// Акции РФ (MOEX, режим TQBR): автосовет каждые 10 минут в часы торгов. Демо-деньги, реальные котировки MOEX ISS (без подписки — с задержкой ~15 мин).
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../public/council.js');

const DIR = __dirname;
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log.jsonl');
const SUMMARY = path.join(DIR, 'summary.json');
const TICKERS = (process.env.TICKERS || 'SBER,GAZP,LKOH,YDEX,GMKN,ROSN,NVTK,TATN,MGNT,MOEX').split(',');
const TF = '10m', TF_MS = 10 * 60 * 1000;
const ROUND_MS = 10 * 60 * 1000;
const STOP_CHECK_MS = 60 * 1000;
const ENDS_AT = Number(process.env.ENDS_AT || 0) || Date.now() + Number(process.env.DURATION_H || 24) * 3600 * 1000;
const START = 1000000, FEE = 0.0005, RISK_PCT = 1, MAX_POS = 4, MAX_POS_SHARE = 0.2;
const ISS = 'https://iss.moex.com/iss';
// правило свежести: ISS без подписки отдаёт сделки с задержкой ~15 мин; терпим до 27 мин по цене и до 37 мин по последней закрытой свече
const MAX_PRICE_AGE_MIN = 27, MAX_CANDLE_AGE_MIN = 37;

// ISS из этой сети нестабильно отвечает fetch'у (undici рвёт соединения) — ходим через curl, короткий таймаут и несколько попыток
const { execFile } = require('child_process');
function curl(url) {
  return new Promise((res, rej) => execFile('curl', ['-sS', '--compressed', '-m', '20', '-A', 'trader-council-demo', '-w', '\n%{http_code}', url], { maxBuffer: 20 * 1024 * 1024 }, (e, out) => {
    if (e) return rej(new Error('curl: ' + (e.message || '').split('\n')[0].slice(0, 120)));
    const i = out.lastIndexOf('\n'); const code = out.slice(i + 1).trim(); if (code !== '200') return rej(new Error('HTTP ' + code));
    try { res(JSON.parse(out.slice(0, i))); } catch (x) { rej(new Error('bad json')); }
  }));
}
// «хеджированные» запросы: новая попытка каждые 5 с, пока предыдущие висят (до 3 одновременно, до 8 всего); берём первый успешный ответ
function j(url, total = 8) {
  return new Promise((resolve, reject) => {
    let started = 0, failed = 0, done = false, last; const timers = [];
    const fire = () => {
      if (done || started >= total) return; started++;
      curl(url).then((d) => { if (!done) { done = true; timers.forEach(clearTimeout); resolve(d); } }, (e) => {
        last = e; failed++;
        if (failed >= total && !done) { done = true; timers.forEach(clearTimeout); reject(last); }
        else if (started - failed < 1) fire();
      });
      if (started - failed < 3) timers.push(setTimeout(fire, 5000));
    };
    fire();
  });
}
const r2 = (x) => Math.round(x * 100) / 100;
const iso = () => new Date().toISOString();
const msk = (s) => Date.parse(s.replace(' ', 'T') + '+03:00'); // ISS отдаёт время по Москве
const table = (t) => t.data.map((row) => Object.fromEntries(t.columns.map((c, i) => [c, row[i]])));

// --- расписание MOEX (по Москве) ---
// будни: утренняя сессия 07:00–09:50, основная 10:00–18:40 (+аукцион закрытия до 18:50), вечерняя 19:05–23:50; выходные: 10:00–19:00
function mskParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const H = (h, m = 0) => h * 60 + m;
function session(d = new Date()) {
  const { wd, min } = mskParts(d);
  if (['Sat', 'Sun'].includes(wd)) return min >= H(10) && min < H(19) ? 'выходного дня' : null;
  if (min >= H(7) && min < H(9, 50)) return 'утренняя';
  if (min >= H(10) && min < H(18, 40)) return 'основная';
  if (min >= H(19, 5) && min < H(23, 50)) return 'вечерняя';
  return null;
}

