// Angular Lens — bridge (isolated world). Owns the per-page buffers (network +
// errors), relays page-hook events to the side panel, and runs the picker and
// CSS analysis on request.
(() => {
  if (globalThis.FeLensBridge) return;

  const OUT = '__felens:out';
  const IN = '__felens:in';
  const MAX_NET = 600;
  const MAX_ERR = 200;
  const MAX_LOG = 500;

  const state = {
    framework: null,
    net: new Map(), // id → entry (insertion ordered)
    errors: new Map(), // fingerprint → grouped error
    logs: [], // console messages, oldest first
    selection: null,
  };
  const pendingEval = new Map(); // id → sendResponse
  let evalSeq = 0;

  const toPanel = (type, payload) => {
    chrome.runtime.sendMessage({ type: 'evt', evt: type, payload }).catch(() => { /* panel closed */ });
  };

  let badgeTimer = 0;
  const updateBadge = () => {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      let n = 0;
      for (const e of state.errors.values()) if (e.kind !== 'warn') n += e.count;
      chrome.runtime.sendMessage({ type: 'badge', errors: n }).catch(() => {});
    }, 250);
  };

  // ── synchronous RPC into the page world (dispatchEvent is synchronous) ──
  let rid = 0;
  let lastReply = null;
  function rpc(type, el, extra = {}) {
    const id = ++rid;
    const q = el ? `q${id}` : null;
    if (el) el.setAttribute('data-felens-q', q);
    lastReply = null;
    try {
      document.dispatchEvent(new CustomEvent(IN, { detail: JSON.stringify({ type, rid: id, q, ...extra }) }));
    } finally {
      if (el) el.removeAttribute('data-felens-q');
    }
    return lastReply?.rid === id ? lastReply.payload : null;
  }

  function fingerprint(e) {
    const frame = (e.stack || '').split('\n').find((l) => /:\d+:\d+/.test(l)) || '';
    return `${e.kind === 'warn' ? 'w' : 'e'}|${e.message.slice(0, 300)}|${frame.trim()}`;
  }

  function addError(e) {
    const key = fingerprint(e);
    const prev = state.errors.get(key);
    if (prev) {
      prev.count++;
      prev.last = e.time;
      toPanel('err:update', { key, count: prev.count, last: prev.last });
    } else {
      const entry = { ...e, key, count: 1, first: e.time, last: e.time };
      state.errors.set(key, entry);
      if (state.errors.size > MAX_ERR) state.errors.delete(state.errors.keys().next().value);
      toPanel('err:add', entry);
    }
    updateBadge();
  }

  document.addEventListener(OUT, (ev) => {
    let msg;
    try { msg = JSON.parse(ev.detail); } catch { return; }
    const { type, payload } = msg;
    switch (type) {
      case 'reply':
        lastReply = payload;
        break;
      case 'framework':
        state.framework = payload;
        toPanel('framework', payload);
        break;
      case 'net:start': {
        state.net.set(payload.id, payload);
        if (state.net.size > MAX_NET) state.net.delete(state.net.keys().next().value);
        toPanel('net:start', payload);
        break;
      }
      case 'net:end': {
        const entry = state.net.get(payload.id);
        if (!entry) break;
        Object.assign(entry, payload);
        toPanel('net:end', payload);
        if (payload.status === 0 || payload.status >= 400) {
          addError({
            kind: 'http',
            message: `${entry.method} ${entry.url} → ${payload.status || payload.statusText || 'failed'}${payload.status ? ' ' + (payload.statusText || '') : ''}`.trim(),
            stack: entry.initiator || '',
            code: null,
            time: Date.now(),
            netId: entry.id,
          });
        }
        break;
      }
      case 'res': {
        for (const r of payload) {
          state.net.set(r.id, r);
          if (state.net.size > MAX_NET) state.net.delete(state.net.keys().next().value);
        }
        toPanel('res', payload);
        break;
      }
      case 'err':
        addError(payload);
        break;
      case 'log':
        state.logs.push(payload);
        if (state.logs.length > MAX_LOG) state.logs.shift();
        toPanel('log', payload);
        break;
      case 'eval:done': {
        const respond = pendingEval.get(payload.id);
        pendingEval.delete(payload.id);
        respond?.(payload);
        break;
      }
    }
  });

  const pathToEl = (path) => {
    if (!Array.isArray(path)) return null;
    let n = document.documentElement;
    for (const i of path) { n = n?.children[i]; if (!n) return null; }
    return n;
  };

  function inspect(el) {
    const fw = rpc('inspect', el) || { chain: [] };
    let css = null;
    try { css = globalThis.FeLensCss.analyze(el); } catch (e) { css = { error: String(e?.message || e) }; }
    const r = el.getBoundingClientRect();
    // Enough detail to find the element's line in its template.
    const attrs = [...el.attributes]
      .map((a) => a.name)
      .filter((n) => !/^(_ng|ng-|data-felens|class$|style$|id$)/.test(n));
    state.selection = {
      element: fw.element || el.localName,
      elementIsHost: !!fw.elementIsHost,
      desc: {
        tag: el.localName,
        id: el.id || '',
        classes: [...el.classList].filter((c) => !c.startsWith('ng-')),
        attrs,
        text: (el.childNodes.length && [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim())?.textContent.trim().slice(0, 40)) || '',
      },
      framework: fw.framework || state.framework,
      chain: fw.chain || [],
      listeners: fw.listeners || [],
      directives: fw.directives || [],
      error: fw.error,
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      text: (el.innerText || '').trim().slice(0, 80),
      css,
    };
    return state.selection;
  }

  function pick() {
    globalThis.FeLensPicker.start((el) => {
      const sel = inspect(el);
      toPanel('selection', sel);
    });
    toPanel('picker', { active: true });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'snapshot': {
        if (!state.framework) state.framework = rpc('detect');
        sendResponse({
          url: location.href,
          framework: state.framework,
          net: [...state.net.values()],
          errors: [...state.errors.values()],
          logs: state.logs,
          selection: state.selection,
          picking: globalThis.FeLensPicker.picking,
        });
        return;
      }
      case 'scripts': {
        // Same-origin scripts loaded so far (main bundle + lazy route chunks).
        const urls = new Set();
        for (const s of document.scripts) if (s.src) urls.add(s.src);
        for (const e of performance.getEntriesByType('resource')) {
          if (/\.m?js(\?|$)/.test(e.name) && e.name.startsWith(location.origin)) urls.add(e.name);
        }
        sendResponse([...urls].filter((u) => u.startsWith(location.origin)));
        return;
      }
      case 'picker:toggle':
      case 'picker:start':
        if (globalThis.FeLensPicker.picking && msg.type === 'picker:toggle') {
          globalThis.FeLensPicker.stop();
          toPanel('picker', { active: false });
        } else pick();
        sendResponse(true);
        return;
      case 'picker:stop':
        globalThis.FeLensPicker.stop();
        sendResponse(true);
        return;
      case 'eval': {
        // The page answers asynchronously (the code may await), so keep the
        // channel open and reply when 'eval:done' arrives.
        const id = ++evalSeq;
        const timer = setTimeout(() => {
          if (!pendingEval.delete(id)) return;
          sendResponse({ ok: false, error: 'No result after 30 s: the promise never settled.' });
        }, 30000);
        pendingEval.set(id, (p) => { clearTimeout(timer); sendResponse(p); });
        const sel = globalThis.FeLensPicker.selected;
        rpc('eval', sel?.isConnected ? sel : null, { id, code: String(msg.code || '') });
        return true;
      }
      case 'clear:logs':
        state.logs = [];
        sendResponse(true);
        return;
      case 'reinspect': {
        const el = globalThis.FeLensPicker.selected;
        sendResponse(el?.isConnected ? inspect(el) : null);
        return;
      }
      case 'select:parent': {
        const el = globalThis.FeLensPicker.selected?.parentElement;
        if (el && el !== document.documentElement) { globalThis.FeLensPicker.select(el); sendResponse(inspect(el)); }
        else sendResponse(null);
        return;
      }
      case 'select:path': {
        const el = pathToEl(msg.path);
        if (el) { globalThis.FeLensPicker.select(el); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); sendResponse(inspect(el)); }
        else sendResponse(null);
        return;
      }
      case 'selection:clear':
        globalThis.FeLensPicker.clear();
        state.selection = null;
        sendResponse(true);
        return;
      case 'outline:toggle': {
        const id = 'felens-outline-all';
        const existing = document.getElementById(id);
        if (existing) existing.remove();
        else {
          const s = document.createElement('style');
          s.id = id;
          s.textContent = '*:not([data-felens-ui]) { outline: 1px solid rgb(255 0 80 / .45) !important; outline-offset: -1px !important; }';
          document.documentElement.append(s);
        }
        sendResponse(!existing);
        return;
      }
      case 'clear:net':
        state.net.clear();
        sendResponse(true);
        return;
      case 'clear:errors':
        state.errors.clear();
        updateBadge();
        sendResponse(true);
        return;
    }
  });

  globalThis.FeLensBridge = {
    hoverInfo: (el) => rpc('hover', el),
  };
})();
