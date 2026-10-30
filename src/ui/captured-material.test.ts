import { describe, expect, it } from 'vitest';
import { parsePosition } from '../rules/index.js';
import { capturedSummary } from './captured-material.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('capturedSummary', () => {
  it('reports nothing for the starting position', () => {
    const summary = capturedSummary(START, parsePosition(START));
    expect(summary.capturedByWhite).toEqual([]);
    expect(summary.capturedByBlack).toEqual([]);
    expect(summary.advantage).toBe(0);
  });

  it('lists captures per side, most valuable first, with the material advantage', () => {
    // White has taken a pawn (h7); black has taken the knight (b1).
    const after = 'rnbqkbnr/ppppppp1/8/8/8/8/PPPPPPPP/R1BQKBNR w KQkq - 0 3';
    const summary = capturedSummary(START, parsePosition(after));
    expect(summary.capturedByWhite).toEqual(['p']);
    expect(summary.capturedByBlack).toEqual(['n']);
    expect(summary.advantage).toBe(-2);
  });

  it('sorts several captures by value', () => {
    const after = '1nbqkbnr/pppp1ppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 5';
    const summary = capturedSummary(START, parsePosition(after));
    expect(summary.capturedByWhite).toEqual(['r', 'p']);
    expect(summary.advantage).toBe(6);
  });

  it('does not count a promoted pawn as a capture', () => {
    const start = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    const after = '4Qk2/8/8/8/8/8/8/4K3 b - - 0 1';
    const moves = [{ from: 'e7', to: 'e8', promotion: 'q', fenBefore: '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1' }];
    const summary = capturedSummary(start, parsePosition(after), moves);
    expect(summary.capturedByWhite).toEqual([]);
    expect(summary.capturedByBlack).toEqual([]);
    expect(summary.advantage).toBe(9);
  });

  it('adapts to a custom starting setup from the position editor', () => {
    const start = 'k7/8/8/8/8/8/8/7K w - - 0 1';
    const after = 'k7/8/8/8/8/8/K7/8 b - - 0 1';
    const summary = capturedSummary(start, parsePosition(after));
    expect(summary.capturedByBlack).toEqual([]);
    expect(summary.capturedByWhite).toEqual([]);
    expect(summary.advantage).toBe(0);
  });
});
