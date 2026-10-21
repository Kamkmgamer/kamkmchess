import { describe, expect, it, vi } from 'vitest';
import { createOnlineQueueController } from './readiness';
import type { OnlineQueueAssignment, OnlineQueueController, OnlineQueuePorts, OnlineQueueTimers } from './readiness';
import type { QueueEntry, SeatControl, TimeControl } from './contracts';
import type { OnlineMatchView } from './updates';

const timeControl: TimeControl = { startingTimeMs: 300_000, incrementMs: 2_000 };
const agentControl: SeatControl = { kind: 'agent', modelLabel: 'Test Model' };

/** Lets every pending microtask and timer callback settle. */
function tick(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    schemaVersion: 2,
    entryId: 'entry-0000001',
    owner: { kind: 'account', id: 'account-1' },
    control: agentControl,
    timeControl,
    status: 'waiting',
    version: 1,
    readyAt: '2026-10-21T10:00:00.000Z',
    cutoffAt: '2026-10-21T10:00:10.000Z',
    assignedMatchId: null,
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

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
      { seat: 'black', publicLabel: 'Opponent', control: { kind: 'agent', modelLabel: 'Test Model' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
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

const assignment: OnlineQueueAssignment = {
  matchId: 'match-00000001',
  seat: 'black',
  opponentLabel: 'Opponent',
  control: { kind: 'agent', modelLabel: 'Test Model' },
};

interface Harness {
  readonly controller: OnlineQueueController;
  readonly ports: {
    checkAgent: ReturnType<typeof vi.fn<(control: SeatControl) => Promise<{ ready: boolean; detail: string }>>>;
    prepareEngine: ReturnType<typeof vi.fn<() => Promise<void>>>;
    acceptReady: ReturnType<typeof vi.fn<(request: { control: SeatControl; timeControl: TimeControl }) => Promise<QueueEntry>>>;
    readEntry: ReturnType<typeof vi.fn<(entryId: string) => Promise<QueueEntry>>>;
    readyEntry: ReturnType<typeof vi.fn<(entryId: string) => Promise<QueueEntry>>>;
    readMatch: ReturnType<typeof vi.fn<(matchId: string) => Promise<OnlineMatchView>>>;
    cancelEntry: ReturnType<typeof vi.fn<(entryId: string) => Promise<QueueEntry>>>;
    keepSearching: ReturnType<typeof vi.fn<(entryId: string) => Promise<QueueEntry>>>;
    findCompatibleEntry: ReturnType<typeof vi.fn<(entryId: string) => Promise<OnlineQueueAssignment | null>>>;
    commitFallback: ReturnType<typeof vi.fn<(entryId: string) => Promise<OnlineQueueAssignment>>>;
  };
  /** Fires the armed cutoff timer. */
  fireCutoff(): void;
}

function createHarness(overrides: Partial<OnlineQueuePorts> = {}): Harness {
  const scheduled: { callback: () => void; delay: number }[] = [];
  const timers: OnlineQueueTimers = {
    setTimer(callback, delayMs) {
      scheduled.push({ callback, delay: delayMs });
      return scheduled.length - 1;
    },
    clearTimer(handle) {
      const index = handle as number;
      if (index >= 0 && index < scheduled.length) scheduled[index] = { callback: () => undefined, delay: 0 };
    },
  };
  const ports = {
    checkAgent: vi.fn<(control: SeatControl) => Promise<{ ready: boolean; detail: string }>>(async () => ({ ready: true, detail: '' })),
    prepareEngine: vi.fn<() => Promise<void>>(async () => undefined),
    acceptReady: vi.fn<(request: { control: SeatControl; timeControl: TimeControl }) => Promise<QueueEntry>>(async () => entry()),
    readEntry: vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => entry()),
    readyEntry: vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => entry()),
    readMatch: vi.fn<(matchId: string) => Promise<OnlineMatchView>>(async () => matchView()),
    cancelEntry: vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => entry({ status: 'cancelled' })),
    keepSearching: vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => entry({ cutoffAt: null })),
    findCompatibleEntry: vi.fn<(entryId: string) => Promise<OnlineQueueAssignment | null>>(async () => null),
    commitFallback: vi.fn<(entryId: string) => Promise<OnlineQueueAssignment>>(async () => assignment),
    ...overrides,
  };
  const controller = createOnlineQueueController({
    ports: ports as unknown as OnlineQueuePorts,
    timers,
    now: () => Date.parse('2026-10-21T10:00:00.000Z'),
  });
  return {
    controller,
    ports: ports as unknown as Harness['ports'],
    fireCutoff() {
      const pending = scheduled.filter(item => item.delay > 0);
      const last = pending[pending.length - 1];
      if (last) last.callback();
    },
  };
}

