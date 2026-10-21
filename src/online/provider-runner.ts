/**
 * The browser-owned online agent runner (KHA-73).
 *
 * One agent seat of one online match is played by a browser runner. The runner
 * takes the seat lease of the turn it acts for, asks the provider for one
 * answer, reads the answer with the shared classified decoder, and submits the
 * result to the service as a versioned command.
 *
 * The rules this module keeps:
 *
 * - **One lease per seat and per turn.** The lease is acquired before the
 *   first provider request, renewed while the runner works, and released when
 *   the turn ends. A second runner of the same seat is refused by the service,
 *   so a duplicate tab shares the game instead of taking the seat.
 * - **The service owns the outcome.** The runner proposes a move, a
 *   resignation or a spent recovery attempt. It never decides a result, never
 *   concedes a game and never writes match state.
 * - **The budgets are the service's.** Four illegal attempts and three
 *   automatic formatting corrections are counted by the service. The runner
 *   reports a spent attempt and never refills a budget, so a retry, a switch
 *   or a takeover keeps the spent attempts.
 * - **A provider failure never concedes.** A failed or lost provider request
 *   never resigns the seat. It produces an explicit recovery decision.
 * - **Uncertain billable work is never repeated by itself.** When the runner
 *   loses its lease while a provider request may still be running, the request
 *   identifier is left behind in the service lease and in the browser-local
 *   pending record. The next runner offers Retry, switch or takeover and
 *   never issues a second provider request on its own.
 * - **A stale answer is dropped.** A snapshot that changes the position, the
 *   side to move or the control epoch cancels the pending answer, so a reply
 *   of a superseded turn never becomes an accepted move.
 * - **Exactly one accepted move.** Every command carries an operation
 *   identifier. A lost acknowledgement is retried with the same identifier, so
 *   the service answers with the original receipt instead of accepting a
 *   second move.
 * - **Nothing private is shared.** The credential, the provider route and the
 *   model conversation stay in the browser. A shared command carries only a
 *   public model label, a move or another action, the epochs and the lease
 *   identifier.
 * - **Games are independent.** The runner is an ordinary object. One owner may
 *   run several separately requested games at the same time, and nothing in
 *   this module is a singleton.
 *
 * The module owns no transport and no chess authority. The caller injects the
 * lease client, the command client and the provider client, and it feeds the
 * runner with the canonical match snapshot it already receives.
 */
import {
  MAX_FORMAT_CORRECTIONS,
  MAX_ILLEGAL_MOVE_ATTEMPTS,
  decideCompletedAnswer,
} from '../moves/index.js';
import type { TurnBudgetsV1 } from '../moves/index.js';
import { parsePosition } from '../rules/index.js';
import type { CoordinateMove, Position } from '../rules/index.js';
import {
  createAnthropicMessagesDecoder,
  createChatCompletionsDecoder,
  createResponsesDecoder,
  encodeAnthropicMessagesRequest,
  encodeChatCompletionsRequest,
  encodeResponsesRequest,
} from '../providers/protocols/index.js';
import type {
  ProtocolGenerationConfig,
  ProtocolHistory,
  ProtocolStreamDecoder,
  ProviderProtocol,
  ResponsesSchema,
} from '../providers/protocols/index.js';
import { fetchProvider } from '../providers/transport.js';
import { buildRunnerRequestEnvelope, parseRunnerLease } from './contracts';
import type { OnlineAction, Receipt, RunnerLease, RunnerRequestEnvelope, Seat } from './contracts';
import { onlineSideToMove } from './turn';
import type { OnlineMatchView } from './updates';

/** The contract version the runner speaks. */
export const ONLINE_RUNNER_SCHEMA_VERSION = 2;

/** The lease operations the service accepts. */
export type RunnerLeaseAction = 'acquire' | 'renew' | 'release';

/** The uncertain provider request operations the service accepts. */
export type RunnerRequestAction = 'begin' | 'clear';

/**
 * The exact body of the runner lease route.
 *
 * The service decodes the body strictly: an unknown field is refused. The
 * body therefore carries no `generation` field, and it names the lease
 * operations in one `action` field instead of one HTTP method per operation.
 */
export interface RunnerLeaseRequestBody {
  readonly schemaVersion: number;
  readonly action: RunnerLeaseAction;
  readonly seat: Seat;
  readonly runnerId: string;
  readonly leaseId?: string;
  readonly turnVersion?: number;
  readonly controlEpoch: number;
}

/**
 * The exact body of the uncertain provider request route.
 *
 * The body is decoded strictly as well. The lease identifier and the request
 * identifier are always present, because the record belongs to one lease and
 * names one request.
 */
export type RunnerRequestRequestBody = RunnerRequestEnvelope;

/**
 * The lease record the service answers.
 *
 * The DTO of the lease has one parser: the strict parser of the shared
 * contract. The runner adds the two checks of its own scope, the match and the
 * seat of the runner. No required field of the contract is weakened, and the
 * shared fixture of the service is read by the same parser on both sides.
 */
export type ProviderRunnerLease = RunnerLease;

/**
 * Reads the lease answer of the service.
 *
 * The answer is read with the strict parser of the shared contract, so the
 * browser and the service agree on one DTO and on one set of identifiers. The
 * runner refuses an answer that belongs to another match or to another seat.
 */
export function parseRunnerLeaseAnswer(value: unknown, matchId: string, seat: Seat): ProviderRunnerLease {
  let lease: RunnerLease;
  try {
    lease = parseRunnerLease(value);
  } catch (error) {
    throw new ProviderRunnerServiceError(
      'refused',
      error instanceof Error ? error.message : 'The lease answer is not a lease of the contract.',
    );
  }
  if (lease.matchId !== matchId) {
    throw new ProviderRunnerServiceError('refused', 'The lease belongs to another match.');
  }
  if (lease.seat !== seat) {
    throw new ProviderRunnerServiceError('refused', 'The lease belongs to another seat.');
  }
  return lease;
}

/** Builds the exact lease request body. */
export function buildRunnerLeaseBody(input: {
  readonly action: RunnerLeaseAction;
  readonly seat: Seat;
  readonly runnerId: string;
  readonly controlEpoch: number;
  readonly leaseId?: string | null;
  readonly turnVersion?: number | null;
}): RunnerLeaseRequestBody {
  const leaseId = input.leaseId ?? '';
  const turnVersion = input.turnVersion ?? 0;
  return {
    schemaVersion: ONLINE_RUNNER_SCHEMA_VERSION,
    action: input.action,
    seat: input.seat,
    runnerId: input.runnerId,
    // The service omits an empty lease identifier and a zero turn version.
    ...(leaseId.length > 0 ? { leaseId } : {}),
    ...(turnVersion > 0 ? { turnVersion } : {}),
    // The control epoch is always present. The service refuses a runner that
    // did not see the latest control change.
    controlEpoch: input.controlEpoch,
  };
}

/**
 * Builds the exact uncertain provider request body.
 *
 * The body is the shared envelope of the contract, so the browser and the
 * service read one shape. The envelope always carries the turn version: the
 * service reads a missing version as the turn that is current now, and the
 * shared parser of the contract requires the field.
 */
export function buildRunnerRequestBody(input: {
  readonly action: RunnerRequestAction;
  readonly seat: Seat;
  readonly runnerId: string;
  readonly leaseId: string;
  readonly requestId: string;
  readonly controlEpoch: number;
  readonly turnVersion?: number | null;
}): RunnerRequestEnvelope {
  return buildRunnerRequestEnvelope({
    action: input.action,
    seat: input.seat,
    runnerId: input.runnerId,
    leaseId: input.leaseId,
    requestId: input.requestId,
    controlEpoch: input.controlEpoch,
    turnVersion: input.turnVersion ?? 0,
  });
}

/** The failure of a lease or command request. */
export type ProviderRunnerServiceErrorKind =
  /** The service refused the request because it was stale or held. */
  | 'conflict'
  /** The service refused the request because the contract was broken. */
  | 'refused'
  /** The match, the seat or the lease does not exist for this participant. */
  | 'not-found'
  /** The credential was refused. */
  | 'unauthorized'
  /** The service could not serve the request at this moment. */
  | 'unavailable'
  /** The request never reached the service. */
  | 'transport';

/** A failure of one service request. */
export class ProviderRunnerServiceError extends Error {
  readonly kind: ProviderRunnerServiceErrorKind;
  readonly status: number;

