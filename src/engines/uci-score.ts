export type EvaluationScore = { kind: 'cp'; value: number } | { kind: 'mate'; value: number; winner: 'white' | 'black' };
export interface EngineEvaluation { score: EvaluationScore; depth: number }

/** UCI scores are relative to the root side to move. The UI always uses White's perspective. */
export function parseUciEvaluation(line: string, whiteToMove: boolean): EngineEvaluation | null {
  if (!line.startsWith('info ') || /\b(?:lowerbound|upperbound)\b/.test(line)) return null;
  const pv = /\bmultipv (\d+)\b/.exec(line);
  if (pv && pv[1] !== '1') return null;
  const match = /\bscore (cp|mate) (-?\d+)\b/.exec(line);
  const depth = /\bdepth (\d+)\b/.exec(line);
  if (!match || !depth) return null;
  const raw = Number(match[2]);
  if (!Number.isSafeInteger(raw)) return null;
  const value = (whiteToMove ? raw : -raw) || 0;
  const score: EvaluationScore = match[1] === 'cp' ? { kind: 'cp', value }
    : { kind: 'mate', value, winner: (raw > 0) === whiteToMove ? 'white' : 'black' };
  return { score, depth: Number(depth[1]) };
}

export function whiteEvaluationPercent(score: EvaluationScore): number {
  if (score.kind === 'mate') return score.winner === 'white' ? 100 : 0;
  // Same centipawn scale as Lichess's published winning-chances model.
  return 50 * (1 + Math.tanh(Math.max(-1000, Math.min(1000, score.value)) * 0.00368208 / 2));
}

export function formatEvaluation(score: EvaluationScore): string {
  if (score.kind === 'mate') return `${score.winner === 'black' ? '-' : ''}M${Math.abs(score.value)}`;
  const pawns = (score.value / 100).toFixed(1);
  return Number(pawns) === 0 ? '0.0' : `${score.value > 0 ? '+' : ''}${pawns}`;
}
