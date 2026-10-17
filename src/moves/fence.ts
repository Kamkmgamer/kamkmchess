import type { ChessSideV1 } from '../storage/index.js';

/**
 * The identity one model reply must still carry to act on the pending turn.
 *
 * A repeated FEN is not identity: the same board can return after Undo, a switch or a
 * restore, so the fence compares the game, segment, side, position revision, request
 * generation and ownership epoch. The controller owns generation authority; this module
 * only answers whether a reply is still eligible to be applied.
 */
export interface TurnReplyFence {
  readonly gameId: string;
  readonly segmentId: string;
  readonly side: ChessSideV1;
  readonly positionRevision: number;
  readonly requestGeneration: number;
  readonly ownershipEpoch: number;
}

export interface FencedReply {
  readonly fence: TurnReplyFence;
  readonly handled: boolean;
}

export function createFencedReply(fence: TurnReplyFence): FencedReply {
  return Object.freeze({ fence, handled: false });
}

/** True only for an unhandled reply that still matches every fenced field. */
export function acceptsReply(turn: TurnReplyFence, reply: FencedReply): boolean {
  if (reply.handled) return false;
  return (
    reply.fence.gameId === turn.gameId &&
    reply.fence.segmentId === turn.segmentId &&
    reply.fence.side === turn.side &&
    reply.fence.positionRevision === turn.positionRevision &&
    reply.fence.requestGeneration === turn.requestGeneration &&
    reply.fence.ownershipEpoch === turn.ownershipEpoch
  );
}

/**
 * Marks a reply as already handled. Applying one move twice would spend a second attempt,
 * add a second increment or replace a result, so the caller must apply each reply once.
 */
export function markReplyHandled(reply: FencedReply): FencedReply {
  return Object.freeze({ fence: reply.fence, handled: true });
}