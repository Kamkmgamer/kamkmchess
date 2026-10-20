/**
 * The browser runner lease client (KHA-73, KHA-77).
 *
 * A seat that an agent or the browser engine controls needs a runner lease.
 * The service requires the lease on every command of such a seat, and it
 * fences a lease of an older control epoch or of an older turn.
 *
 * The wire contract is the one of the participant API:
 *
 * ```
 * POST /v1/online/matches/{matchID}/runner/lease
 * { "schemaVersion": 2, "action": "acquire" | "renew" | "release",
 *   "seat": "white" | "black", "runnerId": "…",
 *   "leaseId"?: "…", "turnVersion"?: 7, "controlEpoch": 3 }
 *
 * GET /v1/online/matches/{matchID}/runner/lease?seat=white
 *
 * POST /v1/online/matches/{matchID}/runner/request
 * { "schemaVersion": 2, "action": "begin" | "clear",
 *   "seat": "white" | "black", "runnerId": "…",
 *   "leaseId": "…", "requestId": "…",
 *   "turnVersion"?: 7, "controlEpoch": 3 }
 * ```
 *
 * The service decodes the body strictly: an unknown field is refused. The
 * client therefore sends exactly the fields of the contract and nothing else.
 *
 * The rules this module keeps:
 *
 * - One lease per seat and per turn. A second tab of the same owner cannot
 *   take a lease that is already held.
 * - The lease is renewed while the runner works. A lease that expires during
 *   a long turn is renewed before the answer is submitted.
 * - The lease identifier travels in the command envelope. It is never sent as
 *   a query parameter and never written to a durable list.
 * - A released or revoked lease stops the runner. The runner never submits an
 *   answer under a lease it no longer holds.
 */
import type { AuthorizedRequester } from './request';
import type { ParticipantSession } from './session';
import { matchSeatScope } from './auth';
import type { LeaseStatus, Seat } from './contracts';

/** The lease the service answered. */
export interface OnlineRunnerLease {
  readonly leaseId: string;
  readonly matchId: string;
  readonly seat: Seat;
  readonly controlEpoch: number;
  readonly generation: number;
  readonly runnerId: string;
  readonly status: LeaseStatus;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  /** The version of the turn the lease was taken for, when the service names one. */
  readonly turnVersion: number | null;
}

/** The failure of a lease request. */
export class OnlineRunnerLeaseError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'OnlineRunnerLeaseError';
    this.status = status;
  }
}

export interface OnlineRunnerLeaseOptions {
  readonly requester: AuthorizedRequester;
  readonly session: ParticipantSession;
  readonly matchId: string;
  readonly seat: Seat;
  /** The identifier of this browser runner. It never leaves the browser. */
  readonly runnerId: string;
  /** The schema version of the shared contracts. */
  readonly schemaVersion?: number;
}

/** The identity of one lease request. */
export interface OnlineLeaseTurn {
  /** The control epoch of the seat. A lease of an older epoch is fenced. */
  readonly controlEpoch: number;
  /** The version of the turn the lease belongs to. */
  readonly turnVersion: number;
}

/** The client of one runner lease. */
export interface OnlineRunnerLeaseClient {
  /** Takes the lease of the current turn. */
  acquire(input: OnlineLeaseTurn): Promise<OnlineRunnerLease>;
  /** Renews the lease of the current turn. */
  renew(input: OnlineLeaseTurn & { leaseId: string }): Promise<OnlineRunnerLease>;
  /** Releases the lease of the current turn. */
  release(input: OnlineLeaseTurn & { leaseId: string }): Promise<OnlineRunnerLease>;
  /** Reads the lease of the seat. */
  read(): Promise<OnlineRunnerLease | null>;
  /** Records that a billable provider request started. */
  beginRequest(input: OnlineLeaseTurn & { leaseId: string; requestId: string }): Promise<OnlineRunnerLease>;
  /** Records that a billable provider request settled. */
  clearRequest(input: OnlineLeaseTurn & { leaseId: string; requestId: string }): Promise<OnlineRunnerLease>;
}

/** The path of the runner lease route. */
export function onlineRunnerLeasePath(matchId: string): string {
  return `/v1/online/matches/${encodeURIComponent(matchId)}/runner/lease`;
}

/** The path of the runner request route. */
export function onlineRunnerRequestPath(matchId: string): string {
  return `/v1/online/matches/${encodeURIComponent(matchId)}/runner/request`;
}

/**
 * Reads a lease answer.
 *
 * The parser is tolerant about the fields the service may add: it reads the
 * lease identity and its state and ignores the rest.
 */
