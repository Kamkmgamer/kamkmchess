import { parseUciEvaluation } from './uci-score.js';
import type { EngineEvaluation } from './uci-score.js';

export type BrowserEngineId = 'stockfish-lite' | 'stockfish-full';
export interface BrowserEngineSettings { engineId: BrowserEngineId; hashMb: number; moveTimeMs: number }
export interface EngineProgress { loaded: number; total: number; phase: 'downloading' | 'starting' }
export const ENGINE_VERSION = '19.0.1';
const CACHE_NAME = `kamkmchess.engines.${ENGINE_VERSION}`;
export const BROWSER_ENGINES = {
  'stockfish-lite': { name: 'Stockfish 19 Lite', file: 'stockfish-19-lite-single', downloadMb: 2, description: 'Small download. Recommended for laptops, phones and everyday play.' },
  'stockfish-full': { name: 'Stockfish 19', file: 'stockfish-19-single', downloadMb: 100, description: 'Full evaluation network. A larger download for stronger analysis on computers with more memory.' },
} as const;
interface EngineAssets { scriptUrl: string; wasmUrl: string; cached: boolean }
const assets = new Map<BrowserEngineId, EngineAssets>();
const workers = new Map<BrowserEngineId, BrowserUciEngine>();

export function supportsBrowserEngines(): boolean { return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined'; }

export function engineAssetUrls(id: BrowserEngineId): string[] {
  const base = `${import.meta.env.BASE_URL}engines/${ENGINE_VERSION}/${BROWSER_ENGINES[id].file}`;
  return [`${base}.js`, `${base}.wasm`];
}

async function engineCache(): Promise<Cache | null> {
  try { return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME); }
  catch { return null; }
}

export async function isEngineDownloaded(id: BrowserEngineId): Promise<boolean> {
  if (assets.has(id)) return true;
  const cache = await engineCache();
  try { return cache !== null && (await Promise.all(engineAssetUrls(id).map(url => cache.match(url)))).every(Boolean); }
  catch { return false; }
}

/** Only same-origin, version-pinned build assets become executable Workers. */
export async function downloadBrowserEngine(id: BrowserEngineId, onProgress?: (progress: EngineProgress) => void, signal?: AbortSignal): Promise<EngineAssets> {
  if (!supportsBrowserEngines()) throw new Error('This browser cannot run WebAssembly chess engines. Use a current version of Chrome, Edge, Firefox or Safari.');
  if (signal?.aborted) throw new DOMException('Engine download stopped.', 'AbortError');
  const existing = assets.get(id);
  if (existing) return existing;
  const cache = await engineCache();
  const blobs: Blob[] = [];
  let loaded = 0;
  let total = BROWSER_ENGINES[id].downloadMb * 1_000_000;
  let cached = cache !== null;
  for (const [index, url] of engineAssetUrls(id).entries()) {
    let response = await cache?.match(url);
    const fromCache = response !== undefined;
    if (!response) response = await fetch(url, { signal: signal ?? null, credentials: 'same-origin' });
    if (!response.ok || !response.body) throw new Error('The engine download failed. Check your connection and try again.');
    const length = Number(response.headers.get('Content-Length'));
    if (index === 1 && length > 0) total = loaded + length;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Engine download stopped.', 'AbortError');
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(new Uint8Array(chunk.value)); loaded += chunk.value.byteLength;
        onProgress?.({ phase: 'downloading', loaded, total: Math.max(total, loaded) });
      }
    } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
    if (signal?.aborted) throw new DOMException('Engine download stopped.', 'AbortError');
    const blob = new Blob(chunks, { type: index === 0 ? 'text/javascript' : 'application/wasm' });
    // A missing asset on an SPA host may return index.html with HTTP 200.
    if (index === 1) {
      const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (header.join(',') !== '0,97,115,109') throw new Error('The engine files are unavailable. Reload the app or try again after it is updated.');
    } else if (!(await blob.slice(0, 500).text()).includes('Stockfish.js')) throw new Error('The engine script is unavailable. Reload the app and retry.');
    if (cache && !fromCache) {
      try { await cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type, 'Content-Length': String(blob.size) } })); }
      catch { cached = false; }
    }
    blobs.push(blob);
  }
  const ready = { scriptUrl: URL.createObjectURL(blobs[0]!), wasmUrl: URL.createObjectURL(blobs[1]!), cached };
  const competing = assets.get(id);
  if (competing) { URL.revokeObjectURL(ready.scriptUrl); URL.revokeObjectURL(ready.wasmUrl); return competing; }
  assets.set(id, ready);
  return ready;
}

export interface BrowserEngineResult { move: string; engineName: string; elapsedMs: number }

