/**
 * Deterministic fixtures of the online agent runner (KHA-73).
 *
 * The fake service speaks the exact runner lease route and the exact command
 * route of the service, including the strict bodies and the strict answers.
 * It applies the documented rules of the service:
 *
 * - a lease is per seat and per turn,
 * - a control epoch that does not match is a conflict,
 * - a turn version that does not match is a conflict,
 * - a live lease of another runner is a conflict,
 * - a new lease carries the pending request of the previous lease,
 * - a command of an agent seat needs the live lease of the turn,
 * - the fourth illegal attempt ends the match and the fourth formatting
 *   correction is refused.
 *
 * No fixture sends a provider request, and no fixture needs a credential.
 */
import { applyCoordinateMove, parsePosition } from '../../src/rules/index';
import type { CoordinateMove, Promotion, Square } from '../../src/rules/index';
import {
  ProviderRunnerServiceError,
  buildRunnerLeaseBody,
  buildRunnerRequestBody,
} from '../../src/online/provider-runner';
import type {
  ProviderRunnerAnswer,
  ProviderRunnerCommandPort,
  ProviderRunnerLease,
  ProviderRunnerLeasePort,
  ProviderRunnerPendingRecord,
  ProviderRunnerPendingStore,
  ProviderRunnerPrompt,
  ProviderRunnerProviderPort,
  ProviderRunnerSnapshot,
  ProviderRunnerTimers,
  RunnerLeaseRequestBody,
  RunnerRequestRequestBody,
} from '../../src/online/provider-runner';
import type { OnlineMatchView } from '../../src/online/updates';
import type { ClockState, Event, Move, OnlineAction, Receipt, Result, Seat } from '../../src/online/contracts';

/** The standard position every fixture starts from. */
export const FAKE_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The label the service publishes for a label it does not know. */
export const FAKE_NEUTRAL_MODEL_LABEL = 'Custom model';

/**
 * The allowlist of the fixture.
 *
 * The service resolves a declared label to a publishable one before it
 * accepts it, and an unknown label resolves to the neutral label. The
 * fixture models that resolution, so a runner that compares a declared label
 * with a published label fails here the same way it fails in production.
 */
export const FAKE_PUBLISHED_LABELS: Readonly<Record<string, string>> = {
  'test agent': 'Test Agent',
  'second agent': 'Second Agent',
  'stockfish 19 lite (browser)': 'Stockfish 19 Lite (browser)',
};

/** Resolves a declared label to the label the service publishes. */
export function resolveFakePublishedLabel(label: string): string {
  return FAKE_PUBLISHED_LABELS[label.trim().toLowerCase()] ?? FAKE_NEUTRAL_MODEL_LABEL;
}

/** The declared control of the fake seat. */
export interface FakeSeatControl {
  readonly kind: 'human' | 'agent' | 'engine';
  readonly modelLabel?: string;
}

/** The state of the fake match. */
export interface FakeMatch {
  matchId: string;
  seat: Seat;
  version: number;
  controlEpoch: number;
  /** The control epoch of the seat. It changes with the control of the seat. */
  seatControlEpoch: number;
  positionFen: string;
  sideToMove: Seat;
  /** The published control of the seat. */
  control: FakeSeatControl;
  illegalAttemptsSpent: number;
  formatCorrectionsSpent: number;
  /** The accepted moves of the match. */
  moves: Move[];
  result: Result | null;
}

/** One command the runner sent. */
export interface RecordedCommand {
  readonly action: OnlineAction;
  readonly operationId: string | undefined;
  readonly expectedVersion: number | undefined;
  readonly leaseId: string | undefined;
}

/** The lease the fake service stores. */
export interface FakeLease {
  leaseId: string;
  matchId: string;
  seat: Seat;
  controlEpoch: number;
  generation: number;
  runnerId: string;
  status: 'active' | 'revoked' | 'expired';
  acquiredAt: string;
  expiresAt: string;
  revokedAt: string | null;
  turnVersion: number | null;
  runnerEpoch: number;
  pendingRequestId: string | null;
  pendingRequestStartedAt: string | null;
  revokedReason: string | null;
  lastRenewedAt: string | null;
}

