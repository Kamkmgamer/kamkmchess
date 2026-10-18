import { Chess } from 'chess.js';
import { BrowserUciEngine, downloadBrowserEngine } from '../engines/browser';

export const DEMO_MOVE_INTERVAL_MS = 250;
export const DEMO_REPLAY_DELAY_MS = 2000;

export function demoFrame(game: Chess) {
  const moves = game.history({ verbose: true });
  const turn = game.turn();
  const result = game.isCheckmate() ? `${turn === 'w' ? 'Black' : 'White'} wins by checkmate.`
    : game.isStalemate() ? 'Draw by stalemate.'
    : game.isThreefoldRepetition() ? 'Draw by repetition.'
    : game.isInsufficientMaterial() ? 'Draw by insufficient material.'
    : game.isDrawByFiftyMoves() ? 'Draw by the fifty-move rule.' : null;
  return { board: game.board(), move: moves.at(-1) ?? null, moves, turn, result, check: game.isCheck() };
}

function waitForMove(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Demo stopped.', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, Math.max(0, delay));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Leave the result visible briefly, then start another game until paused. */
export async function playDemoLoop(game: Chess, startingFen: string, signal: AbortSignal,
  onMove: (frame: ReturnType<typeof demoFrame>) => void, onReady: () => void): Promise<void> {
  if (new Chess(startingFen).isGameOver()) return;
  while (!signal.aborted) {
    await playDemoGame(game, startingFen, signal, onMove, onReady);
    await waitForMove(DEMO_REPLAY_DELAY_MS, signal);
    if (signal.aborted) return;
    game.load(startingFen);
    onMove(demoFrame(game));
  }
}

/** The demo owns its worker so pausing it never interrupts a playable match. */
export async function playDemoGame(game: Chess, startingFen: string, signal: AbortSignal,
  onMove: (frame: ReturnType<typeof demoFrame>) => void, onReady: () => void): Promise<void> {
  if (game.isGameOver() || signal.aborted) return;
  const source = await downloadBrowserEngine('stockfish-lite', undefined, signal);
  if (signal.aborted) return;
  const engine = new BrowserUciEngine(source);
  try {
    onReady();
    let nextMoveAt = performance.now() + DEMO_MOVE_INTERVAL_MS;
    while (!signal.aborted && !game.isGameOver()) {
      const result = await engine.search({ engineId: 'stockfish-lite', hashMb: 16, moveTimeMs: 100 }, {
        startingFen, moves: game.history({ verbose: true }).map(move => move.lan),
      }, signal);
      // Include search time in the cadence instead of adding 250 ms after it.
      await waitForMove(nextMoveAt - performance.now(), signal);
      if (signal.aborted) return;
      nextMoveAt = performance.now() + DEMO_MOVE_INTERVAL_MS;
      game.move(result.move);
      onMove(demoFrame(game));
    }
  } finally { engine.close(); }
}
