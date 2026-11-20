// src/shared/messages.ts
var PANEL_PORT = "angular-lens-panel";

// src/shared/sourcemap.ts
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_INDEX = new Map([...B64].map((c, i) => [c, i]));
var isRawMap = (v) => typeof v === "object" && v !== null && typeof Reflect.get(v, "mappings") === "string" && Array.isArray(Reflect.get(v, "sources"));
function decodeVlq(str) {
  const out = [];
  let shift = 0, value = 0;
  for (const ch of str) {
    const digit = B64_INDEX.get(ch);
    if (digit === void 0) continue;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const neg = value & 1;
    value >>>= 1;
    out.push(neg ? -value : value);
    value = 0;
    shift = 0;
  }
  return out;
}
function parseMappings(mappings) {
  const lines = [];
  let src = 0, srcLine = 0, srcCol = 0, name = 0;
  for (const line of mappings.split(";")) {
    const segs = [];
    let genCol = 0;
    for (const seg of line ? line.split(",") : []) {
      const [d0, d1, d2, d3, d4] = decodeVlq(seg);
      if (d0 === void 0) continue;
      genCol += d0;
      if (d1 !== void 0 && d2 !== void 0 && d3 !== void 0) {
        src += d1;
        srcLine += d2;
        srcCol += d3;
        if (d4 !== void 0) name += d4;
        segs.push([genCol, src, srcLine, srcCol, d4 !== void 0 ? name : -1]);
      }
    }
    lines.push(segs);
  }
  return lines;
}
var cache = /* @__PURE__ */ new Map();
async function fetchJson(url) {
  const res2 = await fetch(url);
  if (!res2.ok) return null;
  return res2.json();
}
function loadMap(scriptUrl) {
  const hit = cache.get(scriptUrl);
  if (hit) return hit;
  const p = (async () => {
    try {
      const js = await (await fetch(scriptUrl, { cache: "force-cache" })).text();
      const at = js.lastIndexOf("sourceMappingURL=");
      const ref = at >= 0 ? /sourceMappingURL=([^\s'"]+)/.exec(js.slice(at))?.[1] : void 0;
      let raw;
      if (!ref) raw = await fetchJson(`${scriptUrl}.map`);
      else if (ref.startsWith("data:")) {
        const b64 = ref.slice(ref.indexOf(",") + 1);
        raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
      } else raw = await fetchJson(new URL(ref, scriptUrl));
      return isRawMap(raw) ? { raw, lines: null } : null;
    } catch {
      return null;
    }
  })();
  cache.set(scriptUrl, p);
  return p;
}
function cleanSource(source, sourceRoot) {
  let s = (sourceRoot ? sourceRoot.replace(/\/?$/, "/") : "") + source;
  s = s.replace(/^webpack:\/\/\/?/, "").replace(/^[a-z-]+:\/\/\/?/, "").replace(/^\.\//, "");
  return s.replace(/^(\.\.\/)+/, "");
}
var isLibrary = (file) => /node_modules|\/@angular\/|\/rxjs\/|zone\.js|\/vite\/deps\/|\/@fs\/|polyfills|webpack\/|\(webpack\)|vite\/dist/.test(file);
var sourceIndex = /* @__PURE__ */ new Map();
async function findSource(file, scriptUrls) {
  const want = file.replace(/^\.?\//, "");
  if (!want) return null;
  const known = sourceIndex.get(want);
  if (known != null) return known;
  for (const url of scriptUrls) {
    if (isLibrary(url)) continue;
    const raw = (await loadMap(url))?.raw;
    if (!raw?.sourcesContent) continue;
    const contents = raw.sourcesContent;
    raw.sources.forEach((s, i) => {
      const text = contents[i];
      if (s == null || text == null) return;
      const clean = cleanSource(s, raw.sourceRoot);
      if (!sourceIndex.has(clean)) sourceIndex.set(clean, text);
    });
    const found = sourceIndex.get(want);
    if (found != null) return found;
  }
  for (const [k, v] of sourceIndex) if (k.endsWith(want) || want.endsWith(k)) return v;
  return null;
}
function clearSourceCache() {
  cache.clear();
  sourceIndex.clear();
}
async function resolve(url, line, col) {
  const map = await loadMap(url);
  if (!map) return null;
  map.lines ??= parseMappings(map.raw.mappings);
  const segs = map.lines[line - 1];
  if (!segs?.length) return null;
  let best;
  for (const s of segs) {
    if (s[0] <= col - 1) best = s;
    else break;
  }
  best ??= segs[0];
  if (!best) return null;
  const source = map.raw.sources[best[1]];
  if (source == null) return null;
  const name = best[4] >= 0 ? map.raw.names?.[best[4]] : void 0;
  const origin = { file: cleanSource(source, map.raw.sourceRoot), line: best[2] + 1, col: best[3] + 1 };
  if (name) origin.name = name;
  return origin;
}
var FRAME = /^\s*at\s+(?:(.*?)\s+\()?((?:https?|chrome-extension):\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/;
function parseStack(stack) {
  const frames = [];
  for (const l of stack.split("\n")) {
    const m = FRAME.exec(l);
    if (m?.[2]) frames.push({ fn: m[1] ?? "", url: m[2], line: Number(m[3]), col: Number(m[4]) });
  }
  return frames;
}
async function mapStack(stack, limit = 80) {
  const frames = parseStack(stack).filter((f) => !f.url.startsWith("chrome-extension://")).slice(0, limit);
  return Promise.all(frames.map(async (f) => {
    const orig = isLibrary(f.url) ? null : await resolve(f.url, f.line, f.col).catch(() => null);
    const file = orig?.file ?? f.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\?.*$/, "");
    return { ...f, orig, file, lib: isLibrary(orig?.file ?? f.url) };
  }));
}
var isAppFrame = (f) => !f.lib && f.orig !== null;

// src/panel/core/bus.ts
var listeners = /* @__PURE__ */ new Map();
function on(name, fn) {
  const list2 = listeners.get(name) ?? [];
  list2.push(fn);
  listeners.set(name, list2);
}
function emit(name, ...data) {
  for (const fn of listeners.get(name) ?? []) fn(data[0]);
}

// src/panel/core/dom.ts
function $(sel, root = document) {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
var $maybe = (sel, root = document) => root.querySelector(sel);
var $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
var input = (sel, root = document) => $(sel, root);
var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c] ?? c);
var closest = (e, sel) => e.target instanceof Element ? e.target.closest(sel) : null;
var copyTimers = /* @__PURE__ */ new WeakMap();
async function copyText(button, text) {
  const tip = button.parentElement?.querySelector('[role="status"]');
  clearTimeout(copyTimers.get(button));
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    ok = false;
  }
  if (tip) tip.textContent = ok ? "Copied" : "Copy failed";
  button.toggleAttribute("data-copied", ok);
  copyTimers.set(button, window.setTimeout(() => {
    if (tip) tip.textContent = "";
    button.removeAttribute("data-copied");
  }, 1800));
}
function chipGroup(root, onChange) {
  const multi = root.hasAttribute("data-multi");
  root.addEventListener("click", (e) => {
    const b = closest(e, "button[data-value]");
    if (!b) return;
    if (multi) b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
    else for (const x of $$("button[data-value]", root)) x.setAttribute("aria-pressed", String(x === b));
    onChange();
  });
  return () => $$('button[data-value][aria-pressed="true"]', root).map((b) => b.dataset.value ?? "");
}
function setChip(root, value) {
  for (const b of $$("button[data-value]", root)) b.setAttribute("aria-pressed", String(b.dataset.value === value));
}

// src/panel/core/state.ts
var S = {
  windowId: null,
  tabId: null,
  tabUrl: "",
  framework: null,
  net: /* @__PURE__ */ new Map(),
  errors: /* @__PURE__ */ new Map(),
  selection: null,
  settings: { root: "", editor: "vscode", apiBase: "" },
  picking: false,
  scripts: []
};

// src/panel/core/rpc.ts
async function send(msg) {
  if (S.tabId == null) return void 0;
  try {
    return await chrome.tabs.sendMessage(S.tabId, msg);
  } catch {
    return void 0;
  }
}
async function pageScripts(refresh2 = false) {
  if (refresh2 || !S.scripts.length) S.scripts = await send({ type: "scripts" }) ?? [];
  return S.scripts;
}

// src/panel/core/editor.ts
function absPath(file) {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(file)) return file.replaceAll("\\", "/");
  if (!S.settings.root) return null;
  return `${S.settings.root.replaceAll("\\", "/").replace(/\/$/, "")}/${file.replace(/^\.?\//, "")}`;
}
function editorUrl(file, line = 1, col = 1) {
  const p = absPath(file);
  if (!p) return null;
  const slashed = p.startsWith("/") ? p : `/${p}`;
  switch (S.settings.editor) {
    case "cursor":
      return `cursor://file${slashed}:${line}:${col}`;
    case "webstorm":
      return `webstorm://open?file=${encodeURIComponent(p)}&line=${line}&column=${col}`;
    default:
      return `vscode://file${slashed}:${line}:${col}`;
  }
}
function fileLink(file, line, col, label) {
  if (!file) return '<span class="file-link nofile">source location unavailable</span>';
  const text = esc(label ?? `${file}${line ? `:${line}` : ""}${col ? `:${col}` : ""}`);
  return `<button type="button" class="file-link" data-open-file="${esc(file)}" data-line="${line ?? 1}" data-col="${col ?? 1}" title="Open ${esc(file)} in your editor">${text}</button>`;
}
async function openInEditor(file, line, col) {
  const url = editorUrl(file, line, col);
  if (!url) {
    $("#settings").showPopover();
    $("#root").focus();
    $("#saved").textContent = "Set your project folder to open files.";
    return;
  }
  if (S.tabId != null) await chrome.tabs.update(S.tabId, { url });
}
document.addEventListener("click", (e) => {
  const b = closest(e, "[data-open-file]");
  if (!b) return;
  e.stopPropagation();
  void openInEditor(b.dataset.openFile ?? "", Number(b.dataset.line) || 1, Number(b.dataset.col) || 1);
});

// src/panel/core/format.ts
var fmtMs = (ms) => ms == null ? "\u2026" : ms >= 1e3 ? `${(ms / 1e3).toFixed(2)} s` : `${Math.round(ms)} ms`;
var fmtSize = (b) => b == null || b === 0 ? "\u2013" : b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`;
function val(v) {
  if (!v) return '<span class="v-null">\u2014</span>';
  switch (v.t) {
    case "null":
      return '<span class="v-null">null</span>';
    case "undef":
      return '<span class="v-null">undefined</span>';
    case "str":
      return `<span class="v-str">"${esc(v.v)}"</span>`;
    case "num":
      return `<span class="v-num">${esc(v.v)}</span>`;
    case "bool":
      return `<span class="v-bool">${esc(v.v)}</span>`;
    case "fn":
      return `<span class="v-fn">${esc(v.v)}</span>`;
    case "node":
    case "other":
      return `<span class="v-other">${esc(v.v)}</span>`;
    case "signal":
      return `<span class="v-sig">${esc(v.kind)}</span>${val(v.v)}`;
    case "obs":
      return `<span class="v-other">${esc(v.v)}</span>${v.cur ? ` ${val(v.cur)}` : ""}`;
    case "arr": {
      const label = `${v.ctor ?? "Array"}(${v.len})`;
      if (!v.items.length) return `<span class="v-other">${esc(label)} []</span>`;
      return `<details class="v-obj"><summary>${esc(label)}</summary><dl class="kv">${v.items.map((x, i) => `<dt>${i}</dt><dd>${val(x)}</dd>`).join("")}</dl></details>`;
    }
    case "obj": {
      const label = `${v.ctor ?? "Object"} {${v.entries.length ? "\u2026" : ""}}`;
      if (!v.entries.length) return `<span class="v-other">${esc(label)}</span>`;
      return `<details class="v-obj"><summary>${esc(label)}</summary><dl class="kv">${v.entries.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${val(x)}</dd>`).join("")}${v.more ? `<dt>\u2026</dt><dd class="v-null">${v.more} more</dd>` : ""}</dl></details>`;
    }
  }
}
var kvList = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${val(v)}</dd>`).join("")}</dl>`;
function jsonTree(value, key = null, depth = 0) {
  const label = key == null ? "" : `<span class="j-key">${esc(key)}</span>: `;
  if (value === null) return `<div class="j-row">${label}<span class="v-null">null</span></div>`;
  if (typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    const preview = Array.isArray(value) ? `Array(${entries.length})` : `{${entries.slice(0, 3).map(([k]) => esc(k)).join(", ")}${entries.length > 3 ? ", \u2026" : ""}}`;
    const shown = entries.slice(0, 200);
    return `<details class="j-node" ${depth < 1 ? "open" : ""}><summary>${label}<span class="v-other">${preview}</span></summary>${shown.map(([k, v]) => jsonTree(v, k, depth + 1)).join("")}${entries.length > shown.length ? `<div class="j-row v-null">\u2026 ${entries.length - shown.length} more</div>` : ""}</details>`;
  }
  const cls = typeof value === "string" ? "v-str" : typeof value === "number" ? "v-num" : "v-bool";
  const text = typeof value === "string" ? `"${value.length > 300 ? `${value.slice(0, 300)}\u2026` : value}"` : String(value);
  return `<div class="j-row">${label}<span class="${cls}">${esc(text)}</span></div>`;
}

