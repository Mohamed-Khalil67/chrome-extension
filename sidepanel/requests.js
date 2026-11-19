// Requests tab: build and send an HTTP request, read the response, and copy
// TypeScript interfaces / an Angular service generated from it.
import { S, $, $$, esc, on, fmtMs, fmtSize, copyText, jsonTree } from './core.js';
import { toTypeScript, angularService } from './schema.js';

const store = {
  get: async (k, d) => { try { return (await chrome.storage.local.get(k))[k] ?? d; } catch { return d; } },
  set: (k, v) => { try { chrome.storage.local.set({ [k]: v }); } catch { /* ignore */ } },
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const newRow = (key = '', value = '', enabled = true) => ({ key, value, on: enabled });
const blankAuth = () => ({ type: 'none', token: '', user: '', pass: '', name: 'X-API-Key' });
const req = {
  method: 'GET', url: '', params: [newRow()], headers: [newRow()],
  bodyType: 'json', body: '', auth: blankAuth(),
};
let vars = ''; // "key=value" lines
let reqTab = 'params';
let res = null; // last response
let resTab = 'body';
let rootName = 'Response';
let dates = 'string';
let history = [];

// ───────────── helpers ─────────────
function varMap() {
  const m = {};
  for (const line of vars.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return m;
}
const fill = (s) => { const m = varMap(); return String(s ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, k) => (k in m ? m[k] : all)); };
const active = (rows) => rows.filter((r) => r.on && r.key.trim());

function finalUrl() {
  const raw = fill(req.url.trim());
  if (!raw) return '';
  let u;
  try { u = new URL(raw, S.tabUrl || undefined); } catch { return raw; }
  for (const p of active(req.params)) u.searchParams.append(fill(p.key), fill(p.value));
  return u.toString();
}
function finalHeaders() {
  const hd = new Headers();
  for (const r of active(req.headers)) { try { hd.set(fill(r.key), fill(r.value)); } catch { /* invalid name */ } }
  const a = req.auth;
  if (a.type === 'bearer' && a.token) hd.set('Authorization', `Bearer ${fill(a.token)}`);
  if (a.type === 'basic') hd.set('Authorization', `Basic ${btoa(`${fill(a.user)}:${fill(a.pass)}`)}`);
  if (a.type === 'key' && a.token) { try { hd.set(fill(a.name || 'X-API-Key'), fill(a.token)); } catch { /* invalid name */ } }
  if (req.bodyType === 'json' && !hd.has('Content-Type')) hd.set('Content-Type', 'application/json');
  if (req.bodyType === 'form' && !hd.has('Content-Type')) hd.set('Content-Type', 'application/x-www-form-urlencoded');
  return hd;
}
function finalBody() {
  if (['GET', 'HEAD'].includes(req.method) || req.bodyType === 'none') return undefined;
  const b = fill(req.body);
  if (req.bodyType !== 'form') return b || undefined;
  const p = new URLSearchParams();
  for (const line of b.split('\n')) { const i = line.indexOf('='); if (i > 0) p.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); }
  return p.toString();
}

const looksJson = (t) => /^\s*[[{]/.test(t);
function parseJson(text) { try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: e.message }; } }

