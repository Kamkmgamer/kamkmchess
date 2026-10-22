import { describe, expect, it, vi } from 'vitest';
import { createOnlineComposition, OnlineQueueIdentityChangedError, OnlineQueueLockUnavailableError } from './composition';
import { createFriendSecretStore } from './friend-secrets';
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
  entryRead?: (path: string) => { status: number; data: unknown };
  match?: { status: number; data: unknown };
  fallback?: { status: number; data: unknown };
  matchView?: { status: number; data: unknown };
  updates?: { snapshot: OnlineMatchView };
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
    } else if (path.includes('/queue/entries') && method === 'GET') {
      // The read of an entry never allocates.
      result = answers.entryRead?.(path) ?? { status: 200, data: entryAnswer(null) };
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
    } else if (path.includes('/updates')) {
      // The update route answers with the canonical snapshot of the match.
      const snapshot = answers.updates?.snapshot ?? matchView();
      result = { status: 200, data: { schemaVersion: 1, cursor: snapshot.version, snapshot } };
    } else if (path.includes('/v1/online/matches/')) {
      result = answers.matchView ?? { status: 200, data: matchView() };
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

/**
 * Waits for a condition of the test.
 *
 * The service publishes the canonical state of the match on its poll, so a
 * test waits a little longer than one poll interval for a runner to learn it.
 */
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`The condition (${label}) was not reached.`);
    await new Promise<void>(resolve => { setTimeout(resolve, 5); });
  }
}

/**
 * Stores one intent of an identity, with the entry id of a queue entry.
 *
 * The record is the one the browser writes before it asks the service for
 * the entry, so a reload finds the entry of the owner again.
 */
function storeIntent(storage: Storage, entryId: string, engineMatchId: string | null, identity = 'account%3Aaccount-1'): void {
  storage.setItem(`kamkmchess.online.queue.intent.v1:${identity}`, JSON.stringify([{
    key: 'intent-00000001',
    settings: 'human||300000|2000',
    control: { kind: 'human' },
    timeControl,
    entryId,
    recordId: 'queue-1',
    selection: null,
    engineMatchId,
  }]));
}

/**
 * A queue service that behaves like the service.
 *
 * The client request identifier makes the creation idempotent, so the same
 * key always answers with the same entry. A cancelled entry stays
 * cancelled, so a replay of the key of a cancelled entry answers with the
 * cancelled entry and never with a live one.
 */
function createQueueService(): {
  readonly fetcher: typeof fetch;
  /** The idempotency keys of the created entries, in order. */
  readonly creations: string[];
  /** The entries the service cancelled, in order. */
  readonly cancels: string[];
  /** Every request the service received, in order. */
  readonly requests: string[];
  /** The entries of the service, by their identifier. */
  readonly entries: Map<string, QueueEntry>;
} {
  const entries = new Map<string, QueueEntry>();
  const byRequest = new Map<string, string>();
  const creations: string[] = [];
  const cancels: string[] = [];
  const requests: string[] = [];
  let counter = 0;

  function answer(status: number, data: unknown): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }

  function liveEntry(entryId: string, control: unknown): QueueEntry {
    return {
      schemaVersion: 2,
      entryId,
      owner: { kind: 'account', id: 'account-1' },
      control: (control ?? { kind: 'human' }) as QueueEntry['control'],
      timeControl,
      status: 'waiting',
      version: 1,
      // The window of the entry is far away, so the entry keeps searching
      // while the test runs.
      readyAt: '2099-01-01T00:00:00.000Z',
      cutoffAt: '2099-01-01T00:00:10.000Z',
      assignedMatchId: null,
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
  }

  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.includes('/v1/online/features')) return answer(200, { friends: true, queue: true });
    if (!path.includes('/queue/entries')) return answer(404, { error: 'not_found' });
    requests.push(`${method} ${path}`);
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (method === 'POST' && path.endsWith('/entries')) {
      const key = String(body?.clientRequestId ?? '');
      const known = byRequest.get(key);
      // The creation is idempotent per client request identifier.
      if (known !== undefined) return answer(200, entries.get(known));
      counter += 1;
      const entryId = `entry-000000${counter}`;
      byRequest.set(key, entryId);
      creations.push(key);
      const created = liveEntry(entryId, body?.control);
      entries.set(entryId, created);
      return answer(201, created);
    }
    const segments = path.split('/').filter(Boolean);
    const entryId = decodeURIComponent(segments[segments.length - 2] ?? '');
    const entry = entries.get(entryId);
    if (!entry) return answer(404, { error: 'not_found' });
    if (path.endsWith('/cancel')) {
      const cancelled: QueueEntry = { ...entry, status: 'cancelled' };
      entries.set(entryId, cancelled);
      cancels.push(entryId);
      return answer(200, cancelled);
    }
    return answer(200, entry);
  });

  return { fetcher: fetcher as unknown as typeof fetch, creations, cancels, requests, entries };
}

/** The claims of the shared storage of an identity. */
function claims(storage: Storage): string[] {
  return [...storage.data.keys()].filter(key => key.includes(':claim:'));
}

/** The claim of the shared entry of an identity. */
function claimOf(storage: Storage): { key: string; settings: string } | null {
  for (const [key, value] of storage.data) {
    if (!key.includes(':claim:')) continue;
    return JSON.parse(value) as { key: string; settings: string };
  }
  return null;
}

/** The requests of the fallback route. */
function fallbacks(wires: readonly Wire[]): Wire[] {
  return wires.filter(wire => wire.path.endsWith('/fallback'));
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

  it('keeps the lease of a waiting entry alive while the owner decides (F1)', async () => {
    const clock = manualTimers();
    const { fetcher, wires } = createFetchDouble({
      // The service refuses the engine fallback: its window has not ended.
      fallback: { status: 409, data: { error: 'conflict' } },
    });
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage: createStorage(),
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      timers: clock.timers,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    // The cutoff arrives and the service refuses the fallback.
    clock.fire();
    await settle();
    expect(composition.queueState.phase).toBe('searching');
    // The owner may recover the search while the service decides.
    expect(composition.queueState.options).toContain('retry');
    expect(composition.queueState.options).toContain('keep-searching');
    // The entry keeps its lease: the poll of the service continues.
    const before = wires.filter(wire => wire.path.endsWith('/heartbeat')).length;
    clock.fire();
    await settle();
    const after = wires.filter(wire => wire.path.endsWith('/heartbeat')).length;
    expect(after).toBeGreaterThan(before);
    composition.dispose();
  });

  it('keeps the lease of a waiting entry alive while the engine is unavailable (F1)', async () => {
    const clock = manualTimers();
    const { fetcher, wires } = createFetchDouble({});
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage: createStorage(),
      accountSession: accountSession(),
      // The engine does not start. The search continues without it.
      prepareEngine: async () => { throw new Error('The engine download failed.'); },
      timers: clock.timers,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    // The cutoff arrives without a usable engine.
    clock.fire();
    await settle();
    expect(composition.queueState.phase).toBe('engine-unavailable');
    // The owner may recover the search.
    expect(composition.queueState.options).toContain('retry');
    expect(composition.queueState.options).toContain('keep-searching');
    // The entry keeps its lease: the poll of the service continues, so the
    // readiness lease of the service does not die while the owner decides.
    const before = wires.filter(wire => wire.path.endsWith('/heartbeat')).length;
    clock.fire();
    await settle();
    const after = wires.filter(wire => wire.path.endsWith('/heartbeat')).length;
    expect(after).toBeGreaterThan(before);
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

describe('the owner shares one entry (QUE-03, QUE-04, QUE-08)', () => {
  /** The entries the service created. */
  function creations(wires: readonly Wire[]): Wire[] {
    return wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST');
  }

  /** The idempotency keys of the created entries. */
  function keys(wires: readonly Wire[]): string[] {
    return creations(wires).map(wire => String(wire.body?.clientRequestId));
  }

  /**
   * The lock of the browser, shared by two tabs of one browser.
   *
   * The lock of the origin belongs to every tab of the browser. The double
   * holds one claim at a time, exactly like it.
   */
  function createBrowserLock(): { lock: <T>(name: string, run: () => Promise<T>) => Promise<T> } {
    const chains = new Map<string, Promise<unknown>>();
    return {
      lock<T>(name: string, run: () => Promise<T>): Promise<T> {
        const chain = chains.get(name) ?? Promise.resolve();
        const result = chain.then(() => run());
        chains.set(name, result.then(() => undefined, () => undefined));
        return result;
      },
    };
  }

  it('joins the entry it already waits with', async () => {
    // The default enter reaches the entry of the owner. A second click never
    // creates a second entry, a second record or a second key.
    const { composition, wires } = createComposition();
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    expect(creations(wires)).toHaveLength(1);
    expect(keys(wires)).toHaveLength(1);
    expect(composition.queueEntries).toHaveLength(1);
    expect(composition.queueEntries[0]?.state.phase).toBe('searching');
    composition.dispose();
  });

  it('never creates a second entry for two simultaneous calls', async () => {
    const { composition, wires } = createComposition();
    await Promise.all([
      composition.enterQueue({ control: { kind: 'human' }, timeControl }),
      composition.enterQueue({ control: { kind: 'human' }, timeControl }),
    ]);
    expect(creations(wires)).toHaveLength(1);
    expect(composition.queueEntries).toHaveLength(1);
    composition.dispose();
  });

  it('creates a parallel entry for an explicit new intent', async () => {
    // The explicit second game owns its own entry, its own key and its own
    // timer. The entry of the owner keeps waiting.
    const clock = manualTimers();
    const { composition, wires } = createComposition({ timers: clock.timers });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl }, { intent: 'new' });
    expect(creations(wires)).toHaveLength(2);
    expect(new Set(keys(wires)).size).toBe(2);
    expect(composition.queueEntries).toHaveLength(2);
    // Both entries keep a poll timer of their own.
    expect(clock.pending).toBeGreaterThanOrEqual(2);
    composition.dispose();
  });

  it('reaches the entry of the owner in another tab of the same browser', async () => {
    // A second tab of the same browser reaches the entry of the owner. It
    // creates no second entry and no second key.
    const storage = createStorage();
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: { ...entryAnswer(null), entryId: 'entry-0000001' } }),
    });
    const first = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    await first.enterQueue({ control: { kind: 'human' }, timeControl });
    const second = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    await second.enterQueue({ control: { kind: 'human' }, timeControl });
    // The second tab shows the entry of the first one.
    expect(creations(wires)).toHaveLength(1);
    expect(second.queueEntries).toHaveLength(1);
    expect(second.queueEntries[0]?.entryId).toBe('entry-0000001');
    expect(second.queueEntries[0]?.state.phase).toBe('searching');
    first.dispose();
    second.dispose();
  });

  it('claims one key when two tabs enter at the same moment', async () => {
    // Two fresh tabs of the same browser enter the queue at the same moment.
    // The claim of the shared entry is taken under the lock of the browser,
    // so both tabs reach one entry with one key.
    const storage = createStorage();
    const browser = createBrowserLock();
    const { fetcher, wires } = createFetchDouble({
      entry: (body) => ({ status: 201, data: { ...entryAnswer(body), entryId: 'entry-0000001' } }),
      entryRead: () => ({ status: 200, data: { ...entryAnswer(null), entryId: 'entry-0000001' } }),
    });
    const options = {
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      queueLock: browser.lock,
    };
    const first = createOnlineComposition(options);
    const second = createOnlineComposition(options);
    await Promise.all([
      first.enterQueue({ control: { kind: 'human' }, timeControl }),
      second.enterQueue({ control: { kind: 'human' }, timeControl }),
    ]);
    // The two tabs share one key, so the service answers with one entry.
    expect(new Set(keys(wires)).size).toBe(1);
    expect(first.queueEntries[0]?.entryId).toBe('entry-0000001');
    expect(second.queueEntries[0]?.entryId).toBe('entry-0000001');
    first.dispose();
    second.dispose();
  });

  it('keeps the entry of the owner when the service does not answer', async () => {
    // The read of the entry fails without an answer. The entry may exist, so
    // the intent of the owner is preserved and its key is reused: the tab
    // never creates a second entry.
    const storage = createStorage();
    const { fetcher, wires } = createFetchDouble({
      entry: (body) => ({ status: 201, data: { ...entryAnswer(body), entryId: 'entry-0000001' } }),
    });
    const holding: typeof fetch = async (input, init) => {
      const path = String(input);
      if (path.includes('/queue/entries/entry-0000001') && (init?.method ?? 'GET') === 'GET') {
        throw new Error('The connection was lost.');
      }
      return fetcher(input, init);
    };
    const first = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: holding as typeof fetch,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    await first.enterQueue({ control: { kind: 'human' }, timeControl });
    const second = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: holding as typeof fetch,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    await second.enterQueue({ control: { kind: 'human' }, timeControl });
    // The second tab reaches the same key, so the service answers with the
    // entry of the owner.
    expect(new Set(keys(wires)).size).toBe(1);
    expect(second.queueEntries[0]?.entryId).toBe('entry-0000001');
    first.dispose();
    second.dispose();
  });

  it('replaces the current entry when the selection changes, and keeps the other one', async () => {
    // A deliberate selection change cancels the shared entry of the owner and
    // rejoins with a fresh window. The explicit second game of the owner keeps
    // waiting: the default enter never takes it away.
    let created = 0;
    const { fetcher, wires } = createFetchDouble({
      entry: (body) => ({ status: 201, data: { ...entryAnswer(body), entryId: `entry-000000${++created}` } }),
      entryRead: (path) => ({ status: 200, data: { ...entryAnswer(null), entryId: path.split('/').pop() ?? 'entry-0000000' } }),
    });
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage: createStorage(),
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl }, { intent: 'new' });
    // The owner changes the clock of the shared entry.
    await composition.enterQueue({
      control: { kind: 'human' },
      timeControl: { startingTimeMs: 180_000, incrementMs: 2_000 },
    });
    const creates = creations(wires);
    expect(creates).toHaveLength(3);
    expect(new Set(keys(wires)).size).toBe(3);
    // The shared entry is cancelled, and the explicit one is untouched.
    const cancels = wires.filter(wire => wire.path.endsWith('/cancel'));
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.path).toContain('entry-0000001');
    // The explicit second game of the owner keeps waiting.
    const searching = composition.queueEntries.filter(entry => entry.state.phase === 'searching');
    expect(searching.length).toBeGreaterThanOrEqual(2);
    expect(searching.some(entry => entry.entryId === 'entry-0000002')).toBe(true);
    composition.dispose();
  });

  it('never abandons the entry of the owner when the readiness fails', async () => {
    // A failed readiness blocks the entry. The entry of the owner keeps
    // waiting, and the owner may play the seat themselves.
    const { fetcher, wires } = createFetchDouble({
      entry: (body) => ({ status: 201, data: { ...entryAnswer(body), entryId: 'entry-0000001' } }),
      entryRead: () => ({ status: 200, data: { ...entryAnswer(null), entryId: 'entry-0000001' } }),
    });
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage: createStorage(),
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      checkModel: async () => ({ ready: false, detail: 'The model is not connected.' }),
    });
    composition.setAgent({
      label: 'GPT-4o',
      selection: { connectionId: 'c1', modelRoutingId: 'm1', protocol: 'chat-completions', configurationRevision: 'r1', diagnostic: 'passed-current-session' } as unknown as ModelSelection,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    // The owner changes the selection to the agent, and the readiness fails.
    await composition.enterQueue({ control: { kind: 'agent', modelLabel: 'GPT-4o' }, timeControl });
    // The entry of the owner is not cancelled, and no new entry is created.
    expect(wires.filter(wire => wire.path.endsWith('/cancel'))).toHaveLength(0);
    expect(creations(wires)).toHaveLength(1);
    expect(composition.queueEntries[0]?.state.phase).toBe('searching');
    composition.dispose();
  });

  it('discards the enter of an identity that signed in again', async () => {
    // The identity leaves and comes back while the entry is read. The enter
    // of the older generation never reaches the current identity, so it
    // creates no entry.
    const listeners = new Set<(identity: { accountId: string; token: () => Promise<string> } | null) => void>();
    let identity: { accountId: string; token: () => Promise<string> } | null = { accountId: 'account-1', token: async () => 'token' };
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: { ...entryAnswer(null), status: 'assigned', assignedMatchId: 'match-00000031' } }),
    });
    const holding: typeof fetch = async (input, init) => {
      const path = String(input);
      if (path.includes('/queue/entries/entry-0000001')) await gate;
      return fetcher(input, init);
    };
    const storage = createStorage();
    storeIntent(storage, 'entry-0000001', null);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: holding as typeof fetch,
      storage,
      accountSession: {
        get identity() { return identity; },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      },
      prepareEngine: async () => undefined,
    });
    const entering = composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await settle();
    // The identity leaves and comes back while the entry is read.
    identity = { accountId: 'account-2', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    identity = { accountId: 'account-1', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    release?.();
    await entering;
    await settle();
    // The enter of the older generation created no entry.
    expect(creations(wires)).toHaveLength(0);
    composition.dispose();
  });
});

