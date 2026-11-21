// Angular Lens: page (MAIN world) hook. Runs at document_start, before the app.
// Captures fetch/XHR calls, errors and console output, runs Console code, and
// answers "which component rendered this element?" through Angular's `ng` debug API.
// Everything is wrapped so a bug here can never break the page.
import {
  IN, OUT, readPageRequest,
  type Body, type ComponentInfo, type ErrKind, type ErrPayload, type FrameworkInfo, type Header,
  type InspectResult, type ListenerInfo, type LogLevel, type PageEvent, type PageRequest, type RenderMode, type Val,
} from '../shared/messages';

// ───────────── Angular's debug API (dev builds only) ─────────────
interface NgMeta { inputs?: Record<string, unknown>; outputs?: Record<string, unknown>; encapsulation?: number; changeDetection?: number }
interface NgListener { name: string; type: string; useCapture?: boolean; callback?: { name?: string } }
interface NgDebugApi {
  getComponent(el: Element): object | null;
  getOwningComponent(el: Element): object | null;
  getHostElement(cmp: object): Element;
  getDirectiveMetadata?(cmp: object): NgMeta | null;
  getListeners?(el: Element): NgListener[];
  getDirectives?(el: Element): object[];
  applyChanges?(cmp: object): void;
}
// Compiled component definition (`ɵcmp`). Internal API: every field may be missing.
interface NgDef {
  inputs?: Record<string, string | [string, ...unknown[]]>;
  outputs?: Record<string, string>;
  selectors?: unknown[][];
  debugInfo?: { className?: string; filePath?: string; lineNumber?: number };
  onPush?: boolean;
  encapsulation?: number;
  standalone?: boolean;
}
declare global {
  interface Window { ng?: NgDebugApi; Zone?: unknown; $0?: Element; __feLensHooked?: boolean }
  interface ErrorConstructor { stackTraceLimit: number } // V8
}

// Read a property of an object we don't own (component instance, error-like value).
const prop = (o: object, k: PropertyKey): unknown => Reflect.get(o, k) as unknown;
const message = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'object' && e && typeof prop(e, 'message') === 'string' ? String(prop(e, 'message')) : String(e));

