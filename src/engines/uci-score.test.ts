import { describe, expect, it } from 'vitest';
import { formatEvaluation, parseUciEvaluation, whiteEvaluationPercent } from './uci-score.js';

describe('evaluation scores', () => {
  it('normalizes Black-to-move centipawns and mates to White', () => {
    expect(parseUciEvaluation('info depth 18 score cp 125 nodes 400', false)).toEqual({ depth: 18, score: { kind: 'cp', value: -125 } });
    expect(parseUciEvaluation('info depth 20 score mate -3 pv a1a2', false)?.score).toEqual({ kind: 'mate', value: 3, winner: 'white' });
    expect(parseUciEvaluation('info depth 0 score mate 0', true)?.score).toEqual({ kind: 'mate', value: 0, winner: 'black' });
    expect(parseUciEvaluation('info depth 0 score mate 0', false)?.score).toEqual({ kind: 'mate', value: 0, winner: 'white' });
  });
  it('ignores bounds, secondary variations and non-score output', () => {
    for (const line of ['info depth 5 score cp 300 lowerbound', 'info depth 5 score cp -200 upperbound', 'info depth 5 multipv 2 score cp 100', 'info string score cp 500', 'bestmove e2e4']) {
      expect(parseUciEvaluation(line, true)).toBeNull();
    }
  });
  it('maps equal, favorable and mating scores and formats small scores without negative zero', () => {
    expect(whiteEvaluationPercent({ kind: 'cp', value: 0 })).toBe(50);
    expect(whiteEvaluationPercent({ kind: 'cp', value: 100 })).toBeCloseTo(59.1026, 3);
    expect(whiteEvaluationPercent({ kind: 'cp', value: -100 })).toBeCloseTo(40.8974, 3);
    expect(whiteEvaluationPercent({ kind: 'mate', value: 0, winner: 'black' })).toBe(0);
    expect(formatEvaluation({ kind: 'cp', value: -1 })).toBe('0.0');
    expect(formatEvaluation({ kind: 'cp', value: 125 })).toBe('+1.3');
    expect(formatEvaluation({ kind: 'mate', value: -4, winner: 'black' })).toBe('-M4');
  });
});