/**
 * The shared entry never outlives its claim (QUE-03, QUE-04, QUE-08).
 *
 * The claim of the shared entry names the key of the entry the owner waits
 * with. A terminal entry - a cancelled, an expired or a completed one - must
 * never leave that claim behind: the claim would pin the next enter of the
 * owner to the terminal key, and the service would answer with the entry that
 * is over.
 */
describe('the claim of the shared entry never outlives its entry', () => {
  it('reaches a fresh entry when the owner enters the queue again after a cancel', async () => {
    // The owner cancels the entry and plays again. The cancelled key never
    // reaches the service again, and the claim of the cancelled entry does
    // not pin the next entry of the owner.
    const service = createQueueService();
    const storage = createStorage();
    const clock = manualTimers();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      timers: clock.timers,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    expect(service.creations).toHaveLength(1);
    const cancelledKey = service.creations[0]!;
    await composition.queue.cancel();
    await settle();
    // The claim of the cancelled entry is gone.
    expect(claims(storage)).toHaveLength(0);
    // The owner plays again.
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await settle();
    // A fresh key reaches the service, and the entry of the owner waits.
    expect(service.creations).toHaveLength(2);
    expect(service.creations[1]).not.toBe(cancelledKey);
    expect(service.entries.get('entry-0000002')?.status).toBe('waiting');
    const searching = composition.queueEntries.filter(entry => entry.state.phase === 'searching');
    expect(searching).toHaveLength(1);
    expect(searching[0]?.entryId).toBe('entry-0000002');
    composition.dispose();
  });

  it('never reuses the cancelled key when the owner returns to the first settings', async () => {
    // The owner watches the agent, plays the seat themselves and watches the
    // agent again. Every entry of the owner has its own key, and the key of
    // the cancelled agent entry never reaches the service again.
    const service = createQueueService();
    const storage = createStorage();
    const clock = manualTimers();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      timers: clock.timers,
      checkModel: async () => ({ ready: true, detail: '' }),
    });
    composition.setAgent({
      label: 'GPT-4o',
      selection: { connectionId: 'c1', modelRoutingId: 'm1', protocol: 'chat-completions', configurationRevision: 'r1', diagnostic: 'passed-current-session' } as unknown as ModelSelection,
    });
    await composition.enterQueue({ control: { kind: 'agent', modelLabel: 'GPT-4o' }, timeControl });
    expect(service.creations).toHaveLength(1);
    const agentKey = service.creations[0]!;
    // The owner plays the seat themselves. The agent entry is replaced.
    await composition.queue.playYourself();
    await settle();
    expect(service.creations).toHaveLength(2);
    expect(service.creations[1]).not.toBe(agentKey);
    // The claim of the shared entry follows the record: it names the key of
    // the entry the owner waits with now, and never the key of the cancelled
    // agent entry.
    expect(claimOf(storage)?.key).toBe(service.creations[1]);
    // The owner watches the agent again.
    await composition.enterQueue({ control: { kind: 'agent', modelLabel: 'GPT-4o' }, timeControl });
    await settle();
    // Every entry of the owner has its own key, and the last one waits.
    expect(service.creations).toHaveLength(3);
    expect(new Set(service.creations).size).toBe(3);
    expect(service.creations[2]).not.toBe(agentKey);
    const searching = composition.queueEntries.filter(entry => entry.state.phase === 'searching');
    expect(searching.length).toBeGreaterThanOrEqual(1);
    expect(searching[searching.length - 1]?.entryId).toBe('entry-0000003');
    composition.dispose();
  });

  it('never lets an explicit second game take the claim of the shared entry', async () => {
    // The explicit second game owns its own entry and its own key. The claim
    // of the shared entry stays with the entry the owner waits with, so the
    // default enter of another tab reaches that entry and not the explicit
    // one.
    const service = createQueueService();
    const storage = createStorage();
    const clock = manualTimers();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      timers: clock.timers,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    const sharedKey = service.creations[0]!;
    await composition.enterQueue({ control: { kind: 'human' }, timeControl }, { intent: 'new' });
    expect(service.creations).toHaveLength(2);
    // The claim still names the shared entry.
    expect(claimOf(storage)?.key).toBe(sharedKey);
    composition.dispose();
  });

  it('reaches the same entry when the service does not answer the read', async () => {
    // The read of the entry fails without an answer. The entry may exist, so
    // the key of the owner is reused: the service answers with the same entry
    // and the second tab never creates a second one.
    const service = createQueueService();
    const storage = createStorage();
    const holding: typeof fetch = async (input, init) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && path.includes('/queue/entries/')) {
        throw new Error('The connection was lost.');
      }
      return service.fetcher(input, init);
    };
    const options = {
      baseUrl: 'https://api.example.test',
      fetch: holding as typeof fetch,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    };
    const first = createOnlineComposition(options);
    await first.enterQueue({ control: { kind: 'human' }, timeControl });
    const second = createOnlineComposition(options);
    await second.enterQueue({ control: { kind: 'human' }, timeControl });
    // One key and one entry: the second tab reached the entry of the owner.
    expect(service.creations).toHaveLength(1);
    expect(second.queueEntries[0]?.entryId).toBe('entry-0000001');
    first.dispose();
    second.dispose();
  });

  it('fails closed when the browser cannot lock the tabs of the origin', async () => {
    // A browser without the lock of the origin cannot serialize its tabs. The
    // claim of the shared entry is a read-modify-write of the storage, so two
    // tabs would interleave it and mint two keys. The queue refuses the enter
    // with an actionable error instead of racing the other tab.
    vi.stubGlobal('window', { location: { search: '', pathname: '/' } });
    vi.stubGlobal('navigator', { userAgent: 'test' });
    try {
      const service = createQueueService();
      const storage = createStorage();
      const options = {
        baseUrl: 'https://api.example.test',
        fetch: service.fetcher,
        storage,
        accountSession: accountSession(),
        prepareEngine: async () => undefined,
      };
      const first = createOnlineComposition(options);
      const second = createOnlineComposition(options);
      await expect(first.enterQueue({ control: { kind: 'human' }, timeControl }))
        .rejects.toThrow(OnlineQueueLockUnavailableError);
      await expect(second.enterQueue({ control: { kind: 'human' }, timeControl }))
        .rejects.toThrow(OnlineQueueLockUnavailableError);
      // No entry was created, and no claim was taken.
      expect(service.creations).toHaveLength(0);
      expect(claims(storage)).toHaveLength(0);
      first.dispose();
      second.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tells the owner what the browser cannot do', async () => {
    // The refusal names the way out, so the owner can act on it.
    vi.stubGlobal('window', { location: { search: '', pathname: '/' } });
    vi.stubGlobal('navigator', { userAgent: 'test' });
    try {
      const service = createQueueService();
      const composition = createOnlineComposition({
        baseUrl: 'https://api.example.test',
        fetch: service.fetcher,
        storage: createStorage(),
        accountSession: accountSession(),
        prepareEngine: async () => undefined,
      });
      const failure = await composition.enterQueue({ control: { kind: 'human' }, timeControl })
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(OnlineQueueLockUnavailableError);
      expect((failure as Error).message).toMatch(/browser/i);
      composition.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * The queue entry of the owner is created once (QUE-01, QUE-03, QUE-04,
 * QUE-06, QUE-08, QUE-13).
 *
 * The entry of the owner is one request for one game. A tab that closes
 * before the service reports the end of its entry, a readiness that fails, a
 * settings change next to an explicit second game, an identity that leaves
 * while the entry is prepared and a browser that cannot lock its tabs all
 * leave the owner with exactly the entries they asked for - never with a
 * second game and never with an entry the service never heard of.
 */
describe('the queue entry of the owner is created once', () => {
  it('creates a fresh entry when the entry of the owner is already over', async () => {
    // The tab of the owner closes before the service reports the end of its
    // entry. The intent and the claim of the closed tab are still on the
    // device, and they name an entry that is over. The read of the service
    // wins over them: the next tab reaches a fresh entry and never the
    // terminal one.
    const service = createQueueService();
    const storage = createStorage();
    const options = {
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    };
    const first = createOnlineComposition(options);
    await first.enterQueue({ control: { kind: 'human' }, timeControl });
    expect(service.creations).toHaveLength(1);
    const firstKey = service.creations[0]!;
    // The tab closes before it sees the terminal state of its entry.
    first.dispose();
    const entry = service.entries.get('entry-0000001')!;
    service.entries.set('entry-0000001', { ...entry, status: 'cancelled' });
    // A new tab of the same browser enters the queue again.
    const second = createOnlineComposition(options);
    await second.enterQueue({ control: { kind: 'human' }, timeControl });
    await settle();
    // The terminal key never reaches the service again.
    expect(service.creations).toHaveLength(2);
    expect(service.creations[1]).not.toBe(firstKey);
    // The new entry of the owner waits, and it has its own actions.
    const searching = second.queueEntries.filter(entry => entry.state.phase === 'searching');
    expect(searching).toHaveLength(1);
    expect(searching[0]?.entryId).toBe('entry-0000002');
    second.dispose();
  });

  it('never creates an entry for an agent whose readiness failed', async () => {
    // The readiness of the agent fails, so the request never leaves the
    // browser. The owner plays the seat themselves, and the rejected agent
    // entry is never created: a failed readiness leaves no queue entry
    // behind, and no entry that could be matched behind the owner's back.
    const service = createQueueService();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage: createStorage(),
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      checkModel: async () => ({ ready: false, detail: 'The model is not connected.' }),
    });
    composition.setAgent({
      label: 'GPT-4o',
      selection: { connectionId: 'c1', modelRoutingId: 'm1', protocol: 'chat-completions', configurationRevision: 'r1', diagnostic: 'passed-current-session' } as unknown as ModelSelection,
    });
    await composition.enterQueue({ control: { kind: 'agent', modelLabel: 'GPT-4o' }, timeControl });
    // The readiness failed: the service never heard of an entry.
    expect(composition.queueEntries[0]?.state.phase).toBe('agent-failed');
    expect(service.creations).toHaveLength(0);
    // The owner plays the seat themselves.
    await composition.queue.playYourself();
    await settle();
    // Only the human seat of the owner exists.
    expect(service.creations).toHaveLength(1);
    expect([...service.entries.values()].map(entry => entry.control)).toEqual([{ kind: 'human' }]);
    // The rejected agent entry was never created, so it was never cancelled.
    expect(service.cancels).toHaveLength(0);
    composition.dispose();
  });

  it('replaces the shared entry and keeps the explicit one when the settings change', async () => {
    // The owner waits with a shared entry and asked for an explicit second
    // game. The settings of the shared entry change: the shared entry is
    // replaced and the explicit game of the owner keeps waiting. The default
    // enter never takes the explicit entry away.
    const service = createQueueService();
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    const sharedKey = service.creations[0]!;
    await composition.enterQueue({ control: { kind: 'human' }, timeControl }, { intent: 'new' });
    const explicitKey = service.creations[1]!;
    expect(explicitKey).not.toBe(sharedKey);
    // The claim of the shared entry still names the shared entry.
    expect(claimOf(storage)?.key).toBe(sharedKey);
    // The owner changes the clock of the shared entry.
    await composition.enterQueue({
      control: { kind: 'human' },
      timeControl: { startingTimeMs: 180_000, incrementMs: 2_000 },
    });
    await settle();
    // A fresh key reached the service, and the shared entry was cancelled.
    expect(service.creations).toHaveLength(3);
    expect(service.cancels).toEqual(['entry-0000001']);
    // The explicit game of the owner keeps waiting.
    expect(service.entries.get('entry-0000002')?.status).toBe('waiting');
    const searching = composition.queueEntries.filter(entry => entry.state.phase === 'searching');
    expect(searching.some(entry => entry.entryId === 'entry-0000002')).toBe(true);
    composition.dispose();
  });

  it('never creates an entry under an identity that is no longer current', async () => {
    // The identity leaves while the entry of the owner is prepared. The work
    // of the older generation never reaches the service, so no entry is
    // created under the credential of the identity that came back.
    const listeners = new Set<(identity: { accountId: string; token: () => Promise<string> } | null) => void>();
    let identity: { accountId: string; token: () => Promise<string> } | null = { accountId: 'account-1', token: async () => 'token-1' };
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let claims = 0;
    // The lock of the browser holds the write of the intent, so the identity
    // can change while the entry is prepared.
    const queueLock = async <T>(_name: string, run: () => Promise<T>): Promise<T> => {
      claims += 1;
      if (claims === 2) await gate;
      return run();
    };
    const service = createQueueService();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage: createStorage(),
      accountSession: {
        get identity() { return identity; },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      },
      prepareEngine: async () => undefined,
      queueLock,
    });
    const entering = composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await settle();
    // The identity leaves while the entry is prepared.
    identity = { accountId: 'account-2', token: async () => 'token-2' };
    for (const listener of listeners) listener(identity);
    release?.();
    await entering;
    await settle();
    // The stale generation created no entry.
    expect(service.creations).toHaveLength(0);
    expect(service.requests.filter(request => request.startsWith('POST'))).toHaveLength(0);
    composition.dispose();
  });

  it('leaves no record and sends no request when the browser cannot lock its tabs', async () => {
    // A browser without the lock of the origin cannot share one entry between
    // its tabs. The enter fails closed, and it leaves no idle record behind:
    // the owner never sees an entry that the service does not know.
    vi.stubGlobal('window', { location: { search: '', pathname: '/' } });
    vi.stubGlobal('navigator', { userAgent: 'test' });
    try {
      const service = createQueueService();
      const composition = createOnlineComposition({
        baseUrl: 'https://api.example.test',
        fetch: service.fetcher,
        storage: createStorage(),
        accountSession: accountSession(),
        prepareEngine: async () => undefined,
      });
      await expect(composition.enterQueue({ control: { kind: 'human' }, timeControl }))
        .rejects.toThrow(OnlineQueueLockUnavailableError);
      // No record of an entry that does not exist, and no request at all.
      expect(composition.queueEntries).toHaveLength(0);
      expect(service.creations).toHaveLength(0);
      expect(service.requests).toHaveLength(0);
      composition.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the engine seat of a match plays one turn at a time', () => {
  it('never plays the current turn twice when a replaced seat answers late', async () => {
    // A seat that is replaced - a new credential, a new identity - is disposed
    // while it searches. Its answer arrives late, and it must never clear the
    // record of the turn that runs now: the current turn is never played
    // twice.
    const plays: { resolve: (result: { kind: 'stopped' } | { kind: 'moved'; move: string }) => void }[] = [];
    const { fetcher } = createFetchDouble({
      updates: {
        snapshot: matchView({
          clock: { ...matchView().clock, activeSeat: 'black', activeSince: '2026-10-21T10:00:00.000Z' },
        }),
      },
    });
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage: createStorage(),
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      createEngineSeat: () => ({
        seat: 'black',
        stopped: false,
        play: () => new Promise(resolve => { plays.push({ resolve }); }),
        dispose: async () => undefined,
      }),
    });
    // The engine seat of the fallback game holds a credential.
    composition.registerGuestCredential(createGuestCredential({
      guestId: 'guest-engine',
      matchId: 'match-00000001',
      seat: 'black',
      token: 'engine-token',
    }), 'account');
    composition.attachAndFocus('match-00000001', 'white');
    // The engine seat of the fallback game plays its turn.
    await vi.waitFor(() => { expect(plays.length).toBe(1); });
    // The credential of the seat is replaced, so the seat is disposed and a
    // new seat plays the turn.
    composition.registerGuestCredential(createGuestCredential({
      guestId: 'guest-engine',
      matchId: 'match-00000001',
      seat: 'black',
      token: 'engine-token-2',
    }), 'account');
    await vi.waitFor(() => { expect(plays.length).toBe(2); });
    // The disposed seat answers late. The record of the current turn survives,
    // so the turn is not played a second time.
    plays[0]?.resolve({ kind: 'stopped' });
    await settle();
    // The workspace changes again, so the engine seats are driven again with
    // the same version of the match.
    composition.attachAndFocus('match-00000001', 'white');
    await settle();
    await new Promise(resolve => { setTimeout(resolve, 500); });
    expect(plays.length).toBe(2);
    composition.dispose();
  });
});

describe('the engine credential recovery only touches a committed engine game (R6-01)', () => {
  it('never asks the service to commit the engine of a waiting entry', async () => {
    // The fallback route of the service is the authoritative allocation of
    // the browser engine. A waiting entry must never reach it before its
    // cutoff, or the engine would be committed before the deadline of the
    // search. The cutoff of the entry has not arrived here.
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({
        status: 200,
        data: { ...entryAnswer(null), status: 'waiting', cutoffAt: new Date(Date.now() + 60_000).toISOString() },
      }),
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_waiting0001', null);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    await settle();
    await settle();
    // The state of the entry was read, and the fallback route was never
    // asked.
    expect(wires.some(wire => wire.path.includes('/queue/entries/qe_waiting0001') && wire.method === 'GET')).toBe(true);
    expect(fallbacks(wires)).toHaveLength(0);
    composition.dispose();
  });

  it('never asks the service to commit the engine of a cancelled entry', async () => {
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: { ...entryAnswer(null), status: 'cancelled' } }),
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_cancelled01', null);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    await settle();
    await settle();
    expect(fallbacks(wires)).toHaveLength(0);
    composition.dispose();
  });

  it('rotates the credential of a committed engine game exactly once', async () => {
    // The entry already produced its game with the browser engine, so the
    // service rotates the credential of the engine seat. A reload and an
    // identity change in the same moment never rotate it twice.
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: { ...entryAnswer(null), status: 'assigned', assignedMatchId: 'match-00000001' } }),
      matchView: { status: 200, data: matchView() },
      fallback: {
        status: 200,
        data: {
          ...fallbackAnswer(),
          guestCredential: { guestId: 'guest-engine', matchId: 'match-00000001', seat: 'black', token: 'engine-token' },
        },
      },
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_assigned01', 'match-00000001');
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    composition.resumeMatches();
    await settle();
    await settle();
    expect(fallbacks(wires)).toHaveLength(1);
    composition.dispose();
  });

  it('never rotates an engine credential for a game with a human opponent', async () => {
    // The game of the entry has no engine seat, so the service must not be
    // asked for an engine credential.
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: { ...entryAnswer(null), status: 'assigned', assignedMatchId: 'match-00000001' } }),
      matchView: {
        status: 200,
        data: matchView({
          seats: [
            { seat: 'white', publicLabel: 'Owner', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
            { seat: 'black', publicLabel: 'Guest', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
          ],
        }),
      },
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_assigned02', null);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    await settle();
    await settle();
    expect(fallbacks(wires)).toHaveLength(0);
    composition.dispose();
  });

  it('ignores the answer of a recovery that belongs to an older identity', async () => {
    // The identity changed while the service was asked. The answer of the
    // older identity never reaches the current one.
    const listeners = new Set<(identity: { accountId: string; token: () => Promise<string> } | null) => void>();
    let identity: { accountId: string; token: () => Promise<string> } | null = { accountId: 'account-1', token: async () => 'token' };
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: { ...entryAnswer(null), status: 'assigned', assignedMatchId: 'match-00000001' } }),
      matchView: { status: 200, data: matchView() },
      fallback: {
        status: 200,
        data: {
          ...fallbackAnswer(),
          guestCredential: { guestId: 'guest-engine', matchId: 'match-00000001', seat: 'black', token: 'engine-token' },
        },
      },
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_assigned03', 'match-00000001');
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
    composition.resumeMatches();
    await settle();
    // The identity changed while the recovery was running.
    identity = { accountId: 'account-2', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    await settle();
    await settle();
    // The answer of the older identity was ignored: the seat of the new
    // identity owns no engine credential.
    expect(fallbacks(wires)).toHaveLength(1);
    composition.dispose();
  });
});

