// JSON → TypeScript interfaces. Arrays of objects are merged: a key missing in
// some items becomes optional, mixed types become unions, null adds `| null`.

type Prop = { shape: Shape; optional: boolean };
type Shape =
  | { kind: 'string' | 'number' | 'boolean' | 'null' | 'unknown' | 'date' }
  | { kind: 'array'; item: Shape }
  | { kind: 'object'; props: Map<string, Prop> }
  | { kind: 'union'; of: Shape[] };

const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const pascal = (s: string): string => {
  const p = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^\d/.test(p) ? `_${p}` : p || 'Item';
};
const singular = (s: string): string => (/ies$/.test(s) ? s.replace(/ies$/, 'y') : /(ss|us)$/.test(s) ? s : s.replace(/s$/, ''));
const validKey = (k: string): string => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function shapeOf(v: unknown): Shape {
  if (v === null) return { kind: 'null' };
  if (Array.isArray(v)) {
    const items: Shape[] = v.map(shapeOf);
    return { kind: 'array', item: items.length ? items.reduce(merge) : { kind: 'unknown' } };
  }
  switch (typeof v) {
    case 'string': return { kind: ISO.test(v) && v.length > 9 ? 'date' : 'string' };
    case 'number': return { kind: 'number' };
    case 'boolean': return { kind: 'boolean' };
    case 'object': {
      const props = new Map<string, Prop>();
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) props.set(k, { shape: shapeOf(x), optional: false });
      return { kind: 'object', props };
    }
    default: return { kind: 'unknown' };
  }
}

// A union is a list of members, at most one per kind (string and date share one).
const members = (s: Shape): Shape[] => (s.kind === 'union' ? s.of : [s]);
const stringy = (k: Shape['kind']): boolean => k === 'string' || k === 'date';

function merge(a: Shape, b: Shape): Shape {
  const out: Shape[] = [];
  for (const m of [...members(a), ...members(b)]) {
    const i = out.findIndex((x) => x.kind === m.kind || (stringy(x.kind) && stringy(m.kind)));
    const same = out[i];
    if (!same) { out.push(m); continue; }
    if (same.kind === 'date' && m.kind === 'string') out[i] = { kind: 'string' }; // one non-date makes it a plain string
    else if (same.kind === 'array' && m.kind === 'array') out[i] = { kind: 'array', item: merge(same.item, m.item) };
    else if (same.kind === 'object' && m.kind === 'object') {
      const props = new Map(same.props);
      for (const [k, p] of m.props) {
        const q = props.get(k);
        props.set(k, q ? { shape: merge(q.shape, p.shape), optional: q.optional || p.optional } : { shape: p.shape, optional: true });
      }
      for (const [k, q] of props) if (!m.props.has(k)) props.set(k, { ...q, optional: true });
      out[i] = { kind: 'object', props };
    }
  }
  return out.length === 1 && out[0] ? out[0] : { kind: 'union', of: out };
}

export interface TsOptions { dates?: 'string' | 'Date'; exportKw?: boolean }

export function toTypeScript(value: unknown, rootName = 'Response', { dates = 'string', exportKw = true }: TsOptions = {}): string {
  const decls: (string | null)[] = [];
  const used = new Set<string>();
  const uniq = (n: string): string => { let x = n, i = 2; while (used.has(x)) x = n + i++; used.add(x); return x; };
  const ex = exportKw ? 'export ' : '';

  function typeOf(s: Shape, hint: string): string {
    switch (s.kind) {
      case 'date': return dates === 'Date' ? 'Date' : 'string';
      case 'array': {
        const one = singular(hint);
        const t = typeOf(s.item, pascal(one) === pascal(hint) ? `${hint}Item` : one);
        return /[|&]/.test(t) && !t.startsWith('(') ? `(${t})[]` : `${t}[]`;
      }
      case 'object': return declare(s.props, hint);
      case 'union': {
        const parts = [...new Set(s.of.filter((m) => m.kind !== 'null').map((m) => typeOf(m, hint)))];
        if (s.of.some((m) => m.kind === 'null')) parts.push('null');
        return parts.join(' | ');
      }
      default: return s.kind;
    }
  }
  function declare(props: Map<string, Prop>, hint: string): string {
    if (!props.size) return 'Record<string, unknown>';
    const name = uniq(pascal(hint));
    const idx = decls.push(null) - 1; // keep parents before children
    const lines = [...props].map(([k, p]) => `  ${validKey(k)}${p.optional ? '?' : ''}: ${typeOf(p.shape, k)};`);
    decls[idx] = `${ex}interface ${name} {\n${lines.join('\n')}\n}`;
    return name;
  }

  const root = shapeOf(value);
  const top = typeOf(root, rootName);
  const body = decls.filter((d): d is string => d !== null).join('\n\n');
  if (root.kind === 'object' && top !== 'Record<string, unknown>') return body;
  return `${ex}type ${pascal(rootName)} = ${top};${body ? `\n\n${body}` : ''}`;
}

export interface ServiceSpec { method: string; url: string; hasBody: boolean; rootName: string; isArrayRoot: boolean }

// A ready-to-paste Angular service method for the request.
export function angularService({ method, url, hasBody, rootName, isArrayRoot }: ServiceSpec): string {
  const m = method.toLowerCase();
  const name = pascal(rootName);
  let path = url;
  let base = '';
  try { const u = new URL(url); path = u.pathname + u.search; base = u.origin; } catch { /* keep as typed */ }
  const type = isArrayRoot ? `${name}[]` : name;
  const call = hasBody && m !== 'delete'
    ? `this.http.${m}<${type}>(\`\${this.base}${path}\`, body)`
    : `this.http.${m}<${type}>(\`\${this.base}${path}\`)`;
  return `import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class ${name}Api {
  private readonly http = inject(HttpClient);
  private readonly base = '${base}';

  ${m}${name}(${hasBody ? 'body: unknown' : ''}) {
    return ${call};
  }
}`;
}
