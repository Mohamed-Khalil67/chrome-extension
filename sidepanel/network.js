// Network tab: every request the page makes, classified like DevTools
// (type + status class) plus plain-language problem hints.
import { S, $, $$, esc, h, send, emit, fmtMs, fmtSize, chipGroup, copyText, jsonTree } from './core.js';
import { mapStack } from './sourcemap.js';
import { codeBlock } from './code.js';

const TYPE_LABEL = { api: 'API', doc: 'Doc', js: 'JS', css: 'CSS', img: 'Img', font: 'Font', media: 'Media', other: 'Other' };
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

// Returns [{level: 'error'|'warn'|'info', label, hint}]
export function problems(n, dupCount = 0) {
  const out = [];
  const add = (level, label, hint) => out.push({ level, label, hint });
  const s = n.status;
  if (n.statusText === 'aborted') add('info', 'Cancelled', 'The request was aborted before it finished. Often switchMap cancelling an older request, or a component destroyed mid-request. Usually harmless.');
  else if (s === 0) add('error', 'Blocked or offline', 'No response reached the page: CORS, DNS, a refused connection, or an ad blocker. A CORS problem shows its own message in the browser console.');
  else if (s === 401) add('error', 'Not authenticated', hasHeader(n.reqHeaders, 'authorization') ? 'The Authorization header was sent but rejected: the token is probably expired or invalid.' : 'No Authorization header was sent. Check that your HTTP interceptor adds the token, and that the user is logged in.');
  else if (s === 403) add('error', 'Forbidden', 'The server knows who you are but refuses this action. Check the user\'s role or permissions on the server.');
  else if (s === 404) add('error', 'Not found', 'Wrong URL, route or ID. Compare the URL with the API docs and your environment base URL.');
  else if (s === 405) add('error', 'Method not allowed', `The endpoint exists but doesn't accept ${n.method}.`);
  else if (s === 400 || s === 422) add('error', 'Rejected input', 'The server didn\'t accept the request data. The Response tab usually says which field.');
  else if (s === 408 || s === 504) add('error', 'Timed out', 'The server or a gateway gave up waiting.');
  else if (s === 429) add('warn', 'Rate limited', `Too many requests. ${headerVal(n.resHeaders, 'retry-after') ? `Retry after ${headerVal(n.resHeaders, 'retry-after')} s.` : ''}`);
  else if (s >= 500) add('error', 'Server error', 'The server failed while handling the request. The request may be fine: check the server logs and the Response tab.');
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

// ───────────── state ─────────────
const rows = new Map(); // id → <tr>
let selectedId = null;
let sortKey = null; // null → newest first
let sortDir = 'descending';
let dupCounts = new Map(); // id → count
let getStatus = () => [];
let getType = () => ['all'];

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
  S.net.clear(); rows.clear(); dupCounts.clear();
  $('#net-rows').replaceChildren();
  closeDetail();
  scheduleRefresh();
}

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

function matches(n) {
  const types = getType();
  if (!types.includes('all') && !types.includes(n.type)) return false;
  const st = getStatus();
  if (st.length && !st.includes(statusClass(n))) return false;
  if ($('#net-problems').checked && !(['4xx', '5xx', 'failed'].includes(statusClass(n)) || problems(n, dupCounts.get(n.id)).some((p) => p.level !== 'info'))) return false;
  const q = $('#net-q').value.trim().toLowerCase();
  if (q && !`${n.method} ${n.url} ${n.status ?? ''}`.toLowerCase().includes(q)) return false;
  return true;
}

const sortVal = {
  name: (n) => nameOf(n.url).toLowerCase(),
  status: (n) => n.status ?? -1,
  type: (n) => n.type,
  size: (n) => n.size || 0,
  time: (n) => (n.end ? n.end - n.start : Infinity),
};

let raf = 0;
export function scheduleRefresh() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(refresh);
}

