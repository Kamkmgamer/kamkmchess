import { describe, expect, it } from 'vitest';
import { frameEvaluation } from './render.js';

describe('video evaluation after the played move', () => {
  it('shows delivered checkmate as mate zero and keeps the winner for either color', () => {
    expect(frameEvaluation({ side: 'white', playedScore: { kind: 'mate', value: 1 } })).toMatchObject({ kind: 'mate', value: 0, winner: 'white' });
    const black = frameEvaluation({ side: 'black', playedScore: { kind: 'mate', value: 1 } });
    expect(black.kind).toBe('mate');
    if (black.kind === 'mate') { expect(black.winner).toBe('black'); expect(Math.abs(black.value)).toBe(0); }
  });
  it('advances a winning mate count without shortening an opponent mating sequence', () => {
    expect(frameEvaluation({ side: 'white', playedScore: { kind: 'mate', value: 3 } })).toMatchObject({ value: 2, winner: 'white' });
    expect(frameEvaluation({ side: 'black', playedScore: { kind: 'mate', value: -3 } })).toMatchObject({ value: 3, winner: 'white' });
    expect(frameEvaluation({ side: 'black', playedScore: { kind: 'cp', value: 250 } })).toEqual({ kind: 'cp', value: -250 });
  });
});
