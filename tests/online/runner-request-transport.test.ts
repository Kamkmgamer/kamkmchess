import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOnlineRunnerLeaseClient } from '../../src/online/runner-lease';
import { parseRunnerRequestEnvelope } from '../../src/online/contracts';

// The emitted wire body of the runner request route.
//
// The service owns the strict decoder and the shared fixture, so the body the
// browser really sends is compared with the fixture of the service, and the
// emitted body is parsed with the same rules the service applies.

const fixturePath = 'backend/online/testdata/online-contracts.json';

interface ContractFixture {
  readonly runnerRequest: unknown;
  readonly runnerLease: {
    readonly leaseId: string;
    readonly runnerId: string;
    readonly seat: string;
    readonly controlEpoch: number;
    readonly turnVersion: number | null;
  };
}

interface CapturedWire {
  readonly path: string;
  readonly body: unknown;
}

function loadFixture(): ContractFixture {
  const raw = readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw) as ContractFixture;
}

function captureClient(fixture: ContractFixture): { wires: CapturedWire[]; client: ReturnType<typeof createOnlineRunnerLeaseClient> } {
  const wires: CapturedWire[] = [];
  const client = createOnlineRunnerLeaseClient({
    matchId: 'match-contract-01',
    seat: fixture.runnerLease.seat === 'white' ? 'white' : 'black',
    runnerId: fixture.runnerLease.runnerId,
    requester: {
      async request(_scope: unknown, init: { path: string; body?: unknown }) {
        wires.push({ path: init.path, body: init.body });
        return {
          status: 200,
          ok: true,
          data: {
            schemaVersion: 2,
            leaseId: fixture.runnerLease.leaseId,
            matchId: 'match-contract-01',
            seat: fixture.runnerLease.seat,
            controlEpoch: fixture.runnerLease.controlEpoch,
            generation: 1,
            runnerId: fixture.runnerLease.runnerId,
            status: 'active',
            acquiredAt: '2026-10-21T10:00:00Z',
            expiresAt: '2026-10-21T10:00:30Z',
            revokedAt: null,
            turnVersion: fixture.runnerLease.turnVersion,
            runnerEpoch: 2,
            pendingRequestId: null,
            pendingRequestStartedAt: null,
            revokedReason: null,
            lastRenewedAt: null,
          },
        };
      },
    },
  } as never);
  return { wires, client };
}

describe('the emitted runner request body', () => {
  it('sends the envelope of the shared fixture', async () => {
    const fixture = loadFixture();
    const { wires, client } = captureClient(fixture);
    await client.beginRequest({
      controlEpoch: fixture.runnerLease.controlEpoch,
      turnVersion: fixture.runnerLease.turnVersion,
      leaseId: fixture.runnerLease.leaseId,
      requestId: 'request-contract-01',
    });
    expect(wires).toHaveLength(1);
    expect(wires[0]?.path).toContain('/runner/request');
    expect(wires[0]?.body).toEqual(fixture.runnerRequest);
  });

  it('sends an explicit zero turn version when the caller supplies none', async () => {
    const fixture = loadFixture();
    const { wires, client } = captureClient(fixture);
    await client.beginRequest({
      controlEpoch: fixture.runnerLease.controlEpoch,
      turnVersion: null,
      leaseId: fixture.runnerLease.leaseId,
      requestId: 'request-contract-01',
    });
    const body = wires[0]?.body as Record<string, unknown>;
    expect(body.turnVersion).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(body, 'turnVersion')).toBe(true);
  });

  it('sends a clear body that matches the shared envelope parser', async () => {
    const fixture = loadFixture();
    const { wires, client } = captureClient(fixture);
    await client.clearRequest({
      controlEpoch: fixture.runnerLease.controlEpoch,
      turnVersion: fixture.runnerLease.turnVersion,
      leaseId: fixture.runnerLease.leaseId,
      requestId: 'request-contract-01',
    });
    const envelope = parseRunnerRequestEnvelope(wires[0]?.body);
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.action).toBe('clear');
    expect(envelope.leaseId).toBe(fixture.runnerLease.leaseId);
  });
});
