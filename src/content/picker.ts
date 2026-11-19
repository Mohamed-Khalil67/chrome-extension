// Element picker overlay (isolated world). The overlay lives in a Shadow DOM
// inside a manual popover, so it sits in the top layer above the app's own
// z-index stacks and the app's CSS can't touch it.
import type { HoverInfo } from '../shared/messages';

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
    pointer-events: none;
  }
  [hidden] { display: none !important; }
`;

interface Parts { box: HTMLElement; margin: HTMLElement; border: HTMLElement; padding: HTMLElement; content: HTMLElement; label: HTMLElement; hint: HTMLElement }

let host: HTMLDivElement | null = null;
let els: Parts | null = null;
let picking = false;
let hoverEl: Element | null = null;
let selectedEl: Element | null = null;
let raf = 0;
let onPick: ((el: Element) => void) | null = null;
let hoverInfo: (el: Element) => HoverInfo | null = () => null;
// Last pointer position while picking. The page can change under a still
// cursor (carousels, scrolling, layout shifts), so re-hit-test every frame
// instead of only on pointermove. The click then selects exactly what is shown.
let pointer: { x: number; y: number } | null = null;
// When the user steps with ↑/↓, keep their choice until the pointer moves.
let manual = false;

export function setHoverInfo(fn: (el: Element) => HoverInfo | null): void { hoverInfo = fn; }

function part(root: ShadowRoot, sel: string): HTMLElement {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error(`overlay part ${sel} missing`);
  return el;
}

function ensureOverlay(): Parts {
  if (host?.isConnected && els) return els;
  host = document.createElement('div');
  host.setAttribute('data-felens-ui', '');
  host.setAttribute('popover', 'manual');
  host.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>${CSS_TEXT}</style>
    <div class="box" hidden>
      <div class="layer margin"></div><div class="layer border"></div>
      <div class="layer padding"></div><div class="layer content"></div>
    </div>
    <div class="label" hidden></div>
    <div class="hint" hidden>Click to inspect · ↑ ↓ parent / child · Esc to cancel</div>`;
  els = {
    box: part(root, '.box'), margin: part(root, '.margin'), border: part(root, '.border'),
    padding: part(root, '.padding'), content: part(root, '.content'), label: part(root, '.label'), hint: part(root, '.hint'),
  };
  document.documentElement.append(host);
  return els;
}

function show(): Parts {
  const parts = ensureOverlay();
  try {
    // Re-show so we end up above any top-layer element the app opened later.
    if (host?.matches(':popover-open')) host.hidePopover();
    host?.showPopover();
  } catch { /* popover unsupported: falls back to z-index */ }
  return parts;
}

// Take the overlay out of the top layer when nothing is drawn, so nothing of
// ours sits over the page while you use it.
function hideOverlay(): void {
  cancelAnimationFrame(raf);
  if (els) { els.box.hidden = true; els.label.hidden = true; els.hint.hidden = true; }
  try { if (host?.matches(':popover-open')) host.hidePopover(); } catch { /* ignore */ }
}

// After a pick, the selected element is outlined briefly, then the outline goes
// away: on the next click, scroll or key press, or after a few seconds.
const FLASH_MS = 2500;
let flashing = false;
let flashTimer = 0;
function endFlash(): void {
  flashing = false;
  clearTimeout(flashTimer);
  removeEventListener('pointerdown', endFlash, true);
  removeEventListener('scroll', endFlash, true);
  removeEventListener('keydown', endFlash, true);
  if (!picking) hideOverlay();
}
function flash(): void {
  flashing = true;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(endFlash, FLASH_MS);
  // Registered after the picking click has finished, so that click doesn't end it.
  setTimeout(() => {
    if (!flashing) return;
    addEventListener('pointerdown', endFlash, true);
    addEventListener('scroll', endFlash, { capture: true, passive: true });
    addEventListener('keydown', endFlash, true);
  }, 0);
}

const place = (node: HTMLElement, x: number, y: number, w: number, h: number): void => {
  node.style.left = `${x}px`; node.style.top = `${y}px`;
  node.style.width = `${Math.max(0, w)}px`; node.style.height = `${Math.max(0, h)}px`;
};

function draw(p: Parts, el: Element): void {
  if (!el.isConnected) { p.box.hidden = true; p.label.hidden = true; return; }
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const n = (v: string): number => parseFloat(v) || 0;
  const [mt, mr, mb, ml] = [n(cs.marginTop), n(cs.marginRight), n(cs.marginBottom), n(cs.marginLeft)];
  const [bt, br, bb, bl] = [n(cs.borderTopWidth), n(cs.borderRightWidth), n(cs.borderBottomWidth), n(cs.borderLeftWidth)];
  const [pt, pr, pb, pl] = [n(cs.paddingTop), n(cs.paddingRight), n(cs.paddingBottom), n(cs.paddingLeft)];
  place(p.margin, r.left - ml, r.top - mt, r.width + ml + mr, r.height + mt + mb);
  place(p.border, r.left, r.top, r.width, r.height);
  place(p.padding, r.left + bl, r.top + bt, r.width - bl - br, r.height - bt - bb);
  place(p.content, r.left + bl + pl, r.top + bt + pt, r.width - bl - br - pl - pr, r.height - bt - bb - pt - pb);
  p.box.hidden = false;
}

