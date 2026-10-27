import type { Color, PieceType, Position } from '../rules/index.js';

/** Standard material values for the advantage badge; kings are never captured. */
const MATERIAL_VALUES: Record<Exclude<PieceType, 'k'>, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const ORDER: readonly (Exclude<PieceType, 'k'>)[] = ['q', 'r', 'b', 'n', 'p'];

type MaterialCounts = Record<Exclude<PieceType, 'k'>, number>;

function emptyCounts(): MaterialCounts {
  return { p: 0, n: 0, b: 0, r: 0, q: 0 };
}

/** Counts the pieces of one FEN placement field; the starting position may be any edited setup. */
function placementCounts(placement: string): Record<Color, MaterialCounts> {
  const counts: Record<Color, MaterialCounts> = { w: emptyCounts(), b: emptyCounts() };
  for (const character of placement) {
    if (character === '/') continue;
    if (character >= '1' && character <= '8') continue;
    const color: Color = character === character.toUpperCase() ? 'w' : 'b';
    const type = character.toLowerCase() as Exclude<PieceType, 'k'>;
    if (type in counts[color]) counts[color][type] += 1;
  }
  return counts;
}

/** A promoted pawn left the board without being captured, so it must not appear as a capture. */
export interface MoveWithPromotion {
  readonly promotion?: string | null;
  readonly fenBefore: string;
}

export interface CapturedSummary {
  /** Pieces this color has taken from the opponent, most valuable first. */
  readonly capturedByWhite: readonly PieceType[];
  readonly capturedByBlack: readonly PieceType[];
  /** Material difference in pawns; positive means White is ahead. */
  readonly advantage: number;
}

/**
 * Derives the captured pieces and the material score by comparing a position with the
 * starting setup. Promotions are compensated, so only real captures are listed. When a
 * promoted piece replaces a captured one of the same type the icon tray under-counts by
 * that piece; the material score itself stays exact either way.
 */
export function capturedSummary(startingFen: string, position: Position, moves: readonly MoveWithPromotion[] = []): CapturedSummary {
  const start = placementCounts(startingFen.split(' ')[0] ?? '');
  const live = placementCounts(position.placement);
  const promoted: Record<Color, number> = { w: 0, b: 0 };
  for (const move of moves) {
    if (move.promotion === undefined || move.promotion === null) continue;
    const mover = (move.fenBefore.split(' ')[1] ?? 'w') === 'b' ? 'b' : 'w';
    promoted[mover] += 1;
  }
  const captured = (taker: Color): PieceType[] => {
    const victim: Color = taker === 'w' ? 'b' : 'w';
    const taken: PieceType[] = [];
    for (const type of ORDER) {
      let missing = start[victim][type] - live[victim][type];
      if (type === 'p') missing -= promoted[victim];
      for (let i = 0; i < missing; i += 1) taken.push(type);
    }
    return taken;
  };
  const material = (color: Color): number =>
    ORDER.reduce((sum, type) => sum + live[color][type] * MATERIAL_VALUES[type], 0);
  return {
    capturedByWhite: captured('w'),
    capturedByBlack: captured('b'),
    advantage: material('w') - material('b'),
  };
}
