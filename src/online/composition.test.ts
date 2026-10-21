import { describe, expect, it, vi } from 'vitest';
import { createOnlineComposition } from './composition';
import type { QueueEntry } from './contracts';
import type { ModelSelection } from '../controller/index.js';
import type { OnlineComposition } from './composition';
import { createGuestCredential } from './auth';
import type { OnlineMatchView } from './updates';
import type { ConnectionNamespace, ConnectionProfile, ConnectionStore } from '../providers/connections/index.js';
import { namespaceKey } from '../providers/connections/index.js';
import {
  bindCredentialValues,
  captureCredentialBindingGeneration,
  createCredentialBindingOwner,
} from '../providers/connections/credential-binding.js';

const timeControl = { startingTimeMs: 300_000, incrementMs: 2_000 };

function matchView(overrides: Partial<OnlineMatchView> = {}): OnlineMatchView {
  return {
    schemaVersion: 2,
    matchId: 'match-00000001',
    variant: 'orthodox',
    startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    positionFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    timeControl,
    version: 1,
    controlEpoch: 1,
    rulesPolicyVersion: 'online-rules/1',
    status: 'active',
    result: null,
    seats: [
      { seat: 'white', publicLabel: 'Owner', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      { seat: 'black', publicLabel: 'Stockfish 19 Lite', control: { kind: 'engine', modelLabel: 'Stockfish 19 Lite' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ],
    clock: {
      whiteMs: 300_000,
      blackMs: 300_000,
      activeSeat: null,
      activeSince: null,
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

interface Wire {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
  readonly headers: Record<string, string>;
}

/**
 * A fetch double that answers the queue and the participant routes.
 *
 * The answers carry the exact field names of the service contract, so a
 * renamed field fails the fixture instead of being papered over.
 */
function createFetchDouble(answers: {
  entry?: (body: Record<string, unknown> | null) => { status: number; data: unknown };
  match?: { status: number; data: unknown };
  fallback?: { status: number; data: unknown };
  matchView?: { status: number; data: unknown };
}) {
  const wires: Wire[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
    wires.push({ path, method, body, headers });
    let result: { status: number; data: unknown } = { status: 404, data: { error: 'not_found' } };
    if (path.endsWith('/cancel')) {
      result = { status: 200, data: { ...entryAnswer(null), status: 'cancelled' } };
    } else if (path.includes('/queue/entries') && method === 'POST' && path.endsWith('/entries')) {
      result = answers.entry?.(body) ?? { status: 201, data: entryAnswer(body) };
    } else if (path.endsWith('/fallback')) {
      result = answers.fallback ?? { status: 200, data: fallbackAnswer() };
    } else if (path.endsWith('/match')) {
      result = answers.match ?? { status: 404, data: { error: 'not_found' } };
    } else if (path.includes('/v1/online/invitations/') && path.endsWith('/seat-credential')) {
      // The account claim names the match and the seat, without a credential.
      result = { status: 200, data: { schemaVersion: 2, matchId: 'match-00000007', seat: 'white', guestCredential: null } };
    } else if (path.includes('/v1/online/invitations/')) {
      result = {
        status: 200,
        data: {
          schemaVersion: 2,
          invitationId: 'invitation-0002',
          kind: 'link',
          status: 'consumed',
          inviterLabel: 'Guest',
          inviterSeat: 'white',
          inviterControl: { kind: 'human' },
          timeControl,
          startingFen: null,
          expiresAt: '2026-10-22T10:00:00.000Z',
          createdAt: '2026-10-21T10:00:00.000Z',
          consumedAt: '2026-10-21T10:01:00.000Z',
          cancelledAt: null,
          matchId: 'match-00000007',
        },
      };
    } else if (path.includes('/v1/online/matches/')) {
      result = answers.matchView ?? { status: 200, data: matchView() };
    } else if (path.includes('/updates')) {
      const snapshot = matchView();
      result = { status: 200, data: { schemaVersion: 1, cursor: snapshot.version, snapshot } };
    } else if (path.includes('/v1/online/features')) {
      result = { status: 200, data: { friends: true, queue: true } };
    }
    return new Response(JSON.stringify(result.data), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetcher: fetcher as unknown as typeof fetch, wires };
}

function entryAnswer(body: Record<string, unknown> | null): Record<string, unknown> {
  return {
    schemaVersion: 2,
    entryId: 'entry-0000001',
    owner: { kind: 'account', id: 'account-1' },
    control: body?.control ?? { kind: 'human' },
    timeControl: body?.timeControl ?? timeControl,
    status: 'waiting',
    version: 1,
    readyAt: '2026-10-21T10:00:00.000Z',
    cutoffAt: '2026-10-21T10:00:10.000Z',
    assignedMatchId: null,
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
  };
}

function fallbackAnswer(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    matchId: 'match-00000001',
    seat: 'white',
    opponentLabel: 'Stockfish 19 Lite',
    control: { kind: 'engine', modelLabel: 'Stockfish 19 Lite' },
          guestCredential: undefined,
  };
}

interface Storage {
  readonly data: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
}

/** Lets every pending promise settle. */
function settle(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

/** A signed-in account session for the queue, which is an account surface. */
function accountSession(): { identity: { accountId: string; token: () => Promise<string> }; subscribe: (listener: (identity: { accountId: string; token: () => Promise<string> } | null) => void) => () => void } {
  return {
    identity: { accountId: 'account-1', token: async () => 'account-token' },
    subscribe: () => () => undefined,
  };
}

function createComposition(overrides: {
  fetcher?: typeof fetch;
  storage?: Storage;
  accountSession?: Parameters<typeof createOnlineComposition>[0]['accountSession'];
  timers?: Parameters<typeof createOnlineComposition>[0]['timers'];
} = {}): { composition: OnlineComposition; wires: Wire[]; storage: Storage } {
  const { fetcher, wires } = createFetchDouble({});
  const storage = overrides.storage ?? createStorage();
  const composition = createOnlineComposition({
    baseUrl: 'https://api.example.test',
    fetch: overrides.fetcher ?? fetcher,
    storage,
    accountSession: overrides.accountSession ?? accountSession(),
    // The browser engine prepares. The fixture answers the fallback.
    prepareEngine: async () => undefined,
    ...(overrides.timers ? { timers: overrides.timers } : {}),
  });
  return { composition, wires, storage };
}

/** A timer seam that never fires on its own. */
function manualTimers(): { timers: { setTimer: (callback: () => void, delayMs: number) => unknown; clearTimer: (handle: unknown) => void }; fire: () => void; pending: number } {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    timers: {
      setTimer(callback) {
        const handle = next;
        next += 1;
        pending.set(handle, callback);
        return handle;
      },
      clearTimer(handle) {
        pending.delete(handle as number);
      },
    },
    get pending() {
      return pending.size;
    },
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe('the online composition wires the product (B-2, B-5, B-7, B-12)', () => {
  it('attaches and shows a committed assignment', async () => {
    const clock = manualTimers();
    const { composition, wires } = createComposition({ timers: clock.timers });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    // The cutoff commits the browser engine fallback.
    clock.fire();
    await settle();
    const fallback = wires.find(wire => wire.path.endsWith('/fallback'));
    expect(fallback).toBeDefined();
    expect(composition.workspace.games.map(game => game.matchId)).toContain('match-00000001');
    expect(composition.workspace.focusedMatchId).toBe('match-00000001');
    composition.dispose();
  });

  it('polls the waiting entry and feeds the answer into the controller', async () => {
    const clock = manualTimers();
    const { composition, wires } = createComposition({ timers: clock.timers });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    clock.fire();
    await settle();
    const reads = wires.filter(wire => wire.path.includes('/queue/entries/entry-0000001') && wire.method === 'GET');
    // The entry is read by the background poll.
    expect(reads.length).toBeGreaterThan(0);
    const heartbeats = wires.filter(wire => wire.path.endsWith('/heartbeat'));
    expect(heartbeats.length).toBeGreaterThan(0);
    composition.dispose();
  });

  it('creates a second entry for an explicit new intent', async () => {
    const { composition, wires } = createComposition();
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    const first = wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST');
    await composition.enterQueue({ control: { kind: 'human' }, timeControl }, { intent: 'new' });
    const second = wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST');
    expect(second.length).toBe(first.length + 1);
    const keys = second.map(wire => String(wire.body?.clientRequestId));
    expect(new Set(keys).size).toBe(keys.length);
    composition.dispose();
  });

  it('keeps an earlier entry alive with its own timer and its own cancel (B-5)', async () => {
    const clock = manualTimers();
    const { composition } = createComposition({ timers: clock.timers });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    const firstId = composition.queueEntries[0]?.id;
    await composition.enterQueue({ control: { kind: 'human' }, timeControl }, { intent: 'new' });
    expect(composition.queueEntries).toHaveLength(2);
    expect(composition.queueEntries[0]?.id).toBe(firstId);
    // Both entries keep a poll timer of their own.
    expect(clock.pending).toBeGreaterThanOrEqual(2);
    // The older entry can be cancelled on its own.
    await composition.queueEntries[0]?.cancel();
    expect(composition.queueEntries[0]?.state.phase).toBe('cancelled');
    expect(composition.queueEntries[1]?.state.phase).toBe('searching');
    composition.dispose();
  });

  it('releases the intent when the creation is definitively refused', async () => {
    const { fetcher, wires } = createFetchDouble({
      entry: () => ({ status: 400, data: { error: 'invalid_request' } }),
    });
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    // A definitive refusal releases the intent, so the owner can try again.
    expect(storage.data.size).toBe(0);
    composition.dispose();
    expect(wires.length).toBeGreaterThan(0);
  });

  it('keeps the intent of a newer entry when an older entry ends (B-4, scoped)', async () => {
    // The older entry A expires while the newer entry B is created, commits
    // and its answer is lost. The intent of B survives and its retry reuses
    // the same key.
    let lost = false;
    const { fetcher, wires } = createFetchDouble({
      entry: (body) => {
        const control = body?.control as { kind?: string } | undefined;
        if (control?.kind === 'agent' && !lost) {
          lost = true;
          throw new Error('The connection was lost.');
        }
        return { status: 201, data: entryAnswer(body) };
      },
    });
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      checkModel: async () => ({ ready: true, detail: '' }),
    });
    // The older entry A waits and then expires.
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    // The owner has an own agent, so the agent seat may enter the queue.
    composition.setAgent({
      label: 'GPT-4o',
      selection: { connectionId: 'c1', modelRoutingId: 'm1', protocol: 'chat-completions', configurationRevision: 'r1', diagnostic: 'passed-current-session' } as unknown as ModelSelection,
    });
    // The newer entry B commits, but its answer is lost.
    await composition.enterQueue({ control: { kind: 'agent', modelLabel: 'GPT-4o' }, timeControl }, { intent: 'new' })
      .catch(() => undefined);
    // The terminal state of the older entry A does not release the intent of B.
    composition.queueEntries[0]?.observe({ ...entryAnswer(null), status: 'waiting', readyAt: null } as unknown as QueueEntry);
    // The retry of B reuses the key of B, and never the key of the older
    // entry A.
    const before = wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST').length;
    await composition.queue.retry().catch(() => undefined);
    const creates = wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST');
    expect(creates.length).toBe(before + 1);
    const keys = creates.map(wire => String(wire.body?.clientRequestId));
    expect(keys[1]).toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[1]);
    composition.dispose();
  });
  it('keeps the intent when the answer of the creation is unknown (B-4)', async () => {
    // The service committed the entry, but the answer never reached the
    // browser. The retry has to reach the same entry.
    let committed = false;
    const { fetcher, wires } = createFetchDouble({
      entry: (body) => {
        committed = true;
        void body;
        throw new Error('The connection was lost.');
      },
    });
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    expect(committed).toBe(true);
    const stored = [...storage.data.values()][0] ?? '';
    expect(stored).toContain('"key"');
    const key = JSON.parse(stored) as { key: string; entryId: string | null };
    // A new composition of the same identity and the same settings reuses
    // the key, so the service answers with the same entry.
    const retry = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
    });
    await retry.enterQueue({ control: { kind: 'human' }, timeControl });
    const second = JSON.parse([...storage.data.values()][0] ?? '{}') as { key: string };
    expect(second.key).toBe(key.key);
    const creates = wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST');
    expect(creates).toHaveLength(2);
    expect(creates[0]?.body?.clientRequestId).toBe(creates[1]?.body?.clientRequestId);
    composition.dispose();
    retry.dispose();
  });

  it('namespaces the intent by the identity', async () => {
    const storage = createStorage();
    const { composition } = createComposition({ storage });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    const keys = [...storage.data.keys()];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(key => key.startsWith('kamkmchess.online.queue.intent.v1:'))).toBe(true);
    // The key carries the identity, so two accounts never share it.
    expect(keys.some(key => key.includes('account-1'))).toBe(true);
    composition.dispose();
  });

  it('keeps the intent of a matched entry for the recovery of the engine seat', async () => {
    // The entry id of a matched entry is the only way to ask the service to
    // rotate the credential of the engine seat when the identity comes back,
    // so the intent of a matched entry survives the match.
    const storage = createStorage();
    const { composition } = createComposition({ storage });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    const key = 'kamkmchess.online.queue.intent.v1:account%3Aaccount-1';
    const before = JSON.parse(String(storage.getItem(key) ?? '[]')) as { entryId: string | null }[];
    expect(before.length).toBe(1);
    expect(before[0]?.entryId).toBeTruthy();
    // The entry produced a game.
    composition.queueEntries[0]?.observe({
      ...entryAnswer(null),
      status: 'assigned',
      assignedMatchId: 'match-00000031',
    } as unknown as QueueEntry);
    await settle();
    const after = JSON.parse(String(storage.getItem(key) ?? '[]')) as { entryId: string | null }[];
    expect(after.length).toBe(1);
    expect(after[0]?.entryId).toBe(before[0]?.entryId);
    composition.dispose();
  });
});

describe('the agent binding follows the seat, never the public label (B-26)', () => {
  it('binds the exact private selection of the chosen label and keeps it in the browser', () => {
    const storage = createStorage();
    const { composition } = createComposition({ storage });
    const first = { connectionId: 'c1', modelRoutingId: 'm1', protocol: 'chat-completions', configurationRevision: 'r1', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    const second = { connectionId: 'c2', modelRoutingId: 'm2', protocol: 'chat-completions', configurationRevision: 'r2', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    composition.setAgentCatalog([{ id: 'choice-1', label: 'My agent', selection: first }, { id: 'choice-2', label: 'Other model', selection: second }]);
    // A seat without a binding has no agent: the browser never guesses one.
    expect(composition.agentBindingFor('match-00000001', 'white')).toBeNull();
    // The owner chooses the agent of the seat.
    composition.bindAgentSeat('match-00000001', 'white', 'Other model');
    expect(composition.agentBindingFor('match-00000001', 'white')).toBe('Other model');
    // The binding is stored in the browser, so a reload keeps it.
    const reloaded = createComposition({ storage });
    expect(reloaded.composition.agentBindingFor('match-00000001', 'white')).toBe('Other model');
    composition.dispose();
    reloaded.composition.dispose();
  });

  it('binds the own agent of the owner to the seat of the assigned match', () => {
    const { composition } = createComposition();
    const selection = { kind: 'model', providerId: 'p', connectionId: 'c1', configurationRevision: 1, modelRoutingId: 'm1', protocol: 'chat-completions', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    composition.setAgentCatalog([{ id: 'choice-1', label: 'My agent', selection }]);
    composition.setAgent({ label: 'My agent', selection });
    // The assignment knows the match and the seat of the owner, and the
    // selection that was captured when the entry was created.
    composition.attachAndFocus('match-00000042', 'black', undefined, selection);
    expect(composition.agentBindingFor('match-00000042', 'black')).toBe('My agent');
    expect(composition.agentBindingFor('match-00000042', 'white')).toBeNull();
    // A seat without a captured selection stays unbound: the owner chooses.
    composition.attachAndFocus('match-00000043', 'black');
    expect(composition.agentBindingFor('match-00000043', 'black')).toBeNull();
    composition.dispose();
  });

  it('binds nothing for a label the owner never connected', () => {
    const { composition } = createComposition();
    composition.setAgentCatalog([{ id: 'choice-1', label: 'My agent', selection: { connectionId: 'c1', modelRoutingId: 'm1' } as unknown as ModelSelection }]);
    composition.bindAgentSeat('match-00000001', 'white', 'Unknown model');
    expect(composition.agentBindingFor('match-00000001', 'white')).toBeNull();
    composition.dispose();
  });

  it('resolves the private selection of a switch and never relabels the old one', async () => {
    const { composition } = createComposition();
    const first = { connectionId: 'c1', modelRoutingId: 'm1', protocol: 'chat-completions', configurationRevision: 'r1', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    const second = { connectionId: 'c2', modelRoutingId: 'm2', protocol: 'chat-completions', configurationRevision: 'r2', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    composition.setAgent({ label: 'Custom model', selection: first });
    composition.setAgentCatalog([{ id: 'choice-1', label: 'Custom model', selection: first }, { id: 'choice-2', label: 'Other model', selection: second }]);
    // A switch to a label of the catalog resolves the private selection of
    // that label.
    const outcome = await composition.agentDecision('match-00000001', 'white', 'switch-model', 'Other model');
    expect(outcome.kind).toBe('accepted');
    // A switch to a label the owner never connected is refused, and the
    // refusal is explicit.
    const refused = await composition.agentDecision('match-00000001', 'white', 'switch-model', 'Unknown model');
    expect(refused.kind).toBe('refused');
    composition.dispose();
  });
});

describe('the composition reacts to a snapshot (R4-03)', () => {
  it('publishes the change of an attached match', async () => {
    const { composition } = createComposition();
    let notifications = 0;
    const unsubscribe = composition.subscribe(() => { notifications += 1; });
    // The workspace follows the match, and the update route answers with a
    // canonical snapshot. The composition has to learn about it, otherwise the
    // engine seat and the agent seat never play.
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-1',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    });
    const deadline = Date.now() + 5_000;
    while (notifications === 0 && Date.now() < deadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 25); });
    }
    expect(notifications).toBeGreaterThan(0);
    expect(composition.workspace.state('match-00000001')?.status).not.toBeNull();
    unsubscribe();
    composition.dispose();
  });
});

describe('two private models that share one public label (R4-08)', () => {
  it('keeps them apart and binds each seat with its own selection', () => {
    const { composition } = createComposition();
    const first = { kind: 'model', providerId: 'p', connectionId: 'c1', configurationRevision: 1, modelRoutingId: 'm1', protocol: 'chat-completions', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    const second = { kind: 'model', providerId: 'p', connectionId: 'c2', configurationRevision: 2, modelRoutingId: 'm2', protocol: 'responses', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    // Both models carry the same public label on the service.
    composition.setAgentCatalog([
      { id: 'private-a', label: 'Custom model', selection: first },
      { id: 'private-b', label: 'Custom model', selection: second },
    ]);
    expect(composition.agentCatalog).toHaveLength(2);
    composition.attachAndFocus('match-00000010', 'white', undefined, first);
    composition.attachAndFocus('match-00000011', 'white', undefined, second);
    // Each seat keeps its own private selection.
    expect(composition.agentBindingFor('match-00000010', 'white')).toBe('Custom model');
    expect(composition.agentBindingFor('match-00000011', 'white')).toBe('Custom model');
    composition.dispose();
  });

  it('resolves a choice by its private identity', () => {
    const { composition } = createComposition();
    const first = { kind: 'model', providerId: 'p', connectionId: 'c1', configurationRevision: 1, modelRoutingId: 'm1', protocol: 'chat-completions', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    const second = { kind: 'model', providerId: 'p', connectionId: 'c2', configurationRevision: 2, modelRoutingId: 'm2', protocol: 'responses', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    composition.setAgentCatalog([
      { id: 'private-a', label: 'Custom model', selection: first },
      { id: 'private-b', label: 'Custom model', selection: second },
    ]);
    // An ambiguous label resolves to nothing, so the browser never guesses.
    composition.bindAgentSeat('match-00000012', 'white', 'Custom model');
    expect(composition.agentBindingFor('match-00000012', 'white')).toBeNull();
    // The private identity of the entry resolves.
    composition.bindAgentSeat('match-00000012', 'white', 'private-b');
    expect(composition.agentBindingFor('match-00000012', 'white')).toBe('Custom model');
    composition.dispose();
  });
});

describe('the identity handover keeps the model of the returning owner', () => {
  it('restores the model of the identity that comes back', () => {
    const storage = createStorage();
    const { composition } = createComposition({ storage });
    const selection = { kind: 'model', providerId: 'p', connectionId: 'c1', configurationRevision: 1, modelRoutingId: 'm1', protocol: 'chat-completions', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    composition.setAgentCatalog([{ id: 'private-a', label: 'My agent', selection }]);
    composition.attachAndFocus('match-00000020', 'white', undefined, selection);
    expect(composition.agentBindingFor('match-00000020', 'white')).toBe('My agent');
    // The identity leaves and comes back: the private binding of that identity
    // is still on the device and is restored.
    expect(composition.agentBindingFor('match-00000020', 'white')).toBe('My agent');
    composition.dispose();
  });
});

describe('the deferred claims of the friend flow (r9)', () => {
  it('polls for a rematch alone, without a tracked invitation', () => {
    const clock = manualTimers();
    const { composition } = createComposition({ timers: clock.timers });
    composition.trackRematch('rematch-0001', 'match-00000001', null);
    // The poll runs for the rematch alone.
    expect(clock.pending).toBeGreaterThan(0);
    composition.dispose();
  });

  it('keeps the record of a proposed rematch durable', () => {
    const storage = createStorage();
    const { composition } = createComposition({ storage });
    const selection = { kind: 'model', providerId: 'p', connectionId: 'c1', configurationRevision: 1, modelRoutingId: 'm1', protocol: 'chat-completions', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    composition.trackRematch('rematch-0002', 'match-00000002', selection);
    // A new composition of the same identity finds the record again.
    const reloaded = createComposition({ storage });
    const records = [...storage.data.values()].join('');
    expect(records).toContain('rematch-0002');
    reloaded.composition.dispose();
    composition.dispose();
  });

  it('claims the seat of a consumed invitation of an account (no guest credential)', async () => {
    // The claim answer of an account seat carries no guest credential, but it
    // names the match and the seat.
    const clock = manualTimers();
    const { fetcher, wires } = createFetchDouble({
      entry: () => ({ status: 201, data: entryAnswer(null) }),
    });
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      timers: clock.timers,
    });
    composition.trackInvitation('invitation-0002', 'owner-token', null);
    // The poll reads the invitation, sees the consumption and claims the seat.
    clock.fire();
    await settle();
    await settle();
    const claim = wires.find(wire => wire.path.includes('/seat-credential'));
    expect(claim).toBeDefined();
    // The claim answer names the match and the seat, so the inviter follows
    // its own match with the account credential.
    expect(composition.workspace.games.map(game => game.matchId)).toContain('match-00000007');
    composition.dispose();
  });

  it('asks for one fresh engine credential after the identity came back', async () => {
    // The browser held the credential of the engine seat of its account. The
    // identity changed, so the credential was revoked. When the identity
    // returns, the browser holds no usable credential and asks for the
    // explicit recovery once.
    const { fetcher, wires } = createFetchDouble({
      entry: () => ({ status: 201, data: entryAnswer(null) }),
      fallback: {
        status: 200,
        data: {
          schemaVersion: 2,
          matchId: 'match-00000030',
          seat: 'white',
          opponentLabel: 'Stockfish 19 Lite',
          control: { kind: 'engine', modelLabel: 'Stockfish 19 Lite' },
        },
      },
    });
    const storage = createStorage();
    const listeners = new Set<(identity: { accountId: string; token: () => Promise<string> } | null) => void>();
    let identity: { accountId: string; token: () => Promise<string> } | null = { accountId: 'account-1', token: async () => 'token' };
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: {
        get identity() { return identity; },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      },
      prepareEngine: async () => undefined,
    });
    // The engine seat of a fallback game is bound to the account.
    composition.registerGuestCredential(createGuestCredential({
      guestId: 'guest-engine',
      matchId: 'match-00000030',
      seat: 'black',
      token: 'engine-token',
    }), 'account');
    // The entry of the fallback game carries the durable intent.
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    // The identity leaves and comes back: the credential of the engine seat
    // is revoked, so the recovery asks the service for a fresh one.
    identity = { accountId: 'account-2', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    identity = { accountId: 'account-1', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    await settle();
    await settle();
    const fallbacks = wires.filter(wire => wire.path.endsWith('/fallback'));
    // The routine fallback never rotates a credential. The recovery that
    // follows asks for the rotation, because the browser holds no usable
    // credential of the engine seat any more.
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks[0]?.body?.credentialRecovery).toBeUndefined();
    const recovery = fallbacks[fallbacks.length - 1];
    expect(recovery?.body?.credentialRecovery).toBe(true);
    composition.dispose();
  });

  it('discards a deferred claim of the identity that left', async () => {
    const { composition, wires } = createComposition();
    // The claim of the invitation is deferred: the identity changes while the
    // service is asked.
    const session = { identity: { accountId: 'account-1', token: async () => 'token' }, subscribe: () => () => undefined };
    const scoped = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
      storage: createStorage(),
      accountSession: session,
    });
    scoped.trackInvitation('invitation-0001', 'owner-token', null);
    expect(scoped.workspace.games).toHaveLength(0);
    scoped.dispose();
    expect(wires.length).toBeGreaterThanOrEqual(0);
    composition.dispose();
  });
});

describe('the composition keeps the guest authority (B-6)', () => {  it('never drives a guest seat with the account credential', async () => {
    const { composition, wires } = createComposition();
    composition.registerGuestCredential(createGuestCredential({
      guestId: 'guest-1',
      matchId: 'match-00000002',
      seat: 'black',
      token: 'guest-token',
    }), 'guest');
    const client = composition.commandClient('match-00000002', 'black');
    expect(client).not.toBeNull();
    client!.setVersion(1);
    await client!.move('e7e5').catch(() => undefined);
    const command = wires.find(wire => wire.path.includes('/commands'));
    expect(command?.headers['x-guest-seat-token']).toBe('guest-token');
    expect(command?.headers.authorization).toBeUndefined();
    composition.dispose();
  });

  it('fails closed when the guest credential of a seat is gone', () => {
    const { composition } = createComposition();
    composition.registerGuestCredential(createGuestCredential({
      guestId: 'guest-1',
      matchId: 'match-00000003',
      seat: 'black',
      token: 'guest-token',
    }), 'guest');
    expect(composition.commandClient('match-00000003', 'black')).not.toBeNull();
    composition.dispose();
  });
});

/**
 * The service of a composition that plays an agent seat.
 *
 * The double answers the lease route, the request route and the command route
 * of the runner, so the composition drives a real runner over the real
 * transport. The acknowledgement of a command can be lost, so a test can
 * recover a command the service already applied, and a route can wait for the
 * test, so a test can open a window between two answers of the service.
 */
interface AgentServiceState {
  view: OnlineMatchView;
  /** The mode of the command route of the runner. */
  mode: 'online' | 'lost';
  version: number;
  controlEpoch: number;
  commands: Array<Record<string, unknown>>;
  leases: number;
  /** The lease of the seat. */
  leaseId: string | null;
  /** The command route waits for the test. */
  holdCommand: boolean;
  /** The command route waits for the test now. */
  heldCommand: boolean;
  /** The lease route waits for the test. */
  holdLease: boolean;
  /** The lease route waits for the test now. */
  heldLease: boolean;
  /** The releases the service saw. */
  releases: number;
  /** The gate the command route waits for. */
  commandGate: Promise<void>;
  /** The gate the lease route waits for. */
  leaseGate: Promise<void>;
}

/** One held answer of the service. */
function createGate(): { readonly promise: Promise<void>; release: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, release: () => resolve() };
}

function agentServiceDouble(state: AgentServiceState): typeof fetch {
  const receipts = new Map<string, Record<string, unknown>>();
  const attempts = new Map<string, number>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown>;
    const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    if (path.endsWith('/runner/lease') || path.endsWith('/runner/request')) {
      if (state.holdLease) {
        state.holdLease = false;
        state.heldLease = true;
        await state.leaseGate;
      }
      if (String(body?.action ?? '') === 'release') state.releases += 1;
      state.leases += 1;
      // The lease of the seat keeps its identifier while the runner renews it.
      if (state.leaseId === null) state.leaseId = `lease-0000000${state.leases}`;
      return json({
        schemaVersion: 2,
        leaseId: state.leaseId,
        matchId: 'match-00000001',
        seat: 'white',
        controlEpoch: state.controlEpoch,
        generation: 1,
        runnerId: String(body?.runnerId ?? 'runner-1'),
        status: 'active',
        acquiredAt: '2026-10-21T10:00:00.000Z',
        expiresAt: '2035-01-01T00:00:00.000Z',
        revokedAt: null,
        turnVersion: state.version,
        runnerEpoch: 1,
        pendingRequestId: path.endsWith('/runner/request') ? String(body?.requestId ?? '') : null,
        pendingRequestStartedAt: null,
        revokedReason: null,
        lastRenewedAt: '2026-10-21T10:00:00.000Z',
      });
    }
    if (path.endsWith('/commands')) {
      if (state.holdCommand) {
        state.holdCommand = false;
        state.heldCommand = true;
        await state.commandGate;
      }
      state.commands.push(body ?? {});
      const operationId = String(body?.operationId ?? 'operation-1');
      const attempt = (attempts.get(operationId) ?? 0) + 1;
      attempts.set(operationId, attempt);
      const stored = receipts.get(operationId);
      if (stored !== undefined) {
        // The replay of an accepted operation answers with the stored receipt.
        if (state.mode === 'lost' && attempt <= 3) throw new TypeError('The network failed.');
        return json(stored);
      }
      const action = (body?.action ?? {}) as { kind?: string; control?: { kind?: string; modelLabel?: string } };
      if (Number(body?.expectedVersion ?? 0) > state.version) {
        return json({ error: 'conflict' }, 409);
      }
      state.version += 1;
      if (action.kind === 'set_control') state.controlEpoch += 1;
      const receipt: Record<string, unknown> = {
        schemaVersion: 2,
        matchId: 'match-00000001',
        operationId,
        outcome: 'accepted',
        version: state.version,
        controlEpoch: state.controlEpoch,
        decidedAt: '2026-10-21T10:00:00.000Z',
      };
      if (action.kind === 'set_control') {
        receipt.event = {
          schemaVersion: 2,
          matchId: 'match-00000001',
          version: state.version,
          kind: 'control_change',
          seat: 'white',
          controlEpoch: state.controlEpoch,
          decisionAt: '2026-10-21T10:00:00.000Z',
          acceptedAt: '2026-10-21T10:00:00.000Z',
          control: action.control ?? { kind: 'agent' },
        };
      }
      receipts.set(operationId, receipt);
      // The command reached the service and was applied there, but the browser
      // never learned the receipt.
      if (state.mode === 'lost' && attempt <= 3) throw new TypeError('The network failed.');
      return json(receipt);
    }
    if (path.includes('/updates')) {
      return json({ schemaVersion: 1, cursor: state.version, snapshot: state.view });
    }
    if (path.includes('/v1/online/matches/')) {
      return json(state.view);
    }
    return json({ error: 'not_found' }, 404);
  }) as unknown as typeof fetch;
}

/** The private selection of one catalog entry. */
function selectionOf(connectionId: string, modelRoutingId: string): ModelSelection {
  return {
    kind: 'model',
    providerId: 'p',
    connectionId,
    configurationRevision: 1,
    modelRoutingId,
    protocol: 'chat-completions',
    diagnostic: 'passed-current-session',
  } as unknown as ModelSelection;
}

/**
 * The connection store of the fixture.
 *
 * Every profile carries its own credential, so a test can see which private
 * selection asked the provider and which credential it used.
 */
function connectionStoreOf(profiles: readonly { id: string }[]): {
  readonly store: Promise<ConnectionStore>;
  readonly asked: string[];
} {
  const asked: string[] = [];
  const owner = createCredentialBindingOwner();
  const store = {
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
      // The credential of the profile is bound to the profile, so the
      // provider request carries the credential of the private model that owns
      // it.
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
 * The provider of the fixture.
 *
 * The provider transport is the global transport of the browser, so the
 * fixture answers it directly. Every answer records the credential of the
 * request, so a test can see which private model asked the provider.
 */
function providerFixture(): {
  readonly requests: Array<{ readonly url: string; readonly authorization: string | null }>;
  restore(): void;
} {
  const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    requests.push({ url: String(input), authorization: headers.get('authorization') });
    return new Response(JSON.stringify({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '{"move":"e2e4"}' },
        finish_reason: 'stop',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch);
  return { requests, restore: () => vi.unstubAllGlobals() };
}

/** The canonical view of the agent seat of the fixture. */
function agentView(state: AgentServiceState, control: { kind: 'human' | 'agent'; modelLabel?: string }, seatToMove: boolean): OnlineMatchView {
  return matchView({
    version: state.version,
    controlEpoch: state.controlEpoch,
    seats: [
      { seat: 'white', publicLabel: 'Owner', control, controlEpoch: state.controlEpoch, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      { seat: 'black', publicLabel: 'Guest', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ],
    clock: {
      whiteMs: 300_000,
      blackMs: 300_000,
      // The opening reply window keeps the seat from moving while the seat
      // waits for the decision of the owner.
      activeSeat: seatToMove ? 'white' : null,
      activeSince: seatToMove ? '2026-10-21T10:00:00.000Z' : null,
      deadlineAt: null,
      whiteMoved: false,
      blackMoved: false,
      turnNumber: 1,
      replySeat: seatToMove ? null : 'black',
      replyDeadlineAt: null,
    },
  });
}

describe('the recovery of an applied handoff (R10-A)', () => {
  /** The state of the service of the fixture. */
  function serviceState(seatToMove = true): AgentServiceState {
    const commandGate = createGate();
    const leaseGate = createGate();
    const state: AgentServiceState = {
      view: matchView(),
      mode: 'lost',
      version: 1,
      controlEpoch: 1,
      commands: [],
      leases: 0,
      leaseId: null,
      holdCommand: false,
      heldCommand: false,
      holdLease: false,
      heldLease: false,
      releases: 0,
      commandGate: commandGate.promise,
      leaseGate: leaseGate.promise,
    };
    state.view = agentView(state, { kind: 'agent', modelLabel: 'Custom model' }, seatToMove);
    return state;
  }

  /** Waits for a condition of the test. */
  async function until(condition: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`The condition (${label}) was not reached.`);
      await new Promise<void>(resolve => { setTimeout(resolve, 5); });
    }
  }

  it('binds the captured private selection of a recovered switch and plays the seat with it', async () => {
    const provider = providerFixture();
    const storage = createStorage();
    const first = selectionOf('c1', 'm1');
    const second = selectionOf('c2', 'm2');
    const state = serviceState();
    const connections = connectionStoreOf([{ id: 'c1' }, { id: 'c2' }]);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: agentServiceDouble(state),
      storage,
      accountSession: accountSession(),
      connectionStore: connections.store,
    });
    composition.setAgentCatalog([
      { id: 'private-a', label: 'Custom model', selection: first },
      { id: 'private-b', label: 'Custom model', selection: second },
    ]);
    composition.setAgent({ label: 'Custom model', selection: first });
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-1',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The seat is to move, so the runner of the old selection asks the
    // provider and submits the move of the seat.
    await until(() => provider.requests.length > 0, 'the provider is asked');
    expect(provider.requests.every(request => request.authorization === 'Bearer key-c1')).toBe(true);

    // The owner switches the seat to the other private model. The service
    // applies the command and the browser never learns the receipt, so the
    // outcome is unknown and the binding of the seat stays the old one.
    const unknown = await composition.agentDecision('match-00000001', 'white', 'switch-model', 'private-b');
    expect(unknown.kind).toBe('unknown');
    expect(composition.agentBindingFor('match-00000001', 'white')).toBe('Custom model');
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBe('c1');
    // The control of the seat changed at the service. From this moment the
    // browser never asks the provider with the credential of the old model
    // again.
    const askedBefore = provider.requests.length;

    // The owner retries. The service answers with the stored receipt, so the
    // switch is proven.
    state.mode = 'online';
    const accepted = await composition.agentDecision('match-00000001', 'white', 'retry');
    expect(accepted.kind).toBe('accepted');

    // The seat plays the private selection the owner chose, and not the one
    // the public label names: both models carry the same public label.
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBe('c2');
    // The runner of the seat is the one of the new selection.
    expect(composition.agentRunnerState('match-00000001', 'white')).not.toBeNull();

    // The seat is to move, so the runner of the new selection asks the
    // provider, and the request carries the credential of that selection. The
    // runner of the old selection never plays again: only the private
    // binding of the proven control may play the seat.
    await until(() => provider.requests.length > askedBefore, 'the provider is asked again');
    const after = provider.requests.slice(askedBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every(request => request.authorization === 'Bearer key-c2')).toBe(true);
    expect(connections.asked).toContain('c2');

    // The seat keeps playing with the new model: the runner of the new
    // selection is the one that asks the provider and submits the answer.
    expect(composition.agentRunnerState('match-00000001', 'white')?.publicModelLabel).toBe('Custom model');
    composition.dispose();
    provider.restore();
  });

  it('plays the seat with the new private selection after a direct switch and never with the old credential again', async () => {
    const provider = providerFixture();
    const storage = createStorage();
    const first = selectionOf('c1', 'm1');
    const second = selectionOf('c2', 'm2');
    const state = serviceState();
    const connections = connectionStoreOf([{ id: 'c1' }, { id: 'c2' }]);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: agentServiceDouble(state),
      storage,
      accountSession: accountSession(),
      connectionStore: connections.store,
    });
    composition.setAgentCatalog([
      { id: 'private-a', label: 'Custom model', selection: first },
      { id: 'private-b', label: 'Custom model', selection: second },
    ]);
    composition.setAgent({ label: 'Custom model', selection: first });
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-1',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The seat is to move, so the runner of the old selection asks the
    // provider with its own credential.
    await until(() => provider.requests.length > 0, 'the provider is asked');
    expect(provider.requests.every(request => request.authorization === 'Bearer key-c1')).toBe(true);

    // The owner switches the seat to the other private model. The service
    // answers the command, so the switch is proven.
    state.mode = 'online';
    const askedBefore = provider.requests.length;
    const accepted = await composition.agentDecision('match-00000001', 'white', 'switch-model', 'private-b');
    expect(accepted.kind).toBe('accepted');
    await until(
      () => composition.agentRunnerState('match-00000001', 'white')?.boundSeatControlEpoch === state.controlEpoch,
      'the replacement runner binds the proven control epoch',
    );
    expect(composition.agentRunnerState('match-00000001', 'white')?.boundSeatControlEpoch)
      .toBe(state.controlEpoch);
    // The control of the seat changed at the service. From this moment the
    // browser never asks the provider with the credential of the old model
    // again.
    // The seat plays the private selection the owner chose: the runner of the
    // new selection asks the provider with the credential of that selection.
    await until(() => provider.requests.length > askedBefore, 'the provider is asked again');
    const after = provider.requests.slice(askedBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every(request => request.authorization === 'Bearer key-c2')).toBe(true);
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBe('c2');
    expect(connections.asked).toContain('c2');
    composition.dispose();
    provider.restore();
  });

  it('removes the binding of a seat that a recovered takeover gave to the owner', async () => {
    const provider = providerFixture();
    const storage = createStorage();
    const first = selectionOf('c1', 'm1');
    const state = serviceState(false);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: agentServiceDouble(state),
      storage,
      accountSession: accountSession(),
      connectionStore: connectionStoreOf([{ id: 'c1' }]).store,
    });
    composition.setAgentCatalog([{ id: 'private-a', label: 'Custom model', selection: first }]);
    composition.setAgent({ label: 'Custom model', selection: first });
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-1',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The owner takes the seat over. The service applies the command and the
    // browser never learns the receipt.
    const unknown = await composition.agentDecision('match-00000001', 'white', 'takeover');
    expect(unknown.kind).toBe('unknown');
    // The binding of the seat stays: the takeover is not proven.
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBe('c1');

    // The owner retries. The service answers with the stored receipt, so the
    // takeover is proven.
    state.mode = 'online';
    const accepted = await composition.agentDecision('match-00000001', 'white', 'retry');
    expect(accepted.kind).toBe('accepted');
    // The seat belongs to the human owner now: the binding leaves the memory
    // and the device, and the browser keeps no runner for the seat.
    expect(composition.agentBindingFor('match-00000001', 'white')).toBeNull();
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBeNull();
    expect(composition.agentRunnerState('match-00000001', 'white')).toBeNull();
    // The seat is the human's now, so the browser asks the provider for
    // nothing.
    expect(provider.requests).toHaveLength(0);
    composition.dispose();
    provider.restore();
  });

  it('keeps the decision of a newer owner and never applies the older one', async () => {
    const provider = providerFixture();
    const storage = createStorage();
    const first = selectionOf('c1', 'm1');
    const second = selectionOf('c2', 'm2');
    const third = selectionOf('c3', 'm3');
    const state = serviceState();
    const commandGate = createGate();
    const leaseGate = createGate();
    state.commandGate = commandGate.promise;
    state.leaseGate = leaseGate.promise;
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: agentServiceDouble(state),
      storage,
      accountSession: accountSession(),
      connectionStore: connectionStoreOf([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]).store,
    });
    composition.setAgentCatalog([
      { id: 'private-a', label: 'Custom model', selection: first },
      { id: 'private-b', label: 'Custom model', selection: second },
      { id: 'private-c', label: 'Custom model', selection: third },
    ]);
    composition.setAgent({ label: 'Custom model', selection: first });
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-1',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The owner switches the seat to the second private model. The service
    // applies the command and the browser never learns the receipt.
    const unknown = await composition.agentDecision('match-00000001', 'white', 'switch-model', 'private-b');
    expect(unknown.kind).toBe('unknown');
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBe('c1');

    // The owner retries. The receipt of the replay waits for the service.
    state.mode = 'online';
    state.holdCommand = true;
    const retrying = composition.agentDecision('match-00000001', 'white', 'retry');
    await until(() => state.heldCommand, 'the replay waits for the service');
    commandGate.release();

    // The receipt of the replay proves the switch, and the runner of the seat
    // gives its lease back while the owner decides again.
    state.holdLease = true;
    await until(() => state.heldLease, 'the lease of the seat waits for the service');

    // The owner decides again while the older recovery waits: the newer
    // decision is the one the seat waits for.
    const newer = await composition.agentDecision('match-00000001', 'white', 'switch-model', 'private-c');
    expect(newer.kind).toBe('accepted');
    leaseGate.release();
    // The older recovery is ended by the newer decision of the owner.
    expect((await retrying).kind).toBe('unknown');

    // The newer decision is the one the seat plays, and the older decision
    // never reaches the binding of the seat.
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBe('c3');
    expect(provider.requests.map(request => request.authorization)).not.toContain('Bearer key-c2');
    composition.dispose();
    provider.restore();
  });

  it('never applies the decision of an identity that left and came back', async () => {
    const provider = providerFixture();
    const storage = createStorage();
    const first = selectionOf('c1', 'm1');
    const second = selectionOf('c2', 'm2');
    const state = serviceState();
    const commandGate = createGate();
    state.commandGate = commandGate.promise;
    const identity = controllableAccountSession();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: agentServiceDouble(state),
      storage,
      accountSession: identity.session,
      connectionStore: connectionStoreOf([{ id: 'c1' }, { id: 'c2' }]).store,
    });
    composition.setAgentCatalog([
      { id: 'private-a', label: 'Custom model', selection: first },
      { id: 'private-b', label: 'Custom model', selection: second },
    ]);
    composition.setAgent({ label: 'Custom model', selection: first });
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-1',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The owner switches the seat to the other private model. The service
    // applies the command and the browser never learns the receipt.
    const unknown = await composition.agentDecision('match-00000001', 'white', 'switch-model', 'private-b');
    expect(unknown.kind).toBe('unknown');

    // The owner retries. The receipt of the replay waits for the service, and
    // the identity of the browser leaves and comes back in the meantime.
    state.mode = 'online';
    state.holdCommand = true;
    const retrying = composition.agentDecision('match-00000001', 'white', 'retry');
    await until(() => state.heldCommand, 'the replay waits for the service');
    identity.switchTo(null);
    identity.switchTo('account-1');
    commandGate.release();
    await retrying;

    // The decision of the older identity never reaches the binding of the
    // seat, although the identity of the browser is the same one again.
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBe('c1');
    expect(provider.requests.map(request => request.authorization)).not.toContain('Bearer key-c2');
    composition.dispose();
    provider.restore();
  });
});

/** The private selection the device holds for one seat. */
function persistedSelection(storage: Storage, matchId: string, seat: string): string | null {
  for (const [key, value] of storage.data) {
    if (!key.includes('agent')) continue;
    const parsed = JSON.parse(value) as Array<{ matchId: string; seat: string; selection: { connectionId?: string } }>;
    const record = parsed.find(binding => binding.matchId === matchId && binding.seat === seat);
    if (record) return record.selection.connectionId ?? null;
  }
  return null;
}

/** An account session the test can hand over. */
function controllableAccountSession(): {
  readonly session: NonNullable<Parameters<typeof createOnlineComposition>[0]['accountSession']>;
  switchTo(accountId: string | null): void;
} {
  let listener: ((identity: { accountId: string; token: () => Promise<string> } | null) => void) | null = null;
  const session = {
    identity: { accountId: 'account-1', token: async () => 'account-token' },
    subscribe: (next: (identity: { accountId: string; token: () => Promise<string> } | null) => void) => {
      listener = next;
      return () => { listener = null; };
    },
  };
  return {
    session,
    switchTo(accountId) {
      listener?.(accountId === null ? null : { accountId, token: async () => 'account-token' });
    },
  };
}
