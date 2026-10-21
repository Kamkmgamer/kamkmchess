import { describe, expect, it, vi } from 'vitest';
import { createOnlineWorkspace, onlineIdentityKey } from './workspace';
import type { OnlineGameRegistryEntry, OnlineGameRegistryStorage, OnlineSeatBinding, OnlineWorkspace } from './workspace';
import type { OnlineSubscriberInput } from './workspace';
import type { OnlineUpdatesSubscriber } from './updates';
import type { OnlineMatchView } from './updates';
import { createGuestCredential } from './auth';
import type { AccountOnlineCredential, GuestOnlineCredential } from './auth';
import type { AccountSessionPort } from './session';

function matchView(matchId: string, overrides: Partial<OnlineMatchView> = {}): OnlineMatchView {
  return {
    schemaVersion: 2,
    matchId,
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
      { seat: 'white', publicLabel: 'Owner', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      { seat: 'black', publicLabel: 'Opponent', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
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
    ...overrides,
  };
}

interface FakeSubscriber extends OnlineUpdatesSubscriber {
  emitSnapshot(snapshot: OnlineMatchView): void;
  emitError(): void;
  emitStop(reason: 'disposed' | 'unauthorized'): void;
  readonly started: boolean;
}

function createSubscriberFactory(): { factory: (input: OnlineSubscriberInput) => OnlineUpdatesSubscriber; created: FakeSubscriber[] } {
  const created: FakeSubscriber[] = [];
  const factory = (input: OnlineSubscriberInput): OnlineUpdatesSubscriber => {
    let started = false;
    const subscriber: FakeSubscriber = {
      start() { started = true; },
      wake() { /* the fake reconnects immediately */ },
      dispose() { /* the fake keeps no resource */ },
      get status() { return 'idle' as const; },
      get transport() { return 'sse' as const; },
      get cursor() { return null; },
      get stopReason() { return null; },
      get started() { return started; },
      emitSnapshot(snapshot) { input.onSnapshot(snapshot); },
      emitError() { input.onError(new Error('stream failed')); },
      emitStop(reason) { input.onStop(reason); },
    };
    created.push(subscriber);
    return subscriber;
  };
  return { factory, created };
}

function guestCredential(guestId: string, matchId: string, seat: 'white' | 'black'): GuestOnlineCredential {
  return createGuestCredential({ guestId, matchId, seat, token: `token-${guestId}` });
}

function accountCredential(accountId: string): AccountOnlineCredential {
  return {
    kind: 'account',
    accountId,
    issue: async () => `token-${accountId}`,
  };
}

function memoryRegistry(): OnlineGameRegistryStorage & { readonly data: Map<string, readonly OnlineGameRegistryEntry[]> } {
  const data = new Map<string, readonly OnlineGameRegistryEntry[]>();
  return {
    data,
    read(identityKey) {
      return data.get(identityKey) ?? [];
    },
    write(identityKey, entries) {
      data.set(identityKey, entries);
    },
  };
}

function accountSessionPort(initial: { accountId: string } | null): AccountSessionPort & { signIn(accountId: string): void; signOut(): void } {
  let identity = initial === null ? null : { accountId: initial.accountId, token: async () => 'token' };
  const listeners = new Set<(identity: { accountId: string; token: () => Promise<string> } | null) => void>();
  return {
    get identity() { return identity; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    signIn(accountId: string) {
      identity = { accountId, token: async () => 'token' };
      for (const listener of [...listeners]) listener(identity);
    },
    signOut() {
      identity = null;
      for (const listener of [...listeners]) listener(null);
    },
  };
}

describe('the online workspace keeps concurrent games (UX-04)', () => {
  it('follows two guest games at the same time with their own authority', () => {
    const { factory, created } = createSubscriberFactory();
    const workspace = createOnlineWorkspace({ baseUrl: 'https://example.test', createSubscriber: factory });
    const first: OnlineSeatBinding = { matchId: 'match-00000001', seat: 'white', credential: guestCredential('guest-a', 'match-00000001', 'white') };
    const second: OnlineSeatBinding = { matchId: 'match-00000002', seat: 'black', credential: guestCredential('guest-b', 'match-00000002', 'black') };
    workspace.attach(first);
    workspace.attach(second);
    expect(created).toHaveLength(2);
    expect(workspace.games.map(game => game.matchId)).toEqual(['match-00000001', 'match-00000002']);
    created[0]!.emitSnapshot(matchView('match-00000001'));
    created[1]!.emitSnapshot(matchView('match-00000002'));
    expect(workspace.state('match-00000001')?.status).toBe('live');
    expect(workspace.state('match-00000002')?.status).toBe('live');
    expect(workspace.state('match-00000001')?.snapshot?.matchId).toBe('match-00000001');
    expect(workspace.state('match-00000002')?.snapshot?.matchId).toBe('match-00000002');
  });

  it('keeps a live game running while another game is shown', () => {
    const { factory, created } = createSubscriberFactory();
    const workspace = createOnlineWorkspace({ baseUrl: 'https://example.test', createSubscriber: factory });
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: guestCredential('guest-a', 'match-00000001', 'white') });
    workspace.attach({ matchId: 'match-00000002', seat: 'white', credential: guestCredential('guest-b', 'match-00000002', 'white') });
    workspace.focus('match-00000002');
    expect(workspace.focusedMatchId).toBe('match-00000002');
    // The first match keeps receiving snapshots while it is not shown.
    created[0]!.emitSnapshot(matchView('match-00000001'));
    expect(workspace.state('match-00000001')?.status).toBe('live');
    expect(workspace.state('match-00000001')?.snapshot).not.toBeNull();
  });

  it('drops a late answer of a detached match', () => {
    const { factory, created } = createSubscriberFactory();
    const workspace = createOnlineWorkspace({ baseUrl: 'https://example.test', createSubscriber: factory });
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: guestCredential('guest-a', 'match-00000001', 'white') });
    workspace.detach('match-00000001');
    created[0]!.emitSnapshot(matchView('match-00000001'));
    expect(workspace.state('match-00000001')).toBeNull();
    expect(workspace.games).toHaveLength(0);
  });

  it('never replaces the authority of one match with the authority of another', () => {
    const { factory, created } = createSubscriberFactory();
    const workspace = createOnlineWorkspace({ baseUrl: 'https://example.test', createSubscriber: factory });
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: guestCredential('guest-a', 'match-00000001', 'white') });
    // The same match with a different credential starts a new attachment.
    workspace.attach({ matchId: 'match-00000001', seat: 'black', credential: guestCredential('guest-b', 'match-00000001', 'black') });
    expect(created).toHaveLength(2);
    expect(workspace.games).toHaveLength(1);
    expect(workspace.state('match-00000001')?.seat).toBe('black');
  });
});