// ───────────── send ─────────────
async function ensureAccess(url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return false; }
  const pattern = `${origin}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch { return true; }
}

async function sendRequest() {
  const url = finalUrl();
  if (!url) { showError('Enter a URL first.'); return; }
  if (!/^https?:\/\//i.test(url)) { showError('The URL must start with http:// or https://, or be a path when a page is open.'); return; }
  // First call in the click handler: Chrome asks for access to a new site only on a user action.
  const granted = await ensureAccess(url);
  if (!granted) { showError('Access to this site was not granted, so the panel cannot call it from here.'); return; }
  const btn = $('#rq-send');
  btn.disabled = true; btn.textContent = 'Sending…';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: req.method, headers: finalHeaders(), body: finalBody(), signal: ctrl.signal, credentials: 'include', cache: 'no-store' });
    const buf = await r.arrayBuffer();
    const time = performance.now() - t0;
    const ct = r.headers.get('content-type') || '';
    const text = /image|font|octet|zip|pdf|video|audio/.test(ct) ? '' : new TextDecoder().decode(buf);
    res = { status: r.status, statusText: r.statusText, time, size: buf.byteLength, ct, text, headers: [...r.headers.entries()], url: r.url, binary: !text && buf.byteLength > 0 };
    remember();
  } catch (e) {
    res = { error: e.name === 'AbortError' ? 'Timed out after 60 s.' : `${e.message}. The server may be down, the URL wrong, or the certificate invalid.` };
  } finally {
    clearTimeout(timer);
    btn.disabled = false; btn.textContent = 'Send';
  }
  resTab = 'body';
  renderResponse();
}

function showError(msg) { res = { error: msg }; renderResponse(); }

// ───────────── history + draft ─────────────
function remember() {
  const entry = JSON.parse(JSON.stringify(req));
  const sig = `${entry.method} ${entry.url}`;
  history = [entry, ...history.filter((x) => `${x.method} ${x.url}` !== sig)].slice(0, 15);
  store.set('req:history', history);
  renderHistory();
}
const saveDraft = () => { store.set('req:draft', req); };

// ───────────── rendering ─────────────
function kvTable(rows, kind) {
  return `<div class="kv-edit" data-kv="${kind}">${rows.map((r, i) => `
    <div class="kv-row">
      <input type="checkbox" data-i="${i}" data-f="on" ${r.on ? 'checked' : ''} aria-label="Enabled">
      <input type="text" data-i="${i}" data-f="key" value="${esc(r.key)}" placeholder="${kind === 'headers' ? 'Header' : 'Name'}" spellcheck="false" aria-label="Name">
      <input type="text" data-i="${i}" data-f="value" value="${esc(r.value)}" placeholder="Value" spellcheck="false" aria-label="Value">
      <button type="button" class="btn ghost tiny" data-del="${i}" aria-label="Remove">×</button>
    </div>`).join('')}
    <button type="button" class="btn ghost small" data-add="${kind}">+ Add</button></div>`;
}

function renderRequest() {
  const tabs = [['params', 'Params', active(req.params).length], ['headers', 'Headers', active(req.headers).length],
    ['body', 'Body', req.bodyType !== 'none' && req.body ? 1 : 0], ['auth', 'Auth', req.auth.type !== 'none' ? 1 : 0], ['vars', 'Variables', Object.keys(varMap()).length]];
  let body = '';
  if (reqTab === 'params') body = kvTable(req.params, 'params');
  else if (reqTab === 'headers') body = kvTable(req.headers, 'headers');
  else if (reqTab === 'body') {
    body = `<div class="rq-line"><label for="rq-btype">Format</label>
      <select id="rq-btype">${[['none', 'None'], ['json', 'JSON'], ['text', 'Text'], ['form', 'Form (key=value lines)']].map(([v, l]) => `<option value="${v}" ${req.bodyType === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${req.bodyType === 'json' ? '<button type="button" class="btn ghost small" id="rq-fmt">Format JSON</button>' : ''}</div>
      ${req.bodyType === 'none' ? '<p class="help">This request has no body.</p>' : `<textarea id="rq-body" class="rq-text" rows="8" spellcheck="false" aria-label="Request body" placeholder="${req.bodyType === 'json' ? '{ &quot;name&quot;: &quot;Ada&quot; }' : ''}">${esc(req.body)}</textarea>`}
      ${['GET', 'HEAD'].includes(req.method) && req.bodyType !== 'none' ? `<p class="help">${req.method} requests are sent without a body.</p>` : ''}`;
  } else if (reqTab === 'auth') {
    const a = req.auth;
    body = `<div class="rq-line"><label for="rq-atype">Type</label>
      <select id="rq-atype">${[['none', 'None'], ['bearer', 'Bearer token'], ['basic', 'Basic'], ['key', 'API key header']].map(([v, l]) => `<option value="${v}" ${a.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${a.type === 'bearer' ? `<input type="text" class="rq-in" data-auth="token" value="${esc(a.token)}" placeholder="Token or {{token}}" spellcheck="false" aria-label="Token">` : ''}
      ${a.type === 'basic' ? `<input type="text" class="rq-in" data-auth="user" value="${esc(a.user)}" placeholder="Username" aria-label="Username"><input type="text" class="rq-in" data-auth="pass" value="${esc(a.pass)}" placeholder="Password" aria-label="Password">` : ''}
      ${a.type === 'key' ? `<input type="text" class="rq-in" data-auth="name" value="${esc(a.name)}" placeholder="Header name" aria-label="Header name"><input type="text" class="rq-in" data-auth="token" value="${esc(a.token)}" placeholder="Key" aria-label="Key">` : ''}
      <p class="help">Saved in this browser only. Use test tokens.</p>`;
  } else {
    body = `<textarea id="rq-vars" class="rq-text" rows="6" spellcheck="false" aria-label="Variables" placeholder="api=http://localhost:3000&#10;token=eyJ…">${esc(vars)}</textarea>
      <p class="help">One <code>name=value</code> per line. Use them as <code>{{name}}</code> in the URL, headers, body and auth.</p>`;
  }
  $('#rq-sub').innerHTML = tabs.map(([k, l, n]) => `<button type="button" role="tab" data-rt="${k}" aria-selected="${k === reqTab}">${l}${n ? ` <span class="n">${n}</span>` : ''}</button>`).join('');
  $('#rq-pane').innerHTML = body;
  $('#rq-preview').textContent = finalUrl();
}

function renderHistory() {
  const sel = $('#rq-history');
  sel.innerHTML = `<option value="">Recent requests</option>${history.map((x, i) => `<option value="${i}">${esc(x.method)} ${esc(x.url.replace(/^https?:\/\//, ''))}</option>`).join('')}`;
}

function bodyHtml() {
  if (res.binary) return `<p class="help">Binary response (${esc(res.ct)}), ${fmtSize(res.size)}.</p>`;
  if (!res.text) return '<p class="help">Empty response body.</p>';
  const j = parseJson(res.text);
  return j.ok
    ? `<div class="json-tree">${jsonTree(j.value)}</div>`
    : `<pre class="rq-raw">${esc(res.text.slice(0, 200000))}</pre>${looksJson(res.text) ? `<p class="help">Not valid JSON: ${esc(j.error)}</p>` : ''}`;
}

function interfaceHtml() {
  const j = res.text ? parseJson(res.text) : { ok: false };
  if (!j.ok) return '<p class="help">The interface is generated from a JSON response. This one is not JSON.</p>';
  res.ts = toTypeScript(j.value, rootName, { dates });
  res.svc = angularService({ method: req.method, url: finalUrl(), hasBody: !!finalBody(), rootName, isArrayRoot: Array.isArray(j.value) });
  return `<div class="rq-line">
      <label for="rq-root">Name</label><input id="rq-root" class="rq-in short" value="${esc(rootName)}" spellcheck="false">
      <label for="rq-dates">Dates</label><select id="rq-dates"><option value="string" ${dates === 'string' ? 'selected' : ''}>string</option><option value="Date" ${dates === 'Date' ? 'selected' : ''}>Date</option></select></div>
    <div class="code-head"><span>TypeScript</span><span><button type="button" class="btn small" data-copy="ts">Copy interfaces</button><span role="status" class="saved"></span></span></div>
    <pre class="rq-raw">${esc(res.ts)}</pre>
    <div class="code-head"><span>Angular service</span><span><button type="button" class="btn small" data-copy="svc">Copy service</button><span role="status" class="saved"></span></span></div>
    <pre class="rq-raw">${esc(res.svc)}</pre>
    <p class="help">Fields missing from some array items are marked optional. Check <code>null</code> and union types against your API contract.</p>`;
}

const statusTone = (s) => (s >= 500 ? 'bad' : s >= 400 ? 'warn' : s >= 300 ? 'info' : 'ok');

function renderResponse() {
  const box = $('#rq-res');
  if (!res) { box.innerHTML = '<p class="empty">Send a request to see the response here.</p>'; return; }
  if (res.error) { box.innerHTML = `<div class="rq-err" role="alert">${esc(res.error)}</div>`; return; }
  const tabs = [['body', 'Body'], ['headers', `Headers <span class="n">${res.headers.length}</span>`], ['interface', 'Interface']];
  let pane = '';
  if (resTab === 'body') pane = bodyHtml();
  else if (resTab === 'headers') pane = `<dl class="kv">${res.headers.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  else pane = interfaceHtml();
  box.innerHTML = `
    <div class="rq-status"><span class="st t-${statusTone(res.status)}">${res.status} ${esc(res.statusText)}</span>
      <span>${fmtMs(res.time)}</span><span>${fmtSize(res.size)}</span>
      ${res.ct ? `<span class="ct">${esc(res.ct.split(';')[0])}</span>` : ''}</div>
    <div class="subtabs" role="tablist" aria-label="Response">${tabs.map(([k, l]) => `<button type="button" role="tab" data-st="${k}" aria-selected="${k === resTab}">${l}</button>`).join('')}</div>
    <div class="rq-body">${pane}</div>
    ${resTab === 'body' && res.text ? '<div class="actions"><button type="button" class="btn small" data-copy="raw">Copy response</button><span role="status" class="saved"></span></div>' : ''}`;
}

// ───────────── from Network ─────────────
function suggestName(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter((s) => s && !/^\d+$/.test(s) && !/^v\d+$/.test(s) && s !== 'api');
    const w = (seg.at(-1) || 'Response').replace(/\.\w+$/, '').replace(/[^A-Za-z0-9]+/g, ' ').trim();
    return w.split(' ').filter(Boolean).map((x) => x[0].toUpperCase() + x.slice(1)).join('') || 'Response';
  } catch { return 'Response'; }
}
function syncTop() { $('#rq-method').value = req.method; $('#rq-url').value = req.url; }
function reset() { res = null; reqTab = 'params'; syncTop(); renderRequest(); renderResponse(); saveDraft(); }

function load(n) {
  if (!n) return;
  const headers = (n.reqHeaders || []).map(([k, v]) => newRow(k, v));
  const ct = (n.reqHeaders || []).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  let url = n.url, params = [];
  try { const u = new URL(n.url); params = [...u.searchParams].map(([k, v]) => newRow(k, v)); u.search = ''; url = u.toString(); } catch { /* keep */ }
  const text = typeof n.reqBody === 'string' ? n.reqBody : n.reqBody?.text || '';
  Object.assign(req, {
    method: METHODS.includes(n.method) ? n.method : 'GET', url, params: [...params, newRow()],
    headers: [...headers, newRow()], body: text,
    bodyType: !text ? 'none' : /json/.test(ct) || looksJson(text) ? 'json' : /x-www-form/.test(ct) ? 'form' : 'text',
    auth: blankAuth(),
  });
  if (req.bodyType === 'form') req.body = text.split('&').map((p) => { try { return decodeURIComponent(p.replace(/\+/g, ' ')); } catch { return p; } }).join('\n');
  rootName = suggestName(url);
  reset();
}

// Re-render only the code blocks so the Name field keeps focus while typing.
function refreshInterface() {
  const j = res?.text ? parseJson(res.text) : null;
  if (!j?.ok) return;
  res.ts = toTypeScript(j.value, rootName, { dates });
  res.svc = angularService({ method: req.method, url: finalUrl(), hasBody: !!finalBody(), rootName, isArrayRoot: Array.isArray(j.value) });
  const pres = $$('.rq-raw', $('#rq-res'));
  if (pres[0]) pres[0].textContent = res.ts;
  if (pres[1]) pres[1].textContent = res.svc;
}

// ───────────── init ─────────────
export async function init() {
  Object.assign(req, await store.get('req:draft', {}));
  vars = await store.get('req:vars', '');
  history = await store.get('req:history', []);
  rootName = suggestName(req.url);
  $('#rq-method').innerHTML = METHODS.map((m) => `<option>${m}</option>`).join('');
  syncTop(); renderRequest(); renderHistory(); renderResponse();

  $('#rq-method').addEventListener('change', (e) => { req.method = e.target.value; renderRequest(); saveDraft(); });
  $('#rq-url').addEventListener('input', (e) => { req.url = e.target.value; $('#rq-preview').textContent = finalUrl(); saveDraft(); });
  $('#rq-form').addEventListener('submit', (e) => { e.preventDefault(); sendRequest(); });
  $('#rq-history').addEventListener('change', (e) => {
    const x = history[e.target.value];
    if (x) { Object.assign(req, JSON.parse(JSON.stringify(x))); rootName = suggestName(req.url); reset(); }
    e.target.value = '';
  });
  $('#rq-new').addEventListener('click', () => {
    Object.assign(req, { method: 'GET', url: '', params: [newRow()], headers: [newRow()], bodyType: 'json', body: '', auth: blankAuth() });
    reset();
  });
  $('#rq-sub').addEventListener('click', (e) => { const b = e.target.closest('[data-rt]'); if (b) { reqTab = b.dataset.rt; renderRequest(); } });

  const pane = $('#rq-pane');
  pane.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.f) {
      const rows = req[t.closest('[data-kv]').dataset.kv];
      rows[t.dataset.i][t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value;
    } else if (t.id === 'rq-body') req.body = t.value;
    else if (t.id === 'rq-vars') { vars = t.value; store.set('req:vars', vars); }
    else if (t.dataset.auth) req.auth[t.dataset.auth] = t.value;
    $('#rq-preview').textContent = finalUrl();
    saveDraft();
  });
  pane.addEventListener('change', (e) => {
    if (e.target.id === 'rq-btype') { req.bodyType = e.target.value; renderRequest(); saveDraft(); }
    if (e.target.id === 'rq-atype') { req.auth.type = e.target.value; renderRequest(); saveDraft(); }
  });
  pane.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]'), del = e.target.closest('[data-del]');
    if (add) { req[add.dataset.add].push(newRow()); renderRequest(); $$('[data-f="key"]', $('#rq-pane')).at(-1)?.focus(); }
    if (del) {
      const kind = del.closest('[data-kv]').dataset.kv;
      req[kind].splice(+del.dataset.del, 1);
      if (!req[kind].length) req[kind].push(newRow());
      renderRequest(); saveDraft();
    }
    if (e.target.id === 'rq-fmt') {
      const j = parseJson(req.body);
      if (j.ok) { req.body = JSON.stringify(j.value, null, 2); renderRequest(); saveDraft(); }
    }
  });

  const out = $('#rq-res');
  out.addEventListener('click', (e) => {
    const t = e.target.closest('[data-st]');
    if (t) { resTab = t.dataset.st; renderResponse(); return; }
    const c = e.target.closest('[data-copy]');
    if (c) copyText(c, c.dataset.copy === 'ts' ? res.ts : c.dataset.copy === 'svc' ? res.svc : res.text);
  });
  out.addEventListener('input', (e) => { if (e.target.id === 'rq-root') { rootName = e.target.value.trim() || 'Response'; refreshInterface(); } });
  out.addEventListener('change', (e) => { if (e.target.id === 'rq-dates') { dates = e.target.value; refreshInterface(); } });

  on('to-requests', load);
}
