"use strict";
(() => {
  // src/shared/messages.ts
  var OUT = "__felens:out";
  var IN = "__felens:in";
  var PAGE_REQUESTS = /* @__PURE__ */ new Set(["detect", "inspect", "hover", "applyChanges", "eval"]);
  var isRecord = (v) => typeof v === "object" && v !== null;
  function parse(detail) {
    if (typeof detail !== "string") return null;
    try {
      return JSON.parse(detail);
    } catch {
      return null;
    }
  }
  function readPageRequest(detail) {
    const m = parse(detail);
    if (!isRecord(m) || typeof m.type !== "string" || !PAGE_REQUESTS.has(m.type) || typeof m.rid !== "number") return null;
    if (m.q !== null && typeof m.q !== "string") return null;
    return m;
  }

  // src/content/hook.main.ts
  var prop = (o, k) => Reflect.get(o, k);
  var message = (e) => e instanceof Error ? e.message : typeof e === "object" && e && typeof prop(e, "message") === "string" ? String(prop(e, "message")) : String(e);
  (() => {
    if (window.__feLensHooked) return;
    window.__feLensHooked = true;
    const MAX_BODY = 200 * 1024;
    const IGNORE_URL = /\/@vite\/|\/@fs\/|\/@ng\/|\/@id\/|\/__vite_ping|sockjs-node|\/ng-cli-ws|hot-update\.json/;
    const emit = (e) => {
      try {
        document.dispatchEvent(new CustomEvent(OUT, { detail: JSON.stringify(e) }));
      } catch {
      }
    };
    let seq = 0;
    const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const now = () => performance.timeOrigin + performance.now();
    const captureStack = () => {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 400;
      const stack = new Error().stack ?? "";
      Error.stackTraceLimit = limit;
      return stack;
    };
    const signalSym = (v) => Object.getOwnPropertySymbols(v).find((s) => s.description === "SIGNAL");
    function serialize(value, depth = 0, seen = /* @__PURE__ */ new WeakSet()) {
      try {
        if (value === null) return { t: "null" };
        switch (typeof value) {
          case "undefined":
            return { t: "undef" };
          case "string":
            return { t: "str", v: value.length > 500 ? `${value.slice(0, 500)}\u2026` : value };
          case "number":
          case "bigint":
            return { t: "num", v: String(value) };
          case "boolean":
            return { t: "bool", v: String(value) };
          case "symbol":
            return { t: "other", v: value.toString() };
          case "function": {
            const sym = signalSym(value);
            if (!sym) return { t: "fn", v: `\u0192 ${value.name || "anonymous"}()` };
            let inner;
            try {
              inner = value();
            } catch (e) {
              inner = `\u26A0 ${message(e)}`;
            }
            const node = prop(value, sym);
            const kind = typeof prop(value, "set") === "function" ? "signal" : typeof node === "object" && node && "transformFn" in node ? "input" : "computed";
            return { t: "signal", kind, writable: kind === "signal", v: serialize(inner, depth, seen) };
          }
        }
        const obj = value;
        if (obj instanceof Node) return { t: "node", v: obj instanceof Element ? `<${obj.localName}${obj.id ? `#${obj.id}` : ""}>` : obj.nodeName };
        if (obj instanceof Date) return { t: "other", v: Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString() };
        if (obj instanceof RegExp) return { t: "other", v: String(obj) };
        if (obj instanceof Error) return { t: "other", v: `${obj.name}: ${obj.message}` };
        const ctor = prop(obj, "constructor")?.name;
        const ctorName2 = typeof ctor === "string" ? ctor : "";
        if (typeof prop(obj, "subscribe") === "function" && typeof prop(obj, "pipe") === "function") {
          const name = ctorName2 || "Observable";
          const cur = "value" in obj && name.includes("Subject") ? serialize(prop(obj, "value"), depth + 1, seen) : void 0;
          return cur ? { t: "obs", v: name, cur } : { t: "obs", v: name };
        }
        if (seen.has(obj)) return { t: "other", v: "[circular]" };
        seen.add(obj);
        if (depth >= 3) return { t: "other", v: Array.isArray(obj) ? `Array(${obj.length})` : `${ctorName2 || "Object"} {\u2026}` };
        if (Array.isArray(obj)) return { t: "arr", len: obj.length, items: obj.slice(0, 50).map((x) => serialize(x, depth + 1, seen)) };
        if (obj instanceof Map) return { t: "obj", ctor: `Map(${obj.size})`, entries: [...obj].slice(0, 50).map(([k, v]) => [String(k), serialize(v, depth + 1, seen)]) };
        if (obj instanceof Set) return { t: "arr", ctor: "Set", len: obj.size, items: [...obj].slice(0, 50).map((x) => serialize(x, depth + 1, seen)) };
        if (ctorName2 && ctorName2 !== "Object" && depth > 0 && !Object.keys(obj).length) return { t: "other", v: `${ctorName2} {}` };
        const keys = Object.keys(obj).filter((k) => !k.startsWith("__") && !k.startsWith("\u0275"));
        const out = {
          t: "obj",
          entries: keys.slice(0, 60).map((k) => {
            let v;
            try {
              v = prop(obj, k);
            } catch (e) {
              v = `\u26A0 ${message(e)}`;
            }
            return [k, serialize(v, depth + 1, seen)];
          }),
          more: keys.length > 60 ? keys.length - 60 : 0
        };
        if (ctorName2 && ctorName2 !== "Object") out.ctor = ctorName2;
        return out;
      } catch (e) {
        return { t: "other", v: `\u26A0 ${message(e)}` };
      }
    }
    const clip = (text) => text.length > MAX_BODY ? { text: text.slice(0, MAX_BODY), truncated: true } : { text };
    function describeBody(body) {
      if (body == null) return null;
      try {
        if (typeof body === "string") return clip(body);
        if (body instanceof URLSearchParams) return clip(body.toString());
        if (body instanceof FormData) {
          const parts = [];
          for (const [k, v] of body) parts.push(`${k}=${typeof v === "string" ? v : `[File ${v.name}, ${v.size} B]`}`);
          return { text: parts.join("\n"), note: "FormData" };
        }
        if (body instanceof Blob) return { text: "", note: `Blob ${body.type} ${body.size} B` };
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { text: "", note: `Binary ${body.byteLength} B` };
        if (body instanceof ReadableStream) return { text: "", note: "Stream" };
        return clip(String(body));
      } catch {
        return { text: "", note: "unreadable body" };
      }
    }
    const headersToList = (h) => {
      const out = [];
      try {
        h.forEach((v, k) => out.push([k, v]));
      } catch {
      }
      return out;
    };
    const absUrl = (u) => {
      try {
        return new URL(u, location.href).href;
      } catch {
        return String(u);
      }
    };
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function feLensFetch(input, init) {
        let url = "", method = "GET", reqHeaders = [], reqBody = null;
        try {
          const req = input instanceof Request ? input : null;
          url = absUrl(input instanceof Request ? input.url : input);
          method = (init?.method ?? req?.method ?? "GET").toUpperCase();
          reqHeaders = headersToList(new Headers(init?.headers ?? req?.headers));
          reqBody = describeBody(init?.body);
        } catch {
        }
        if (!url || IGNORE_URL.test(url)) return origFetch.call(this, input, init);
        const id = nextId();
        emit({ type: "net:start", payload: { id, kind: "fetch", url, method, start: now(), reqHeaders, reqBody, initiator: captureStack() } });
        const p = origFetch.call(this, input, init);
        p.then(
          async (res) => {
            const base = { id, status: res.status, statusText: res.statusText, end: now(), resHeaders: headersToList(res.headers), redirected: res.redirected };
            const ct = res.headers.get("content-type") ?? "";
            if (/event-stream|octet-stream|image\/|video\/|audio\/|font\//.test(ct)) {
              emit({ type: "net:end", payload: { ...base, resBody: { text: "", note: ct.split(";")[0] ?? ct } } });
              return;
            }
            try {
              const text = await res.clone().text();
              emit({ type: "net:end", payload: { ...base, size: text.length, resBody: clip(text), end: now() } });
            } catch {
              emit({ type: "net:end", payload: { ...base, resBody: { text: "", note: "body not readable" } } });
            }
          },
          (err) => {
            const aborted = err instanceof DOMException && err.name === "AbortError";
            emit({ type: "net:end", payload: { id, status: 0, statusText: aborted ? "aborted" : "failed", error: message(err), end: now() } });
          }
        );
        return p;
      };
    }
    const xhrInfo = /* @__PURE__ */ new WeakMap();
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;
    const origSetHeader = XHR.setRequestHeader;
    XHR.open = function(method, url, ...rest) {
      try {
        xhrInfo.set(this, { method: String(method).toUpperCase(), url: absUrl(url), reqHeaders: [] });
      } catch {
      }
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.setRequestHeader = function(k, v) {
      try {
        xhrInfo.get(this)?.reqHeaders.push([k, v]);
      } catch {
      }
      return origSetHeader.call(this, k, v);
    };
    XHR.send = function(body) {
      const info2 = xhrInfo.get(this);
      if (info2 && !IGNORE_URL.test(info2.url)) {
        const id = nextId();
        emit({ type: "net:start", payload: { id, kind: "xhr", url: info2.url, method: info2.method, start: now(), reqHeaders: info2.reqHeaders, reqBody: describeBody(body), initiator: captureStack() } });
        this.addEventListener("loadend", () => {
          try {
            const resHeaders = (this.getAllResponseHeaders() || "").trim().split(/[\r\n]+/).filter(Boolean).map((line) => {
              const i = line.indexOf(":");
              return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
            });
            let resBody;
            if (this.responseType === "" || this.responseType === "text") resBody = clip(this.responseText);
            else if (this.responseType === "json") resBody = clip(JSON.stringify(this.response));
            else resBody = { text: "", note: this.responseType };
            emit({ type: "net:end", payload: { id, status: this.status, statusText: this.status === 0 ? "failed" : this.statusText, end: now(), resHeaders, resBody, size: resBody.text.length } });
          } catch {
          }
        });
      }
      return origSend.call(this, body);
    };
    const reported = /* @__PURE__ */ new WeakSet();
    const firstTime = (err) => {
      if (!err || typeof err !== "object") return true;
      if (reported.has(err)) return false;
      reported.add(err);
      return true;
    };
    const isHttpFailure = (e) => {
      if (!e || typeof e !== "object" || prop(e, "name") !== "HttpErrorResponse") return false;
      const s = Number(prop(e, "status"));
      return s === 0 || s >= 400;
    };
    function errorPayload(kind, err, extra = {}) {
      const isErr = !!err && typeof err === "object" && typeof prop(err, "message") === "string";
      const name = isErr ? String(prop(err, "name") ?? "") : "";
      const msg = isErr ? `${name && name !== "Error" ? `${name}: ` : ""}${message(err)}` : String(err);
      return {
        kind,
        message: msg,
        stack: isErr ? String(prop(err, "stack") ?? "") : "",
        code: /\bNG0*(\d{1,4})\b/.exec(msg)?.[1] ?? null,
        time: Date.now(),
        ...extra
      };
    }
    window.addEventListener("error", (e) => {
      if (e.error || e.message) {
        if (!firstTime(e.error) || isHttpFailure(e.error)) return;
        emit({ type: "err", payload: errorPayload("error", e.error ?? e.message, { file: e.filename, line: e.lineno, col: e.colno }) });
      } else if (e.target instanceof Element) {
        const t = e.target;
        const src = t instanceof HTMLScriptElement || t instanceof HTMLImageElement ? t.src : t instanceof HTMLLinkElement ? t.href : t.getAttribute("src") ?? "";
        emit({ type: "err", payload: errorPayload("resource", `Failed to load <${t.localName}> ${src}`.trim()) });
      }
    }, true);
    window.addEventListener("unhandledrejection", (e) => {
      if (!firstTime(e.reason)) return;
      emit({ type: "err", payload: errorPayload("promise", e.reason ?? "Unhandled promise rejection") });
    });
    const ownFrames = (stack) => stack.split("\n").slice(1).filter((l) => !/hook\.main\.js/.test(l)).join("\n");
    function reportConsoleError(level, args) {
      const errObj = args.find((a) => !!a && typeof a === "object" && typeof prop(a, "message") === "string");
      if (errObj && (!firstTime(errObj) || isHttpFailure(errObj))) return;
      const text = args.map((a) => a instanceof Error ? a.message : typeof a === "string" ? a : (() => {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })()).join(" ").replace(/^ERROR\s+/, "");
      const p = errorPayload(level === "error" ? "console" : "warn", errObj ?? text);
      if (errObj) p.message = text || p.message;
      if (!p.stack) p.stack = ownFrames(new Error().stack ?? "");
      emit({ type: "err", payload: p });
    }
    const brief = (v) => {
      if (typeof v === "string") return v;
      if (v == null || typeof v !== "object") return String(v);
      try {
        const s = JSON.stringify(v);
        return s.length > 300 ? `${s.slice(0, 300)}\u2026` : s;
      } catch {
        return String(v);
      }
    };
    function formatArgs(args) {
      const first = args[0];
      if (typeof first !== "string" || !/%[sdifoOjc%]/.test(first)) return args;
      let i = 1;
      const text = first.replace(/%([sdifoOjc%])/g, (m, c) => {
        if (c === "%") return "%";
        if (i >= args.length) return m;
        const v = args[i++];
        if (c === "c") return "";
        if (c === "d" || c === "i") return String(parseInt(String(v), 10));
        if (c === "f") return String(parseFloat(String(v)));
        return brief(v);
      });
      return [text, ...args.slice(i)];
    }
    let logWindow = 0, logCount = 0, logDropped = 0;
    function emitLog(level, args) {
      const t = Date.now();
      if (t - logWindow > 1e3) {
        if (logDropped) emit({ type: "log", payload: { id: nextId(), level: "warn", args: [{ t: "str", v: `Angular Lens skipped ${logDropped} console messages (more than 300 per second).` }], time: t, stack: "" } });
        logWindow = t;
        logCount = 0;
        logDropped = 0;
      }
      if (++logCount > 300) {
        logDropped++;
        return;
      }
      emit({
        type: "log",
        payload: {
          id: nextId(),
          level,
          args: formatArgs(args).map((a) => typeof a === "string" ? { t: "str", v: a.length > 4e3 ? `${a.slice(0, 4e3)}\u2026` : a } : serialize(a, 1)),
          time: t,
          stack: ownFrames(new Error().stack ?? "")
        }
      });
    }
    for (const level of ["log", "info", "debug", "warn", "error"]) {
      const prev = console[level];
      console[level] = function(...args) {
        try {
          if (level === "error" || level === "warn") reportConsoleError(level, args);
          else emitLog(level, args);
        } catch {
        }
        return prev.apply(this, args);
      };
    }
    const indirectEval = eval;
    async function runEval(id, code) {
      try {
        let result;
        if (/\bawait\b/.test(code)) {
          try {
            result = indirectEval(`(async () => (${code}
))()`);
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
            result = indirectEval(`(async () => {${code}
})()`);
          }
        } else {
          result = indirectEval(code);
        }
        if (result instanceof Promise) result = await result;
        emit({ type: "eval:done", payload: { id, ok: true, value: serialize(result, 0) } });
      } catch (e) {
        const blocked = e instanceof EvalError || /unsafe-eval|Content Security Policy/i.test(message(e));
        const name = e instanceof Error ? e.name : "Error";
        emit({
          type: "eval:done",
          payload: {
            id,
            ok: false,
            error: blocked ? "This page blocks running code (its Content-Security-Policy has no unsafe-eval)." : `${name}: ${message(e)}`,
            stack: e instanceof Error ? e.stack ?? "" : ""
          }
        });
      }
    }
    const describeEl = (el) => {
      if (!el) return "";
      let s = el.localName;
      if (el.id) s += `#${el.id}`;
      const cls = [...el.classList].filter((c) => !c.startsWith("ng-") && !c.startsWith("_")).slice(0, 3);
      if (cls.length) s += `.${cls.join(".")}`;
      return s;
    };
    const domPath = (el) => {
      const path = [];
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        if (!n.parentElement) return null;
        path.unshift([...n.parentElement.children].indexOf(n));
      }
      return path;
    };
    const parentOf = (n) => {
      if (n.parentElement) return n.parentElement;
      const root = n.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    };
    const ngDef = (cmp) => {
      const ctor = prop(cmp, "constructor");
      if (typeof ctor !== "function") return null;
      const def = prop(ctor, "\u0275cmp") ?? prop(ctor, "\u0275dir");
      return typeof def === "object" && def ? def : null;
    };
    const ctorName = (cmp) => {
      const ctor = prop(cmp, "constructor");
      return typeof ctor === "function" ? ctor.name : "";
    };
    function detect() {
      const root = document.querySelector("[ng-version]");
      if (!root) return { name: null };
      return { name: "Angular", version: root.getAttribute("ng-version") ?? "", dev: typeof window.ng?.getComponent === "function", zoneless: typeof window.Zone === "undefined" };
    }
    function hostComponentOf(el) {
      const ng = window.ng;
      if (!ng) return null;
      for (let n = el; n; n = parentOf(n)) {
        const own = ng.getComponent(n);
        if (own) return { cmp: own, host: n, isHost: n === el };
        const owner = ng.getOwningComponent(n);
        if (owner) return { cmp: owner, host: ng.getHostElement(owner), isHost: false };
      }
      return null;
    }
    function info(cmp, host) {
      const def = ngDef(cmp);
      const dbg = def?.debugInfo;
      let meta = null;
      try {
        meta = window.ng?.getDirectiveMetadata?.(cmp) ?? null;
      } catch {
      }
      const propOf = (publicName) => {
        const raw = def?.inputs?.[publicName];
        return Array.isArray(raw) ? raw[0] : typeof raw === "string" ? raw : publicName;
      };
      const inputNames = def?.inputs ? Object.keys(def.inputs) : Object.keys(meta?.inputs ?? {});
      const inputs = inputNames.map((publicName) => {
        const p = propOf(publicName);
        let v;
        try {
          v = prop(cmp, p);
        } catch {
        }
        return [publicName === p ? p : `${publicName} (${p})`, serialize(v)];
      });
      const outputs = def?.outputs ? Object.keys(def.outputs) : Object.keys(meta?.outputs ?? {});
      const skip = /* @__PURE__ */ new Set([...inputNames.map(propOf), ...outputs]);
      const state = Object.keys(cmp).filter((k) => !skip.has(k) && !k.startsWith("__") && !k.startsWith("\u0275")).slice(0, 60).map((k) => {
        let v;
        try {
          v = prop(cmp, k);
        } catch {
        }
        return [k, serialize(v, 0)];
      });
      const selector = def?.selectors?.map((s) => s.filter((x) => typeof x === "string").join("")).join(", ") || host.localName;
      const enc = meta?.encapsulation ?? def?.encapsulation;
      return {
        framework: "Angular",
        name: dbg?.className || ctorName(cmp) || "Component",
        selector,
        host: describeEl(host),
        path: domPath(host),
        file: dbg?.filePath ?? null,
        line: dbg?.lineNumber ?? null,
        badges: [
          def?.onPush || meta?.changeDetection === 0 ? "OnPush" : null,
          enc === 0 ? "Emulated" : enc === 2 ? "None" : enc === 3 ? "ShadowDom" : null,
          def?.standalone === false ? "NgModule" : null
        ].filter((b) => b !== null),
        inputs,
        outputs,
        state
      };
    }
    function chain(el) {
      const ng = window.ng;
      if (!ng || typeof ng.getComponent !== "function") return { chain: [] };
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      let cur = hostComponentOf(el);
      while (cur && out.length < 30 && !seen.has(cur.cmp)) {
        seen.add(cur.cmp);
        out.push(info(cur.cmp, cur.host));
        const up = parentOf(cur.host);
        cur = up ? hostComponentOf(up) : null;
      }
      let listeners = [];
      try {
        listeners = (ng.getListeners?.(el) ?? []).map((l) => ({ name: l.name, type: l.type, capture: !!l.useCapture, fn: l.callback?.name ?? "" }));
      } catch {
      }
      let directives = [];
      try {
        directives = (ng.getDirectives?.(el) ?? []).map(ctorName).filter(Boolean);
      } catch {
      }
      return { chain: out, listeners, directives };
    }
    let cachedFw = null;
    const framework = () => {
      if (cachedFw?.name) return cachedFw;
      try {
        cachedFw = detect();
      } catch {
        cachedFw = { name: null };
      }
      return cachedFw;
    };
    function inspect(el, full) {
      let result;
      try {
        result = chain(el);
      } catch (e) {
        result = { chain: [], error: message(e) };
      }
      if (!full) {
        const c = result.chain[0];
        return { name: c?.name ?? null, selector: c?.selector ?? null };
      }
      let isHost = false;
      try {
        isHost = !!window.ng?.getComponent(el);
      } catch {
      }
      return { ...result, framework: framework(), element: describeEl(el), elementIsHost: isHost };
    }
    document.addEventListener(IN, (e) => {
      const msg = e instanceof CustomEvent ? readPageRequest(e.detail) : null;
      if (!msg) return;
      const reply = (payload) => emit({ type: "reply", payload: { rid: msg.rid, payload } });
      const target = msg.q ? document.querySelector(`[data-felens-q="${CSS.escape(msg.q)}"]`) : null;
      try {
        switch (msg.type) {
          case "detect":
            reply(framework());
            break;
          case "inspect":
          case "hover":
            reply(target ? inspect(target, msg.type === "inspect") : null);
            break;
          case "applyChanges": {
            const found = target ? hostComponentOf(target) : null;
            if (found) window.ng?.applyChanges?.(found.cmp);
            reply(true);
            break;
          }
          case "eval":
            if (target) window.$0 = target;
            void runEval(msg.id ?? 0, msg.code ?? "");
            break;
        }
      } catch (err) {
        reply({ error: message(err) });
      }
    });
    const announce = () => emit({ type: "framework", payload: framework() });
    if (document.readyState === "complete") setTimeout(announce, 0);
    else window.addEventListener("load", () => setTimeout(announce, 300), { once: true });
  })();
})();
//# sourceMappingURL=hook.main.js.map