describe('the waiting entry of a reload is resumed with its original cutoff (R6-01)', () => {
  /** The answer of a waiting entry with a ready time and a cutoff. */
  function waitingEntry(entryId: string, cutoffAt = new Date(Date.now() + 60_000).toISOString()): Record<string, unknown> {
    return {
      ...entryAnswer(null),
      entryId,
      status: 'waiting',
      readyAt: '2026-10-21T10:00:00.000Z',
      cutoffAt,
      assignedMatchId: null,
    };
  }

  it('shows the same entry again, with the cutoff the service gave it', async () => {
    // A reload must not lose the entry of the owner, and it must not create
    // a second one: the entry of the service is the canonical one.
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: waitingEntry('qe_waiting0002') }),
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_waiting0002', null);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    await settle();
    await settle();
    // The entry is shown again, with the original cutoff.
    expect(composition.queueEntries).toHaveLength(1);
    expect(composition.queueEntries[0]?.entryId).toBe('qe_waiting0002');
    expect(composition.queueEntries[0]?.state.phase).toBe('searching');
    expect(composition.queueEntries[0]?.state.cutoffAt).toBe(composition.queueEntries[0]?.state.entry?.cutoffAt);
    // No entry was created, and the service was never asked to commit the
    // engine of the waiting entry.
    expect(wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST')).toHaveLength(0);
    expect(wires.filter(wire => wire.path.endsWith('/fallback'))).toHaveLength(0);
    composition.dispose();
  });

  it('commits the engine of a resumed entry exactly at its original cutoff', async () => {
    // The resumed entry keeps the cutoff the service gave it. The engine
    // prepares during the search, exactly as it does for an entry this
    // browser created, so the cutoff can commit it - and the commit happens
    // at the cutoff, never before it.
    const clock = manualTimers();
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: waitingEntry('qe_waiting0005') }),
      fallback: {
        status: 200,
        data: {
          ...fallbackAnswer(),
          guestCredential: { guestId: 'guest-engine', matchId: 'match-00000001', seat: 'black', token: 'engine-token' },
        },
      },
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_waiting0005', null);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      timers: clock.timers,
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    await settle();
    await settle();
    // The cutoff has not arrived: the engine was not committed.
    expect(fallbacks(wires)).toHaveLength(0);
    // The cutoff of the entry arrives.
    clock.fire();
    await settle();
    await settle();
    await settle();
    expect(fallbacks(wires)).toHaveLength(1);
    // The entry of the service was never replaced.
    expect(wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST')).toHaveLength(0);
    composition.dispose();
  });

  it('lets the owner act on a resumed entry without replacing it', async () => {
    // The explicit action of the owner reuses the entry of the service: the
    // same intent carries the same idempotency key, so the service answers
    // with the same entry.
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: waitingEntry('qe_waiting0006') }),
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_waiting0006', null);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    await settle();
    await settle();
    expect(composition.queueEntries).toHaveLength(1);
    // The owner plays the seat themselves. The entry of the service is the
    // same one, so the idempotency key is the same too.
    await composition.queue.playYourself();
    await settle();
    const creations = wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST');
    expect(creations).toHaveLength(1);
    expect(creations[0]?.body?.clientRequestId).toBe('intent-00000001');
    composition.dispose();
  });

  it('never resumes the entry of an identity that is not the current one', async () => {
    // The intents are namespaced by the identity, so the entry of another
    // identity never reaches the screen of this one.
    const { fetcher } = createFetchDouble({
      entryRead: () => ({ status: 200, data: waitingEntry('qe_other00001') }),
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_other00001', null, 'account%3Aaccount-2');
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    await settle();
    await settle();
    expect(composition.queueEntries).toHaveLength(0);
    composition.dispose();
  });

  it('resumes the entry of the identity that comes back, without showing it twice', async () => {
    // The identity change fences the state of the previous identity. The
    // entry of the identity that returns is resumed in its own record, so
    // the screen never shows the same entry twice.
    const listeners = new Set<(identity: { accountId: string; token: () => Promise<string> } | null) => void>();
    let identity: { accountId: string; token: () => Promise<string> } | null = { accountId: 'account-1', token: async () => 'token' };
    const { fetcher } = createFetchDouble({
      entryRead: () => ({ status: 200, data: waitingEntry('qe_waiting0003') }),
    });
    const storage = createStorage();
    storeIntent(storage, 'qe_waiting0003', null);
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
    composition.resumeMatches();
    await settle();
    await settle();
    expect(composition.queueEntries).toHaveLength(1);
    expect(composition.queueEntries[0]?.state.phase).toBe('searching');
    // Another identity signs in. The entry of the previous identity leaves
    // the screen.
    identity = { accountId: 'account-2', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    await settle();
    await settle();
    expect(composition.queueEntries.filter(entry => entry.state.phase === 'searching')).toHaveLength(0);
    // The first identity comes back. Its entry is resumed in its own record.
    identity = { accountId: 'account-1', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    await settle();
    await settle();
    expect(composition.queueEntries.filter(entry => entry.state.phase === 'searching')).toHaveLength(1);
    expect(composition.queueEntries).toHaveLength(1);
    composition.dispose();
  });

  it('ignores the answer of a restore that belongs to an older identity', async () => {    // The identity changed while the service was asked for the entry. The
    // answer of the older identity never reaches the current one.
    const listeners = new Set<(identity: { accountId: string; token: () => Promise<string> } | null) => void>();
    let identity: { accountId: string; token: () => Promise<string> } | null = { accountId: 'account-1', token: async () => 'token' };
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: waitingEntry('qe_waiting0004') }),
    });
    const holding: typeof fetch = async (input, init) => {
      const path = String(input);
      if (path.includes('/queue/entries/qe_waiting0004')) {
        await gate;
      }
      return fetcher(input, init);
    };
    const storage = createStorage();
    storeIntent(storage, 'qe_waiting0004', null);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: holding as typeof fetch,
      storage,
      accountSession: {
        get identity() { return identity; },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      },
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    await settle();
    // The identity changed while the entry was read.
    identity = { accountId: 'account-2', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    release?.();
    await settle();
    await settle();
    // The entry of the older identity never reaches the screen.
    expect(composition.queueEntries).toHaveLength(0);
    expect(wires.filter(wire => wire.path.endsWith('/fallback'))).toHaveLength(0);
    composition.dispose();
  });

  it('resumes the entry of the identity that comes back while a read is held', async () => {
    // The read of the entry is held while the identity leaves and comes back.
    // The claim of the older identity never blocks the claim of the identity
    // that returned, so the entry is resumed again.
    const listeners = new Set<(identity: { accountId: string; token: () => Promise<string> } | null) => void>();
    let identity: { accountId: string; token: () => Promise<string> } | null = { accountId: 'account-1', token: async () => 'token' };
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const { fetcher, wires } = createFetchDouble({
      entryRead: () => ({ status: 200, data: waitingEntry('qe_waiting0008') }),
    });
    const holding: typeof fetch = async (input, init) => {
      const path = String(input);
      // Only the first read of the entry is held.
      if (!held && path.includes('/queue/entries/qe_waiting0008')) {
        held = true;
        await gate;
      }
      return fetcher(input, init);
    };
    const storage = createStorage();
    storeIntent(storage, 'qe_waiting0008', null);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: holding as typeof fetch,
      storage,
      accountSession: {
        get identity() { return identity; },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      },
      prepareEngine: async () => undefined,
    });
    composition.resumeMatches();
    await settle();
    expect(held).toBe(true);
    // The identity leaves and comes back while the read is held.
    identity = { accountId: 'account-2', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    identity = { accountId: 'account-1', token: async () => 'token' };
    for (const listener of listeners) listener(identity);
    await settle();
    // The answer of the older identity arrives and is discarded.
    release?.();
    await settle();
    await settle();
    await settle();
    // The identity that came back owns its entry again.
    expect(composition.queueEntries.filter(entry => entry.state.phase === 'searching')).toHaveLength(1);
    expect(wires.filter(wire => wire.path.endsWith('/fallback'))).toHaveLength(0);
    composition.dispose();
  });
});