describe('own-agent readiness blocks the entry (QUE-05, QUE-06)', () => {
  it('checks the agent before the entry exists, so no search time elapses during the check', async () => {
    const order: string[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const checkAgent = vi.fn<(control: SeatControl) => Promise<{ ready: boolean; detail: string }>>(async () => {
      order.push('check-start');
      await new Promise<void>(resolve => { gate.release = resolve; });
      order.push('check-end');
      return { ready: true, detail: '' };
    });
    const acceptReady = vi.fn<(request: { control: SeatControl; timeControl: TimeControl }) => Promise<QueueEntry>>(async () => {
      order.push('accept');
      return entry();
    });
    const harness = createHarness({ checkAgent, acceptReady });
    const pending = harness.controller.enter({ control: agentControl, timeControl });
    expect(order).toEqual(['check-start']);
    expect(harness.ports.acceptReady).not.toHaveBeenCalled();
    gate.release?.();
    await pending;
    expect(order).toEqual(['check-start', 'check-end', 'accept']);
    expect(harness.controller.state.phase).toBe('searching');
  });

  it('blocks the entry when the agent check fails and offers Retry or Play yourself', async () => {
    const checkAgent = vi.fn<(control: SeatControl) => Promise<{ ready: boolean; detail: string }>>(async () => ({ ready: false, detail: 'The model connection failed.' }));
    const harness = createHarness({ checkAgent });
    await harness.controller.enter({ control: agentControl, timeControl });
    expect(harness.controller.state.phase).toBe('agent-failed');
    expect(harness.controller.state.detail).toBe('The model connection failed.');
    expect(harness.controller.state.options).toContain('retry');
    expect(harness.controller.state.options).toContain('play-yourself');
    expect(harness.ports.acceptReady).not.toHaveBeenCalled();
  });

  it('replaces the agent seat with a human seat only on an explicit Play yourself', async () => {
    const checkAgent = vi.fn<(control: SeatControl) => Promise<{ ready: boolean; detail: string }>>(async () => ({ ready: false, detail: 'failed' }));
    const acceptReady = vi.fn<(request: { control: SeatControl; timeControl: TimeControl }) => Promise<QueueEntry>>(async () => entry({ control: { kind: 'human' } }));
    const harness = createHarness({ checkAgent, acceptReady });
    await harness.controller.enter({ control: agentControl, timeControl });
    await harness.controller.playYourself();
    expect(acceptReady).toHaveBeenCalledWith({ control: { kind: 'human' }, timeControl });
    expect(harness.controller.state.phase).toBe('searching');
  });
});

describe('engine preparation never blocks the search (QUE-12)', () => {
  it('keeps searching when the engine preparation fails', async () => {
    const prepareEngine = vi.fn<() => Promise<void>>(async () => { throw new Error('The engine download failed.'); });
    const harness = createHarness({ prepareEngine });
    await harness.controller.enter({ control: agentControl, timeControl });
    expect(harness.controller.state.phase).toBe('searching');
    expect(harness.controller.state.engineState).toBe('failed');
  });

  it('offers Retry and Keep searching when the cutoff arrives without an engine', async () => {
    const prepareEngine = vi.fn<() => Promise<void>>(async () => { throw new Error('The engine download failed.'); });
    const harness = createHarness({ prepareEngine });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    await tick();
    expect(harness.controller.state.phase).toBe('engine-unavailable');
    expect(harness.controller.state.options).toContain('retry');
    expect(harness.controller.state.options).toContain('keep-searching');
  });

  it('offers Retry while the engine is still preparing at the cutoff', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const prepareEngine = vi.fn<() => Promise<void>>(async () => {
      await new Promise<void>(resolve => { gate.release = resolve; });
    });
    const harness = createHarness({ prepareEngine });
    await harness.controller.enter({ control: agentControl, timeControl });
    expect(harness.controller.state.engineState).toBe('preparing');
    harness.fireCutoff();
    await tick();
    expect(harness.controller.state.phase).toBe('engine-unavailable');
    expect(harness.controller.state.options).toContain('retry');
    gate.release?.();
  });

  it('commits the Stockfish fallback at the cutoff when the engine is ready', async () => {
    const harness = createHarness();
    await harness.controller.enter({ control: agentControl, timeControl });
    expect(harness.controller.state.engineState).toBe('ready');
    harness.fireCutoff();
    await tick();
    expect(harness.ports.commitFallback).toHaveBeenCalledTimes(1);
    expect(harness.controller.state.phase).toBe('matched');
    expect(harness.controller.state.assignment?.matchId).toBe('match-00000001');
    expect(harness.controller.state.assignment?.seat).toBe('black');
  });

  it('prefers a compatible candidate at the cutoff over the engine fallback', async () => {
    const findCompatibleEntry = vi.fn<(entryId: string) => Promise<OnlineQueueAssignment | null>>(async () => assignment);
    const harness = createHarness({ findCompatibleEntry });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    await tick();
    expect(harness.ports.commitFallback).not.toHaveBeenCalled();
    expect(harness.controller.state.phase).toBe('matched');
  });
});

