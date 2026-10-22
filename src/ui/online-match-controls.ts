/**
 * The online match controls of the screen (KHA-74).
 *
 * The module holds the decisions behind the match controls of the online
 * screen: which offers of the opponent are still open, the exact target
 * version of a takeback, the recovery actions the service allows, and the
 * commands those controls send. It is pure: it renders nothing, it owns no
 * state, and it never decides an outcome of its own.
 *
 * The rules this module keeps:
 *
 * - A draw offer is an offer, not an agreement. The confirmation copy says so,
 *   and the service still needs the consent of the opponent.
 * - A takeback names the exact version of the position it restores. The
 *   browser never invents a version: it reads the version of the position
 *   before the discarded move.
 * - The abandonment claim belongs to the service. The browser offers the claim
 *   only when the service published it, and it never infers a win from its own
 *   clock.
 * - "Keep waiting" never concedes a result. It only records that the owner
 *   waits for the opponent.
 * - The interface copy stays inside the twenty-word convention.
 */
import type { OnlineMatchCommandClient } from '../online/match-client.js';
import type { OnlineClaimInput, OnlinePresenceClient, OnlinePresenceView } from '../online/presence-client.js';
import type { OnlineMatchView, OnlineOfferView } from '../online/updates.js';
import type { Seat } from '../online/contracts.js';

/** The action the confirmation panel describes. */
export type OnlineConfirmAction = 'draw' | 'takeback' | 'resign';

/** The target of a takeback offer. */
export interface OnlineTakebackTarget {
  /** The exact version of the position the takeback restores. */
  readonly targetVersion: number;
  /** The number of the move the takeback discards. */
  readonly moveNumber: number;
}

/** The recovery actions the service allows for a match. */
export interface OnlineRecoveryState {
  /** True when the service published the abandonment claim. */
  readonly claimAllowed: boolean;
  /** True when the opponent is offline and the owner may keep waiting. */
  readonly keepWaitingAllowed: boolean;
  /** The honest note of the state. It is empty when there is nothing to say. */
  readonly note: string;
}

/**
 * The confirmation copy of an action.
 *
 * An offer that the opponent still has to accept is never described as a
 * final agreement, and a final action never hides that it cannot be undone.
 * A takeback names the move it discards, so the owner sees what it offers.
 */
export function onlineConfirmCopy(action: OnlineConfirmAction, moveNumber?: number): string {
  if (action === 'draw') return 'Offer a draw? The opponent must accept.';
  if (action === 'takeback') {
    if (moveNumber === undefined) return 'Offer a takeback? The opponent must accept.';
    return `Take back move ${moveNumber}? The opponent must accept.`;
  }
  return 'Resign this game? It cannot be undone.';
}

/** The accessible name of the confirmation group of an action. */
export function onlineConfirmLabel(action: OnlineConfirmAction): string {
  if (action === 'draw') return 'Confirm draw offer';
  if (action === 'takeback') return 'Confirm takeback offer';
  return 'Confirm resignation';
}

/**
 * The offers of the opponent that the owner may still answer.
 *
 * An ignored offer stays out of the list until the service publishes it
 * again, so an ignored offer never hides a newer one.
 */
export function onlineIncomingOffers(
  view: OnlineMatchView,
  yourSeat: Seat | null,
  ignored: readonly string[] = [],
): readonly OnlineOfferView[] {
  if (yourSeat === null) return [];
  return view.pendingOffers.filter(offer => offer.seat !== yourSeat && !ignored.includes(offer.offerId));
}

/** The offers of this browser that the opponent has not answered yet. */
export function onlineOwnOffers(view: OnlineMatchView, yourSeat: Seat | null): readonly OnlineOfferView[] {
  if (yourSeat === null) return [];
  return view.pendingOffers.filter(offer => offer.seat === yourSeat);
}

/**
 * The exact target version of a takeback that discards the last accepted move.
 *
 * The service restores the position of the named version, so the target is
 * the version of the position before the discarded move: the version of the
 * move before it, or the first version of the match for the opening move.
 */
export function onlineTakebackTarget(view: OnlineMatchView): OnlineTakebackTarget | null {
  const moves = view.moves;
  const last = moves[moves.length - 1];
  if (!last) return null;
  const index = moves.length - 1;
  const previous = index === 0 ? 1 : (moves[index - 1]?.version ?? 1);
  return { targetVersion: previous, moveNumber: index + 1 };
}

/**
 * The number of the move a takeback target discards.
 *
 * The target names a position of the current line, so the move that follows
 * it is the discarded one.
 */
