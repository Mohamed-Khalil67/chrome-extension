// Network and errors tab: every request the page makes plus the JS errors, on
// one timeline. A breakdown by status code explains what each code means from
// the backend's side, and works as a filter.
import { S, $, $$, esc, send, emit, on, fmtMs, fmtSize, chipGroup, copyText, jsonTree } from './core.js';
import { mapStack } from './sourcemap.js';
import { codeBlock } from './code.js';
import { meaning, shortMeaning } from './status-codes.js';
import * as errors from './errors.js';

const TYPE_LABEL = { api: 'API', doc: 'Doc', js: 'JS', css: 'CSS', img: 'Img', font: 'Font', media: 'Media', other: 'Other', error: 'Error' };
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'failed'];

// ───────────── classification ─────────────
export function statusClass(n) {
  if (n.statusText === 'aborted') return 'aborted';
  if (n.status == null) return n.end ? 'unknown' : 'pending';
  if (n.status === 0) return 'failed';
  if (n.status >= 500) return '5xx';
  if (n.status >= 400) return '4xx';
  if (n.status >= 300) return '3xx';
  return '2xx';
}

const hasHeader = (list, name) => (list || []).some(([k]) => k.toLowerCase() === name);
const headerVal = (list, name) => (list || []).find(([k]) => k.toLowerCase() === name)?.[1] || '';
const AUTH_HEADERS = ['authorization', 'token', 'x-auth-token', 'x-access-token', 'x-api-key'];
const authHeader = (n) => (n.reqHeaders || []).find(([k]) => AUTH_HEADERS.includes(k.toLowerCase()))?.[0];

// Front-end-specific findings from what was actually captured.
// Returns [{level: 'error'|'warn'|'info', label, hint}]
export function problems(n, dupCount = 0) {
  const out = [];
  const add = (level, label, hint) => out.push({ level, label, hint });
  const s = n.status;
  if (n.statusText === 'aborted') add('info', 'Cancelled', 'The request was aborted before it finished. Often switchMap cancelling an older request, or a component destroyed mid-request. Usually harmless.');
  else if (s === 0) add('error', 'Blocked or offline', 'No response reached the page: CORS, DNS, a refused connection, or an ad blocker. A CORS problem shows its own message in the browser console.');
  else if (s === 401) {
    const h = authHeader(n);
    add('error', 'Not authenticated', h ? `The ${h} header was sent but rejected: the token is probably expired or invalid.` : 'No auth header (Authorization or token) was sent with this request. Check that your HTTP interceptor adds it for this URL, and that the user is logged in.');
  }
  else if (s === 403) add('error', 'Forbidden', 'The server knows who you are but refuses this action.');
  else if (s === 404) add('error', 'Not found', 'Compare the URL with the API docs and your environment base URL.');
  else if (s === 405) add('error', 'Method not allowed', `The endpoint exists but doesn't accept ${n.method}.`);
  else if (s === 400 || s === 422) add('error', 'Rejected input', 'The server didn\'t accept the request data. The Response tab usually says which field.');
  else if (s === 408 || s === 504) add('error', 'Timed out', 'The server or a gateway gave up waiting.');
  else if (s === 429) add('warn', 'Rate limited', `Too many requests. ${headerVal(n.resHeaders, 'retry-after') ? `Retry after ${headerVal(n.resHeaders, 'retry-after')} s.` : ''}`);
  else if (s >= 500) add('error', 'Server error', 'The request may be fine: check the server logs and the Response tab.');
  else if (s >= 400) add('error', `Client error ${s}`, 'The server rejected the request.');

  const body = n.resBody?.text || '';
  const ct = headerVal(n.resHeaders, 'content-type') || n.contentType || '';
  if (n.type === 'api' && s >= 200 && s < 300 && (/html/.test(ct) || /^\s*<(!doctype|html)/i.test(body))) {
    add('error', 'HTML instead of JSON', 'The API returned an HTML page, usually the dev server\'s index.html fallback. The API URL is probably wrong, or the dev proxy isn\'t set up.');
  }
  const dur = n.end && n.start ? n.end - n.start : null;
  if (dur != null && dur > 1000) add('warn', 'Slow', `Took ${fmtMs(dur)}.`);
  if ((n.size || 0) > 1024 * 1024) add('warn', 'Large', `${fmtSize(n.size)}. Consider pagination, compression or smaller images.`);
  if (dupCount > 1) add('warn', `Duplicate ×${dupCount}`, 'The same request was made several times within 1 second. Check for a double subscribe (async pipe and subscribe on the same observable) or a missing shareReplay.');
  return out;
}

