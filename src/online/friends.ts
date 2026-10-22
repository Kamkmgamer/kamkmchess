/**
 * Friend invitations, account challenges and mutual rematches (KHA-75).
 *
 * The module owns the *browser* half of one friend invitation:
 *
 * - the typed route contract of the friend surface,
 * - the strict parsers of every answer, and
 * - the domain rules the interface needs: which invitation states exist, when
 *   a credential has to be claimed, and when a rematch may be accepted.
 *
 * It owns no transport of its own beyond the small port it declares, no chess
 * authority and no provider request. The caller injects the transport, so the
 * rules below are testable without a network or a database.
 *
 * The rules this module keeps:
 *
 * - The invitation identifier is the shareable secret of the link. It is a
 *   bearer secret for exactly one acceptance and never a credential.
 * - A named challenge names a public name. The service resolves the name to
 *   the account itself, so an authentication identifier never travels in a
 *   request and never reaches an answer.
 * - The owner token of an invitation travels in a private request header. It
 *   never travels in a URL, a query string or a body, and it is never
 *   logged.
 * - An acceptance is resumed with the acceptance key. The key is generated
 *   once per accept intent, kept for the page lifetime and reused on every
 *   retry, so a lost answer never consumes a second invitation.
 * - A guest acceptor needs the acceptance key, because a guest has no other
 *   identity to resume with.
 * - A guest seat credential is delivered once. A routine retry never
 *   supersedes a credential another request already delivered; the rotation
 *   is explicit and happens only when the browser holds no working
 *   credential.
 * - The guest inviter claims its own seat credential after the invitee
 *   accepted, because a guest seat credential is bound to a match that did
 *   not exist before.
 * - A rematch needs both participants. The proposal is the proposer's
 *   consent; the opponent's acceptance creates the new match. A rematch is a
 *   new match, so the credential of the finished match cannot authorize it
 *   and a guest that lost the answer gets a fresh credential of the new
 *   seat.
 * - A rematch offer is accepted by the opponent of the proposer only, and
 *   only while the offer is a live pending offer. The service answers whether
 *   the reader proposed the offer, and no identity of the proposer ever
 *   travels in the answer. An accepted offer stays reopenable by the
 *   opponent, because the duplicate acceptance is the recovery of a lost
 *   answer.
 * - An expired link reports the `expired` state, both in the preview and in
 *   the refused acceptance, so the interface can say that the link expired
 *   instead of reporting a generic conflict.
 * - The preview shows the inviter's public name or Guest, the color, the
 *   clock and the custom position. It never invents a pairing.
 * - A published model label is the canonical public label. It may be
 *   collapsed to the neutral label, so the browser keeps its own binding of
 *   a model opponent and never identifies a model by the published label.
 */
import type { OnlineMatchView } from './updates';
import type { Seat, SeatControl, TimeControl } from './contracts';

/** The wire schema version of the online contracts. */
export const ONLINE_FRIENDS_SCHEMA_VERSION = 2;

/** The route that creates an invitation. */
export const FRIENDS_INVITATIONS_PATH = '/v1/online/invitations';
/** The route that reads one invitation. */
export const FRIENDS_INVITATION_PATH = '/v1/online/invitations/{invitationId}';
/** The route that accepts one invitation. */
export const FRIENDS_INVITATION_ACCEPT_PATH = '/v1/online/invitations/{invitationId}/accept';
/** The route that cancels one invitation. */
export const FRIENDS_INVITATION_CANCEL_PATH = '/v1/online/invitations/{invitationId}/cancel';
/** The route that claims the guest seat credential of the inviter. */
export const FRIENDS_INVITATION_SEAT_CREDENTIAL_PATH = '/v1/online/invitations/{invitationId}/seat-credential';
/** The route that proposes a rematch. */
export const FRIENDS_REMATCH_PATH = '/v1/online/rematches';
/** The route that accepts a rematch. */
export const FRIENDS_REMATCH_ACCEPT_PATH = '/v1/online/rematches/{rematchId}/accept';
/** The route that claims the guest seat credential of a rematch proposer. */
export const FRIENDS_REMATCH_SEAT_CREDENTIAL_PATH = '/v1/online/rematches/{rematchId}/seat-credential';
/** The route that reads the pending rematch of a finished match. */
export const FRIENDS_MATCH_REMATCH_PATH = '/v1/online/matches/{matchId}/rematch';

