#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py — GNSS 上位机本地服务

替代 `python3 -m http.server`，在静态托管之外加了三件事：

  1. /api/config        探测地图 Key 类型，决定用 JS API 还是静态底图
  2. /api/staticmap     高德静态地图代理（Key 只留在服务端，不进前端 JS）
  3. /api/ntrip/*       NTRIP 客户端（千寻 FindCM 等），把 RTCM 差分数据
                        取回来交给浏览器写进串口

只监听 127.0.0.1，不对外暴露。

启动：python3 server.py [--port 8765] [--no-browser]
"""

import argparse
import base64
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
LOCAL_KEY_FILE = os.path.join(ROOT, "map-key.local.js")

# ============================================================
# 1. 配置与 Key 类型探测
# ============================================================

_KEY_CACHE = {"key": None, "kind": None, "ts": 0}


def read_local_keys():
    """从 map-key.local.js 里读出 Key（文件不存在就返回空）"""
    keys = {"js": "", "web": "", "sec": ""}
    if not os.path.exists(LOCAL_KEY_FILE):
        return keys
    try:
        src = open(LOCAL_KEY_FILE, encoding="utf-8").read()
    except OSError:
        return keys

    def grab(name):
        m = re.search(name + r"""\s*=\s*['"]([^'"]*)['"]""", src)
        return m.group(1).strip() if m else ""

    keys["js"] = grab(r"__GNSS_MAP_JS_KEY__")
    keys["web"] = grab(r"__GNSS_MAP_WEB_KEY__")
    keys["sec"] = grab(r"__GNSS_MAP_SEC__")
    # 兼容老写法：单一 __UM621_MAP_KEY__（旧版键名，保留读取）
    legacy = grab(r"__GNSS_MAP_KEY__")
    if legacy and not (keys["js"] or keys["web"]):
        keys["web"] = legacy  # 先当作候选，探测后可能改判
    return keys


def classify_key(key):
    """
    判断 Key 属于哪一类：
      web     —— 能用 restapi.amap.com（Web服务）
      js      —— 不能用 restapi，属于 Web端(JS API)
      invalid —— Key 本身无效
    依据：高德的 Key 按「服务平台」绑定，跨平台调用会返回对应 infocode。
    """
    if not key:
        return None
    if _KEY_CACHE["key"] == key and time.time() - _KEY_CACHE["ts"] < 600:
        return _KEY_CACHE["kind"]
    kind = "invalid"
    try:
        url = "https://restapi.amap.com/v3/ip?key=" + urllib.parse.quote(key)
        with urllib.request.urlopen(url, timeout=6) as r:
            j = json.loads(r.read().decode("utf-8", "replace"))
        if j.get("status") == "1":
            kind = "web"
        else:
            code = str(j.get("infocode", ""))
            # 10009 USERKEY_PLAT_NOMATCH / 10001 INVALID_USER_KEY / 10008 平台不匹配
            kind = "js" if code in ("10009", "10008") else "invalid"
    except Exception:
        kind = "unknown"
    _KEY_CACHE.update({"key": key, "kind": kind, "ts": time.time()})
    return kind


def map_config():
    """给前端的配置：绝不返回 Web服务 Key"""
    keys = read_local_keys()
    js_key = keys["js"]
    web_key = keys["web"]

    # 老写法只在 __UM621_MAP_KEY__ 里填了一个：探测后自动归位
    if web_key and not js_key and classify_key(web_key) == "js":
        js_key, web_key = web_key, ""

    return {
        "jsKey": js_key,
        "securityCode": keys["sec"],
        "hasWebKey": bool(web_key),
        "mapMode": "jsapi" if js_key else ("static" if web_key else "none"),
    }


# ============================================================
# 2. 静态地图代理（带缓存）
# ============================================================

STATIC_CACHE = {}
STATIC_CACHE_LOCK = threading.Lock()
STATIC_CACHE_MAX = 48
# 只允许这些参数透传，避免把代理变成万能转发器
ALLOWED_PARAMS = ("location", "zoom", "size", "scale", "style", "paths", "markers", "traffic", "label")


def fetch_static_map(query):
    params = {k: v for k, v in urllib.parse.parse_qsl(query, keep_blank_values=True)
              if k in ALLOWED_PARAMS}
    if "location" not in params:
        raise ValueError("缺少 location 参数")

    keys = read_local_keys()
    web_key = keys["web"]
    if not web_key:
        raise ValueError("未配置 Web服务 Key，静态底图不可用")

    params["key"] = web_key
    url = "https://restapi.amap.com/v3/staticmap?" + urllib.parse.urlencode(params, safe="*:;,.-")

    cache_key = url
    with STATIC_CACHE_LOCK:
        hit = STATIC_CACHE.get(cache_key)
        if hit and time.time() - hit[1] < 90:
            return hit[0]

    req = urllib.request.Request(url, headers={"User-Agent": "gnss-web-host/1.0"})
    with urllib.request.urlopen(req, timeout=12) as r:
        body = r.read()
        ctype = r.headers.get("Content-Type", "")
    if not ctype.startswith("image"):
        # 出错时高德返回 JSON，原样抛出方便定位
        raise ValueError(body[:200].decode("utf-8", "replace"))

    with STATIC_CACHE_LOCK:
        if len(STATIC_CACHE) > STATIC_CACHE_MAX:
            STATIC_CACHE.clear()
        STATIC_CACHE[cache_key] = (body, time.time())
    return body


# ============================================================
# 3. NTRIP 客户端
# ============================================================

class NtripSession:
    """一条 NTRIP 连接。把 caster 推下来的 RTCM 攒在缓冲区里，等浏览器来取。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.sock = None
        self.thread = None
        self.alive = False
        self.buf = bytearray()
        self.carry = b""
        self.gga = b""
        self.gga_ts = 0.0
        self.info = {}
        self.stats = {"bytes": 0, "msgs": {}, "since": 0.0, "lastData": 0.0, "error": ""}

    # ---------- 连接 ----------
    def connect(self, host, port, mount, user, password, version="2.0"):
        self.close()
        s = socket.create_connection((host, int(port)), timeout=12)
        s.settimeout(12)
        auth = base64.b64encode(f"{user}:{password}".encode()).decode()
        req = (
            f"GET /{mount} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Ntrip-Version: Ntrip/{version}\r\n"
            f"User-Agent: NTRIP gnss-web-host/1.0\r\n"
            f"Authorization: Basic {auth}\r\n"
            f"Accept: */*\r\n"
            f"Connection: close\r\n\r\n"
        ).encode()
        s.sendall(req)

        head = b""
        s.settimeout(10)
        # 读到响应头结束，或者读到一个 RTCM3 前导字节（NTRIP v1 直接吐数据）
        while len(head) < 4096:
            chunk = s.recv(1)
            if not chunk:
                break
            head += chunk
            if head[:1] == b"\xd3":
                break
            if head.endswith(b"\r\n\r\n"):
                break

        payload = b""
        if head[:1] == b"\xd3":
            payload = head
        else:
            text = head.decode("latin-1", "replace")
            first = text.split("\r\n", 1)[0]
            if "200" not in first and "ICY" not in first.upper():
                s.close()
                if "401" in first:
                    raise ValueError("鉴权失败（401）：账号或密码不对，或账号未激活")
                if "404" in first:
                    raise ValueError("挂载点不存在（404）：检查挂载点名称")
                raise ValueError("caster 拒绝连接：" + first[:120])
            m = re.search(r"Source-Agent:\s*(.+)", text, re.I)
            if m:
                self.info["agent"] = m.group(1).strip()

        self.sock = s
        s.settimeout(None)
        self.alive = True
        self.buf.clear()
        self.carry = b""
        self.stats = {"bytes": 0, "msgs": {}, "since": time.time(),
                      "lastData": 0.0, "error": ""}
        self.info.update({"host": host, "port": int(port), "mount": mount,
                          "agent": self.info.get("agent", "")})
        if payload:
            self._ingest(payload)

        self.thread = threading.Thread(target=self._reader, daemon=True)
        self.thread.start()
        return True

    # ---------- 收数据 ----------
    def _reader(self):
        try:
            while self.alive and self.sock:
                try:
                    data = self.sock.recv(8192)
                except OSError:
                    break
                if not data:
                    break
                self._ingest(data)
        finally:
            if self.alive:
                self.stats["error"] = "caster 断开连接"
            self.alive = False

    def _ingest(self, data):
        with self.lock:
            self.stats["bytes"] += len(data)
            self.stats["lastData"] = time.time()
            self.buf.extend(data)
            if len(self.buf) > 1_500_000:
                del self.buf[:len(self.buf) - 1_000_000]
            # 统计 RTCM3 消息类型
            d = self.carry + data
            i = 0
            while i + 6 <= len(d):
                if d[i] != 0xD3:
                    i += 1
                    continue
                ln = ((d[i + 1] & 0x03) << 8) | d[i + 2]
                if i + 3 + ln + 3 > len(d):
                    break
                if ln >= 2:
                    mt = str(((d[i + 3] << 4) | (d[i + 4] >> 4)) & 0x0FFF)
                    self.stats["msgs"][mt] = self.stats["msgs"].get(mt, 0) + 1
                i += 3 + ln + 3
            self.carry = d[i:]

    # ---------- 取数据 ----------
    def pull(self, limit=8192):
        with self.lock:
            if not self.buf:
                return b""
            n = min(limit, len(self.buf))
            out = bytes(self.buf[:n])
            del self.buf[:n]
            return out

    # ---------- GGA ----------
    def push_gga(self, line):
        line = (line or "").strip()
        if not line.startswith("$"):
            return False
        if not line.startswith(("$GPGGA", "$GNGGA", "$GBGGA", "$GAGGA", "$GLGGA", "$BDGGA")):
            return False
        self.gga = (line + "\r\n").encode()
        self.gga_ts = time.time()
        if self.sock and self.alive:
            try:
                self.sock.sendall(self.gga)
                return True
            except OSError as e:
                self.stats["error"] = str(e)
        return False

    # ---------- 状态 ----------
    def status(self):
        with self.lock:
            return {
                "connected": self.alive,
                "info": dict(self.info),
                "bytes": self.stats["bytes"],
                "msgs": dict(self.stats["msgs"]),
                "buffered": len(self.buf),
                "uptime": round(time.time() - self.stats["since"], 1) if self.stats["since"] else 0,
                "lastDataAgo": round(time.time() - self.stats["lastData"], 1) if self.stats["lastData"] else None,
                "ggaAgo": round(time.time() - self.gga_ts, 1) if self.gga_ts else None,
                "error": self.stats["error"],
            }

    def close(self):
        self.alive = False
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        self.buf.clear()
        self.info = {}
        return True


