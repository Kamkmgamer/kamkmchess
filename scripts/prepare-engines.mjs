import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('stockfish/package.json'));
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
if (manifest.version !== '19.0.1') throw new Error('Review browser engine assets before changing the pinned Stockfish version.');
const target = new URL(`../public/engines/${manifest.version}/`, import.meta.url);
await mkdir(target, { recursive: true });
for (const engine of ['stockfish-19-lite-single', 'stockfish-19-single']) {
  for (const extension of ['js', 'wasm']) await copyFile(join(packageRoot, 'bin', `${engine}.${extension}`), new URL(`${engine}.${extension}`, target));
}
console.log('Browser Stockfish assets ready. Engines download only when selected in the app.');