  constructor(kind: ProviderRunnerServiceErrorKind, message: string, status = 0) {
    super(message);
    this.name = 'ProviderRunnerServiceError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * The authentication codes that mean the participant may not act any more.
 *
 * The participant boundary reports a stable code and no HTTP status, so the
 * runner reads the code. A cleared or changed credential is not a lost
 * acknowledgement: retrying it can never succeed.
 */
const UNAUTHORIZED_ERROR_CODES: ReadonlySet<string> = new Set([
  'no-credential',
  'credential-cleared',
  'credential-expired',
  'credential-changed',
  'invalid-credential',
  'wrong-scope',
  'identity-changed',
  'origin-mismatch',
  'credential-in-url',
  'credential-header-conflict',
  'disposed',
]);

/** The authentication codes that report a broken request rather than a lost credential. */
const REFUSED_ERROR_CODES: ReadonlySet<string> = new Set(['invalid-url', 'invalid-transport']);

/**
 * Maps an unknown failure onto a service failure kind.
 *
 * The runner accepts the failures of any client: a failure that carries a
 * `kind` is taken as it is, a failure that carries an authentication `code` is
 * mapped with the codes of the participant boundary, and a failure that carries
 * only an HTTP status is mapped with the status mapping of the service.
 */
export function classifyProviderRunnerError(error: unknown): ProviderRunnerServiceErrorKind {
  if (error instanceof ProviderRunnerServiceError) return error.kind;
  if (typeof error !== 'object' || error === null) return 'transport';
  const record = error as { kind?: unknown; status?: unknown; code?: unknown };
  if (record.kind === 'conflict' || record.kind === 'refused' || record.kind === 'not-found' ||
    record.kind === 'unauthorized' || record.kind === 'unavailable' || record.kind === 'transport') {
    return record.kind;
  }
  if (typeof record.code === 'string') {
    if (UNAUTHORIZED_ERROR_CODES.has(record.code)) return 'unauthorized';
    if (REFUSED_ERROR_CODES.has(record.code)) return 'refused';
  }
  if (typeof record.status === 'number' && Number.isFinite(record.status)) {
    if (record.status === 409) return 'conflict';
    if (record.status === 404) return 'not-found';
    if (record.status === 400) return 'refused';
    if (record.status === 401 || record.status === 403) return 'unauthorized';
    if (record.status >= 500) return 'unavailable';
    return 'refused';
  }
  return 'transport';
}

/**
 * The lease client of one browser runner.
 *
 * The client speaks the runner lease route and the uncertain provider request
 * route. The runner identifier belongs to the client, so two tabs of one owner
 * never share it and a duplicate tab is refused by the service.
 */
export interface ProviderRunnerLeasePort {
  /** The opaque identifier of this browser runner. It never leaves the browser. */
  readonly runnerId: string;
  /** Takes the lease of the current turn. */
  acquire(input: { controlEpoch: number; turnVersion: number | null }): Promise<ProviderRunnerLease>;
  /** Renews the lease of the current turn. */
  renew(input: { controlEpoch: number; turnVersion: number | null; leaseId: string }): Promise<ProviderRunnerLease>;
  /** Gives the lease of the seat back. */
  release(input: { controlEpoch: number; turnVersion: number | null; leaseId: string }): Promise<ProviderRunnerLease>;
  /** Records that a billable provider request started. */
  beginRequest(input: {
    controlEpoch: number;
    turnVersion: number | null;
    leaseId: string;
    requestId: string;
  }): Promise<ProviderRunnerLease>;
  /** Records that the billable provider request settled. */
  clearRequest(input: {
    controlEpoch: number;
    turnVersion: number | null;
    leaseId: string;
    requestId: string;
  }): Promise<ProviderRunnerLease>;
  /** Reads the lease of the seat, or null when no runner holds it. */
  read(): Promise<ProviderRunnerLease | null>;
}

/** The options of one shared command. */
export interface ProviderRunnerCommandOptions {
  /** The idempotency identifier of the operation. */
  readonly operationId?: string;
  /** The match version the command expects. */
  readonly expectedVersion?: number;
  /** The runner lease of an agent seat. */
  readonly leaseId?: string;
}

/**
 * The command client of one match.
 *
 * The client proposes an action and reads the receipt. The runner uses the
 * client for the moves, the resignations and the spent recovery attempts of
 * its own seat.
 */
export interface ProviderRunnerCommandPort {
  /** Proposes one action and reads the receipt of the service. */
  submit(action: OnlineAction, options?: ProviderRunnerCommandOptions): Promise<Receipt>;
  /** Records the control epoch the client sends with the next command. */
  setControlEpoch?(epoch: number): void;
  /** Records the match version the client sends with the next command. */
  setVersion?(version: number): void;
}

/** One provider request of one turn. */
export interface ProviderRunnerPrompt {
  /** The opaque identifier of this request. The service records it. */
  readonly requestId: string;
  /** The position the request is about. */
  readonly positionFen: string;
  /** The position the match started from. */
  readonly startingFen: string;
  /** The side that owes the move. */
  readonly sideToMove: Seat;
  /** The accepted moves of the match, in notation the provider reads. */
  readonly moves: readonly string[];
  /** The clock reading of the turn. */
  readonly clock: { readonly whiteMs: number; readonly blackMs: number; readonly incrementMs: number };
  /** The recovery budgets already spent in this turn. */
  readonly budgets: { readonly illegalAttemptsSpent: number; readonly formatCorrectionsSpent: number };
  /** The moves the provider already tried and that were refused. */
  readonly rejectedMoves: readonly { readonly move: string; readonly reason: string }[];
  /** The private correction messages of this turn. */
  readonly corrections: readonly string[];
  /** The instructions of the match. */
  readonly instructions: string;
  /** The signal that cancels a stale request. */
  readonly signal: AbortSignal;
}

/** The answer of one provider request. */
export interface ProviderRunnerAnswer {
  /** The answer text of the provider. */
  readonly answerText: string;
  /** How the request ended. */
  readonly terminal: 'complete' | 'partial' | 'failed' | 'aborted';
  /**
   * True when the request may have reached the provider and been billed.
   *
   * An uncertain answer never produces a second provider request by itself.
   */
  readonly uncertain: boolean;
  /** The usage record of the provider, when it reported one. */
  readonly usage?: unknown;
}

/**
 * The provider client of one agent.
 *
 * The client owns the credential, the route and the conversation of the
 * browser. It never receives a credential of the service and it never returns
 * one.
 */
export interface ProviderRunnerProviderPort {
  /** Runs one billable provider request and returns its answer. */
  run(prompt: ProviderRunnerPrompt): Promise<ProviderRunnerAnswer>;
}

/**
 * One private conversation record of a seat.
 *
 * The record belongs to the turn it was written in. The turn is named by the
 * canonical position the turn was played from, so a correction of an earlier
 * turn is never sent again in a later one, while a correction of the same turn
 * survives a retry, a switch and a takeover.
 */
export interface ProviderRunnerConversationRecord {
  readonly id: string;
  readonly role: 'user' | 'agent';
  readonly text: string;
  readonly createdAt: number;
  /** The canonical position of the turn the record belongs to. */
  readonly turn?: string;
}

/**
 * The private conversation of one seat.
 *
 * The conversation stays in the browser. It is never sent to the service and
 * never reaches a shared replay.
 */
export interface ProviderRunnerConversationStore {
  read(matchId: string, seat: Seat): readonly ProviderRunnerConversationRecord[];
  append(matchId: string, seat: Seat, record: ProviderRunnerConversationRecord): void;
  clear(matchId: string, seat: Seat): void;
}

/** The durable record of a provider request that may still be running. */
export interface ProviderRunnerPendingRecord {
  readonly matchId: string;
  readonly seat: Seat;
  readonly requestId: string;
  readonly turnVersion: number;
  readonly controlEpoch: number;
  readonly startedAt: number;
}

/**
 * The durable pending record of one seat.
 *
 * The record is browser-local. It survives a reload, so a runner that comes
 * back knows that a billable request may still be running and never issues a
 * second one by itself.
 */
export interface ProviderRunnerPendingStore {
  read(matchId: string, seat: Seat): ProviderRunnerPendingRecord | null;
  write(record: ProviderRunnerPendingRecord): void;
  clear(matchId: string, seat: Seat): void;
}

/** The timers of the runner. Tests inject a deterministic one. */
export interface ProviderRunnerTimers {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

/** The phase of one runner. */
export type ProviderRunnerPhase =
  /** No work is running. */
  | 'idle'
  /** The seat is not held by this runner. */
  | 'waiting-lease'
  /** A provider request is running. */
  | 'generating'
  /** A command is on its way to the service. */
  | 'submitting'
  /** Uncertain billable work waits for an explicit owner decision. */
  | 'uncertain'
  /** The automatic formatting budget is spent. The owner recovers. */
  | 'paused'
  /** The provider or the transport failed. The owner recovers. */
  | 'failed'
  /** The runner was stopped on purpose. */
  | 'stopped';

/** The kinds of uncertainty the runner reports. */
export type ProviderRunnerUncertaintyKind =
  /** A provider request may still be running and may have been billed. */
  | 'provider-request'
  /** A command may have been accepted while its acknowledgement was lost. */
  | 'submission';

/** The uncertainty the runner waits on. */
export interface ProviderRunnerUncertainty {
  readonly kind: ProviderRunnerUncertaintyKind;
  /** The provider request that may still be running. */
  readonly requestId: string | null;
  /** The operation whose acknowledgement was lost. */
  readonly operationId: string | null;
  /** When the uncertain work started. */
  readonly startedAt: number;
  /** A short reason for the uncertainty. */
  readonly detail: string;
}

/** The explicit recovery decisions the owner may take. */
export type ProviderRunnerDecision = 'retry' | 'switch-model' | 'takeover';

/**
 * The outcome of an action of the owner.
 *
 * The interface reads it to keep or to drop the binding of the seat: a
 * takeover that the service refused must not delete the runner of the seat,
 * and a decision that a newer decision superseded must not be reported as
 * applied. The outcome carries no routing identifier, no credential and no
 * private selection; it carries the public label the seat declares.
 */
export type ProviderRunnerActionOutcome =
  /**
   * The runner accepted the decision.
   *
   * The meaning depends on the decision. `retry()` accepts the scheduling of
   * one more request of the provider: the runner asks the provider again and
   * the service has not applied a command. `switchModel()` and `takeover()`
   * accept the canonical command of the service: the receipt proves that the
   * seat declares this label and that the seat belongs to this controller.
   *
   * The optional detail names what the runner had to leave out, so the
   * caller never has to guess why a decision was applied without the lease
   * of the runner.
   */
  | { readonly kind: 'accepted'; readonly publicModelLabel: string; readonly detail?: string }
  /** The service or the runner refused the decision. The seat keeps its state. */
  | { readonly kind: 'refused'; readonly detail: string }
  /** The outcome could not be established. The owner may retry. */
  | { readonly kind: 'unknown'; readonly detail: string };

/** The outcome of one command of the runner. */
type SubmitOutcome =
  | { readonly kind: 'accepted'; readonly receipt: Receipt }
  | {
    readonly kind: 'fenced' | 'refused' | 'unauthorized' | 'unacknowledged' | 'superseded';
    readonly detail: string;
  };

/** The state of one runner. */
export interface ProviderRunnerState {
  readonly matchId: string;
  readonly seat: Seat;
  readonly phase: ProviderRunnerPhase;
  /**
   * The label the service publishes for the agent.
   *
   * The service resolves a declared label to a publishable one before it
   * accepts it, so the published label is the identity of the agent. The
   * runner adopts it from the receipt of a control change and from the seat
   * view of the snapshot.
   */
  readonly publicModelLabel: string;
  readonly leaseId: string | null;
  readonly controlEpoch: number;
  /** The service epoch of the match, when the caller knows it. */
  readonly serviceEpoch: number;
  /** The epoch of the seat binding, when the caller knows it. */
  readonly seatEpoch: number;
  /**
   * The control epoch of the seat the runner is bound to.
   *
   * The epoch of the seat is the canonical answer to the question which
   * controller plays the seat. A runner of a superseded controller never
   * submits a move.
   */
  readonly boundSeatControlEpoch: number | null;
  /**
   * True when another controller took the seat.
   *
   * The runner stops and the caller decides whether it binds a new agent to
   * the seat.
   */
  readonly superseded: boolean;
  readonly turnVersion: number | null;
  /** The match version the runner acts for. */
  readonly version: number;
  readonly illegalAttemptsSpent: number;
  readonly formatCorrectionsSpent: number;
  /** The uncertainty the runner waits on, or null. */
  readonly uncertainty: ProviderRunnerUncertainty | null;
  /** The decisions the owner may take right now. */
  readonly decisions: readonly ProviderRunnerDecision[];
  readonly lastMove: string | null;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

/** The declared control of the seat the runner acts for. */
export interface ProviderRunnerSeatControl {
  readonly kind: 'human' | 'agent' | 'engine';
  /** The label the service publishes for the agent. It is never a route identifier. */
  readonly modelLabel?: string;
}

/** The canonical match state the runner acts on. */
export interface ProviderRunnerSnapshot {
  readonly matchId: string;
  /** The match version of this state. */
  readonly version: number;
  /** The control epoch of this state. */
  readonly controlEpoch: number;
  readonly status: 'active' | 'completed' | 'aborted';
  /** The side that owes the move, or null while the match is finished. */
  readonly sideToMove: Seat | null;
  readonly positionFen: string;
  readonly startingFen: string;
  /** The accepted moves of the match. */
  readonly moves: readonly string[];
  readonly clock: { readonly whiteMs: number; readonly blackMs: number; readonly incrementMs: number };
  /** The declared control of the seat the runner acts for. */
  readonly seatControl: ProviderRunnerSeatControl;
  /**
   * The control epoch of the seat the runner acts for.
   *
   * The epoch of the seat changes when the control of that seat changes. It
   * is the canonical answer to the question which controller plays the seat,
   * and it is never a label comparison.
   */
  readonly seatControlEpoch: number;
  /** The illegal attempts already spent in this turn. */
  readonly illegalAttemptsSpent: number;
  /** The formatting corrections already spent in this turn. */
  readonly formatCorrectionsSpent: number;
  /** The service epoch of the match, when the caller knows it. */
  readonly serviceEpoch?: number;
  /** The epoch of the seat binding, when the caller knows it. */
  readonly seatEpoch?: number;
}

/** The options of the canonical conversion of a match view. */
export interface ProviderRunnerSnapshotOptions {
  /** The service epoch of the match, when the caller knows it. */
  readonly serviceEpoch?: number;
  /** The epoch of the seat binding, when the caller knows it. */
  readonly seatEpoch?: number;
}

/**
 * Converts the canonical match view of the service into the state the runner
 * acts on.
 *
 * The conversion is the one place that reads the seat view, so the control
 * epoch of the seat, the published label of the agent and the canonical
 * counters of the turn always come from the same seat of the same view. A
 * caller that builds the state by hand can name the wrong epoch, and the
 * runner would then stand down for a controller it still owns.
 */
export function providerRunnerSnapshotFromView(
  view: OnlineMatchView,
  seat: Seat,
  options: ProviderRunnerSnapshotOptions = {},
): ProviderRunnerSnapshot {
  const seatView = view.seats.find((candidate) => candidate.seat === seat);
  if (seatView === undefined) {
    throw new Error('The match view does not carry the seat of the runner.');
  }
  return {
    matchId: view.matchId,
    version: view.version,
    controlEpoch: view.controlEpoch,
    status: view.status,
    // The side that owes the move is the seat of the opening reply window
    // while it is open, the seat whose clock runs otherwise, and the seat the
    // canonical position names while no clock runs at all. The shared rule of
    // the service, the interface, the engine seat and the runner is one rule.
    sideToMove: onlineSideToMove(view),
    positionFen: view.positionFen,
    startingFen: view.startingFen,
    // The provider reads the moves of the match in the notation of the
    // offline request building, which is the notation of the game record.
    moves: view.moves.map((move) => move.san),
    clock: {
      whiteMs: view.clock.whiteMs,
      blackMs: view.clock.blackMs,
      incrementMs: view.timeControl.incrementMs,
    },
    seatControl: seatView.control,
    // The control epoch of the seat is the canonical answer to the question
    // which controller plays the seat.
    seatControlEpoch: seatView.controlEpoch,
    illegalAttemptsSpent: seatView.illegalAttemptsSpent,
    formatCorrectionsSpent: seatView.formatCorrectionsSpent,
    ...(options.serviceEpoch === undefined ? {} : { serviceEpoch: options.serviceEpoch }),
    ...(options.seatEpoch === undefined ? {} : { seatEpoch: options.seatEpoch }),
  };
}

/** The options of one browser runner. */
export interface ProviderRunnerOptions {
  readonly matchId: string;
  readonly seat: Seat;
  /**
   * The label the owner configured for the agent.
   *
   * The service resolves a declared label to a publishable one before it
   * accepts it, so the runner adopts the published label from the receipt of a
   * control change and from the seat view of the snapshot. The declared label
   * is only the starting point.
   */
  readonly publicModelLabel: string;
  /** The lease client of this runner. */
  readonly leases: ProviderRunnerLeasePort;
  /** The command client of this match. */
  readonly commands: ProviderRunnerCommandPort;
  /** The provider client of this agent. */
  readonly provider: ProviderRunnerProviderPort;
  /** The private conversation of the seat. */
  readonly conversation?: ProviderRunnerConversationStore;
  /** The durable pending record of the seat. */
  readonly pending?: ProviderRunnerPendingStore;
  /** The instructions of the match. */
  readonly instructions?: string;
  /** Creates the identifiers of the runner. */
  readonly idFactory?: () => string;
  /** Reads the current time. */
  readonly now?: () => number;
  /** The timers of the runner. */
  readonly timers?: ProviderRunnerTimers;
  /** How often the lease is renewed while the runner works. */
  readonly renewIntervalMs?: number;
  /** How often a lost acknowledgement is retried with the same operation. */
  readonly maxSubmissionAttempts?: number;
  /** Whether a snapshot starts the turn on its own. */
  readonly autoStart?: boolean;
  /** Receives every change of the runner. */
  readonly onState?: (state: ProviderRunnerState) => void;
}

/** The browser runner of one agent seat. */
export interface OnlineProviderRunner {
  readonly matchId: string;
  readonly seat: Seat;
  /** The current state of the runner. */
  readonly state: ProviderRunnerState;
  /** Registers a listener for every change. */
  subscribe(listener: (state: ProviderRunnerState) => void): () => void;
  /** Feeds the canonical match state. A changed turn cancels a pending answer. */
  applySnapshot(snapshot: ProviderRunnerSnapshot): void;
  /** Plays the turn when the seat is agent controlled and it is the seat's turn. */
  start(): Promise<void>;
  /**
   * Starts the runner again after the owner stopped it.
   *
   * A stopped runner is resumable. The owner may stop an agent and start it
   * again without losing the seat, the budgets or the conversation.
   */
  resume(): Promise<void>;
  /** Stops the runner and releases the lease. */
  stop(): Promise<void>;
  /**
   * Retries the uncertain work on the explicit request of the owner.
   *
   * The outcome tells the caller whether the decision reached the provider.
   */
  retry(): Promise<ProviderRunnerActionOutcome>;
  /**
   * Switches the agent of the seat on the explicit request of the owner.
   *
   * The outcome tells the caller whether the service applied the switch.
   */
  switchModel(publicModelLabel: string): Promise<ProviderRunnerActionOutcome>;
  /**
   * Hands the seat to the human owner on the explicit request of the owner.
   *
   * The outcome tells the caller whether the service applied the handoff, so
   * the binding of the seat is only dropped when it did.
   */
  takeover(): Promise<ProviderRunnerActionOutcome>;
  /** Stops the runner and releases every resource it holds. */
  dispose(): Promise<void>;
}

const DEFAULT_RENEW_INTERVAL_MS = 5000;
const DEFAULT_MAX_SUBMISSION_ATTEMPTS = 3;
const MAX_CONVERSATION_RECORDS = 24;

/**
 * The largest factor of the renewal backoff.
 *
 * A transient failure of the renewal is retried with a growing delay, and
 * the delay never grows past this factor of the renewal interval.
 */
const MAX_RENEWAL_BACKOFF_FACTOR = 8;

/**
 * The number of times the runner may take a new lease in one turn.
 *
 * A lease that is lost again and again is a seat the runner does not hold.
 */
const MAX_LEASE_TAKEOVERS = 3;

const defaultIdFactory = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `req${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
};

const defaultNow = (): number => Date.now();

const defaultTimers: ProviderRunnerTimers = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs) as unknown as number;
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle);
  },
};

/**
 * Reports whether a label may be published as the identity of an agent.
 *
 * A public label names the agent for other participants. A route identifier,
 * a model path or a provider key never qualifies, so it can never be shared
 * by accident.
 */
export function isPublicModelLabel(label: string): boolean {
  if (label.length === 0 || label.length > 64) return false;
  return /^[A-Za-z0-9][A-Za-z0-9 ._'-]*$/.test(label);
}

const MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * Keeps an identifier inside the shape the service accepts.
 *
 * The service accepts an opaque identifier of letters, digits, dashes and
 * underscores. A route, a path or a credential never reaches an identifier.
 */
function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
}

/**
 * Checks that one shared action carries nothing private.
 *
 * The check is a guard, not a parser. It refuses an action with an unknown
 * field, an action that carries a route identifier and an action that is not
 * part of the shared contract.
 */
export function assertSharedActionSafe(action: OnlineAction): void {
  if (typeof action !== 'object' || action === null) {
    throw new Error('A shared action must be an object.');
  }
  const record = action as Record<string, unknown>;
  const kind = record.kind;
  if (kind === 'submit_move') {
    const move = record.move;
    if (typeof move !== 'string' || !MOVE_PATTERN.test(move)) {
      throw new Error('A shared move must be one coordinate move.');
    }
    assertKeys(record, ['kind', 'move']);
    return;
  }
  if (kind === 'resign' || kind === 'cancel') {
    assertKeys(record, ['kind']);
    return;
  }
  if (kind === 'set_control') {
    const control = record.control;
    if (typeof control !== 'object' || control === null) {
      throw new Error('A shared control change must carry a control.');
    }
    const controlRecord = control as Record<string, unknown>;
    if (controlRecord.kind !== 'human' && controlRecord.kind !== 'agent' && controlRecord.kind !== 'engine') {
      throw new Error('A shared control change must name a known control kind.');
    }
    if (controlRecord.modelLabel !== undefined) {
      if (typeof controlRecord.modelLabel !== 'string' || !isPublicModelLabel(controlRecord.modelLabel)) {
        throw new Error('A shared control change may only carry a public model label.');
      }
    }
    assertKeys(controlRecord, ['kind', 'modelLabel']);
    assertKeys(record, ['kind', 'control']);
    return;
  }
  if (kind === 'record_recovery_attempt') {
    const attempt = record.attempt;
    if (attempt !== 'illegal_move' && attempt !== 'formatting_correction') {
      throw new Error('A shared recovery attempt must name a known attempt kind.');
    }
    assertKeys(record, ['kind', 'attempt']);
    return;
  }
  throw new Error('The runner may only submit a move, a resignation, a control change or a recovery attempt.');
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`The shared action carries an unknown field (${key}).`);
    }
  }
}

/** Creates the in-memory private conversation of a seat. */
export function createMemoryConversationStore(): ProviderRunnerConversationStore {
  const conversations = new Map<string, ProviderRunnerConversationRecord[]>();
  const keyOf = (matchId: string, seat: Seat): string => `${matchId}:${seat}`;
  return {
    read(matchId, seat) {
      return conversations.get(keyOf(matchId, seat)) ?? [];
    },
    append(matchId, seat, record) {
      const key = keyOf(matchId, seat);
      const records = [...(conversations.get(key) ?? []), record];
      conversations.set(key, records.slice(-MAX_CONVERSATION_RECORDS));
    },
    clear(matchId, seat) {
      conversations.delete(keyOf(matchId, seat));
    },
  };
}

/**
 * Creates the browser-local private conversation of a seat.
 *
 * The conversation is namespaced by match and seat, it never carries a
 * credential and it never leaves the browser. A browser that refuses the
 * storage keeps the conversation in memory only.
 */
export function createLocalConversationStore(
  prefix = 'kamkmchess.online.runner.conversation.v1',
): ProviderRunnerConversationStore {
  const keyOf = (matchId: string, seat: Seat): string => `${prefix}:${encodeURIComponent(matchId)}:${seat}`;
  return {
    read(matchId, seat) {
      try {
        const raw = globalThis.localStorage?.getItem(keyOf(matchId, seat));
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const records: ProviderRunnerConversationRecord[] = [];
        for (const item of parsed) {
          if (typeof item !== 'object' || item === null) continue;
          const record = item as Record<string, unknown>;
          if (typeof record.id !== 'string' || typeof record.text !== 'string') continue;
          if (record.role !== 'user' && record.role !== 'agent') continue;
          records.push({
            id: record.id,
            role: record.role,
            text: record.text,
            createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
            ...(typeof record.turn === 'string' ? { turn: record.turn } : {}),
          });
        }
        return records;
      } catch {
        return [];
      }
    },
    append(matchId, seat, record) {
      try {
        const key = keyOf(matchId, seat);
        const raw = globalThis.localStorage?.getItem(key);
        const existing = raw ? (JSON.parse(raw) as unknown) : [];
        const records = Array.isArray(existing) ? existing : [];
        const next = [...records, { ...record }].slice(-MAX_CONVERSATION_RECORDS);
        globalThis.localStorage?.setItem(key, JSON.stringify(next));
      } catch {
        // A browser that refuses the storage keeps the conversation in memory only.
      }
    },
    clear(matchId, seat) {
      try {
        globalThis.localStorage?.removeItem(keyOf(matchId, seat));
      } catch {
        // A browser that refuses the storage has nothing to clear.
      }
    },
  };
}

/**
 * Creates the browser-local pending record of a seat.
 *
 * The record names the provider request that may still be running. It is
 * browser-local, it holds no credential and no conversation, and it is the
 * honest trace that keeps a runner from issuing a second billable request.
 */
export function createLocalPendingStore(
  prefix = 'kamkmchess.online.runner.pending.v1',
): ProviderRunnerPendingStore {
  const keyOf = (matchId: string, seat: Seat): string => `${prefix}:${encodeURIComponent(matchId)}:${seat}`;
  return {
    read(matchId, seat) {
      try {
        const raw = globalThis.localStorage?.getItem(keyOf(matchId, seat));
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const record = parsed as Record<string, unknown>;
        if (typeof record.requestId !== 'string' || record.requestId.length === 0) return null;
        return {
          matchId,
          seat,
          requestId: record.requestId,
          turnVersion: typeof record.turnVersion === 'number' ? record.turnVersion : 0,
          controlEpoch: typeof record.controlEpoch === 'number' ? record.controlEpoch : 0,
          startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
        };
      } catch {
        return null;
      }
    },
    write(record) {
      try {
        globalThis.localStorage?.setItem(keyOf(record.matchId, record.seat), JSON.stringify({ ...record }));
      } catch {
        // A browser that refuses the storage keeps the record in memory only.
      }
    },
    clear(matchId, seat) {
      try {
        globalThis.localStorage?.removeItem(keyOf(matchId, seat));
      } catch {
        // A browser that refuses the storage has nothing to clear.
      }
    },
  };
}

/**
 * Builds the provider request of one online turn.
 *
 * The payload carries the position, the accepted moves, the clock and the
 * spent budgets of the turn. The corrections of the turn follow as private
 * messages. Nothing of it is shared with the service.
 */
export function composeOnlineProviderHistory(prompt: ProviderRunnerPrompt): ProtocolHistory {
  const records = [{
    id: prompt.requestId,
    role: 'user' as const,
    text: JSON.stringify({
      kind: 'current-match-input',
      fen: prompt.positionFen,
      sideToMove: prompt.sideToMove,
      startingFen: prompt.startingFen,
      moves: prompt.moves.join(' '),
      clock: {
        whiteMs: prompt.clock.whiteMs,
        blackMs: prompt.clock.blackMs,
        incrementMs: prompt.clock.incrementMs,
      },
      ...(prompt.rejectedMoves.length === 0 ? {} : { rejectedMoves: prompt.rejectedMoves }),
      ...(prompt.budgets.formatCorrectionsSpent === 0 ? {} : {
        formatCorrection: 'Your previous reply had an invalid move format. Choose one move and return only the required JSON, including q, r, b or n for a promotion.',
      }),
    }),
  }];
  prompt.corrections.forEach((correction, index) => {
    records.push({ id: `${prompt.requestId}-c${index}`, role: 'user', text: correction });
  });
  return { instructions: prompt.instructions, records, cachePrefixRecordCount: 0 };
}

/** The resolved destination of one provider request. */
export interface ProviderRunnerTarget {
  readonly protocol: ProviderProtocol;
  readonly model: string;
  readonly url: string;
  /** The request headers. They carry the credential and never leave the browser. */
  readonly headers: Readonly<Record<string, string>>;
  readonly generation: Omit<ProtocolGenerationConfig, 'model'>;
  /** The answer schema of the responses protocol. */
  readonly responsesSchema?: ResponsesSchema;
}

/** The options of the protocol provider client. */
export interface ProviderRunnerProtocolOptions {
  /** Resolves the destination of one request. The credential stays in the browser. */
  readonly resolveTarget: (prompt: ProviderRunnerPrompt) => Promise<ProviderRunnerTarget>;
  /** The transport of the request. It defaults to the shared provider transport. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The instructions of the match. */
  readonly instructions?: string;
  /** Receives the usage record of a settled request. */
  readonly onUsage?: (usage: unknown) => void;
}

/**
 * Creates the provider client of one agent.
 *
 * The client encodes the request with the shared protocol encoders, sends it
 * with the shared provider transport and reads it with the shared protocol
 * decoders. A request that never reaches the provider is uncertain, because
 * it may still have been billed.
 */
export function createProtocolProviderPort(options: ProviderRunnerProtocolOptions): ProviderRunnerProviderPort {
  const transport = options.fetch ?? fetchProvider;
  const instructions = options.instructions ?? '';
  return {
    async run(prompt) {
      const target = await options.resolveTarget(prompt);
      const config: ProtocolGenerationConfig = { ...target.generation, model: target.model };
      const encoded = encodeForProtocol(target.protocol, composeOnlineProviderHistory({
        ...prompt,
        instructions: instructions.length > 0 ? instructions : prompt.instructions,
      }), config);
      let response: Response;
      try {
        response = await transport(target.url, {
          method: 'POST',
          headers: { ...target.headers, 'content-type': 'application/json' },
          body: JSON.stringify(encoded.body),
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: prompt.signal,
        });
      } catch (error) {
        if (prompt.signal.aborted) throw error;
        // The request may have reached the provider and been billed.
        return { answerText: '', terminal: 'failed', uncertain: true };
      }
      const decoder = createDecoder(target.protocol, response.status, target.responsesSchema);
      if (response.body) {
        await readBody(response.body, decoder, prompt.signal);
      } else if (prompt.signal.aborted) {
        decoder.abort();
      }
      const result = decoder.finish();
      if (options.onUsage) options.onUsage(result.usage);
      if (!response.ok) {
        // The provider answered, so the request is settled and not uncertain.
        return { answerText: result.answerText, terminal: 'failed', uncertain: false };
      }
      if (result.terminal === 'aborted') {
        return { answerText: result.answerText, terminal: 'aborted', uncertain: false };
      }
      if (result.terminal === 'complete') {
        return { answerText: result.answerText, terminal: 'complete', uncertain: false };
      }
      return { answerText: result.answerText, terminal: 'partial', uncertain: false };
    },
  };
}

function encodeForProtocol(
  protocol: ProviderProtocol,
  history: ProtocolHistory,
  config: ProtocolGenerationConfig,
): { body: Readonly<Record<string, unknown>> } {
  switch (protocol) {
    case 'chat-completions':
      return encodeChatCompletionsRequest(history, config);
    case 'responses':
      return encodeResponsesRequest(history, config);
    case 'anthropic-messages':
      return encodeAnthropicMessagesRequest(history, config);
  }
}

function createDecoder(
  protocol: ProviderProtocol,
  status: number,
  responsesSchema?: ResponsesSchema,
): ProtocolStreamDecoder {
  switch (protocol) {
    case 'chat-completions':
      return createChatCompletionsDecoder({ httpStatus: status });
    case 'responses':
      return createResponsesDecoder({
        httpStatus: status,
        ...(responsesSchema === undefined ? {} : { responsesSchema }),
      });
    case 'anthropic-messages':
      return createAnthropicMessagesDecoder({ httpStatus: status });
  }
}

async function readBody(
  body: ReadableStream<Uint8Array>,
  decoder: ProtocolStreamDecoder,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal.aborted) {
        decoder.abort();
        return;
      }
      const next = await reader.read();
      if (next.done) return;
      if (next.value) decoder.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A reader that is already released needs no cleanup.
    }
  }
}

/** The budgets of one turn, as the shared decoder counts them. */
function turnBudgets(illegalSpent: number, formatSpent: number): TurnBudgetsV1 {
  return {
    schemaVersion: 1,
    illegalMoveAttempts: Math.min(illegalSpent, MAX_ILLEGAL_MOVE_ATTEMPTS),
    formatCorrections: Math.min(formatSpent, MAX_FORMAT_CORRECTIONS),
    manualRetries: 0,
    attemptRecords: [],
  };
}

function sameTurn(left: ProviderRunnerSnapshot, right: ProviderRunnerSnapshot): boolean {
  // The turn identity is the position, the side to move, the control epoch and
  // the epochs of the service and of the seat binding. A change of any of them
  // means that the pending answer belongs to a superseded turn.
  return left.positionFen === right.positionFen &&
    left.sideToMove === right.sideToMove &&
    left.controlEpoch === right.controlEpoch &&
    (left.serviceEpoch ?? 0) === (right.serviceEpoch ?? 0) &&
    (left.seatEpoch ?? 0) === (right.seatEpoch ?? 0) &&
    left.seatControl.kind === right.seatControl.kind &&
    seatControlEpochOf(left) === seatControlEpochOf(right) &&
    right.status === 'active';
}

/**
 * Reports whether the accepted move of one side ended the turn.
 *
 * The service resets the recovery budget of a seat when the seat's own move
 * is accepted, so the budget of the browser follows the turn and not the life
 * of the runner. A control change or a retry keeps the budget of the turn.
 */
function turnEnded(left: ProviderRunnerSnapshot, right: ProviderRunnerSnapshot): boolean {
  return left.sideToMove !== right.sideToMove || left.positionFen !== right.positionFen;
}

/**
 * Reads the control epoch of the seat of one state.
 *
 * The epoch is unknown when a caller built the state without it. An unknown
 * epoch never fences the runner, because the lease of the seat is the fence
 * that protects the move.
 */
function seatControlEpochOf(snapshot: ProviderRunnerSnapshot): number | null {
  const epoch = snapshot.seatControlEpoch;
  return typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

/** The outcome of one renewal of the lease. */
type RenewOutcome =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly kind: ProviderRunnerServiceErrorKind;
    /**
     * `lease-gone` means the lease was revoked or it expired and a new one
     * may be taken. `unusable` means the runner has to fail closed. A
     * `transient` failure keeps the lease and arms the next renewal. A
     * `stale` answer belongs to a lease the runner does not hold any more, so
     * it changes nothing.
     */
    readonly state: 'lease-gone' | 'unusable' | 'transient' | 'stale';
  };

/**
 * Creates the browser runner of one agent seat.
 *
 * The runner is an ordinary object. One owner may create several runners for
 * separately requested games, and every runner owns its own lease, its own
 * conversation and its own pending record.
 */
export function createOnlineProviderRunner(options: ProviderRunnerOptions): OnlineProviderRunner {
  const { matchId, seat, leases, commands, provider } = options;
  const conversation = options.conversation ?? createMemoryConversationStore();
  const pendingStore = options.pending ?? createLocalPendingStore();
  const idFactory = options.idFactory ?? defaultIdFactory;
  const now = options.now ?? defaultNow;
  const timers = options.timers ?? defaultTimers;
  const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  const maxSubmissionAttempts = options.maxSubmissionAttempts ?? DEFAULT_MAX_SUBMISSION_ATTEMPTS;
  const autoStart = options.autoStart ?? true;
  const listeners = new Set<(state: ProviderRunnerState) => void>();

  let publicModelLabel = options.publicModelLabel;
  let snapshot: ProviderRunnerSnapshot | null = null;
  let phase: ProviderRunnerPhase = 'idle';
  let leaseRecord: ProviderRunnerLease | null = null;
  /**
   * The generation of the lease of the seat.
   *
   * The generation moves whenever the lease is taken, given back or dropped.
   * An answer of a lease request that is still in flight belongs to the
   * generation it was sent in, and it may not resurrect a lease the runner
   * does not hold any more.
   */
  let leaseGeneration = 0;
  /**
   * The generation of the lifecycle of the runner.
   *
   * The generation moves whenever the owner stops the runner, the match ends,
   * another controller takes the seat or the runner is disposed. Every answer
   * of a request that is still in flight belongs to the generation it was
   * sent in, so it may not write a phase, may not start work and may not ask
   * the provider for another answer.
   */
  let lifecycleGeneration = 0;
  let leaseId: string | null = null;
  let turnVersion: number | null = null;
  let version = 0;
  let controlEpoch = 0;
  let serviceEpoch = 0;
  let seatEpoch = 0;
  let boundSeatControlEpoch: number | null = null;
  let superseded = false;
  let illegalSpent = 0;
  let formatSpent = 0;
  let uncertainty: ProviderRunnerUncertainty | null = null;
  let lastMove: string | null = null;
  let lastError: string | null = null;
  let running = false;
  let restartRequested = false;
  /**
   * The requests whose settlement the owner decided.
   *
   * The decision of the owner is bound to the request it settled. The guard of
   * the turn asks whether the record in the store is one of them: that record
   * may be passed once, and every other record fences the runner again. A
   * boolean that lives as long as the lease would open the guard for every
   * later record.
   */
  const settledRequestIds = new Set<string>();
  /**
   * The token of the newest owner action.
   *
   * Every action of the owner takes a token before it sends its command. A
   * newer action invalidates the older one, so the newest decision of the
   * owner is the one that is applied and the older one never overwrites the
   * state of the runner.
   */
  let ownerActionToken = 0;
  let disposed = false;
  let renewHandle: number | null = null;
  let renewalFailures = 0;
  let leaseLosses = 0;
  let activeController: AbortController | null = null;
  let abortReason: 'stale' | 'lease-lost' | 'stopped' | null = null;
  let activeRequestId: string | null = null;
  let pendingSubmission: {
    action: OnlineAction;
    operationId: string;
    /** Whether the command presents the lease of the runner. */
    presentLease: boolean;
  } | null = null;
  let rejectedMoves: { move: string; reason: string }[] = [];
  let operationCounter = 0;
  let operationToken: string | null = null;
  let updatedAt = now();

  function currentState(): ProviderRunnerState {
    return {
      matchId,
      seat,
      phase,
      publicModelLabel,
      leaseId,
      controlEpoch,
      serviceEpoch,
      seatEpoch,
      boundSeatControlEpoch,
      superseded,
      turnVersion,
      version,
      illegalAttemptsSpent: illegalSpent,
      formatCorrectionsSpent: formatSpent,
      uncertainty,
      decisions: decisionsFor(phase),
      lastMove,
      lastError,
      updatedAt,
    };
  }

  function decisionsFor(state: ProviderRunnerPhase): readonly ProviderRunnerDecision[] {
    if (state === 'uncertain' || state === 'paused' || state === 'failed' || state === 'stopped') {
      return ['retry', 'switch-model', 'takeover'];
    }
    return [];
  }

  function publish(): void {
    updatedAt = now();
    const state = currentState();
    for (const listener of [...listeners]) listener(state);
    options.onState?.(state);
  }

  function setPhase(next: ProviderRunnerPhase, error?: string | null): void {
    phase = next;
    if (error !== undefined) lastError = error;
    publish();
  }

  function nextOperationId(kind: string): string {
    if (operationToken === null) {
      // The token keeps the operation identifiers of two runners of the same
      // match apart, so a runner that takes the seat after another one never
      // reuses an accepted operation identifier.
      operationToken = sanitizeIdentifier(`${idFactory()}-${leases.runnerId}`).slice(0, 40);
    }
    operationCounter += 1;
    return `op-${kind}-${operationCounter}-${operationToken}`;
  }

  function clearRenewal(): void {
    if (renewHandle === null) return;
    timers.clearTimeout(renewHandle);
    renewHandle = null;
  }

  /**
   * The time the lease of the seat still lives, or null when the lease does
   * not name an expiry.
   */
  function leaseRemainingMs(): number | null {
    if (leaseRecord === null) return null;
    const expiresAt = Date.parse(leaseRecord.expiresAt);
    if (!Number.isFinite(expiresAt)) return null;
    return expiresAt - now();
  }

  /**
   * The margin the runner keeps between the last renewal and the expiry of
   * the lease.
   *
   * The runner has to know that it lost the seat before the lease expires,
   * because the seat belongs to another runner from that moment on. One
   * renewal interval is the margin.
   */
  function expirySafetyMarginMs(): number {
    return renewIntervalMs;
  }

  /**
   * Reports whether the lease of the seat is about to expire.
   *
   * The lease of the service lives for thirty seconds. A runner that cannot
   * renew it any more must fail closed before the lease expires, because the
   * seat belongs to another runner from that moment on.
   */
  function leaseIsAboutToExpire(): boolean {
    const remaining = leaseRemainingMs();
    if (remaining === null) return false;
    return remaining <= expirySafetyMarginMs();
  }

  /**
   * The delay of the next renewal after a failed one.
   *
   * The backoff grows, but it never grows past the life of the lease: the
   * next renewal has to happen before the lease expires, and the safety
   * margin is kept. A delay of zero means that there is no time left for
   * another renewal, so the runner has to fail closed.
   */
  function renewalBackoffMs(): number {
    const factor = Math.min(2 ** renewalFailures, MAX_RENEWAL_BACKOFF_FACTOR);
    const backoff = Math.min(renewIntervalMs * factor, renewIntervalMs * MAX_RENEWAL_BACKOFF_FACTOR);
    const remaining = leaseRemainingMs();
    if (remaining === null) return backoff;
    const latest = remaining - expirySafetyMarginMs();
    if (latest <= 0) return 0;
    return Math.min(backoff, latest);
  }

  /**
   * Arms the next renewal of the lease.
   *
   * The renewal is armed on every outcome of a renewal, so a single transient
   * failure never ends the heartbeat of the seat.
   */
  function scheduleRenewal(delayMs: number = renewIntervalMs): void {
    clearRenewal();
    if (disposed || leaseRecord === null) return;
    renewHandle = timers.setTimeout(() => {
      renewHandle = null;
      void renewLease().then((outcome) => {
        if (outcome.ok) return;
        if (outcome.state === 'stale') {
          // The answer belongs to a lease the runner does not hold any more.
          // It may not resurrect the lease, arm a heartbeat or change the
          // state of the runner.
          return;
        }
        if (outcome.state === 'transient') {
          // A transient failure. The renewal is armed again with a bounded
          // backoff, and the runner fails closed when the lease is about to
          // expire.
          if (leaseIsAboutToExpire()) handleLeaseLoss();
          return;
        }
        handleLeaseLoss();
      });
    }, delayMs);
  }

  function cancelPending(reason: 'stale' | 'lease-lost' | 'stopped'): void {
    if (activeController === null) return;
    abortReason = reason;
    activeController.abort();
  }

  function handleLeaseLoss(): void {
    // The lease is gone. A provider request that may still be running becomes
    // an explicit uncertainty, and no second request is issued by itself.
    if (activeController !== null) {
      cancelPending('lease-lost');
      return;
    }
    clearRenewal();
    // The generation of the lease moves, so a renewal that is still in flight
    // cannot install the lease again after the runner gave it up.
    leaseGeneration += 1;
    leaseRecord = null;
    leaseId = null;
    const durable = pendingStore.read(matchId, seat);
    if (durable) {
      enterUncertainty(pendingUncertainty('A request of this browser may still be running.'));
      return;
    }
    setPhase('waiting-lease', 'The lease of the seat was lost.');
  }

  /** Reads the durable pending record and the lease record of the seat. */
  function pendingUncertainty(detail: string): ProviderRunnerUncertainty {
    const durable = pendingStore.read(matchId, seat);
    return {
      kind: 'provider-request',
      requestId: durable?.requestId ?? null,
      operationId: null,
      startedAt: durable?.startedAt ?? now(),
      detail,
    };
  }

  function enterUncertainty(next: ProviderRunnerUncertainty): void {
    uncertainty = next;
    if (disposed) return;
    if (phase === 'stopped') {
      // The owner stopped the runner. The uncertainty is still reported, and
      // the decisions of a stopped runner still offer the recovery, but the
      // phase of the runner stays the one the owner chose.
      publish();
      return;
    }
    setPhase('uncertain', next.detail);
  }

  async function acquireLease(): Promise<
    | { ok: true }
    | { ok: false; detail: string; stale: boolean }
  > {
    // The answer of the acquisition belongs to the lease the runner holds now.
    // A lease that is given back, replaced or dropped while the acquisition is
    // in flight may not be resurrected by the answer.
    const generation = leaseGeneration;
    try {
      const lease = await leases.acquire({ controlEpoch, turnVersion: version > 0 ? version : null });
      if (leaseResponseIsStale(generation, null, lease.leaseId)) {
        // The answer belongs to a lease the runner does not hold any more. It
        // may not install a lease, arm a heartbeat or change the phase.
        return { ok: false, detail: 'The lease of the seat was taken back.', stale: true };
      }
      leaseGeneration += 1;
      leaseRecord = lease;
      leaseId = lease.leaseId;
      turnVersion = lease.turnVersion;
      renewalFailures = 0;
      scheduleRenewal();
      return { ok: true };
    } catch (error) {
      const kind = classifyProviderRunnerError(error);
      if (kind === 'unauthorized') {
        // The credential may not act any more. The runner stops instead of
        // asking for a lease on every snapshot.
        setPhase('stopped', 'The credential of the seat was refused.');
        return { ok: false, detail: 'The credential of the seat was refused.', stale: false };
      }
      const detail = kind === 'conflict'
        ? 'Another runner holds the seat.'
        : 'The service refused the runner lease.';
      lastError = detail;
      return { ok: false, detail, stale: false };
    }
  }

  async function renewLease(): Promise<RenewOutcome> {
    if (leaseRecord === null || leaseId === null) {
      clearRenewal();
      return { ok: false, kind: 'conflict', state: 'lease-gone' };
    }
    // The response of the renewal belongs to the lease the runner holds now.
    // A lease that is given back, replaced or revoked while the renewal is in
    // flight may not be resurrected by the answer, and it may not disturb the
    // lease the runner holds now.
    const generation = leaseGeneration;
    const requestedLeaseId = leaseId;
    try {
      const lease = await leases.renew({
        controlEpoch,
        // The runner asks for the turn it acts for. A runner that did not see
        // the latest version of the match is refused instead of silently
        // rebinding to a turn it never observed.
        turnVersion: version > 0 ? version : null,
        leaseId: requestedLeaseId,
      });
      if (leaseResponseIsStale(generation, requestedLeaseId, lease.leaseId)) {
        return { ok: false, kind: 'conflict', state: 'stale' };
      }
      if (lease.status !== 'active') {
        leaseRecord = lease;
        clearRenewal();
        return { ok: false, kind: 'conflict', state: 'lease-gone' };
      }
      leaseRecord = lease;
      turnVersion = lease.turnVersion;
      renewalFailures = 0;
      leaseLosses = 0;
      scheduleRenewal();
      return { ok: true };
    } catch (error) {
      if (leaseResponseIsStale(generation, requestedLeaseId, requestedLeaseId)) {
        // The failure of a lease the runner does not hold any more may not
        // disturb the lease it holds now, and it may not arm a heartbeat.
        return { ok: false, kind: classifyProviderRunnerError(error), state: 'stale' };
      }
      const kind = classifyProviderRunnerError(error);
      renewalFailures += 1;
      if (kind === 'unauthorized') {
        // The credential may not act any more. The runner fails closed.
        clearRenewal();
        return { ok: false, kind, state: 'unusable' };
      }
      if (kind === 'conflict') {
        // The lease was revoked or it expired. The runner gives it up and
        // takes a new one.
        clearRenewal();
        return { ok: false, kind, state: 'lease-gone' };
      }
      if (leaseIsAboutToExpire()) {
        // The lease is about to expire and it could not be renewed. The
        // runner fails closed before the seat belongs to another runner.
        clearRenewal();
        return { ok: false, kind, state: 'unusable' };
      }
      // A transient failure. The heartbeat of the seat is armed again with a
      // bounded backoff, so one failed renewal never ends it. The backoff
      // never reaches past the life of the lease.
      const delay = renewalBackoffMs();
      if (delay <= 0) {
        // There is no time left for another renewal before the lease
        // expires, so the runner fails closed.
        clearRenewal();
        return { ok: false, kind, state: 'unusable' };
      }
      scheduleRenewal(delay);
      return { ok: false, kind, state: 'transient' };
    }
  }

  /**
   * Reports whether the answer of a lease request belongs to a lease the
   * runner no longer holds.
   *
   * The generation of the lease changes whenever the lease is taken, given
   * back or dropped, and the identifier of the lease names the one answer.
   * A stopped or a disposed runner holds no lease at all.
   */
  function leaseResponseIsStale(
    generation: number,
    requestedLeaseId: string | null,
    answeredLeaseId: string | null,
  ): boolean {
    if (disposed) return true;
    if (generation !== leaseGeneration) return true;
    if (requestedLeaseId !== null && answeredLeaseId !== null && requestedLeaseId !== answeredLeaseId) {
      return true;
    }
    // A lease of a match that is over is never taken and never kept.
    if (snapshot !== null && snapshot.status !== 'active') return true;
    return phase === 'stopped' && leaseRecord === null;
  }

  async function releaseLease(): Promise<void> {
    clearRenewal();
    // The generation of the lease moves on every path that gives the lease
    // back, also when no lease is held. An answer of a request that is still
    // in flight may not install a lease.
    leaseGeneration += 1;
    if (leaseRecord === null || leaseId === null) return;
    const current = leaseId;
    leaseRecord = null;
    leaseId = null;
    turnVersion = null;
    try {
      await leases.release({ controlEpoch, turnVersion: version > 0 ? version : null, leaseId: current });
    } catch {
      // A lease that cannot be released expires on its own.
    }
  }

  /** Gives up a lease that the service does not accept any more. */
  function dropLease(): void {
    clearRenewal();
    // The generation of the lease moves, so an answer of a renewal that is
    // still in flight cannot resurrect the lease.
    leaseGeneration += 1;
    leaseRecord = null;
    leaseId = null;
    turnVersion = null;
  }

  /**
   * Makes sure the lease is live and bound to the version the runner acts for.
   *
   * `allowPending` is used by the explicit owner recovery. The owner decides
   * that the uncertain work of a previous runner may be paid twice, so the new
   * lease is taken without the pending check and the pending record of the
   * service is settled.
   */
  async function ensureLease(
    allowPending = false,
  ): Promise<{ ok: true } | { ok: false; detail: string; stale: boolean }> {
    if (leaseRecord === null || leaseId === null) {
      return takeLeaseAndSettle(allowPending);
    }
    if (leaseRecord.turnVersion !== version) {
      const renewed = await renewLease();
      if (renewed.ok) return { ok: true };
      if (renewed.state === 'stale') {
        // The lease moved on while the renewal was in flight. The runner
        // takes a new lease on the next turn.
        return { ok: false, detail: 'The lease of the seat was taken back.', stale: true };
      }
      // The lease is not live any more: it was revoked or it expired. It is
      // given up and a new one is taken, so the seat keeps a lease that the
      // service accepts.
      dropLease();
      return takeLeaseAndSettle(allowPending);
    }
    return { ok: true };
  }

  /**
   * Takes the lease of the seat and settles the pending records.
   *
   * The pending record of the service belongs to the lease, and the pending
   * record of the browser belongs to the browser. A record of either of them
   * that the owner did not decide about holds the runner, because the billable
   * work may still be running.
   */
  async function takeLeaseAndSettle(
    allowPending: boolean,
  ): Promise<{ ok: true } | { ok: false; detail: string; stale: boolean }> {
    // The records the owner decided about are captured before the acquisition
    // waits for the service. A record that appears while the acquisition is in
    // flight belongs to another request, and it is neither authorized nor
    // deleted by this decision.
    const decided = new Set(settledRequestIds);
    const acquired = await acquireLease();
    if (!acquired.ok) return acquired;
    if (leaseRecord?.pendingRequestId) {
      if (!allowPending && !decided.has(leaseRecord.pendingRequestId)) {
        enterUncertainty({
          kind: 'provider-request',
          requestId: leaseRecord.pendingRequestId,
          operationId: null,
          startedAt: now(),
          detail: 'A previous runner may still have started billable work.',
        });
        return { ok: false, detail: 'A previous runner may still have started billable work.', stale: false };
      }
      if (decided.has(leaseRecord.pendingRequestId)) {
        // Only a record the owner decided about is closed. The acquisition of
        // a lease is not a decision of the owner, so it never closes a record
        // that the owner left open: a takeover leaves the uncertain record of
        // the billable work, a switch settles it on purpose.
        await clearPendingRequest(leaseRecord.pendingRequestId);
      }
    }
    const durable = pendingStore.read(matchId, seat);
    if (durable) {
      if (!allowPending && !decided.has(durable.requestId)) {
        enterUncertainty(pendingUncertainty('A previous request of this browser may still be running.'));
        return { ok: false, detail: 'A previous request of this browser may still be running.', stale: false };
      }
      if (decided.has(durable.requestId)) {
        // The record of the browser is only cleared when it is still the record
        // that was read. A second tab of the same browser shares the store and
        // may have written a newer record in the meantime.
        const current = pendingStore.read(matchId, seat);
        if (current !== null && current.requestId === durable.requestId) {
          pendingStore.clear(matchId, seat);
        }
      }
    }
    return { ok: true };
  }

  /**
   * Sends the handoff of the seat and keeps the newest decision of the owner.
   *
   * Two decisions of the owner may be in flight at the same time. The service
   * applies the one that arrives first and refuses the other one with the
   * version fence, so the refusal of the *newest* decision is sent again with
   * the version that the service has now. The older decision is never retried:
   * its intent is superseded.
   *
   * The handoff presents no lease. The service accepts the command of the
   * owner without a lease and fences a stale runner with the control epoch
   * and the version of the match, so the handoff of a seat whose lease died
   * is still the decision of the owner.
   */
  async function sendHandoff(
    command: OnlineAction,
    owner: { readonly token: number; readonly generation: number },
    kind: string,
  ): Promise<SubmitOutcome> {
    const operationId = nextOperationId(kind);
    const fence: SubmitFence = { token: owner.token, generation: owner.generation };
    let outcome = await submitAction(command, operationId, fence, { presentLease: false });
    if (outcome.kind === 'fenced' && ownerActionIsCurrent(owner.token, owner.generation)) {
      // The service refused the command because the version of the match moved
      // on: an older decision of the owner was accepted first. The newest
      // decision wins, so the command is sent again with the version the
      // runner knows now.
      outcome = await submitAction(command, operationId, fence, { presentLease: false });
    }
    return outcome;
  }

  /** Settles the pending request record of the service. */
  async function clearPendingRequest(requestId: string): Promise<void> {
    if (leaseId === null) return;
    try {
      await leases.clearRequest({
        controlEpoch,
        turnVersion: version > 0 ? version : null,
        leaseId,
        requestId,
      });
    } catch {
      // The record stays honest. The owner already decided what happens next.
    }
  }

  /**
   * The records of the uncertain work that a decision of the owner settles.
   *
   * The capture happens in the same tick as the decision of the owner, before
   * any await. A record that another tab of the same browser writes while the
   * decision waits for the service is a different request, and it is neither
   * settled nor authorized by that decision.
   */
  interface DecidedRecords {
    /** The record of the browser that the owner decided about. */
    readonly browserRequestId: string | null;
  }

  /** Captures the records of the uncertain work for a decision of the owner. */
  function captureDecidedRecords(): DecidedRecords {
    if (uncertainty === null && activeRequestId === null) {
      // The owner decided without an uncertain work. There is nothing to
      // settle, and the record of another tab is not the record of this
      // decision.
      return { browserRequestId: null };
    }
    // The uncertainty names the request the owner decided about, and a request
    // that is still running is the work of this runner. A record that another
    // tab wrote in the meantime is a different request: it neither inherits
    // the authorization nor is settled by this decision.
    return {
      browserRequestId: uncertainty?.requestId ?? activeRequestId,
    };
  }

  /**
   * Settles the pending records of the uncertain work.
   *
   * The decision of the owner accepts that the uncertain work may be paid
   * twice, so the honest record of the previous request is closed: the
   * pending record of the browser and the pending record of the service are
   * cleared. Without that, the decision of the owner would be swallowed by the
   * guard that keeps the runner from asking the provider again.
   *
   * The settlement belongs to the generation of the owner action that started
   * it. A newer action of the owner, a stop or a dispose ends it, and only
   * the records that the decision captured are closed: a newer request of
   * another tab keeps its record.
   *
   * The authorization of the owner is recorded only when the settlement
   * reached its end while the decision was still the decision of the owner.
   * A superseded decision leaves no authorization behind, so the next turn is
   * fenced again by the record it could not settle. The authorization belongs
   * to that exact record: a newer record of another tab never inherits it.
   */
  async function settleUncertainWork(
    owner: { readonly token: number; readonly generation: number },
    decided: DecidedRecords,
  ): Promise<boolean> {
    // A decision that was superseded sends nothing: the record of the
    // uncertain work stays as it is.
    if (!ownerActionIsCurrent(owner.token, owner.generation)) return false;
    if (leaseId !== null && decided.browserRequestId !== null) {
      // The record of the service carries the same request as the record of
      // the browser: the runner writes its own record after the service
      // recorded the request.
      await clearPendingRequest(decided.browserRequestId);
      if (!ownerActionIsCurrent(owner.token, owner.generation)) return false;
    }
    if (!ownerActionIsCurrent(owner.token, owner.generation)) return false;
    if (decided.browserRequestId !== null) {
      // The record of the browser is only cleared when it is still the record
      // that the owner decided about: a second tab of the same browser may
      // have written a newer one while the service answered.
      const current = pendingStore.read(matchId, seat);
      if (current !== null && current.requestId === decided.browserRequestId) {
        pendingStore.clear(matchId, seat);
      }
      // The decision of the owner is bound to this exact record.
      settledRequestIds.add(decided.browserRequestId);
    }
    return true;
  }

  /**
   * Reports whether the runner may act on the current state of the match.
   *
   * The seat control epoch is the canonical answer to the question which
   * controller plays the seat. A runner of a superseded controller never
   * submits a move, and the published label is never compared with the
   * declared one, because the service publishes a resolved label.
   */
  function shouldAct(current: ProviderRunnerSnapshot): boolean {
    if (current.status !== 'active') return false;
    if (current.sideToMove !== seat) return false;
    if (current.seatControl.kind !== 'agent') return false;
    if (superseded) return false;
    const epoch = seatControlEpochOf(current);
    if (boundSeatControlEpoch !== null && epoch !== null) {
      // A snapshot of an older epoch of the seat is stale. The runner waits
      // for the state of the seat it is bound to.
      if (epoch < boundSeatControlEpoch) return false;
      if (epoch > boundSeatControlEpoch) return false;
    }
    return true;
  }

  /** Reports whether another controller took the seat. */
  function isSuperseded(current: ProviderRunnerSnapshot): boolean {
    const epoch = seatControlEpochOf(current);
    if (boundSeatControlEpoch === null || epoch === null) return false;
    return epoch > boundSeatControlEpoch;
  }

  /** Binds the runner to the control epoch of the seat it plays. */
  function bindSeatControlEpoch(current: ProviderRunnerSnapshot): void {
    if (boundSeatControlEpoch !== null) return;
    const epoch = seatControlEpochOf(current);
    if (epoch !== null) boundSeatControlEpoch = epoch;
  }

  function positionOf(current: ProviderRunnerSnapshot): Position | null {
    try {
      return parsePosition(current.positionFen);
    } catch {
      return null;
    }
  }

  /**
   * The corrections of the current turn.
   *
   * The corrections are the private messages of the turn the runner is
   * playing. A correction of an earlier turn belongs to another position and
   * is never sent again, so the prompt of a later turn does not tell the
   * model to fix a mistake that it cannot make any more. The history of the
   * conversation itself is never cleared: the accepted moves of the game stay
   * in the store.
   */
  function correctionsOf(): readonly string[] {
    const turn = currentTurnKey();
    if (turn === null) return [];
    return conversation
      .read(matchId, seat)
      .filter((record) => record.role === 'user' && record.turn === turn)
      .map((record) => record.text);
  }

  /**
   * The canonical position of the turn the runner plays.
   *
   * The position names the turn, so a correction of the same turn is found
   * again and a correction of another turn is not.
   */
  function currentTurnKey(): string | null {
    return snapshot === null ? null : snapshot.positionFen;
  }

  /**
   * Appends one record to the private conversation of the seat.
   *
   * The record is stamped with the turn it belongs to. The history of the
   * conversation is never cleared, so the accepted moves of the game stay in
   * the store; only the prompt of a turn reads the corrections of that turn.
   */
  function appendConversation(role: 'user' | 'agent', text: string): void {
    const turn = currentTurnKey();
    conversation.append(matchId, seat, {
      id: idFactory(),
      role,
      text,
      createdAt: now(),
      ...(turn === null ? {} : { turn }),
    });
  }

  function rejectedMovesOf(): readonly { move: string; reason: string }[] {
    return rejectedMoves;
  }

  async function submitAction(
    action: OnlineAction,
    operationId: string,
    fence?: SubmitFence,
    options?: { readonly presentLease?: boolean },
  ): Promise<
    | { kind: 'accepted'; receipt: Receipt }
    | {
      readonly kind: 'fenced' | 'refused' | 'unauthorized' | 'unacknowledged' | 'superseded';
      readonly detail: string;
    }
  > {
    assertSharedActionSafe(action);
    // The handoff of the seat is the authority of the owner: it presents no
    // lease, so a lease that the service considers dead can never make the
    // owner powerless. Every other command presents the lease of the runner.
    const lease = options?.presentLease === false ? null : leaseId;
    // The operation identifier stays with the action while the acknowledgement
    // is missing, so a retry is the same operation and never a second move.
    // The bookkeeping belongs to the command that is in flight: a command of a
    // decision that was superseded never overwrites the bookkeeping of a newer
    // command that is still waiting for its acknowledgement.
    if (fence === undefined || submitFenceIsCurrent(fence)) {
      pendingSubmission = { action, operationId, presentLease: lease !== null };
    }
    for (let attempt = 0; attempt < maxSubmissionAttempts; attempt += 1) {
      if (fence !== undefined && !submitFenceIsCurrent(fence)) {
        // The decision of the owner was superseded, the runner was stopped or
        // the match ended. The command is not sent again and the shared state
        // of the runner is not changed any more.
        return { kind: 'superseded', detail: 'A newer decision of the owner ended the command.' };
      }
      try {
        const receipt = await commands.submit(action, {
          operationId,
          expectedVersion: version,
          ...(lease === null ? {} : { leaseId: lease }),
        });
        // The receipt is a fact of the service: the version and the control
        // epoch of the match move on even when the command was sent by a
        // decision that was superseded in the meantime. The next command of
        // the runner has to carry them.
        if (receipt.version > version) version = receipt.version;
        if (receipt.controlEpoch > controlEpoch) {
          controlEpoch = receipt.controlEpoch;
          commands.setControlEpoch?.(controlEpoch);
        }
        commands.setVersion?.(version);
        // The bookkeeping of the command is only cleared when it still names
        // this command. A newer command that lost its acknowledgement keeps
        // its own record, so the owner may still send it again.
        clearPendingSubmission(operationId);
        return { kind: 'accepted', receipt };
      } catch (error) {
        const kind = classifyProviderRunnerError(error);
        if (kind === 'transport' || kind === 'unavailable') {
          // The acknowledgement was lost. The operation identifier stays the
          // same, so the service answers with the original receipt and never
          // accepts a second move. A command of a decision that was superseded
          // in the meantime is not sent again.
          if (fence !== undefined && !submitFenceIsCurrent(fence)) {
            return { kind: 'superseded', detail: 'A newer decision of the owner ended the command.' };
          }
          continue;
        }
        if (kind === 'unauthorized') {
          // The credential may not act any more. The runner stops instead of
          // sending the command again.
          clearPendingSubmission(operationId);
          return { kind: 'unauthorized', detail: 'The credential of the seat was refused.' };
        }
        if (kind === 'not-found' && lease !== null) {
          // The service answers a fenced lease with a missing resource. The
          // lease was revoked, expired or belongs to another turn, so the
          // command was never a rules refusal.
          clearPendingSubmission(operationId);
          return { kind: 'fenced', detail: 'The lease of the seat no longer accepts commands.' };
        }
        if (kind === 'conflict') {
          clearPendingSubmission(operationId);
          return { kind: 'fenced', detail: 'The service refused a stale version or epoch.' };
        }
        clearPendingSubmission(operationId);
        return { kind: 'refused', detail: 'The service refused the command.' };
      }
    }
    return { kind: 'unacknowledged', detail: 'The command was sent but never acknowledged.' };
  }

  async function reportRecoveryAttempt(
    attempt: 'illegal_move' | 'formatting_correction',
    lifecycle: number,
  ): Promise<boolean> {
    const outcome = await submitAction(
      { kind: 'record_recovery_attempt', attempt },
      nextOperationId('recovery'),
      { token: null, generation: lifecycle },
    );
    if (outcome.kind === 'accepted') return true;
    if (lifecycle !== lifecycleGeneration) return false;
    if (outcome.kind === 'unauthorized') {
      await releaseLease();
      if (mayChangePhase(lifecycle)) setPhase('stopped', outcome.detail);
      return false;
    }
    if (outcome.kind === 'fenced') {
      dropLease();
      if (mayChangePhase(lifecycle)) setPhase('idle', outcome.detail);
      return false;
    }
    if (outcome.kind === 'superseded') {
      // The turn was superseded while the command was in flight. The attempt
      // is not spent, and the owner decides what happens next.
      return false;
    }
    return false;
  }

  async function playTurn(): Promise<void> {
    for (;;) {
      // The generation of the lifecycle fences every answer of a request that
      // is still in flight. The owner may stop the runner, the match may end
      // or another controller may take the seat while the runner waits.
      const lifecycle = lifecycleGeneration;
      const current = snapshot;
      if (current === null || !shouldAct(current)) {
        if (current !== null && isSuperseded(current)) {
          // Another controller took the seat. The runner gives the seat back
          // and waits for the caller to bind a new agent.
          superseded = true;
          await releaseLease();
          if (mayChangePhase(lifecycle)) setPhase('idle', 'Another controller took the seat.');
          return;
        }
        if (mayChangePhase(lifecycle)) setPhase('idle');
        return;
      }
      const leased = await ensureLease();
      if (lifecycle !== lifecycleGeneration) return;
      if (!leased.ok) {
        if (leased.stale) {
          // The answer belongs to a lease the runner does not hold any more.
          // It changes nothing.
          return;
        }
        if (phase !== 'uncertain' && mayChangePhase(lifecycle)) setPhase('waiting-lease', leased.detail);
        return;
      }
      // The lease is bound to the control epoch of the seat. The epoch is the
      // canonical answer to the question which controller plays the seat.
      bindSeatControlEpoch(current);
      const renewed = await renewLease();
      if (lifecycle !== lifecycleGeneration) return;
      if (!renewed.ok) {
        if (renewed.state === 'stale') {
          // The lease moved on while the renewal was in flight. The runner
          // waits for the state of the seat and takes a new lease then.
          return;
        }
        if (renewed.state === 'unusable') {
          // The runner fails closed. It never asks for a lease in a loop.
          dropLease();
          if (mayChangePhase(lifecycle)) setPhase('waiting-lease', 'The lease of the seat could not be kept alive.');
          return;
        }
        if (renewed.state === 'lease-gone') {
          // The lease was revoked or it expired. The runner gives it up and
          // takes a new one. A seat that another runner holds is never taken.
          dropLease();
          leaseLosses += 1;
          if (leaseLosses > MAX_LEASE_TAKEOVERS) {
            if (mayChangePhase(lifecycle)) setPhase('waiting-lease', 'The lease of the seat was lost again.');
            return;
          }
          const reacquired = await ensureLease();
          if (lifecycle !== lifecycleGeneration) return;
          if (!reacquired.ok) {
            if (reacquired.stale) return;
            if (phase !== 'uncertain' && mayChangePhase(lifecycle)) setPhase('waiting-lease', reacquired.detail);
            return;
          }
          bindSeatControlEpoch(current);
        }
      }
      const position = positionOf(current);
      if (position === null) {
        if (mayChangePhase(lifecycle)) setPhase('failed', 'The position of the match could not be read.');
        return;
      }
      // An open uncertainty or a pending record of an earlier request means
      // that billable work may still be running. The runner never asks the
      // provider for another answer by itself. The decision of the owner is
      // the one exception: it settles the pending record and lets the runner
      // ask the provider again.
      if (uncertainty !== null) return;
      const openRequest = pendingStore.read(matchId, seat);
      if (openRequest !== null) {
        if (settledRequestIds.has(openRequest.requestId)) {
          // The owner decided about this request. The decision authorises one
          // request, and it is consumed now, so every other record fences the
          // runner again.
          settledRequestIds.delete(openRequest.requestId);
        } else {
          enterUncertainty(pendingUncertainty('A request of this browser may still be running.'));
          return;
        }
      }
      const requestId = idFactory();
      const controller = new AbortController();
      activeController = controller;
      abortReason = null;
      activeRequestId = requestId;
      if (leaseId !== null) {
        try {
          await leases.beginRequest({
            controlEpoch,
            turnVersion: version > 0 ? version : null,
            leaseId,
            requestId,
          });
        } catch (error) {
          const kind = classifyProviderRunnerError(error);
          activeController = null;
          activeRequestId = null;
          if (lifecycle !== lifecycleGeneration) return;
          if (kind === 'conflict') {
            // The request never started, so it was never billed. The runner
            // gives the lease up and takes a new one.
            dropLease();
            const reacquired = await ensureLease();
            if (!reacquired.ok) {
              if (reacquired.stale) return;
              if (phase !== 'uncertain' && mayChangePhase(lifecycle)) setPhase('waiting-lease', reacquired.detail);
              return;
            }
            continue;
          }
          if (kind === 'unauthorized') {
            if (mayChangePhase(lifecycle)) setPhase('stopped', 'The credential of the seat was refused.');
            return;
          }
          // The request was not recorded, so it is not sent. A billable
          // request without a record would hide the uncertainty of a lost
          // runner from the next runner of the seat.
          if (mayChangePhase(lifecycle)) setPhase('failed', 'The service could not record the provider request.');
          return;
        }
      }
      if (lifecycle !== lifecycleGeneration || controller.signal.aborted) {
        // The owner stopped the runner while the record of the service was in
        // flight. The request is never sent, and the phase of the runner stays
        // the one the owner chose.
        activeController = null;
        activeRequestId = null;
        return;
      }
      // The pending record is written after the service recorded the request,
      // so a crash between the two leaves the honest record of the service.
      pendingStore.write({
        matchId,
        seat,
        requestId,
        turnVersion: turnVersion ?? version,
        controlEpoch,
        startedAt: now(),
      });
      if (mayChangePhase(lifecycle)) setPhase('generating');
      let answer: ProviderRunnerAnswer;
      try {
        answer = await provider.run({
          requestId,
          positionFen: current.positionFen,
          startingFen: current.startingFen,
          sideToMove: seat,
          moves: current.moves,
          clock: current.clock,
          budgets: { illegalAttemptsSpent: illegalSpent, formatCorrectionsSpent: formatSpent },
          rejectedMoves: rejectedMovesOf(),
          corrections: correctionsOf(),
          instructions: options.instructions ?? '',
          signal: controller.signal,
        });
      } catch {
        activeController = null;
        activeRequestId = null;
        // The owner decided while the request was in flight. The decision is
        // newer than this answer, so the answer writes no phase and it does
        // not swallow the uncertainty of the owner.
        if (lifecycle !== lifecycleGeneration) return;
        if (controller.signal.aborted && abortReason === 'stale') {
          if (mayChangePhase(lifecycle)) setPhase('idle', 'The answer of a superseded turn was dropped.');
          return;
        }
        if (controller.signal.aborted && abortReason === 'stopped') {
          // The owner stopped the runner. An uncertainty that is already open
          // is never swallowed, because the uncertain work has to stay
          // recoverable.
          if (uncertainty === null && mayChangePhase(lifecycle)) setPhase('stopped');
          return;
        }
        // The request may have reached the provider and been billed. The
        // uncertainty is explicit and no second request is issued by itself.
        enterUncertainty({
          kind: 'provider-request',
          requestId,
          operationId: null,
          startedAt: now(),
          detail: 'The provider request did not answer.',
        });
        return;
      }
      const aborted = controller.signal.aborted;
      activeController = null;
      activeRequestId = null;
      if (aborted) {
        if (abortReason === 'stale') {
          if (mayChangePhase(lifecycle)) setPhase('idle', 'The answer of a superseded turn was dropped.');
          return;
        }
        if (abortReason === 'lease-lost') {
          enterUncertainty({
            kind: 'provider-request',
            requestId,
            operationId: null,
            startedAt: now(),
            detail: 'The lease was lost while the provider request was running.',
          });
          return;
        }
        // The owner stopped the runner. An uncertainty that is already open is
        // never swallowed, because the uncertain work has to stay recoverable.
        if (uncertainty === null && mayChangePhase(lifecycle)) setPhase('stopped');
        return;
      }
      if (answer.uncertain) {
        enterUncertainty({
          kind: 'provider-request',
          requestId,
          operationId: null,
          startedAt: now(),
          detail: 'The provider request may still have been billed.',
        });
        return;
      }
      if (answer.terminal === 'aborted') {
        if (mayChangePhase(lifecycle)) setPhase('stopped');
        return;
      }
      if (answer.terminal === 'failed') {
        // A provider failure never concedes. The seat keeps its turn and the
        // owner recovers: the phase `failed` waits for the decision of the
        // owner, so the runner never asks the provider again by itself.
        await settleRequest(requestId);
        if (lifecycle !== lifecycleGeneration) return;
        if (mayChangePhase(lifecycle)) setPhase('failed', 'The provider request failed.');
        return;
      }
      await settleRequest(requestId);
      if (lifecycle !== lifecycleGeneration) return;
      const latest = snapshot;
      if (latest === null || !sameTurn(current, latest)) {
        if (mayChangePhase(lifecycle)) setPhase('idle', 'The answer of a superseded turn was dropped.');
        return;
      }
      // The lease is renewed before the answer is submitted. A lease that was
      // revoked or that expired while the request ran cannot accept the move,
      // and the billable work of this turn is then uncertain.
      const submitted = await renewLease();
      if (lifecycle !== lifecycleGeneration) return;
      if (!submitted.ok && submitted.state === 'stale') {
        // The lease moved on while the renewal was in flight. The answer of
        // the provider belongs to a turn the runner does not hold any more, so
        // it is not submitted. A runner that the owner stopped or that waits
        // for the owner keeps its phase: a late answer never starts it again.
        if (mayChangePhase(lifecycle)) setPhase('idle', 'The answer of a superseded turn was dropped.');
        return;
      }
      if (!submitted.ok && submitted.state !== 'transient') {
        enterUncertainty({
          kind: 'provider-request',
          requestId,
          operationId: null,
          startedAt: now(),
          detail: 'The lease was lost before the answer could be submitted.',
        });
        return;
      }
      const decision = decideCompletedAnswer({
        budgets: turnBudgets(illegalSpent, formatSpent),
        position,
        modelConfigurationIdentity: null,
        answer: { answerText: answer.answerText, position },
      });
      if (decision.kind === 'accepted-move') {
        const uci = coordinateMoveToUci(decision.move);
        lastMove = uci;
        const outcome = await submitAction(
          { kind: 'submit_move', move: uci },
          nextOperationId('move'),
          { token: null, generation: lifecycle },
        );
        if (outcome.kind === 'accepted') {
          // An accepted move ends the turn, and the service resets the
          // recovery budget of the seat with it.
          illegalSpent = 0;
          formatSpent = 0;
          rejectedMoves = [];
          await releaseLease();
          if (mayChangePhase(lifecycle)) setPhase('idle');
          return;
        }
        if (outcome.kind === 'unacknowledged') {
          enterUncertainty({
            kind: 'submission',
            requestId: null,
            operationId: pendingSubmission?.operationId ?? null,
            startedAt: now(),
            detail: outcome.detail,
          });
          return;
        }
        if (outcome.kind === 'unauthorized') {
          await releaseLease();
          if (mayChangePhase(lifecycle)) setPhase('stopped', outcome.detail);
          return;
        }
        if (outcome.kind === 'fenced') {
          // The lease fenced the command. The state moved on, so the runner
          // waits for the next snapshot instead of spending an attempt.
          dropLease();
          if (mayChangePhase(lifecycle)) setPhase('idle', outcome.detail);
          return;
        }
        if (outcome.kind === 'superseded') {
          // The turn was superseded while the command was in flight. The owner
          // decides what happens to the lease and to the phase of the runner.
          return;
        }
        // The service refused a move the browser believed to be legal. The
        // state moved on, so the runner waits for the next snapshot instead of
        // spending an attempt.
        await releaseLease();
        if (mayChangePhase(lifecycle)) setPhase('idle', outcome.detail);
        return;
      }
      if (decision.kind === 'model-resignation') {
        appendConversation('agent', decision.statement);
        const outcome = await submitAction(
          { kind: 'resign' },
          nextOperationId('resign'),
          { token: null, generation: lifecycle },
        );
        if (outcome.kind === 'accepted') {
          await releaseLease();
          if (mayChangePhase(lifecycle)) setPhase('idle');
          return;
        }
        if (outcome.kind === 'unacknowledged') {
          enterUncertainty({
            kind: 'submission',
            requestId: null,
            operationId: pendingSubmission?.operationId ?? null,
            startedAt: now(),
            detail: outcome.detail,
          });
          return;
        }
        if (outcome.kind === 'unauthorized') {
          await releaseLease();
          if (mayChangePhase(lifecycle)) setPhase('stopped', outcome.detail);
          return;
        }
        if (outcome.kind === 'fenced') {
          dropLease();
          if (mayChangePhase(lifecycle)) setPhase('idle', outcome.detail);
          return;
        }
        if (outcome.kind === 'superseded') {
          // The turn was superseded while the command was in flight. The owner
          // decides what happens to the lease and to the phase of the runner.
          return;
        }
        await releaseLease();
        if (mayChangePhase(lifecycle)) setPhase('idle', outcome.detail);
        return;
      }
      if (decision.kind === 'illegal-attempt') {
        const uci = coordinateMoveToUci(decision.record.move);
        const reported = await reportRecoveryAttempt('illegal_move', lifecycle);
        if (!reported) {
          if (phase === 'generating' && mayChangePhase(lifecycle)) setPhase('idle', 'The spent attempt was not accepted.');
          return;
        }
        // The service counts the attempt. The runner adopts the count only
        // after the service accepted it.
        illegalSpent = decision.attempt;
        rejectedMoves = [...rejectedMoves, { move: uci, reason: decision.record.violation.message }];
        appendConversation('agent', uci);
        appendConversation('user', decision.correction);
        if (decision.loss !== null) {
          // The fourth illegal attempt ends the match. The service decides the
          // result, so the runner only stops.
          await releaseLease();
          if (mayChangePhase(lifecycle)) setPhase('idle', 'The fourth illegal attempt was recorded.');
          return;
        }
        continue;
      }
      // A formatting correction. The budget is independent of the chess
      // attempts.
      if (decision.pause !== null) {
        // The automatic budget is spent. The owner recovers with Retry or a
        // switch, and no further correction is issued by itself. The spent
        // budget is not reported again, because the service refuses a
        // correction beyond its budget.
        appendConversation('user', decision.correction);
        await releaseLease();
        if (mayChangePhase(lifecycle)) setPhase('paused', 'The formatting correction budget is spent.');
        return;
      }
      const reported = await reportRecoveryAttempt('formatting_correction', lifecycle);
      if (!reported) {
        if (phase === 'generating' && mayChangePhase(lifecycle)) setPhase('idle', 'The spent correction was not accepted.');
        return;
      }
      formatSpent = decision.budgets.formatCorrections;
      appendConversation('user', decision.correction);
    }
  }

  async function settleRequest(requestId: string): Promise<void> {
    let settled = false;
    if (leaseId !== null) {
      try {
        await leases.clearRequest({
          controlEpoch,
          turnVersion: version > 0 ? version : null,
          leaseId,
          requestId,
        });
        settled = true;
      } catch {
        // A lease that cannot clear the record keeps the honest pending
        // request, which is the safer state. The record of the browser stays
        // as well, because the request may still be running.
      }
    }
    if (!settled) return;
    // The record of the browser is only cleared when it is still the record
    // that was settled: a second tab of the same browser shares the store and
    // may have written a newer one.
    const current = pendingStore.read(matchId, seat);
    if (current !== null && current.requestId === requestId) {
      pendingStore.clear(matchId, seat);
    }
  }

  /**
   * Reports whether the runner waits for an explicit owner decision.
   *
   * The phase `failed` waits as well: a provider failure is answered by the
   * owner with `retry`, `switch-model` or `takeover`, and the runner never
   * asks the provider again by itself.
   */
  function waitsForOwner(): boolean {
    return phase === 'uncertain' || phase === 'paused' || phase === 'failed' || phase === 'stopped';
  }

  /**
   * Reports whether the runner may still write its own phase.
   *
   * The phase of a runner that waits for the owner may only be left by an
   * explicit owner decision, and a disposed runner is finished. A lifecycle
   * generation that moved means that the owner stopped the runner, that the
   * match ended or that another controller took the seat, so the answer of a
   * request that was still in flight changes nothing.
   */
  function mayChangePhase(lifecycle: number = lifecycleGeneration): boolean {
    if (disposed) return false;
    if (lifecycle !== lifecycleGeneration) return false;
    return !waitsForOwner();
  }

  /** Moves the generation of the lifecycle of the runner. */
  function advanceLifecycle(): void {
    lifecycleGeneration += 1;
  }

  /**
   * Takes the token of a new owner action.
   *
   * The token orders the actions of the owner. A newer action invalidates the
   * older one, and a stop or a dispose invalidates every action that is still
   * in flight.
   */
  function nextOwnerActionToken(): number {
    ownerActionToken += 1;
    return ownerActionToken;
  }

  /**
   * The fence of one command of the runner.
   *
   * A command of an owner action belongs to the token of that action, and a
   * command of the runner's own work belongs to the generation of the
   * lifecycle it was started in. The fence decides whether the command may be
   * sent again after a lost acknowledgement: a command of a decision that was
   * superseded is never sent again, and the shared state of the runner is
   * never changed for it.
   */
  interface SubmitFence {
    /** The token of the owner action, or null for the work of the runner. */
    readonly token: number | null;
    /** The generation of the lifecycle the command belongs to. */
    readonly generation: number;
  }

  /**
   * Reports whether a command may still be sent.
   *
   * The token orders the decisions of the owner, and the generation of the
   * lifecycle fences the work of a turn that the match ended or that the
   * owner stopped. Both fences are needed: a newer decision supersedes the
   * older one, and the end of the match ends every decision that is still in
   * flight. A disposed runner holds nothing at all.
   */
  function submitFenceIsCurrent(fence: SubmitFence): boolean {
    if (disposed) return false;
    if (fence.generation !== lifecycleGeneration) return false;
    if (fence.token !== null && fence.token !== ownerActionToken) return false;
    return true;
  }

  /**
   * Reports whether an owner action is still the newest decision.
   *
   * An action that is not the newest one was superseded: it must not write a
   * phase, must not retry its command and must not change a record any more.
   * A disposed runner holds nothing at all.
   */
  function ownerActionIsCurrent(token: number, generation: number): boolean {
    return submitFenceIsCurrent({ token, generation });
  }

  /**
   * Clears the bookkeeping of a command that is answered or refused.
   *
   * The bookkeeping is only cleared when it still names the command: a newer
   * command that lost its acknowledgement keeps its own record, so the owner
   * may still send it again.
   */
  function clearPendingSubmission(operationId: string): void {
    if (pendingSubmission !== null && pendingSubmission.operationId === operationId) {
      pendingSubmission = null;
    }
  }

  /** Starts the turn without waiting for the provider answer. */
  function schedule(): void {
    if (disposed) return;
    void run().catch((error: unknown) => {
      setPhase('failed', error instanceof Error ? error.message : 'The runner failed.');
    });
  }

  async function run(): Promise<void> {
    if (disposed) return;
    if (running) {
      // The turn that is running will pick the new snapshot up.
      restartRequested = true;
      return;
    }
    if (waitsForOwner()) return;
    running = true;
    try {
      do {
        restartRequested = false;
        await playTurn();
      } while (restartRequested && !disposed && !waitsForOwner());
    } finally {
      running = false;
    }
  }

  const runner: OnlineProviderRunner = {
    matchId,
    seat,
    get state() {
      return currentState();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    applySnapshot(next) {
      if (disposed) return;
      if (next.matchId !== matchId) {
        throw new Error('A snapshot of another match cannot reach this runner.');
      }
      const previous = snapshot;
      snapshot = next;
      if (next.version > version) version = next.version;
      if (next.controlEpoch > controlEpoch) {
        controlEpoch = next.controlEpoch;
        commands.setControlEpoch?.(controlEpoch);
      }
      if (next.serviceEpoch !== undefined) serviceEpoch = next.serviceEpoch;
      if (next.seatEpoch !== undefined) seatEpoch = next.seatEpoch;
      // The service publishes a resolved label, so the published label of the
      // seat is the identity of the agent. The runner adopts it.
      if (next.seatControl.modelLabel !== undefined) publicModelLabel = next.seatControl.modelLabel;
      if (previous !== null && turnEnded(previous, next)) {
        // The turn ended. The service resets the recovery budget of the seat
        // with the accepted move, so the budget of the browser follows the
        // canonical counts of the new turn.
        illegalSpent = next.illegalAttemptsSpent;
        formatSpent = next.formatCorrectionsSpent;
        rejectedMoves = [];
      } else {
        if (next.illegalAttemptsSpent > illegalSpent) illegalSpent = next.illegalAttemptsSpent;
        if (next.formatCorrectionsSpent > formatSpent) formatSpent = next.formatCorrectionsSpent;
      }
      if (previous !== null && !sameTurn(previous, next)) {
        // The turn changed under the runner. The pending answer is stale and
        // is dropped instead of submitted.
        cancelPending('stale');
        if (activeController === null && phase === 'generating') {
          setPhase('idle', 'The answer of a superseded turn was dropped.');
        }
      }
      if (next.status !== 'active') {
        // The match is over. The pending answer is useless, the lease of the
        // seat is given back and the heartbeat stops, so a finished match
        // keeps no lease. The generation of the lifecycle moves, so an answer
        // of a request that is still in flight may not install a lease of the
        // finished match.
        advanceLifecycle();
        cancelPending('stale');
        void releaseLease();
        setPhase('idle', 'The match is over.');
        return;
      }
      publish();
      if (running) {
        restartRequested = true;
      } else if (autoStart) {
        schedule();
      }
    },
    async start() {
      if (disposed) return;
      // A stopped runner is resumable. The owner may stop an agent and start
      // it again without losing the seat.
      if (phase === 'stopped' && uncertainty === null) {
        advanceLifecycle();
        setPhase('idle');
      }
      schedule();
    },
    async resume() {
      if (disposed) return;
      if (phase === 'stopped' && uncertainty === null) {
        advanceLifecycle();
        setPhase('idle');
      }
      schedule();
    },
    async stop() {
      if (disposed) return;
      // The generation of the lifecycle moves, so an answer of a request that
      // is still in flight may not write a phase, start work or ask the
      // provider for another answer. The token of the stop ends every action
      // of the owner that is still in flight: the stop wins.
      advanceLifecycle();
      const token = nextOwnerActionToken();
      const generation = lifecycleGeneration;
      if (activeController !== null) {
        const requestId = activeRequestId;
        cancelPending('stopped');
        activeController = null;
        activeRequestId = null;
        enterUncertainty({
          kind: 'provider-request',
          requestId,
          operationId: null,
          startedAt: now(),
          detail: 'The runner stopped while a provider request was running.',
        });
        return;
      }
      await releaseLease();
      // A newer action of the owner or a dispose ends the stop: the phase of
      // the runner is the one of the newest action.
      if (!ownerActionIsCurrent(token, generation)) return;
      setPhase('stopped');
    },
    async retry(): Promise<ProviderRunnerActionOutcome> {
      if (disposed) return { kind: 'unknown', detail: 'The runner is disposed.' };
      if (phase !== 'uncertain' && phase !== 'paused' && phase !== 'failed' && phase !== 'stopped') {
        return { kind: 'unknown', detail: 'The runner waits for no decision.' };
      }
      const token = nextOwnerActionToken();
      const operation = pendingSubmission;
      // The records of the uncertain work are captured in the tick of the
      // decision, before the settlement waits for the service. A record that
      // another tab writes in the meantime is a different request, and this
      // decision neither settles it nor authorizes it.
      const decided = captureDecidedRecords();
      uncertainty = null;
      // The owner decided. The uncertain work may be paid twice, so the pending
      // records of the browser and of the service are settled and the runner
      // may ask the provider again. The generation of the lifecycle moves, so
      // an answer of the old request cannot write a phase.
      advanceLifecycle();
      const owner = { token, generation: lifecycleGeneration };
      if (!await settleUncertainWork(owner, decided)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the retry.' };
      }
      if (!ownerActionIsCurrent(owner.token, owner.generation)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the retry.' };
      }
      setPhase('idle');
      if (operation !== null) {
        // The operation identifier stays the same, so the service answers with
        // the original receipt instead of accepting a second move. The command
        // is only sent while the decision of the owner is the newest one.
        const outcome = await submitAction(
          operation.action,
          operation.operationId,
          { token: owner.token, generation: owner.generation },
          { presentLease: operation.presentLease },
        );
        if (!ownerActionIsCurrent(owner.token, owner.generation)) {
          return { kind: 'unknown', detail: 'A newer decision of the owner ended the retry.' };
        }
        if (outcome.kind === 'accepted') {
          await releaseLease();
          if (!ownerActionIsCurrent(owner.token, owner.generation)) {
            return { kind: 'unknown', detail: 'A newer decision of the owner ended the retry.' };
          }
          setPhase('idle');
          return { kind: 'accepted', publicModelLabel };
        }
        if (outcome.kind === 'unacknowledged') {
          // The acknowledgement of the command was lost. The outcome could not
          // be established, so the owner may retry.
          enterUncertainty({
            kind: 'submission',
            requestId: null,
            operationId: operation.operationId,
            startedAt: now(),
            detail: outcome.detail,
          });
          return { kind: 'unknown', detail: outcome.detail };
        }
        if (outcome.kind === 'unauthorized') {
          setPhase('stopped', outcome.detail);
          return { kind: 'refused', detail: outcome.detail };
        }
        if (outcome.kind === 'superseded') {
          return { kind: 'unknown', detail: outcome.detail };
        }
        return { kind: 'refused', detail: outcome.detail };
      }
      if (!ownerActionIsCurrent(owner.token, owner.generation)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the retry.' };
      }
      schedule();
      return { kind: 'accepted', publicModelLabel };
    },
    async switchModel(label): Promise<ProviderRunnerActionOutcome> {
      if (disposed) return { kind: 'unknown', detail: 'The runner is disposed.' };
      if (!isPublicModelLabel(label)) {
        setPhase(phase, 'A shared model label may not name a route.');
        return { kind: 'refused', detail: 'A shared model label may not name a route.' };
      }
      const token = nextOwnerActionToken();
      const generation = lifecycleGeneration;
      // The records of the uncertain work are captured in the tick of the
      // decision, before the decision waits for the service. A record that
      // another tab writes in the meantime is a different request, and this
      // decision neither settles it nor authorizes it.
      const decided = captureDecidedRecords();
      // The handoff of the seat is the authority of the owner and it needs no
      // lease: the service accepts the command of the owner without a lease
      // and fences a stale runner with the control epoch and the version of
      // the match. The runner takes the lease of the seat anyway, so the
      // pending record of the service can be closed with it. When the lease
      // cannot be taken, the handoff goes without a lease, and the outcome
      // names the reason instead of hiding it.
      const leased = await ensureLease(true);
      const leaseNote = leased.ok ? undefined : `The lease of the seat could not be taken: ${leased.detail}`;
      // A newer action of the owner ends the switch: no control change is
      // sent for a decision that is no longer the newest one.
      if (!ownerActionIsCurrent(token, generation)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the switch.' };
      }
      const command: OnlineAction = { kind: 'set_control', control: { kind: 'agent', modelLabel: label } };
      const outcome = await sendHandoff(command, { token, generation }, 'switch');
      if (!ownerActionIsCurrent(token, generation)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the switch.' };
      }
      if (outcome.kind !== 'accepted') {
        if (outcome.kind !== 'superseded') {
          setPhase(phase, 'The service refused the model switch.');
        }
        // A lost acknowledgement leaves the outcome unproven, so the owner may
        // retry. The interface never claims a success it cannot prove.
        return outcome.kind === 'unacknowledged' || outcome.kind === 'superseded'
          ? { kind: 'unknown', detail: withLeaseNote(outcome.detail, leaseNote) }
          : { kind: 'refused', detail: withLeaseNote(outcome.detail, leaseNote) };
      }
      // The service resolves the declared label to a publishable one, so the
      // runner adopts the published label of the receipt. The seat control
      // epoch of the receipt is the epoch of the seat after the change.
      const published = outcome.receipt.event?.control?.modelLabel;
      if (published !== undefined) publicModelLabel = published;
      boundSeatControlEpoch = outcome.receipt.controlEpoch;
      superseded = false;
      uncertainty = null;
      // The control of the seat changed, so the work of the old turn is
      // fenced and the generation of the lifecycle moves. The decision of the
      // owner settles the pending records, so the new agent may ask the
      // provider again.
      advanceLifecycle();
      const owner = { token, generation: lifecycleGeneration };
      if (!await settleUncertainWork(owner, decided)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the switch.' };
      }
      if (!ownerActionIsCurrent(owner.token, owner.generation)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the switch.' };
      }
      await releaseLease();
      if (!ownerActionIsCurrent(owner.token, owner.generation)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the switch.' };
      }
      setPhase('idle');
      schedule();
      return { kind: 'accepted', publicModelLabel, ...(leaseNote === undefined ? {} : { detail: leaseNote }) };
    },
    async takeover(): Promise<ProviderRunnerActionOutcome> {
      if (disposed) return { kind: 'unknown', detail: 'The runner is disposed.' };
      const token = nextOwnerActionToken();
      const generation = lifecycleGeneration;
      // The handoff of the seat is the authority of the owner and it needs no
      // lease: the service accepts the command of the owner without a lease
      // and fences a stale runner with the control epoch and the version of
      // the match. The runner takes the lease of the seat anyway, so the
      // pending record of the service can be closed with it. When the lease
      // cannot be taken, the handoff goes without a lease, and the outcome
      // names the reason instead of hiding it.
      const leased = await ensureLease(true);
      const leaseNote = leased.ok ? undefined : `The lease of the seat could not be taken: ${leased.detail}`;
      // A newer action of the owner ends the takeover: no control change is
      // sent for a decision that is no longer the newest one.
      if (!ownerActionIsCurrent(token, generation)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the takeover.' };
      }
      const command: OnlineAction = { kind: 'set_control', control: { kind: 'human' } };
      const outcome = await sendHandoff(command, { token, generation }, 'takeover');
      if (!ownerActionIsCurrent(token, generation)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the takeover.' };
      }
      if (outcome.kind !== 'accepted') {
        if (outcome.kind !== 'superseded') {
          // The refusal of the service is reported to the owner. The caller
          // keeps the binding of the seat, so the agent is not dropped
          // silently.
          setPhase(phase, 'The service refused the takeover.');
        }
        return outcome.kind === 'unacknowledged' || outcome.kind === 'superseded'
          ? { kind: 'unknown', detail: withLeaseNote(outcome.detail, leaseNote) }
          : { kind: 'refused', detail: withLeaseNote(outcome.detail, leaseNote) };
      }
      boundSeatControlEpoch = outcome.receipt.controlEpoch;
      uncertainty = null;
      // The seat belongs to the human owner now, so the work of the agent is
      // fenced and the generation of the lifecycle moves. The record of the
      // uncertain work stays open on purpose: a human owner does not pay for
      // the billable request of the agent, and the record keeps the seat
      // honest until a decision of the owner closes it.
      advanceLifecycle();
      // The generation of this decision is captured here. The check after the
      // release compares the decision with the generation it belongs to, so a
      // terminal change of the match while the release is in flight ends the
      // decision instead of passing it.
      const owner = { token, generation: lifecycleGeneration };
      await releaseLease();
      if (!ownerActionIsCurrent(owner.token, owner.generation)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the takeover.' };
      }
      setPhase('stopped', 'The seat belongs to the human owner now.');
      return { kind: 'accepted', publicModelLabel, ...(leaseNote === undefined ? {} : { detail: leaseNote }) };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      // The generation of the lifecycle moves, so an answer of a request that
      // is still in flight changes nothing.
      advanceLifecycle();
      clearRenewal();
      if (activeController !== null) {
        cancelPending('stopped');
        activeController = null;
        activeRequestId = null;
      }
      await releaseLease();
      listeners.clear();
    },
  };

  return runner;
}

/**
 * Names the lease that a handoff had to leave out.
 *
 * The handoff of the seat is the authority of the owner: it goes without a
 * lease when the lease of the seat cannot be taken. The outcome says so, so
 * the caller never has to guess why a decision was applied without the fence
 * of the runner.
 */
function withLeaseNote(detail: string, note: string | undefined): string {
  return note === undefined ? detail : `${detail} ${note}`;
}

/**
 * The coordinate move of a decision, in UCI notation.
 *
 * The helper keeps the notation of one place, so the shared command and the
 * private conversation always name the same move.
 */
export function coordinateMoveToUci(move: CoordinateMove): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}
