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
import { createFetchFriendTransport, createFriendClient, isLocallyOwnedInvitation } from './friends';
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
  claimSeatCredential(invitationId: string, ownerToken: string): Promise<FriendSeatCredential>;
  /** Proposes a rematch of a finished match. */
  proposeRematch(matchId: string, request?: { timeControl?: TimeControl; startingFen?: string }): Promise<FriendRematch>;
  /**
   * Accepts a rematch offer.
   *
   * A guest that lost the answer of its acceptance rotates its credential, so
   * the recovery never depends on the lost answer.
   */
  acceptRematch(rematchId: string, request?: { rotateCredential?: boolean }): Promise<FriendRematchAccepted>;
  /** Reads the pending rematch offer of a match. */
  pendingRematch(matchId: string): Promise<FriendRematch | null>;
}

export interface FriendSurfaceOptions {
  /** The trusted service origin. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /**
   * The credential header of the active participant, or null.
   *
   * The header is minted per call, so the credential is never cached.
   */
  readonly credential?: () => Promise<Record<string, string> | null>;
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
  /** The invitations this browser already accepted. */
  const acceptedInvitations = new Set<string>();
  /**
   * The canonical client of one call.
   *
   * The credential is minted before the call and the canonical transport
   * carries it in the header.
   */
  async function clientFor(): Promise<FriendClient> {
    const header = options.credential ? await options.credential() : null;
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
      // invitation was already consumed by this browser.
      const rotateCredential = acceptedInvitations.has(invitationId);
      acceptedInvitations.add(invitationId);
      return (await clientFor()).acceptInvitation(invitationId, { control, acceptanceKey, rotateCredential });
    },
    async cancel(invitationId) {
      const ownerToken = options.secrets.readOwnerToken(invitationId);
      if (!ownerToken) throw new Error('This browser does not own the invitation.');
      return (await clientFor()).cancelInvitation(invitationId, ownerToken);
    },
    async claimSeatCredential(invitationId, ownerToken) {
      return (await clientFor()).claimSeatCredential(invitationId, ownerToken);
    },
    async proposeRematch(matchId, request) {
      return (await clientFor()).proposeRematch({
        matchId,
        ...(request?.timeControl ? { timeControl: request.timeControl } : {}),
        ...(request?.startingFen ? { startingFen: request.startingFen } : {}),
      });
    },
    async acceptRematch(rematchId, request) {
      return (await clientFor()).acceptRematch(rematchId, {
        ...(request?.rotateCredential === undefined ? {} : { rotateCredential: request.rotateCredential }),
      });
    },
    async pendingRematch(matchId) {
      return (await clientFor()).readPendingRematch(matchId);
    },
  };
}
