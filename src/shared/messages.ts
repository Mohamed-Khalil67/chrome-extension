// Every message that crosses a boundary: page world ⇄ isolated world (CustomEvents
// on `document`), and content script ⇄ side panel / service worker (chrome.runtime).
// Data from the page world is untrusted: it is checked with the guards below.

// ───────────── values shown in the panel (component state, console args) ─────────────
export type Val =
  | { t: 'null' }
  | { t: 'undef' }
  | { t: 'str'; v: string }
  | { t: 'num'; v: string }
  | { t: 'bool'; v: string }
  | { t: 'fn'; v: string }
  | { t: 'node'; v: string }
  | { t: 'other'; v: string }
  | { t: 'signal'; kind: 'signal' | 'input' | 'computed'; writable: boolean; v: Val }
  | { t: 'obs'; v: string; cur?: Val }
  | { t: 'arr'; len: number; items: Val[]; ctor?: string }
  | { t: 'obj'; ctor?: string; entries: [string, Val][]; more?: number };

// ───────────── network ─────────────
export type Header = [name: string, value: string];
export interface Body { text: string; truncated?: boolean; note?: string }

export interface NetStart {
  id: string;
  kind: 'fetch' | 'xhr';
  url: string;
  method: string;
  start: number;
  reqHeaders: Header[];
  reqBody: Body | null;
  initiator: string;
}
export interface NetEnd {
  id: string;
  status: number;
  statusText: string;
  end: number;
  resHeaders?: Header[];
  resBody?: Body;
  size?: number;
  redirected?: boolean;
  error?: string;
}
export type NetEntry = NetStart & Partial<Omit<NetEnd, 'id'>>;

// ───────────── errors ─────────────
export type ErrKind = 'error' | 'promise' | 'console' | 'warn' | 'resource' | 'http';
export interface ErrPayload {
  kind: ErrKind;
  message: string;
  stack: string;
  code: string | null; // NG error number, e.g. "100" for NG0100
  time: number;
  file?: string;
  line?: number;
  col?: number;
  netId?: string;
}
export interface ErrorEntry extends ErrPayload { key: string; count: number; first: number; last: number }
export interface ErrUpdate { key: string; count: number; last: number }

// ───────────── console ─────────────
export type LogLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';
export interface LogMsg { id: string; level: LogLevel; args: Val[]; time: number; stack: string }
export type EvalResult = { ok: true; value: Val } | { ok: false; error: string; stack?: string };
export type EvalDone = EvalResult & { id: number };

// ───────────── framework / inspect ─────────────
export interface FrameworkInfo {
  name: string | null;
  version?: string;
  dev?: boolean;
  zoneless?: boolean;
  adapter?: string;
}
export interface ComponentInfo {
  framework: string;
  name: string;
  selector: string;
  host: string;
  path?: number[] | null;
  file: string | null;
  line: number | null;
  badges: string[];
  inputs: [string, Val][];
  outputs: string[];
  state: [string, Val][];
}
export interface ListenerInfo { name: string; type: string; capture: boolean; fn: string }
export interface InspectResult {
  framework?: FrameworkInfo;
  element?: string;
  elementIsHost?: boolean;
  chain: ComponentInfo[];
  listeners?: ListenerInfo[];
  directives?: string[];
  error?: string;
}
export interface HoverInfo { name: string | null; selector: string | null }

// ───────────── CSS analysis ─────────────
export interface BoxModel {
  display: string;
  position: string;
  boxSizing: string;
  width: number;
  height: number;
  margin: number[];
  border: number[];
  padding: number[];
  content: [number, number];
  key: { color: string; background: string; font: string; zIndex: string; overflow: string; gap: string };
}
export interface LayoutWarning { level: 'error' | 'warn' | 'info'; text: string; hint: string }
export interface RuleLine { prop: string; value: string; important: boolean; overridden: boolean }
export interface RuleOut {
  label: string;
  selector: string;
  matched?: string[];
  ctx?: string[];
  owner?: string | null;
  inline?: boolean;
  lines: RuleLine[];
}
export type CssAnalysis = { box: BoxModel; warnings: LayoutWarning[]; rules: RuleOut[] } | { error: string };

export interface ElementDesc { tag: string; id: string; classes: string[]; attrs: string[]; text: string }

