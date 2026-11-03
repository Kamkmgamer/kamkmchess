import type { ReviewLine, ReviewScore } from '../engines/review-score.js';

export type MoveGrade = 'great' | 'best' | 'good' | 'slight-inaccuracy' | 'inaccuracy' | 'mistake' | 'blunder' | 'forced' | 'unreviewed';
export const GRADE_LABELS: Record<MoveGrade, string> = {
  great: 'Great', best: 'Best', good: 'Good', 'slight-inaccuracy': 'Slight inaccuracy', inaccuracy: 'Inaccuracy',
  mistake: 'Mistake', blunder: 'Blunder', forced: 'Forced', unreviewed: 'Uncertain',
};
export interface MoveAssessment {
  readonly grade: MoveGrade;
  readonly loss: number | null;
  readonly playedScore: ReviewScore;
  readonly bestMove: string;
  readonly bestSan: string;
  readonly depth: number;
  readonly explanation: string;
}

export function expectedScore(line: ReviewLine): number | null {
  if (line.score.kind === 'mate') return line.score.value > 0 ? 1 : 0;
  return line.wdl ? (line.wdl.win + line.wdl.draw / 2) / 1000 : null;
}

export function assessMove(options: {
  best: ReviewLine; played: ReviewLine; second: ReviewLine | undefined; uci: string;
  bestSan: string; legalCount: number; confirmed: boolean;
}): MoveAssessment {
  const { best, played, second, uci, bestSan, legalCount, confirmed } = options;
  const bestValue = expectedScore(best);
  const playedValue = expectedScore(played);
  const loss = bestValue === null || playedValue === null ? null : Math.max(0, bestValue - playedValue);
  const stable = confirmed && best.bound === 'exact' && played.bound === 'exact'
    && best.depth >= 8 && played.depth >= 8 && bestValue !== null && playedValue !== null && playedValue <= bestValue + 0.03;
  let grade: MoveGrade = 'unreviewed';
  let explanation = 'Stockfish needs a deeper search here.';
  const primary = best.pv[0] === uci;
  if (legalCount === 1) { grade = 'forced'; explanation = 'The only legal move.'; }
  else if (stable && loss !== null) {
    grade = loss < 0.02 ? primary ? 'best' : 'good' : loss < 0.05 ? 'slight-inaccuracy'
      : loss < 0.10 ? 'inaccuracy' : loss < 0.20 ? 'mistake' : 'blunder';
    const alternative = second ? expectedScore(second) : null;
    if (primary && loss < 0.02 && second?.bound === 'exact' && second.depth === best.depth
      && alternative !== null && bestValue! - alternative >= 0.10) grade = 'great';
    explanation = grade === 'great' ? 'A strong move with much weaker alternatives.'
      : grade === 'best' ? "Stockfish's first choice."
      : grade === 'good' ? 'Keeps the position on track.' : `Stockfish prefers ${bestSan}.`;
    if (best.score.kind !== 'mate' && played.score.kind === 'mate' && played.score.value < 0) explanation = 'Allows a forced mate.';
    else if (best.score.kind === 'mate' && best.score.value > 0 && (played.score.kind !== 'mate' || played.score.value < 0)) explanation = 'Misses a mating continuation.';
    // Mate distance alone never makes an already losing move a blunder.
    if (best.score.kind === 'mate' && best.score.value < 0 && played.score.kind === 'mate' && played.score.value < 0) {
      grade = primary ? 'best' : 'good'; explanation = 'The position was already losing.';
    }
  }
  return { grade, loss, playedScore: played.score, bestMove: best.pv[0] ?? uci, bestSan,
    depth: Math.min(best.depth, played.depth), explanation };
}
