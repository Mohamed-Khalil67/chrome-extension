// JSON → TypeScript interfaces. Arrays of objects are merged: a key missing in
// some items becomes optional, mixed types become unions, null adds `| null`.

const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const pascal = (s) => {
  const p = String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^\d/.test(p) ? `_${p}` : p || 'Item';
};
const singular = (s) => (/ies$/.test(s) ? s.replace(/ies$/, 'y') : /(ss|us)$/.test(s) ? s : s.replace(/s$/, ''));
const validKey = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

// Shape: { kind: 'string'|'number'|'boolean'|'null'|'unknown'|'date'|'array'|'object', ... }
function shapeOf(v) {
  if (v === null) return { kind: 'null' };
  if (Array.isArray(v)) return { kind: 'array', item: v.length ? v.map(shapeOf).reduce(merge) : { kind: 'unknown' } };
  switch (typeof v) {
    case 'string': return { kind: ISO.test(v) && v.length > 9 ? 'date' : 'string' };
    case 'number': return { kind: 'number' };
    case 'boolean': return { kind: 'boolean' };
    case 'object': {
      const props = new Map();
      for (const [k, x] of Object.entries(v)) props.set(k, { shape: shapeOf(x), optional: false });
      return { kind: 'object', props };
    }
    default: return { kind: 'unknown' };
  }
}

// A union of shapes is a list of members, one per kind.
const members = (s) => (s.kind === 'union' ? s.of : [s]);
function merge(a, b) {
  const out = [];
  for (const m of [...members(a), ...members(b)]) {
    const same = out.find((x) => x.kind === m.kind || (['string', 'date'].includes(x.kind) && ['string', 'date'].includes(m.kind)));
    if (!same) { out.push(m); continue; }
    if (same.kind === 'date' && m.kind === 'string') same.kind = 'string'; // one non-date makes it a plain string
    if (same.kind === 'array') same.item = merge(same.item, m.item);
    if (same.kind === 'object') {
      for (const [k, p] of m.props) {
        const q = same.props.get(k);
        same.props.set(k, q ? { shape: merge(q.shape, p.shape), optional: q.optional || p.optional } : { shape: p.shape, optional: true });
      }
      for (const [k, q] of same.props) if (!m.props.has(k)) q.optional = true;
    }
  }
  return out.length === 1 ? out[0] : { kind: 'union', of: out };
}

export function toTypeScript(value, rootName = 'Response', { dates = 'string', exportKw = true } = {}) {
  const decls = [];
  const used = new Set();
  const uniq = (n) => { let x = n, i = 2; while (used.has(x)) x = n + i++; used.add(x); return x; };
  const ex = exportKw ? 'export ' : '';

  function typeOf(s, hint) {
    switch (s.kind) {
      case 'date': return dates === 'Date' ? 'Date' : 'string';
      case 'array': {
        const one = singular(hint);
        const t = typeOf(s.item, pascal(one) === pascal(hint) ? `${hint}Item` : one);
        return /[|&]/.test(t) && !t.startsWith('(') ? `(${t})[]` : `${t}[]`;
      }
      case 'object': return declare(s, hint);
      case 'union': {
        const parts = s.of.filter((m) => m.kind !== 'null').map((m) => typeOf(m, hint));
        const uniqParts = [...new Set(parts)];
        if (s.of.some((m) => m.kind === 'null')) uniqParts.push('null');
        return uniqParts.join(' | ');
      }
      default: return s.kind;
    }
  }
  function declare(s, hint) {
    if (!s.props.size) return 'Record<string, unknown>';
    const name = uniq(pascal(hint));
    const idx = decls.push(null) - 1; // keep parents before children
    const lines = [];
    for (const [k, p] of s.props) lines.push(`  ${validKey(k)}${p.optional ? '?' : ''}: ${typeOf(p.shape, k)};`);
    decls[idx] = `${ex}interface ${name} {\n${lines.join('\n')}\n}`;
    return name;
  }

  const root = shapeOf(value);
  const top = typeOf(root, rootName);
  let out = decls.filter(Boolean).join('\n\n');
  if (root.kind !== 'object' || top === 'Record<string, unknown>') out = `${ex}type ${pascal(rootName)} = ${top};${out ? '\n\n' + out : ''}`;
  else if (top !== pascal(rootName) && top !== uniq.name) out = out.replace(`interface ${top} `, `interface ${pascal(rootName)} `);
  return out;
}

// A ready-to-paste Angular service method for the request.
export function angularService({ method, url, hasBody, rootName, isArrayRoot }) {
  const m = method.toLowerCase();
  const name = pascal(rootName);
  let path = url;
  try { const u = new URL(url); path = u.pathname + u.search; } catch { /* keep as typed */ }
  const base = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  const type = isArrayRoot ? `${name}[]` : name;
  const body = hasBody ? 'body: unknown' : '';
  const call = hasBody && m !== 'delete'
    ? `this.http.${m}<${type}>(\`\${this.base}${path}\`, body)`
    : `this.http.${m}<${type}>(\`\${this.base}${path}\`)`;
  return `import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class ${name}Api {
  private readonly http = inject(HttpClient);
  private readonly base = '${base}';

  ${m === 'get' ? 'get' : m}${name}(${body}) {
    return ${call};
  }
}`;
}
