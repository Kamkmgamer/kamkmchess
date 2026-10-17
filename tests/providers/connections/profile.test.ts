import { describe, expect, it } from 'vitest';
import {
  createConnectionProfile,
  createManualModelReference,
  getConnectionEndpoints,
  reviseConnectionProfile,
  type ConnectionProtocol,
} from '../../../src/providers/connections';

describe('connection profiles', () => {
  it('CON-01 gives each provider its approved default protocol', async () => {
    const openai = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    const openrouter = await createConnectionProfile({ id: 'router', name: 'OpenRouter', provider: 'openrouter' });
    const anthropic = await createConnectionProfile({ id: 'anthropic', name: 'Anthropic', provider: 'anthropic' });

    expect([openai.protocol, openrouter.protocol, anthropic.protocol]).toEqual([
      'responses',
      'chat-completions',
      'messages',
    ] satisfies ConnectionProtocol[]);
  });

  it('CON-01 resolves the default generation and catalog URLs for all three providers', async () => {
    const openai = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    const openrouter = await createConnectionProfile({ id: 'router', name: 'OpenRouter', provider: 'openrouter' });
    const anthropic = await createConnectionProfile({ id: 'anthropic', name: 'Anthropic', provider: 'anthropic' });

    expect(getConnectionEndpoints(openai)).toEqual({
      generationUrl: 'https://api.openai.com/v1/responses',
      catalogUrl: 'https://api.openai.com/v1/models',
    });
    expect(getConnectionEndpoints(openrouter)).toEqual({
      generationUrl: 'https://openrouter.ai/api/v1/chat/completions',
      catalogUrl: 'https://openrouter.ai/api/v1/models',
    });
    expect(getConnectionEndpoints(anthropic)).toEqual({
      generationUrl: 'https://api.anthropic.com/v1/messages',
      catalogUrl: 'https://api.anthropic.com/v1/models',
    });
  });

  it('CON-01 keeps a custom path prefix and appends each selected route once', async () => {
    const profile = await createConnectionProfile({
      id: 'custom',
      name: 'Team proxy',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'https://models.example.test/tenant/edge/v1/',
      catalogUrl: 'https://models.example.test/tenant/edge/v1/models',
      auth: { kind: 'api-key-header', headerName: 'x-team-key' },
    });

    expect(getConnectionEndpoints(profile)).toEqual({
      generationUrl: 'https://models.example.test/tenant/edge/v1/responses',
      catalogUrl: 'https://models.example.test/tenant/edge/v1/models',
    });
  });

  it('CON-01 preserves a path prefix that happens to end with another protocol route name', async () => {
    const profile = await createConnectionProfile({
      id: 'custom-prefix',
      name: 'Messages tenant API',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'https://models.example.test/tenant/messages',
      catalogUrl: 'https://models.example.test/tenant/messages/models',
      auth: { kind: 'none' },
    });

    expect(getConnectionEndpoints(profile)).toEqual({
      generationUrl: 'https://models.example.test/tenant/messages/responses',
      catalogUrl: 'https://models.example.test/tenant/messages/models',
    });
  });

  it('CON-01 shows the endpoint already containing its selected route without duplicating it', async () => {
    const profile = await createConnectionProfile({
      id: 'openai-final',
      name: 'OpenAI endpoint',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1/responses',
    });

    expect(getConnectionEndpoints(profile).generationUrl).toBe('https://api.openai.com/v1/responses');
    expect(getConnectionEndpoints(profile).catalogUrl).toBe('https://api.openai.com/v1/models');
  });

  it('CON-01 replaces an old protocol suffix when the player selects another protocol', async () => {
    const original = await createConnectionProfile({
      id: 'openai-alternative',
      name: 'OpenAI Responses',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1/responses',
    });
    const profile = await reviseConnectionProfile(original, { protocol: 'chat-completions' });

    expect(getConnectionEndpoints(profile)).toEqual({
      generationUrl: 'https://api.openai.com/v1/chat/completions',
      catalogUrl: 'https://api.openai.com/v1/models',
    });
  });

  it('CON-03 refuses URL userinfo and credential-like query parameters', async () => {
    await expect(createConnectionProfile({
      id: 'userinfo',
      name: 'Unsafe URL',
      provider: 'custom',
      protocol: 'chat-completions',
      baseUrl: 'https://synthetic-key@models.example.test/v1',
      auth: { kind: 'none' },
    })).rejects.toMatchObject({ code: 'unsafe-endpoint-url' });

    await expect(createConnectionProfile({
      id: 'empty-userinfo',
      name: 'Empty userinfo',
      provider: 'custom',
      protocol: 'chat-completions',
      baseUrl: 'https://@models.example.test/v1',
      auth: { kind: 'none' },
    })).rejects.toMatchObject({ code: 'unsafe-endpoint-url' });

    await expect(createConnectionProfile({
      id: 'query-secret',
      name: 'Unsafe query',
      provider: 'custom',
      protocol: 'chat-completions',
      baseUrl: 'https://models.example.test/v1?api_key=synthetic-key',
      auth: { kind: 'none' },
    })).rejects.toMatchObject({ code: 'unsafe-endpoint-url' });
  });

  it('CON-03 rejects compact credential query names without rejecting routing controls', async () => {
    for (const name of ['auth_key', 'access_key', 'key_id']) {
      const canary = `${name}-query-canary`;
      const error = await createConnectionProfile({
        id: `query-${name}`,
        name: 'Credential query',
        provider: 'custom',
        protocol: 'responses',
        baseUrl: `https://gateway.example.test/v1?${name}=${canary}`,
        auth: { kind: 'none' },
      }).then(() => undefined, (cause: unknown) => cause);
      expect(error).toMatchObject({ code: 'unsafe-endpoint-url' });
      expect(JSON.stringify(error)).not.toContain(canary);
    }

    const routed = await createConnectionProfile({
      id: 'query-routing-controls',
      name: 'Routing controls',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'https://gateway.example.test/v1?api-version=2025-01&tenant=blue&routing=eu&author=player&monkey=fixture',
      auth: { kind: 'none' },
    });
    expect(getConnectionEndpoints(routed).generationUrl)
      .toBe('https://gateway.example.test/v1/responses?api-version=2025-01&tenant=blue&routing=eu&author=player&monkey=fixture');
  });

  it('CON-03 does not accept secret values in bearer profile objects or literal credential headers', async () => {
    const unsafeBearer = {
      kind: 'bearer',
      apiKey: 'nested-profile-canary',
    } as never;
    const profile = await createConnectionProfile({
      id: 'custom',
      name: 'Custom',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'https://custom.example.test/v1',
      auth: unsafeBearer,
    });
    expect(JSON.stringify(profile)).not.toContain('nested-profile-canary');

    await expect(createConnectionProfile({
      id: 'custom-secret-literal',
      name: 'Custom secret literal',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'https://custom.example.test/v1',
      auth: { kind: 'none' },
      headers: [{ name: 'x-auth-token', source: 'literal', value: 'literal-secret-canary' }],
    })).rejects.toMatchObject({ code: 'invalid-header' });
  });

  it('CON-03 rejects compact credential-looking names for literal headers', async () => {
    const canary = 'literal-header-secret-canary';
    const error = await createConnectionProfile({
      id: 'compact-literal-secret',
      name: 'Compact literal secret',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'https://custom.example.test/v1',
      auth: { kind: 'none' },
      headers: [{ name: 'myapikey', source: 'literal', value: canary }],
    }).then(() => undefined, (cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'invalid-header' });
    expect(JSON.stringify(error)).not.toContain(canary);

    const configuredHeader = await createConnectionProfile({
      id: 'compact-credential-header',
      name: 'Credential header',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'https://custom.example.test/v1',
      auth: { kind: 'none' },
      headers: [{ name: 'myapikey', source: 'credential' }],
    });
    expect(configuredHeader.headers).toEqual([{ name: 'myapikey', source: 'credential' }]);

    const ordinaryHeaders = await createConnectionProfile({
      id: 'ordinary-headers',
      name: 'Ordinary headers',
      provider: 'custom',
      protocol: 'responses',
      baseUrl: 'https://custom.example.test/v1',
      auth: { kind: 'none' },
      headers: [
        { name: 'author', source: 'literal', value: 'player' },
        { name: 'x-tenant-id', source: 'literal', value: 'blue' },
        { name: 'x-monkey-mode', source: 'literal', value: 'fixture' },
      ],
    });
    expect(ordinaryHeaders.headers).toHaveLength(3);
  });

  it('CON-01 requires a protocol and auth mode for custom profiles', async () => {
    await expect(createConnectionProfile({
      id: 'custom',
      name: 'Unconfigured custom endpoint',
      provider: 'custom',
      baseUrl: 'https://models.example.test/v1',
    } as never)).rejects.toMatchObject({ code: 'invalid-profile' });
  });

  it('CON-02 accepts an exact manual model ID without catalog data and scopes it to its connection', async () => {
    const openai = await createConnectionProfile({ id: 'openai', name: 'OpenAI', provider: 'openai' });
    const proxy = await createConnectionProfile({
      id: 'proxy',
      name: 'Proxy',
      provider: 'custom',
      protocol: 'chat-completions',
      baseUrl: 'https://proxy.example.test/v1',
      auth: { kind: 'none' },
    });
    const modelId = 'Vendor/Model:stable-alias_v2';

    expect(createManualModelReference(openai, modelId)).toEqual({ connectionId: 'openai', requestedModelId: modelId, source: 'manual' });
    expect(createManualModelReference(proxy, modelId)).toEqual({ connectionId: 'proxy', requestedModelId: modelId, source: 'manual' });
    expect(() => createManualModelReference(openai, ' model-id')).toThrowError(
      expect.objectContaining({ code: 'invalid-model-id' }),
    );
    expect(() => createManualModelReference(openai, '')).toThrowError(
      expect.objectContaining({ code: 'invalid-model-id' }),
    );
  });
});
