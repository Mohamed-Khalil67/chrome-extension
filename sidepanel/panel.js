import { mapStack } from './sourcemap.js';

// ───────────────────────── state ─────────────────────────
const S = {
  windowId: null,
  tabId: null,
  tabUrl: '',
  framework: null,
  net: new Map(),
  errors: new Map(),
  selection: null,
  settings: { root: '', editor: 'vscode' },
  picking: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Content scripts in the current tab.
async function send(msg) {
  if (S.tabId == null) return null;
  try { return await chrome.tabs.sendMessage(S.tabId, msg); } catch { return undefined; }
}

// ───────────────────────── editor links ─────────────────────────
function absPath(file) {
  if (!file) return null;
  if (/^([a-zA-Z]:[\\/]|\/)/.test(file)) return file.replaceAll('\\', '/');
  if (!S.settings.root) return null;
  return `${S.settings.root.replaceAll('\\', '/').replace(/\/$/, '')}/${file.replace(/^\.?\//, '')}`;
}

function editorUrl(file, line = 1, col = 1) {
  const p = absPath(file);
  if (!p) return null;
  const slashed = p.startsWith('/') ? p : `/${p}`;
  switch (S.settings.editor) {
    case 'cursor': return `cursor://file${slashed}:${line}:${col}`;
    case 'webstorm': return `webstorm://open?file=${encodeURIComponent(p)}&line=${line}&column=${col}`;
    default: return `vscode://file${slashed}:${line}:${col}`;
  }
}

function fileLink(file, line, col, label) {
  if (!file) return `<span class="file-link nofile">source location unavailable</span>`;
  const text = esc(label || `${file}${line ? ':' + line : ''}${col ? ':' + col : ''}`);
  return `<button type="button" class="file-link" data-open-file="${esc(file)}" data-line="${line || 1}" data-col="${col || 1}" title="Open in editor">${text}</button>`;
}

async function openInEditor(file, line, col) {
  const url = editorUrl(file, line, col);
  if (!url) {
    $('#settings').showPopover();
    $('#root').focus();
    $('#saved').textContent = 'Set your project folder to open files.';
    return;
  }
  // Updating the tab with an external-protocol URL hands it to the OS without navigating.
  await chrome.tabs.update(S.tabId, { url });
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-open-file]');
  if (b) openInEditor(b.dataset.openFile, +b.dataset.line, +b.dataset.col);
});

