// FE Lens — element picker overlay (isolated world).
// The overlay lives in a Shadow DOM inside a manual popover, so it sits in the
// top layer above the app's own z-index stacks and the app's CSS can't touch it.
(() => {
  if (globalThis.FeLensPicker) return;

  const CSS_TEXT = `
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
    }
    [hidden] { display: none !important; }
  `;

  let host, root, els, picking = false, hoverEl = null, selectedEl = null, raf = 0, onPick = null;

  function ensureOverlay() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-felens-ui', '');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${CSS_TEXT}</style>
      <div class="box" part="box" hidden>
        <div class="layer margin"></div><div class="layer border"></div>
        <div class="layer padding"></div><div class="layer content"></div>
      </div>
      <div class="label" hidden></div>
      <div class="hint" hidden>Click an element to inspect · Esc to cancel</div>`;
    els = {
      box: root.querySelector('.box'),
      margin: root.querySelector('.margin'),
      border: root.querySelector('.border'),
      padding: root.querySelector('.padding'),
      content: root.querySelector('.content'),
      label: root.querySelector('.label'),
      hint: root.querySelector('.hint'),
    };
    document.documentElement.append(host);
  }

  function show() {
    ensureOverlay();
    try {
      // Re-show so we end up above any top-layer element the app opened later.
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch { /* popover unsupported: falls back to z-index */ }
  }

  const place = (node, x, y, w, h) => {
    node.style.left = `${x}px`; node.style.top = `${y}px`;
    node.style.width = `${Math.max(0, w)}px`; node.style.height = `${Math.max(0, h)}px`;
  };

  function draw(el) {
    if (!el?.isConnected) { els.box.hidden = true; els.label.hidden = true; return; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const n = (p) => parseFloat(cs[p]) || 0;
    const [mt, mr, mb, ml] = [n('marginTop'), n('marginRight'), n('marginBottom'), n('marginLeft')];
    const [bt, br, bb, bl] = [n('borderTopWidth'), n('borderRightWidth'), n('borderBottomWidth'), n('borderLeftWidth')];
    const [pt, pr, pb, pl] = [n('paddingTop'), n('paddingRight'), n('paddingBottom'), n('paddingLeft')];
    place(els.margin, r.left - ml, r.top - mt, r.width + ml + mr, r.height + mt + mb);
    place(els.border, r.left, r.top, r.width, r.height);
    place(els.padding, r.left + bl, r.top + bt, r.width - bl - br, r.height - bt - bb);
    place(els.content, r.left + bl + pl, r.top + bt + pt, r.width - bl - br - pl - pr, r.height - bt - bb - pt - pb);
    els.box.hidden = false;
  }

  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      const target = picking ? hoverEl : selectedEl;
      if (!target) {
        els.box.hidden = true;
        els.label.hidden = true;
        // Keep ticking while picking: the first hover target arrives later.
        if (picking) raf = requestAnimationFrame(tick);
        return;
      }
      els.box.classList.toggle('selected', !picking);
      draw(target);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function setLabel(el) {
    const r = el.getBoundingClientRect();
    const info = globalThis.FeLensBridge?.hoverInfo(el);
    let tag = el.localName;
    if (el.id) tag += `#${el.id}`;
    const cls = [...el.classList].filter((c) => !c.startsWith('ng-')).slice(0, 2);
    if (cls.length) tag += `.${cls.join('.')}`;
    els.label.innerHTML =
      (info?.name ? `<b>${escapeHtml(info.name)}</b> <span class="dim">›</span> ` : '') +
      `<span class="tag">${escapeHtml(tag)}</span> <span class="dim">${Math.round(r.width)}×${Math.round(r.height)}</span>`;
    els.label.hidden = false;
  }

  const isOurs = (el) => el === host || el?.closest?.('[data-felens-ui]');

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOurs(el) || el === hoverEl) return;
    hoverEl = el;
    setLabel(el);
  }

  function swallow(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (!picking) return;
    swallow(e);
    const el = document.elementFromPoint(e.clientX, e.clientY) || hoverEl;
    stop();
    if (el && !isOurs(el)) {
      select(el);
      onPick?.(el);
    }
  }

  function onKey(e) {
    if (picking && e.key === 'Escape') { swallow(e); stop(); }
  }

  function start(cb) {
    onPick = cb;
    show();
    picking = true;
    hoverEl = null;
    els.hint.hidden = false;
    document.documentElement.style.cursor = 'crosshair';
    addEventListener('pointermove', onMove, true);
    addEventListener('click', onClick, true);
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) addEventListener(t, swallow, true);
    addEventListener('keydown', onKey, true);
    loop();
  }

  function stop() {
    picking = false;
    els.hint.hidden = true;
    els.label.hidden = true;
    document.documentElement.style.cursor = '';
    removeEventListener('pointermove', onMove, true);
    removeEventListener('click', onClick, true);
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) removeEventListener(t, swallow, true);
    removeEventListener('keydown', onKey, true);
    loop();
  }

  function select(el) {
    show();
    selectedEl = el;
    if (el) setLabel(el);
    loop();
  }

  function clear() {
    selectedEl = null;
    if (els) { els.box.hidden = true; els.label.hidden = true; }
    cancelAnimationFrame(raf);
  }

  globalThis.FeLensPicker = {
    start, stop, select, clear,
    get picking() { return picking; },
    get selected() { return selectedEl; },
  };
})();
