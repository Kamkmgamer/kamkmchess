/**
 * The invitations of the current identity (KHA-75).
 *
 * The product contract says that an invitation lasts twelve hours and that
 * the inviter may cancel it. The inviter therefore has to find its pending
 * invitation again after a reload or a navigation, and it has to be able to
 * cancel it there.
 *
 * The rules this module keeps:
 *
 * - The state of an invitation is the one the service published. The browser
 *   never infers it from its own clock, and it never shows an invitation of
 *   another identity.
 * - Only an open invitation can be cancelled. An accepted, a cancelled and an
 *   expired invitation are settled: they never produce a match.
 * - The owner token of an invitation never reaches the screen. The screen
 *   names the invitation and its state, nothing else.
 */
import type { FriendInvitation } from '../online/friend-routes.js';

/** The visible state of an invitation of the current identity. */
export type OwnedInvitationState = 'open' | 'accepted' | 'cancelled' | 'expired';

/**
 * The state of an invitation, as the screen names it.
 *
 * A consumed invitation is an accepted one: the invitee used it, so the
 * inviter follows the match instead of the link.
 */
export function ownedInvitationState(invitation: FriendInvitation): OwnedInvitationState {
  if (invitation.status === 'consumed') return 'accepted';
  return invitation.status;
}

/** The visible state of an invitation, as the screen names it. */
export function ownedInvitationStateLabel(invitation: FriendInvitation): string {
  switch (ownedInvitationState(invitation)) {
    case 'open': return 'Open';
    case 'accepted': return 'Accepted';
    case 'cancelled': return 'Cancelled';
    case 'expired': return 'Expired';
  }
}

/**
 * True when the owner may still cancel the invitation.
 *
 * Only an open invitation can be cancelled. Every other state is settled by
 * the service already.
 */
export function ownedInvitationCancelable(invitation: FriendInvitation): boolean {
  return invitation.status === 'open';
}

/**
 * The open invitation the screen may cancel.
 *
 * The invitation the owner is looking at is preferred, so the cancel action
 * names the invitation on the screen. A recovered invitation is the next one,
 * so the inviter cancels the pending invitation it finds after a reload.
 */
export function ownedInvitationCancelTarget(
  shown: FriendInvitation | null,
  owned: readonly FriendInvitation[],
  isOwned: (invitationId: string) => boolean,
): string | null {
  if (shown !== null && ownedInvitationCancelable(shown) && isOwned(shown.invitationId)) {
    return shown.invitationId;
  }
  for (const invitation of owned) {
    if (ownedInvitationCancelable(invitation)) return invitation.invitationId;
  }
  return null;
}

/**
 * True when the browser may accept the invitation on the screen.
 *
 * An invitation of another identity is accepted as usual: the guest and the
 * invitee keep their normal path. The invitation of this identity is never
 * accepted: the inviter cannot play both sides of its own game.
 */
export function ownedInvitationAcceptable(
  invitation: FriendInvitation | null,
  isOwned: (invitationId: string) => boolean,
): boolean {
  if (invitation === null) return false;
  if (invitation.status !== 'open') return false;
  return !isOwned(invitation.invitationId);
}
