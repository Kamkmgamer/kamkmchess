/**
 * The browser runner lease client (KHA-73, KHA-77).
 *
 * A seat that an agent or the browser engine controls needs a runner lease.
 * The service requires the lease on every command of such a seat, and it
 * fences a lease of an older control epoch or of an older turn.
 *
 * The client speaks the exact wire of the participant API. The request
 * bodies are built by the shared builders of the provider runner, so a change
 * of the contract lands in one place:
 *
 * ```
 * POST /v1/online/matches/{matchID}/runner/lease
 * POST /v1/online/matches/{matchID}/runner/request
 * GET  /v1/online/matches/{matchID}/runner/lease?seat=white
 * ```
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
import { buildRunnerLeaseBody, buildRunnerRequestBody, parseRunnerLeaseAnswer } from './provider-runner';
import type { ProviderRunnerLease, ProviderRunnerLeasePort } from './provider-runner';
import type { AuthorizedRequester } from './request';
import type { ParticipantSession } from './session';
import { matchSeatScope } from './auth';
import type { Seat } from './contracts';

export type { ProviderRunnerLease };

export interface OnlineRunnerLeaseOptions {
  readonly requester: AuthorizedRequester;
  readonly session: ParticipantSession;
  readonly matchId: string;
  readonly seat: Seat;
  /**
   * The identifier of this browser runner.
   *
   * Two tabs of one owner must not share it, because the service refuses a
   * second runner of a seat that a live lease holds.
   */
  readonly runnerId: string;
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
 * Creates the runner lease client.
 *
 * The client sends only the lease request fields and reads only the lease
 * answer. It never reads or writes a credential itself.
 */
export function createOnlineRunnerLeaseClient(options: OnlineRunnerLeaseOptions): ProviderRunnerLeasePort {
  const { requester, matchId, seat, runnerId } = options;
  const scope = matchSeatScope(matchId, seat);
  const leasePath = onlineRunnerLeasePath(matchId);
  const requestPath = onlineRunnerRequestPath(matchId);

  async function sendLease(
    action: 'acquire' | 'renew' | 'release',
    body: { controlEpoch: number; turnVersion: number | null; leaseId?: string | null },
  ): Promise<ProviderRunnerLease> {
    const result = await requester.request(scope, {
      path: leasePath,
      method: 'POST',
      body: buildRunnerLeaseBody({
        action,
        seat,
        runnerId,
        controlEpoch: body.controlEpoch,
        leaseId: body.leaseId ?? null,
        turnVersion: body.turnVersion ?? null,
      }),
    });
    if (!result.ok) {
      throw new Error(`The service refused the runner lease (${result.status}).`);
    }
    return parseRunnerLeaseAnswer(result.data, matchId, seat);
  }

  async function sendRequest(
    action: 'begin' | 'clear',
    body: { controlEpoch: number; turnVersion: number | null; leaseId: string; requestId: string },
  ): Promise<ProviderRunnerLease> {
    const result = await requester.request(scope, {
      path: requestPath,
      method: 'POST',
      body: buildRunnerRequestBody({
        action,
        seat,
        runnerId,
        leaseId: body.leaseId,
        requestId: body.requestId,
        controlEpoch: body.controlEpoch,
        turnVersion: body.turnVersion ?? null,
      }),
    });
    if (!result.ok) {
      throw new Error(`The service refused the runner request (${result.status}).`);
    }
    return parseRunnerLeaseAnswer(result.data, matchId, seat);
  }

  return {
    runnerId,
    acquire(input) {
      return sendLease('acquire', { controlEpoch: input.controlEpoch, turnVersion: input.turnVersion });
    },
    renew(input) {
      return sendLease('renew', {
        controlEpoch: input.controlEpoch,
        turnVersion: input.turnVersion,
        leaseId: input.leaseId,
      });
    },
    release(input) {
      return sendLease('release', {
        controlEpoch: input.controlEpoch,
        turnVersion: input.turnVersion,
        leaseId: input.leaseId,
      });
    },
    async read() {
      const result = await requester.request(scope, {
        path: `${leasePath}?seat=${encodeURIComponent(seat)}`,
      });
      if (result.status === 404) return null;
      if (!result.ok) {
        throw new Error(`The service refused the runner lease (${result.status}).`);
      }
      return parseRunnerLeaseAnswer(result.data, matchId, seat);
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