/** The fake online service of one match and one seat. */
export interface FakeOnlineService {
  readonly match: FakeMatch;
  readonly commands: ProviderRunnerCommandPort;
  readonly recordedCommands: RecordedCommand[];
  readonly recordedLeaseBodies: RunnerLeaseRequestBody[];
  readonly recordedRequestBodies: RunnerRequestRequestBody[];
  /** The lease the service stores, or null. */
  readonly lease: FakeLease | null;
  /** The lease client of one browser runner. */
  leasePort(runnerId: string): ProviderRunnerLeasePort;
  /** Accepts a move of the other seat and advances the match version. */
  opponentMove(uci: string): void;
  /** Revokes the lease of the seat, like a control change does. */
  revokeLease(reason?: string): void;
  /** Marks the lease of the seat as expired. */
  expireLease(): void;
  /** Applies the next command but loses its acknowledgement. */
  loseNextAcknowledgement(): void;
}

function cloneLease(lease: FakeLease): ProviderRunnerLease {
  return {
    schemaVersion: 2,
    leaseId: lease.leaseId,
    matchId: lease.matchId,
    seat: lease.seat,
    controlEpoch: lease.controlEpoch,
    generation: lease.generation,
    runnerId: lease.runnerId,
    status: lease.status,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    revokedAt: lease.revokedAt,
    turnVersion: lease.turnVersion,
    runnerEpoch: lease.runnerEpoch,
    pendingRequestId: lease.pendingRequestId,
    pendingRequestStartedAt: lease.pendingRequestStartedAt,
    revokedReason: lease.revokedReason,
    lastRenewedAt: lease.lastRenewedAt,
  };
}

function otherSeat(seat: Seat): Seat {
  return seat === 'white' ? 'black' : 'white';
}

function parseUci(uci: string): CoordinateMove {
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.length > 4 ? (uci.slice(4, 5) as Promotion) : undefined;
  return promotion === undefined ? { from, to } : { from, to, promotion };
}

/**
 * How the fixture fences the commands of an agent seat.
 *
 * The service of today fences the acceptance of a move with the runner
 * lease. The mutation that can end the match, the spent recovery attempt,
 * and the resignation are not fenced by the service yet. The fixture models
 * the service of today, so the fixtures never claim a fence the service does
 * not apply.
 */
export type FakeLeaseFence = 'moves-only' | 'agent-commands';

