/**
 * The friend invitation and rematch routes (KHA-75).
 *
 * The adapter calls the friend routes of the service. It owns no friend rule:
 * the service owns the invitation lifetime, the one-use consumption, the
 * seat assignment and the rematch consent.
 *
 * The wire contract is the one of the participant API:
 *
 * ```
 * POST /v1/online/invitations                    create a link or a challenge
 * GET  /v1/online/invitations/{invitationId}      the link preview
 * POST /v1/online/invitations/{invitationId}/accept
 * POST /v1/online/invitations/{invitationId}/cancel
 * POST /v1/online/invitations/{invitationId}/seat-credential
 * POST /v1/online/rematches                       propose a rematch
 * POST /v1/online/rematches/{rematchId}/accept
 * POST /v1/online/rematches/{rematchId}/seat-credential
 * GET  /v1/online/matches/{matchId}/rematch      the pending rematch offer
 * ```
 *
 * The rules this module keeps:
 *
 * - The credential travels in a request header. It never travels in a URL, a
 *   query string or a body.
 * - The creation answer is wrapped (`invitation` and `ownerToken`), the
 *   preview answer is the invitation itself, and the acceptance answer is an
 *   envelope that carries the participant match view.
 * - A guest acceptance carries an acceptance key. The key is generated once
 *   per accept intent and reused on every retry, so a lost answer never
 *   consumes a second invitation.
 * - The owner token is the inviter's recoverable ownership. It is returned
 *   once and never stored by the service in readable form.
 */
import { ONLINE_CONTRACTS_SCHEMA_VERSION } from './contracts';
import type { Seat, SeatControl, TimeControl } from './contracts';
import type { OnlineMatchView } from './updates';

/** The public view of one invitation. */
export interface FriendInvitation {
  readonly schemaVersion: number;
  readonly invitationId: string;
  readonly kind: 'link' | 'challenge';
  readonly status: 'open' | 'consumed' | 'cancelled' | 'expired';
  readonly inviterLabel: string;
  readonly inviterSeat: Seat;
  readonly inviterControl: SeatControl;
  readonly timeControl: TimeControl;
  readonly startingFen: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt: string | null;
  readonly cancelledAt: string | null;
  readonly matchId: string | null;
}

/** The answer of an invitation creation. */
export interface FriendInvitationCreated {
  readonly schemaVersion: number;
  readonly invitation: FriendInvitation;
  /** The inviter's recoverable ownership secret. */
  readonly ownerToken: string;
}

/** The private credential of a guest seat. */
export interface FriendGuestCredential {
  readonly guestId: string;
  readonly matchId: string;
  readonly seat: Seat;
  readonly token: string;
  readonly expiresAt: string;
}

/** The answer of an accepted invitation. */
export interface FriendInvitationAccepted {
  readonly schemaVersion: number;
  readonly match: OnlineMatchView;
  readonly seat: Seat;
  readonly acceptanceId: string;
  readonly guestCredential: FriendGuestCredential | null;
}

/** The answer of a seat credential request. */
export interface FriendSeatCredential {
  readonly schemaVersion: number;
  readonly matchId: string;
  readonly seat: Seat;
  readonly guestCredential: FriendGuestCredential | null;
}

/** One rematch offer. */
export interface FriendRematch {
  readonly rematchId: string;
  readonly matchId: string;
  readonly status: 'pending' | 'accepting' | 'accepted' | 'superseded' | 'declined' | 'expired';
  readonly proposerLabel: string;
  readonly proposerSeat: Seat;
  readonly timeControl: TimeControl;
  readonly startingFen: string | null;
  readonly expiresAt: string;
  readonly newMatchId: string | null;
}

/** The answer of an accepted rematch. */
export interface FriendRematchAccepted {
  readonly schemaVersion: number;
  readonly rematch: FriendRematch;
  readonly match: OnlineMatchView;
  readonly seat: Seat;
  readonly guestCredential: FriendGuestCredential | null;
}

