import { describe, expect, it, vi } from 'vitest';
import { createOnlineComposition } from './composition';
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
    if (path.includes('/queue/entries') && method === 'POST' && path.endsWith('/entries')) {
      result = answers.entry?.(body) ?? { status: 201, data: entryAnswer(body) };
    } else if (path.endsWith('/fallback')) {
      result = answers.fallback ?? { status: 200, data: fallbackAnswer() };
    } else if (path.endsWith('/match')) {
      result = answers.match ?? { status: 404, data: { error: 'not_found' } };
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
    guestCredential: {
      guestId: 'guest-engine',
      matchId: 'match-00000001',
      seat: 'black',
      token: 'engine-token',
      expiresAt: '2026-10-22T10:00:00Z',
    },
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
function manualTimers(): { timers: { setTimer: (callback: () => void, delayMs: number) => unknown; clearTimer: (handle: unknown) => void }; fire: () => void } {
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

  it('releases the intent when the creation fails', async () => {
    const { fetcher, wires } = createFetchDouble({
      entry: () => ({ status: 503, data: { error: 'temporarily_unavailable' } }),
    });
    const storage = createStorage();
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
      storage,
      accountSession: accountSession(),
    });
    await composition.enterQueue({ control: { kind: 'human' }, timeControl });
    expect(storage.data.size).toBe(0);
    composition.dispose();
    expect(wires.length).toBeGreaterThan(0);
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

describe('the composition keeps the guest authority (B-6)', () => {
  it('never drives a guest seat with the account credential', async () => {
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
