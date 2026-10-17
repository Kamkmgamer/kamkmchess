import type { Color, CoordinateMove, File, PieceOnSquare, Position, Rank, Square } from '../rules/index.js';

/**
 * Rule-specific explanations for one illegal model attempt.
 *
 * The application explains the specific violation it can prove from its own board, such as
 * "That leaves your king in check", and asks the model to choose again. It never lists
 * legal moves, never suggests a replacement and never ranks candidates. Legality itself is
 * decided by the rules module; this module only words the failure.
 */
export type IllegalMoveCode =
  | 'no-piece-at-origin'
  | 'wrong-side-piece'
  | 'same-square'
  | 'own-piece-on-target'
  | 'castling-not-allowed'
  | 'castling-through-check'
  | 'king-move-into-check'
  | 'not-legal-in-position';

export interface IllegalMoveExplanation {
  readonly code: IllegalMoveCode;
  readonly message: string;
}

const KNIGHT_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

const KING_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

const DIAGONALS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const ORTHOGONALS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const FILES: readonly File[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS: readonly Rank[] = ['1', '2', '3', '4', '5', '6', '7', '8'];

function fileIndex(file: File): number {
  return FILES.indexOf(file);
}

function squareAt(fileIndexFromOrigin: number, rankIndex: number): Square | null {
  const file = FILES[fileIndexFromOrigin];
  const rank = RANKS[rankIndex];
  if (file === undefined || rank === undefined) return null;
  return `${file}${rank}`;
}

function pieceAt(position: Position, square: Square): PieceOnSquare | null {
  return position.pieces.find((piece) => piece.square === square) ?? null;
}

function rayAttacks(
  position: Position,
  from: Square,
  offsets: readonly (readonly [number, number])[],
  defender: Color,
): boolean {
  const file = fileIndex(from[0] as File);
  const rank = Number(from[1]) - 1;
  for (const [fileDelta, rankDelta] of offsets) {
    let currentFile = file + fileDelta;
    let currentRank = rank + rankDelta;
    while (currentFile >= 0 && currentFile < FILES.length && currentRank >= 0 && currentRank < RANKS.length) {
      const square = squareAt(currentFile, currentRank);
      if (square === null) break;
      const piece = pieceAt(position, square);
      if (piece !== null) {
        if (piece.color === defender) {
          const type = piece.type;
          if (type === 'q' || (offsets === DIAGONALS && type === 'b') || (offsets === ORTHOGONALS && type === 'r')) {
            return true;
          }
        }
        break;
      }
      currentFile += fileDelta;
      currentRank += rankDelta;
    }
  }
  return false;
}

/** Reports whether `defender` attacks `square` in the given position. */
export function isSquareAttacked(position: Position, square: Square, defender: Color): boolean {
  const file = fileIndex(square[0] as File);
  const rank = Number(square[1]) - 1;

  for (const [fileDelta, rankDelta] of KING_OFFSETS) {
    const neighbour = squareAt(file + fileDelta, rank + rankDelta);
    if (neighbour === null) continue;
    const piece = pieceAt(position, neighbour);
    if (piece?.color === defender && piece.type === 'k') return true;
  }
  for (const [fileDelta, rankDelta] of KNIGHT_OFFSETS) {
    const origin = squareAt(file + fileDelta, rank + rankDelta);
    if (origin === null) continue;
    const piece = pieceAt(position, origin);
    if (piece?.color === defender && piece.type === 'n') return true;
  }
  const pawnRank = defender === 'w' ? rank - 1 : rank + 1;
  for (const fileDelta of [-1, 1]) {
    const origin = squareAt(file + fileDelta, pawnRank);
    if (origin === null) continue;
    const piece = pieceAt(position, origin);
    if (piece?.color === defender && piece.type === 'p') return true;
  }
  if (rayAttacks(position, square, DIAGONALS, defender)) return true;
  return rayAttacks(position, square, ORTHOGONALS, defender);
}

function castlingRight(position: Position, move: CoordinateMove): string | null {
  const rank = position.sideToMove === 'w' ? '1' : '8';
  if (move.from !== `e${rank}`) return null;
  if (move.to === `g${rank}`) return position.sideToMove === 'w' ? 'K' : 'k';
  if (move.to === `c${rank}`) return position.sideToMove === 'w' ? 'Q' : 'q';
  return null;
}

function castlingPath(position: Position, move: CoordinateMove): readonly Square[] {
  const rank = position.sideToMove === 'w' ? '1' : '8';
  if (move.to === `g${rank}`) return [`f${rank}` as Square, `g${rank}` as Square];
  return [`d${rank}` as Square, `c${rank}` as Square, `b${rank}` as Square];
}

/** Wording used when the model's own piece cannot reach the requested squares. */
function genericExplanation(move: CoordinateMove): IllegalMoveExplanation {
  return {
    code: 'not-legal-in-position',
    message: `${move.from}${move.to} is not legal in this position. Please choose a legal move yourself.`,
  };
}

/** Explains one illegal attempt without revealing or choosing any legal move. */
export function explainIllegalMove(position: Position, move: CoordinateMove): IllegalMoveExplanation {
  if (move.from === move.to) {
    return {
      code: 'same-square',
      message: `${move.from}${move.to} does not move a piece. Please choose a legal move yourself.`,
    };
  }
  const piece = pieceAt(position, move.from);
  if (piece === null) {
    return {
      code: 'no-piece-at-origin',
      message: `There is no piece on ${move.from}. Please choose a legal move yourself.`,
    };
  }
  if (piece.color !== position.sideToMove) {
    return {
      code: 'wrong-side-piece',
      message: `The piece on ${move.from} is not yours to move in this position. Please choose a legal move yourself.`,
    };
  }
  const target = pieceAt(position, move.to);
  if (target !== null && target.color === position.sideToMove) {
    return {
      code: 'own-piece-on-target',
      message: `${move.to} is occupied by your own piece. Please choose a legal move yourself.`,
    };
  }
  const right = castlingRight(position, move);
  if (right !== null && !position.castlingRights.includes(right)) {
    return {
      code: 'castling-not-allowed',
      message: `Your king may not castle from ${move.from} in this position. Please choose a legal move yourself.`,
    };
  }
  if (right !== null) {
    const crossed = castlingPath(position, move).some((square) => isSquareAttacked(position, square, opponent(position.sideToMove)));
    if (crossed) {
      return {
        code: 'castling-through-check',
        message: `${move.from}${move.to} castles through or into check. Please choose a legal move yourself.`,
      };
    }
  }
  if (piece.type === 'k' && isSquareAttacked(position, move.to, opponent(position.sideToMove))) {
    return {
      code: 'king-move-into-check',
      message: `${move.from}${move.to} leaves your king in check. Please choose a legal move yourself.`,
    };
  }
  return genericExplanation(move);
}

function opponent(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}