/** A dedicated Worker keeps search off the UI thread. Searches are serialized per engine build. */
export class BrowserUciEngine {
  private readonly worker: Worker;
  private initialized = false;
  private busy = false;
  private closed = false;
  private name = 'Stockfish';
  private listener: ((line: string) => void) | null = null;
  private failure: ((error: Error) => void) | null = null;

  constructor(source: EngineAssets, private readonly createWorker: (url: string) => Worker = url => new Worker(url)) {
    this.worker = this.createWorker(`${source.scriptUrl}#${encodeURIComponent(source.wasmUrl)}`);
    this.worker.onmessage = event => {
      if (typeof event.data !== 'string') return;
      for (const line of event.data.split('\n')) {
        if (line.startsWith('id name ')) this.name = line.slice(8, 200);
        this.listener?.(line.trim());
      }
    };
    this.worker.onerror = event => { event.preventDefault(); this.failure?.(new Error('The browser could not start the engine. Free some memory, select Stockfish Lite and retry.')); this.close(); };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.worker.terminate();
    const failure = this.failure; this.failure = null;
    failure?.(new DOMException('Engine stopped.', 'AbortError'));
  }

  private exchange(command: string, matches: (line: string) => boolean, timeoutMs: number, signal?: AbortSignal, onLine?: (line: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.closed || signal?.aborted) { reject(new DOMException('Engine stopped.', 'AbortError')); return; }
      const finish = (error: Error | null, line = '') => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.listener = null; this.failure = null;
        if (error) { this.close(); reject(error); } else resolve(line);
      };
      const abort = () => finish(new DOMException('Engine stopped.', 'AbortError'));
      const timer = globalThis.setTimeout(() => finish(new Error('The browser engine took too long. Select Stockfish Lite or retry.')), timeoutMs);
      this.listener = line => { onLine?.(line); if (matches(line)) finish(null, line); };
      this.failure = error => finish(error);
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.postMessage(command);
    });
  }

  async search(settings: BrowserEngineSettings, position: { startingFen: string; moves: readonly string[] }, signal?: AbortSignal): Promise<BrowserEngineResult> {
    return this.run(settings, position, signal);
  }

  async analyze(settings: BrowserEngineSettings, position: { startingFen: string; moves: readonly string[] }, onEvaluation: (evaluation: EngineEvaluation) => void, signal?: AbortSignal): Promise<void> {
    await this.run(settings, position, signal, onEvaluation);
  }

  private async run(settings: BrowserEngineSettings, position: { startingFen: string; moves: readonly string[] }, signal?: AbortSignal, onEvaluation?: (evaluation: EngineEvaluation) => void): Promise<BrowserEngineResult> {
    if (this.busy) throw new Error('This engine is still finishing another turn. Stop that turn and retry.');
    this.busy = true;
    const start = performance.now();
    try {
      if (!this.initialized) { await this.exchange('uci', line => line === 'uciok', 30_000, signal); this.initialized = true; }
      this.worker.postMessage(`setoption name Hash value ${settings.hashMb}`);
      this.worker.postMessage('ucinewgame');
      await this.exchange('isready', line => line === 'readyok', 10_000, signal);
      this.worker.postMessage(`position fen ${position.startingFen}${position.moves.length ? ` moves ${position.moves.join(' ')}` : ''}`);
      const whiteToMove = (position.startingFen.split(' ')[1] === 'w') === (position.moves.length % 2 === 0);
      let evaluated = false;
      const best = await this.exchange(`go movetime ${settings.moveTimeMs}`, line => line.startsWith('bestmove '), settings.moveTimeMs + 10_000, signal, line => {
        if (!onEvaluation) return;
        const evaluation = parseUciEvaluation(line, whiteToMove);
        if (evaluation) { evaluated = true; onEvaluation(evaluation); }
      });
      const move = best.split(/\s+/)[1] ?? '';
      if (onEvaluation ? !evaluated : !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new Error(onEvaluation ? 'The engine returned no evaluation. Retry analysis.' : 'The engine returned no playable move. Retry this turn.');
      return { move, engineName: this.name, elapsedMs: Math.round(performance.now() - start) };
    } finally { this.busy = false; }
  }

  get stopped(): boolean { return this.closed; }
}

export async function searchBrowserEngine(settings: BrowserEngineSettings, position: { startingFen: string; moves: readonly string[] }, signal?: AbortSignal,
  onProgress?: (progress: EngineProgress) => void): Promise<BrowserEngineResult> {
  const source = await downloadBrowserEngine(settings.engineId, onProgress, signal);
  let worker = workers.get(settings.engineId);
  if (!worker || worker.stopped) { worker = new BrowserUciEngine(source); workers.set(settings.engineId, worker); }
  onProgress?.({ phase: 'starting', loaded: 1, total: 1 });
  return worker.search(settings, position, signal);
}

export function stopBrowserEngines(): void { for (const worker of workers.values()) worker.close(); workers.clear(); }
