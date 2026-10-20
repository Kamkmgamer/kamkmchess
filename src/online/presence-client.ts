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
 */
import type { AuthorizedRequester } from './request';
import type { ParticipantSession } from './session';
import { matchSeatScope } from './auth';
import type { Seat } from './contracts';

/** The presence of one seat. */
export interface OnlineSeatPresence {
  readonly seat: Seat;
  readonly state: 'connected' | 'offline' | 'unknown';
  readonly lastHeartbeatAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly offlineSince: string | null;
  readonly keepWaitingAt: string | null;
}

/** Why the claim is or is not offered. */
export type OnlineClaimReason =
  | 'eligible'
  | 'opponent-connected'
  | 'opponent-unknown'
  | 'awaiting-first-moves'
  | 'opening-reply-outstanding'
  | 'service-unavailable'
  | 'match-ended'
  | 'offline-grace-period';

/** The claim option of one participant. */
export interface OnlineClaimAvailability {
  readonly eligible: boolean;
  readonly reason: OnlineClaimReason;
  readonly opponentSeat: Seat | null;
  readonly offlineSince: string | null;
  readonly graceSecondsLeft: number;
}

/** The presence view of one match. */
export interface OnlinePresenceView {
  readonly schemaVersion: number;
  readonly matchId: string;
  readonly version: number;
  readonly controlEpoch: number;
  readonly status: string;
  readonly seats: readonly OnlineSeatPresence[];
  readonly serviceState: 'healthy' | 'degraded' | 'unavailable';
  readonly claim: OnlineClaimAvailability;
  readonly yourSeat: Seat | null;
}

export interface OnlinePresenceClientOptions {
  readonly requester: AuthorizedRequester;
  readonly session: ParticipantSession;
  readonly matchId: string;
  readonly seat: Seat;
}

export interface OnlinePresenceClient {
  /** Reports in and extends the liveness lease. */
  heartbeat(): Promise<OnlineSeatPresence>;
  /** Reads the presence of both seats and the claim option. */
  view(): Promise<OnlinePresenceView>;
  /** Records that the caller keeps waiting. */
  keepWaiting(): Promise<OnlineSeatPresence>;
}

/** The path of the presence route. */
export function onlinePresencePath(matchId: string): string {
  return `/v1/online/matches/${encodeURIComponent(matchId)}/presence`;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseSeatPresence(value: unknown, path: string): OnlineSeatPresence {
  const record = asRecord(value, path);
  const seat = record.seat;
  const state = record.state;
  if (seat !== 'white' && seat !== 'black') throw new Error(`${path}.seat is invalid.`);
  if (state !== 'connected' && state !== 'offline' && state !== 'unknown') {
    throw new Error(`${path}.state is invalid.`);
  }
  return {
    seat,
    state,
    lastHeartbeatAt: optionalTimestamp(record.lastHeartbeatAt),
    leaseExpiresAt: optionalTimestamp(record.leaseExpiresAt),
    offlineSince: optionalTimestamp(record.offlineSince),
    keepWaitingAt: optionalTimestamp(record.keepWaitingAt),
  };
}

function parsePresenceView(value: unknown, matchId: string): OnlinePresenceView {
  const path = 'presence';
  const record = asRecord(value, path);
  if (record.matchId !== matchId) throw new Error(`${path}.matchId is another match.`);
  const seats = Array.isArray(record.seats) ? record.seats : [];
  const claim = asRecord(record.claim, `${path}.claim`);
  const serviceState = record.serviceState;
  if (serviceState !== 'healthy' && serviceState !== 'degraded' && serviceState !== 'unavailable') {
    throw new Error(`${path}.serviceState is invalid.`);
  }
  const opponentSeat = claim.opponentSeat;
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 1,
    matchId,
    version: typeof record.version === 'number' ? record.version : 0,
    controlEpoch: typeof record.controlEpoch === 'number' ? record.controlEpoch : 0,
    status: typeof record.status === 'string' ? record.status : 'active',
    seats: seats.map((seat, index) => parseSeatPresence(seat, `${path}.seats[${index}]`)),
    serviceState,
    claim: {
      eligible: claim.eligible === true,
      reason: typeof claim.reason === 'string' ? claim.reason as OnlineClaimReason : 'opponent-unknown',
      opponentSeat: opponentSeat === 'white' || opponentSeat === 'black' ? opponentSeat : null,
      offlineSince: optionalTimestamp(claim.offlineSince),
      graceSecondsLeft: typeof claim.graceSecondsLeft === 'number' ? claim.graceSecondsLeft : 0,
    },
    yourSeat: record.yourSeat === 'white' || record.yourSeat === 'black' ? record.yourSeat : null,
  };
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
    return parseSeatPresence(result.data, 'presence');
  }

  return {
    heartbeat() {
      return postSeat('');
    },
    keepWaiting() {
      return postSeat('/keep-waiting');
    },
    async view() {
      const result = await requester.request(scope, { path });
      if (!result.ok) {
        throw new Error(`The service refused the presence request (${result.status}).`);
      }
      return parsePresenceView(result.data, matchId);
    },
  };
}
