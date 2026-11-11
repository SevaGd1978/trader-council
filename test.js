// Быстрый тест логики на реальных свечах: node test.js
const C = require('./public/council.js');
(async () => {
  const d = await (await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200')).json();
  const k = d.map((x) => x.slice(0, 6).map(Number));
  const s = C.newState(); const r = C.runRound(s, k);
  console.log(r.msgs.length, 'реплик, решение', r.final, r.confidence + '%', 'баланс', s.balance.toFixed(2));
  if (r.msgs.length < 7) throw new Error('мало реплик');
})();
