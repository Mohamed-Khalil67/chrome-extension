// Code view: shows real source lines inside the panel, read from the dev
// server's source maps (sourcesContent). No editor or file access needed.
import { esc, fileLink, pageScripts } from './core.js';
import { findSource } from './sourcemap.js';

// ───────────── tiny syntax highlighter (TS / HTML) ─────────────
const TS_KEYWORDS = new Set(('abstract as async await break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while yield').split(' '));

function highlightTs(line) {
  const re = /(\/\/.*$|\/\*.*?\*\/)|(`(?:\\.|[^`])*`?|'(?:\\.|[^'])*'?|"(?:\\.|[^"])*"?)|(@[A-Za-z_]\w*)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\w\s])/g;
  let out = '';
  for (const m of line.matchAll(re)) {
    const [t, comment, str, deco, num, word] = m;
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
  const re = /(<!--.*?-->)|(<\/?[\w-]+)|([\[(]{1,2}[\w.-]+[\])]{1,2}|\*?[\w:.-]+(?==))|("[^"]*"?|'[^']*'?)|(\{\{.*?\}\}|@(?:if|else|for|switch|case|default|defer|empty|let)\b)|(\/?>)|([^<"'{@\[(*\w/>]+|.)/g;
  let out = '';
  for (const m of line.matchAll(re)) {
    const [t, comment, tag, attr, str, ng, close] = m;
    if (comment) out += `<span class="tk-c">${esc(t)}</span>`;
    else if (tag || close) out += `<span class="tk-k">${esc(t)}</span>`;
    else if (attr) out += `<span class="tk-d">${esc(t)}</span>`;
    else if (str) out += `<span class="tk-s">${esc(t)}</span>`;
    else if (ng) out += `<span class="tk-t">${esc(t)}</span>`;
    else out += esc(t);
  }
  return out;
}

const highlight = (file, line) => (/\.(html?|vue|svelte)$/i.test(file) ? highlightHtml(line) : highlightTs(line));

// ───────────── snippet rendering ─────────────
// Returns HTML for a code block. `line` is 1-based. The block carries the data
// it needs to re-render itself larger ("Show more").
export function snippetHtml(file, text, line, { before = 3, after = 3, tone = 'focus', label } = {}) {
  const lines = text.split('\n');
  const from = Math.max(1, line - before);
  const to = Math.min(lines.length, line + after);
  const width = String(to).length;
  const rows = [];
  for (let n = from; n <= to; n++) {
    rows.push(`<div class="ln${n === line ? ` hl ${tone}` : ''}"><span class="no" style="--w:${width}ch">${n}</span><code>${highlight(file, lines[n - 1] ?? '') || ' '}</code></div>`);
  }
  const canGrow = from > 1 || to < lines.length;
  return `
    <figure class="code" data-file="${esc(file)}" data-line="${line}" data-tone="${tone}" data-before="${before}" data-after="${after}">
      <figcaption>${fileLink(file, line, null, label)}${canGrow ? `<button type="button" class="btn tiny ghost" data-grow>${before >= 20 ? 'Show less' : 'Show more'}</button>` : ''}</figcaption>
      <div class="lines" role="region" aria-label="Source of ${esc(file)} around line ${line}" tabindex="0">${rows.join('')}</div>
    </figure>`;
}

// Async: look up the source and render; a placeholder is shown meanwhile.
export async function codeBlock(file, line, opts = {}) {
  if (!file || !line) return '';
  let text = await findSource(file, await pageScripts());
  if (text == null) text = await findSource(file, await pageScripts(true)); // a lazy chunk may have loaded since
  if (text == null) return `<p class="note code-missing">Source not available in the page's source maps. ${fileLink(file, line, null, 'Open in editor')}</p>`;
  return snippetHtml(file, text, line, opts);
}

// "Show more / less" on any code block.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-grow]');
  if (!b) return;
  const fig = b.closest('figure.code');
  const { file, line, tone } = fig.dataset;
  const big = Number(fig.dataset.before) < 20;
  const text = await findSource(file, await pageScripts());
  if (text == null) return;
  const next = snippetHtml(file, text, Number(line), { before: big ? 20 : 3, after: big ? 20 : 3, tone });
  const t = document.createElement('template');
  t.innerHTML = next.trim();
  fig.replaceWith(t.content.firstElementChild);
});

// ───────────── template line for a picked element ─────────────
// Score each line of the template by how well it matches the element's tag,
// id, classes and attributes; return the best line (1-based) or null.
export function findTemplateLine(text, desc) {
  if (!text || !desc?.tag) return null;
  const lines = text.split('\n');
  const tagRe = new RegExp(`<${desc.tag.replace(/[-]/g, '\\-')}(?=[\\s>/]|$)`, 'i');
  let best = null;
  lines.forEach((l, i) => {
    if (!tagRe.test(l)) return;
    // Attributes may continue on following lines: look at the opening tag text.
    const chunk = lines.slice(i, i + 8).join(' ').split(/>(?![^"]*")/)[0];
    let score = 1;
    if (desc.id && chunk.includes(`id="${desc.id}"`)) score += 6;
    for (const c of desc.classes || []) if (new RegExp(`[\\s"'.]${c.replace(/[.*+?^${}()|[\]\\:/]/g, '\\$&')}(?=[\\s"'])`).test(chunk)) score += 2;
    for (const a of desc.attrs || []) if (chunk.includes(a)) score += 1;
    if (desc.text && lines.slice(i, i + 4).join(' ').includes(desc.text.slice(0, 20))) score += 3;
    if (!best || score > best.score) best = { line: i + 1, score };
  });
  return best;
}

// Template for a component: an external .html next to the .ts, or the inline
// `template:` inside the .ts file.
export async function templateFor(tsFile) {
  if (!tsFile) return null;
  const scripts = await pageScripts();
  const htmlFile = tsFile.replace(/\.ts$/, '.html');
  const html = await findSource(htmlFile, scripts);
  if (html != null) return { file: htmlFile, text: html, offset: 0 };
  const ts = await findSource(tsFile, scripts);
  if (ts == null) return null;
  const m = /template\s*:\s*`/.exec(ts);
  if (!m) return null;
  return { file: tsFile, text: ts, offset: 0, inline: true };
}
