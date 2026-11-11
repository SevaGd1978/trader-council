#!/usr/bin/env python3
"""Сводка автосовета: python3 report.py [путь к log.jsonl]"""
import json, sys, os
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=5), 'Asia/Yekaterinburg')
here = os.path.dirname(os.path.abspath(__file__))
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'log.jsonl')
rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
state = json.load(open(os.path.join(here, 'state.json'), encoding='utf-8'))
rounds = [r for r in rows if r['type'] == 'round']
if not rounds:
    sys.exit('Раундов ещё не было')
priced = [r for r in rows if r.get('price') and r['type'] in ('round', 'stop', 'finish')]
t = lambda iso: datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(TZ).strftime('%d.%m %H:%M')
start_eq = state['start']
end = priced[-1]
end_eq = end['equity']
trades = [x['trade'] for x in rows if x.get('trade')]
closed = [x for x in trades if x['side'] == 'sell']
wins = [x for x in closed if x['pnl'] > 0]
p0, p1 = rounds[0]['price'], end['price']
pnl = end_eq - start_eq
pair = state['settings']['pair']
print(f"Автосовет · {pair}/USDT (тикер GRAM) · свечи {state['settings']['tf']} · риск {state['settings']['riskPct']}%")
print(f"Период: {t(rounds[0]['time'])} – {t(end['time'])} (Екатеринбург), раундов: {len(rounds)}" + (' · завершён' if state['auto'].get('finished') else ' · ещё идёт'))
print(f"Капитал: {start_eq:,.2f} → {end_eq:,.2f} USDT")
print(f"P&L: {pnl:+,.2f} USDT ({pnl / start_eq * 100:+.2f}%)")
print(f"Сделок: покупок {sum(1 for x in trades if x['side'] == 'buy')}, закрытых {len(closed)}, винрейт {len(wins) / len(closed) * 100:.0f}%" if closed else f"Сделок: покупок {sum(1 for x in trades if x['side'] == 'buy')}, закрытых 0")
if closed:
    b = max(closed, key=lambda x: x['pnl']); w = min(closed, key=lambda x: x['pnl'])
    fmt = lambda x: f"{x['pnl']:+.2f} USDT ({x['entry']} → {x['price']}, {x['reason']})"
    print(f"Лучшая: {fmt(b)}")
    print(f"Худшая: {fmt(w)}")
if state['positions']:
    for p in state['positions'].values():
        print(f"Открыта позиция: {p['qty']:.4f} {p['pair']} от {p['entry']} (P&L {(p1 - p['entry']) * p['qty']:+.2f} USDT)")
print(f"Цена {pair}: {p0} → {p1} ({(p1 / p0 - 1) * 100:+.2f}%) — для сравнения: «купить и держать» дало бы {start_eq * (p1 / p0 - 1):+,.2f} USDT")
d = {}
for r in rounds: d[r['decision']] = d.get(r['decision'], 0) + 1
print('Решения арбитра: ' + ', '.join(f"{k} {v}" for k, v in d.items()) + f"; вето: {sum(1 for r in rounds if r.get('veto') and r['proposal'] != 'hold')}")
errs = sum(1 for r in rows if r['type'] == 'error')
if errs: print(f"Ошибок получения данных: {errs}")
