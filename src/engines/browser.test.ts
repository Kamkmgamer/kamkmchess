import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  commands: string[] = [];
  terminated = false;
  respondToSearch = true;
  constructor(readonly url: string) { FakeWorker.instances.push(this); }
  emit(line: string) { this.onmessage?.(new MessageEvent('message', { data: line })); }
  postMessage(command: string) {
    this.commands.push(command);
    queueMicrotask(() => {
      if (command === 'uci') { this.emit('id name Stockfish fixture'); this.emit('uciok'); }
      if (command === 'isready') this.emit('readyok');
      if (command.startsWith('go ') && this.respondToSearch) this.emit('bestmove e2e4 ponder e7e5');
    });
  }
  terminate() { this.terminated = true; }
}
const settings = { engineId: 'stockfish-lite' as const, hashMb: 16, moveTimeMs: 250 };
const position = { startingFen: '8/8/8/8/8/8/K7/7k w - - 0 1', moves: ['a2a3'] };

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); FakeWorker.instances = []; });

describe('browser UCI workers', () => {
  it('handshakes before search, preserves repetition history, and reuses the same worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { BrowserUciEngine } = await import('./browser.js');
    const engine = new BrowserUciEngine({ scriptUrl: 'blob:script', wasmUrl: 'blob:wasm', cached: true });
    expect(await engine.search(settings, position)).toMatchObject({ move: 'e2e4', engineName: 'Stockfish fixture' });
    await engine.search({ ...settings, hashMb: 32 }, position);
    const worker = FakeWorker.instances[0]!;
    expect(worker.commands.filter(command => command === 'uci')).toHaveLength(1);
    expect(worker.commands).toContain(`position fen ${position.startingFen} moves a2a3`);
    expect(worker.commands).toContain('setoption name Hash value 32');
    expect(worker.commands.filter(command => command === 'go movetime 250')).toHaveLength(2);
    engine.close(); expect(worker.terminated).toBe(true);
  });

  it('terminates a stopped worker and rejects its pending turn, including late replies', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { BrowserUciEngine } = await import('./browser.js');
    const engine = new BrowserUciEngine({ scriptUrl: 'blob:script', wasmUrl: 'blob:wasm', cached: false });
    const worker = FakeWorker.instances[0]!; worker.respondToSearch = false;
    const abort = new AbortController();
    const pending = engine.search(settings, position, abort.signal);
    await vi.waitFor(() => expect(worker.commands).toContain('go movetime 250'));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); abort.abort(); await rejected;
    worker.emit('bestmove e2e4');
    expect(worker.terminated).toBe(true); expect(engine.stopped).toBe(true);
  });

  it('surfaces browser failures and rejects overlapping searches', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { BrowserUciEngine } = await import('./browser.js');
    const engine = new BrowserUciEngine({ scriptUrl: 'blob:script', wasmUrl: 'blob:wasm', cached: false });
    const worker = FakeWorker.instances[0]!; worker.respondToSearch = false;
    const pending = engine.search(settings, position);
    await expect(engine.search(settings, position)).rejects.toThrow('another turn');
    await vi.waitFor(() => expect(worker.commands).toContain('go movetime 250'));
    const rejected = expect(pending).rejects.toThrow('Free some memory');
    worker.onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    await rejected; expect(worker.terminated).toBe(true);
  });

  it('loads pinned assets once and reuses their persistent cache after reload', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const saved = new Map<string, Response>();
    vi.stubGlobal('caches', { open: async () => ({ match: async (url: string) => saved.get(url)?.clone(), put: async (url: string, response: Response) => { saved.set(url, response); } }) });
    const fetch = vi.fn(async (url: string) => url.endsWith('.js') ? new Response('/*! Stockfish.js */', { headers: { 'Content-Length': '20' } })
      : new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { headers: { 'Content-Length': '8' } }));
    vi.stubGlobal('fetch', fetch);
    let browser = await import('./browser.js');
    expect(await browser.isEngineDownloaded('stockfish-lite')).toBe(false);
    expect((await browser.downloadBrowserEngine('stockfish-lite')).cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.resetModules(); browser = await import('./browser.js');
    expect(await browser.isEngineDownloaded('stockfish-lite')).toBe(true);
    await browser.downloadBrowserEngine('stockfish-lite');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing WASM asset served as SPA HTML instead of executing it', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('.js') ? '/*! Stockfish.js */' : '<!doctype html>')));
    const { downloadBrowserEngine } = await import('./browser.js');
    await expect(downloadBrowserEngine('stockfish-lite')).rejects.toThrow('engine files are unavailable');
  });
});
