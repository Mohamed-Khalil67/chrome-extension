// Console tab: what the page logs, and its errors and warnings, with the line
// of code behind each one. A prompt at the bottom runs JavaScript in the page.
import type { LogMsg, Val } from '../../../shared/messages';
import { isAppFrame, mapStack } from '../../../shared/sourcemap';
import { on, emit } from '../../core/bus';
import { $, $$, chipGroup, closest, esc, setChip } from '../../core/dom';
import { fileLink } from '../../core/editor';
import { val } from '../../core/format';
import { send } from '../../core/rpc';
import { S, type PanelError } from '../../core/state';
import * as errors from './errors';

type Level = 'log' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogMsg['level'], Level> = { log: 'log', debug: 'log', info: 'info', warn: 'warn', error: 'error' };
const MAX_ROWS = 500;

let getLevel = (): string[] => ['all'];
let last: { sig: string; row: HTMLElement; count: number } | null = null; // last log row, for collapsing repeats
const logCounts: Record<Level, number> = { log: 0, info: 0, warn: 0, error: 0 };
const errRows = new Map<string, HTMLElement>(); // error key → row
const history: string[] = [];
let histPos = -1;

const list = (): HTMLElement => $('#con-list');

// Top-level strings print as text, like DevTools; everything else as a value.
const argHtml = (a: Val): string => (a.t === 'str' ? `<span class="con-text">${esc(a.v)}</span>` : val(a));

function atBottom(): boolean {
  const l = list();
  return l.scrollHeight - l.scrollTop - l.clientHeight < 40;
}
function append(row: HTMLElement): void {
  const stick = atBottom();
  list().append(row);
  while (list().children.length > MAX_ROWS) list().firstElementChild?.remove();
  applyFilter(row);
  if (stick) list().scrollTop = list().scrollHeight;
  $('#con-empty').hidden = true;
}

function rowFor(kind: Level | 'in' | 'out', inner: string, src = ''): HTMLElement {
  const row = document.createElement('div');
  row.className = `con-row l-${kind}`;
  row.innerHTML = `<span class="con-ico" aria-hidden="true"></span><div class="con-msg">${inner}</div><span class="con-src">${src}</span>`;
  return row;
}
const part = (row: HTMLElement, sel: string): HTMLElement => $(sel, row);

// Where a message was logged: the first frame of your code, through source maps.
async function locate(row: HTMLElement, stack: string): Promise<void> {
  if (!stack) return;
  // Skip dev-server and test-runner wrappers around console (Vite's client patches it).
  const frames = (await mapStack(stack, 8)).filter((x) => !/\/@vite\/client|\/@fs\/|pptr:|__puppeteer/.test(x.url));
  const f = frames.find(isAppFrame) ?? frames.find((x) => x.orig) ?? frames[0];
  if (!f) return;
  part(row, '.con-src').innerHTML = f.orig
    ? fileLink(f.orig.file, f.orig.line, f.orig.col, `${f.orig.file.split('/').pop() ?? f.orig.file}:${f.orig.line}`)
    : `<span title="${esc(f.file)}">${esc(f.file.split('/').pop()?.split('?')[0] ?? f.file)}:${f.line}</span>`;
}

// ───────────── logs ─────────────
export function addLog(m: LogMsg): void {
  const level = LEVELS[m.level];
  logCounts[level]++;
  const sig = `${level}|${JSON.stringify(m.args).slice(0, 2000)}|${m.stack.split('\n')[0] ?? ''}`;
  if (last && last.sig === sig && last.row.isConnected) {
    last.count++;
    const badge = part(last.row, '.con-times');
    badge.textContent = String(last.count);
    badge.hidden = false;
    emit('counts');
    return;
  }
  const row = rowFor(level, `<span class="con-times" hidden></span>${m.args.map(argHtml).join(' ')}`);
  row.dataset.level = level;
  last = { sig, row, count: 1 };
  append(row);
  void locate(row, m.stack);
  emit('counts');
}

// ───────────── errors and warnings ─────────────
function errorRowHtml(e: PanelError): string {
  const loc = errors.appFrame(e);
  return `
    <span class="con-ico" aria-hidden="true"></span>
    <div class="con-msg">
      <details class="con-err">
        <summary><span class="con-times"${e.count > 1 ? '' : ' hidden'}>${e.count}</span><span class="con-text">${esc(e.message)}</span>${e.code ? ' <span class="badge">Angular</span>' : ''}</summary>
        <div class="con-err-body"><p class="note">Loading…</p></div>
      </details>
    </div>
    <span class="con-src">${loc ? fileLink(loc.orig.file, loc.orig.line, loc.orig.col, `${loc.orig.file.split('/').pop() ?? loc.orig.file}:${loc.orig.line}`) : ''}</span>`;
}

function upsertError(e: PanelError): void {
  if (!errors.listed(e)) return;
  let row = errRows.get(e.key);
  if (!row) {
    row = document.createElement('div');
    row.className = `con-row l-${errors.isWarning(e) ? 'warn' : 'error'}`;
    row.dataset.level = errors.isWarning(e) ? 'warn' : 'error';
    row.dataset.errKey = e.key;
    errRows.set(e.key, row);
    row.innerHTML = errorRowHtml(e);
    last = null;
    append(row);
  } else {
    const open = row.querySelector('details')?.open ?? false;
    row.innerHTML = errorRowHtml(e);
    if (open) void expand(row, e);
  }
  emit('counts');
}

