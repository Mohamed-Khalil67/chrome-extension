// Angular Lens side panel shell: tabs, settings, connection to the inspected
// tab, live events and the health strip. Feature logic lives in features/.
import { PANEL_PORT, type RuntimeEvent } from '../shared/messages';
import { clearSourceCache } from '../shared/sourcemap';
import { emit, on, type TabName } from './core/bus';
import { $, closest, esc, input } from './core/dom';
import { DEFAULT_IDE_PORT, openViaIde } from './core/editor';
import { send } from './core/rpc';
import { S, type Editor } from './core/state';
import * as con from './features/console/console';
import * as errors from './features/console/errors';
import * as inspect from './features/inspect/inspect';
import * as network from './features/network/network';
import * as requests from './features/requests/requests';

// ───────────── framework badge ─────────────
function renderFramework(): void {
  const fw = S.framework;
  const el = $('#fw');
  if (!fw?.name) { el.innerHTML = '<span class="badge">No Angular app detected</span>'; return; }
  const parts = [`<span class="badge lens">${esc(fw.name)} ${esc(fw.version ?? '')}</span>`];
  parts.push(fw.dev ? '<span class="badge">dev</span>' : '<span class="badge warn" title="Production build: component details are not available">prod build</span>');
  if (fw.zoneless) parts.push('<span class="badge">zoneless</span>');
  el.innerHTML = parts.join('');
}

// ───────────── health strip + tab counts ─────────────
function renderCounts(): void {
  const errN = errors.errorCount();
  const failN = network.failedCount();
  const layoutN = inspect.layoutWarnings();
  $('#net-count').textContent = String(network.apiCount() || '');
  $('#net-fail').textContent = String(failN || '');
  $('#net-fail').title = failN ? `${failN} failed call${failN > 1 ? 's' : ''}` : '';
  $('#con-count').textContent = String(con.total() || '');
  $('#con-err').textContent = String(errN || '');
  $('#con-err').title = errN ? `${errN} error${errN > 1 ? 's' : ''}` : '';
  const strip: string[] = [];
  if (errN) strip.push(`<button type="button" class="health bad" data-go="errors">${errN} error${errN > 1 ? 's' : ''}</button>`);
  if (failN) strip.push(`<button type="button" class="health bad" data-go="failed">${failN} failed API call${failN > 1 ? 's' : ''}</button>`);
  if (layoutN) strip.push(`<button type="button" class="health warn" data-go="layout">${layoutN} layout issue${layoutN > 1 ? 's' : ''}</button>`);
  $('#health').innerHTML = strip.join('');
  $('#health').hidden = !strip.length;
}
on('counts', renderCounts);
on('errors-mapped', () => { if (S.selection) inspect.render(); });

function showErrors(): void { selectTab('console'); con.showErrors(); }
on('goto-errors', showErrors);

$('#health').addEventListener('click', (e) => {
  switch (closest(e, '[data-go]')?.dataset.go) {
    case 'errors': showErrors(); break;
    case 'failed': selectTab('network'); network.showProblems(); break;
    case 'layout': selectTab('inspect'); inspect.showLayout(); break;
  }
});

// ───────────── tabs (left to right, as shown) ─────────────
const TABS: TabName[] = ['console', 'network', 'inspect', 'requests'];
const FIRST_TAB: TabName = 'console';
function selectTab(name: TabName): void {
  for (const t of TABS) {
    const tab = $(`#tab-${t}`), panel = $(`#panel-${t}`);
    const onTab = t === name;
    tab.setAttribute('aria-selected', String(onTab));
    tab.toggleAttribute('focusgroupstart', onTab);
    tab.tabIndex = onTab ? 0 : -1;
    panel.hidden = !onTab;
  }
}
for (const t of TABS) $(`#tab-${t}`).addEventListener('click', () => selectTab(t));
on('goto-tab', selectTab);
if (!('focusgroup' in HTMLElement.prototype)) {
  for (const t of TABS) $(`#tab-${t}`).tabIndex = t === FIRST_TAB ? 0 : -1;
  $('.tablist').addEventListener('keydown', (e) => {
    const i = TABS.findIndex((t) => $(`#tab-${t}`) === document.activeElement);
    if (i < 0) return;
    const keys: Record<string, number> = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i - 1 + TABS.length) % TABS.length, Home: 0, End: TABS.length - 1 };
    const next = TABS[keys[e.key] ?? -1];
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    $(`#tab-${next}`).focus();
  });
}

