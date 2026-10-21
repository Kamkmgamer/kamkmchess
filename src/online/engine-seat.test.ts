import { describe, expect, it, vi } from 'vitest';

const search = vi.fn(async () => ({ move: 'e2e4', engineName: 'Stockfish 19', elapsedMs: 5 }));
vi.mock('../engines/browser', () => ({
  searchBrowserEngine: (...args: unknown[]) => search(...(args as [])),
}));

const { createOnlineEngineSeat, onlineSeatToMove } = await import('./engine-seat');
const { createGuestCredential } = await import('./auth');
const { createParticipantSession } = await import('./session');
const { createAuthorizedRequester } = await import('./request');
type OnlineMatchView = import('./updates').OnlineMatchView;

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
  readonly body: Record<string, unknown>;
}

function createSeat(respond: (wire: Wire) => { status: number; data: unknown }) {
  const session = createParticipantSession();
  session.selectGuest(createGuestCredential({
    guestId: 'guest-engine',
    matchId: 'match-00000001',
    seat: 'black',
    token: 'engine-token',
  }));
  const wires: Wire[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    wires.push({ path, body });
    const result = respond({ path, body });
    return new Response(JSON.stringify(result.data), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  });
  void createAuthorizedRequester({ session, baseUrl: 'https://api.example.test', fetch: fetcher as unknown as typeof fetch });
  const seat = createOnlineEngineSeat({
    matchId: 'match-00000001',
    seat: 'black',
    credential: {
      kind: 'guest',
      guestId: 'guest-engine',
      matchId: 'match-00000001',
      seat: 'black',
      issue: async () => 'engine-token',
    },
    baseUrl: 'https://api.example.test',
    fetch: fetcher as unknown as typeof fetch,
    runnerId: 'runner-1',
  });
  // The seat owns its own requester, so the test drives the wire through the
  // shared fetch implementation.
  return { seat, wires, fetcher };
}

const leaseAnswer = {
  schemaVersion: 2,
  leaseId: 'lease-0001',
  matchId: 'match-00000001',
  seat: 'black',
  controlEpoch: 1,
  generation: 1,
  runnerId: 'runner-1',
  status: 'active',
  acquiredAt: '2026-10-21T10:00:00.000Z',
  expiresAt: '2026-10-21T10:00:15.000Z',
  revokedAt: null,
  turnVersion: 1,
  runnerEpoch: 1,
  pendingRequestId: null,
  pendingRequestStartedAt: null,
  revokedReason: null,
  lastRenewedAt: null,
};

const receiptAnswer = {
  schemaVersion: 2,
  matchId: 'match-00000001',
  operationId: 'operation-1',
  outcome: 'accepted',
  version: 2,
  controlEpoch: 1,
  decidedAt: '2026-10-21T10:00:01.000Z',
};

describe('whose turn it is', () => {
  it('moves the seat the opening reply belongs to', () => {
    const view = matchView({
      positionFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      clock: { ...matchView().clock, replySeat: 'black', replyDeadlineAt: '2026-10-21T10:00:15.000Z' },
    });
    expect(onlineSeatToMove(view, 'black')).toBe(true);
    expect(onlineSeatToMove(view, 'white')).toBe(false);
  });

  it('moves the seat the position names when no reply is outstanding', () => {
    expect(onlineSeatToMove(matchView(), 'white')).toBe(true);
    expect(onlineSeatToMove(matchView(), 'black')).toBe(false);
  });

  it('follows the active seat once the main clock runs', () => {
    const view = matchView({ clock: { ...matchView().clock, activeSeat: 'black', activeSince: '2026-10-21T10:00:00.000Z' } });
    expect(onlineSeatToMove(view, 'black')).toBe(true);
    expect(onlineSeatToMove(view, 'white')).toBe(false);
  });

  it('never moves a finished match', () => {
    expect(onlineSeatToMove(matchView({ status: 'completed' }), 'white')).toBe(false);
  });
});

describe('the browser engine seat', () => {
  it('takes a lease, searches the canonical history and submits the move with the lease', async () => {
    const wires: Wire[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
      wires.push({ path, body });
      const data = path.includes('/runner/lease') ? leaseAnswer : receiptAnswer;
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    search.mockResolvedValueOnce({ move: 'e2e4', engineName: 'Stockfish 19', elapsedMs: 5 });
    const seat = createOnlineEngineSeat({
      matchId: 'match-00000001',
      seat: 'black',
      credential: {
        kind: 'guest',
        guestId: 'guest-engine',
        matchId: 'match-00000001',
        seat: 'black',
        issue: async () => 'engine-token',
      },
      baseUrl: 'https://api.example.test',
      fetch: fetcher as unknown as typeof fetch,
      runnerId: 'runner-1',
    });
    const view = matchView({
      positionFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1',
      clock: { ...matchView().clock, activeSeat: 'black', activeSince: '2026-10-21T10:00:00.000Z' },
      moves: [{
        version: 1,
        seat: 'white',
        uci: 'e2e4',
        san: 'e4',
        resultingFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      }],
    });
    const result = await seat.play(view);
    expect(result).toEqual({ kind: 'moved', move: 'e2e4' });
    // The engine searched the canonical history of the match.
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ engineId: 'stockfish-lite' }),
      {
        startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: ['e2e4'],
      },
      undefined,
    );
    const lease = wires.find(wire => wire.path.includes('/runner/lease'));
    expect(lease?.body.action).toBe('acquire');
    expect(lease?.body.seat).toBe('black');
    expect(lease?.body.runnerId).toBe('runner-1');
    expect(lease?.body.controlEpoch).toBe(1);
    const command = wires.find(wire => wire.path.includes('/commands'));
    expect(command?.body.leaseId).toBe('lease-0001');
    expect(command?.body.action).toEqual({ kind: 'submit_move', move: 'e2e4' });
  });

  it('does not move when the engine seat is not to move', async () => {
    const { seat } = createSeat(() => ({ status: 200, data: leaseAnswer }));
    const result = await seat.play(matchView());
    expect(result).toEqual({ kind: 'not-turn' });
    expect(search).not.toHaveBeenCalled();
  });

  it('does not move a seat that is not an engine seat', async () => {
    const { seat } = createSeat(() => ({ status: 200, data: leaseAnswer }));
    const result = await seat.play(matchView({
      clock: { ...matchView().clock, activeSeat: 'black', activeSince: '2026-10-21T10:00:00.000Z' },
      seats: [
        { seat: 'white', publicLabel: 'Owner', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
        { seat: 'black', publicLabel: 'Owner', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      ],
    }));
    expect(result).toEqual({ kind: 'not-turn' });
  });
});