/**
 * The private header that carries the owner token of an invitation.
 *
 * The owner token is the recoverable ownership of an invitation and of the
 * match it creates. It travels in this header and never in a URL, a query
 * string or a request body.
 */
export const FRIENDS_OWNER_TOKEN_HEADER = 'X-Online-Owner-Token';

/** The two invitation paths. */
export type FriendInvitationKind = 'link' | 'challenge';

/** The durable state of an invitation. */
export type FriendInvitationStatus = 'open' | 'consumed' | 'cancelled' | 'expired';

/** The durable state of a rematch offer. */
export type FriendRematchStatus = 'pending' | 'accepting' | 'accepted' | 'superseded' | 'declined' | 'expired';

/** The public view of one invitation. */
export interface FriendInvitation {
  readonly schemaVersion: number;
  readonly invitationId: string;
  readonly kind: FriendInvitationKind;
  readonly status: FriendInvitationStatus;
  /** The public name of the inviter, or Guest. */
  readonly inviterLabel: string;
  readonly inviterSeat: Seat;
  readonly inviterControl: SeatControl;
  readonly timeControl: TimeControl;
  /** The custom position, or null for the standard position. */
  readonly startingFen: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt: string | null;
  readonly cancelledAt: string | null;
  readonly matchId: string | null;
}

/** The private credential of a guest seat. */
export interface FriendGuestCredential {
  readonly guestId: string;
  readonly matchId: string;
  readonly seat: Seat;
  /** The plaintext token. It exists only in this answer. */
  readonly token: string;
  readonly expiresAt: string;
}

/** The answer of an invitation creation. */
export interface FriendInvitationCreated {
  readonly schemaVersion: number;
  readonly invitation: FriendInvitation;
  /**
   * The inviter's revocable ownership secret.
   *
   * The browser keeps it in local state only. It never travels in a URL and
   * it never enters a shared snapshot.
   */
  readonly ownerToken: string;
}

/** The answer of an accepted invitation. */
export interface FriendInvitationAccepted {
  readonly schemaVersion: number;
  /** The participant live view of the created match. */
  readonly match: OnlineMatchView;
  /** The seat the acceptor plays. */
  readonly seat: Seat;
  readonly acceptanceId: string;
  /** Present only when this request minted the guest seat credential. */
  readonly guestCredential: FriendGuestCredential | null;
}

/** The answer of a seat credential request. */
export interface FriendSeatCredential {
  readonly schemaVersion: number;
  readonly matchId: string;
  readonly seat: Seat;
  readonly guestCredential: FriendGuestCredential | null;
}

/** The public view of one rematch offer. */
export interface FriendRematch {
  readonly rematchId: string;
  readonly matchId: string;
  readonly status: FriendRematchStatus;
  readonly proposerLabel: string;
  /** The seat the proposer plays in the new match. The colors are reversed. */
  readonly proposerSeat: Seat;
  readonly timeControl: TimeControl;
  readonly startingFen: string | null;
  readonly expiresAt: string;
  readonly newMatchId: string | null;
  /**
   * True when the reader of the offer proposed it.
   *
   * The service compares the stored identity of the proposer with the
   * identity of the reader, so the answer is a fact about the reader alone
   * and no identity of the proposer ever travels in the answer. The proposal
   * is already the consent of the proposer, so only the opponent of the
   * proposer may accept the offer.
   */
  readonly proposedByViewer: boolean;
}

/** The answer of an accepted rematch. */
export interface FriendRematchAccepted {
  readonly schemaVersion: number;
  readonly rematch: FriendRematch;
  readonly match: OnlineMatchView;
  readonly seat: Seat;
  readonly guestCredential: FriendGuestCredential | null;
}

/** The request that creates one invitation. */
export interface FriendInvitationCreateRequest {
  readonly kind?: FriendInvitationKind;
  /**
   * The public name of the account a challenge names.
   *
   * Required for a challenge, forbidden for a link. A public name is a
   * public identity: the service resolves it to the account itself and the
   * account subject never travels in a request.
   */
  readonly recipientUsername?: string;
  readonly seat: Seat;
  readonly timeControl: TimeControl;
  readonly startingFen?: string;
  /** The inviter's own seat control. */
  readonly control: SeatControl;
}

