// Shared state and helpers for the Angular Lens side panel modules.

export const S = {
  windowId: null,
  tabId: null,
  tabUrl: '',
  framework: null,
  net: new Map(),
  errors: new Map(),
  selection: null,
  settings: { root: '', editor: 'vscode' },
  picking: false,
  scripts: [],
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Message the content scripts in the inspected tab.
export async function send(msg) {
  if (S.tabId == null) return null;
  try { return await chrome.tabs.sendMessage(S.tabId, msg); } catch { return undefined; }
}

// Same-origin scripts in the page, used to find source maps (refreshed lazily:
// route chunks load later).
export async function pageScripts(refresh = false) {
  if (refresh || !S.scripts.length) S.scripts = (await send({ type: 'scripts' })) || [];
  return S.scripts;
}

// ───────────── tiny event bus between modules ─────────────
const listeners = new Map();
export const on = (name, fn) => { (listeners.get(name) || listeners.set(name, []).get(name)).push(fn); };
export const emit = (name, data) => { for (const fn of listeners.get(name) || []) fn(data); };

// ───────────── formatting ─────────────
export const fmtMs = (ms) => (ms == null ? '…' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
export const fmtSize = (b) => (b == null || b === 0 ? '–' : b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`);

// ───────────── editor links ─────────────
function absPath(file) {
  if (!file) return null;
  if (/^([a-zA-Z]:[\\/]|\/)/.test(file)) return file.replaceAll('\\', '/');
  if (!S.settings.root) return null;
  return `${S.settings.root.replaceAll('\\', '/').replace(/\/$/, '')}/${file.replace(/^\.?\//, '')}`;
}

export function editorUrl(file, line = 1, col = 1) {
  const p = absPath(file);
  if (!p) return null;
  const slashed = p.startsWith('/') ? p : `/${p}`;
  switch (S.settings.editor) {
    case 'cursor': return `cursor://file${slashed}:${line}:${col}`;
    case 'webstorm': return `webstorm://open?file=${encodeURIComponent(p)}&line=${line}&column=${col}`;
    default: return `vscode://file${slashed}:${line}:${col}`;
  }
}

export function fileLink(file, line, col, label) {
  if (!file) return '<span class="file-link nofile">source location unavailable</span>';
  const text = esc(label || `${file}${line ? ':' + line : ''}${col ? ':' + col : ''}`);
  return `<button type="button" class="file-link" data-open-file="${esc(file)}" data-line="${line || 1}" data-col="${col || 1}" title="Open in editor">${text}</button>`;
}

export async function openInEditor(file, line, col) {
  const url = editorUrl(file, line, col);
  if (!url) {
    $('#settings').showPopover();
    $('#root').focus();
    $('#saved').textContent = 'Set your project folder to open files.';
    return;
  }
  // An external-protocol URL is handed to the OS without navigating the tab.
  await chrome.tabs.update(S.tabId, { url });
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-open-file]');
  if (b) openInEditor(b.dataset.openFile, +b.dataset.line, +b.dataset.col);
});

// ───────────── copy with visible + announced feedback ─────────────
const copyTimers = new WeakMap();
export async function copyText(button, text) {
  const tip = button.parentElement.querySelector('[role="status"]');
  clearTimeout(copyTimers.get(button));
  let ok = true;
  try { await navigator.clipboard.writeText(text); } catch { ok = false; }
  if (tip) tip.textContent = ok ? 'Copied' : 'Copy failed';
  button.toggleAttribute('data-copied', ok);
  copyTimers.set(button, setTimeout(() => {
    if (tip) tip.textContent = '';
    button.removeAttribute('data-copied');
  }, 1800));
}

// ───────────── chip groups (single or multi select) ─────────────
// <div class="chips" data-multi> <button aria-pressed> … — returns a getter.
export function chipGroup(root, onChange) {
  const multi = root.hasAttribute('data-multi');
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    if (multi) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    else for (const x of root.querySelectorAll('button[data-value]')) x.setAttribute('aria-pressed', String(x === b));
    onChange();
  });
  return () => $$('button[data-value][aria-pressed="true"]', root).map((b) => b.dataset.value);
}

// ───────────── value rendering (component inputs / state) ─────────────
export function val(v) {
  if (!v) return '<span class="v-null">—</span>';
  switch (v.t) {
    case 'null': return '<span class="v-null">null</span>';
    case 'undef': return '<span class="v-null">undefined</span>';
    case 'str': return `<span class="v-str">"${esc(v.v)}"</span>`;
    case 'num': return `<span class="v-num">${esc(v.v)}</span>`;
    case 'bool': return `<span class="v-bool">${esc(v.v)}</span>`;
    case 'fn': return `<span class="v-fn">${esc(v.v)}</span>`;
    case 'node': return `<span class="v-other">${esc(v.v)}</span>`;
    case 'signal': return `<span class="v-sig">${esc(v.kind || (v.writable ? 'signal' : 'computed'))}</span>${val(v.v)}`;
    case 'obs': return `<span class="v-other">${esc(v.v)}</span>${v.cur ? ' ' + val(v.cur) : ''}`;
    case 'arr': {
      const label = `${v.ctor || 'Array'}(${v.len})`;
      if (!v.items.length) return `<span class="v-other">${label} []</span>`;
      return `<details class="v-obj"><summary>${esc(label)}</summary><dl class="kv">${v.items.map((x, i) => `<dt>${i}</dt><dd>${val(x)}</dd>`).join('')}</dl></details>`;
    }
    case 'obj': {
      const label = `${v.ctor || 'Object'} {${v.entries.length ? '…' : ''}}`;
      if (!v.entries.length) return `<span class="v-other">${esc(label)}</span>`;
      return `<details class="v-obj"><summary>${esc(label)}</summary><dl class="kv">${v.entries.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${val(x)}</dd>`).join('')}${v.more ? `<dt>…</dt><dd class="v-null">${v.more} more</dd>` : ''}</dl></details>`;
    }
    default: return `<span class="v-other">${esc(v.v)}</span>`;
  }
}

export const kvList = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${val(v)}</dd>`).join('')}</dl>`;

// ───────────── JSON tree (network Preview tab) ─────────────
export function jsonTree(value, key = null, depth = 0) {
  const label = key == null ? '' : `<span class="j-key">${esc(key)}</span>: `;
  if (value === null) return `<div class="j-row">${label}<span class="v-null">null</span></div>`;
  if (Array.isArray(value) || typeof value === 'object') {
    const isArr = Array.isArray(value);
    const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
    const preview = isArr ? `Array(${value.length})` : `{${entries.slice(0, 3).map(([k]) => esc(k)).join(', ')}${entries.length > 3 ? ', …' : ''}}`;
    const shown = entries.slice(0, 200);
    return `<details class="j-node" ${depth < 1 ? 'open' : ''}><summary>${label}<span class="v-other">${preview}</span></summary>${shown.map(([k, v]) => jsonTree(v, k, depth + 1)).join('')}${entries.length > shown.length ? `<div class="j-row v-null">… ${entries.length - shown.length} more</div>` : ''}</details>`;
  }
  const cls = typeof value === 'string' ? 'v-str' : typeof value === 'number' ? 'v-num' : 'v-bool';
  const text = typeof value === 'string' ? `"${value.length > 300 ? value.slice(0, 300) + '…' : value}"` : String(value);
  return `<div class="j-row">${label}<span class="${cls}">${esc(text)}</span></div>`;
}