// ───────────────────────── value rendering ─────────────────────────
function val(v) {
  if (!v) return '<span class="v-null">—</span>';
  switch (v.t) {
    case 'null': return '<span class="v-null">null</span>';
    case 'undef': return '<span class="v-null">undefined</span>';
    case 'str': return `<span class="v-str">"${esc(v.v)}"</span>`;
    case 'num': return `<span class="v-num">${esc(v.v)}</span>`;
    case 'bool': return `<span class="v-bool">${esc(v.v)}</span>`;
    case 'fn': return `<span class="v-fn">${esc(v.v)}</span>`;
    case 'node': return `<span class="v-other">${esc(v.v)}</span>`;
    case 'signal': return `<span class="v-sig" title="${v.writable ? 'writable signal' : 'computed / input signal'}">${esc(v.kind || (v.writable ? 'signal' : 'computed'))}</span>${val(v.v)}`;
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

const kvList = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${val(v)}</dd>`).join('')}</dl>`;

// ───────────────────────── framework badge ─────────────────────────
function renderFramework() {
  const fw = S.framework;
  const el = $('#fw');
  if (!fw?.name) { el.innerHTML = '<span class="badge">No framework detected</span>'; return; }
  const parts = [`<span class="badge lens">${esc(fw.name)} ${esc(fw.version || '')}</span>`];
  if (fw.name === 'Angular') {
    parts.push(fw.dev ? '<span class="badge">dev mode</span>' : '<span class="badge warn" title="Production build: component details are not available">prod build</span>');
    if (fw.zoneless) parts.push('<span class="badge">zoneless</span>');
  }
  el.innerHTML = parts.join('');
}

// ───────────────────────── inspect ─────────────────────────
function renderInspect() {
  const root = $('#inspect');
  const sel = S.selection;
  if (!sel) {
    const prodNote = S.framework?.name === 'Angular' && !S.framework.dev
      ? '<p><strong>This is a production build.</strong> Run <code>ng serve</code> to see component names and files. Styles, network and errors still work.</p>' : '';
    root.innerHTML = `
      <div class="start">
        <h2>Find the code behind any part of the page</h2>
        <p>Press <strong>Pick</strong>, then click an area of the app. You'll get:</p>
        <ul>
          <li>the component that rendered it and its source file</li>
          <li>its inputs, signals and state right now</li>
          <li>which CSS rules apply, and layout problems found</li>
        </ul>
        ${prodNote}
        <button type="button" class="btn primary" data-act="pick">Pick an element</button>
      </div>`;
    return;
  }

  const [focus, ...parents] = sel.chain;
  const errs = relatedErrors(focus);
  root.innerHTML = `
    <div class="el-line">
      <span class="tag">&lt;${esc(sel.element)}&gt;</span>
      <span class="dim">${sel.rect.w}×${sel.rect.h}</span>
      <span class="spacer"></span>
      <button type="button" class="btn small ghost" data-act="parent" title="Select the parent element">Parent</button>
      <button type="button" class="btn small ghost" data-act="refresh" title="Read current values again">Refresh</button>
      <button type="button" class="btn small ghost" data-act="clear-sel">Clear</button>
    </div>
    ${sel.chain.length ? `
    <ol class="trail" aria-label="Component tree, nearest first">
      <li class="focus">${focusCard(focus, sel, errs)}</li>
      ${parents.map((c) => `<li><button type="button" class="cmp-parent" data-path='${esc(JSON.stringify(c.path || null))}'><b>${esc(c.name)}</b><span class="mono">${esc(c.file || c.selector || '')}</span></button></li>`).join('')}
    </ol>` : noComponentNote(sel)}
    ${problemsSection(sel.css)}
    ${focus ? dataSections(focus, sel) : ''}
    ${boxSection(sel.css)}
    ${rulesSection(sel.css)}`;
}

function noComponentNote(sel) {
  if (sel.error) return `<p class="note">Could not read component info: ${esc(sel.error)}</p>`;
  const fw = sel.framework;
  if (fw?.name === 'Angular' && !fw.dev) return '<p class="note">Production build: component info is not available. Run the app with <code>ng serve</code>.</p>';
  if (!fw?.name) return '<p class="note">No supported framework found on this page. Styles and layout checks below still apply.</p>';
  return '<p class="note">This element is not inside a component.</p>';
}

function focusCard(c, sel, errs) {
  return `
    <article class="cmp-focus">
      <h2 class="cmp-name">${esc(c.name)}</h2>
      ${c.selector ? `<div class="cmp-sel">&lt;${esc(c.selector)}&gt;</div>` : ''}
      <div class="cmp-file">${fileLink(c.file, c.line)}</div>
      <div class="badges">
        ${c.badges.map((b) => `<span class="badge">${esc(b)}</span>`).join('')}
        ${sel.directives?.length ? sel.directives.filter((d) => d !== c.name).map((d) => `<span class="badge lens" title="Directive on the selected element">${esc(d)}</span>`).join('') : ''}
        ${errs.length ? `<button type="button" class="badge bad" data-act="goto-errors">${errs.length} related error${errs.length > 1 ? 's' : ''}</button>` : ''}
      </div>
    </article>`;
}

function dataSections(c, sel) {
  const out = [];
  if (c.inputs.length) out.push(`<section class="section"><h3>Inputs <span class="n">${c.inputs.length}</span></h3>${kvList(c.inputs)}</section>`);
  if (c.state.length) out.push(`<section class="section"><h3>State <span class="n">${c.state.length}</span></h3>${kvList(c.state)}</section>`);
  if (c.outputs.length) out.push(`<section class="section"><h3>Outputs</h3><div class="badges">${c.outputs.map((o) => `<span class="badge">${esc(o)}</span>`).join('')}</div></section>`);
  if (sel.listeners?.length) {
    out.push(`<section class="section"><h3>Event listeners on this element</h3><dl class="kv">${sel.listeners.map((l) => `<dt>(${esc(l.name)})</dt><dd>${esc(l.fn || 'handler')}${l.type === 'dom' ? '' : ` <span class="v-null">${esc(l.type)}</span>`}</dd>`).join('')}</dl></section>`);
  }
  return out.join('');
}

function problemsSection(css) {
  if (!css || css.error) return '';
  const list = css.warnings || [];
  return `<section class="section"><h3>Layout and style checks</h3>${list.length
    ? `<ul class="problems">${list.map((w) => `<li class="problem ${esc(w.level)}"><strong>${esc(w.text)}</strong><span>${esc(w.hint || '')}</span></li>`).join('')}</ul>`
    : '<p class="all-good">No layout problems found on this element.</p>'}</section>`;
}

function boxSection(css) {
  const b = css?.box;
  if (!b) return '';
  const side = (arr) => arr.map((n) => (n ? n : '–'));
  const [mt, mr, mb, ml] = side(b.margin), [bt, br, bb, bl] = side(b.border), [pt, pr, pb, pl] = side(b.padding);
  return `
    <section class="section"><h3>Box model</h3>
      <div class="boxm" role="img" aria-label="margin ${b.margin.join(' ')}, border ${b.border.join(' ')}, padding ${b.padding.join(' ')}, content ${b.content[0]} by ${b.content[1]}">
        <div class="lyr m"><span class="lbl">margin</span><span class="t">${mt}</span><span class="b">${mb}</span><span class="l">${ml}</span><span class="r">${mr}</span>
          <div class="lyr bd"><span class="lbl">border</span><span class="t">${bt}</span><span class="b">${bb}</span><span class="l">${bl}</span><span class="r">${br}</span>
            <div class="lyr p"><span class="lbl">padding</span><span class="t">${pt}</span><span class="b">${pb}</span><span class="l">${pl}</span><span class="r">${pr}</span>
              <div class="c">${b.content[0]} × ${b.content[1]}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="facts">
        <span class="badge">display: ${esc(b.display)}</span>
        <span class="badge">position: ${esc(b.position)}</span>
        <span class="badge">${esc(b.boxSizing)}</span>
        ${b.key.zIndex !== 'auto' ? `<span class="badge">z-index: ${esc(b.key.zIndex)}</span>` : ''}
        ${b.key.overflow !== 'visible' ? `<span class="badge">overflow: ${esc(b.key.overflow)}</span>` : ''}
      </div>
    </section>`;
}

function rulesSection(css) {
  if (!css?.rules) return css?.error ? `<p class="note">CSS analysis failed: ${esc(css.error)}</p>` : '';
  const rules = css.rules.filter((r) => r.lines.length);
  if (!rules.length) return '<section class="section"><h3>Styles</h3><p class="note">Only browser defaults and inherited styles apply.</p></section>';
  return `
    <section class="section"><h3>Styles <span class="n">${rules.length} rules, strongest first</span></h3>
      ${rules.map((r) => `
        <div class="rule">
          <header>
            <span class="sel">${esc(r.selector)}</span>
            ${r.owner ? `<span class="owner" title="Scoped component styles">${esc(r.owner)}</span>` : `<span class="src">${esc(r.label)}</span>`}
          </header>
          ${r.ctx?.length ? `<div class="ctx">${r.ctx.map(esc).join(' ')}</div>` : ''}
          <ul>${r.lines.map((d) => `<li class="${d.overridden ? 'over' : ''}" ${d.overridden ? 'title="Overridden by a stronger rule"' : ''}><span class="p-name">${esc(d.prop)}</span>: ${esc(d.value)}${d.important ? ' <span class="imp">!important</span>' : ''};</li>`).join('')}</ul>
        </div>`).join('')}
    </section>`;
}

function relatedErrors(c) {
  if (!c) return [];
  return [...S.errors.values()].filter((e) =>
    e.kind !== 'warn' && ((e.message || '').includes(c.name) || (e.stack || '').includes(c.name) ||
      (c.file && e.mapped?.some((f) => f.orig?.file?.endsWith(c.file.replace(/^\.?\//, ''))))));
}

$('#inspect').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const parentBtn = e.target.closest('.cmp-parent');
  if (parentBtn) {
    const path = JSON.parse(parentBtn.dataset.path || 'null');
    if (path) { const sel = await send({ type: 'select:path', path }); if (sel) { S.selection = sel; renderInspect(); } }
    return;
  }
  if (act === 'pick') startPick();
  else if (act === 'refresh') { const sel = await send({ type: 'reinspect' }); if (sel) { S.selection = sel; renderInspect(); } }
  else if (act === 'parent') { const sel = await send({ type: 'select:parent' }); if (sel) { S.selection = sel; renderInspect(); } }
  else if (act === 'clear-sel') { await send({ type: 'selection:clear' }); S.selection = null; renderInspect(); }
  else if (act === 'goto-errors') selectTab('errors');
});

// ───────────────────────── pick ─────────────────────────
async function startPick() {
  const ok = await send({ type: S.picking ? 'picker:stop' : 'picker:start' });
  if (ok === undefined) return showOffline();
  setPicking(!S.picking);
}
function setPicking(on) {
  S.picking = on;
  const b = $('#pick');
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('span').textContent = on ? 'Picking… (Esc)' : 'Pick';
}
$('#pick').addEventListener('click', startPick);

// ───────────────────────── network ─────────────────────────
const netRows = new Map();

function statusClass(n) {
  if (n.status == null) return 'pending';
  if (n.status === 0 || n.status >= 400) return 'bad';
  if (n.status >= 300) return 'redir';
  return 'ok';
}
const fmtMs = (n) => (n.end ? `${Math.round(n.end - n.start)}ms` : '…');
const fmtSize = (b) => (b == null ? '' : b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);

function splitUrl(url) {
  try {
    const u = new URL(url);
    const name = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
    return { name: name + (u.search ? u.search.slice(0, 40) : ''), rest: `${u.host}${u.pathname}` };
  } catch { return { name: url, rest: '' }; }
}

function netSummary(n) {
  const { name, rest } = splitUrl(n.url);
  const cls = statusClass(n);
  return `
    <span class="m">${esc(n.method)}</span>
    <span class="u"><b title="${esc(n.url)}">${esc(name)}</b><small>${esc(rest)}</small></span>
    <span class="s ${cls}">${n.status == null ? '…' : n.status || 'ERR'}</span>
    <span class="t">${fmtMs(n)}</span>`;
}

function upsertNet(n) {
  let row = netRows.get(n.id);
  const failed = n.status === 0 || n.status >= 400;
  if (!row) {
    row = h(`<details class="item net" data-id="${esc(n.id)}"><summary></summary><div class="body"></div></details>`);
    row.addEventListener('toggle', () => { if (row.open) renderNetBody(row, S.net.get(n.id)); });
    netRows.set(n.id, row);
    $('#net-list').prepend(row);
  }
  row.classList.toggle('failed', failed);
  row.querySelector('summary').innerHTML = netSummary(n);
  if (row.open) renderNetBody(row, n);
  applyNetFilter(row, n);
  updateCounts();
}

function prettyBody(b, headers) {
  if (!b) return '<p class="note">No body</p>';
  if (!b.text) return `<p class="note">${esc(b.note || 'Empty')}</p>`;
  let text = b.text;
  const ct = (headers || []).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  if (/json/.test(ct) || /^\s*[[{]/.test(text)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not json */ } }
  return `<pre class="code">${esc(text)}</pre>${b.truncated ? '<p class="note">Truncated at 200 KB</p>' : ''}${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}`;
}

const headerList = (list) => (list?.length
  ? `<dl class="kv">${list.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
  : '<p class="note">None captured</p>');

async function renderNetBody(row, n) {
  const body = row.querySelector('.body');
  body.innerHTML = `
    <dl class="kv">
      <dt>URL</dt><dd>${esc(n.url)}</dd>
      <dt>Status</dt><dd><span class="s ${statusClass(n)}">${n.status ?? 'pending'}</span> ${esc(n.statusText || '')}${n.error ? ` ${esc(n.error)}` : ''}</dd>
      <dt>Time</dt><dd>${fmtMs(n)}${n.size != null ? `, ${fmtSize(n.size)}` : ''}</dd>
      <dt>Via</dt><dd>${n.kind === 'xhr' ? 'XMLHttpRequest' : 'fetch'}</dd>
      <dt>Called from</dt><dd class="initiator">…</dd>
    </dl>
    ${n.reqBody ? `<div class="sub"><h4>Request body</h4>${prettyBody(n.reqBody, n.reqHeaders)}</div>` : ''}
    <div class="sub"><h4>Response</h4>${n.status == null ? '<p class="note">Waiting…</p>' : prettyBody(n.resBody, n.resHeaders)}</div>
    <details class="sub"><summary>Request headers</summary>${headerList(n.reqHeaders)}</details>
    <details class="sub"><summary>Response headers</summary>${headerList(n.resHeaders)}</details>
    <div class="actions">
      <button type="button" class="btn small" data-copy="curl">Copy as cURL</button>
      <button type="button" class="btn small" data-copy="fetch">Copy as fetch</button>
      <button type="button" class="btn small" data-copy="response">Copy response</button>
      <span role="status" class="saved"></span>
    </div>`;
  const frames = await mapStack(n.initiator);
  const app = frames.find((f) => !f.lib && f.orig);
  body.querySelector('.initiator').innerHTML = app ? fileLink(app.orig.file, app.orig.line, app.orig.col) + (app.fn ? ` <span class="v-null">${esc(app.fn)}</span>` : '') : '<span class="v-null">unknown</span>';
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

$('#net-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const n = S.net.get(b.closest('.net').dataset.id);
  const text = b.dataset.copy === 'curl' ? asCurl(n) : b.dataset.copy === 'fetch' ? asFetch(n) : (n.resBody?.text || '');
  const status = b.parentElement.querySelector('[role="status"]');
  try { await navigator.clipboard.writeText(text); status.textContent = 'Copied'; } catch { status.textContent = 'Copy failed'; }
  setTimeout(() => (status.textContent = ''), 1800);
});

function applyNetFilter(row, n) {
  const q = $('#net-q').value.trim().toLowerCase();
  const failedOnly = $('#net-failed').checked;
  const failed = n.status === 0 || n.status >= 400;
  row.hidden = (failedOnly && !failed) || (q && !`${n.method} ${n.url} ${n.status}`.toLowerCase().includes(q));
}
function refilterNet() {
  for (const [id, row] of netRows) applyNetFilter(row, S.net.get(id));
  updateCounts();
}
$('#net-q').addEventListener('input', refilterNet);
$('#net-failed').addEventListener('change', refilterNet);
$('#net-clear').addEventListener('click', async () => {
  await send({ type: 'clear:net' });
  S.net.clear(); netRows.clear(); $('#net-list').replaceChildren(); updateCounts();
});

// ───────────────────────── errors ─────────────────────────
const errRows = new Map();
const kindLabel = { error: 'Uncaught error', promise: 'Unhandled promise rejection', console: 'console.error', warn: 'Warning', http: 'Failed request', resource: 'Failed to load' };

function errSummary(e) {
  const loc = e.mapped?.find((f) => !f.lib && f.orig);
  return `
    <span class="ico" aria-hidden="true"></span>
    <span class="msg"><b>${esc(e.message)}</b><small>${esc(kindLabel[e.kind] || e.kind)}${loc ? ` in ${esc(loc.orig.file)}:${loc.orig.line}` : ''}</small></span>
    <span class="times" title="Times seen">${e.count > 1 ? `×${e.count}` : ''}</span>`;
}

function renderErrBody(row, e) {
  const body = row.querySelector('.body');
  const frames = e.mapped || [];
  const appFrames = frames.filter((f) => !f.lib);
  const ng = e.code ? `<a class="ng-help" href="https://angular.dev/errors/NG${String(e.code).padStart(4, '0')}" target="_blank" rel="noopener">What NG${String(e.code).padStart(4, '0')} means and how to fix it</a>` : '';
  const frameLi = (f) => `<li class="${f.lib ? 'lib' : ''}">${f.orig ? fileLink(f.orig.file, f.orig.line, f.orig.col) : `<span>${esc(f.file)}:${f.line}</span>`}<span class="fn">${esc(f.orig?.name || f.fn || '')}</span></li>`;
  body.innerHTML = `
    <pre class="code">${esc(e.message)}</pre>
    ${ng}
    ${e.netId ? '<div class="actions"><button type="button" class="btn small" data-act="show-req">Show request</button></div>' : ''}
    ${frames.length ? `
      <div class="sub"><h4>${appFrames.length ? 'Where it happened in your code' : 'Stack'}</h4>
        <ul class="frames">${(appFrames.length ? appFrames : frames).slice(0, 8).map(frameLi).join('')}</ul>
      </div>
      ${appFrames.length && frames.length > appFrames.length ? `<details class="sub"><summary>Full stack (${frames.length} frames)</summary><ul class="frames">${frames.map(frameLi).join('')}</ul></details>` : ''}`
      : e.stack ? `<details class="sub"><summary>Raw stack</summary><pre class="code">${esc(e.stack)}</pre></details>` : ''}
    <p class="note">First seen ${new Date(e.first).toLocaleTimeString()}${e.count > 1 ? `, last ${new Date(e.last).toLocaleTimeString()}` : ''}</p>`;
}

async function addErr(e) {
  S.errors.set(e.key, e);
  let row = errRows.get(e.key);
  if (!row) {
    row = h(`<details class="item err ${esc(e.kind)}"><summary></summary><div class="body"></div></details>`);
    row.addEventListener('toggle', () => { if (row.open) renderErrBody(row, S.errors.get(e.key)); });
    errRows.set(e.key, row);
    $('#err-list').prepend(row);
  }
  row.querySelector('summary').innerHTML = errSummary(e);
  applyErrFilter(row, e);
  updateCounts();
  if (!e.mapped && e.stack) {
    e.mapped = await mapStack(e.stack);
    row.querySelector('summary').innerHTML = errSummary(e);
    if (row.open) renderErrBody(row, e);
    if (S.selection) renderInspect(); // related-error badge may change
  }
}

function applyErrFilter(row, e) {
  row.hidden = e.kind === 'warn' && !$('#err-warn').checked;
}
$('#err-warn').addEventListener('change', () => { for (const [k, row] of errRows) applyErrFilter(row, S.errors.get(k)); updateCounts(); });
$('#err-clear').addEventListener('click', async () => {
  await send({ type: 'clear:errors' });
  S.errors.clear(); errRows.clear(); $('#err-list').replaceChildren(); updateCounts();
});
$('#err-list').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-act="show-req"]')) {
    const key = [...errRows].find(([, r]) => r.contains(ev.target))?.[0];
    const id = S.errors.get(key)?.netId;
    const row = netRows.get(id);
    selectTab('network');
    if (row) { row.hidden = false; row.open = true; row.scrollIntoView({ block: 'center' }); }
  }
});

function updateCounts() {
  const visibleNet = [...netRows.values()].filter((r) => !r.hidden).length;
  $('#net-count').textContent = S.net.size ? (visibleNet === S.net.size ? S.net.size : `${visibleNet}/${S.net.size}`) : '';
  const errCount = [...S.errors.values()].filter((e) => e.kind !== 'warn').reduce((a, e) => a + e.count, 0);
  $('#err-count').textContent = errCount || '';
  $('#net-empty').hidden = S.net.size > 0;
  $('#err-empty').hidden = [...errRows.values()].some((r) => !r.hidden);
}

// ───────────────────────── tabs ─────────────────────────
const tabs = ['inspect', 'network', 'errors'];
function selectTab(name) {
  for (const t of tabs) {
    const tab = $(`#tab-${t}`), panel = $(`#panel-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.toggleAttribute('focusgroupstart', on);
    tab.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  }
}
for (const t of tabs) $(`#tab-${t}`).addEventListener('click', () => selectTab(t));
// Arrow-key roving focus where `focusgroup` isn't supported yet.
if (!('focusgroup' in HTMLElement.prototype)) {
  for (const t of tabs) $(`#tab-${t}`).tabIndex = t === 'inspect' ? 0 : -1;
  $('.tablist').addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => $(`#tab-${t}`) === document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j == null) return;
    e.preventDefault();
    selectTab(tabs[j]);
    $(`#tab-${tabs[j]}`).focus();
  });
}

// ───────────────────────── settings ─────────────────────────
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  Object.assign(S.settings, settings || {});
  $('#root').value = S.settings.root;
  $('#editor').value = S.settings.editor;
}
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  S.settings.root = $('#root').value.trim();
  S.settings.editor = $('#editor').value;
  await chrome.storage.local.set({ settings: S.settings });
  $('#saved').textContent = 'Saved';
  setTimeout(() => ($('#saved').textContent = ''), 1600);
});

