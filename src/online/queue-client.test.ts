import { describe, expect, it, vi } from 'vitest';
import { ONLINE_QUEUE_ROUTES, createOnlineQueueClient } from './queue-client';
import { createAuthorizedRequester } from './request';
import { createParticipantSession } from './session';

const entryAnswer = {
  schemaVersion: 2,
  entryId: 'entry-0000001',
  owner: { kind: 'account', id: 'account-1' },
  control: { kind: 'human' },
  timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
  status: 'waiting',
  version: 1,
  readyAt: '2026-10-21T10:00:00.000Z',
  cutoffAt: '2026-10-21T10:00:10.000Z',
  assignedMatchId: null,
  createdAt: '2026-10-21T10:00:00.000Z',
  updatedAt: '2026-10-21T10:00:00.000Z',
};

function createClient(respond: (path: string, body: unknown) => { status: number; data: unknown }) {
  // The queue is an account surface: the guest seat credential is refused.
  const session = createParticipantSession({
    accountSession: {
      identity: { accountId: 'account-1', token: async () => 'account-token' },
      subscribe: () => () => undefined,
    },
  });
  const wires: { path: string; method: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown;
    wires.push({ path, method: init?.method ?? 'GET', body });
    const result = respond(path, body);
    return new Response(JSON.stringify(result.data), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  });
  const requester = createAuthorizedRequester({
    session,
    baseUrl: 'https://api.example.test',
    fetch: fetcher as unknown as typeof fetch,
  });
  return { client: createOnlineQueueClient({ requester }), wires, session };
}

describe('the queue client speaks the published routes', () => {
  it('creates an entry with the shared body and an idempotency key', async () => {
    const { client, wires } = createClient(() => ({ status: 201, data: entryAnswer }));
    const entry = await client.create({
      control: { kind: 'agent', modelLabel: 'GPT-4o' },
      timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
      clientRequestId: 'intent-0001',
    });
    expect(entry.entryId).toBe('entry-0000001');
    expect(wires[0]?.path).toContain(ONLINE_QUEUE_ROUTES.entries);
    expect(wires[0]?.method).toBe('POST');
    expect(wires[0]?.body).toEqual({
      schemaVersion: 2,
      control: { kind: 'agent', modelLabel: 'GPT-4o' },
      timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
      clientRequestId: 'intent-0001',
    });
  });

  it('reads, readies, cancels and keeps searching', async () => {
    const { client, wires } = createClient(() => ({ status: 200, data: entryAnswer }));
    await client.read('entry-0000001');
    await client.ready('entry-0000001');
    await client.cancel('entry-0000001');
    await client.keepSearching('entry-0000001');
    expect(wires.map(wire => wire.path.replace('https://api.example.test', ''))).toEqual([
      '/v1/online/queue/entries/entry-0000001',
      '/v1/online/queue/entries/entry-0000001/ready',
      '/v1/online/queue/entries/entry-0000001/cancel',
      '/v1/online/queue/entries/entry-0000001/keep-searching',
    ]);
  });

  it('reads a missing candidate as no candidate', async () => {
    const { client } = createClient(() => ({ status: 404, data: {} }));
    expect(await client.findCompatible('entry-0000001')).toBeNull();
  });

  it('reads the assignment of a compatible entry', async () => {
    const { client } = createClient(() => ({ status: 200, data: {
      schemaVersion: 2,
      matchId: 'match-00000001',
      seat: 'black',
      opponentLabel: 'Bob',
      control: { kind: 'agent', modelLabel: 'GPT-4o' },
    } }));
    const assignment = await client.findCompatible('entry-0000001');
    expect(assignment?.matchId).toBe('match-00000001');
    expect(assignment?.seat).toBe('black');
  });

  it('reads the engine seat credential of a fallback answer', async () => {
    const { client } = createClient(() => ({ status: 200, data: {
      schemaVersion: 2,
      matchId: 'match-00000001',
      seat: 'white',
      opponentLabel: 'Stockfish 19 Lite',
      control: { kind: 'engine', modelLabel: 'Stockfish 19 Lite' },
      guestCredential: {
        guestId: 'guest-engine',
        matchId: 'match-00000001',
        seat: 'black',
        token: 'engine-token',
        expiresAt: '2026-10-22T10:00:00Z',
      },
    } }));
    const answer = await client.commitFallback('entry-0000001');
    expect(answer.matchId).toBe('match-00000001');
    expect(answer.engineCredential).not.toBeNull();
  });

  it('refuses an answer of another schema version', async () => {
    const { client } = createClient(() => ({ status: 200, data: { ...entryAnswer, schemaVersion: 1 } }));
    await expect(client.read('entry-0000001')).rejects.toThrow();
  });
});
