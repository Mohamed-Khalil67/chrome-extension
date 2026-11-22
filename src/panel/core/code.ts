// Code view: real source lines inside the panel, read from the dev server's
// source maps (sourcesContent). No editor or file access needed.
import type { ElementDesc } from '../../shared/messages';
import { findSource } from '../../shared/sourcemap';
import { closest, esc } from './dom';
import { fileLink } from './editor';
import { pageScripts } from './rpc';

// ───────────── tiny syntax highlighter (TS / HTML) ─────────────
const TS_KEYWORDS = new Set('abstract as async await break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while yield'.split(' '));

function highlightTs(line: string): string {
  const re = /(\/\/.*$|\/\*.*?\*\/)|(`(?:\\.|[^`])*`?|'(?:\\.|[^'])*'?|"(?:\\.|[^"])*"?)|(@[A-Za-z_]\w*)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\w\s])/g;
  let out = '';
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

function highlightHtml(line: string): string {
  const re = /(<!--.*?-->)|(<\/?[\w-]+)|([[(]{1,2}[\w.-]+[\])]{1,2}|\*?[\w:.-]+(?==))|("[^"]*"?|'[^']*'?)|(\{\{.*?\}\}|@(?:if|else|for|switch|case|default|defer|empty|let)\b)|(\/?>)|([^<"'{@[(*\w/>]+|.)/g;
  let out = '';
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

const highlight = (file: string, line: string): string => (/\.html?$/i.test(file) ? highlightHtml(line) : highlightTs(line));

// ───────────── snippet rendering ─────────────
export type Tone = 'focus' | 'error' | 'warn';
export interface SnippetOptions { before?: number; after?: number; tone?: Tone; label?: string }

// HTML for a code block. `line` is 1-based. The block carries the data it
// needs to re-render itself larger ("Show more").
export function snippetHtml(file: string, text: string, line: number, { before = 3, after = 3, tone = 'focus', label }: SnippetOptions = {}): string {
  const lines = text.split('\n');
  const from = Math.max(1, line - before);
  const to = Math.min(lines.length, line + after);
  const width = String(to).length;
  const rows: string[] = [];
  for (let n = from; n <= to; n++) {
    rows.push(`<div class="ln${n === line ? ` hl ${tone}` : ''}"><span class="no" style="--w:${width}ch">${n}</span><code>${highlight(file, lines[n - 1] ?? '') || ' '}</code></div>`);
  }
  const canGrow = from > 1 || to < lines.length;
  return `
    <figure class="code" data-file="${esc(file)}" data-line="${line}" data-tone="${tone}" data-before="${before}" data-after="${after}">
      <figcaption>${fileLink(file, line, null, label)}<button type="button" class="btn tiny primary" data-open-file="${esc(file)}" data-line="${line}" data-col="1" title="Open ${esc(file)}:${line} in your editor">Open in editor</button>${canGrow ? `<button type="button" class="btn tiny ghost" data-grow>${before >= 20 ? 'Show less' : 'Show more'}</button>` : ''}</figcaption>
      <div class="lines" role="region" aria-label="Source of ${esc(file)} around line ${line}" tabindex="0">${rows.join('')}</div>
    </figure>`;
}

// Looks up the source and renders it.
export async function codeBlock(file: string | null | undefined, line: number | null | undefined, opts: SnippetOptions = {}): Promise<string> {
  if (!file || !line) return '';
  let text = await findSource(file, await pageScripts());
  text ??= await findSource(file, await pageScripts(true)); // a lazy chunk may have loaded since
  if (text == null) return `<p class="note code-missing">Source not available in the page's source maps. ${fileLink(file, line, null, 'Open in editor')}</p>`;
  return snippetHtml(file, text, line, opts);
}

const isTone = (t: string | undefined): t is Tone => t === 'focus' || t === 'error' || t === 'warn';

// "Show more / less" on any code block.
document.addEventListener('click', (e) => {
  const b = closest(e, '[data-grow]');
  const fig = b?.closest<HTMLElement>('figure.code');
  if (!fig) return;
  const { file = '', line = '1', tone } = fig.dataset;
  const big = Number(fig.dataset.before) < 20;
  void (async () => {
    const text = await findSource(file, await pageScripts());
    if (text == null) return;
    const t = document.createElement('template');
    t.innerHTML = snippetHtml(file, text, Number(line), { before: big ? 20 : 3, after: big ? 20 : 3, tone: isTone(tone) ? tone : 'focus' }).trim();
    const next = t.content.firstElementChild;
    if (next) fig.replaceWith(next);
  })();
});

// ───────────── template line for a picked element ─────────────
// Score each template line by how well it matches the element's tag, id,
// classes and attributes; return the best line (1-based).
export function findTemplateLine(text: string, desc: ElementDesc): { line: number; score: number } | null {
  if (!text || !desc.tag) return null;
  const lines = text.split('\n');
  const tagRe = new RegExp(`<${desc.tag.replace(/-/g, '\\-')}(?=[\\s>/]|$)`, 'i');
  let best: { line: number; score: number } | null = null;
  lines.forEach((l, i) => {
    if (!tagRe.test(l)) return;
    // Attributes may continue on following lines: look at the opening tag text.
    const chunk = lines.slice(i, i + 8).join(' ').split(/>(?![^"]*")/)[0] ?? '';
    let score = 1;
    if (desc.id && chunk.includes(`id="${desc.id}"`)) score += 6;
    for (const c of desc.classes) if (new RegExp(`[\\s"'.]${c.replace(/[.*+?^${}()|[\]\\:/]/g, '\\$&')}(?=[\\s"'])`).test(chunk)) score += 2;
    for (const a of desc.attrs) if (chunk.includes(a)) score += 1;
    if (desc.text && lines.slice(i, i + 4).join(' ').includes(desc.text.slice(0, 20))) score += 3;
    if (!best || score > best.score) best = { line: i + 1, score };
  });
  return best;
}

// Template for a component: an external .html next to the .ts, or the inline
// `template:` inside the .ts file.
export async function templateFor(tsFile: string): Promise<{ file: string; text: string; inline?: boolean } | null> {
  const scripts = await pageScripts();
  const htmlFile = tsFile.replace(/\.ts$/, '.html');
  const html = await findSource(htmlFile, scripts);
  if (html != null) return { file: htmlFile, text: html };
  const ts = await findSource(tsFile, scripts);
  if (ts == null || !/template\s*:\s*`/.test(ts)) return null;
  return { file: tsFile, text: ts, inline: true };
}
