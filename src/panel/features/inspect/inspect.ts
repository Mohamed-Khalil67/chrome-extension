// Inspect tab: the picked element → its component, code, template line,
// styles and layout checks, split into sub-tabs.
import type { BoxModel, CssAnalysis, Selection } from '../../../shared/messages';
import { emit } from '../../core/bus';
import { codeBlock, findTemplateLine, snippetHtml, templateFor } from '../../core/code';
import { $, $$, $maybe, closest, esc } from '../../core/dom';
import { fileLink } from '../../core/editor';
import { kvList } from '../../core/format';
import { send } from '../../core/rpc';
import { S } from '../../core/state';
import { relatedTo } from '../console/errors';

type SubTab = 'component' | 'styles' | 'layout';
let subTab: SubTab = 'component';
const isSubTab = (s: string | undefined): s is SubTab => s === 'component' || s === 'styles' || s === 'layout';

// ───────────── empty state ─────────────
function startHtml(): string {
  const prodNote = S.framework?.name === 'Angular' && !S.framework.dev
    ? '<p><strong>This is a production build.</strong> Run <code>ng serve</code> to see component names, files and code. Styles, network and errors still work.</p>' : '';
  return `
    <div class="start">
      <h2>Find the code behind any part of the page</h2>
      <p>Press <strong>Pick</strong>, then click an area of the app, or hold <kbd>Alt</kbd> and click it while you use the page. You'll see:</p>
      <ul>
        <li>the component that rendered it, with its code and template line</li>
        <li>its inputs, signals and state right now</li>
        <li>which CSS rules apply, and any layout problems</li>
      </ul>
      ${prodNote}
      <button type="button" class="btn primary" data-act="pick">Pick an element</button>
    </div>`;
}

// ───────────── component sub-tab ─────────────
function componentHtml(sel: Selection): string {
  const [focus, ...parents] = sel.chain;
  if (!focus) return noComponentNote(sel);
  const errs = relatedTo(focus);
  return `
    <ol class="trail" aria-label="Component tree, nearest first">
      <li class="focus">
        <article class="cmp-focus">
          <h2 class="cmp-name">${esc(focus.name)}</h2>
          ${focus.selector ? `<div class="cmp-sel">&lt;${esc(focus.selector)}&gt;</div>` : ''}
          <div class="cmp-file">${fileLink(focus.file, focus.line)}</div>
          <div class="badges">
            ${focus.badges.map((b) => `<span class="badge">${esc(b)}</span>`).join('')}
            ${sel.directives.filter((d) => d !== focus.name).map((d) => `<span class="badge lens" title="Directive on the selected element">${esc(d)}</span>`).join('')}
            ${errs.length ? `<button type="button" class="badge bad" data-act="goto-errors">${errs.length} related error${errs.length > 1 ? 's' : ''}</button>` : ''}
          </div>
        </article>
      </li>
      ${parents.map((c) => `<li><button type="button" class="cmp-parent" data-path='${esc(JSON.stringify(c.path ?? null))}'><b>${esc(c.name)}</b><span class="mono">${esc(c.file ?? c.selector)}</span></button></li>`).join('')}
    </ol>
    <section class="section"><h3>Template</h3><div id="tpl-code"><p class="note">Looking up the template…</p></div></section>
    <section class="section"><h3>Class</h3><div id="cls-code">${focus.file ? '<p class="note">Loading source…</p>' : '<p class="note">No source location for this component.</p>'}</div></section>
    ${focus.inputs.length ? `<section class="section"><h3>Inputs <span class="n">${focus.inputs.length}</span></h3>${kvList(focus.inputs)}</section>` : ''}
    ${focus.state.length ? `<section class="section"><h3>State <span class="n">${focus.state.length}</span></h3>${kvList(focus.state)}</section>` : ''}
    ${focus.outputs.length ? `<section class="section"><h3>Outputs</h3><div class="badges">${focus.outputs.map((o) => `<span class="badge">${esc(o)}</span>`).join('')}</div></section>` : ''}
    ${sel.listeners.length ? `<section class="section"><h3>Event listeners on this element</h3><dl class="kv">${sel.listeners.map((l) => `<dt>(${esc(l.name)})</dt><dd>${esc(l.fn || 'handler')}</dd>`).join('')}</dl></section>` : ''}`;
}

