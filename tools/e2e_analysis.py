#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""浏览器端到端验证：导入 -> 分析 -> 地图 -> 报告"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = "/tmp/umcheck/shots"
os.makedirs(OUT, exist_ok=True)

errors = []
logs = []


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.path.expanduser(
            "~/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
        ctx = browser.new_context(viewport={"width": 1680, "height": 1000}, accept_downloads=True)
        page = ctx.new_page()

        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: (logs.append(f"{m.type}: {m.text}"),
                                      errors.append(f"console.error: {m.text}")
                                      if m.type == "error" else None))

        page.goto(f"{BASE}/?an=sample", wait_until="domcontentloaded")
        page.wait_for_timeout(3500)

        # ---------- 1. 面板是否出来了 ----------
        print("1) 面板状态")
        print("   modal hidden:", page.eval_on_selector("#anModal", "el => el.hidden"))
        print("   grid hidden :", page.eval_on_selector("#anGrid", "el => el.hidden"))
        print("   sub:", page.inner_text("#anSub"))
        print("   grade:", page.inner_text("#anScore").replace("\n", " | "))
        print("   verdict:", page.inner_text("#anVerdict"))

        # ---------- 2. 问题清单 ----------
        print("\n2) 问题清单")
        n_iss = page.eval_on_selector_all(".an-iss", "els => els.length")
        tabs = page.inner_text("#anIssueTabs").replace("\n", " ")
        print("   条目数:", n_iss, "| tabs:", tabs)
        for t in page.eval_on_selector_all(".an-iss .an-iss-title", "els => els.map(e => e.textContent.trim())"):
            print("   -", t)

        # ---------- 3. 展开第一条 ----------
        if n_iss:
            page.click(".an-iss")
            page.wait_for_timeout(300)
            opened = page.eval_on_selector(".an-iss", "el => el.classList.contains('open')")
            body = page.eval_on_selector(".an-iss .an-iss-body", "el => el.innerText.slice(0,160)")
            print("\n3) 展开第一条:", opened)
            print("   正文:", body.replace("\n", " / "))

        # ---------- 4. 地图与曲线 ----------
        print("\n4) 地图与曲线")
        page.wait_for_timeout(1800)
        print("   地图底注:", page.inner_text("#anMapNote"))
        map_img = page.eval_on_selector("#anMap", "el => { const i = el.querySelector('img'); return i ? i.naturalWidth + 'x' + i.naturalHeight : 'no-img'; }")
        map_cv = page.eval_on_selector("#anMap", "el => !!el.querySelector('canvas')")
        print("   底图尺寸:", map_img, "| overlay canvas:", map_cv)
        for cid in ("cvAnFix", "cvAnSats", "cvAnSpeed"):
            box = page.eval_on_selector("#" + cid, "el => el.width + 'x' + el.height")
            print(f"   {cid}: {box}")

        # ---------- 5. 点「定位」 ----------
        loc = page.query_selector(".an-iss-loc")
        if loc:
            loc.click()
            page.wait_for_timeout(800)
            print("\n5) 点定位后 toast:", page.inner_text("#toast"))

        page.screenshot(path=os.path.join(OUT, "01-analysis.png"), full_page=False)

        # ---------- 6. 导出 HTML 报告 ----------
        print("\n6) 导出报告")
        page.click("#btnAnReport")
        page.wait_for_timeout(300)
        print("   菜单项:", page.eval_on_selector_all("#anReportMenu button b", "els => els.map(e => e.textContent)"))

        with page.expect_download() as dl:
            page.click('#anReportMenu button[data-fmt="html"]')
        d = dl.value
        rpt = os.path.join(OUT, "report.html")
        d.save_as(rpt)
        print("   下载:", d.suggested_filename, os.path.getsize(rpt), "bytes")

        with page.expect_download() as dl2:
            page.click("#btnAnReport")
            page.wait_for_timeout(200)
            page.click('#anReportMenu button[data-fmt="csv"]')
        d2 = dl2.value
        csvp = os.path.join(OUT, "issues.csv")
        d2.save_as(csvp)
        print("   下载:", d2.suggested_filename, os.path.getsize(csvp), "bytes")

        # ---------- 7. 报告文件本身能不能打开 ----------
        rp = ctx.new_page()
        rp.goto("file://" + rpt)
        rp.wait_for_timeout(600)
        print("   报告标题:", rp.title())
        print("   报告评级:", rp.inner_text(".verdict .head").replace("\n", " "))
        print("   报告章节:", rp.eval_on_selector_all("h2", "els => els.map(e => e.textContent)"))
        print("   报告 SVG 数:", rp.eval_on_selector_all("svg.chart", "els => els.length"))
        print("   问题表格行:", rp.eval_on_selector_all("table tbody tr", "els => els.length"))
        rp.screenshot(path=os.path.join(OUT, "02-report.png"), full_page=True)
        rp.close()

        # ---------- 8. 清空后手工导入文件 ----------
        print("\n8) 手工导入")
        page.click("#btnAnClear")
        page.wait_for_timeout(400)
        print("   清空后 empty 可见:", page.eval_on_selector("#anEmpty", "el => !el.hidden"))

        page.set_input_files("#anFile", [
            os.path.join(WEB, "samples", "gnss-track-20261101-0930.gpx"),
            os.path.join(WEB, "samples", "gnss-log-20261101-0930.nmea"),
        ])
        page.wait_for_timeout(3000)
        print("   导入后条目数:", page.eval_on_selector_all(".an-iss", "els => els.length"))
        print("   文件卡片:", page.eval_on_selector_all(".an-file-name", "els => els.map(e => e.textContent)"))
        page.screenshot(path=os.path.join(OUT, "03-import.png"), full_page=False)

        # ---------- 9. 只导轨迹（无日志）时的降级 ----------
        print("\n9) 只导轨迹")
        page.click("#btnAnClear")
        page.wait_for_timeout(300)
        page.set_input_files("#anFile", [os.path.join(WEB, "samples", "gnss-track-20261101-0930.gpx")])
        page.wait_for_timeout(2500)
        print("   条目数:", page.eval_on_selector_all(".an-iss", "els => els.length"))
        for t in page.eval_on_selector_all(".an-iss .an-iss-title", "els => els.map(e => e.textContent.trim())"):
            print("   -", t)
        page.screenshot(path=os.path.join(OUT, "04-trackonly.png"), full_page=False)

        print("\n=== console/错误 ===")
        for e in errors:
            print("  !!", e)
        if not errors:
            print("  无错误")

        browser.close()


if __name__ == "__main__":
    main()
