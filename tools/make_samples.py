#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_samples.py — 生成一份「故意有问题」的示例路测数据

用途：日志分析面板没有真实数据时也能演示和自测。
数据里埋了 5 类典型状况，覆盖诊断引擎的全部主路径：

  t=120~165s  整段无任何语句        → 链路中断（TRACK_GAP_LINK）
  t=240~275s  GGA quality=0         → 定位丢失（TRACK_GAP_LOST）
  t=300/355s  单点位置飞出去又回来   → 跳点 / 折返尖峰（TRACK_JUMP）
  t=420~470s  坐标完全不变          → 静止停留，不是故障（TRACK_GAP_STATIC）
  t=470~560s  坐标小幅游走          → 静止漂移（TRACK_DRIFT）
  t=380~400s  校验和被打乱          → 校验错误（LOG_CHECKSUM）

输出与上位机导出格式完全一致（GPX 1.1 + 纯 NMEA），
所以这份数据既验证解析器，也验证「导出 → 读回」这条闭环。

用法：python3 tools/make_samples.py
"""

import math
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "samples")

# ---- 起点：西安高新，2026-11-01 01:30:00 UTC（本地 09:30） ----
LAT0 = 34.16400
LON0 = 108.88600
T0_UTC = (2026, 11, 1, 1, 30, 0)
DATE_STR = "011126"          # ddmmyy
DURATION = 700               # 秒

M_PER_DEG_LAT = 111320.0


class Rng:
    """固定种子的线性同余，保证每次生成的样本一模一样"""

    def __init__(self, seed=20261101):
        self.s = seed

    def next(self):
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s / 0x7FFFFFFF

    def sym(self):
        return self.next() * 2 - 1


def nmea_checksum(body):
    c = 0
    for ch in body:
        c ^= ord(ch)
    return c


def frame(body, corrupt=False):
    cs = nmea_checksum(body)
    if corrupt:
        cs = (cs + 0x11) & 0xFF
    return "$%s*%02X" % (body, cs)


def coord(lat, lon):
    """十进制度 → NMEA 的 ddmm.mmmmm"""
    def one(v, deg_width):
        v = abs(v)
        d = int(v)
        m = (v - d) * 60
        return "%0*d%08.5f" % (deg_width, d, m)

    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return one(lat, 2), ns, one(lon, 3), ew


def utc_of(sec):
    h, m, s = T0_UTC[3], T0_UTC[4], T0_UTC[5]
    total = h * 3600 + m * 60 + s + sec
    hh = (total // 3600) % 24
    mm = (total // 60) % 60
    ss = total % 60
    return "%02d%02d%02d.00" % (hh, mm, ss)


def iso_of(sec):
    h, m, s = T0_UTC[3], T0_UTC[4], T0_UTC[5]
    total = h * 3600 + m * 60 + s + sec
    return "%04d-%02d-%02dT%02d:%02d:%02dZ" % (
        T0_UTC[0], T0_UTC[1], T0_UTC[2],
        (total // 3600) % 24, (total // 60) % 60, total % 60,
    )


# ---- 星座与卫星池（够真实就行，不需要在历元间连续） ----
POOL = [
    ("GP", [5, 12, 15, 18, 24, 28, 30, 32]),
    ("GB", [1, 3, 7, 9, 11, 19, 21, 26, 33, 35, 37, 40]),
    ("GL", [65, 66, 72, 74, 81, 82]),
    ("GA", [2, 5, 9, 11, 19, 24]),
]
SYS_ID = {"GP": 1, "GB": 4, "GL": 2, "GA": 3}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    rng = Rng()

    lat, lon = LAT0, LON0
    heading = 92.0
    points = []          # 轨迹点，与上位机写轨迹的规则一致
    lines = []           # NMEA 语句

    last_track = None
    drift_anchor = None

    for t in range(DURATION + 1):
        # ---------- 场景状态 ----------
        silent = 120 <= t < 165           # 链路中断：什么都不发
        lost = 240 <= t < 275             # 定位丢失：quality=0
        parked_still = 420 <= t < 470     # 停车，坐标完全不变
        parked_drift = 470 <= t < 560     # 停车，坐标小幅游走
        crosstalk = 380 <= t < 400        # 线缆干扰：校验和错

        # ---------- 位置推进 ----------
        if silent:
            # 车在动，只是没数据发出来 —— 这才是真正的「轨迹断档」
            speed_kmh = 43.0
            step = speed_kmh / 3.6
            lat += (step * math.cos(math.radians(heading))) / M_PER_DEG_LAT
            lon += (step * math.sin(math.radians(heading))) / (
                M_PER_DEG_LAT * math.cos(math.radians(lat)))
            continue

        if parked_still:
            speed_kmh = 0.0
        elif parked_drift:
            # 真实静止漂移不是白噪声，而是绕真值慢慢画圈（多路径 + 电离层缓慢变化）。
            # 这里用半径 9m、周期 120s 的圆周运动叠一点半径起伏，速度约 1.7 km/h，
            # 包络半径 ~10m、90 秒走 42m —— 正好落在诊断规则的判定区间里。
            if drift_anchor is None:
                drift_anchor = (lat, lon)
            speed_kmh = 0.0
            ang = (t - 470) / 120.0 * 2 * math.pi
            r = 9.0 + 1.4 * math.sin(t / 9.0)
            lat = drift_anchor[0] + (r * math.cos(ang)) / M_PER_DEG_LAT
            lon = drift_anchor[1] + (r * math.sin(ang)) / (
                M_PER_DEG_LAT * math.cos(math.radians(drift_anchor[0])))
        else:
            speed_kmh = 40 + 9 * math.sin(t / 26.0) + 3 * rng.sym()
            heading = 92 + 24 * math.sin(t / 70.0)
            step = speed_kmh / 3.6
            lat += (step * math.cos(math.radians(heading))) / M_PER_DEG_LAT
            lon += (step * math.sin(math.radians(heading))) / (
                M_PER_DEG_LAT * math.cos(math.radians(lat)))

        # ---------- 跳点：飞出去一秒再回来 ----------
        spike = t in (300, 355)
        plat, plon = lat, lon
        if spike:
            plat += 55.0 / M_PER_DEG_LAT
            plon += 55.0 / (M_PER_DEG_LAT * math.cos(math.radians(lat)))

        # ---------- 信号条件 ----------
        if lost:
            quality, sats, hdop = 0, 0, 99.99
        else:
            quality = 1
            canyon = 275 <= t < 330
            sats = rng.next() * 6 + (8 if canyon else 18)
            sats = int(min(28, sats))
            hdop = (3.1 if canyon else 1.05) + 0.45 * rng.next()

        ns, ew = coord(plat, plon)[1], coord(plat, plon)[3]
        lat_s, lon_s = coord(plat, plon)[0], coord(plat, plon)[2]

        # ---------- 语句：GSV / GSA / GGA / RMC / VTG ----------
        vis = 0
        for sys, prns in POOL:
            n = len(prns) if not lost else max(3, len(prns) // 3)
            use = prns[:n]
            vis += n
            total = (n + 3) // 4
            for i in range(total):
                chunk = use[i * 4:(i + 1) * 4]
                body = ",".join(
                    "%02d,%02d,%03d,%02d" % (
                        p,
                        12 + (p * 7 + t) % 78,
                        (p * 37 + t * 3) % 360,
                        (18 if lost else 30) + (p * 13 + t) % 22,
                    ) for p in chunk
                )
                lines.append(frame("%sGSV,%d,%d,%02d,%s" % (
                    sys, total, i + 1, n, body), corrupt=(crosstalk and i == 0)))

        for sys, prns in POOL:
            n = len(prns) if not lost else max(2, len(prns) // 4)
            slots = ["%02d" % p for p in prns[:n]]
            slots += [""] * (12 - len(slots))
            lines.append(frame("GNGSA,A,%d,%s,%.2f,%.2f,%.2f,%d" % (
                3 if not lost else 1, ",".join(slots), hdop * 1.5, hdop, hdop * 1.2,
                SYS_ID[sys]), corrupt=(crosstalk and sys == "GL")))

        if lost:
            lines.append(frame(
                "GNGGA,%s,,,,,0,00,99.99,,,,,," % utc_of(t), corrupt=(crosstalk and t % 3 == 0)))
            lines.append(frame(
                "GNRMC,%s,V,,,,,,,%s,,,N" % (utc_of(t), DATE_STR)))
        else:
            lines.append(frame(
                "GNGGA,%s,%s,%s,%s,%s,%d,%02d,%.2f,%.1f,M,-8.1,M,," % (
                    utc_of(t), lat_s, ns, lon_s, ew, quality, sats, hdop, 473.8 + 1.6 * rng.sym()),
                corrupt=(crosstalk and t % 4 == 0)))
            lines.append(frame(
                "GNRMC,%s,A,%s,%s,%s,%s,%.1f,%.1f,%s,,,A" % (
                    utc_of(t), lat_s, ns, lon_s, ew, speed_kmh / 1.852, heading, DATE_STR)))
            lines.append(frame("GNVTG,%.1f,T,%.1f,M,%.1f,N,%.1f,K,A" % (
                heading, heading + 0.7, speed_kmh / 1.852, speed_kmh)))

        if t % 10 == 0:
            lines.append(frame("SNRSTAT,1,0,0,2"))
        if t == 60:
            lines.append(frame("GNTXT,01,01,02,GNSS SAMPLE DATA"))

        # ---------- 轨迹点：与 nmea.js 的 _pushTrack 规则一致 ----------
        if quality > 0:
            key = (round(plat, 7), round(plon, 7))
            if key != last_track:
                last_track = key
                points.append({
                    "lat": plat, "lon": plon,
                    "alt": round(473.8 + 1.6 * rng.sym(), 1),
                    "t": t,
                    "speed": round(speed_kmh, 2),
                    "course": round(heading, 1),
                    "hdop": round(hdop, 2),
                })

    # ---------- 写 GPX（格式与 web/export.js 的 toGPX 逐字对齐） ----------
    rows = []
    for p in points:
        rows.append(
            '      <trkpt lat="%.7f" lon="%.7f">\n'
            '        <ele>%.1f</ele>\n'
            '        <time>%s</time>\n'
            '        <hdop>%.2f</hdop>\n'
            '        <extensions><speed>%.2f</speed><course>%.1f</course></extensions>\n'
            '      </trkpt>' % (
                p["lat"], p["lon"], p["alt"], iso_of(p["t"]), p["hdop"],
                p["speed"], p["course"])
        )

    gpx = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="gnss-web-host" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>示例轨迹（含 6 类状况）</name>
    <time>%s</time>
  </metadata>
  <trk>
    <name>示例轨迹（含 6 类状况）</name>
    <trkseg>
%s
    </trkseg>
  </trk>
</gpx>
""" % (iso_of(0), "\n".join(rows))

    gpx_path = os.path.join(OUT_DIR, "gnss-track-20261101-0930.gpx")
    with open(gpx_path, "w", encoding="utf-8") as f:
        f.write(gpx)

    log_path = os.path.join(OUT_DIR, "gnss-log-20261101-0930.nmea")
    with open(log_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")

    print("轨迹点 %d 个 → %s (%.1f KB)" % (
        len(points), os.path.basename(gpx_path), os.path.getsize(gpx_path) / 1024))
    print("语句   %d 条 → %s (%.1f KB)" % (
        len(lines), os.path.basename(log_path), os.path.getsize(log_path) / 1024))


if __name__ == "__main__":
    main()
