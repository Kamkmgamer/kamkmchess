import { isSquareAttackedInFen } from '../rules/index.js';
import type { Color, CoordinateMove, PieceOnSquare, Position, Square } from '../rules/index.js';

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

function pieceAt(position: Position, square: Square): PieceOnSquare | null {
  return position.pieces.find((piece) => piece.square === square) ?? null;
}

/** Reports whether `defender` attacks `square` in the given position. */
export function isSquareAttacked(position: Position, square: Square, defender: Color): boolean {
  return isSquareAttackedInFen(position.fen, square, defender);
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