// ───────────── pick ─────────────
async function startPick(): Promise<void> {
  const ok = await send({ type: S.picking ? 'picker:stop' : 'picker:start' });
  if (ok === undefined) { void showOffline(); return; }
  setPicking(!S.picking);
}
function setPicking(onState: boolean): void {
  S.picking = onState;
  const b = $('#pick');
  b.setAttribute('aria-pressed', String(onState));
  $('span', b).textContent = onState ? 'Picking… (Esc)' : 'Pick';
}
$('#pick').addEventListener('click', () => { void startPick(); });

// ───────────── settings ─────────────
const isEditor = (v: unknown): v is Editor => v === 'vscode' || v === 'cursor' || v === 'webstorm';
async function loadSettings(): Promise<void> {
  const { settings } = await chrome.storage.local.get('settings');
  if (typeof settings === 'object' && settings !== null) {
    const root: unknown = Reflect.get(settings, 'root');
    const editor: unknown = Reflect.get(settings, 'editor');
    const idePort: unknown = Reflect.get(settings, 'idePort');
    const apiBase: unknown = Reflect.get(settings, 'apiBase');
    if (typeof root === 'string') S.settings.root = root;
    if (isEditor(editor)) S.settings.editor = editor;
    if (typeof idePort === 'number' && idePort > 0) S.settings.idePort = idePort;
    if (typeof apiBase === 'string') S.settings.apiBase = apiBase;
  }
  input('#root').value = S.settings.root;
  $<HTMLSelectElement>('#editor').value = S.settings.editor;
  input('#ide-port').value = String(S.settings.idePort || DEFAULT_IDE_PORT);
  input('#api-base').value = S.settings.apiBase;
}
function readSettingsForm(): void {
  S.settings.root = input('#root').value.trim();
  const editor = $<HTMLSelectElement>('#editor').value;
  if (isEditor(editor)) S.settings.editor = editor;
  S.settings.idePort = Number(input('#ide-port').value) || DEFAULT_IDE_PORT;
  S.settings.apiBase = input('#api-base').value.trim();
}
$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    readSettingsForm();
    await chrome.storage.local.set({ settings: S.settings });
    emit('settings-changed');
    $('#saved').textContent = 'Saved';
    setTimeout(() => { $('#saved').textContent = ''; }, 1600);
  })();
});

// Does the editor link actually reach the IDE? Says so instead of failing silently.
$('#ide-test').addEventListener('click', () => {
  void (async () => {
    readSettingsForm();
    const status = $('#ide-status');
    if (S.settings.editor !== 'webstorm') { status.textContent = `${S.settings.editor} opens through its own URL; no port needed.`; return; }
    if (!S.settings.root) { status.textContent = 'Set the project folder first.'; return; }
    status.textContent = 'Checking…';
    const ok = await openViaIde(`${S.settings.root.replaceAll('\\', '/').replace(/\/$/, '')}/package.json`, 1, 1);
    status.textContent = ok
      ? 'WebStorm answered — links will open there.'
      : `No answer on port ${S.settings.idePort}. Is WebStorm running, with "Allow unsigned requests" on?`;
  })();
});

// ───────────── offline / enable on other sites ─────────────
function siteOrigin(url: string): string | null {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.hostname}/*` : null; } catch { return null; }
}

async function showOffline(): Promise<void> {
  const box = $('#offline');
  const origin = siteOrigin(S.tabUrl);
  const granted = origin ? await chrome.permissions.contains({ origins: [origin] }) : false;
  if (!origin) {
    box.innerHTML = '<h2>Open your app to start</h2><p>Angular Lens works on your Angular app, for example <code>http://localhost:4200</code>.</p>';
  } else if (granted) {
    box.innerHTML = '<h2>Reload the page to connect</h2><p>Angular Lens starts with the page, so it can record API calls and errors from the first moment.</p><button type="button" class="btn primary" data-act="reload">Reload page</button>';
  } else {
    box.innerHTML = `<h2>Angular Lens is off for this site</h2><p>It runs on localhost by default. Turn it on for <code>${esc(new URL(S.tabUrl).hostname)}</code> to inspect it too.</p><button type="button" class="btn primary" data-act="enable">Turn on for this site</button>`;
  }
  box.hidden = false;
}
$('#offline').addEventListener('click', (e) => {
  const act = closest(e, '[data-act]')?.dataset.act;
  if (act === 'reload' && S.tabId != null) void chrome.tabs.reload(S.tabId);
  if (act === 'enable') enableSite();
});
function enableSite(): void {
  const origin = siteOrigin(S.tabUrl);
  if (!origin) return;
  // permissions.request must run inside the click, before any await.
  chrome.permissions.request({ origins: [origin] }, (ok) => {
    if (!ok) return;
    const id = origin.replace(/[^a-z0-9]/gi, '_');
    void (async () => {
      try {
        await chrome.scripting.registerContentScripts([
          { id: `main_${id}`, matches: [origin], js: ['content/hook.main.js'], runAt: 'document_start', world: 'MAIN' },
          { id: `iso_${id}`, matches: [origin], js: ['content/isolated.js'], runAt: 'document_start' },
        ]);
      } catch { /* already registered */ }
      if (S.tabId != null) await chrome.tabs.reload(S.tabId);
    })();
  });
}

