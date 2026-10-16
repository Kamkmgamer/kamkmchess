import { describe, expect, it } from 'vitest';
import {
  checkConnection,
  createConnectionProfile,
} from '../../../src/providers/connections';
import { bindTestCredentials } from '../../support/connections';

describe('explicit connection checks', () => {
  it('CON-02/03 sends only a catalog GET with omitted cookies and redirect rejection', async () => {
    const profile = await createConnectionProfile({
      id: 'router',
      name: 'OpenRouter',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.example.test/prefix/api/v1',
    });
    const credentials = await bindTestCredentials(profile, { apiKey: 'catalog-secret-canary' });
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    const result = await checkConnection(profile, credentials, {
      fetch: async (input, init) => {
        requests.push({ input, ...(init === undefined ? {} : { init }) });
        return new Response(JSON.stringify({
          data: [{ id: 'vendor/model:Exact', name: 'Fixture model', owned_by: 'vendor' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      now: () => 1_800_000_000_000,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe('https://openrouter.example.test/prefix/api/v1/models');
    expect(requests[0]?.init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe('Bearer catalog-secret-canary');
    expect(result).toEqual({
      status: 'success',
      requestedUrl: 'https://openrouter.example.test/prefix/api/v1/models',
      checkedAtMs: 1_800_000_000_000,
      models: [{ id: 'vendor/model:Exact', displayName: 'Fixture model', ownedBy: 'vendor' }],
    });
  });

  it('CON-02 follows Anthropic catalog pages only during the explicit check', async () => {
    const profile = await createConnectionProfile({ id: 'anthropic', name: 'Anthropic', provider: 'anthropic' });
    const credentials = await bindTestCredentials(profile, { apiKey: 'anthropic-canary' });
    const requested: string[] = [];

    const result = await checkConnection(profile, credentials, {
      fetch: async (input) => {
        requested.push(String(input));
        const page = requested.length === 1
          ? { data: [{ id: 'claude-fixture-one', display_name: 'Claude fixture one' }], has_more: true, last_id: 'claude-fixture-one' }
          : { data: [{ id: 'claude-fixture-two', display_name: 'Claude fixture two' }], has_more: false };
        return new Response(JSON.stringify(page), { status: 200 });
      },
      now: () => 10,
    });

    expect(requested).toEqual([
      'https://api.anthropic.com/v1/models',
      'https://api.anthropic.com/v1/models?after_id=claude-fixture-one',
    ]);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.models.map((model) => model.id)).toEqual(['claude-fixture-one', 'claude-fixture-two']);
    }
  });

  it('CON-05 returns a scoped rate-limit error with a retry hint and redacts the key', async () => {
    const profile = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    const credentials = await bindTestCredentials(profile, { apiKey: 'synthetic-error-key' });
    let calls = 0;

    const result = await checkConnection(profile, credentials, {
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          error: {
            code: 'rate_limit_exceeded',
            message: 'Key synthetic-error-key was denied at https://private.example.test/api',
          },
        }), { status: 429, headers: { 'retry-after': '3' } });
      },
      now: () => 1000,
    });

    expect(calls).toBe(1);
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.error).toMatchObject({ code: 'http-rate-limited', status: 429, retryAfterMs: 3000 });
      expect(result.error.message).not.toContain('synthetic-error-key');
      expect(result.error.message).not.toContain('private.example.test');
      expect(result.error.message).not.toContain('CORS');
    }
  });

  it('CON-05 treats a redirect-blocked fetch failure as unknown and makes no retry', async () => {
    const profile = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    const credentials = await bindTestCredentials(profile, { apiKey: 'redirect-key-canary' });
    let calls = 0;

    const result = await checkConnection(profile, credentials, {
      fetch: async (_input, init) => {
        calls += 1;
        expect(init?.redirect).toBe('error');
        throw new TypeError('Failed to fetch');
      },
    });

    expect(calls).toBe(1);
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.error.code).toBe('request-failed');
      expect(result.error.message).toContain('cause is unknown');
      expect(result.error.message).not.toContain('CORS');
    }
  });

  it('CON-05 keeps authentication, permission, endpoint and capacity statuses distinct', async () => {
    const profile = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    const credentials = await bindTestCredentials(profile, { apiKey: 'status-key-canary' });
    const expected = new Map([
      [401, 'http-authentication'],
      [402, 'http-quota'],
      [403, 'http-permission'],
      [404, 'http-endpoint'],
      [413, 'http-capacity'],
      [529, 'http-capacity'],
    ]);

    for (const [status, code] of expected) {
      const result = await checkConnection(profile, credentials, {
        fetch: async () => new Response('{"error":{"message":"fixture status"}}', { status }),
      });
      expect(result.status).toBe('failure');
      if (result.status === 'failure') expect(result.error.code).toBe(code);
    }
  });

  it('CON-02 returns manual-entry guidance without making a request when a custom catalog is absent', async () => {
    const profile = await createConnectionProfile({
      id: 'manual-only',
      name: 'Manual endpoint',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'https://models.example.test/team/v1',
      auth: { kind: 'none' },
    });
    const credentials = await bindTestCredentials(profile, {});
    let calls = 0;

    const result = await checkConnection(profile, credentials, {
      fetch: async () => {
        calls += 1;
        return new Response('{}');
      },
      now: () => 500,
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      status: 'unavailable',
      checkedAtMs: 500,
      error: { code: 'catalog-unavailable' },
    });
  });
});
