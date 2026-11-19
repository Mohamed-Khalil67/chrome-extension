// Errors: the store and the detail view. They are listed in the Console tab.
// Failed HTTP calls are not listed here: the Network tab shows them.
import type { ComponentInfo, ErrKind, ErrUpdate } from '../../../shared/messages';
import { isAppFrame, mapStack, type AppFrame, type MappedFrame } from '../../../shared/sourcemap';
import { emit } from '../../core/bus';
import { codeBlock } from '../../core/code';
import { esc } from '../../core/dom';
import { fileLink } from '../../core/editor';
import { S, type PanelError } from '../../core/state';

const KIND_LABEL: Record<ErrKind, string> = { error: 'Uncaught error', promise: 'Unhandled promise rejection', console: 'console.error', warn: 'Warning', http: 'Failed request', resource: 'Failed to load' };
export const kindLabel = (k: ErrKind): string => KIND_LABEL[k];

export const listed = (e: PanelError): boolean => e.kind !== 'http';
export const isWarning = (e: PanelError): boolean => e.kind === 'warn';
export const appFrame = (e: PanelError): AppFrame | undefined => e.mapped?.find(isAppFrame);
const ngCode = (e: PanelError): string => `NG${String(e.code).padStart(4, '0')}`;

export async function add(e: PanelError): Promise<void> {
  S.errors.set(e.key, e);
  emit('error', e);
  if (!e.mapped && e.stack) {
    e.mapped = await mapStack(e.stack);
    emit('error', e);
    emit('errors-mapped');
  }
}

export function update(p: ErrUpdate): void {
  const e = S.errors.get(p.key);
  if (!e) return;
  e.count = p.count;
  e.last = p.last;
  emit('error', e);
}

export function clear(): void {
  S.errors.clear();
  emit('errors-cleared');
}

export const errorCount = (): number => [...S.errors.values()].filter((e) => listed(e) && !isWarning(e)).reduce((a, e) => a + e.count, 0);
export const warningCount = (): number => [...S.errors.values()].filter(isWarning).reduce((a, e) => a + e.count, 0);

// Errors whose message, stack or mapped frames point at a component.
export function relatedTo(c: ComponentInfo | undefined): PanelError[] {
  if (!c) return [];
  const file = c.file?.replace(/^\.?\//, '');
  return [...S.errors.values()].filter((e) =>
    listed(e) && !isWarning(e) && (e.message.includes(c.name) || e.stack.includes(c.name) ||
      (!!file && !!e.mapped?.some((f) => f.orig?.file.endsWith(file)))));
}

const frameLi = (f: MappedFrame): string =>
  `<li class="${f.lib ? 'lib' : ''}">${f.orig ? fileLink(f.orig.file, f.orig.line, f.orig.col) : `<span>${esc(f.file)}:${f.line}</span>`}<span class="fn">${esc(f.orig?.name ?? f.fn)}</span></li>`;

// The expanded view of one error: what it means, the failing line, the stack.
export async function detailHtml(e: PanelError): Promise<string> {
  const frames = e.mapped ?? [];
  const app = frames.filter(isAppFrame);
  const top = app[0];
  const tone = isWarning(e) ? 'warn' : 'error';
  const code = top ? await codeBlock(top.orig.file, top.orig.line, { tone, before: 3, after: 2, label: `Thrown in ${top.orig.file}:${top.orig.line}` }) : '';
  return `
    <div class="box"><h3>What this means</h3><p>${esc(explain(e))}</p></div>
    ${e.code ? `<a class="ng-help" href="https://angular.dev/errors/${ngCode(e)}" target="_blank" rel="noopener">What ${ngCode(e)} means and how to fix it</a>` : ''}
    ${code || (e.stack ? '' : '<p class="note">No stack trace was captured for this error.</p>')}
    ${app.length > 1 ? `<details class="sub"><summary>Called through ${app.length - 1} more place${app.length > 2 ? 's' : ''} in your code</summary><ul class="frames">${app.slice(1, 8).map(frameLi).join('')}</ul></details>` : ''}
    ${frames.length ? `<details class="sub"><summary>Full stack (${frames.length} frames)</summary><ul class="frames">${frames.map(frameLi).join('')}</ul></details>` : e.stack ? `<details class="sub"><summary>Raw stack</summary><pre class="body-pre">${esc(e.stack)}</pre></details>` : ''}
    <p class="note">${esc(kindLabel(e.kind))}. First seen ${new Date(e.first).toLocaleTimeString()}${e.count > 1 ? `, last ${new Date(e.last).toLocaleTimeString()}` : ''}.</p>`;
}

// Plain-language reading of the most common front-end error messages.
function explain(e: PanelError): string {
  const m = e.message;
  if (isWarning(e)) return 'A warning from your code or a library. The app keeps running, but it often points at a real problem.';
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
