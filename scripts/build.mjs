import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const isWatch = process.argv.includes('--watch');
const distDir = path.resolve('dist');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyStaticFiles() {
  copyFile('manifest.json', path.join(distDir, 'manifest.json'));
  copyFile('src/devtools/devtools.html', path.join(distDir, 'devtools.html'));
  copyFile('src/panel/panel.html', path.join(distDir, 'panel/panel.html'));
  copyFile('src/panel/panel.css', path.join(distDir, 'panel/panel.css'));

  const assetsDir = path.resolve('src/assets');
  if (fs.existsSync(assetsDir)) {
    for (const file of fs.readdirSync(assetsDir)) {
      copyFile(path.join(assetsDir, file), path.join(distDir, 'assets', file));
    }
  }
}

async function build() {
  ensureDir(distDir);
  ensureDir(path.join(distDir, 'panel'));
  copyStaticFiles();

  const entryPoints = [
    { in: 'src/devtools/devtools.ts', out: 'devtools' },
    { in: 'src/panel/panel.ts', out: 'panel/panel' },
    { in: 'src/content/inspector.ts', out: 'content' },
    { in: 'src/background/service-worker.ts', out: 'background' }
  ];

  const buildOptions = {
    entryPoints,
    bundle: true,
    outdir: distDir,
    target: ['es2022'],
    format: 'iife',
    sourcemap: true,
    logLevel: 'info'
  };

  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('⚡ Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log('✓ Build completed successfully.');
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
