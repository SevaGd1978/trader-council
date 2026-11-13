// Слой данных: сервер (если есть) или напрямую публичные API бирж + Telegram CloudStorage/localStorage.
(function (root) {
  'use strict';
  const SYM = { TON: 'GRAM', BTC: 'BTC', ETH: 'ETH', NOT: 'NOT', DOGS: 'DOGS' }; // TON на биржах = тикер GRAM
  const TF = { '15m': { bin: '15m', okx: '15m', bybit: '15', ms: 9e5 }, '1h': { bin: '1h', okx: '1H', bybit: '60', ms: 36e5 }, '4h': { bin: '4h', okx: '4H', bybit: '240', ms: 144e5 }, '1d': { bin: '1d', okx: '1Dutc', bybit: 'D', ms: 864e5 } };
  async function j(url) { const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000); try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } }
  const N = (k) => k.slice(0, 6).map(Number);
  const SRC = [
    ['binance', async (s, tf) => { let e; for (const h of ['https://api.binance.com', 'https://data-api.binance.vision']) { try { const d = await j(`${h}/api/v3/klines?symbol=${s}USDT&interval=${TF[tf].bin}&limit=200`); return d.map(N); } catch (x) { e = x; } } throw e; }],
    ['okx', async (s, tf) => { const d = await j(`https://www.okx.com/api/v5/market/candles?instId=${s}-USDT&bar=${TF[tf].okx}&limit=200`); if (d.code !== '0') throw new Error(d.msg); return d.data.map(N).reverse(); }],
    ['bybit', async (s, tf) => { const d = await j(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${s}USDT&interval=${TF[tf].bybit}&limit=200`); if (d.retCode !== 0) throw new Error(d.retMsg); return d.result.list.map(N).reverse(); }],
  ];
  const cache = {};
  async function directCandles(pair, tf) {
    const key = pair + tf; if (cache[key] && Date.now() - cache[key].at < 15000) return cache[key];
    const errs = [];
    for (const [name, fn] of SRC) {
      try {
        const k = await fn(SYM[pair], tf);
        if (k.length < 30) throw new Error('мало свечей');
        if (Date.now() - k[k.length - 1][0] > TF[tf].ms * 3) throw new Error('устаревшие данные');
        return (cache[key] = { pair, tf, source: name, candles: k, price: k[k.length - 1][4], at: Date.now() });
      } catch (e) { errs.push(name + ': ' + e.message); }
    }
    throw new Error('биржи недоступны (' + errs.join('; ') + ')');
  }
  let server = null; // null — неизвестно, true/false
  async function hasServer() {
    if (server !== null) return server;
    try { const r = await fetch('api/health', { cache: 'no-store' }); const h = await r.json(); server = !!h.ok; Data.llm = !!h.llm; } catch (_) { server = false; }
    return server;
  }
  async function candles(pair, tf) {
    if (await hasServer()) { try { const r = await fetch(`api/candles?pair=${pair}&tf=${tf}`); const d = await r.json(); if (r.ok) return d; } catch (_) {} }
    return directCandles(pair, tf);
  }
  async function prices() {
    if (await hasServer()) { try { const r = await fetch('api/prices'); if (r.ok) return await r.json(); } catch (_) {} }
    const out = {};
    await Promise.all(Object.keys(SYM).map(async (p) => { try { const v = await directCandles(p, '1h'); out[p] = { price: v.price, source: v.source, open24: v.candles[Math.max(0, v.candles.length - 25)][4] }; } catch (e) { out[p] = { error: e.message }; } }));
    return out;
  }
  // --- Telegram CloudStorage (по 4096 символов на ключ) ---
  function cs() { const t = root.Telegram && root.Telegram.WebApp; return t && t.initData && t.CloudStorage && t.isVersionAtLeast && t.isVersionAtLeast('6.9') ? t.CloudStorage : null; }
  const csGet = (keys) => new Promise((ok) => cs().getItems(keys, (e, v) => ok(e ? null : v)));
  const csSet = (k, v) => new Promise((ok) => cs().setItem(k, v, (e) => ok(!e)));
  async function cloudLoad() {
    if (!cs()) return null;
    const h = await csGet(['tc_n']); const n = h && Number(h.tc_n); if (!n) return null;
    const keys = Array.from({ length: n }, (_, i) => 'tc_' + i); const v = await csGet(keys); if (!v) return null;
    try { return JSON.parse(keys.map((k) => v[k] || '').join('')); } catch (_) { return null; }
  }
  async function cloudSave(obj) {
    if (!cs()) return;
    const s = JSON.stringify(obj); const parts = s.match(/[\s\S]{1,4000}/g) || [''];
    if (parts.length > 60) return;
    for (let i = 0; i < parts.length; i++) await csSet('tc_' + i, parts[i]);
    await csSet('tc_n', String(parts.length));
  }
  async function sentiment(pair) {
    if (root.Council && root.Council.fetchSentiment) return root.Council.fetchSentiment('crypto', { pair });
    return { ok: false, source: 'crypto', score: 0, detail: 'модуль совета не загружен' };
  }
  const Data = { candles, prices, sentiment, hasServer, cloudLoad, cloudSave, llm: false };

  root.Data = Data;
})(window);
