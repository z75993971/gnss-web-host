#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mock_caster.py — 本地假 NTRIP caster，用来验证 server.py 的客户端实现

模拟真实 caster 的行为：
  1. 校验 Authorization，错了回 401
  2. 对了回 HTTP/1.1 200 OK 然后持续推 RTCM3 帧
  3. 收到客户端发来的 GGA 就打印出来（虚拟参考站就是靠这个定位）

运行：python3 mock_caster.py 2101
"""
import base64
import socket
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 2101
USER, PASSWORD = "testuser", "testpass"
print(f"mock caster 监听 127.0.0.1:{PORT}  账号 {USER}/{PASSWORD}", flush=True)


def rtcm3(msg_type, payload_len=12):
    """造一条 RTCM3 帧：0xD3 + 6bit保留/10bit长度 + 12bit消息号 + 内容 + 3字节CRC"""
    body = bytes([(msg_type >> 4) & 0xFF, ((msg_type & 0x0F) << 4)]) + bytes(payload_len)
    ln = len(body)
    head = bytes([0xD3, (ln >> 8) & 0x03, ln & 0xFF])
    return head + body + b"\x00\x00\x00"   # CRC 随便填，客户端只做类型统计


FRAMES = [rtcm3(1005, 19), rtcm3(1077, 40), rtcm3(1087, 40), rtcm3(1097, 36), rtcm3(1127, 44), rtcm3(1019, 60)]


def handle(conn, addr):
    try:
        req = b""
        conn.settimeout(8)
        while b"\r\n\r\n" not in req:
            chunk = conn.recv(1024)
            if not chunk:
                return
            req += chunk
        text = req.decode("latin-1", "replace")
        first = text.split("\r\n", 1)[0]
        auth = ""
        for line in text.split("\r\n"):
            if line.lower().startswith("authorization:"):
                auth = line.split(":", 1)[1].strip()
        mount = first.split(" ")[1].strip("/") if " " in first else "?"
        print(f"[{addr[1]}] {first}  mount={mount}  auth={auth[:20]}…", flush=True)

        ok = False
        if auth.startswith("Basic "):
            try:
                u, p = base64.b64decode(auth[6:]).decode().split(":", 1)
                ok = (u == USER and p == PASSWORD)
            except Exception:
                ok = False

        if not ok:
            conn.sendall(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"mock\"\r\n\r\n")
            print("  → 401 鉴权失败", flush=True)
            return

        conn.sendall(b"HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\n"
                     b"Cache-Control: no-store\r\nConnection: close\r\n\r\n")
        print("  → 200 开始推流", flush=True)

        stop = threading.Event()

        def reader():
            """读客户端发来的 GGA"""
            while not stop.is_set():
                try:
                    d = conn.recv(4096)
                except OSError:
                    return
                if not d:
                    return
                for ln in d.decode("latin-1", "replace").splitlines():
                    if "GGA" in ln:
                        print(f"  ← 收到 GGA: {ln.strip()[:80]}", flush=True)

        threading.Thread(target=reader, daemon=True).start()

        i = 0
        while i < 40:
            for f in FRAMES:
                conn.sendall(f)
            i += 1
            time.sleep(1)
        stop.set()
    except Exception as e:
        print("异常:", e, flush=True)
    finally:
        try:
            conn.close()
        except OSError:
            pass


s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", PORT))
s.listen(4)
while True:
    c, a = s.accept()
    threading.Thread(target=handle, args=(c, a), daemon=True).start()
