/**
 * The guest entry of the online screen (KHA-75).
 *
 * The fixture drives the browser modules with a local service double and a
 * synthetic provider. It sends no provider request to a real service and it
 * spends nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGuestOnlineComposition, publishGuestAgentCatalog } from './online-guest-entry';
import { createOnlineComposition } from '../online/composition';
import { createGuestCredential } from '../online/auth';
import { ONLINE_CONTRACTS_SCHEMA_VERSION } from '../online/contracts';
import type { ModelSelection } from '../controller/index.js';
import type { OnlineMatchView } from '../online/updates';
import type { ConnectionNamespace, ConnectionProfile, ConnectionStore } from '../providers/connections/index.js';
import { namespaceKey } from '../providers/connections/index.js';
import {
  bindCredentialValues,
  captureCredentialBindingGeneration,
  createCredentialBindingOwner,
} from '../providers/connections/credential-binding.js';

const GUEST: ConnectionNamespace = { kind: 'guest' };

/** The private selection of the own model of the guest. */
function selectionOf(connectionId: string, modelRoutingId: string): ModelSelection {
  return {
    kind: 'model',
    providerId: 'custom',
    connectionId,
    configurationRevision: 1,
    modelRoutingId,
    protocol: 'chat-completions',
    diagnostic: 'passed-current-session',
  } as unknown as ModelSelection;
}

