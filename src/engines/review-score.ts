export interface ReviewScore {
  readonly kind: 'cp' | 'mate';
  readonly value: number;
}

export interface ReviewLine {
  readonly depth: number;
  readonly nodes: number;
  readonly multipv: number;
  readonly bound: 'exact' | 'lower' | 'upper';
  readonly score: ReviewScore;
  readonly wdl: { readonly win: number; readonly draw: number; readonly loss: number } | null;
  readonly pv: readonly string[];
}

const coordinate = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
export function isUciMove(value: string): boolean { return coordinate.test(value); }

/** Review values retain the UCI root perspective, including Black-to-move roots. */
export function parseReviewLine(line: string): ReviewLine | null {
  if (!line.startsWith('info ')) return null;
  const score = /\bscore (cp|mate) (-?\d+)\b/.exec(line);
  const depth = /\bdepth (\d+)\b/.exec(line);
  const nodes = /\bnodes (\d+)\b/.exec(line);
  const multipv = /\bmultipv (\d+)\b/.exec(line);
  const pv = /\bpv ((?:[a-h][1-8][a-h][1-8][qrbn]?\s*)+)$/.exec(line);
  if (!score || !depth) return null;
  const values = [Number(score[2]), Number(depth[1]), Number(nodes?.[1] ?? 0), Number(multipv?.[1] ?? 1)];
  if (!values.every(Number.isSafeInteger) || values[3]! < 1) return null;
  const wdlMatch = /\bwdl (\d+) (\d+) (\d+)\b/.exec(line);
  const wdl = wdlMatch ? { win: Number(wdlMatch[1]), draw: Number(wdlMatch[2]), loss: Number(wdlMatch[3]) } : null;
  if (wdl && (wdl.win + wdl.draw + wdl.loss !== 1000 || Object.values(wdl).some(value => value > 1000))) return null;
  return {
    depth: values[1]!, nodes: values[2]!, multipv: values[3]!,
    bound: /\blowerbound\b/.test(line) ? 'lower' : /\bupperbound\b/.test(line) ? 'upper' : 'exact',
    score: { kind: score[1] === 'mate' ? 'mate' : 'cp', value: values[0]! },
    wdl, pv: pv ? pv[1]!.trim().split(/\s+/) : [],
  };
}

/** A completed candidate set must come from one exact search iteration. */
export class ReviewIterations {
  private current: ReviewLine[] = [];
  private complete: readonly ReviewLine[] = [];
  constructor(private readonly count: number) {}

  accept(line: ReviewLine): void {
    if (line.multipv === 1) this.current = [];
    if (line.bound !== 'exact' || !line.pv.length || line.multipv !== this.current.length + 1) return;
    if (this.current.length && this.current[0]!.depth !== line.depth) return;
    this.current.push(line);
    if (this.current.length === this.count) this.complete = [...this.current];
  }

  result(): readonly ReviewLine[] { return this.complete; }
}
