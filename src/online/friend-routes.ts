/**
 * The browser adapter of the friend surface (KHA-75).
 *
 * The adapter owns the browser half of the friend flow: the acceptance key
 * of an accept intent, the owner token of an invitation this browser
 * created, and the guard that keeps the browser from accepting its own
 * invitation. The wire itself belongs to the canonical client of the
 * matching worker, `src/online/friends.ts`.
 *
 * The rules this module keeps:
 *
 * - The acceptance key is written before the acceptance is sent and it is
 *   reused on every retry. A lost answer therefore replays the same key, and
 *   a reload finds it again. The guest never needs the credential of a lost
 *   answer to recover.
 * - The browser never accepts an invitation it created itself. The owner
 *   token of the invitation is the proof.
 * - The owner token stays in the browser. It is the recoverable ownership of
 *   the invitation and of the created match.
 * - The credential travels in a request header. It never travels in a URL, a
 *   query string or a body.
 */
import { createFetchFriendTransport, createFriendClient, isLocallyOwnedInvitation, FriendError } from './friends';
import type {
  FriendClient,
  FriendSeatCredential,
  FriendInvitation,
  FriendInvitationAccepted,
  FriendInvitationCreated,
  FriendRematch,
  FriendRematchAccepted,
} from './friends';
import type { FriendSecretStore } from './friend-secrets.js';
export type { FriendClient, FriendInvitation, FriendInvitationCreated, FriendRematch, FriendRematchAccepted } from './friends.js';
import type { Seat, SeatControl, TimeControl } from './contracts';

/** The answer of an accepted invitation. */
export type FriendAcceptance = FriendInvitationAccepted;

/** The client of the friend surface of this browser. */
export interface FriendSurface {
  /** Creates one shareable link or one named challenge. */
  create(request: {
    kind?: 'link' | 'challenge';
    recipientAccountId?: string;
    seat: Seat;
    timeControl: TimeControl;
    startingFen?: string;
    control: SeatControl;
  }): Promise<FriendInvitationCreated>;
  /** Reads the link preview. */
  preview(invitationId: string): Promise<FriendInvitation>;
  /**
   * Accepts an invitation.
   *
   * The acceptance key is the stored key of the accept intent, so a retry
   * after a lost answer reaches the same invitation.
   */
  accept(invitationId: string, control: SeatControl): Promise<FriendAcceptance>;
  /** Cancels an invitation this browser created. */
  cancel(invitationId: string): Promise<FriendInvitation>;
  /** Claims the seat credential of the inviter of a consumed invitation. */
  claimSeatCredential(invitationId: string, ownerToken: string, matchId?: string | null): Promise<FriendSeatCredential>;
  /** Proposes a rematch of a finished match. */
  proposeRematch(matchId: string, request?: { timeControl?: TimeControl; startingFen?: string }): Promise<FriendRematch>;
  /**
   * Accepts a rematch offer.
   *
   * A guest that lost the answer of its acceptance rotates its credential, so
   * the recovery never depends on the lost answer.
   */
  acceptRematch(rematchId: string, request?: { rotateCredential?: boolean; matchId?: string }): Promise<FriendRematchAccepted>;
  /** Claims the seat credential of the proposer of an accepted rematch. */
  claimRematchSeatCredential(rematchId: string, matchId?: string | null): Promise<FriendSeatCredential>;
  /** Reads the pending rematch offer of a match. */
  pendingRematch(matchId: string): Promise<FriendRematch | null>;
}

export interface FriendSurfaceOptions {
  /** The trusted service origin. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /**
   * The credential of the participant that acts on a match.
   *
   * The credential is bound to the match of the call, so a guest acts with
   * the seat credential of its own match and never with the credential of
   * another match.
   */
  readonly credentialFor?: (matchId: string | null) => Promise<Record<string, string> | null>;
  /** The browser owned secrets of the surface. */
  readonly secrets: FriendSecretStore;
}

/**
 * Creates the browser adapter of the friend surface.
 *
 * The adapter delegates every wire call to the canonical client of the
 * matching worker. It adds only the browser owned parts.
 */