NTRIP = NtripSession()


# ============================================================
# 4. HTTP 服务
# ============================================================

class Handler(SimpleHTTPRequestHandler):
    server_version = "gnss-web-host/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        # 轮询接口太吵，静音
        if "/api/ntrip/pull" in (self.path or "") or "/api/ntrip/status" in (self.path or ""):
            return
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------- 工具 ----------
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _bin(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=60")
        self.end_headers()
        self.wfile.write(body)

    def _body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8", "replace"))
        except (ValueError, OSError):
            return {}

    # ---------- 路由 ----------
    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/api/config":
            return self._json(map_config())

        if path == "/api/staticmap":
            try:
                return self._bin(fetch_static_map(query), "image/png")
            except Exception as e:
                return self._json({"error": str(e)}, 502)

        if path == "/api/ntrip/status":
            return self._json(NTRIP.status())

        if path == "/api/ntrip/pull":
            data = NTRIP.pull()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if data:
                self.wfile.write(data)
            return

        if path == "/api/ntrip/gga":
            line = urllib.parse.parse_qs(query).get("line", [""])[0]
            return self._json({"sent": NTRIP.push_gga(line)})

        return super().do_GET()

    def do_POST(self):
        path = self.path.partition("?")[0]
        if path == "/api/ntrip/connect":
            body = self._body_json()
            try:
                NTRIP.connect(
                    body.get("host", "").strip(),
                    body.get("port", 8002),
                    body.get("mount", "AUTO").strip() or "AUTO",
                    body.get("user", "").strip(),
                    body.get("pass", ""),
                )
                return self._json({"ok": True, "status": NTRIP.status()})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 200)

        if path == "/api/ntrip/disconnect":
            NTRIP.close()
            return self._json({"ok": True})

        if path == "/api/ntrip/gga":
            body = self._body_json()
            return self._json({"sent": NTRIP.push_gga(body.get("line", ""))})

        self.send_error(404)

    # 关掉目录列表，避免误暴露文件
    def list_directory(self, path):
        self.send_error(403)
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    os.chdir(ROOT)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.daemon_threads = True
    cfg = map_config()
    print(f"GNSS 本地服务  http://127.0.0.1:{args.port}/")
    print(f"  地图模式：{cfg['mapMode']}"
          + ("（高德 JS API，可拖动缩放）" if cfg["mapMode"] == "jsapi" else
             "（静态底图兜底，Key 只留在服务端）" if cfg["mapMode"] == "static" else
             "（未配置 Key）"))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        NTRIP.close()


if __name__ == "__main__":
    main()
