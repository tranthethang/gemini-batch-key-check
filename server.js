// Gemini Batch Key Check - zero dependency (Node >= 18)
// Run: node server.js  ->  http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 20000;
const DECISIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const DEFAULT_MODEL = 'gemini-decision-1';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function checkKey(key, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();

  try {
    const r = await fetch(DECISIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        model,
        input: 'Ping',
        questions: {
          ping: {
            type: 'noul',
            instructions: 'Is this a ping?',
          },
        },
      }),
      signal: ctrl.signal,
    });
    const latency = Date.now() - start;
    const rawText = await r.text();
    let data = null;
    try { data = JSON.parse(rawText); } catch (_) {}
    if (!r.ok) {
      console.error(`[check] ${key.slice(0, 6)}… model=${model} HTTP ${r.status}: ${rawText.slice(0, 500)}`);
    }

    if (r.ok) {
      const ans = data?.answers?.ping;
      const text = ans
        ? `noul=${ans.noul ?? '?'}, confidence=${ans.confidence ?? '?'}`
        : '(empty response)';
      return { state: 'ok', http: r.status, latency, message: text };
    }

    const err = data?.error || {};
    const reason = (err.details || []).find((d) => d.reason)?.reason || '';
    const msg = err.message || rawText.slice(0, 200) || `HTTP ${r.status}`;

    let state = 'error';
    if (r.status === 429) state = 'quota';
    else if (reason === 'API_KEY_INVALID' || /API key not valid/i.test(msg)) state = 'invalid';
    else if (r.status === 403) state = 'forbidden';
    else if (r.status === 404) state = 'notfound';

    return { state, http: r.status, latency, message: msg };
  } catch (e) {
    const latency = Date.now() - start;
    console.error('[check] exception:', e.name, e.message, e.cause || '');
    if (e.name === 'AbortError') {
      return { state: 'timeout', http: 0, latency, message: `Timed out after ${TIMEOUT_MS / 1000}s` };
    }
    return { state: 'error', http: 0, latency, message: e.message };
  } finally {
    clearTimeout(timer);
  }
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === 'GET') {
      const urlPath = req.url.split('?')[0];
      const name = urlPath === '/' ? 'index.html' : path.normalize(urlPath).replace(/^([/\\]|\.\.)+/, '');
      const file = path.join(PUBLIC_DIR, name);
      if (file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(file));
      }
    }

    if (req.method === 'POST' && req.url === '/api/check') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const key = String(body.key || '').trim();
      const model = String(body.model || DEFAULT_MODEL).trim();
      if (!key) return sendJson(res, 400, { state: 'error', message: 'Missing key' });
      return sendJson(res, 200, await checkKey(key, model));
    }

    sendJson(res, 404, { state: 'error', message: 'Not found: ' + req.url });
  } catch (e) {
    sendJson(res, 500, { state: 'error', message: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Gemini Batch Key Check running at http://localhost:${PORT}`);
});
