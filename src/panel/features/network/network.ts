// Network tab: the calls your app makes to its backend (fetch/XHR with JSON),
// each with the line of your code that made it. A breakdown by status code
// explains what each code means from the backend's side, and works as a filter.
import type { Body, Header, NetEntry } from '../../../shared/messages';
import { isAppFrame, mapStack, type AppFrame } from '../../../shared/sourcemap';
import { meaning, shortMeaning } from '../../../shared/status-codes';
import { emit, on } from '../../core/bus';
import { codeBlock } from '../../core/code';
import { $, $$, $maybe, closest, copyText, esc, input } from '../../core/dom';
import { fileLink } from '../../core/editor';
import { fmtMs, fmtSize, jsonTree } from '../../core/format';
import { send } from '../../core/rpc';
import { S } from '../../core/state';

type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'failed' | 'aborted' | 'pending';
const STATUS_CLASSES: StatusClass[] = ['2xx', '3xx', '4xx', '5xx', 'failed'];

// ───────────── which calls are backend API calls ─────────────
const urlOf = (u: string): URL | null => { try { return new URL(u); } catch { return null; } };
const headerVal = (list: Header[] | undefined, name: string): string => list?.find(([k]) => k.toLowerCase() === name)?.[1] ?? '';
const isJsonResponse = (n: NetEntry): boolean => /json/.test(headerVal(n.resHeaders, 'content-type')) || /^\s*[[{]/.test(n.resBody?.text ?? '');
const apiBases = (): string[] => S.settings.apiBase.split(',').map((s) => s.trim()).filter(Boolean);

// Analytics, tags, ads and error reporters: never your backend.
const TRACKERS = /(^|\.)(google-analytics|googletagmanager|googleadservices|doubleclick|googlesyndication|clarity|hotjar|facebook|fbcdn|linkedin|licdn|twitter|ads-twitter|tiktok|snapchat|pinterest|segment|mixpanel|amplitude|heap|fullstory|logrocket|sentry|datadoghq|newrelic|nr-data|bugsnag|intercom|hubspot|hs-analytics|hsforms|zdassets|crisp|tawk|cloudflareinsights|posthog)\./i;
const looksLikeApiRequest = (n: NetEntry): boolean =>
  !!authHeader(n) || /json/.test(headerVal(n.reqHeaders, 'content-type')) || /^\s*[[{]/.test(n.reqBody?.text ?? '');

// Your backend is the other host that answers with JSON (or takes an auth
// header) most often. Hosts with only a stray call, like a Firebase auth lookup
// or an analytics ping that returns JSON, fall below 30% of the busiest host.
let backendHosts = new Set<string>();
function computeBackendHosts(): void {
  const pageOrigin = urlOf(S.tabUrl)?.origin;
  const counts = new Map<string, number>();
  for (const n of S.net.values()) {
    const u = urlOf(n.url);
    if (!u || u.origin === pageOrigin || TRACKERS.test(u.hostname)) continue;
    if (isJsonResponse(n) || authHeader(n)) counts.set(u.host, (counts.get(u.host) ?? 0) + 1);
  }
  const top = Math.max(0, ...counts.values());
  backendHosts = new Set([...counts].filter(([, c]) => c >= Math.max(1, top * 0.3)).map(([h]) => h));
}

export function isBackendCall(n: NetEntry): boolean {
  const bases = apiBases();
  if (bases.length) return bases.some((b) => n.url.startsWith(b));
  const u = urlOf(n.url);
  if (!u) return false;
  if (u.origin === urlOf(S.tabUrl)?.origin) {
    // Same origin: API routes have no file extension (/api/users), static files do (/assets/i18n/en.json).
    return !/\.[a-z0-9]{2,5}$/i.test(u.pathname);
  }
  if (TRACKERS.test(u.hostname)) return false;
  if (backendHosts.has(u.host)) return true;
  // Failed or still pending: nothing to learn the host from yet. Count it if it looks like an API call,
  // or if no backend has been identified at all (a backend that is down must still show up).
  const unresolved = n.status == null || n.status === 0 || n.status >= 400;
  return unresolved && (looksLikeApiRequest(n) || backendHosts.size === 0);
}

export function statusClass(n: NetEntry): StatusClass {
  if (n.statusText === 'aborted') return 'aborted';
  if (n.status == null) return 'pending';
  if (n.status === 0) return 'failed';
  if (n.status >= 500) return '5xx';
  if (n.status >= 400) return '4xx';
  if (n.status >= 300) return '3xx';
  return '2xx';
}

const AUTH_HEADERS = ['authorization', 'token', 'x-auth-token', 'x-access-token', 'x-api-key'];
const authHeader = (n: NetEntry): string | undefined => n.reqHeaders.find(([k]) => AUTH_HEADERS.includes(k.toLowerCase()))?.[0];

interface Problem { level: 'error' | 'warn' | 'info'; label: string; hint: string }

// Front-end findings from what was actually captured.
export function problems(n: NetEntry, dupCount = 0): Problem[] {
  const out: Problem[] = [];
  const add = (level: Problem['level'], label: string, hint: string): void => { out.push({ level, label, hint }); };
  const s = n.status;
  if (n.statusText === 'aborted') add('info', 'Cancelled', 'The request was aborted before it finished. Often switchMap cancelling an older request, or a component destroyed mid-request. Usually harmless.');
  else if (s === 0) add('error', 'Blocked or offline', 'No response reached the page: CORS, DNS, a refused connection, or an ad blocker. A CORS problem shows its own message in the browser console.');
  else if (s === 401) {
    const h = authHeader(n);
    add('error', 'Not authenticated', h ? `The ${h} header was sent but rejected: the token is probably expired or invalid.` : 'No auth header (Authorization or token) was sent with this request. Check that your HTTP interceptor adds it for this URL, and that the user is logged in.');
  } else if (s === 403) add('error', 'Forbidden', 'The server knows who you are but refuses this action.');
  else if (s === 404) add('error', 'Not found', 'Compare the URL with the API docs and your environment base URL.');
  else if (s === 405) add('error', 'Method not allowed', `The endpoint exists but doesn't accept ${n.method}.`);
  else if (s === 400 || s === 422) add('error', 'Rejected input', 'The server didn\'t accept the request data. The Response tab usually says which field.');
  else if (s === 408 || s === 504) add('error', 'Timed out', 'The server or a gateway gave up waiting.');
  else if (s === 429) { const ra = headerVal(n.resHeaders, 'retry-after'); add('warn', 'Rate limited', `Too many requests.${ra ? ` Retry after ${ra} s.` : ''}`); }
  else if (s != null && s >= 500) add('error', 'Server error', 'The request may be fine: check the server logs and the Response tab.');
  else if (s != null && s >= 400) add('error', `Client error ${s}`, 'The server rejected the request.');

  const body = n.resBody?.text ?? '';
  const ct = headerVal(n.resHeaders, 'content-type');
  if (s != null && s >= 200 && s < 300 && (/html/.test(ct) || /^\s*<(!doctype|html)/i.test(body))) {
    add('error', 'HTML instead of JSON', 'The API returned an HTML page, usually the dev server\'s index.html fallback. The API URL is probably wrong, or the dev proxy isn\'t set up.');
  }
  const dur = n.end && n.start ? n.end - n.start : null;
  if (dur != null && dur > 1000) add('warn', 'Slow', `Took ${fmtMs(dur)}.`);
  if ((n.size ?? 0) > 1024 * 1024) add('warn', 'Large', `${fmtSize(n.size)}. Consider pagination or smaller responses.`);
  if (dupCount > 1) add('warn', `Duplicate ×${dupCount}`, 'The same request was made several times within 1 second. Check for a double subscribe (async pipe and subscribe on the same observable) or a missing shareReplay.');
  return out;
}

// The bucket a row belongs to in the status-code breakdown.
function codeKey(n: NetEntry): string | null {
  if (n.statusText === 'aborted') return 'aborted';
  if (n.status === 0) return 'failed';
  return n.status == null ? null : String(n.status);
}
const codeTone = (k: string): string => (k === 'failed' || k.startsWith('5') ? 'bad' : k.startsWith('4') ? 'warn' : k.startsWith('3') || k === 'aborted' ? 'info' : 'ok');
const codeOrder = (k: string): number => (/^\d/.test(k) ? Number(k) : k === 'failed' ? 900 : 901);
const codeLabel = (k: string): string => (k === 'failed' ? 'ERR' : k === 'aborted' ? '×' : k);

// ───────────── where in your code each call was made ─────────────
interface CallSite { at: AppFrame | null; from: AppFrame | null }
const siteCache = new Map<string, Promise<CallSite>>();

// The first frame of your code (usually a service), and the next file up
// (usually the component that called the service).
function callSite(n: NetEntry): Promise<CallSite> {
  const hit = siteCache.get(n.initiator);
  if (hit) return hit;
  const p = mapStack(n.initiator, 400).then((frames): CallSite => {
    const app = frames.filter(isAppFrame);
    const at = app[0] ?? null;
    const from = app.find((f) => f.orig.file !== at?.orig.file) ?? null;
    return { at, from };
  }).catch((): CallSite => ({ at: null, from: null }));
  siteCache.set(n.initiator, p);
  return p;
}
const base = (file: string): string => file.split('/').pop() ?? file;

function siteHtml(site: CallSite): string {
  if (!site.at) return '<span class="site none">Started by Angular (no line of your code on the stack)</span>';
  const { at, from } = site;
  return `<span class="site">${fileLink(at.orig.file, at.orig.line, at.orig.col, `${base(at.orig.file)}:${at.orig.line}`)}${from ? ` <span class="dim">from</span> ${fileLink(from.orig.file, from.orig.line, from.orig.col, `${base(from.orig.file)}:${from.orig.line}`)}` : ''}</span>`;
}

// ───────────── state ─────────────
const rows = new Map<string, HTMLTableRowElement>();
let selectedId: string | null = null;
type SortKey = 'name' | 'status' | 'size' | 'time';
let sortKey: SortKey | null = null; // null → newest first
let sortDir: 'ascending' | 'descending' = 'descending';
let dupCounts = new Map<string, number>();
const codeFilter = new Set<string>();

const nameOf = (url: string): string => {
  const u = urlOf(url);
  if (!u) return url;
  const lastSeg = u.pathname.split('/').filter(Boolean).pop() ?? u.host;
  return lastSeg + (u.search ? u.search.slice(0, 30) : '');
};
const pathOf = (url: string): string => { const u = urlOf(url); return u ? u.host + u.pathname : url; };

// ───────────── list ─────────────
function rowHtml(n: NetEntry): string {
  const sc = statusClass(n);
  const tag = problems(n, dupCounts.get(n.id)).find((p) => p.level !== 'info');
  const dur = n.end ? n.end - n.start : null;
  const status = n.status == null ? '…' : n.status || (sc === 'aborted' ? '×' : 'ERR');
  return `
    <td class="c-name">
      <button type="button" class="row-open" title="${esc(n.url)}"><span class="nm"><b class="meth m-${esc(n.method.toLowerCase())}">${esc(n.method)}</b> ${esc(nameOf(n.url))}</span><span class="host">${esc(pathOf(n.url))}</span></button>
      ${tag ? `<span class="tag ${tag.level}">${esc(tag.label)}</span>` : ''}
      <div class="site-line"><span class="site loading">Finding the call site…</span></div>
    </td>
    <td class="c-status"><span class="st ${sc}">${status}</span></td>
    <td class="c-time">${fmtMs(dur)}</td>
    <td class="c-size">${fmtSize(n.size)}</td>`;
}

function ensureRow(n: NetEntry): void {
  let tr = rows.get(n.id);
  if (!tr) {
    tr = document.createElement('tr');
    tr.dataset.id = n.id;
    rows.set(n.id, tr);
    $('#net-rows').append(tr);
  }
  tr.className = `net-row st-${statusClass(n)}${problems(n, dupCounts.get(n.id)).some((p) => p.level === 'error') ? ' problem' : ''}`;
  tr.innerHTML = rowHtml(n);
  const row = tr;
  void callSite(n).then((site) => {
    const line = row.querySelector('.site-line');
    if (line && row.dataset.id === n.id) line.innerHTML = siteHtml(site);
  });
}

export function upsert(n: NetEntry): void {
  if (rows.has(n.id)) {
    ensureRow(n);
    if (selectedId === n.id) void renderDetail(n.id, true);
  }
  scheduleRefresh(); // decides which calls are listed (see syncRows)
}

// Decide which calls are backend calls. The answer can change as more calls
// arrive (the busiest host becomes clear), so every refresh checks them all.
function syncRows(): void {
  computeBackendHosts();
  for (const n of S.net.values()) {
    const show = isBackendCall(n);
    const row = rows.get(n.id);
    if (show && !row) ensureRow(n);
    else if (!show && row) { row.remove(); rows.delete(n.id); if (selectedId === n.id) closeDetail(); }
  }
}

export function clear(): void {
  S.net.clear();
  dupCounts.clear();
  for (const tr of rows.values()) tr.remove();
  rows.clear();
  if (selectedId) closeDetail();
  scheduleRefresh();
}

const apiCalls = (): NetEntry[] => [...S.net.values()].filter((n) => rows.has(n.id));

// Duplicate detection: same method+URL started within 1 s of another.
function computeDups(): void {
  const groups = new Map<string, NetEntry[]>();
  for (const n of apiCalls()) {
    const k = `${n.method} ${n.url}`;
    const g = groups.get(k) ?? [];
    g.push(n);
    groups.set(k, g);
  }
  const next = new Map<string, number>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.start - b.start);
    const burst = g.filter((n, i) => {
      const prev = g[i - 1], after = g[i + 1];
      return (!!prev && n.start - prev.start < 1000) || (!!after && after.start - n.start < 1000);
    });
    for (const n of burst) next.set(n.id, burst.length);
  }
  const changed = [...new Set([...next.keys(), ...dupCounts.keys()])].filter((id) => next.get(id) !== dupCounts.get(id));
  dupCounts = next;
  for (const id of changed) { const n = S.net.get(id); if (n) ensureRow(n); }
}

const isProblem = (n: NetEntry): boolean =>
  ['4xx', '5xx', 'failed'].includes(statusClass(n)) || problems(n, dupCounts.get(n.id)).some((p) => p.level !== 'info');

function matches(n: NetEntry): boolean {
  const k = codeKey(n);
  if (codeFilter.size && (!k || !codeFilter.has(k))) return false;
  if (input('#net-problems').checked && !isProblem(n)) return false;
  const q = input('#net-q').value.trim().toLowerCase();
  if (q) {
    const site = rows.get(n.id)?.querySelector('.site-line')?.textContent ?? '';
    if (!`${n.method} ${n.url} ${n.status ?? ''} ${site}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

const sortVal: Record<SortKey, (n: NetEntry) => string | number> = {
  name: (n) => nameOf(n.url).toLowerCase(),
  status: (n) => n.status ?? -1,
  size: (n) => n.size ?? 0,
  time: (n) => (n.end ? n.end - n.start : Infinity),
};

let raf = 0;
export function scheduleRefresh(): void {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(refresh);
}

function refresh(): void {
  syncRows();
  computeDups();
  const all = apiCalls();
  const visible = all.filter(matches);
  const visibleIds = new Set(visible.map((n) => n.id));

  // Order: move existing rows (never rebuild the tbody).
  const key = sortKey ? sortVal[sortKey] : null;
  visible.sort((a, b) => {
    if (!key) return b.start - a.start;
    const x = key(a), y = key(b);
    const r = x < y ? -1 : x > y ? 1 : 0;
    return sortDir === 'ascending' ? r : -r;
  });
  const tbody = $('#net-rows');
  for (const [id, tr] of rows) tr.hidden = !visibleIds.has(id);
  let prev: HTMLTableRowElement | null = null;
  for (const n of visible) {
    const tr = rows.get(n.id);
    if (!tr) continue;
    const want: Element | null = prev ? prev.nextElementSibling : tbody.firstElementChild;
    if (want !== tr) { if (prev) prev.after(tr); else tbody.prepend(tr); }
    prev = tr;
  }

  renderCodes(all);

  // Summary + status bar.
  const counts = new Map<StatusClass, number>(STATUS_CLASSES.map((c) => [c, 0]));
  for (const n of all) { const c = statusClass(n); counts.set(c, (counts.get(c) ?? 0) + 1); }
  const sum = STATUS_CLASSES.reduce((a, c) => a + (counts.get(c) ?? 0), 0) || 1;
  $('#net-bar').innerHTML = STATUS_CLASSES.filter((c) => counts.get(c)).map((c) => `<span class="bar-seg ${c}" style="flex:${(counts.get(c) ?? 0) / sum}" title="${c}: ${counts.get(c) ?? 0}"></span>`).join('');
  const hosts = [...new Set(all.map((n) => urlOf(n.url)?.host ?? ''))].filter(Boolean);
  const failed = all.filter((n) => ['4xx', '5xx', 'failed'].includes(statusClass(n))).length;
  $('#net-summary').innerHTML = all.length
    ? `${visible.length === all.length ? '' : `Showing ${visible.length} of ${all.length}. `}${all.length} API call${all.length === 1 ? '' : 's'} to <b>${esc(hosts.slice(0, 2).join(', '))}${hosts.length > 2 ? '…' : ''}</b>${failed ? `, <span class="bad">${failed} failed</span>` : ''}`
    : '';
  $('#net-empty').hidden = all.length > 0;
  $('#net-nomatch').hidden = !(all.length && !visible.length);
  emit('counts');
}

// Status-code breakdown: one bar per code the page got, with what it means.
// Clicking a row filters the list.
function renderCodes(all: NetEntry[]): void {
  const counts = new Map<string, number>();
  for (const n of all) {
    const k = codeKey(n);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const k of codeFilter) if (!counts.has(k)) counts.set(k, 0);
  const keys = [...counts.keys()].sort((a, b) => codeOrder(a) - codeOrder(b));
  const max = Math.max(1, ...counts.values());
  const box = $('#net-codes');
  box.hidden = !keys.length;
  $('.codes-list', box).innerHTML = keys.map((k) => `
    <button type="button" class="code-row t-${codeTone(k)}" data-code="${esc(k)}" aria-pressed="${codeFilter.has(k)}">
      <span class="code-pill">${esc(codeLabel(k))}</span>
      <span class="code-mean">${esc(shortMeaning(k))}</span>
      <span class="code-bar"><span style="inline-size:${((counts.get(k) ?? 0) / max) * 100}%"></span></span>
      <span class="code-n">${counts.get(k) ?? 0}</span>
    </button>`).join('');
  $('.codes-reset', box).hidden = !codeFilter.size;
}

// ───────────── detail (drill-down over the list) ─────────────
type DetailTab = 'headers' | 'payload' | 'response' | 'preview' | 'timing' | 'initiator';
let detailTab: DetailTab = 'headers';

function prettyBody(b: Body | null | undefined, headers: Header[] | undefined): string {
  if (!b) return '<p class="note">No body.</p>';
  if (!b.text) return `<p class="note">${esc(b.note ?? 'Empty body.')}</p>`;
  let text = b.text;
  if (/json/.test(headerVal(headers, 'content-type')) || /^\s*[[{]/.test(text)) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
  }
  return `<pre class="body-pre">${esc(text)}</pre>${b.truncated ? '<p class="note">Truncated at 200 KB.</p>' : ''}`;
}

const headerList = (list: Header[] | undefined): string => (list?.length
  ? `<dl class="kv">${list.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
  : '<p class="note">None captured.</p>');

function parsedJson(n: NetEntry): { value: unknown } | null {
  const t = n.resBody?.text;
  if (!t || !/^\s*[[{]/.test(t)) return null;
  try { return { value: JSON.parse(t) as unknown }; } catch { return null; }
}

// The error message the backend put in its body, if any.
function serverMessage(n: NetEntry): string {
  if (!(n.status != null && n.status >= 400)) return '';
  const j = parsedJson(n)?.value;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    const o = j as Record<string, unknown>;
    const err = o.error;
    const nested = err && typeof err === 'object' ? (err as Record<string, unknown>).message : undefined;
    const pick = o.message ?? nested ?? err ?? o.detail ?? o.title ?? o.msg ?? o.errors;
    if (pick != null) return typeof pick === 'string' ? pick : JSON.stringify(pick).slice(0, 300);
  }
  const t = n.resBody?.text?.trim();
  if (!t) return '';
  if (t.startsWith('<')) { // HTML error page: Express puts the message in <pre>, others in <title> or <h1>
    const m = /<pre[^>]*>([\s\S]{1,300}?)<\/pre>/i.exec(t) ?? /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(t) ?? /<title>([\s\S]{1,200}?)<\/title>/i.exec(t);
    return m?.[1] ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
  }
  return t.length < 200 ? t : '';
}

// What the code means, what the backend said, and where to look.
async function meaningHtml(n: NetEntry): Promise<string> {
  const m = meaning(n.status, n.statusText);
  if (!m) return '';
  const probs = problems(n, dupCounts.get(n.id));
  const sc = statusClass(n);
  const tone = sc === '4xx' ? 'warn' : sc === '5xx' || sc === 'failed' ? 'error' : sc === '2xx' && !probs.some((p) => p.level === 'error') ? 'ok' : 'info';
  // The first finding comes from the status code. Keep it only when it adds
  // something the table can't know (headers sent, method, retry-after).
  const s = n.status ?? -1;
  const specific = s === 401 || s === 0 || s === 405 || s === 429 || sc === 'aborted';
  const fromStatus = (s >= 400 || s === 0 || sc === 'aborted') && probs.length ? probs[0] : null;
  const front = probs.filter((p) => (p !== fromStatus || specific) && (p.level !== 'info' || sc === 'aborted'));
  const msg = serverMessage(n);

  const site = await callSite(n);
  const ah = authHeader(n);
  const sent = ah ? `Sent with ${ah} header` : 'Sent without auth header';
  const resp = n.status == null ? 'Waiting…' : n.status === 0 ? 'No response' : `${n.status} ${m.title}`;

  // JS errors in the 3 s before this request started (listed in the Console tab).
  const before = [...S.errors.values()].filter((e) => e.kind !== 'http' && e.kind !== 'warn' && e.first <= n.start && n.start - e.first < 3000);
  const isOk = tone === 'ok';
  const frontBox = front.length || (!isOk && m.front)
    ? `<div class="box"><h3>Check in the front end</h3>${front.map((p) => `<p><strong>${esc(p.label)}.</strong> ${esc(p.hint)}</p>`).join('')}${!isOk && m.front && !(specific && fromStatus) ? `<p>${esc(m.front)}</p>` : ''}</div>`
    : '';
  return `
    <ol class="facts-strip" aria-label="What happened">
      <li>${site.at ? esc(`${base(site.at.orig.file)}:${site.at.orig.line}`) : 'Started by Angular'}</li>
      <li class="${!ah && n.status === 401 ? 'f-warn' : ''}">${esc(sent)}</li>
      <li class="f-${tone}">${esc(resp)}</li>
    </ol>
    <div class="meaning ${tone}">
      <p class="m-title"><span class="st pill ${sc}">${n.status ?? '…'}</span> ${esc(m.title)}</p>
      <h3>What the backend is saying</h3>
      <p>${esc(m.backend)}</p>
      ${msg ? `<p class="server-msg"><span>Server message</span> <code>${esc(msg)}</code></p>` : ''}
    </div>
    ${frontBox}
    ${!isOk && m.back ? `<div class="box"><h3>Check in the backend</h3><p>${esc(m.back)}</p></div>` : ''}
    ${before.length ? `<div class="box related"><h3>JS errors just before this request</h3>${before.map((e) => `<button type="button" class="link" data-err-key="${esc(e.key)}">${esc(e.message.slice(0, 90))}</button> <span class="note">${fmtMs(n.start - e.first)} earlier</span>`).join('<br>')}</div>` : ''}`;
}

function tabsFor(n: NetEntry): [DetailTab, string][] {
  const tabs: [DetailTab, string][] = [['initiator', 'Code'], ['headers', 'Headers']];
  if (n.reqBody) tabs.push(['payload', 'Payload']);
  tabs.push(['response', 'Response']);
  if (parsedJson(n)) tabs.push(['preview', 'Preview']);
  tabs.push(['timing', 'Timing']);
  return tabs;
}

async function tabBody(n: NetEntry, tab: DetailTab): Promise<string> {
  const dur = n.end ? n.end - n.start : null;
  switch (tab) {
    case 'headers':
      return `
        <dl class="kv">
          <dt>URL</dt><dd>${esc(n.url)}</dd>
          <dt>Method</dt><dd>${esc(n.method)}</dd>
          <dt>Status</dt><dd><span class="st ${statusClass(n)}">${n.status ?? '–'}</span> ${esc(n.statusText ?? '')}${n.error ? ` ${esc(n.error)}` : ''}</dd>
          <dt>Sent with</dt><dd>${n.kind === 'xhr' ? 'XMLHttpRequest (HttpClient)' : 'fetch'}</dd>
        </dl>
        <h4>Response headers</h4>${headerList(n.resHeaders)}<h4>Request headers</h4>${headerList(n.reqHeaders)}`;
    case 'payload':
      return prettyBody(n.reqBody, n.reqHeaders);
    case 'response':
      return n.status == null ? '<p class="note">Waiting for the response…</p>' : `
        <input type="search" class="find" placeholder="Find in response" aria-label="Find in response">
        ${prettyBody(n.resBody, n.resHeaders)}`;
    case 'preview': {
      const j = parsedJson(n);
      return j ? `<div class="json">${jsonTree(j.value)}</div>` : '';
    }
    case 'timing': {
      const first = Math.min(...apiCalls().map((x) => x.start));
      return `
        <dl class="kv">
          <dt>Started</dt><dd>${fmtMs(n.start - first)} after the first API call</dd>
          <dt>Duration</dt><dd>${fmtMs(dur)}</dd>
          <dt>Size</dt><dd>${fmtSize(n.size)}</dd>
        </dl>`;
    }
    case 'initiator': {
      const frames = (await mapStack(n.initiator, 400)).filter(isAppFrame);
      if (!frames.length) return '<p class="note">No line in your code is on the call stack. The request was started by Angular itself, for example an <code>httpResource</code>, <code>resource</code> or <code>effect</code> reacting to a signal. Look for the signal or input that feeds it.</p>';
      const seen = new Set<string>();
      const picks = frames.filter((f) => !seen.has(f.orig.file) && !!seen.add(f.orig.file)).slice(0, 3);
      const blocks = await Promise.all(picks.map((f, i) => codeBlock(f.orig.file, f.orig.line, { tone: 'focus', label: `${i === 0 ? 'Called in' : 'Triggered by'} ${f.orig.file}:${f.orig.line}` })));
      return blocks.join('');
    }
  }
}

const backBtn = `<button type="button" class="btn icon" data-act="back" aria-label="Back to the list">
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
</button>`;

let renderSeq = 0;
async function renderDetail(id: string, keepTab = false): Promise<void> {
  const seq = ++renderSeq;
  const n = S.net.get(id);
  if (!n) return;
  const tabs = tabsFor(n);
  if (!keepTab || !tabs.some(([k]) => k === detailTab)) detailTab = firstTab(n, tabs);
  const top = await meaningHtml(n);
  const body = await tabBody(n, detailTab);
  if (seq !== renderSeq) return;
  $('#net-detail').innerHTML = `
    <header class="detail-head">${backBtn}
      <h2 class="detail-title" tabindex="-1"><span class="meth">${esc(n.method)}</span> ${esc(nameOf(n.url))}</h2>
      <span class="st pill ${statusClass(n)}">${n.status ?? '…'}</span>
    </header>
    <div class="detail-scroll">
      ${top}
      <div class="subtabs" role="tablist" aria-label="Request details">
        ${tabs.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === detailTab}">${label}</button>`).join('')}
      </div>
      <div class="tab-body" role="tabpanel">${body}</div>
      <div class="actions">
        <button type="button" class="btn small" data-act="to-requests">Open in Requests</button>
        <button type="button" class="btn small" data-copy="curl">Copy as cURL</button>
        <button type="button" class="btn small" data-copy="fetch">Copy as fetch</button>
        <button type="button" class="btn small" data-copy="response">Copy response</button>
        <span role="status" class="saved"></span>
      </div>
    </div>`;
}

// Open the most useful tab first: Response for failures, the code otherwise.
function firstTab(n: NetEntry, tabs: [DetailTab, string][]): DetailTab {
  const has = (k: DetailTab): boolean => tabs.some(([t]) => t === k);
  if (['4xx', '5xx'].includes(statusClass(n)) && has('response')) return 'response';
  return 'initiator';
}

export async function openDetail(id: string): Promise<void> {
  selectedId = id;
  for (const tr of rows.values()) tr.removeAttribute('aria-current');
  rows.get(id)?.setAttribute('aria-current', 'true');
  await renderDetail(id);
  $('#net-list-view').inert = true;
  $('#net-detail').hidden = false;
  $maybe('.detail-title')?.focus({ preventScroll: true });
}

export function closeDetail(): void {
  const id = selectedId;
  selectedId = null;
  $('#net-detail').hidden = true;
  $('#net-list-view').inert = false;
  const tr = id ? rows.get(id) : undefined;
  tr?.querySelector<HTMLElement>('.row-open')?.focus({ preventScroll: false });
}

function step(dir: 1 | -1): void {
  const visible = $$<HTMLTableRowElement>('tr', $('#net-rows')).filter((tr) => !tr.hidden);
  const i = visible.findIndex((tr) => tr.dataset.id === selectedId);
  const next = visible[i + dir]?.dataset.id;
  if (next) void openDetail(next);
}

const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
function asCurl(n: NetEntry): string {
  const parts = [`curl ${shellQuote(n.url)}`];
  if (n.method !== 'GET') parts.push(`-X ${n.method}`);
  for (const [k, v] of n.reqHeaders) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (n.reqBody?.text) parts.push(`--data-raw ${shellQuote(n.reqBody.text)}`);
  return parts.join(' \\\n  ');
}
function asFetch(n: NetEntry): string {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method: n.method, headers: Object.fromEntries(n.reqHeaders) };
  if (n.reqBody?.text) init.body = n.reqBody.text;
  return `await fetch(${JSON.stringify(n.url)}, ${JSON.stringify(init, null, 2)});`;
}

// ───────────── wiring ─────────────
export function init(): void {
  input('#net-q').addEventListener('input', scheduleRefresh);
  input('#net-problems').addEventListener('change', scheduleRefresh);
  $('#net-clear').addEventListener('click', () => { void send({ type: 'clear:net' }).then(clear); });

  $('#net-codes').addEventListener('click', (e) => {
    if (closest(e, '.codes-reset')) { codeFilter.clear(); scheduleRefresh(); return; }
    const k = closest(e, '[data-code]')?.dataset.code;
    if (!k) return;
    if (codeFilter.has(k)) codeFilter.delete(k); else codeFilter.add(k);
    scheduleRefresh();
  });

  // Sortable headers (buttons inside <th>, aria-sort on the active one only).
  $('#net-table thead').addEventListener('click', (e) => {
    const b = closest(e, 'button[data-sort]');
    const th = b?.closest('th');
    const k = b?.dataset.sort;
    if (!b || !th || !(k === 'name' || k === 'status' || k === 'size' || k === 'time')) return;
    if (sortKey === k && sortDir === 'descending') { sortKey = null; th.removeAttribute('aria-sort'); } else {
      sortDir = sortKey === k ? 'descending' : 'ascending';
      sortKey = k;
      for (const x of $$('#net-table th')) x.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', sortDir);
    }
    $('#net-sort-status').textContent = sortKey ? `Sorted by ${b.textContent?.trim() ?? sortKey}, ${sortDir}` : 'Newest first';
    scheduleRefresh();
  });

  $('#net-rows').addEventListener('click', (e) => {
    if (closest(e, '.file-link')) return; // opens the editor instead
    const id = closest<HTMLTableRowElement>(e, 'tr[data-id]')?.dataset.id;
    if (id) void openDetail(id);
  });

  const detail = $('#net-detail');
  detail.addEventListener('click', (e) => {
    if (closest(e, '[data-act="back"]')) { closeDetail(); return; }
    const n = selectedId ? S.net.get(selectedId) : undefined;
    if (!n) return;
    if (closest(e, '[data-act="to-requests"]')) { emit('to-requests', n); emit('goto-tab', 'requests'); return; }
    const errKey = closest(e, '[data-err-key]')?.dataset.errKey;
    if (errKey) { openConsoleError(errKey); return; }
    const tab = closest(e, '[data-tab]');
    const t = tab?.dataset.tab;
    if (tab && (t === 'headers' || t === 'payload' || t === 'response' || t === 'preview' || t === 'timing' || t === 'initiator')) {
      detailTab = t;
      for (const x of $$('[data-tab]', detail)) x.setAttribute('aria-selected', String(x === tab));
      void tabBody(n, t).then((html) => { $('.tab-body', detail).innerHTML = html; });
      return;
    }
    const c = closest(e, '[data-copy]');
    if (c) void copyText(c, c.dataset.copy === 'curl' ? asCurl(n) : c.dataset.copy === 'fetch' ? asFetch(n) : n.resBody?.text ?? '');
  });
  // Find in response: highlight matches.
  detail.addEventListener('input', (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || !box.matches('.find')) return;
    const pre = $maybe('.body-pre', detail);
    if (!pre) return;
    const raw = pre.dataset.raw ?? (pre.dataset.raw = pre.textContent ?? '');
    const q = box.value;
    if (!q) { pre.textContent = raw; return; }
    pre.innerHTML = esc(raw).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
    pre.querySelector('mark')?.scrollIntoView({ block: 'nearest' });
  });
  detail.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const inTabs = !!closest(e, '[role="tablist"]');
    if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
    else if (e.key === 'ArrowDown' && !inTabs) { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp' && !inTabs) { e.preventDefault(); step(-1); }
  });

  // A changed API base URL changes which calls are listed.
  on('settings-changed', scheduleRefresh);
}

let openConsoleError: (key: string) => void = () => {};
export function onOpenError(fn: (key: string) => void): void { openConsoleError = fn; }

// For the health strip.
export const failedCount = (): number => apiCalls().filter((n) => ['4xx', '5xx', 'failed'].includes(statusClass(n))).length;
export const apiCount = (): number => rows.size;
export function showProblems(): void {
  codeFilter.clear();
  input('#net-problems').checked = true;
  scheduleRefresh();
}
