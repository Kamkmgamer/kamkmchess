import type {
  AdjudicationWorkV1, ControllerFenceV1, ControllerSnapshotV1,
  GameController, GameControllerIntentResultV1, GameControllerIntentV1,
} from '../controller/index.js';
import { applyCoordinateMove, legalMoves, parsePosition, sanToCoordinateMove } from '../rules/index.js';
import type { Position } from '../rules/index.js';
import type { AppliedMoveV1, GameResultV1, PlayerSelectionV1 } from '../storage/index.js';
import type { FinalResultReasonV1 } from '../storage/types.js';
import type { ClockReading, ClockSide } from '../clocks/index.js';
import type { HostedGameMeta, LocalGameSession } from '../ui/match-composition.js';
import { ChessMcpClient, remoteEndpoint } from './remote.js';

const POLL_MS = 1000;
// While the game is being played the page keeps up with the server's own
// turn polling, so the opponent's move — and its check highlight — lands
// about as fast as a locally generated model turn. Idle and finished games
// fall back to the slow cadence.
const LIVE_POLL_MS = 300;
const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The watch payload of a hosted game, published by the MCP server. */
interface WatchBoard {
  gameId: string; fen: string; status: string; players: Record<string, string>; moves: string[];
  clock: { whiteMs: number; blackMs: number; incrementMs?: number; activeSeat?: 'white' | 'black' | null };
  result: { kind?: string; winner?: string | null; reason?: string } | null;
  watch_url: string;
}

/** The backend's win vocabulary, narrowed to what the play screen words. */
const WIN_REASONS: Record<string, Exclude<FinalResultReasonV1, 'stalemate' | 'draw-agreement'>> = {
  checkmate: 'checkmate', resignation: 'resignation', timeout: 'timeout',
  abandonment: 'timeout', abort: 'timeout', opening_reply_timeout: 'timeout', illegal_move: 'illegal-move',
};

/** The backend's draw vocabulary. */
const DRAW_REASONS: Record<string, 'stalemate' | 'threefold-repetition' | 'fifty-move-rule' | 'dead-position' | 'draw-agreement'> = {
  stalemate: 'stalemate', repetition: 'threefold-repetition', fifty_move: 'fifty-move-rule',
  insufficient_material: 'dead-position', agreement: 'draw-agreement',
};

/** The coordinate replay of the SAN list the server publishes. */
interface Replay {
  startingFen: string;
  moves: AppliedMoveV1[];
  position: Position;
  /** Leading SAN count the replay consumed, so a view joined mid-game can skip what it never saw. */
  appliedCount: number;
}

function replayAll(startingFen: string, sans: readonly string[]): Replay | null {
  let position: Position;
  try { position = parsePosition(startingFen); } catch { return null; }
  const moves: AppliedMoveV1[] = [];
  for (const [index, san] of sans.entries()) {
    const move = sanToCoordinateMove(position, san);
    if (!move) return null;
    const before = position;
    position = applyCoordinateMove(before, move).position;
    moves.push({
      moveId: `hosted-${index}`, from: move.from, to: move.to, promotion: move.promotion ?? null,
      san, fenBefore: before.fen, fenAfter: position.fen, eventId: `hosted-${index}`,
    });
  }
  return { startingFen, moves, position, appliedCount: sans.length };
}

/**
 * A hosted agent game as a play-screen session.
 *
 * The remote MCP server owns the rules, the clock and the result; this
 * controller renders its watch payload as a controller snapshot and sends
 * the human seat's intents back through MCP. Because the page speaks the
 * ordinary controller protocol, the play screen is the one surface: features
 * added there land on hosted games by themselves.
 */