// --- данные MOEX ISS ---
// пакетный снимок: цена последней сделки, лот, статус торгов, время данных и задержка
async function snapshot() {
  const d = await j(`${ISS}/engines/stock/markets/shares/boards/TQBR/securities.json?securities=${TICKERS.join(',')}&iss.meta=off&securities.columns=SECID,LOTSIZE,PREVPRICE&marketdata.columns=SECID,LAST,UPDATETIME,TIME,SYSTIME,TRADINGSTATUS,TRADINGSESSION`);
  const sec = Object.fromEntries(table(d.securities).map((r) => [r.SECID, r]));
  const out = {};
  for (const m of table(d.marketdata)) {
    const sys = msk(m.SYSTIME), day = m.SYSTIME.slice(0, 10);
    let upd = msk(day + ' ' + m.UPDATETIME); if (upd > sys + 60000) upd -= 86400000;
    out[m.SECID] = { price: m.LAST, lot: sec[m.SECID] ? sec[m.SECID].LOTSIZE : 1, dataTime: upd, sysTime: sys, delayMin: Math.round((sys - upd) / 60000), lastTradeTime: m.TIME, status: m.TRADINGSTATUS };
  }
  return out;
}
const CACHE = {}; // свечи по тикерам в памяти процесса
async function candles(sym, snap) {
  const from5 = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const cache = CACHE[sym];
  const from = cache && cache.length >= 200 ? new Date(Date.now() - 86400000).toISOString().slice(0, 10) : from5; // после первой загрузки догружаем только последние сутки
  let rows = [];
  for (let start = 0; start < 3000; start += 500) { // ISS отдаёт свечи страницами по 500
    const d = await j(`${ISS}/engines/stock/markets/shares/boards/TQBR/securities/${sym}/candles.json?interval=10&from=${from}&start=${start}&iss.meta=off&candles.columns=begin,end,open,high,low,close,volume`);
    const part = table(d.candles); rows = rows.concat(part); if (part.length < 500) break;
  }
  const s = snap[sym]; if (!s || !s.price) throw new Error(sym + ': нет цены');
  if ((s.sysTime - s.dataTime) / 60000 > MAX_PRICE_AGE_MIN) throw new Error(`${sym}: устаревшая цена (${s.delayMin} мин)`);
  // только закрытые свечи: конец свечи раньше момента, по который есть данные
  const fresh = rows.map((c) => [msk(c.begin), c.open, c.high, c.low, c.close, c.volume || 0, msk(c.end)])
    .filter((c) => c[6] < s.dataTime).map((c) => c.slice(0, 6));
  const byT = new Map((cache || []).map((c) => [c[0], c])); fresh.forEach((c) => byT.set(c[0], c));
  let k = [...byT.values()].sort((a, b) => a[0] - b[0]).slice(-200);
  CACHE[sym] = k;
  if (k.length < 40) throw new Error(sym + ': мало свечей');
  const candleAge = (s.sysTime - (k[k.length - 1][0] + TF_MS)) / 60000;
  if (candleAge > MAX_CANDLE_AGE_MIN) throw new Error(`${sym}: устаревшие свечи (${Math.round(candleAge)} мин)`);
  return { source: 'moex-iss', candles: k, price: s.price, priceTime: s.dataTime, delayMin: s.delayMin, lot: s.lot };
}
// бенчмарк: индекс МосБиржи (IMOEX) — его ISS отдаёт в реальном времени; запасной вариант — фонд TMOS
async function benchmark() {
  try {
    const d = await j(`${ISS}/engines/stock/markets/index/boards/SNDX/securities/IMOEX.json?iss.meta=off&iss.only=marketdata&marketdata.columns=SECID,CURRENTVALUE,LASTVALUE,UPDATETIME`);
    const m = table(d.marketdata)[0]; const v = m.CURRENTVALUE || m.LASTVALUE; if (v) return { sym: 'IMOEX', value: v, time: m.UPDATETIME };
  } catch (_) {}
  const d = await j(`${ISS}/engines/stock/markets/shares/boards/TQTF/securities/TMOS.json?iss.meta=off&iss.only=marketdata&marketdata.columns=SECID,LAST,UPDATETIME`);
  const m = table(d.marketdata)[0]; return { sym: 'TMOS', value: m.LAST, time: m.UPDATETIME };
}