/** Creates the fake online service of one match. */
export function createFakeOnlineService(options: {
  readonly matchId?: string;
  readonly seat?: Seat;
  readonly control?: FakeSeatControl;
  readonly version?: number;
  readonly controlEpoch?: number;
  readonly positionFen?: string;
  readonly sideToMove?: Seat;
  readonly leaseFence?: FakeLeaseFence;
  /** The clock of the fixture. A test moves it to age a lease. */
  readonly now?: () => number;
} = {}): FakeOnlineService {
  const leaseFence = options.leaseFence ?? 'moves-only';
  const clock = options.now ?? ((): number => Date.now());
  const match: FakeMatch = {
    matchId: options.matchId ?? 'match-0001',
    seat: options.seat ?? 'white',
    version: options.version ?? 1,
    controlEpoch: options.controlEpoch ?? 1,
    seatControlEpoch: options.controlEpoch ?? 1,
    positionFen: options.positionFen ?? FAKE_START_FEN,
    sideToMove: options.sideToMove ?? 'white',
    control: options.control ?? { kind: 'agent', modelLabel: 'Test Agent' },
    illegalAttemptsSpent: 0,
    formatCorrectionsSpent: 0,
    moves: [],
    result: null,
  };
  const recordedCommands: RecordedCommand[] = [];
  const recordedLeaseBodies: RunnerLeaseRequestBody[] = [];
  const recordedRequestBodies: RunnerRequestRequestBody[] = [];
  const receipts = new Map<string, Receipt>();
  let lease: FakeLease | null = null;
  let leaseCounter = 0;
  let operationCounter = 0;
  let loseAcknowledgement = false;

  function conflict(message: string): ProviderRunnerServiceError {
    return new ProviderRunnerServiceError('conflict', message, 409);
  }

  function notFound(message: string): ProviderRunnerServiceError {
    return new ProviderRunnerServiceError('not-found', message, 404);
  }

  function requireActiveLease(
    body: { leaseId?: string; runnerId: string; controlEpoch: number; turnVersion?: number },
    options: { readonly boundTurn: boolean },
  ): FakeLease {
    const current = lease;
    if (current === null || current.leaseId !== body.leaseId) throw notFound('The lease does not exist.');
    if (current.runnerId !== body.runnerId) throw notFound('The lease belongs to another runner.');
    if (current.status !== 'active') throw conflict('The lease is not active.');
    if (current.controlEpoch !== match.controlEpoch || body.controlEpoch !== match.controlEpoch) {
      throw conflict('The control epoch moved on.');
    }
    const turnVersion = body.turnVersion ?? 0;
    const version = turnVersion === 0 ? match.version : turnVersion;
    // The renewal may move the lease to the turn that is current now. The
    // request record stays bound to the turn the lease already holds.
    if (version !== match.version) throw conflict('The lease is bound to another turn.');
    if (options.boundTurn && current.turnVersion !== version) {
      throw conflict('The lease is bound to another turn.');
    }
    return current;
  }

  function handleLease(body: RunnerLeaseRequestBody): ProviderRunnerLease {
    if (body.schemaVersion !== 2) throw new ProviderRunnerServiceError('refused', 'The schema version is unknown.', 400);
    if (body.seat !== match.seat) throw notFound('The seat is not a seat of this match.');
    if (body.controlEpoch !== match.controlEpoch) throw conflict('The control epoch moved on.');
    if (match.result !== null) throw conflict('The match has ended.');
    const requestedTurn = body.turnVersion ?? 0;
    const turnVersion = requestedTurn === 0 ? match.version : requestedTurn;
    if (turnVersion !== match.version) throw conflict('The turn version moved on.');
    if (body.action === 'acquire') {
      if (match.control.kind === 'human') throw conflict('A human seat has no browser runner.');
      const current = lease;
      if (current !== null && current.status === 'active') {
        if (current.runnerId !== body.runnerId) throw conflict('Another runner holds the seat.');
        current.turnVersion = turnVersion;
        current.lastRenewedAt = new Date(clock()).toISOString();
        return cloneLease(current);
      }
      leaseCounter += 1;
      const created: FakeLease = {
        leaseId: `lease-${match.matchId}-${leaseCounter}`,
        matchId: match.matchId,
        seat: match.seat,
        controlEpoch: match.controlEpoch,
        generation: leaseCounter,
        runnerId: body.runnerId,
        status: 'active',
        acquiredAt: new Date(clock()).toISOString(),
        expiresAt: new Date(clock() + 30000).toISOString(),
        revokedAt: null,
        turnVersion,
        runnerEpoch: 1,
        // The uncertain request of the previous lease survives the lease change.
        pendingRequestId: current?.pendingRequestId ?? null,
        pendingRequestStartedAt: current?.pendingRequestStartedAt ?? null,
        revokedReason: null,
        lastRenewedAt: new Date(clock()).toISOString(),
      };
      lease = created;
      return cloneLease(created);
    }
    if (body.action === 'renew') {
      const current = requireActiveLease({ ...body, leaseId: body.leaseId ?? '' }, { boundTurn: false });
      current.turnVersion = turnVersion;
      current.lastRenewedAt = new Date(clock()).toISOString();
      return cloneLease(current);
    }
    const current = lease;
    if (current === null || current.leaseId !== body.leaseId) throw notFound('The lease does not exist.');
    if (current.runnerId !== body.runnerId) throw notFound('The lease belongs to another runner.');
    if (current.status === 'active') {
      current.status = 'revoked';
      current.revokedAt = new Date(clock()).toISOString();
      current.revokedReason = 'released';
    }
    return cloneLease(current);
  }

  function handleRequest(body: RunnerRequestRequestBody): ProviderRunnerLease {
    if (body.schemaVersion !== 2) throw new ProviderRunnerServiceError('refused', 'The schema version is unknown.', 400);
    if (body.seat !== match.seat) throw notFound('The seat is not a seat of this match.');
    const current = requireActiveLease(body, { boundTurn: true });
    if (body.action === 'begin') {
      if (current.pendingRequestId !== null && current.pendingRequestId !== body.requestId) {
        throw conflict('Another provider request is still recorded.');
      }
      current.pendingRequestId = body.requestId;
      current.pendingRequestStartedAt = new Date(clock()).toISOString();
      return cloneLease(current);
    }
    if (current.pendingRequestId !== null && current.pendingRequestId !== body.requestId) {
      throw conflict('Another provider request is still recorded.');
    }
    current.pendingRequestId = null;
    current.pendingRequestStartedAt = null;
    return cloneLease(current);
  }

  const commands: ProviderRunnerCommandPort = {
    async submit(action, submitOptions) {
      operationCounter += 1;
      const operationId = submitOptions?.operationId ?? `operation-${operationCounter}`;
      recordedCommands.push({
        action,
        operationId: submitOptions?.operationId,
        expectedVersion: submitOptions?.expectedVersion,
        leaseId: submitOptions?.leaseId,
      });
      const stored = receipts.get(operationId);
      if (stored !== undefined) return stored;
      const leaseId = submitOptions?.leaseId;
      const fenced = leaseFence === 'agent-commands' ||
        action.kind === 'submit_move';
      if (fenced && leaseId !== undefined) {
        const current = lease;
        if (current === null || current.leaseId !== leaseId || current.status !== 'active') {
          // The service answers a fenced lease with a missing resource.
          throw notFound('The lease does not accept a command.');
        }
        if (current.turnVersion !== submitOptions?.expectedVersion) {
          throw conflict('The lease is bound to another turn.');
        }
      }
      if (fenced && leaseId === undefined && match.control.kind !== 'human') {
        // An agent seat acts through a browser runner, and the runner holds
        // the lease of the seat.
        throw notFound('The seat needs the lease of its runner.');
      }
      const expectedVersion = submitOptions?.expectedVersion ?? 0;
      if (expectedVersion !== match.version) throw conflict('The expected version moved on.');
      if (match.result !== null) throw conflict('The match has ended.');
      const outcome: Receipt['outcome'] = 'accepted';
      let event: Event | undefined;
      if (action.kind === 'submit_move') {
        if (match.sideToMove !== match.seat) throw conflict('The seat does not owe the move.');
        const position = parsePosition(match.positionFen);
        try {
          applyCoordinateMove(position, parseUci(action.move));
        } catch {
          throw conflict('The move is not legal.');
        }
        const applied = applyCoordinateMove(position, parseUci(action.move));
        match.positionFen = applied.position.fen;
        match.sideToMove = otherSeat(match.seat);
        match.version += 1;
        match.moves = [...match.moves, {
          version: match.version,
          seat: match.seat,
          uci: action.move,
          san: applied.san,
          resultingFen: applied.position.fen,
        }];
        // The spent budgets of a turn reset with the accepted move.
        match.illegalAttemptsSpent = 0;
        match.formatCorrectionsSpent = 0;
      } else if (action.kind === 'resign') {
        match.result = { kind: 'win', winner: otherSeat(match.seat), reason: 'resignation' };
        match.version += 1;
      } else if (action.kind === 'record_recovery_attempt') {
        if (match.sideToMove !== match.seat) throw conflict('The seat does not owe the move.');
        if (action.attempt === 'illegal_move') {
          match.illegalAttemptsSpent += 1;
          if (match.illegalAttemptsSpent >= 4) {
            match.result = { kind: 'win', winner: otherSeat(match.seat), reason: 'illegal_move' };
          }
        } else {
          if (match.formatCorrectionsSpent >= 3) throw conflict('The formatting budget is spent.');
          match.formatCorrectionsSpent += 1;
        }
        match.version += 1;
      } else if (action.kind === 'set_control') {
        match.controlEpoch += 1;
        // The control change of a seat sets the control epoch of that seat.
        match.seatControlEpoch = match.controlEpoch;
        // The service resolves the declared label to a publishable one before
        // it accepts the change.
        match.control = {
          kind: action.control.kind,
          ...(action.control.modelLabel === undefined
            ? {}
            : { modelLabel: resolveFakePublishedLabel(action.control.modelLabel) }),
        };
        match.version += 1;
        event = {
          schemaVersion: 2,
          matchId: match.matchId,
          version: match.version,
          kind: 'control_change',
          seat: match.seat,
          controlEpoch: match.controlEpoch,
          decisionAt: new Date(clock()).toISOString(),
          acceptedAt: new Date(clock()).toISOString(),
          control: match.control,
        };
        if (lease !== null && lease.status === 'active') {
          lease.status = 'revoked';
          lease.revokedAt = new Date(clock()).toISOString();
          lease.revokedReason = 'control_change';
        }
      }
      const receipt: Receipt = {
        schemaVersion: 2,
        matchId: match.matchId,
        operationId,
        outcome,
        version: match.version,
        controlEpoch: match.controlEpoch,
        decidedAt: new Date(clock()).toISOString(),
        ...(event === undefined ? {} : { event }),
        ...(match.result === null ? {} : { result: match.result }),
      };
      receipts.set(operationId, receipt);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new ProviderRunnerServiceError('transport', 'The acknowledgement was lost.', 0);
      }
      return receipt;
    },
    setControlEpoch() {
      // The fake service owns the epoch.
    },
    setVersion() {
      // The fake service owns the version.
    },
  };

  return {
    match,
    commands,
    recordedCommands,
    recordedLeaseBodies,
    recordedRequestBodies,
    get lease() {
      return lease;
    },
    leasePort(runnerId: string): ProviderRunnerLeasePort {
      const port: ProviderRunnerLeasePort = {
        runnerId,
        async acquire(input) {
          const body = buildRunnerLeaseBody({
            action: 'acquire',
            seat: match.seat,
            runnerId,
            controlEpoch: input.controlEpoch,
            turnVersion: input.turnVersion,
          });
          recordedLeaseBodies.push(body);
          return handleLease(body);
        },
        async renew(input) {
          const body = buildRunnerLeaseBody({
            action: 'renew',
            seat: match.seat,
            runnerId,
            controlEpoch: input.controlEpoch,
            leaseId: input.leaseId,
            turnVersion: input.turnVersion,
          });
          recordedLeaseBodies.push(body);
          return handleLease(body);
        },
        async release(input) {
          const body = buildRunnerLeaseBody({
            action: 'release',
            seat: match.seat,
            runnerId,
            controlEpoch: input.controlEpoch,
            leaseId: input.leaseId,
            turnVersion: input.turnVersion,
          });
          recordedLeaseBodies.push(body);
          return handleLease(body);
        },
        async beginRequest(input) {
          const body = buildRunnerRequestBody({
            action: 'begin',
            seat: match.seat,
            runnerId,
            leaseId: input.leaseId,
            requestId: input.requestId,
            controlEpoch: input.controlEpoch,
            turnVersion: input.turnVersion,
          });
          recordedRequestBodies.push(body);
          return handleRequest(body);
        },
        async clearRequest(input) {
          const body = buildRunnerRequestBody({
            action: 'clear',
            seat: match.seat,
            runnerId,
            leaseId: input.leaseId,
            requestId: input.requestId,
            controlEpoch: input.controlEpoch,
            turnVersion: input.turnVersion,
          });
          recordedRequestBodies.push(body);
          return handleRequest(body);
        },
        async read() {
          return lease === null ? null : cloneLease(lease);
        },
      };
      return port;
    },
    opponentMove(uci: string) {
      const position = parsePosition(match.positionFen);
      const applied = applyCoordinateMove(position, parseUci(uci));
      match.positionFen = applied.position.fen;
      match.sideToMove = otherSeat(match.sideToMove);
      match.version += 1;
      match.moves = [...match.moves, {
        version: match.version,
        seat: match.sideToMove === 'white' ? 'black' : 'white',
        uci,
        san: applied.san,
        resultingFen: applied.position.fen,
      }];
    },
    revokeLease(reason = 'control_change') {
      if (lease === null || lease.status !== 'active') return;
      lease.status = 'revoked';
      lease.revokedAt = new Date(clock()).toISOString();
      lease.revokedReason = reason;
    },
    expireLease() {
      if (lease === null || lease.status !== 'active') return;
      lease.status = 'expired';
    },
    loseNextAcknowledgement() {
      loseAcknowledgement = true;
    },
  };
}

