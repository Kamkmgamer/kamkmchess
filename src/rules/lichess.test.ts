import { describe, expect, it } from 'vitest';
import { applyCoordinateMove, legalMoves, parsePosition, timeoutWinner } from './index.js';
import type { Position } from './types.js';

function perft(position: Position, depth: number): number {
  if (depth === 0) return 1;
  return legalMoves(position).reduce((count, move) => count + perft(applyCoordinateMove(position, move).position, depth - 1), 0);
}

describe('chessops integration', () => {
  it('matches the standard depth-three legal move count', () => {
    expect(perft(parsePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 3)).toBe(8902);
  });

  it('keeps cached destinations immutable when transitions mutate engine clones', () => {
    const position = parsePosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const before = legalMoves(position);
    expect(applyCoordinateMove(position, { from: 'e1', to: 'g1' }).san).toBe('O-O');
    expect(legalMoves(position)).toBe(before);
    expect(() => applyCoordinateMove(position, { from: 'e1', to: 'h1' })).toThrow();
  });

  it.each([
    ['7k/8/6K1/8/8/8/Q7/8 w - - 0 1', 'draw'],
    ['7k/8/6K1/8/8/8/8/q7 w - - 0 1', 'black'],
    ['7k/8/6K1/8/8/8/8/n7 w - - 0 1', 'draw'],
    ['7k/8/6K1/8/8/8/8/nn6 w - - 0 1', 'black'],
    ['7k/8/6K1/8/8/8/P7/n7 w - - 0 1', 'black'],
    ['5b1k/8/6K1/8/8/8/8/2B5 w - - 0 1', 'draw'],
    ['6bk/8/6K1/8/8/8/8/2B5 w - - 0 1', 'black'],
    // Black has a rook, but White's only legal move captures it: Kxh2.
    ['8/8/8/8/8/8/5k1r/7K w - - 0 1', 'draw'],
  ])('classifies timeout material and forced outcomes for %s', (fen, winner) => {
    expect(timeoutWinner(parsePosition(fen), 'w')).toBe(winner);
  });
});
