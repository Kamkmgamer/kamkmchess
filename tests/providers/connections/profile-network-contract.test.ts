import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  checkConnection,
  createConnectionProfile,
  getConnectionEndpoints,
  openConnectionStore,
  prepareCatalogRequest,
  prepareGenerationRequest,
} from '../../../src/providers/connections';

describe('saved profile network contract', () => {
  it('keeps each provider, explicit alternative and custom route locally bound and request-scoped', async () => {
    const profiles = await Promise.all([
      createConnectionProfile({ id: 'openai-responses', name: 'OpenAI Responses', provider: 'openai' }),
      createConnectionProfile({ id: 'openai-chat', name: 'OpenAI Chat', provider: 'openai', protocol: 'chat-completions' }),
      createConnectionProfile({ id: 'openrouter-chat', name: 'OpenRouter Chat', provider: 'openrouter' }),
      createConnectionProfile({ id: 'openrouter-responses', name: 'OpenRouter Responses', provider: 'openrouter', protocol: 'responses' }),
      createConnectionProfile({ id: 'anthropic-messages', name: 'Anthropic Messages', provider: 'anthropic' }),
      createConnectionProfile({ id: 'anthropic-chat', name: 'Anthropic Chat', provider: 'anthropic', protocol: 'chat-completions' }),
      createConnectionProfile({
        id: 'custom-responses',
        name: 'Custom Responses',
        provider: 'custom',
        protocol: 'responses',
        baseUrl: 'https://custom.example.test/tenant/v1',
        catalogUrl: 'https://custom.example.test/tenant/v1/models',
        auth: { kind: 'api-key-header', headerName: 'x-tenant-key' },
        headers: [{ name: 'x-project-token', source: 'credential' }],
      }),
    ]);

    for (const profile of profiles) {
      const suffix = profile.id;
      const apiKey = `${suffix}-api-key-canary`;
      const projectToken = `${suffix}-project-token-canary`;
      const factory = new IDBFactory();
      const store = await openConnectionStore({ factory, databaseName: `profile-contract-${suffix}` });
      const namespace = { kind: 'guest' } as const;
      await store.saveProfile(namespace, profile);
      await store.assignCredential(namespace, profile.id, {
        apiKey,
        ...(profile.provider === 'custom' ? { headers: { 'x-project-token': projectToken } } : {}),
      });

      const localBinding = await store.resolveCredentials(namespace, profile);
      expect(localBinding.status).toBe('bound');
      if (localBinding.status !== 'bound') throw new Error(`Expected local binding for ${profile.id}.`);
      expect(JSON.stringify(localBinding.credentials)).not.toContain(apiKey);
      expect(await store.snapshotKnownCredentials(namespace)).toEqual(
        profile.provider === 'custom' ? [apiKey, projectToken] : [apiKey],
      );

      const endpoints = getConnectionEndpoints(profile);
      const generation = prepareGenerationRequest(profile, localBinding.credentials, '{}');
      const catalog = prepareCatalogRequest(profile, localBinding.credentials);
      expect(generation.url).toBe(endpoints.generationUrl);
      expect(catalog.url).toBe(endpoints.catalogUrl);
      for (const request of [generation, catalog]) {
        expect(request.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
      }
      const generationHeaders = new Headers(generation.init.headers);
      if (profile.auth.kind === 'bearer') expect(generationHeaders.get('authorization')).toBe(`Bearer ${apiKey}`);
      if (profile.auth.kind === 'api-key-header') expect(generationHeaders.get(profile.auth.headerName)).toBe(apiKey);
      if (profile.provider === 'custom') expect(generationHeaders.get('x-project-token')).toBe(projectToken);

      let calls = 0;
      const result = await checkConnection(profile, localBinding.credentials, {
        fetch: async (input, init) => {
          calls += 1;
          expect(String(input)).toBe(endpoints.catalogUrl);
          expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
          throw new TypeError(`redirect blocked for ${apiKey} ${projectToken}`);
        },
      });
      expect(calls).toBe(1);
      expect(result.status).toBe('failure');
      expect(JSON.stringify(result)).not.toContain(apiKey);
      expect(JSON.stringify(result)).not.toContain(projectToken);
      expect(JSON.stringify(result)).not.toContain('CORS');

      const otherDevice = await openConnectionStore({
        factory: new IDBFactory(),
        databaseName: `profile-contract-${suffix}`,
      });
      await otherDevice.saveProfile(namespace, profile);
      const unbound = await otherDevice.resolveCredentials(namespace, profile);
      expect(unbound.status).toBe(profile.auth.kind === 'none' ? 'bound' : 'missing');
    }
  });
});