// src/panel/core/code.ts
var TS_KEYWORDS = new Set("abstract as async await break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while yield".split(" "));
function highlightTs(line) {
  const re = /(\/\/.*$|\/\*.*?\*\/)|(`(?:\\.|[^`])*`?|'(?:\\.|[^'])*'?|"(?:\\.|[^"])*"?)|(@[A-Za-z_]\w*)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\w\s])/g;
  let out = "";
  for (const [t, comment, str, deco, num, word] of line.matchAll(re)) {
    if (comment) out += `<span class="tk-c">${esc(t)}</span>`;
    else if (str) out += `<span class="tk-s">${esc(t)}</span>`;
    else if (deco) out += `<span class="tk-d">${esc(t)}</span>`;
    else if (num) out += `<span class="tk-n">${esc(t)}</span>`;
    else if (word) {
      if (TS_KEYWORDS.has(t)) out += `<span class="tk-k">${esc(t)}</span>`;
      else if (/^[A-Z]/.test(t)) out += `<span class="tk-t">${esc(t)}</span>`;
      else out += esc(t);
    } else out += esc(t);
  }
  return out;
}
function highlightHtml(line) {
  const re = /(<!--.*?-->)|(<\/?[\w-]+)|([[(]{1,2}[\w.-]+[\])]{1,2}|\*?[\w:.-]+(?==))|("[^"]*"?|'[^']*'?)|(\{\{.*?\}\}|@(?:if|else|for|switch|case|default|defer|empty|let)\b)|(\/?>)|([^<"'{@[(*\w/>]+|.)/g;
  let out = "";
  for (const [t, comment, tag, attr, str, ng, close] of line.matchAll(re)) {
    if (comment) out += `<span class="tk-c">${esc(t)}</span>`;
    else if (tag || close) out += `<span class="tk-k">${esc(t)}</span>`;
    else if (attr) out += `<span class="tk-d">${esc(t)}</span>`;
    else if (str) out += `<span class="tk-s">${esc(t)}</span>`;
    else if (ng) out += `<span class="tk-t">${esc(t)}</span>`;
    else out += esc(t);
  }
  return out;
}
var highlight = (file, line) => /\.html?$/i.test(file) ? highlightHtml(line) : highlightTs(line);
function snippetHtml(file, text, line, { before = 3, after = 3, tone = "focus", label } = {}) {
  const lines = text.split("\n");
  const from = Math.max(1, line - before);
  const to = Math.min(lines.length, line + after);
  const width = String(to).length;
  const rows2 = [];
  for (let n = from; n <= to; n++) {
    rows2.push(`<div class="ln${n === line ? ` hl ${tone}` : ""}"><span class="no" style="--w:${width}ch">${n}</span><code>${highlight(file, lines[n - 1] ?? "") || " "}</code></div>`);
  }
  const canGrow = from > 1 || to < lines.length;
  return `
    <figure class="code" data-file="${esc(file)}" data-line="${line}" data-tone="${tone}" data-before="${before}" data-after="${after}">
      <figcaption>${fileLink(file, line, null, label)}${canGrow ? `<button type="button" class="btn tiny ghost" data-grow>${before >= 20 ? "Show less" : "Show more"}</button>` : ""}</figcaption>
      <div class="lines" role="region" aria-label="Source of ${esc(file)} around line ${line}" tabindex="0">${rows2.join("")}</div>
    </figure>`;
}
async function codeBlock(file, line, opts = {}) {
  if (!file || !line) return "";
  let text = await findSource(file, await pageScripts());
  text ??= await findSource(file, await pageScripts(true));
  if (text == null) return `<p class="note code-missing">Source not available in the page's source maps. ${fileLink(file, line, null, "Open in editor")}</p>`;
  return snippetHtml(file, text, line, opts);
}
var isTone = (t) => t === "focus" || t === "error" || t === "warn";
document.addEventListener("click", (e) => {
  const b = closest(e, "[data-grow]");
  const fig = b?.closest("figure.code");
  if (!fig) return;
  const { file = "", line = "1", tone } = fig.dataset;
  const big = Number(fig.dataset.before) < 20;
  void (async () => {
    const text = await findSource(file, await pageScripts());
    if (text == null) return;
    const t = document.createElement("template");
    t.innerHTML = snippetHtml(file, text, Number(line), { before: big ? 20 : 3, after: big ? 20 : 3, tone: isTone(tone) ? tone : "focus" }).trim();
    const next = t.content.firstElementChild;
    if (next) fig.replaceWith(next);
  })();
});
function findTemplateLine(text, desc) {
  if (!text || !desc.tag) return null;
  const lines = text.split("\n");
  const tagRe = new RegExp(`<${desc.tag.replace(/-/g, "\\-")}(?=[\\s>/]|$)`, "i");
  let best = null;
  lines.forEach((l, i) => {
    if (!tagRe.test(l)) return;
    const chunk = lines.slice(i, i + 8).join(" ").split(/>(?![^"]*")/)[0] ?? "";
    let score = 1;
    if (desc.id && chunk.includes(`id="${desc.id}"`)) score += 6;
    for (const c of desc.classes) if (new RegExp(`[\\s"'.]${c.replace(/[.*+?^${}()|[\]\\:/]/g, "\\$&")}(?=[\\s"'])`).test(chunk)) score += 2;
    for (const a of desc.attrs) if (chunk.includes(a)) score += 1;
    if (desc.text && lines.slice(i, i + 4).join(" ").includes(desc.text.slice(0, 20))) score += 3;
    if (!best || score > best.score) best = { line: i + 1, score };
  });
  return best;
}
async function templateFor(tsFile) {
  const scripts = await pageScripts();
  const htmlFile = tsFile.replace(/\.ts$/, ".html");
  const html = await findSource(htmlFile, scripts);
  if (html != null) return { file: htmlFile, text: html };
  const ts = await findSource(tsFile, scripts);
  if (ts == null || !/template\s*:\s*`/.test(ts)) return null;
  return { file: tsFile, text: ts, inline: true };
}

// src/panel/features/console/errors.ts
var KIND_LABEL = { error: "Uncaught error", promise: "Unhandled promise rejection", console: "console.error", warn: "Warning", http: "Failed request", resource: "Failed to load" };
var kindLabel = (k) => KIND_LABEL[k];
var listed = (e) => e.kind !== "http";
var isWarning = (e) => e.kind === "warn";
var appFrame = (e) => e.mapped?.find(isAppFrame);
var ngCode = (e) => `NG${String(e.code).padStart(4, "0")}`;
async function add(e) {
  S.errors.set(e.key, e);
  emit("error", e);
  if (!e.mapped && e.stack) {
    e.mapped = await mapStack(e.stack);
    emit("error", e);
    emit("errors-mapped");
  }
}
function update(p) {
  const e = S.errors.get(p.key);
  if (!e) return;
  e.count = p.count;
  e.last = p.last;
  emit("error", e);
}
function clear() {
  S.errors.clear();
  emit("errors-cleared");
}
var errorCount = () => [...S.errors.values()].filter((e) => listed(e) && !isWarning(e)).reduce((a, e) => a + e.count, 0);
var warningCount = () => [...S.errors.values()].filter(isWarning).reduce((a, e) => a + e.count, 0);
function relatedTo(c) {
  if (!c) return [];
  const file = c.file?.replace(/^\.?\//, "");
  return [...S.errors.values()].filter((e) => listed(e) && !isWarning(e) && (e.message.includes(c.name) || e.stack.includes(c.name) || !!file && !!e.mapped?.some((f) => f.orig?.file.endsWith(file))));
}
var frameLi = (f) => `<li class="${f.lib ? "lib" : ""}">${f.orig ? fileLink(f.orig.file, f.orig.line, f.orig.col) : `<span>${esc(f.file)}:${f.line}</span>`}<span class="fn">${esc(f.orig?.name ?? f.fn)}</span></li>`;
async function detailHtml(e) {
  const frames = e.mapped ?? [];
  const app = frames.filter(isAppFrame);
  const top = app[0];
  const tone = isWarning(e) ? "warn" : "error";
  const code = top ? await codeBlock(top.orig.file, top.orig.line, { tone, before: 3, after: 2, label: `Thrown in ${top.orig.file}:${top.orig.line}` }) : "";
  return `
    <div class="box"><h3>What this means</h3><p>${esc(explain(e))}</p></div>
    ${e.code ? `<a class="ng-help" href="https://angular.dev/errors/${ngCode(e)}" target="_blank" rel="noopener">What ${ngCode(e)} means and how to fix it</a>` : ""}
    ${code || (e.stack ? "" : '<p class="note">No stack trace was captured for this error.</p>')}
    ${app.length > 1 ? `<details class="sub"><summary>Called through ${app.length - 1} more place${app.length > 2 ? "s" : ""} in your code</summary><ul class="frames">${app.slice(1, 8).map(frameLi).join("")}</ul></details>` : ""}
    ${frames.length ? `<details class="sub"><summary>Full stack (${frames.length} frames)</summary><ul class="frames">${frames.map(frameLi).join("")}</ul></details>` : e.stack ? `<details class="sub"><summary>Raw stack</summary><pre class="body-pre">${esc(e.stack)}</pre></details>` : ""}
    <p class="note">${esc(kindLabel(e.kind))}. First seen ${new Date(e.first).toLocaleTimeString()}${e.count > 1 ? `, last ${new Date(e.last).toLocaleTimeString()}` : ""}.</p>`;
}
function explain(e) {
  const m = e.message;
  if (isWarning(e)) return "A warning from your code or a library. The app keeps running, but it often points at a real problem.";
  if (e.code) return "Angular stopped because the framework detected a mistake. The docs link below explains this code.";
  if (/Cannot read propert|undefined is not an object|of undefined|of null/.test(m)) return "Your code read a property of something that is undefined or null. Usually data that hasn't loaded yet, a typo in a field name, or a field the API doesn't send. Use ?. or check the value first.";
  if (/is not a function/.test(m)) return "Your code called something that isn't a function: a typo, a missing import, or a value of the wrong type.";
  if (/is not defined/.test(m)) return "A variable is used but never declared or imported.";
  if (/Maximum call stack/.test(m)) return "Infinite recursion: a function, setter or effect keeps calling itself.";
  if (/JSON/.test(m) && /Unexpected token|parse/i.test(m)) return "Your code tried to parse something that isn't JSON, often an HTML error page returned by the server.";
  if (e.kind === "promise") return "A promise failed and nothing caught it. Add error handling (catch, or catchError in RxJS) where it is created.";
  if (e.kind === "resource") return "A script, stylesheet or image failed to load. Check the file path.";
  return "Your front-end code threw this error. The highlighted line is where it happened.";
}

// src/panel/features/console/console.ts
var LEVELS = { log: "log", debug: "log", info: "info", warn: "warn", error: "error" };
var MAX_ROWS = 500;
var getLevel = () => ["all"];
var last = null;
var logCounts = { log: 0, info: 0, warn: 0, error: 0 };
var errRows = /* @__PURE__ */ new Map();
var history = [];
var histPos = -1;
var list = () => $("#con-list");
var argHtml = (a) => a.t === "str" ? `<span class="con-text">${esc(a.v)}</span>` : val(a);
function atBottom() {
  const l = list();
  return l.scrollHeight - l.scrollTop - l.clientHeight < 40;
}
function append(row) {
  const stick = atBottom();
  list().append(row);
  while (list().children.length > MAX_ROWS) list().firstElementChild?.remove();
  applyFilter(row);
  if (stick) list().scrollTop = list().scrollHeight;
  $("#con-empty").hidden = true;
}
function rowFor(kind, inner, src = "") {
  const row = document.createElement("div");
  row.className = `con-row l-${kind}`;
  row.innerHTML = `<span class="con-ico" aria-hidden="true"></span><div class="con-msg">${inner}</div><span class="con-src">${src}</span>`;
  return row;
}
var part = (row, sel) => $(sel, row);
async function locate(row, stack) {
  if (!stack) return;
  const frames = (await mapStack(stack, 8)).filter((x) => !/\/@vite\/client|\/@fs\/|pptr:|__puppeteer/.test(x.url));
  const f = frames.find(isAppFrame) ?? frames.find((x) => x.orig) ?? frames[0];
  if (!f) return;
  part(row, ".con-src").innerHTML = f.orig ? fileLink(f.orig.file, f.orig.line, f.orig.col, `${f.orig.file.split("/").pop() ?? f.orig.file}:${f.orig.line}`) : `<span title="${esc(f.file)}">${esc(f.file.split("/").pop()?.split("?")[0] ?? f.file)}:${f.line}</span>`;
}
function addLog(m) {
  const level = LEVELS[m.level];
  logCounts[level]++;
  const sig = `${level}|${JSON.stringify(m.args).slice(0, 2e3)}|${m.stack.split("\n")[0] ?? ""}`;
  if (last && last.sig === sig && last.row.isConnected) {
    last.count++;
    const badge = part(last.row, ".con-times");
    badge.textContent = String(last.count);
    badge.hidden = false;
    emit("counts");
    return;
  }
  const row = rowFor(level, `<span class="con-times" hidden></span>${m.args.map(argHtml).join(" ")}`);
  row.dataset.level = level;
  last = { sig, row, count: 1 };
  append(row);
  void locate(row, m.stack);
  emit("counts");
}
function errorRowHtml(e) {
  const loc = appFrame(e);
  return `
    <span class="con-ico" aria-hidden="true"></span>
    <div class="con-msg">
      <details class="con-err">
        <summary><span class="con-times"${e.count > 1 ? "" : " hidden"}>${e.count}</span><span class="con-text">${esc(e.message)}</span>${e.code ? ' <span class="badge">Angular</span>' : ""}</summary>
        <div class="con-err-body"><p class="note">Loading\u2026</p></div>
      </details>
    </div>
    <span class="con-src">${loc ? fileLink(loc.orig.file, loc.orig.line, loc.orig.col, `${loc.orig.file.split("/").pop() ?? loc.orig.file}:${loc.orig.line}`) : ""}</span>`;
}
function upsertError(e) {
  if (!listed(e)) return;
  let row = errRows.get(e.key);
  if (!row) {
    row = document.createElement("div");
    row.className = `con-row l-${isWarning(e) ? "warn" : "error"}`;
    row.dataset.level = isWarning(e) ? "warn" : "error";
    row.dataset.errKey = e.key;
    errRows.set(e.key, row);
    row.innerHTML = errorRowHtml(e);
    last = null;
    append(row);
  } else {
    const open = row.querySelector("details")?.open ?? false;
    row.innerHTML = errorRowHtml(e);
    if (open) void expand(row, e);
  }
  emit("counts");
}
async function expand(row, e) {
  const details = row.querySelector("details");
  if (!details) return;
  details.open = true;
  part(row, ".con-err-body").innerHTML = await detailHtml(e);
}
function openError(key) {
  showErrors();
  const row = errRows.get(key);
  const e = S.errors.get(key);
  if (!row || !e) return;
  void expand(row, e);
  row.scrollIntoView({ block: "nearest" });
}
on("error", upsertError);
on("errors-cleared", () => {
  for (const row of errRows.values()) row.remove();
  errRows.clear();
  emit("counts");
});
var total = () => logCounts.log + logCounts.info + logCounts.warn + logCounts.error + errorCount() + warningCount();
var countOf = (k) => {
  switch (k) {
    case "error":
      return logCounts.error + errorCount();
    case "warn":
      return logCounts.warn + warningCount();
    case "info":
      return logCounts.info;
    case "log":
      return logCounts.log;
    default:
      return 0;
  }
};
function applyFilter(row) {
  const lv = getLevel()[0] ?? "all";
  const levelOk = lv === "all" || row.dataset.level === lv;
  row.hidden = !levelOk;
}
function refilter() {
  for (const row of $$(".con-row", list())) applyFilter(row);
  for (const b of $$("button", $("#con-levels"))) {
    const n = b.querySelector(".n");
    if (n) n.textContent = b.dataset.value === "all" ? "" : String(countOf(b.dataset.value ?? "") || "");
  }
}
on("counts", refilter);
function showErrors() {
  setChip($("#con-levels"), "error");
  refilter();
}
function clear2() {
  list().replaceChildren();
  errRows.clear();
  last = null;
  for (const k of Object.keys(logCounts)) logCounts[k] = 0;
  $("#con-empty").hidden = false;
  emit("counts");
}
async function run(code) {
  history.push(code);
  if (history.length > 100) history.shift();
  histPos = -1;
  last = null;
  append(rowFor("in", `<pre class="con-code">${esc(code)}</pre>`));
  const pending = rowFor("out", '<span class="v-null">Running\u2026</span>');
  append(pending);
  const res2 = await send({ type: "eval", code });
  const msg = part(pending, ".con-msg");
  if (res2 == null) {
    pending.className = "con-row l-error";
    msg.textContent = "Not connected to the page. Reload the page and try again.";
  } else if (res2.ok) {
    msg.innerHTML = val(res2.value);
  } else {
    pending.className = "con-row l-error";
    msg.innerHTML = `<span class="con-text">${esc(res2.error)}</span>`;
  }
  list().scrollTop = list().scrollHeight;
}
function grow(t) {
  t.rows = Math.min(8, Math.max(1, t.value.split("\n").length));
}
function init() {
  getLevel = chipGroup($("#con-levels"), refilter);
  $("#con-clear").addEventListener("click", () => {
    void (async () => {
      await send({ type: "clear:logs" });
      await send({ type: "clear:errors" });
      clear2();
      clear();
    })();
  });
  list().addEventListener("toggle", (e) => {
    const details = e.target;
    if (!(details instanceof HTMLDetailsElement) || !details.open) return;
    const row = details.closest(".con-row");
    const err = row?.dataset.errKey ? S.errors.get(row.dataset.errKey) : void 0;
    if (row && err) void expand(row, err);
  }, true);
  const ta = $("#con-input");
  ta.addEventListener("input", () => grow(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const code = ta.value.trim();
      if (!code) return;
      ta.value = "";
      grow(ta);
      void run(code);
      return;
    }
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    if (e.key === "ArrowUp" && !before.includes("\n") && history.length) {
      e.preventDefault();
      histPos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      ta.value = history[histPos] ?? "";
      grow(ta);
    } else if (e.key === "ArrowDown" && !after.includes("\n") && histPos >= 0) {
      e.preventDefault();
      histPos = histPos + 1 < history.length ? histPos + 1 : -1;
      ta.value = histPos < 0 ? "" : history[histPos] ?? "";
      grow(ta);
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      $("#con-clear").click();
    }
  });
  $("#con-form").addEventListener("submit", (e) => {
    e.preventDefault();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  });
  list().addEventListener("click", (e) => {
    if (closest(e, ".con-src")) e.preventDefault();
  });
}
function hints() {
  const ng = S.framework?.name === "Angular";
  return `Messages, errors and warnings from your app show up here, with the line that caused them. Type JavaScript below to run it in the page. <code>$0</code> is the element you picked${ng ? ", and <code>ng.getOwningComponent($0)</code> returns the component that rendered it" : ""}.`;
}

// src/panel/features/inspect/inspect.ts
var subTab = "component";
var isSubTab = (s) => s === "component" || s === "styles" || s === "layout";
function startHtml() {
  const prodNote = S.framework?.name === "Angular" && !S.framework.dev ? "<p><strong>This is a production build.</strong> Run <code>ng serve</code> to see component names, files and code. Styles, network and errors still work.</p>" : "";
  return `
    <div class="start">
      <h2>Find the code behind any part of the page</h2>
      <p>Press <strong>Pick</strong>, then click an area of the app, or hold <kbd>Alt</kbd> and click it while you use the page. You'll see:</p>
      <ul>
        <li>the component that rendered it, with its code and template line</li>
        <li>its inputs, signals and state right now</li>
        <li>which CSS rules apply, and any layout problems</li>
      </ul>
      ${prodNote}
      <button type="button" class="btn primary" data-act="pick">Pick an element</button>
    </div>`;
}
function componentHtml(sel) {
  const [focus, ...parents] = sel.chain;
  if (!focus) return noComponentNote(sel);
  const errs = relatedTo(focus);
  return `
    <ol class="trail" aria-label="Component tree, nearest first">
      <li class="focus">
        <article class="cmp-focus">
          <h2 class="cmp-name">${esc(focus.name)}</h2>
          ${focus.selector ? `<div class="cmp-sel">&lt;${esc(focus.selector)}&gt;</div>` : ""}
          <div class="cmp-file">${fileLink(focus.file, focus.line)}</div>
          <div class="badges">
            ${focus.badges.map((b) => `<span class="badge">${esc(b)}</span>`).join("")}
            ${sel.directives.filter((d) => d !== focus.name).map((d) => `<span class="badge lens" title="Directive on the selected element">${esc(d)}</span>`).join("")}
            ${errs.length ? `<button type="button" class="badge bad" data-act="goto-errors">${errs.length} related error${errs.length > 1 ? "s" : ""}</button>` : ""}
          </div>
        </article>
      </li>
      ${parents.map((c) => `<li><button type="button" class="cmp-parent" data-path='${esc(JSON.stringify(c.path ?? null))}'><b>${esc(c.name)}</b><span class="mono">${esc(c.file ?? c.selector)}</span></button></li>`).join("")}
    </ol>
    <section class="section"><h3>Template</h3><div id="tpl-code"><p class="note">Looking up the template\u2026</p></div></section>
    <section class="section"><h3>Class</h3><div id="cls-code">${focus.file ? '<p class="note">Loading source\u2026</p>' : '<p class="note">No source location for this component.</p>'}</div></section>
    ${focus.inputs.length ? `<section class="section"><h3>Inputs <span class="n">${focus.inputs.length}</span></h3>${kvList(focus.inputs)}</section>` : ""}
    ${focus.state.length ? `<section class="section"><h3>State <span class="n">${focus.state.length}</span></h3>${kvList(focus.state)}</section>` : ""}
    ${focus.outputs.length ? `<section class="section"><h3>Outputs</h3><div class="badges">${focus.outputs.map((o) => `<span class="badge">${esc(o)}</span>`).join("")}</div></section>` : ""}
    ${sel.listeners.length ? `<section class="section"><h3>Event listeners on this element</h3><dl class="kv">${sel.listeners.map((l) => `<dt>(${esc(l.name)})</dt><dd>${esc(l.fn || "handler")}</dd>`).join("")}</dl></section>` : ""}`;
}
function noComponentNote(sel) {
  if (sel.error) return `<p class="note">Couldn't read component info: ${esc(sel.error)}</p>`;
  const fw = sel.framework;
  if (fw?.name === "Angular" && !fw.dev) return `<p class="note">Production build: component info isn't available. Run the app with <code>ng serve</code>.</p>`;
  if (!fw?.name) return `<p class="note">This page isn't an Angular app. The Styles and Layout tabs still apply.</p>`;
  return `<p class="note">This element isn't inside a component.</p>`;
}
async function loadCode(sel) {
  const [focus, parent] = sel.chain;
  if (!focus) return;
  if (focus.file && focus.line) {
    const html = await codeBlock(focus.file, focus.line, { before: 1, after: 8, tone: "focus" });
    const box2 = $maybe("#cls-code");
    if (S.selection === sel && box2) box2.innerHTML = html;
  }
  const owner = sel.elementIsHost ? parent : focus;
  const tpl = owner?.file ? await templateFor(owner.file) : null;
  const box = $maybe("#tpl-code");
  if (S.selection !== sel || !box) return;
  if (!tpl) {
    box.innerHTML = `<p class="note">Template not found in the page's source maps.</p>`;
    return;
  }
  const hit = findTemplateLine(tpl.text, sel.desc);
  if (!hit) {
    box.innerHTML = `<p class="note">Couldn't match &lt;${esc(sel.desc.tag)}&gt; to a line in ${fileLink(tpl.file, 1)}. It may be created by a child component or a directive.</p>`;
    return;
  }
  const label = `${tpl.file}:${hit.line}${hit.score < 3 ? " (best guess)" : ""}`;
  box.innerHTML = snippetHtml(tpl.file, tpl.text, hit.line, { before: 2, after: 3, tone: "focus", label });
}
function boxHtml(b) {
  const side = (arr) => arr.map((n) => n || "\u2013");
  const [mt, mr, mb, ml] = side(b.margin), [bt, br, bb, bl] = side(b.border), [pt, pr, pb, pl] = side(b.padding);
  return `
    <section class="section"><h3>Box model</h3>
      <div class="boxm" role="img" aria-label="margin ${b.margin.join(" ")}, border ${b.border.join(" ")}, padding ${b.padding.join(" ")}, content ${b.content[0]} by ${b.content[1]}">
        <div class="lyr m"><span class="lbl">margin</span><span class="t">${mt}</span><span class="b">${mb}</span><span class="l">${ml}</span><span class="r">${mr}</span>
          <div class="lyr bd"><span class="lbl">border</span><span class="t">${bt}</span><span class="b">${bb}</span><span class="l">${bl}</span><span class="r">${br}</span>
            <div class="lyr p"><span class="lbl">padding</span><span class="t">${pt}</span><span class="b">${pb}</span><span class="l">${pl}</span><span class="r">${pr}</span>
              <div class="c">${b.content[0]} \xD7 ${b.content[1]}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="facts">
        <span class="badge">display: ${esc(b.display)}</span>
        <span class="badge">position: ${esc(b.position)}</span>
        <span class="badge">${esc(b.boxSizing)}</span>
        ${b.key.zIndex !== "auto" ? `<span class="badge">z-index: ${esc(b.key.zIndex)}</span>` : ""}
        ${b.key.overflow !== "visible" ? `<span class="badge">overflow: ${esc(b.key.overflow)}</span>` : ""}
      </div>
    </section>`;
}
function stylesHtml(css) {
  if (!css || "error" in css) return `<p class="note">CSS analysis failed${css ? `: ${esc(css.error)}` : ""}.</p>`;
  const rules = css.rules.filter((r) => r.lines.length);
  const rulesHtml = rules.length ? `
    <section class="section"><h3>Rules <span class="n">${rules.length}, strongest first</span></h3>
      ${rules.map((r) => `
        <div class="rule">
          <header>
            <span class="sel">${esc(r.selector)}</span>
            ${r.owner ? `<span class="owner" title="Scoped component styles">${esc(r.owner)}</span>` : `<span class="src">${esc(r.label)}</span>`}
          </header>
          ${r.ctx?.length ? `<div class="ctx">${r.ctx.map(esc).join(" ")}</div>` : ""}
          <ul>${r.lines.map((d) => `<li class="${d.overridden ? "over" : ""}" ${d.overridden ? 'title="Overridden by a stronger rule"' : ""}><span class="p-name">${esc(d.prop)}</span>: ${esc(d.value)}${d.important ? ' <span class="imp">!important</span>' : ""};</li>`).join("")}</ul>
        </div>`).join("")}
    </section>` : '<section class="section"><h3>Rules</h3><p class="note">Only browser defaults and inherited styles apply.</p></section>';
  return boxHtml(css.box) + rulesHtml;
}
var warningsOf = (css) => css && !("error" in css) ? css.warnings : [];
function layoutHtml(css) {
  const list2 = warningsOf(css);
  return list2.length ? `<ul class="problems">${list2.map((w) => `<li class="problem ${esc(w.level)}"><strong>${esc(w.text)}</strong><span>${esc(w.hint)}</span></li>`).join("")}</ul>` : '<p class="all-good">No layout problems found on this element.</p>';
}
var layoutWarnings = () => warningsOf(S.selection?.css).filter((w) => w.level !== "info").length;
function render() {
  const root = $("#inspect");
  const sel = S.selection;
  if (!sel) {
    root.innerHTML = startHtml();
    emit("counts");
    return;
  }
  const warnN = warningsOf(sel.css).length;
  const tabs = [["component", "Component"], ["styles", "Styles"], ["layout", `Layout${warnN ? ` <span class="n warn">${warnN}</span>` : ""}`]];
  root.innerHTML = `
    <div class="el-bar">
      <span class="tag">&lt;${esc(sel.element)}&gt;</span>
      <span class="dim">${sel.rect.w}\xD7${sel.rect.h}</span>
      <span class="spacer"></span>
      <button type="button" class="btn small ghost" data-act="parent" title="Select the parent element">Parent</button>
      <button type="button" class="btn small ghost" data-act="refresh" title="Read current values again">Refresh</button>
      <button type="button" class="btn small ghost" data-act="clear-sel">Clear</button>
    </div>
    <div class="seg" role="tablist" aria-label="Inspect views">
      ${tabs.map(([k, label]) => `<button type="button" role="tab" data-sub="${k}" aria-selected="${k === subTab}">${label}</button>`).join("")}
    </div>
    <div class="sub-body" role="tabpanel">
      ${subTab === "component" ? componentHtml(sel) : subTab === "styles" ? stylesHtml(sel.css) : layoutHtml(sel.css)}
    </div>`;
  if (subTab === "component") void loadCode(sel);
  emit("counts");
}
function showLayout() {
  subTab = "layout";
  render();
}
var setSelection = (sel) => {
  if (sel) {
    S.selection = sel;
    render();
  }
};
function init2(startPick2) {
  const root = $("#inspect");
  root.addEventListener("click", (e) => {
    const sub = closest(e, "[data-sub]")?.dataset.sub;
    if (isSubTab(sub)) {
      subTab = sub;
      render();
      return;
    }
    const parentBtn = closest(e, ".cmp-parent");
    if (parentBtn) {
      const raw = JSON.parse(parentBtn.dataset.path ?? "null");
      if (Array.isArray(raw) && raw.every((x) => typeof x === "number")) void send({ type: "select:path", path: raw }).then(setSelection);
      return;
    }
    switch (closest(e, "[data-act]")?.dataset.act) {
      case "pick":
        startPick2();
        break;
      case "refresh":
        void send({ type: "reinspect" }).then(setSelection);
        break;
      case "parent":
        void send({ type: "select:parent" }).then(setSelection);
        break;
      case "clear-sel":
        void send({ type: "selection:clear" }).then(() => {
          S.selection = null;
          render();
        });
        break;
      case "goto-errors":
        emit("goto-errors");
        break;
    }
  });
  root.addEventListener("keydown", (e) => {
    const tab = closest(e, "[data-sub]");
    if (!tab || e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const all = $$("[data-sub]", root);
    const i = all.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1);
    const next = all[(i + all.length) % all.length]?.dataset.sub;
    if (!isSubTab(next)) return;
    subTab = next;
    render();
    $maybe(`[data-sub="${subTab}"]`)?.focus();
  });
}

// src/shared/status-codes.ts
var CODES = {
  200: { title: "OK", backend: "The backend handled the request and sent the data back." },
  201: { title: "Created", backend: "The backend saved the new item." },
  202: { title: "Accepted", backend: "The backend queued the work; it may not be finished yet." },
  204: { title: "No content", backend: "It worked, and there is no body to send back.", front: "Don't try to parse a JSON body from this response." },
  206: { title: "Partial content", backend: "Part of a file was sent (range request), usually video or audio." },
  301: { title: "Moved permanently", backend: "The resource lives at a new URL for good.", front: "Update the URL in your code or environment file." },
  302: { title: "Found (redirect)", backend: "The backend sent you to another URL, often a login page.", front: "If an API call redirects, the session may have expired.", back: "APIs usually should return 401 instead of redirecting to a login page." },
  304: { title: "Not modified", backend: "Nothing changed since the last download, so the browser used its cached copy." },
  307: { title: "Temporary redirect", backend: "Try the same request at another URL (method and body are kept)." },
  308: { title: "Permanent redirect", backend: "The endpoint moved for good (method and body are kept)." },
  400: { title: "Bad request", backend: "The backend couldn't understand the request: missing field, wrong type or malformed JSON.", front: "Compare the Payload tab with what the API expects. Check Content-Type is application/json.", back: "Request validation rules and the DTO for this endpoint. The response body usually names the field." },
  401: { title: "Unauthorized", backend: "You didn't prove who you are: the token is missing, expired or malformed.", front: "Check the user is logged in and that your interceptor adds the token header to this URL.", back: "Auth middleware on this route, token expiry, and the header name it expects." },
  403: { title: "Forbidden", backend: "The backend knows who you are, but this user isn't allowed to do this.", front: "Hide or disable the action for users without the role.", back: "Role or permission checks for this route, and the user's roles." },
  404: { title: "Not found", backend: "There's nothing at this URL: wrong route, wrong ID, or the item was deleted.", front: "Compare the URL with the API docs: base URL, path, plural vs singular, and the ID you passed.", back: "That the route is registered and the item with this ID exists." },
  405: { title: "Method not allowed", backend: "The URL exists but doesn't accept this HTTP method.", front: "Use the method the API expects (GET, POST, PUT, PATCH or DELETE).", back: "Which methods the route is registered for." },
  406: { title: "Not acceptable", backend: "The backend can't send the format you asked for in the Accept header." },
  408: { title: "Request timeout", backend: "The backend waited too long for the request to arrive.", front: "Large uploads or a slow network." },
  409: { title: "Conflict", backend: "The request clashes with the current data: duplicate item, or someone changed it first.", front: "Reload the data and retry, or show the user the conflict.", back: "Unique constraints and version checks." },
  410: { title: "Gone", backend: "This resource was removed on purpose and won't come back." },
  413: { title: "Payload too large", backend: "The request body is bigger than the backend allows.", front: "Compress or resize the file before uploading.", back: "Body size limits in the server and any proxy." },
  415: { title: "Unsupported media type", backend: "The backend doesn't accept this Content-Type.", front: "Send JSON with Content-Type: application/json, or FormData for files." },
  422: { title: "Unprocessable content", backend: "The data is well formed but fails a validation rule.", front: "The Response tab usually lists which fields failed. Show those messages in the form.", back: "The validation rules for this endpoint." },
  429: { title: "Too many requests", backend: "You hit the rate limit.", front: "Look for duplicate or looping calls. Debounce search inputs.", back: "Rate limit settings for this route." },
  500: { title: "Internal server error", backend: "The backend code crashed while handling the request. The request itself may be fine.", front: "Check the payload for unexpected values (null, empty string, wrong ID) that could trigger the bug.", back: "The server logs at this time: there's an exception with a stack trace." },
  501: { title: "Not implemented", backend: "The backend doesn't support this feature yet." },
  502: { title: "Bad gateway", backend: "A proxy or gateway couldn't get a valid answer from the real server.", front: "If you use a dev proxy (proxy.conf.json), check its target.", back: "Whether the API process is running, and the proxy configuration." },
  503: { title: "Service unavailable", backend: "The backend is down, overloaded or in maintenance.", back: "Server health, deploys in progress, and resource limits." },
  504: { title: "Gateway timeout", backend: "A proxy gave up waiting for the backend to answer.", front: "Request less data (pagination, filters).", back: "Slow queries or calls to other services on this route." }
};
var CLASS_FALLBACK = {
  2: { title: "Success", backend: "The backend handled the request." },
  3: { title: "Redirect", backend: "The backend pointed the browser somewhere else." },
  4: { title: "Client error", backend: "The backend rejected the request as wrong in some way.", front: "Check the URL, payload and headers.", back: "The response body and the route's checks." },
  5: { title: "Server error", backend: "The backend failed while handling the request.", back: "The server logs at this time." }
};
var FAILED = { title: "Never reached the backend", backend: "No response came back: CORS, the server is down, DNS, offline, or an ad blocker.", front: "Open the browser console for a CORS message. Check the API URL and that you're online.", back: "That the server is running and sends Access-Control-Allow-Origin for your dev origin." };
var ABORTED = { title: "Cancelled", backend: "The page cancelled the request before the backend answered.", front: "Usually switchMap cancelling an older request, or a component destroyed mid-request. Normally harmless." };
function meaning(status, statusText) {
  if (statusText === "aborted") return ABORTED;
  if (status === 0) return FAILED;
  if (status == null) return null;
  return CODES[status] ?? CLASS_FALLBACK[String(status)[0] ?? ""] ?? { title: `Status ${status}`, backend: "" };
}
var SHORT = {
  200: "Backend sent the data",
  201: "Saved",
  202: "Queued",
  204: "Done, no body",
  206: "Part of a file",
  301: "Moved for good",
  302: "Redirected",
  304: "Served from cache",
  307: "Redirected",
  308: "Moved for good",
  400: "Request data is wrong",
  401: "Not logged in or token expired",
  403: "Not allowed for this user",
  404: "Wrong URL or ID",
  405: "Wrong HTTP method",
  408: "Request too slow",
  409: "Clashes with current data",
  413: "Upload too large",
  415: "Wrong Content-Type",
  422: "Failed validation",
  429: "Rate limited",
  500: "Backend code crashed",
  502: "Proxy got no answer",
  503: "Backend down",
  504: "Backend too slow",
  failed: "Never reached the backend",
  aborted: "Cancelled by the page"
};
var shortMeaning = (k) => SHORT[k] ?? meaning(Number(k))?.title ?? "";

// src/panel/features/network/network.ts
var STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "failed"];
var urlOf = (u) => {
  try {
    return new URL(u);
  } catch {
    return null;
  }
};
var headerVal = (list2, name) => list2?.find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
var isJsonResponse = (n) => /json/.test(headerVal(n.resHeaders, "content-type")) || /^\s*[[{]/.test(n.resBody?.text ?? "");
var apiBases = () => S.settings.apiBase.split(",").map((s) => s.trim()).filter(Boolean);
var TRACKERS = /(^|\.)(google-analytics|googletagmanager|googleadservices|doubleclick|googlesyndication|clarity|hotjar|facebook|fbcdn|linkedin|licdn|twitter|ads-twitter|tiktok|snapchat|pinterest|segment|mixpanel|amplitude|heap|fullstory|logrocket|sentry|datadoghq|newrelic|nr-data|bugsnag|intercom|hubspot|hs-analytics|hsforms|zdassets|crisp|tawk|cloudflareinsights|posthog)\./i;
var looksLikeApiRequest = (n) => !!authHeader(n) || /json/.test(headerVal(n.reqHeaders, "content-type")) || /^\s*[[{]/.test(n.reqBody?.text ?? "");
var backendHosts = /* @__PURE__ */ new Set();
function computeBackendHosts() {
  const pageOrigin = urlOf(S.tabUrl)?.origin;
  const counts = /* @__PURE__ */ new Map();
  for (const n of S.net.values()) {
    const u = urlOf(n.url);
    if (!u || u.origin === pageOrigin || TRACKERS.test(u.hostname)) continue;
    if (isJsonResponse(n) || authHeader(n)) counts.set(u.host, (counts.get(u.host) ?? 0) + 1);
  }
  const top = Math.max(0, ...counts.values());
  backendHosts = new Set([...counts].filter(([, c]) => c >= Math.max(1, top * 0.3)).map(([h]) => h));
}
function isBackendCall(n) {
  const bases = apiBases();
  if (bases.length) return bases.some((b) => n.url.startsWith(b));
  const u = urlOf(n.url);
  if (!u) return false;
  if (u.origin === urlOf(S.tabUrl)?.origin) {
    return !/\.[a-z0-9]{2,5}$/i.test(u.pathname);
  }
  if (TRACKERS.test(u.hostname)) return false;
  if (backendHosts.has(u.host)) return true;
  const unresolved = n.status == null || n.status === 0 || n.status >= 400;
  return unresolved && (looksLikeApiRequest(n) || backendHosts.size === 0);
}
function statusClass(n) {
  if (n.statusText === "aborted") return "aborted";
  if (n.status == null) return "pending";
  if (n.status === 0) return "failed";
  if (n.status >= 500) return "5xx";
  if (n.status >= 400) return "4xx";
  if (n.status >= 300) return "3xx";
  return "2xx";
}
var AUTH_HEADERS = ["authorization", "token", "x-auth-token", "x-access-token", "x-api-key"];
var authHeader = (n) => n.reqHeaders.find(([k]) => AUTH_HEADERS.includes(k.toLowerCase()))?.[0];
function problems(n, dupCount = 0) {
  const out = [];
  const add2 = (level, label, hint) => {
    out.push({ level, label, hint });
  };
  const s = n.status;
  if (n.statusText === "aborted") add2("info", "Cancelled", "The request was aborted before it finished. Often switchMap cancelling an older request, or a component destroyed mid-request. Usually harmless.");
  else if (s === 0) add2("error", "Blocked or offline", "No response reached the page: CORS, DNS, a refused connection, or an ad blocker. A CORS problem shows its own message in the browser console.");
  else if (s === 401) {
    const h = authHeader(n);
    add2("error", "Not authenticated", h ? `The ${h} header was sent but rejected: the token is probably expired or invalid.` : "No auth header (Authorization or token) was sent with this request. Check that your HTTP interceptor adds it for this URL, and that the user is logged in.");
  } else if (s === 403) add2("error", "Forbidden", "The server knows who you are but refuses this action.");
  else if (s === 404) add2("error", "Not found", "Compare the URL with the API docs and your environment base URL.");
  else if (s === 405) add2("error", "Method not allowed", `The endpoint exists but doesn't accept ${n.method}.`);
  else if (s === 400 || s === 422) add2("error", "Rejected input", "The server didn't accept the request data. The Response tab usually says which field.");
  else if (s === 408 || s === 504) add2("error", "Timed out", "The server or a gateway gave up waiting.");
  else if (s === 429) {
    const ra = headerVal(n.resHeaders, "retry-after");
    add2("warn", "Rate limited", `Too many requests.${ra ? ` Retry after ${ra} s.` : ""}`);
  } else if (s != null && s >= 500) add2("error", "Server error", "The request may be fine: check the server logs and the Response tab.");
  else if (s != null && s >= 400) add2("error", `Client error ${s}`, "The server rejected the request.");
  const body = n.resBody?.text ?? "";
  const ct = headerVal(n.resHeaders, "content-type");
  if (s != null && s >= 200 && s < 300 && (/html/.test(ct) || /^\s*<(!doctype|html)/i.test(body))) {
    add2("error", "HTML instead of JSON", "The API returned an HTML page, usually the dev server's index.html fallback. The API URL is probably wrong, or the dev proxy isn't set up.");
  }
  const dur = n.end && n.start ? n.end - n.start : null;
  if (dur != null && dur > 1e3) add2("warn", "Slow", `Took ${fmtMs(dur)}.`);
  if ((n.size ?? 0) > 1024 * 1024) add2("warn", "Large", `${fmtSize(n.size)}. Consider pagination or smaller responses.`);
  if (dupCount > 1) add2("warn", `Duplicate \xD7${dupCount}`, "The same request was made several times within 1 second. Check for a double subscribe (async pipe and subscribe on the same observable) or a missing shareReplay.");
  return out;
}
function codeKey(n) {
  if (n.statusText === "aborted") return "aborted";
  if (n.status === 0) return "failed";
  return n.status == null ? null : String(n.status);
}
var codeTone = (k) => k === "failed" || k.startsWith("5") ? "bad" : k.startsWith("4") ? "warn" : k.startsWith("3") || k === "aborted" ? "info" : "ok";
var codeOrder = (k) => /^\d/.test(k) ? Number(k) : k === "failed" ? 900 : 901;
var codeLabel = (k) => k === "failed" ? "ERR" : k === "aborted" ? "\xD7" : k;
var siteCache = /* @__PURE__ */ new Map();
function callSite(n) {
  const hit = siteCache.get(n.initiator);
  if (hit) return hit;
  const p = mapStack(n.initiator, 400).then((frames) => {
    const app = frames.filter(isAppFrame);
    const at = app[0] ?? null;
    const from = app.find((f) => f.orig.file !== at?.orig.file) ?? null;
    return { at, from };
  }).catch(() => ({ at: null, from: null }));
  siteCache.set(n.initiator, p);
  return p;
}
var base = (file) => file.split("/").pop() ?? file;
function siteHtml(site) {
  if (!site.at) return '<span class="site none">Started by Angular (no line of your code on the stack)</span>';
  const { at, from } = site;
  return `<span class="site">${fileLink(at.orig.file, at.orig.line, at.orig.col, `${base(at.orig.file)}:${at.orig.line}`)}${from ? ` <span class="dim">from</span> ${fileLink(from.orig.file, from.orig.line, from.orig.col, `${base(from.orig.file)}:${from.orig.line}`)}` : ""}</span>`;
}
var rows = /* @__PURE__ */ new Map();
var selectedId = null;
var sortKey = null;
var sortDir = "descending";
var dupCounts = /* @__PURE__ */ new Map();
var codeFilter = /* @__PURE__ */ new Set();
var nameOf = (url) => {
  const u = urlOf(url);
  if (!u) return url;
  const lastSeg = u.pathname.split("/").filter(Boolean).pop() ?? u.host;
  return lastSeg + (u.search ? u.search.slice(0, 30) : "");
};
var pathOf = (url) => {
  const u = urlOf(url);
  return u ? u.host + u.pathname : url;
};
function rowHtml(n) {
  const sc = statusClass(n);
  const tag = problems(n, dupCounts.get(n.id)).find((p) => p.level !== "info");
  const dur = n.end ? n.end - n.start : null;
  const status = n.status == null ? "\u2026" : n.status || (sc === "aborted" ? "\xD7" : "ERR");
  return `
    <td class="c-name">
      <button type="button" class="row-open" title="${esc(n.url)}"><span class="nm"><b class="meth m-${esc(n.method.toLowerCase())}">${esc(n.method)}</b> ${esc(nameOf(n.url))}</span><span class="host">${esc(pathOf(n.url))}</span></button>
      ${tag ? `<span class="tag ${tag.level}">${esc(tag.label)}</span>` : ""}
      <div class="site-line"><span class="site loading">Finding the call site\u2026</span></div>
    </td>
    <td class="c-status"><span class="st ${sc}">${status}</span></td>
    <td class="c-time">${fmtMs(dur)}</td>
    <td class="c-size">${fmtSize(n.size)}</td>`;
}
function ensureRow(n) {
  let tr = rows.get(n.id);
  if (!tr) {
    tr = document.createElement("tr");
    tr.dataset.id = n.id;
    rows.set(n.id, tr);
    $("#net-rows").append(tr);
  }
  tr.className = `net-row st-${statusClass(n)}${problems(n, dupCounts.get(n.id)).some((p) => p.level === "error") ? " problem" : ""}`;
  tr.innerHTML = rowHtml(n);
  const row = tr;
  void callSite(n).then((site) => {
    const line = row.querySelector(".site-line");
    if (line && row.dataset.id === n.id) line.innerHTML = siteHtml(site);
  });
}
function upsert(n) {
  if (rows.has(n.id)) {
    ensureRow(n);
    if (selectedId === n.id) void renderDetail(n.id, true);
  }
  scheduleRefresh();
}
function syncRows() {
  computeBackendHosts();
  for (const n of S.net.values()) {
    const show = isBackendCall(n);
    const row = rows.get(n.id);
    if (show && !row) ensureRow(n);
    else if (!show && row) {
      row.remove();
      rows.delete(n.id);
      if (selectedId === n.id) closeDetail();
    }
  }
}
function clear3() {
  S.net.clear();
  dupCounts.clear();
  for (const tr of rows.values()) tr.remove();
  rows.clear();
  if (selectedId) closeDetail();
  scheduleRefresh();
}
var apiCalls = () => [...S.net.values()].filter((n) => rows.has(n.id));
function computeDups() {
  const groups = /* @__PURE__ */ new Map();
  for (const n of apiCalls()) {
    const k = `${n.method} ${n.url}`;
    const g = groups.get(k) ?? [];
    g.push(n);
    groups.set(k, g);
  }
  const next = /* @__PURE__ */ new Map();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.start - b.start);
    const burst = g.filter((n, i) => {
      const prev = g[i - 1], after = g[i + 1];
      return !!prev && n.start - prev.start < 1e3 || !!after && after.start - n.start < 1e3;
    });
    for (const n of burst) next.set(n.id, burst.length);
  }
  const changed = [.../* @__PURE__ */ new Set([...next.keys(), ...dupCounts.keys()])].filter((id) => next.get(id) !== dupCounts.get(id));
  dupCounts = next;
  for (const id of changed) {
    const n = S.net.get(id);
    if (n) ensureRow(n);
  }
}
var isProblem = (n) => ["4xx", "5xx", "failed"].includes(statusClass(n)) || problems(n, dupCounts.get(n.id)).some((p) => p.level !== "info");
function matches(n) {
  const k = codeKey(n);
  if (codeFilter.size && (!k || !codeFilter.has(k))) return false;
  if (input("#net-problems").checked && !isProblem(n)) return false;
  const q = input("#net-q").value.trim().toLowerCase();
  if (q) {
    const site = rows.get(n.id)?.querySelector(".site-line")?.textContent ?? "";
    if (!`${n.method} ${n.url} ${n.status ?? ""} ${site}`.toLowerCase().includes(q)) return false;
  }
  return true;
}
var sortVal = {
  name: (n) => nameOf(n.url).toLowerCase(),
  status: (n) => n.status ?? -1,
  size: (n) => n.size ?? 0,
  time: (n) => n.end ? n.end - n.start : Infinity
};
var raf = 0;
function scheduleRefresh() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(refresh);
}
function refresh() {
  syncRows();
  computeDups();
  const all = apiCalls();
  const visible = all.filter(matches);
  const visibleIds = new Set(visible.map((n) => n.id));
  const key = sortKey ? sortVal[sortKey] : null;
  visible.sort((a, b) => {
    if (!key) return b.start - a.start;
    const x = key(a), y = key(b);
    const r = x < y ? -1 : x > y ? 1 : 0;
    return sortDir === "ascending" ? r : -r;
  });
  const tbody = $("#net-rows");
  for (const [id, tr] of rows) tr.hidden = !visibleIds.has(id);
  let prev = null;
  for (const n of visible) {
    const tr = rows.get(n.id);
    if (!tr) continue;
    const want = prev ? prev.nextElementSibling : tbody.firstElementChild;
    if (want !== tr) {
      if (prev) prev.after(tr);
      else tbody.prepend(tr);
    }
    prev = tr;
  }
  renderCodes(all);
  const counts = new Map(STATUS_CLASSES.map((c) => [c, 0]));
  for (const n of all) {
    const c = statusClass(n);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const sum = STATUS_CLASSES.reduce((a, c) => a + (counts.get(c) ?? 0), 0) || 1;
  $("#net-bar").innerHTML = STATUS_CLASSES.filter((c) => counts.get(c)).map((c) => `<span class="bar-seg ${c}" style="flex:${(counts.get(c) ?? 0) / sum}" title="${c}: ${counts.get(c) ?? 0}"></span>`).join("");
  const hosts = [...new Set(all.map((n) => urlOf(n.url)?.host ?? ""))].filter(Boolean);
  const failed = all.filter((n) => ["4xx", "5xx", "failed"].includes(statusClass(n))).length;
  $("#net-summary").innerHTML = all.length ? `${visible.length === all.length ? "" : `Showing ${visible.length} of ${all.length}. `}${all.length} API call${all.length === 1 ? "" : "s"} to <b>${esc(hosts.slice(0, 2).join(", "))}${hosts.length > 2 ? "\u2026" : ""}</b>${failed ? `, <span class="bad">${failed} failed</span>` : ""}` : "";
  $("#net-empty").hidden = all.length > 0;
  $("#net-nomatch").hidden = !(all.length && !visible.length);
  emit("counts");
}
function renderCodes(all) {
  const counts = /* @__PURE__ */ new Map();
  for (const n of all) {
    const k = codeKey(n);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const k of codeFilter) if (!counts.has(k)) counts.set(k, 0);
  const keys = [...counts.keys()].sort((a, b) => codeOrder(a) - codeOrder(b));
  const max = Math.max(1, ...counts.values());
  const box = $("#net-codes");
  box.hidden = !keys.length;
  $(".codes-list", box).innerHTML = keys.map((k) => `
    <button type="button" class="code-row t-${codeTone(k)}" data-code="${esc(k)}" aria-pressed="${codeFilter.has(k)}">
      <span class="code-pill">${esc(codeLabel(k))}</span>
      <span class="code-mean">${esc(shortMeaning(k))}</span>
      <span class="code-bar"><span style="inline-size:${(counts.get(k) ?? 0) / max * 100}%"></span></span>
      <span class="code-n">${counts.get(k) ?? 0}</span>
    </button>`).join("");
  $(".codes-reset", box).hidden = !codeFilter.size;
}
var detailTab = "headers";
function prettyBody(b, headers) {
  if (!b) return '<p class="note">No body.</p>';
  if (!b.text) return `<p class="note">${esc(b.note ?? "Empty body.")}</p>`;
  let text = b.text;
  if (/json/.test(headerVal(headers, "content-type")) || /^\s*[[{]/.test(text)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
    }
  }
  return `<pre class="body-pre">${esc(text)}</pre>${b.truncated ? '<p class="note">Truncated at 200 KB.</p>' : ""}`;
}
var headerList = (list2) => list2?.length ? `<dl class="kv">${list2.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : '<p class="note">None captured.</p>';
function parsedJson(n) {
  const t = n.resBody?.text;
  if (!t || !/^\s*[[{]/.test(t)) return null;
  try {
    return { value: JSON.parse(t) };
  } catch {
    return null;
  }
}
function serverMessage(n) {
  if (!(n.status != null && n.status >= 400)) return "";
  const j = parsedJson(n)?.value;
  if (j && typeof j === "object" && !Array.isArray(j)) {
    const o = j;
    const err = o.error;
    const nested = err && typeof err === "object" ? err.message : void 0;
    const pick = o.message ?? nested ?? err ?? o.detail ?? o.title ?? o.msg ?? o.errors;
    if (pick != null) return typeof pick === "string" ? pick : JSON.stringify(pick).slice(0, 300);
  }
  const t = n.resBody?.text?.trim();
  if (!t) return "";
  if (t.startsWith("<")) {
    const m = /<pre[^>]*>([\s\S]{1,300}?)<\/pre>/i.exec(t) ?? /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(t) ?? /<title>([\s\S]{1,200}?)<\/title>/i.exec(t);
    return m?.[1] ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
  }
  return t.length < 200 ? t : "";
}
async function meaningHtml(n) {
  const m = meaning(n.status, n.statusText);
  if (!m) return "";
  const probs = problems(n, dupCounts.get(n.id));
  const sc = statusClass(n);
  const tone = sc === "4xx" ? "warn" : sc === "5xx" || sc === "failed" ? "error" : sc === "2xx" && !probs.some((p) => p.level === "error") ? "ok" : "info";
  const s = n.status ?? -1;
  const specific = s === 401 || s === 0 || s === 405 || s === 429 || sc === "aborted";
  const fromStatus = (s >= 400 || s === 0 || sc === "aborted") && probs.length ? probs[0] : null;
  const front = probs.filter((p) => (p !== fromStatus || specific) && (p.level !== "info" || sc === "aborted"));
  const msg = serverMessage(n);
  const site = await callSite(n);
  const ah = authHeader(n);
  const sent = ah ? `Sent with ${ah} header` : "Sent without auth header";
  const resp = n.status == null ? "Waiting\u2026" : n.status === 0 ? "No response" : `${n.status} ${m.title}`;
  const before = [...S.errors.values()].filter((e) => e.kind !== "http" && e.kind !== "warn" && e.first <= n.start && n.start - e.first < 3e3);
  const isOk = tone === "ok";
  const frontBox = front.length || !isOk && m.front ? `<div class="box"><h3>Check in the front end</h3>${front.map((p) => `<p><strong>${esc(p.label)}.</strong> ${esc(p.hint)}</p>`).join("")}${!isOk && m.front && !(specific && fromStatus) ? `<p>${esc(m.front)}</p>` : ""}</div>` : "";
  return `
    <ol class="facts-strip" aria-label="What happened">
      <li>${site.at ? esc(`${base(site.at.orig.file)}:${site.at.orig.line}`) : "Started by Angular"}</li>
      <li class="${!ah && n.status === 401 ? "f-warn" : ""}">${esc(sent)}</li>
      <li class="f-${tone}">${esc(resp)}</li>
    </ol>
    <div class="meaning ${tone}">
      <p class="m-title"><span class="st pill ${sc}">${n.status ?? "\u2026"}</span> ${esc(m.title)}</p>
      <h3>What the backend is saying</h3>
      <p>${esc(m.backend)}</p>
      ${msg ? `<p class="server-msg"><span>Server message</span> <code>${esc(msg)}</code></p>` : ""}
    </div>
    ${frontBox}
    ${!isOk && m.back ? `<div class="box"><h3>Check in the backend</h3><p>${esc(m.back)}</p></div>` : ""}
    ${before.length ? `<div class="box related"><h3>JS errors just before this request</h3>${before.map((e) => `<button type="button" class="link" data-err-key="${esc(e.key)}">${esc(e.message.slice(0, 90))}</button> <span class="note">${fmtMs(n.start - e.first)} earlier</span>`).join("<br>")}</div>` : ""}`;
}
function tabsFor(n) {
  const tabs = [["initiator", "Code"], ["headers", "Headers"]];
  if (n.reqBody) tabs.push(["payload", "Payload"]);
  tabs.push(["response", "Response"]);
  if (parsedJson(n)) tabs.push(["preview", "Preview"]);
  tabs.push(["timing", "Timing"]);
  return tabs;
}
async function tabBody(n, tab) {
  const dur = n.end ? n.end - n.start : null;
  switch (tab) {
    case "headers":
      return `
        <dl class="kv">
          <dt>URL</dt><dd>${esc(n.url)}</dd>
          <dt>Method</dt><dd>${esc(n.method)}</dd>
          <dt>Status</dt><dd><span class="st ${statusClass(n)}">${n.status ?? "\u2013"}</span> ${esc(n.statusText ?? "")}${n.error ? ` ${esc(n.error)}` : ""}</dd>
          <dt>Sent with</dt><dd>${n.kind === "xhr" ? "XMLHttpRequest (HttpClient)" : "fetch"}</dd>
        </dl>
        <h4>Response headers</h4>${headerList(n.resHeaders)}<h4>Request headers</h4>${headerList(n.reqHeaders)}`;
    case "payload":
      return prettyBody(n.reqBody, n.reqHeaders);
    case "response":
      return n.status == null ? '<p class="note">Waiting for the response\u2026</p>' : `
        <input type="search" class="find" placeholder="Find in response" aria-label="Find in response">
        ${prettyBody(n.resBody, n.resHeaders)}`;
    case "preview": {
      const j = parsedJson(n);
      return j ? `<div class="json">${jsonTree(j.value)}</div>` : "";
    }
    case "timing": {
      const first = Math.min(...apiCalls().map((x) => x.start));
      return `
        <dl class="kv">
          <dt>Started</dt><dd>${fmtMs(n.start - first)} after the first API call</dd>
          <dt>Duration</dt><dd>${fmtMs(dur)}</dd>
          <dt>Size</dt><dd>${fmtSize(n.size)}</dd>
        </dl>`;
    }
    case "initiator": {
      const frames = (await mapStack(n.initiator, 400)).filter(isAppFrame);
      if (!frames.length) return '<p class="note">No line in your code is on the call stack. The request was started by Angular itself, for example an <code>httpResource</code>, <code>resource</code> or <code>effect</code> reacting to a signal. Look for the signal or input that feeds it.</p>';
      const seen = /* @__PURE__ */ new Set();
      const picks = frames.filter((f) => !seen.has(f.orig.file) && !!seen.add(f.orig.file)).slice(0, 3);
      const blocks = await Promise.all(picks.map((f, i) => codeBlock(f.orig.file, f.orig.line, { tone: "focus", label: `${i === 0 ? "Called in" : "Triggered by"} ${f.orig.file}:${f.orig.line}` })));
      return blocks.join("");
    }
  }
}
var backBtn = `<button type="button" class="btn icon" data-act="back" aria-label="Back to the list">
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
</button>`;
var renderSeq = 0;
async function renderDetail(id, keepTab = false) {
  const seq = ++renderSeq;
  const n = S.net.get(id);
  if (!n) return;
  const tabs = tabsFor(n);
  if (!keepTab || !tabs.some(([k]) => k === detailTab)) detailTab = firstTab(n, tabs);
  const top = await meaningHtml(n);
  const body = await tabBody(n, detailTab);
  if (seq !== renderSeq) return;
  $("#net-detail").innerHTML = `
    <header class="detail-head">${backBtn}
      <h2 class="detail-title" tabindex="-1"><span class="meth">${esc(n.method)}</span> ${esc(nameOf(n.url))}</h2>
      <span class="st pill ${statusClass(n)}">${n.status ?? "\u2026"}</span>
    </header>
    <div class="detail-scroll">
      ${top}
      <div class="subtabs" role="tablist" aria-label="Request details">
        ${tabs.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === detailTab}">${label}</button>`).join("")}
      </div>
      <div class="tab-body" role="tabpanel">${body}</div>
      <div class="actions">
        <button type="button" class="btn small" data-act="to-requests">Open in Requests</button>
        <button type="button" class="btn small" data-copy="curl">Copy as cURL</button>
        <button type="button" class="btn small" data-copy="fetch">Copy as fetch</button>
        <button type="button" class="btn small" data-copy="response">Copy response</button>
        <span role="status" class="saved"></span>
      </div>
    </div>`;
}
function firstTab(n, tabs) {
  const has = (k) => tabs.some(([t]) => t === k);
  if (["4xx", "5xx"].includes(statusClass(n)) && has("response")) return "response";
  return "initiator";
}
async function openDetail(id) {
  selectedId = id;
  for (const tr of rows.values()) tr.removeAttribute("aria-current");
  rows.get(id)?.setAttribute("aria-current", "true");
  await renderDetail(id);
  $("#net-list-view").inert = true;
  $("#net-detail").hidden = false;
  $maybe(".detail-title")?.focus({ preventScroll: true });
}
function closeDetail() {
  const id = selectedId;
  selectedId = null;
  $("#net-detail").hidden = true;
  $("#net-list-view").inert = false;
  const tr = id ? rows.get(id) : void 0;
  tr?.querySelector(".row-open")?.focus({ preventScroll: false });
}
function step(dir) {
  const visible = $$("tr", $("#net-rows")).filter((tr) => !tr.hidden);
  const i = visible.findIndex((tr) => tr.dataset.id === selectedId);
  const next = visible[i + dir]?.dataset.id;
  if (next) void openDetail(next);
}
var shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function asCurl(n) {
  const parts = [`curl ${shellQuote(n.url)}`];
  if (n.method !== "GET") parts.push(`-X ${n.method}`);
  for (const [k, v] of n.reqHeaders) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (n.reqBody?.text) parts.push(`--data-raw ${shellQuote(n.reqBody.text)}`);
  return parts.join(" \\\n  ");
}
function asFetch(n) {
  const init5 = { method: n.method, headers: Object.fromEntries(n.reqHeaders) };
  if (n.reqBody?.text) init5.body = n.reqBody.text;
  return `await fetch(${JSON.stringify(n.url)}, ${JSON.stringify(init5, null, 2)});`;
}
function init3() {
  input("#net-q").addEventListener("input", scheduleRefresh);
  input("#net-problems").addEventListener("change", scheduleRefresh);
  $("#net-clear").addEventListener("click", () => {
    void send({ type: "clear:net" }).then(clear3);
  });
  $("#net-codes").addEventListener("click", (e) => {
    if (closest(e, ".codes-reset")) {
      codeFilter.clear();
      scheduleRefresh();
      return;
    }
    const k = closest(e, "[data-code]")?.dataset.code;
    if (!k) return;
    if (codeFilter.has(k)) codeFilter.delete(k);
    else codeFilter.add(k);
    scheduleRefresh();
  });
  $("#net-table thead").addEventListener("click", (e) => {
    const b = closest(e, "button[data-sort]");
    const th = b?.closest("th");
    const k = b?.dataset.sort;
    if (!b || !th || !(k === "name" || k === "status" || k === "size" || k === "time")) return;
    if (sortKey === k && sortDir === "descending") {
      sortKey = null;
      th.removeAttribute("aria-sort");
    } else {
      sortDir = sortKey === k ? "descending" : "ascending";
      sortKey = k;
      for (const x of $$("#net-table th")) x.removeAttribute("aria-sort");
      th.setAttribute("aria-sort", sortDir);
    }
    $("#net-sort-status").textContent = sortKey ? `Sorted by ${b.textContent?.trim() ?? sortKey}, ${sortDir}` : "Newest first";
    scheduleRefresh();
  });
  $("#net-rows").addEventListener("click", (e) => {
    if (closest(e, ".file-link")) return;
    const id = closest(e, "tr[data-id]")?.dataset.id;
    if (id) void openDetail(id);
  });
  const detail = $("#net-detail");
  detail.addEventListener("click", (e) => {
    if (closest(e, '[data-act="back"]')) {
      closeDetail();
      return;
    }
    const n = selectedId ? S.net.get(selectedId) : void 0;
    if (!n) return;
    if (closest(e, '[data-act="to-requests"]')) {
      emit("to-requests", n);
      emit("goto-tab", "requests");
      return;
    }
    const errKey = closest(e, "[data-err-key]")?.dataset.errKey;
    if (errKey) {
      openConsoleError(errKey);
      return;
    }
    const tab = closest(e, "[data-tab]");
    const t = tab?.dataset.tab;
    if (tab && (t === "headers" || t === "payload" || t === "response" || t === "preview" || t === "timing" || t === "initiator")) {
      detailTab = t;
      for (const x of $$("[data-tab]", detail)) x.setAttribute("aria-selected", String(x === tab));
      void tabBody(n, t).then((html) => {
        $(".tab-body", detail).innerHTML = html;
      });
      return;
    }
    const c = closest(e, "[data-copy]");
    if (c) void copyText(c, c.dataset.copy === "curl" ? asCurl(n) : c.dataset.copy === "fetch" ? asFetch(n) : n.resBody?.text ?? "");
  });
  detail.addEventListener("input", (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || !box.matches(".find")) return;
    const pre = $maybe(".body-pre", detail);
    if (!pre) return;
    const raw = pre.dataset.raw ?? (pre.dataset.raw = pre.textContent ?? "");
    const q = box.value;
    if (!q) {
      pre.textContent = raw;
      return;
    }
    pre.innerHTML = esc(raw).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
    pre.querySelector("mark")?.scrollIntoView({ block: "nearest" });
  });
  detail.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const inTabs = !!closest(e, '[role="tablist"]');
    if (e.key === "Escape") {
      e.preventDefault();
      closeDetail();
    } else if (e.key === "ArrowDown" && !inTabs) {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp" && !inTabs) {
      e.preventDefault();
      step(-1);
    }
  });
  on("settings-changed", scheduleRefresh);
}
var openConsoleError = () => {
};
function onOpenError(fn) {
  openConsoleError = fn;
}
var failedCount = () => apiCalls().filter((n) => ["4xx", "5xx", "failed"].includes(statusClass(n))).length;
var apiCount = () => rows.size;
function showProblems() {
  codeFilter.clear();
  input("#net-problems").checked = true;
  scheduleRefresh();
}

// src/shared/schema.ts
var ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
var pascal = (s) => {
  const p = s.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return /^\d/.test(p) ? `_${p}` : p || "Item";
};
var singular = (s) => /ies$/.test(s) ? s.replace(/ies$/, "y") : /(ss|us)$/.test(s) ? s : s.replace(/s$/, "");
var validKey = (k) => /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
function shapeOf(v) {
  if (v === null) return { kind: "null" };
  if (Array.isArray(v)) {
    const items = v.map(shapeOf);
    return { kind: "array", item: items.length ? items.reduce(merge) : { kind: "unknown" } };
  }
  switch (typeof v) {
    case "string":
      return { kind: ISO.test(v) && v.length > 9 ? "date" : "string" };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "object": {
      const props = /* @__PURE__ */ new Map();
      for (const [k, x] of Object.entries(v)) props.set(k, { shape: shapeOf(x), optional: false });
      return { kind: "object", props };
    }
    default:
      return { kind: "unknown" };
  }
}
var members = (s) => s.kind === "union" ? s.of : [s];
var stringy = (k) => k === "string" || k === "date";
function merge(a, b) {
  const out = [];
  for (const m of [...members(a), ...members(b)]) {
    const i = out.findIndex((x) => x.kind === m.kind || stringy(x.kind) && stringy(m.kind));
    const same = out[i];
    if (!same) {
      out.push(m);
      continue;
    }
    if (same.kind === "date" && m.kind === "string") out[i] = { kind: "string" };
    else if (same.kind === "array" && m.kind === "array") out[i] = { kind: "array", item: merge(same.item, m.item) };
    else if (same.kind === "object" && m.kind === "object") {
      const props = new Map(same.props);
      for (const [k, p] of m.props) {
        const q = props.get(k);
        props.set(k, q ? { shape: merge(q.shape, p.shape), optional: q.optional || p.optional } : { shape: p.shape, optional: true });
      }
      for (const [k, q] of props) if (!m.props.has(k)) props.set(k, { ...q, optional: true });
      out[i] = { kind: "object", props };
    }
  }
  return out.length === 1 && out[0] ? out[0] : { kind: "union", of: out };
}
function toTypeScript(value, rootName2 = "Response", { dates: dates2 = "string", exportKw = true } = {}) {
  const decls = [];
  const used = /* @__PURE__ */ new Set();
  const uniq = (n) => {
    let x = n, i = 2;
    while (used.has(x)) x = n + i++;
    used.add(x);
    return x;
  };
  const ex = exportKw ? "export " : "";
  function typeOf(s, hint) {
    switch (s.kind) {
      case "date":
        return dates2 === "Date" ? "Date" : "string";
      case "array": {
        const one = singular(hint);
        const t = typeOf(s.item, pascal(one) === pascal(hint) ? `${hint}Item` : one);
        return /[|&]/.test(t) && !t.startsWith("(") ? `(${t})[]` : `${t}[]`;
      }
      case "object":
        return declare(s.props, hint);
      case "union": {
        const parts = [...new Set(s.of.filter((m) => m.kind !== "null").map((m) => typeOf(m, hint)))];
        if (s.of.some((m) => m.kind === "null")) parts.push("null");
        return parts.join(" | ");
      }
      default:
        return s.kind;
    }
  }
  function declare(props, hint) {
    if (!props.size) return "Record<string, unknown>";
    const name = uniq(pascal(hint));
    const idx = decls.push(null) - 1;
    const lines = [...props].map(([k, p]) => `  ${validKey(k)}${p.optional ? "?" : ""}: ${typeOf(p.shape, k)};`);
    decls[idx] = `${ex}interface ${name} {
${lines.join("\n")}
}`;
    return name;
  }
  const root = shapeOf(value);
  const top = typeOf(root, rootName2);
  const body = decls.filter((d) => d !== null).join("\n\n");
  if (root.kind === "object" && top !== "Record<string, unknown>") return body;
  return `${ex}type ${pascal(rootName2)} = ${top};${body ? `

${body}` : ""}`;
}
function angularService({ method, url, hasBody, rootName: rootName2, isArrayRoot }) {
  const m = method.toLowerCase();
  const name = pascal(rootName2);
  let path = url;
  let base2 = "";
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
    base2 = u.origin;
  } catch {
  }
  const type = isArrayRoot ? `${name}[]` : name;
  const call = hasBody && m !== "delete" ? `this.http.${m}<${type}>(\`\${this.base}${path}\`, body)` : `this.http.${m}<${type}>(\`\${this.base}${path}\`)`;
  return `import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class ${name}Api {
  private readonly http = inject(HttpClient);
  private readonly base = '${base2}';

  ${m}${name}(${hasBody ? "body: unknown" : ""}) {
    return ${call};
  }
}`;
}

// src/panel/features/requests/requests.ts
var METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
var newRow = (key = "", value = "", enabled = true) => ({ key, value, on: enabled });
var blankAuth = () => ({ type: "none", token: "", user: "", pass: "", name: "X-API-Key" });
var blankDraft = () => ({ method: "GET", url: "", params: [newRow()], headers: [newRow()], bodyType: "json", body: "", auth: blankAuth() });
var isMethod = (m) => typeof m === "string" && METHODS.includes(m);
var isRows = (v) => Array.isArray(v) && v.every((r) => typeof r === "object" && r !== null && typeof Reflect.get(r, "key") === "string" && typeof Reflect.get(r, "value") === "string");
function readDraft(v) {
  if (typeof v !== "object" || v === null) return null;
  const d = blankDraft();
  const get = (k) => Reflect.get(v, k);
  const method = get("method"), url = get("url"), params = get("params"), headers = get("headers"), bodyType = get("bodyType"), body = get("body"), auth = get("auth");
  if (isMethod(method)) d.method = method;
  if (typeof url === "string") d.url = url;
  if (isRows(params) && params.length) d.params = params;
  if (isRows(headers) && headers.length) d.headers = headers;
  if (bodyType === "none" || bodyType === "json" || bodyType === "text" || bodyType === "form") d.bodyType = bodyType;
  if (typeof body === "string") d.body = body;
  if (typeof auth === "object" && auth !== null) {
    const t = Reflect.get(auth, "type");
    if (t === "none" || t === "bearer" || t === "basic" || t === "key") d.auth.type = t;
    for (const k of ["token", "user", "pass", "name"]) {
      const x = Reflect.get(auth, k);
      if (typeof x === "string") d.auth[k] = x;
    }
  }
  return d;
}
async function load(key) {
  try {
    return (await chrome.storage.local.get(key))[key];
  } catch {
    return void 0;
  }
}
var save = (key, value) => {
  chrome.storage.local.set({ [key]: value }).catch(() => {
  });
};
var req = blankDraft();
var vars = "";
var reqTab = "params";
var res = null;
var resTab = "body";
var rootName = "Response";
var nameEdited = false;
var dates = "string";
var history2 = [];
function varMap() {
  const m = /* @__PURE__ */ new Map();
  for (const line of vars.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trim().startsWith("#")) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return m;
}
var fill = (s) => {
  const m = varMap();
  return s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, k) => m.get(k) ?? all);
};
var active = (rows2) => rows2.filter((r) => r.on && r.key.trim());
function finalUrl() {
  const raw = fill(req.url.trim());
  if (!raw) return "";
  let u;
  try {
    u = new URL(raw, S.tabUrl || void 0);
  } catch {
    return raw;
  }
  for (const p of active(req.params)) u.searchParams.append(fill(p.key), fill(p.value));
  return u.toString();
}
function finalHeaders() {
  const hd = new Headers();
  const set = (k, v) => {
    try {
      hd.set(k, v);
    } catch {
    }
  };
  for (const r of active(req.headers)) set(fill(r.key), fill(r.value));
  const a = req.auth;
  if (a.type === "bearer" && a.token) set("Authorization", `Bearer ${fill(a.token)}`);
  if (a.type === "basic") set("Authorization", `Basic ${btoa(`${fill(a.user)}:${fill(a.pass)}`)}`);
  if (a.type === "key" && a.token) set(fill(a.name || "X-API-Key"), fill(a.token));
  if (req.bodyType === "json" && !hd.has("Content-Type")) set("Content-Type", "application/json");
  if (req.bodyType === "form" && !hd.has("Content-Type")) set("Content-Type", "application/x-www-form-urlencoded");
  return hd;
}
function finalBody() {
  if (req.method === "GET" || req.method === "HEAD" || req.bodyType === "none") return void 0;
  const b = fill(req.body);
  if (req.bodyType !== "form") return b || void 0;
  const p = new URLSearchParams();
  for (const line of b.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) p.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return p.toString();
}
var looksJson = (t) => /^\s*[[{]/.test(t);
function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
async function ensureAccess(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  const pattern = `${origin}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return true;
  }
}
async function sendRequest() {
  const url = finalUrl();
  if (!url) {
    showError("Enter a URL first.");
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    showError("The URL must start with http:// or https://, or be a path when a page is open.");
    return;
  }
  if (!await ensureAccess(url)) {
    showError("Access to this site was not granted, so the panel cannot call it from here.");
    return;
  }
  const btn = $("#rq-send");
  btn.disabled = true;
  btn.textContent = "Sending\u2026";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6e4);
  const t0 = performance.now();
  try {
    const body = finalBody();
    const r = await fetch(url, { method: req.method, headers: finalHeaders(), ...body !== void 0 ? { body } : {}, signal: ctrl.signal, credentials: "include", cache: "no-store" });
    const buf = await r.arrayBuffer();
    const ct = r.headers.get("content-type") ?? "";
    const text = /image|font|octet|zip|pdf|video|audio/.test(ct) ? "" : new TextDecoder().decode(buf);
    res = { status: r.status, statusText: r.statusText, time: performance.now() - t0, size: buf.byteLength, ct, text, headers: [...r.headers.entries()], binary: !text && buf.byteLength > 0 };
    remember();
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    res = { error: aborted ? "Timed out after 60 s." : `${e instanceof Error ? e.message : String(e)}. The server may be down, the URL wrong, or the certificate invalid.` };
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
    btn.textContent = "Send";
  }
  resTab = "body";
  renderResponse();
}
function showError(msg) {
  res = { error: msg };
  renderResponse();
}
var copyDraft = (d) => ({ ...d, params: d.params.map((r) => ({ ...r })), headers: d.headers.map((r) => ({ ...r })), auth: { ...d.auth } });
function remember() {
  const entry = copyDraft(req);
  const sig = `${entry.method} ${entry.url}`;
  history2 = [entry, ...history2.filter((x) => `${x.method} ${x.url}` !== sig)].slice(0, 15);
  save("req:history", history2);
  renderHistory();
}
var saveDraft = () => {
  save("req:draft", req);
};
function kvTable(rows2, kind) {
  return `<div class="kv-edit" data-kv="${kind}">${rows2.map((r, i) => `
    <div class="kv-row">
      <input type="checkbox" data-i="${i}" data-f="on" ${r.on ? "checked" : ""} aria-label="Enabled">
      <input type="text" data-i="${i}" data-f="key" value="${esc(r.key)}" placeholder="${kind === "headers" ? "Header" : "Name"}" spellcheck="false" aria-label="Name">
      <input type="text" data-i="${i}" data-f="value" value="${esc(r.value)}" placeholder="Value" spellcheck="false" aria-label="Value">
      <button type="button" class="btn ghost tiny" data-del="${i}" aria-label="Remove">\xD7</button>
    </div>`).join("")}
    <button type="button" class="btn ghost small" data-add="${kind}">+ Add</button></div>`;
}
var option = (value, label, current) => `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`;
function renderRequest() {
  const tabs = [
    ["params", "Params", active(req.params).length],
    ["headers", "Headers", active(req.headers).length],
    ["body", "Body", req.bodyType !== "none" && req.body ? 1 : 0],
    ["auth", "Auth", req.auth.type !== "none" ? 1 : 0],
    ["vars", "Variables", varMap().size]
  ];
  let body = "";
  if (reqTab === "params") body = kvTable(req.params, "params");
  else if (reqTab === "headers") body = kvTable(req.headers, "headers");
  else if (reqTab === "body") {
    const noBody = req.method === "GET" || req.method === "HEAD";
    body = `<div class="rq-line"><label for="rq-btype">Format</label>
      <select id="rq-btype">${option("none", "None", req.bodyType)}${option("json", "JSON", req.bodyType)}${option("text", "Text", req.bodyType)}${option("form", "Form (key=value lines)", req.bodyType)}</select>
      ${req.bodyType === "json" ? '<button type="button" class="btn ghost small" id="rq-fmt">Format JSON</button>' : ""}</div>
      ${req.bodyType === "none" ? '<p class="help">This request has no body.</p>' : `<textarea id="rq-body" class="rq-text" rows="8" spellcheck="false" aria-label="Request body" placeholder="${req.bodyType === "json" ? "{ &quot;name&quot;: &quot;Ada&quot; }" : ""}">${esc(req.body)}</textarea>`}
      ${noBody && req.bodyType !== "none" ? `<p class="help">${req.method} requests are sent without a body.</p>` : ""}`;
  } else if (reqTab === "auth") {
    const a = req.auth;
    const field = (k, placeholder) => `<input type="text" class="rq-in" data-auth="${k}" value="${esc(a[k])}" placeholder="${placeholder}" spellcheck="false" aria-label="${placeholder}">`;
    body = `<div class="rq-line"><label for="rq-atype">Type</label>
      <select id="rq-atype">${option("none", "None", a.type)}${option("bearer", "Bearer token", a.type)}${option("basic", "Basic", a.type)}${option("key", "API key header", a.type)}</select></div>
      ${a.type === "bearer" ? field("token", "Token or {{token}}") : ""}
      ${a.type === "basic" ? field("user", "Username") + field("pass", "Password") : ""}
      ${a.type === "key" ? field("name", "Header name") + field("token", "Key") : ""}
      <p class="help">Saved in this browser only. Use test tokens.</p>`;
  } else {
    body = `<textarea id="rq-vars" class="rq-text" rows="6" spellcheck="false" aria-label="Variables" placeholder="api=http://localhost:3000&#10;token=eyJ\u2026">${esc(vars)}</textarea>
      <p class="help">One <code>name=value</code> per line. Use them as <code>{{name}}</code> in the URL, headers, body and auth.</p>`;
  }
  $("#rq-sub").innerHTML = tabs.map(([k, l, n]) => `<button type="button" role="tab" data-rt="${k}" aria-selected="${k === reqTab}">${l}${n ? ` <span class="n">${n}</span>` : ""}</button>`).join("");
  $("#rq-pane").innerHTML = body;
  $("#rq-preview").textContent = finalUrl();
}
function renderHistory() {
  $("#rq-history").innerHTML = `<option value="">Recent requests</option>${history2.map((x, i) => `<option value="${i}">${esc(x.method)} ${esc(x.url.replace(/^https?:\/\//, ""))}</option>`).join("")}`;
}
function bodyHtml(r) {
  if (r.binary) return `<p class="help">Binary response (${esc(r.ct)}), ${fmtSize(r.size)}.</p>`;
  if (!r.text) return '<p class="help">Empty response body.</p>';
  const j = parseJson(r.text);
  return j.ok ? `<div class="json-tree">${jsonTree(j.value)}</div>` : `<pre class="rq-raw">${esc(r.text.slice(0, 2e5))}</pre>${looksJson(r.text) ? `<p class="help">Not valid JSON: ${esc(j.error)}</p>` : ""}`;
}
function buildCode(r) {
  const j = r.text ? parseJson(r.text) : null;
  if (!j?.ok) return false;
  r.ts = toTypeScript(j.value, rootName, { dates });
  r.svc = angularService({ method: req.method, url: finalUrl(), hasBody: finalBody() !== void 0, rootName, isArrayRoot: Array.isArray(j.value) });
  return true;
}
function interfaceHtml(r) {
  if (!buildCode(r)) return '<p class="help">The interface is generated from a JSON response. This one is not JSON.</p>';
  return `<div class="rq-line">
      <label for="rq-root">Name</label><input id="rq-root" class="rq-in short" value="${esc(rootName)}" spellcheck="false">
      <label for="rq-dates">Dates</label><select id="rq-dates">${option("string", "string", dates)}${option("Date", "Date", dates)}</select></div>
    <div class="code-head"><span>TypeScript</span><span><button type="button" class="btn small" data-copy="ts">Copy interfaces</button><span role="status" class="saved"></span></span></div>
    <pre class="rq-raw">${esc(r.ts ?? "")}</pre>
    <div class="code-head"><span>Angular service</span><span><button type="button" class="btn small" data-copy="svc">Copy service</button><span role="status" class="saved"></span></span></div>
    <pre class="rq-raw">${esc(r.svc ?? "")}</pre>
    <p class="help">Fields missing from some array items are marked optional. Check <code>null</code> and union types against your API contract.</p>`;
}
var statusTone = (s) => s >= 500 ? "bad" : s >= 400 ? "warn" : s >= 300 ? "info" : "ok";
function renderResponse() {
  const box = $("#rq-res");
  if (!res) {
    box.innerHTML = '<p class="empty">Send a request to see the response here.</p>';
    return;
  }
  if ("error" in res) {
    box.innerHTML = `<div class="rq-err" role="alert">${esc(res.error)}</div>`;
    return;
  }
  const r = res;
  const tabs = [["body", "Body"], ["headers", `Headers <span class="n">${r.headers.length}</span>`], ["interface", "Interface"]];
  const pane = resTab === "body" ? bodyHtml(r) : resTab === "headers" ? `<dl class="kv">${r.headers.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : interfaceHtml(r);
  box.innerHTML = `
    <div class="rq-status"><span class="st t-${statusTone(r.status)}">${r.status} ${esc(r.statusText)}</span>
      <span>${fmtMs(r.time)}</span><span>${fmtSize(r.size)}</span>
      ${r.ct ? `<span class="ct">${esc(r.ct.split(";")[0] ?? r.ct)}</span>` : ""}</div>
    <div class="subtabs" role="tablist" aria-label="Response">${tabs.map(([k, l]) => `<button type="button" role="tab" data-st="${k}" aria-selected="${k === resTab}">${l}</button>`).join("")}</div>
    <div class="rq-body">${pane}</div>
    ${resTab === "body" && r.text ? '<div class="actions"><button type="button" class="btn small" data-copy="raw">Copy response</button><span role="status" class="saved"></span></div>' : ""}`;
}
function refreshInterface() {
  if (!res || "error" in res || !buildCode(res)) return;
  const [ts, svc] = $$(".rq-raw", $("#rq-res"));
  if (ts) ts.textContent = res.ts ?? "";
  if (svc) svc.textContent = res.svc ?? "";
}
function suggestName(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter((s) => s && !/^\d+$/.test(s) && !/^v\d+$/.test(s) && s !== "api");
    const w = (seg.at(-1) ?? "Response").replace(/\.\w+$/, "").replace(/[^A-Za-z0-9]+/g, " ").trim();
    return w.split(" ").filter(Boolean).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join("") || "Response";
  } catch {
    return "Response";
  }
}
function syncTop() {
  $("#rq-method").value = req.method;
  $("#rq-url").value = req.url;
}
function reset() {
  res = null;
  reqTab = "params";
  nameEdited = false;
  rootName = suggestName(req.url);
  syncTop();
  renderRequest();
  renderResponse();
  saveDraft();
}
function loadFrom(n) {
  const ct = n.reqHeaders.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  let url = n.url;
  let params = [];
  try {
    const u = new URL(n.url);
    params = [...u.searchParams].map(([k, v]) => newRow(k, v));
    u.search = "";
    url = u.toString();
  } catch {
  }
  const text = n.reqBody?.text ?? "";
  const bodyType = !text ? "none" : /json/.test(ct) || looksJson(text) ? "json" : /x-www-form/.test(ct) ? "form" : "text";
  Object.assign(req, {
    method: isMethod(n.method) ? n.method : "GET",
    url,
    params: [...params, newRow()],
    headers: [...n.reqHeaders.map(([k, v]) => newRow(k, v)), newRow()],
    bodyType,
    body: bodyType === "form" ? text.split("&").map((p) => {
      try {
        return decodeURIComponent(p.replace(/\+/g, " "));
      } catch {
        return p;
      }
    }).join("\n") : text,
    auth: blankAuth()
  });
  rootName = suggestName(url);
  reset();
}
async function init4() {
  Object.assign(req, readDraft(await load("req:draft")) ?? blankDraft());
  const v = await load("req:vars");
  vars = typeof v === "string" ? v : "";
  const h = await load("req:history");
  history2 = Array.isArray(h) ? h.map(readDraft).filter((d) => d !== null) : [];
  rootName = suggestName(req.url);
  $("#rq-method").innerHTML = METHODS.map((m) => `<option>${m}</option>`).join("");
  syncTop();
  renderRequest();
  renderHistory();
  renderResponse();
  $("#rq-method").addEventListener("change", (e) => {
    const m = e.currentTarget.value;
    if (isMethod(m)) req.method = m;
    renderRequest();
    saveDraft();
  });
  $("#rq-url").addEventListener("input", (e) => {
    req.url = e.currentTarget.value;
    if (!nameEdited) rootName = suggestName(fill(req.url));
    $("#rq-preview").textContent = finalUrl();
    saveDraft();
  });
  $("#rq-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void sendRequest();
  });
  $("#rq-history").addEventListener("change", (e) => {
    const sel = e.currentTarget;
    const x = history2[Number(sel.value)];
    if (sel.value !== "" && x) {
      Object.assign(req, copyDraft(x));
      rootName = suggestName(req.url);
      reset();
    }
    sel.value = "";
  });
  $("#rq-new").addEventListener("click", () => {
    Object.assign(req, blankDraft());
    reset();
  });
  $("#rq-sub").addEventListener("click", (e) => {
    const t = closest(e, "[data-rt]")?.dataset.rt;
    if (t === "params" || t === "headers" || t === "body" || t === "auth" || t === "vars") {
      reqTab = t;
      renderRequest();
    }
  });
  const pane = $("#rq-pane");
  pane.addEventListener("input", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.dataset.f) {
      const kind = t.closest("[data-kv]")?.dataset.kv;
      const row = kind === "params" || kind === "headers" ? req[kind][Number(t.dataset.i)] : void 0;
      if (row) {
        if (t.dataset.f === "on") row.on = t.checked;
        else if (t.dataset.f === "key") row.key = t.value;
        else if (t.dataset.f === "value") row.value = t.value;
      }
    } else if (t instanceof HTMLTextAreaElement && t.id === "rq-body") req.body = t.value;
    else if (t instanceof HTMLTextAreaElement && t.id === "rq-vars") {
      vars = t.value;
      save("req:vars", vars);
    } else if (t instanceof HTMLInputElement) {
      const k = t.dataset.auth;
      if (k === "token" || k === "user" || k === "pass" || k === "name") req.auth[k] = t.value;
    }
    $("#rq-preview").textContent = finalUrl();
    saveDraft();
  });
  pane.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement)) return;
    if (t.id === "rq-btype" && (t.value === "none" || t.value === "json" || t.value === "text" || t.value === "form")) req.bodyType = t.value;
    else if (t.id === "rq-atype" && (t.value === "none" || t.value === "bearer" || t.value === "basic" || t.value === "key")) req.auth.type = t.value;
    else return;
    renderRequest();
    saveDraft();
  });
  pane.addEventListener("click", (e) => {
    const add2 = closest(e, "[data-add]")?.dataset.add;
    if (add2 === "params" || add2 === "headers") {
      req[add2].push(newRow());
      renderRequest();
      $$('[data-f="key"]', pane).at(-1)?.focus();
      return;
    }
    const del = closest(e, "[data-del]");
    const kind = del?.closest("[data-kv]")?.dataset.kv;
    if (del && (kind === "params" || kind === "headers")) {
      req[kind].splice(Number(del.dataset.del), 1);
      if (!req[kind].length) req[kind].push(newRow());
      renderRequest();
      saveDraft();
      return;
    }
    if (closest(e, "#rq-fmt")) {
      const j = parseJson(req.body);
      if (j.ok) {
        req.body = JSON.stringify(j.value, null, 2);
        renderRequest();
        saveDraft();
      }
    }
  });
  const out = $("#rq-res");
  out.addEventListener("click", (e) => {
    const t = closest(e, "[data-st]")?.dataset.st;
    if (t === "body" || t === "headers" || t === "interface") {
      resTab = t;
      renderResponse();
      return;
    }
    const c = closest(e, "[data-copy]");
    if (!c || !res || "error" in res) return;
    void copyText(c, c.dataset.copy === "ts" ? res.ts ?? "" : c.dataset.copy === "svc" ? res.svc ?? "" : res.text);
  });
  out.addEventListener("input", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.id === "rq-root") {
      rootName = e.target.value.trim() || "Response";
      nameEdited = true;
      refreshInterface();
    }
  });
  out.addEventListener("change", (e) => {
    if (e.target instanceof HTMLSelectElement && e.target.id === "rq-dates") {
      dates = e.target.value === "Date" ? "Date" : "string";
      refreshInterface();
    }
  });
  on("to-requests", loadFrom);
}

