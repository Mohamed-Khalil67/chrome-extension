import fs from 'node:fs';
import path from 'node:path';

// Valid 1x1 blue PNG
const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPifAQAE+wH97d5+WAAAAABJRU5ErkJggg==';
const buffer = Buffer.from(base64Png, 'base64');

const assetsDir = path.resolve('src/assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

fs.writeFileSync(path.join(assetsDir, 'icon16.png'), buffer);
fs.writeFileSync(path.join(assetsDir, 'icon48.png'), buffer);
fs.writeFileSync(path.join(assetsDir, 'icon128.png'), buffer);

console.log('Icons generated successfully.');