async function expand(row: HTMLElement, e: PanelError): Promise<void> {
  const details = row.querySelector('details');
  if (!details) return;
  details.open = true;
  part(row, '.con-err-body').innerHTML = await errors.detailHtml(e);
}

// Open one error (from Network or Inspect) and scroll to it.
export function openError(key: string): void {
  showErrors();
  const row = errRows.get(key);
  const e = S.errors.get(key);
  if (!row || !e) return;
  void expand(row, e);
  row.scrollIntoView({ block: 'nearest' });
}

on('error', upsertError);
on('errors-cleared', () => {
  for (const row of errRows.values()) row.remove();
  errRows.clear();
  emit('counts');
});

// ───────────── counts and filters ─────────────
export const errorCount = (): number => errors.errorCount();
export const total = (): number => logCounts.log + logCounts.info + logCounts.warn + logCounts.error + errors.errorCount() + errors.warningCount();
const countOf = (k: string): number => {
  switch (k) {
    case 'error': return logCounts.error + errors.errorCount();
    case 'warn': return logCounts.warn + errors.warningCount();
    case 'info': return logCounts.info;
    case 'log': return logCounts.log;
    default: return 0;
  }
};

function applyFilter(row: HTMLElement): void {
  const lv = getLevel()[0] ?? 'all';
  const levelOk = lv === 'all' || row.dataset.level === lv; // prompt rows have no level: only under All
  row.hidden = !levelOk;
}
function refilter(): void {
  for (const row of $$('.con-row', list())) applyFilter(row);
  for (const b of $$('button', $('#con-levels'))) {
    const n = b.querySelector('.n');
    if (n) n.textContent = b.dataset.value === 'all' ? '' : String(countOf(b.dataset.value ?? '') || '');
  }
}
on('counts', refilter);

export function showErrors(): void {
  setChip($('#con-levels'), 'error');
  refilter();
}

export function clear(): void {
  list().replaceChildren();
  errRows.clear();
  last = null;
  for (const k of Object.keys(logCounts) as Level[]) logCounts[k] = 0;
  $('#con-empty').hidden = false;
  emit('counts');
}

// ───────────── prompt ─────────────
async function run(code: string): Promise<void> {
  history.push(code);
  if (history.length > 100) history.shift();
  histPos = -1;
  last = null;
  append(rowFor('in', `<pre class="con-code">${esc(code)}</pre>`));
  const pending = rowFor('out', '<span class="v-null">Running…</span>');
  append(pending);
  const res = await send({ type: 'eval', code });
  const msg = part(pending, '.con-msg');
  if (res == null) {
    pending.className = 'con-row l-error';
    msg.textContent = 'Not connected to the page. Reload the page and try again.';
  } else if (res.ok) {
    msg.innerHTML = val(res.value);
  } else {
    pending.className = 'con-row l-error';
    msg.innerHTML = `<span class="con-text">${esc(res.error)}</span>`;
  }
  list().scrollTop = list().scrollHeight;
}

function grow(t: HTMLTextAreaElement): void {
  t.rows = Math.min(8, Math.max(1, t.value.split('\n').length));
}

export function init(): void {
  getLevel = chipGroup($('#con-levels'), refilter);
  $('#con-clear').addEventListener('click', () => {
    void (async () => {
      await send({ type: 'clear:logs' });
      await send({ type: 'clear:errors' });
      clear();
      errors.clear();
    })();
  });

  // Expanding an error row loads its explanation and code.
  list().addEventListener('toggle', (e) => {
    const details = e.target;
    if (!(details instanceof HTMLDetailsElement) || !details.open) return;
    const row = details.closest<HTMLElement>('.con-row');
    const err = row?.dataset.errKey ? S.errors.get(row.dataset.errKey) : undefined;
    if (row && err) void expand(row, err);
  }, true);

  const ta = $<HTMLTextAreaElement>('#con-input');
  ta.addEventListener('input', () => grow(ta));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const code = ta.value.trim();
      if (!code) return;
      ta.value = '';
      grow(ta);
      void run(code);
      return;
    }
    // History: ↑/↓ when the caret is on the first/last line.
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    if (e.key === 'ArrowUp' && !before.includes('\n') && history.length) {
      e.preventDefault();
      histPos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      ta.value = history[histPos] ?? '';
      grow(ta);
    } else if (e.key === 'ArrowDown' && !after.includes('\n') && histPos >= 0) {
      e.preventDefault();
      histPos = histPos + 1 < history.length ? histPos + 1 : -1;
      ta.value = histPos < 0 ? '' : history[histPos] ?? '';
      grow(ta);
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      $('#con-clear').click();
    }
  });
  $('#con-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  });
  list().addEventListener('click', (e) => {
    // Clicking an error's location opens the editor; don't also toggle the row.
    if (closest(e, '.con-src')) e.preventDefault();
  });
}

// Shown in the empty state: what you can type.
export function hints(): string {
  const ng = S.framework?.name === 'Angular';
  return `Messages, errors and warnings from your app show up here, with the line that caused them. Type JavaScript below to run it in the page. <code>$0</code> is the element you picked${ng ? ', and <code>ng.getOwningComponent($0)</code> returns the component that rendered it' : ''}.`;
}