/** The credential of the active participant. */
export interface FriendCredentialProvider {
  /**
   * The credential header of the active participant.
   *
   * It is null for an anonymous caller. The header is the only place a
   * credential ever travels.
   */
  header(): Promise<Record<string, string> | null>;
}

export interface FriendClientOptions {
  /** The trusted service origin. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** The credential of the active participant. */
  readonly credentials: FriendCredentialProvider;
}

/** The client of the friend routes. */
export interface FriendClient {
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
  /** Accepts an invitation and answers with the created match. */
  accept(invitationId: string, request: { acceptanceKey: string; control: SeatControl }): Promise<FriendInvitationAccepted>;
  /** Cancels an invitation. */
  cancel(invitationId: string, ownerToken: string): Promise<FriendInvitation>;
  /** Claims the seat credential of the inviter of a consumed invitation. */
  seatCredential(invitationId: string, ownerToken: string): Promise<FriendSeatCredential>;
  /** Proposes a rematch of a finished match. */
  proposeRematch(matchId: string, request?: { timeControl?: TimeControl; startingFen?: string }): Promise<FriendRematch>;
  /** Accepts a rematch offer and answers with the created match. */
  acceptRematch(rematchId: string): Promise<FriendRematchAccepted>;
  /** Reads the pending rematch offer of a match. */
  pendingRematch(matchId: string): Promise<FriendRematch | null>;
}

/** The routes of the friend surface. */
export const FRIEND_ROUTES = {
  invitations: '/v1/online/invitations',
  invitation: (invitationId: string) => `/v1/online/invitations/${encodeURIComponent(invitationId)}`,
  invitationAccept: (invitationId: string) => `/v1/online/invitations/${encodeURIComponent(invitationId)}/accept`,
  invitationCancel: (invitationId: string) => `/v1/online/invitations/${encodeURIComponent(invitationId)}/cancel`,
  invitationSeatCredential: (invitationId: string) => `/v1/online/invitations/${encodeURIComponent(invitationId)}/seat-credential`,
  rematches: '/v1/online/rematches',
  rematchAccept: (rematchId: string) => `/v1/online/rematches/${encodeURIComponent(rematchId)}/accept`,
  rematchSeatCredential: (rematchId: string) => `/v1/online/rematches/${encodeURIComponent(rematchId)}/seat-credential`,
  matchRematch: (matchId: string) => `/v1/online/matches/${encodeURIComponent(matchId)}/rematch`,
} as const;