// --- состояние ---
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
function save(st) { fs.writeFileSync(STATE + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(STATE + '.tmp', STATE); }
function load() {
  if (fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const st = { v: 1, market: 'RU', start: START, balance: START, positions: {}, trades: [], rounds: [], round: 0, prices: {}, lots: {},
    settings: { tf: TF, riskPct: RISK_PCT, maxPositions: MAX_POS, maxPosShare: MAX_POS_SHARE, fee: FEE, tickers: TICKERS, board: 'TQBR' },
    auto: { startedAt: Date.now(), endsAt: ENDS_AT, lastRoundAt: 0, lastClosedLog: 0, benchSym: null, benchStart: null, benchStartAt: null, bench: null, delayMin: null } };
  save(st); return st;
}
const equity = (st) => st.balance + Object.values(st.positions).reduce((s, p) => s + p.qty * (st.prices[p.pair] || p.entry), 0);

function buy(st, sym, price, plan, reason) {
  const cost = plan.qty * price, fee = cost * FEE;
  st.balance -= cost + fee;
  st.positions[sym] = { pair: sym, qty: plan.qty, lots: plan.lots, lot: plan.lot, entry: price, sl: plan.sl, tp: plan.tp, at: Date.now(), fee };
  const t = { id: Date.now(), side: 'buy', pair: sym, qty: plan.qty, lots: plan.lots, price, fee: r2(fee), reason, at: Date.now() };
  st.trades.unshift(t); return t;
}
function sell(st, sym, price, reason) {
  const p = st.positions[sym]; if (!p) return null;
  const gross = p.qty * price, fee = gross * FEE; st.balance += gross - fee;
  const pnl = gross - fee - (p.qty * p.entry + p.fee);
  delete st.positions[sym];
  const t = { id: Date.now(), side: 'sell', pair: sym, qty: p.qty, lots: p.lots, price, fee: r2(fee), pnl: r2(pnl), entry: p.entry, reason, at: Date.now(), heldMin: Math.round((Date.now() - p.at) / 60000) };
  st.trades.unshift(t); st.trades = st.trades.slice(0, 500); return t;
}

function councilFor(st, sym, d) {
  const view = { balance: st.balance, positions: st.positions, round: st.round, settings: { pair: sym, tf: TF, riskPct: RISK_PCT } };
  const res = C.runRound(view, d.candles, { dryRun: true });
  const msgs = res.msgs.filter((m) => !(m.bot === 'risk' && res.proposal === 'buy' && !res.veto))
    .map((m) => m.name + ': ' + m.text.replace(/\/USDT/g, '').replace(/USDT/g, '₽'));
  return { sym, price: d.price, lot: d.lot, analysisPrice: res.analysis.price, atr: res.analysis.atr, votes: res.votes, score: r2(res.score), proposal: res.proposal, veto: res.veto, decision: res.final, confidence: res.confidence, trade: null, msgs };
}
// исполнение: сначала продажи, потом покупки от самого сильного сигнала; объём кратен лоту
function execute(st, out) {
  for (const o of out) if (o.decision === 'sell' && st.positions[o.sym]) o.trade = sell(st, o.sym, o.price, `совет, уверенность ${o.confidence}%`);
  const buys = out.filter((o) => o.decision === 'buy').sort((x, y) => y.score - x.score);
  for (const o of buys) {
    if (st.positions[o.sym]) continue;
    const price = o.price, lot = o.lot || 1, stopDist = Math.max(o.atr * 1.5, price * 0.004), eq = equity(st);
    let qty = (eq * RISK_PCT / 100) / stopDist;
    const cap = Math.min(eq * MAX_POS_SHARE, st.balance * 0.98);
    if (qty * price > cap) qty = cap / price;
    const lots = Math.floor(qty / lot); qty = lots * lot;
    const plan = { qty, lots, lot, sl: price - stopDist, tp: price + stopDist * 2 };
    let veto = null;
    if (Object.keys(st.positions).length >= MAX_POS) veto = `лимит открытых позиций (${MAX_POS}) исчерпан, сигнал слабее уже купленных`;
    else if (lots < 1) veto = `денег не хватает даже на один лот (${lot} шт.)`;
    if (veto) { o.veto = veto; o.decision = 'hold'; o.msgs.push('Риск-менеджер: ВЕТО: ' + veto + '.'); continue; }
    o.trade = buy(st, o.sym, price, plan, `совет, уверенность ${o.confidence}%`);
    o.msgs.push(`Риск-менеджер: Риск ${RISK_PCT}% капитала, стоп ${plan.sl.toFixed(2)} (1,5×ATR), тейк ${plan.tp.toFixed(2)} (R:R 1:2). Беру ${lots} лот(ов) по ${lot} = ${qty} шт. ${o.sym} ≈ ${(qty * price).toFixed(0)} ₽ (не больше ${MAX_POS_SHARE * 100}% капитала), комиссия ${FEE * 100}%. Разрешаю.`);
  }
}

function writeSummary(st) {
  const eq = equity(st), closed = st.trades.filter((t) => t.side === 'sell');
  const b0 = st.auto.benchStart, b1 = st.auto.bench;
  const s = { updatedAt: Date.now(), startedAt: st.auto.startedAt, endsAt: st.auto.endsAt, finished: !!st.auto.finished, marketOpen: !!session(), session: session(),
    tickers: TICKERS, tf: TF, riskPct: RISK_PCT, maxPositions: MAX_POS, fee: FEE, currency: 'RUB', delayMin: st.auto.delayMin,
    start: st.start, balance: r2(st.balance), equity: r2(eq), pnl: r2(eq - st.start), pnlPct: Math.round((eq / st.start - 1) * 1e4) / 100,
    rounds: st.round, trades: closed.length, wins: closed.filter((t) => t.pnl > 0).length,
    benchSym: st.auto.benchSym, benchStart: b0, bench: b1, benchPct: b0 && b1 ? Math.round((b1 / b0 - 1) * 1e4) / 100 : null,
    positions: Object.values(st.positions).map((p) => ({ ...p, price: st.prices[p.pair] })),
    recentTrades: st.trades.slice(0, 15), lastRound: st.rounds[st.rounds.length - 1] || null };
  fs.writeFileSync(SUMMARY, JSON.stringify(s)); return s;
}
let lastPublish = 0;
async function publish(force) {
  if (!process.env.GH_TOKEN || process.env.PUBLISH === '0') return;
  if (!force && Date.now() - lastPublish < 30 * 60 * 1000) return;
  lastPublish = Date.now();
  const repo = 'SevaGd1978/trader-council', p = 'auto/ru.json';
  const h = { authorization: 'Bearer ' + process.env.GH_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'trader-council' };
  for (let attempt = 0; attempt < 4; attempt++) { // 409 — ветку gh-pages параллельно обновили другие раннеры, берём свежий sha и повторяем
    try {
      let sha; const g = await fetch(`https://api.github.com/repos/${repo}/contents/${p}?ref=gh-pages`, { headers: h });
      if (g.ok) sha = (await g.json()).sha;
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/${p}`, { method: 'PUT', headers: h, body: JSON.stringify({ message: 'auto: ru', branch: 'gh-pages', sha, content: Buffer.from(fs.readFileSync(SUMMARY)).toString('base64') }) });
      if (r.ok) return;
      const txt = (await r.text()).slice(0, 200);
      if (r.status !== 409 && r.status !== 422) { console.error('publish', r.status, txt); return; }
    } catch (e) { console.error('publish', e.message); }
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));
  }
  console.error('publish: не удалось после 4 попыток');
}

async function updBench(st) {
  try { const b = await benchmark(); if (!st.auto.benchStart || st.auto.benchSym !== b.sym) { st.auto.benchSym = b.sym; st.auto.benchStart = b.value; st.auto.benchStartAt = Date.now(); } st.auto.bench = b.value; } catch (_) {}
}

const slotOf = (t) => Math.floor(t / ROUND_MS);
async function round(st) {
  const out = [], errors = [];
  let snap; try { snap = await snapshot(); } catch (e) { log({ type: 'error', time: iso(), error: 'снимок ISS: ' + e.message }); return; }
  const got = await Promise.all(TICKERS.map((sym, i) => new Promise((r) => setTimeout(r, i * 400)).then(() => candles(sym, snap)).then((d) => ({ sym, d }), (e) => ({ sym, e }))));
  for (const { sym, d, e } of got) {
    if (e) { errors.push(e.message); continue; }
    st.prices[sym] = d.price; st.lots[sym] = d.lot; out.push({ ...councilFor(st, sym, d), source: d.source, delayMin: d.delayMin, priceTime: new Date(d.priceTime).toISOString() });
  }
  if (!out.length) { log({ type: 'error', time: iso(), error: 'нет свежих котировок: ' + errors.join(' | ') }); save(st); return; } // повтор через минуту
  execute(st, out);
  await updBench(st);
  const delays = out.map((o) => o.delayMin).sort((a, b) => a - b); st.auto.delayMin = delays[Math.floor(delays.length / 2)];
  st.auto.lastRoundAt = Date.now();
  st.round++;
  const eq = equity(st);
  const brief = out.map((o) => ({ sym: o.sym, price: o.price, score: o.score, decision: o.decision, confidence: o.confidence }));
  st.rounds.push({ at: Date.now(), n: st.round, session: session(), delayMin: st.auto.delayMin, results: brief }); st.rounds = st.rounds.slice(-30);
  log({ type: 'round', n: st.round, time: iso(), session: session(), delayMin: st.auto.delayMin, results: out, errors, balance: r2(st.balance), equity: r2(eq), open: Object.keys(st.positions), bench: { sym: st.auto.benchSym, value: st.auto.bench } });
  save(st); writeSummary(st); await publish(out.some((o) => o.trade) || st.round === 1);
  console.log(iso(), `round ${st.round} (delay ${st.auto.delayMin}m)`, brief.map((b) => `${b.sym} ${b.price} ${b.decision}`).join(', '), 'eq', eq.toFixed(2), errors.length ? 'errors ' + errors.join('; ') : '');
}
async function stops(st) {
  const syms = Object.keys(st.positions); if (!syms.length) return;
  let snap; try { snap = await snapshot(); } catch (_) { return; }
  let any = false;
  for (const sym of syms) {
    const s = snap[sym]; if (!s || !s.price || (s.sysTime - s.dataTime) / 60000 > MAX_PRICE_AGE_MIN) continue;
    const px = s.price; st.prices[sym] = px; const p = st.positions[sym];
    const reason = px <= p.sl ? 'стоп-лосс' : px >= p.tp ? 'тейк-профит' : null;
    if (reason) { const t = sell(st, sym, px, reason); any = true; log({ type: 'stop', time: iso(), sym, price: px, trade: t, balance: r2(st.balance), equity: r2(equity(st)) }); console.log(iso(), 'stop', sym, reason, t.pnl); }
  }
  save(st); if (any) { writeSummary(st); await publish(true); }
}
function applyExtend(st) {
  const f = path.join(DIR, 'extend-until'); if (!fs.existsSync(f)) return;
  const v = Number(String(fs.readFileSync(f, 'utf8')).trim());
  if (!Number.isFinite(v) || v <= st.auto.endsAt) return;
  st.auto.endsAt = v; st.auto.finished = false; save(st); writeSummary(st);
}

(async function main() {
  const st = load();
  console.log(iso(), 'start, ends', new Date(st.auto.endsAt).toISOString());
  for (;;) {
    applyExtend(st);
    if (Date.now() >= st.auto.endsAt) {
      if (!st.auto.finished) { await updBench(st); st.auto.finished = true; log({ type: 'finish', time: iso(), balance: r2(st.balance), equity: r2(equity(st)), prices: st.prices, bench: { sym: st.auto.benchSym, value: st.auto.bench } }); save(st); writeSummary(st); await publish(true); }
      console.log('done'); fs.writeFileSync(path.join(DIR, 'DONE'), iso()); process.exit(0);
    }
    try {
      if (!session()) {
        if (Date.now() - (st.auto.lastClosedLog || 0) >= 3600 * 1000) { st.auto.lastClosedLog = Date.now(); log({ type: 'market_closed', time: iso(), equity: r2(equity(st)), open: Object.keys(st.positions) }); save(st); writeSummary(st); await publish(true); }
      } else if (slotOf(Date.now()) > slotOf(st.auto.lastRoundAt || 0)) await round(st);
      else await stops(st);
    } catch (e) { console.error(iso(), 'error', e.message); log({ type: 'error', time: iso(), error: e.message }); }
    const toNext = (slotOf(Date.now()) + 1) * ROUND_MS - Date.now();
    await new Promise((r) => setTimeout(r, Math.max(1000, Math.min(STOP_CHECK_MS, toNext + 2000))));
  }
})();