function refresh() {
  computeDups();
  const all = [...S.net.values()];
  const visible = all.filter(matches);
  const visibleIds = new Set(visible.map((n) => n.id));

  // Order: move existing rows (never rebuild the tbody).
  const key = sortVal[sortKey];
  visible.sort((a, b) => {
    if (!key) return b.start - a.start;
    const x = key(a), y = key(b);
    const r = x < y ? -1 : x > y ? 1 : 0;
    return sortDir === 'ascending' ? r : -r;
  });
  const tbody = $('#net-rows');
  for (const [id, tr] of rows) tr.hidden = !visibleIds.has(id);
  let prev = null;
  for (const n of visible) {
    const tr = rows.get(n.id);
    if (!tr) continue;
    const want = prev ? prev.nextElementSibling : tbody.firstElementChild;
    if (want !== tr) (prev ? prev.after(tr) : tbody.prepend(tr));
    prev = tr;
  }

  // Waterfall across the visible requests.
  const t0 = Math.min(...visible.map((n) => n.start));
  const t1 = Math.max(...visible.map((n) => n.end || n.start));
  const span = Math.max(1, t1 - t0);
  for (const n of visible) {
    const bar = rows.get(n.id)?.querySelector('.wf-bar');
    if (!bar) continue;
    bar.style.left = `${((n.start - t0) / span) * 100}%`;
    bar.style.width = `${Math.max(1.5, (((n.end || n.start) - n.start) / span) * 100)}%`;
  }

  // Summary + status bar + chip counts (counts follow the type filter, like DevTools).
  const types = getType();
  const ofType = all.filter((n) => types.includes('all') || types.includes(n.type));
  const counts = Object.fromEntries(STATUS_CLASSES.map((c) => [c, 0]));
  for (const n of ofType) { const c = statusClass(n); if (c in counts) counts[c]++; }
  for (const b of $$('#net-status button')) b.querySelector('.n').textContent = counts[b.dataset.value] || '';
  const bar = $('#net-bar');
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  bar.innerHTML = STATUS_CLASSES.filter((c) => counts[c]).map((c) => `<span class="bar-seg ${c}" style="flex:${counts[c] / total}"></span>`).join('');
  const bytes = visible.reduce((a, n) => a + (n.size || 0), 0);
  $('#net-summary').textContent = all.length
    ? `${visible.length === all.length ? all.length : `${visible.length} of ${all.length}`} requests, ${fmtSize(bytes)}, ${fmtMs(isFinite(span) && visible.length ? span : 0)}`
    : '';
  for (const b of $$('#net-types button')) {
    const t = b.dataset.value;
    b.querySelector('.n').textContent = t === 'all' ? '' : all.filter((n) => n.type === t).length || '';
  }
  $('#net-empty').hidden = all.length > 0;
  $('#net-nomatch').hidden = !(all.length && !visible.length);
  emit('counts');
}

// ───────────── detail (drill-down over the list) ─────────────
let detailTab = 'headers';

function hintBanner(n) {
  const probs = problems(n, dupCounts.get(n.id));
  if (!probs.length) return '';
  return probs.map((p) => `<div class="hint ${p.level}"><strong>${esc(p.label)}.</strong> ${esc(p.hint)}</div>`).join('');
}

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

async function renderDetail(id, keepTab = false) {
  const n = S.net.get(id);
  if (!n) return;
  const tabs = tabsFor(n);
  if (!keepTab || !tabs.some(([k]) => k === detailTab)) detailTab = probsFirstTab(n, tabs);
  const view = $('#net-detail');
  view.innerHTML = `
    <header class="detail-head">
      <button type="button" class="btn icon" data-act="back" aria-label="Back to requests">
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <h2 class="detail-title" tabindex="-1"><span class="meth">${esc(n.method)}</span> ${esc(nameOf(n.url))}</h2>
      <span class="st pill ${statusClass(n)}">${n.status ?? '…'}</span>
    </header>
    <div class="detail-scroll">
      ${hintBanner(n)}
      <div class="subtabs" role="tablist" aria-label="Request details">
        ${tabs.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === detailTab}">${label}</button>`).join('')}
      </div>
      <div class="tab-body" role="tabpanel">…</div>
      ${n.type === 'api' ? `
      <div class="actions">
        <button type="button" class="btn small" data-copy="curl">Copy as cURL</button>
        <button type="button" class="btn small" data-copy="fetch">Copy as fetch</button>
        <button type="button" class="btn small" data-copy="response">Copy response</button>
        <span role="status" class="saved"></span>
      </div>` : ''}
    </div>`;
  const body = view.querySelector('.tab-body');
  body.innerHTML = await tabBody(n, detailTab);
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
  getStatus = chipGroup($('#net-status'), scheduleRefresh);
  getType = chipGroup($('#net-types'), scheduleRefresh);
  $('#net-q').addEventListener('input', scheduleRefresh);
  $('#net-problems').addEventListener('change', scheduleRefresh);
  $('#net-clear').addEventListener('click', async () => { await send({ type: 'clear:net' }); clear(); });

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
    else if (e.key === 'ArrowDown' && e.altKey === false && !e.target.closest('[role="tablist"]')) { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp' && !e.target.closest('[role="tablist"]')) { e.preventDefault(); step(-1); }
  });
}

// For other modules (Errors → "Show request", health strip).
export function failedCount() {
  let n = 0;
  for (const r of S.net.values()) if (['4xx', '5xx', 'failed'].includes(statusClass(r))) n++;
  return n;
}
export function showProblems() {
  $('#net-problems').checked = true;
  scheduleRefresh();
}