export class HostedGameController implements GameController {
  private readonly listeners = new Set<(snapshot: ControllerSnapshotV1) => void>();
  private readonly client = new ChessMcpClient();
  private board: WatchBoard | null = null;
  private replay: Replay | null = null;
  private joining = false;
  private joined = false;
  private connectionError: string | null = null;
  private cached: ControllerSnapshotV1 | null = null;
  private lastPollAt = 0;
  private stopped = false;
  private ticker: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly watchId: string, private readonly seatToken: string | null,
    readonly side: 'white' | 'black') {}

  async initialize(): Promise<ControllerSnapshotV1> {
    await this.poll();
    this.schedule();
    return this.snapshot();
  }

  private schedule(): void {
    if (this.stopped || this.ticker !== undefined) return;
    this.ticker = setTimeout(() => {
      this.ticker = undefined;
      // The clock display ticks from the interpolated snapshot; the poll
      // answers with the server's own banks a moment later.
      if (this.listeners.size > 0) this.publish();
      void this.poll().then(() => { if (this.listeners.size > 0) this.publish(); });
      this.schedule();
    }, this.pollInterval());
  }

  /** The polling cadence: live while the game is being played, slow otherwise. */
  private pollInterval(): number {
    return this.board !== null && this.board.result === null && this.board.status === 'active' ? LIVE_POLL_MS : POLL_MS;
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const response = await fetch(`${remoteEndpoint}?watch=${encodeURIComponent(this.watchId)}`, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('This hosted game is unavailable.');
      const board = await response.json() as WatchBoard;
      // The anchor is the instant the payload was adopted: the server already
      // charged the elapsed time up to its own answer, and a failed attempt
      // leaves the last anchor in place so a running clock keeps charging.
      this.lastPollAt = performance.now();
      this.adopt(board);
      this.connectionError = null;
    } catch (error) {
      this.connectionError = error instanceof Error ? error.message : 'Connection lost. Retrying.';
    }
  }

  /** Adopts a watch payload, replaying its SAN list into real coordinate moves. */
  private adopt(board: WatchBoard): void {
    this.board = board;
    if (!this.replay) {
      // A first sight either replays the whole game from the standard start
      // (verified against the payload FEN) or anchors on the position as seen.
      const full = replayAll(STANDARD_FEN, board.moves);
      this.replay = full && full.position.fen === board.fen ? full : replayAll(board.fen, []);
      return;
    }
    const fresh = board.moves.slice(this.replay.appliedCount);
    if (fresh.length === 0) return;
    let position = this.replay.position;
    const moves = [...this.replay.moves];
    let consumed = this.replay.appliedCount;
    for (const [offset, san] of fresh.entries()) {
      const move = sanToCoordinateMove(position, san);
      if (!move) { this.replay = replayAll(board.fen, []); return; }
      const before = position;
      position = applyCoordinateMove(before, move).position;
      moves.push({
        moveId: `hosted-${consumed + offset}`, from: move.from, to: move.to, promotion: move.promotion ?? null,
        san, fenBefore: before.fen, fenAfter: position.fen, eventId: `hosted-${consumed + offset}`,
      });
      consumed += 1;
    }
    this.replay = { startingFen: this.replay.startingFen, moves, position, appliedCount: consumed };
  }

  private seatOf(color: ClockSide): PlayerSelectionV1 {
    if (this.joined && this.side === color) return { kind: 'human' };
    const label = this.board?.players[color] ?? (color === 'white' ? 'White' : 'Black');
    return {
      kind: 'model', providerId: 'remote-agent', connectionId: 'hosted', configurationRevision: 1,
      modelRoutingId: label.replace(/\s*\(self-reported\)\s*$/i, '').trim() || (color === 'white' ? 'White' : 'Black'),
      protocol: 'custom', diagnostic: 'passed-current-session',
    };
  }

  private buildSnapshot(): ControllerSnapshotV1 {
    const board = this.board;
    const replay = this.replay;
    if (!board || !replay) throw new Error('The hosted game is not open yet.');
    const position = replay.position;
    const sideToMove = position.sideToMove === 'w' ? 'white' : 'black';
    const finished = board.result !== null;
    const waiting = !finished && board.status !== 'active';
    const activeSide = finished || waiting ? null : sideToMove;
    const banks = { whiteMs: Math.max(0, Math.round(board.clock.whiteMs)), blackMs: Math.max(0, Math.round(board.clock.blackMs)) };
    // The server charges only a running main clock. Before the first move and
    // during the opening reply window none runs, so the banks stand and the
    // interpolation must not charge the side to move between polls.
    const runningSeat = activeSide === null ? null : board.clock.activeSeat ?? null;
    const elapsed = runningSeat === null ? 0 : Math.max(0, performance.now() - this.lastPollAt);
    const remaining = runningSeat === null ? banks : {
      whiteMs: runningSeat === 'white' ? Math.max(0, banks.whiteMs - elapsed) : banks.whiteMs,
      blackMs: runningSeat === 'black' ? Math.max(0, banks.blackMs - elapsed) : banks.blackMs,
    };
    const clockReading: ClockReading | null = activeSide === null ? null : {
      activeSide,
      status: remaining[`${activeSide}Ms`] <= 0 ? 'expired' : 'running',
      remaining,
      elapsedMs: Math.round(elapsed),
      deadline: { monotonicMs: null, wallTimeMs: Date.now() + remaining[`${activeSide}Ms`], hostTimeMs: null },
      evidence: {
        basis: 'wall-clock', assurance: 'wall-clock-assumption',
        anchor: { monotonicMs: this.lastPollAt, wallTimeMs: Date.now() - elapsed },
        observedAt: { monotonicMs: performance.now(), wallTimeMs: Date.now() },
        elapsed: { monotonicMs: null, wallMs: Math.round(elapsed), hostAdjustedMs: null },
        maxObservedDivergenceMs: 0,
      },
    };
    const eventId = `hosted-final-${board.moves.length}`;
    const decidedAtMs = Date.now();
    const result: GameResultV1 = board.result === null ? { kind: 'unresolved' }
      : board.result.winner === 'white' || board.result.winner === 'black'
      ? { kind: 'final', winner: board.result.winner, reason: WIN_REASONS[board.result.reason ?? ''] ?? 'timeout', eventId, decidedAtMs }
      : { kind: 'final', winner: 'draw', reason: DRAW_REASONS[board.result.reason ?? ''] ?? 'draw-agreement', eventId, decidedAtMs };
    return {
      checkpoint: {
        schemaVersion: 1, gameId: board.gameId, namespace: { kind: 'guest' },
        revision: 1, ownershipEpoch: 1, segmentId: 'hosted', positionRevision: board.moves.length,
        requestGeneration: 0, analysisGeneration: 0, updatedAtMs: Date.now(),
        rules: {
          variant: 'orthodox', startingFen: replay.startingFen, currentFen: position.fen,
          sideToMove, castlingRights: position.castlingRights, enPassantSquare: position.enPassantSquare,
          halfmoveClock: position.halfmoveClock, fullmoveNumber: position.fullmoveNumber,
          repetitionLedger: { version: 1, positions: [] }, moves: replay.moves,
        },
        history: { currentSegmentId: 'hosted', segments: [], messages: [] },
        clocks: {
          schemaVersion: 1,
          timeControl: { startingTimeMs: Math.max(banks.whiteMs, banks.blackMs), incrementMs: Math.round(board.clock.incrementMs ?? 0) },
          banksAtAnchor: banks, activeSide,
          anchor: activeSide === null ? null : { monotonicMs: this.lastPollAt, wallTimeMs: Date.now() },
          lastReconciledAtMs: Date.now(),
        },
        budgets: {
          formattingCorrectionsRemaining: 0,
          illegalMoveAttemptsRemaining: { white: 0, black: 0 }, manualRetriesBySide: { white: 0, black: 0 },
        },
        selections: { players: { white: this.seatOf('white'), black: this.seatOf('black') } },
        archive: {
          egressStatus: 'eligible',
          currentLine: { lineId: 'hosted', eventIds: [] }, discardedLines: [],
        },
        result, practice: { mode: 'ordinary', scored: false, sourceGameId: null, sourcePositionFen: null, originalResult: null },
        extensions: {},
      },
      position,
      clockReading,
      fence: {
        schemaVersion: 1, gameId: board.gameId, segmentId: 'hosted', side: sideToMove,
        revision: 1, positionRevision: board.moves.length, requestGeneration: 0, analysisGeneration: 0,
        ownershipEpoch: 1, modelConfigurationIdentity: null,
      },
      readiness: 'ready',
      adjudication: { status: 'none', query: null, requestId: null },
      modelHandoff: { committed: null, producing: null, queued: null },
    };
  }

  /** Publishes a fresh snapshot; the interpolation above keeps the clock alive between polls. */
  private publish(): void {
    this.cached = null;
    const next = this.snapshot();
    for (const listener of [...this.listeners]) listener(next);
  }

  snapshot(): ControllerSnapshotV1 {
    return this.cached ?? (this.cached = this.buildSnapshot());
  }

  subscribe(listener: (snapshot: ControllerSnapshotV1) => void): () => void {
    this.listeners.add(listener);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      // A page with no listeners — a swapped session or a closed tab — stops the network.
      if (this.listeners.size === 0 && this.ticker !== undefined) {
        clearTimeout(this.ticker);
        this.ticker = undefined;
      }
    };
  }

  async reconcile(): Promise<ControllerSnapshotV1> {
    // The interpolation is already relative to now; a rebuilt snapshot keeps
    // the display live and marks an emptied bank expired.
    this.cached = null;
    return this.snapshot();
  }

  async joinSeat(): Promise<void> {
    if (!this.seatToken) throw new Error('This address does not carry a seat invitation.');
    if (this.joining) return;
    this.joining = true;
    try {
      await this.client.call('join_seat', { resume_token: this.seatToken, model_name: 'Human' });
      this.joined = true;
      await this.poll();
      this.publish();
    } finally { this.joining = false; }
  }

  async dispatch(intent: GameControllerIntentV1): Promise<GameControllerIntentResultV1> {
    const current = this.snapshot();
    if (intent.kind === 'human-move') {
      const side = this.joined ? this.side : null;
      if (side === null || current.position.sideToMove !== side[0]) {
        return { kind: 'rejected', reason: 'wrong-side', snapshot: current };
      }
      const legal = legalMoves(current.position).some(candidate =>
        candidate.from === intent.move.from && candidate.to === intent.move.to);
      if (!legal) return { kind: 'rejected', reason: 'illegal-move', snapshot: current };
      try {
        // No wait: like the ordinary controller, the intent returns as soon
        // as the move is committed and the opponent's reply arrives through
        // the watch poll. Waiting here held the whole play screen for the
        // agent's think time and kept premoves out of reach for that window.
        await this.client.call('make_move', { move: `${intent.move.from}${intent.move.to}${intent.move.promotion ?? ''}`, wait_seconds: 0 });
      } catch {
        return { kind: 'rejected', reason: 'illegal-move', snapshot: current };
      }
      await this.poll();
      return { kind: 'accepted', snapshot: this.snapshot() };
    }
    if (intent.kind === 'declare-result') {
      const side = this.joined ? this.side : null;
      if (intent.declaration.kind === 'draw' || side === null || intent.declaration.side !== side) {
        return { kind: 'rejected', reason: 'not-actionable', snapshot: current };
      }
      try { await this.client.call('resign'); } catch {
        return { kind: 'rejected', reason: 'not-actionable', snapshot: current };
      }
      await this.poll();
      return { kind: 'accepted', snapshot: this.snapshot() };
    }
    // Stop-model-turn and the model bookkeeping intents have no server action;
    // hosted turns belong to the external agents alone.
    if (intent.kind === 'stop-model-turn') return { kind: 'accepted', snapshot: current };
    return { kind: 'rejected', reason: 'not-actionable', snapshot: current };
  }

  /** The interface's direct declaration entry point; the seat's own side resigns. */
  async declareResult(_fence: ControllerFenceV1, declaration: { kind: 'draw' } | { kind: 'resignation'; side: ClockSide }): Promise<GameControllerIntentResultV1> {
    return this.dispatch({ schemaVersion: 1, kind: 'declare-result', fence: this.snapshot().fence, declaration });
  }
  async addClockTime(): Promise<GameControllerIntentResultV1> {
    return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
  }
  async appendModelTurnArchive(): Promise<ControllerFenceV1 | null> { return null; }
  async continueAdjudication(): Promise<AdjudicationWorkV1 | null> { return null; }
  async stopAdjudication(): Promise<ControllerSnapshotV1> { return this.snapshot(); }
  async acceptAdjudicationResult(): Promise<ControllerSnapshotV1> { return this.snapshot(); }
  async startGame(): Promise<ControllerSnapshotV1> {
    // The server started the game; a hosted waiting room just waits.
    return this.snapshot();
  }
  private unavailable(action: string): never {
    throw new Error(`Hosted games play out on the server, so ${action} is unavailable.`);
  }
  async undo(): Promise<ControllerSnapshotV1> { this.unavailable('undo'); }
  async undoMove(): Promise<ControllerSnapshotV1> { return this.undo(); }
  async takeback(): Promise<ControllerSnapshotV1> { return this.undo(); }
  async startPractice(): Promise<ControllerSnapshotV1> { return this.undo(); }
  async beginPractice(): Promise<ControllerSnapshotV1> { return this.undo(); }
  async queueModelSelection(): Promise<ControllerSnapshotV1> { this.unavailable('a model change'); }
  async cancelModelSelection(): Promise<ControllerSnapshotV1> { return this.queueModelSelection(); }
  async resumePriorModel(): Promise<ControllerSnapshotV1> { return this.queueModelSelection(); }
  async retryModelSelection(): Promise<ControllerSnapshotV1> { return this.queueModelSelection(); }

  meta(): HostedGameMeta {
    const fallback = `${window.location.origin}/play/agent?watch=${encodeURIComponent(this.watchId)}`;
    return {
      side: this.side,
      hasSeat: this.seatToken !== null,
      watchUrl: this.board?.watch_url ?? fallback,
      invitations: (() => {
        try { return JSON.parse(sessionStorage.getItem(`agent-game:${this.watchId}`) ?? '{}') as Record<'white' | 'black', string>; }
        catch { return {} as Record<'white' | 'black', string>; }
      })(),
      joinSeat: () => this.joinSeat(),
      connectionError: () => this.connectionError,
    };
  }
}

/** Opens a hosted agent game as an ordinary play-screen session. */
export function openHostedGameSession(options: {
  watchId: string;
  seatToken: string | null;
  side: 'white' | 'black';
}): LocalGameSession {
  const controller = new HostedGameController(options.watchId, options.seatToken, options.side);
  return { gameId: options.watchId, restored: false, controller, hosted: controller.meta() };
}