describe('the accepted seat of an invitation survives a reload (R6-07)', () => {
  it('owns the seat of an accepted invitation again', async () => {
    // The credential of an accepted seat is the authority of the seat of the
    // match the invitation produced. It is kept on the device, so a reload
    // still owns the seat.
    const storage = createStorage();
    const secrets = createFriendSecretStore({ storage, identity: 'guest' });
    expect(secrets.rememberAcceptedSeat('invitation-0001', {
      guestId: 'guest-1',
      matchId: 'match-00000001',
      seat: 'black',
      token: 'seat-token',
    })).toBe(true);
    const { fetcher } = createFetchDouble({});
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
    });
    // The seat of the accepted match is owned again, and the game of the
    // accepted seat is attached again.
    expect(composition.commandClient('match-00000001', 'black')).not.toBeNull();
    expect(composition.workspace.games.map(game => game.matchId)).toContain('match-00000001');
    composition.dispose();
  });
});

describe('the disposal of a composition waits for its engine seats', () => {
  it('settles the promise of the disposal after the seats released their leases', async () => {
    // The disposal is synchronous in its effect, and the promise settles when
    // the engine seats released their leases.
    const { fetcher } = createFetchDouble({
      updates: {
        snapshot: matchView({
          clock: { ...matchView().clock, activeSeat: 'black', activeSince: '2026-10-21T10:00:00.000Z' },
        }),
      },
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let released = false;
    let created = false;
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage: createStorage(),
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      createEngineSeat: () => {
        created = true;
        return {
          seat: 'black',
          stopped: false,
          play: () => new Promise(() => undefined),
          dispose: async () => { await gate; released = true; },
        };
      },
    });
    composition.registerGuestCredential(createGuestCredential({
      guestId: 'guest-engine',
      matchId: 'match-00000001',
      seat: 'black',
      token: 'engine-token',
    }), 'account');
    composition.attachAndFocus('match-00000001', 'white');
    await vi.waitFor(() => { expect(created).toBe(true); });
    const disposal = composition.disposeAsync();
    let settled = false;
    void disposal.then(() => { settled = true; });
    await settle();
    // The engine seat still holds its lease.
    expect(settled).toBe(false);
    expect(released).toBe(false);
    release?.();
    await disposal;
    expect(released).toBe(true);
  });

  it('keeps the requester and the session usable until the release of the lease ended', async () => {
    // The disposal invalidates the authority of the browser at once, and the
    // transport of the composition stays usable while the engine seat
    // releases the lease of its turn. A release that is still on the wire
    // never loses its transport.
    const { fetcher, wires } = createFetchDouble({
      updates: {
        snapshot: matchView({
          clock: { ...matchView().clock, activeSeat: 'black', activeSince: '2026-10-21T10:00:00.000Z' },
        }),
      },
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let released = false;
    let created = false;
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage: createStorage(),
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      createEngineSeat: () => {
        created = true;
        return {
          seat: 'black',
          stopped: false,
          play: () => new Promise(() => undefined),
          dispose: async () => { await gate; released = true; },
        };
      },
    });
    // The engine seat of the match is the one that holds the lease.
    composition.registerGuestCredential(createGuestCredential({
      guestId: 'guest-engine',
      matchId: 'match-00000001',
      seat: 'black',
      token: 'engine-token',
    }), 'guest');
    composition.attachAndFocus('match-00000001', 'white');
    await vi.waitFor(() => { expect(created).toBe(true); });
    // The guest seat owns a requester and a session, and the account owns
    // another pair.
    const guest = composition.commandClient('match-00000001', 'black');
    const account = composition.commandClient('match-00000001', 'white');
    expect(guest).not.toBeNull();
    expect(account).not.toBeNull();
    const disposal = composition.disposeAsync();
    await settle();
    // The lease of the engine seat is still held.
    expect(released).toBe(false);
    const before = wires.length;
    // The transport of the guest seat is still usable.
    await guest?.resign().catch(() => undefined);
    expect(wires.length).toBe(before + 1);
    // The transport of the account is still usable too.
    await account?.resign().catch(() => undefined);
    expect(wires.length).toBe(before + 2);
    // The release of the lease ends, and the transport goes away with it.
    release?.();
    await disposal;
    expect(released).toBe(true);
    const after = wires.length;
    await guest?.resign().catch(() => undefined);
    await account?.resign().catch(() => undefined);
    expect(wires.length).toBe(after);
  });

  it('keeps the old transport of a rotated seat and never touches the new one', async () => {
    // A re-minted credential replaces the seat. The transport of the old
    // seat is detached at once, so the new seat gets a transport of its own,
    // and the old transport is disposed when the old engine seat released
    // the lease of its turn.
    const { fetcher, wires } = createFetchDouble({
      updates: {
        snapshot: matchView({
          clock: { ...matchView().clock, activeSeat: 'black', activeSince: '2026-10-21T10:00:00.000Z' },
        }),
      },
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let released = false;
    let created = false;
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage: createStorage(),
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      createEngineSeat: () => {
        created = true;
        return {
          seat: 'black',
          stopped: false,
          play: () => new Promise(() => undefined),
          dispose: async () => { await gate; released = true; },
        };
      },
    });
    composition.registerGuestCredential(createGuestCredential({
      guestId: 'guest-engine',
      matchId: 'match-00000001',
      seat: 'black',
      token: 'engine-token',
    }), 'guest');
    composition.attachAndFocus('match-00000001', 'white');
    await vi.waitFor(() => { expect(created).toBe(true); });
    const oldSeat = composition.commandClient('match-00000001', 'black');
    expect(oldSeat).not.toBeNull();
    // The credential of the seat is re-minted. The old engine seat is
    // released, and its release is held.
    composition.registerGuestCredential(createGuestCredential({
      guestId: 'guest-engine',
      matchId: 'match-00000001',
      seat: 'black',
      token: 'engine-token-2',
    }), 'guest');
    await settle();
    expect(released).toBe(false);
    // The new seat has a transport of its own.
    const newSeat = composition.commandClient('match-00000001', 'black');
    expect(newSeat).not.toBeNull();
    const before = wires.length;
    await newSeat?.resign().catch(() => undefined);
    expect(wires.length).toBe(before + 1);
    // The old transport is still usable while the old seat releases its
    // lease.
    await oldSeat?.resign().catch(() => undefined);
    expect(wires.length).toBe(before + 2);
    // The release ends: the old transport goes away, and the new one stays.
    release?.();
    await settle();
    await settle();
    expect(released).toBe(true);
    const after = wires.length;
    await oldSeat?.resign().catch(() => undefined);
    expect(wires.length).toBe(after);
    await newSeat?.resign().catch(() => undefined);
    expect(wires.length).toBe(after + 1);
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
    expect(composition.agentBindingLabelFor('match-00000001', 'white')).toBeNull();
    // The owner chooses the agent of the seat.
    composition.bindAgentSeat('match-00000001', 'white', 'Other model');
    expect(composition.agentBindingLabelFor('match-00000001', 'white')).toBe('Other model');
    // The binding is stored in the browser, so a reload keeps it.
    const reloaded = createComposition({ storage });
    expect(reloaded.composition.agentBindingLabelFor('match-00000001', 'white')).toBe('Other model');
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
    expect(composition.agentBindingLabelFor('match-00000042', 'black')).toBe('My agent');
    expect(composition.agentBindingLabelFor('match-00000042', 'white')).toBeNull();
    // A seat without a captured selection stays unbound: the owner chooses.
    composition.attachAndFocus('match-00000043', 'black');
    expect(composition.agentBindingLabelFor('match-00000043', 'black')).toBeNull();
    composition.dispose();
  });

  it('binds nothing for a label the owner never connected', () => {
    const { composition } = createComposition();
    composition.setAgentCatalog([{ id: 'choice-1', label: 'My agent', selection: { connectionId: 'c1', modelRoutingId: 'm1' } as unknown as ModelSelection }]);
    composition.bindAgentSeat('match-00000001', 'white', 'Unknown model');
    expect(composition.agentBindingLabelFor('match-00000001', 'white')).toBeNull();
    composition.dispose();
  });

  it('publishes the binding by the private identity, so two models of one label stay apart', () => {
    const { composition } = createComposition();
    const first = { kind: 'model', providerId: 'p', connectionId: 'c1', configurationRevision: 1, modelRoutingId: 'm1', protocol: 'chat-completions', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    const second = { kind: 'model', providerId: 'p', connectionId: 'c1', configurationRevision: 2, modelRoutingId: 'm2', protocol: 'chat-completions', diagnostic: 'passed-current-session' } as unknown as ModelSelection;
    // Two private models of one connection carry the same public label, so only
    // their private identity keeps them apart.
    composition.setAgentCatalog([
      { id: 'agent-first', label: 'Custom model', selection: first },
      { id: 'agent-second', label: 'Custom model', selection: second },
    ]);
    // The owner binds the second model of the connection to the seat.
    composition.rebindAgentSeat('match-00000001', 'white', 'agent-second');
    // The binding is published by the private identity of that model, so the
    // interface resolves the seat to exactly one model.
    expect(composition.agentBindingFor('match-00000001', 'white')).toBe('agent-second');
    // The display still names the model by its public label.
    expect(composition.agentBindingLabelFor('match-00000001', 'white')).toBe('Custom model');
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
    expect(composition.agentBindingLabelFor('match-00000010', 'white')).toBe('Custom model');
    expect(composition.agentBindingLabelFor('match-00000011', 'white')).toBe('Custom model');
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
    expect(composition.agentBindingLabelFor('match-00000012', 'white')).toBeNull();
    // The private identity of the entry resolves.
    composition.bindAgentSeat('match-00000012', 'white', 'private-b');
    expect(composition.agentBindingLabelFor('match-00000012', 'white')).toBe('Custom model');
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
    expect(composition.agentBindingLabelFor('match-00000020', 'white')).toBe('My agent');
    // The identity leaves and comes back: the private binding of that identity
    // is still on the device and is restored.
    expect(composition.agentBindingLabelFor('match-00000020', 'white')).toBe('My agent');
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
      // The entry already produced its game with the browser engine, so the
      // recovery of the credential is allowed to ask the service.
      entryRead: () => ({ status: 200, data: { ...entryAnswer(null), status: 'assigned', assignedMatchId: 'match-00000030' } }),
      matchView: { status: 200, data: matchView({ matchId: 'match-00000030' }) },
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
  /** The control of the seat of the owner. */
  control: { kind: 'human' | 'agent'; modelLabel?: string };
  /** True while the seat of the owner has to move. */
  seatToMove: boolean;
  commands: Array<Record<string, unknown>>;
  /**
   * The commands the service accepted.
   *
   * A command the service refused is not in this list, so a test counts the
   * moves the service really accepted and not the moves the browser tried.
   */
  accepted: Array<Record<string, unknown>>;
  leases: number;
  /** The lease of the seat. */
  leaseId: string | null;
  /** The generation of the lease of the seat. */
  leaseGeneration: number;
  /** The status of the lease of the seat. */
  leaseStatus: 'active' | 'revoked';
  /** The runner that holds the lease of the seat. */
  leaseRunnerId: string | null;
  /**
   * The requests the lease route saw.
   *
   * Every request names the runner that sent it, so a test can see that two
   * tabs of one owner run two runners and that the runner of a seat keeps its
   * identity while it works.
   */
  leaseRequests: Array<{ readonly action: string; readonly runnerId: string }>;
  /** The billable request the service recorded on the lease of the seat. */
  pendingRequestId: string | null;
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
  /**
   * The opponent answers the move of the seat.
   *
   * The service plays the move of the owner on and the opponent answers it, so
   * the seat of the owner is to move again and the version of the match moves
   * on. The test uses it to give the turn back to the seat of the owner.
   */
  opponentReplies(): void;
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
      const leaseAction = String(body?.action ?? '');
      // Every request of the lease route names the runner that sent it.
      state.leaseRequests.push({ action: leaseAction, runnerId: String(body?.runnerId ?? '') });
      // The answer of the service about the lease of the seat.
      const leaseAnswer = (): Record<string, unknown> => ({
        schemaVersion: 2,
        leaseId: state.leaseId ?? `lease-0000000${state.leaseGeneration}`,
        matchId: 'match-00000001',
        seat: 'white',
        controlEpoch: state.controlEpoch,
        generation: state.leaseGeneration,
        runnerId: state.leaseRunnerId ?? String(body?.runnerId ?? 'runner-1'),
        status: state.leaseStatus,
        acquiredAt: '2026-10-21T10:00:00.000Z',
        expiresAt: '2035-01-01T00:00:00.000Z',
        revokedAt: null,
        turnVersion: state.version,
        runnerEpoch: 1,
        pendingRequestId: state.pendingRequestId,
        pendingRequestStartedAt: null,
        revokedReason: state.leaseStatus === 'revoked' ? 'control_change' : null,
        lastRenewedAt: '2026-10-21T10:00:00.000Z',
      });
      if (leaseAction === 'release') {
        // The release gives a lease back. The service checks the lease and the
        // runner of the release, and nothing else: a lease of an older epoch is
        // given back as well.
        if (state.leaseId !== null && String(body?.leaseId ?? '') !== state.leaseId) {
          return json({ error: 'not_found' }, 404);
        }
        if (state.leaseRunnerId !== null && String(body?.runnerId ?? '') !== state.leaseRunnerId) {
          return json({ error: 'not_found' }, 404);
        }
        state.leaseStatus = 'revoked';
        state.releases += 1;
        state.leases += 1;
        return json(leaseAnswer());
      }
      // The service fences a lease or a request whose control epoch or whose
      // turn moved on: the request has to name the state the service holds.
      if (Number(body?.controlEpoch ?? 0) !== state.controlEpoch) {
        return json({ error: 'conflict' }, 409);
      }
      const requestedTurn = Number(body?.turnVersion ?? 0);
      if (requestedTurn !== 0 && requestedTurn !== state.version) {
        return json({ error: 'conflict' }, 409);
      }
      if (leaseAction === 'acquire') {
        if (state.leaseStatus === 'active' && state.leaseId !== null) {
          // The same runner keeps its lease. Another runner holds the seat.
          if (state.leaseRunnerId !== null && String(body?.runnerId ?? '') !== state.leaseRunnerId) {
            return json({ error: 'conflict' }, 409);
          }
        } else {
          // The control change revoked the lease of the seat, so a new lease is
          // taken and it carries the uncertain request of the old lease over.
          state.leaseGeneration += 1;
          state.leaseId = `lease-0000000${state.leaseGeneration}`;
          state.leaseStatus = 'active';
          state.leaseRunnerId = String(body?.runnerId ?? 'runner-1');
        }
      } else {
        // A request about a lease names the lease of the seat and the runner
        // that holds it. A lease of another runner, of another generation or
        // a lease that is not active any more is refused.
        if (state.leaseId === null || String(body?.leaseId ?? '') !== state.leaseId) {
          return json({ error: 'not_found' }, 404);
        }
        if (state.leaseRunnerId !== null && String(body?.runnerId ?? '') !== state.leaseRunnerId) {
          return json({ error: 'not_found' }, 404);
        }
        if (state.leaseStatus !== 'active') {
          return json({ error: 'conflict' }, 409);
        }
      }
      if (leaseAction === 'begin') {
        // Only one billable request is recorded on the lease of the seat.
        if (state.pendingRequestId !== null && state.pendingRequestId !== String(body?.requestId ?? '')) {
          return json({ error: 'conflict' }, 409);
        }
        state.pendingRequestId = String(body?.requestId ?? '');
      }
      if (leaseAction === 'clear') {
        // Only the record the request names is closed: a request of another
        // runner keeps its record.
        if (state.pendingRequestId !== null && state.pendingRequestId !== String(body?.requestId ?? '')) {
          return json({ error: 'conflict' }, 409);
        }
        state.pendingRequestId = null;
      }
      state.leases += 1;
      return json(leaseAnswer());
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
      // The service fences a command whose version or control epoch moved on:
      // the command has to name the exact state the service holds.
      if (Number(body?.expectedVersion ?? 0) !== state.version) {
        return json({ error: 'conflict' }, 409);
      }
      if (Number(body?.controlEpoch ?? 0) !== state.controlEpoch) {
        return json({ error: 'conflict' }, 409);
      }
      state.version += 1;
      // The service accepted the command, so a test counts the moves the
      // service really played on and not the moves the browser tried.
      state.accepted.push(body ?? {});
      if (action.kind === 'set_control') {
        state.controlEpoch += 1;
        state.control = (action.control ?? { kind: 'agent' }) as { kind: 'human' | 'agent'; modelLabel?: string };
        // The service revokes the lease of the seat with the control change.
        state.leaseStatus = 'revoked';
      }
      if (action.kind === 'submit_move') {
        // The service plays the move on, so the other seat answers it and the
        // seat of the owner is not to move any more.
        state.seatToMove = false;
      }
      // The service publishes the state it holds now, so the next command of
      // the browser names the version the service knows.
      state.view = agentView(state);
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
    // The provider answers with the stream of the chat-completions protocol,
    // like the real one does. The decoder of the browser reads that stream, so
    // a plain JSON body would never reach the runner as an answer.
    const chunk = {
      choices: [{ index: 0, delta: { content: '{"move":"e2e4"}' }, finish_reason: 'stop' }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch);
  return { requests, restore: () => vi.unstubAllGlobals() };
}

/**
 * The provider of a held request.
 *
 * The request never answers until the test releases it, so a test can hold the
 * provider request of a runner while the identity changes or the composition
 * is disposed. The request keeps its abort signal, so a test can see that the
 * browser stopped the request instead of letting it run on.
 */
function heldProviderFixture(): {
  readonly requests: Array<{ readonly signal: AbortSignal | null }>;
  release(): void;
  restore(): void;
} {
  const requests: Array<{ readonly signal: AbortSignal | null }> = [];
  const gate = createGate();
  vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? null;
    requests.push({ signal });
    // The request waits for the test. A request the browser stopped never
    // answers, exactly like a request whose transport was aborted.
    const outcome = await Promise.race([
      gate.promise.then(() => 'released' as const),
      new Promise<'stopped'>((resolve) => {
        if (signal === null) return;
        if (signal.aborted) {
          resolve('stopped');
          return;
        }
        signal.addEventListener('abort', () => { resolve('stopped'); });
      }),
    ]);
    if (outcome === 'stopped') throw new DOMException('The request was stopped.', 'AbortError');
    const chunk = {
      choices: [{ index: 0, delta: { content: '{"move":"e2e4"}' }, finish_reason: 'stop' }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch);
  return { requests, release: gate.release, restore: () => vi.unstubAllGlobals() };
}

/** The state of the service of the fixture. */
function serviceState(seatToMove = true): AgentServiceState {
  const commandGate = createGate();
  const leaseGate = createGate();
  const state: AgentServiceState = {
    view: matchView(),
    mode: 'lost',
    version: 1,
    controlEpoch: 1,
    control: { kind: 'agent', modelLabel: 'Custom model' },
    seatToMove,
    commands: [],
    accepted: [],
    leases: 0,
    leaseId: null,
    leaseGeneration: 0,
    leaseStatus: 'active',
    leaseRunnerId: null,
    leaseRequests: [],
    pendingRequestId: null,
    holdCommand: false,
    heldCommand: false,
    holdLease: false,
    heldLease: false,
    releases: 0,
    commandGate: commandGate.promise,
    leaseGate: leaseGate.promise,
    opponentReplies() {
      // The opponent answers the move of the seat: the seat is to move again
      // and the version of the match moves on.
      state.version += 1;
      state.seatToMove = true;
      state.view = agentView(state);
    },
  };
  state.view = agentView(state);
  return state;
}

/** The canonical view of the agent seat of the fixture. */
function agentView(state: AgentServiceState): OnlineMatchView {
  const control = state.control;
  const seatToMove = state.seatToMove;
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
      guestId: 'guest-r10a-1',
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
    // The runner learned the version of the service before the owner decides:
    // a command that names a version the service already left is refused.
    await until(
      () => (composition.agentRunnerState('match-00000001', 'white')?.version ?? 0) >= state.version,
      'the runner learned the version of the service',
    );
    const unknown = await composition.agentDecision('match-00000001', 'white', 'switch-model', 'private-b');
    expect(unknown.kind).toBe('unknown');
    expect(composition.agentBindingLabelFor('match-00000001', 'white')).toBe('Custom model');
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
    // The opponent answered the move of the seat, so the seat is to move again.
    state.opponentReplies();
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
  }, 20_000);

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
      guestId: 'guest-r10a-2',
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
    // The runner learned the version of the service before the owner decides:
    // a command that names a version the service already left is refused.
    await until(
      () => (composition.agentRunnerState('match-00000001', 'white')?.version ?? 0) >= state.version,
      'the runner learned the version of the service',
    );
    const askedBefore = provider.requests.length;
    const accepted = await composition.agentDecision('match-00000001', 'white', 'switch-model', 'private-b');
    expect(accepted.kind).toBe('accepted');
    // The control of the seat changed at the service. From this moment the
    // browser never asks the provider with the credential of the old model
    // again.
    // The seat plays the private selection the owner chose: the runner of the
    // new selection asks the provider with the credential of that selection.
    // The opponent answered the move of the seat, so the seat is to move again
    // and the runner of the new selection plays the turn.
    state.opponentReplies();
    await until(
      () => composition.agentRunnerState('match-00000001', 'white')?.boundSeatControlEpoch === state.controlEpoch,
      'the replacement runner binds the proven control epoch',
    );
    expect(composition.agentRunnerState('match-00000001', 'white')?.boundSeatControlEpoch)
      .toBe(state.controlEpoch);
    await until(() => provider.requests.length > askedBefore, 'the provider is asked again');
    const after = provider.requests.slice(askedBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every(request => request.authorization === 'Bearer key-c2')).toBe(true);
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBe('c2');
    expect(connections.asked).toContain('c2');
    composition.dispose();
    provider.restore();
  }, 20_000);

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
      guestId: 'guest-r10a-3',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The owner takes the seat over. The service applies the command and the
    // browser never learns the receipt.
    // The runner learned the version of the service before the owner decides:
    // a command that names a version the service already left is refused.
    await until(
      () => (composition.agentRunnerState('match-00000001', 'white')?.version ?? 0) >= state.version,
      'the runner learned the version of the service',
    );
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
    expect(composition.agentBindingLabelFor('match-00000001', 'white')).toBeNull();
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBeNull();
    expect(composition.agentRunnerState('match-00000001', 'white')).toBeNull();
    // The seat is the human's now, so the browser asks the provider for
    // nothing.
    expect(provider.requests).toHaveLength(0);
    composition.dispose();
    provider.restore();
  }, 20_000);

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
      guestId: 'guest-r10a-4',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The owner switches the seat to the second private model. The service
    // applies the command and the browser never learns the receipt.
    // The runner learned the version of the service before the owner decides:
    // a command that names a version the service already left is refused.
    await until(
      () => (composition.agentRunnerState('match-00000001', 'white')?.version ?? 0) >= state.version,
      'the runner learned the version of the service',
    );
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
  }, 20_000);

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
      guestId: 'guest-r10a-5',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The owner switches the seat to the other private model. The service
    // applies the command and the browser never learns the receipt.
    // The runner learned the version of the service before the owner decides:
    // a command that names a version the service already left is refused.
    await until(
      () => (composition.agentRunnerState('match-00000001', 'white')?.version ?? 0) >= state.version,
      'the runner learned the version of the service',
    );
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
  }, 20_000);
});