/** One armed timer of the fixture. */
export interface FakeTimer {
  readonly id: number;
  readonly callback: () => void;
  readonly delayMs: number;
}

/** The deterministic timers of the fixture. */
export interface FakeTimers extends ProviderRunnerTimers {
  /** The armed timers. */
  readonly armed: readonly FakeTimer[];
  /** Fires the oldest armed timer, or the timer with the given identifier. */
  fire(id?: number): void;
}

/** Creates the deterministic timers of the fixture. */
export function createFakeTimers(): FakeTimers {
  const armed: FakeTimer[] = [];
  let nextId = 1;
  return {
    armed,
    setTimeout(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      armed.push({ id, callback, delayMs });
      return id;
    },
    clearTimeout(id) {
      const index = armed.findIndex((timer) => timer.id === id);
      if (index >= 0) armed.splice(index, 1);
    },
    fire(id) {
      const index = id === undefined
        ? 0
        : armed.findIndex((timer) => timer.id === id);
      const timer = index >= 0 ? armed[index] : undefined;
      if (timer === undefined) throw new Error('No timer is armed.');
      armed.splice(index, 1);
      timer.callback();
    },
  };
}

/** Creates the in-memory pending record of a seat. */
export function createMemoryPendingStore(): ProviderRunnerPendingStore {
  const records = new Map<string, ProviderRunnerPendingRecord>();
  const keyOf = (matchId: string, seat: Seat): string => `${matchId}:${seat}`;
  return {
    read(matchId, seat) {
      return records.get(keyOf(matchId, seat)) ?? null;
    },
    write(record) {
      records.set(keyOf(record.matchId, record.seat), { ...record });
    },
    clear(matchId, seat) {
      records.delete(keyOf(matchId, seat));
    },
  };
}