// ───────────────────────── connection / offline ─────────────────────────
function siteOrigin(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.hostname}/*` : null; } catch { return null; }
}

async function showOffline() {
  const box = $('#offline');
  const origin = siteOrigin(S.tabUrl);
  const granted = origin ? await chrome.permissions.contains({ origins: [origin] }) : false;
  if (!origin) {
    box.innerHTML = '<h2>Open your app to start</h2><p>FE Lens works on web pages such as <code>http://localhost:4200</code>.</p>';
  } else if (granted) {
    box.innerHTML = '<h2>Reload the page to connect</h2><p>FE Lens starts with the page, so it can record requests and errors from the first moment.</p><button type="button" class="btn primary" data-act="reload">Reload page</button>';
  } else {
    box.innerHTML = `<h2>FE Lens is off for this site</h2><p>It runs on localhost by default. Turn it on for <code>${esc(new URL(S.tabUrl).hostname)}</code> to inspect it too.</p><button type="button" class="btn primary" data-act="enable">Turn on for this site</button>`;
  }
  box.hidden = false;
}

$('#offline').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'reload') chrome.tabs.reload(S.tabId);
  if (act === 'enable') enableSite();
});

function enableSite() {
  const origin = siteOrigin(S.tabUrl);
  // permissions.request must run synchronously inside the click (before any await).
  chrome.permissions.request({ origins: [origin] }, async (ok) => {
    if (!ok) return;
    const id = origin.replace(/[^a-z0-9]/gi, '_');
    try {
      await chrome.scripting.registerContentScripts([
        { id: `main_${id}`, matches: [origin], js: ['content/hook.main.js'], runAt: 'document_start', world: 'MAIN', allFrames: false },
        { id: `iso_${id}`, matches: [origin], js: ['content/css-inspect.js', 'content/picker.js', 'content/bridge.js'], runAt: 'document_start' },
      ]);
    } catch { /* already registered */ }
    chrome.tabs.reload(S.tabId);
  });
}

