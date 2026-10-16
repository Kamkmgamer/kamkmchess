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
  readonly repetitionCount: string;
  readonly thirdRepetition: boolean;
  readonly hundredHalfmoves: boolean;
  readonly deadness: 'not-assessed';
  readonly ending: ObservedEnding;
}

export function observeEndingFacts(position: Position, ledger: RepetitionLedger): EndingFacts {
  const engine = createChessPosition(position);
  const inCheck = engine.isCheck();
  const hasLegalMoves = engine.moves().length > 0;
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
    repetitionCount: currentOccurrences,
    thirdRepetition,
    hundredHalfmoves,
    deadness: 'not-assessed',
    ending,
  });
}