describe('Retry and Keep searching (QUE-12, QUE-13)', () => {
  it('readies the engine and checks for a compatible entry before the fallback', async () => {
    let engineReady = false;
    const prepareEngine = vi.fn<() => Promise<void>>(async () => {
      if (!engineReady) throw new Error('The engine download failed.');
    });
    const harness = createHarness({ prepareEngine });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    await tick();
    expect(harness.controller.state.phase).toBe('engine-unavailable');
    expect(harness.ports.commitFallback).not.toHaveBeenCalled();
    engineReady = true;
    await harness.controller.retry();
    expect(harness.ports.prepareEngine).toHaveBeenCalledTimes(2);
    // One check at the cutoff and one more at the retry.
    expect(harness.ports.findCompatibleEntry).toHaveBeenCalledTimes(2);
    expect(harness.ports.commitFallback).toHaveBeenCalledTimes(1);
    expect(harness.controller.state.phase).toBe('matched');
  });

  it('keeps the compatible candidate found by the retry instead of the fallback', async () => {
    let engineReady = false;
    const prepareEngine = vi.fn<() => Promise<void>>(async () => {
      if (!engineReady) throw new Error('The engine download failed.');
    });
    const findCompatibleEntry = vi.fn<(entryId: string) => Promise<OnlineQueueAssignment | null>>(async () => null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(assignment);
    const harness = createHarness({ prepareEngine, findCompatibleEntry });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    await tick();
    expect(harness.controller.state.phase).toBe('engine-unavailable');
    engineReady = true;
    await harness.controller.retry();
    expect(harness.ports.commitFallback).not.toHaveBeenCalled();
    expect(harness.controller.state.phase).toBe('matched');
    expect(harness.controller.state.assignment?.matchId).toBe('match-00000001');
  });

  it('removes the cutoff explicitly when the owner keeps searching', async () => {
    const harness = createHarness();
    await harness.controller.enter({ control: agentControl, timeControl });
    await harness.controller.keepSearching();
    expect(harness.ports.keepSearching).toHaveBeenCalledWith('entry-0000001');
    expect(harness.controller.state.cutoffAt).toBeNull();
    expect(harness.controller.state.phase).toBe('searching');
  });
});

describe('the committed opponent is fixed (QUE-13)', () => {
  it('keeps the first assignment when a late fallback arrives', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const commitFallback = vi.fn<(entryId: string) => Promise<OnlineQueueAssignment>>(async () => {
      await new Promise<void>(resolve => { gate.release = resolve; });
      return assignment;
    });
    const harness = createHarness({ commitFallback });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    // While the fallback is pending the service assigns a different match.
    harness.controller.observe(entry({ status: 'assigned', assignedMatchId: 'match-00000002' }));
    await tick();
    gate.release?.();
    await tick();
    expect(harness.controller.state.phase).toBe('matched');
    expect(harness.controller.state.assignment?.matchId).toBe('match-00000002');
  });

  it('never moves a matched entry back into a search', async () => {
    const harness = createHarness();
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    await tick();
    expect(harness.controller.state.phase).toBe('matched');
    harness.controller.observe(entry({ status: 'waiting', readyAt: null }));
    expect(harness.controller.state.phase).toBe('matched');
  });
});