// The bucket a row belongs to in the status-code breakdown.
function codeKey(item) {
  if (item.err) return errors.groupOf(item.err);
  const n = item.n;
  if (n.statusText === 'aborted') return 'aborted';
  if (n.status === 0) return 'failed';
  if (n.status == null) return null;
  return String(n.status);
}
const codeTone = (k) => (k === 'js' || k === 'ng' || k === 'failed' || k[0] === '5' ? 'bad' : k[0] === '4' || k === 'warn' ? 'warn' : k[0] === '3' || k === 'aborted' ? 'info' : 'ok');
const codeOrder = (k) => (/^\d/.test(k) ? Number(k) : { failed: 900, aborted: 901, js: 950, ng: 951, warn: 952 }[k] ?? 999);
const codeLabel = (k) => ({ failed: 'ERR', aborted: '×', js: 'JS', ng: 'NG', warn: 'Warn' }[k] || k);

// ───────────── state ─────────────
const rows = new Map(); // id → <tr>   (requests: n.id, errors: "e:" + key)
let selectedId = null;
let sortKey = null; // null → newest first
let sortDir = 'descending';
let dupCounts = new Map(); // id → count
let getType = () => ['all'];
const codeFilter = new Set();

const errId = (key) => `e:${key}`;
const itemOf = (id) => (id?.startsWith('e:') ? { err: S.errors.get(id.slice(2)) } : { n: S.net.get(id) });
const startOf = (item) => (item.err ? item.err.first : item.n.start);

const nameOf = (url) => {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.host;
    return last + (u.search ? u.search.slice(0, 30) : '');
  } catch { return url; }
};
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

// ───────────── list ─────────────
function rowHtml(n) {
  const sc = statusClass(n);
  const probs = problems(n, dupCounts.get(n.id));
  const tag = probs.find((p) => p.level !== 'info');
  const dur = n.end ? n.end - n.start : null;
  return `
    <td class="c-name"><button type="button" class="row-open" title="${esc(n.url)}"><span class="nm">${n.type === 'api' && n.method !== 'GET' ? `<b class="meth">${esc(n.method)}</b> ` : ''}${esc(nameOf(n.url))}</span><span class="host">${esc(hostOf(n.url))}</span></button>${tag ? `<span class="tag ${tag.level}">${esc(tag.label)}</span>` : ''}</td>
    <td class="c-status"><span class="st ${sc}">${n.status == null ? (sc === 'pending' ? '…' : '–') : n.status || (sc === 'aborted' ? '×' : 'ERR')}</span></td>
    <td class="c-type">${TYPE_LABEL[n.type] || 'Other'}</td>
    <td class="c-size">${n.cached ? '<span class="v-null">cache</span>' : fmtSize(n.size)}</td>
    <td class="c-time">${fmtMs(dur)}</td>
    <td class="c-wf"><span class="wf"><span class="wf-bar ${sc}"></span></span></td>`;
}

function errRowHtml(e) {
  const g = errors.groupOf(e);
  const loc = errors.appFrame(e);
  return `
    <td class="c-name"><button type="button" class="row-open" title="${esc(e.message)}"><span class="nm err-nm">${esc(e.message)}</span><span class="host">${loc ? `${esc(loc.orig.file)}:${loc.orig.line}` : esc(errors.kindLabel(e.kind))}</span></button></td>
    <td class="c-status"><span class="st e-${g}">${codeLabel(g)}</span></td>
    <td class="c-type">Error</td>
    <td class="c-size"></td>
    <td class="c-time">${e.count > 1 ? `<span class="times">×${e.count}</span>` : ''}</td>
    <td class="c-wf"><span class="wf"><span class="wf-mark e-${g}"></span></span></td>`;
}

function ensureRow(n) {
  let tr = rows.get(n.id);
  if (!tr) {
    tr = document.createElement('tr');
    tr.dataset.id = n.id;
    rows.set(n.id, tr);
    $('#net-rows').append(tr);
  }
  tr.className = `net-row st-${statusClass(n)}${problems(n, dupCounts.get(n.id)).some((p) => p.level === 'error') ? ' problem' : ''}`;
  tr.innerHTML = rowHtml(n);
  return tr;
}

