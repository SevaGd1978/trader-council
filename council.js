// Логика совета: индикаторы, 6 ботов, дебаты, решение, демо-сделки. Работает и в браузере, и в Node.
(function (root) {
  'use strict';
  // ---------- индикаторы ----------
  const ema = (a, n) => { const k = 2 / (n + 1); const o = [a[0]]; for (let i = 1; i < a.length; i++) o.push(a[i] * k + o[i - 1] * (1 - k)); return o; };
  const sma = (a, n) => a.map((_, i) => i < n - 1 ? NaN : a.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n);
  const std = (a, n) => a.map((_, i) => { if (i < n - 1) return NaN; const w = a.slice(i - n + 1, i + 1); const m = w.reduce((s, x) => s + x, 0) / n; return Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / n); });
  function rsi(c, n = 14) {
    let g = 0, l = 0; const out = Array(c.length).fill(NaN);
    for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d; }
    g /= n; l /= n; out[n] = 100 - 100 / (1 + g / (l || 1e-12));
    for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-12)); }
    return out;
  }
  function atr(k, n = 14) {
    const tr = k.map((x, i) => i === 0 ? x[2] - x[3] : Math.max(x[2] - x[3], Math.abs(x[2] - k[i - 1][4]), Math.abs(x[3] - k[i - 1][4])));
    const o = [tr[0]]; for (let i = 1; i < tr.length; i++) o.push((o[i - 1] * (n - 1) + tr[i]) / n); return o;
  }
  function obv(k) { const o = [0]; for (let i = 1; i < k.length; i++) o.push(o[i - 1] + (k[i][4] > k[i - 1][4] ? k[i][5] : k[i][4] < k[i - 1][4] ? -k[i][5] : 0)); return o; }
  const last = (a) => a[a.length - 1];
  const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
  const pct = (x, d = 2) => (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
  function fmt(p) { if (!isFinite(p)) return '—'; if (p >= 1000) return p.toLocaleString('ru-RU', { maximumFractionDigits: 0 }); if (p >= 1) return p.toFixed(3); const d = Math.max(2, -Math.floor(Math.log10(p)) + 3); return p.toFixed(d); }
  const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

  const BOTS = {
    trend: { name: 'Трендовик', emoji: '📈', color: '#3b82f6', role: 'EMA 9/21' },
    contra: { name: 'Контрарианец', emoji: '🔄', color: '#a855f7', role: 'RSI 14 / возврат к среднему' },
    volume: { name: 'Объёмщик', emoji: '📊', color: '#f59e0b', role: 'Объёмы / OBV' },
    vola: { name: 'Волатильщик', emoji: '⚡', color: '#ef4444', role: 'Боллинджер 20,2 / ATR' },
    risk: { name: 'Риск-менеджер', emoji: '🛡️', color: '#10b981', role: 'Размер позиции, стоп, тейк, вето' },
    arbiter: { name: 'Арбитр', emoji: '⚖️', color: '#64748b', role: 'Взвешивает голоса и решает' },
  };
  const WEIGHTS = { trend: 1.2, contra: 1.0, volume: 0.9, vola: 1.0 };
  const VOTE_RU = { buy: 'ПОКУПКА', sell: 'ПРОДАЖА', hold: 'ЖДАТЬ' };
  const VOTE_ICON = { buy: '🟢', sell: '🔴', hold: '⚪' };
  const toVote = (s) => s > 0.2 ? 'buy' : s < -0.2 ? 'sell' : 'hold';

  // ---------- аналитики ----------
  function analyze(k) {
    const c = k.map((x) => x[4]); const n = c.length; const price = c[n - 1];
    const e9 = ema(c, 9), e21 = ema(c, 21);
    const gap = (last(e9) - last(e21)) / last(e21);
    let crossAgo = null; for (let i = n - 1; i > n - 15; i--) { if (Math.sign(e9[i] - e21[i]) !== Math.sign(e9[i - 1] - e21[i - 1])) { crossAgo = n - 1 - i; break; } }
    const slope = (last(e21) - e21[n - 6]) / e21[n - 6];
    const A = atr(k); const atrPct = last(A) / price;
    let tScore = clamp(gap / (atrPct * 1.5 || 1e-9)); if (crossAgo !== null && crossAgo <= 3) tScore = clamp(tScore * 1.4);
    if (Math.sign(slope) !== Math.sign(gap)) tScore *= 0.5;

    const R = rsi(c); const r = last(R); const s20 = last(sma(c, 20)); const dev = (price - s20) / s20;
    let cScore = r < 30 ? (30 - r) / 15 + 0.3 : r > 70 ? -((r - 70) / 15 + 0.3) : (50 - r) / 60;
    cScore = clamp(cScore - dev / (atrPct * 6 || 1e-9) * 0.3);

    const O = obv(k); const obvSlope = (last(O) - O[n - 11]); const volAvg = k.slice(n - 21, n - 1).reduce((s, x) => s + x[5], 0) / 20;
    const volRatio = k[n - 1][5] / (volAvg || 1e-9); const lastDir = Math.sign(c[n - 1] - c[n - 2]);
    const priceCh10 = (price - c[n - 11]) / c[n - 11];
    const obvNorm = obvSlope / (volAvg * 10 || 1e-9);
    let vScore = clamp(obvNorm * 1.2 + (volRatio > 1.5 ? lastDir * 0.3 : 0));
    const divergence = Math.sign(obvNorm) !== Math.sign(priceCh10) && Math.abs(obvNorm) > 0.15;

    const sd = last(std(c, 20)); const up = s20 + 2 * sd, lo = s20 - 2 * sd; const pb = (price - lo) / ((up - lo) || 1e-9);
    const width = (up - lo) / s20; const widths = c.map((_, i) => i < 40 ? NaN : 0); const bwHist = std(c, 20).map((s, i) => 4 * s / (sma(c, 20)[i] || 1)).filter(isFinite);
    const bwAvg = bwHist.slice(-50).reduce((s, x) => s + x, 0) / Math.min(50, bwHist.length);
    const atrAvg = A.slice(-30).reduce((s, x) => s + x, 0) / 30; const atrExp = last(A) / atrAvg;
    let bScore = 0; if (price > up) bScore = clamp(0.5 + (atrExp - 1)); else if (price < lo) bScore = -clamp(0.5 + (atrExp - 1)); else bScore = (pb - 0.5) * 0.4;
    const squeeze = width < bwAvg * 0.7;
    if (squeeze) bScore *= 0.5;
    void widths;
    return {
      price, atr: last(A), atrPct,
      trend: { score: tScore, e9: last(e9), e21: last(e21), gap, crossAgo, slope },
      contra: { score: cScore, rsi: r, sma20: s20, dev },
      volume: { score: vScore, volRatio, obvNorm, divergence, priceCh10 },
      vola: { score: bScore, up, lo, pb, squeeze, atrExp, width },
    };
  }

  function argText(id, a, seed) {
    if (id === 'trend') {
      const t = a.trend; const v = toVote(t.score);
      const cross = t.crossAgo !== null ? ` Пересечение было ${t.crossAgo === 0 ? 'на этой свече' : t.crossAgo + ' св. назад'}.` : '';
      if (v === 'buy') return pick(['EMA9 (' + fmt(t.e9) + ') выше EMA21 (' + fmt(t.e21) + '), разрыв ' + pct(t.gap) + '.' + cross + ' Тренд вверх, я за покупку.', 'Быстрая EMA над медленной на ' + pct(t.gap) + ', наклон EMA21 ' + pct(t.slope) + '.' + cross + ' Не спорьте с трендом — берём.'], seed);
      if (v === 'sell') return pick(['EMA9 (' + fmt(t.e9) + ') ниже EMA21 (' + fmt(t.e21) + '), разрыв ' + pct(t.gap) + '.' + cross + ' Тренд вниз, голосую за продажу.', 'Медленная EMA сверху, наклон ' + pct(t.slope) + '.' + cross + ' Ловить падающий нож не буду — продаём.'], seed);
      return 'EMA9 и EMA21 почти слиплись (разрыв ' + pct(t.gap) + ').' + cross + ' Внятного тренда нет — жду.';
    }
    if (id === 'contra') {
      const t = a.contra; const v = toVote(t.score);
      if (v === 'buy') return 'RSI ' + t.rsi.toFixed(1) + ', цена ' + pct(t.dev) + ' от SMA20. ' + (t.rsi < 30 ? 'Перепроданность — толпа паникует, а я покупаю.' : 'Цена ниже среднего, жду возврата вверх.');
      if (v === 'sell') return 'RSI ' + t.rsi.toFixed(1) + ', цена ' + pct(t.dev) + ' от SMA20. ' + (t.rsi > 70 ? 'Перекупленность, жадность зашкаливает — фиксирую.' : 'Цена оторвалась от среднего, жду отката.');
      return 'RSI ' + t.rsi.toFixed(1) + ' — нейтральная зона, до SMA20 ' + pct(t.dev) + '. Крайностей нет, мне тут ловить нечего.';
    }
    if (id === 'volume') {
      const t = a.volume; const v = toVote(t.score);
      const vr = 'Объём последней свечи ×' + t.volRatio.toFixed(2) + ' к среднему';
      const div = t.divergence ? ' Внимание: OBV расходится с ценой!' : '';
      if (v === 'buy') return vr + ', OBV за 10 свечей растёт. Деньги заходят — покупатели сильнее.' + div;
      if (v === 'sell') return vr + ', OBV за 10 свечей падает. Деньги уходят — продавцы давят.' + div;
      return vr + ', OBV почти плоский. Объём не подтверждает ни одну сторону.' + div;
    }
    if (id === 'vola') {
      const t = a.vola; const v = toVote(t.score);
      const band = 'Полосы Боллинджера ' + fmt(t.lo) + '–' + fmt(t.up) + ', ATR ' + pct(a.atrPct) + ' (×' + t.atrExp.toFixed(2) + ' к норме).';
      if (a.price > t.up) return band + ' Пробой верхней полосы — импульс вверх, покупаю пробой.';
      if (a.price < t.lo) return band + ' Пробой нижней полосы — импульс вниз, продаю.';
      if (t.squeeze) return band + ' Сжатие полос — скоро будет выстрел, но направление пока неясно.';
      return band + ' Цена внутри канала (' + Math.round(t.pb * 100) + '% ширины). ' + (v === 'hold' ? 'Пробоя нет — жду.' : v === 'buy' ? 'Ближе к верху, слегка за рост.' : 'Ближе к низу, слегка за снижение.');
    }
  }

  function evidence(id, a) {
    if (id === 'trend') return `EMA9 ${a.trend.gap >= 0 ? 'выше' : 'ниже'} EMA21 на ${(Math.abs(a.trend.gap) * 100).toFixed(2)}%`;
    if (id === 'contra') return `RSI ${a.contra.rsi.toFixed(1)} — ${a.contra.rsi > 70 ? 'перекупленность' : a.contra.rsi < 30 ? 'перепроданность' : 'без крайностей'}`;
    if (id === 'volume') return `OBV ${a.volume.obvNorm > 0.1 ? 'растёт' : a.volume.obvNorm < -0.1 ? 'падает' : 'стоит на месте'}, объём ×${a.volume.volRatio.toFixed(2)} к среднему`;
    return `цена на ${Math.round(a.vola.pb * 100)}% канала Боллинджера, ATR ×${a.vola.atrExp.toFixed(2)}`;
  }
  const MOTTO = {
    trend: ['Тренд — друг, пока не доказано обратное.', 'Я против того, чтобы стоять перед поездом.'],
    contra: ['EMA запаздывают, а крайности видно сразу.', 'Толпа обычно ошибается на экстремумах.'],
    volume: ['Цена может врать, объём — редко.', 'Движение без денег — пустышка.'],
    vola: ['Без выхода из канала это просто шум.', 'Волатильность решает, где ставить стоп.'],
  };
  function replyText(id, other, a, votes, seed) {
    const me = votes[id], ot = votes[other]; const on = BOTS[other].name;
    if (me === ot) return pick([`Согласен, ${on}: ${evidence(id, a)} — вывод тот же.`, `${on} прав, у меня ${evidence(id, a)}.`], seed);
    const stance = me === 'hold' ? 'Я бы не спешил.' : `Я остаюсь за «${VOTE_RU[me]}».`;
    return `${on}, ты за «${VOTE_RU[ot]}», но у меня ${evidence(id, a)}. ${stance} ${pick(MOTTO[id], seed)}`;
  }

  // ---------- риск-менеджер ----------
  function riskPlan(a, state, proposal) {
    const s = state.settings; const pos = state.positions[s.pair];
    const stopDist = Math.max(a.atr * 1.5, a.price * 0.004);
    const sl = a.price - stopDist, tp = a.price + stopDist * 2;
    const riskUsd = state.balance * (s.riskPct / 100);
    let qty = riskUsd / stopDist; let notional = qty * a.price;
    const maxNotional = state.balance * 0.95; if (notional > maxNotional) { qty = maxNotional / a.price; notional = maxNotional; }
    let veto = null;
    if (proposal === 'buy') {
      if (pos) veto = `позиция по ${s.pair} уже открыта — не усредняемся`;
      else if (a.atrPct > 0.06) veto = `ATR ${pct(a.atrPct)} за свечу — слишком дико, стоп будет огромным`;
      else if (notional < 10) veto = 'на балансе слишком мало для сделки';
      else if (a.contra.rsi > 80) veto = `RSI ${a.contra.rsi.toFixed(0)} — покупать на таком перегреве запрещаю`;
    }
    if (proposal === 'sell' && !pos) veto = 'продавать нечего: позиции нет, шорты в демо-кошельке не открываем';
    return { stopDist, sl, tp, qty, notional, riskUsd, veto };
  }

  // ---------- раунд совета ----------
  function runRound(state, k, opts = {}) {
    const a = analyze(k); const seed = Math.floor(k[k.length - 1][0] / 1000) + (state.round || 0);
    const ids = ['trend', 'contra', 'volume', 'vola'];
    const votes = {}; ids.forEach((id) => { votes[id] = toVote(a[id].score); });
    const msgs = [];
    const say = (id, text, kind = 'arg') => msgs.push({ bot: id, name: BOTS[id].name, text, kind });
    const s = state.settings; const pos = state.positions[s.pair];
    say('arbiter', `Раунд №${(state.round || 0) + 1}. ${s.pair}/USDT, ${s.tf}, цена ${fmt(a.price)}. ${pos ? `У нас открыта позиция от ${fmt(pos.entry)} (${pct(a.price / pos.entry - 1)}).` : 'Позиций нет.'} Коллеги, ваши мнения.`, 'open');
    ids.forEach((id, i) => say(id, argText(id, a, seed + i)));
    // ответы: каждый отвечает самому несогласному
    ids.forEach((id, i) => {
      const other = ids.filter((o) => o !== id).sort((x, y) => Math.abs(a[y].score - a[id].score) - Math.abs(a[x].score - a[id].score))[0];
      if (votes[other] !== votes[id] || i % 2 === 0) say(id, replyText(id, other, a, votes, seed + i), 'reply');
    });
    // подсчёт
    let sum = 0, wsum = 0; ids.forEach((id) => { sum += WEIGHTS[id] * a[id].score; wsum += WEIGHTS[id]; });
    const score = sum / wsum;
    let proposal = score > 0.15 ? 'buy' : score < -0.15 ? 'sell' : 'hold';
    // если в позиции и голоса слегка негативные — выходим раньше
    if (pos && score < -0.08) proposal = 'sell';
    const plan = riskPlan(a, state, proposal);
    if (proposal === 'buy') say('risk', plan.veto ? `ВЕТО: ${plan.veto}.` : `Риск ${s.riskPct}% = ${plan.riskUsd.toFixed(2)} USDT. Стоп ${fmt(plan.sl)} (1,5×ATR), тейк ${fmt(plan.tp)} (R:R 1:2). Объём ${plan.qty.toPrecision(4)} ${s.pair} ≈ ${plan.notional.toFixed(2)} USDT. Разрешаю.`, plan.veto ? 'veto' : 'arg');
    else if (proposal === 'sell') say('risk', plan.veto ? `ВЕТО: ${plan.veto}.` : `Закрываем позицию — результат ${pct(a.price / pos.entry - 1)}. Капитал важнее надежды.`, plan.veto ? 'veto' : 'arg');
    else say('risk', pos ? `Держим. Стоп ${fmt(pos.sl)}, тейк ${fmt(pos.tp)} — сработают автоматически.` : `Сигнал слабый (${score.toFixed(2)}). Не торговать — тоже позиция.`);
    const final = plan.veto ? 'hold' : proposal;
    const confidence = Math.round(Math.min(0.95, Math.abs(score) * 0.8 + (ids.filter((id) => votes[id] === final).length / ids.length) * 0.4) * 100);
    const tally = ids.map((id) => `${BOTS[id].emoji}${VOTE_ICON[votes[id]]}`).join(' ');
    say('arbiter', `Голоса: ${tally}. Взвешенный счёт ${score >= 0 ? '+' : ''}${score.toFixed(2)}. ${plan.veto && proposal !== 'hold' ? 'Риск-менеджер наложил вето. ' : ''}Решение: ${VOTE_RU[final]}, уверенность ${confidence}%.`, 'decision');
    let trade = null;
    if (!opts.dryRun) trade = applyDecision(state, final, a.price, plan, confidence);
    state.round = (state.round || 0) + 1;
    return { at: Date.now(), pair: s.pair, tf: s.tf, price: a.price, votes, score, proposal, final, confidence, veto: plan.veto, msgs, trade, analysis: a };
  }

  const FEE = 0.001;
  function applyDecision(state, final, price, plan, confidence) {
    const pair = state.settings.pair;
    if (final === 'buy' && !state.positions[pair]) {
      const cost = plan.qty * price; const fee = cost * FEE;
      state.balance -= cost + fee;
      state.positions[pair] = { pair, qty: plan.qty, entry: price, sl: plan.sl, tp: plan.tp, at: Date.now(), fee };
      const t = { id: Date.now(), side: 'buy', pair, qty: plan.qty, price, fee, reason: `совет, уверенность ${confidence}%`, at: Date.now() };
      state.trades.unshift(t); return t;
    }
    if (final === 'sell' && state.positions[pair]) return closePos(state, pair, price, `совет, уверенность ${confidence}%`);
    return null;
  }
  function closePos(state, pair, price, reason) {
    const p = state.positions[pair]; if (!p) return null;
    const gross = p.qty * price; const fee = gross * FEE; state.balance += gross - fee;
    const pnl = gross - fee - (p.qty * p.entry + p.fee);
    delete state.positions[pair];
    const t = { id: Date.now(), side: 'sell', pair, qty: p.qty, price, fee, pnl, entry: p.entry, reason, at: Date.now() };
    state.trades.unshift(t); state.trades = state.trades.slice(0, 300); return t;
  }
  // стоп/тейк по текущим ценам
  function checkStops(state, prices) {
    const out = [];
    for (const pair of Object.keys(state.positions)) {
      const p = state.positions[pair]; const px = prices[pair]; if (!px) continue;
      if (px <= p.sl) out.push(closePos(state, pair, px, 'стоп-лосс'));
      else if (px >= p.tp) out.push(closePos(state, pair, px, 'тейк-профит'));
    }
    return out;
  }
  function newState(balance = 10000) {
    return { v: 1, start: balance, balance, positions: {}, trades: [], rounds: [], round: 0, settings: { pair: 'TON', tf: '1h', autoMin: 0, riskPct: 1 }, created: Date.now() };
  }
  const api = { analyze, runRound, checkStops, newState, closePos, BOTS, VOTE_RU, VOTE_ICON, fmt, pct, ema, rsi, atr, obv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Council = api;
})(typeof window !== 'undefined' ? window : globalThis);
