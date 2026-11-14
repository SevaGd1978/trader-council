// Быстрый тест логики на реальных свечах: node test.js
const C = require('./public/council.js');
async function klines() {
  const src = [
    'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200',
    'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200',
  ];
  for (const u of src) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      if (Array.isArray(d) && d.length > 50) return d.map((x) => x.slice(0, 6).map(Number));
    } catch (e) { console.warn('klines fail', u, e.message); }
  }
  throw new Error('нет свечей для теста');
}
(async () => {
  const k = await klines();
  const sent = await C.fetchSentiment('crypto', { pair: 'BTC' });
  const s = C.newState(); const r = C.runRound(s, k, { sentiment: sent });
  const names = r.msgs.map((m) => m.bot);
  console.log(r.msgs.length, 'реплик, решение', r.final, r.confidence + '%', 'баланс', s.balance.toFixed(2));
  console.log('votes', r.votes);
  console.log('news ok', sent.ok, sent.label, 'levels', r.analysis.levels.event, 'div', r.analysis.div, 'range', r.analysis.range);
  if (r.msgs.length < 12) throw new Error('мало реплик');
  for (const id of ['trend', 'contra', 'volume', 'div', 'news', 'levels', 'range', 'risk', 'arbiter']) {
    if (!names.includes(id)) throw new Error('нет реплик от ' + id);
  }
  if (Object.keys(r.votes).length !== 7) throw new Error('ожидали 7 голосов аналитиков');
  const failed = await C.fetchSentiment('crypto'); // cached ok is fine
  const bad = await C.fetchSentiment('us', { symbol: '' });
  if (bad.ok) throw new Error('пустой тикер должен деградировать');
  // сбой новостей → нейтральный голос
  const k2 = k.slice();
  const hold = C.runRound(C.newState(), k2, { dryRun: true, sentiment: { ok: false, source: 't', detail: 'тест' } });
  if (hold.votes.news !== 'hold') throw new Error('news should be hold on failure');
  // дивергент и флетовик присутствуют в анализе
  const rh = C.runRound(C.newState(), k2, { dryRun: true, sentiment: { ok: false, detail: 'x' } });
  if (!('div' in rh.votes) || !('range' in rh.votes)) throw new Error('нет голосов Дивергента/Флетовика');
  if ('vola' in rh.votes || 'candle' in rh.votes) throw new Error('старые эксперты не должны голосовать');
  console.log('v2 votes', rh.votes, 'div', rh.analysis.div, 'range', rh.analysis.range, 'thr', C.POLICY.enterThr);
  const us = await C.fetchSentiment('us', { symbol: 'AAPL' });
  console.log('yahoo', us.ok, us.label, (us.detail || us.error || '').slice(0, 180));
  console.log('OK');
})();
