import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chess } from 'chess.js';
import { build } from 'vite';

// Bundle the actual TypeScript entry point, without a development server or UI.
const outDir = resolve('.scratch/position-check-benchmark');
await build({
  configFile: false,
  logLevel: 'silent',
  build: { ssr: resolve('src/rules/index.ts'), outDir, emptyOutDir: false },
});
const { parsePosition, createRepetitionLedger, observeEndingFacts, legalMoves } = await import(pathToFileURL(resolve(outDir, 'index.js')).href);
const maximum = process.argv.find((arg) => arg.startsWith('--max-ms='));
const maxMs = maximum ? Number(maximum.slice('--max-ms='.length)) : Infinity;
if (!(maxMs > 0)) throw new Error('--max-ms must be positive.');

/** @type {Array<[string, string]>} */
const positions = [
  ['Start', ''],
  ['Ruy Lopez, move 3', 'e4 e5 Nf3 Nc6 Bb5'],
  ['Ruy Lopez, move 15', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 Nbd2 Bb7 Bc2 Re8 Nf1 Bf8 Ng3 g6 a4 c5'],
  ['Sicilian, move 15', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7 g4 b5 g5 b4 Ne2 Nh5 Ng3 Nxg3 hxg3 a5'],
  ['Nimzo-Indian, move 15', 'd4 Nf6 c4 e6 Nc3 Bb4 f3 d5 a3 Bxc3 bxc3 c5 cxd5 exd5 e3 c4 Ne2 Nc6 g4 O-O Bg2 Na5 O-O Nb3 Ra2 b5 Ng3 a5 g5 Ne8'],
];

for (const [name, line] of positions) {
  const chess = new Chess();
  for (const move of line.split(' ').filter(Boolean)) chess.move(move);
  const times = [];
  for (let sample = 0; sample < 101; sample += 1) {
    const before = performance.now();
    const position = parsePosition(chess.fen());
    const ledger = createRepetitionLedger(position);
    const result = observeEndingFacts(position, ledger);
    const moves = legalMoves(position);
    times.push(performance.now() - before);
    if (!result.hasLegalMoves || result.insufficientMaterial || moves.length === 0) throw new Error(`${name}: unexpected ending`);
  }
  const first = times.shift();
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const minimum = times[0];
  const maximum = times.at(-1);
  if (first === undefined || median === undefined || minimum === undefined || maximum === undefined) throw new Error('No benchmark samples.');
  console.log(`${name}: first ${first.toFixed(3)} ms; warmed median ${median.toFixed(3)} ms, range ${minimum.toFixed(3)}-${maximum.toFixed(3)} ms`);
  if (median > maxMs) process.exitCode = 1;
}

if (process.argv.includes('--memory')) {
  if (!globalThis.gc) throw new Error('Use node --expose-gc scripts/benchmark-position-check.mjs --memory');
  const fen = new Chess().fen();
  const batch = () => {
    for (let index = 0; index < 5_000; index += 1) {
      const position = parsePosition(fen);
      observeEndingFacts(position, createRepetitionLedger(position));
      legalMoves(position);
    }
  };
  batch();
  globalThis.gc();
  const baseline = process.memoryUsage().heapUsed;
  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    batch();
    globalThis.gc();
    samples.push(process.memoryUsage().heapUsed);
  }
  /** @param {number} bytes */
  const mib = bytes => (bytes / 1_048_576).toFixed(2);
  console.log(`Heap after warmup and GC: ${mib(baseline)} MiB; after each 5,000 fresh checks: ${samples.map(mib).join(', ')} MiB`);
  if ((samples.at(-1) ?? baseline) - baseline > 8 * 1_048_576) throw new Error('Rules heap grew by more than 8 MiB after GC.');
}