export function onlineTakebackMoveNumber(view: OnlineMatchView, targetVersion: number): number | null {
  const moves = view.moves;
  for (let index = 0; index < moves.length; index += 1) {
    const previous = index === 0 ? 1 : (moves[index - 1]?.version ?? 1);
    if (previous === targetVersion) return index + 1;
  }
  return null;
}

/**
 * True when the service accepts a takeback offer for this match.
 *
 * The service needs a completed opening exchange, and it needs a match that
 * is still running. The check is a courtesy: the service decides again.
 */
export function onlineTakebackAllowed(view: OnlineMatchView): boolean {
  if (view.status !== 'active') return false;
  if (!view.clock.whiteMoved || !view.clock.blackMoved) return false;
  return view.moves.length > 0;
}

/** The note of an offer of the opponent. */
export function onlineIncomingOfferNote(view: OnlineMatchView, offer: OnlineOfferView): string {
  if (offer.kind === 'draw') return 'The opponent offered a draw.';
  const moveNumber = offer.targetVersion === null
    ? null
    : onlineTakebackMoveNumber(view, offer.targetVersion);
  if (moveNumber === null) return 'The opponent offered a takeback.';
  return `The opponent offered a takeback of move ${moveNumber}.`;
}

/** The note of an offer of this browser. */
export function onlineOwnOfferNote(view: OnlineMatchView, offer: OnlineOfferView): string {
  if (offer.kind === 'draw') return 'Draw offered. The opponent must accept.';
  const moveNumber = offer.targetVersion === null
    ? null
    : onlineTakebackMoveNumber(view, offer.targetVersion);
  if (moveNumber === null) return 'Takeback offered. The opponent must accept.';
  return `Takeback of move ${moveNumber} offered. The opponent must accept.`;
}

/**
 * The recovery actions the service allows.
 *
 * The panel appears only while the opponent is offline, and the claim appears
 * only when the service published it. The note never claims a win that the
 * service did not offer.
 *
 * A service that is not recovered offers nothing. It is not serving, so it
 * cannot confirm that the opponent is absent: the lease of the opponent may
 * have expired while the service was down. The claim is not offered and the
 * absence is not asserted, so a service outage is never read as an
 * abandonment.
 */
export function onlineRecoveryState(presence: OnlinePresenceView | null): OnlineRecoveryState {
  if (presence === null) return { claimAllowed: false, keepWaitingAllowed: false, note: '' };
  if (presence.status !== 'active') return { claimAllowed: false, keepWaitingAllowed: false, note: '' };
  const opponent = presence.seats.find(candidate => candidate.seat !== presence.yourSeat) ?? null;
  if (opponent === null || opponent.state !== 'offline') {
    return { claimAllowed: false, keepWaitingAllowed: false, note: '' };
  }
  if (!presence.recovered) {
    return { claimAllowed: false, keepWaitingAllowed: false, note: 'The service is not available. The claim waits for it.' };
  }
  const claimAllowed = presence.serviceState === 'healthy' && presence.claim.eligible === true;
  const keepWaitingAllowed = true;
  if (claimAllowed) {
    return {
      claimAllowed,
      keepWaitingAllowed,
      note: 'Your opponent is offline for a minute. You may claim the win.',
    };
  }
  if (presence.claim.reason === 'offline-grace-period' && presence.claim.graceSecondsLeft > 0) {
    return {
      claimAllowed,
      keepWaitingAllowed,
      note: `Your opponent is offline. The claim opens in ${presence.claim.graceSecondsLeft} seconds.`,
    };
  }
  return { claimAllowed, keepWaitingAllowed, note: 'Your opponent is offline. You may keep waiting.' };
}

/** Offers a draw to the opponent. */
export async function offerOnlineDraw(client: OnlineMatchCommandClient): Promise<void> {
  await client.offerDraw();
}

/** Accepts the draw offer of the opponent. */
export async function acceptOnlineDraw(client: OnlineMatchCommandClient, offerId: string): Promise<void> {
  await client.acceptDraw(offerId);
}

/** Accepts the takeback offer of the opponent. */
export async function acceptOnlineTakeback(client: OnlineMatchCommandClient, offerId: string): Promise<void> {
  await client.acceptTakeback(offerId);
}

/** Offers a takeback to the exact target version the service needs. */
export async function offerOnlineTakeback(client: OnlineMatchCommandClient, targetVersion: number): Promise<void> {
  await client.offerTakeback(targetVersion);
}

/** Records that the owner keeps waiting for the opponent. */
export async function keepOnlineWaiting(client: OnlinePresenceClient): Promise<void> {
  await client.keepWaiting();
}

/** Claims the win after the opponent stayed offline. */
export async function claimOnlineWin(client: OnlinePresenceClient, input: OnlineClaimInput): Promise<void> {
  await client.claimAbandonment(input);
}
