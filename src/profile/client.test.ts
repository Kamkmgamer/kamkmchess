import { describe, expect, it, vi } from 'vitest';
import { ProfileRequestError, createProfileClient } from './client';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function recordingFetch(handler: (request: RecordedRequest) => Response) {
  const calls: RecordedRequest[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name] = value;
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(request);
    return handler(request);
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const publicProfile = {
  schemaVersion: 1,
  profileId: 'kp_alphaalphaalpha',
  username: 'Alice',
  avatar: { kind: 'chosen', value: 'harbor' },
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:05:00Z',
};

const ownProfile = {
  ...publicProfile,
  username: null,
  avatar: { kind: 'generated', value: 'kp_alphaalphaalpha' },
  guestLinks: [],
};

describe('profile client', () => {
  it('reads a public profile without a credential', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const client = createProfileClient({ baseUrl: 'https://service.example', accountToken: async () => 'jwt', fetch: fetcher });

    const profile = await client.readPublicProfile('kp_alphaalphaalpha');

    expect(profile.username).toBe('Alice');
    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.url).toBe('https://service.example/v1/profiles/kp_alphaalphaalpha');
    expect(calls.at(0)?.headers.Authorization).toBeUndefined();
    expect(calls.at(0)?.headers['X-Guest-Seat-Token']).toBeUndefined();
  });

  it('looks a public name up without a credential', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const client = createProfileClient({ baseUrl: 'https://service.example', accountToken: async () => 'jwt', fetch: fetcher });

    await client.readPublicProfileByUsername('Alice');

    expect(calls.at(0)?.url).toBe('https://service.example/v1/profiles/username/Alice');
    expect(calls.at(0)?.headers.Authorization).toBeUndefined();
  });

  it('reports a missing public name as a not found', async () => {
    const { fetcher } = recordingFetch(() => json({ error: 'not_found' }, 404));
    const client = createProfileClient({ baseUrl: 'https://service.example', accountToken: async () => 'jwt', fetch: fetcher });

    await expect(client.readPublicProfileByUsername('nobody')).rejects.toThrow(/No player uses that name/);
  });

  it('sends the account credential for an account route and never in the body', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const client = createProfileClient({ baseUrl: 'https://service.example', accountToken: async () => 'jwt-1', fetch: fetcher });

    await client.updateOwnProfile({ username: 'Alice' });

    expect(calls.at(0)?.method).toBe('PUT');
    expect(calls.at(0)?.headers.Authorization).toBe('Bearer jwt-1');
    expect(calls.at(0)?.body).toBe('{"username":"Alice"}');
    expect(calls.at(0)?.body).not.toContain('jwt-1');
  });

  it('reports a name that another profile already owns', async () => {
    const { fetcher } = recordingFetch(() => json({ error: 'username_taken' }, 409));
    const client = createProfileClient({ baseUrl: 'https://service.example', accountToken: async () => 'jwt', fetch: fetcher });

    await expect(client.updateOwnProfile({ username: 'rookie' })).rejects.toThrow(/already taken/);
  });

  it('refuses to work without a signed-in account', async () => {
    const { calls, fetcher } = recordingFetch(() => json(ownProfile));
    const client = createProfileClient({ baseUrl: 'https://service.example', accountToken: async () => '', fetch: fetcher });

    await expect(client.readOwnProfile()).rejects.toThrow(/Sign in/);
    expect(calls).toHaveLength(0);
  });

  it('links a guest seat by proving the seat first and binding the proof second', async () => {
    const { calls, fetcher } = recordingFetch(request => {
      if (request.url.endsWith('/v1/guest-seats/ownership-proof')) {
        return json({
          schemaVersion: 1,
          proofId: 'kgp_proofproofproof',
          secret: 'kgp1_secretsecretsecret',
          matchId: 'match_alpha',
          seat: 'white',
          expiresAt: '2026-10-20T10:30:00Z',
        });
      }
      return json({
        schemaVersion: 1,
        linkId: 'kl_linklinklink',
        profileId: 'kp_alphaalphaalpha',
        matchId: 'match_alpha',
        seat: 'white',
        linkedAt: '2026-10-20T10:15:00Z',
      });
    });
    const client = createProfileClient({
      baseUrl: 'https://service.example',
      accountToken: async () => 'jwt-1',
      guestSeatToken: async () => 'guest-secret',
      fetch: fetcher,
    });

    const link = await client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' });

    expect(link.matchId).toBe('match_alpha');
    expect(calls).toHaveLength(2);
    expect(calls.at(0)?.headers['X-Guest-Seat-Token']).toBe('guest-secret');
    expect(calls.at(0)?.headers.Authorization).toBeUndefined();
    expect(calls.at(1)?.headers.Authorization).toBe('Bearer jwt-1');
    expect(calls.at(1)?.headers['X-Guest-Ownership-Proof']).toBe('kgp1_secretsecretsecret');
    expect(calls.at(1)?.body).toBe('{"matchId":"match_alpha","seat":"white"}');
  });

  it('refuses to link a seat the proof does not name', async () => {
    const { calls, fetcher } = recordingFetch(() => json({
      schemaVersion: 1,
      proofId: 'kgp_proofproofproof',
      secret: 'kgp1_secretsecretsecret',
      matchId: 'match_beta',
      seat: 'white',
      expiresAt: '2026-10-20T10:30:00Z',
    }));
    const client = createProfileClient({
      baseUrl: 'https://service.example',
      accountToken: async () => 'jwt-1',
      guestSeatToken: async () => 'guest-secret',
      fetch: fetcher,
    });

    await expect(client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' })).rejects.toThrow(/another seat/);
    expect(calls).toHaveLength(1);
  });

  it('refuses to link a guest seat when the browser holds no guest credential', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const client = createProfileClient({ baseUrl: 'https://service.example', accountToken: async () => 'jwt-1', fetch: fetcher });

    await expect(client.linkGuestSeat({ matchId: 'match_alpha', seat: 'white' })).rejects.toThrow(/No guest seat/);
    expect(calls).toHaveLength(0);
  });

  it('keeps the request on the trusted origin and carries no cookie', async () => {
    const { calls, fetcher } = recordingFetch(() => json(publicProfile));
    const client = createProfileClient({ baseUrl: 'https://service.example', accountToken: async () => 'jwt', fetch: fetcher });

    await client.readPublicProfile('kp_alphaalphaalpha');

    expect(calls.at(0)?.url.startsWith('https://service.example/')).toBe(true);
  });

  it('refuses a base URL that is not a trusted service origin', () => {
    expect(() => createProfileClient({ baseUrl: 'http://service.example', accountToken: async () => 'jwt' })).toThrow(/HTTPS/);
    expect(() => createProfileClient({ baseUrl: 'not a url', accountToken: async () => 'jwt' })).toThrow(/invalid/);
    expect(() => createProfileClient({ baseUrl: '', accountToken: async () => 'jwt' })).toThrow(/required/);
  });

  it('reports a failed request with its status', async () => {
    const { fetcher } = recordingFetch(() => json({ error: 'temporarily_unavailable' }, 503));
    const client = createProfileClient({ baseUrl: 'https://service.example', accountToken: async () => 'jwt', fetch: fetcher });

    const failure = await client.readPublicProfile('kp_alphaalphaalpha').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileRequestError);
    expect((failure as ProfileRequestError).status).toBe(503);
  });
});