function noComponentNote(sel: Selection): string {
  if (sel.error) return `<p class="note">Couldn't read component info: ${esc(sel.error)}</p>`;
  const fw = sel.framework;
  if (fw?.name === 'Angular' && !fw.dev) return '<p class="note">Production build: component info isn\'t available. Run the app with <code>ng serve</code>.</p>';
  if (!fw?.name) return '<p class="note">This page isn\'t an Angular app. The Styles and Layout tabs still apply.</p>';
  return '<p class="note">This element isn\'t inside a component.</p>';
}

// Fill the async code sections after the HTML is in place.
async function loadCode(sel: Selection): Promise<void> {
  const [focus, parent] = sel.chain;
  if (!focus) return;
  // Class: the declaration around debugInfo.lineNumber.
  if (focus.file && focus.line) {
    const html = await codeBlock(focus.file, focus.line, { before: 1, after: 8, tone: 'focus' });
    const box = $maybe('#cls-code');
    if (S.selection === sel && box) box.innerHTML = html;
  }
  // Template: the element's line in the template that created it. A component
  // host element is created by its parent's template.
  const owner = sel.elementIsHost ? parent : focus;
  const tpl = owner?.file ? await templateFor(owner.file) : null;
  const box = $maybe('#tpl-code');
  if (S.selection !== sel || !box) return;
  if (!tpl) { box.innerHTML = '<p class="note">Template not found in the page\'s source maps.</p>'; return; }
  const hit = findTemplateLine(tpl.text, sel.desc);
  if (!hit) {
    box.innerHTML = `<p class="note">Couldn't match &lt;${esc(sel.desc.tag)}&gt; to a line in ${fileLink(tpl.file, 1)}. It may be created by a child component or a directive.</p>`;
    return;
  }
  const label = `${tpl.file}:${hit.line}${hit.score < 3 ? ' (best guess)' : ''}`;
  box.innerHTML = snippetHtml(tpl.file, tpl.text, hit.line, { before: 2, after: 3, tone: 'focus', label });
}

// ───────────── styles + layout sub-tabs ─────────────
function boxHtml(b: BoxModel): string {
  const side = (arr: number[]): (number | string)[] => arr.map((n) => n || '–');
  const [mt, mr, mb, ml] = side(b.margin), [bt, br, bb, bl] = side(b.border), [pt, pr, pb, pl] = side(b.padding);
  return `
    <section class="section"><h3>Box model</h3>
      <div class="boxm" role="img" aria-label="margin ${b.margin.join(' ')}, border ${b.border.join(' ')}, padding ${b.padding.join(' ')}, content ${b.content[0]} by ${b.content[1]}">
        <div class="lyr m"><span class="lbl">margin</span><span class="t">${mt}</span><span class="b">${mb}</span><span class="l">${ml}</span><span class="r">${mr}</span>
          <div class="lyr bd"><span class="lbl">border</span><span class="t">${bt}</span><span class="b">${bb}</span><span class="l">${bl}</span><span class="r">${br}</span>
            <div class="lyr p"><span class="lbl">padding</span><span class="t">${pt}</span><span class="b">${pb}</span><span class="l">${pl}</span><span class="r">${pr}</span>
              <div class="c">${b.content[0]} × ${b.content[1]}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="facts">
        <span class="badge">display: ${esc(b.display)}</span>
        <span class="badge">position: ${esc(b.position)}</span>
        <span class="badge">${esc(b.boxSizing)}</span>
        ${b.key.zIndex !== 'auto' ? `<span class="badge">z-index: ${esc(b.key.zIndex)}</span>` : ''}
        ${b.key.overflow !== 'visible' ? `<span class="badge">overflow: ${esc(b.key.overflow)}</span>` : ''}
      </div>
    </section>`;
}

function stylesHtml(css: CssAnalysis | null): string {
  if (!css || 'error' in css) return `<p class="note">CSS analysis failed${css ? `: ${esc(css.error)}` : ''}.</p>`;
  const rules = css.rules.filter((r) => r.lines.length);
  const rulesHtml = rules.length ? `
    <section class="section"><h3>Rules <span class="n">${rules.length}, strongest first</span></h3>
      ${rules.map((r) => `
        <div class="rule">
          <header>
            <span class="sel">${esc(r.selector)}</span>
            ${r.owner ? `<span class="owner" title="Scoped component styles">${esc(r.owner)}</span>` : `<span class="src">${esc(r.label)}</span>`}
          </header>
          ${r.ctx?.length ? `<div class="ctx">${r.ctx.map(esc).join(' ')}</div>` : ''}
          <ul>${r.lines.map((d) => `<li class="${d.overridden ? 'over' : ''}" ${d.overridden ? 'title="Overridden by a stronger rule"' : ''}><span class="p-name">${esc(d.prop)}</span>: ${esc(d.value)}${d.important ? ' <span class="imp">!important</span>' : ''};</li>`).join('')}</ul>
        </div>`).join('')}
    </section>` : '<section class="section"><h3>Rules</h3><p class="note">Only browser defaults and inherited styles apply.</p></section>';
  return boxHtml(css.box) + rulesHtml;
}

