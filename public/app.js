(function () {
var STATES = {
  idle:     { label: 'Not checked',      cls: 'b-idle' },
  checking: { label: 'Checking…',        cls: 'b-idle b-run' },
  ok:       { label: 'OK',               cls: 'b-ok' },
  quota:    { label: 'Out of quota (429)', cls: 'b-warn' },
  timeout:  { label: 'Timeout',          cls: 'b-warn' },
  invalid:  { label: 'Invalid key',      cls: 'b-bad' },
  forbidden:{ label: 'Blocked (403)',    cls: 'b-bad' },
  notfound: { label: 'Model not found',  cls: 'b-bad' },
  error:    { label: 'Error',            cls: 'b-bad' }
};
function group(s) {
  if (s === 'ok') return 'ok';
  if (s === 'quota' || s === 'timeout') return 'warn';
  if (s === 'idle' || s === 'checking') return 'idle';
  return 'bad';
}

var rows = []; // {key, state, http, latency, message}
var running = false;
var filter = null;

var $ = function (id) { return document.getElementById(id); };
var elInput = $('input'), elTbody = $('tbody'), elSummary = $('summary');
var btnCheck = $('btnCheck'), btnReset = $('btnReset'), btnClear = $('btnClear');
var btnCopyOk = $('btnCopyOk'), btnFilter = $('btnFilter'), elBar = $('bar'), elStatus = $('status');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function mask(k) { return k.length <= 12 ? k : k.slice(0, 8) + '…' + k.slice(-4); }

function parseKeys(text) {
  var seen = {}, out = [];
  text.split(/[\s,;]+/).forEach(function (t) {
    t = t.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (t && !seen[t]) { seen[t] = 1; out.push(t); }
  });
  return out;
}

function syncFromTextarea() {
  var keys = parseKeys(elInput.value);
  var old = {};
  rows.forEach(function (r) { old[r.key] = r; });
  rows = keys.map(function (k) {
    return old[k] || { key: k, state: 'idle', http: '', latency: '', message: '' };
  });
  render();
}

function render() {
  var c = { ok: 0, bad: 0, warn: 0, idle: 0 }, done = 0;
  rows.forEach(function (r) {
    c[group(r.state)]++;
    if (r.state !== 'idle' && r.state !== 'checking') done++;
  });

  elSummary.innerHTML = [
    ['ok', 'Working', c.ok, 't-ok'],
    ['warn', 'Quota / Timeout', c.warn, 't-warn'],
    ['bad', 'Errors', c.bad, 't-bad'],
    ['idle', 'Not checked', c.idle, '']
  ].map(function (t) {
    return '<button type="button" class="tile ' + t[3] + (filter === t[0] ? ' on' : '') + '" data-f="' + t[0] + '">' +
      '<b>' + t[2] + '</b><span>' + t[1] + '</span></button>';
  }).join('');

  elBar.style.width = (rows.length ? Math.round(done / rows.length * 100) : 0) + '%';
  elStatus.textContent = rows.length ? done + '/' + rows.length + ' checked' : '';
  btnFilter.hidden = !filter;
  btnCopyOk.disabled = !c.ok;

  if (!rows.length) {
    elTbody.innerHTML = '<tr><td colspan="7" class="empty">No keys yet. Paste your key list in the box above.</td></tr>';
    btnCheck.disabled = true;
    return;
  }
  btnCheck.disabled = running;

  var html = rows.map(function (r, i) {
    if (filter && group(r.state) !== filter) return '';
    var s = STATES[r.state] || STATES.error;
    return '<tr>' +
      '<td class="num">' + (i + 1) + '</td>' +
      '<td class="key" title="Key is partly masked">' + esc(mask(r.key)) + '</td>' +
      '<td><span class="badge ' + s.cls + '">' + s.label + '</span></td>' +
      '<td class="http">' + esc(r.http) + '</td>' +
      '<td class="lat">' + (r.latency !== '' ? esc(r.latency) + ' ms' : '') + '</td>' +
      '<td class="msg">' + esc(r.message) + '</td>' +
      '<td><button data-i="' + i + '"' + (running ? ' disabled' : '') + '>Check</button></td>' +
    '</tr>';
  }).join('');
  elTbody.innerHTML = html || '<tr><td colspan="7" class="empty">No keys in this status.</td></tr>';
}

async function checkOne(r) {
  r.state = 'checking'; r.http = ''; r.latency = ''; r.message = '';
  render();
  try {
    var base = $('apiBase').value.trim().replace(/\/+$/, '');
    var resp = await fetch(base + '/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: r.key, model: $('model').value.trim() })
    });
    var raw = await resp.text();
    var d;
    try {
      d = JSON.parse(raw);
    } catch (_) {
      r.state = 'error';
      r.http = resp.status;
      r.message = 'The server did not return JSON (HTTP ' + resp.status + '). ' +
        'Run "node server.js" and open http://localhost:3000, ' +
        'or enter the server address in the "API server" field.';
      render();
      return;
    }
    r.state = d.state || 'error';
    r.http = d.http || '';
    r.latency = d.latency != null ? d.latency : '';
    r.message = d.message || '';
  } catch (e) {
    r.state = 'error';
    r.message = e.message;
  }
  render();
}

async function checkAll() {
  if (running || !rows.length) return;
  running = true;
  btnCheck.textContent = 'Running…';
  btnCheck.disabled = true; btnReset.disabled = true; btnClear.disabled = true;

  var limit = Math.max(1, Math.min(20, parseInt($('concurrency').value, 10) || 5));
  var queue = rows.slice();
  var workers = [];
  for (var i = 0; i < limit; i++) {
    workers.push((async function () {
      while (queue.length) { await checkOne(queue.shift()); }
    })());
  }
  await Promise.all(workers);

  running = false;
  btnCheck.textContent = 'Check all keys';
  btnReset.disabled = false; btnClear.disabled = false;
  render();
}

elInput.addEventListener('input', function () { if (!running) syncFromTextarea(); });
btnCheck.addEventListener('click', checkAll);

btnReset.addEventListener('click', function () {
  rows.forEach(function (r) { r.state = 'idle'; r.http = ''; r.latency = ''; r.message = ''; });
  render();
});

btnClear.addEventListener('click', function () {
  elInput.value = ''; rows = []; filter = null; render();
});

btnFilter.addEventListener('click', function () { filter = null; render(); });

elSummary.addEventListener('click', function (e) {
  var t = e.target.closest('[data-f]');
  if (!t) return;
  filter = filter === t.getAttribute('data-f') ? null : t.getAttribute('data-f');
  render();
});

btnCopyOk.addEventListener('click', function () {
  var ok = rows.filter(function (r) { return r.state === 'ok'; }).map(function (r) { return r.key; });
  if (!ok.length) return;
  navigator.clipboard.writeText(ok.join('\n')).then(function () {
    elStatus.textContent = 'Copied ' + ok.length + ' OK keys';
  }, function () {
    elStatus.textContent = 'Copy failed: the browser blocked the clipboard';
  });
});

elTbody.addEventListener('click', function (e) {
  var b = e.target.closest('button[data-i]');
  if (!b || running) return;
  var r = rows[+b.getAttribute('data-i')];
  if (r) checkOne(r);
});

render();
})();
