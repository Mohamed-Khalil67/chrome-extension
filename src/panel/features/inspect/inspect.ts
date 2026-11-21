// Inspect tab: the picked element → its component, code, template line,
// styles and layout checks, split into sub-tabs.
import type { BoxModel, CssAnalysis, DomNode, Selection } from '../../../shared/messages';
import { emit } from '../../core/bus';
import { codeBlock, findTemplateLine, snippetHtml, templateFor } from '../../core/code';
import { $, $$, $maybe, closest, copyText, esc } from '../../core/dom';
import { fileLink } from '../../core/editor';
import { kvList } from '../../core/format';
import { send } from '../../core/rpc';
import { S } from '../../core/state';
import { relatedTo } from '../console/errors';

type SubTab = 'component' | 'styles' | 'layout';
let subTab: SubTab = 'component';
const isSubTab = (s: string | undefined): s is SubTab => s === 'component' || s === 'styles' || s === 'layout';

// ───────────── before anything is picked ─────────────
// No start screen: the tab opens on the app's root element so the tree is
// there to walk straight away. Picking just moves the selection.
let rootState: 'idle' | 'asking' | 'failed' = 'idle';

export function ensureRoot(): void {
  if (S.selection || rootState !== 'idle') return;
  rootState = 'asking';
  void send({ type: 'select:root' }).then((sel) => {
    rootState = sel ? 'idle' : 'failed';
    if (sel) setSelection(sel);
    else render();
  });
}
// A fresh tab (or a reload) asks again.
export function reset(): void { rootState = 'idle'; }