/**
 * The clock of the fake match.
 *
 * The service arms no main clock for the seat that has to move first, and it
 * arms none during the opening reply window. The main clock is therefore
 * never the authority for the turn.
 */
export function fakeMatchClock(match: FakeMatch): ClockState {
  const base = {
    whiteMs: 600000,
    blackMs: 600000,
    activeSince: null,
    deadlineAt: null,
    whiteMoved: match.moves.some((move) => move.seat === 'white'),
    blackMoved: match.moves.some((move) => move.seat === 'black'),
    turnNumber: match.moves.length,
    replyDeadlineAt: null,
  };
  if (match.moves.length === 0) {
    // The initial clock of a fresh match arms no seat at all.
    return { ...base, activeSeat: null, replySeat: null };
  }
  if (match.moves.length === 1) {
    // The opening reply window: the responding seat owes the reply and no
    // main clock runs while the window is open.
    const first = match.moves[0];
    return { ...base, activeSeat: null, replySeat: first === undefined ? null : otherSeat(first.seat) };
  }
  return { ...base, activeSeat: match.sideToMove, replySeat: null };
}

/**
 * Builds the canonical match view of the service.
 *
 * The view is the participant view of the match, so it carries the seat views,
 * the clock of the match and the accepted moves. A test that feeds the runner
 * through the view exercises the same conversion the interface uses.
 */