describe('the identity owns the games (UX-04)', () => {
  it('hides the games of a previous account as soon as the identity changes', () => {
    const { factory } = createSubscriberFactory();
    const accountSession = accountSessionPort({ accountId: 'account-1' });
    const registry = memoryRegistry();
    const workspace = createOnlineWorkspace({
      baseUrl: 'https://example.test',
      createSubscriber: factory,
      accountSession,
      registry,
    });
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: accountCredential('account-1') });
    expect(workspace.games).toHaveLength(1);
    accountSession.signIn('account-2');
    expect(workspace.games).toHaveLength(0);
    // The games of the identity that left are hidden, and its durable list
    // stays on the device, so the identity finds them again when it returns.
    expect(registry.read('account:account-1')).toHaveLength(1);
    expect(registry.read('account:account-2')).toHaveLength(0);
  });

  it('gives the games of an identity back when it returns (A -> B -> A)', () => {
    const { factory } = createSubscriberFactory();
    const accountSession = accountSessionPort({ accountId: 'account-1' });
    const registry = memoryRegistry();
    const workspace = createOnlineWorkspace({
      baseUrl: 'https://example.test',
      createSubscriber: factory,
      accountSession,
      registry,
    });
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: accountCredential('account-1') });
    accountSession.signIn('account-2');
    expect(workspace.games).toHaveLength(0);
    accountSession.signIn('account-1');
    // The durable list of the first account is restored by the composition, so
    // the workspace can attach the match again.
    const restored = registry.read('account:account-1');
    expect(restored).toHaveLength(1);
    for (const entry of restored) {
      workspace.attach({ matchId: entry.matchId, seat: entry.seat, credential: accountCredential('account-1') });
    }
    expect(workspace.games.map(game => game.matchId)).toEqual(['match-00000001']);
  });

  it('keeps a guest seat when an account signs in', () => {
    const { factory } = createSubscriberFactory();
    const accountSession = accountSessionPort(null);
    const workspace = createOnlineWorkspace({ baseUrl: 'https://example.test', createSubscriber: factory, accountSession });
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: guestCredential('guest-a', 'match-00000001', 'white') });
    accountSession.signIn('account-1');
    expect(workspace.games).toHaveLength(1);
    expect(workspace.state('match-00000001')?.identityKey).toBe('guest:guest-a');
  });

  it('keeps the games of an account across a token refresh', () => {
    const { factory } = createSubscriberFactory();
    const accountSession = accountSessionPort({ accountId: 'account-1' });
    const workspace = createOnlineWorkspace({ baseUrl: 'https://example.test', createSubscriber: factory, accountSession });
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: accountCredential('account-1') });
    // The same account is notified again with a new session object.
    accountSession.signIn('account-1');
    expect(workspace.games).toHaveLength(1);
  });

  it('namespaces the durable list by the participant identity', () => {
    const { factory } = createSubscriberFactory();
    const registry = memoryRegistry();
    const workspace = createOnlineWorkspace({ baseUrl: 'https://example.test', createSubscriber: factory, registry });
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: accountCredential('account-1') });
    workspace.attach({ matchId: 'match-00000002', seat: 'white', credential: guestCredential('guest-a', 'match-00000002', 'white') });
    expect(registry.read('account:account-1').map(entry => entry.matchId)).toEqual(['match-00000001']);
    expect(registry.read('guest:guest-a').map(entry => entry.matchId)).toEqual(['match-00000002']);
    expect(onlineIdentityKey(accountCredential('account-1'))).toBe('account:account-1');
  });

  it('restores only the matches whose credential the browser still holds', () => {
    const { factory, created } = createSubscriberFactory();
    const registry = memoryRegistry();
    const workspace = createOnlineWorkspace({ baseUrl: 'https://example.test', createSubscriber: factory, registry });
    const guest = guestCredential('guest-a', 'match-00000001', 'white');
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: guest });
    expect(workspace.persisted('guest:guest-a')).toHaveLength(1);
    // A reload: the guest credential is gone, the account credential is not.
    const reloaded = createOnlineWorkspace({ baseUrl: 'https://example.test', createSubscriber: factory, registry });
    reloaded.restore('guest:guest-a', []);
    expect(reloaded.games).toHaveLength(0);
    reloaded.restore('account:account-1', [{ matchId: 'match-00000002', seat: 'white', credential: accountCredential('account-1') }]);
    expect(reloaded.games.map(game => game.matchId)).toEqual(['match-00000002']);
    expect(created.length).toBeGreaterThan(0);
  });
});

describe('the workspace never joins a queue', () => {
  it('sends no request of its own', () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const { factory } = createSubscriberFactory();
    const workspace: OnlineWorkspace = createOnlineWorkspace({
      baseUrl: 'https://example.test',
      createSubscriber: factory,
      fetch: fetcher as unknown as typeof fetch,
    });
    workspace.attach({ matchId: 'match-00000001', seat: 'white', credential: guestCredential('guest-a', 'match-00000001', 'white') });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