// ───────────── connecting to a tab ─────────────
function resetView(): void {
  S.selection = null; S.framework = null; S.scripts = [];
  network.clear();
  con.clear();
  errors.clear();
  setPicking(false);
  clearSourceCache();
}

// While this port is open, Alt+click on the page selects an element.
let port: chrome.runtime.Port | null = null;
function openPort(tabId: number): void {
  port?.disconnect();
  port = chrome.tabs.connect(tabId, { name: PANEL_PORT });
  port.onDisconnect.addListener(() => { port = null; });
}

// `index.html?tabId=123` pins the panel to one tab (debugging/testing).
const PINNED_TAB = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function connect(): Promise<void> {
  resetView();
  const tab = PINNED_TAB
    ? await chrome.tabs.get(PINNED_TAB).catch(() => null)
    : (await chrome.tabs.query({ active: true, windowId: S.windowId ?? chrome.windows.WINDOW_ID_CURRENT }))[0];
  if (tab?.id == null) return;
  S.tabId = tab.id;
  S.tabUrl = tab.url ?? '';
  const snap = await send({ type: 'snapshot' });
  if (!snap) { renderFramework(); inspect.render(); void showOffline(); return; }
  $('#offline').hidden = true;
  openPort(tab.id);
  S.framework = snap.framework;
  S.selection = snap.selection;
  setPicking(snap.picking);
  for (const n of snap.net) { S.net.set(n.id, n); network.upsert(n); }
  for (const e of snap.errors) void errors.add(e);
  for (const m of snap.logs) con.addLog(m);
  renderFramework();
  $('#con-empty').innerHTML = con.hints();
  inspect.render();
}

chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
  // Only our own content script, in the tab this panel watches.
  if (sender.id !== chrome.runtime.id || sender.tab?.id !== S.tabId) return;
  if (typeof msg !== 'object' || msg === null || Reflect.get(msg, 'type') !== 'evt') return;
  const ev = msg as RuntimeEvent; // sent by our content script (see content/isolated.ts)
  switch (ev.evt) {
    case 'framework': S.framework = ev.payload; renderFramework(); if (!S.selection) inspect.render(); break;
    case 'net:start': S.net.set(ev.payload.id, ev.payload); network.upsert(ev.payload); break;
    case 'net:end': { const n = S.net.get(ev.payload.id); if (n) { Object.assign(n, ev.payload); network.upsert(n); } break; }
    case 'err:add': void errors.add(ev.payload); break;
    case 'err:update': errors.update(ev.payload); break;
    case 'log': con.addLog(ev.payload); break;
    case 'selection': S.selection = ev.payload; setPicking(false); selectTab('inspect'); inspect.render(); break;
    case 'picker': setPicking(ev.payload.active); break;
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!PINNED_TAB && windowId === S.windowId && tabId !== S.tabId) void connect();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== S.tabId) return;
  if (info.url) S.tabUrl = info.url;
  if (info.status === 'complete') void connect();
});

// ───────────── start ─────────────
network.init();
network.onOpenError((key) => { selectTab('console'); con.openError(key); });
con.init();
inspect.init(() => { void startPick(); });
void (async () => {
  const win = await chrome.windows.getCurrent();
  S.windowId = win.id ?? null;
  await loadSettings();
  await requests.init();
  await connect();
})();
