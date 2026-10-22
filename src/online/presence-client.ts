/**
 * The participant presence client (KHA-70, KHA-73).
 *
 * A participant that is connected reports in every five seconds. The report
 * keeps the liveness lease alive, so a suspended tab expires and the other
 * participant may claim the win after one continuous minute of silence.
 *
 * The rules this module keeps:
 *
 * - The heartbeat carries the seat of the caller. It never carries the seat
 *   of the opponent.
 * - "Keep waiting" never concedes a result. It only records that the caller
 *   waits for the opponent.
 * - The claim is offered by the service, never by the browser. The browser
 *   only sends the claim the service allowed.
 * - The credential travels in the request header of the authorized
 *   requester. It never travels in a URL or a body.
 * - The shape of every answer belongs to the contract module. The client
 *   reads the canonical types and parsers of `./contracts` and never keeps a
 *   second, laxer copy of them.
 */
import {
  ONLINE_CONTRACTS_SCHEMA_VERSION,
  parsePresenceView,
  parseReceipt,
  parseSeatPresence,
} from './contracts';
import type {
  ClaimAvailability,
  ClaimReason,
  PresenceView,
  Receipt,
  Seat,
  SeatPresence,
} from './contracts';
import type { AuthorizedRequester } from './request';
import type { ParticipantSession } from './session';
import { matchSeatScope } from './auth';

/** The presence of one seat. */
export type OnlineSeatPresence = SeatPresence;

/** Why the claim is or is not offered. */
export type OnlineClaimReason = ClaimReason;

/** The claim option of one participant. */
export type OnlineClaimAvailability = ClaimAvailability;

/** The presence view of one match. */
export type OnlinePresenceView = PresenceView;

export interface OnlinePresenceClientOptions {
  readonly requester: AuthorizedRequester;
  readonly session: ParticipantSession;
  readonly matchId: string;
  readonly seat: Seat;
}

/**
 * The input of an abandonment claim.
 *
 * The claim carries the facts the service checks again under the match lock:
 * the version and the control epoch the browser last saw, and the seat of the
 * caller. The identifier of the operation keeps a retry idempotent.
 */
export interface OnlineClaimInput {
  /** The version the browser last saw. */
  readonly expectedVersion: number;
  /** The control epoch the browser last saw. */
  readonly controlEpoch: number;
  /** The idempotency identifier of the claim. */
  readonly operationId?: string;
}

export interface OnlinePresenceClient {
  /** Reports in and extends the liveness lease. */
  heartbeat(): Promise<OnlineSeatPresence>;
  /** Reads the presence of both seats and the claim option. */
  view(): Promise<OnlinePresenceView>;
  /** Records that the caller keeps waiting. */
  keepWaiting(): Promise<OnlineSeatPresence>;
  /**
   * Claims the win because the opponent stayed offline.
   *
   * The service decides whether the claim is allowed. The browser sends the
   * claim it was offered and reads the receipt the service answered.
   */
  claimAbandonment(input: OnlineClaimInput): Promise<Receipt>;
}

/** The path of the presence route. */
export function onlinePresencePath(matchId: string): string {
  return `/v1/online/matches/${encodeURIComponent(matchId)}/presence`;
}

/** The path of the abandonment claim route. */
export function onlineClaimPath(matchId: string): string {
  return `/v1/online/matches/${encodeURIComponent(matchId)}/claim`;
}

/** Creates the identifier of one claim. */
function defaultOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `op${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * Reads the presence view of one match from the answer of the service.
 *
 * The contract module owns the shape of the answer. The client keeps one
 * binding check of its own: the view must belong to the match it asked for,
 * because a view of another match would carry the presence of other seats.
 */
function readPresenceView(value: unknown, matchId: string): PresenceView {
  const view = parsePresenceView(value);
  if (view.matchId !== matchId) {
    throw new Error('The presence view belongs to another match.');
  }
  return view;
}

/**
 * Creates the presence client of one seat.
 *
 * The client sends only the seat of the caller. The service owns the
 * liveness lease and the claim rule.
 */
export function createOnlinePresenceClient(options: OnlinePresenceClientOptions): OnlinePresenceClient {
  const { requester, matchId, seat } = options;
  const scope = matchSeatScope(matchId, seat);
  const path = onlinePresencePath(matchId);

  async function postSeat(subPath: string): Promise<OnlineSeatPresence> {
    const result = await requester.request(scope, {
      path: `${path}${subPath}`,
      method: 'POST',
      body: { seat },
    });
    if (!result.ok) {
      throw new Error(`The service refused the presence request (${result.status}).`);
    }
    return parseSeatPresence(result.data);
  }

  /**
   * Sends the abandonment claim of the caller.
   *
   * The envelope is closed: the claim carries no action, because a claim never
   * changes the position, the turn or the clocks of a running game.
   */
  async function claimAbandonment(input: OnlineClaimInput): Promise<Receipt> {
    const command = {
      schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
      matchId,
      operationId: input.operationId ?? defaultOperationId(),
      expectedVersion: input.expectedVersion,
      seat,
      controlEpoch: input.controlEpoch,
    };
    const result = await requester.request(scope, {
      path: onlineClaimPath(matchId),
      method: 'POST',
      body: command,
    });
    if (!result.ok) {
      throw new Error(`The service refused the claim (${result.status}).`);
    }
    const receipt = parseReceipt(result.data);
    if (receipt.matchId !== matchId) {
      throw new Error('The receipt belongs to another match.');
    }
    return receipt;
  }

  return {
    heartbeat() {
      return postSeat('');
    },
    keepWaiting() {
      return postSeat('/keep-waiting');
    },
    claimAbandonment,
    async view() {
      const result = await requester.request(scope, { path });
      if (!result.ok) {
        throw new Error(`The service refused the presence request (${result.status}).`);
      }
      return readPresenceView(result.data, matchId);
    },
  };
}
