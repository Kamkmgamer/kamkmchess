import { describe, expect, it, vi } from 'vitest';
import { createFriendSurface } from './friend-routes';
import { createFriendSecretStore } from './friend-secrets';

const timeControl = { startingTimeMs: 300_000, incrementMs: 2_000 };

function createStorage(): { data: Map<string, string>; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void } {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
}

const invitationAnswer = {
  schemaVersion: 2,
  invitationId: 'invitation-0001',
  kind: 'link',
  status: 'open',
  inviterLabel: 'Guest',
  inviterSeat: 'white',
  inviterControl: { kind: 'human' },
  timeControl,
  startingFen: null,
  expiresAt: '2026-10-22T10:00:00Z',
  createdAt: '2026-10-21T10:00:00Z',
  consumedAt: null,
  cancelledAt: null,
  matchId: null,
};

describe('the browser adapter of the friend surface', () => {
  it('stores the acceptance key before the acceptance and replays it', async () => {
    const storage = createStorage();
    const secrets = createFriendSecretStore({ storage, identity: 'guest' });
    const bodies: (Record<string, unknown> | null)[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        schemaVersion: 2,
        match: { matchId: 'match-00000001' },
        seat: 'black',
        acceptanceId: 'acceptance-0001',
        guestCredential: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const surface = createFriendSurface({
      baseUrl: 'https://api.example.test',
      fetch: fetcher as unknown as typeof fetch,
      secrets,
    });
    await surface.accept('invitation-0001', { kind: 'human' });
    const first = bodies[0]?.acceptanceKey;
    expect(typeof first).toBe('string');
    // The key is stored before the acceptance is sent.
    expect(secrets.readAcceptanceKey('invitation-0001')).toBe(first);
    // A retry of the same intent replays the same key.
    await surface.accept('invitation-0001', { kind: 'human' });
    expect(bodies[1]?.acceptanceKey).toBe(first);
    expect(secrets.readAcceptanceKey('invitation-0001')).toBe(first);
  });

  it('finds the stored key again after a reload', () => {
    const storage = createStorage();
    const first = createFriendSecretStore({ storage, identity: 'guest' });
    const key = first.acceptanceKey('invitation-0002');
    const reloaded = createFriendSecretStore({ storage, identity: 'guest' });
    expect(reloaded.readAcceptanceKey('invitation-0002')).toBe(key);
    expect(reloaded.acceptanceKey('invitation-0002')).toBe(key);
  });

  it('never accepts an invitation this browser created', async () => {
    const storage = createStorage();
    const secrets = createFriendSecretStore({ storage, identity: 'guest' });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      invitation: invitationAnswer,
      ownerToken: 'owner-token',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    const surface = createFriendSurface({
      baseUrl: 'https://api.example.test',
      fetch: fetcher as unknown as typeof fetch,
      secrets,
    });
    await surface.create({ seat: 'white', timeControl, control: { kind: 'human' } });
    expect(secrets.ownsInvitation('invitation-0001')).toBe(true);
    await expect(surface.accept('invitation-0001', { kind: 'human' })).rejects.toThrow(/created the invitation/);
  });

  it('keeps the secrets of one identity away from another identity', () => {
    const storage = createStorage();
    const secrets = createFriendSecretStore({ storage, identity: 'account-1' });
    const key = secrets.acceptanceKey('invitation-0003');
    secrets.setIdentity('account-2');
    expect(secrets.readAcceptanceKey('invitation-0003')).toBeNull();
    secrets.setIdentity('account-1');
    expect(secrets.readAcceptanceKey('invitation-0003')).toBe(key);
  });
});
