import { describe, expect, it } from 'vitest';
import { classifyConnectionRoute, createConnectionProfile } from '../../../src/providers/connections';

describe('connection route evidence scope', () => {
  it('CON-06 labels only the sampled loopback browser route as conditional', async () => {
    const loopback = await createConnectionProfile({
      id: 'local',
      name: 'Local proxy',
      provider: 'custom',
      protocol: 'chat-completions',
      baseUrl: 'http://127.0.0.1:8317/prefix/v1',
      auth: { kind: 'none' },
    });
    const route = classifyConnectionRoute(loopback);

    expect(route).toMatchObject({ kind: 'loopback-http', evidence: 'conditional-research-only' });
    expect(route.statement).toContain('Windows Chrome and Edge');
    expect(route.statement).toContain('remain unverified');
  });

  it('CON-06 applies the same conditional route scope to the CLIProxyAPI loopback preset', async () => {
    const profile = await createConnectionProfile({ id: 'cliproxy', name: 'CLIProxyAPI', provider: 'cliproxy' });
    expect(classifyConnectionRoute(profile)).toMatchObject({ kind: 'loopback-http', evidence: 'conditional-research-only' });
  });

  it('CON-06 labels LAN and public HTTP destinations unverified', async () => {
    const lan = await createConnectionProfile({
      id: 'lan',
      name: 'LAN',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'http://192.168.1.22:9000/v1',
      auth: { kind: 'none' },
    });
    const publicHttp = await createConnectionProfile({
      id: 'http',
      name: 'HTTP',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'http://models.example.test/v1',
      auth: { kind: 'none' },
    });

    expect(classifyConnectionRoute(lan)).toMatchObject({ kind: 'private-network', evidence: 'unverified' });
    expect(classifyConnectionRoute(publicHttp)).toMatchObject({ kind: 'unverified-http', evidence: 'unverified' });
  });

  it('CON-06 labels public HTTPS normal without asserting CORS or provider access', async () => {
    const profile = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    const route = classifyConnectionRoute(profile);

    expect(route).toMatchObject({ kind: 'public-https', evidence: 'normal-remote-route' });
    expect(route.statement).toContain('does not establish CORS');
  });
});
