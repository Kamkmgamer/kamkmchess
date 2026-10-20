import { describe, expect, it } from 'vitest';
import {
  FriendError,
  createAcceptanceKey,
  createFetchFriendTransport,
  createFriendClient,
  isAcceptableInvitation,
  needsCredentialRotation,
  needsGuestSeatCredential,
  parseInvitation,
  type FriendInvitation,
  type FriendTransport,
} from './friends';

const invitation: FriendInvitation = {
  schemaVersion: 2,
  invitationId: 'inv_0123456789',
  kind: 'link',
  status: 'open',
  inviterLabel: 'Guest',
  inviterSeat: 'white',
  inviterControl: { kind: 'human' },
  timeControl: { startingTimeMs: 300000, incrementMs: 2000 },
  startingFen: null,
  expiresAt: '2026-10-21T10:00:00Z',
  createdAt: '2026-10-20T22:00:00Z',
  consumedAt: null,
  cancelledAt: null,
  matchId: null,
};

describe('the friend client', () => {
  it('sends the documented routes and parses the answers', async () => {
    const calls: string[] = [];
    const matchView = { matchId: 'match-1', yourSeat: 'black' };
    const transport: FriendTransport = {
      async send(request) {
        calls.push(`${request.method} ${request.path}`);
        if (request.method === 'GET') return invitation;
        if (request.path.endsWith('/accept')) {
          return { schemaVersion: 2, match: matchView, seat: 'black', acceptanceId: 'acc_1', guestCredential: null };
        }
        if (request.path.endsWith('/cancel')) return invitation;
        if (request.path.endsWith('/seat-credential')) {
          return { schemaVersion: 2, matchId: 'match-1', seat: 'white', guestCredential: null };
        }
        return { schemaVersion: 2, invitation, ownerToken: 'kmoi1_token' };
      },
    };
    const client = createFriendClient(transport);
    const created = await client.createInvitation({
      seat: 'white',
      timeControl: { startingTimeMs: 300000, incrementMs: 2000 },
      control: { kind: 'human' },
    });
    expect(calls[0]).toBe('POST /v1/online/invitations');
    expect(created.invitation.inviterLabel).toBe('Guest');
    expect(created.ownerToken).toBe('kmoi1_token');

    await client.readInvitation('inv_0123456789');
    expect(calls[1]).toBe('GET /v1/online/invitations/inv_0123456789');

    await client.acceptInvitation('inv_0123456789', {
      control: { kind: 'human' },
      acceptanceKey: 'ak_0123456789abcdef',
    });
    expect(calls[2]).toBe('POST /v1/online/invitations/inv_0123456789/accept');

    await client.cancelInvitation('inv_0123456789', 'kmoi1_token');
    expect(calls[3]).toBe('POST /v1/online/invitations/inv_0123456789/cancel');

    await client.claimSeatCredential('inv_0123456789', 'kmoi1_token');
    expect(calls[4]).toBe('POST /v1/online/invitations/inv_0123456789/seat-credential');
  });

  it('answers a missing pending rematch with null', async () => {
    const transport: FriendTransport = {
      async send() {
        throw new FriendError('not-found', 'gone', 404);
      },
    };
    const client = createFriendClient(transport);
    await expect(client.readPendingRematch('match-1')).resolves.toBeNull();
  });

  it('refuses an answer with an unknown shape', () => {
    expect(() => parseInvitation({ ...invitation, status: 'maybe' })).toThrowError(FriendError);
    expect(() => parseInvitation({ ...invitation, inviterSeat: 'side' })).toThrowError(FriendError);
    expect(() => parseInvitation({ ...invitation, timeControl: { startingTimeMs: 'x', incrementMs: 0 } })).toThrowError(FriendError);
  });
});

describe('the friend domain rules', () => {
  it('accepts only an open invitation', () => {
    expect(isAcceptableInvitation(invitation)).toBe(true);
    expect(isAcceptableInvitation({ ...invitation, status: 'consumed' })).toBe(false);
    expect(isAcceptableInvitation({ ...invitation, status: 'cancelled' })).toBe(false);
    expect(isAcceptableInvitation({ ...invitation, status: 'expired' })).toBe(false);
  });

  it('claims a guest seat credential only after the match exists', () => {
    expect(needsGuestSeatCredential(invitation, { isGuest: true, credentialReceived: false })).toBe(false);
    const consumed: FriendInvitation = { ...invitation, status: 'consumed', matchId: 'match-1' };
    expect(needsGuestSeatCredential(consumed, { isGuest: true, credentialReceived: false })).toBe(true);
    expect(needsGuestSeatCredential(consumed, { isGuest: true, credentialReceived: true })).toBe(false);
    expect(needsGuestSeatCredential(consumed, { isGuest: false, credentialReceived: false })).toBe(false);
  });

  it('rotates a credential only when none works', () => {
    expect(needsCredentialRotation(false)).toBe(true);
    expect(needsCredentialRotation(true)).toBe(false);
  });

  it('builds an acceptance key that the service accepts', () => {
    const key = createAcceptanceKey(() => 'abc');
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
});

describe('the fetch transport', () => {
  it('never puts a credential in the URL or the body', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const transport = createFetchFriendTransport({
      baseUrl: 'https://api.example/',
      fetch: async (input, init) => {
        seen.push({ url: String(input), init });
        return new Response(JSON.stringify({ schemaVersion: 2, invitation, ownerToken: 'token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      credential: () => ({ Authorization: 'Bearer session' }),
    });
    const client = createFriendClient(transport);
    await client.createInvitation({
      seat: 'white',
      timeControl: { startingTimeMs: 300000, incrementMs: 0 },
      control: { kind: 'human' },
    });
    expect(seen[0]?.url).toBe('https://api.example/v1/online/invitations');
    expect(String(seen[0]?.init?.body)).not.toContain('Bearer');
    const headers = (seen[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer session');
  });

  it('sends an anonymous request without a credential', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const transport = createFetchFriendTransport({
      baseUrl: 'https://api.example',
      fetch: async (input, init) => {
        seen.push({ url: String(input), init });
        return new Response(JSON.stringify(invitation), { status: 200 });
      },
    });
    const client = createFriendClient(transport);
    await client.readInvitation('inv_0123456789');
    const headers = (seen[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('maps a refused answer onto a stable code', async () => {
    const transport = createFetchFriendTransport({
      baseUrl: 'https://api.example',
      fetch: async () => new Response(JSON.stringify({ error: 'conflict' }), { status: 409 }),
    });
    const client = createFriendClient(transport);
    await expect(client.readInvitation('inv_1')).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});
