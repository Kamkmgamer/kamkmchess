import { applyCoordinateMove, legalMoves, parsePosition } from '../rules/index.js';
import type { CoordinateMove } from '../rules/index.js';
import type { GameCheckpointV1, GameResultV1 } from '../storage/types.js';

export interface ReplayMove {
  readonly uci: string;
  readonly san: string;
  readonly label: string;
  readonly side: 'white' | 'black';
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly capture: boolean;
}

type StoredFinalResult = Extract<GameResultV1, { kind: 'final' }>;
export type RecapResult = Omit<StoredFinalResult, 'reason'> & { readonly reason: StoredFinalResult['reason'] | 'abandonment' | 'opening-reply-timeout' };

export interface GameReplay {
  readonly gameId: string;
  readonly scope: string;
  readonly lineId: string;
  readonly startingFen: string;
  readonly moves: readonly ReplayMove[];
  readonly result: RecapResult;
  readonly players: { readonly white: string; readonly black: string };
}

export function coordinateText(move: CoordinateMove): string { return move.from + move.to + (move.promotion ?? ''); }

/** Copies only public chess facts. The game archive and provider traffic never enter a recap. */
export function captureReplay(checkpoint: Pick<GameCheckpointV1, 'gameId' | 'namespace' | 'rules' | 'archive' | 'extensions'> & { readonly result: GameResultV1 | RecapResult }, players: GameReplay['players']): GameReplay {
  if (checkpoint.result.kind !== 'final') throw new Error('Finish the game before making a video.');
  const source = checkpoint.extensions['hosted-replay']?.data;
  if (source && typeof source === 'object' && !Array.isArray(source) && source.complete === false) throw new Error('The full game history is unavailable. Reopen the complete game and retry.');
  if (source && typeof source === 'object' && !Array.isArray(source) && (source.resultKind === 'abort' || source.resultReason === 'abort')) throw new Error('A completed, scored game is needed for a video.');
  let reason: RecapResult['reason'] = checkpoint.result.reason;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    if (source.resultReason === 'abandonment') reason = 'abandonment';
    if (source.resultReason === 'opening_reply_timeout') reason = 'opening-reply-timeout';
  }
  let position = parsePosition(checkpoint.rules.startingFen);
  const moves: ReplayMove[] = [];
  for (const saved of checkpoint.rules.moves) {
    const move = legalMoves(position).find(candidate => coordinateText(candidate) === saved.from + saved.to + (saved.promotion ?? ''));
    if (!move || saved.fenBefore !== position.fen) throw new Error('The game history is incomplete. Reopen the game and retry.');
    const next = applyCoordinateMove(position, move);
    if (next.position.fen !== saved.fenAfter || next.san !== saved.san) throw new Error('The game history could not be verified.');
    moves.push(Object.freeze({
      uci: coordinateText(move), san: next.san,
      label: `${position.fullmoveNumber}${position.sideToMove === 'w' ? '.' : '...'}${next.san}`,
      side: position.sideToMove === 'w' ? 'white' : 'black',
      fenBefore: position.fen, fenAfter: next.position.fen, capture: next.isCapture,
    }));
    position = next.position;
  }
  if (position.fen !== checkpoint.rules.currentFen) throw new Error('The game history does not match the final board.');
  return Object.freeze({ gameId: checkpoint.gameId, scope: checkpoint.namespace.kind === 'guest' ? 'guest' : `account:${checkpoint.namespace.accountId}`, lineId: checkpoint.archive.currentLine.lineId,
    startingFen: checkpoint.rules.startingFen, moves: Object.freeze(moves), result: Object.freeze({ ...checkpoint.result, reason }),
    players: Object.freeze({ white: players.white.slice(0, 100), black: players.black.slice(0, 100) }),
  });
}

/** An inexpensive deterministic seed for music; storage keys retain the full replay identity. */
export function replaySeed(text: string): number {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
  return seed >>> 0;
}
