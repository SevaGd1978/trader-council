// Акции США: автосовет каждые 10 минут, только в основную сессию NYSE. Демо-деньги, реальные котировки (Yahoo Finance).
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../public/council.js');

const DIR = __dirname;
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log.jsonl');
const SUMMARY = path.join(DIR, 'summary.json');
const TICKERS = (process.env.TICKERS || 'AAPL,TSLA,NVDA,MSFT,AMZN,META,GOOGL,SPY').split(',');
const TF = '5m', TF_MS = 5 * 60 * 1000;
const ROUND_MS = 10 * 60 * 1000;
const STOP_CHECK_MS = 60 * 1000;
const DURATION_MS = Number(process.env.DURATION_H || 24) * 3600 * 1000;
const START = 10000, FEE = 0.0005, RISK_PCT = 1, MAX_POS = 4, MAX_POS_SHARE = 0.2;

const UA = { 'user-agent': 'Mozilla/5.0' }; // полный UA браузера Yahoo режет 429 без cookie
async function j(url) { const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000); try { const r = await fetch(url, { signal: c.signal, headers: UA }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } }
const r2 = (x) => Math.round(x * 100) / 100;
const iso = () => new Date().toISOString();

// --- часы NYSE ---
function nyParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
function marketOpen(d = new Date()) { const { wd, min } = nyParts(d); return !['Sat', 'Sun'].includes(wd) && min >= 570 && min < 960; }

