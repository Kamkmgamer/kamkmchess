import {
  applyCoordinateMove, createRepetitionLedger, observeEndingFacts, parsePosition, recordPosition,
} from '../rules/index.js';
import type { CoordinateMove, Position, RepetitionLedger } from '../rules/index.js';
import { BrowserUciEngine, downloadBrowserEngine } from '../engines/browser';

export const DEMO_MOVE_INTERVAL_MS = 250;
export const DEMO_REPLAY_DELAY_MS = 2000;
export const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** One display move of the demo: SAN with the color and fullmove number that played it. */
export interface DemoMove {
  readonly san: string;
  readonly color: 'w' | 'b';
  readonly number: string;
}

/** What the landing preview shows for one position of the demo game. */
export interface DemoFrame {
  readonly position: Position;
  readonly moves: readonly DemoMove[];
  readonly lastMove: ({ readonly from: string; readonly to: string; readonly san: string; readonly color: 'w' | 'b' }) | null;
  readonly turn: 'w' | 'b';
  readonly check: boolean;
  readonly result: string | null;
}

/** The mutable state of the running demo, held by the preview component. */
export interface DemoGame {
  position: Position;
  moves: CoordinateMove[];
  display: DemoMove[];
  ledger: RepetitionLedger;
}

/**
 * The ending of a position in the demo's own words, in the same precedence
 * the controller settles: mate, stalemate, repetition, material, the
 * fifty-move rule.
 */
function resultText(position: Position, ledger: RepetitionLedger): string | null {
  const facts = observeEndingFacts(position, ledger);
  const turn = position.sideToMove;
  if (facts.checkmate) return `${turn === 'w' ? 'Black' : 'White'} wins by checkmate.`;
  if (facts.stalemate) return 'Draw by stalemate.';
  if (facts.thirdRepetition) return 'Draw by repetition.';
  if (facts.insufficientMaterial) return 'Draw by insufficient material.';
  if (facts.hundredHalfmoves) return 'Draw by the fifty-move rule.';
  return null;
}

export function createDemoGame(startingFen: string): DemoGame {
  const position = parsePosition(startingFen);
  const ledger = recordPosition(createRepetitionLedger(position), position);
  return { position, moves: [], display: [], ledger };
}

export function demoFrame(game: DemoGame): DemoFrame {
  const last = game.display.at(-1) ?? null;
  const move = game.moves.at(-1) ?? null;
  return {
    position: game.position,
    moves: game.display,
    lastMove: last && move ? { from: move.from, to: move.to, san: last.san, color: last.color } : null,
    turn: game.position.sideToMove,
    check: observeEndingFacts(game.position, game.ledger).inCheck,
    result: resultText(game.position, game.ledger),
  };
}

function lan(move: CoordinateMove): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

/** The engine answers in UCI; the shared rules want a coordinate move. */
function coordinate(uci: string): CoordinateMove {
  return {
    from: uci.slice(0, 2), to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci[4] } : {}),
  } as CoordinateMove;
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
export async function playDemoLoop(game: DemoGame, startingFen: string, signal: AbortSignal,
  onMove: (frame: DemoFrame) => void, onReady: () => void): Promise<void> {
  if (demoFrame(createDemoGame(startingFen)).result) return;
  while (!signal.aborted) {
    await playDemoGame(game, startingFen, signal, onMove, onReady);
    await waitForMove(DEMO_REPLAY_DELAY_MS, signal);
    if (signal.aborted) return;
    const restarted = createDemoGame(startingFen);
    game.position = restarted.position;
    game.moves = restarted.moves;
    game.display = restarted.display;
    game.ledger = restarted.ledger;
    onMove(demoFrame(game));
  }
}

/** The demo owns its worker so pausing it never interrupts a playable match. */
export async function playDemoGame(game: DemoGame, startingFen: string, signal: AbortSignal,
  onMove: (frame: DemoFrame) => void, onReady: () => void): Promise<void> {
  if (demoFrame(game).result || signal.aborted) return;
  const source = await downloadBrowserEngine('stockfish-lite', undefined, signal);
  if (signal.aborted) return;
  const engine = new BrowserUciEngine(source);
  try {
    onReady();
    let nextMoveAt = performance.now() + DEMO_MOVE_INTERVAL_MS;
    while (!signal.aborted && !demoFrame(game).result) {
      const result = await engine.search({ engineId: 'stockfish-lite', hashMb: 16, moveTimeMs: 100 }, {
        startingFen, moves: game.moves.map(lan),
      }, signal);
      // Include search time in the cadence instead of adding 250 ms after it.
      await waitForMove(nextMoveAt - performance.now(), signal);
      if (signal.aborted) return;
      nextMoveAt = performance.now() + DEMO_MOVE_INTERVAL_MS;
      const before = game.position;
      const applied = applyCoordinateMove(before, coordinate(result.move));
      game.position = applied.position;
      game.moves.push(applied.move);
      game.display.push({ san: applied.san, color: before.sideToMove, number: before.fullmoveNumber });
      game.ledger = recordPosition(game.ledger, game.position);
      onMove(demoFrame(game));
    }
  } finally { engine.close(); }
}
