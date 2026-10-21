import { describe, expect, it } from 'vitest';
import { bindCredentialValues, captureCredentialBindingGeneration, createCredentialBindingOwner } from '../providers/connections/credential-binding.js';
import { recordDisclosureChoice } from '../providers/connections/disclosure.js';
import { createConnectionProfile, getConnectionEndpoints } from '../providers/connections/profile.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';
import { OpponentService } from '../opponents/index.js';
import { agentServiceForNamespace } from './agent-services';

const ACCOUNT: ConnectionNamespace = { kind: 'account', accountId: 'user_1' };
const GUEST: ConnectionNamespace = { kind: 'guest' };

/**
 * A store that holds the same profile id in both namespaces, with a
 * different credential in each of them.
 */
async function twoNamespaces(): Promise<{ store: ConnectionStore; profileId: string }> {
  const profile = await createConnectionProfile({
    id: 'route-a', name: 'Shared route', provider: 'openrouter', baseUrl: 'https://proxy.example/v1',
    protocol: 'chat-completions', auth: { kind: 'bearer' }, catalogPagination: 'none',
  });
  const owner = createCredentialBindingOwner();
  const credentialFor = (namespace: ConnectionNamespace) => bindCredentialValues({
    profileId: profile.id, configRevision: profile.configRevision, credentialRevision: 7,
    ...getConnectionEndpoints(profile),
  }, { apiKey: namespace.kind === 'account' ? 'account-key' : 'guest-key' },
  captureCredentialBindingGeneration(owner, namespace.kind, profile.id));
  const disclosure = recordDisclosureChoice(profile, { decision: 'accepted', recordedAtMs: 1 });
  const store = {
    async getProfile() { return profile; },
    async resolveCredentials(namespace: ConnectionNamespace) {
      return { status: 'bound' as const, credentials: credentialFor(namespace) };
    },
    async getDisclosureChoice() { return disclosure; },
    async getCatalogSnapshot() { return undefined; },
    async recordCatalogCheck() { throw new Error('the catalog is not written in this case'); },
  } as unknown as ConnectionStore;
  return { store, profileId: profile.id };
}

function streamResponse(answer: string) {
  const frames = [
    `data: ${JSON.stringify({ model: 'router/model-alias', choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ model: 'router/model-alias', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frames)); controller.close(); },
  }), { status: 200 });
}

describe('the provider service of the active identity', () => {
  it('never reads the credentials of another identity', async () => {
    const { store } = await twoNamespaces();
    const seen: (string | null)[] = [];
    const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
      const headers = new Headers(init.headers as HeadersInit);
      seen.push(headers.get('authorization'));
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const plan = /Unique plan marker: ([^\s.]+)/.exec(body.messages[1]!.content)![1]!;
      const marker = /set marker to "(KAMKM-COMPAT-[^"]+)"/.exec(body.messages[2]!.content)![1]!;
      return streamResponse(JSON.stringify({ move: 'e2e4', plan, marker }));
    };
    let index = 0;
    const ids = (): string => `id-${index++}`;
    const guest = new OpponentService({ connections: store, namespace: GUEST, fetch, idFactory: ids });
    const account = new OpponentService({ connections: store, namespace: ACCOUNT, fetch, idFactory: ids });

    // The account namespace resolves the service of the account.
    const chosen = agentServiceForNamespace({ guest, account }, ACCOUNT);
    expect(chosen).toBe(account);
    await (chosen as OpponentService).runCompatibilityDiagnostic({ profileId: 'route-a', modelId: 'model-a' });
    expect(seen.at(-1)).toContain('account-key');

    // The guest namespace resolves the service of the guest.
    const guestChosen = agentServiceForNamespace({ guest, account }, GUEST);
    expect(guestChosen).toBe(guest);
    await (guestChosen as OpponentService).runCompatibilityDiagnostic({ profileId: 'route-a', modelId: 'model-a' });
    expect(seen.at(-1)).toContain('guest-key');
  });

  it('fails closed when the account has no service', () => {
    expect(agentServiceForNamespace({ guest: null as never }, ACCOUNT)).toBeNull();
  });
});
