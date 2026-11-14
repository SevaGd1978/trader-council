#!/usr/bin/env python3
"""Сводка автосовета по акциям США: python3 report.py"""
import json, sys, os
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=5), 'Asia/Yekaterinburg')
here = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(os.path.join(here, 'log.jsonl'), encoding='utf-8') if l.strip()]
st = json.load(open(os.path.join(here, 'state.json'), encoding='utf-8'))
rounds = [r for r in rows if r['type'] == 'round']
t = lambda ms_or_iso: (datetime.fromisoformat(ms_or_iso.replace('Z', '+00:00')) if isinstance(ms_or_iso, str) else datetime.fromtimestamp(ms_or_iso / 1000, timezone.utc)).astimezone(TZ).strftime('%d.%m %H:%M')
start = st['start']
prices = st['prices']
eq = st['balance'] + sum(p['qty'] * prices.get(p['pair'], p['entry']) for p in st['positions'].values())
pnl = eq - start
trades = [x['trade'] for x in rows if x.get('trade')] + [o['trade'] for r in rounds for o in r['results'] if o.get('trade')]
closed = [x for x in trades if x['side'] == 'sell']
buys = [x for x in trades if x['side'] == 'buy']
wins = [x for x in closed if x['pnl'] > 0]
s = st['settings']
print(f"Автосовет · акции США ({', '.join(s['tickers'])}) · свечи {s['tf']} · риск {s['riskPct']}% · до {s['maxPositions']} позиций · комиссия {s['fee'] * 100:.2f}%")
print(f"Период: {t(st['auto']['startedAt'])} – {t(rounds[-1]['time']) if rounds else '—'} (Екатеринбург), раундов в часы биржи: {len(rounds)}" + (' · завершён' if st['auto'].get('finished') else ' · ещё идёт'))
print(f"Капитал: {start:,.2f} → {eq:,.2f} USD (свободно {st['balance']:,.2f})")
print(f"P&L: {pnl:+,.2f} USD ({pnl / start * 100:+.2f}%)")
fees = sum(x.get('fee', 0) for x in trades)
print(f"Сделок: покупок {len(buys)}, закрытых {len(closed)}" + (f", винрейт {len(wins) / len(closed) * 100:.0f}% ({len(wins)}/{len(closed)})" if closed else '') + f", комиссий {fees:.2f} USD")
if closed:
    fmt = lambda x: f"{x['pair']} {x['pnl']:+.2f} USD ({x['entry']:.2f} → {x['price']:.2f}, {x['reason']})"
    print('Лучшая: ' + fmt(max(closed, key=lambda x: x['pnl'])))
    print('Худшая: ' + fmt(min(closed, key=lambda x: x['pnl'])))
    by = {}
    for x in closed: by[x['pair']] = by.get(x['pair'], 0) + x['pnl']
    print('По тикерам: ' + ', '.join(f"{k} {v:+.2f}" for k, v in sorted(by.items(), key=lambda kv: -kv[1])))
for p in st['positions'].values():
    px = prices.get(p['pair'], p['entry'])
    print(f"Открыта: {p['qty']:.3f} {p['pair']} от {p['entry']:.2f}, сейчас {px:.2f} (P&L {(px - p['entry']) * p['qty']:+.2f} USD), стоп {p['sl']:.2f}, тейк {p['tp']:.2f}")
spy0, spy1 = st['auto'].get('spyStart'), prices.get('SPY')
if spy0 and spy1:
    bh = start * (spy1 / spy0 - 1)
    print(f"SPY: {spy0:.2f} → {spy1:.2f} ({(spy1 / spy0 - 1) * 100:+.2f}%) — «купить SPY и держать» дало бы {bh:+,.2f} USD; совет {'лучше' if pnl > bh else 'хуже'} на {abs(pnl - bh):,.2f} USD")
d = {}
for r in rounds:
    for o in r['results']: d[o['decision']] = d.get(o['decision'], 0) + 1
if d: print('Решения по тикерам: ' + ', '.join(f"{k} {v}" for k, v in d.items()))
errs = sum(1 for r in rows if r['type'] == 'error')
if errs: print(f"Ошибок получения данных: {errs}")
def _et(dt):
    try:
        from zoneinfo import ZoneInfo
        return dt.astimezone(ZoneInfo('America/New_York'))
    except Exception:
        return dt.astimezone(timezone(timedelta(hours=-5)))

def _session_gap_sec(a, b):
    """Секунды между a и b, попавшие в основную сессию NYSE (пн–пт 9:30–16:00 ET)."""
    a, b = _et(a), _et(b)
    if b <= a: return 0
    total, cur = 0, a
    while cur < b:
        start = cur.replace(hour=9, minute=30, second=0, microsecond=0)
        end = cur.replace(hour=16, minute=0, second=0, microsecond=0)
        if cur.weekday() < 5:
            lo, hi = max(cur, start), min(b, end)
            if hi > lo: total += (hi - lo).total_seconds()
        cur = (cur + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return total

gaps = []
prev = None
for r in rounds:
    cur = datetime.fromisoformat(r['time'].replace('Z', '+00:00')) if isinstance(r['time'], str) else datetime.fromtimestamp(r['time']/1000, timezone.utc)
    if prev:
        g = _session_gap_sec(prev, cur)
        if g > 15 * 60:
            gaps.append(g)
    prev = cur
if gaps:
    print(f"Простои в часы сессии NYSE (паузы >15 мин): {len(gaps)} раз, суммарно {sum(gaps)/60:.0f} мин (макс {max(gaps)/60:.0f} мин). Период отсчёта — с исходного старта, без сброса счёта.")
