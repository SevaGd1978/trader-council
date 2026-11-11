/* global Council */
(function () {
  'use strict';
  const C = Council, $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : null;
  if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor('bg_color'); tg.setBackgroundColor('bg_color'); } catch (_) {} }
  const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  let deviceId = localStorage.getItem('tc_device');
  if (!deviceId) { deviceId = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('tc_device', deviceId); }
  const LS_KEY = 'tc_state_' + (tgUser ? 'tg' + tgUser.id : 'local');
  const headers = { 'content-type': 'application/json', 'x-device-id': deviceId };
  if (tg) headers['x-init-data'] = tg.initData;

  let state = null, prices = {}, busy = false, autoTimer = null, lastRound = 0;
  const haptic = (t) => { try { tg && tg.HapticFeedback.notificationOccurred(t); } catch (_) {} };
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600); }
  const money = (x) => (isFinite(x) ? x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—') + ' USDT';
  const sgn = (x) => (x >= 0 ? '+' : '') + x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const time = (t) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- состояние ----------
  async function load() {
    let s = null, local = null;
    try { local = JSON.parse(localStorage.getItem(LS_KEY)); } catch (_) {}
    if (await Data.hasServer()) { try { const r = await fetch('api/state', { headers }); if (r.ok) s = await r.json(); } catch (_) {} }
    else { try { const c = await Data.cloudLoad(); if (c) { s = c; if (local && local.rounds && (local.round || 0) >= (c.round || 0)) s.rounds = local.rounds; } } catch (_) {} }
    if (!s || (local && (local.saved || 0) > (s.saved || 0))) s = local || s;
    state = s && s.v === 1 ? s : C.newState();
  }
  let saveT = null;
  function save() {
    state.saved = Date.now();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      if (await Data.hasServer()) fetch('api/state', { method: 'PUT', headers, body: JSON.stringify(state) }).catch(() => {});
      else { // в облако Telegram — компактно, без текстов реплик
        const c = Object.assign({}, state, { trades: state.trades.slice(0, 40), rounds: state.rounds.slice(-10).map((r) => Object.assign({}, r, { msgs: [] })) });
        Data.cloudSave(c).catch(() => {});
      }
    }, 600);
  }

  // ---------- цены ----------
  async function loadPrices() {
    try {
      const d = await Data.prices();
      for (const p in d) if (d[p].price) prices[p] = d[p];
      const closed = C.checkStops(state, Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, v.price])));
      closed.forEach((t) => { addTradeNote(t); toast(`${t.reason === 'стоп-лосс' ? '🛑' : '🎯'} ${t.pair}: сработал ${t.reason}, ${sgn(t.pnl)} USDT`); });
      if (closed.length) save();
      renderHeader();
      if ($('tab-port').classList.contains('active')) renderPortfolio();
    } catch (e) { $('srcLine').textContent = 'нет связи с ценами'; }
  }
  function equity() { let e = state.balance; for (const p in state.positions) { const px = prices[p] ? prices[p].price : state.positions[p].entry; e += state.positions[p].qty * px; } return e; }
  function renderHeader() {
    const p = state.settings.pair, d = prices[p];
    $('pxPair').textContent = p + '/USDT';
    if (d) {
      $('pxVal').textContent = C.fmt(d.price);
      const ch = d.price / d.open24 - 1; $('pxCh').textContent = '24ч ' + C.pct(ch); $('pxCh').className = 'sub ' + (ch >= 0 ? 'pos' : 'neg');
      $('srcLine').textContent = `источник: ${d.source} · ${state.settings.tf}`;
    }
    const eq = equity(), pnl = eq - state.start;
    $('eqVal').textContent = money(eq);
    $('eqPnl').textContent = sgn(pnl) + ' (' + C.pct(pnl / state.start) + ')'; $('eqPnl').className = 'sub ' + (pnl >= 0 ? 'pos' : 'neg');
    $('autoInfo').textContent = state.settings.autoMin ? `⏱ авто каждые ${state.settings.autoMin} мин` : '';
  }

  // ---------- чат ----------
  const chat = $('chat');
  function msgEl(m) {
    const b = C.BOTS[m.bot]; const d = document.createElement('div');
    d.className = 'msg ' + (m.kind || '');
    d.innerHTML = `<div class="ava" style="background:${b.color}22">${b.emoji}</div><div class="bubble"><div class="who" style="color:${b.color}">${b.name} <small>${m.kind === 'reply' ? '↩ ответ' : b.role}</small></div>${esc(m.text)}</div>`;
    return d;
  }
  function sepEl(t) { const d = document.createElement('div'); d.className = 'sep'; d.textContent = t; return d; }
  function addTradeNote(t, parent = chat) {
    const d = document.createElement('div'); d.className = 'tradeNote ' + t.side;
    d.textContent = t.side === 'buy' ? `🟢 Демо-покупка ${t.qty.toPrecision(4)} ${t.pair} по ${C.fmt(t.price)}` : `🔴 Демо-продажа ${t.qty.toPrecision(4)} ${t.pair} по ${C.fmt(t.price)} · ${t.reason} · P&L ${sgn(t.pnl)} USDT`;
    parent.appendChild(d); return d;
  }
  function renderHistory() {
    chat.innerHTML = '';
    if (!state.rounds.length) {
      chat.appendChild(sepEl('Совет ещё не собирался'));
      const intro = [
        { bot: 'arbiter', text: 'Добро пожаловать! Нас шестеро: четыре аналитика спорят, риск-менеджер следит за деньгами, а я принимаю решение. Счёт демо — 10 000 виртуальных USDT, цены настоящие.' },
        { bot: 'risk', text: 'Никаких реальных ордеров и кошельков: всё в песочнице. Нажмите «Провести раунд совета» или включите авто-раунды в настройках.' },
      ];
      intro.forEach((m) => chat.appendChild(msgEl(m)));
      return;
    }
    state.rounds.slice(-8).forEach((r) => {
      chat.appendChild(sepEl(`${time(r.at)} · ${r.pair}/USDT ${r.tf} · ${C.fmt(r.price)}`));
      if (r.msgs.length) r.msgs.forEach((m) => chat.appendChild(msgEl(m))); else chat.appendChild(msgEl({ bot: 'arbiter', kind: 'decision', text: `Решение: ${C.VOTE_RU[r.final]}, уверенность ${r.confidence}% (счёт ${r.score.toFixed(2)}).` }));
      if (r.trade) addTradeNote(r.trade);
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function playRound(r) {
    if (chat.firstChild && !state.rounds.slice(0, -1).length) chat.innerHTML = '';
    chat.appendChild(sepEl(`${time(r.at)} · ${r.pair}/USDT ${r.tf} · ${C.fmt(r.price)}`));
    const fast = document.hidden;
    for (const m of r.msgs) {
      if (!fast) {
        const ty = document.createElement('div'); ty.className = 'typing'; ty.textContent = `${C.BOTS[m.bot].name} печатает…`; chat.appendChild(ty); scrollDown();
        await sleep(Math.min(900, 250 + m.text.length * 6)); ty.remove();
      }
      chat.appendChild(msgEl(m)); scrollDown();
    }
    if (r.trade) { addTradeNote(r.trade); scrollDown(); }
  }
  function scrollDown() { if ($('tab-chat').classList.contains('active')) window.scrollTo(0, document.body.scrollHeight); }

  async function round(auto = false) {
    if (busy) return; busy = true; const btn = $('btnRound'); btn.disabled = true; btn.textContent = '⏳ Совет совещается…';
    try {
      const s = state.settings;
      const d = await Data.candles(s.pair, s.tf);
      prices[s.pair] = Object.assign(prices[s.pair] || {}, { price: d.price, source: d.source, open24: prices[s.pair] ? prices[s.pair].open24 : d.price });
      const res = C.runRound(state, d.candles);
      res.source = d.source; delete res.analysis;
      // необязательно: «оживить» текст через LLM, если на сервере есть ключ
      if (Data.llm) { try { const pr = await fetch('api/polish', { method: 'POST', headers, body: JSON.stringify({ messages: res.msgs }) }); const pj = await pr.json(); if (pj.texts) pj.texts.forEach((t, i) => { res.msgs[i].text = t; }); } catch (_) {} }
      state.rounds.push(res); state.rounds = state.rounds.slice(-30);
      save(); lastRound = Date.now();
      await playRound(res);
      renderHeader();
      if (res.trade) haptic('success');
      if (auto && document.hidden && res.trade) toast('Совет совершил сделку');
    } catch (e) { toast('Ошибка: ' + e.message); }
    busy = false; btn.disabled = false; btn.textContent = '▶ Провести раунд совета';
  }

  // ---------- портфель ----------
  function renderPortfolio() {
    const eq = equity(), pnl = eq - state.start;
    const closed = state.trades.filter((t) => t.side === 'sell'); const wins = closed.filter((t) => t.pnl > 0).length;
    $('pBal').textContent = money(state.balance); $('pEq').textContent = money(eq);
    $('pPnl').innerHTML = `<span class="${pnl >= 0 ? 'pos' : 'neg'}">${sgn(pnl)}</span>`;
    $('pWin').textContent = `${closed.length} / ${closed.length ? Math.round(wins / closed.length * 100) : 0}%`;
    const ps = Object.values(state.positions);
    $('positions').innerHTML = ps.length ? '' : '<div class="card empty">Нет открытых позиций</div>';
    ps.forEach((p) => {
      const px = prices[p.pair] ? prices[p.pair].price : p.entry; const up = (px - p.entry) * p.qty;
      const d = document.createElement('div'); d.className = 'card';
      d.innerHTML = `<div class="row"><b>${p.pair}/USDT · лонг</b><span class="${up >= 0 ? 'pos' : 'neg'}">${sgn(up)} USDT (${C.pct(px / p.entry - 1)})</span></div>
        <div class="sub">Объём ${p.qty.toPrecision(5)} · вход ${C.fmt(p.entry)} · сейчас ${C.fmt(px)}<br>Стоп ${C.fmt(p.sl)} · тейк ${C.fmt(p.tp)} · с ${time(p.at)}</div>
        <div style="margin-top:8px"><button class="small" data-close="${p.pair}">Закрыть вручную</button></div>`;
      $('positions').appendChild(d);
    });
    $('trades').innerHTML = state.trades.length ? state.trades.slice(0, 50).map((t) => `<div class="it"><div><b class="${t.side === 'buy' ? 'pos' : 'neg'}">${t.side === 'buy' ? 'Покупка' : 'Продажа'}</b> ${t.pair} ${t.qty.toPrecision(4)} @ ${C.fmt(t.price)}<div class="sub">${time(t.at)} · ${esc(t.reason)}</div></div><div>${t.pnl !== undefined ? `<span class="${t.pnl >= 0 ? 'pos' : 'neg'}">${sgn(t.pnl)}</span>` : `−${(t.qty * t.price).toFixed(2)}`}</div></div>`).join('') : '<div class="empty">Сделок пока нет</div>';
    $('decisions').innerHTML = state.rounds.length ? state.rounds.slice().reverse().slice(0, 20).map((r) => `<div class="it"><div>${time(r.at)} · ${r.pair} ${r.tf}<div class="sub">${Object.values(r.votes).map((v) => C.VOTE_ICON[v]).join('')} счёт ${r.score.toFixed(2)}${r.veto && r.proposal !== 'hold' ? ' · вето' : ''}</div></div><div><b>${C.VOTE_RU[r.final]}</b> ${r.confidence}%</div></div>`).join('') : '<div class="empty">Раундов пока не было</div>';
  }
  async function renderAuto() {
    try {
      const r = await fetch('auto/summary.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return;
      const a = await r.json(); const box = $('autoBox'); box.style.display = '';
      const closed = a.recentTrades.filter((t) => t.side === 'sell');
      const p = a.position;
      $('autoCard').innerHTML = `<div class="sub">Отдельный демо-счёт: совет сам собирается каждые 10 минут (${a.symbol}, свечи ${a.tf}, риск ${a.riskPct}%). ${a.finished ? 'Прогон завершён.' : 'Идёт до ' + time(a.endsAt) + '.'}</div>
        <div class="grid2" style="margin-top:8px"><div><div class="lbl">Капитал</div><div class="val">${money(a.equity)}</div></div>
        <div><div class="lbl">P&amp;L</div><div class="val ${a.pnl >= 0 ? 'pos' : 'neg'}">${sgn(a.pnl)} (${a.pnlPct >= 0 ? '+' : ''}${a.pnlPct}%)</div></div>
        <div><div class="lbl">Раундов / сделок</div><div class="val">${a.rounds} / ${a.trades}</div></div>
        <div><div class="lbl">Цена с начала</div><div class="val ${a.price >= a.startPrice ? 'pos' : 'neg'}">${C.pct(a.price / a.startPrice - 1)}</div></div></div>
        ${p ? `<div class="sub" style="margin-top:8px">Позиция: ${p.qty.toPrecision(5)} ${p.pair} от ${C.fmt(p.entry)}, стоп ${C.fmt(p.sl)}, тейк ${C.fmt(p.tp)}</div>` : ''}
        <div class="list" style="margin-top:6px">${a.recentRounds.slice(0, 6).map((x) => `<div class="it"><div>${time(x.at)} · ${C.fmt(x.price)}<div class="sub">${Object.values(x.votes).map((v) => C.VOTE_ICON[v]).join('')} счёт ${x.score}</div></div><div><b>${C.VOTE_RU[x.final]}</b> ${x.confidence}%</div></div>`).join('')}</div>
        <div class="sub">Обновлено ${time(a.updatedAt)}${closed.length ? '' : ''}</div>`;
    } catch (_) {}
  }
  $('positions').addEventListener('click', (e) => {
    const p = e.target.dataset.close; if (!p) return;
    const px = prices[p] ? prices[p].price : state.positions[p].entry;
    const t = C.closePos(state, p, px, 'вручную'); addTradeNote(t); save(); renderPortfolio(); renderHeader(); toast(`Закрыто: ${sgn(t.pnl)} USDT`);
  });

  // ---------- настройки ----------
  function renderSettings() {
    const s = state.settings;
    $('sPair').value = s.pair; $('sTf').value = s.tf; $('sAuto').value = String(s.autoMin); $('sRisk').value = s.riskPct; $('sRiskV').textContent = s.riskPct + '%'; $('sStart').value = state.start;
    $('userLine').textContent = tgUser ? `Счёт привязан к Telegram: ${tgUser.first_name || ''} (id ${tgUser.id})` : 'Открыто в браузере: счёт хранится для этого устройства';
    $('botsList').innerHTML = Object.values(C.BOTS).map((b) => `<div class="botrow"><div class="ava" style="background:${b.color}22">${b.emoji}</div><div><b>${b.name}</b><div class="sub">${b.role}</div></div></div>`).join('');
  }
  const onSet = (id, fn) => $(id).addEventListener('change', () => { fn($(id).value); save(); renderHeader(); setupAuto(); });
  onSet('sPair', (v) => { state.settings.pair = v; });
  onSet('sTf', (v) => { state.settings.tf = v; });
  onSet('sAuto', (v) => { state.settings.autoMin = Number(v); lastRound = Date.now(); });
  $('sRisk').addEventListener('input', () => { $('sRiskV').textContent = $('sRisk').value + '%'; });
  onSet('sRisk', (v) => { state.settings.riskPct = Number(v); });
  async function doReset() {
    const start = Math.max(100, Number($('sStart').value) || 10000); const keep = state.settings;
    state = C.newState(start); state.settings = Object.assign({}, keep); save(); renderHistory(); renderHeader(); renderSettings(); toast('Демо-счёт сброшен: ' + money(start));
  }
  $('btnReset').addEventListener('click', () => {
    const q = 'Сбросить демо-счёт? Баланс, позиции и история будут удалены.';
    if (tg && tg.showConfirm) tg.showConfirm(q, (ok) => ok && doReset()); else if (confirm(q)) doReset();
  });

  function setupAuto() {
    clearInterval(autoTimer); autoTimer = null;
    if (state.settings.autoMin) autoTimer = setInterval(() => { if (Date.now() - lastRound >= state.settings.autoMin * 60000 - 500) round(true); }, 5000);
  }

  // ---------- вкладки ----------
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    $('actionbar').style.display = b.dataset.tab === 'chat' ? '' : 'none';
    if (b.dataset.tab === 'port') { renderPortfolio(); renderAuto(); }
    if (b.dataset.tab === 'set') renderSettings();
    if (b.dataset.tab === 'chat') scrollDown();
    try { tg && tg.HapticFeedback.selectionChanged(); } catch (_) {}
  }));
  $('btnRound').addEventListener('click', () => round(false));

  (async function init() {
    await load();
    renderHistory(); renderHeader(); renderSettings(); scrollDown();
    await loadPrices(); setInterval(loadPrices, 20000);
    lastRound = state.rounds.length ? state.rounds[state.rounds.length - 1].at : 0;
    setupAuto();
    window.__tc = { get state() { return state; }, round };
  })();
})();