/**
 * The moves the service accepted for the seat of the owner.
 *
 * A command the service refused is not counted, so the number is the number of
 * moves the game really played on.
 */
function acceptedMoves(state: AgentServiceState): number {
  return state.accepted.filter(command => (command.action as { kind?: string } | undefined)?.kind === 'submit_move').length;
}

/**
 * The control changes the service accepted for the seat of the owner.
 *
 * A control change the service refused is not counted, so the number is the
 * number of control changes the game really applied.
 */
function acceptedControlChanges(state: AgentServiceState): number {
  return state.accepted.filter(command => (command.action as { kind?: string } | undefined)?.kind === 'set_control').length;
}

describe('the hand-back of a seat to the agent of the owner (R10-B)', () => {
  it('hands the seat back to the agent after the owner took it over, without a reload', async () => {
    const provider = providerFixture();
    const storage = createStorage();
    const first = selectionOf('c1', 'm1');
    const state = serviceState();
    // The service answers every command of this test, so every decision of
    // the owner is proven.
    state.mode = 'online';
    const connections = connectionStoreOf([{ id: 'c1' }]);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: agentServiceDouble(state),
      storage,
      accountSession: accountSession(),
      connectionStore: connections.store,
    });
    composition.setAgentCatalog([{ id: 'private-a', label: 'Custom model', selection: first }]);
    composition.setAgent({ label: 'Custom model', selection: first });
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-r10b-1',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The seat is to move, so the runner of the seat asks the provider and
    // submits the move of the seat.
    await until(() => provider.requests.length > 0, 'the provider is asked');
    await until(() => acceptedMoves(state) === 1, 'the move of the seat is accepted');

    // The owner takes the seat over. The seat belongs to the human now, the
    // runner of the seat is gone and the private binding of the seat leaves
    // the browser.
    await until(
      () => (composition.agentRunnerState('match-00000001', 'white')?.version ?? 0) >= state.version,
      'the runner learned the version of the service',
    );
    const takeover = await composition.agentDecision('match-00000001', 'white', 'takeover');
    expect(takeover.kind).toBe('accepted');
    expect(state.control.kind).toBe('human');
    expect(composition.agentRunnerState('match-00000001', 'white')).toBeNull();
    expect(composition.agentBindingLabelFor('match-00000001', 'white')).toBeNull();

    // The opponent answers the move of the seat, so the seat is to move again
    // and it waits for the owner.
    state.opponentReplies();
    await until(
      () => (composition.workspace.state('match-00000001')?.snapshot?.version ?? 0) >= state.version,
      'the browser knows the version of the service',
    );
    const askedBefore = provider.requests.length;
    const movesBefore = acceptedMoves(state);
    const controlsBefore = acceptedControlChanges(state);

    // The owner hands the seat back to the agent. The composition asks the
    // service for the control change and binds the seat to the private
    // selection of the owner, so the seat plays with the model the owner
    // chose and not with a guess of the browser.
    const handoff = await composition.handSeatToAgent('match-00000001', 'white');
    expect(handoff.kind).toBe('accepted');
    expect(state.control.kind).toBe('agent');
    // The service applied exactly one control change for the hand-back.
    expect(acceptedControlChanges(state) - controlsBefore).toBe(1);
    expect(persistedSelection(storage, 'match-00000001', 'white')).toBe('c1');

    // The seat plays again without a reload: the runner of the seat is back,
    // and it asks the provider exactly once for the turn and submits exactly
    // one move.
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat is back');
    await until(() => provider.requests.length > askedBefore, 'the provider is asked again');
    expect(provider.requests.length - askedBefore).toBe(1);
    expect(provider.requests.slice(askedBefore).every(request => request.authorization === 'Bearer key-c1')).toBe(true);
    await until(() => acceptedMoves(state) === movesBefore + 1, 'the move of the hand-back is accepted');
    expect(acceptedMoves(state) - movesBefore).toBe(1);
    composition.dispose();
    provider.restore();
  }, 30_000);

  it('replaces a runner that the service superseded and never asks the provider twice', async () => {
    const provider = heldProviderFixture();
    const storage = createStorage();
    const first = selectionOf('c1', 'm1');
    const state = serviceState();
    const connections = connectionStoreOf([{ id: 'c1' }]);
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: agentServiceDouble(state),
      storage,
      accountSession: accountSession(),
      connectionStore: connections.store,
    });
    composition.setAgentCatalog([{ id: 'private-a', label: 'Custom model', selection: first }]);
    composition.setAgent({ label: 'Custom model', selection: first });
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-r10b-2',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, first);
    await until(() => composition.agentRunnerState('match-00000001', 'white') !== null, 'the runner of the seat');

    // The seat is to move, so the runner of the seat asks the provider. The
    // request waits for the test, so it may still be running.
    await until(() => provider.requests.length === 1, 'the provider is asked');

    // Another controller took the seat: the service advances the control epoch
    // of the seat while the runner plays it. The runner of the seat stands
    // down and gives the lease of the seat back.
    state.version += 1;
    state.controlEpoch += 1;
    state.view = agentView(state);

    // The composition replaces the runner that gave up, so the seat is never
    // left without a runner.
    await until(
      () => composition.agentRunnerState('match-00000001', 'white') !== null,
      'the seat keeps a runner',
    );
    // The request of the old runner may still be running, so the replacement
    // never asks the provider for a second answer by itself. It waits for the
    // decision of the owner instead.
    await until(
      () => composition.agentRunnerState('match-00000001', 'white')?.phase === 'uncertain',
      'the replacement waits for the decision of the owner',
    );
    const runner = composition.agentRunnerState('match-00000001', 'white');
    // The runner of the seat is not the one that gave up: it plays the epoch
    // the service publishes now.
    expect(runner?.superseded).toBe(false);
    expect(runner?.uncertainty?.kind).toBe('provider-request');
    expect(provider.requests.length).toBe(1);
    expect(acceptedMoves(state)).toBe(0);
    composition.dispose();
    provider.restore();
  }, 30_000);
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