const warningsOf = (css: CssAnalysis | null | undefined) => (css && !('error' in css) ? css.warnings : []);

function layoutHtml(css: CssAnalysis | null): string {
  const list = warningsOf(css);
  return list.length
    ? `<ul class="problems">${list.map((w) => `<li class="problem ${esc(w.level)}"><strong>${esc(w.text)}</strong><span>${esc(w.hint)}</span></li>`).join('')}</ul>`
    : '<p class="all-good">No layout problems found on this element.</p>';
}

export const layoutWarnings = (): number => warningsOf(S.selection?.css).filter((w) => w.level !== 'info').length;

// ───────────── render ─────────────
export function render(): void {
  const root = $('#inspect');
  const sel = S.selection;
  if (!sel) { root.innerHTML = startHtml(); emit('counts'); return; }
  const warnN = warningsOf(sel.css).length;
  const tabs: [SubTab, string][] = [['component', 'Component'], ['styles', 'Styles'], ['layout', `Layout${warnN ? ` <span class="n warn">${warnN}</span>` : ''}`]];
  root.innerHTML = `
    <div class="el-bar">
      <span class="tag">&lt;${esc(sel.element)}&gt;</span>
      <span class="dim">${sel.rect.w}×${sel.rect.h}</span>
      <span class="spacer"></span>
      <button type="button" class="btn small ghost" data-act="parent" title="Select the parent element">Parent</button>
      <button type="button" class="btn small ghost" data-act="refresh" title="Read current values again">Refresh</button>
      <button type="button" class="btn small ghost" data-act="clear-sel">Clear</button>
    </div>
    <div class="seg" role="tablist" aria-label="Inspect views">
      ${tabs.map(([k, label]) => `<button type="button" role="tab" data-sub="${k}" aria-selected="${k === subTab}">${label}</button>`).join('')}
    </div>
    <div class="sub-body" role="tabpanel">
      ${subTab === 'component' ? componentHtml(sel) : subTab === 'styles' ? stylesHtml(sel.css) : layoutHtml(sel.css)}
    </div>`;
  if (subTab === 'component') void loadCode(sel);
  emit('counts');
}

export function showLayout(): void { subTab = 'layout'; render(); }

const setSelection = (sel: Selection | null | undefined): void => {
  if (sel) { S.selection = sel; render(); }
};

export function init(startPick: () => void): void {
  const root = $('#inspect');
  root.addEventListener('click', (e) => {
    const sub = closest(e, '[data-sub]')?.dataset.sub;
    if (isSubTab(sub)) { subTab = sub; render(); return; }
    const parentBtn = closest(e, '.cmp-parent');
    if (parentBtn) {
      const raw: unknown = JSON.parse(parentBtn.dataset.path ?? 'null');
      if (Array.isArray(raw) && raw.every((x) => typeof x === 'number')) void send({ type: 'select:path', path: raw }).then(setSelection);
      return;
    }
    switch (closest(e, '[data-act]')?.dataset.act) {
      case 'pick': startPick(); break;
      case 'refresh': void send({ type: 'reinspect' }).then(setSelection); break;
      case 'parent': void send({ type: 'select:parent' }).then(setSelection); break;
      case 'clear-sel': void send({ type: 'selection:clear' }).then(() => { S.selection = null; render(); }); break;
      case 'goto-errors': emit('goto-errors'); break;
    }
  });
  // Arrow keys between the sub-tabs.
  root.addEventListener('keydown', (e) => {
    const tab = closest(e, '[data-sub]');
    if (!tab || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const all = $$('[data-sub]', root);
    const i = all.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
    const next = all[(i + all.length) % all.length]?.dataset.sub;
    if (!isSubTab(next)) return;
    subTab = next;
    render();
    $maybe(`[data-sub="${subTab}"]`)?.focus();
  });
}