/** The request that accepts one invitation. */
export interface FriendInvitationAcceptRequest {
  readonly control: SeatControl;
  /** The idempotency key of the accept intent. Required for a guest. */
  readonly acceptanceKey: string;
  /** Replaces a live credential of the seat. */
  readonly rotateCredential?: boolean;
}

/** The request that proposes a rematch. */
export interface FriendRematchRequest {
  readonly matchId: string;
  readonly timeControl?: TimeControl;
  readonly startingFen?: string;
}

/**
 * The request that accepts one rematch offer.
 *
 * A rematch is a new match, so the credential of the finished match cannot
 * authorize the new seat. A guest that lost the answer receives a fresh
 * credential of the new seat, and it may ask for the replacement explicitly
 * as well.
 */
export interface FriendRematchAcceptRequest {
  /**
   * Replaces a live guest seat credential of the new seat.
   *
   * The browser asks for the replacement when it holds no working
   * credential of the new match, for example after a lost answer.
   */
  readonly rotateCredential?: boolean;
}

/** One request of the friend surface. */
export interface FriendRequest {
  readonly path: string;
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
  /**
   * The private headers of the request.
   *
   * A secret of the surface travels in a header and never in the body, so
   * it never reaches a log line of a proxy and never becomes part of a
   * cached request.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** The transport of the friend surface. */
export interface FriendTransport {
  send(request: FriendRequest): Promise<unknown>;
}

/** The typed client of the friend surface. */
export interface FriendClient {
  createInvitation(request: FriendInvitationCreateRequest): Promise<FriendInvitationCreated>;
  /**
   * Reads one invitation.
   *
   * The owner token authorizes the read for the inviter of a named
   * challenge. It travels in the private header of the surface.
   */
  readInvitation(invitationId: string, ownerToken?: string): Promise<FriendInvitation>;
  acceptInvitation(invitationId: string, request: FriendInvitationAcceptRequest): Promise<FriendInvitationAccepted>;
  cancelInvitation(invitationId: string, ownerToken: string): Promise<FriendInvitation>;
  claimSeatCredential(invitationId: string, ownerToken: string): Promise<FriendSeatCredential>;
  proposeRematch(request: FriendRematchRequest): Promise<FriendRematch>;
  acceptRematch(rematchId: string, request?: FriendRematchAcceptRequest): Promise<FriendRematchAccepted>;
  claimRematchSeatCredential(rematchId: string): Promise<FriendSeatCredential>;
  readPendingRematch(matchId: string): Promise<FriendRematch | null>;
}

/** A failure of the friend surface carries a stable code. */
export type FriendErrorCode =
  | 'invalid-request'
  | 'invalid-answer'
  | 'not-found'
  | 'conflict'
  | 'expired'
  | 'not-authorized'
  | 'origin-required'
  | 'unauthorized'
  | 'unavailable';

export class FriendError extends Error {
  readonly code: FriendErrorCode;
  readonly status: number;

