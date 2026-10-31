import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', { location: { origin: 'https://chess.test' } });
const { openHostedGameSession } = await import('./hosted-session.js');
const { checkedColor } = await import('../ui/board-input.js');

const watchBoard = {
  gameId: 'match-1', status: 'active',
  players: { white: 'GLM-4.7 (self-reported)', black: 'Kimi K2' },
  clock: { whiteMs: 170_000, blackMs: 165_000, incrementMs: 60_000 },
  result: null,
  watch_url: 'https://chess.test/play/agent?watch=match-1',
};
let board: Record<string, unknown>;
const rpc: { name: string; args: Record<string, unknown> }[] = [];

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

function mcpOk(structured: Record<string, unknown>): Response {
  return jsonResponse({ jsonrpc: '2.0', id: 1, result: { structuredContent: structured } }, { 'Mcp-Session-Id': 'session-1' });
}

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'https://chess.test' } });
  // Five plies in, the opening reply window has closed and black's main clock runs.
  board = { ...watchBoard, fen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
    clock: { ...watchBoard.clock, activeSeat: 'black' } };
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { method: string; params?: { name: string; arguments?: Record<string, unknown> } };
      if (body.method === 'initialize') return mcpOk({ protocolVersion: '2025-06-18' });
      rpc.push({ name: body.params?.name ?? '', args: body.params?.arguments ?? {} });
      if (body.params?.name === 'make_move') {
        return mcpOk({ gameId: 'match-1', accepted: true });
      }
      if (body.params?.name === 'join_seat') return mcpOk({ gameId: 'match-1', seat: 'white' });
      if (body.params?.name === 'resign') return mcpOk({ gameId: 'match-1', resigned: true });
      return jsonResponse({ jsonrpc: '2.0', id: 1, error: { message: 'Unknown tool.' } });
    }
    return jsonResponse(board);
  }));
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rpc.length = 0; });