export function createFriendSurface(options: FriendSurfaceOptions): FriendSurface {
  /** The invitations this browser created. */
  const ownedInvitations = new Set<string>();
  /**
   * The canonical client of one call.
   *
   * The credential is minted before the call and the canonical transport
   * carries it in the header.
   */
  async function clientFor(matchId: string | null = null): Promise<FriendClient> {
    const header = options.credentialFor ? await options.credentialFor(matchId) : null;
    return createFriendClient(createFetchFriendTransport({
      baseUrl: options.baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      credential: () => header,
    }));
  }

  return {
    async create(request) {
      const created = await (await clientFor()).createInvitation(request);
      // The owner token is the recoverable ownership of the invitation. It
      // stays in the browser.
      options.secrets.rememberOwnerToken(created.invitation.invitationId, created.ownerToken);
      ownedInvitations.add(created.invitation.invitationId);
      return created;
    },
    async preview(invitationId) {
      return (await clientFor()).readInvitation(invitationId);
    },
    async accept(invitationId, control) {
      if (isLocallyOwnedInvitation(invitationId, ownedInvitations) || options.secrets.ownsInvitation(invitationId)) {
        // The browser created the invitation. It cannot accept its own
        // invitation, and it does not consume it. The check also consults the
        // persisted secrets, so a reload still refuses it.
        throw new Error('This browser created the invitation.');
      }
      // The key is stored before the acceptance is sent, so a lost answer
      // replays the same key and a reload finds it again.
      const acceptanceKey = options.secrets.acceptanceKey(invitationId);
      // A first acceptance never rotates a credential. A retry of the same
      // accept intent asks for the explicit recovery once, because the
      // invitation was already consumed by this browser. The record is
      // durable, so a reload still recovers.
      const rotateCredential = options.secrets.beginAcceptance(invitationId);
      // The token of the records is captured before the acceptance is sent.
      const context = options.secrets.context;
      try {
        const accepted = await (await clientFor()).acceptInvitation(invitationId, { control, acceptanceKey, rotateCredential });
        if (options.secrets.context !== context) {
          // The identity changed while the acceptance was on the wire. The
          // record of the previous identity never reaches the current one,
          // and the intent of the current one is never cleared. The
          // acceptance intent of the identity that started the attempt
          // stays, so the seat of that identity stays recoverable.
          return accepted;
        }
        // The credential of the seat is remembered before the acceptance is
        // forgotten, so a reload still owns the seat of the match. A lost
        // answer keeps the marker, so the next attempt asks for the explicit
        // recovery once. A credential that did not reach the device keeps the
        // marker too: the record would be lost with the page.
        if (accepted.guestCredential) {
          const durable = options.secrets.rememberAcceptedSeat(invitationId, {
            guestId: accepted.guestCredential.guestId,
            matchId: accepted.guestCredential.matchId,
            seat: accepted.guestCredential.seat,
            token: accepted.guestCredential.token,
          });
          if (durable) {
            // The credential reached the device, so a reload finds it and the
            // next attempt is a first acceptance.
            options.secrets.forgetAcceptance(invitationId);
          }
          // A credential that did not reach the device keeps the acceptance
          // intent: the record would be lost with the page, so the next
          // attempt asks the service for the explicit recovery of the
          // credential, because the invitation was probably consumed by this
          // attempt.
        } else {
          // The seat needs no seat credential: the account credential
          // authorizes it. The acceptance intent is settled.
          options.secrets.forgetAcceptance(invitationId);
        }
        return accepted;
      } catch (error) {
        // A refusal proves that the invitation was not consumed by this
        // attempt, so the acceptance intent is forgotten and the next attempt
        // is a first acceptance. A conflict and an unknown failure keep the
        // marker: the invitation may have been consumed, so the next attempt
        // asks for the explicit recovery once. An answer of an older identity
        // never clears the intent of the current one.
        const refused = error instanceof FriendError
          && error.status >= 400
          && error.status < 500
          && error.status !== 409;
        if (refused && options.secrets.context === context) options.secrets.forgetAcceptance(invitationId);
        throw error;
      }
    },
    async cancel(invitationId) {
      const ownerToken = options.secrets.readOwnerToken(invitationId);
      if (!ownerToken) throw new Error('This browser does not own the invitation.');
      return (await clientFor()).cancelInvitation(invitationId, ownerToken);
    },
    async claimSeatCredential(invitationId, ownerToken, matchId) {
      return (await clientFor(matchId ?? null)).claimSeatCredential(invitationId, ownerToken);
    },
    async proposeRematch(matchId, request) {
      return (await clientFor(matchId)).proposeRematch({
        matchId,
        ...(request?.timeControl ? { timeControl: request.timeControl } : {}),
        ...(request?.startingFen ? { startingFen: request.startingFen } : {}),
      });
    },
    async acceptRematch(rematchId, request) {
      return (await clientFor(request?.matchId ?? null)).acceptRematch(rematchId, {
        ...(request?.rotateCredential === undefined ? {} : { rotateCredential: request.rotateCredential }),
      });
    },
    async claimRematchSeatCredential(rematchId, matchId) {
      return (await clientFor(matchId ?? null)).claimRematchSeatCredential(rematchId);
    },
    async pendingRematch(matchId) {
      return (await clientFor(matchId)).readPendingRematch(matchId);
    },
  };
}
