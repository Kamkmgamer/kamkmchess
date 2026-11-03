import { describe, expect, it } from 'vitest';
import { parseReviewLine, ReviewIterations } from './review-score.js';

describe('UCI review iterations', () => {
  it('keeps scores in root perspective and validates WDL totals', () => {
    expect(parseReviewLine('info depth 15 multipv 1 score cp -60 wdl 10 600 390 nodes 10000 pv e7e5 g1f3')).toMatchObject({
      depth: 15, score: { kind: 'cp', value: -60 }, wdl: { win: 10, draw: 600, loss: 390 }, pv: ['e7e5', 'g1f3'],
    });
    expect(parseReviewLine('info depth 15 score cp 0 wdl 10 600 900 pv e7e5')).toBeNull();
  });
  it('retains a complete exact iteration when later candidates are bounded or at different depths', () => {
    const collector = new ReviewIterations(2);
    for (const text of [
      'info depth 8 multipv 1 score cp 50 pv e2e4', 'info depth 8 multipv 2 score cp 40 pv d2d4',
      'info depth 9 multipv 1 score cp 60 pv e2e4', 'info depth 8 multipv 2 score cp 45 pv d2d4',
      'info depth 10 multipv 1 score cp 80 lowerbound pv e2e4', 'info depth 10 multipv 2 score cp 30 pv d2d4',
    ]) collector.accept(parseReviewLine(text)!);
    expect(collector.result().map(line => [line.depth, line.multipv, line.score.value])).toEqual([[8, 1, 50], [8, 2, 40]]);
  });
});
