/**
 * The lease wire between the browser and the service (KHA-73).
 *
 * The service of the online play owns the lease route and the route of the
 * uncertain provider request. The browser builds the bodies of both routes and
 * reads the lease answer of the service.
 *
 * The test ties the two implementations together with the shared fixtures of
 * the service: the Go answer of `backend/online/testdata/online-contracts.json`
 * is read by the parser of the runner *and* by the strict parser of the shared
 * contract, and the bodies that the browser builds are the bodies of the
 * shared wire fixture `backend/online/testdata/online-browser-bodies.json`.
 * The strict decoder of the service reads that very same fixture, so a body
 * the browser builds and a body the service refuses cannot both pass.
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
const browserBodiesPath = resolve(here, '../../backend/online/testdata/online-browser-bodies.json');

interface SharedFixture {
  readonly runnerLease: unknown;
}

function sharedFixture(): SharedFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as SharedFixture;
}

interface BrowserBodies {
  readonly leaseAcquire: unknown;
  readonly leaseRenew: unknown;
  readonly leaseRelease: unknown;
  readonly requestBegin: unknown;
  readonly requestClear: unknown;
}

function browserBodies(): BrowserBodies {
  return JSON.parse(readFileSync(browserBodiesPath, 'utf8')) as BrowserBodies;
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

  it('builds the bodies the strict decoder of the service reads', () => {
    // The bodies of the browser are the bodies of the shared wire fixture,
    // and the strict decoder of the service reads that fixture. The empty
    // lease identifier and the zero turn version are omitted, like the Go
    // envelope.
    const bodies = browserBodies();
    expect(buildRunnerLeaseBody({
      action: 'acquire',
      seat: 'white',
      runnerId: 'runner-tab-01',
      controlEpoch: 2,
      leaseId: null,
      turnVersion: null,
    })).toEqual(bodies.leaseAcquire);
    expect(buildRunnerLeaseBody({
      action: 'renew',
      seat: 'white',
      runnerId: 'runner-tab-01',
      controlEpoch: 2,
      leaseId: 'lease-contract-01',
      turnVersion: 4,
    })).toEqual(bodies.leaseRenew);
    expect(buildRunnerLeaseBody({
      action: 'release',
      seat: 'white',
      runnerId: 'runner-tab-01',
      controlEpoch: 2,
      leaseId: 'lease-contract-01',
      turnVersion: 4,
    })).toEqual(bodies.leaseRelease);
    expect(buildRunnerRequestBody({
      action: 'begin',
      seat: 'white',
      runnerId: 'runner-tab-01',
      leaseId: 'lease-contract-01',
      requestId: 'request-contract-01',
      controlEpoch: 2,
      turnVersion: 4,
    })).toEqual(bodies.requestBegin);
    expect(buildRunnerRequestBody({
      action: 'clear',
      seat: 'white',
      runnerId: 'runner-tab-01',
      leaseId: 'lease-contract-01',
      requestId: 'request-contract-01',
      controlEpoch: 2,
      turnVersion: 4,
    })).toEqual(bodies.requestClear);
  });
});
