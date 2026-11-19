// Requests tab: build and send an HTTP request, read the response, and copy
// TypeScript interfaces / an Angular service generated from it.
import type { NetEntry } from '../../../shared/messages';
import { angularService, toTypeScript } from '../../../shared/schema';
import { on } from '../../core/bus';
import { $, $$, closest, copyText, esc } from '../../core/dom';
import { fmtMs, fmtSize, jsonTree } from '../../core/format';
import { S } from '../../core/state';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type Method = (typeof METHODS)[number];
type BodyType = 'none' | 'json' | 'text' | 'form';
type AuthType = 'none' | 'bearer' | 'basic' | 'key';
interface Row { key: string; value: string; on: boolean }
interface Auth { type: AuthType; token: string; user: string; pass: string; name: string }
interface Draft { method: Method; url: string; params: Row[]; headers: Row[]; bodyType: BodyType; body: string; auth: Auth }
type ReqTab = 'params' | 'headers' | 'body' | 'auth' | 'vars';
type ResTab = 'body' | 'headers' | 'interface';
type Response =
  | { error: string }
  | { status: number; statusText: string; time: number; size: number; ct: string; text: string; headers: [string, string][]; binary: boolean; ts?: string; svc?: string };

const newRow = (key = '', value = '', enabled = true): Row => ({ key, value, on: enabled });
const blankAuth = (): Auth => ({ type: 'none', token: '', user: '', pass: '', name: 'X-API-Key' });
const blankDraft = (): Draft => ({ method: 'GET', url: '', params: [newRow()], headers: [newRow()], bodyType: 'json', body: '', auth: blankAuth() });

// ───────────── storage (this browser only) ─────────────
const isMethod = (m: unknown): m is Method => typeof m === 'string' && (METHODS as readonly string[]).includes(m);
const isRows = (v: unknown): v is Row[] => Array.isArray(v) && v.every((r) => typeof r === 'object' && r !== null && typeof Reflect.get(r, 'key') === 'string' && typeof Reflect.get(r, 'value') === 'string');
function readDraft(v: unknown): Draft | null {
  if (typeof v !== 'object' || v === null) return null;
  const d = blankDraft();
  const get = (k: string): unknown => Reflect.get(v, k);
  const method = get('method'), url = get('url'), params = get('params'), headers = get('headers'), bodyType = get('bodyType'), body = get('body'), auth = get('auth');
  if (isMethod(method)) d.method = method;
  if (typeof url === 'string') d.url = url;
  if (isRows(params) && params.length) d.params = params;
  if (isRows(headers) && headers.length) d.headers = headers;
  if (bodyType === 'none' || bodyType === 'json' || bodyType === 'text' || bodyType === 'form') d.bodyType = bodyType;
  if (typeof body === 'string') d.body = body;
  if (typeof auth === 'object' && auth !== null) {
    const t = Reflect.get(auth, 'type');
    if (t === 'none' || t === 'bearer' || t === 'basic' || t === 'key') d.auth.type = t;
    for (const k of ['token', 'user', 'pass', 'name'] as const) { const x = Reflect.get(auth, k); if (typeof x === 'string') d.auth[k] = x; }
  }
  return d;
}
async function load(key: string): Promise<unknown> {
  try { return (await chrome.storage.local.get(key))[key]; } catch { return undefined; }
}
const save = (key: string, value: unknown): void => { chrome.storage.local.set({ [key]: value }).catch(() => {}); };

const req: Draft = blankDraft();
let vars = ''; // "key=value" lines
let reqTab: ReqTab = 'params';
let res: Response | null = null;
let resTab: ResTab = 'body';
let rootName = 'Response';
let nameEdited = false; // until the user types a name, it follows the URL
let dates: 'string' | 'Date' = 'string';
let history: Draft[] = [];

// ───────────── building the request ─────────────
function varMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of vars.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return m;
}
const fill = (s: string): string => { const m = varMap(); return s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, k: string) => m.get(k) ?? all); };
const active = (rows: Row[]): Row[] => rows.filter((r) => r.on && r.key.trim());

