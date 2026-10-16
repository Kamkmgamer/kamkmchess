import { Chess } from 'chess.js';
import type { Position } from './types.js';

export function createChessPosition(position: Position): Chess {
  const fields = position.fen.split(' ');
  const placement = fields[0];
  const sideToMove = fields[1];
  const castlingRights = fields[2];
  const enPassantSquare = fields[3];
  if (
    placement === undefined ||
    sideToMove === undefined ||
    castlingRights === undefined ||
    enPassantSquare === undefined
  ) {
    throw new Error('A validated position must retain all six FEN fields.');
  }

  return new Chess(`${placement} ${sideToMove} ${castlingRights} ${enPassantSquare} 0 1`);
}