(() => {
  if (window.__feLensHooked) return;
  window.__feLensHooked = true;

  const MAX_BODY = 200 * 1024;
  // Dev-server internals (Vite, Angular HMR / component hot-updates, websockets).
  const IGNORE_URL = /\/@vite\/|\/@fs\/|\/@ng\/|\/@id\/|\/__vite_ping|sockjs-node|\/ng-cli-ws|hot-update\.json/;

  const emit = (e: PageEvent): void => {
    try { document.dispatchEvent(new CustomEvent(OUT, { detail: JSON.stringify(e) })); } catch { /* never throw into the page */ }
  };

  let seq = 0;
  const nextId = (): string => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  const now = (): number => performance.timeOrigin + performance.now();
  const captureStack = (): string => {
    const limit = Error.stackTraceLimit;
    // HttpClient + RxJS + zone.js put well over 100 frames between your code and
    // fetch (measured on a real app: 100 was not enough to reach the component).
    Error.stackTraceLimit = 400;
    const stack = new Error().stack ?? '';
    Error.stackTraceLimit = limit;
    return stack;
  };

  // ───────────── value serialization ─────────────
  const signalSym = (v: object): symbol | undefined => Object.getOwnPropertySymbols(v).find((s) => s.description === 'SIGNAL');

  function serialize(value: unknown, depth = 0, seen = new WeakSet<object>()): Val {
    try {
      if (value === null) return { t: 'null' };
      switch (typeof value) {
        case 'undefined': return { t: 'undef' };
        case 'string': return { t: 'str', v: value.length > 500 ? `${value.slice(0, 500)}…` : value };
        case 'number': case 'bigint': return { t: 'num', v: String(value) };
        case 'boolean': return { t: 'bool', v: String(value) };
        case 'symbol': return { t: 'other', v: value.toString() };
        case 'function': {
          const sym = signalSym(value);
          if (!sym) return { t: 'fn', v: `ƒ ${value.name || 'anonymous'}()` };
          let inner: unknown;
          try { inner = (value as () => unknown)(); } catch (e) { inner = `⚠ ${message(e)}`; } // a signal is callable with no arguments
          const node = prop(value, sym);
          const kind = typeof prop(value, 'set') === 'function' ? 'signal' : typeof node === 'object' && node && 'transformFn' in node ? 'input' : 'computed';
          return { t: 'signal', kind, writable: kind === 'signal', v: serialize(inner, depth, seen) };
        }
      }
      const obj = value as object; // typeof is 'object' here
      if (obj instanceof Node) return { t: 'node', v: obj instanceof Element ? `<${obj.localName}${obj.id ? `#${obj.id}` : ''}>` : obj.nodeName };
      if (obj instanceof Date) return { t: 'other', v: Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString() };
      if (obj instanceof RegExp) return { t: 'other', v: String(obj) };
      if (obj instanceof Error) return { t: 'other', v: `${obj.name}: ${obj.message}` };
      const ctor = (prop(obj, 'constructor') as { name?: unknown } | undefined)?.name;
      const ctorName = typeof ctor === 'string' ? ctor : '';
      if (typeof prop(obj, 'subscribe') === 'function' && typeof prop(obj, 'pipe') === 'function') {
        const name = ctorName || 'Observable';
        const cur = 'value' in obj && name.includes('Subject') ? serialize(prop(obj, 'value'), depth + 1, seen) : undefined;
        return cur ? { t: 'obs', v: name, cur } : { t: 'obs', v: name };
      }
      if (seen.has(obj)) return { t: 'other', v: '[circular]' };
      seen.add(obj);
      if (depth >= 3) return { t: 'other', v: Array.isArray(obj) ? `Array(${obj.length})` : `${ctorName || 'Object'} {…}` };
      if (Array.isArray(obj)) return { t: 'arr', len: obj.length, items: obj.slice(0, 50).map((x: unknown) => serialize(x, depth + 1, seen)) };
      if (obj instanceof Map) return { t: 'obj', ctor: `Map(${obj.size})`, entries: [...obj].slice(0, 50).map(([k, v]: [unknown, unknown]) => [String(k), serialize(v, depth + 1, seen)]) };
      if (obj instanceof Set) return { t: 'arr', ctor: 'Set', len: obj.size, items: [...obj].slice(0, 50).map((x: unknown) => serialize(x, depth + 1, seen)) };
      // Injected services and big framework objects: don't expand.
      if (ctorName && ctorName !== 'Object' && depth > 0 && !Object.keys(obj).length) return { t: 'other', v: `${ctorName} {}` };
      const keys = Object.keys(obj).filter((k) => !k.startsWith('__') && !k.startsWith('ɵ'));
      const out: Val = {
        t: 'obj',
        entries: keys.slice(0, 60).map((k): [string, Val] => {
          let v: unknown;
          try { v = prop(obj, k); } catch (e) { v = `⚠ ${message(e)}`; }
          return [k, serialize(v, depth + 1, seen)];
        }),
        more: keys.length > 60 ? keys.length - 60 : 0,
      };
      if (ctorName && ctorName !== 'Object') out.ctor = ctorName;
      return out;
    } catch (e) {
      return { t: 'other', v: `⚠ ${message(e)}` };
    }
  }

  // ───────────── network: fetch and XHR ─────────────
  const clip = (text: string): Body => (text.length > MAX_BODY ? { text: text.slice(0, MAX_BODY), truncated: true } : { text });

  function describeBody(body: unknown): Body | null {
    if (body == null) return null;
    try {
      if (typeof body === 'string') return clip(body);
      if (body instanceof URLSearchParams) return clip(body.toString());
      if (body instanceof FormData) {
        const parts: string[] = [];
        for (const [k, v] of body) parts.push(`${k}=${typeof v === 'string' ? v : `[File ${v.name}, ${v.size} B]`}`);
        return { text: parts.join('\n'), note: 'FormData' };
      }
      if (body instanceof Blob) return { text: '', note: `Blob ${body.type} ${body.size} B` };
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { text: '', note: `Binary ${body.byteLength} B` };
      if (body instanceof ReadableStream) return { text: '', note: 'Stream' };
      return clip(String(body));
    } catch {
      return { text: '', note: 'unreadable body' };
    }
  }

  const headersToList = (h: Headers): Header[] => {
    const out: Header[] = [];
    try { h.forEach((v, k) => out.push([k, v])); } catch { /* ignore */ }
    return out;
  };
  const absUrl = (u: string | URL): string => {
    try { return new URL(u, location.href).href; } catch { return String(u); }
  };

  // `input instanceof Request` throws if the page removed the global; read the
  // fields we need by shape instead.
  const requestLike = (v: unknown): { url: unknown; method?: unknown; headers?: unknown } | null => {
    try {
      if (typeof v !== 'object' || v === null || v instanceof URL) return null;
      return typeof Reflect.get(v, 'url') === 'string' ? (v as { url: unknown; method?: unknown; headers?: unknown }) : null;
    } catch { return null; }
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function feLensFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let url = '', method = 'GET', reqHeaders: Header[] = [], reqBody: Body | null = null;
      // One step at a time: a page that has replaced Request, Headers or URL
      // (or a body we can't read) must cost at most that one detail, never the
      // whole row. A single try around all of this used to drop the call.
      const req = requestLike(input);
      try { url = absUrl(req ? String(req.url) : (input as string | URL)); } catch { /* keep '' */ }
      try { method = String(init?.method ?? req?.method ?? 'GET').toUpperCase(); } catch { /* keep GET */ }
      try { reqHeaders = headersToList(new Headers((init?.headers ?? req?.headers) as HeadersInit | undefined)); } catch { /* keep [] */ }
      try { reqBody = describeBody(init?.body); } catch { /* keep null */ }
      if (!url || IGNORE_URL.test(url)) return origFetch.call(this, input, init);

      const id = nextId();
      emit({ type: 'net:start', payload: { id, kind: 'fetch', url, method, start: now(), reqHeaders, reqBody, initiator: captureStack() } });
      const p = origFetch.call(this, input, init);
      p.then(
        async (res) => {
          const base = { id, status: res.status, statusText: res.statusText, end: now(), resHeaders: headersToList(res.headers), redirected: res.redirected };
          const ct = res.headers.get('content-type') ?? '';
          if (/event-stream|octet-stream|image\/|video\/|audio\/|font\//.test(ct)) {
            emit({ type: 'net:end', payload: { ...base, resBody: { text: '', note: ct.split(';')[0] ?? ct } } });
            return;
          }
          try {
            const text = await res.clone().text();
            emit({ type: 'net:end', payload: { ...base, size: text.length, resBody: clip(text), end: now() } });
          } catch {
            emit({ type: 'net:end', payload: { ...base, resBody: { text: '', note: 'body not readable' } } });
          }
        },
        (err: unknown) => {
          const aborted = err instanceof DOMException && err.name === 'AbortError';
          emit({ type: 'net:end', payload: { id, status: 0, statusText: aborted ? 'aborted' : 'failed', error: message(err), end: now() } });
        },
      );
      return p;
    };
  }

  // ───────────── server-rendered pages (SSR / SSG) ─────────────
  // On an SSR or SSG page the API calls happen on the server: the browser makes
  // none, and a Network tab that only watches fetch/XHR looks broken. Angular
  // ships those server responses to the browser in a transfer-cache script and
  // HttpClient replays them, so read that script and list what it holds.
  //
  // Read while the HTML is still parsing: Angular strips the `ngh` hydration
  // attributes once it boots, so looking later would miss them.
  const ssr = { context: '', hydrated: false, state: '', httpCount: 0, replayed: false };
  // `<script id="<APP_ID>-state">`, written by the server and read (never
  // removed) by Angular's retrieveTransferredState.
  const STATE_SEL = 'script[id$="-state"]';

  function scanSsr(): void {
    try {
      if (!ssr.context) ssr.context = document.querySelector('[ng-server-context]')?.getAttribute('ng-server-context') ?? '';
      if (!ssr.hydrated && document.querySelector('[ngh]')) ssr.hydrated = true;
      // Always take the latest text: while the HTML streams in, an early read
      // can catch half of the JSON.
      const raw = document.querySelector(STATE_SEL)?.textContent?.trim();
      if (raw) ssr.state = raw;
    } catch { /* never throw into the page */ }
  }

  function ssrInfo(): Pick<FrameworkInfo, 'render' | 'hydrated' | 'transferHttp'> {
    const c = ssr.context.toLowerCase();
    const render: RenderMode = c.includes('ssg') ? 'ssg' : c.includes('ssr') ? 'ssr' : c ? 'server' : 'csr';
    return { render, hydrated: ssr.hydrated, transferHttp: ssr.httpCount };
  }

  // One entry of Angular's HTTP transfer cache. The field names were shortened
  // in Angular 17.1 (`b`, `h`, `s`, `st`, `u`); accept both spellings.
  interface CachedResponse {
    b?: unknown; body?: unknown;
    h?: Record<string, string[]>; headers?: Record<string, string[]>;
    s?: number; status?: number;
    st?: string; statusText?: string;
    u?: string; url?: string;
    rt?: string; responseType?: string;
  }
  const pick = <A, B>(a: A | undefined, b: B | undefined): A | B | undefined => (a === undefined ? b : a);

  // Identify entries by shape, not by key: the key is an opaque hash whose
  // format has changed between Angular versions (an "H<number>" string once, a
  // 64-character hex digest since). Everything else in the script is the app's
  // own TransferState.
  const RESPONSE_FIELDS = ['b', 'h', 's', 'st', 'u', 'rt'] as const;
  function isCachedResponse(v: Record<string, unknown>): boolean {
    if (!('b' in v) && !('body' in v)) return false;
    const hits = RESPONSE_FIELDS.filter((k) => k in v).length;
    return hits >= 2 || 'url' in v || 'status' in v;
  }

  function replayTransfer(): void {
    if (ssr.replayed) return;
    ssr.replayed = true;
    scanSsr();
    if (!ssr.state) return;
    let json: unknown;
    try { json = JSON.parse(ssr.state); } catch { return; }
    if (typeof json !== 'object' || json === null) return;
    const at = now();
    for (const [key, raw] of Object.entries(json)) {
      if (typeof raw !== 'object' || raw === null || !isCachedResponse(raw as Record<string, unknown>)) continue;
      const v = raw as CachedResponse;
      const body = pick(v.b, v.body);
      // arraybuffer and blob responses are stored base64-encoded.
      const binary = v.rt === 'arraybuffer' || v.rt === 'blob';
      const text = binary ? '' : typeof body === 'string' ? body : (() => { try { return JSON.stringify(body); } catch { return ''; } })();
      const headerMap = pick(v.h, v.headers) ?? {};
      const resHeaders: Header[] = [];
      for (const [k, val] of Object.entries(headerMap)) {
        resHeaders.push([k, Array.isArray(val) ? val.join(', ') : String(val)]);
      }
      // The transfer cache stores no content-type; the Response/Preview tabs
      // need one to format JSON.
      if (!resHeaders.some(([k]) => k.toLowerCase() === 'content-type') && /^[[{]/.test(text)) {
        resHeaders.push(['content-type', 'application/json (not stored in the transfer cache)']);
      }
      const url = pick(v.u, v.url);
      const id = nextId();
      emit({ type: 'net:start', payload: { id, kind: 'transfer', url: absUrl(typeof url === 'string' && url ? url : `/${key}`), method: 'GET', start: at, reqHeaders: [], reqBody: null, initiator: '' } });
      const resBody: Body = binary ? { text: '', note: `${String(v.rt)} response, stored base64-encoded` } : clip(text);
      emit({ type: 'net:end', payload: { id, status: pick(v.s, v.status) ?? 200, statusText: pick(v.st, v.statusText) ?? 'OK', end: at, resHeaders, resBody, size: text.length } });
      ssr.httpCount++;
    }
  }

  // documentElement exists at document_start; its subtree does not yet.
  try {
    const obs = new MutationObserver(() => { scanSsr(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const settle = (): void => { obs.disconnect(); replayTransfer(); emit({ type: 'framework', payload: framework() }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', settle, { once: true });
    else setTimeout(settle, 0);
  } catch { /* never throw into the page */ }

  interface XhrInfo { method: string; url: string; reqHeaders: Header[] }
  const xhrInfo = new WeakMap<XMLHttpRequest, XhrInfo>();
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const origSetHeader = XHR.setRequestHeader;
  XHR.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try { xhrInfo.set(this, { method: String(method).toUpperCase(), url: absUrl(url), reqHeaders: [] }); } catch { /* ignore */ }
    // open(method, url, async?, user?, password?): pass the optional arguments through unchanged.
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  };
  XHR.setRequestHeader = function (this: XMLHttpRequest, k: string, v: string) {
    try { xhrInfo.get(this)?.reqHeaders.push([k, v]); } catch { /* ignore */ }
    return origSetHeader.call(this, k, v);
  };
  XHR.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = xhrInfo.get(this);
    if (info && !IGNORE_URL.test(info.url)) {
      const id = nextId();
      emit({ type: 'net:start', payload: { id, kind: 'xhr', url: info.url, method: info.method, start: now(), reqHeaders: info.reqHeaders, reqBody: describeBody(body), initiator: captureStack() } });
      this.addEventListener('loadend', () => {
        try {
          const resHeaders = (this.getAllResponseHeaders() || '')
            .trim().split(/[\r\n]+/).filter(Boolean)
            .map((line): Header => { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; });
          let resBody: Body;
          if (this.responseType === '' || this.responseType === 'text') resBody = clip(this.responseText);
          else if (this.responseType === 'json') resBody = clip(JSON.stringify(this.response));
          else resBody = { text: '', note: this.responseType };
          emit({ type: 'net:end', payload: { id, status: this.status, statusText: this.status === 0 ? 'failed' : this.statusText, end: now(), resHeaders, resBody, size: resBody.text.length } });
        } catch { /* ignore */ }
      });
    }
    return origSend.call(this, body);
  };

  // ───────────── errors ─────────────
  // The same Error object often arrives twice (window 'error' + Angular's
  // ErrorHandler → console.error). Report each object once.
  const reported = new WeakSet<object>();
  const firstTime = (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return true;
    if (reported.has(err)) return false;
    reported.add(err);
    return true;
  };
  // Angular's HttpErrorResponse for a failed call: the network hook already reports it.
  const isHttpFailure = (e: unknown): boolean => {
    if (!e || typeof e !== 'object' || prop(e, 'name') !== 'HttpErrorResponse') return false;
    const s = Number(prop(e, 'status'));
    return s === 0 || s >= 400;
  };

  function errorPayload(kind: ErrKind, err: unknown, extra: Partial<ErrPayload> = {}): ErrPayload {
    const isErr = !!err && typeof err === 'object' && typeof prop(err, 'message') === 'string';
    const name = isErr ? String(prop(err, 'name') ?? '') : '';
    const msg = isErr ? `${name && name !== 'Error' ? `${name}: ` : ''}${message(err)}` : String(err);
    return {
      kind,
      message: msg,
      stack: isErr ? String(prop(err, 'stack') ?? '') : '',
      code: /\bNG0*(\d{1,4})\b/.exec(msg)?.[1] ?? null,
      time: Date.now(),
      ...extra,
    };
  }

  window.addEventListener('error', (e) => {
    if (e.error || e.message) {
      if (!firstTime(e.error) || isHttpFailure(e.error)) return;
      emit({ type: 'err', payload: errorPayload('error', e.error ?? e.message, { file: e.filename, line: e.lineno, col: e.colno }) });
    } else if (e.target instanceof Element) {
      const t = e.target;
      // The property is the resolved URL; the attribute may be missing when the script was created by code.
      const src = t instanceof HTMLScriptElement || t instanceof HTMLImageElement ? t.src : t instanceof HTMLLinkElement ? t.href : t.getAttribute('src') ?? '';
      emit({ type: 'err', payload: errorPayload('resource', `Failed to load <${t.localName}> ${src}`.trim()) });
    }
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    if (!firstTime(e.reason)) return;
    emit({ type: 'err', payload: errorPayload('promise', e.reason ?? 'Unhandled promise rejection') });
  });

  const ownFrames = (stack: string): string => stack.split('\n').slice(1).filter((l) => !/hook\.main\.js/.test(l)).join('\n');

  function reportConsoleError(level: 'error' | 'warn', args: unknown[]): void {
    // Error-like objects too (Angular's HttpErrorResponse is not an Error).
    const errObj = args.find((a): a is object => !!a && typeof a === 'object' && typeof prop(a, 'message') === 'string');
    if (errObj && (!firstTime(errObj) || isHttpFailure(errObj))) return;
    const text = args
      .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(' ')
      .replace(/^ERROR\s+/, '');
    const p = errorPayload(level === 'error' ? 'console' : 'warn', errObj ?? text);
    if (errObj) p.message = text || p.message;
    if (!p.stack) p.stack = ownFrames(new Error().stack ?? '');
    emit({ type: 'err', payload: p });
  }

  // ───────────── console ─────────────
  // Every console call, with its call site. At most 300 per second so a
  // logging loop can't flood the panel.
  const brief = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v == null || typeof v !== 'object') return String(v);
    try { const s = JSON.stringify(v); return s.length > 300 ? `${s.slice(0, 300)}…` : s; } catch { return String(v); }
  };
  // printf-style substitutions (%s %d %i %f %o %O %j %c), like DevTools.
  function formatArgs(args: unknown[]): unknown[] {
    const first = args[0];
    if (typeof first !== 'string' || !/%[sdifoOjc%]/.test(first)) return args;
    let i = 1;
    const text = first.replace(/%([sdifoOjc%])/g, (m: string, c: string) => {
      if (c === '%') return '%';
      if (i >= args.length) return m;
      const v = args[i++];
      if (c === 'c') return '';
      if (c === 'd' || c === 'i') return String(parseInt(String(v), 10));
      if (c === 'f') return String(parseFloat(String(v)));
      return brief(v);
    });
    return [text, ...args.slice(i)];
  }
  let logWindow = 0, logCount = 0, logDropped = 0;
  function emitLog(level: LogLevel, args: unknown[]): void {
    const t = Date.now();
    if (t - logWindow > 1000) {
      if (logDropped) emit({ type: 'log', payload: { id: nextId(), level: 'warn', args: [{ t: 'str', v: `Angular Lens skipped ${logDropped} console messages (more than 300 per second).` }], time: t, stack: '' } });
      logWindow = t; logCount = 0; logDropped = 0;
    }
    if (++logCount > 300) { logDropped++; return; }
    emit({
      type: 'log',
      payload: {
        id: nextId(),
        level,
        args: formatArgs(args).map((a): Val => (typeof a === 'string' ? { t: 'str', v: a.length > 4000 ? `${a.slice(0, 4000)}…` : a } : serialize(a, 1))),
        time: t,
        stack: ownFrames(new Error().stack ?? ''),
      },
    });
  }
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    const prev = console[level];
    console[level] = function (this: Console, ...args: unknown[]) {
      try {
        // error/warn become error rows (grouped, explained, with the failing line);
        // the rest are plain log rows.
        if (level === 'error' || level === 'warn') reportConsoleError(level, args);
        else emitLog(level, args);
      } catch { /* ignore */ }
      return prev.apply(this, args);
    };
  }

  // Run code typed in the Console tab, in the page's global scope. Code that
  // uses `await` runs inside an async function. `$0` is the picked element.
  const indirectEval = eval;
  async function runEval(id: number, code: string): Promise<void> {
    try {
      let result: unknown;
      if (/\bawait\b/.test(code)) {
        try { result = indirectEval(`(async () => (${code}\n))()`); }
        catch (e) { if (!(e instanceof SyntaxError)) throw e; result = indirectEval(`(async () => {${code}\n})()`); }
      } else {
        result = indirectEval(code);
      }
      if (result instanceof Promise) result = await result;
      emit({ type: 'eval:done', payload: { id, ok: true, value: serialize(result, 0) } });
    } catch (e) {
      const blocked = e instanceof EvalError || /unsafe-eval|Content Security Policy/i.test(message(e));
      const name = e instanceof Error ? e.name : 'Error';
      emit({
        type: 'eval:done',
        payload: {
          id,
          ok: false,
          error: blocked ? 'This page blocks running code (its Content-Security-Policy has no unsafe-eval).' : `${name}: ${message(e)}`,
          stack: e instanceof Error ? e.stack ?? '' : '',
        },
      });
    }
  }

  // ───────────── Angular adapter ─────────────
  const describeEl = (el: Element | null | undefined): string => {
    if (!el) return '';
    let s = el.localName;
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].filter((c) => !c.startsWith('ng-') && !c.startsWith('_')).slice(0, 3);
    if (cls.length) s += `.${cls.join('.')}`;
    return s;
  };
  // Child-index path from <html>, so the isolated world can find the same node.
  const domPath = (el: Element): number[] | null => {
    const path: number[] = [];
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      if (!n.parentElement) return null; // detached or inside a shadow root
      path.unshift([...n.parentElement.children].indexOf(n));
    }
    return path;
  };
  const parentOf = (n: Element): Element | null => {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  const ngDef = (cmp: object): NgDef | null => {
    const ctor = prop(cmp, 'constructor');
    if (typeof ctor !== 'function') return null;
    const def = prop(ctor, 'ɵcmp') ?? prop(ctor, 'ɵdir');
    // Angular's compiled definition: read defensively, every field optional.
    return typeof def === 'object' && def ? (def as NgDef) : null;
  };
  const ctorName = (cmp: object): string => {
    const ctor = prop(cmp, 'constructor');
    return typeof ctor === 'function' ? ctor.name : '';
  };

  function detect(): FrameworkInfo {
    const root = document.querySelector('[ng-version]');
    if (!root) return { name: null };
    return { name: 'Angular', version: root.getAttribute('ng-version') ?? '', dev: typeof window.ng?.getComponent === 'function', zoneless: typeof window.Zone === 'undefined' };
  }

  function hostComponentOf(el: Element): { cmp: object; host: Element; isHost: boolean } | null {
    const ng = window.ng;
    if (!ng) return null;
    for (let n: Element | null = el; n; n = parentOf(n)) {
      const own = ng.getComponent(n);
      if (own) return { cmp: own, host: n, isHost: n === el };
      const owner = ng.getOwningComponent(n);
      if (owner) return { cmp: owner, host: ng.getHostElement(owner), isHost: false };
    }
    return null;
  }

  function info(cmp: object, host: Element): ComponentInfo {
    const def = ngDef(cmp);
    const dbg = def?.debugInfo;
    let meta: NgMeta | null = null;
    try { meta = window.ng?.getDirectiveMetadata?.(cmp) ?? null; } catch { /* ignore */ }
    const propOf = (publicName: string): string => {
      const raw = def?.inputs?.[publicName];
      return Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw : publicName;
    };
    const inputNames = def?.inputs ? Object.keys(def.inputs) : Object.keys(meta?.inputs ?? {});
    const inputs = inputNames.map((publicName): [string, Val] => {
      const p = propOf(publicName);
      let v: unknown;
      try { v = prop(cmp, p); } catch { /* ignore */ }
      return [publicName === p ? p : `${publicName} (${p})`, serialize(v)];
    });
    const outputs = def?.outputs ? Object.keys(def.outputs) : Object.keys(meta?.outputs ?? {});
    const skip = new Set([...inputNames.map(propOf), ...outputs]);
    const state = Object.keys(cmp)
      .filter((k) => !skip.has(k) && !k.startsWith('__') && !k.startsWith('ɵ'))
      .slice(0, 60)
      .map((k): [string, Val] => { let v: unknown; try { v = prop(cmp, k); } catch { /* ignore */ } return [k, serialize(v, 0)]; });
    const selector = def?.selectors?.map((s) => s.filter((x): x is string => typeof x === 'string').join('')).join(', ') || host.localName;
    const enc = meta?.encapsulation ?? def?.encapsulation;
    return {
      framework: 'Angular',
      name: dbg?.className || ctorName(cmp) || 'Component',
      selector,
      host: describeEl(host),
      path: domPath(host),
      file: dbg?.filePath ?? null,
      line: dbg?.lineNumber ?? null,
      badges: [
        def?.onPush || meta?.changeDetection === 0 ? 'OnPush' : null,
        enc === 0 ? 'Emulated' : enc === 2 ? 'None' : enc === 3 ? 'ShadowDom' : null,
        def?.standalone === false ? 'NgModule' : null,
      ].filter((b): b is string => b !== null),
      inputs,
      outputs,
      state,
    };
  }

  function chain(el: Element): InspectResult {
    const ng = window.ng;
    if (!ng || typeof ng.getComponent !== 'function') return { chain: [] };
    // Owning component of the element, then the component that owns that
    // component's host element, and so on up to the root.
    const out: ComponentInfo[] = [];
    const seen = new Set<object>();
    let cur = hostComponentOf(el);
    while (cur && out.length < 30 && !seen.has(cur.cmp)) {
      seen.add(cur.cmp);
      out.push(info(cur.cmp, cur.host));
      const up = parentOf(cur.host);
      cur = up ? hostComponentOf(up) : null;
    }
    let listeners: ListenerInfo[] = [];
    try { listeners = (ng.getListeners?.(el) ?? []).map((l) => ({ name: l.name, type: l.type, capture: !!l.useCapture, fn: l.callback?.name ?? '' })); } catch { /* ignore */ }
    let directives: string[] = [];
    try { directives = (ng.getDirectives?.(el) ?? []).map(ctorName).filter(Boolean); } catch { /* ignore */ }
    return { chain: out, listeners, directives };
  }

  let cachedFw: FrameworkInfo | null = null;
  // Which framework it is never changes; how the page was rendered is only
  // known once the HTML has been read, so it is merged in fresh every time.
  const framework = (): FrameworkInfo => {
    if (!cachedFw?.name) {
      try { cachedFw = detect(); } catch { cachedFw = { name: null }; }
    }
    return { ...cachedFw, ...ssrInfo() };
  };

  function inspect(el: Element, full: boolean): InspectResult | { name: string | null; selector: string | null } {
    let result: InspectResult;
    try { result = chain(el); } catch (e) { result = { chain: [], error: message(e) }; }
    if (!full) {
      const c = result.chain[0];
      return { name: c?.name ?? null, selector: c?.selector ?? null };
    }
    let isHost = false;
    try { isHost = !!window.ng?.getComponent(el); } catch { /* ignore */ }
    return { ...result, framework: framework(), element: describeEl(el), elementIsHost: isHost };
  }

  // Requests from the isolated world. The element comes via a temporary attribute.
  document.addEventListener(IN, (e) => {
    const msg: PageRequest | null = e instanceof CustomEvent ? readPageRequest(e.detail) : null;
    if (!msg) return;
    const reply = (payload: unknown): void => emit({ type: 'reply', payload: { rid: msg.rid, payload } });
    const target = msg.q ? document.querySelector(`[data-felens-q="${CSS.escape(msg.q)}"]`) : null;
    try {
      switch (msg.type) {
        case 'detect': reply(framework()); break;
        case 'inspect': case 'hover': reply(target ? inspect(target, msg.type === 'inspect') : null); break;
        case 'applyChanges': {
          const found = target ? hostComponentOf(target) : null;
          if (found) window.ng?.applyChanges?.(found.cmp);
          reply(true);
          break;
        }
        case 'eval':
          // Read $0 now: the bridge removes the marker attribute right after dispatch.
          if (target) window.$0 = target;
          void runEval(msg.id ?? 0, msg.code ?? '');
          break;
      }
    } catch (err) {
      reply({ error: message(err) });
    }
  });

  // Tell the bridge once the app has bootstrapped (framework markers appear).
  const announce = (): void => emit({ type: 'framework', payload: framework() });
  if (document.readyState === 'complete') setTimeout(announce, 0);
  else window.addEventListener('load', () => setTimeout(announce, 300), { once: true });
})();