function finalUrl(): string {
  const raw = fill(req.url.trim());
  if (!raw) return '';
  let u: URL;
  try { u = new URL(raw, S.tabUrl || undefined); } catch { return raw; }
  for (const p of active(req.params)) u.searchParams.append(fill(p.key), fill(p.value));
  return u.toString();
}
function finalHeaders(): Headers {
  const hd = new Headers();
  const set = (k: string, v: string): void => { try { hd.set(k, v); } catch { /* invalid header name */ } };
  for (const r of active(req.headers)) set(fill(r.key), fill(r.value));
  const a = req.auth;
  if (a.type === 'bearer' && a.token) set('Authorization', `Bearer ${fill(a.token)}`);
  if (a.type === 'basic') set('Authorization', `Basic ${btoa(`${fill(a.user)}:${fill(a.pass)}`)}`);
  if (a.type === 'key' && a.token) set(fill(a.name || 'X-API-Key'), fill(a.token));
  if (req.bodyType === 'json' && !hd.has('Content-Type')) set('Content-Type', 'application/json');
  if (req.bodyType === 'form' && !hd.has('Content-Type')) set('Content-Type', 'application/x-www-form-urlencoded');
  return hd;
}
function finalBody(): string | undefined {
  if (req.method === 'GET' || req.method === 'HEAD' || req.bodyType === 'none') return undefined;
  const b = fill(req.body);
  if (req.bodyType !== 'form') return b || undefined;
  const p = new URLSearchParams();
  for (const line of b.split('\n')) { const i = line.indexOf('='); if (i > 0) p.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); }
  return p.toString();
}

