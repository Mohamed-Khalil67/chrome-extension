// FE Lens side panel shell: tabs, settings, connection to the inspected tab,
// live events, and the health strip. Feature logic lives in the tab modules.
import { S, $, $$, esc, send, on } from './core.js';
import { clearSourceCache } from './sourcemap.js';
import * as network from './network.js';
import * as errors from './errors.js';
import * as inspect from './inspect.js';

// ───────────── framework badge ─────────────
function renderFramework() {
  const fw = S.framework;
  const el = $('#fw');
  if (!fw?.name) { el.innerHTML = '<span class="badge">No framework detected</span>'; return; }
  const parts = [`<span class="badge lens">${esc(fw.name)} ${esc(fw.version || '')}</span>`];
  if (fw.name === 'Angular') {
    parts.push(fw.dev ? '<span class="badge">dev</span>' : '<span class="badge warn" title="Production build: component details are not available">prod build</span>');
    if (fw.zoneless) parts.push('<span class="badge">zoneless</span>');
  }
  el.innerHTML = parts.join('');
}

// ───────────── health strip + tab counts ─────────────
function renderCounts() {
  const errN = errors.errorCount();
  const failN = network.failedCount();
  const layoutN = inspect.layoutWarnings();
  $('#net-count').textContent = S.net.size || '';
  $('#err-count').textContent = errN || '';
  $('#err-count').title = errN ? `${errN} JS error${errN > 1 ? 's' : ''}` : '';
  const strip = [];
  if (errN) strip.push(`<button type="button" class="health bad" data-go="errors">${errN} error${errN > 1 ? 's' : ''}</button>`);
  if (failN) strip.push(`<button type="button" class="health bad" data-go="failed">${failN} failed request${failN > 1 ? 's' : ''}</button>`);
  if (layoutN) strip.push(`<button type="button" class="health warn" data-go="layout">${layoutN} layout issue${layoutN > 1 ? 's' : ''}</button>`);
  $('#health').innerHTML = strip.join('');
  $('#health').hidden = !strip.length;
}
on('counts', renderCounts);
on('errors-mapped', () => { if (S.selection) inspect.render(); });

$('#health').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]')?.dataset.go;
  if (go === 'errors') { selectTab('network'); network.showErrors(); }
  if (go === 'failed') { selectTab('network'); network.showProblems(); }
  if (go === 'layout') { selectTab('inspect'); inspect.showLayout(); }
});

// ───────────── tabs ─────────────
const tabs = ['inspect', 'network'];
function selectTab(name) {
  for (const t of tabs) {
    const tab = $(`#tab-${t}`), panel = $(`#panel-${t}`);
    const onTab = t === name;
    tab.setAttribute('aria-selected', String(onTab));
    tab.toggleAttribute('focusgroupstart', onTab);
    tab.tabIndex = onTab ? 0 : -1;
    panel.hidden = !onTab;
  }
}
for (const t of tabs) $(`#tab-${t}`).addEventListener('click', () => selectTab(t));
if (!('focusgroup' in HTMLElement.prototype)) {
  for (const t of tabs) $(`#tab-${t}`).tabIndex = t === 'inspect' ? 0 : -1;
  $('.tablist').addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => $(`#tab-${t}`) === document.activeElement);
    if (i < 0) return;
    const j = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
    if (j == null) return;
    e.preventDefault();
    selectTab(tabs[j]);
    $(`#tab-${tabs[j]}`).focus();
  });
}

// ───────────── pick ─────────────
async function startPick() {
  const ok = await send({ type: S.picking ? 'picker:stop' : 'picker:start' });
  if (ok === undefined) return showOffline();
  setPicking(!S.picking);
}
function setPicking(onState) {
  S.picking = onState;
  const b = $('#pick');
  b.setAttribute('aria-pressed', String(onState));
  b.querySelector('span').textContent = onState ? 'Picking… (Esc)' : 'Pick';
}
$('#pick').addEventListener('click', startPick);

// ───────────── settings ─────────────
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

// ───────────── offline / enable on other sites ─────────────
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
  // permissions.request must run inside the click, before any await.
  chrome.permissions.request({ origins: [origin] }, async (ok) => {
    if (!ok) return;
    const id = origin.replace(/[^a-z0-9]/gi, '_');
    try {
      await chrome.scripting.registerContentScripts([
        { id: `main_${id}`, matches: [origin], js: ['content/hook.main.js'], runAt: 'document_start', world: 'MAIN' },
        { id: `iso_${id}`, matches: [origin], js: ['content/css-inspect.js', 'content/picker.js', 'content/bridge.js'], runAt: 'document_start' },
      ]);
    } catch { /* already registered */ }
    chrome.tabs.reload(S.tabId);
  });
}

// ───────────── connecting to a tab ─────────────
function resetView() {
  S.selection = null; S.framework = null; S.scripts = [];
  network.clear();
  errors.clear();
  setPicking(false);
  clearSourceCache();
}

// `index.html?tabId=123` pins the panel to one tab (debugging/testing).
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
  if (!snap) { renderFramework(); inspect.render(); return showOffline(); }
  $('#offline').hidden = true;
  S.framework = snap.framework;
  S.selection = snap.selection;
  setPicking(!!snap.picking);
  for (const n of snap.net) { S.net.set(n.id, n); network.upsert(n); }
  for (const e of snap.errors) errors.add(e);
  renderFramework();
  inspect.render();
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'evt' || sender.tab?.id !== S.tabId) return;
  const p = msg.payload;
  switch (msg.evt) {
    case 'framework': S.framework = p; renderFramework(); if (!S.selection) inspect.render(); break;
    case 'net:start': S.net.set(p.id, p); network.upsert(p); break;
    case 'net:end': { const n = S.net.get(p.id); if (n) { Object.assign(n, p); network.upsert(n); } break; }
    case 'res': network.addResources(p); break;
    case 'err:add': errors.add(p); break;
    case 'err:update': errors.update(p); break;
    case 'selection': S.selection = p; setPicking(false); selectTab('inspect'); inspect.render(); break;
    case 'picker': setPicking(p.active); break;
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!PINNED_TAB && windowId === S.windowId && tabId !== S.tabId) connect();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== S.tabId) return;
  if (info.url) S.tabUrl = info.url;
  if (info.status === 'complete') connect();
});

// ───────────── start ─────────────
network.init();
inspect.init({ startPick, gotoErrors: () => { selectTab('network'); network.showErrors(); } });

(async () => {
  const win = await chrome.windows.getCurrent();
  S.windowId = win.id;
  await loadSettings();
  await connect();
})();
