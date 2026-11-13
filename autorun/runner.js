// Автосовет: раунд каждые 10 минут, 24 часа, демо-деньги на реальных котировках.
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../public/council.js');

const DIR = __dirname;
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log.jsonl');
const SUMMARY = path.join(DIR, 'summary.json');
const PAIR = process.env.PAIR || 'TON';
const TF = process.env.TF || '15m';
const ROUND_MS = 10 * 60 * 1000;
const STOP_CHECK_MS = 30 * 1000;
const DURATION_MS = 24 * 3600 * 1000;
const SYM = { TON: 'GRAM', BTC: 'BTC', ETH: 'ETH', NOT: 'NOT', DOGS: 'DOGS' };
const TFS = { '15m': { bin: '15m', okx: '15m', bybit: '15', ms: 9e5 }, '5m': { bin: '5m', okx: '5m', bybit: '5', ms: 3e5 }, '1h': { bin: '1h', okx: '1H', bybit: '60', ms: 36e5 } };

async function j(url) { const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000); try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } }
const N = (k) => k.slice(0, 6).map(Number);
async function candles(pair, tf) {
  const s = SYM[pair], T = TFS[tf], errs = [];
  const src = [
    ['binance', async () => (await j(`https://api.binance.com/api/v3/klines?symbol=${s}USDT&interval=${T.bin}&limit=200`)).map(N)],
    ['binance-vision', async () => (await j(`https://data-api.binance.vision/api/v3/klines?symbol=${s}USDT&interval=${T.bin}&limit=200`)).map(N)],
    ['okx', async () => { const d = await j(`https://www.okx.com/api/v5/market/candles?instId=${s}-USDT&bar=${T.okx}&limit=200`); if (d.code !== '0') throw new Error(d.msg); return d.data.map(N).reverse(); }],
    ['bybit', async () => { const d = await j(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${s}USDT&interval=${T.bybit}&limit=200`); if (d.retCode !== 0) throw new Error(d.retMsg); return d.result.list.map(N).reverse(); }],
  ];
  for (const [name, fn] of src) {
    try { const k = await fn(); if (k.length < 30) throw new Error('мало свечей'); if (Date.now() - k[k.length - 1][0] > T.ms * 3) throw new Error('устарело'); return { source: name, candles: k, price: k[k.length - 1][4] }; } catch (e) { errs.push(name + ': ' + e.message); }
  }
  throw new Error(errs.join('; '));
}
async function ticker(pair) {
  const s = SYM[pair];
  try { return Number((await j(`https://api.binance.com/api/v3/ticker/price?symbol=${s}USDT`)).price); } catch (_) {}
  try { return Number((await j(`https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT`)).data[0].last); } catch (_) {}
  return (await candles(pair, TF)).price;
}

const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
function save(st) { fs.writeFileSync(STATE + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(STATE + '.tmp', STATE); }
function load() {
  if (fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const st = C.newState(10000);
  st.settings = Object.assign(st.settings, { pair: PAIR, tf: TF, autoMin: 10 }); // риск по умолчанию 1%
  st.auto = { startedAt: Date.now(), endsAt: Date.now() + DURATION_MS, startPrice: null, lastRoundAt: 0, lastPrice: null };
  save(st); return st;
}
const equity = (st, px) => st.balance + Object.values(st.positions).reduce((s, p) => s + p.qty * px, 0);
const r2 = (x) => Math.round(x * 100) / 100;

function writeSummary(st) {
  const px = st.auto.lastPrice || st.auto.startPrice;
  const eq = equity(st, px);
  const closed = st.trades.filter((t) => t.side === 'sell');
  const s = {
    updatedAt: Date.now(), startedAt: st.auto.startedAt, endsAt: st.auto.endsAt, finished: !!st.auto.finished,
    pair: st.settings.pair, symbol: SYM[st.settings.pair] + '/USDT', tf: st.settings.tf, riskPct: st.settings.riskPct,
    start: st.start, balance: r2(st.balance), equity: r2(eq), pnl: r2(eq - st.start), pnlPct: Math.round((eq / st.start - 1) * 1e4) / 100,
    rounds: st.round, trades: closed.length, wins: closed.filter((t) => t.pnl > 0).length,
    startPrice: st.auto.startPrice, price: px,
    position: Object.values(st.positions)[0] || null,
    recentTrades: st.trades.slice(0, 15),
    recentRounds: st.rounds.slice(-12).reverse().map((r) => ({ at: r.at, price: r.price, votes: r.votes, score: Math.round(r.score * 100) / 100, final: r.final, confidence: r.confidence, veto: r.veto })),
  };
  fs.writeFileSync(SUMMARY, JSON.stringify(s));
  return s;
}

// публикация summary.json в ветку gh-pages (только чтение в Mini App)
let lastPublish = 0;
async function publish(force) {
  if (!process.env.GH_TOKEN || process.env.PUBLISH === '0') return;
  if (!force && Date.now() - lastPublish < 30 * 60 * 1000) return;
  lastPublish = Date.now();
  const repo = 'SevaGd1978/trader-council', p = 'auto/summary.json';
  const h = { authorization: 'Bearer ' + process.env.GH_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'trader-council' };
  try {
    let sha;
    const g = await fetch(`https://api.github.com/repos/${repo}/contents/${p}?ref=gh-pages`, { headers: h });
    if (g.ok) sha = (await g.json()).sha;
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${p}`, { method: 'PUT', headers: h, body: JSON.stringify({ message: 'auto: summary', branch: 'gh-pages', sha, content: Buffer.from(fs.readFileSync(SUMMARY)).toString('base64') }) });
    if (!r.ok) console.error('publish', r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.error('publish', e.message); }
}

// расписание по сетке: старт + n×10 мин (без накопления задержек); пропущенные слоты не догоняем
function nextDue(st) {
  if (!st.auto.lastRoundAt) return 0;
  const slot = Math.floor((st.auto.lastRoundAt - st.auto.startedAt + 1000) / ROUND_MS) + 1;
  return st.auto.startedAt + slot * ROUND_MS;
}
async function round(st) {
  const due = nextDue(st); const lateSec = due ? Math.round((Date.now() - due) / 1000) : 0;
  const d = await candles(st.settings.pair, st.settings.tf);
  const sent = await C.fetchSentiment('crypto', { pair: st.settings.pair });
  const res = C.runRound(st, d.candles, { sentiment: sent });
  if (!st.auto.startPrice) st.auto.startPrice = d.price;
  st.auto.lastPrice = d.price; st.auto.lastRoundAt = Date.now();
  delete res.analysis;
  st.rounds.push(res); st.rounds = st.rounds.slice(-20);
  const eq = equity(st, d.price);
  log({ type: 'round', n: st.round, time: new Date().toISOString(), lateSec, price: d.price, source: d.source, votes: res.votes, score: r2(res.score), proposal: res.proposal, veto: res.veto, decision: res.final, confidence: res.confidence, trade: res.trade, balance: r2(st.balance), equity: r2(eq), messages: res.msgs.map((m) => m.name + ': ' + m.text) });
  save(st); writeSummary(st);
  await publish(!!res.trade);
  console.log(new Date().toISOString(), `round ${st.round} ${d.price} ${res.final} ${res.confidence}% eq ${eq.toFixed(2)}`);
}
async function stops(st) {
  if (!Object.keys(st.positions).length) return;
  const px = await ticker(st.settings.pair);
  st.auto.lastPrice = px;
  const closed = C.checkStops(st, { [st.settings.pair]: px });
  for (const t of closed) {
    log({ type: 'stop', time: new Date().toISOString(), price: px, trade: t, balance: r2(st.balance), equity: r2(equity(st, px)) });
    console.log(new Date().toISOString(), 'stop', t.reason, t.pnl);
  }
  if (closed.length) { save(st); writeSummary(st); await publish(true); }
}

function applyExtend(st) {
  const f = path.join(DIR, 'extend-until');
  if (!fs.existsSync(f)) return;
  const v = Number(String(fs.readFileSync(f, 'utf8')).trim());
  if (!Number.isFinite(v) || v <= st.auto.endsAt) return;
  st.auto.endsAt = v;
  if (st.auto.finished) st.auto.finished = false;
  save(st); writeSummary(st);
  console.log(new Date().toISOString(), 'extended until', new Date(v).toISOString());
}

(async function main() {
  const st = load();
  applyExtend(st);
  console.log('start, ends', new Date(st.auto.endsAt).toISOString());
  let lastBeat = Date.now();
  for (;;) {
    const gap = Date.now() - lastBeat;
    if (gap > 3 * 60 * 1000) {
      log({ type: 'wakeup', time: new Date().toISOString(), sleptMs: gap });
      console.log(new Date().toISOString(), 'wakeup after', Math.round(gap / 1000), 's');
    }
    lastBeat = Date.now();
    applyExtend(st);
    if (Date.now() >= st.auto.endsAt) {
      if (!st.auto.finished) {
        st.auto.finished = true; const px = await ticker(st.settings.pair).catch(() => st.auto.lastPrice); st.auto.lastPrice = px;
        log({ type: 'finish', time: new Date().toISOString(), price: px, balance: r2(st.balance), equity: r2(equity(st, px)) });
        save(st); writeSummary(st); await publish(true);
      }
      console.log('24h done'); fs.writeFileSync(path.join(DIR, 'DONE'), new Date().toISOString()); process.exit(0);
    }
    try {
      if (Date.now() >= nextDue(st)) await round(st);
      else await stops(st);
    } catch (e) { console.error(new Date().toISOString(), 'error', e.message); log({ type: 'error', time: new Date().toISOString(), error: e.message }); }
    const nextRound = nextDue(st) - Date.now();
    await new Promise((r) => setTimeout(r, Math.max(1000, Math.min(STOP_CHECK_MS, nextRound))));
  }
})();