/**
 * The composition keeps the entries of the identity that owns them.
 *
 * The cases below are the findings of the review of the queue composition:
 *
 * - An identity change takes the rows of the previous identity away, and the
 *   cleanup of an entry stays in the namespace of the identity that owns it.
 * - A creation that was on the wire when the identity changed leaves a
 *   durable obligation in the namespace of the identity that asked, so the
 *   entry of the previous identity never waits behind the owner's back.
 * - The default action targets the shared entry of the owner, never an
 *   explicit second game.
 * - A read of the service that does not answer is never treated as an absent
 *   entry: the old shared entry is resolved before a new one is created.
 */
describe('the queue composition keeps the entries of the identity that owns them', () => {
  /** The identity of a signed-in account, with a token of its own. */
  interface Identity {
    readonly accountId: string;
    readonly token: () => Promise<string>;
  }

  /**
   * An account session the test hands over.
   *
   * Every account has a token of its own, so a wire of one account is never
   * confused with a wire of another one.
   */
  function switchingSession(): {
    readonly session: NonNullable<Parameters<typeof createOnlineComposition>[0]['accountSession']>;
    switchTo(accountId: string): void;
  } {
    const listeners = new Set<(identity: Identity | null) => void>();
    let current: Identity | null = { accountId: 'account-1', token: async () => 'token-account-1' };
    return {
      session: {
        get identity() { return current; },
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      },
      switchTo(accountId) {
        current = { accountId, token: async () => `token-${accountId}` };
        for (const listener of [...listeners]) listener(current);
      },
    };
  }

  /** The durable intents of one identity. */
  function intentsOf(storage: Storage, identity: string): Array<Record<string, unknown>> {
    const raw = storage.getItem(`kamkmchess.online.queue.intent.v1:${encodeURIComponent(identity)}`);
    if (!raw) return [];
    return JSON.parse(raw) as Array<Record<string, unknown>>;
  }

  /** The claim of the shared entry of one identity. */
  function claimOfIdentity(storage: Storage, identity: string): { key: string; settings: string } | null {
    const raw = storage.getItem(`kamkmchess.online.queue.intent.v1:claim:${encodeURIComponent(identity)}`);
    if (!raw) return null;
    return JSON.parse(raw) as { key: string; settings: string };
  }

  /** A queue entry of the service that waits. */
  function waitingServiceEntry(entryId: string): QueueEntry {
    return {
      schemaVersion: 2,
      entryId,
      owner: { kind: 'account', id: 'account-1' },
      control: { kind: 'human' },
      timeControl,
      status: 'waiting',
      version: 1,
      readyAt: '2099-01-01T00:00:00.000Z',
      cutoffAt: '2099-01-01T00:00:10.000Z',
      assignedMatchId: null,
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
  }

  it('takes the row of the previous identity away when another account signs in', async () => {
    // A live entry belongs to the account that created it. When another
    // account signs in, the row of the previous account leaves the screen, so
    // the new account never shows it and never controls it. The claim and the
    // intent of the previous account stay in its own namespace, so the
    // cleanup of that entry never touches the namespace of the new one.
    const service = createQueueService();
    const storage = createStorage();
    const account = switchingSession();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: account.session,
      prepareEngine: async () => undefined,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    expect(composition.queueEntries).toHaveLength(1);
    const sharedKey = service.creations[0]!;
    expect(claimOfIdentity(storage, 'account:account-1')?.key).toBe(sharedKey);

    // Another account signs in.
    account.switchTo('account-2');
    await settle();

    // The row of the previous account is gone, and the new account sees an
    // idle queue.
    expect(composition.queueEntries).toHaveLength(0);
    expect(composition.queueState.phase).toBe('idle');
    // The new account owns nothing: its namespace is empty.
    expect(intentsOf(storage, 'account:account-2')).toHaveLength(0);
    expect(claimOfIdentity(storage, 'account:account-2')).toBeNull();
    // The claim of the previous account is untouched: it belongs to that
    // account, and the new account never releases it.
    expect(claimOfIdentity(storage, 'account:account-1')?.key).toBe(sharedKey);
    // The durable intent of the previous account stays in its own namespace,
    // so the account finds its entry again when it returns.
    expect(intentsOf(storage, 'account:account-1').map(intent => intent.key)).toEqual([sharedKey]);
    // The entry of the previous account keeps waiting on the service: the
    // account that signed in never cancels the entry of another account.
    expect(service.cancels).toHaveLength(0);
    composition.dispose();
  });

  it('keeps a durable obligation when the account changes during the creation', async () => {
    // The creation of the entry is on the wire when another account signs in.
    // The service may have accepted the entry under the account that asked,
    // and the answer never arrives. The browser keeps the obligation to
    // cancel that entry in the namespace of the account that asked, and the
    // new account never issues a request for the entry of the old one.
    const service = createQueueService();
    const storage = createStorage();
    const account = switchingSession();
    const wires: Wire[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const recording: typeof fetch = async (input, init) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[name.toLowerCase()] = value;
      }
      wires.push({ path, method, body: null, headers });
      // The first creation waits on the wire.
      if (!held && method === 'POST' && path.endsWith('/entries')) {
        held = true;
        await gate;
      }
      return service.fetcher(input, init);
    };
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: recording as typeof fetch,
      storage,
      accountSession: account.session,
      prepareEngine: async () => undefined,
    });
    const entering = composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await settle();
    expect(held).toBe(true);

    // Another account signs in while the creation is on the wire.
    account.switchTo('account-2');
    release?.();

    // The enter reports the failure instead of pretending that the entry was
    // created.
    await expect(entering).rejects.toThrow(OnlineQueueIdentityChangedError);
    await settle();

    // The creation travelled with the token of the account that asked, and the
    // new account never issued a request for the entry of the old one.
    const creations = wires.filter(wire => wire.path.endsWith('/entries') && wire.method === 'POST');
    expect(creations).toHaveLength(1);
    expect(creations[0]?.headers.authorization).toBe('Bearer token-account-1');
    expect(wires.filter(wire => wire.path.endsWith('/cancel'))).toHaveLength(0);
    expect(wires.every(wire => wire.headers.authorization !== 'Bearer token-account-2')).toBe(true);
    // The new account sees no row of the previous account.
    expect(composition.queueEntries).toHaveLength(0);

    // The obligation lives in the namespace of the account that asked, and it
    // keeps the key of the entry, so the entry is recovered with the same key.
    const obligations = intentsOf(storage, 'account:account-1');
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.cleanup).toBe(true);
    expect(obligations[0]?.sent).toBe(true);
    expect(obligations[0]?.entryId).toBeNull();
    expect(obligations[0]?.key).toBe(service.creations[0]);
    // The new account owns no obligation at all.
    expect(intentsOf(storage, 'account:account-2')).toHaveLength(0);

    // The account that asked comes back. Its obligation is resolved: the
    // entry is recovered with the same key and cancelled, with the token of
    // that account.
    account.switchTo('account-1');
    await settle();
    await settle();
    await settle();
    const cancels = wires.filter(wire => wire.path.endsWith('/cancel'));
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.headers.authorization).toBe('Bearer token-account-1');
    expect(service.cancels).toEqual(['entry-0000001']);
    // The recovery used the same key, so the service never saw a second entry.
    expect(new Set(service.creations).size).toBe(1);
    // The obligation is gone, and the entry of the old account is cancelled.
    expect(intentsOf(storage, 'account:account-1')).toHaveLength(0);
    expect(service.entries.get('entry-0000001')?.status).toBe('cancelled');
    composition.dispose();
  });

  it('targets the shared entry of the owner and never an explicit second game', async () => {
    // The owner waits with a shared entry and asked for an explicit second
    // game with the same settings. The default action joins the shared entry:
    // the explicit entry keeps waiting, stays visible and is never the target
    // of the default action.
    const service = createQueueService();
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl }, { intent: 'new' });
    await settle();
    expect(service.creations).toHaveLength(2);
    const sharedKey = service.creations[0]!;
    const explicitKey = service.creations[1]!;
    expect(explicitKey).not.toBe(sharedKey);

    // The default action again, with the same settings.
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await settle();

    // No third entry: the default action reached the shared entry.
    expect(service.creations).toHaveLength(2);
    // The shared entry is the one that is shown.
    expect(composition.queueState.entry?.entryId).toBe('entry-0000001');
    // The explicit entry keeps waiting and stays visible.
    const searching = composition.queueEntries.filter(entry => entry.state.phase === 'searching');
    expect(searching).toHaveLength(2);
    expect(searching.some(entry => entry.entryId === 'entry-0000002')).toBe(true);
    // The claim of the shared entry still names the shared entry: the explicit
    // game never took it.
    expect(claimOfIdentity(storage, 'account:account-1')?.key).toBe(sharedKey);
    composition.dispose();
  });

  it('replaces the shared entry and keeps the explicit one when the default action changes the model', async () => {
    // The default action asks for another model. The shared entry of the
    // owner is replaced by a fresh one, and the explicit second game of the
    // owner keeps waiting: the default action never takes it away.
    const service = createQueueService();
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
      checkModel: async () => ({ ready: true, detail: '' }),
    });
    composition.setAgent({
      label: 'GPT-4o',
      selection: { connectionId: 'c1', modelRoutingId: 'm1', protocol: 'chat-completions', configurationRevision: 'r1', diagnostic: 'passed-current-session' } as unknown as ModelSelection,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl }, { intent: 'new' });
    await settle();
    expect(service.creations).toHaveLength(2);

    // The default action watches the agent instead.
    await composition.enterQueue({ control: { kind: 'agent', modelLabel: 'GPT-4o' }, timeControl });
    await settle();

    // The shared entry of the owner was resolved and a fresh one waits.
    expect(service.cancels).toEqual(['entry-0000001']);
    expect(service.creations).toHaveLength(3);
    // The explicit second game of the owner keeps waiting.
    expect(service.entries.get('entry-0000002')?.status).toBe('waiting');
    const searching = composition.queueEntries.filter(entry => entry.state.phase === 'searching');
    expect(searching.some(entry => entry.entryId === 'entry-0000002')).toBe(true);
    composition.dispose();
  });

  it('resolves the old shared entry when the service does not answer the read', async () => {
    // The settings of the owner changed in another tab, and the read of the
    // old entry fails by transport. The old entry is never treated as
    // absent: it is resolved before the new entry is created, so the owner
    // never ends up with two eligible shared entries.
    const service = createQueueService();
    const storage = createStorage();
    storage.setItem('kamkmchess.online.queue.intent.v1:account%3Aaccount-1', JSON.stringify([{
      key: 'intent-shared-0001',
      settings: 'human||300000|2000',
      control: { kind: 'human' },
      timeControl,
      entryId: 'entry-0000009',
      recordId: 'queue-1',
      state: 'live',
      sent: true,
      shared: true,
      selection: null,
      engineMatchId: null,
    }]));
    service.entries.set('entry-0000009', waitingServiceEntry('entry-0000009'));
    const failing: typeof fetch = async (input, init) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      // The read of the entry fails by transport.
      if (method === 'GET' && path.includes('/queue/entries/')) {
        throw new Error('The connection was lost.');
      }
      return service.fetcher(input, init);
    };
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: failing as typeof fetch,
      storage,
      accountSession: accountSession(),
      prepareEngine: async () => undefined,
    });
    await composition.enterQueue({
      control: { kind: 'human' },
      timeControl: { startingTimeMs: 180_000, incrementMs: 2_000 },
    });
    await settle();

    // The old shared entry was resolved before the new entry was created.
    expect(service.cancels).toEqual(['entry-0000009']);
    // A fresh entry waits, with a key of its own. The key of the old entry
    // never reaches the service as a creation.
    expect(service.creations).toHaveLength(1);
    expect(service.creations[0]).not.toBe('intent-shared-0001');
    expect(service.entries.get('entry-0000001')?.status).toBe('waiting');
    // The old intent is gone, and the claim names the new entry.
    expect(intentsOf(storage, 'account:account-1').map(intent => intent.key)).toEqual([service.creations[0]]);
    expect(claimOfIdentity(storage, 'account:account-1')?.key).toBe(service.creations[0]);
    composition.dispose();
  });
});