describe('hosted game sessions', () => {
  it('renders the watch payload as an ordinary play-screen snapshot', async () => {
    const session = openHostedGameSession({ watchId: 'match-1', seatToken: null, side: 'white' });
    const snapshot = await session.controller.initialize();
    // The SAN list replayed into real coordinate moves with review positions.
    expect(snapshot.checkpoint.rules.moves).toHaveLength(5);
    expect(snapshot.checkpoint.rules.moves[4]).toMatchObject({ from: 'f1', to: 'b5', san: 'Bb5', fenAfter: board.fen });
    expect(snapshot.checkpoint.rules.startingFen).toContain('rnbqkbnr');
    expect(snapshot.position.fen).toBe(board.fen);
    expect(checkedColor(snapshot.position)).toBeUndefined();
    // The server's clock and turn read like a local game's.
    expect(snapshot.clockReading?.status).toBe('running');
    expect(snapshot.checkpoint.clocks.activeSide).toBe('black');
    // Reported names lose the marker and ride the ordinary model seat record.
    expect(snapshot.checkpoint.selections.players.white).toMatchObject({ kind: 'model', modelRoutingId: 'GLM-4.7' });
    expect(snapshot.checkpoint.selections.players.black).toMatchObject({ kind: 'model', modelRoutingId: 'Kimi K2' });
    expect(session.hosted?.watchUrl).toBe(watchBoard.watch_url);
  });

  it('refuses moves for a seat this browser has not joined', async () => {
    const session = openHostedGameSession({ watchId: 'match-1', seatToken: 'white-secret', side: 'white' });
    await session.controller.initialize();
    const result = await session.controller.dispatch({
      schemaVersion: 1, kind: 'human-move', fence: session.controller.snapshot().fence, move: { from: 'e2', to: 'e4' },
    });
    expect(result.kind).toBe('rejected');
  });

  it('joins the invited seat and plays its moves through MCP', async () => {
    board = { ...watchBoard, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [] };
    const session = openHostedGameSession({ watchId: 'match-1', seatToken: 'white-secret', side: 'white' });
    await session.controller.initialize();
    await session.hosted?.joinSeat();
    expect(rpc[0]).toMatchObject({ name: 'join_seat', args: { resume_token: 'white-secret', model_name: 'Human' } });
    const snapshot = session.controller.snapshot();
    expect(snapshot.checkpoint.selections.players.white).toMatchObject({ kind: 'human' });
    expect(snapshot.checkpoint.selections.players.black).toMatchObject({ kind: 'model', modelRoutingId: 'Kimi K2' });
    const result = await session.controller.dispatch({
      schemaVersion: 1, kind: 'human-move', fence: snapshot.fence, move: { from: 'a2', to: 'a4' },
    });
    expect(result.kind).toBe('accepted');
    // The move intent returns without waiting for the opponent's reply, so
    // the play screen stays as responsive as a local game's.
    expect(rpc[1]).toMatchObject({ name: 'make_move', args: { move: 'a2a4', wait_seconds: 0 } });
  });

  it('maps a server rejection of the seat move to an illegal-move result', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { method: string; params?: { name: string } };
        if (body.method === 'initialize') return mcpOk({ protocolVersion: '2025-06-18' });
        if (body.params?.name === 'join_seat') return mcpOk({ seat: 'white' });
        if (body.params?.name === 'make_move') {
          return jsonResponse({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Not your turn.' }] } });
        }
      }
      return jsonResponse(board);
    }));
    board = { ...watchBoard, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [] };
    const session = openHostedGameSession({ watchId: 'match-1', seatToken: 'white-secret', side: 'white' });
    await session.controller.initialize();
    await session.hosted?.joinSeat();
    const result = await session.controller.dispatch({
      schemaVersion: 1, kind: 'human-move', fence: session.controller.snapshot().fence, move: { from: 'a2', to: 'a4' },
    });
    expect(result).toMatchObject({ kind: 'rejected', reason: 'illegal-move' });
  });

  it('resigns the joined side through the result declaration', async () => {
    const session = openHostedGameSession({ watchId: 'match-1', seatToken: 'white-secret', side: 'white' });
    await session.controller.initialize();
    await session.hosted?.joinSeat();
    const result = await session.controller.declareResult(session.controller.snapshot().fence, { kind: 'resignation', side: 'white' });
    expect(result.kind).toBe('accepted');
    expect(rpc[1]).toMatchObject({ name: 'resign' });
  });

  it('words a finished game with the shared result vocabulary', async () => {
    board = { ...watchBoard, fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', moves: ['f3', 'e5', 'g4', 'Qh4#'], result: { kind: 'win', winner: 'black', reason: 'checkmate' } };
    const session = openHostedGameSession({ watchId: 'match-1', seatToken: null, side: 'white' });
    const snapshot = await session.controller.initialize();
    expect(snapshot.checkpoint.result).toMatchObject({ kind: 'final', winner: 'black', reason: 'checkmate' });
    expect(snapshot.checkpoint.clocks.activeSide).toBeNull();
    expect(snapshot.clockReading).toBeNull();
    expect(checkedColor(snapshot.position)).toBe('white');
  });

  it('anchors on the position as seen when the game did not start from the standard position', async () => {
    // The watch payload carries no starting FEN, so a mid-game join to a
    // custom-start game anchors here and accumulates moves from now on.
    const asSeen = '4k3/8/8/8/8/7R/8/4K3 b - - 1 1';
    board = { ...watchBoard, fen: asSeen, moves: ['Rh3'] };
    const session = openHostedGameSession({ watchId: 'match-1', seatToken: null, side: 'white' });
    const snapshot = await session.controller.initialize();
    expect(snapshot.checkpoint.rules.startingFen).toBe(asSeen);
    expect(snapshot.checkpoint.rules.moves).toHaveLength(0);
    expect(snapshot.position.fen).toBe(asSeen);
  });

  it('holds the opening banks still until the server runs a main clock', async () => {
    // Before the first move no bank is being charged, so the display must not
    // tick white down and then snap back to full on every poll.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    board = { ...watchBoard, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [],
      clock: { whiteMs: 900_000, blackMs: 900_000, incrementMs: 60_000 } };
    const session = openHostedGameSession({ watchId: 'match-1', seatToken: null, side: 'white' });
    const snapshot = await session.controller.initialize();
    expect(snapshot.clockReading).toMatchObject({ status: 'running', activeSide: 'white' });
    expect(snapshot.clockReading?.remaining?.whiteMs).toBe(900_000);
    const unsubscribe = session.controller.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(3_500);
    await expect(session.controller.reconcile()).resolves.toMatchObject({
      clockReading: { status: 'running', remaining: { whiteMs: 900_000, blackMs: 900_000 } },
    });
    // The server arms white's main clock once the opening exchange is played,
    // and from then on the display interpolates the running bank.
    board = { ...board, fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', moves: ['e4', 'e5'],
      clock: { whiteMs: 890_000, blackMs: 900_000, incrementMs: 60_000, activeSeat: 'white' } };
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(1_000);
    const running = await session.controller.reconcile();
    expect(running.clockReading).toMatchObject({ status: 'running', activeSide: 'white' });
    expect(running.clockReading?.remaining?.whiteMs ?? 0).toBeLessThan(890_000);
    expect(running.clockReading?.remaining?.blackMs).toBe(900_000);
    unsubscribe();
  });

  it('polls live while the game is being played, slowly when it is not', async () => {
    // The opponent's move and its check highlight ride the watch poll, so a
    // played game keeps the server's own turn cadence and a waiting or
    // finished game falls back to the idle one.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const watchCount = () => vi.mocked(fetch).mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST').length;
    const session = openHostedGameSession({ watchId: 'match-1', seatToken: null, side: 'white' });
    await session.controller.initialize();
    const unsubscribe = session.controller.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    const live = watchCount();
    expect(live).toBeGreaterThanOrEqual(3);
    board = { ...board, status: 'waiting-for-players' };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchCount() - live).toBeLessThanOrEqual(2);
    unsubscribe();
  });
});
