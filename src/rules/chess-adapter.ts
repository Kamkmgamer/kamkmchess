import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { attacks } from 'chessops/attacks';
import { parseSquare } from 'chessops/util';
import type { Color, Position, Square } from './types.js';

const positions = new WeakMap<Position, Chess>();

function setupFromFen(fen: string) {
  // Exact decimal counters belong to our immutable position, not chessops' bounded numbers.
  return parseFen(`${fen.split(' ').slice(0, 4).join(' ')} 0 1`).unwrap();
}

export function createChessPosition(position: Position): Chess {
  let engine = positions.get(position);
  if (!engine) {
    engine = Chess.fromSetup(setupFromFen(position.fen)).unwrap();
    positions.set(position, engine);
  }
  return engine.clone();
}

export function isSquareAttackedInFen(fen: string, square: Square, byColor: Color): boolean {
  const board = setupFromFen(fen).board;
  const target = parseSquare(square);
  for (const from of board[byColor === 'w' ? 'white' : 'black']) {
    const piece = board.get(from);
    if (piece && attacks(piece, from, board.occupied).has(target)) return true;
  }
  return false;
}