/**
 * A cancellation that lost the race against an assignment (QUE-08, QUE-10).
 *
 * The queue refuses the cancellation of an assigned entry with a conflict:
 * the entry produced exactly one game, and the game is cancelled through the
 * participant command route, not through the queue. The browser reconciles
 * that conflict with the authoritative state of the entry and of its game, and
 * it never drops the obligation of an entry it could not resolve.
 */
describe('a cancellation that lost the race against an assignment', () => {
  /**
   * A queue service whose entry wins the race against a cancellation.
   *
   * The creation is idempotent per client request identifier, exactly like the
   * service, so the recovery of a lost answer reaches the same entry and never
   * a second one.
   */
  function createRacingQueueService(options: {
    /** The creation route loses its first answer. */
    readonly loseCreation?: boolean;
    /** The created entry is assigned already. */
    readonly assigned?: boolean;
    /** The command route refuses the cancellation of the game. */
    readonly refuseCommand?: boolean;
    /** The game is over already. */
    readonly gameEnded?: boolean;
  } = {}): {
    readonly fetcher: typeof fetch;
    readonly wires: Wire[];
    readonly creations: string[];
    readonly cancels: string[];
    readonly commands: Record<string, unknown>[];
  } {
    const entries = new Map<string, QueueEntry>();
    const byRequest = new Map<string, string>();
    const wires: Wire[] = [];
    const creations: string[] = [];
    const cancels: string[] = [];
    const commands: Record<string, unknown>[] = [];
    let counter = 0;
    let lost = false;

    function entryOf(entryId: string, control: unknown, assigned: boolean): QueueEntry {
      return {
        schemaVersion: 2,
        entryId,
        owner: { kind: 'account', id: 'account-1' },
        control: (control ?? { kind: 'human' }) as QueueEntry['control'],
        timeControl,
        status: assigned ? 'assigned' : 'waiting',
        version: 1,
        readyAt: '2099-01-01T00:00:00.000Z',
        cutoffAt: '2099-01-01T00:00:10.000Z',
        assignedMatchId: assigned ? 'match-00000031' : null,
        createdAt: '2099-01-01T00:00:00.000Z',
        updatedAt: '2099-01-01T00:00:00.000Z',
      };
    }

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown>;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
      wires.push({ path, method, body, headers });
      const answer = (status: number, data: unknown): Response => new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

      if (path.includes('/v1/online/features')) return answer(200, { friends: true, queue: true });
      if (path.includes('/v1/online/matches/') && path.endsWith('/commands')) {
        commands.push(body ?? {});
        if (options.refuseCommand) return answer(409, { error: 'conflict' });
        return answer(200, {
          schemaVersion: 2,
          matchId: body?.matchId ?? 'match-00000031',
          operationId: body?.operationId ?? 'operation-00000001',
          outcome: 'accepted',
          version: 2,
          controlEpoch: 1,
          decidedAt: '2026-10-21T10:05:00.000Z',
        });
      }
      if (path.includes('/v1/online/matches/')) {
        const matchId = path.split('/').filter(Boolean).pop() ?? 'match-00000031';
        return answer(200, matchView({
          matchId,
          status: options.gameEnded === true ? 'completed' : 'active',
          result: options.gameEnded === true ? { kind: 'abort', winner: null, reason: 'abort' } : null,
        }));
      }
      if (!path.includes('/queue/entries')) return answer(404, { error: 'not_found' });
      if (method === 'POST' && path.endsWith('/entries')) {
        const key = String(body?.clientRequestId ?? '');
        const known = byRequest.get(key);
        // The creation is idempotent per client request identifier.
        if (known !== undefined) return answer(200, entries.get(known));
        counter += 1;
        const entryId = `entry-000000${counter}`;
        byRequest.set(key, entryId);
        creations.push(key);
        const created = entryOf(entryId, body?.control, options.assigned === true);
        entries.set(entryId, created);
        if (options.loseCreation === true && !lost) {
          lost = true;
          // The service accepted the entry, and the answer never arrives.
          throw new Error('The connection was lost.');
        }
        return answer(201, created);
      }
      const segments = path.split('/').filter(Boolean);
      // The read of an entry names it in the last segment, and a mutation of
      // an entry names it in the segment before its own route.
      const entryId = decodeURIComponent(
        (method === 'GET' ? segments[segments.length - 1] : segments[segments.length - 2]) ?? '',
      );
      const entry = entries.get(entryId);
      if (!entry) return answer(404, { error: 'not_found' });
      if (path.endsWith('/cancel')) {
        cancels.push(entryId);
        // The entry won the race: it is assigned, and the queue refuses the
        // cancellation of an assigned entry with a conflict.
        const assigned = entryOf(entryId, entry.control, true);
        entries.set(entryId, assigned);
        return answer(409, { error: 'conflict' });
      }
      // The read of the entry: the entry is assigned.
      const assigned = entryOf(entryId, entry.control, true);
      entries.set(entryId, assigned);
      return answer(200, assigned);
    });

    return { fetcher: fetcher as unknown as typeof fetch, wires, creations, cancels, commands };
  }

  /** The durable intents of one identity. */
  function intentsOf(storage: Storage, identity: string): Array<Record<string, unknown>> {
    const raw = storage.getItem(`kamkmchess.online.queue.intent.v1:${encodeURIComponent(identity)}`);
    if (!raw) return [];
    return JSON.parse(raw) as Array<Record<string, unknown>>;
  }

  /**
   * An account session the test hands over.
   *
   * Every account has a token of its own, so a wire of one account is never
   * confused with a wire of another one.
   */
  function switchingSession(): {
    readonly session: NonNullable<Parameters<typeof createOnlineComposition>[0]['accountSession']>;
    switchTo(accountId: string): void;
  } {
    type Identity = { readonly accountId: string; readonly token: () => Promise<string> };
    const listeners = new Set<(identity: Identity | null) => void>();
    let current: Identity | null = { accountId: 'account-1', token: async () => 'token-account-1' };
    return {
      session: {
        get identity() { return current; },
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      },
      switchTo(accountId) {
        current = { accountId, token: async () => `token-${accountId}` };
        for (const listener of [...listeners]) listener(current);
      },
    };
  }

  it('cancels the game of an entry that won the race against its cancellation', async () => {
    // The owner changes the settings of the shared entry. The entry wins the
    // race against its cancellation: it is assigned and it produced exactly
    // one game. The queue refuses the cancellation with a conflict, so the
    // game is cancelled through the participant command route instead.
    const service = createRacingQueueService();
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: switchingSession().session,
      prepareEngine: async () => undefined,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    expect(service.creations).toHaveLength(1);
    const replacedKey = service.creations[0]!;

    // The owner changes the clock of the shared entry.
    await composition.enterQueue({
      control: { kind: 'human' },
      timeControl: { startingTimeMs: 180_000, incrementMs: 2_000 },
    });
    await settle();

    // The queue refused the cancellation of the assigned entry.
    expect(service.cancels).toEqual(['entry-0000001']);
    // The game of the owner was cancelled through the participant command
    // route, with a stable operation key, so a retry answers with the same
    // receipt instead of acting twice.
    expect(service.commands).toHaveLength(1);
    const command = service.commands[0]!;
    expect(command.action).toEqual({ kind: 'cancel' });
    expect(command.matchId).toBe('match-00000031');
    expect(command.seat).toBe('white');
    expect(command.expectedVersion).toBe(1);
    expect(command.operationId).toBe(`cancel-${replacedKey}`);
    // The fresh entry of the new settings waits, and the owner never ends up
    // with two eligible shared entries.
    expect(service.creations).toHaveLength(2);
    expect(intentsOf(storage, 'account:account-1').map(intent => intent.key)).toEqual([service.creations[1]]);
    composition.dispose();
  });

  it('never starts a second search while the cancellation of the game is unconfirmed', async () => {
    // The command route refuses the cancellation of the game, so the outcome
    // of the cancellation is unknown. The owner never ends up with two
    // eligible shared entries, and the assignment is never abandoned: the
    // intent of the replaced entry survives for a later try.
    const service = createRacingQueueService({ refuseCommand: true });
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: service.fetcher,
      storage,
      accountSession: switchingSession().session,
      prepareEngine: async () => undefined,
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    expect(service.creations).toHaveLength(1);

    await composition.enterQueue({
      control: { kind: 'human' },
      timeControl: { startingTimeMs: 180_000, incrementMs: 2_000 },
    });
    await settle();

    // The game was not abandoned: the cancellation was attempted.
    expect(service.cancels).toEqual(['entry-0000001']);
    expect(service.commands).toHaveLength(1);
    // No second entry reached the service while the cancellation of the game
    // was unresolved: the owner never ends up with two eligible shared
    // entries.
    expect(service.creations).toHaveLength(1);
    // The obligation of the replaced entry survives, and the intent of the new
    // settings is durable and unsent: the retry of the owner reuses its key,
    // so the service never sees a second entry for it.
    const intents = intentsOf(storage, 'account:account-1');
    expect(intents).toHaveLength(2);
    const obligation = intents.find(intent => intent.entryId === 'entry-0000001');
    expect(obligation?.key).toBe(service.creations[0]);
    expect(obligation?.cleanup).toBe(true);
    const planned = intents.find(intent => intent.entryId === null);
    expect(planned?.sent).toBe(false);
    expect(planned?.cleanup).toBe(false);
    expect(planned?.key).not.toBe(service.creations[0]);
    // The owner learns that the entry of the old settings is not over yet.
    expect(composition.queueState.detail).toContain('could not be cancelled');
    composition.dispose();
  });

  it('cancels the game of a stale entry when the account that asked comes back', async () => {
    // The creation of the entry is on the wire when another account signs in.
    // The service accepted the entry and assigned it before the answer was
    // lost, so the stale entry produced a game. The account that asked comes
    // back: its obligation is resolved with the token of that account, and
    // the game is cancelled through the participant command route. The game
    // never plays with an absent seat.
    const service = createRacingQueueService({ loseCreation: true, assigned: true });
    const storage = createStorage();
    const account = switchingSession();
    const wires: Wire[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const recording: typeof fetch = async (input, init) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
      wires.push({ path, method, body: null, headers });
      // The first creation waits on the wire.
      if (!held && method === 'POST' && path.endsWith('/entries')) {
        held = true;
        await gate;
      }
      return service.fetcher(input, init);
    };
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: recording as typeof fetch,
      storage,
      accountSession: account.session,
      prepareEngine: async () => undefined,
    });
    const entering = composition.enterQueue({ control: { kind: 'human' }, timeControl });
    await settle();
    expect(held).toBe(true);

    // Another account signs in while the creation is on the wire.
    account.switchTo('account-2');
    release?.();
    await expect(entering).rejects.toThrow(OnlineQueueIdentityChangedError);
    await settle();

    // The obligation of the account that asked survives, and the new account
    // owns nothing.
    expect(intentsOf(storage, 'account:account-1')).toHaveLength(1);
    expect(intentsOf(storage, 'account:account-1')[0]?.cleanup).toBe(true);
    expect(intentsOf(storage, 'account:account-2')).toHaveLength(0);

    // The account that asked comes back.
    account.switchTo('account-1');
    await settle();
    await settle();
    await settle();

    // The stale entry was recovered with the same key, so the service never
    // saw a second entry, and the queue refused the cancellation of the
    // assigned entry.
    expect(new Set(service.creations).size).toBe(1);
    expect(service.cancels).toEqual(['entry-0000001']);
    // The game of the stale entry was cancelled through the participant
    // command route, with the token of the account that owns the seat.
    expect(service.commands).toHaveLength(1);
    expect(service.commands[0]?.action).toEqual({ kind: 'cancel' });
    const commandWire = wires.find(wire => wire.path.endsWith('/commands'));
    expect(commandWire?.headers.authorization).toBe('Bearer token-account-1');
    // The obligation is discharged: nothing is left behind the owner's back.
    expect(intentsOf(storage, 'account:account-1')).toHaveLength(0);
    composition.dispose();
  });
});

