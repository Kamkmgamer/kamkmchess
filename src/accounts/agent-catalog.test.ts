import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_AGENT_LABEL,
  privateAgentId,
  publicAgentLabel,
  readPrivateAgentCatalog,
  seatChoiceAvailable,
} from './agent-catalog';
import type { PrivateAgentEntry } from './agent-catalog';
import type { ModelSelection } from '../controller/index.js';
import type { ConnectionNamespace, ConnectionProfile, ConnectionStore } from '../providers/connections/index.js';

const GUEST: ConnectionNamespace = { kind: 'guest' };

/** A private selection of one connection. */
function selection(connectionId: string, modelRoutingId: string): ModelSelection {
  return {
    kind: 'model',
    providerId: 'custom',
    connectionId,
    configurationRevision: 7,
    modelRoutingId,
    protocol: 'chat-completions',
    diagnostic: 'not-run',
  };
}

/** A catalog entry of one private selection. */
function entry(connectionId: string, label: string, modelSelection: ModelSelection): PrivateAgentEntry {
  return { id: privateAgentId(modelSelection), label, displayName: label, selection: modelSelection, connectionId };
}

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
    expect(entries.map(entry => entry.displayName)).toEqual(['Model A']);
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
    // The public label is the neutral one for both, and the private identity
    // keeps them apart.
    expect(entries[0]?.label).toBe(NEUTRAL_AGENT_LABEL);
    expect(entries[1]?.label).toBe(NEUTRAL_AGENT_LABEL);
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

describe('the public label of a model', () => {
  it('publishes only a public name the service knows', () => {
    expect(publicAgentLabel('gpt-4o')).toBe('GPT-4o');
    expect(publicAgentLabel('GPT-4o')).toBe('GPT-4o');
    expect(publicAgentLabel('claude-sonnet-4')).toBe('Claude Sonnet 4');
    expect(publicAgentLabel('stockfish-19-lite')).toBe('Stockfish 19 Lite (browser)');
  });

  it('publishes an unknown name as the neutral one', () => {
    // A name that only passes a character filter is still a private alias.
    expect(publicAgentLabel('private-prod')).toBe(NEUTRAL_AGENT_LABEL);
    expect(publicAgentLabel('internal/team-model')).toBe(NEUTRAL_AGENT_LABEL);
    expect(publicAgentLabel('my-org/private-route-v2')).toBe(NEUTRAL_AGENT_LABEL);
    expect(publicAgentLabel('sk-live-abcdef0123456789')).toBe(NEUTRAL_AGENT_LABEL);
    expect(publicAgentLabel('https://api.internal.example/v1')).toBe(NEUTRAL_AGENT_LABEL);
    expect(publicAgentLabel('')).toBe(NEUTRAL_AGENT_LABEL);
  });

  it('carries no ordinal, so two private models share the neutral name', () => {
    expect(publicAgentLabel('private-a')).toBe(publicAgentLabel('private-b'));
  });
});

describe('the choice of a model for a seat', () => {
  const first = entry('first', 'Custom model', selection('first', 'model-a'));
  const second = entry('second', 'Custom model', selection('second', 'model-b'));

  it('offers every model of the owner, also the one that plays the new games', () => {
    // The seat plays the second model, so the first model stays available:
    // the model of the new games is not the model of this seat.
    expect(seatChoiceAvailable({ entry: first, bound: second })).toBe(true);
    expect(seatChoiceAvailable({ entry: second, bound: second })).toBe(false);
    expect(seatChoiceAvailable({ entry: first, bound: null })).toBe(true);
  });

  it('keeps every model available when the binding of the seat is ambiguous', () => {
    // Two private models share the neutral public label, so the binding of the
    // seat names more than one model and the owner may choose again.
    expect(seatChoiceAvailable({ entry: first, bound: null, ambiguous: true })).toBe(true);
    expect(seatChoiceAvailable({ entry: second, bound: null, ambiguous: true })).toBe(true);
  });
});