describe('a lost answer never creates a second game (F-12)', () => {
  it('adopts the assignment the service committed when the fallback answer was lost', async () => {
    const commitFallback = vi.fn<(entryId: string) => Promise<OnlineQueueAssignment>>(async () => {
      throw new Error('The answer was lost.');
    });
    const readEntry = vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => entry({
      status: 'assigned',
      assignedMatchId: 'match-00000007',
    }));
    const harness = createHarness({ commitFallback, readEntry });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    await tick();
    // The service committed the assignment; the browser learns it from the
    // entry and never commits a second game.
    expect(harness.controller.state.phase).toBe('matched');
    expect(harness.controller.state.assignment?.matchId).toBe('match-00000007');
    expect(harness.ports.commitFallback).not.toHaveBeenCalled();
  });

  it('re-reads the entry before a retry commits a second fallback', async () => {
    let engineReady = false;
    const prepareEngine = vi.fn<() => Promise<void>>(async () => {
      if (!engineReady) throw new Error('The engine download failed.');
    });
    let assigned = false;
    const readEntry = vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => (assigned
      ? entry({ status: 'assigned', assignedMatchId: 'match-00000008' })
      : entry()));
    const harness = createHarness({ prepareEngine, readEntry });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    await tick();
    expect(harness.controller.state.phase).toBe('engine-unavailable');
    // The service committed the fallback while the browser was away.
    assigned = true;
    engineReady = true;
    await harness.controller.retry();
    // The entry was already assigned: no second fallback is committed.
    expect(harness.ports.commitFallback).not.toHaveBeenCalled();
    expect(harness.controller.state.phase).toBe('matched');
    expect(harness.controller.state.assignment?.matchId).toBe('match-00000008');
  });
});

describe('a refused cancellation keeps the committed opponent (F-13)', () => {
  it('does not report a cancelled entry when the service refuses', async () => {
    const cancelEntry = vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => {
      throw new Error('The entry is already assigned.');
    });
    const harness = createHarness({ cancelEntry });
    await harness.controller.enter({ control: agentControl, timeControl });
    await harness.controller.cancel();
    expect(harness.controller.state.phase).not.toBe('cancelled');
    expect(harness.controller.state.detail).toContain('could not be cancelled');
  });

  it('adopts the assignment when the refused cancellation hid one', async () => {
    const cancelEntry = vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => {
      throw new Error('The entry is already assigned.');
    });
    const readEntry = vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => entry({
      status: 'assigned',
      assignedMatchId: 'match-00000009',
    }));
    const harness = createHarness({ cancelEntry, readEntry });
    await harness.controller.enter({ control: agentControl, timeControl });
    await harness.controller.cancel();
    expect(harness.controller.state.phase).toBe('matched');
    expect(harness.controller.state.assignment?.matchId).toBe('match-00000009');
  });

  it('reports a cancelled entry only when the service confirms it', async () => {
    const harness = createHarness();
    await harness.controller.enter({ control: agentControl, timeControl });
    await harness.controller.cancel();
    expect(harness.controller.state.phase).toBe('cancelled');
  });
});

