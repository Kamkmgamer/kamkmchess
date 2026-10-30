import { castlingSide } from 'chessops/chess';
import { makeBoardFen, makeCastlingFen } from 'chessops/fen';
import { makeSan, parseSan } from 'chessops/san';
import { charToRole, kingCastlesTo, makeSquare, parseSquare } from 'chessops/util';
import type { NormalMove } from 'chessops/types';
import { createChessPosition } from './chess-adapter.js';
import { parsePosition } from './position.js';
import type { CoordinateMove, PieceOnSquare, Position, Promotion } from './types.js';

export interface Transition {
  readonly move: CoordinateMove;
  readonly san: string;
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

const moveCache = new WeakMap<Position, readonly CoordinateMove[]>();
const promotions: readonly Promotion[] = ['q', 'r', 'b', 'n'];

/** The coordinate move a SAN token denotes in this position, or null when it is not legal there. */
export function sanToCoordinateMove(position: Position, san: string): CoordinateMove | null {
  const move = parseSan(createChessPosition(position), san.trim());
  if (!move || !('from' in move)) return null;
  // Orthodox SAN promotions are underpromotions; chessops types carry the full role union.
  const promotion = move.promotion === undefined ? undefined
    : ({ queen: 'q', rook: 'r', bishop: 'b', knight: 'n' } as const)[move.promotion as 'queen' | 'rook' | 'bishop' | 'knight'];
  return promotion === undefined ? { from: makeSquare(move.from), to: makeSquare(move.to) }
    : { from: makeSquare(move.from), to: makeSquare(move.to), promotion };
}

/** Legal orthodox coordinates, including explicit promotion choices. */
export function legalMoves(position: Position): readonly CoordinateMove[] {
  const cached = moveCache.get(position);
  if (cached) return cached;
  const engine = createChessPosition(position);
  const moves: CoordinateMove[] = [];
  for (const [from, destinations] of engine.allDests()) {
    for (const to of destinations) {
      const side = castlingSide(engine, { from, to });
      const coordinates = { from: makeSquare(from), to: makeSquare(side ? kingCastlesTo(engine.turn, side) : to) };
      if (engine.board.get(from)?.role === 'pawn' && (to < 8 || to >= 56)) {
        for (const promotion of promotions) moves.push(Object.freeze({ ...coordinates, promotion }));
      } else moves.push(Object.freeze(coordinates));
    }
  }
  const result = Object.freeze(moves);
  moveCache.set(position, result);
  return result;
}

export function applyCoordinateMove(position: Position, move: CoordinateMove): Transition {
  if (!/^[a-h][1-8]$/.test(move.from) || !/^[a-h][1-8]$/.test(move.to) ||
      (move.promotion !== undefined && !promotions.includes(move.promotion))) throw new IllegalMoveError(move);
  const engine = createChessPosition(position);
  const raw: NormalMove = { from: parseSquare(move.from), to: parseSquare(move.to),
    ...(move.promotion === undefined ? {} : { promotion: charToRole(move.promotion) }) };
  const castle = castlingSide(engine, raw);
  if ((castle && raw.to !== kingCastlesTo(engine.turn, castle)) || !engine.isLegal(raw)) throw new IllegalMoveError(move);
  const movingPiece = position.pieces.find(piece => piece.square === move.from);
  if (!movingPiece) throw new Error('A legal move has no moving piece.');
  const enPassant = movingPiece.type === 'p' && move.from[0] !== move.to[0] && !engine.board.get(raw.to);
  const captureSquare = enPassant ? `${move.to[0]}${move.from[1]}` : move.to;
  const capturedPiece = position.pieces.find(piece => piece.square === captureSquare) ?? null;
  const isCapture = capturedPiece !== null;
  const san = makeSan(engine, raw);
  engine.play(raw);
  const enPassantSquare = movingPiece.type === 'p' && Math.abs(Number(move.to[1]) - Number(move.from[1])) === 2
    ? `${move.from[0]}${(Number(move.to[1]) + Number(move.from[1])) / 2}` : '-';
  const nextPosition = parsePosition([
    makeBoardFen(engine.board), engine.turn === 'white' ? 'w' : 'b',
    makeCastlingFen(engine.board, engine.castles.castlingRights), enPassantSquare,
    movingPiece.type === 'p' || isCapture ? '0' : (BigInt(position.halfmoveClock) + 1n).toString(),
    position.sideToMove === 'b' ? (BigInt(position.fullmoveNumber) + 1n).toString() : position.fullmoveNumber,
  ].join(' '));
  return Object.freeze({ move: Object.freeze({ ...move }), san, position: nextPosition, movingPiece, capturedPiece,
    isCapture, isPawnMove: movingPiece.type === 'p' });
}
