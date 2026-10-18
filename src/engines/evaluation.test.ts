import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ downloaded: vi.fn(), download: vi.fn(), analyze: vi.fn(), close: vi.fn() }));
vi.mock('./browser.js', () => ({
  isEngineDownloaded: mock.downloaded,
  downloadBrowserEngine: mock.download,
  BrowserUciEngine: class { stopped = false; analyze = mock.analyze; close = mock.close; },
}));
import { PositionEvaluator } from './evaluation.js';
const position = { startingFen: 'start', moves: ['e2e4'] };

beforeEach(() => { mock.downloaded.mockResolvedValue(false); mock.download.mockResolvedValue({}); mock.analyze.mockResolvedValue(undefined); });
afterEach(() => vi.resetAllMocks());

describe('spectator engine selection', () => {
  it('downloads only Lite when the full engine is absent', async () => {
    const evaluator = new PositionEvaluator();
    await evaluator.evaluate(position, new AbortController().signal, vi.fn(), vi.fn());
    expect(mock.download.mock.calls.map(call => call[0])).toEqual(['stockfish-lite']);
    expect(mock.analyze.mock.calls[0]?.[1]).toBe(position);
    evaluator.close();
  });
  it('prefers a downloaded full engine and reuses its analysis worker', async () => {
    mock.downloaded.mockResolvedValue(true);
    const evaluator = new PositionEvaluator();
    await evaluator.evaluate(position, new AbortController().signal, vi.fn(), vi.fn());
    await evaluator.evaluate(position, new AbortController().signal, vi.fn(), vi.fn());
    expect(mock.download.mock.calls.map(call => call[0])).toEqual(['stockfish-full', 'stockfish-full']);
    expect(mock.close).not.toHaveBeenCalled();
    evaluator.close(); expect(mock.close).toHaveBeenCalledTimes(1);
  });
  it('falls back to Lite after full-engine failure without retrying full on every move', async () => {
    mock.downloaded.mockResolvedValue(true);
    mock.analyze.mockRejectedValueOnce(new Error('Out of memory'));
    const evaluator = new PositionEvaluator();
    await evaluator.evaluate(position, new AbortController().signal, vi.fn(), vi.fn());
    await evaluator.evaluate(position, new AbortController().signal, vi.fn(), vi.fn());
    expect(mock.download.mock.calls.map(call => call[0])).toEqual(['stockfish-full', 'stockfish-lite', 'stockfish-lite']);
    evaluator.close();
  });
  it('does not fall back or publish old scores after cancellation', async () => {
    mock.downloaded.mockResolvedValue(true);
    const controller = new AbortController();
    const onEvaluation = vi.fn();
    mock.analyze.mockImplementationOnce(async (_settings, _position, publish) => {
      controller.abort(); publish({ depth: 1, score: { kind: 'cp', value: 20 } });
      throw new DOMException('Stopped', 'AbortError');
    });
    const evaluator = new PositionEvaluator();
    await expect(evaluator.evaluate(position, controller.signal, onEvaluation, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    expect(onEvaluation).not.toHaveBeenCalled();
    expect(mock.download).toHaveBeenCalledTimes(1);
    evaluator.close();
  });
});