function ensureErrRow(e) {
  const id = errId(e.key);
  let tr = rows.get(id);
  if (!tr) {
    tr = document.createElement('tr');
    tr.dataset.id = id;
    rows.set(id, tr);
    $('#net-rows').append(tr);
  }
  tr.className = `net-row err-row g-${errors.groupOf(e)}`;
  tr.innerHTML = errRowHtml(e);
  return tr;
}

export function upsert(n) {
  ensureRow(n);
  if (selectedId === n.id) renderDetail(n.id, true);
  scheduleRefresh();
}

export function addResources(list) {
  for (const r of list) { S.net.set(r.id, r); ensureRow(r); }
  scheduleRefresh();
}

export function clear() {
  S.net.clear(); dupCounts.clear();
  for (const [id, tr] of rows) if (!id.startsWith('e:')) { tr.remove(); rows.delete(id); }
  if (selectedId && !selectedId.startsWith('e:')) closeDetail();
  scheduleRefresh();
}

function clearErrors() {
  for (const [id, tr] of rows) if (id.startsWith('e:')) { tr.remove(); rows.delete(id); }
  if (selectedId?.startsWith('e:')) closeDetail();
  scheduleRefresh();
}

on('error', (e) => {
  if (!errors.listed(e)) return;
  ensureErrRow(e);
  if (selectedId === errId(e.key)) renderDetail(selectedId, true);
  scheduleRefresh();
});
on('errors-cleared', clearErrors);

