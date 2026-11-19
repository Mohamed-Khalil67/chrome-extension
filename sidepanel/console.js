// Console tab: the page's console messages with their source line, and a
// prompt that runs JavaScript in the page.
import { S, $, esc, val, send, emit, chipGroup, fileLink } from './core.js';
import { mapStack } from './sourcemap.js';

const MAX_ROWS = 500;
const LEVELS = { log: 'log', debug: 'log', info: 'info', warn: 'warn', error: 'error' };
let getLevel = () => ['all'];
let last = null; // last row, for collapsing repeats
const counts = { log: 0, info: 0, warn: 0, error: 0 };
const history = [];
let histPos = -1;

const list = () => $('#con-list');

// Top-level strings print as text, like DevTools; everything else as a value.
const argHtml = (a) => (a?.t === 'str' ? `<span class="con-text">${esc(a.v)}</span>` : val(a));

function atBottom() {
  const l = list();
  return l.scrollHeight - l.scrollTop - l.clientHeight < 40;
}
function append(row) {
  const stick = atBottom();
  list().append(row);
  while (list().children.length > MAX_ROWS) list().firstElementChild.remove();
  applyFilter(row);
  if (stick) list().scrollTop = list().scrollHeight;
  $('#con-empty').hidden = true;
}

function rowFor(kind, inner, src = '') {
  const row = document.createElement('div');
  row.className = `con-row l-${kind}`;
  row.innerHTML = `<span class="con-ico" aria-hidden="true"></span><div class="con-msg">${inner}</div><span class="con-src">${src}</span>`;
  return row;
}

// Where the message was logged: the first frame of your code, through source maps.
async function locate(row, stack) {
  if (!stack) return;
  // Skip dev-server and test-runner wrappers around console (Vite's client patches it).
  const frames = (await mapStack(stack, 8)).filter((x) => !/\/@vite\/client|\/@fs\/|pptr:|__puppeteer/.test(x.url || ''));
  const app = frames.find((f) => !f.lib && f.orig);
  const f = app || frames.find((x) => x.orig) || frames[0];
  if (!f) return;
  row.querySelector('.con-src').innerHTML = f.orig
    ? fileLink(f.orig.file, f.orig.line, f.orig.col, `${f.orig.file.split('/').pop()}:${f.orig.line}`)
    : `<span title="${esc(f.file)}">${esc(String(f.file).split('/').pop().split('?')[0])}:${f.line}</span>`;
}

export function add(m) {
  const level = LEVELS[m.level] || 'log';
  counts[level]++;
  const sig = `${level}|${JSON.stringify(m.args).slice(0, 2000)}|${(m.stack || '').split('\n')[0]}`;
  if (last && last.sig === sig && last.row.isConnected) {
    last.count++;
    const badge = last.row.querySelector('.con-times');
    badge.textContent = last.count;
    badge.hidden = false;
    emit('counts');
    return;
  }
  const row = rowFor(level, `<span class="con-times" hidden></span>${m.args.map(argHtml).join(' ')}`);
  row.dataset.level = level;
  last = { sig, row, count: 1 };
  append(row);
  locate(row, m.stack);
  emit('counts');
}

export function clear() {
  list().replaceChildren();
  last = null;
  for (const k in counts) counts[k] = 0;
  $('#con-empty').hidden = false;
  emit('counts');
}

export const errorCount = () => counts.error;
export const total = () => counts.log + counts.info + counts.warn + counts.error;

function applyFilter(row) {
  const lv = getLevel()[0] || 'all';
  const q = $('#con-q').value.trim().toLowerCase();
  const level = row.dataset.level;
  const levelOk = lv === 'all' || level === lv; // prompt rows have no level: only under All
  row.hidden = !(levelOk && (!q || row.textContent.toLowerCase().includes(q)));
}
function refilter() {
  for (const row of list().children) applyFilter(row);
  for (const b of $('#con-levels').querySelectorAll('button')) {
    const k = b.dataset.value;
    b.querySelector('.n').textContent = k === 'all' ? '' : counts[k] || '';
  }
}

// ───────────── prompt ─────────────
async function run(code) {
  history.push(code);
  if (history.length > 100) history.shift();
  histPos = -1;
  last = null;
  append(rowFor('in', `<pre class="con-code">${esc(code)}</pre>`));
  const pending = rowFor('out', '<span class="v-null">Running…</span>');
  append(pending);
  const res = await send({ type: 'eval', code });
  if (res == null) {
    pending.className = 'con-row l-error';
    pending.querySelector('.con-msg').textContent = 'Not connected to the page. Reload the page and try again.';
  } else if (res.ok) {
    pending.querySelector('.con-msg').innerHTML = val(res.value);
  } else {
    pending.className = 'con-row l-error';
    pending.querySelector('.con-msg').innerHTML = `<span class="con-text">${esc(res.error)}</span>`;
  }
  list().scrollTop = list().scrollHeight;
}

function grow(t) {
  t.rows = Math.min(8, Math.max(1, t.value.split('\n').length));
}

export function init() {
  getLevel = chipGroup($('#con-levels'), refilter);
  $('#con-q').addEventListener('input', refilter);
  $('#con-clear').addEventListener('click', async () => { await send({ type: 'clear:logs' }); clear(); });

  const input = $('#con-input');
  input.addEventListener('input', () => grow(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const code = input.value.trim();
      if (!code) return;
      input.value = '';
      grow(input);
      run(code);
      return;
    }
    // History: ↑/↓ when the caret is on the first/last line.
    const before = input.value.slice(0, input.selectionStart);
    const after = input.value.slice(input.selectionEnd);
    if (e.key === 'ArrowUp' && !before.includes('\n') && history.length) {
      e.preventDefault();
      histPos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      input.value = history[histPos];
      grow(input);
    } else if (e.key === 'ArrowDown' && !after.includes('\n') && histPos >= 0) {
      e.preventDefault();
      histPos = histPos + 1 < history.length ? histPos + 1 : -1;
      input.value = histPos < 0 ? '' : history[histPos];
      grow(input);
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      $('#con-clear').click();
    }
  });
  $('#con-form').addEventListener('submit', (e) => {
    e.preventDefault();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  });
}

// Shown in the empty state: what you can type.
export function hints() {
  const ng = S.framework?.name === 'Angular';
  return `Messages your app logs show up here, with the line that logged them. Type JavaScript below to run it in the page. <code>$0</code> is the element you picked${ng ? ', and <code>ng.getOwningComponent($0)</code> returns the component that rendered it' : ''}.`;
}
