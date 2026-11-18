// Minimal source-map resolver: turns `http://localhost:4200/main.js:120:15`
// into `src/app/foo.ts:42:7` using the dev server's source maps.
// Small on purpose (no dependency): decodes VLQ mappings lazily per script.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

function decodeVlq(str) {
  const out = [];
  let shift = 0, value = 0;
  for (const ch of str) {
    const digit = B64_INDEX.get(ch);
    if (digit === undefined) continue;
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) { shift += 5; continue; }
    const neg = value & 1;
    value >>>= 1;
    out.push(neg ? -value : value);
    value = 0; shift = 0;
  }
  return out;
}

function parseMappings(mappings) {
  // lines[genLine] = [[genCol, srcIdx, srcLine, srcCol, nameIdx?], ...]
  const lines = [];
  let src = 0, srcLine = 0, srcCol = 0, name = 0;
  for (const line of mappings.split(';')) {
    const segs = [];
    let genCol = 0;
    if (line) {
      for (const seg of line.split(',')) {
        const v = decodeVlq(seg);
        if (!v.length) continue;
        genCol += v[0];
        if (v.length >= 4) {
          src += v[1]; srcLine += v[2]; srcCol += v[3];
          if (v.length >= 5) name += v[4];
          segs.push([genCol, src, srcLine, srcCol, v.length >= 5 ? name : -1]);
        }
      }
    }
    lines.push(segs);
  }
  return lines;
}

const cache = new Map(); // scriptUrl → Promise<map|null>

async function loadMap(scriptUrl) {
  if (cache.has(scriptUrl)) return cache.get(scriptUrl);
  const p = (async () => {
    try {
      const js = await (await fetch(scriptUrl, { cache: 'force-cache' })).text();
      const m = /[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m.exec(js.slice(-4000));
      let raw;
      if (!m) {
        const res = await fetch(scriptUrl + '.map');
        if (!res.ok) return null;
        raw = await res.json();
      } else if (m[1].startsWith('data:')) {
        const b64 = m[1].slice(m[1].indexOf(',') + 1);
        raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
      } else {
        raw = await (await fetch(new URL(m[1], scriptUrl))).json();
      }
      if (!raw?.mappings) return null;
      return { raw, lines: null };
    } catch {
      return null;
    }
  })();
  cache.set(scriptUrl, p);
  return p;
}

function cleanSource(source, sourceRoot) {
  let s = (sourceRoot ? sourceRoot.replace(/\/?$/, '/') : '') + source;
  s = s.replace(/^webpack:\/\/\/?/, '').replace(/^[a-z-]+:\/\/\/?/, '').replace(/^\.\//, '');
  s = s.replace(/^(\.\.\/)+/, '');
  return s;
}

export async function resolve(url, line, col) {
  const map = await loadMap(url);
  if (!map) return null;
  map.lines ??= parseMappings(map.raw.mappings);
  const segs = map.lines[line - 1];
  if (!segs?.length) return null;
  let best = null;
  for (const s of segs) {
    if (s[0] <= col - 1) best = s; else break;
  }
  best ??= segs[0];
  const source = map.raw.sources[best[1]];
  if (source == null) return null;
  return {
    file: cleanSource(source, map.raw.sourceRoot),
    line: best[2] + 1,
    col: best[3] + 1,
    name: best[4] >= 0 ? map.raw.names?.[best[4]] : undefined,
  };
}

// "    at Foo.bar (http://localhost:4200/main.js:10:5)" → frame object
const FRAME = /^\s*at\s+(?:(.*?)\s+\()?((?:https?|chrome-extension):\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/;
export function parseStack(stack) {
  const frames = [];
  for (const l of String(stack || '').split('\n')) {
    const m = FRAME.exec(l);
    if (m) frames.push({ fn: m[1] || '', url: m[2], line: +m[3], col: +m[4] });
  }
  return frames;
}

export const isLibrary = (file) =>
  /node_modules|\/@angular\/|\/rxjs\/|zone\.js|\/vite\/deps\/|\/@fs\/|polyfills|webpack\/|\(webpack\)|vite\/dist|\/react-dom|\/vue\//.test(file || '');

// RxJS/HttpClient stacks are deep: the app frame is often 40+ frames down.
// Library frames are not resolved (no fetch), so a high limit is cheap.
export async function mapStack(stack, limit = 80) {
  const frames = parseStack(stack).filter((f) => !f.url.startsWith('chrome-extension://')).slice(0, limit);
  return Promise.all(frames.map(async (f) => {
    // Don't fetch maps for prebundled libraries (Vite deps): slow and often stale.
    const orig = isLibrary(f.url) ? null : await resolve(f.url, f.line, f.col).catch(() => null);
    const file = orig?.file || f.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
    return { ...f, orig, file, lib: isLibrary(orig?.file || f.url) };
  }));
}
