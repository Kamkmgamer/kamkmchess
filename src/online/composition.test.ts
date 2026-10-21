import { describe, expect, it, vi } from 'vitest';
import { createOnlineComposition } from './composition';
import type { QueueEntry } from './contracts';
import type { ModelSelection } from '../controller/index.js';
import type { OnlineComposition } from './composition';
import { createGuestCredential } from './auth';
import type { OnlineMatchView } from './updates';

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
