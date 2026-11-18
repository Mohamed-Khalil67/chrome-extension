// FE Lens — page (MAIN world) hook. Runs at document_start, before the app.
// Captures fetch/XHR traffic and runtime errors, and answers "which component
// rendered this element?" using framework debug APIs (Angular `ng` global,
// React fibers, Vue component instances).
//
// Talks to the isolated content script (bridge.js) through CustomEvents on
// `document` with JSON-string payloads (only strings cross worlds reliably).
// Everything here is wrapped so a bug in FE Lens can never break the page.
(() => {
  if (window.__feLensHooked) return;
  window.__feLensHooked = true;

  const OUT = '__felens:out';
  const IN = '__felens:in';
  const MAX_BODY = 200 * 1024;
  // Dev-server internals (Vite, Angular HMR / component hot-updates, websockets).
  const IGNORE_URL = /\/@vite\/|\/@fs\/|\/@ng\/|\/@id\/|\/__vite_ping|sockjs-node|\/ng-cli-ws|hot-update\.json/;

  const emit = (type, payload) => {
    try {
      document.dispatchEvent(new CustomEvent(OUT, { detail: JSON.stringify({ type, payload }) }));
    } catch { /* never throw into the page */ }
  };

  let seq = 0;
  const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  const now = () => performance.timeOrigin + performance.now();

  // ───────────────────────── value serialization ─────────────────────────
  const SIGNAL_SYM_DESC = 'SIGNAL';
  const isSignal = (v) =>
    typeof v === 'function' &&
    Object.getOwnPropertySymbols(v).some((s) => s.description === SIGNAL_SYM_DESC);

  function serialize(value, depth = 0, seen = new WeakSet()) {
    try {
      if (value === null) return { t: 'null' };
      const type = typeof value;
      if (type === 'undefined') return { t: 'undef' };
      if (type === 'string') return { t: 'str', v: value.length > 500 ? value.slice(0, 500) + '…' : value };
      if (type === 'number' || type === 'boolean' || type === 'bigint') return { t: type === 'bigint' ? 'num' : type.slice(0, 4), v: String(value) };
      if (type === 'symbol') return { t: 'other', v: value.toString() };
      if (isSignal(value)) {
        let inner;
        try { inner = value(); } catch (e) { inner = `⚠ ${e?.message ?? e}`; }
        const node = value[Object.getOwnPropertySymbols(value).find((s) => s.description === SIGNAL_SYM_DESC)] || {};
        const kind = typeof value.set === 'function' ? 'signal' : 'transformFn' in node ? 'input' : 'computed';
        return { t: 'signal', kind, writable: kind === 'signal', v: serialize(inner, depth, seen) };
      }
      if (type === 'function') return { t: 'fn', v: `ƒ ${value.name || 'anonymous'}()` };
      if (value instanceof Node) {
        const el = value;
        return { t: 'node', v: el.nodeType === 1 ? `<${el.localName}${el.id ? '#' + el.id : ''}>` : el.nodeName };
      }
      if (value instanceof Date) return { t: 'other', v: isNaN(value) ? 'Invalid Date' : value.toISOString() };
      if (value instanceof RegExp) return { t: 'other', v: String(value) };
      if (value instanceof Error) return { t: 'other', v: `${value.name}: ${value.message}` };
      if (typeof value.subscribe === 'function' && typeof value.pipe === 'function') {
        const name = value.constructor?.name || 'Observable';
        let current;
        if ('value' in value && name.includes('Subject')) current = serialize(value.value, depth + 1, seen);
        return { t: 'obs', v: name, cur: current };
      }
      if (seen.has(value)) return { t: 'other', v: '[circular]' };
      seen.add(value);
      const ctor = value.constructor?.name;
      if (depth >= 3) return { t: 'other', v: Array.isArray(value) ? `Array(${value.length})` : `${ctor || 'Object'} {…}` };
      if (Array.isArray(value)) {
        return { t: 'arr', len: value.length, items: value.slice(0, 50).map((x) => serialize(x, depth + 1, seen)) };
      }
      if (value instanceof Map) {
        return { t: 'obj', ctor: `Map(${value.size})`, entries: [...value].slice(0, 50).map(([k, v]) => [String(k), serialize(v, depth + 1, seen)]) };
      }
      if (value instanceof Set) {
        return { t: 'arr', ctor: 'Set', len: value.size, items: [...value].slice(0, 50).map((x) => serialize(x, depth + 1, seen)) };
      }
      // Injected services / big framework objects: don't expand deeply.
      const isService = ctor && ctor !== 'Object' && depth > 0 && !Object.keys(value).length;
      if (isService) return { t: 'other', v: `${ctor} {}` };
      const keys = Object.keys(value).filter((k) => !k.startsWith('__') && !k.startsWith('ɵ'));
      return {
        t: 'obj',
        ctor: ctor && ctor !== 'Object' ? ctor : undefined,
        entries: keys.slice(0, 60).map((k) => {
          let v;
          try { v = value[k]; } catch (e) { v = `⚠ ${e?.message}`; }
          return [k, serialize(v, depth + 1, seen)];
        }),
        more: keys.length > 60 ? keys.length - 60 : 0,
      };
    } catch (e) {
      return { t: 'other', v: `⚠ ${e?.message ?? e}` };
    }
  }

  // ───────────────────────────── network ─────────────────────────────
  const clip = (text) =>
    typeof text === 'string' && text.length > MAX_BODY ? { text: text.slice(0, MAX_BODY), truncated: true } : { text };

  function describeBody(body) {
    if (body == null) return null;
    try {
      if (typeof body === 'string') return clip(body);
      if (body instanceof URLSearchParams) return clip(body.toString());
      if (body instanceof FormData) {
        const parts = [];
        for (const [k, v] of body) parts.push(`${k}=${typeof v === 'string' ? v : `[File ${v.name}, ${v.size} B]`}`);
        return { text: parts.join('\n'), note: 'FormData' };
      }
      if (body instanceof Blob) return { text: '', note: `Blob ${body.type || ''} ${body.size} B` };
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { text: '', note: `Binary ${body.byteLength} B` };
      if (body instanceof ReadableStream) return { text: '', note: 'Stream' };
      return clip(String(body));
    } catch {
      return { text: '', note: 'unreadable body' };
    }
  }

  const headersToList = (h) => {
    const out = [];
    try { h?.forEach((v, k) => out.push([k, v])); } catch { /* ignore */ }
    return out;
  };

  const absUrl = (u) => {
    try { return new URL(u, location.href).href; } catch { return String(u); }
  };

  // fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function feLensFetch(input, init) {
      let url, method, reqHeaders, reqBody;
      try {
        const req = input instanceof Request ? input : null;
        url = absUrl(req ? req.url : input);
        method = (init?.method || req?.method || 'GET').toUpperCase();
        reqHeaders = headersToList(new Headers(init?.headers || req?.headers || undefined));
        reqBody = describeBody(init?.body);
      } catch { /* fall through */ }
      if (!url || IGNORE_URL.test(url)) return origFetch.apply(this, arguments);

      const id = nextId();
      const start = now();
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 100; // RxJS chains are deep; keep the app frame
      const stack = new Error().stack;
      Error.stackTraceLimit = limit;
      emit('net:start', { id, kind: 'fetch', type: 'api', url, method, start, reqHeaders, reqBody, initiator: stack });

      const p = origFetch.apply(this, arguments);
      p.then(
        async (res) => {
          const base = {
            id, status: res.status, statusText: res.statusText, end: now(),
            resHeaders: headersToList(res.headers), redirected: res.redirected, resType: res.type,
          };
          const ct = res.headers.get('content-type') || '';
          if (/event-stream|octet-stream|image\/|video\/|audio\/|font\//.test(ct)) {
            emit('net:end', { ...base, resBody: { text: '', note: ct.split(';')[0] } });
            return;
          }
          try {
            const text = await res.clone().text();
            emit('net:end', { ...base, size: text.length, resBody: clip(text), end: now() });
          } catch {
            emit('net:end', { ...base, resBody: { text: '', note: 'body not readable' } });
          }
        },
        (err) => {
          emit('net:end', { id, status: 0, statusText: err?.name === 'AbortError' ? 'aborted' : 'failed', error: String(err?.message || err), end: now() });
        },
      );
      return p;
    };
  }

  // XMLHttpRequest
  const XHR = window.XMLHttpRequest?.prototype;
  if (XHR) {
    const origOpen = XHR.open;
    const origSend = XHR.send;
    const origSetHeader = XHR.setRequestHeader;
    XHR.open = function (method, url) {
      try { this.__fl = { method: String(method).toUpperCase(), url: absUrl(url), reqHeaders: [] }; } catch { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XHR.setRequestHeader = function (k, v) {
      try { this.__fl?.reqHeaders.push([k, v]); } catch { /* ignore */ }
      return origSetHeader.apply(this, arguments);
    };
    XHR.send = function (body) {
      const info = this.__fl;
      if (info && !IGNORE_URL.test(info.url)) {
        const id = nextId();
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 100;
        const initiator = new Error().stack;
        Error.stackTraceLimit = limit;
        emit('net:start', { id, kind: 'xhr', type: 'api', url: info.url, method: info.method, start: now(), reqHeaders: info.reqHeaders, reqBody: describeBody(body), initiator });
        this.addEventListener('loadend', () => {
          try {
            const resHeaders = (this.getAllResponseHeaders() || '')
              .trim().split(/[\r\n]+/).filter(Boolean)
              .map((line) => { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; });
            let resBody;
            if (this.responseType === '' || this.responseType === 'text') resBody = clip(this.responseText);
            else if (this.responseType === 'json') resBody = clip(JSON.stringify(this.response));
            else resBody = { text: '', note: this.responseType };
            emit('net:end', {
              id, status: this.status, statusText: this.status === 0 ? 'failed' : this.statusText, end: now(),
              resHeaders, resBody, size: resBody.text?.length ?? 0,
            });
          } catch { /* ignore */ }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  // ───────────── all other resources (JS, CSS, images, fonts, docs) ─────────────
  // fetch/XHR are captured above with full bodies. Everything else comes from the
  // Resource Timing API, which (in Chromium) also reports the HTTP status.
  const RES_EXT = [
    [/\.(m?js)(\?|$)/i, 'js'], [/\.css(\?|$)/i, 'css'],
    [/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|$)/i, 'img'],
    [/\.(woff2?|ttf|otf|eot)(\?|$)/i, 'font'], [/\.(mp4|webm|mp3|ogg|wav|m3u8)(\?|$)/i, 'media'],
    [/\.(json|map)(\?|$)/i, 'other'],
  ];
  function resType(e) {
    const t = e.initiatorType;
    if (e.entryType === 'navigation' || t === 'iframe' || t === 'frame') return 'doc';
    if (t === 'script') return 'js';
    if (t === 'css' && /\.(woff2?|ttf|otf)(\?|$)/i.test(e.name)) return 'font';
    if (t === 'img' || t === 'image' || t === 'icon') return 'img';
    if (t === 'video' || t === 'audio' || t === 'track') return 'media';
    const ct = e.contentType || '';
    if (/javascript/.test(ct)) return 'js';
    if (/css/.test(ct)) return 'css';
    if (/^image\//.test(ct)) return 'img';
    if (/font/.test(ct)) return 'font';
    if (/html/.test(ct)) return 'doc';
    for (const [re, type] of RES_EXT) if (re.test(e.name)) return type;
    if (t === 'link' || t === 'css') return 'css';
    return 'other';
  }
  let resSeq = 0;
  let resQueue = [];
  let resTimer = 0;
  function onResources(entries) {
    for (const e of entries) {
      if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'beacon') continue;
      if (IGNORE_URL.test(e.name) || e.name.startsWith('chrome-extension:') || e.name.startsWith('data:')) continue;
      const phase = (a, b) => (e[a] > 0 && e[b] > 0 ? Math.max(0, Math.round(e[b] - e[a])) : null);
      resQueue.push({
        id: `r${(resSeq++).toString(36)}`,
        kind: 'res',
        type: resType(e),
        url: e.name,
        method: 'GET',
        start: performance.timeOrigin + e.startTime,
        end: performance.timeOrigin + e.responseEnd,
        // 0 = unknown (cross-origin without Timing-Allow-Origin, or blocked).
        status: e.responseStatus || null,
        size: e.transferSize || e.encodedBodySize || 0,
        cached: e.transferSize === 0 && e.decodedBodySize > 0,
        contentType: e.contentType || '',
        initiatorType: e.initiatorType || e.entryType,
        phases: {
          dns: phase('domainLookupStart', 'domainLookupEnd'),
          connect: phase('connectStart', 'connectEnd'),
          waiting: phase('requestStart', 'responseStart'),
          download: phase('responseStart', 'responseEnd'),
        },
      });
    }
    clearTimeout(resTimer);
    resTimer = setTimeout(() => {
      if (resQueue.length) emit('res', resQueue);
      resQueue = [];
    }, 250);
  }
  try {
    new PerformanceObserver((list) => onResources(list.getEntries())).observe({ type: 'resource', buffered: true });
    new PerformanceObserver((list) => onResources(list.getEntries())).observe({ type: 'navigation', buffered: true });
  } catch { /* old browser */ }

  // ───────────────────────────── errors ─────────────────────────────
  // The same Error object often arrives twice (window 'error' + Angular's
  // ErrorHandler → console.error). Report each object once.
  const reported = new WeakSet();
  const firstTime = (err) => {
    if (!err || typeof err !== 'object') return true;
    if (reported.has(err)) return false;
    reported.add(err);
    return true;
  };

  function errorPayload(kind, err, extra = {}) {
    const isErr = err && typeof err === 'object' && 'message' in err;
    const message = isErr ? `${err.name && err.name !== 'Error' ? err.name + ': ' : ''}${err.message}` : String(err);
    return {
      kind,
      message,
      stack: isErr ? String(err.stack || '') : '',
      code: (/\bNG0*(\d{1,4})\b/.exec(message) || [])[1] || null,
      time: Date.now(),
      ...extra,
    };
  }

  window.addEventListener('error', (e) => {
    if (e.error || e.message) {
      if (!firstTime(e.error)) return;
      if (e.error?.name === 'HttpErrorResponse' && (e.error.status === 0 || e.error.status >= 400)) return;
      emit('err', errorPayload('error', e.error || e.message, { file: e.filename, line: e.lineno, col: e.colno }));
    } else if (e.target && e.target !== window && e.target.localName) {
      const t = e.target;
      emit('err', errorPayload('resource', `Failed to load <${t.localName}> ${t.src || t.href || ''}`));
    }
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    if (!firstTime(e.reason)) return;
    emit('err', errorPayload('promise', e.reason ?? 'Unhandled promise rejection'));
  });

  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = function (...args) {
      try {
        // Error-like objects too (e.g. Angular's HttpErrorResponse is not an Error).
        const errObj = args.find((a) => a && typeof a === 'object' && typeof a.message === 'string');
        if (errObj && !firstTime(errObj)) return orig.apply(this, args);
        // Failed HTTP calls are already reported by the network hook.
        if (errObj?.name === 'HttpErrorResponse' && (errObj.status === 0 || errObj.status >= 400)) return orig.apply(this, args);
        const text = args
          .map((a) => (a instanceof Error ? `${a.message}` : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
          .join(' ')
          .replace(/^ERROR\s+/, '');
        const p = errorPayload(level === 'error' ? 'console' : 'warn', errObj || text);
        if (errObj) p.message = text || p.message;
        if (!p.stack) p.stack = new Error().stack.split('\n').slice(2).join('\n');
        emit('err', p);
      } catch { /* ignore */ }
      return orig.apply(this, args);
    };
  }

  // ───────────────────────── framework adapters ─────────────────────────
  const describeEl = (el) => {
    if (!el || el.nodeType !== 1) return '';
    let s = el.localName;
    if (el.id) s += '#' + el.id;
    const cls = [...el.classList].filter((c) => !c.startsWith('ng-') && !c.startsWith('_')).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };

  // Child-index path from <html>, so the isolated world can find the same node.
  const domPath = (el) => {
    const path = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (!n.parentElement) return null; // detached or inside a shadow root
      path.unshift([...n.parentElement.children].indexOf(n));
    }
    return path;
  };

  const angular = {
    name: 'Angular',
    detect() {
      const root = document.querySelector('[ng-version]');
      if (!root) return null;
      const ng = window.ng;
      return {
        name: 'Angular',
        version: root.getAttribute('ng-version'),
        dev: !!(ng && typeof ng.getComponent === 'function'),
        zoneless: typeof window.Zone === 'undefined',
      };
    },
    def(cmp) {
      return cmp?.constructor?.ɵcmp || cmp?.constructor?.ɵdir || null;
    },
    hostComponentOf(el) {
      const ng = window.ng;
      if (!ng) return null;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement || n.getRootNode()?.host) {
        const own = ng.getComponent(n);
        if (own) return { cmp: own, host: n, isHost: n === el };
        const owner = ng.getOwningComponent(n);
        if (owner) return { cmp: owner, host: ng.getHostElement(owner), isHost: false };
      }
      return null;
    },
    info(cmp, host) {
      const ng = window.ng;
      const def = this.def(cmp);
      const dbg = def?.debugInfo || null;
      let meta = null;
      try { meta = ng.getDirectiveMetadata?.(cmp) ?? null; } catch { /* ignore */ }
      const inputNames = def?.inputs ? Object.keys(def.inputs) : Object.keys(meta?.inputs || {});
      const inputs = inputNames.map((publicName) => {
        const raw = def?.inputs?.[publicName];
        const prop = Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw : publicName;
        let v;
        try { v = cmp[prop]; } catch { /* ignore */ }
        return [publicName === prop ? prop : `${publicName} (${prop})`, serialize(v)];
      });
      const outputs = def?.outputs ? Object.keys(def.outputs) : Object.keys(meta?.outputs || {});
      const skip = new Set(inputNames.map((n) => (Array.isArray(def?.inputs?.[n]) ? def.inputs[n][0] : n)).concat(outputs));
      const state = Object.keys(cmp)
        .filter((k) => !skip.has(k) && !k.startsWith('__') && !k.startsWith('ɵ'))
        .slice(0, 60)
        .map((k) => { let v; try { v = cmp[k]; } catch { /* ignore */ } return [k, serialize(v, 0)]; });
      const selector = def?.selectors?.map((s) => s.filter((x) => typeof x === 'string').join('')).join(', ') || host?.localName;
      const enc = meta?.encapsulation ?? def?.encapsulation;
      return {
        framework: 'Angular',
        name: dbg?.className || cmp.constructor?.name || 'Component',
        selector,
        host: describeEl(host),
        path: host ? domPath(host) : null,
        file: dbg?.filePath || null,
        line: dbg?.lineNumber || null,
        badges: [
          def?.onPush || meta?.changeDetection === 0 ? 'OnPush' : null,
          enc === 0 ? 'Emulated' : enc === 2 ? 'None' : enc === 3 ? 'ShadowDom' : null,
          def?.standalone === false ? 'NgModule' : null,
        ].filter(Boolean),
        inputs,
        outputs,
        state,
      };
    },
    chain(el) {
      const ng = window.ng;
      if (!ng || typeof ng.getComponent !== 'function') return { chain: [], listeners: [] };
      // Walk up: owning component of the element, then the component that owns
      // that component's host element, and so on up to the root.
      const out = [];
      const seen = new Set();
      let cur = this.hostComponentOf(el);
      while (cur && out.length < 30 && !seen.has(cur.cmp)) {
        seen.add(cur.cmp);
        out.push(this.info(cur.cmp, cur.host));
        const parentEl = cur.host?.parentElement || cur.host?.getRootNode?.()?.host;
        cur = parentEl ? this.hostComponentOf(parentEl) : null;
      }
      let listeners = [];
      try {
        listeners = (ng.getListeners?.(el) || []).map((l) => ({
          name: l.name, type: l.type, capture: !!l.useCapture, fn: l.callback?.name || '',
        }));
      } catch { /* ignore */ }
      // Structural / attribute directives on the element itself.
      let directives = [];
      try { directives = (ng.getDirectives?.(el) || []).map((d) => d.constructor?.name).filter(Boolean); } catch { /* ignore */ }
      return { chain: out, listeners, directives };
    },
    applyChanges(el) {
      const found = this.hostComponentOf(el);
      if (found) window.ng?.applyChanges?.(found.cmp);
    },
    // True when the element is itself a component host: then the markup that
    // created it lives in the *parent* component's template.
    isHost(el) {
      try { return !!window.ng?.getComponent?.(el); } catch { return false; }
    },
  };

  const reactKey = (el) => Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  const react = {
    name: 'React',
    detect() {
      const roots = [document.getElementById('root'), document.getElementById('app'), document.body?.firstElementChild].filter(Boolean);
      const hit = roots.some((r) => Object.keys(r).some((k) => k.startsWith('__reactContainer$'))) ||
        [...(document.body?.querySelectorAll('*') || [])].slice(0, 50).some((n) => reactKey(n));
      return hit ? { name: 'React', version: window.React?.version || '', dev: true } : null;
    },
    chain(el) {
      let node = el;
      while (node && !reactKey(node)) node = node.parentElement;
      if (!node) return { chain: [] };
      let fiber = node[reactKey(node)];
      const out = [];
      while (fiber && out.length < 25) {
        const t = fiber.type;
        if (typeof t === 'function' || (t && typeof t === 'object' && (t.render || t.type))) {
          const fn = typeof t === 'function' ? t : t.render || t.type;
          const src = fiber._debugSource;
          out.push({
            framework: 'React',
            name: fn?.displayName || fn?.name || 'Anonymous',
            selector: '',
            host: '',
            file: src?.fileName || null,
            line: src?.lineNumber || null,
            badges: [],
            inputs: Object.entries(fiber.memoizedProps || {}).filter(([k]) => k !== 'children').slice(0, 40).map(([k, v]) => [k, serialize(v, 1)]),
            outputs: [],
            state: [],
          });
        }
        fiber = fiber.return;
      }
      return { chain: out };
    },
  };

  const vue = {
    name: 'Vue',
    detect() {
      const app = document.querySelector('[data-v-app]');
      return app ? { name: 'Vue', version: app.__vue_app__?.version || '', dev: !!app.__vue_app__ } : null;
    },
    chain(el) {
      let node = el;
      while (node && !node.__vueParentComponent) node = node.parentElement;
      let inst = node?.__vueParentComponent;
      const out = [];
      while (inst && out.length < 25) {
        const t = inst.type || {};
        out.push({
          framework: 'Vue',
          name: t.__name || t.name || (t.__file ? t.__file.split('/').pop().replace(/\.vue$/, '') : 'Anonymous'),
          selector: '',
          host: describeEl(inst.vnode?.el),
          path: inst.vnode?.el?.nodeType === 1 ? domPath(inst.vnode.el) : null,
          file: t.__file || null,
          line: null,
          badges: [],
          inputs: Object.entries(inst.props || {}).slice(0, 40).map(([k, v]) => [k, serialize(v, 1)]),
          outputs: Object.keys(t.emits || {}),
          state: Object.entries(inst.setupState || {}).slice(0, 40).map(([k, v]) => [k, serialize(v, 1)]),
        });
        inst = inst.parent;
      }
      return { chain: out };
    },
  };

  const adapters = [angular, react, vue];
  let cachedFw = null;
  function detectFramework() {
    for (const a of adapters) {
      try {
        const d = a.detect();
        if (d) return (cachedFw = { ...d, adapter: a.name });
      } catch { /* ignore */ }
    }
    return { name: null };
  }
  const adapterFor = () => adapters.find((a) => a.name === (cachedFw?.adapter || detectFramework().adapter));

  function inspect(el, full) {
    const fw = cachedFw || detectFramework();
    const a = adapterFor();
    let result = { chain: [] };
    try { if (a) result = a.chain(el); } catch (e) { result = { chain: [], error: String(e?.message || e) }; }
    if (!full) {
      const c = result.chain?.[0];
      return { name: c?.name || null, selector: c?.selector || null };
    }
    return {
      framework: fw,
      element: describeEl(el),
      elementIsHost: a?.isHost ? a.isHost(el) : false,
      ...result,
    };
  }

  // Requests from the isolated world. Element passed via a temporary attribute.
  document.addEventListener(IN, (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    const reply = (payload) => emit('reply', { rid: msg.rid, payload });
    try {
      if (msg.type === 'detect') {
        reply(detectFramework());
      } else if (msg.type === 'inspect' || msg.type === 'hover') {
        const el = document.querySelector(`[data-felens-q="${msg.q}"]`);
        reply(el ? inspect(el, msg.type === 'inspect') : null);
      } else if (msg.type === 'applyChanges') {
        const el = document.querySelector(`[data-felens-q="${msg.q}"]`);
        if (el) angular.applyChanges(el);
        reply(true);
      }
    } catch (err) {
      reply({ error: String(err?.message || err) });
    }
  });

  // Tell the bridge once the app has bootstrapped (framework markers appear).
  const announce = () => emit('framework', detectFramework());
  if (document.readyState === 'complete') setTimeout(announce, 0);
  else window.addEventListener('load', () => setTimeout(announce, 300), { once: true });
})();
