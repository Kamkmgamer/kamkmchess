/**
 * The browser engine preparation (KHA-77).
 *
 * The fallback opponent is the browser Stockfish 19 Lite. The preparation
 * downloads the pinned engine build and warms it up, so the ten-second search
 * window is not spent on a download.
 *
 * The rules this module keeps:
 *
 * - The preparation never blocks an agent search. A failure is reported to
 *   the caller, and the caller decides whether the fallback is still
 *   possible.
 * - The engine build is pinned by the offline engine module. The preparation
 *   never fetches an engine from an unknown origin.
 * - The preparation is idempotent. A second call after a successful
 *   preparation does nothing.
 */
import { downloadBrowserEngine, supportsBrowserEngines } from '../engines/browser';
import type { BrowserEngineId, EngineProgress } from '../engines/browser';

/** The preparation of the browser engine. */
export interface OnlineEnginePreparation {
  /** Prepares the engine. It is idempotent. */
  prepare(): Promise<void>;
  /** True once the engine is prepared. */
  readonly ready: boolean;
  /** The last progress the preparation reported. */
  readonly progress: EngineProgress | null;
}

export interface OnlineEnginePreparationOptions {
  /** The engine build. The fallback always uses Stockfish 19 Lite. */
  readonly engineId?: BrowserEngineId;
  /** Receives the download progress. */
  readonly onProgress?: (progress: EngineProgress) => void;
}

/**
 * Creates the browser engine preparation.
 *
 * The preparation is browser-owned: the engine runs in this browser and the
 * service never sees it.
 */
export function createBrowserEnginePreparation(options: OnlineEnginePreparationOptions = {}): OnlineEnginePreparation {
  const engineId = options.engineId ?? 'stockfish-lite';
  let ready = false;
  let progress: EngineProgress | null = null;
  let pending: Promise<void> | null = null;

  return {
    get ready() {
      return ready;
    },
    get progress() {
      return progress;
    },
    prepare() {
      if (ready) return Promise.resolve();
      if (pending) return pending;
      pending = (async () => {
        if (!supportsBrowserEngines()) {
          throw new Error('This browser cannot run the chess engine.');
        }
        await downloadBrowserEngine(engineId, next => {
          progress = next;
          options.onProgress?.(next);
        });
        ready = true;
      })().catch((error: unknown) => {
        // A failed preparation is retried by the next attempt.
        pending = null;
        throw error instanceof Error ? error : new Error('The engine could not be prepared.');
      });
      return pending;
    },
  };
}
