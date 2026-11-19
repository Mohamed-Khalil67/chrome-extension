// Build the extension into dist/: one bundle per entry point, plus the static files.
// Usage: node scripts/build.mjs [--watch]
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const options = {
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background/index.ts',
    'content/hook.main': 'src/content/hook.main.ts',
    'content/isolated': 'src/content/isolated.ts',
    'panel/main': 'src/panel/main.ts',
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'chrome125',
  sourcemap: 'linked',
  logLevel: 'info',
};
// Content scripts are classic scripts, not modules.
const classic = { ...options, entryPoints: { 'content/hook.main': options.entryPoints['content/hook.main'], 'content/isolated': options.entryPoints['content/isolated'] }, format: 'iife' };
const modules = { ...options, entryPoints: { background: options.entryPoints.background, 'panel/main': options.entryPoints['panel/main'] } };

function copyStatic() {
  fs.cpSync(path.join(root, 'static'), out, { recursive: true });
}

fs.rmSync(out, { recursive: true, force: true });
copyStatic();
if (watch) {
  for (const o of [classic, modules]) await (await context(o)).watch();
  fs.watch(path.join(root, 'static'), { recursive: true }, () => { copyStatic(); console.log('static copied'); });
  console.log('watching…');
} else {
  await Promise.all([build(classic), build(modules)]);
}
