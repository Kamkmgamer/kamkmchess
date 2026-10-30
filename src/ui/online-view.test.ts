import { describe, expect, it } from 'vitest';
import {
  onlineAppliedMoves,
  onlineConnectionText,
  onlineControlLabel,
  onlineGameTitle,
  onlinePositionFen,
  onlineResultText,
  onlineSeatRows,
  onlineStatusText,
} from './online-view';
import { onlineClockReading } from '../online/clock';
import type { OnlineMatchView } from '../online/updates';

function matchView(overrides: Partial<OnlineMatchView> = {}): OnlineMatchView {
  return {
    schemaVersion: 2,
    matchId: 'match-00000001',
    variant: 'orthodox',
    startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    positionFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
    version: 2,
    controlEpoch: 1,
    rulesPolicyVersion: 'online-rules/1',
    status: 'active',
    result: null,
    seats: [
      { seat: 'white', publicLabel: 'Alice', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      { seat: 'black', publicLabel: 'Stockfish 19 Lite', control: { kind: 'engine', modelLabel: 'Stockfish 19 Lite' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ],
    clock: {
      whiteMs: 300_000,
      blackMs: 300_000,
      activeSeat: 'black',
      activeSince: '2026-10-21T10:00:00.000Z',
      deadlineAt: null,
      whiteMoved: true,
      blackMoved: false,
      turnNumber: 1,
      replySeat: null,
      replyDeadlineAt: null,
    },
    moves: [{
      version: 1,
      seat: 'white',
      uci: 'e2e4',
      san: 'e4',
      resultingFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    }],
    pendingOffers: [],
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    completedAt: null,
    yourSeat: 'white',
    ...overrides,
  };
}

describe('the compact control labels (UX-06)', () => {
  it('names a human, an agent and the browser engine', () => {
    expect(onlineControlLabel({ kind: 'human' })).toBe('Human');
    expect(onlineControlLabel({ kind: 'agent', modelLabel: 'GPT-4o' })).toBe('Agent · GPT-4o');
    expect(onlineControlLabel({ kind: 'engine', modelLabel: 'Stockfish 19 Lite' })).toBe('Engine · Stockfish 19 Lite (browser)');
  });

  it('never invents a control the view does not name (B-10)', () => {
    expect(onlineControlLabel(null)).toBe('Unknown');
    const rows = onlineSeatRows(matchView({ seats: [
      { seat: 'white', publicLabel: 'Owner', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ] }), 'white');
    expect(rows[1]?.controlLabel).toBe('Unknown');
  });

  it('shows one compact label per seat and no separate declared-models list', () => {
    const rows = onlineSeatRows(matchView(), 'white');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ seat: 'white', label: 'Alice', controlLabel: 'Human', control: { kind: 'human' }, yours: true });
    expect(rows[1]).toEqual({
      seat: 'black', label: 'Stockfish 19 Lite', controlLabel: 'Engine · Stockfish 19 Lite (browser)',
      control: { kind: 'engine', modelLabel: 'Stockfish 19 Lite' }, yours: false,
    });
  });

  it('names the opponent of the focused match', () => {
    expect(onlineGameTitle(matchView(), 'white')).toBe('Stockfish 19 Lite · Engine · Stockfish 19 Lite (browser)');
  });
});

describe('the status and result lines', () => {
  it('names the side to move', () => {
    const view = matchView();
    const reading = onlineClockReading(view.clock, Date.parse('2026-10-21T10:00:00.000Z'));
    expect(onlineStatusText(view, reading)).toBe('Black to move.');
  });

  it('names the outstanding opening reply', () => {
    const view = matchView({
      clock: { ...matchView().clock, activeSeat: null, activeSince: null, replySeat: 'black', replyDeadlineAt: '2026-10-21T10:00:15.000Z' },
    });
    const reading = onlineClockReading(view.clock, Date.parse('2026-10-21T10:00:00.000Z'));
    expect(onlineStatusText(view, reading)).toBe('Black to reply.');
  });

  it('names a final result once', () => {
    const view = matchView({
      status: 'completed',
      result: { kind: 'win', winner: 'white', reason: 'checkmate' },
    });
    expect(onlineResultText(view)).toBe('White wins.');
    const reading = onlineClockReading(view.clock, Date.now());
    expect(onlineStatusText(view, reading)).toBe('White wins.');
  });

  it('names an abort without a scored result', () => {
    const view = matchView({ status: 'aborted', result: { kind: 'abort', winner: null, reason: 'abort' } });
    expect(onlineResultText(view)).toBe('Aborted.');
  });

  it('names the connection state of a suspended tab', () => {
    expect(onlineConnectionText('reconnecting')).toBe('Reconnecting…');
    expect(onlineConnectionText('live')).toBe('');
  });
});

describe('the accepted moves', () => {
  it('shapes the canonical moves for the shared move list', () => {
    const moves = onlineAppliedMoves(matchView());
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual({
      moveId: 'online-1',
      from: 'e2',
      to: 'e4',
      promotion: null,
      san: 'e4',
      fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      eventId: 'online-1',
    });
  });

  it('reads the position of a move number', () => {
    const view = matchView();
    expect(onlinePositionFen(view, 0)).toBe(view.startingFen);
    expect(onlinePositionFen(view, 1)).toBe(view.moves[0]!.resultingFen);
  });
});