// Duplicate detection: same method+URL started within 1 s of another.
function computeDups() {
  const groups = new Map();
  for (const n of S.net.values()) {
    if (n.type !== 'api') continue;
    const k = `${n.method} ${n.url}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(n);
  }
  const next = new Map();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.start - b.start);
    const burst = list.filter((n, i) => (i > 0 && n.start - list[i - 1].start < 1000) || (i < list.length - 1 && list[i + 1].start - n.start < 1000));
    for (const n of burst) next.set(n.id, burst.length);
  }
  const changed = [...new Set([...next.keys(), ...dupCounts.keys()])].filter((id) => next.get(id) !== dupCounts.get(id));
  dupCounts = next;
  for (const id of changed) { const n = S.net.get(id); if (n) ensureRow(n); }
}

const typeOf = (item) => (item.err ? 'error' : item.n.type);
const typeOk = (item, types = getType()) => types.includes('all') || types.includes(typeOf(item));

function isProblem(item) {
  if (item.err) return item.err.kind !== 'warn';
  const n = item.n;
  return ['4xx', '5xx', 'failed'].includes(statusClass(n)) || problems(n, dupCounts.get(n.id)).some((p) => p.level !== 'info');
}

function matches(item) {
  if (!typeOk(item)) return false;
  if (codeFilter.size && !codeFilter.has(codeKey(item))) return false;
  if ($('#net-problems').checked && !isProblem(item)) return false;
  const q = $('#net-q').value.trim().toLowerCase();
  if (q) {
    const hay = item.err ? `${item.err.message} ${errors.appFrame(item.err)?.orig.file || ''}` : `${item.n.method} ${item.n.url} ${item.n.status ?? ''}`;
    if (!hay.toLowerCase().includes(q)) return false;
  }
  return true;
}

const sortVal = {
  name: (i) => (i.err ? i.err.message : nameOf(i.n.url)).toLowerCase(),
  status: (i) => (i.err ? 1000 : i.n.status ?? -1),
  type: (i) => typeOf(i),
  size: (i) => (i.err ? -1 : i.n.size || 0),
  time: (i) => (i.err ? -1 : i.n.end ? i.n.end - i.n.start : Infinity),
};

function allItems() {
  const out = [];
  for (const n of S.net.values()) out.push({ id: n.id, n });
  for (const e of S.errors.values()) if (errors.listed(e)) out.push({ id: errId(e.key), err: e });
  return out;
}

let raf = 0;
export function scheduleRefresh() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(refresh);
}

function refresh() {
  computeDups();
  const all = allItems();
  const visible = all.filter(matches);
  const visibleIds = new Set(visible.map((i) => i.id));

  // Order: move existing rows (never rebuild the tbody).
  const key = sortVal[sortKey];
  visible.sort((a, b) => {
    if (!key) return startOf(b) - startOf(a);
    const x = key(a), y = key(b);
    const r = x < y ? -1 : x > y ? 1 : 0;
    return sortDir === 'ascending' ? r : -r;
  });
  const tbody = $('#net-rows');
  for (const [id, tr] of rows) tr.hidden = !visibleIds.has(id);
  let prev = null;
  for (const i of visible) {
    const tr = rows.get(i.id);
    if (!tr) continue;
    const want = prev ? prev.nextElementSibling : tbody.firstElementChild;
    if (want !== tr) (prev ? prev.after(tr) : tbody.prepend(tr));
    prev = tr;
  }

  // Timeline: requests as bars, errors as markers, on one axis.
  const reqs = visible.filter((i) => i.n);
  const t0 = Math.min(...visible.map(startOf));
  const t1 = Math.max(...visible.map((i) => (i.n ? i.n.end || i.n.start : i.err.first)));
  const span = Math.max(1, t1 - t0);
  for (const i of visible) {
    const tr = rows.get(i.id);
    if (!tr) continue;
    if (i.n) {
      const bar = tr.querySelector('.wf-bar');
      bar.style.left = `${((i.n.start - t0) / span) * 100}%`;
      bar.style.width = `${Math.max(1.5, (((i.n.end || i.n.start) - i.n.start) / span) * 100)}%`;
    } else {
      tr.querySelector('.wf-mark').style.left = `${((i.err.first - t0) / span) * 100}%`;
    }
  }

  renderCodes(all);

  // Summary + status bar (follow the type filter, like DevTools).
  const ofType = all.filter((i) => i.n && typeOk(i));
  const counts = Object.fromEntries(STATUS_CLASSES.map((c) => [c, 0]));
  for (const i of ofType) { const c = statusClass(i.n); if (c in counts) counts[c]++; }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  $('#net-bar').innerHTML = STATUS_CLASSES.filter((c) => counts[c]).map((c) => `<span class="bar-seg ${c}" style="flex:${counts[c] / total}" title="${c}: ${counts[c]}"></span>`).join('');
  const nReq = all.filter((i) => i.n).length;
  const nErr = all.filter((i) => i.err && i.err.kind !== 'warn').reduce((a, i) => a + i.err.count, 0);
  const bytes = reqs.reduce((a, i) => a + (i.n.size || 0), 0);
  $('#net-summary').textContent = all.length
    ? `${visible.length === all.length ? '' : `Showing ${visible.length} of ${all.length}. `}${nReq} request${nReq === 1 ? '' : 's'}${reqs.length ? `, ${fmtSize(bytes)}, ${fmtMs(span)}` : ''}${nErr ? `. ${nErr} JS error${nErr === 1 ? '' : 's'}` : ''}`
    : '';
  for (const b of $$('#net-types button')) {
    const t = b.dataset.value;
    b.querySelector('.n').textContent = t === 'all' ? '' : all.filter((i) => typeOf(i) === t).length || '';
  }
  $('#net-empty').hidden = all.length > 0;
  $('#net-nomatch').hidden = !(all.length && !visible.length);
  emit('counts');
}

// Status-code breakdown: one bar per code the page actually got, with what it
// means. Counts follow the type filter. Clicking a row filters the list.
function renderCodes(all) {
  const counts = new Map();
  for (const i of all) {
    if (!typeOk(i)) continue;
    const k = codeKey(i);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + (i.err ? i.err.count : 1));
  }
  for (const k of codeFilter) if (!counts.has(k)) counts.set(k, 0);
  const keys = [...counts.keys()].sort((a, b) => codeOrder(a) - codeOrder(b));
  const max = Math.max(1, ...counts.values());
  const box = $('#net-codes');
  box.hidden = !keys.length;
  box.querySelector('.codes-list').innerHTML = keys.map((k) => `
    <button type="button" class="code-row t-${codeTone(k)}" data-code="${esc(k)}" aria-pressed="${codeFilter.has(k)}">
      <span class="code-pill">${esc(codeLabel(k))}</span>
      <span class="code-mean">${esc(shortMeaning(k))}</span>
      <span class="code-bar"><span style="inline-size:${(counts.get(k) / max) * 100}%"></span></span>
      <span class="code-n">${counts.get(k)}</span>
    </button>`).join('');
  box.querySelector('.codes-reset').hidden = !codeFilter.size;
}

// ───────────── detail (drill-down over the list) ─────────────
let detailTab = 'headers';

function prettyBody(b, headers) {
  if (!b) return '<p class="note">No body.</p>';
  if (!b.text) return `<p class="note">${esc(b.note || 'Empty body.')}</p>`;
  let text = b.text;
  const ct = headerVal(headers, 'content-type');
  if (/json/.test(ct) || /^\s*[[{]/.test(text)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ } }
  return `<pre class="body-pre">${esc(text)}</pre>${b.truncated ? '<p class="note">Truncated at 200 KB.</p>' : ''}`;
}

const headerList = (list) => (list?.length
  ? `<dl class="kv">${list.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
  : '<p class="note">None captured.</p>');

function parsedJson(n) {
  const t = n.resBody?.text;
  if (!t || !/^\s*[[{]/.test(t)) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

// The error message the backend put in its JSON body, if any.
function serverMessage(n) {
  if (!(n.status >= 400)) return '';
  const j = parsedJson(n);
  if (j && typeof j === 'object') {
    const pick = j.message ?? j.error?.message ?? j.error ?? j.detail ?? j.title ?? j.msg ?? j.errors;
    if (pick != null) return typeof pick === 'string' ? pick : JSON.stringify(pick).slice(0, 300);
  }
  const t = n.resBody?.text?.trim();
  if (!t) return '';
  if (/^</.test(t)) { // HTML error page: Express puts the message in <pre>, others in <title> or <h1>
    const m = t.match(/<pre[^>]*>([\s\S]{1,300}?)<\/pre>/i) || t.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i) || t.match(/<title>([\s\S]{1,200}?)<\/title>/i);
    return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
  }
  return t.length < 200 ? t : '';
}

// What the code means, what the backend said, and where to look. Built from the
// status table plus what was captured (headers, body, call site).
async function meaningHtml(n) {
  const m = meaning(n.status, n.statusText);
  const probs = problems(n, dupCounts.get(n.id));
  const sc = statusClass(n);
  if (!m) return '';
  const tone = ['4xx'].includes(sc) ? 'warn' : ['5xx', 'failed'].includes(sc) ? 'error' : sc === '2xx' && !probs.some((p) => p.level === 'error') ? 'ok' : 'info';
  // The first finding comes from the status code. Keep it only when it adds
  // something the table can't know (headers sent, method, retry-after);
  // otherwise the table's front-end advice says it better.
  const specific = n.status === 401 || n.status === 0 || n.status === 405 || n.status === 429 || sc === 'aborted';
  const fromStatus = (n.status >= 400 || n.status === 0 || sc === 'aborted') && probs.length ? probs[0] : null;
  const front = probs.filter((p) => (p !== fromStatus || specific) && (p.level !== 'info' || sc === 'aborted'));
  const msg = serverMessage(n);

  // Fact strip: only steps that were actually captured.
  let from = 'Started by the framework';
  if (n.initiator) {
    const f = (await mapStack(n.initiator)).find((x) => !x.lib && x.orig);
    if (f) from = `${f.orig.file.split('/').pop()}:${f.orig.line}`;
  } else if (n.type !== 'api') from = n.initiatorType ? `<${n.initiatorType}>` : 'Browser';
  const ah = authHeader(n);
  const sent = n.type !== 'api' ? 'Request sent' : ah ? `Sent with ${ah} header` : 'Sent without auth header';
  const resp = n.status == null ? 'Waiting…' : n.status === 0 ? 'No response' : `${n.status} ${m.title}`;

  // JS errors in the 3 s before this request started.
  const before = [...S.errors.values()].filter((e) => errors.listed(e) && e.kind !== 'warn' && e.first <= n.start && n.start - e.first < 3000);

  const isOk = tone === 'ok';
  return `
    <ol class="facts-strip" aria-label="What happened">
      <li>${esc(from)}</li>
      <li class="${n.type === 'api' && !ah && n.status === 401 ? 'f-warn' : ''}">${esc(sent)}</li>
      <li class="f-${tone}">${esc(resp)}</li>
    </ol>
    <div class="meaning ${tone}">
      <p class="m-title"><span class="st pill ${sc}">${n.status ?? '…'}</span> ${esc(m.title)}</p>
      <h3>What the backend is saying</h3>
      <p>${esc(m.backend)}</p>
      ${msg ? `<p class="server-msg"><span>Server message</span> <code>${esc(msg)}</code></p>` : ''}
    </div>
    ${!isOk && (front.length || m.front) ? `<div class="box"><h3>Check in the front end</h3>${front.map((p) => `<p><strong>${esc(p.label)}.</strong> ${esc(p.hint)}</p>`).join('')}${m.front && !(specific && fromStatus) ? `<p>${esc(m.front)}</p>` : ''}</div>` : ''}
    ${isOk && front.length ? `<div class="box"><h3>Check in the front end</h3>${front.map((p) => `<p><strong>${esc(p.label)}.</strong> ${esc(p.hint)}</p>`).join('')}</div>` : ''}
    ${!isOk && m.back ? `<div class="box"><h3>Check in the backend</h3><p>${esc(m.back)}</p></div>` : ''}
    ${before.length ? `<div class="box related"><h3>JS errors just before this request</h3>${before.map((e) => `<button type="button" class="link" data-open="${esc(errId(e.key))}">${esc(e.message.slice(0, 90))}</button> <span class="note">${fmtMs(n.start - e.first)} earlier</span>`).join('<br>')}</div>` : ''}`;
}

function tabsFor(n) {
  const tabs = [['headers', 'Headers']];
  if (n.reqBody) tabs.push(['payload', 'Payload']);
  if (n.type === 'api') tabs.push(['response', 'Response']);
  if (parsedJson(n) !== undefined) tabs.push(['preview', 'Preview']);
  tabs.push(['timing', 'Timing']);
  if (n.initiator) tabs.push(['initiator', 'Initiator']);
  return tabs;
}

async function tabBody(n, tab) {
  const dur = n.end ? n.end - n.start : null;
  switch (tab) {
    case 'headers':
      return `
        <dl class="kv">
          <dt>URL</dt><dd>${esc(n.url)}</dd>
          <dt>Method</dt><dd>${esc(n.method)}</dd>
          <dt>Status</dt><dd><span class="st ${statusClass(n)}">${n.status ?? '–'}</span> ${esc(n.statusText || '')}${n.error ? ` ${esc(n.error)}` : ''}</dd>
          <dt>Type</dt><dd>${TYPE_LABEL[n.type] || 'Other'}${n.kind === 'xhr' ? ' (XMLHttpRequest)' : n.kind === 'fetch' ? ' (fetch)' : n.initiatorType ? ` (${esc(n.initiatorType)})` : ''}</dd>
          ${n.contentType ? `<dt>Content type</dt><dd>${esc(n.contentType)}</dd>` : ''}
        </dl>
        ${n.type === 'api'
          ? `<h4>Response headers</h4>${headerList(n.resHeaders)}<h4>Request headers</h4>${headerList(n.reqHeaders)}`
          : '<p class="note">Headers are only captured for API calls (fetch/XHR). For other files the browser only exposes status, size and timing.</p>'}`;
    case 'payload':
      return prettyBody(n.reqBody, n.reqHeaders);
    case 'response':
      return n.status == null ? '<p class="note">Waiting for the response…</p>' : `
        <input type="search" class="find" placeholder="Find in response" aria-label="Find in response">
        ${prettyBody(n.resBody, n.resHeaders)}`;
    case 'preview':
      return `<div class="json">${jsonTree(parsedJson(n))}</div>`;
    case 'timing': {
      const phases = n.phases && Object.entries(n.phases).filter(([, v]) => v != null);
      const max = Math.max(1, ...(phases || []).map(([, v]) => v), dur || 0);
      return `
        <dl class="kv">
          <dt>Started</dt><dd>${fmtMs(n.start - Math.min(...[...S.net.values()].map((x) => x.start)))} after the first request</dd>
          <dt>Duration</dt><dd>${fmtMs(dur)}</dd>
          <dt>Size</dt><dd>${n.cached ? 'from cache' : fmtSize(n.size)}</dd>
        </dl>
        ${phases?.length ? `<div class="phases">${phases.map(([k, v]) => `<div class="ph"><span>${{ dns: 'DNS lookup', connect: 'Connecting', waiting: 'Waiting for server', download: 'Downloading' }[k]}</span><span class="ph-bar"><span style="width:${(v / max) * 100}%"></span></span><span class="mono">${fmtMs(v)}</span></div>`).join('')}</div>` : ''}`;
    }
    case 'initiator': {
      const frames = (await mapStack(n.initiator)).filter((f) => !f.lib && f.orig);
      if (!frames.length) return '<p class="note">No line in your code is on the call stack. The request was started by the framework itself, for example an <code>httpResource</code>, <code>resource</code> or <code>effect</code> reacting to a signal. Look for the signal or input that feeds it.</p>';
      const seen = new Set();
      const picks = frames.filter((f) => !seen.has(f.orig.file) && seen.add(f.orig.file)).slice(0, 3);
      const blocks = await Promise.all(picks.map((f, i) => codeBlock(f.orig.file, f.orig.line, { tone: 'focus', label: `${i === 0 ? 'Called from' : 'Triggered by'} ${f.orig.file}:${f.orig.line}` })));
      return blocks.join('');
    }
  }
  return '';
}

const backBtn = `<button type="button" class="btn icon" data-act="back" aria-label="Back to the list">
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
</button>`;

let renderSeq = 0;
async function renderDetail(id, keepTab = false) {
  const seq = ++renderSeq;
  const item = itemOf(id);
  const view = $('#net-detail');
  if (item.err) {
    const e = item.err;
    const g = errors.groupOf(e);
    const html = await errors.detailHtml(e);
    if (seq !== renderSeq) return;
    view.innerHTML = `
      <header class="detail-head">${backBtn}
        <h2 class="detail-title" tabindex="-1">${esc(e.message)}</h2>
        <span class="st pill e-${g}">${codeLabel(g)}</span>
      </header>
      <div class="detail-scroll">${html}${e.netId && S.net.has(e.netId) ? '<div class="actions"><button type="button" class="btn small" data-open="' + esc(e.netId) + '">Show request</button></div>' : ''}</div>`;
    return;
  }
  const n = item.n;
  if (!n) return;
  const tabs = tabsFor(n);
  if (!keepTab || !tabs.some(([k]) => k === detailTab)) detailTab = probsFirstTab(n, tabs);
  const top = await meaningHtml(n);
  const body = await tabBody(n, detailTab);
  if (seq !== renderSeq) return;
  view.innerHTML = `
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
      ${n.type === 'api' ? `
      <div class="actions">
        <button type="button" class="btn small" data-copy="curl">Copy as cURL</button>
        <button type="button" class="btn small" data-copy="fetch">Copy as fetch</button>
        <button type="button" class="btn small" data-copy="response">Copy response</button>
        <span role="status" class="saved"></span>
      </div>` : ''}
    </div>`;
}

// Open the most useful tab first: Response for failures, Preview for JSON, else Headers.
function probsFirstTab(n, tabs) {
  const has = (k) => tabs.some(([t]) => t === k);
  if (['4xx', '5xx'].includes(statusClass(n)) && has('response')) return 'response';
  if (has('preview')) return 'preview';
  return 'headers';
}

export async function openDetail(id) {
  selectedId = id;
  for (const tr of rows.values()) tr.removeAttribute('aria-current');
  rows.get(id)?.setAttribute('aria-current', 'true');
  await renderDetail(id);
  $('#net-list-view').inert = true;
  $('#net-detail').hidden = false;
  $('.detail-title')?.focus({ preventScroll: true });
}

export function closeDetail() {
  const id = selectedId;
  selectedId = null;
  $('#net-detail').hidden = true;
  $('#net-list-view').inert = false;
  const tr = id && rows.get(id);
  tr?.querySelector('.row-open')?.focus({ preventScroll: false });
}

function step(dir) {
  const visible = [...$('#net-rows').children].filter((tr) => !tr.hidden);
  const i = visible.findIndex((tr) => tr.dataset.id === selectedId);
  const next = visible[i + dir];
  if (next) openDetail(next.dataset.id);
}

function asCurl(n) {
  const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  const parts = [`curl ${q(n.url)}`];
  if (n.method !== 'GET') parts.push(`-X ${n.method}`);
  for (const [k, v] of n.reqHeaders || []) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (n.reqBody?.text) parts.push(`--data-raw ${q(n.reqBody.text)}`);
  return parts.join(' \\\n  ');
}
function asFetch(n) {
  const init = { method: n.method, headers: Object.fromEntries(n.reqHeaders || []) };
  if (n.reqBody?.text) init.body = n.reqBody.text;
  return `await fetch(${JSON.stringify(n.url)}, ${JSON.stringify(init, null, 2)});`;
}

// ───────────── wiring ─────────────
export function init() {
  getType = chipGroup($('#net-types'), scheduleRefresh);
  $('#net-q').addEventListener('input', scheduleRefresh);
  $('#net-problems').addEventListener('change', scheduleRefresh);
  $('#net-clear').addEventListener('click', async () => {
    await send({ type: 'clear:net' });
    await send({ type: 'clear:errors' });
    clear();
    errors.clear();
  });

  $('#net-codes').addEventListener('click', (e) => {
    if (e.target.closest('.codes-reset')) { codeFilter.clear(); return scheduleRefresh(); }
    const b = e.target.closest('[data-code]');
    if (!b) return;
    const k = b.dataset.code;
    codeFilter.has(k) ? codeFilter.delete(k) : codeFilter.add(k);
    scheduleRefresh();
  });

  // Sortable headers (buttons inside <th>, aria-sort on the active one only).
  $('#net-table thead').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sort]');
    if (!b) return;
    const th = b.closest('th');
    const k = b.dataset.sort;
    if (sortKey === k && sortDir === 'descending') { sortKey = null; th.removeAttribute('aria-sort'); }
    else {
      sortDir = sortKey === k ? 'descending' : 'ascending';
      sortKey = k;
      for (const x of $$('#net-table th')) x.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', sortDir);
    }
    $('#net-sort-status').textContent = sortKey ? `Sorted by ${b.textContent.trim()}, ${sortDir}` : 'Newest first';
    scheduleRefresh();
  });

  $('#net-rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(tr.dataset.id);
  });

  const detail = $('#net-detail');
  detail.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="back"]')) return closeDetail();
    const jump = e.target.closest('[data-open]');
    if (jump) return openDetail(jump.dataset.open);
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      detailTab = tab.dataset.tab;
      for (const t of $$('[data-tab]', detail)) t.setAttribute('aria-selected', String(t === tab));
      const n = S.net.get(selectedId);
      $('.tab-body', detail).innerHTML = await tabBody(n, detailTab);
      return;
    }
    const c = e.target.closest('[data-copy]');
    if (c) {
      const n = S.net.get(selectedId);
      copyText(c, c.dataset.copy === 'curl' ? asCurl(n) : c.dataset.copy === 'fetch' ? asFetch(n) : (n.resBody?.text || ''));
    }
  });
  // Find in response: highlight matches.
  detail.addEventListener('input', (e) => {
    if (!e.target.matches('.find')) return;
    const pre = $('.body-pre', detail);
    if (!pre) return;
    const raw = pre.dataset.raw ?? (pre.dataset.raw = pre.textContent);
    const q = e.target.value;
    if (!q) { pre.textContent = raw; return; }
    pre.innerHTML = esc(raw).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
    pre.querySelector('mark')?.scrollIntoView({ block: 'nearest' });
  });
  detail.addEventListener('keydown', (e) => {
    if (e.target.matches('input')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
    else if (e.key === 'ArrowDown' && !e.target.closest('[role="tablist"]')) { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp' && !e.target.closest('[role="tablist"]')) { e.preventDefault(); step(-1); }
  });
}

// For the health strip and Inspect.
export function failedCount() {
  let n = 0;
  for (const r of S.net.values()) if (['4xx', '5xx', 'failed'].includes(statusClass(r))) n++;
  return n;
}
function setType(t) {
  for (const b of $$('#net-types button')) b.setAttribute('aria-pressed', String(b.dataset.value === t));
}
export function showProblems() {
  codeFilter.clear();
  setType('all');
  $('#net-problems').checked = true;
  scheduleRefresh();
}
export function showErrors() {
  codeFilter.clear();
  setType('error');
  $('#net-problems').checked = false;
  scheduleRefresh();
}