describe('the assignment is authoritative (QUE-11, F-19)', () => {
  it('reads the seat, the label and the declared control from the participant view', async () => {
    const readMatch = vi.fn<(matchId: string) => Promise<OnlineMatchView>>(async () => matchView({
      yourSeat: 'black',
      seats: [
        { seat: 'white', publicLabel: 'Opponent', control: { kind: 'engine', modelLabel: 'Stockfish 19 Lite' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
        { seat: 'black', publicLabel: 'Owner', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      ],
    }));
    const harness = createHarness({ readMatch });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.controller.observe(entry({ status: 'assigned', assignedMatchId: 'match-00000009' }));
    await tick();
    expect(harness.controller.state.phase).toBe('matched');
    expect(harness.controller.state.assignment?.seat).toBe('black');
    expect(harness.controller.state.assignment?.opponentLabel).toBe('Opponent');
    expect(harness.controller.state.assignment?.control).toEqual({ kind: 'engine', modelLabel: 'Stockfish 19 Lite' });
  });

  it('never declares an opponent control the view does not name', async () => {
    const readMatch = vi.fn<(matchId: string) => Promise<OnlineMatchView>>(async () => matchView({
      yourSeat: 'white',
      seats: [
        { seat: 'white', publicLabel: 'Owner', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      ],
    }));
    const harness = createHarness({ readMatch });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.controller.observe(entry({ status: 'assigned', assignedMatchId: 'match-00000010' }));
    await tick();
    expect(harness.controller.state.phase).toBe('matched');
    expect(harness.controller.state.assignment?.control).toBeNull();
  });

  it('does not start a search or prepare the engine for an entry that was assigned at once', async () => {
    const acceptReady = vi.fn<(request: { control: SeatControl; timeControl: TimeControl }) => Promise<QueueEntry>>(async () => entry({ status: 'assigned', assignedMatchId: 'match-00000003' }));
    const harness = createHarness({ acceptReady });
    await harness.controller.enter({ control: agentControl, timeControl });
    expect(harness.ports.prepareEngine).not.toHaveBeenCalled();
    expect(harness.controller.state.phase).toBe('matched');
  });
});

describe('cancelling while the entry is being created (MAT-02)', () => {
  it('cleans the late entry up and stays cancelled', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const acceptReady = vi.fn<(request: { control: SeatControl; timeControl: TimeControl }) => Promise<QueueEntry>>(async () => {
      await new Promise<void>(resolve => { gate.release = resolve; });
      return entry();
    });
    const harness = createHarness({ acceptReady });
    const pending = harness.controller.enter({ control: agentControl, timeControl });
    await tick();
    await harness.controller.cancel();
    expect(harness.controller.state.phase).toBe('cancelled');
    gate.release?.();
    await pending;
    await tick();
    expect(harness.ports.cancelEntry).toHaveBeenCalledWith('entry-0000001');
    expect(harness.controller.state.phase).toBe('cancelled');
  });
});

describe('an expired entry needs an explicit rejoin (QUE-07)', () => {
  it('reports the expiry and rejoins with a fresh window', async () => {
    const acceptReady = vi.fn<(request: { control: SeatControl; timeControl: TimeControl }) => Promise<QueueEntry>>(async () => entry());
    const readyEntry = vi.fn<(entryId: string) => Promise<QueueEntry>>(async () => entry({ readyAt: '2026-10-21T10:05:00.000Z', cutoffAt: '2026-10-21T10:05:10.000Z' }));
    const harness = createHarness({ acceptReady, readyEntry });
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.controller.observe(entry({ status: 'waiting', readyAt: null }));
    expect(harness.controller.state.phase).toBe('expired');
    expect(harness.controller.state.options).toContain('rejoin');
    await harness.controller.rejoin();
    // The service re-arms the entry instead of creating a second one.
    expect(harness.ports.readyEntry).toHaveBeenCalledWith('entry-0000001');
    expect(acceptReady).toHaveBeenCalledTimes(1);
    expect(harness.controller.state.phase).toBe('searching');
  });
});

describe('the owner always leaves an entry (B-9, B-14)', () => {
  it('offers a cancel while the agent check runs', () => {
    const harness = createHarness();
    expect(harness.controller.state.options).toEqual([]);
    expect(harness.controller.state.phase).toBe('idle');
  });

  it('reports an accepted entry that is not ready as expired', async () => {
    const acceptReady = vi.fn<(request: { control: SeatControl; timeControl: TimeControl }) => Promise<QueueEntry>>(async () => entry({ readyAt: null, cutoffAt: null }));
    const harness = createHarness({ acceptReady });
    await harness.controller.enter({ control: agentControl, timeControl });
    expect(harness.controller.state.phase).toBe('expired');
    expect(harness.controller.state.options).toContain('rejoin');
    expect(harness.controller.state.options).toContain('cancel');
  });

  it('never lets a late cancellation replace a committed opponent', async () => {
    const harness = createHarness();
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    await tick();
    expect(harness.controller.state.phase).toBe('matched');
    harness.controller.observe(entry({ status: 'cancelled' }));
    expect(harness.controller.state.phase).toBe('matched');
  });
});

describe('the controller adopts an entry that the browser already owns (R6-01)', () => {
  it('resumes the search of the entry with the cutoff the service gave it', () => {
    const harness = createHarness();
    harness.controller.adopt(entry({ entryId: 'entry-0000002', cutoffAt: '2026-10-21T10:00:10.000Z' }));
    // The entry is the same canonical entry, so the search continues with
    // its original cutoff.
    expect(harness.controller.state.phase).toBe('searching');
    expect(harness.controller.state.entry?.entryId).toBe('entry-0000002');
    expect(harness.controller.state.cutoffAt).toBe('2026-10-21T10:00:10.000Z');
    // Nothing is created, and the fallback is never asked for.
    expect(harness.ports.acceptReady).not.toHaveBeenCalled();
    expect(harness.ports.commitFallback).not.toHaveBeenCalled();
  });

  it('prepares the engine of an adopted entry during the search', async () => {
    // The fallback of the service is the authoritative allocation of the
    // browser engine. The engine prepares during the search, exactly as it
    // does for an entry this browser created, and the cutoff of the entry
    // commits it.
    const harness = createHarness();
    harness.controller.adopt(entry({ entryId: 'entry-0000003' }));
    await tick();
    expect(harness.ports.prepareEngine).toHaveBeenCalled();
    // The engine is not committed before the cutoff of the entry.
    expect(harness.ports.commitFallback).not.toHaveBeenCalled();
  });

  it('restores the settings of the entry, so the explicit actions of the owner work again', async () => {
    // The entry carries the control and the clock it was created with. The
    // owner may act on it again after a reload.
    const harness = createHarness();
    harness.controller.adopt(entry({ entryId: 'entry-0000004', control: { kind: 'human' }, timeControl }));
    await harness.controller.playYourself();
    expect(harness.ports.acceptReady).toHaveBeenCalledTimes(1);
    expect(harness.ports.acceptReady.mock.calls[0]?.[0]).toEqual({ control: { kind: 'human' }, timeControl });
  });

  it('lets the owner rejoin the adopted entry instead of creating another one', async () => {
    const harness = createHarness();
    harness.controller.adopt(entry({ entryId: 'entry-0000005' }));
    await harness.controller.rejoin();
    // The same entry is re-armed, and no other entry is created.
    expect(harness.ports.readyEntry).toHaveBeenCalledWith('entry-0000005');
    expect(harness.ports.acceptReady).not.toHaveBeenCalled();
  });

  it('never replaces a committed opponent with an adopted entry', async () => {
    const harness = createHarness();
    await harness.controller.enter({ control: agentControl, timeControl });
    harness.fireCutoff();
    await tick();
    expect(harness.controller.state.phase).toBe('matched');
    harness.controller.adopt(entry({ entryId: 'entry-0000004', status: 'assigned', assignedMatchId: 'match-00000001' }));
    expect(harness.controller.state.assignment?.matchId).toBe('match-00000001');
  });
});
