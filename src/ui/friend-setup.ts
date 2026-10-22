/**
 * The setup of a friend invitation (KHA-75).
 *
 * The module owns the browser half of the setup of an invitation: the kind
 * of the invitation, the color of the inviter, the seat of the inviter, the
 * custom position and the canonical preview of an invitation.
 *
 * The rules this module keeps:
 *
 * - A named challenge names the public name of an account, so only a
 *   signed-in browser creates one. The service resolves the name to the
 *   account, so an authentication identifier never travels in a request. A
 *   guest shares a link, and a link never carries a recipient.
 * - The custom position is offered to the service as it was written. The
 *   service is the authority of the position, and the browser refuses an
 *   unparsable one before the request leaves the page.
 * - A friend seat is a human seat or the seat of the owner's own agent. There
 *   is no built-in engine seat in friend setup.
 * - The preview shows the inviter, the color of the inviter, the color the
 *   invitee receives, the clock and the custom position. It never names a
 *   pairing that was not agreed.
 */
import { parsePosition } from '../rules/index.js';
import type { Seat, SeatControl, TimeControl } from '../online/contracts.js';
import type { FriendInvitation } from '../online/friend-routes.js';

/** The two kinds of a friend invitation. */
export type FriendInvitationKind = 'link' | 'challenge';

/** The seat of a participant of a friend game. */
export type FriendSeatControl = 'human' | 'agent';

/** The request the service accepts. */
export interface FriendInvitationRequest {
  readonly kind: FriendInvitationKind;
  /**
   * The public name of the account a challenge names.
   *
   * A link never carries one. A public name is a public identity, so the
   * service resolves it to the account itself and the authentication
   * identifier of the recipient never travels in a request.
   */
  readonly recipientUsername?: string;
  readonly seat: Seat;
  readonly timeControl: TimeControl;
  /** The custom position, or nothing for the standard position. */
  readonly startingFen?: string;
  readonly control: SeatControl;
}

/** The setup the owner chose. */
export interface FriendSetupInput {
  readonly kind: FriendInvitationKind;
  /** The color of the inviter. */
  readonly seat: Seat;
  /** The seat of the inviter. */
  readonly control: FriendSeatControl;
  /** The account a challenge names, by its public name. */
  readonly recipient: string;
  /** The custom position of the game. */
  readonly startingFen: string;
  readonly timeControl: TimeControl;
  /** The public label of the own agent of the owner. */
  readonly modelLabel: string | null;
  /** True when a signed-in account owns the browser. */
  readonly accountSignedIn: boolean;
}

/** The request of the service, or the reason it is refused. */
export type FriendSetupResult =
  | { readonly ok: true; readonly request: FriendInvitationRequest }
  | { readonly ok: false; readonly message: string };

/**
 * True when a custom position can be offered to the service.
 *
 * The service refuses an unplayable position. The browser refuses an
 * unparsable one before the request leaves the page, so the owner reads the
 * reason without a round trip.
 */
export function isPlayableFen(fen: string): boolean {
  try {
    parsePosition(fen);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the request of one friend invitation.
 *
 * The answer is the request the service accepts, or the reason the browser
 * refuses to send one. The browser never sends a request it cannot honour:
 * a challenge without an account, a challenge without a recipient, an
 * unparsable position and an agent seat without a model are all refused
 * here.
 */
export function friendInvitationRequest(input: FriendSetupInput): FriendSetupResult {
  const recipient = input.recipient.trim();
  const startingFen = input.startingFen.trim();
  if (input.kind === 'challenge') {
    // A named challenge names an account, so only a signed-in browser may
    // create one. A guest shares a link.
    if (!input.accountSignedIn) return { ok: false, message: 'Sign in to challenge a friend.' };
    if (recipient.length === 0) return { ok: false, message: 'Enter the recipient username.' };
  }
  if (startingFen.length > 0 && !isPlayableFen(startingFen)) {
    return { ok: false, message: 'The position is not a valid FEN.' };
  }
  if (input.control === 'agent' && (input.modelLabel === null || input.modelLabel.length === 0)) {
    return { ok: false, message: 'Choose your agent first.' };
  }
  return {
    ok: true,
    request: {
      kind: input.kind,
      // A link has no named recipient. The service refuses one.
      ...(input.kind === 'challenge' ? { recipientUsername: recipient } : {}),
      seat: input.seat,
      timeControl: input.timeControl,
      ...(startingFen.length > 0 ? { startingFen } : {}),
      control: input.control === 'agent'
        ? { kind: 'agent', modelLabel: input.modelLabel as string }
        : { kind: 'human' },
    },
  };
}

/**
 * The canonical preview text of one invitation.
 *
 * The custom position is part of the text, so the invitee reads the board the
 * inviter chose before the acceptance.
 */
export function friendInvitationPreview(invitation: FriendInvitation): string {
  const clock = `${Math.round(invitation.timeControl.startingTimeMs / 60_000)}+${Math.round(invitation.timeControl.incrementMs / 1000)}`;
  const yourSeat = invitation.inviterSeat === 'white' ? 'black' : 'white';
  const parts = [invitation.inviterLabel, invitation.inviterSeat, `Your color ${yourSeat}`, clock];
  if (invitation.startingFen) parts.push(`Custom position: ${invitation.startingFen}`);
  return parts.join(' · ');
}
