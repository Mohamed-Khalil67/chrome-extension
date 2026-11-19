// Errors: data and detail rendering. They are listed inside the Network tab,
// next to the requests, so a JS error right before a failed call is visible.
import { S, esc, emit, fileLink } from './core.js';
import { mapStack } from './sourcemap.js';
import { codeBlock } from './code.js';

const KIND_LABEL = { error: 'Uncaught error', promise: 'Unhandled promise rejection', console: 'console.error', warn: 'Warning', http: 'Failed request', resource: 'Failed to load' };
export const kindLabel = (k) => KIND_LABEL[k] || k;

// Bucket used by the status-code breakdown: js, ng or warn. HTTP errors are
// not listed separately: the request row already shows them.
export function groupOf(e) {
  if (e.kind === 'warn') return 'warn';
  if (e.code) return 'ng';
  if (e.kind === 'http') return 'http';
  return 'js';
}
export const listed = (e) => groupOf(e) !== 'http';

export const appFrame = (e) => e.mapped?.find((f) => !f.lib && f.orig);
const ngCode = (e) => `NG${String(e.code).padStart(4, '0')}`;

export async function add(e) {
  S.errors.set(e.key, e);
  emit('error', e);
  if (!e.mapped && e.stack) {
    e.mapped = await mapStack(e.stack);
    emit('error', e);
    emit('errors-mapped');
  }
}

export function update(p) {
  const e = S.errors.get(p.key);
  if (!e) return;
  e.count = p.count; e.last = p.last;
  emit('error', e);
}

export function clear() {
  S.errors.clear();
  emit('errors-cleared');
}

export const errorCount = () => [...S.errors.values()].filter((e) => listed(e) && e.kind !== 'warn').reduce((a, e) => a + e.count, 0);

// Errors whose message, stack or mapped frames point at a component.
export function relatedTo(c) {
  if (!c) return [];
  const file = c.file?.replace(/^\.?\//, '');
  return [...S.errors.values()].filter((e) =>
    listed(e) && e.kind !== 'warn' && ((e.message || '').includes(c.name) || (e.stack || '').includes(c.name) ||
      (file && e.mapped?.some((f) => f.orig?.file?.endsWith(file)))));
}

// Detail view body for one error (shown in the Network drill-down).
export async function detailHtml(e) {
  const frames = e.mapped || [];
  const app = frames.filter((f) => !f.lib && f.orig);
  const top = app[0];
  const frameLi = (f) => `<li class="${f.lib ? 'lib' : ''}">${f.orig ? fileLink(f.orig.file, f.orig.line, f.orig.col) : `<span>${esc(f.file)}:${f.line}</span>`}<span class="fn">${esc(f.orig?.name || f.fn || '')}</span></li>`;
  const tone = e.kind === 'warn' ? 'warn' : 'error';
  const code = top ? await codeBlock(top.orig.file, top.orig.line, { tone, before: 3, after: 2, label: `Thrown in ${top.orig.file}:${top.orig.line}` }) : '';
  return `
    <div class="meaning ${e.kind === 'warn' ? 'warn' : 'error'}">
      <p class="m-title">${esc(kindLabel(e.kind))}${e.count > 1 ? ` <span class="times">×${e.count}</span>` : ''}</p>
      <p class="err-msg">${esc(e.message)}</p>
    </div>
    <div class="box"><h3>What this means</h3><p>${esc(explain(e))}</p></div>
    ${e.code ? `<a class="ng-help" href="https://angular.dev/errors/${ngCode(e)}" target="_blank" rel="noopener">What ${ngCode(e)} means and how to fix it</a>` : ''}
    ${code || (e.stack ? '' : '<p class="note">No stack trace was captured for this error.</p>')}
    ${app.length > 1 ? `<details class="sub"><summary>Called through ${app.length - 1} more place${app.length > 2 ? 's' : ''} in your code</summary><ul class="frames">${app.slice(1, 8).map(frameLi).join('')}</ul></details>` : ''}
    ${frames.length ? `<details class="sub"><summary>Full stack (${frames.length} frames)</summary><ul class="frames">${frames.map(frameLi).join('')}</ul></details>` : e.stack ? `<details class="sub"><summary>Raw stack</summary><pre class="body-pre">${esc(e.stack)}</pre></details>` : ''}
    <p class="note">First seen ${new Date(e.first).toLocaleTimeString()}${e.count > 1 ? `, last ${new Date(e.last).toLocaleTimeString()}` : ''}</p>`;
}

// Plain-language reading of the most common front-end error messages.
function explain(e) {
  const m = e.message || '';
  if (e.kind === 'warn') return 'A warning from your code or a library. The app keeps running, but it often points at a real problem.';
  if (e.code) return 'Angular stopped because the framework detected a mistake. The docs link below explains this code.';
  if (/Cannot read propert|undefined is not an object|of undefined|of null/.test(m)) return 'Your code read a property of something that is undefined or null. Usually data that hasn\'t loaded yet, a typo in a field name, or a field the API doesn\'t send. Use ?. or check the value first.';
  if (/is not a function/.test(m)) return 'Your code called something that isn\'t a function: a typo, a missing import, or a value of the wrong type.';
  if (/is not defined/.test(m)) return 'A variable is used but never declared or imported.';
  if (/Maximum call stack/.test(m)) return 'Infinite recursion: a function, setter or effect keeps calling itself.';
  if (/JSON/.test(m) && /Unexpected token|parse/i.test(m)) return 'Your code tried to parse something that isn\'t JSON, often an HTML error page returned by the server.';
  if (e.kind === 'promise') return 'A promise failed and nothing caught it. Add error handling (catch, or catchError in RxJS) where it is created.';
  if (e.kind === 'resource') return 'A script, stylesheet or image failed to load. Check the file path.';
  return 'Your front-end code threw this error. The highlighted line is where it happened.';
}
