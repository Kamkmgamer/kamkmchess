import { GRADE_LABELS } from '../review/grades.js';
import type { MoveGrade } from '../review/grades.js';
import { replaySeed } from '../review/replay.js';
import type { GameReview, ReviewedMove } from '../review/review.js';

export type RecapMode = 'replay' | 'highlights';
export interface RecapScene {
  readonly kind: 'intro' | 'move' | 'ending';
  readonly start: number;
  readonly duration: number;
  readonly move: ReviewedMove | null;
  readonly fen: string;
  readonly jump: boolean;
  readonly caption: string;
}
export interface RecapTimeline {
  readonly review: GameReview;
  readonly scenes: readonly RecapScene[];
  readonly duration: number;
  readonly bpm: number;
  readonly seed: number;
  readonly mode: RecapMode;
}

const INTEREST: Record<MoveGrade, number> = {
  great: 8, best: 1, good: 0, forced: 0, 'slight-inaccuracy': 2, inaccuracy: 3, mistake: 6, blunder: 9, unreviewed: 0,
};

function selectHighlights(moves: readonly ReviewedMove[]): Set<number> {
  const selected = new Set<number>();
  // Establish the opening and include the actual finish even in quiet games.
  for (let i = 0; i < Math.min(4, moves.length); i++) selected.add(i);
  for (let i = Math.max(0, moves.length - 5); i < moves.length; i++) selected.add(i);
  const candidates = moves.map((move, index) => ({ index, weight: INTEREST[move.grade] + (move.san.includes('#') ? 12 : move.san.includes('=') ? 5 : 0) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const centers: number[] = [];
  for (const candidate of candidates) {
    if (centers.length >= 6 || candidate.weight < 3 || centers.some(index => Math.abs(index - candidate.index) < 4)) continue;
    centers.push(candidate.index);
    for (let i = Math.max(0, candidate.index - 2); i <= Math.min(moves.length - 1, candidate.index + 2); i++) selected.add(i);
  }
  return selected;
}

export function resultCaption(review: GameReview): string {
  const { winner, reason } = review.replay.result;
  const reasons = { checkmate: 'checkmate', resignation: 'resignation', timeout: 'time', 'illegal-move': 'illegal moves',
    stalemate: 'stalemate', 'threefold-repetition': 'repetition', 'fifty-move-rule': 'the fifty-move rule',
    'dead-position': 'insufficient material', 'draw-agreement': 'agreement', abandonment: 'abandonment', 'opening-reply-timeout': 'the opening reply deadline' };
  return winner === 'draw' ? `Draw by ${reasons[reason]}` : `${winner === 'white' ? 'White' : 'Black'} wins by ${reasons[reason]}`;
}

export function planRecap(review: GameReview, mode: RecapMode = 'replay'): RecapTimeline {
  const scenes: RecapScene[] = [];
  const chosen = mode === 'highlights' ? selectHighlights(review.moves) : new Set(review.moves.map((_, index) => index));
  let time = 0;
  const add = (scene: Omit<RecapScene, 'start'>) => { scenes.push({ ...scene, start: time }); time += scene.duration; };
  add({ kind: 'intro', duration: 2, move: null, fen: review.replay.startingFen, jump: false, caption: mode === 'highlights' ? 'Game highlights' : 'Game replay' });
  let previous = -1;
  for (const [index, move] of review.moves.entries()) {
    if (!chosen.has(index)) continue;
    const important = INTEREST[move.grade] >= 3 || move.san.includes('#') || move.san.includes('=');
    const jump = index !== previous + 1;
    add({ kind: 'move', duration: important ? 3 : jump ? 2 : 1, move, fen: move.fenAfter, jump,
      caption: move.san.endsWith('#') ? 'Checkmate' : GRADE_LABELS[move.grade] });
    previous = index;
  }
  add({ kind: 'ending', duration: 4, move: review.moves.at(-1) ?? null,
    fen: review.moves.at(-1)?.fenAfter ?? review.replay.startingFen, jump: false, caption: resultCaption(review) });
  return { review, scenes, duration: time, bpm: 120,
    seed: replaySeed(JSON.stringify([review.replay.startingFen, review.moves.map(move => move.uci), review.replay.result.winner])), mode };
}

export function sceneAt(timeline: RecapTimeline, seconds: number): RecapScene {
  return timeline.scenes.find(scene => seconds < scene.start + scene.duration) ?? timeline.scenes.at(-1)!;
}