export function parseRunnerLeaseAnswer(value: unknown, matchId: string): OnlineRunnerLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OnlineRunnerLeaseError('The lease answer is not an object.');
  }
  const record = value as Record<string, unknown>;
  const leaseId = record.leaseId;
  const answerMatchId = record.matchId;
  const seat = record.seat;
  const controlEpoch = record.controlEpoch;
  const generation = record.generation;
  const runnerId = record.runnerId;
  const status = record.status;
  const acquiredAt = record.acquiredAt;
  const expiresAt = record.expiresAt;
  const revokedAt = record.revokedAt;
  if (typeof leaseId !== 'string' || leaseId.length === 0) {
    throw new OnlineRunnerLeaseError('The lease answer carries no lease.');
  }
  if (typeof answerMatchId !== 'string' || answerMatchId !== matchId) {
    throw new OnlineRunnerLeaseError('The lease belongs to another match.');
  }
  if (seat !== 'white' && seat !== 'black') {
    throw new OnlineRunnerLeaseError('The lease answer carries no seat.');
  }
  if (typeof controlEpoch !== 'number' || !Number.isSafeInteger(controlEpoch)) {
    throw new OnlineRunnerLeaseError('The lease answer carries no control epoch.');
  }
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation)) {
    throw new OnlineRunnerLeaseError('The lease answer carries no generation.');
  }
  if (typeof runnerId !== 'string') {
    throw new OnlineRunnerLeaseError('The lease answer carries no runner.');
  }
  if (status !== 'active' && status !== 'revoked' && status !== 'expired') {
    throw new OnlineRunnerLeaseError('The lease answer carries no state.');
  }
  return {
    leaseId,
    matchId: answerMatchId,
    seat,
    controlEpoch,
    generation,
    runnerId,
    status,
    acquiredAt: typeof acquiredAt === 'string' ? acquiredAt : '',
    expiresAt: typeof expiresAt === 'string' ? expiresAt : '',
    revokedAt: typeof revokedAt === 'string' ? revokedAt : null,
    turnVersion: typeof record.turnVersion === 'number' ? record.turnVersion : null,
  };
}

/**
 * Creates the runner lease client.
 *
 * The client sends only the lease request fields and reads only the lease
 * answer. It never reads or writes a credential itself.
 */
export function createOnlineRunnerLeaseClient(options: OnlineRunnerLeaseOptions): OnlineRunnerLeaseClient {
  const { requester, matchId, seat, runnerId } = options;
  const scope = matchSeatScope(matchId, seat);
  const leasePath = onlineRunnerLeasePath(matchId);
  const requestPath = onlineRunnerRequestPath(matchId);
  const schemaVersion = options.schemaVersion ?? 2;

  async function sendLease(
    action: 'acquire' | 'renew' | 'release',
    body: { controlEpoch: number; turnVersion: number; leaseId?: string },
  ): Promise<OnlineRunnerLease> {
    const result = await requester.request(scope, {
      path: leasePath,
      method: 'POST',
      body: {
        schemaVersion,
        action,
        seat,
        runnerId,
        controlEpoch: body.controlEpoch,
        turnVersion: body.turnVersion,
        ...(body.leaseId ? { leaseId: body.leaseId } : {}),
      },
    });
    if (!result.ok) {
      throw new OnlineRunnerLeaseError(`The service refused the runner lease (${result.status}).`, result.status);
    }
    return parseRunnerLeaseAnswer(result.data, matchId);
  }

  async function sendRequest(
    action: 'begin' | 'clear',
    body: { controlEpoch: number; turnVersion: number; leaseId: string; requestId: string },
  ): Promise<OnlineRunnerLease> {
    const result = await requester.request(scope, {
      path: requestPath,
      method: 'POST',
      body: {
        schemaVersion,
        action,
        seat,
        runnerId,
        leaseId: body.leaseId,
        requestId: body.requestId,
        controlEpoch: body.controlEpoch,
        turnVersion: body.turnVersion,
      },
    });
    if (!result.ok) {
      throw new OnlineRunnerLeaseError(`The service refused the runner request (${result.status}).`, result.status);
    }
    return parseRunnerLeaseAnswer(result.data, matchId);
  }

  return {
    acquire(input) {
      return sendLease('acquire', input);
    },
    renew(input) {
      return sendLease('renew', { controlEpoch: input.controlEpoch, turnVersion: input.turnVersion, leaseId: input.leaseId });
    },
    release(input) {
      return sendLease('release', { controlEpoch: input.controlEpoch, turnVersion: input.turnVersion, leaseId: input.leaseId });
    },
    async read() {
      const result = await requester.request(scope, {
        path: `${leasePath}?seat=${encodeURIComponent(seat)}`,
      });
      if (result.status === 404) return null;
      if (!result.ok) {
        throw new OnlineRunnerLeaseError(`The service refused the runner lease (${result.status}).`, result.status);
      }
      return parseRunnerLeaseAnswer(result.data, matchId);
    },
    beginRequest(input) {
      return sendRequest('begin', {
        controlEpoch: input.controlEpoch,
        turnVersion: input.turnVersion,
        leaseId: input.leaseId,
        requestId: input.requestId,
      });
    },
    clearRequest(input) {
      return sendRequest('clear', {
        controlEpoch: input.controlEpoch,
        turnVersion: input.turnVersion,
        leaseId: input.leaseId,
        requestId: input.requestId,
      });
    },
  };
}