const looksJson = (t: string): boolean => /^\s*[[{]/.test(t);
function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

// ───────────── sending ─────────────
async function ensureAccess(url: string): Promise<boolean> {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return false; }
  const pattern = `${origin}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch { return true; }
}

async function sendRequest(): Promise<void> {
  const url = finalUrl();
  if (!url) { showError('Enter a URL first.'); return; }
  if (!/^https?:\/\//i.test(url)) { showError('The URL must start with http:// or https://, or be a path when a page is open.'); return; }
  // First await in the click handler: Chrome asks for access to a new site only on a user action.
  if (!(await ensureAccess(url))) { showError('Access to this site was not granted, so the panel cannot call it from here.'); return; }
  const btn = $<HTMLButtonElement>('#rq-send');
  btn.disabled = true; btn.textContent = 'Sending…';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  const t0 = performance.now();
  try {
    const body = finalBody();
    const r = await fetch(url, { method: req.method, headers: finalHeaders(), ...(body !== undefined ? { body } : {}), signal: ctrl.signal, credentials: 'include', cache: 'no-store' });
    const buf = await r.arrayBuffer();
    const ct = r.headers.get('content-type') ?? '';
    const text = /image|font|octet|zip|pdf|video|audio/.test(ct) ? '' : new TextDecoder().decode(buf);
    res = { status: r.status, statusText: r.statusText, time: performance.now() - t0, size: buf.byteLength, ct, text, headers: [...r.headers.entries()], binary: !text && buf.byteLength > 0 };
    remember();
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    res = { error: aborted ? 'Timed out after 60 s.' : `${e instanceof Error ? e.message : String(e)}. The server may be down, the URL wrong, or the certificate invalid.` };
  } finally {
    clearTimeout(timer);
    btn.disabled = false; btn.textContent = 'Send';
  }
  resTab = 'body';
  renderResponse();
}

function showError(msg: string): void { res = { error: msg }; renderResponse(); }

// ───────────── history + draft ─────────────
const copyDraft = (d: Draft): Draft => ({ ...d, params: d.params.map((r) => ({ ...r })), headers: d.headers.map((r) => ({ ...r })), auth: { ...d.auth } });
function remember(): void {
  const entry = copyDraft(req);
  const sig = `${entry.method} ${entry.url}`;
  history = [entry, ...history.filter((x) => `${x.method} ${x.url}` !== sig)].slice(0, 15);
  save('req:history', history);
  renderHistory();
}
const saveDraft = (): void => { save('req:draft', req); };

// ───────────── rendering ─────────────
function kvTable(rows: Row[], kind: 'params' | 'headers'): string {
  return `<div class="kv-edit" data-kv="${kind}">${rows.map((r, i) => `
    <div class="kv-row">
      <input type="checkbox" data-i="${i}" data-f="on" ${r.on ? 'checked' : ''} aria-label="Enabled">
      <input type="text" data-i="${i}" data-f="key" value="${esc(r.key)}" placeholder="${kind === 'headers' ? 'Header' : 'Name'}" spellcheck="false" aria-label="Name">
      <input type="text" data-i="${i}" data-f="value" value="${esc(r.value)}" placeholder="Value" spellcheck="false" aria-label="Value">
      <button type="button" class="btn ghost tiny" data-del="${i}" aria-label="Remove">×</button>
    </div>`).join('')}
    <button type="button" class="btn ghost small" data-add="${kind}">+ Add</button></div>`;
}
const option = <T extends string>(value: T, label: string, current: T): string => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;

function renderRequest(): void {
  const tabs: [ReqTab, string, number][] = [
    ['params', 'Params', active(req.params).length], ['headers', 'Headers', active(req.headers).length],
    ['body', 'Body', req.bodyType !== 'none' && req.body ? 1 : 0], ['auth', 'Auth', req.auth.type !== 'none' ? 1 : 0], ['vars', 'Variables', varMap().size],
  ];
  let body = '';
  if (reqTab === 'params') body = kvTable(req.params, 'params');
  else if (reqTab === 'headers') body = kvTable(req.headers, 'headers');
  else if (reqTab === 'body') {
    const noBody = req.method === 'GET' || req.method === 'HEAD';
    body = `<div class="rq-line"><label for="rq-btype">Format</label>
      <select id="rq-btype">${option('none', 'None', req.bodyType)}${option('json', 'JSON', req.bodyType)}${option('text', 'Text', req.bodyType)}${option('form', 'Form (key=value lines)', req.bodyType)}</select>
      ${req.bodyType === 'json' ? '<button type="button" class="btn ghost small" id="rq-fmt">Format JSON</button>' : ''}</div>
      ${req.bodyType === 'none' ? '<p class="help">This request has no body.</p>' : `<textarea id="rq-body" class="rq-text" rows="8" spellcheck="false" aria-label="Request body" placeholder="${req.bodyType === 'json' ? '{ &quot;name&quot;: &quot;Ada&quot; }' : ''}">${esc(req.body)}</textarea>`}
      ${noBody && req.bodyType !== 'none' ? `<p class="help">${req.method} requests are sent without a body.</p>` : ''}`;
  } else if (reqTab === 'auth') {
    const a = req.auth;
    const field = (k: keyof Omit<Auth, 'type'>, placeholder: string): string => `<input type="text" class="rq-in" data-auth="${k}" value="${esc(a[k])}" placeholder="${placeholder}" spellcheck="false" aria-label="${placeholder}">`;
    body = `<div class="rq-line"><label for="rq-atype">Type</label>
      <select id="rq-atype">${option('none', 'None', a.type)}${option('bearer', 'Bearer token', a.type)}${option('basic', 'Basic', a.type)}${option('key', 'API key header', a.type)}</select></div>
      ${a.type === 'bearer' ? field('token', 'Token or {{token}}') : ''}
      ${a.type === 'basic' ? field('user', 'Username') + field('pass', 'Password') : ''}
      ${a.type === 'key' ? field('name', 'Header name') + field('token', 'Key') : ''}
      <p class="help">Saved in this browser only. Use test tokens.</p>`;
  } else {
    body = `<textarea id="rq-vars" class="rq-text" rows="6" spellcheck="false" aria-label="Variables" placeholder="api=http://localhost:3000&#10;token=eyJ…">${esc(vars)}</textarea>
      <p class="help">One <code>name=value</code> per line. Use them as <code>{{name}}</code> in the URL, headers, body and auth.</p>`;
  }
  $('#rq-sub').innerHTML = tabs.map(([k, l, n]) => `<button type="button" role="tab" data-rt="${k}" aria-selected="${k === reqTab}">${l}${n ? ` <span class="n">${n}</span>` : ''}</button>`).join('');
  $('#rq-pane').innerHTML = body;
  $('#rq-preview').textContent = finalUrl();
}

function renderHistory(): void {
  $('#rq-history').innerHTML = `<option value="">Recent requests</option>${history.map((x, i) => `<option value="${i}">${esc(x.method)} ${esc(x.url.replace(/^https?:\/\//, ''))}</option>`).join('')}`;
}

type Ok = Exclude<Response, { error: string }>;

function bodyHtml(r: Ok): string {
  if (r.binary) return `<p class="help">Binary response (${esc(r.ct)}), ${fmtSize(r.size)}.</p>`;
  if (!r.text) return '<p class="help">Empty response body.</p>';
  const j = parseJson(r.text);
  return j.ok
    ? `<div class="json-tree">${jsonTree(j.value)}</div>`
    : `<pre class="rq-raw">${esc(r.text.slice(0, 200000))}</pre>${looksJson(r.text) ? `<p class="help">Not valid JSON: ${esc(j.error)}</p>` : ''}`;
}

function buildCode(r: Ok): boolean {
  const j = r.text ? parseJson(r.text) : null;
  if (!j?.ok) return false;
  r.ts = toTypeScript(j.value, rootName, { dates });
  r.svc = angularService({ method: req.method, url: finalUrl(), hasBody: finalBody() !== undefined, rootName, isArrayRoot: Array.isArray(j.value) });
  return true;
}

function interfaceHtml(r: Ok): string {
  if (!buildCode(r)) return '<p class="help">The interface is generated from a JSON response. This one is not JSON.</p>';
  return `<div class="rq-line">
      <label for="rq-root">Name</label><input id="rq-root" class="rq-in short" value="${esc(rootName)}" spellcheck="false">
      <label for="rq-dates">Dates</label><select id="rq-dates">${option('string', 'string', dates)}${option('Date', 'Date', dates)}</select></div>
    <div class="code-head"><span>TypeScript</span><span><button type="button" class="btn small" data-copy="ts">Copy interfaces</button><span role="status" class="saved"></span></span></div>
    <pre class="rq-raw">${esc(r.ts ?? '')}</pre>
    <div class="code-head"><span>Angular service</span><span><button type="button" class="btn small" data-copy="svc">Copy service</button><span role="status" class="saved"></span></span></div>
    <pre class="rq-raw">${esc(r.svc ?? '')}</pre>
    <p class="help">Fields missing from some array items are marked optional. Check <code>null</code> and union types against your API contract.</p>`;
}

const statusTone = (s: number): string => (s >= 500 ? 'bad' : s >= 400 ? 'warn' : s >= 300 ? 'info' : 'ok');

function renderResponse(): void {
  const box = $('#rq-res');
  if (!res) { box.innerHTML = '<p class="empty">Send a request to see the response here.</p>'; return; }
  if ('error' in res) { box.innerHTML = `<div class="rq-err" role="alert">${esc(res.error)}</div>`; return; }
  const r = res;
  const tabs: [ResTab, string][] = [['body', 'Body'], ['headers', `Headers <span class="n">${r.headers.length}</span>`], ['interface', 'Interface']];
  const pane = resTab === 'body' ? bodyHtml(r)
    : resTab === 'headers' ? `<dl class="kv">${r.headers.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
      : interfaceHtml(r);
  box.innerHTML = `
    <div class="rq-status"><span class="st t-${statusTone(r.status)}">${r.status} ${esc(r.statusText)}</span>
      <span>${fmtMs(r.time)}</span><span>${fmtSize(r.size)}</span>
      ${r.ct ? `<span class="ct">${esc(r.ct.split(';')[0] ?? r.ct)}</span>` : ''}</div>
    <div class="subtabs" role="tablist" aria-label="Response">${tabs.map(([k, l]) => `<button type="button" role="tab" data-st="${k}" aria-selected="${k === resTab}">${l}</button>`).join('')}</div>
    <div class="rq-body">${pane}</div>
    ${resTab === 'body' && r.text ? '<div class="actions"><button type="button" class="btn small" data-copy="raw">Copy response</button><span role="status" class="saved"></span></div>' : ''}`;
}

// Re-render only the code blocks so the Name field keeps focus while typing.
function refreshInterface(): void {
  if (!res || 'error' in res || !buildCode(res)) return;
  const [ts, svc] = $$('.rq-raw', $('#rq-res'));
  if (ts) ts.textContent = res.ts ?? '';
  if (svc) svc.textContent = res.svc ?? '';
}

// ───────────── from Network ─────────────
function suggestName(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter((s) => s && !/^\d+$/.test(s) && !/^v\d+$/.test(s) && s !== 'api');
    const w = (seg.at(-1) ?? 'Response').replace(/\.\w+$/, '').replace(/[^A-Za-z0-9]+/g, ' ').trim();
    return w.split(' ').filter(Boolean).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('') || 'Response';
  } catch { return 'Response'; }
}
function syncTop(): void {
  $<HTMLSelectElement>('#rq-method').value = req.method;
  $<HTMLInputElement>('#rq-url').value = req.url;
}
function reset(): void { res = null; reqTab = 'params'; nameEdited = false; rootName = suggestName(req.url); syncTop(); renderRequest(); renderResponse(); saveDraft(); }

function loadFrom(n: NetEntry): void {
  const ct = n.reqHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  let url = n.url;
  let params: Row[] = [];
  try { const u = new URL(n.url); params = [...u.searchParams].map(([k, v]) => newRow(k, v)); u.search = ''; url = u.toString(); } catch { /* keep */ }
  const text = n.reqBody?.text ?? '';
  const bodyType: BodyType = !text ? 'none' : /json/.test(ct) || looksJson(text) ? 'json' : /x-www-form/.test(ct) ? 'form' : 'text';
  Object.assign(req, {
    method: isMethod(n.method) ? n.method : 'GET',
    url,
    params: [...params, newRow()],
    headers: [...n.reqHeaders.map(([k, v]) => newRow(k, v)), newRow()],
    bodyType,
    body: bodyType === 'form' ? text.split('&').map((p) => { try { return decodeURIComponent(p.replace(/\+/g, ' ')); } catch { return p; } }).join('\n') : text,
    auth: blankAuth(),
  } satisfies Draft);
  rootName = suggestName(url);
  reset();
}

// ───────────── wiring ─────────────
export async function init(): Promise<void> {
  Object.assign(req, readDraft(await load('req:draft')) ?? blankDraft());
  const v = await load('req:vars');
  vars = typeof v === 'string' ? v : '';
  const h = await load('req:history');
  history = Array.isArray(h) ? h.map(readDraft).filter((d): d is Draft => d !== null) : [];
  rootName = suggestName(req.url);
  $('#rq-method').innerHTML = METHODS.map((m) => `<option>${m}</option>`).join('');
  syncTop(); renderRequest(); renderHistory(); renderResponse();

  $<HTMLSelectElement>('#rq-method').addEventListener('change', (e) => {
    const m = (e.currentTarget as HTMLSelectElement).value; // the listener is on this select
    if (isMethod(m)) req.method = m;
    renderRequest(); saveDraft();
  });
  $<HTMLInputElement>('#rq-url').addEventListener('input', (e) => {
    req.url = (e.currentTarget as HTMLInputElement).value; // the listener is on this input
    if (!nameEdited) rootName = suggestName(fill(req.url));
    $('#rq-preview').textContent = finalUrl();
    saveDraft();
  });
  $('#rq-form').addEventListener('submit', (e) => { e.preventDefault(); void sendRequest(); });
  $<HTMLSelectElement>('#rq-history').addEventListener('change', (e) => {
    const sel = e.currentTarget as HTMLSelectElement; // the listener is on this select
    const x = history[Number(sel.value)];
    if (sel.value !== '' && x) { Object.assign(req, copyDraft(x)); rootName = suggestName(req.url); reset(); }
    sel.value = '';
  });
  $('#rq-new').addEventListener('click', () => { Object.assign(req, blankDraft()); reset(); });
  $('#rq-sub').addEventListener('click', (e) => {
    const t = closest(e, '[data-rt]')?.dataset.rt;
    if (t === 'params' || t === 'headers' || t === 'body' || t === 'auth' || t === 'vars') { reqTab = t; renderRequest(); }
  });

  const pane = $('#rq-pane');
  pane.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.dataset.f) {
      const kind = t.closest<HTMLElement>('[data-kv]')?.dataset.kv;
      const row = (kind === 'params' || kind === 'headers') ? req[kind][Number(t.dataset.i)] : undefined;
      if (row) {
        if (t.dataset.f === 'on') row.on = t.checked;
        else if (t.dataset.f === 'key') row.key = t.value;
        else if (t.dataset.f === 'value') row.value = t.value;
      }
    } else if (t instanceof HTMLTextAreaElement && t.id === 'rq-body') req.body = t.value;
    else if (t instanceof HTMLTextAreaElement && t.id === 'rq-vars') { vars = t.value; save('req:vars', vars); }
    else if (t instanceof HTMLInputElement) {
      const k = t.dataset.auth;
      if (k === 'token' || k === 'user' || k === 'pass' || k === 'name') req.auth[k] = t.value;
    }
    $('#rq-preview').textContent = finalUrl();
    saveDraft();
  });
  pane.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement)) return;
    if (t.id === 'rq-btype' && (t.value === 'none' || t.value === 'json' || t.value === 'text' || t.value === 'form')) req.bodyType = t.value;
    else if (t.id === 'rq-atype' && (t.value === 'none' || t.value === 'bearer' || t.value === 'basic' || t.value === 'key')) req.auth.type = t.value;
    else return;
    renderRequest(); saveDraft();
  });
  pane.addEventListener('click', (e) => {
    const add = closest(e, '[data-add]')?.dataset.add;
    if (add === 'params' || add === 'headers') {
      req[add].push(newRow());
      renderRequest();
      $$('[data-f="key"]', pane).at(-1)?.focus();
      return;
    }
    const del = closest(e, '[data-del]');
    const kind = del?.closest<HTMLElement>('[data-kv]')?.dataset.kv;
    if (del && (kind === 'params' || kind === 'headers')) {
      req[kind].splice(Number(del.dataset.del), 1);
      if (!req[kind].length) req[kind].push(newRow());
      renderRequest(); saveDraft();
      return;
    }
    if (closest(e, '#rq-fmt')) {
      const j = parseJson(req.body);
      if (j.ok) { req.body = JSON.stringify(j.value, null, 2); renderRequest(); saveDraft(); }
    }
  });

  const out = $('#rq-res');
  out.addEventListener('click', (e) => {
    const t = closest(e, '[data-st]')?.dataset.st;
    if (t === 'body' || t === 'headers' || t === 'interface') { resTab = t; renderResponse(); return; }
    const c = closest(e, '[data-copy]');
    if (!c || !res || 'error' in res) return;
    void copyText(c, c.dataset.copy === 'ts' ? res.ts ?? '' : c.dataset.copy === 'svc' ? res.svc ?? '' : res.text);
  });
  out.addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.id === 'rq-root') { rootName = e.target.value.trim() || 'Response'; nameEdited = true; refreshInterface(); }
  });
  out.addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement && e.target.id === 'rq-dates') { dates = e.target.value === 'Date' ? 'Date' : 'string'; refreshInterface(); }
  });

  on('to-requests', loadFrom);
}
