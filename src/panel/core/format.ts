// Formatting: durations, sizes, captured values and JSON trees.
import type { Val } from '../../shared/messages';
import { esc } from './dom';

export const fmtMs = (ms: number | null | undefined): string => (ms == null ? '…' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
export const fmtSize = (b: number | null | undefined): string => (b == null || b === 0 ? '–' : b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`);

// A captured value (component input, state, console argument).
export function val(v: Val | undefined): string {
  if (!v) return '<span class="v-null">—</span>';
  switch (v.t) {
    case 'null': return '<span class="v-null">null</span>';
    case 'undef': return '<span class="v-null">undefined</span>';
    case 'str': return `<span class="v-str">"${esc(v.v)}"</span>`;
    case 'num': return `<span class="v-num">${esc(v.v)}</span>`;
    case 'bool': return `<span class="v-bool">${esc(v.v)}</span>`;
    case 'fn': return `<span class="v-fn">${esc(v.v)}</span>`;
    case 'node': case 'other': return `<span class="v-other">${esc(v.v)}</span>`;
    case 'signal': return `<span class="v-sig">${esc(v.kind)}</span>${val(v.v)}`;
    case 'obs': return `<span class="v-other">${esc(v.v)}</span>${v.cur ? ` ${val(v.cur)}` : ''}`;
    case 'arr': {
      const label = `${v.ctor ?? 'Array'}(${v.len})`;
      if (!v.items.length) return `<span class="v-other">${esc(label)} []</span>`;
      return `<details class="v-obj"><summary>${esc(label)}</summary><dl class="kv">${v.items.map((x, i) => `<dt>${i}</dt><dd>${val(x)}</dd>`).join('')}</dl></details>`;
    }
    case 'obj': {
      const label = `${v.ctor ?? 'Object'} {${v.entries.length ? '…' : ''}}`;
      if (!v.entries.length) return `<span class="v-other">${esc(label)}</span>`;
      return `<details class="v-obj"><summary>${esc(label)}</summary><dl class="kv">${v.entries.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${val(x)}</dd>`).join('')}${v.more ? `<dt>…</dt><dd class="v-null">${v.more} more</dd>` : ''}</dl></details>`;
    }
  }
}

export const kvList = (pairs: [string, Val][]): string => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${val(v)}</dd>`).join('')}</dl>`;

// A collapsible tree for parsed JSON (response previews).
export function jsonTree(value: unknown, key: string | number | null = null, depth = 0): string {
  const label = key == null ? '' : `<span class="j-key">${esc(key)}</span>: `;
  if (value === null) return `<div class="j-row">${label}<span class="v-null">null</span></div>`;
  if (typeof value === 'object') {
    const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((v: unknown, i): [number, unknown] => [i, v]) : Object.entries(value);
    const preview = Array.isArray(value) ? `Array(${entries.length})` : `{${entries.slice(0, 3).map(([k]) => esc(k)).join(', ')}${entries.length > 3 ? ', …' : ''}}`;
    const shown = entries.slice(0, 200);
    return `<details class="j-node" ${depth < 1 ? 'open' : ''}><summary>${label}<span class="v-other">${preview}</span></summary>${shown.map(([k, v]) => jsonTree(v, k, depth + 1)).join('')}${entries.length > shown.length ? `<div class="j-row v-null">… ${entries.length - shown.length} more</div>` : ''}</details>`;
  }
  const cls = typeof value === 'string' ? 'v-str' : typeof value === 'number' ? 'v-num' : 'v-bool';
  const text = typeof value === 'string' ? `"${value.length > 300 ? `${value.slice(0, 300)}…` : value}"` : String(value);
  return `<div class="j-row">${label}<span class="${cls}">${esc(text)}</span></div>`;
}
