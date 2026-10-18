import { createChessPosition } from './chess-adapter.js';
import { repetitionCount, type RepetitionLedger } from './repetition.js';
import type { Position } from './types.js';

export type ObservedEnding =
  | 'checkmate'
  | 'stalemate'
  | 'threefold-repetition'
  | 'hundred-halfmoves'
  | 'none';

export interface EndingFacts {
  readonly inCheck: boolean;
  readonly hasLegalMoves: boolean;
  readonly checkmate: boolean;
  readonly stalemate: boolean;
  readonly insufficientMaterial: boolean;
  readonly repetitionCount: string;
  readonly thirdRepetition: boolean;
  readonly hundredHalfmoves: boolean;
  readonly deadness: 'not-assessed';
  readonly ending: ObservedEnding;
}

export function observeEndingFacts(position: Position, ledger: RepetitionLedger): EndingFacts {
  const engine = createChessPosition(position);
  const context = engine.ctx();
  const inCheck = context.checkers.nonEmpty();
  const hasLegalMoves = engine.hasDests(context);
  const checkmate = inCheck && !hasLegalMoves;
  const stalemate = !inCheck && !hasLegalMoves;
  const currentOccurrences = repetitionCount(ledger, position);
  const thirdRepetition = BigInt(currentOccurrences) >= 3n;
  const hundredHalfmoves = BigInt(position.halfmoveClock) >= 100n;

  let ending: ObservedEnding = 'none';
  if (checkmate) ending = 'checkmate';
  else if (stalemate) ending = 'stalemate';
  else if (thirdRepetition) ending = 'threefold-repetition';
  else if (hundredHalfmoves) ending = 'hundred-halfmoves';

  return Object.freeze({
    inCheck,
    hasLegalMoves,
    checkmate,
    stalemate,
    insufficientMaterial: engine.isInsufficientMaterial(),
    repetitionCount: currentOccurrences,
    thirdRepetition,
    hundredHalfmoves,
    deadness: 'not-assessed',
    ending,
  });
}

/** Lichess timeout policy: material, then a bounded one-ply forced-outcome check. */
export function timeoutWinner(position: Position, expiredColor: 'w' | 'b'): 'white' | 'black' | 'draw' {
  const engine = createChessPosition(position);
  const opponent = expiredColor === 'w' ? 'black' : 'white';
  if (engine.hasInsufficientMaterial(opponent)) return 'draw';
  // A timeout is assessed on the flagging player's turn.
  if (engine.turn !== (expiredColor === 'w' ? 'white' : 'black')) return opponent;
  let hasMoves = false;
  for (const [from, destinations] of engine.allDests()) {
    for (const to of destinations) {
      const roles = engine.board.get(from)?.role === 'pawn' && (to < 8 || to >= 56)
        ? ['queen', 'rook', 'bishop', 'knight'] as const : [undefined];
      for (const promotion of roles) {
        hasMoves = true;
        const next = engine.clone();
        next.play({ from, to, ...(promotion === undefined ? {} : { promotion }) });
        const context = next.ctx();
        const outcome = next.outcome(context);
        if (outcome?.winner === opponent) return opponent;
        if (!outcome && !next.hasInsufficientMaterial(opponent)) return opponent;
      }
    }
  }
  return hasMoves ? 'draw' : opponent;
}