export function fakeMatchView(
  match: FakeMatch,
  overrides: Partial<OnlineMatchView> = {},
): OnlineMatchView {
  const other = otherSeat(match.seat);
  return {
    schemaVersion: 1,
    matchId: match.matchId,
    variant: 'orthodox',
    startingFen: FAKE_START_FEN,
    positionFen: match.positionFen,
    timeControl: { startingTimeMs: 600000, incrementMs: 1000 },
    version: match.version,
    controlEpoch: match.controlEpoch,
    rulesPolicyVersion: 'online-rules/1',
    status: match.result === null ? 'active' : 'completed',
    result: match.result,
    seats: [
      {
        seat: match.seat,
        publicLabel: 'Owner',
        control: match.control,
        controlEpoch: match.seatControlEpoch,
        illegalAttemptsSpent: match.illegalAttemptsSpent,
        formatCorrectionsSpent: match.formatCorrectionsSpent,
      },
      {
        seat: other,
        publicLabel: 'Guest',
        control: { kind: 'human' },
        controlEpoch: 1,
        illegalAttemptsSpent: 0,
        formatCorrectionsSpent: 0,
      },
    ],
    clock: fakeMatchClock(match),
    moves: [...match.moves],
    pendingOffers: [],
    createdAt: '2026-10-21T00:00:00Z',
    updatedAt: '2026-10-21T00:00:00Z',
    completedAt: null,
    yourSeat: match.seat,
    ...overrides,
  };
}