function waitingHtml(): string {
  if (rootState === 'failed') {
    return `<div class="start">
      <h2>Not connected to the page</h2>
      <p>Angular Lens starts with the page. Reload your app, or press <strong>Pick</strong> and click an element.</p>
      <button type="button" class="btn primary" data-act="pick">Pick an element</button>
    </div>`;
  }
  return '<p class="note">Reading the page tree…</p>';
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

// ───────────── DOM hierarchy ─────────────
// <html> down to the selected element, then its children: the whole chain is
// walkable, so you can move up to a wrapper or down into a child without
// re-picking on the page.
function nodeLabel(n: DomNode): string {
  const id = n.id ? `#${n.id}` : '';
  const cls = n.classes.length ? `.${n.classes.slice(0, 3).join('.')}${n.classes.length > 3 ? '…' : ''}` : '';
  return `${n.tag}${id}${cls}`;
}

function nodeBtn(n: DomNode, depth: number, kind: 'ancestor' | 'current' | 'child'): string {
  const meta = [
    n.component ? `<span class="n-cmp">${esc(n.component)}</span>` : '',
    n.childCount ? `<span class="n-kids">${n.childCount}</span>` : '',
  ].filter(Boolean).join('');
  return `<li>
    <button type="button" class="dom-node ${kind}" data-path="${esc(JSON.stringify(n.path))}"
      style="--d:${depth}" ${kind === 'current' ? 'aria-current="true"' : ''}
      title="${esc(nodeLabel(n))} — ${n.w}×${n.h}">
      <span class="n-tag">${esc(n.tag)}</span><span class="n-name">${esc(nodeLabel(n).slice(n.tag.length))}</span>${meta}
    </button>
  </li>`;
}

function treeHtml(sel: Selection): string {
  const path = sel.domPath;
  const current = path.at(-1);
  // No walkable path (an element inside a shadow root): still say what is selected.
  if (!current) {
    return `<section class="dom-tree"><header class="dom-head">
      <h3 class="n-tag">&lt;${esc(sel.element)}&gt;</h3>
      <span class="dim">${sel.rect.w}×${sel.rect.h} · inside a shadow root, so the hierarchy can't be walked</span>
    </header></section>`;
  }
  const ancestors = path.slice(0, -1);
  const kids = sel.domChildren;
  const sibs = sel.siblingCount > 1 ? `${sel.siblingIndex + 1} of ${sel.siblingCount}` : 'only child';
  return `
    <section class="dom-tree" aria-label="Element hierarchy">
      <header class="dom-head">
        <h3>Hierarchy</h3>
        <span class="dim">${esc(sibs)} · ${current.w}×${current.h}</span>
        <span class="spacer"></span>
        <span class="dom-keys dim" aria-hidden="true">↑ parent · ↓ child · ← → sibling</span>
        <button type="button" class="btn tiny ghost" data-act="copy-sel" title="Copy a CSS selector for this element">Copy selector</button>
        <span class="sr-only" role="status"></span>
      </header>
      <ol class="dom-list">
        ${ancestors.map((n, i) => nodeBtn(n, i, 'ancestor')).join('')}
        ${nodeBtn(current, ancestors.length, 'current')}
        ${kids.map((n) => nodeBtn(n, ancestors.length + 1, 'child')).join('')}
      </ol>
      ${current.childCount > kids.length ? `<p class="note">Showing the first ${kids.length} of ${current.childCount} children.</p>` : ''}
    </section>`;
}

const selectPath = (path: number[]): void => {
  void send({ type: 'select:path', path }).then((sel) => {
    setSelection(sel);
    // render() rebuilt the list: put focus back on the row that is now current,
    // so arrow keys keep walking the tree.
    $maybe('.dom-node.current')?.focus();
  });
};

// A selector good enough to paste into the console or a test.
function cssSelectorOf(sel: Selection): string {
  return sel.domPath.slice(1).map((n) => {
    if (n.id) return `#${n.id}`;
    const cls = n.classes.length ? `.${n.classes.join('.')}` : '';
    return `${n.tag}${cls}`;
  }).join(' > ');
}

// ───────────── render ─────────────
export function render(): void {
  const root = $('#inspect');
  const sel = S.selection;
  if (!sel) { root.innerHTML = waitingHtml(); ensureRoot(); emit('counts'); return; }
  const warnN = warningsOf(sel.css).length;
  const tabs: [SubTab, string][] = [['component', 'Component'], ['styles', 'Styles'], ['layout', `Layout${warnN ? ` <span class="n warn">${warnN}</span>` : ''}`]];
  root.innerHTML = `
    ${treeHtml(sel)}
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
    const node = closest(e, '[data-path]');
    if (node) {
      const raw: unknown = JSON.parse(node.dataset.path ?? 'null');
      if (Array.isArray(raw) && raw.every((x) => typeof x === 'number')) selectPath(raw);
      return;
    }
    const act = closest<HTMLElement>(e, '[data-act]');
    switch (act?.dataset.act) {
      case 'pick': startPick(); break;
      case 'copy-sel': if (S.selection) void copyText(act, cssSelectorOf(S.selection)); break;
      case 'goto-errors': emit('goto-errors'); break;
    }
  });
  // Arrow keys: between the sub-tabs, and through the hierarchy.
  root.addEventListener('keydown', (e) => {
    const tab = closest(e, '[data-sub]');
    if (tab && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const all = $$('[data-sub]', root);
      const i = all.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
      const next = all[(i + all.length) % all.length]?.dataset.sub;
      if (!isSubTab(next)) return;
      subTab = next;
      render();
      $maybe(`[data-sub="${subTab}"]`)?.focus();
      return;
    }
    const sel = S.selection;
    if (!sel || !closest(e, '.dom-tree')) return;
    const path = sel.domPath.at(-1)?.path;
    if (!path) return;
    const i = path.at(-1);
    const next = ((): number[] | null => {
      switch (e.key) {
        case 'ArrowUp': return path.length ? path.slice(0, -1) : null;
        case 'ArrowDown': return sel.domChildren[0]?.path ?? null;
        case 'ArrowLeft': return i != null && i > 0 ? [...path.slice(0, -1), i - 1] : null;
        case 'ArrowRight': return i != null && i < sel.siblingCount - 1 ? [...path.slice(0, -1), i + 1] : null;
        default: return null;
      }
    })();
    if (!next) return;
    e.preventDefault();
    selectPath(next);
  });
  // Keep the focused row in view after a move.
  root.addEventListener('focusin', (e) => { closest(e, '.dom-node')?.scrollIntoView({ block: 'nearest' }); });
}