function loop(): void {
  cancelAnimationFrame(raf);
  const p = els;
  if (!p) return;
  const tick = (): void => {
    if (picking && pointer && !manual) {
      const el = hitTest(pointer.x, pointer.y);
      if (el && el !== hoverEl) { hoverEl = el; setLabel(el); }
    }
    const target = picking ? hoverEl : flashing ? selectedEl : null;
    if (!target) {
      p.box.hidden = true;
      p.label.hidden = true;
      // Keep ticking while picking: the first hover target arrives later.
      if (picking) raf = requestAnimationFrame(tick);
      else hideOverlay();
      return;
    }
    p.box.classList.toggle('selected', !picking);
    draw(p, target);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

function setLabel(el: Element): void {
  if (!els) return;
  const r = el.getBoundingClientRect();
  const info = hoverInfo(el);
  let tag = el.localName;
  if (el.id) tag += `#${el.id}`;
  const cls = [...el.classList].filter((c) => !c.startsWith('ng-')).slice(0, 2);
  if (cls.length) tag += `.${cls.join('.')}`;
  els.label.innerHTML =
    (info?.name ? `<b>${escapeHtml(info.name)}</b> <span class="dim">›</span> ` : '') +
    `<span class="tag">${escapeHtml(tag)}</span> <span class="dim">${Math.round(r.width)}×${Math.round(r.height)}</span>`;
  els.label.hidden = false;
}

const isOurs = (el: Element | null): boolean => !!el && (el === host || !!el.closest('[data-felens-ui]'));

// Topmost page element at a point, descending into open shadow roots
// (web components, Angular ViewEncapsulation.ShadowDom).
function hitTest(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el && !isOurs(el) ? el : null;
}

function setHover(el: Element | null): void {
  if (!el || el === hoverEl) return;
  hoverEl = el;
  setLabel(el);
}

function onMove(e: PointerEvent): void {
  pointer = { x: e.clientX, y: e.clientY };
  manual = false;
  setHover(hitTest(pointer.x, pointer.y));
}

function swallow(e: Event): void {
  if (!picking) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

function finish(el: Element | null): void {
  stop();
  if (el && !isOurs(el)) {
    select(el);
    onPick?.(el);
  }
}

function onClick(e: MouseEvent): void {
  if (!picking) return;
  swallow(e);
  // What you see is what you get: select the highlighted element. If the
  // pointer never moved (picking started under the cursor), hit-test now.
  finish(hoverEl ?? hitTest(e.clientX, e.clientY));
}

function onKey(e: KeyboardEvent): void {
  if (!picking) return;
  if (e.key === 'Escape') { swallow(e); stop(); return; }
  // ↑ parent, ↓ back toward the element under the pointer, Enter selects.
  const up = hoverEl?.parentElement;
  if (e.key === 'ArrowUp' && up && up !== document.documentElement) {
    swallow(e); manual = true; setHover(up);
  } else if (e.key === 'ArrowDown' && hoverEl) {
    swallow(e);
    const under = pointer ? hitTest(pointer.x, pointer.y) : null;
    let child: Element | null = null;
    // Step one level down along the path to the element under the pointer.
    for (let n = under; n && n !== hoverEl; n = n.parentElement) child = n;
    child ??= hoverEl.firstElementChild;
    if (child) { manual = true; setHover(child); }
  } else if (e.key === 'Enter' && hoverEl) {
    swallow(e);
    finish(hoverEl);
  }
}

const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup'] as const;

export function start(cb: (el: Element) => void): void {
  onPick = cb;
  const p = show();
  picking = true;
  hoverEl = null;
  manual = false;
  pointer = null;
  p.hint.hidden = false;
  document.documentElement.style.cursor = 'crosshair';
  addEventListener('pointermove', onMove, true);
  addEventListener('click', onClick, true);
  for (const t of BLOCKED) addEventListener(t, swallow, true);
  addEventListener('keydown', onKey, true);
  loop();
}

export function stop(): void {
  picking = false;
  if (els) { els.hint.hidden = true; els.label.hidden = true; }
  document.documentElement.style.cursor = '';
  removeEventListener('pointermove', onMove, true);
  removeEventListener('click', onClick, true);
  for (const t of BLOCKED) removeEventListener(t, swallow, true);
  removeEventListener('keydown', onKey, true);
  loop();
}

export function select(el: Element): void {
  show();
  selectedEl = el;
  setLabel(el);
  flash();
  loop();
}

export function clear(): void {
  selectedEl = null;
  endFlash();
  hideOverlay();
}

// ───────────── Alt+click: pick while using the page ─────────────
// Active only while the side panel is open. A plain click keeps working as
// usual; Alt+click selects the element under the pointer and doesn't reach
// the page (Chrome would otherwise download a link on Alt+click).
let altPick: ((el: Element) => void) | null = null;
const ALT_BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup'] as const;
function altSwallow(e: MouseEvent): void {
  if (!e.altKey || picking) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}
function altClick(e: MouseEvent): void {
  if (!e.altKey || picking || !altPick) return;
  altSwallow(e);
  const el = hitTest(e.clientX, e.clientY);
  if (el) { select(el); altPick(el); }
}
export function setAltPick(cb: ((el: Element) => void) | null): void {
  const was = altPick !== null;
  altPick = cb;
  if (cb && !was) {
    addEventListener('click', altClick, true);
    for (const t of ALT_BLOCKED) addEventListener(t, altSwallow, true);
  } else if (!cb && was) {
    removeEventListener('click', altClick, true);
    for (const t of ALT_BLOCKED) removeEventListener(t, altSwallow, true);
  }
}

export const isPicking = (): boolean => picking;
export const selected = (): Element | null => selectedEl;