// One element in the DOM tree, as the Inspect tab lists it. `path` is the chain
// of child indices from <html>, the same shape `select:path` takes.
export interface DomNode {
  path: number[];
  tag: string;
  id: string;
  classes: string[];
  childCount: number;
  component: string | null; // component that rendered it, when known
  w: number;
  h: number;
}
export interface Selection {
  element: string;
  elementIsHost: boolean;
  desc: ElementDesc;
  // <html> → … → the selected element (last), then what sits under and beside it.
  domPath: DomNode[];
  domChildren: DomNode[];
  siblingIndex: number;
  siblingCount: number;
  framework: FrameworkInfo | null;
  chain: ComponentInfo[];
  listeners: ListenerInfo[];
  directives: string[];
  error?: string;
  rect: { w: number; h: number };
  text: string;
  css: CssAnalysis | null;
}

// ───────────── page world → isolated world ─────────────
export const OUT = '__felens:out';
export const IN = '__felens:in';

export type PageEvent =
  | { type: 'reply'; payload: { rid: number; payload: unknown } }
  | { type: 'framework'; payload: FrameworkInfo }
  | { type: 'net:start'; payload: NetStart }
  | { type: 'net:end'; payload: NetEnd }
  | { type: 'err'; payload: ErrPayload }
  | { type: 'log'; payload: LogMsg }
  | { type: 'eval:done'; payload: EvalDone };

export type PageRequest = {
  type: 'detect' | 'inspect' | 'hover' | 'applyChanges' | 'eval';
  rid: number;
  q: string | null;
  id?: number;
  code?: string;
};

const PAGE_EVENTS = new Set<string>(['reply', 'framework', 'net:start', 'net:end', 'err', 'log', 'eval:done']);
const PAGE_REQUESTS = new Set<string>(['detect', 'inspect', 'hover', 'applyChanges', 'eval']);

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function parse(detail: unknown): unknown {
  if (typeof detail !== 'string') return null;
  try { return JSON.parse(detail); } catch { return null; }
}

// Any script on the page can dispatch these events, so check the shape before use.
export function readPageEvent(detail: unknown): PageEvent | null {
  const m = parse(detail);
  if (!isRecord(m) || typeof m.type !== 'string' || !PAGE_EVENTS.has(m.type) || !isRecord(m.payload)) return null;
  // Shape checked: known discriminant with an object payload, produced by our hook.
  return m as PageEvent;
}
export function readPageRequest(detail: unknown): PageRequest | null {
  const m = parse(detail);
  if (!isRecord(m) || typeof m.type !== 'string' || !PAGE_REQUESTS.has(m.type) || typeof m.rid !== 'number') return null;
  if (m.q !== null && typeof m.q !== 'string') return null;
  // Shape checked above: known type, numeric rid, string-or-null q.
  return m as PageRequest;
}

// ───────────── content script → side panel ─────────────
export type PanelEvent =
  | { evt: 'framework'; payload: FrameworkInfo }
  | { evt: 'net:start'; payload: NetStart }
  | { evt: 'net:end'; payload: NetEnd }
  | { evt: 'err:add'; payload: ErrorEntry }
  | { evt: 'err:update'; payload: ErrUpdate }
  | { evt: 'log'; payload: LogMsg }
  | { evt: 'selection'; payload: Selection }
  | { evt: 'picker'; payload: { active: boolean } };
export type RuntimeEvent = { type: 'evt' } & PanelEvent;
export type BadgeMsg = { type: 'badge'; errors: number };

// ───────────── side panel → content script ─────────────
export interface Snapshot {
  url: string;
  framework: FrameworkInfo | null;
  net: NetEntry[];
  errors: ErrorEntry[];
  logs: LogMsg[];
  selection: Selection | null;
  picking: boolean;
}

// Request type → response type.
export interface PanelRpc {
  snapshot: { req: { type: 'snapshot' }; res: Snapshot };
  scripts: { req: { type: 'scripts' }; res: string[] };
  'picker:toggle': { req: { type: 'picker:toggle' }; res: boolean };
  'picker:start': { req: { type: 'picker:start' }; res: boolean };
  'picker:stop': { req: { type: 'picker:stop' }; res: boolean };
  eval: { req: { type: 'eval'; code: string }; res: EvalResult };
  'clear:logs': { req: { type: 'clear:logs' }; res: boolean };
  'clear:net': { req: { type: 'clear:net' }; res: boolean };
  'clear:errors': { req: { type: 'clear:errors' }; res: boolean };
  'select:path': { req: { type: 'select:path'; path: number[] }; res: Selection | null };
}
export type PanelRequest = PanelRpc[keyof PanelRpc]['req'];
// The panel keeps a port open to the content script while it is open; Alt+click
// picking is active only then.
export const PANEL_PORT = 'angular-lens-panel';
export type ResponseOf<T extends PanelRequest> = PanelRpc[T['type']]['res'];
