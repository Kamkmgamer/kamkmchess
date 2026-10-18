import type { Chess, Color, Move, PieceSymbol } from 'chess.js';
import type { CoordinateMove } from '../../rules/index.js';

export type SearchMove = ConstructorParameters<typeof Move>[1];

interface SearchEngine {
  readonly _board: readonly ({ readonly type: PieceSymbol; readonly color: Color } | undefined)[];
  readonly _kings: Readonly<Record<Color, number>>;
  _attacked(color: Color, square: number): boolean;
  _moves(): SearchMove[];
  _makeMove(move: SearchMove): void;
  _undoMove(): SearchMove | null;
}

// chess.js 1.4.0 has no public coordinate-only make/unmake API. Keep its
// version-specific access here. The public Move wrapper computes SAN and two
// FENs and regenerates legal moves, which is prohibitive for speculative nodes.
// Only apply records generated for this exact board, then undo before reuse.
// No repetition bookkeeping is needed for hypothetical mating reachability.
// This adapter is discovery-only: the independent checker uses public rules.
function engine(chess: Chess): SearchEngine {
  return chess as unknown as SearchEngine;
}

export function searchMoves(chess: Chess): SearchMove[] {
  return engine(chess)._moves();
}

export function makeSearchMove(chess: Chess, move: SearchMove): void {
  engine(chess)._makeMove(move);
}

export function undoSearchMove(chess: Chess): void {
  engine(chess)._undoMove();
}

export function searchBoard(chess: Chess): SearchEngine['_board'] {
  return engine(chess)._board;
}

export function searchKing(chess: Chess, color: Color): number {
  return engine(chess)._kings[color];
}

export function searchAttacked(chess: Chess, square: number, color: Color): boolean {
  return engine(chess)._attacked(color, square);
}

export function searchCoordinates(move: SearchMove): CoordinateMove {
  const square = (index: number): CoordinateMove['from'] =>
    `${String.fromCharCode(97 + (index & 7))}${8 - (index >> 4)}` as CoordinateMove['from'];
  return {
    from: square(move.from), to: square(move.to),
    ...(move.promotion === undefined ? {} : { promotion: move.promotion as NonNullable<CoordinateMove['promotion']> }),
  };
}
