import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureReplay } from './replay.js';
import { recapCheckpoint } from '../../tests/support/recap.js';

const mock = vi.hoisted(() => ({ downloaded: vi.fn(), download: vi.fn(), search: vi.fn(), close: vi.fn(), load: vi.fn(), save: vi.fn() }));
vi.mock('../engines/browser.js', () => ({
  ENGINE_VERSION: '19.0.1', BROWSER_ENGINES: { 'stockfish-full': { name: 'Full' }, 'stockfish-lite': { name: 'Lite' } },
  isEngineDownloaded: mock.downloaded, downloadBrowserEngine: mock.download,
  BrowserUciEngine: class {
    constructor(private readonly assets: { id: string }) {}
    review(position: unknown, options: unknown) { return mock.search(position, options, this.assets.id); }
    close() { mock.close(this.assets.id); }
  },
}));
vi.mock('./store.js', () => ({ loadReview: mock.load, saveReview: mock.save }));
import { reviewGame } from './review.js';

beforeEach(() => {
  mock.downloaded.mockResolvedValue(false); mock.download.mockImplementation(async id => ({ id }));
  mock.load.mockResolvedValue([]); mock.save.mockResolvedValue(undefined);
  mock.search.mockImplementation(async (position: { moves: string[] }, options: { multiPv: number; searchMove?: string }) => {
    const moves = position.moves.length % 2 ? ['e7e5', 'c7c5'] : ['e2e4', 'd2d4'];
    return { engineName: 'Stockfish fixture', bestMove: options.searchMove ?? moves[0],
      lines: (options.searchMove ? [options.searchMove] : moves.slice(0, options.multiPv)).map((uci, index) => ({
        depth: 14, nodes: 100_000, multipv: index + 1, bound: 'exact', score: { kind: 'cp', value: 20 },
        wdl: { win: 100, draw: 800, loss: 100 }, pv: [uci],
      })),
    };
  });
});
afterEach(() => vi.resetAllMocks());

function replay() { return captureReplay(recapCheckpoint(['e4', 'e5']), { white: 'White', black: 'Black' }); }
describe('game review worker ownership and recovery', () => {
  it('uses only Lite when full is absent, preserves prefixes, and closes its own worker', async () => {
    const game = replay();
    const result = await reviewGame(game, new AbortController().signal, vi.fn());
    expect(result.moves.map(move => move.grade)).toEqual(['best', 'best']);
    expect(mock.download.mock.calls.map(call => call[0])).toEqual(['stockfish-lite']);
    expect(mock.search.mock.calls.map(call => call[0].moves)).toEqual([[], ['e2e4']]);
    expect(mock.close).toHaveBeenCalledWith('stockfish-lite'); expect(mock.save).toHaveBeenCalledTimes(2);
  });
  it('restarts a failed full-engine job with a separate Lite cache identity', async () => {
    mock.downloaded.mockResolvedValue(true); mock.search.mockRejectedValueOnce(new Error('Out of memory'));
    const result = await reviewGame(replay(), new AbortController().signal, vi.fn());
    expect(result.engineId).toBe('stockfish-lite');
    expect(mock.download.mock.calls.map(call => call[0])).toEqual(['stockfish-full', 'stockfish-lite']);
    expect(mock.load.mock.calls[0]![0]).not.toBe(mock.load.mock.calls[1]![0]);
    expect(mock.close.mock.calls.map(call => call[0])).toEqual(['stockfish-full', 'stockfish-lite']);
  });
  it('uses Lite directly in faster mode even when the full engine is installed', async () => {
    mock.downloaded.mockResolvedValue(true);
    const result = await reviewGame(replay(), new AbortController().signal, vi.fn(), true);
    expect(result.engineId).toBe('stockfish-lite');
    expect(mock.download.mock.calls.map(call => call[0])).toEqual(['stockfish-lite']);
    expect(mock.downloaded).not.toHaveBeenCalled();
    expect(mock.search.mock.calls[0]![1]).toMatchObject({ nodes: 20_000 });
  });
  it('resumes completed positions without another worker or engine download', async () => {
    const initial = await reviewGame(replay(), new AbortController().signal, vi.fn());
    mock.load.mockResolvedValue(initial.moves); mock.search.mockClear(); mock.download.mockClear();
    const resumed = await reviewGame(replay(), new AbortController().signal, vi.fn());
    expect(resumed.moves).toEqual(initial.moves); expect(mock.search).not.toHaveBeenCalled(); expect(mock.download).not.toHaveBeenCalled();
  });
  it('never falls back or publishes completion after cancellation', async () => {
    mock.downloaded.mockResolvedValue(true);
    const abort = new AbortController();
    mock.search.mockImplementationOnce(async () => { abort.abort(); throw new DOMException('Stopped', 'AbortError'); });
    const progress = vi.fn();
    await expect(reviewGame(replay(), abort.signal, progress)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.download).toHaveBeenCalledTimes(1); expect(mock.save).not.toHaveBeenCalled();
    expect(progress.mock.calls.every(call => call[0].completed === 0)).toBe(true);
  });
});