/** The failure of a friend request. */
export class FriendRouteError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'FriendRouteError';
    this.status = status;
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FriendRouteError(`${path} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new FriendRouteError(`${path} is missing.`);
  return value;
}

function optionalString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new FriendRouteError(`${path} is invalid.`);
  return value;
}

function parseSeat(value: unknown, path: string): Seat {
  if (value !== 'white' && value !== 'black') throw new FriendRouteError(`${path} is invalid.`);
  return value;
}

function parseControl(value: unknown, path: string): SeatControl {
  const record = asRecord(value, path);
  const kind = record.kind;
  if (kind !== 'human' && kind !== 'agent' && kind !== 'engine') {
    throw new FriendRouteError(`${path}.kind is invalid.`);
  }
  const label = optionalString(record.modelLabel, `${path}.modelLabel`);
  if (kind === 'human') return { kind: 'human' };
  if (label === null) throw new FriendRouteError(`${path}.modelLabel is missing.`);
  return { kind, modelLabel: label };
}

function parseTimeControl(value: unknown, path: string): TimeControl {
  const record = asRecord(value, path);
  const startingTimeMs = record.startingTimeMs;
  const incrementMs = record.incrementMs;
  if (typeof startingTimeMs !== 'number' || !Number.isSafeInteger(startingTimeMs) || startingTimeMs < 1) {
    throw new FriendRouteError(`${path}.startingTimeMs is invalid.`);
  }
  if (typeof incrementMs !== 'number' || !Number.isSafeInteger(incrementMs) || incrementMs < 0) {
    throw new FriendRouteError(`${path}.incrementMs is invalid.`);
  }
  return { startingTimeMs, incrementMs };
}

/** Parses the public view of one invitation. */
export function parseFriendInvitation(value: unknown): FriendInvitation {
  const path = 'invitation';
  const record = asRecord(value, path);
  const kind = requiredString(record.kind, `${path}.kind`);
  if (kind !== 'link' && kind !== 'challenge') throw new FriendRouteError(`${path}.kind is invalid.`);
  const status = requiredString(record.status, `${path}.status`);
  if (status !== 'open' && status !== 'consumed' && status !== 'cancelled' && status !== 'expired') {
    throw new FriendRouteError(`${path}.status is invalid.`);
  }
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== 'number') throw new FriendRouteError(`${path}.schemaVersion is missing.`);
  return {
    schemaVersion,
    invitationId: requiredString(record.invitationId, `${path}.invitationId`),
    kind,
    status,
    inviterLabel: requiredString(record.inviterLabel, `${path}.inviterLabel`),
    inviterSeat: parseSeat(record.inviterSeat, `${path}.inviterSeat`),
    inviterControl: parseControl(record.inviterControl, `${path}.inviterControl`),
    timeControl: parseTimeControl(record.timeControl, `${path}.timeControl`),
    startingFen: optionalString(record.startingFen, `${path}.startingFen`),
    expiresAt: requiredString(record.expiresAt, `${path}.expiresAt`),
    createdAt: requiredString(record.createdAt, `${path}.createdAt`),
    consumedAt: optionalString(record.consumedAt, `${path}.consumedAt`),
    cancelledAt: optionalString(record.cancelledAt, `${path}.cancelledAt`),
    matchId: optionalString(record.matchId, `${path}.matchId`),
  };
}

function parseGuestCredential(value: unknown, path: string): FriendGuestCredential | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value, path);
  return {
    guestId: requiredString(record.guestId, `${path}.guestId`),
    matchId: requiredString(record.matchId, `${path}.matchId`),
    seat: parseSeat(record.seat, `${path}.seat`),
    token: requiredString(record.token, `${path}.token`),
    expiresAt: requiredString(record.expiresAt, `${path}.expiresAt`),
  };
}

function parseRematch(value: unknown, path: string): FriendRematch {
  const record = asRecord(value, path);
  const status = requiredString(record.status, `${path}.status`);
  if (status !== 'pending' && status !== 'accepting' && status !== 'accepted' && status !== 'superseded' && status !== 'declined' && status !== 'expired') {
    throw new FriendRouteError(`${path}.status is invalid.`);
  }
  return {
    rematchId: requiredString(record.rematchId, `${path}.rematchId`),
    matchId: requiredString(record.matchId, `${path}.matchId`),
    status,
    proposerLabel: requiredString(record.proposerLabel, `${path}.proposerLabel`),
    proposerSeat: parseSeat(record.proposerSeat, `${path}.proposerSeat`),
    timeControl: parseTimeControl(record.timeControl, `${path}.timeControl`),
    startingFen: optionalString(record.startingFen, `${path}.startingFen`),
    expiresAt: requiredString(record.expiresAt, `${path}.expiresAt`),
    newMatchId: optionalString(record.newMatchId, `${path}.newMatchId`),
  };
}

/**
 * Creates the friend client.
 *
 * The client sends only the fields of the contract and reads only the
 * allowlisted answers. It never reads or writes a credential itself.
 */
export function createFriendClient(options: FriendClientOptions): FriendClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function call<T>(path: string, method: 'GET' | 'POST', body: unknown, parse: (value: unknown) => T): Promise<T> {
    const headers = await options.credentials.header();
    const init: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        ...(headers ?? {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const response = await fetcher(`${base}${path}`, init);
    if (!response.ok) {
      throw new FriendRouteError(`The service refused the friend request (${response.status}).`, response.status);
    }
    return parse(await response.json() as unknown);
  }

  return {
    create(request) {
      return call(FRIEND_ROUTES.invitations, 'POST', {
        schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
        kind: request.kind ?? 'link',
        ...(request.recipientAccountId ? { recipientAccountId: request.recipientAccountId } : {}),
        seat: request.seat,
        timeControl: request.timeControl,
        ...(request.startingFen ? { startingFen: request.startingFen } : {}),
        control: request.control,
      }, (value) => {
        const record = asRecord(value, 'invitationCreated');
        const invitation = parseFriendInvitation(record.invitation);
        return {
          schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : ONLINE_CONTRACTS_SCHEMA_VERSION,
          invitation,
          ownerToken: requiredString(record.ownerToken, 'invitationCreated.ownerToken'),
        };
      });
    },
    preview(invitationId) {
      return call(FRIEND_ROUTES.invitation(invitationId), 'GET', undefined, parseFriendInvitation);
    },
    accept(invitationId, request) {
      return call(FRIEND_ROUTES.invitationAccept(invitationId), 'POST', {
        schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
        acceptanceKey: request.acceptanceKey,
        control: request.control,
      }, (value) => {
        const record = asRecord(value, 'invitationAccepted');
        const match = asRecord(record.match, 'invitationAccepted.match');
        return {
          schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : ONLINE_CONTRACTS_SCHEMA_VERSION,
          match: match as unknown as OnlineMatchView,
          seat: parseSeat(record.seat, 'invitationAccepted.seat'),
          acceptanceId: requiredString(record.acceptanceId, 'invitationAccepted.acceptanceId'),
          guestCredential: parseGuestCredential(record.guestCredential, 'invitationAccepted.guestCredential'),
        };
      });
    },
    cancel(invitationId, ownerToken) {
      return call(FRIEND_ROUTES.invitationCancel(invitationId), 'POST', {
        schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
        ownerToken,
      }, parseFriendInvitation);
    },
    seatCredential(invitationId, ownerToken) {
      return call(FRIEND_ROUTES.invitationSeatCredential(invitationId), 'POST', {
        schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
        ownerToken,
      }, (value) => {
        const record = asRecord(value, 'seatCredential');
        return {
          schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : ONLINE_CONTRACTS_SCHEMA_VERSION,
          matchId: requiredString(record.matchId, 'seatCredential.matchId'),
          seat: parseSeat(record.seat, 'seatCredential.seat'),
          guestCredential: parseGuestCredential(record.guestCredential, 'seatCredential.guestCredential'),
        };
      });
    },
    proposeRematch(matchId, request) {
      return call(FRIEND_ROUTES.rematches, 'POST', {
        schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
        matchId,
        ...(request?.timeControl ? { timeControl: request.timeControl } : {}),
        ...(request?.startingFen ? { startingFen: request.startingFen } : {}),
      }, (value) => {
        const record = asRecord(value, 'rematchAnswer');
        return parseRematch(record.rematch, 'rematchAnswer.rematch');
      });
    },
    acceptRematch(rematchId) {
      return call(FRIEND_ROUTES.rematchAccept(rematchId), 'POST', {
        schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
      }, (value) => {
        const record = asRecord(value, 'rematchAccepted');
        const match = asRecord(record.match, 'rematchAccepted.match');
        return {
          schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : ONLINE_CONTRACTS_SCHEMA_VERSION,
          rematch: parseRematch(record.rematch, 'rematchAccepted.rematch'),
          match: match as unknown as OnlineMatchView,
          seat: parseSeat(record.seat, 'rematchAccepted.seat'),
          guestCredential: parseGuestCredential(record.guestCredential, 'rematchAccepted.guestCredential'),
        };
      });
    },
    async pendingRematch(matchId) {
      const record = await call<unknown>(FRIEND_ROUTES.matchRematch(matchId), 'GET', undefined, value => value);
      const wrapped = asRecord(record, 'rematchAnswer');
      if (wrapped.rematch === null || wrapped.rematch === undefined) return null;
      return parseRematch(wrapped.rematch, 'rematchAnswer.rematch');
    },
  };
}
