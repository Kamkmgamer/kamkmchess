/**
 * The lease wire between the browser and the service (KHA-73).
 *
 * The service of the online play owns the lease route and the route of the
 * uncertain provider request. The browser builds the bodies of both routes and
 * reads the lease answer of the service.
 *
 * The test ties the two implementations together with the shared fixture of the
 * service: the Go answer of `backend/online/testdata/online-contracts.json` is
 * read by the parser of the runner *and* by the strict parser of the shared
 * contract, and the bodies that the browser builds carry exactly the fields
 * that the strict decoder of the service accepts.
 *
 * The fixture is the contract of the service, so a change of the Go answer
 * that the browser does not understand fails here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseRunnerLease } from '../../src/online/contracts';
import {
  buildRunnerLeaseBody,
  buildRunnerRequestBody,
  parseRunnerLeaseAnswer,
} from '../../src/online/provider-runner';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../backend/online/testdata/online-contracts.json');

interface SharedFixture {
  readonly runnerLease: unknown;
}

function sharedFixture(): SharedFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as SharedFixture;
}

describe('the lease wire of the browser and the service', () => {
  it('reads the answer of the service with the parser of the runner and with the shared parser', () => {
    const fixture = sharedFixture();
    const answer = parseRunnerLeaseAnswer(fixture.runnerLease, 'match-contract-01', 'white');
    const shared = parseRunnerLease(fixture.runnerLease);

    // The two parsers of one DTO read the same answer of the service.
    expect(answer.leaseId).toBe(shared.leaseId);
    expect(answer.matchId).toBe(shared.matchId);
    expect(answer.seat).toBe(shared.seat);
    expect(answer.controlEpoch).toBe(shared.controlEpoch);
    expect(answer.generation).toBe(shared.generation);
    expect(answer.runnerId).toBe(shared.runnerId);
    expect(answer.status).toBe(shared.status);
    expect(answer.turnVersion).toBe(shared.turnVersion);
    expect(answer.runnerEpoch).toBe(shared.runnerEpoch);
    expect(answer.pendingRequestId).toBe(shared.pendingRequestId);
    expect(answer.pendingRequestStartedAt).toBe(shared.pendingRequestStartedAt);
    expect(answer.revokedReason).toBe(shared.revokedReason);
    expect(answer.lastRenewedAt).toBe(shared.lastRenewedAt);
    expect(answer.acquiredAt).toBe(shared.acquiredAt);
    expect(answer.expiresAt).toBe(shared.expiresAt);
    expect(answer.revokedAt).toBe(shared.revokedAt);
  });

  it('refuses the answer of the service for another match or another seat', () => {
    const fixture = sharedFixture();
    expect(() => parseRunnerLeaseAnswer(fixture.runnerLease, 'match-other-01', 'white')).toThrow();
    expect(() => parseRunnerLeaseAnswer(fixture.runnerLease, 'match-contract-01', 'black')).toThrow();
  });

  it('builds the bodies of the service without a field it does not know', () => {
    // The decoder of the service refuses an unknown field, so the bodies of
    // the browser carry exactly the fields of its envelope. The empty lease
    // identifier and the zero turn version are omitted, like the Go envelope.
    const acquire = buildRunnerLeaseBody({
      action: 'acquire',
      seat: 'white',
      runnerId: 'runner-tab-01',
      controlEpoch: 2,
      leaseId: null,
      turnVersion: null,
    });
    expect(Object.keys(acquire).sort()).toEqual([
      'action',
      'controlEpoch',
      'runnerId',
      'schemaVersion',
      'seat',
    ]);

    const renew = buildRunnerLeaseBody({
      action: 'renew',
      seat: 'white',
      runnerId: 'runner-tab-01',
      controlEpoch: 2,
      leaseId: 'lease-contract-01',
      turnVersion: 4,
    });
    expect(Object.keys(renew).sort()).toEqual([
      'action',
      'controlEpoch',
      'leaseId',
      'runnerId',
      'schemaVersion',
      'seat',
      'turnVersion',
    ]);

    const request = buildRunnerRequestBody({
      action: 'begin',
      seat: 'white',
      runnerId: 'runner-tab-01',
      leaseId: 'lease-contract-01',
      requestId: 'request-contract-01',
      controlEpoch: 2,
      turnVersion: 4,
    });
    expect(Object.keys(request).sort()).toEqual([
      'action',
      'controlEpoch',
      'leaseId',
      'requestId',
      'runnerId',
      'schemaVersion',
      'seat',
      'turnVersion',
    ]);
  });
});
