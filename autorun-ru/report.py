#!/usr/bin/env python3
"""Сводка автосовета по акциям РФ (MOEX): python3 report.py"""
import json, os
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=5), 'Asia/Yekaterinburg')
here = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(os.path.join(here, 'log.jsonl'), encoding='utf-8') if l.strip()]
st = json.load(open(os.path.join(here, 'state.json'), encoding='utf-8'))
rounds = [r for r in rows if r['type'] == 'round']
t = lambda v: (datetime.fromisoformat(v.replace('Z', '+00:00')) if isinstance(v, str) else datetime.fromtimestamp(v / 1000, timezone.utc)).astimezone(TZ).strftime('%d.%m %H:%M')
rub = lambda x: f"{x:,.2f}".replace(',', ' ')
start, prices, a = st['start'], st['prices'], st['auto']
eq = st['balance'] + sum(p['qty'] * prices.get(p['pair'], p['entry']) for p in st['positions'].values())
pnl = eq - start
trades = [x['trade'] for x in rows if x.get('trade')] + [o['trade'] for r in rounds for o in r['results'] if o.get('trade')]
closed = [x for x in trades if x['side'] == 'sell']
buys = [x for x in trades if x['side'] == 'buy']
wins = [x for x in closed if x['pnl'] > 0]
s = st['settings']
print(f"Автосовет · акции РФ, MOEX {s.get('board', 'TQBR')} ({', '.join(s['tickers'])}) · свечи {s['tf']} · риск {s['riskPct']}% · до {s['maxPositions']} позиций · до {s['maxPosShare'] * 100:.0f}% на позицию · комиссия {s['fee'] * 100:.2f}%")
print(f"Период: {t(a['startedAt'])} – {t(rounds[-1]['time']) if rounds else '—'} (Екатеринбург), раундов в часы торгов: {len(rounds)}" + (' · завершён' if a.get('finished') else f" · идёт до {t(a['endsAt'])}"))
sess = {}
for r in rounds: sess[r.get('session') or '?'] = sess.get(r.get('session') or '?', 0) + 1
if sess: print('Раунды по сессиям: ' + ', '.join(f"{k} {v}" for k, v in sess.items()))
delays = [r['delayMin'] for r in rounds if r.get('delayMin') is not None]
if delays: print(f"Задержка котировок ISS: {min(delays)}–{max(delays)} мин (медиана {sorted(delays)[len(delays) // 2]})")
print(f"Капитал: {rub(start)} → {rub(eq)} ₽ (свободно {rub(st['balance'])})")
print(f"P&L: {pnl:+,.2f} ₽ ({pnl / start * 100:+.2f}%)".replace(',', ' '))
fees = sum(x.get('fee', 0) for x in trades)
print(f"Сделок: покупок {len(buys)}, закрытых {len(closed)}" + (f", винрейт {len(wins) / len(closed) * 100:.0f}% ({len(wins)}/{len(closed)})" if closed else '') + f", комиссий {rub(fees)} ₽")
if closed:
    fmt = lambda x: f"{x['pair']} {x['pnl']:+,.2f} ₽ ({x['entry']:.2f} → {x['price']:.2f}, {x['reason']})".replace(',', ' ')
    print('Лучшая: ' + fmt(max(closed, key=lambda x: x['pnl'])))
    print('Худшая: ' + fmt(min(closed, key=lambda x: x['pnl'])))
    by = {}
    for x in closed: by[x['pair']] = by.get(x['pair'], 0) + x['pnl']
    print('По тикерам: ' + ', '.join(f"{k} {v:+.2f}" for k, v in sorted(by.items(), key=lambda kv: -kv[1])))
for p in st['positions'].values():
    px = prices.get(p['pair'], p['entry'])
    print(f"Открыта: {p['pair']} {p['qty']:g} шт. ({p.get('lots', '?')} лот.) от {p['entry']:.2f}, сейчас {px:.2f} (P&L {(px - p['entry']) * p['qty']:+.2f} ₽), стоп {p['sl']:.2f}, тейк {p['tp']:.2f}")
b0, b1, bs = a.get('benchStart'), a.get('bench'), a.get('benchSym') or 'IMOEX'
if b0 and b1:
    bh = start * (b1 / b0 - 1)
    print(f"{bs}: {b0:.2f} → {b1:.2f} ({(b1 / b0 - 1) * 100:+.2f}%) — «купить индекс и держать» дало бы {bh:+,.2f} ₽; совет {'лучше' if pnl > bh else 'хуже'} на {abs(pnl - bh):,.2f} ₽".replace(',', ' '))
d = {}
for r in rounds:
    for o in r['results']: d[o['decision']] = d.get(o['decision'], 0) + 1
if d: print('Решения по тикерам: ' + ', '.join(f"{k} {v}" for k, v in d.items()))
vetoes = sum(1 for r in rounds for o in r['results'] if o.get('veto') and o.get('proposal') == 'buy')
if vetoes: print(f"Вето Риск-менеджера на покупки: {vetoes}")
errs = sum(1 for r in rows if r['type'] == 'error')
if errs: print(f"Ошибок получения данных: {errs}")
