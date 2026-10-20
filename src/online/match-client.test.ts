import { describe, expect, it, vi } from 'vitest';
import { createOnlineMatchCommandClient, onlineCommandsPath } from './match-client';
import { createAuthorizedRequester } from './request';
import { createParticipantSession } from './session';
import { createGuestCredential } from './auth';
import type { AuthorizedResult } from './request';

function receiptBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    matchId: 'match-00000001',
    operationId: 'operation-1',
    outcome: 'accepted',
    version: 4,
    controlEpoch: 1,
    decidedAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

function createClient(respond: (body: unknown) => AuthorizedResult) {
  const session = createParticipantSession();
  session.selectGuest(createGuestCredential({
    guestId: 'guest-1',
    matchId: 'match-00000001',
    seat: 'white',
    token: 'seat-token',
  }));
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown;
    const result = respond(body);
    return new Response(JSON.stringify(result.data), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  });
  const requester = createAuthorizedRequester({
    session,
    baseUrl: 'https://api.example.test',
    fetch: fetcher as unknown as typeof fetch,
  });
  const client = createOnlineMatchCommandClient({
    requester,
    session,
    matchId: 'match-00000001',
    seat: 'white',
    createOperationId: () => 'operation-1',
  });
  return { client, fetcher, session };
}

describe('the participant command client', () => {
  it('posts the shared command contract to the command route', async () => {
    const { client, fetcher } = createClient(() => ({ status: 200, ok: true, data: receiptBody() }));
    await client.move('e2e4');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0]!;
    expect(String(input)).toContain(onlineCommandsPath('match-00000001'));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.schemaVersion).toBe(2);
    expect(body.matchId).toBe('match-00000001');
    expect(body.operationId).toBe('operation-1');
    expect(body.expectedVersion).toBe(1);
    expect(body.seat).toBe('white');
    expect(body.controlEpoch).toBe(1);
    expect(body.action).toEqual({ kind: 'submit_move', move: 'e2e4' });
    // A human seat carries no lease.
    expect('leaseId' in body).toBe(false);
  });

  it('carries the runner lease of an engine seat', async () => {
    const { client, fetcher } = createClient(() => ({ status: 200, ok: true, data: receiptBody() }));
    await client.move('e2e4', { leaseId: 'lease-0001' });
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body.leaseId).toBe('lease-0001');
  });

  it('sends the version the browser last saw', async () => {
    const { client, fetcher } = createClient(() => ({ status: 200, ok: true, data: receiptBody({ version: 7 }) }));
    client.setVersion(6);
    await client.move('e2e4');
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body.expectedVersion).toBe(6);
  });

  it('adopts the version of an accepted receipt', async () => {
    const { client } = createClient(() => ({ status: 200, ok: true, data: receiptBody({ version: 9 }) }));
    await client.move('e2e4');
    expect(client.expectedVersion).toBe(9);
  });

  it('refuses a receipt of another match', async () => {
    const { client } = createClient(() => ({ status: 200, ok: true, data: receiptBody({ matchId: 'match-00000002' }) }));
    await expect(client.move('e2e4')).rejects.toThrow(/another match/);
  });

  it('reports a refused command with its status', async () => {
    const { client } = createClient(() => ({ status: 409, ok: false, data: {} }));
    await expect(client.resign()).rejects.toThrow(/409/);
  });

  it('proposes the actions of the shared contract', async () => {
    const { client, fetcher } = createClient(() => ({ status: 200, ok: true, data: receiptBody() }));
    await client.offerDraw();
    await client.acceptDraw('offer-0001');
    await client.offerTakeback(3);
    await client.acceptTakeback('offer-0001');
    await client.setControl({ kind: 'human' });
    await client.cancel();
    const actions = fetcher.mock.calls.map(call => (JSON.parse(String(call[1]?.body)) as { action: unknown }).action);
    expect(actions).toEqual([
      { kind: 'offer_draw' },
      { kind: 'accept_draw', offerId: 'offer-0001' },
      { kind: 'offer_takeback', targetVersion: 3 },
      { kind: 'accept_takeback', offerId: 'offer-0001' },
      { kind: 'set_control', control: { kind: 'human' } },
      { kind: 'cancel' },
    ]);
  });
});