  constructor(code: FriendErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'FriendError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Creates the typed client of the friend surface.
 */
export function createFriendClient(transport: FriendTransport): FriendClient {
  return {
    async createInvitation(request) {
      const body = await transport.send({
        path: FRIENDS_INVITATIONS_PATH,
        method: 'POST',
        body: {
          schemaVersion: ONLINE_FRIENDS_SCHEMA_VERSION,
          kind: request.kind ?? 'link',
          // A challenge names a public name. The account subject of the
          // recipient is resolved by the service and never travels here.
          recipientUsername: request.recipientUsername ?? '',
          seat: request.seat,
          timeControl: request.timeControl,
          startingFen: request.startingFen ?? '',
          control: request.control,
        },
      });
      return parseInvitationCreated(body);
    },
    async readInvitation(invitationId, ownerToken) {
      const body = await transport.send({
        path: FRIENDS_INVITATION_PATH.replace('{invitationId}', encodeURIComponent(invitationId)),
        method: 'GET',
        ...(ownerToken ? { headers: { [FRIENDS_OWNER_TOKEN_HEADER]: ownerToken } } : {}),
      });
      return parseInvitation(body);
    },
    async acceptInvitation(invitationId, request) {
      const body = await transport.send({
        path: FRIENDS_INVITATION_ACCEPT_PATH.replace('{invitationId}', encodeURIComponent(invitationId)),
        method: 'POST',
        body: {
          schemaVersion: ONLINE_FRIENDS_SCHEMA_VERSION,
          acceptanceKey: request.acceptanceKey,
          control: request.control,
          rotateCredential: request.rotateCredential === true,
        },
      });
      return parseInvitationAccepted(body);
    },
    async cancelInvitation(invitationId, ownerToken) {
      const body = await transport.send({
        path: FRIENDS_INVITATION_CANCEL_PATH.replace('{invitationId}', encodeURIComponent(invitationId)),
        method: 'POST',
        body: { schemaVersion: ONLINE_FRIENDS_SCHEMA_VERSION },
        // The owner token travels in the private header of the surface. It
        // never travels in the body and never in the URL.
        headers: { [FRIENDS_OWNER_TOKEN_HEADER]: ownerToken },
      });
      return parseInvitation(body);
    },
    async claimSeatCredential(invitationId, ownerToken) {
      const body = await transport.send({
        path: FRIENDS_INVITATION_SEAT_CREDENTIAL_PATH.replace('{invitationId}', encodeURIComponent(invitationId)),
        method: 'POST',
        body: { schemaVersion: ONLINE_FRIENDS_SCHEMA_VERSION },
        // The owner token travels in the private header of the surface. It
        // never travels in the body and never in the URL.
        headers: { [FRIENDS_OWNER_TOKEN_HEADER]: ownerToken },
      });
      return parseSeatCredential(body);
    },
    async proposeRematch(request) {
      const body = await transport.send({
        path: FRIENDS_REMATCH_PATH,
        method: 'POST',
        body: {
          schemaVersion: ONLINE_FRIENDS_SCHEMA_VERSION,
          matchId: request.matchId,
          timeControl: request.timeControl ?? null,
          startingFen: request.startingFen ?? null,
        },
      });
      return parseRematchAnswer(body);
    },
    async acceptRematch(rematchId, request) {
      const body = await transport.send({
        path: FRIENDS_REMATCH_ACCEPT_PATH.replace('{rematchId}', encodeURIComponent(rematchId)),
        method: 'POST',
        body: {
          schemaVersion: ONLINE_FRIENDS_SCHEMA_VERSION,
          rotateCredential: request?.rotateCredential === true,
        },
      });
      return parseRematchAccepted(body);
    },
    async claimRematchSeatCredential(rematchId) {
      const body = await transport.send({
        path: FRIENDS_REMATCH_SEAT_CREDENTIAL_PATH.replace('{rematchId}', encodeURIComponent(rematchId)),
        method: 'POST',
        body: { schemaVersion: ONLINE_FRIENDS_SCHEMA_VERSION },
      });
      return parseSeatCredential(body);
    },
    async readPendingRematch(matchId) {
      try {
        const body = await transport.send({
          path: FRIENDS_MATCH_REMATCH_PATH.replace('{matchId}', encodeURIComponent(matchId)),
          method: 'GET',
        });
        return parseRematchAnswer(body);
      } catch (error) {
        if (error instanceof FriendError && error.code === 'not-found') return null;
        throw error;
      }
    },
  };
}

/**
 * Builds a transport over a fetch call.
 *
 * The credential is optional. The guest paths of the friend surface are
 * public, so a request without a credential is legitimate. A credential never
 * travels in the URL, the query string or the body: it rides the header the
 * caller owns.
 */
export function createFetchFriendTransport(options: {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** Returns the credential header, or null for an anonymous request. */
  readonly credential?: () => Record<string, string> | null;
}): FriendTransport {
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    async send(request) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      // The private headers of the request carry the owner token of an
      // invitation. The credential of the caller is applied afterwards, so a
      // request header never replaces it.
      if (request.headers) Object.assign(headers, request.headers);
      const credential = options.credential?.();
      if (credential) Object.assign(headers, credential);
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';
      const init: RequestInit = { method: request.method, headers };
      if (request.body !== undefined) init.body = JSON.stringify(request.body);
      if (request.signal) init.signal = request.signal;
      const response = await fetcher(`${base}${request.path}`, init);
      const text = await response.text();
      let payload: unknown = null;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new FriendError('invalid-answer', 'The service answer is not JSON.', response.status);
        }
      }
      if (!response.ok) throw friendError(response.status, payload);
      return payload;
    },
  };
}

