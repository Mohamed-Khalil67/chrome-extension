// DOM helpers.

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
export const $maybe = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];
export const input = (sel: string, root: ParentNode = document): HTMLInputElement => $<HTMLInputElement>(sel, root);

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);

// Closest ancestor (or self) of the event target matching a selector.
export const closest = <T extends Element = HTMLElement>(e: Event, sel: string): T | null =>
  e.target instanceof Element ? e.target.closest<T>(sel) : null;

// ───────────── copy with visible + announced feedback ─────────────
const copyTimers = new WeakMap<Element, number>();
export async function copyText(button: HTMLElement, text: string): Promise<void> {
  const tip = button.parentElement?.querySelector('[role="status"]');
  clearTimeout(copyTimers.get(button));
  let ok = true;
  try { await navigator.clipboard.writeText(text); } catch { ok = false; }
  if (tip) tip.textContent = ok ? 'Copied' : 'Copy failed';
  button.toggleAttribute('data-copied', ok);
  copyTimers.set(button, window.setTimeout(() => {
    if (tip) tip.textContent = '';
    button.removeAttribute('data-copied');
  }, 1800));
}

// ───────────── chip groups (single or multi select) ─────────────
// <div data-multi?> <button data-value aria-pressed>…  Returns a getter for the pressed values.
export function chipGroup(root: HTMLElement, onChange: () => void): () => string[] {
  const multi = root.hasAttribute('data-multi');
  root.addEventListener('click', (e) => {
    const b = closest(e, 'button[data-value]');
    if (!b) return;
    if (multi) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    else for (const x of $$('button[data-value]', root)) x.setAttribute('aria-pressed', String(x === b));
    onChange();
  });
  return () => $$('button[data-value][aria-pressed="true"]', root).map((b) => b.dataset.value ?? '');
}
export function setChip(root: HTMLElement, value: string): void {
  for (const b of $$('button[data-value]', root)) b.setAttribute('aria-pressed', String(b.dataset.value === value));
}
