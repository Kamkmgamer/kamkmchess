import { describe, expect, it } from 'vitest';
import { onlineSeatToMove, onlineSideToMove } from './turn';
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

describe('the turn of an online match (B-1)', () => {
  it('belongs to the side the canonical position names before the first move', () => {
    const view = matchView();
    expect(onlineSideToMove(view)).toBe('white');
    expect(onlineSeatToMove(view, 'white')).toBe(true);
    expect(onlineSeatToMove(view, 'black')).toBe(false);
  });

  it('belongs to the seat that owes the opening reply', () => {
    const view = matchView({
      positionFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      clock: { ...matchView().clock, replySeat: 'black', replyDeadlineAt: '2026-10-21T10:00:15.000Z' },
    });
    expect(onlineSideToMove(view)).toBe('black');
    expect(onlineSeatToMove(view, 'black')).toBe(true);
    expect(onlineSeatToMove(view, 'white')).toBe(false);
  });

  it('follows the active seat once the main clock runs', () => {
    const view = matchView({
      clock: { ...matchView().clock, activeSeat: 'black', activeSince: '2026-10-21T10:00:00.000Z' },
    });
    expect(onlineSideToMove(view)).toBe('black');
  });

  it('follows a custom position that starts with Black', () => {
    const view = matchView({
      startingFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      positionFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    });
    expect(onlineSideToMove(view)).toBe('black');
  });

  it('has no side to move in a finished match', () => {
    const view = matchView({ status: 'completed', result: { kind: 'win', winner: 'white', reason: 'checkmate' } });
    expect(onlineSideToMove(view)).toBeNull();
    expect(onlineSeatToMove(view, 'white')).toBe(false);
  });
});
