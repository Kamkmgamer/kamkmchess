import { describe, expect, it } from 'vitest';
import type { ReviewLine } from '../engines/review-score.js';
import { assessMove, expectedScore } from './grades.js';

function line(win: number, draw: number, move = 'e2e4'): ReviewLine {
  return { depth: 16, nodes: 100_000, multipv: 1, bound: 'exact', score: { kind: 'cp', value: 50 },
    wdl: { win, draw, loss: 1000 - win - draw }, pv: [move] };
}
function assess(best: ReviewLine, played: ReviewLine, second?: ReviewLine) {
  return assessMove({ best, played, second, uci: played.pv[0]!, bestSan: 'e4', legalCount: 20, confirmed: true });
}
describe('move grading policy', () => {
  it('uses expected points, including draw probability, from the same mover perspective', () => {
    expect(expectedScore(line(100, 800))).toBe(0.5);
    expect(assess(line(400, 500), line(0, 200, 'g2g4'))).toMatchObject({ grade: 'blunder', loss: 0.55 });
    // A Black root uses exactly the same mover-relative arithmetic.
    expect(assess(line(300, 600, 'e7e5'), line(0, 600, 'a7a6')).grade).toBe('blunder');
  });
  it('distinguishes equivalent moves from a confirmed strong move with poor alternatives', () => {
    const best = line(400, 500);
    expect(assess(best, line(390, 500, 'd2d4')).grade).toBe('good');
    expect(assess(best, best, { ...line(0, 600, 'd2d4'), multipv: 2 }).grade).toBe('great');
  });
  it('keeps shallow, bounded, or inconsistent assessments uncertain', () => {
    const best = line(300, 500);
    expect(assess({ ...best, depth: 4 }, line(0, 100)).grade).toBe('unreviewed');
    expect(assess({ ...best, bound: 'lower' }, line(0, 100)).grade).toBe('unreviewed');
    expect(assess(line(0, 100), line(500, 400)).grade).toBe('unreviewed');
  });
  it('does not mistake a shorter forced loss for a fresh blunder', () => {
    const best = { ...line(0, 0), score: { kind: 'mate' as const, value: -8 } };
    const played = { ...line(0, 0, 'd2d4'), score: { kind: 'mate' as const, value: -2 } };
    expect(assess(best, played)).toMatchObject({ grade: 'good', loss: 0 });
    expect(assess(line(200, 700), played).explanation).toBe('Allows a forced mate.');
  });
});
