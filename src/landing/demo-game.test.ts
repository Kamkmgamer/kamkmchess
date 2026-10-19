import { Chess, DEFAULT_POSITION } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ search: vi.fn(), close: vi.fn(), download: vi.fn() }));
vi.mock('../engines/browser', () => ({
  downloadBrowserEngine: engine.download,
  BrowserUciEngine: class { search = engine.search; close = engine.close; },
}));
import { demoFrame, playDemoGame, playDemoLoop } from './demo-game';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); engine.download.mockResolvedValue({}); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe('automatic demo game', () => {
  it('plays a legal game at 250 ms intervals and stops at checkmate', async () => {
    for (const move of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) engine.search.mockResolvedValueOnce({ move });
    const game = new Chess();
    const onMove = vi.fn();
    const finished = playDemoGame(game, DEFAULT_POSITION, new AbortController().signal, onMove, vi.fn());
    await vi.advanceTimersByTimeAsync(249);
    expect(onMove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(game.history()).toEqual(['f3']);
    await vi.advanceTimersByTimeAsync(750);
    await finished;
    expect(game.isCheckmate()).toBe(true);
    expect(onMove).toHaveBeenCalledTimes(4);
    expect(demoFrame(game).result).toBe('Black wins by checkmate.');
    expect(engine.search.mock.calls[3]?.[1]).toEqual({ startingFen: DEFAULT_POSITION, moves: ['f2f3', 'e7e5', 'g2g4'] });
    expect(engine.download).toHaveBeenCalledWith('stockfish-lite', undefined, expect.any(AbortSignal));
    expect(engine.close).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending move when paused and closes only its own worker', async () => {
    engine.search.mockResolvedValue({ move: 'e2e4' });
    const game = new Chess();
    const controller = new AbortController();
    const onMove = vi.fn();
    const finished = playDemoGame(game, DEFAULT_POSITION, controller.signal, onMove, vi.fn());
    const rejected = expect(finished).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(500);
    expect(game.history()).toEqual([]);
    expect(onMove).not.toHaveBeenCalled();
    expect(engine.close).toHaveBeenCalledTimes(1);
  });

  it('does not load an engine for an already finished position', async () => {
    const game = new Chess('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
    await playDemoGame(game, game.fen(), new AbortController().signal, vi.fn(), vi.fn());
    expect(engine.download).not.toHaveBeenCalled();
  });

  it('holds the result for two seconds and automatically plays another game', async () => {
    for (const move of ['f2f3', 'e7e5', 'g2g4', 'd8h4', 'e2e4']) engine.search.mockResolvedValueOnce({ move });
    const game = new Chess();
    const controller = new AbortController();
    const onMove = vi.fn();
    const finished = playDemoLoop(game, DEFAULT_POSITION, controller.signal, onMove, vi.fn());
    const rejected = expect(finished).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(2999);
    expect(game.isCheckmate()).toBe(true);
    expect(engine.search).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(game.fen()).toBe(DEFAULT_POSITION);
    expect(onMove.mock.lastCall?.[0].moves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(game.history()).toEqual(['e4']);
    expect(engine.search.mock.calls[4]?.[1]).toEqual({ startingFen: DEFAULT_POSITION, moves: [] });
    controller.abort();
    await rejected;
  });

  it('cancels automatic replay when paused during the result', async () => {
    for (const move of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) engine.search.mockResolvedValueOnce({ move });
    const game = new Chess();
    const controller = new AbortController();
    const finished = playDemoLoop(game, DEFAULT_POSITION, controller.signal, vi.fn(), vi.fn());
    const rejected = expect(finished).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1500);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(3000);
    expect(game.isCheckmate()).toBe(true);
    expect(engine.search).toHaveBeenCalledTimes(4);
    expect(engine.close).toHaveBeenCalledTimes(1);
  });
});