/** The canonical view of the match of the guest. */
function agentView(): OnlineMatchView {
  return {
    schemaVersion: 2,
    matchId: 'match-00000001',
    variant: 'orthodox',
    startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    positionFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
    version: 1,
    controlEpoch: 1,
    rulesPolicyVersion: 'online-rules/1',
    status: 'active',
    result: null,
    seats: [
      { seat: 'white', publicLabel: 'Owner', control: { kind: 'agent', modelLabel: 'Custom model' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      { seat: 'black', publicLabel: 'Guest', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ],
    clock: {
      whiteMs: 300_000,
      blackMs: 300_000,
      activeSeat: 'white',
      activeSince: '2026-10-21T10:00:00.000Z',
      deadlineAt: null,
      whiteMoved: false,
      blackMoved: false,
      turnNumber: 1,
      replySeat: null,
      replyDeadlineAt: null,
    },
    moves: [],
    pendingOffers: [],
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    completedAt: null,
    yourSeat: 'white',
  };
}

/**
 * The connection store of the fixture.
 *
 * Every profile carries its own credential, so the test sees which private
 * selection asked the provider and with which credential. The store also
 * advertises one model per profile, so the private catalog of the owner can
 * be read from it.
 */
function connectionStoreOf(profiles: readonly { id: string }[]): {
  readonly store: Promise<ConnectionStore>;
  readonly asked: string[];
} {
  const asked: string[] = [];
  const owner = createCredentialBindingOwner();
  const store = {
    async listProfiles() {
      return profiles.map(profile => ({
        schemaVersion: 1 as const,
        id: profile.id,
        name: profile.id,
        provider: 'custom',
        protocol: 'chat-completions' as const,
        baseUrl: 'https://127.0.0.1:1',
        catalogPagination: 'none' as const,
        auth: { kind: 'bearer' as const },
        headers: [],
        configRevision: 'r1',
      }));
    },
    async getCatalogSnapshot(_namespace: ConnectionNamespace, profile: ConnectionProfile) {
      return {
        profileId: profile.id,
        configRevision: profile.configRevision,
        checkedAtMs: 1,
        state: 'complete' as const,
        entries: [{ id: 'model-a', displayName: 'Model A', state: 'advertised' as const, lastAdvertisedAtMs: 1 }],
      };
    },
    async getProfile(_namespace: ConnectionNamespace, profileId: string) {
      asked.push(profileId);
      return profiles.some(profile => profile.id === profileId)
        ? {
          schemaVersion: 1,
          id: profileId,
          name: profileId,
          provider: 'custom',
          protocol: 'chat-completions',
          baseUrl: 'https://127.0.0.1:1',
          catalogPagination: 'none',
          auth: { kind: 'bearer' },
          headers: [],
          configRevision: 'r1',
        }
        : undefined;
    },
    async resolveCredentials(namespace: ConnectionNamespace, profile: ConnectionProfile) {
      const generation = captureCredentialBindingGeneration(owner, namespaceKey(namespace), profile.id);
      const credentials = bindCredentialValues({
        profileId: profile.id,
        configRevision: profile.configRevision,
        credentialRevision: 1,
        generationUrl: 'https://127.0.0.1:1/v1/chat/completions',
      }, { apiKey: `key-${profile.id}` }, generation);
      return { status: 'bound', credentials };
    },
  } as unknown as ConnectionStore;
  return { store: Promise.resolve(store), asked };
}

/**
 * The service of the fixture.
 *
 * The double answers the routes the browser runner needs: the snapshot of the
 * match, the lease of the seat, the uncertain request and the command of the
 * seat.
 */
function serviceDouble(state: { commands: number }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown>;
    const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    if (path.endsWith('/runner/lease') || path.endsWith('/runner/request')) {
      const action = String(body?.action ?? '');
      return json({
        schemaVersion: 2,
        leaseId: 'lease-00000001',
        matchId: 'match-00000001',
        seat: 'white',
        controlEpoch: 1,
        generation: 1,
        runnerId: String(body?.runnerId ?? 'runner-1'),
        status: 'active',
        acquiredAt: '2026-10-21T10:00:00.000Z',
        expiresAt: '2035-01-01T00:00:00.000Z',
        revokedAt: null,
        turnVersion: 1,
        runnerEpoch: 1,
        // The service publishes the request that may still be running.
        pendingRequestId: action === 'begin' ? String(body?.requestId ?? '') : null,
        pendingRequestStartedAt: null,
        revokedReason: null,
        lastRenewedAt: '2026-10-21T10:00:00.000Z',
      });
    }
    if (path.endsWith('/commands')) {
      state.commands += 1;
      return json({
        schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
        matchId: 'match-00000001',
        operationId: String(body?.operationId ?? 'operation-00000001'),
        outcome: 'accepted',
        version: 2,
        controlEpoch: 1,
        decidedAt: '2026-10-21T10:00:00.000Z',
      });
    }
    if (path.endsWith('/seat-credential')) {
      // The inviter claims the seat credential of the created match.
      return json({
        schemaVersion: 2,
        matchId: 'match-00000001',
        seat: 'white',
        guestCredential: {
          guestId: 'guest-00000001',
          matchId: 'match-00000001',
          seat: 'white',
          token: 'seat-token',
          expiresAt: '2035-01-01T00:00:00.000Z',
        },
      });
    }
    if (path.includes('/v1/online/invitations/')) {
      // The invitation was consumed, so the inviter may claim its seat.
      return json({
        schemaVersion: 2,
        invitationId: 'invitation-00000001',
        kind: 'link',
        status: 'consumed',
        inviterLabel: 'Guest',
        inviterSeat: 'white',
        inviterControl: { kind: 'agent', modelLabel: 'Custom model' },
        timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
        startingFen: null,
        expiresAt: '2035-01-01T00:00:00.000Z',
        createdAt: '2026-10-21T10:00:00.000Z',
        consumedAt: '2026-10-21T10:00:05.000Z',
        cancelledAt: null,
        matchId: 'match-00000001',
      });
    }
    if (path.includes('/updates')) return json({ schemaVersion: 1, cursor: 1, snapshot: agentView() });
    if (path.includes('/v1/online/matches/')) return json(agentView());
    return json({ error: 'not_found' }, 404);
  }) as unknown as typeof fetch;
}

/**
 * The provider of the fixture.
 *
 * The provider transport is the global transport of the browser, so the
 * fixture answers it directly. The answer records the credential of the
 * request, so the test sees which private model asked the provider.
 */
function providerFixture(): { readonly requests: Array<{ readonly authorization: string | null }>; restore(): void } {
  const requests: Array<{ readonly authorization: string | null }> = [];
  vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    requests.push({ authorization: headers.get('authorization') });
    const chunk = { choices: [{ index: 0, delta: { content: '{"move":"e2e4"}' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch);
  return { requests, restore: () => vi.unstubAllGlobals() };
}

/** Waits for a condition of the test. */
async function until(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`The condition (${label}) was not reached.`);
    await new Promise<void>(resolve => { setTimeout(resolve, 5); });
  }
}

describe('the guest entry of the online screen', () => {
  it('publishes the private catalog of the browser so the guest may play its own agent', async () => {
    const connections = connectionStoreOf([{ id: 'c1' }]);
    const online = createGuestOnlineComposition({
      baseUrl: 'https://api.example.test',
      connectionStore: connections.store,
      namespace: GUEST,
    });
    await publishGuestAgentCatalog(online, { connectionStore: connections.store, namespace: GUEST });
    // The own agent of the guest is published with its public label, and the
    // private selection stays in the browser.
    expect(online.agent?.label).toBe('Custom model');
    expect(online.agent?.selection.connectionId).toBe('c1');
    expect(online.agent?.selection.modelRoutingId).toBe('model-a');
    expect(online.agentCatalog.map(entry => entry.id)).toHaveLength(1);
    online.dispose();
  });

  it('plays the accepted seat of the guest with the model of its own browser', async () => {
    const provider = providerFixture();
    const state = { commands: 0 };
    const connections = connectionStoreOf([{ id: 'c1' }]);
    const selection = selectionOf('c1', 'model-a');
    const online = createGuestOnlineComposition({
      baseUrl: 'https://api.example.test',
      connectionStore: connections.store,
      namespace: GUEST,
      fetch: serviceDouble(state),
    });
    online.setAgentCatalog([{ id: 'private-a', label: 'Custom model', selection }]);
    online.setAgent({ label: 'Custom model', selection });
    // The guest seat of the accepted invitation.
    const credential = createGuestCredential({
      guestId: 'guest-00000001',
      matchId: 'match-00000001',
      seat: 'white',
      token: 'guest-token',
    });
    online.registerGuestCredential(credential, 'guest');
    online.attachAndFocus('match-00000001', 'white', undefined, selection);

    // The runner of the seat exists, because the composition owns the
    // connection store of the browser.
    await until(() => online.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');
    // The seat plays its turn, so the provider is asked with the credential of
    // the private model of the browser.
    await until(() => provider.requests.length > 0, 'the provider is asked');
    expect(provider.requests.every(request => request.authorization === 'Bearer key-c1')).toBe(true);
    expect(connections.asked).toContain('c1');
    online.dispose();
    provider.restore();
  }, 20_000);

  it('never plays an agent seat without the connection store of the browser', async () => {
    const provider = providerFixture();
    const state = { commands: 0 };
    const selection = selectionOf('c1', 'model-a');
    // The composition without the owned store is the defect of the guest
    // path: the seat of an accepted invitation waits for a model that can
    // never answer.
    const online = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: serviceDouble(state),
    });
    online.setAgentCatalog([{ id: 'private-a', label: 'Custom model', selection }]);
    online.setAgent({ label: 'Custom model', selection });
    const credential = createGuestCredential({
      guestId: 'guest-00000002',
      matchId: 'match-00000001',
      seat: 'white',
      token: 'guest-token',
    });
    online.registerGuestCredential(credential, 'guest');
    online.attachAndFocus('match-00000001', 'white', undefined, selection);
    await until(() => online.workspace.state('match-00000001')?.snapshot !== null, 'the snapshot of the match');
    // The seat has no runner, so the browser never plays it.
    await new Promise<void>(resolve => { setTimeout(resolve, 250); });
    expect(online.agentRunnerState('match-00000001', 'white')).toBeNull();
    expect(provider.requests).toHaveLength(0);
    online.dispose();
    provider.restore();
  }, 20_000);

  it('keeps the model the acceptor chose on the seat it accepted', () => {
    const state = { commands: 0 };
    const connections = connectionStoreOf([{ id: 'c1' }]);
    const selection = selectionOf('c1', 'model-a');
    const online = createGuestOnlineComposition({
      baseUrl: 'https://api.example.test',
      connectionStore: connections.store,
      namespace: GUEST,
      fetch: serviceDouble(state),
    });
    online.setAgentCatalog([{ id: 'private-a', label: 'Custom model', selection }]);
    online.setAgent({ label: 'Custom model', selection });
    // The seat the acceptor played, with the private selection it captured
    // before the acceptance.
    const credential = createGuestCredential({
      guestId: 'guest-00000003',
      matchId: 'match-00000002',
      seat: 'black',
      token: 'guest-token',
    });
    online.registerGuestCredential(credential, 'guest');
    online.attachAndFocus('match-00000002', 'black', undefined, selection);
    // The seat keeps the exact private model of the owner, never the public
    // label alone.
    expect(online.agentBindingFor('match-00000002', 'black')).toBe('private-a');
    expect(online.agentBindingLabelFor('match-00000002', 'black')).toBe('Custom model');
    online.dispose();
  });

  it('keeps the model the inviter chose when the invitee accepted the invitation', async () => {
    const state = { commands: 0 };
    const connections = connectionStoreOf([{ id: 'c1' }]);
    const selection = selectionOf('c1', 'model-a');
    const online = createGuestOnlineComposition({
      baseUrl: 'https://api.example.test',
      connectionStore: connections.store,
      namespace: GUEST,
      fetch: serviceDouble(state),
    });
    online.setAgentCatalog([{ id: 'private-a', label: 'Custom model', selection }]);
    online.setAgent({ label: 'Custom model', selection });
    // The inviter tracks its own invitation with the private selection it
    // captured before the service was asked.
    online.trackInvitation('invitation-00000001', 'owner-token', selection);
    // The invitation was consumed, so the inviter claims the seat of the
    // created match, and the seat keeps the model it chose.
    await until(
      () => online.agentBindingFor('match-00000001', 'white') !== null,
      'the seat of the inviter',
      10_000,
    );
    expect(online.agentBindingFor('match-00000001', 'white')).toBe('private-a');
    expect(online.agentBindingLabelFor('match-00000001', 'white')).toBe('Custom model');
    online.dispose();
  }, 20_000);
});
