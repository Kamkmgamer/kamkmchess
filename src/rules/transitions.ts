import type { Move as ChessMove } from 'chess.js';
import { createChessPosition } from './chess-adapter.js';
import { parsePosition } from './position.js';
import type { Color, CoordinateMove, PieceOnSquare, Position, Promotion, Square } from './types.js';

export interface Transition {
  readonly move: CoordinateMove;
  readonly position: Position;
  readonly movingPiece: PieceOnSquare;
  readonly capturedPiece: PieceOnSquare | null;
  readonly isCapture: boolean;
  readonly isPawnMove: boolean;
}

export class IllegalMoveError extends Error {
  readonly move: CoordinateMove;

  constructor(move: CoordinateMove) {
    super(`Illegal coordinate move ${move.from}-${move.to}.`);
    this.name = 'IllegalMoveError';
    this.move = Object.freeze({ ...move });
  }
}

function isSquare(value: string): value is Square {
  return /^[a-h][1-8]$/.test(value);
}

function isPromotion(value: unknown): value is Promotion {
  return value === 'q' || value === 'r' || value === 'b' || value === 'n';
}

function coordinatesFromChessMove(move: ChessMove): CoordinateMove {
  return move.promotion === undefined
    ? Object.freeze({ from: move.from as Square, to: move.to as Square })
    : Object.freeze({
        from: move.from as Square,
        to: move.to as Square,
        promotion: move.promotion as Promotion,
      });
}

function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function updatedCastlingRights(position: Position, move: ChessMove, capturedPiece: PieceOnSquare | null): string {
  const rights = new Set(position.castlingRights === '-' ? [] : position.castlingRights);

  if (move.piece === 'k') {
    rights.delete(move.color === 'w' ? 'K' : 'k');
    rights.delete(move.color === 'w' ? 'Q' : 'q');
  }
  if (move.piece === 'r') {
    if (move.from === 'h1') rights.delete('K');
    if (move.from === 'a1') rights.delete('Q');
    if (move.from === 'h8') rights.delete('k');
    if (move.from === 'a8') rights.delete('q');
  }
  if (capturedPiece?.type === 'r') {
    if (capturedPiece.square === 'h1') rights.delete('K');
    if (capturedPiece.square === 'a1') rights.delete('Q');
    if (capturedPiece.square === 'h8') rights.delete('k');
    if (capturedPiece.square === 'a8') rights.delete('q');
  }

  return [...'KQkq'].filter((right) => rights.has(right)).join('') || '-';
}

function enPassantAfter(move: ChessMove): Square | null {
  if (move.piece !== 'p' || Math.abs(Number(move.to[1]) - Number(move.from[1])) !== 2) return null;
  const targetRank = (Number(move.to[1]) + Number(move.from[1])) / 2;
  return `${move.from[0]}${targetRank}` as Square;
}

function capturedSquare(move: ChessMove): Square {
  return move.isEnPassant() ? `${move.to[0]}${move.from[1]}` as Square : move.to as Square;
}

/**
 * Lists legal coordinates for local proof exploration. The list must not enter model input.
 * This function intentionally ignores repetition and halfmove draw cutoffs.
 */
export function legalMoves(position: Position): readonly CoordinateMove[] {
  const engine = createChessPosition(position);
  return Object.freeze(engine.moves({ verbose: true }).map(coordinatesFromChessMove));
}

/**
 * Applies one orthodox legal move. Match acceptance must observe ending facts separately.
 * Keeping this transition draw-cutoff-free lets proof analysis explore hypothetical paths.
 */
export function applyCoordinateMove(position: Position, move: CoordinateMove): Transition {
  if (
    !isSquare(move.from) ||
    !isSquare(move.to) ||
    (move.promotion !== undefined && !isPromotion(move.promotion))
  ) {
    throw new IllegalMoveError(move);
  }

  const engine = createChessPosition(position);
  // Only this piece can match the submitted coordinates. Verbose generation
  // computes SAN and before/after FENs for each candidate, so avoid doing that
  // work for every other piece during play and independent proof replay.
  const legalMove = engine.moves({ square: move.from, verbose: true }).find(
    (candidate) =>
      candidate.from === move.from &&
      candidate.to === move.to &&
      candidate.promotion === move.promotion,
  );
  if (legalMove === undefined) throw new IllegalMoveError(move);

  const movingPiece = position.pieces.find((piece) => piece.square === legalMove.from);
  if (movingPiece === undefined) throw new Error('A generated legal move has no moving piece.');
  const captureSquare = capturedSquare(legalMove);
  const capturedPiece = position.pieces.find((piece) => piece.square === captureSquare) ?? null;
  const appliedMove = engine.move({
    from: legalMove.from,
    to: legalMove.to,
    ...(legalMove.promotion === undefined ? {} : { promotion: legalMove.promotion }),
  });
  const nextFields = engine.fen({ forceEnpassantSquare: true }).split(' ');
  const placement = nextFields[0];
  if (placement === undefined) throw new Error('chess.js did not return a board placement after a legal move.');

  const isCapture = appliedMove.isCapture() || appliedMove.isEnPassant();
  const halfmoveClock =
    appliedMove.piece === 'p' || isCapture
      ? '0'
      : (BigInt(position.halfmoveClock) + 1n).toString();
  const fullmoveNumber =
    position.sideToMove === 'b'
      ? (BigInt(position.fullmoveNumber) + 1n).toString()
      : position.fullmoveNumber;
  const castlingRights = updatedCastlingRights(position, appliedMove, capturedPiece);
  const enPassantSquare = enPassantAfter(appliedMove);
  const nextTurn = opposite(position.sideToMove);
  const nextFen = [
    placement,
    nextTurn,
    castlingRights,
    enPassantSquare ?? '-',
    halfmoveClock,
    fullmoveNumber,
  ].join(' ');
  const nextPosition = parsePosition(nextFen);

  return Object.freeze({
    move: coordinatesFromChessMove(appliedMove),
    position: nextPosition,
    movingPiece,
    capturedPiece,
    isCapture,
    isPawnMove: appliedMove.piece === 'p',
  });
}
