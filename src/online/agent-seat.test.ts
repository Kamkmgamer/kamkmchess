import { describe, expect, it } from 'vitest';
import { providerRunnerSnapshot } from './agent-seat';
import { onlineSideToMove } from './turn';
import type { OnlineMatchView } from './updates';

function matchView(overrides: Partial<OnlineMatchView> = {}): OnlineMatchView {
  return {
    schemaVersion: 2,
    matchId: 'match-00000001',
    variant: 'orthodox',
    startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    positionFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
    version: 1,
    controlEpoch: 4,
    rulesPolicyVersion: 'online-rules/1',
    status: 'active',
    result: null,
    seats: [
      { seat: 'white', publicLabel: 'Owner', control: { kind: 'agent', modelLabel: 'GPT-4o' }, controlEpoch: 9, illegalAttemptsSpent: 1, formatCorrectionsSpent: 2 },
      { seat: 'black', publicLabel: 'Opponent', control: { kind: 'human' }, controlEpoch: 3, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ],
    clock: {
      whiteMs: 300_000,
      blackMs: 300_000,
      // The service arms no main clock before the first move.
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

describe('the state of the agent runner (KHA-73)', () => {
  it('carries the canonical seat epoch, the spent budgets and the declared control', () => {
    const snapshot = providerRunnerSnapshot(matchView(), 'white');
    expect(snapshot.seatControlEpoch).toBe(9);
    expect(snapshot.controlEpoch).toBe(4);
    expect(snapshot.illegalAttemptsSpent).toBe(1);
    expect(snapshot.formatCorrectionsSpent).toBe(2);
    expect(snapshot.seatControl).toEqual({ kind: 'agent', modelLabel: 'GPT-4o' });
  });

  it('runs the first move of a match, whose clock is not armed yet', () => {
    const view = matchView();
    expect(view.clock.activeSeat).toBeNull();
    const snapshot = providerRunnerSnapshot(view, 'white');
    expect(snapshot.sideToMove).toBe('white');
    expect(snapshot.sideToMove).toBe(onlineSideToMove(view));
  });

  it('runs the opening reply of the seat that owes it', () => {
    const view = matchView({
      positionFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      clock: { ...matchView().clock, replySeat: 'white', replyDeadlineAt: '2026-10-21T10:00:15.000Z' },
    });
    const snapshot = providerRunnerSnapshot(view, 'white');
    expect(snapshot.sideToMove).toBe('white');
    expect(snapshot.sideToMove).toBe(onlineSideToMove(view));
  });

  it('follows the active seat once the clock runs', () => {
    const view = matchView({
      clock: { ...matchView().clock, activeSeat: 'black', activeSince: '2026-10-21T10:00:00.000Z' },
    });
    expect(providerRunnerSnapshot(view, 'white').sideToMove).toBe('black');
  });
});
