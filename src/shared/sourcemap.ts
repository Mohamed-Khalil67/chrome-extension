// Minimal source-map resolver: turns `http://localhost:4200/main.js:120:15`
// into `src/app/foo.ts:42:7` using the dev server's source maps.
// Small on purpose (no dependency): decodes VLQ mappings lazily per script.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

interface RawMap { mappings: string; sources: (string | null)[]; sourcesContent?: (string | null)[]; sourceRoot?: string; names?: string[] }
type Segment = [genCol: number, src: number, srcLine: number, srcCol: number, name: number];
interface LoadedMap { raw: RawMap; lines: Segment[][] | null }

export interface Origin { file: string; line: number; col: number; name?: string }
export interface Frame { fn: string; url: string; line: number; col: number }
export interface MappedFrame extends Frame { orig: Origin | null; file: string; lib: boolean }

const isRawMap = (v: unknown): v is RawMap =>
  typeof v === 'object' && v !== null && typeof Reflect.get(v, 'mappings') === 'string' && Array.isArray(Reflect.get(v, 'sources'));

function decodeVlq(str: string): number[] {
  const out: number[] = [];
  let shift = 0, value = 0;
  for (const ch of str) {
    const digit = B64_INDEX.get(ch);
    if (digit === undefined) continue;
    value += (digit & 31) << shift;
    if (digit & 32) { shift += 5; continue; }
    const neg = value & 1;
    value >>>= 1;
    out.push(neg ? -value : value);
    value = 0; shift = 0;
  }
  return out;
}

function parseMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let src = 0, srcLine = 0, srcCol = 0, name = 0;
  for (const line of mappings.split(';')) {
    const segs: Segment[] = [];
    let genCol = 0;
    for (const seg of line ? line.split(',') : []) {
      const [d0, d1, d2, d3, d4] = decodeVlq(seg);
      if (d0 === undefined) continue;
      genCol += d0;
      if (d1 !== undefined && d2 !== undefined && d3 !== undefined) {
        src += d1; srcLine += d2; srcCol += d3;
        if (d4 !== undefined) name += d4;
        segs.push([genCol, src, srcLine, srcCol, d4 !== undefined ? name : -1]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

const cache = new Map<string, Promise<LoadedMap | null>>(); // script URL → map

async function fetchJson(url: string | URL): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json() as Promise<unknown>;
}

function loadMap(scriptUrl: string): Promise<LoadedMap | null> {
  const hit = cache.get(scriptUrl);
  if (hit) return hit;
  const p = (async (): Promise<LoadedMap | null> => {
    try {
      const js = await (await fetch(scriptUrl, { cache: 'force-cache' })).text();
      // Inline (data:) maps can be megabytes long, so look for the last
      // sourceMappingURL comment anywhere in the file, not just its tail.
      const at = js.lastIndexOf('sourceMappingURL=');
      const ref = at >= 0 ? /sourceMappingURL=([^\s'"]+)/.exec(js.slice(at))?.[1] : undefined;
      let raw: unknown;
      if (!ref) raw = await fetchJson(`${scriptUrl}.map`);
      else if (ref.startsWith('data:')) {
        const b64 = ref.slice(ref.indexOf(',') + 1);
        raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
      } else raw = await fetchJson(new URL(ref, scriptUrl));
      return isRawMap(raw) ? { raw, lines: null } : null;
    } catch {
      return null;
    }
  })();
  cache.set(scriptUrl, p);
  return p;
}

function cleanSource(source: string, sourceRoot?: string): string {
  let s = (sourceRoot ? sourceRoot.replace(/\/?$/, '/') : '') + source;
  s = s.replace(/^webpack:\/\/\/?/, '').replace(/^[a-z-]+:\/\/\/?/, '').replace(/^\.\//, '');
  return s.replace(/^(\.\.\/)+/, '');
}

export const isLibrary = (file: string): boolean =>
  /node_modules|\/@angular\/|\/rxjs\/|zone\.js|\/vite\/deps\/|\/@fs\/|polyfills|webpack\/|\(webpack\)|vite\/dist/.test(file);

// Original source text for a project file (e.g. "src/app/foo.ts"), looked up in
// the source maps of the given scripts. Uses `sourcesContent`, which Angular dev
// builds include, so no file system access is needed.
const sourceIndex = new Map<string, string>(); // file → text
export async function findSource(file: string, scriptUrls: string[]): Promise<string | null> {
  const want = file.replace(/^\.?\//, '');
  if (!want) return null;
  const known = sourceIndex.get(want);
  if (known != null) return known;
  for (const url of scriptUrls) {
    if (isLibrary(url)) continue;
    const raw = (await loadMap(url))?.raw;
    if (!raw?.sourcesContent) continue;
    const contents = raw.sourcesContent;
    raw.sources.forEach((s, i) => {
      const text = contents[i];
      if (s == null || text == null) return;
      const clean = cleanSource(s, raw.sourceRoot);
      if (!sourceIndex.has(clean)) sourceIndex.set(clean, text);
    });
    const found = sourceIndex.get(want);
    if (found != null) return found;
  }
  for (const [k, v] of sourceIndex) if (k.endsWith(want) || want.endsWith(k)) return v;
  return null;
}

export function clearSourceCache(): void {
  cache.clear();
  sourceIndex.clear();
}

export async function resolve(url: string, line: number, col: number): Promise<Origin | null> {
  const map = await loadMap(url);
  if (!map) return null;
  map.lines ??= parseMappings(map.raw.mappings);
  const segs = map.lines[line - 1];
  if (!segs?.length) return null;
  let best: Segment | undefined;
  for (const s of segs) {
    if (s[0] <= col - 1) best = s; else break;
  }
  best ??= segs[0];
  if (!best) return null;
  const source = map.raw.sources[best[1]];
  if (source == null) return null;
  const name = best[4] >= 0 ? map.raw.names?.[best[4]] : undefined;
  const origin: Origin = { file: cleanSource(source, map.raw.sourceRoot), line: best[2] + 1, col: best[3] + 1 };
  if (name) origin.name = name;
  return origin;
}

// "    at Foo.bar (http://localhost:4200/main.js:10:5)" → frame object
const FRAME = /^\s*at\s+(?:(.*?)\s+\()?((?:https?|chrome-extension):\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/;
export function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const l of stack.split('\n')) {
    const m = FRAME.exec(l);
    if (m?.[2]) frames.push({ fn: m[1] ?? '', url: m[2], line: Number(m[3]), col: Number(m[4]) });
  }
  return frames;
}

// RxJS/HttpClient stacks are deep: the app frame is often 40+ frames down.
// Library frames are not resolved (no fetch), so a high limit is cheap.
export async function mapStack(stack: string, limit = 80): Promise<MappedFrame[]> {
  const frames = parseStack(stack).filter((f) => !f.url.startsWith('chrome-extension://')).slice(0, limit);
  return Promise.all(frames.map(async (f): Promise<MappedFrame> => {
    // Don't fetch maps for prebundled libraries (Vite deps): slow and often stale.
    const orig = isLibrary(f.url) ? null : await resolve(f.url, f.line, f.col).catch(() => null);
    const file = orig?.file ?? f.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
    return { ...f, orig, file, lib: isLibrary(orig?.file ?? f.url) };
  }));
}

// The first frame in the app's own code (not a library), if any.
export type AppFrame = MappedFrame & { orig: Origin };
export const isAppFrame = (f: MappedFrame): f is AppFrame => !f.lib && f.orig !== null;