/** Maps a failed answer onto a stable error code. */
function friendError(status: number, payload: unknown): FriendError {
  const code = typeof payload === 'object' && payload !== null ? (payload as { error?: unknown }).error : undefined;
  switch (status) {
    case 400:
      return new FriendError('invalid-request', 'The request is not valid.', status);
    case 403:
      return new FriendError(code === 'origin_required' ? 'origin-required' : 'not-authorized', 'The request was refused.', status);
    case 404:
      return new FriendError('not-found', 'The invitation or the match was not found.', status);
    case 409:
      return new FriendError('conflict', 'The invitation changed before the request.', status);
    case 410:
      return new FriendError('expired', 'The invitation link expired.', status);
    case 401:
      return new FriendError('unauthorized', 'The request needs a signed-in account.', status);
    default:
      return new FriendError('unavailable', 'The service is temporarily unavailable.', status);
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FriendError('invalid-answer', `${path} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new FriendError('invalid-answer', `${path}.${key} is missing.`);
  }
  return value;
}

function optionalString(object: Record<string, unknown>, key: string, path: string): string | null {
  const value = object[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new FriendError('invalid-answer', `${path}.${key} is not a string.`);
  }
  return value;
}

function requiredNumber(object: Record<string, unknown>, key: string, path: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FriendError('invalid-answer', `${path}.${key} is missing.`);
  }
  return value;
}

function requiredSeat(object: Record<string, unknown>, key: string, path: string): Seat {
  const value = object[key];
  if (value !== 'white' && value !== 'black') {
    throw new FriendError('invalid-answer', `${path}.${key} is not a seat.`);
  }
  return value;
}

function optionalBoolean(object: Record<string, unknown>, key: string, path: string): boolean | null {
  const value = object[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw new FriendError('invalid-answer', `${path}.${key} is not a boolean.`);
  }
  return value;
}

function parseTimeControl(value: unknown, path: string): TimeControl {
  const object = asObject(value, path);
  return {
    startingTimeMs: requiredNumber(object, 'startingTimeMs', path),
    incrementMs: requiredNumber(object, 'incrementMs', path),
  };
}

function parseSeatControl(value: unknown, path: string): SeatControl {
  const object = asObject(value, path);
  const kind = requiredString(object, 'kind', path);
  if (kind !== 'human' && kind !== 'agent' && kind !== 'engine') {
    throw new FriendError('invalid-answer', `${path}.kind is not a control kind.`);
  }
  const label = optionalString(object, 'modelLabel', path);
  return label === null ? { kind } : { kind, modelLabel: label };
}

/** Parses the public view of one invitation. */
export function parseInvitation(value: unknown): FriendInvitation {
  const path = 'invitation';
  const object = asObject(value, path);
  const kind = requiredString(object, 'kind', path);
  if (kind !== 'link' && kind !== 'challenge') {
    throw new FriendError('invalid-answer', `${path}.kind is not an invitation kind.`);
  }
  const status = requiredString(object, 'status', path);
  if (status !== 'open' && status !== 'consumed' && status !== 'cancelled' && status !== 'expired') {
    throw new FriendError('invalid-answer', `${path}.status is not an invitation status.`);
  }
  return {
    schemaVersion: requiredNumber(object, 'schemaVersion', path),
    invitationId: requiredString(object, 'invitationId', path),
    kind,
    status,
    inviterLabel: requiredString(object, 'inviterLabel', path),
    inviterSeat: requiredSeat(object, 'inviterSeat', path),
    inviterControl: parseSeatControl(object['inviterControl'], `${path}.inviterControl`),
    timeControl: parseTimeControl(object['timeControl'], `${path}.timeControl`),
    startingFen: optionalString(object, 'startingFen', path),
    expiresAt: requiredString(object, 'expiresAt', path),
    createdAt: requiredString(object, 'createdAt', path),
    consumedAt: optionalString(object, 'consumedAt', path),
    cancelledAt: optionalString(object, 'cancelledAt', path),
    matchId: optionalString(object, 'matchId', path),
  };
}

/** Parses the answer of an invitation creation. */
export function parseInvitationCreated(value: unknown): FriendInvitationCreated {
  const path = 'invitationCreated';
  const object = asObject(value, path);
  return {
    schemaVersion: requiredNumber(object, 'schemaVersion', path),
    invitation: parseInvitation(object['invitation']),
    ownerToken: requiredString(object, 'ownerToken', path),
  };
}

function parseGuestCredential(value: unknown, path: string): FriendGuestCredential | null {
  if (value === null || value === undefined) return null;
  const object = asObject(value, path);
  return {
    guestId: requiredString(object, 'guestId', path),
    matchId: requiredString(object, 'matchId', path),
    seat: requiredSeat(object, 'seat', path),
    token: requiredString(object, 'token', path),
    expiresAt: requiredString(object, 'expiresAt', path),
  };
}

/** Parses the answer of an accepted invitation. */
export function parseInvitationAccepted(value: unknown): FriendInvitationAccepted {
  const path = 'invitationAccepted';
  const object = asObject(value, path);
  const match = asObject(object['match'], `${path}.match`);
  return {
    schemaVersion: requiredNumber(object, 'schemaVersion', path),
    match: match as unknown as OnlineMatchView,
    seat: requiredSeat(object, 'seat', path),
    acceptanceId: requiredString(object, 'acceptanceId', path),
    guestCredential: parseGuestCredential(object['guestCredential'], `${path}.guestCredential`),
  };
}

/** Parses the answer of a seat credential request. */
export function parseSeatCredential(value: unknown): FriendSeatCredential {
  const path = 'seatCredential';
  const object = asObject(value, path);
  return {
    schemaVersion: requiredNumber(object, 'schemaVersion', path),
    matchId: requiredString(object, 'matchId', path),
    seat: requiredSeat(object, 'seat', path),
    guestCredential: parseGuestCredential(object['guestCredential'], `${path}.guestCredential`),
  };
}

/** Parses the public view of one rematch offer. */
export function parseRematch(value: unknown): FriendRematch {
  const path = 'rematch';
  const object = asObject(value, path);
  const status = requiredString(object, 'status', path);
  if (status !== 'pending' && status !== 'accepting' && status !== 'accepted' && status !== 'superseded' && status !== 'declined' && status !== 'expired') {
    throw new FriendError('invalid-answer', `${path}.status is not a rematch status.`);
  }
  return {
    rematchId: requiredString(object, 'rematchId', path),
    matchId: requiredString(object, 'matchId', path),
    status,
    proposerLabel: requiredString(object, 'proposerLabel', path),
    proposerSeat: requiredSeat(object, 'proposerSeat', path),
    timeControl: parseTimeControl(object['timeControl'], `${path}.timeControl`),
    startingFen: optionalString(object, 'startingFen', path),
    expiresAt: requiredString(object, 'expiresAt', path),
    newMatchId: optionalString(object, 'newMatchId', path),
    proposedByViewer: optionalBoolean(object, 'proposedByViewer', path) ?? false,
  };
}

/** Parses the answer that carries one rematch offer. */
export function parseRematchAnswer(value: unknown): FriendRematch {
  const path = 'rematchAnswer';
  const object = asObject(value, path);
  return parseRematch(object['rematch']);
}

/** Parses the answer of an accepted rematch. */
export function parseRematchAccepted(value: unknown): FriendRematchAccepted {
  const path = 'rematchAccepted';
  const object = asObject(value, path);
  const match = asObject(object['match'], `${path}.match`);
  return {
    schemaVersion: requiredNumber(object, 'schemaVersion', path),
    rematch: parseRematch(object['rematch']),
    match: match as unknown as OnlineMatchView,
    seat: requiredSeat(object, 'seat', path),
    guestCredential: parseGuestCredential(object['guestCredential'], `${path}.guestCredential`),
  };
}

/**
 * True when the invitation may still be accepted.
 */
export function isAcceptableInvitation(invitation: FriendInvitation): boolean {
  return invitation.status === 'open';
}

/**
 * The action the reader of a rematch offer may take.
 *
 * - `accept` accepts a live pending offer and creates the new match;
 * - `open` reopens the new match of an accepted offer, because the duplicate
 *   acceptance returns the same match and the credential of the seat of the
 *   accepter;
 * - `none` leaves the offer alone.
 */
export type FriendRematchAction = 'accept' | 'open' | 'none';

/**
 * The action the reader may take on the rematch offer.
 *
 * A rematch needs both participants. The proposal is already the consent of
 * the proposer, so the proposer never accepts its own offer: the service
 * refuses that acceptance with a conflict. Only the opponent of the proposer
 * may act on the offer.
 *
 * The opponent of a live pending offer accepts it, because the acceptance
 * creates the new match. The deadline of the offer has to lie ahead: the
 * service refuses the acceptance of an offer whose deadline passed, and the
 * service never publishes such an offer in the first place. The rule keeps
 * the deadline as well, so an offer that expired while the reader looked at
 * it is not offered again.
 *
 * An accepted offer created its match already. The opponent of the proposer
 * may still reopen it, because the duplicate acceptance is the recovery of a
 * lost answer: it returns the same match and it mints the credential of the
 * seat of the accepter. The proposer has no such recovery, because the
 * service claims the seat of the proposer with the seat credential route.
 */
export function rematchAction(
  rematch: FriendRematch,
  options: { readonly now: number },
): FriendRematchAction {
  if (rematch.proposedByViewer) return 'none';
  if (rematch.status === 'accepted') return 'open';
  if (rematch.status !== 'pending') return 'none';
  const deadline = Date.parse(rematch.expiresAt);
  if (Number.isNaN(deadline)) return 'none';
  if (deadline <= options.now) return 'none';
  return 'accept';
}

/**
 * True when the browser has to claim a guest seat credential.
 *
 * A guest seat credential is bound to a match seat, so it cannot exist before
 * the match exists. A guest inviter claims it after the invitee accepted, and
 * a guest acceptor receives it in the acceptance answer.
 */
export function needsGuestSeatCredential(
  invitation: FriendInvitation,
  options: { readonly isGuest: boolean; readonly credentialReceived: boolean },
): boolean {
  if (!options.isGuest) return false;
  if (options.credentialReceived) return false;
  return invitation.status === 'consumed' && invitation.matchId !== null;
}

/**
 * True when the acceptance has to ask for a credential rotation.
 *
 * The rotation happens only when the browser holds no working credential, so
 * a routine retry never supersedes a credential another request delivered.
 */
export function needsCredentialRotation(hasWorkingCredential: boolean): boolean {
  return !hasWorkingCredential;
}

/**
 * True when the browser itself created the invitation.
 *
 * The service cannot tell that an anonymous guest who created a link is the
 * same human who opens it later: an anonymous guest is a fresh opaque
 * identity and the service never tracks people. The browser can avoid the
 * case itself, because it knows which links it created and keeps their owner
 * tokens.
 *
 * This is a convenience of the interface, not an identity proof. It stops one
 * browser from accepting its own link. It does not stop a second browser of
 * the same human, and it is no substitute for the consent of the other
 * player.
 */
export function isLocallyOwnedInvitation(invitationId: string, owned: ReadonlySet<string>): boolean {
  if (!invitationId) return false;
  return owned.has(invitationId);
}

/**
 * Builds the acceptance key of one accept intent.
 *
 * The key is generated once and reused by every retry of the same intent. It
 * must have at least sixteen characters of letters, digits, dash or
 * underscore.
 *
 * The key is the only capability that resumes a guest acceptance, so the
 * default source is a cryptographically secure one. An environment without
 * one fails closed instead of minting a guessable capability.
 */
export function createAcceptanceKey(random: () => string = defaultRandom): string {
  const value = random().replace(/[^A-Za-z0-9_-]/g, '');
  const body = value.length >= 16 ? value.slice(0, 48) : value.padEnd(16, '0');
  return `ak_${body}`;
}

/** The alphabet of the acceptance key. */
const acceptanceKeyAlphabet = 'ABCDEFGHIJKLMNOP';

/**
 * The default entropy source of the acceptance key.
 *
 * Twenty-four random bytes carry 192 bits, and the encoding below keeps every
 * one of them: a byte becomes two characters of a sixteen character
 * alphabet, so two different byte sequences never produce the same text.
 */
function defaultRandom(): string {
  const globalCrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (!globalCrypto?.getRandomValues) {
    throw new FriendError('unavailable', 'This browser has no secure random source for the acceptance key.');
  }
  const bytes = new Uint8Array(24);
  globalCrypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += acceptanceKeyAlphabet.charAt(byte >> 4) + acceptanceKeyAlphabet.charAt(byte & 15);
  return out;
}