// ───────────────────────── loading a tab ─────────────────────────
function resetView() {
  S.net.clear(); S.errors.clear(); S.selection = null; S.framework = null;
  netRows.clear(); errRows.clear();
  $('#net-list').replaceChildren(); $('#err-list').replaceChildren();
  setPicking(false);
  updateCounts();
}

// `sidepanel/index.html?tabId=123` pins the panel to one tab (handy when the
// panel is opened as a normal page for debugging/testing).
const PINNED_TAB = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function connect() {
  resetView();
  const [tab] = PINNED_TAB
    ? [await chrome.tabs.get(PINNED_TAB).catch(() => null)]
    : await chrome.tabs.query({ active: true, windowId: S.windowId });
  if (!tab) return;
  S.tabId = tab.id;
  S.tabUrl = tab.url || '';
  const snap = await send({ type: 'snapshot' });
  if (!snap) { renderFramework(); renderInspect(); return showOffline(); }
  $('#offline').hidden = true;
  S.framework = snap.framework;
  S.selection = snap.selection;
  setPicking(!!snap.picking);
  for (const n of snap.net) { S.net.set(n.id, n); upsertNet(n); }
  for (const e of snap.errors) addErr(e);
  renderFramework();
  renderInspect();
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'evt' || sender.tab?.id !== S.tabId) return;
  const p = msg.payload;
  switch (msg.evt) {
    case 'framework': S.framework = p; renderFramework(); if (!S.selection) renderInspect(); break;
    case 'net:start': S.net.set(p.id, p); upsertNet(p); break;
    case 'net:end': { const n = S.net.get(p.id); if (n) { Object.assign(n, p); upsertNet(n); } break; }
    case 'err:add': addErr(p); break;
    case 'err:update': { const e = S.errors.get(p.key); if (e) { e.count = p.count; e.last = p.last; addErr(e); } break; }
    case 'selection': S.selection = p; setPicking(false); selectTab('inspect'); renderInspect(); break;
    case 'picker': setPicking(p.active); break;
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!PINNED_TAB && windowId === S.windowId && tabId !== S.tabId) connect();
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId !== S.tabId) return;
  if (info.url) S.tabUrl = info.url;
  if (info.status === 'loading' && info.url === undefined && tab.url === S.tabUrl) {
    // Full reload: page buffers are gone.
    resetView(); renderInspect();
  }
  if (info.status === 'complete') connect();
});

(async () => {
  const win = await chrome.windows.getCurrent();
  S.windowId = win.id;
  await loadSettings();
  await connect();
})();
