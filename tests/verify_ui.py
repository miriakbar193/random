"""Headless-Chrome smoke check + screenshot capture for the P0 containment work.

Loads the running dashboard (mock mode), fails on any console/page error, walks
the key pages, exercises P1-09 conflict detection and P0-03 demo actions, and
writes screenshots to /workspace/artifacts.
"""
import sys, pathlib
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8000"
OUT = pathlib.Path("/workspace/artifacts")
OUT.mkdir(parents=True, exist_ok=True)

errors = []

def shot(page, name):
    page.screenshot(path=str(OUT / name), full_page=False)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1366, "height": 768})
    page = ctx.new_page()
    # Ignore benign environmental failures: blocked external CDNs/tiles (QUIC),
    # and the missing favicon. Everything else is an app fault we want to catch.
    def on_console(m):
        if m.type != "error":
            return
        t = m.text
        if "Failed to load resource" in t or "ERR_QUIC" in t or "favicon" in t:
            return
        errors.append(f"console.error: {t}")
    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(600)
    shot(page, "01-hub.png")

    # Decisions page (P0-02 metrics, P0-03 demo actions)
    page.evaluate("go('decisions')")
    page.wait_for_timeout(500)
    shot(page, "02-decisions.png")
    # Read the KPI labels/values back out of the DOM
    kpi = page.evaluate("Array.from(document.querySelectorAll('#decKpi .kpi')).map(k=>k.querySelector('.lb').textContent+': '+k.querySelector('.vl').textContent.trim())")
    print("Decision KPIs:", kpi)
    # Click a demo Approve and capture the non-official receipt toast
    btn = page.query_selector('#allDec [data-decact="approve"]')
    if btn:
        btn.click()
        page.wait_for_timeout(300)
        toast = page.evaluate("document.getElementById('toast').textContent")
        print("Demo action toast:", toast)
        shot(page, "03-decision-demo-toast.png")

    # Meeting prioritisation (P0-04 + P1-09 conflict)
    page.evaluate("go('prio')")
    page.wait_for_timeout(500)
    shot(page, "04-prio-agenda.png")
    conflicts = page.evaluate("Exec.meetingConflicts(F.meetings)")
    print("Conflicts:", conflicts)

    # Calendar (P1-09 conflict chip on the demo day)
    page.evaluate("go('calendar')")
    page.wait_for_timeout(500)
    shot(page, "05-calendar.png")

    # Simulator (P0-05 methodology-review containment)
    page.evaluate("go('simulator')")
    page.wait_for_timeout(600)
    shot(page, "06-simulator.png")
    mr = page.evaluate("Array.from(document.querySelectorAll('.rc.mr .rl')).map(e=>e.textContent)")
    print("Methodology-review rows:", mr)

    # AI page (P0-08 capability banner — mock => demo)
    page.evaluate("go('ai')")
    page.wait_for_timeout(800)
    shot(page, "07-ai-capability.png")
    cap = page.evaluate("({state: AI_CAP, banner: document.getElementById('chatCap').textContent})")
    print("AI capability:", cap)

    # Document review (P0-06 supported formats + partial-review note)
    page.evaluate("go('docreview')")
    page.wait_for_timeout(400)
    shot(page, "08-docreview.png")

    # Mobile viewport (P1-10 / P0-01 badge visible)
    page.set_viewport_size({"width": 390, "height": 844})
    page.evaluate("go('overview')")
    page.wait_for_timeout(500)
    shot(page, "09-overview-mobile.png")

    # P0-08: simulate an unreachable backend (health 503) and confirm the panel
    # neither crashes nor shows false success — chat is disabled with a retry.
    page.set_viewport_size({"width": 1366, "height": 768})
    page2 = ctx.new_page()
    page2.route("**/api/health", lambda route: route.fulfill(status=503, body="down"))
    page2.route("**/api/chat", lambda route: route.fulfill(status=503, body="down"))
    page2.goto(BASE, wait_until="domcontentloaded")
    page2.wait_for_timeout(1500)
    page2.evaluate("go('ai')")
    page2.wait_for_timeout(400)
    down = page2.evaluate("({state: AI_CAP, disabled: document.getElementById('ask').disabled, banner: document.getElementById('chatCap').textContent})")
    print("Backend-down scenario:", down)
    shot(page2, "10-ai-backend-down.png")
    assert down["state"] == "down" and down["disabled"], "P0-08: chat should be disabled when backend is down"

    browser.close()

if errors:
    print("\nCONSOLE/PAGE ERRORS:")
    for e in errors:
        print("  -", e)
    sys.exit(1)
print("\nNo console/page errors. Screenshots in", OUT)
