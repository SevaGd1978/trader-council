// Совет трейдеров — сервер: прокси цен (без ключей) + хранение демо-состояния.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 80);
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const STATE_DIR = path.join(DATA_DIR, 'users');
fs.mkdirSync(STATE_DIR, { recursive: true });
const PUB = path.join(__dirname, 'public');
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // необязательно: если задан, initData проверяется по подписи

// TON на биржах торгуется под тикером GRAM
const PAIRS = { TON: 'GRAM', BTC: 'BTC', ETH: 'ETH', NOT: 'NOT', DOGS: 'DOGS' };
const TF = {
  '15m': { bin: '15m', okx: '15m', bybit: '15', ms: 9e5 },
  '1h': { bin: '1h', okx: '1H', bybit: '60', ms: 36e5 },
  '4h': { bin: '4h', okx: '4H', bybit: '240', ms: 144e5 },
  '1d': { bin: '1d', okx: '1Dutc', bybit: 'D', ms: 864e5 },
};

async function getJSON(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'trader-council/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const num = (a) => a.map(Number);
const sources = {
  async binance(sym, tf, limit) {
    const hosts = ['https://api.binance.com', 'https://data-api.binance.vision'];
    let err;
    for (const h of hosts) {
      try {
        const d = await getJSON(`${h}/api/v3/klines?symbol=${sym}USDT&interval=${TF[tf].bin}&limit=${limit}`);
        if (!Array.isArray(d)) throw new Error('bad');
        return d.map((k) => num(k.slice(0, 6)));
      } catch (e) { err = e; }
    }
    throw err;
  },
  async okx(sym, tf, limit) {
    const d = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT&bar=${TF[tf].okx}&limit=${Math.min(limit, 300)}`);
    if (d.code !== '0') throw new Error(d.msg || 'okx');
    return d.data.map((k) => num(k.slice(0, 6))).reverse();
  },
  async bybit(sym, tf, limit) {
    const d = await getJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}USDT&interval=${TF[tf].bybit}&limit=${limit}`);
    if (d.retCode !== 0) throw new Error(d.retMsg);
    return d.result.list.map((k) => num(k.slice(0, 6))).reverse();
  },
};
const cache = new Map();
async function candles(pair, tf, limit = 200) {
  const sym = PAIRS[pair];
  if (!sym || !TF[tf]) throw new Error('unknown pair/tf');
  const key = `${pair}|${tf}`;
  const c = cache.get(key);
  if (c && Date.now() - c.at < 15000) return c.v;
  const errors = [];
  for (const name of ['binance', 'okx', 'bybit']) {
    try {
      const k = await sources[name](sym, tf, limit);
      if (k.length < 30) throw new Error('мало свечей');
      const last = k[k.length - 1][0];
      if (Date.now() - last > TF[tf].ms * 3) throw new Error('устаревшие данные');
      const v = { pair, symbol: sym + '/USDT', tf, source: name, candles: k, price: k[k.length - 1][4], at: Date.now() };
      cache.set(key, { at: Date.now(), v });
      return v;
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  if (c) return { ...c.v, stale: true };
  throw new Error('Все источники недоступны — ' + errors.join('; '));
}

// --- пользователь из Telegram initData (или id устройства) ---
function userKey(req) {
  const init = req.headers['x-init-data'];
  if (init) {
    try {
      const p = new URLSearchParams(init);
      if (BOT_TOKEN) {
        const hash = p.get('hash'); p.delete('hash');
        const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
        const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
        if (calc !== hash) throw new Error('bad sig');
      }
      const u = JSON.parse(p.get('user'));
      if (u && u.id) return 'tg_' + String(u.id).replace(/\D/g, '');
    } catch (_) { /* упадём на id устройства */ }
  }
  const dev = String(req.headers['x-device-id'] || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return dev ? 'dev_' + dev : null;
}

// --- необязательный LLM для живого текста (OpenAI-совместимый API) ---
const LLM_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const LLM_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
async function llmRewrite(messages) {
  const prompt = 'Перепиши реплики трейдеров живым разговорным русским языком, сохрани все цифры, смысл и порядок. ' +
    'Верни JSON-массив строк той же длины.\n' + JSON.stringify(messages.map((m) => `${m.name}: ${m.text}`));
  const r = await fetch(LLM_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + LLM_KEY },
    body: JSON.stringify({ model: LLM_MODEL, temperature: 0.7, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  const txt = d.choices[0].message.content.replace(/^```(json)?|```$/g, '').trim();
  const arr = JSON.parse(txt);
  if (!Array.isArray(arr) || arr.length !== messages.length) throw new Error('bad llm');
  return arr.map((s) => String(s).replace(/^[^:]{1,20}:\s*/, ''));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok, bad) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) { bad(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { bad(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/health') return send(res, 200, { ok: true, llm: !!LLM_KEY });
    if (u.pathname === '/api/candles') {
      const v = await candles(u.searchParams.get('pair') || 'TON', u.searchParams.get('tf') || '1h');
      return send(res, 200, v);
    }
    if (u.pathname === '/api/prices') {
      const out = {};
      await Promise.all(Object.keys(PAIRS).map(async (p) => {
        try { const v = await candles(p, '1h'); out[p] = { price: v.price, source: v.source, open24: v.candles[Math.max(0, v.candles.length - 25)][4] }; } catch (e) { out[p] = { error: e.message }; }
      }));
      return send(res, 200, out);
    }
    if (u.pathname === '/api/state') {
      const key = userKey(req);
      if (!key) return send(res, 400, { error: 'нет идентификатора пользователя' });
      const f = path.join(STATE_DIR, key + '.json');
      if (req.method === 'GET') return send(res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
      if (req.method === 'PUT') {
        const s = await body(req);
        fs.writeFileSync(f + '.tmp', JSON.stringify(s)); fs.renameSync(f + '.tmp', f);
        return send(res, 200, { ok: true, user: key });
      }
      if (req.method === 'DELETE') { if (fs.existsSync(f)) fs.unlinkSync(f); return send(res, 200, { ok: true }); }
    }
    if (u.pathname === '/api/polish' && req.method === 'POST') {
      if (!LLM_KEY) return send(res, 200, { texts: null });
      const b = await body(req);
      try { return send(res, 200, { texts: await llmRewrite(b.messages || []) }); } catch (e) { return send(res, 200, { texts: null }); }
    }
    // статика
    let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const f = path.join(PUB, p);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
});
server.listen(PORT, () => console.log('trader-council on :' + PORT + ', data ' + DATA_DIR));