/** Builds the canonical match state the runner acts on. */
export function fakeSnapshot(
  match: FakeMatch,
  overrides: Partial<ProviderRunnerSnapshot> = {},
): ProviderRunnerSnapshot {
  return {
    matchId: match.matchId,
    version: match.version,
    controlEpoch: match.controlEpoch,
    status: match.result === null ? 'active' : 'completed',
    sideToMove: match.result === null ? match.sideToMove : null,
    positionFen: match.positionFen,
    startingFen: FAKE_START_FEN,
    moves: [],
    clock: { whiteMs: 60000, blackMs: 60000, incrementMs: 1000 },
    seatControl: match.control,
    seatControlEpoch: match.seatControlEpoch,
    illegalAttemptsSpent: match.illegalAttemptsSpent,
    formatCorrectionsSpent: match.formatCorrectionsSpent,
    ...overrides,
  };
}

/** One waiting provider request. */
interface PendingProviderRequest {
  readonly prompt: ProviderRunnerPrompt;
  readonly resolve: (answer: ProviderRunnerAnswer) => void;
  readonly reject: (error: unknown) => void;
}

/** The deterministic provider client of the fixtures. */
export interface FakeProvider extends ProviderRunnerProviderPort {
  /** Every prompt the runner sent. */
  readonly prompts: readonly ProviderRunnerPrompt[];
  /** Answers the waiting request with a complete answer. */
  answer(answerText: string): void;
  /** Fails the waiting request. */
  fail(message?: string): void;
  /** Answers the waiting request with an uncertain answer. */
  answerUncertain(answerText?: string): void;
  /** Waits until a request arrives. */
  waitForRequest(): Promise<ProviderRunnerPrompt>;
}

/** Creates the deterministic provider client. */
export function createFakeProvider(): FakeProvider {
  const prompts: ProviderRunnerPrompt[] = [];
  const waiting: PendingProviderRequest[] = [];
  const arrivals: Array<(prompt: ProviderRunnerPrompt) => void> = [];

  function settle(action: (request: PendingProviderRequest) => void): void {
    const next = waiting.shift();
    if (next === undefined) throw new Error('No provider request is waiting.');
    action(next);
  }

  return {
    prompts,
    async run(prompt) {
      prompts.push(prompt);
      return new Promise<ProviderRunnerAnswer>((resolve, reject) => {
        const request: PendingProviderRequest = { prompt, resolve, reject };
        waiting.push(request);
        const onAbort = (): void => {
          const index = waiting.indexOf(request);
          if (index >= 0) waiting.splice(index, 1);
          const error = new Error('The provider request was cancelled.');
          error.name = 'AbortError';
          reject(error);
        };
        if (prompt.signal.aborted) onAbort();
        else prompt.signal.addEventListener('abort', onAbort, { once: true });
        while (arrivals.length > 0) {
          const arrival = arrivals.shift();
          arrival?.(prompt);
        }
      });
    },
    answer(answerText) {
      settle((request) => request.resolve({ answerText, terminal: 'complete', uncertain: false }));
    },
    fail(message = 'The provider request failed.') {
      settle((request) => request.reject(new Error(message)));
    },
    answerUncertain(answerText = '') {
      settle((request) => request.resolve({ answerText, terminal: 'complete', uncertain: true }));
    },
    waitForRequest() {
      if (prompts.length > 0) return Promise.resolve(prompts[prompts.length - 1] as ProviderRunnerPrompt);
      return new Promise<ProviderRunnerPrompt>((resolve) => {
        arrivals.push(resolve);
      });
    },
  };
}
