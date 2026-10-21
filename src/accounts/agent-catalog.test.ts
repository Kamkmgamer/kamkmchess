import { describe, expect, it } from 'vitest';
import { NEUTRAL_AGENT_LABEL, privateAgentId, publicSafeAgentLabel, readPrivateAgentCatalog, uniqueAgentLabels } from './agent-catalog';
import type { ConnectionNamespace, ConnectionProfile, ConnectionStore } from '../providers/connections/index.js';

const GUEST: ConnectionNamespace = { kind: 'guest' };

function profile(overrides: Partial<ConnectionProfile> & { id: string }): ConnectionProfile {
  return {
    schemaVersion: 1,
    name: overrides.id,
    provider: 'custom',
    protocol: 'chat-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    catalogPagination: 'none',
    auth: { kind: 'none' },
    headers: [],
    configRevision: 'revision-1',
    ...overrides,
  };
}

interface FakeStoreOptions {
  readonly profiles: readonly ConnectionProfile[];
  readonly bound?: readonly string[];
  readonly catalogs?: Readonly<Record<string, { entries: readonly { id: string; displayName?: string; state: 'advertised' | 'stale' }[] }>>;
}

function fakeStore(options: FakeStoreOptions): ConnectionStore {
  const bound = new Set(options.bound ?? options.profiles.map(item => item.id));
  const store = {
    async listProfiles() { return options.profiles; },
    async getProfile(_namespace: ConnectionNamespace, profileId: string) {
      return options.profiles.find(item => item.id === profileId);
    },
    async resolveCredentials(_namespace: ConnectionNamespace, item: ConnectionProfile) {
      if (!bound.has(item.id)) return { status: 'missing' as const };
      return {
        status: 'bound' as const,
        credentials: {
          profileId: item.id,
          configRevision: item.configRevision,
          credentialRevision: 1,
          generationUrl: `${item.baseUrl}/chat/completions`,
        },
      };
    },
    async getCatalogSnapshot(_namespace: ConnectionNamespace, item: ConnectionProfile) {
      const catalog = options.catalogs?.[item.id];
      if (!catalog) return undefined;
      return {
        profileId: item.id,
        configRevision: item.configRevision,
        checkedAtMs: 1,
        state: 'complete' as const,
        entries: catalog.entries.map(entry => ({ ...entry, lastAdvertisedAtMs: 1 })),
      };
    },
  };
  return store as unknown as ConnectionStore;
}

describe('the private model catalog of the owner', () => {
  it('offers the models of every connection whose credential is bound', async () => {
    const entries = await readPrivateAgentCatalog({
      connectionStore: Promise.resolve(fakeStore({
        profiles: [profile({ id: 'first' }), profile({ id: 'second' })],
        bound: ['first'],
        catalogs: {
          first: { entries: [{ id: 'model-a', displayName: 'Model A', state: 'advertised' }] },
          second: { entries: [{ id: 'model-b', displayName: 'Model B', state: 'advertised' }] },
        },
      })),
      namespace: GUEST,
    });
    expect(entries.map(entry => entry.label)).toEqual(['Model A']);
    expect(entries[0]?.selection.connectionId).toBe('first');
    expect(entries[0]?.selection.modelRoutingId).toBe('model-a');
  });

  it('never offers a model the provider does not advertise any more', async () => {
    const entries = await readPrivateAgentCatalog({
      connectionStore: Promise.resolve(fakeStore({
        profiles: [profile({ id: 'first' })],
        catalogs: { first: { entries: [{ id: 'model-a', state: 'stale' }] } },
      })),
      namespace: GUEST,
    });
    expect(entries).toEqual([]);
  });

  it('keeps two private models apart when they share one display name', async () => {
    const entries = await readPrivateAgentCatalog({
      connectionStore: Promise.resolve(fakeStore({
        profiles: [profile({ id: 'first' }), profile({ id: 'second' })],
        catalogs: {
          first: { entries: [{ id: 'route-one', displayName: 'Custom model', state: 'advertised' }] },
          second: { entries: [{ id: 'route-two', displayName: 'Custom model', state: 'advertised' }] },
        },
      })),
      namespace: GUEST,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.label).toBe('Custom model');
    expect(entries[1]?.label).toBe('Custom model 2');
    // The identity of an entry is its own private id, never the public label.
    expect(entries[0]?.id).not.toBe(entries[1]?.id);
    expect(entries[0]?.id).toBe(privateAgentId(entries[0]!.selection));
    expect(entries[1]?.id).toBe(privateAgentId(entries[1]!.selection));
  });

  it('never turns a routing id into a public label', async () => {
    const entries = await readPrivateAgentCatalog({
      connectionStore: Promise.resolve(fakeStore({
        profiles: [profile({ id: 'first' })],
        catalogs: { first: { entries: [{ id: 'sk-secret-route', state: 'advertised' }] } },
      })),
      namespace: GUEST,
    });
    expect(entries[0]?.label).toBe(NEUTRAL_AGENT_LABEL);
    expect(entries[0]?.label).not.toContain('sk-secret');
    expect(entries[0]?.selection.modelRoutingId).toBe('sk-secret-route');
  });

  it('gives the same entry the same private identity after a reload', async () => {
    const store = fakeStore({
      profiles: [profile({ id: 'first' })],
      catalogs: { first: { entries: [{ id: 'model-a', displayName: 'Model A', state: 'advertised' }] } },
    });
    const first = await readPrivateAgentCatalog({ connectionStore: Promise.resolve(store), namespace: GUEST });
    const second = await readPrivateAgentCatalog({ connectionStore: Promise.resolve(store), namespace: GUEST });
    expect(first[0]?.id).toBe(second[0]?.id);
  });
});

describe('the labels of the private catalog', () => {
  it('keeps a label inside the shape a shared model label may have', () => {
    expect(publicSafeAgentLabel('GPT-4o mini')).toBe('GPT-4o mini');
    expect(publicSafeAgentLabel('sk-secret/route')).toBe('sk-secret route');
    expect(publicSafeAgentLabel('---')).toBe('');
    expect(publicSafeAgentLabel('a'.repeat(80))).toHaveLength(64);
  });

  it('numbers the labels that would collide', () => {
    expect(uniqueAgentLabels(['A', 'A', 'A'])).toEqual(['A', 'A 2', 'A 3']);
    expect(uniqueAgentLabels(['', ''])).toEqual([NEUTRAL_AGENT_LABEL, `${NEUTRAL_AGENT_LABEL} 2`]);
  });
});
