// Errors tab: grouped by kind, each error shows the failing source line inline.
import { S, $, $$, esc, h, send, emit, fileLink, chipGroup } from './core.js';
import { mapStack } from './sourcemap.js';
import { codeBlock } from './code.js';

const rows = new Map();
const KIND_LABEL = { error: 'Uncaught error', promise: 'Unhandled promise rejection', console: 'console.error', warn: 'Warning', http: 'Failed request', resource: 'Failed to load' };

export function groupOf(e) {
  if (e.kind === 'warn') return 'warn';
  if (e.code) return 'ng';
  if (e.kind === 'http' || e.kind === 'resource') return 'http';
  return 'runtime';
}

let getKinds = () => ['all'];

const appFrame = (e) => e.mapped?.find((f) => !f.lib && f.orig);
const ngCode = (e) => `NG${String(e.code).padStart(4, '0')}`;

function summary(e) {
  const loc = appFrame(e);
  return `
    <span class="ico" aria-hidden="true"></span>
    <span class="msg"><b>${esc(e.message)}</b><small>${esc(KIND_LABEL[e.kind] || e.kind)}${loc ? ` in ${esc(loc.orig.file)}:${loc.orig.line}` : ''}</small></span>
    <span class="times" title="Times seen">${e.count > 1 ? `×${e.count}` : ''}</span>`;
}

async function renderBody(row, e) {
  const body = row.querySelector('.body');
  const frames = e.mapped || [];
  const app = frames.filter((f) => !f.lib && f.orig);
  const top = app[0];
  const frameLi = (f) => `<li class="${f.lib ? 'lib' : ''}">${f.orig ? fileLink(f.orig.file, f.orig.line, f.orig.col) : `<span>${esc(f.file)}:${f.line}</span>`}<span class="fn">${esc(f.orig?.name || f.fn || '')}</span></li>`;
  body.innerHTML = `
    ${e.message.length > 120 ? `<pre class="body-pre">${esc(e.message)}</pre>` : ''}
    ${e.code ? `<a class="ng-help" href="https://angular.dev/errors/${ngCode(e)}" target="_blank" rel="noopener">What ${ngCode(e)} means and how to fix it</a>` : ''}
    ${e.netId ? '<div class="actions"><button type="button" class="btn small" data-act="show-req">Show request</button></div>' : ''}
    <div class="err-code">${top ? '<p class="note">Loading source…</p>' : ''}</div>
    ${app.length > 1 ? `<details class="sub"><summary>Called through ${app.length - 1} more place${app.length > 2 ? 's' : ''} in your code</summary><ul class="frames">${app.slice(1, 8).map(frameLi).join('')}</ul></details>` : ''}
    ${frames.length ? `<details class="sub"><summary>Full stack (${frames.length} frames)</summary><ul class="frames">${frames.map(frameLi).join('')}</ul></details>` : e.stack ? `<details class="sub"><summary>Raw stack</summary><pre class="body-pre">${esc(e.stack)}</pre></details>` : ''}
    <p class="note">First seen ${new Date(e.first).toLocaleTimeString()}${e.count > 1 ? `, last ${new Date(e.last).toLocaleTimeString()}` : ''}</p>`;
  if (top) {
    const tone = e.kind === 'warn' ? 'warn' : e.kind === 'http' ? 'focus' : 'error';
    body.querySelector('.err-code').innerHTML = await codeBlock(top.orig.file, top.orig.line, { tone, before: 3, after: 2 });
  }
}

function filterRow(row, e) {
  // Single-select: "All" shows everything except warnings, which have their own chip.
  const k = getKinds()[0] || 'all';
  row.hidden = k === 'all' ? groupOf(e) === 'warn' : groupOf(e) !== k;
}

export async function add(e) {
  S.errors.set(e.key, e);
  let row = rows.get(e.key);
  if (!row) {
    row = h(`<details class="item err ${esc(e.kind)} g-${groupOf(e)}"><summary></summary><div class="body"></div></details>`);
    row.addEventListener('toggle', () => { if (row.open) renderBody(row, S.errors.get(e.key)); });
    rows.set(e.key, row);
    $('#err-list').prepend(row);
  }
  row.querySelector('summary').innerHTML = summary(e);
  filterRow(row, e);
  refreshCounts();
  if (!e.mapped && e.stack) {
    e.mapped = await mapStack(e.stack);
    row.querySelector('summary').innerHTML = summary(e);
    if (row.open) renderBody(row, e);
    emit('errors-mapped');
  }
}

export function update(p) {
  const e = S.errors.get(p.key);
  if (!e) return;
  e.count = p.count; e.last = p.last;
  rows.get(p.key).querySelector('summary').innerHTML = summary(e);
  refreshCounts();
}

export function clear() {
  S.errors.clear(); rows.clear();
  $('#err-list').replaceChildren();
  refreshCounts();
}

function refreshCounts() {
  const counts = { all: 0, runtime: 0, http: 0, ng: 0, warn: 0 };
  for (const e of S.errors.values()) {
    const g = groupOf(e);
    counts[g] += e.count;
    if (g !== 'warn') counts.all += e.count;
  }
  for (const b of $$('#err-kinds button')) b.querySelector('.n').textContent = counts[b.dataset.value] || '';
  $('#err-empty').hidden = [...rows.values()].some((r) => !r.hidden);
  emit('counts');
}

export const errorCount = () => [...S.errors.values()].filter((e) => e.kind !== 'warn').reduce((a, e) => a + e.count, 0);

// Errors whose message, stack or mapped frames point at a component.
export function relatedTo(c) {
  if (!c) return [];
  const file = c.file?.replace(/^\.?\//, '');
  return [...S.errors.values()].filter((e) =>
    e.kind !== 'warn' && ((e.message || '').includes(c.name) || (e.stack || '').includes(c.name) ||
      (file && e.mapped?.some((f) => f.orig?.file?.endsWith(file)))));
}

export function init({ onShowRequest }) {
  getKinds = chipGroup($('#err-kinds'), () => { for (const [k, r] of rows) filterRow(r, S.errors.get(k)); refreshCounts(); });
  $('#err-clear').addEventListener('click', async () => { await send({ type: 'clear:errors' }); clear(); });
  $('#err-list').addEventListener('click', (ev) => {
    if (!ev.target.closest('[data-act="show-req"]')) return;
    const key = [...rows].find(([, r]) => r.contains(ev.target))?.[0];
    const id = S.errors.get(key)?.netId;
    if (id) onShowRequest(id);
  });
}
