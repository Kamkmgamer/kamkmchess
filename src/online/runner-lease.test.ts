import { describe, expect, it, vi } from 'vitest';
import { createOnlineRunnerLeaseClient, onlineRunnerLeasePath, onlineRunnerRequestPath } from './runner-lease';
import { parseRunnerLeaseAnswer, ProviderRunnerServiceError } from './provider-runner';
import { createParticipantSession } from './session';
import { createAuthorizedRequester } from './request';
import { createGuestCredential } from './auth';

const leaseAnswer = {
  schemaVersion: 2,
  leaseId: 'lease-0001',
  matchId: 'match-00000001',
  seat: 'black',
  controlEpoch: 3,
  generation: 1,
  runnerId: 'runner-1',
  status: 'active',
  acquiredAt: '2026-10-21T10:00:00.000Z',
  expiresAt: '2026-10-21T10:00:15.000Z',
  revokedAt: null,
  turnVersion: 7,
  runnerEpoch: 1,
  pendingRequestId: null,
  pendingRequestStartedAt: null,
  revokedReason: null,
  lastRenewedAt: null,
};

function createClient(respond: () => { status: number; data: unknown }) {
  const session = createParticipantSession();
  session.selectGuest(createGuestCredential({
    guestId: 'guest-1',
    matchId: 'match-00000001',
    seat: 'black',
    token: 'seat-token',
  }));
  const wires: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown>;
    wires.push({ path, method: init?.method ?? 'GET', body });
    const result = respond();
    return new Response(JSON.stringify(result.data), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  });
  const requester = createAuthorizedRequester({
    session,
    baseUrl: 'https://api.example.test',
    fetch: fetcher as unknown as typeof fetch,
  });
  const client = createOnlineRunnerLeaseClient({
    requester,
    session,
    matchId: 'match-00000001',
    seat: 'black',
    runnerId: 'runner-1',
  });
  return { client, wires };
}

describe('the runner lease wire', () => {
  it('acquires a lease with the strict request body', async () => {
    const { client, wires } = createClient(() => ({ status: 200, data: leaseAnswer }));
    const lease = await client.acquire({ controlEpoch: 3, turnVersion: 7 });
    expect(lease.leaseId).toBe('lease-0001');
    expect(lease.turnVersion).toBe(7);
    expect(wires[0]?.path).toContain(onlineRunnerLeasePath('match-00000001'));
    expect(wires[0]?.method).toBe('POST');
    expect(wires[0]?.body).toEqual({
      schemaVersion: 2,
      action: 'acquire',
      seat: 'black',
      runnerId: 'runner-1',
      controlEpoch: 3,
      turnVersion: 7,
    });
  });

  it('renews and releases with the same route and an action', async () => {
    const { client, wires } = createClient(() => ({ status: 200, data: leaseAnswer }));
    await client.renew({ controlEpoch: 3, turnVersion: 7, leaseId: 'lease-0001' });
    await client.release({ controlEpoch: 3, turnVersion: 7, leaseId: 'lease-0001' });
    expect(wires[0]?.body?.action).toBe('renew');
    expect(wires[0]?.body?.leaseId).toBe('lease-0001');
    expect(wires[1]?.body?.action).toBe('release');
    expect(wires[1]?.body?.leaseId).toBe('lease-0001');
  });

  it('records a provider request with its own route and body', async () => {
    const { client, wires } = createClient(() => ({ status: 200, data: leaseAnswer }));
    await client.beginRequest({ controlEpoch: 3, turnVersion: 7, leaseId: 'lease-0001', requestId: 'request-1' });
    expect(wires[0]?.path).toContain(onlineRunnerRequestPath('match-00000001'));
    expect(wires[0]?.body).toEqual({
      schemaVersion: 2,
      action: 'begin',
      seat: 'black',
      runnerId: 'runner-1',
      leaseId: 'lease-0001',
      requestId: 'request-1',
      controlEpoch: 3,
      turnVersion: 7,
    });
  });

  it('reads the lease of the seat with a query parameter', async () => {
    const { client, wires } = createClient(() => ({ status: 200, data: leaseAnswer }));
    const lease = await client.read();
    expect(lease?.leaseId).toBe('lease-0001');
    expect(wires[0]?.path).toContain('seat=black');
    expect(wires[0]?.method).toBe('GET');
  });

  it('reads a missing lease as no lease', async () => {
    const { client } = createClient(() => ({ status: 404, data: {} }));
    expect(await client.read()).toBeNull();
  });

  it('refuses a lease of another match', () => {
    expect(() => parseRunnerLeaseAnswer({ ...leaseAnswer, matchId: 'match-00000002' }, 'match-00000001', 'black')).toThrow(/another match/);
  });

  it('refuses a lease without an identity', () => {
    // The answer is read with the strict parser of the shared contract, so the
    // message names the field the contract refused.
    expect(() => parseRunnerLeaseAnswer({ ...leaseAnswer, leaseId: '' }, 'match-00000001', 'black')).toThrow(/invalid id/);
    expect(() => parseRunnerLeaseAnswer({ ...leaseAnswer, status: 'unknown' }, 'match-00000001', 'black')).toThrow(/invalid lease status/);
  });

  it('classifies a refused credential, a held lease and a missing lease', async () => {
    // The failure carries the real status, so the runner tells a refused
    // credential, a held lease and a missing lease apart.
    for (const [status, kind] of [[401, 'unauthorized'], [409, 'conflict'], [404, 'not-found']] as const) {
      const { client } = createClient(() => ({ status, data: {} }));
      const failure = await client.acquire({ controlEpoch: 1, turnVersion: 1 }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderRunnerServiceError);
      expect((failure as ProviderRunnerServiceError).kind).toBe(kind);
      expect((failure as ProviderRunnerServiceError).status).toBe(status);
    }
  });
});