/**
 * An account session the test hands over.
 *
 * Every account has a token of its own, so a wire of one account is never
 * confused with a wire of another one. The session keeps every listener, so
 * the participant session of the composition and the composition itself both
 * see the handover.
 */
function handoverAccountSession(): {
  readonly session: NonNullable<Parameters<typeof createOnlineComposition>[0]['accountSession']>;
  switchTo(accountId: string | null): void;
} {
  type Identity = { readonly accountId: string; readonly token: () => Promise<string> };
  const listeners = new Set<(identity: Identity | null) => void>();
  let current: Identity | null = { accountId: 'account-1', token: async () => 'token-account-1' };
  return {
    session: {
      get identity() { return current; },
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    switchTo(accountId) {
      current = accountId === null
        ? null
        : { accountId, token: async () => `token-${accountId}` };
      for (const listener of [...listeners]) listener(current);
    },
  };
}

/**
 * The runner of a fenced identity never runs again (ARC-05, ARC-08).
 *
 * The browser owns the provider request of an agent seat, so a request of the
 * previous identity may not keep running after the identity left, and its
 * answer may never become a move. The cases below hold the provider request
 * of a running runner, fence the identity or the composition, and watch the
 * request and the lease of the seat.
 */
describe('the runner of a fenced identity never runs again (ARC-05, ARC-08)', () => {
  /** The moves the service received. */
  function submittedMoves(state: AgentServiceState): Array<Record<string, unknown>> {
    return state.commands.filter(command => {
      const action = command.action as { kind?: string } | undefined;
      return action?.kind === 'submit_move';
    });
  }

  /** A composition with one owned agent seat and a held provider request. */
  function agentComposition(state: AgentServiceState, session: ReturnType<typeof handoverAccountSession>): {
    readonly composition: OnlineComposition;
    readonly provider: ReturnType<typeof heldProviderFixture>;
  } {
    const provider = heldProviderFixture();
    const selection = selectionOf('c1', 'm1');
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: agentServiceDouble(state),
      storage: createStorage(),
      accountSession: session.session,
      connectionStore: connectionStoreOf([{ id: 'c1' }]).store,
    });
    composition.setAgentCatalog([{ id: 'private-a', label: 'Custom model', selection }]);
    composition.setAgent({ label: 'Custom model', selection });
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-fence-1',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, selection);
    return { composition, provider };
  }

  it('stops the provider request of the previous identity when another account signs in', async () => {
    const state = serviceState();
    state.mode = 'online';
    const identity = handoverAccountSession();
    const { composition, provider } = agentComposition(state, identity);
    await until(
      () => composition.agentRunnerState('match-00000001', 'white') !== null,
      'the runner of the seat',
    );
    await until(() => provider.requests.length > 0, 'the provider is asked');

    // The provider request is held: it never answers until the test releases
    // it, so the identity change happens while it is on the wire.
    expect(provider.requests[0]?.signal?.aborted).toBe(false);
    expect(submittedMoves(state)).toHaveLength(0);

    // Another account signs in. The work of the previous identity is fenced.
    identity.switchTo('account-2');
    await settle();

    // The provider request of the previous identity is stopped.
    expect(provider.requests[0]?.signal?.aborted).toBe(true);
    // The runner of the previous identity is gone.
    expect(composition.agentRunnerState('match-00000001', 'white')).toBeNull();
    // The lease of the seat is given back.
    await until(() => state.releases > 0, 'the lease of the seat is released');

    // The answer of the stopped request never becomes a move.
    provider.release();
    await settle();
    await settle();
    expect(submittedMoves(state)).toHaveLength(0);
    // The new identity never asks the provider with the private model of the
    // previous one.
    expect(provider.requests).toHaveLength(1);
    composition.dispose();
    provider.restore();
  }, 20_000);

  it('stops the provider request of a runner when the composition is disposed', async () => {
    const state = serviceState();
    state.mode = 'online';
    const identity = handoverAccountSession();
    const { composition, provider } = agentComposition(state, identity);
    await until(
      () => composition.agentRunnerState('match-00000001', 'white') !== null,
      'the runner of the seat',
    );
    await until(() => provider.requests.length > 0, 'the provider is asked');
    expect(provider.requests[0]?.signal?.aborted).toBe(false);

    // The composition is disposed while the provider request is on the wire.
    await composition.disposeAsync();

    // The provider request is stopped, and the runner is gone.
    expect(provider.requests[0]?.signal?.aborted).toBe(true);
    expect(composition.agentRunnerState('match-00000001', 'white')).toBeNull();
    // The lease of the seat is given back with the transport of the
    // composition, before that transport goes away.
    expect(state.releases).toBeGreaterThan(0);

    // The answer of the stopped request never becomes a move.
    provider.release();
    await settle();
    await settle();
    expect(submittedMoves(state)).toHaveLength(0);
    provider.restore();
  }, 20_000);

  it('stops the runner of a suspended composition and plays the seat again after the resume', async () => {
    const state = serviceState();
    state.mode = 'online';
    const identity = handoverAccountSession();
    const { composition, provider } = agentComposition(state, identity);
    await until(
      () => composition.agentRunnerState('match-00000001', 'white') !== null,
      'the runner of the seat',
    );
    await until(() => provider.requests.length > 0, 'the provider is asked');

    // The composition is suspended while the provider request is on the wire.
    composition.suspend();
    await settle();

    // The provider request is stopped, and the runner is gone.
    expect(provider.requests[0]?.signal?.aborted).toBe(true);
    expect(composition.agentRunnerState('match-00000001', 'white')).toBeNull();
    // The lease of the seat is given back, so the seat is free for the
    // runner of the resumed composition.
    await until(() => state.releases > 0, 'the lease of the seat is released');

    // The resumed composition plays the seat again, with a runner of its own.
    composition.resume();
    await until(
      () => composition.agentRunnerState('match-00000001', 'white') !== null,
      'the runner of the resumed composition',
    );
    await settle();
    // The uncertain work of the stopped request is never repeated by itself,
    // so the runner of the resumed composition waits for the decision of the
    // owner instead of asking the provider again.
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.signal?.aborted).toBe(true);
    composition.dispose();
    provider.restore();
  }, 20_000);
});

/**
 * The runner of a tab is its own (ARC-08).
 *
 * The lease of a seat is held by one runner, and the service refuses a second
 * runner of a seat that a live lease holds. The browser therefore mints the
 * identity of the runner per tab: two tabs of one owner run two runners, and
 * the duplicate tab is refused by the service instead of being taken for the
 * holder of the lease. An identity that two tabs share would let both tabs
 * drive the same agent seat and ask the provider twice.
 */
describe('the runner of a tab is its own (ARC-08)', () => {
  /** The moves the service received. */
  function submittedMoves(state: AgentServiceState): Array<Record<string, unknown>> {
    return state.commands.filter(command => {
      const action = command.action as { kind?: string } | undefined;
      return action?.kind === 'submit_move';
    });
  }

  /**
   * One tab of the owner.
   *
   * The tab owns the agent seat of the match and drives it with the private
   * selection of the owner. Two tabs of one owner share the storage of the
   * browser and the account of the owner.
   */
  function tab(
    state: AgentServiceState,
    storage: Storage,
    session: ReturnType<typeof accountSession>,
    connections: ReturnType<typeof connectionStoreOf>,
  ): OnlineComposition {
    const selection = selectionOf('c1', 'm1');
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: agentServiceDouble(state),
      storage,
      accountSession: session,
      connectionStore: connections.store,
    });
    composition.setAgentCatalog([{ id: 'private-a', label: 'Custom model', selection }]);
    composition.setAgent({ label: 'Custom model', selection });
    composition.attachAndFocus('match-00000001', 'white', {
      kind: 'guest',
      guestId: 'guest-tab-1',
      matchId: 'match-00000001',
      seat: 'white',
      issue: async () => 'guest-token',
    }, selection);
    return composition;
  }

  it('gives two tabs of one owner two runner identities and leaves the seat with one of them', async () => {
    const state = serviceState();
    state.mode = 'online';
    const provider = heldProviderFixture();
    const storage = createStorage();
    const session = accountSession();
    const connections = connectionStoreOf([{ id: 'c1' }]);
    const first = tab(state, storage, session, connections);
    const second = tab(state, storage, session, connections);
    await until(
      () => first.agentRunnerState('match-00000001', 'white') !== null,
      'the runner of the first tab',
    );
    await until(
      () => second.agentRunnerState('match-00000001', 'white') !== null,
      'the runner of the second tab',
    );
    await until(() => provider.requests.length > 0, 'the provider is asked');
    await until(
      () => [first, second].some(composition => composition.agentRunnerState('match-00000001', 'white')?.phase === 'waiting-lease'),
      'the duplicate tab stands down',
    );

    // The two tabs of the owner run two runners: the identity of a runner is
    // the identity of its tab, so the service can tell them apart.
    const identities = new Set(state.leaseRequests.map(request => request.runnerId));
    expect(identities.size).toBe(2);

    // The service gave the lease of the seat to one of the two runners, and it
    // refused the other one: a live lease of another runner is refused.
    const holder = state.leaseRunnerId;
    expect(holder).not.toBeNull();
    const refused = state.leaseRequests.filter(request => request.runnerId !== holder);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every(request => request.action === 'acquire')).toBe(true);

    // The runner that holds the lease asks the provider, and the runner of the
    // duplicate tab stands down instead of driving the seat a second time.
    const phases = [first, second].map(composition => composition.agentRunnerState('match-00000001', 'white')?.phase);
    expect(phases.filter(phase => phase === 'generating')).toHaveLength(1);
    expect(phases.filter(phase => phase === 'waiting-lease')).toHaveLength(1);
    // The duplicate tab never asked the provider and never submitted a move.
    expect(provider.requests).toHaveLength(1);
    expect(submittedMoves(state)).toHaveLength(0);

    provider.release();
    first.dispose();
    second.dispose();
    provider.restore();
  }, 20_000);

  it('keeps the identity of the runner of a seat while it works', async () => {
    const state = serviceState();
    state.mode = 'online';
    const provider = heldProviderFixture();
    const storage = createStorage();
    const connections = connectionStoreOf([{ id: 'c1' }]);
    const composition = tab(state, storage, accountSession(), connections);
    await until(
      () => composition.agentRunnerState('match-00000001', 'white') !== null,
      'the runner of the seat',
    );
    await until(() => provider.requests.length > 0, 'the provider is asked');
    await until(
      () => state.leaseRequests.some(request => request.action === 'renew'),
      'the lease of the seat is renewed',
    );

    // Every request of the runner names the same runner: the runner keeps the
    // lease it took while it renews it and while it records its request.
    const identities = new Set(state.leaseRequests.map(request => request.runnerId));
    expect(identities.size).toBe(1);
    const identity = [...identities][0] ?? '';
    expect(identity).toContain('match-00000001');
    expect(identity).toContain('white');

    // The tab gives the lease back and takes a new one when it plays the seat
    // again, and the identity of the runner of the seat does not change.
    composition.suspend();
    await until(
      () => state.leaseRequests.some(request => request.action === 'release'),
      'the lease of the seat is given back',
    );
    composition.resume();
    await until(
      () => state.leaseRequests.filter(request => request.action === 'acquire').length >= 2,
      'the runner takes a new lease',
    );
    expect(new Set(state.leaseRequests.map(request => request.runnerId)).size).toBe(1);
    composition.dispose();
    provider.restore();
  }, 20_000);
});