// --- данные: Yahoo Finance chart API, свечи 5m, только закрытые, проверка свежести ---
async function candles(sym) {
  const errs = [];
  for (const host of ['query1', 'query2']) {
    try {
      const d = await j(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?interval=${TF}&range=5d&includePrePost=false`);
      const res = d.chart && d.chart.result && d.chart.result[0]; if (!res) throw new Error('пустой ответ');
      const q = res.indicators.quote[0], ts = res.timestamp || [];
      const now = Date.now(); let k = [];
      for (let i = 0; i < ts.length; i++) { const t = ts[i] * 1000; if ([q.open[i], q.high[i], q.low[i], q.close[i]].some((x) => x == null)) continue; if (t + TF_MS > now) continue; k.push([t, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] || 0]); }
      k = k.slice(-200);
      if (k.length < 40) throw new Error('мало свечей');
      const m = res.meta, liveT = m.regularMarketTime * 1000, price = m.regularMarketPrice;
      if (now - liveT > 15 * 60 * 1000) throw new Error(`устаревшая цена (${Math.round((now - liveT) / 60000)} мин)`);
      if (now - k[k.length - 1][0] > 20 * 60 * 1000) throw new Error('устаревшие свечи');
      return { source: 'yahoo-' + host, candles: k, price, priceTime: liveT };
    } catch (e) { errs.push(host + ': ' + e.message); }
  }
  throw new Error(sym + ' — ' + errs.join('; '));
}
async function quote(sym) {
  const d = await j(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d`).catch(() => j(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d`));
  const m = d.chart.result[0].meta; if (Date.now() - m.regularMarketTime * 1000 > 15 * 60 * 1000) throw new Error('устарело');
  return m.regularMarketPrice;
}

// --- состояние ---
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
function save(st) { fs.writeFileSync(STATE + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(STATE + '.tmp', STATE); }
function load() {
  if (fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const st = { v: 1, market: 'US', start: START, balance: START, positions: {}, trades: [], rounds: [], round: 0, prices: {},
    settings: { tf: TF, riskPct: RISK_PCT, maxPositions: MAX_POS, maxPosShare: MAX_POS_SHARE, fee: FEE, tickers: TICKERS },
    auto: { startedAt: Date.now(), endsAt: Date.now() + DURATION_MS, lastRoundAt: 0, lastClosedLog: 0, spyStart: null, spyStartAt: null } };
  save(st); return st;
}
const equity = (st) => st.balance + Object.values(st.positions).reduce((s, p) => s + p.qty * (st.prices[p.pair] || p.entry), 0);

function buy(st, sym, price, plan, reason) {
  const cost = plan.qty * price, fee = cost * FEE;
  st.balance -= cost + fee;
  st.positions[sym] = { pair: sym, qty: plan.qty, entry: price, sl: plan.sl, tp: plan.tp, at: Date.now(), fee };
  const t = { id: Date.now(), side: 'buy', pair: sym, qty: plan.qty, price, fee: r2(fee), reason, at: Date.now() };
  st.trades.unshift(t); return t;
}
function sell(st, sym, price, reason) {
  const p = st.positions[sym]; if (!p) return null;
  const gross = p.qty * price, fee = gross * FEE; st.balance += gross - fee;
  const pnl = gross - fee - (p.qty * p.entry + p.fee);
  delete st.positions[sym];
  const t = { id: Date.now(), side: 'sell', pair: sym, qty: p.qty, price, fee: r2(fee), pnl: r2(pnl), entry: p.entry, reason, at: Date.now(), heldMin: Math.round((Date.now() - p.at) / 60000) };
  st.trades.unshift(t); st.trades = st.trades.slice(0, 500); return t;
}

// один тикер: совет через общую логику (dryRun, без исполнения)
function councilFor(st, sym, d) {
  const view = { balance: st.balance, positions: st.positions, round: st.round, settings: { pair: sym, tf: TF, riskPct: RISK_PCT } };
  const res = C.runRound(view, d.candles, { dryRun: true });
  // реплику Риск-менеджера про размер сделки пишем сами (у акций свои лимиты), вето «продавать нечего» оставляем
  const msgs = res.msgs.filter((m) => !(m.bot === 'risk' && res.proposal === 'buy' && !res.veto))
    .map((m) => m.name + ': ' + m.text.replace(/\/USDT/g, '').replace(/USDT/g, 'USD'));
  return { sym, price: d.price, analysisPrice: res.analysis.price, atr: res.analysis.atr, votes: res.votes, score: r2(res.score), proposal: res.proposal, veto: res.veto, decision: res.final, confidence: res.confidence, trade: null, msgs };
}
// исполнение: сначала продажи, потом покупки — от самого сильного сигнала; Риск-менеджер режет по лимитам
function execute(st, out) {
  for (const o of out) if (o.decision === 'sell' && st.positions[o.sym]) o.trade = sell(st, o.sym, o.price, `совет, уверенность ${o.confidence}%`);
  const buys = out.filter((o) => o.decision === 'buy').sort((x, y) => y.score - x.score);
  for (const o of buys) {
    const price = o.price, stopDist = Math.max(o.atr * 1.5, price * 0.004), eq = equity(st);
    let qty = (eq * RISK_PCT / 100) / stopDist;
    const cap = Math.min(eq * MAX_POS_SHARE, st.balance * 0.98);
    if (qty * price > cap) qty = cap / price;
    const plan = { qty, sl: price - stopDist, tp: price + stopDist * 2 };
    let veto = null;
    if (Object.keys(st.positions).length >= MAX_POS) veto = `лимит открытых позиций (${MAX_POS}) исчерпан, сигнал слабее уже купленных`;
    else if (qty * price < 50) veto = 'свободных денег слишком мало для сделки';
    if (veto) { o.veto = veto; o.decision = 'hold'; o.msgs.push('Риск-менеджер: ВЕТО: ' + veto + '.'); continue; }
    o.trade = buy(st, o.sym, price, plan, `совет, уверенность ${o.confidence}%`);
    o.msgs.push(`Риск-менеджер: Риск ${RISK_PCT}% капитала, стоп ${plan.sl.toFixed(2)} (1,5×ATR), тейк ${plan.tp.toFixed(2)} (R:R 1:2). Беру ${qty.toFixed(3)} ${o.sym} ≈ ${(qty * price).toFixed(0)} USD (не больше ${MAX_POS_SHARE * 100}% капитала), комиссия ${FEE * 100}%. Разрешаю.`);
  }
}

function writeSummary(st) {
  const eq = equity(st), closed = st.trades.filter((t) => t.side === 'sell');
  const spy0 = st.auto.spyStart, spy1 = st.prices.SPY;
  const s = { updatedAt: Date.now(), startedAt: st.auto.startedAt, endsAt: st.auto.endsAt, finished: !!st.auto.finished, marketOpen: marketOpen(),
    tickers: TICKERS, tf: TF, riskPct: RISK_PCT, maxPositions: MAX_POS, fee: FEE,
    start: st.start, balance: r2(st.balance), equity: r2(eq), pnl: r2(eq - st.start), pnlPct: Math.round((eq / st.start - 1) * 1e4) / 100,
    rounds: st.round, trades: closed.length, wins: closed.filter((t) => t.pnl > 0).length,
    spyStart: spy0, spy: spy1, spyPct: spy0 && spy1 ? Math.round((spy1 / spy0 - 1) * 1e4) / 100 : null,
    positions: Object.values(st.positions).map((p) => ({ ...p, price: st.prices[p.pair] })),
    recentTrades: st.trades.slice(0, 15), lastRound: st.rounds[st.rounds.length - 1] || null };
  fs.writeFileSync(SUMMARY, JSON.stringify(s)); return s;
}
let lastPublish = 0;
async function publish(force) {
  if (!process.env.GH_TOKEN || process.env.PUBLISH === '0') return;
  if (!force && Date.now() - lastPublish < 30 * 60 * 1000) return;
  lastPublish = Date.now();
  const repo = 'SevaGd1978/trader-council', p = 'auto/stocks.json';
  const h = { authorization: 'Bearer ' + process.env.GH_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'trader-council' };
  try {
    let sha; const g = await fetch(`https://api.github.com/repos/${repo}/contents/${p}?ref=gh-pages`, { headers: h });
    if (g.ok) sha = (await g.json()).sha;
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${p}`, { method: 'PUT', headers: h, body: JSON.stringify({ message: 'auto: stocks', branch: 'gh-pages', sha, content: Buffer.from(fs.readFileSync(SUMMARY)).toString('base64') }) });
    if (!r.ok) console.error('publish', r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.error('publish', e.message); }
}

// раунды по сетке настенных часов: :00, :10, :20 …
const slotOf = (t) => Math.floor(t / ROUND_MS);
async function round(st) {
  const out = [], errors = [];
  for (const sym of TICKERS) {
    try { const d = await candles(sym); st.prices[sym] = d.price; out.push({ ...councilFor(st, sym, d), source: d.source, priceTime: new Date(d.priceTime).toISOString() }); }
    catch (e) { errors.push(e.message); }
    await new Promise((r) => setTimeout(r, 400));
  }
  execute(st, out);
  if (!out.length) { log({ type: 'error', time: iso(), error: 'нет свежих котировок: ' + errors.join(' | ') }); save(st); return; } // повтор через минуту
  st.auto.lastRoundAt = Date.now();
  st.round++;
  if (!st.auto.spyStart && st.prices.SPY) { st.auto.spyStart = st.prices.SPY; st.auto.spyStartAt = Date.now(); }
  const eq = equity(st);
  const brief = out.map((o) => ({ sym: o.sym, price: o.price, score: o.score, decision: o.decision, confidence: o.confidence }));
  st.rounds.push({ at: Date.now(), n: st.round, results: brief }); st.rounds = st.rounds.slice(-30);
  log({ type: 'round', n: st.round, time: iso(), results: out, errors, balance: r2(st.balance), equity: r2(eq), open: Object.keys(st.positions), spy: st.prices.SPY });
  save(st); writeSummary(st); await publish(out.some((o) => o.trade));
  console.log(iso(), `round ${st.round}`, brief.map((b) => `${b.sym} ${b.price} ${b.decision}`).join(', '), 'eq', eq.toFixed(2), errors.length ? 'errors ' + errors.length : '');
}
async function stops(st) {
  const syms = Object.keys(st.positions); if (!syms.length) return;
  let any = false;
  for (const sym of syms) {
    let px; try { px = await quote(sym); } catch (_) { continue; }
    st.prices[sym] = px; const p = st.positions[sym];
    const reason = px <= p.sl ? 'стоп-лосс' : px >= p.tp ? 'тейк-профит' : null;
    if (reason) { const t = sell(st, sym, px, reason); any = true; log({ type: 'stop', time: iso(), sym, price: px, trade: t, balance: r2(st.balance), equity: r2(equity(st)) }); console.log(iso(), 'stop', sym, reason, t.pnl); }
  }
  save(st); if (any) { writeSummary(st); await publish(true); }
}

(async function main() {
  const st = load();
  console.log(iso(), 'start, ends', new Date(st.auto.endsAt).toISOString());
  for (;;) {
    if (Date.now() >= st.auto.endsAt) {
      if (!st.auto.finished) { st.auto.finished = true; log({ type: 'finish', time: iso(), balance: r2(st.balance), equity: r2(equity(st)), prices: st.prices, spy: st.prices.SPY }); save(st); writeSummary(st); await publish(true); }
      console.log('done'); fs.writeFileSync(path.join(DIR, 'DONE'), iso()); process.exit(0);
    }
    try {
      if (!marketOpen()) {
        if (Date.now() - (st.auto.lastClosedLog || 0) >= 3600 * 1000) { st.auto.lastClosedLog = Date.now(); log({ type: 'market_closed', time: iso(), equity: r2(equity(st)), open: Object.keys(st.positions) }); save(st); writeSummary(st); await publish(true); }
      } else if (slotOf(Date.now()) > slotOf(st.auto.lastRoundAt || 0)) await round(st);
      else await stops(st);
    } catch (e) { console.error(iso(), 'error', e.message); log({ type: 'error', time: iso(), error: e.message }); }
    const toNext = (slotOf(Date.now()) + 1) * ROUND_MS - Date.now();
    await new Promise((r) => setTimeout(r, Math.max(1000, Math.min(STOP_CHECK_MS, toNext + 2000))));
  }
})();
