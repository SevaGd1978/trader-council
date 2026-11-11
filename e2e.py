import asyncio, sys, json
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8090/'
OUT = sys.argv[2] if len(sys.argv) > 2 else ''
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL, wait_until='networkidle')
        await pg.wait_for_function("document.getElementById('pxVal').textContent !== '—'", timeout=20000)
        print('price', await pg.text_content('#pxVal'), await pg.text_content('#srcLine'))
        # Force a buy: lower risk-free path — run rounds until a trade or 1 round, then check
        bal0 = await pg.evaluate("window.__tc.state.balance")
        await pg.click('#btnRound')
        await pg.wait_for_function("!document.getElementById('btnRound').disabled", timeout=60000)
        st = await pg.evaluate("JSON.stringify({b: window.__tc.state.balance, pos: window.__tc.state.positions, r: window.__tc.state.rounds.at(-1).final, n: window.__tc.state.rounds.at(-1).msgs.length, t: window.__tc.state.trades.length})")
        print('after round', st, 'bal0', bal0)
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=OUT + 'screenshot.png')
        await pg.click('.tabs button[data-tab=port]'); await pg.wait_for_timeout(500)
        await pg.screenshot(path=OUT + 'screenshot-portfolio.png')
        if await pg.query_selector('[data-close]'):
            await pg.click('[data-close]'); await pg.wait_for_timeout(300)
            print('after manual close', await pg.evaluate("JSON.stringify({b: window.__tc.state.balance, t: window.__tc.state.trades.map(t=>[t.side,t.pnl])})"))
        await pg.click('.tabs button[data-tab=set]'); await pg.wait_for_timeout(300)
        await pg.screenshot(path=OUT + 'screenshot-settings.png')
        print('errors', errs)
        await b.close()
asyncio.run(main())