// src/panel/main.ts
function renderFramework() {
  const fw = S.framework;
  const el = $("#fw");
  if (!fw?.name) {
    el.innerHTML = '<span class="badge">No Angular app detected</span>';
    return;
  }
  const parts = [`<span class="badge lens">${esc(fw.name)} ${esc(fw.version ?? "")}</span>`];
  parts.push(fw.dev ? '<span class="badge">dev</span>' : '<span class="badge warn" title="Production build: component details are not available">prod build</span>');
  if (fw.zoneless) parts.push('<span class="badge">zoneless</span>');
  el.innerHTML = parts.join("");
}
function renderCounts() {
  const errN = errorCount();
  const failN = failedCount();
  const layoutN = layoutWarnings();
  $("#net-count").textContent = String(apiCount() || "");
  $("#net-fail").textContent = String(failN || "");
  $("#net-fail").title = failN ? `${failN} failed call${failN > 1 ? "s" : ""}` : "";
  $("#con-count").textContent = String(total() || "");
  $("#con-err").textContent = String(errN || "");
  $("#con-err").title = errN ? `${errN} error${errN > 1 ? "s" : ""}` : "";
  const strip = [];
  if (errN) strip.push(`<button type="button" class="health bad" data-go="errors">${errN} error${errN > 1 ? "s" : ""}</button>`);
  if (failN) strip.push(`<button type="button" class="health bad" data-go="failed">${failN} failed API call${failN > 1 ? "s" : ""}</button>`);
  if (layoutN) strip.push(`<button type="button" class="health warn" data-go="layout">${layoutN} layout issue${layoutN > 1 ? "s" : ""}</button>`);
  $("#health").innerHTML = strip.join("");
  $("#health").hidden = !strip.length;
}
on("counts", renderCounts);
on("errors-mapped", () => {
  if (S.selection) render();
});
function showErrors2() {
  selectTab("console");
  showErrors();
}
on("goto-errors", showErrors2);
$("#health").addEventListener("click", (e) => {
  switch (closest(e, "[data-go]")?.dataset.go) {
    case "errors":
      showErrors2();
      break;
    case "failed":
      selectTab("network");
      showProblems();
      break;
    case "layout":
      selectTab("inspect");
      showLayout();
      break;
  }
});
var TABS = ["inspect", "console", "network", "requests"];
function selectTab(name) {
  for (const t of TABS) {
    const tab = $(`#tab-${t}`), panel = $(`#panel-${t}`);
    const onTab = t === name;
    tab.setAttribute("aria-selected", String(onTab));
    tab.toggleAttribute("focusgroupstart", onTab);
    tab.tabIndex = onTab ? 0 : -1;
    panel.hidden = !onTab;
  }
}
for (const t of TABS) $(`#tab-${t}`).addEventListener("click", () => selectTab(t));
on("goto-tab", selectTab);
if (!("focusgroup" in HTMLElement.prototype)) {
  for (const t of TABS) $(`#tab-${t}`).tabIndex = t === "inspect" ? 0 : -1;
  $(".tablist").addEventListener("keydown", (e) => {
    const i = TABS.findIndex((t) => $(`#tab-${t}`) === document.activeElement);
    if (i < 0) return;
    const keys = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i - 1 + TABS.length) % TABS.length, Home: 0, End: TABS.length - 1 };
    const next = TABS[keys[e.key] ?? -1];
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    $(`#tab-${next}`).focus();
  });
}
async function startPick() {
  const ok = await send({ type: S.picking ? "picker:stop" : "picker:start" });
  if (ok === void 0) {
    void showOffline();
    return;
  }
  setPicking(!S.picking);
}
function setPicking(onState) {
  S.picking = onState;
  const b = $("#pick");
  b.setAttribute("aria-pressed", String(onState));
  $("span", b).textContent = onState ? "Picking\u2026 (Esc)" : "Pick";
}
$("#pick").addEventListener("click", () => {
  void startPick();
});
var isEditor = (v) => v === "vscode" || v === "cursor" || v === "webstorm";
async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  if (typeof settings === "object" && settings !== null) {
    const root = Reflect.get(settings, "root");
    const editor = Reflect.get(settings, "editor");
    const apiBase = Reflect.get(settings, "apiBase");
    if (typeof root === "string") S.settings.root = root;
    if (isEditor(editor)) S.settings.editor = editor;
    if (typeof apiBase === "string") S.settings.apiBase = apiBase;
  }
  input("#root").value = S.settings.root;
  $("#editor").value = S.settings.editor;
  input("#api-base").value = S.settings.apiBase;
}
$("#settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    S.settings.root = input("#root").value.trim();
    const editor = $("#editor").value;
    if (isEditor(editor)) S.settings.editor = editor;
    S.settings.apiBase = input("#api-base").value.trim();
    await chrome.storage.local.set({ settings: S.settings });
    emit("settings-changed");
    $("#saved").textContent = "Saved";
    setTimeout(() => {
      $("#saved").textContent = "";
    }, 1600);
  })();
});
function siteOrigin(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.hostname}/*` : null;
  } catch {
    return null;
  }
}
async function showOffline() {
  const box = $("#offline");
  const origin = siteOrigin(S.tabUrl);
  const granted = origin ? await chrome.permissions.contains({ origins: [origin] }) : false;
  if (!origin) {
    box.innerHTML = "<h2>Open your app to start</h2><p>Angular Lens works on your Angular app, for example <code>http://localhost:4200</code>.</p>";
  } else if (granted) {
    box.innerHTML = '<h2>Reload the page to connect</h2><p>Angular Lens starts with the page, so it can record API calls and errors from the first moment.</p><button type="button" class="btn primary" data-act="reload">Reload page</button>';
  } else {
    box.innerHTML = `<h2>Angular Lens is off for this site</h2><p>It runs on localhost by default. Turn it on for <code>${esc(new URL(S.tabUrl).hostname)}</code> to inspect it too.</p><button type="button" class="btn primary" data-act="enable">Turn on for this site</button>`;
  }
  box.hidden = false;
}
$("#offline").addEventListener("click", (e) => {
  const act = closest(e, "[data-act]")?.dataset.act;
  if (act === "reload" && S.tabId != null) void chrome.tabs.reload(S.tabId);
  if (act === "enable") enableSite();
});
function enableSite() {
  const origin = siteOrigin(S.tabUrl);
  if (!origin) return;
  chrome.permissions.request({ origins: [origin] }, (ok) => {
    if (!ok) return;
    const id = origin.replace(/[^a-z0-9]/gi, "_");
    void (async () => {
      try {
        await chrome.scripting.registerContentScripts([
          { id: `main_${id}`, matches: [origin], js: ["content/hook.main.js"], runAt: "document_start", world: "MAIN" },
          { id: `iso_${id}`, matches: [origin], js: ["content/isolated.js"], runAt: "document_start" }
        ]);
      } catch {
      }
      if (S.tabId != null) await chrome.tabs.reload(S.tabId);
    })();
  });
}
function resetView() {
  S.selection = null;
  S.framework = null;
  S.scripts = [];
  clear3();
  clear2();
  clear();
  setPicking(false);
  clearSourceCache();
}
var port = null;
function openPort(tabId) {
  port?.disconnect();
  port = chrome.tabs.connect(tabId, { name: PANEL_PORT });
  port.onDisconnect.addListener(() => {
    port = null;
  });
}
var PINNED_TAB = Number(new URLSearchParams(location.search).get("tabId")) || null;
async function connect() {
  resetView();
  const tab = PINNED_TAB ? await chrome.tabs.get(PINNED_TAB).catch(() => null) : (await chrome.tabs.query({ active: true, windowId: S.windowId ?? chrome.windows.WINDOW_ID_CURRENT }))[0];
  if (tab?.id == null) return;
  S.tabId = tab.id;
  S.tabUrl = tab.url ?? "";
  const snap = await send({ type: "snapshot" });
  if (!snap) {
    renderFramework();
    render();
    void showOffline();
    return;
  }
  $("#offline").hidden = true;
  openPort(tab.id);
  S.framework = snap.framework;
  S.selection = snap.selection;
  setPicking(snap.picking);
  for (const n of snap.net) {
    S.net.set(n.id, n);
    upsert(n);
  }
  for (const e of snap.errors) void add(e);
  for (const m of snap.logs) addLog(m);
  renderFramework();
  $("#con-empty").innerHTML = hints();
  render();
}
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || sender.tab?.id !== S.tabId) return;
  if (typeof msg !== "object" || msg === null || Reflect.get(msg, "type") !== "evt") return;
  const ev = msg;
  switch (ev.evt) {
    case "framework":
      S.framework = ev.payload;
      renderFramework();
      if (!S.selection) render();
      break;
    case "net:start":
      S.net.set(ev.payload.id, ev.payload);
      upsert(ev.payload);
      break;
    case "net:end": {
      const n = S.net.get(ev.payload.id);
      if (n) {
        Object.assign(n, ev.payload);
        upsert(n);
      }
      break;
    }
    case "err:add":
      void add(ev.payload);
      break;
    case "err:update":
      update(ev.payload);
      break;
    case "log":
      addLog(ev.payload);
      break;
    case "selection":
      S.selection = ev.payload;
      setPicking(false);
      selectTab("inspect");
      render();
      break;
    case "picker":
      setPicking(ev.payload.active);
      break;
  }
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!PINNED_TAB && windowId === S.windowId && tabId !== S.tabId) void connect();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== S.tabId) return;
  if (info.url) S.tabUrl = info.url;
  if (info.status === "complete") void connect();
});
init3();
onOpenError((key) => {
  selectTab("console");
  openError(key);
});
init();
init2(() => {
  void startPick();
});
void (async () => {
  const win = await chrome.windows.getCurrent();
  S.windowId = win.id ?? null;
  await loadSettings();
  await init4();
  await connect();
})();
//# sourceMappingURL=main.js.map
