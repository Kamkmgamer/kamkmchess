import { BrowserUciEngine, downloadBrowserEngine, isEngineDownloaded } from './browser.js';
import type { BrowserEngineId, EngineProgress } from './browser.js';
import type { EngineEvaluation } from './uci-score.js';

/** Analysis owns its worker. Cancelling it cannot stop or occupy an opponent's engine. */
export class PositionEvaluator {
  private worker: BrowserUciEngine | null = null;
  private engineId: BrowserEngineId | null = null;
  private fullFailed = false;

  close(): void { this.worker?.close(); this.worker = null; }

  async evaluate(position: { startingFen: string; moves: readonly string[] }, signal: AbortSignal,
    onEvaluation: (evaluation: EngineEvaluation, engineId: BrowserEngineId) => void,
    onProgress: (engineId: BrowserEngineId, progress?: EngineProgress) => void): Promise<void> {
    const preferred = !this.fullFailed && await isEngineDownloaded('stockfish-full') ? 'stockfish-full' : 'stockfish-lite';
    const run = async (id: BrowserEngineId) => {
      if (signal.aborted) throw new DOMException('Analysis stopped.', 'AbortError');
      onProgress(id);
      const source = await downloadBrowserEngine(id, progress => { if (!signal.aborted) onProgress(id, progress); }, signal);
      if (signal.aborted) throw new DOMException('Analysis stopped.', 'AbortError');
      if (!this.worker || this.worker.stopped || this.engineId !== id) {
        this.close(); this.worker = new BrowserUciEngine(source); this.engineId = id;
      }
      await this.worker.analyze({ engineId: id, hashMb: 16, moveTimeMs: 800 }, position,
        evaluation => { if (!signal.aborted) onEvaluation(evaluation, id); }, signal);
    };
    try { await run(preferred); }
    catch (error) {
      if (signal.aborted || preferred === 'stockfish-lite') throw error;
      this.fullFailed = true; this.close(); await run('stockfish-lite');
    }
  }
}
