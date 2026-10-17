import { describe, expect, it } from 'vitest';
import { bindCredentialValues, captureCredentialBindingGeneration, createCredentialBindingOwner } from './credential-binding';
import { getConnectionEndpoints } from './profile';
import { prepareGenerationRequest } from './requests';
import type { ConnectionProfile, ConnectionProvider, ConnectionProtocol } from './types';

function setup(provider: ConnectionProvider, protocol: ConnectionProtocol) {
  const profile: ConnectionProfile = {
    schemaVersion: 1,
    id: `${provider}-${protocol}`,
    name: 'Test connection',
    provider,
    protocol,
    baseUrl: provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1',
    catalogPagination: 'none',
    auth: { kind: 'none' },
    headers: [],
    configRevision: 'revision-1',
  };
  const owner = createCredentialBindingOwner();
  const credentials = bindCredentialValues({
    profileId: profile.id,
    configRevision: profile.configRevision,
    credentialRevision: 0,
    ...getConnectionEndpoints(profile),
  }, {}, captureCredentialBindingGeneration(owner, 'guest', profile.id));
  return { profile, credentials };
}

function expectUnsupported(profile: ConnectionProfile, credentials: ReturnType<typeof setup>['credentials'], body: string) {
  expect(() => prepareGenerationRequest(profile, credentials, body)).toThrowError(
    expect.objectContaining({ code: 'unsupported-cache-option' }),
  );
}

describe('prepareGenerationRequest cache wire controls', () => {
  it('rejects opaque Blob JSON bodies at the JSON text boundary', () => {
    const { profile, credentials } = setup('openai', 'chat-completions');
    expect(() => prepareGenerationRequest(profile, credentials, new Blob(['{"session_id":"s"}']) as unknown as string))
      .toThrowError(expect.objectContaining({ code: 'invalid-request-body' }));
  });

  it('does not treat historical nested metadata as a route control', () => {
    const { profile, credentials } = setup('openai', 'chat-completions');
    expect(() => prepareGenerationRequest(profile, credentials, JSON.stringify({
      messages: [{ role: 'user', content: JSON.stringify({ metadata: { session_id: 'old' } }) }],
    }))).not.toThrow();
    expect(() => prepareGenerationRequest(profile, credentials, JSON.stringify({
      messages: [{ role: 'user', content: 'old text', metadata: { cache_control: { type: 'ephemeral' } } }],
    }))).not.toThrow();
  });

  it('rejects a Router session control on an OpenAI route only at the top level', () => {
    const { profile, credentials } = setup('openai', 'chat-completions');
    expectUnsupported(profile, credentials, JSON.stringify({ session_id: 's' }));
  });

  it('counts Anthropic cache control only on text content blocks', () => {
    const { profile, credentials } = setup('openai', 'chat-completions');
    expectUnsupported(profile, credentials, JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'retained', cache_control: { type: 'ephemeral' } }] }],
    }));
  });

  it('rejects Anthropic system text cache controls on other routes', () => {
    const { profile, credentials } = setup('openai', 'chat-completions');
    expectUnsupported(profile, credentials, JSON.stringify({
      system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
    }));
  });

  it('rejects malformed cache controls on Anthropic text blocks', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'retained', cache_control: 'ephemeral' }] }],
    });
    const openAi = setup('openai', 'chat-completions');
    expectUnsupported(openAi.profile, openAi.credentials, body);

    const anthropic = setup('anthropic', 'messages');
    expectUnsupported(anthropic.profile, anthropic.credentials, body);
  });

  it('ignores disabled or incomplete Anthropic config when the wire body has no cache control', () => {
    const { profile, credentials } = setup('openai', 'chat-completions');
    const body = JSON.stringify({ messages: [] });
    expect(() => prepareGenerationRequest(profile, credentials, body, { model: 'x', maxOutputTokens: 1, cache: { anthropicEphemeral: false } })).not.toThrow();
    expect(() => prepareGenerationRequest(profile, credentials, body, { model: 'x', maxOutputTokens: 1, cache: { anthropicCacheMinimumTokens: 1024 } })).not.toThrow();
  });

  it('rejects malformed JSON and non-object JSON bodies before sending', () => {
    const { profile, credentials } = setup('openai', 'chat-completions');
    expect(() => prepareGenerationRequest(profile, credentials, '{"messages":')).toThrowError(
      expect.objectContaining({ code: 'invalid-request-body' }),
    );
    expect(() => prepareGenerationRequest(profile, credentials, '[]')).toThrowError(
      expect.objectContaining({ code: 'invalid-request-body' }),
    );
    expect(() => prepareGenerationRequest(profile, credentials, JSON.stringify({ messages: '{ malformed content' }))).not.toThrow();
  });
});
