// Angular Lens — CSS analysis for one element (isolated world; shares the DOM).
// Returns: box model, matched rules (with overridden declarations marked),
// and plain-language warnings for the usual "why does it look like this?" bugs.
(() => {
  if (globalThis.FeLensCss) return;

  // ───────────── specificity ─────────────
  // [ids, classes/attrs/pseudo-classes, types/pseudo-elements]
  function splitTopLevel(sel, sep = ',') {
    const parts = [];
    let depth = 0, cur = '', quote = null;
    for (const ch of sel) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (ch === sep && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const max = (list) => list.reduce((m, s) => (cmp(s, m) > 0 ? s : m), [0, 0, 0]);

  function specificity(selector) {
    let s = [0, 0, 0];
    let rest = selector;
    // Functional pseudo-classes first.
    rest = rest.replace(/:(is|not|has|where|nth-child|nth-last-child)\(((?:[^()]|\([^()]*\))*)\)/g, (_, fn, args) => {
      if (fn === 'where') return ' ';
      if (fn.startsWith('nth')) {
        s = add(s, [0, 1, 0]);
        const of = /\bof\b(.*)$/.exec(args);
        if (of) s = add(s, max(splitTopLevel(of[1]).map(specificity)));
        return ' ';
      }
      s = add(s, max(splitTopLevel(args).map(specificity)));
      return ' ';
    });
    rest = rest.replace(/\[[^\]]*\]/g, () => { s = add(s, [0, 1, 0]); return ' '; });
    rest = rest.replace(/#[\w-]+/g, () => { s = add(s, [1, 0, 0]); return ' '; });
    rest = rest.replace(/\.[\w-]+/g, () => { s = add(s, [0, 1, 0]); return ' '; });
    rest = rest.replace(/::[\w-]+(\([^)]*\))?/g, () => { s = add(s, [0, 0, 1]); return ' '; });
    rest = rest.replace(/:[\w-]+(\([^)]*\))?/g, () => { s = add(s, [0, 1, 0]); return ' '; });
    rest.replace(/(^|[\s>+~(])([a-zA-Z][\w-]*)/g, () => { s = add(s, [0, 0, 1]); return ' '; });
    return s;
  }

  // ───────────── collect matching rules ─────────────
  function sheetLabel(sheet) {
    if (sheet.href) {
      try { const u = new URL(sheet.href); return u.pathname.split('/').pop() || u.pathname; } catch { return sheet.href; }
    }
    const owner = sheet.ownerNode;
    if (owner?.localName === 'style') return owner.id ? `<style#${owner.id}>` : '<style>';
    return 'constructed';
  }

  function collect(el) {
    const matches = [];
    let order = 0;
    const visit = (rules, ctx, sheet) => {
      for (const rule of rules) {
        order++;
        if (rule instanceof CSSStyleRule) {
          let parts;
          try { parts = splitTopLevel(rule.selectorText); } catch { continue; }
          const hit = parts.filter((p) => { try { return el.matches(p); } catch { return false; } });
          if (hit.length) {
            matches.push({ rule, sheet, ctx, order, selector: rule.selectorText, matched: hit, spec: max(hit.map(specificity)) });
          }
          if (rule.cssRules?.length) visit(rule.cssRules, ctx, sheet); // CSS nesting
        } else if (rule instanceof CSSMediaRule) {
          if (matchMedia(rule.conditionText || rule.media.mediaText).matches) visit(rule.cssRules, [...ctx, `@media ${rule.conditionText || rule.media.mediaText}`], sheet);
        } else if (rule instanceof CSSSupportsRule) {
          if (CSS.supports(rule.conditionText)) visit(rule.cssRules, [...ctx, `@supports ${rule.conditionText}`], sheet);
        } else if (globalThis.CSSLayerBlockRule && rule instanceof CSSLayerBlockRule) {
          visit(rule.cssRules, [...ctx, `@layer ${rule.name}`], sheet);
        } else if (globalThis.CSSContainerRule && rule instanceof CSSContainerRule) {
          visit(rule.cssRules, [...ctx, `@container ${rule.conditionText}`], sheet); // can't evaluate; assume applies
        } else if (globalThis.CSSScopeRule && rule instanceof CSSScopeRule) {
          visit(rule.cssRules, [...ctx, '@scope'], sheet);
        }
      }
    };
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) sheets.push(...root.styleSheets, ...(root.adoptedStyleSheets || []));
    for (const sheet of sheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet
      if (!rules) continue;
      visit(rules, [], sheet);
    }
    return matches;
  }

  // Shorthands we try to show as one line instead of 4–12 longhands.
  const SHORTHANDS = [
    'border-radius', 'border-width', 'border-style', 'border-color',
    'border-top', 'border-right', 'border-bottom', 'border-left', 'border',
    'margin', 'padding', 'background', 'font', 'flex', 'overflow', 'outline', 'transition',
    'animation', 'grid-template', 'list-style', 'text-decoration', 'columns', 'mask',
  ];

  function declarations(style) {
    const longhands = [];
    for (let i = 0; i < style.length; i++) longhands.push(style.item(i));
    const claimed = new Set();
    const lines = [];
    for (const sh of SHORTHANDS) {
      const v = style.getPropertyValue(sh);
      if (!v) continue;
      const parts = longhands.filter((l) => !claimed.has(l) && l.startsWith(sh + '-'));
      if (!parts.length) continue;
      parts.forEach((p) => claimed.add(p));
      lines.push({ prop: sh, value: v, important: style.getPropertyPriority(parts[0]) === 'important', longhands: parts });
    }
    for (const l of longhands) {
      if (claimed.has(l)) continue;
      lines.push({ prop: l, value: style.getPropertyValue(l), important: style.getPropertyPriority(l) === 'important', longhands: [l] });
    }
    return lines;
  }

  // Map Angular emulated-encapsulation attributes to the component tag.
  function scopeOwner(selector) {
    const m = /\[_ng(?:content|host)-([\w-]+)\]/.exec(selector);
    if (!m) return null;
    const host = document.querySelector(`[_nghost-${CSS.escape(m[1])}]`);
    return host ? `<${host.localName}>` : `_ng-${m[1]}`;
  }

  function rulesFor(el) {
    const matched = collect(el);
    // Cascade order (simplified): later wins for equal specificity; layers/importance handled per declaration.
    matched.sort((a, b) => cmp(b.spec, a.spec) || b.order - a.order);
    const winners = new Set(); // longhands already decided by a stronger declaration
    const inline = el.getAttribute('style') ? declarations(el.style) : [];
    // Pass 1: !important declarations win over everything normal.
    const all = [
      ...(inline.length ? [{ label: 'element.style', selector: 'style=""', spec: [1, 0, 0, 0], lines: inline, inline: true }] : []),
      ...matched.map((m) => ({
        label: sheetLabel(m.sheet),
        selector: m.selector,
        matched: m.matched,
        ctx: m.ctx,
        spec: m.spec,
        owner: scopeOwner(m.selector),
        lines: declarations(m.rule.style),
      })),
    ];
    // !important declarations are decided first (same order), then normal ones.
    for (const pass of ['important', 'normal']) {
      for (const r of all) {
        for (const d of r.lines) {
          if ((pass === 'important') !== d.important) continue;
          d.overridden = d.longhands.every((lh) => winners.has(lh));
          d.longhands.forEach((lh) => winners.add(lh));
        }
      }
    }
    return all.slice(0, 40).map((r) => ({
      ...r,
      lines: r.lines.map((d) => ({ prop: d.prop, value: d.value, important: d.important, overridden: !!d.overridden })),
    }));
  }

  // ───────────── colors / contrast ─────────────
  let ctx2d;
  function toRgba(color) {
    try {
      ctx2d ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      ctx2d.clearRect(0, 0, 1, 1);
      ctx2d.fillStyle = '#000';
      ctx2d.fillStyle = color;
      ctx2d.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx2d.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    } catch { return null; }
  }
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  function effectiveBg(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none') return null; // can't know
      const c = toRgba(cs.backgroundColor);
      if (c && c[3] > 0.95) return c;
    }
    return [255, 255, 255, 1];
  }

  // ───────────── warnings ─────────────
  function warnings(el) {
    const w = [];
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const push = (level, text, hint) => w.push({ level, text, hint });

    // Hidden / invisible
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = n === el ? cs : getComputedStyle(n);
      const who = n === el ? 'This element' : `Ancestor <${n.localName}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/)[0] : ''}>`;
      if (s.display === 'none') { push('error', `${who} has display: none`, 'Nothing inside it is rendered.'); break; }
      if (s.visibility === 'hidden' && n === el) push('warn', 'visibility: hidden', 'Takes space but is invisible.');
      if (parseFloat(s.opacity) === 0) { push('warn', `${who} has opacity: 0`, 'Invisible but still clickable.'); break; }
    }
    if (rect.width === 0 || rect.height === 0) {
      push('warn', `Zero size (${Math.round(rect.width)}×${Math.round(rect.height)})`,
        cs.display === 'inline' ? 'Inline elements ignore width/height — use inline-block or block.' :
        'Check that children are not all absolutely positioned/floated, and that a parent flex/grid gives it room.');
    }

    // Overflow
    const overflowX = el.scrollWidth - el.clientWidth;
    const overflowY = el.scrollHeight - el.clientHeight;
    if (overflowX > 1 && cs.overflowX === 'visible') push('warn', `Content overflows horizontally by ${overflowX}px`, 'A child is wider than this box. Try min-width: 0 on flex/grid children, or overflow-wrap: anywhere for long text.');
    if (overflowY > 1 && cs.overflowY === 'visible' && cs.height !== 'auto' && !/(auto|fit|max|min)-content/.test(cs.height)) push('warn', `Content overflows vertically by ${overflowY}px`, 'Fixed height is smaller than its content.');
    const vw = document.documentElement.clientWidth;
    if (rect.right > vw + 1 && cs.position !== 'fixed') push('warn', `Extends ${Math.round(rect.right - vw)}px past the viewport`, 'This can cause a horizontal page scrollbar.');
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflow !== 'visible') {
        const pr = n.getBoundingClientRect();
        if (rect.right > pr.right + 1 || rect.bottom > pr.bottom + 1 || rect.left < pr.left - 1 || rect.top < pr.top - 1) {
          push('info', `Partly clipped by <${n.localName}> (overflow: ${s.overflow})`, 'Parts outside that box are cut off.');
        }
        break;
      }
    }

    // Flex child that won't shrink
    const parent = el.parentElement;
    const pcs = parent ? getComputedStyle(parent) : null;
    if (pcs?.display.includes('flex') && cs.minWidth === 'auto' && overflowX > 1) {
      push('info', 'Flex item with min-width: auto', 'Flex items will not shrink below their content width. Add min-width: 0.');
    }

    // z-index without positioning
    if (cs.zIndex !== 'auto' && cs.position === 'static' && !(pcs && /flex|grid/.test(pcs.display))) {
      push('warn', `z-index: ${cs.zIndex} has no effect`, 'z-index only works on positioned elements (relative/absolute/fixed/sticky) or flex/grid items.');
    }

    // Clicks
    if (cs.pointerEvents === 'none') push('info', 'pointer-events: none', 'Clicks pass through this element.');
    if (rect.width > 0 && rect.height > 0) {
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      if (cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight) {
        const top = document.elementsFromPoint(cx, cy).find((n) => !n.hasAttribute?.('data-felens-ui'));
        if (top && top !== el && !el.contains(top) && !top.contains(el)) {
          const d = `<${top.localName}${top.id ? '#' + top.id : ''}${top.classList[0] ? '.' + top.classList[0] : ''}>`;
          push('warn', `Covered by ${d} at its center`, 'Clicks on that spot go to the covering element (check z-index / position).');
        }
      }
    }

    // Contrast (only for elements with their own text)
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText) {
      const fg = toRgba(cs.color);
      const bg = effectiveBg(el);
      if (fg && bg) {
        const L1 = lum(fg), L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        const need = large ? 3 : 4.5;
        if (ratio < need) push('warn', `Low text contrast ${ratio.toFixed(2)}:1 (needs ${need}:1)`, `Color ${cs.color} on ${`rgb(${bg.slice(0, 3).join(' ')})`}.`);
      }
    }

    // Accessibility basics
    if (el.localName === 'img' && !el.hasAttribute('alt')) push('warn', '<img> without alt', 'Add alt="" for decorative images or a description.');
    if ((el.localName === 'button' || el.getAttribute('role') === 'button') && !el.textContent.trim() && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.title) {
      push('warn', 'Button has no accessible name', 'Add text or aria-label.');
    }
    return w;
  }

  function boxModel(el) {
    const cs = getComputedStyle(el);
    const px = (p) => Math.round(parseFloat(cs[p]) * 10) / 10 || 0;
    const r = el.getBoundingClientRect();
    return {
      display: cs.display,
      position: cs.position,
      boxSizing: cs.boxSizing,
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
      margin: [px('marginTop'), px('marginRight'), px('marginBottom'), px('marginLeft')],
      border: [px('borderTopWidth'), px('borderRightWidth'), px('borderBottomWidth'), px('borderLeftWidth')],
      padding: [px('paddingTop'), px('paddingRight'), px('paddingBottom'), px('paddingLeft')],
      content: [
        Math.round((r.width - px('paddingLeft') - px('paddingRight') - px('borderLeftWidth') - px('borderRightWidth')) * 10) / 10,
        Math.round((r.height - px('paddingTop') - px('paddingBottom') - px('borderTopWidth') - px('borderBottomWidth')) * 10) / 10,
      ],
      key: {
        color: cs.color, background: cs.backgroundColor, font: `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily.split(',')[0]}`,
        zIndex: cs.zIndex, overflow: cs.overflow, gap: cs.gap,
      },
    };
  }

  globalThis.FeLensCss = {
    analyze(el) {
      return { box: boxModel(el), warnings: warnings(el), rules: rulesFor(el) };
    },
  };
})();
