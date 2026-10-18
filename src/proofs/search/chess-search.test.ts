import { Chess, type Square } from 'chess.js';
import { expect, it } from 'vitest';
import { makeSearchMove, searchAttacked, searchBoard, searchCoordinates, searchKing, searchMoves, undoSearchMove } from './chess-search.js';

const cases = [
  { name: 'start', fen: new Chess().fen(), special: ['e2e4'] },
  { name: 'white castling', fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', special: ['e1g1', 'e1c1'] },
  { name: 'black castling', fen: 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', special: ['e8g8', 'e8c8'] },
  { name: 'white en passant', fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', special: ['e5d6'] },
  { name: 'black en passant', fen: '4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 2', special: ['e4d3'] },
  { name: 'pinned en passant', fen: 'k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', special: [] },
  { name: 'white promotions', fen: '1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1', special: ['a7a8n', 'a7b8q'] },
  { name: 'black promotions', fen: '4k3/8/8/8/8/8/p7/1R2K3 b - - 0 1', special: ['a2a1n', 'a2b1q'] },
  { name: 'checkmate', fen: '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1', special: [] },
  { name: 'stalemate', fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', special: [] },
];

it.each(cases)('matches the pinned chess.js public API for $name', ({ fen, special }) => {
  const chess = new Chess(fen);
  const original = chess.fen({ forceEnpassantSquare: true });
  const originalHash = chess.hash();
  const moves = searchMoves(chess);
  const key = (move: { from: string; to: string; promotion?: string }) => move.from + move.to + (move.promotion ?? '');
  const coordinates = moves.map(searchCoordinates).map(key);
  expect(coordinates).toEqual(chess.moves({ verbose: true }).map(key));
  for (const move of special) expect(coordinates).toContain(move);
  if (fen.startsWith('k3r3')) expect(coordinates).not.toContain('e5d6');

  for (const move of moves) {
    const reference = new Chess(fen);
    reference.move(searchCoordinates(move));
    makeSearchMove(chess, move);
    expect(chess.fen({ forceEnpassantSquare: true })).toBe(reference.fen({ forceEnpassantSquare: true }));
    expect(chess.hash()).toBe(reference.hash());
    undoSearchMove(chess);
    expect(chess.fen({ forceEnpassantSquare: true })).toBe(original);
    expect(chess.hash()).toBe(originalHash);
  }

  for (let rank = 0; rank < 8; rank += 1) for (let file = 0; file < 8; file += 1) {
    const square = `${String.fromCharCode(97 + file)}${8 - rank}` as Square;
    const index = rank * 16 + file;
    expect(searchBoard(chess)[index] ?? null).toEqual(chess.get(square) ?? null);
    for (const color of ['w', 'b'] as const) {
      expect(searchAttacked(chess, index, color)).toBe(chess.isAttacked(square, color));
      if (chess.get(square)?.type === 'k' && chess.get(square)?.color === color) {
        expect(searchKing(chess, color)).toBe(index);
      }
    }
  }
});

it('preserves nested make/unmake state through the standard perft counts', () => {
  const chess = new Chess();
  const original = chess.fen();
  const hash = chess.hash();
  function perft(depth: number): number {
    if (depth === 0) return 1;
    let count = 0;
    for (const move of searchMoves(chess)) {
      makeSearchMove(chess, move);
      count += perft(depth - 1);
      undoSearchMove(chess);
    }
    return count;
  }
  expect(perft(1)).toBe(20);
  expect(perft(2)).toBe(400);
  expect(perft(3)).toBe(8_902);
  expect(chess.fen()).toBe(original);
  expect(chess.hash()).toBe(hash);
});
