"use strict";
(() => {
  // src/shared/messages.ts
  var OUT = "__felens:out";
  var IN = "__felens:in";
  var PAGE_EVENTS = /* @__PURE__ */ new Set(["reply", "framework", "net:start", "net:end", "err", "log", "eval:done"]);
  var isRecord = (v) => typeof v === "object" && v !== null;
  function parse(detail) {
    if (typeof detail !== "string") return null;
    try {
      return JSON.parse(detail);
    } catch {
      return null;
    }
  }
  function readPageEvent(detail) {
    const m = parse(detail);
    if (!isRecord(m) || typeof m.type !== "string" || !PAGE_EVENTS.has(m.type) || !isRecord(m.payload)) return null;
    return m;
  }
  var PANEL_PORT = "angular-lens-panel";

  // src/content/css-inspect.ts
  function splitTopLevel(sel, sep = ",") {
    const parts = [];
    let depth = 0, cur = "", quote = null;
    for (const ch of sel) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === "(" || ch === "[") depth++;
      if (ch === ")" || ch === "]") depth--;
      if (ch === sep && depth === 0) {
        parts.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }
  var add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  var cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  var max = (list) => list.reduce((m, s) => cmp(s, m) > 0 ? s : m, [0, 0, 0]);
  function specificity(selector) {
    let s = [0, 0, 0];
    let rest = selector;
    rest = rest.replace(/:(is|not|has|where|nth-child|nth-last-child)\(((?:[^()]|\([^()]*\))*)\)/g, (_m, fn, args) => {
      if (fn === "where") return " ";
      if (fn.startsWith("nth")) {
        s = add(s, [0, 1, 0]);
        const of = /\bof\b(.*)$/.exec(args);
        if (of?.[1]) s = add(s, max(splitTopLevel(of[1]).map(specificity)));
        return " ";
      }
      s = add(s, max(splitTopLevel(args).map(specificity)));
      return " ";
    });
    rest = rest.replace(/\[[^\]]*\]/g, () => {
      s = add(s, [0, 1, 0]);
      return " ";
    });
    rest = rest.replace(/#[\w-]+/g, () => {
      s = add(s, [1, 0, 0]);
      return " ";
    });
    rest = rest.replace(/\.[\w-]+/g, () => {
      s = add(s, [0, 1, 0]);
      return " ";
    });
    rest = rest.replace(/::[\w-]+(\([^)]*\))?/g, () => {
      s = add(s, [0, 0, 1]);
      return " ";
    });
    rest = rest.replace(/:[\w-]+(\([^)]*\))?/g, () => {
      s = add(s, [0, 1, 0]);
      return " ";
    });
    rest.replace(/(^|[\s>+~(])([a-zA-Z][\w-]*)/g, () => {
      s = add(s, [0, 0, 1]);
      return " ";
    });
    return s;
  }
  function sheetLabel(sheet) {
    if (sheet.href) {
      try {
        const u = new URL(sheet.href);
        return u.pathname.split("/").pop() || u.pathname;
      } catch {
        return sheet.href;
      }
    }
    const owner = sheet.ownerNode;
    if (owner instanceof HTMLStyleElement) return owner.id ? `<style#${owner.id}>` : "<style>";
    return "constructed";
  }
  function collect(el) {
    const matches = [];
    let order = 0;
    const visit = (rules, ctx, sheet) => {
      for (const rule of rules) {
        order++;
        if (rule instanceof CSSStyleRule) {
          let parts;
          try {
            parts = splitTopLevel(rule.selectorText);
          } catch {
            continue;
          }
          const hit = parts.filter((p) => {
            try {
              return el.matches(p);
            } catch {
              return false;
            }
          });
          if (hit.length) matches.push({ rule, sheet, ctx, order, selector: rule.selectorText, matched: hit, spec: max(hit.map(specificity)) });
          if (rule.cssRules.length) visit(rule.cssRules, ctx, sheet);
        } else if (rule instanceof CSSMediaRule) {
          const cond = rule.conditionText || rule.media.mediaText;
          if (matchMedia(cond).matches) visit(rule.cssRules, [...ctx, `@media ${cond}`], sheet);
        } else if (rule instanceof CSSSupportsRule) {
          if (CSS.supports(rule.conditionText)) visit(rule.cssRules, [...ctx, `@supports ${rule.conditionText}`], sheet);
        } else if (rule instanceof CSSLayerBlockRule) {
          visit(rule.cssRules, [...ctx, `@layer ${rule.name}`], sheet);
        } else if (rule instanceof CSSContainerRule) {
          visit(rule.cssRules, [...ctx, `@container ${rule.conditionText}`], sheet);
        } else if (typeof CSSScopeRule !== "undefined" && rule instanceof CSSScopeRule) {
          visit(rule.cssRules, [...ctx, "@scope"], sheet);
        }
      }
    };
    const sheets = [...document.styleSheets, ...document.adoptedStyleSheets];
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) sheets.push(...root.styleSheets, ...root.adoptedStyleSheets);
    for (const sheet of sheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      visit(rules, [], sheet);
    }
    return matches;
  }
  var SHORTHANDS = [
    "border-radius",
    "border-width",
    "border-style",
    "border-color",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border",
    "margin",
    "padding",
    "background",
    "font",
    "flex",
    "overflow",
    "outline",
    "transition",
    "animation",
    "grid-template",
    "list-style",
    "text-decoration",
    "columns",
    "mask"
  ];
  function declarations(style) {
    const longhands = [];
    for (let i = 0; i < style.length; i++) longhands.push(style.item(i));
    const claimed = /* @__PURE__ */ new Set();
    const lines = [];
    for (const sh of SHORTHANDS) {
      const v = style.getPropertyValue(sh);
      if (!v) continue;
      const parts = longhands.filter((l) => !claimed.has(l) && l.startsWith(`${sh}-`));
      const first = parts[0];
      if (!first) continue;
      parts.forEach((p) => claimed.add(p));
      lines.push({ prop: sh, value: v, important: style.getPropertyPriority(first) === "important", longhands: parts });
    }
    for (const l of longhands) {
      if (claimed.has(l)) continue;
      lines.push({ prop: l, value: style.getPropertyValue(l), important: style.getPropertyPriority(l) === "important", longhands: [l] });
    }
    return lines;
  }
  function scopeOwner(selector) {
    const id = /\[_ng(?:content|host)-([\w-]+)\]/.exec(selector)?.[1];
    if (!id) return null;
    const host2 = document.querySelector(`[_nghost-${CSS.escape(id)}]`);
    return host2 ? `<${host2.localName}>` : `_ng-${id}`;
  }
  function rulesFor(el) {
    const matched = collect(el);
    matched.sort((a, b) => cmp(b.spec, a.spec) || b.order - a.order);
    const winners = /* @__PURE__ */ new Set();
    const inline = el instanceof HTMLElement && el.getAttribute("style") ? declarations(el.style) : [];
    const all = [
      ...inline.length ? [{ label: "element.style", selector: 'style=""', lines: inline, inline: true }] : [],
      ...matched.map((m) => ({
        label: sheetLabel(m.sheet),
        selector: m.selector,
        matched: m.matched,
        ctx: m.ctx,
        owner: scopeOwner(m.selector),
        lines: declarations(m.rule.style)
      }))
    ];
    for (const important of [true, false]) {
      for (const r of all) {
        for (const d of r.lines) {
          if (important !== d.important) continue;
          d.overridden = d.longhands.every((lh) => winners.has(lh));
          d.longhands.forEach((lh) => winners.add(lh));
        }
      }
    }
    return all.slice(0, 40).map((r) => ({
      ...r,
      lines: r.lines.map((d) => ({ prop: d.prop, value: d.value, important: d.important, overridden: !!d.overridden }))
    }));
  }
  var ctx2d = null;
  function toRgba(color) {
    try {
      ctx2d ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
      if (!ctx2d) return null;
      ctx2d.clearRect(0, 0, 1, 1);
      ctx2d.fillStyle = "#000";
      ctx2d.fillStyle = color;
      ctx2d.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = ctx2d.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    } catch {
      return null;
    }
  }
  var lum = ([r, g, b]) => {
    const f = (c) => {
      const x = c / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  function effectiveBg(el) {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== "none") return null;
      const c = toRgba(cs.backgroundColor);
      if (c && c[3] > 0.95) return c;
    }
    return [255, 255, 255, 1];
  }
  function warnings(el) {
    const w = [];
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const push = (level, text, hint) => {
      w.push({ level, text, hint });
    };
    for (let n = el; n; n = n.parentElement) {
      const s = n === el ? cs : getComputedStyle(n);
      const firstClass = n.classList[0];
      const who = n === el ? "This element" : `Ancestor <${n.localName}${firstClass ? `.${firstClass}` : ""}>`;
      if (s.display === "none") {
        push("error", `${who} has display: none`, "Nothing inside it is rendered.");
        break;
      }
      if (s.visibility === "hidden" && n === el) push("warn", "visibility: hidden", "Takes space but is invisible.");
      if (parseFloat(s.opacity) === 0) {
        push("warn", `${who} has opacity: 0`, "Invisible but still clickable.");
        break;
      }
    }
    if (rect.width === 0 || rect.height === 0) {
      push(
        "warn",
        `Zero size (${Math.round(rect.width)}\xD7${Math.round(rect.height)})`,
        cs.display === "inline" ? "Inline elements ignore width/height. Use inline-block or block." : "Check that children are not all absolutely positioned or floated, and that a parent flex/grid gives it room."
      );
    }
    const overflowX = el.scrollWidth - el.clientWidth;
    const overflowY = el.scrollHeight - el.clientHeight;
    if (overflowX > 1 && cs.overflowX === "visible") push("warn", `Content overflows horizontally by ${overflowX}px`, "A child is wider than this box. Try min-width: 0 on flex/grid children, or overflow-wrap: anywhere for long text.");
    if (overflowY > 1 && cs.overflowY === "visible" && cs.height !== "auto" && !/(auto|fit|max|min)-content/.test(cs.height)) push("warn", `Content overflows vertically by ${overflowY}px`, "Fixed height is smaller than its content.");
    const vw = document.documentElement.clientWidth;
    if (rect.right > vw + 1 && cs.position !== "fixed") push("warn", `Extends ${Math.round(rect.right - vw)}px past the viewport`, "This can cause a horizontal page scrollbar.");
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflow !== "visible") {
        const pr = n.getBoundingClientRect();
        if (rect.right > pr.right + 1 || rect.bottom > pr.bottom + 1 || rect.left < pr.left - 1 || rect.top < pr.top - 1) {
          push("info", `Partly clipped by <${n.localName}> (overflow: ${s.overflow})`, "Parts outside that box are cut off.");
        }
        break;
      }
    }
    const parent = el.parentElement;
    const pcs = parent ? getComputedStyle(parent) : null;
    if (pcs?.display.includes("flex") && cs.minWidth === "auto" && overflowX > 1) {
      push("info", "Flex item with min-width: auto", "Flex items will not shrink below their content width. Add min-width: 0.");
    }
    if (cs.zIndex !== "auto" && cs.position === "static" && !(pcs && /flex|grid/.test(pcs.display))) {
      push("warn", `z-index: ${cs.zIndex} has no effect`, "z-index only works on positioned elements (relative/absolute/fixed/sticky) or flex/grid items.");
    }
    if (cs.pointerEvents === "none") push("info", "pointer-events: none", "Clicks pass through this element.");
    if (rect.width > 0 && rect.height > 0) {
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      if (cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight) {
        const top = document.elementsFromPoint(cx, cy).find((n) => !n.hasAttribute("data-felens-ui"));
        if (top && top !== el && !el.contains(top) && !top.contains(el)) {
          const d = `<${top.localName}${top.id ? `#${top.id}` : ""}${top.classList[0] ? `.${top.classList[0]}` : ""}>`;
          push("warn", `Covered by ${d} at its center`, "Clicks on that spot go to the covering element (check z-index / position).");
        }
      }
    }
    const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
    if (hasText) {
      const fg = toRgba(cs.color);
      const bg = effectiveBg(el);
      if (fg && bg) {
        const L1 = lum(fg), L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || size >= 18.66 && Number(cs.fontWeight) >= 700;
        const need = large ? 3 : 4.5;
        if (ratio < need) push("warn", `Low text contrast ${ratio.toFixed(2)}:1 (needs ${need}:1)`, `Color ${cs.color} on rgb(${bg.slice(0, 3).join(" ")}).`);
      }
    }
    if (el.localName === "img" && !el.hasAttribute("alt")) push("warn", "<img> without alt", 'Add alt="" for decorative images or a description.');
    const isButton = el.localName === "button" || el.getAttribute("role") === "button";
    if (isButton && !el.textContent?.trim() && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.getAttribute("title")) {
      push("warn", "Button has no accessible name", "Add text or aria-label.");
    }
    return w;
  }
  function boxModel(el) {
    const cs = getComputedStyle(el);
    const px = (v) => Math.round(parseFloat(v) * 10) / 10 || 0;
    const r = el.getBoundingClientRect();
    const round = (n) => Math.round(n * 10) / 10;
    const margin = [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)];
    const border = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)];
    const padding = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)];
    return {
      display: cs.display,
      position: cs.position,
      boxSizing: cs.boxSizing,
      width: round(r.width),
      height: round(r.height),
      margin,
      border,
      padding,
      content: [
        round(r.width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth)),
        round(r.height - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderTopWidth) - px(cs.borderBottomWidth))
      ],
      key: {
        color: cs.color,
        background: cs.backgroundColor,
        font: `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily.split(",")[0] ?? ""}`,
        zIndex: cs.zIndex,
        overflow: cs.overflow,
        gap: cs.gap
      }
    };
  }
  function analyze(el) {
    try {
      return { box: boxModel(el), warnings: warnings(el), rules: rulesFor(el) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // src/content/picker.ts
  var CSS_TEXT = `
  :host { all: initial; }
  .layer { position: fixed; pointer-events: none; box-sizing: border-box; }
  .margin { background: rgb(246 178 107 / .35); }
  .border { background: rgb(255 229 153 / .35); outline: 1px solid rgb(26 115 232 / .9); anchor-name: --fl-el; }
  .padding { background: rgb(147 196 125 / .40); }
  .content { background: rgb(111 168 220 / .45); }
  .selected .border { outline: 2px solid #1a73e8; background: transparent; }
  .selected .margin, .selected .padding, .selected .content { background: transparent; }
  .label {
    position: fixed; position-anchor: --fl-el;
    position-area: block-start span-inline-end;
    position-try-fallbacks: flip-block, block-end span-inline-end;
    margin: 4px 0; max-inline-size: min(60ch, 90vw);
    font: 500 12px/1.35 ui-sans-serif, system-ui, sans-serif;
    color: #fff; background: #202124; border-radius: 6px; padding: 4px 8px;
    box-shadow: 0 2px 8px rgb(0 0 0 / .3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    pointer-events: none;
  }
  .label b { color: #8ab4f8; font-weight: 600; }
  .label .tag { color: #f28b82; }
  .label .dim { color: #bdc1c6; }
  .hint {
    position: fixed; inset-block-end: 12px; inset-inline-start: 50%; translate: -50% 0;
    font: 500 12px/1.4 ui-sans-serif, system-ui, sans-serif; color: #fff; background: #1a73e8;
    padding: 6px 12px; border-radius: 999px; box-shadow: 0 2px 8px rgb(0 0 0 / .3);
    pointer-events: none;
  }
  [hidden] { display: none !important; }
`;
  var host = null;
  var els = null;
  var picking = false;
  var hoverEl = null;
  var selectedEl = null;
  var raf = 0;
  var onPick = null;
  var hoverInfo = () => null;
  var pointer = null;
  var manual = false;
  function setHoverInfo(fn) {
    hoverInfo = fn;
  }
  function part(root, sel) {
    const el = root.querySelector(sel);
    if (!(el instanceof HTMLElement)) throw new Error(`overlay part ${sel} missing`);
    return el;
  }
  function ensureOverlay() {
    if (host?.isConnected && els) return els;
    host = document.createElement("div");
    host.setAttribute("data-felens-ui", "");
    host.setAttribute("popover", "manual");
    host.style.cssText = "all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
    <style>${CSS_TEXT}</style>
    <div class="box" hidden>
      <div class="layer margin"></div><div class="layer border"></div>
      <div class="layer padding"></div><div class="layer content"></div>
    </div>
    <div class="label" hidden></div>
    <div class="hint" hidden>Click to inspect \xB7 \u2191 \u2193 parent / child \xB7 Esc to cancel</div>`;
    els = {
      box: part(root, ".box"),
      margin: part(root, ".margin"),
      border: part(root, ".border"),
      padding: part(root, ".padding"),
      content: part(root, ".content"),
      label: part(root, ".label"),
      hint: part(root, ".hint")
    };
    document.documentElement.append(host);
    return els;
  }
  function show() {
    const parts = ensureOverlay();
    try {
      if (host?.matches(":popover-open")) host.hidePopover();
      host?.showPopover();
    } catch {
    }
    return parts;
  }
  function hideOverlay() {
    cancelAnimationFrame(raf);
    if (els) {
      els.box.hidden = true;
      els.label.hidden = true;
      els.hint.hidden = true;
    }
    try {
      if (host?.matches(":popover-open")) host.hidePopover();
    } catch {
    }
  }
  var FLASH_MS = 2500;
  var flashing = false;
  var flashTimer = 0;
  function endFlash() {
    flashing = false;
    clearTimeout(flashTimer);
    removeEventListener("pointerdown", endFlash, true);
    removeEventListener("scroll", endFlash, true);
    removeEventListener("keydown", endFlash, true);
    if (!picking) hideOverlay();
  }
  function flash() {
    flashing = true;
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(endFlash, FLASH_MS);
    setTimeout(() => {
      if (!flashing) return;
      addEventListener("pointerdown", endFlash, true);
      addEventListener("scroll", endFlash, { capture: true, passive: true });
      addEventListener("keydown", endFlash, true);
    }, 0);
  }
  var place = (node, x, y, w, h) => {
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.width = `${Math.max(0, w)}px`;
    node.style.height = `${Math.max(0, h)}px`;
  };
  function draw(p, el) {
    if (!el.isConnected) {
      p.box.hidden = true;
      p.label.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const n = (v) => parseFloat(v) || 0;
    const [mt, mr, mb, ml] = [n(cs.marginTop), n(cs.marginRight), n(cs.marginBottom), n(cs.marginLeft)];
    const [bt, br, bb, bl] = [n(cs.borderTopWidth), n(cs.borderRightWidth), n(cs.borderBottomWidth), n(cs.borderLeftWidth)];
    const [pt, pr, pb, pl] = [n(cs.paddingTop), n(cs.paddingRight), n(cs.paddingBottom), n(cs.paddingLeft)];
    place(p.margin, r.left - ml, r.top - mt, r.width + ml + mr, r.height + mt + mb);
    place(p.border, r.left, r.top, r.width, r.height);
    place(p.padding, r.left + bl, r.top + bt, r.width - bl - br, r.height - bt - bb);
    place(p.content, r.left + bl + pl, r.top + bt + pt, r.width - bl - br - pl - pr, r.height - bt - bb - pt - pb);
    p.box.hidden = false;
  }
  function loop() {
    cancelAnimationFrame(raf);
    const p = els;
    if (!p) return;
    const tick = () => {
      if (picking && pointer && !manual) {
        const el = hitTest(pointer.x, pointer.y);
        if (el && el !== hoverEl) {
          hoverEl = el;
          setLabel(el);
        }
      }
      const target = picking ? hoverEl : flashing ? selectedEl : null;
      if (!target) {
        p.box.hidden = true;
        p.label.hidden = true;
        if (picking) raf = requestAnimationFrame(tick);
        else hideOverlay();
        return;
      }
      p.box.classList.toggle("selected", !picking);
      draw(p, target);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  var escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  function setLabel(el) {
    if (!els) return;
    const r = el.getBoundingClientRect();
    const info = hoverInfo(el);
    let tag = el.localName;
    if (el.id) tag += `#${el.id}`;
    const cls = [...el.classList].filter((c) => !c.startsWith("ng-")).slice(0, 2);
    if (cls.length) tag += `.${cls.join(".")}`;
    els.label.innerHTML = (info?.name ? `<b>${escapeHtml(info.name)}</b> <span class="dim">\u203A</span> ` : "") + `<span class="tag">${escapeHtml(tag)}</span> <span class="dim">${Math.round(r.width)}\xD7${Math.round(r.height)}</span>`;
    els.label.hidden = false;
  }
  var isOurs = (el) => !!el && (el === host || !!el.closest("[data-felens-ui]"));
  function hitTest(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el && !isOurs(el) ? el : null;
  }
  function setHover(el) {
    if (!el || el === hoverEl) return;
    hoverEl = el;
    setLabel(el);
  }
  function onMove(e) {
    pointer = { x: e.clientX, y: e.clientY };
    manual = false;
    setHover(hitTest(pointer.x, pointer.y));
  }
  function swallow(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function finish(el) {
    stop();
    if (el && !isOurs(el)) {
      select(el);
      onPick?.(el);
    }
  }
  function onClick(e) {
    if (!picking) return;
    swallow(e);
    finish(hoverEl ?? hitTest(e.clientX, e.clientY));
  }
  function onKey(e) {
    if (!picking) return;
    if (e.key === "Escape") {
      swallow(e);
      stop();
      return;
    }
    const up = hoverEl?.parentElement;
    if (e.key === "ArrowUp" && up && up !== document.documentElement) {
      swallow(e);
      manual = true;
      setHover(up);
    } else if (e.key === "ArrowDown" && hoverEl) {
      swallow(e);
      const under = pointer ? hitTest(pointer.x, pointer.y) : null;
      let child = null;
      for (let n = under; n && n !== hoverEl; n = n.parentElement) child = n;
      child ??= hoverEl.firstElementChild;
      if (child) {
        manual = true;
        setHover(child);
      }
    } else if (e.key === "Enter" && hoverEl) {
      swallow(e);
      finish(hoverEl);
    }
  }
  var BLOCKED = ["pointerdown", "pointerup", "mousedown", "mouseup"];
  function start(cb) {
    onPick = cb;
    const p = show();
    picking = true;
    hoverEl = null;
    manual = false;
    pointer = null;
    p.hint.hidden = false;
    document.documentElement.style.cursor = "crosshair";
    addEventListener("pointermove", onMove, true);
    addEventListener("click", onClick, true);
    for (const t of BLOCKED) addEventListener(t, swallow, true);
    addEventListener("keydown", onKey, true);
    loop();
  }
  function stop() {
    picking = false;
    if (els) {
      els.hint.hidden = true;
      els.label.hidden = true;
    }
    document.documentElement.style.cursor = "";
    removeEventListener("pointermove", onMove, true);
    removeEventListener("click", onClick, true);
    for (const t of BLOCKED) removeEventListener(t, swallow, true);
    removeEventListener("keydown", onKey, true);
    loop();
  }
  function select(el) {
    show();
    selectedEl = el;
    setLabel(el);
    flash();
    loop();
  }
  var altPick = null;
  var ALT_BLOCKED = ["pointerdown", "pointerup", "mousedown", "mouseup"];
  function altSwallow(e) {
    if (!e.altKey || picking) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function altClick(e) {
    if (!e.altKey || picking || !altPick) return;
    altSwallow(e);
    const el = hitTest(e.clientX, e.clientY);
    if (el) {
      select(el);
      altPick(el);
    }
  }
  function setAltPick(cb) {
    const was = altPick !== null;
    altPick = cb;
    if (cb && !was) {
      addEventListener("click", altClick, true);
      for (const t of ALT_BLOCKED) addEventListener(t, altSwallow, true);
    } else if (!cb && was) {
      removeEventListener("click", altClick, true);
      for (const t of ALT_BLOCKED) removeEventListener(t, altSwallow, true);
    }
  }
  var isPicking = () => picking;
  var selected = () => selectedEl;

  // src/content/isolated.ts
  (() => {
    if (window.__feLensBridge) return;
    window.__feLensBridge = true;
    const MAX_NET = 600;
    const MAX_ERR = 200;
    const MAX_LOG = 500;
    const state = {
      framework: null,
      net: /* @__PURE__ */ new Map(),
      // insertion ordered
      errors: /* @__PURE__ */ new Map(),
      // fingerprint → grouped error
      logs: [],
      // oldest first
      selection: null
    };
    const pendingEval = /* @__PURE__ */ new Map();
    let evalSeq = 0;
    const toPanel = (e) => {
      const msg = { type: "evt", ...e };
      chrome.runtime.sendMessage(msg).catch(() => {
      });
    };
    let badgeTimer = 0;
    const updateBadge = () => {
      clearTimeout(badgeTimer);
      badgeTimer = window.setTimeout(() => {
        let n = 0;
        for (const e of state.errors.values()) if (e.kind !== "warn") n += e.count;
        const msg = { type: "badge", errors: n };
        chrome.runtime.sendMessage(msg).catch(() => {
        });
      }, 250);
    };
    const dropOldest = (m, max2) => {
      if (m.size <= max2) return;
      const first = m.keys().next();
      if (!first.done) m.delete(first.value);
    };
    let rid = 0;
    const replies = { last: null };
    function rpc(type, el, extra = {}) {
      const id = ++rid;
      const q = el ? `q${id}` : null;
      if (el && q) el.setAttribute("data-felens-q", q);
      replies.last = null;
      try {
        const req = { type, rid: id, q, ...extra };
        document.dispatchEvent(new CustomEvent(IN, { detail: JSON.stringify(req) }));
      } finally {
        el?.removeAttribute("data-felens-q");
      }
      const reply = lastReply();
      return reply?.rid === id ? reply.payload : null;
    }
    const lastReply = () => replies.last;
    function fingerprint(e) {
      const frame = e.stack.split("\n").find((l) => /:\d+:\d+/.test(l)) ?? "";
      return `${e.kind === "warn" ? "w" : "e"}|${e.message.slice(0, 300)}|${frame.trim()}`;
    }
    function addError(e) {
      const key = fingerprint(e);
      const prev = state.errors.get(key);
      if (prev) {
        prev.count++;
        prev.last = e.time;
        toPanel({ evt: "err:update", payload: { key, count: prev.count, last: prev.last } });
      } else {
        const entry = { ...e, key, count: 1, first: e.time, last: e.time };
        state.errors.set(key, entry);
        dropOldest(state.errors, MAX_ERR);
        toPanel({ evt: "err:add", payload: entry });
      }
      updateBadge();
    }
    document.addEventListener(OUT, (ev) => {
      const msg = ev instanceof CustomEvent ? readPageEvent(ev.detail) : null;
      if (!msg) return;
      switch (msg.type) {
        case "reply":
          replies.last = msg.payload;
          break;
        case "framework":
          state.framework = msg.payload;
          toPanel({ evt: "framework", payload: msg.payload });
          break;
        case "net:start":
          state.net.set(msg.payload.id, msg.payload);
          dropOldest(state.net, MAX_NET);
          toPanel({ evt: "net:start", payload: msg.payload });
          break;
        case "net:end": {
          const p = msg.payload;
          const entry = state.net.get(p.id);
          if (!entry) break;
          Object.assign(entry, p);
          toPanel({ evt: "net:end", payload: p });
          if (p.status === 0 || p.status >= 400) {
            const what = p.status ? `${p.status} ${p.statusText}`.trim() : p.statusText || "failed";
            addError({ kind: "http", message: `${entry.method} ${entry.url} \u2192 ${what}`, stack: entry.initiator, code: null, time: Date.now(), netId: entry.id });
          }
          break;
        }
        case "err":
          addError(msg.payload);
          break;
        case "log":
          state.logs.push(msg.payload);
          if (state.logs.length > MAX_LOG) state.logs.shift();
          toPanel({ evt: "log", payload: msg.payload });
          break;
        case "eval:done": {
          const { id, ...result } = msg.payload;
          const respond = pendingEval.get(id);
          pendingEval.delete(id);
          respond?.(result);
          break;
        }
      }
    });
    const pathToEl = (path) => {
      let n = document.documentElement;
      for (const i of path) {
        n = n?.children[i];
        if (!n) return null;
      }
      return n ?? null;
    };
    const elToPath = (el) => {
      const path = [];
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const parent = n.parentElement;
        if (!parent) break;
        path.unshift([...parent.children].indexOf(n));
      }
      return path;
    };
    function domNode(el, path) {
      const r = el.getBoundingClientRect();
      const hover = rpc("hover", el);
      return {
        path,
        tag: el.localName,
        id: el.id,
        classes: [...el.classList].filter((c) => !c.startsWith("ng-")),
        childCount: el.children.length,
        component: hover?.name ?? null,
        w: Math.round(r.width),
        h: Math.round(r.height)
      };
    }
    function domPathOf(path) {
      const out = [domNode(document.documentElement, [])];
      let node = document.documentElement;
      for (const [i, idx] of path.entries()) {
        const child = node.children[idx];
        if (!child) break;
        node = child;
        out.push(domNode(child, path.slice(0, i + 1)));
      }
      return out;
    }
    const MAX_CHILDREN = 50;
    function domChildrenOf(el, path) {
      return [...el.children].slice(0, MAX_CHILDREN).map((c, i) => domNode(c, [...path, i]));
    }
    function inspect(el) {
      const fw = rpc("inspect", el) ?? { chain: [] };
      const r = el.getBoundingClientRect();
      const attrs = [...el.attributes].map((a) => a.name).filter((n) => !/^(_ng|ng-|data-felens|class$|style$|id$)/.test(n));
      const ownText = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())?.textContent?.trim().slice(0, 40) ?? "";
      const path = elToPath(el);
      const navigable = pathToEl(path) === el;
      const siblings = el.parentElement ? [...el.parentElement.children] : [el];
      const sel = {
        element: fw.element ?? el.localName,
        elementIsHost: !!fw.elementIsHost,
        desc: { tag: el.localName, id: el.id, classes: [...el.classList].filter((c) => !c.startsWith("ng-")), attrs, text: ownText },
        domPath: navigable ? domPathOf(path) : [],
        domChildren: navigable ? domChildrenOf(el, path) : [],
        siblingIndex: siblings.indexOf(el),
        siblingCount: siblings.length,
        framework: fw.framework ?? state.framework,
        chain: fw.chain,
        listeners: fw.listeners ?? [],
        directives: fw.directives ?? [],
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        text: (el instanceof HTMLElement ? el.innerText : el.textContent ?? "").trim().slice(0, 80),
        css: analyze(el)
      };
      if (fw.error) sel.error = fw.error;
      state.selection = sel;
      return sel;
    }
    setHoverInfo((el) => rpc("hover", el));
    function pick() {
      start((el) => toPanel({ evt: "selection", payload: inspect(el) }));
      toPanel({ evt: "picker", payload: { active: true } });
    }
    function handle(msg, reply) {
      switch (msg.type) {
        case "snapshot": {
          state.framework ??= rpc("detect", null);
          const snap = {
            url: location.href,
            framework: state.framework,
            net: [...state.net.values()],
            errors: [...state.errors.values()],
            logs: state.logs,
            selection: state.selection,
            picking: isPicking()
          };
          reply(snap);
          return false;
        }
        case "scripts": {
          const urls = /* @__PURE__ */ new Set();
          for (const s of document.scripts) if (s.src) urls.add(s.src);
          for (const e of performance.getEntriesByType("resource")) {
            if (/\.m?js(\?|$)/.test(e.name) && e.name.startsWith(location.origin)) urls.add(e.name);
          }
          reply([...urls].filter((u) => u.startsWith(location.origin)));
          return false;
        }
        case "picker:toggle":
        case "picker:start":
          if (isPicking() && msg.type === "picker:toggle") {
            stop();
            toPanel({ evt: "picker", payload: { active: false } });
          } else pick();
          reply(true);
          return false;
        case "picker:stop":
          stop();
          reply(true);
          return false;
        case "eval": {
          const id = ++evalSeq;
          const timer = setTimeout(() => {
            if (!pendingEval.delete(id)) return;
            reply({ ok: false, error: "No result after 30 s: the promise never settled." });
          }, 3e4);
          pendingEval.set(id, (r) => {
            clearTimeout(timer);
            reply(r);
          });
          const sel = selected();
          rpc("eval", sel?.isConnected ? sel : null, { id, code: msg.code });
          return true;
        }
        case "clear:logs":
          state.logs = [];
          reply(true);
          return false;
        case "clear:net":
          state.net.clear();
          reply(true);
          return false;
        case "clear:errors":
          state.errors.clear();
          updateBadge();
          reply(true);
          return false;
        case "select:path": {
          const el = pathToEl(msg.path);
          if (el) {
            select(el);
            el.scrollIntoView({ block: "nearest", behavior: "smooth" });
            reply(inspect(el));
          } else reply(null);
          return false;
        }
      }
    }
    let panels = 0;
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PANEL_PORT || port.sender?.id !== chrome.runtime.id) return;
      panels++;
      setAltPick((el) => toPanel({ evt: "selection", payload: inspect(el) }));
      port.onDisconnect.addListener(() => {
        panels--;
        if (panels <= 0) {
          panels = 0;
          setAltPick(null);
        }
      });
    });
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || typeof msg !== "object" || msg === null || !("type" in msg)) return false;
      return handle(msg, sendResponse);
    });
  })();
})();
//# sourceMappingURL=isolated.js.map
