// Isolated-world content script: owns the per-page buffers (network, errors,
// console), relays page-hook events to the side panel, and runs the picker and
// CSS analysis on request.
import {
  IN, OUT, PANEL_PORT, readPageEvent,
  type BadgeMsg, type ErrPayload, type ErrorEntry, type EvalResult, type FrameworkInfo, type InspectResult,
  type HoverInfo, type LogMsg, type NetEntry, type PanelEvent, type PanelRequest, type ResponseOf,
  type RuntimeEvent, type Selection, type Snapshot, type PageRequest,
} from '../shared/messages';
import { analyze } from './css-inspect';
import * as picker from './picker';

declare global { interface Window { __feLensBridge?: boolean } }

(() => {
  if (window.__feLensBridge) return;
  window.__feLensBridge = true;

  const MAX_NET = 600;
  const MAX_ERR = 200;
  const MAX_LOG = 500;

  const state = {
    framework: null as FrameworkInfo | null,
    net: new Map<string, NetEntry>(), // insertion ordered
    errors: new Map<string, ErrorEntry>(), // fingerprint → grouped error
    logs: [] as LogMsg[], // oldest first
    selection: null as Selection | null,
  };
  const pendingEval = new Map<number, (r: EvalResult) => void>();
  let evalSeq = 0;

  const toPanel = (e: PanelEvent): void => {
    const msg: RuntimeEvent = { type: 'evt', ...e };
    chrome.runtime.sendMessage(msg).catch(() => { /* panel closed */ });
  };

  let badgeTimer = 0;
  const updateBadge = (): void => {
    clearTimeout(badgeTimer);
    badgeTimer = window.setTimeout(() => {
      let n = 0;
      for (const e of state.errors.values()) if (e.kind !== 'warn') n += e.count;
      const msg: BadgeMsg = { type: 'badge', errors: n };
      chrome.runtime.sendMessage(msg).catch(() => {});
    }, 250);
  };

  const dropOldest = <K, V>(m: Map<K, V>, max: number): void => {
    if (m.size <= max) return;
    const first = m.keys().next();
    if (!first.done) m.delete(first.value);
  };

  // ── synchronous RPC into the page world (dispatchEvent is synchronous) ──
  let rid = 0;
  // Set by the 'reply' event, which the page dispatches during our dispatchEvent call.
  const replies: { last: { rid: number; payload: unknown } | null } = { last: null };
  function rpc(type: PageRequest['type'], el: Element | null, extra: Partial<PageRequest> = {}): unknown {
    const id = ++rid;
    const q = el ? `q${id}` : null;
    if (el && q) el.setAttribute('data-felens-q', q);
    replies.last = null;
    try {
      const req: PageRequest = { type, rid: id, q, ...extra };
      document.dispatchEvent(new CustomEvent(IN, { detail: JSON.stringify(req) }));
    } finally {
      el?.removeAttribute('data-felens-q');
    }
    const reply = lastReply();
    return reply?.rid === id ? reply.payload : null;
  }
  // A function call, so the compiler doesn't assume `replies.last` is still null.
  const lastReply = (): { rid: number; payload: unknown } | null => replies.last;

  function fingerprint(e: ErrPayload): string {
    const frame = e.stack.split('\n').find((l) => /:\d+:\d+/.test(l)) ?? '';
    return `${e.kind === 'warn' ? 'w' : 'e'}|${e.message.slice(0, 300)}|${frame.trim()}`;
  }

  function addError(e: ErrPayload): void {
    const key = fingerprint(e);
    const prev = state.errors.get(key);
    if (prev) {
      prev.count++;
      prev.last = e.time;
      toPanel({ evt: 'err:update', payload: { key, count: prev.count, last: prev.last } });
    } else {
      const entry: ErrorEntry = { ...e, key, count: 1, first: e.time, last: e.time };
      state.errors.set(key, entry);
      dropOldest(state.errors, MAX_ERR);
      toPanel({ evt: 'err:add', payload: entry });
    }
    updateBadge();
  }

  document.addEventListener(OUT, (ev) => {
    const msg = ev instanceof CustomEvent ? readPageEvent(ev.detail) : null;
    if (!msg) return;
    switch (msg.type) {
      case 'reply':
        replies.last = msg.payload;
        break;
      case 'framework':
        state.framework = msg.payload;
        toPanel({ evt: 'framework', payload: msg.payload });
        break;
      case 'net:start':
        state.net.set(msg.payload.id, msg.payload);
        dropOldest(state.net, MAX_NET);
        toPanel({ evt: 'net:start', payload: msg.payload });
        break;
      case 'net:end': {
        const p = msg.payload;
        const entry = state.net.get(p.id);
        if (!entry) break;
        Object.assign(entry, p);
        toPanel({ evt: 'net:end', payload: p });
        if (p.status === 0 || p.status >= 400) {
          const what = p.status ? `${p.status} ${p.statusText}`.trim() : p.statusText || 'failed';
          addError({ kind: 'http', message: `${entry.method} ${entry.url} → ${what}`, stack: entry.initiator, code: null, time: Date.now(), netId: entry.id });
        }
        break;
      }
      case 'err':
        addError(msg.payload);
        break;
      case 'log':
        state.logs.push(msg.payload);
        if (state.logs.length > MAX_LOG) state.logs.shift();
        toPanel({ evt: 'log', payload: msg.payload });
        break;
      case 'eval:done': {
        const { id, ...result } = msg.payload;
        const respond = pendingEval.get(id);
        pendingEval.delete(id);
        respond?.(result);
        break;
      }
    }
  });

  const pathToEl = (path: number[]): Element | null => {
    let n: Element | null | undefined = document.documentElement;
    for (const i of path) { n = n?.children[i]; if (!n) return null; }
    return n ?? null;
  };

  function inspect(el: Element): Selection {
    // The page hook answers with an InspectResult (our own code on the other side).
    const fw = (rpc('inspect', el) as InspectResult | null) ?? { chain: [] };
    const r = el.getBoundingClientRect();
    // Enough detail to find the element's line in its template.
    const attrs = [...el.attributes].map((a) => a.name).filter((n) => !/^(_ng|ng-|data-felens|class$|style$|id$)/.test(n));
    const ownText = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())?.textContent?.trim().slice(0, 40) ?? '';
    const sel: Selection = {
      element: fw.element ?? el.localName,
      elementIsHost: !!fw.elementIsHost,
      desc: { tag: el.localName, id: el.id, classes: [...el.classList].filter((c) => !c.startsWith('ng-')), attrs, text: ownText },
      framework: fw.framework ?? state.framework,
      chain: fw.chain,
      listeners: fw.listeners ?? [],
      directives: fw.directives ?? [],
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      text: (el instanceof HTMLElement ? el.innerText : el.textContent ?? '').trim().slice(0, 80),
      css: analyze(el),
    };
    if (fw.error) sel.error = fw.error;
    state.selection = sel;
    return sel;
  }

  picker.setHoverInfo((el) => rpc('hover', el) as HoverInfo | null);

  function pick(): void {
    picker.start((el) => toPanel({ evt: 'selection', payload: inspect(el) }));
    toPanel({ evt: 'picker', payload: { active: true } });
  }

  function handle(msg: PanelRequest, reply: (r: ResponseOf<PanelRequest>) => void): boolean {
    switch (msg.type) {
      case 'snapshot': {
        // The hook answers 'detect' with a FrameworkInfo.
        state.framework ??= rpc('detect', null) as FrameworkInfo | null;
        const snap: Snapshot = {
          url: location.href,
          framework: state.framework,
          net: [...state.net.values()],
          errors: [...state.errors.values()],
          logs: state.logs,
          selection: state.selection,
          picking: picker.isPicking(),
        };
        reply(snap);
        return false;
      }
      case 'scripts': {
        // Same-origin scripts loaded so far (main bundle + lazy route chunks).
        const urls = new Set<string>();
        for (const s of document.scripts) if (s.src) urls.add(s.src);
        for (const e of performance.getEntriesByType('resource')) {
          if (/\.m?js(\?|$)/.test(e.name) && e.name.startsWith(location.origin)) urls.add(e.name);
        }
        reply([...urls].filter((u) => u.startsWith(location.origin)));
        return false;
      }
      case 'picker:toggle':
      case 'picker:start':
        if (picker.isPicking() && msg.type === 'picker:toggle') {
          picker.stop();
          toPanel({ evt: 'picker', payload: { active: false } });
        } else pick();
        reply(true);
        return false;
      case 'picker:stop':
        picker.stop();
        reply(true);
        return false;
      case 'eval': {
        // The page answers asynchronously (the code may await): keep the
        // channel open and reply when 'eval:done' arrives.
        const id = ++evalSeq;
        const timer = setTimeout(() => {
          if (!pendingEval.delete(id)) return;
          reply({ ok: false, error: 'No result after 30 s: the promise never settled.' });
        }, 30000);
        pendingEval.set(id, (r) => { clearTimeout(timer); reply(r); });
        const sel = picker.selected();
        rpc('eval', sel?.isConnected ? sel : null, { id, code: msg.code });
        return true;
      }
      case 'clear:logs':
        state.logs = [];
        reply(true);
        return false;
      case 'clear:net':
        state.net.clear();
        reply(true);
        return false;
      case 'clear:errors':
        state.errors.clear();
        updateBadge();
        reply(true);
        return false;
      case 'reinspect': {
        const el = picker.selected();
        reply(el?.isConnected ? inspect(el) : null);
        return false;
      }
      case 'select:parent': {
        const el = picker.selected()?.parentElement;
        if (el && el !== document.documentElement) { picker.select(el); reply(inspect(el)); } else reply(null);
        return false;
      }
      case 'select:path': {
        const el = pathToEl(msg.path);
        if (el) { picker.select(el); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); reply(inspect(el)); } else reply(null);
        return false;
      }
      case 'selection:clear':
        picker.clear();
        state.selection = null;
        reply(true);
        return false;
    }
  }

  // Alt+click picking, while at least one side panel is connected to this tab.
  let panels = 0;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT || port.sender?.id !== chrome.runtime.id) return;
    panels++;
    picker.setAltPick((el) => toPanel({ evt: 'selection', payload: inspect(el) }));
    port.onDisconnect.addListener(() => {
      panels--;
      if (panels <= 0) { panels = 0; picker.setAltPick(null); }
    });
  });

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    // Only the extension's own pages can send runtime messages here.
    if (sender.id !== chrome.runtime.id || typeof msg !== 'object' || msg === null || !('type' in msg)) return false;
    return handle(msg as PanelRequest, sendResponse);
  });
})();
