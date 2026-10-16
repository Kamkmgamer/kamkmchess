import { Chess, type Square as ChessSquare } from 'chess.js';
import type { Color, Position, Square } from './types.js';

function createChessFromFen(fen: string): Chess {
  const fields = fen.split(' ');
  const placement = fields[0];
  const sideToMove = fields[1];
  const castlingRights = fields[2];
  const enPassantSquare = fields[3];
  if (
    fields.length !== 6 ||
    placement === undefined ||
    sideToMove === undefined ||
    castlingRights === undefined ||
    enPassantSquare === undefined
  ) {
    throw new Error('A validated position must retain all six FEN fields.');
  }

  return new Chess(`${placement} ${sideToMove} ${castlingRights} ${enPassantSquare} 0 1`);
}

export function createChessPosition(position: Position): Chess {
  return createChessFromFen(position.fen);
}

export function isSquareAttackedInFen(fen: string, square: Square, byColor: Color): boolean {
  return createChessFromFen(fen).isAttacked(square as ChessSquare, byColor);
}
