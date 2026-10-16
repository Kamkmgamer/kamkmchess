import { describe, expect, it } from 'vitest';
import {
  createConnectionProfile,
  prepareGenerationRequest,
  reviseConnectionProfile,
} from '../../../src/providers/connections';
import { bindTestCredentials } from '../../support/connections';

describe('prepared provider requests', () => {
  it('CON-01/03 prepares Anthropic Messages headers without putting credentials in its URL', async () => {
    const profile = await createConnectionProfile({
      id: 'anthropic',
      name: 'Anthropic',
      provider: 'anthropic',
    });
    const credentials = await bindTestCredentials(profile, { apiKey: 'synthetic-api-key-canary' });
    const prepared = prepareGenerationRequest(profile, credentials, '{"model":"fixture"}');

    expect(prepared.url).toBe('https://api.anthropic.com/v1/messages');
    expect(prepared.init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      body: '{"model":"fixture"}',
    });
    expect(prepared.init.headers).toEqual({
      accept: 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': 'synthetic-api-key-canary',
    });
    expect(prepared.url).not.toContain('synthetic-api-key-canary');
  });

  it('CON-01 prepares explicit protocol alternatives and configured custom secret headers', async () => {
    const openai = await createConnectionProfile({
      id: 'openai-chat',
      name: 'OpenAI Chat',
      provider: 'openai',
      protocol: 'chat-completions',
    });
    const router = await createConnectionProfile({
      id: 'router-responses',
      name: 'OpenRouter Responses',
      provider: 'openrouter',
      protocol: 'responses',
    });
    const custom = await createConnectionProfile({
      id: 'custom-messages',
      name: 'Custom Messages',
      provider: 'custom',
      protocol: 'messages',
      baseUrl: 'https://gateway.example.test/account/v2',
      auth: { kind: 'api-key-header', headerName: 'x-project-key' },
      headers: [
        { name: 'x-region', source: 'literal', value: 'test-region' },
        { name: 'x-tenant-secret', source: 'credential' },
      ],
    });

    expect(prepareGenerationRequest(openai, await bindTestCredentials(openai, { apiKey: 'openai-canary' }), '{}').url)
      .toBe('https://api.openai.com/v1/chat/completions');
    expect(prepareGenerationRequest(router, await bindTestCredentials(router, { apiKey: 'router-canary' }), '{}').url)
      .toBe('https://openrouter.ai/api/v1/responses');

    const request = prepareGenerationRequest(custom, await bindTestCredentials(custom, {
      apiKey: 'project-key-canary',
      headers: { 'x-tenant-secret': 'tenant-secret-canary' },
    }), '{}');
    expect(request.url).toBe('https://gateway.example.test/account/v2/messages');
    expect(request.init.headers).toMatchObject({
      'x-project-key': 'project-key-canary',
      'x-region': 'test-region',
      'x-tenant-secret': 'tenant-secret-canary',
    });
    expect(request.url).not.toContain('canary');
  });

  it('CON-03 rejects a bound credential when the profile destination changes', async () => {
    const profile = await createConnectionProfile({ id: 'proxy', name: 'Proxy', provider: 'openai' });
    const previousBinding = await bindTestCredentials(profile, { apiKey: 'do-not-forward-canary' });
    const changed = await reviseConnectionProfile(profile, { baseUrl: 'https://another.example.test/v1' });

    expect(() => prepareGenerationRequest(changed, previousBinding, '{}')).toThrowError(
      expect.objectContaining({ code: 'credential-destination-mismatch' }),
    );
  });

  it('CON-03 supports an explicit no-auth route without cookies or hidden credentials', async () => {
    const profile = await createConnectionProfile({
      id: 'local',
      name: 'Local endpoint',
      provider: 'custom',
      protocol: 'chat-completions',
      baseUrl: 'http://127.0.0.1:4321/prefix/v1',
      auth: { kind: 'none' },
    });
    const request = prepareGenerationRequest(profile, await bindTestCredentials(profile, {}), '{}');

    expect(request.url).toBe('http://127.0.0.1:4321/prefix/v1/chat/completions');
    expect(request.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(request.init.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' });
  });
});
