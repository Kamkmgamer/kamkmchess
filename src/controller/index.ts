import {
  calculateMoveClockCandidate,
  DEFAULT_TIME_CONTROL,
  readClockAt,
  recoverClockAfterAbsence,
  startClock,
} from '../clocks/index.js';
import type {
  ClockBanks,
  ClockComparisonPolicy,
  ClockReading,
  ClockSide,
  ClockState,
  TimeControl,
  TimeSample,
} from '../clocks/index.js';
import {
  applyCoordinateMove,
  createRepetitionLedger,
  IllegalMoveError,
  observeEndingFacts,
  parsePosition,
  recordPosition,
  restoreRepetitionLedger,
  legalMoves,
} from '../rules/index.js';
import type { CoordinateMove, Position } from '../rules/index.js';
import { createProofAdjudicationRunner } from '../adjudication/index.js';
import type { ProofAdjudicationRunnerV1 } from '../adjudication/index.js';
import {
  checkProofEvidence,
  createDeadnessQuery,
  createTimeoutMatingQuery,
  proofQueryIdentity,
} from '../proofs/index.js';
import type { ProofConclusion, ProofEvidence, ProofQuery, ProofSearchPassResult } from '../proofs/index.js';
import type {
  AppliedMoveV1,
  ArchiveEventV1,
  GameCheckpointV1,
  GameNamespaceV1,
  GameResultV1,
  GameStore,
  JsonValue,
  PlayerSelectionV1,
} from '../storage/index.js';

export type ModelSelection = Extract<PlayerSelectionV1, { kind: 'model' }>;
export type HumanSideChoice = ClockSide | 'random';
type ClockDiscrepancyReading = Extract<ClockReading, { status: 'reconciliation-required' }>;
type ExpiredClockReading = ClockReading & { readonly status: 'expired' };

function isExpiredClockReading(reading: ClockReading): reading is ExpiredClockReading {
  return reading.status === 'expired';
}

const INITIAL_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const GAME_CONTROLLER_INTENT_KINDS: ReadonlySet<string> = new Set([
  'begin-model-turn',
  'stop-model-turn',
  'continue-adjudication',
  'stop-adjudication',
  'human-move',
  'model-move',
]);

const ADJUDICATION_EXTENSION_KEY = 'kha32-exact-adjudication';

function isGameControllerIntentKind(kind: unknown): kind is GameControllerIntentV1['kind'] {
  return typeof kind === 'string' && GAME_CONTROLLER_INTENT_KINDS.has(kind);
}

export interface ControllerTimeSource {
  /** Use decisionTimeMs as the wall reference when called from a checkpoint decision hook. */
  sample(decisionTimeMs?: number): TimeSample;
}

export interface GameControllerOptions {
  gameId: string;
  store: GameStore;
  clockPolicy: ClockComparisonPolicy;
  timeSource?: ControllerTimeSource;
  idFactory?: () => string;
  randomSide?: () => ClockSide;
  adjudicationRunner?: ProofAdjudicationRunnerV1;
}

export interface GameControllerSetupV1 {
  humanSide: HumanSideChoice;
  modelSelection: ModelSelection;
  namespace: GameNamespaceV1;
  ownershipEpoch: number;
  startingFen?: string;
  timeControl?: TimeControl;
}

export interface ControllerFenceV1 {
  schemaVersion: 1;
  gameId: string;
  segmentId: string;
  side: ClockSide;
  revision: number;
  positionRevision: number;
  requestGeneration: number;
  analysisGeneration: number;
  ownershipEpoch: number;
  modelConfigurationIdentity: string | null;
}

export interface ControllerSnapshotV1 {
  checkpoint: GameCheckpointV1;
  position: Position;
  clockReading: ClockReading | null;
  fence: ControllerFenceV1;
  startAvailable: boolean;
  adjudication: ControllerAdjudicationStateV1 | null;
  readiness:
    | 'ready'
    | 'restore-recovery-pending'
    | 'expiry-persistence-pending'
    | 'clock-reconciliation-required'
    | 'adjudication-pending'
    | 'setup-classified';
}

export type AdjudicationCandidateKindV1 = 'deadness' | 'timeout';
export type AdjudicationCandidateStatusV1 = 'running' | 'awaiting-continuation';

export interface PendingAdjudicationCandidateV1 {
  kind: AdjudicationCandidateKindV1;
  eventId: string;
  eventAtMs: number;
  activeClockDeadlineMs: number | null;
  positionFen: string;
  clockAtEvent: GameCheckpointV1['clocks'];
  query: ProofQuery;
  status: AdjudicationCandidateStatusV1;
  attemptGeneration: number;
}

export interface ControllerAdjudicationStateV1 {
  workflow: 'setup' | 'game';
  status: 'pending' | 'setup-ready';
  candidates: readonly PendingAdjudicationCandidateV1[];
}

interface AdjudicationExtensionV1 {
  version: 1;
  data: ControllerAdjudicationStateV1 & {
    setupProof?: { query: ProofQuery; evidence: ProofEvidence };
  };
}

export interface ControllerMoveEventV1 {
  schemaVersion: 1;
  kind: 'human-move' | 'model-move';
  fence: ControllerFenceV1;
  move: CoordinateMove;
}

export type GameControllerIntentV1 =
  | { schemaVersion: 1; kind: 'begin-model-turn'; fence: ControllerFenceV1 }
  | { schemaVersion: 1; kind: 'stop-model-turn'; fence: ControllerFenceV1 }
  | { schemaVersion: 1; kind: 'continue-adjudication'; fence: ControllerFenceV1 }
  | { schemaVersion: 1; kind: 'stop-adjudication'; fence: ControllerFenceV1 }
  | ControllerMoveEventV1;

export interface ModelTurnRequestV1 {
  fence: ControllerFenceV1;
  position: Position;
  clockReading: ClockReading;
}

export type GameControllerIntentResultV1 =
  | { kind: 'model-turn-started'; snapshot: ControllerSnapshotV1; request: ModelTurnRequestV1 }
  | { kind: 'accepted'; snapshot: ControllerSnapshotV1 }
  | {
      kind: 'rejected';
      reason: 'stale-fence' | 'wrong-side' | 'not-actionable' | 'illegal-move';
      snapshot: ControllerSnapshotV1;
    }
  | { kind: 'expired'; snapshot: ControllerSnapshotV1 }
  | { kind: 'clock-reconciliation-required'; snapshot: ControllerSnapshotV1 };

export interface GameController {
  initialize(setup?: GameControllerSetupV1): Promise<ControllerSnapshotV1>;
  classifySetup(setup: GameControllerSetupV1): Promise<ControllerSnapshotV1>;
  startClassifiedSetup(setup: GameControllerSetupV1): Promise<ControllerSnapshotV1>;
  dispatch(intent: GameControllerIntentV1): Promise<GameControllerIntentResultV1>;
  reconcile(): Promise<ControllerSnapshotV1>;
  snapshot(): ControllerSnapshotV1;
  subscribe(listener: (snapshot: ControllerSnapshotV1) => void): () => void;
}

export type GameControllerErrorCode =
  | 'invalid-configuration'
  | 'invalid-intent'
  | 'invalid-setup'
  | 'setup-required'
  | 'revision-conflict'
  | 'saved-game-invalid';

export class GameControllerError extends Error {
  readonly code: GameControllerErrorCode;

  constructor(code: GameControllerErrorCode, message: string) {
    super(message);
    this.name = 'GameControllerError';
    this.code = code;
  }
}

/** Stable, secret-free identity for the exact model configuration in a request fence. */
export function modelConfigurationIdentity(selection: ModelSelection): string {
  if (
    selection.kind !== 'model' ||
    selection.providerId.length === 0 ||
    selection.connectionId.length === 0 ||
    !Number.isSafeInteger(selection.configurationRevision) ||
    selection.configurationRevision < 0 ||
    selection.modelRoutingId.length === 0 ||
    selection.modelRoutingId.trim() !== selection.modelRoutingId
  ) {
    throw new RangeError('Model configuration identity fields are invalid.');
  }

  return JSON.stringify([
    selection.providerId,
    selection.connectionId,
    selection.configurationRevision,
    selection.modelRoutingId,
    selection.protocol,
  ]);
}

const defaultTimeSource: ControllerTimeSource = {
  sample(decisionTimeMs) {
    return {
      monotonicMs: globalThis.performance.now(),
      wallTimeMs: decisionTimeMs ?? Date.now(),
    };
  },
};

const defaultIdFactory = (): string => globalThis.crypto.randomUUID();
const defaultRandomSide = (): ClockSide => (Math.random() < 0.5 ? 'white' : 'black');
interface PreparedSetup {
  readonly humanSide: ClockSide;
  readonly modelSelection: ModelSelection;
  readonly namespace: GameNamespaceV1;
  readonly ownershipEpoch: number;
  readonly startingFen: string;
  readonly position: Position;
  readonly timeControl: TimeControl;
  readonly segmentId: string;
  readonly lineId: string;
}

interface RegistryConfiguration {
  readonly store: GameStore;
  readonly timeSource: ControllerTimeSource;
  readonly clockPolicy: ClockComparisonPolicy;
  readonly adjudicationRunner?: ProofAdjudicationRunnerV1;
}

interface RecoveryReading {
  readonly reading: ClockReading;
  readonly readiness: ControllerSnapshotV1['readiness'];
}

function toClockSide(side: 'white' | 'black'): ClockSide {
  return side;
}

function fromPositionColor(color: Position['sideToMove']): ClockSide {
  return color === 'w' ? 'white' : 'black';
}

function assertClockPolicy(policy: ClockComparisonPolicy): void {
  if (!Number.isFinite(policy.maxReferenceDivergenceMs) || policy.maxReferenceDivergenceMs < 0) {
    throw new GameControllerError('invalid-configuration', 'The clock comparison policy is invalid.');
  }
}

function sampleAtDecision(timeSource: ControllerTimeSource, decisionTimeMs: number): TimeSample {
  const sample = timeSource.sample(decisionTimeMs);
  if (
    !Number.isFinite(sample.monotonicMs) ||
    !Number.isFinite(sample.wallTimeMs) ||
    sample.wallTimeMs !== decisionTimeMs ||
    (sample.hostOffsetMs !== undefined && !Number.isFinite(sample.hostOffsetMs))
  ) {
    throw new GameControllerError(
      'invalid-configuration',
      'The time source must return finite references at the supplied decision time.',
    );
  }
  return sample.hostOffsetMs === undefined
    ? { monotonicMs: sample.monotonicMs, wallTimeMs: decisionTimeMs }
    : {
        monotonicMs: sample.monotonicMs,
        wallTimeMs: decisionTimeMs,
        hostOffsetMs: sample.hostOffsetMs,
      };
}

function createClockState(checkpoint: GameCheckpointV1): ClockState | null {
  const clocks = checkpoint.clocks;
  if (clocks.schemaVersion !== 1) {
    throw new GameControllerError('saved-game-invalid', 'The saved clock schema is unsupported.');
  }
  if (clocks.activeSide === null) {
    if (clocks.anchor !== null) {
      throw new GameControllerError('saved-game-invalid', 'A stopped clock cannot retain a running anchor.');
    }
    return null;
  }
  if (clocks.anchor === null) {
    throw new GameControllerError('saved-game-invalid', 'An active clock must have a reference anchor.');
  }
  return {
    schemaVersion: clocks.schemaVersion,
    timeControl: { ...clocks.timeControl },
    banksAtAnchor: { ...clocks.banksAtAnchor },
    activeSide: clocks.activeSide,
    anchor: clocks.anchor.hostOffsetMs === undefined
      ? { monotonicMs: clocks.anchor.monotonicMs, wallTimeMs: clocks.anchor.wallTimeMs }
      : {
          monotonicMs: clocks.anchor.monotonicMs,
          wallTimeMs: clocks.anchor.wallTimeMs,
          hostOffsetMs: clocks.anchor.hostOffsetMs,
        },
  };
}

function copyNamespace(value: GameNamespaceV1): GameNamespaceV1 {
  if (typeof value !== 'object' || value === null) {
    throw new GameControllerError('invalid-setup', 'The ownership namespace is invalid.');
  }
  if (value.kind === 'guest' && Object.keys(value).length === 1) return { kind: 'guest' };
  if (
    value.kind === 'account' &&
    Object.keys(value).length === 2 &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0
  ) {
    return { kind: 'account', accountId: value.accountId };
  }
  throw new GameControllerError('invalid-setup', 'The ownership namespace is invalid.');
}

function checkpointClock(state: ClockState, lastReconciledAtMs: number): GameCheckpointV1['clocks'] {
  return {
    schemaVersion: state.schemaVersion,
    timeControl: { ...state.timeControl },
    banksAtAnchor: { ...state.banksAtAnchor },
    activeSide: state.activeSide,
    anchor: state.anchor.hostOffsetMs === undefined
      ? { monotonicMs: state.anchor.monotonicMs, wallTimeMs: state.anchor.wallTimeMs }
      : {
          monotonicMs: state.anchor.monotonicMs,
          wallTimeMs: state.anchor.wallTimeMs,
          hostOffsetMs: state.anchor.hostOffsetMs,
        },
    lastReconciledAtMs,
  };
}

function pausedClockCheckpoint(
  timeControl: TimeControl,
  banksAtAnchor: ClockBanks,
  lastReconciledAtMs: number,
  schemaVersion = 1,
): GameCheckpointV1['clocks'] {
  return {
    schemaVersion: schemaVersion as 1,
    timeControl: { ...timeControl },
    banksAtAnchor: { ...banksAtAnchor },
    activeSide: null,
    anchor: null,
    lastReconciledAtMs,
  };
}

function stopClock(state: ClockState, lastReconciledAtMs: number): GameCheckpointV1['clocks'] {
  return pausedClockCheckpoint(
    state.timeControl,
    state.banksAtAnchor,
    lastReconciledAtMs,
    state.schemaVersion,
  );
}

function finalResultForPosition(
  position: Position,
  facts: ReturnType<typeof observeEndingFacts>,
  eventId: string,
  decidedAtMs: number,
): Extract<GameResultV1, { kind: 'final' }> | null {
  const sideToMove = fromPositionColor(position.sideToMove);
  if (facts.checkmate) {
    return {
      kind: 'final',
      winner: sideToMove === 'white' ? 'black' : 'white',
      reason: 'checkmate',
      eventId,
      decidedAtMs,
    };
  }
  if (facts.stalemate) {
    return { kind: 'final', winner: 'draw', reason: 'stalemate', eventId, decidedAtMs };
  }
  if (facts.thirdRepetition) {
    return { kind: 'final', winner: 'draw', reason: 'threefold-repetition', eventId, decidedAtMs };
  }
  if (facts.hundredHalfmoves) {
    return { kind: 'final', winner: 'draw', reason: 'fifty-move-rule', eventId, decidedAtMs };
  }
  return null;
}

function sideForCheckpoint(checkpoint: GameCheckpointV1): ClockSide {
  return toClockSide(checkpoint.rules.sideToMove);
}

function createFence(checkpoint: GameCheckpointV1): ControllerFenceV1 {
  const side = sideForCheckpoint(checkpoint);
  const selection = checkpoint.selections.players[side];
  return {
    schemaVersion: 1,
    gameId: checkpoint.gameId,
    segmentId: checkpoint.segmentId,
    side,
    revision: checkpoint.revision,
    positionRevision: checkpoint.positionRevision,
    requestGeneration: checkpoint.requestGeneration,
    analysisGeneration: checkpoint.analysisGeneration,
    ownershipEpoch: checkpoint.ownershipEpoch,
    modelConfigurationIdentity: selection.kind === 'model'
      ? modelConfigurationIdentity(selection)
      : null,
  };
}

function copySnapshot(snapshot: ControllerSnapshotV1): ControllerSnapshotV1 {
  return {
    checkpoint: structuredClone(snapshot.checkpoint),
    position: snapshot.position,
    clockReading: snapshot.clockReading === null ? null : structuredClone(snapshot.clockReading),
    fence: { ...snapshot.fence },
    startAvailable: snapshot.startAvailable,
    adjudication: snapshot.adjudication === null ? null : structuredClone(snapshot.adjudication),
    readiness: snapshot.readiness,
  };
}

function freezeModelSelection(selection: ModelSelection): ModelSelection {
  return {
    kind: 'model',
    providerId: selection.providerId,
    connectionId: selection.connectionId,
    configurationRevision: selection.configurationRevision,
    modelRoutingId: selection.modelRoutingId,
    protocol: selection.protocol,
    diagnostic: selection.diagnostic,
  };
}

function prepareSetup(
  setup: GameControllerSetupV1,
  idFactory: () => string,
  randomSide: () => ClockSide,
  requireDiagnostic = true,
): PreparedSetup {
  if (requireDiagnostic && setup.modelSelection.diagnostic !== 'passed-current-session') {
    throw new GameControllerError('invalid-setup', 'A current-session model diagnostic must pass before setup.');
  }
  modelConfigurationIdentity(setup.modelSelection);
  if (!Number.isSafeInteger(setup.ownershipEpoch) || setup.ownershipEpoch < 0) {
    throw new GameControllerError('invalid-setup', 'The ownership epoch must be a nonnegative safe integer.');
  }
  const namespace = copyNamespace(setup.namespace);
  const timeControl = setup.timeControl ?? DEFAULT_TIME_CONTROL;
  if (
    !Number.isFinite(timeControl.startingTimeMs) ||
    timeControl.startingTimeMs <= 0 ||
    !Number.isFinite(timeControl.incrementMs) ||
    timeControl.incrementMs < 0
  ) {
    throw new GameControllerError('invalid-setup', 'The time control must have positive starting time and nonnegative increment.');
  }
  const humanSide = setup.humanSide === 'random' ? randomSide() : setup.humanSide;
  if (humanSide !== 'white' && humanSide !== 'black') {
    throw new GameControllerError('invalid-setup', 'The selected human side is invalid.');
  }
  const position = parsePosition(setup.startingFen ?? INITIAL_POSITION);
  const segmentId = idFactory();
  const lineId = idFactory();
  if (
    typeof segmentId !== 'string' ||
    segmentId.length === 0 ||
    typeof lineId !== 'string' ||
    lineId.length === 0 ||
    segmentId === lineId
  ) {
    throw new GameControllerError('invalid-setup', 'The identifier source must return distinct nonempty IDs.');
  }
  return {
    humanSide,
    modelSelection: freezeModelSelection(setup.modelSelection),
    namespace,
    ownershipEpoch: setup.ownershipEpoch,
    startingFen: setup.startingFen ?? INITIAL_POSITION,
    position,
    timeControl: { ...timeControl },
    segmentId,
    lineId,
  };
}

function makeCheckpoint(
  gameId: string,
  prepared: PreparedSetup,
  clock: ClockState | null,
  decisionTimeMs: number,
  createdEventId: string,
  result: GameResultV1 = { kind: 'unresolved' },
  extensions: GameCheckpointV1['extensions'] = {},
): GameCheckpointV1 {
  const ledger = createRepetitionLedger(prepared.position);
  const players: Record<ClockSide, PlayerSelectionV1> = {
    white: prepared.humanSide === 'white' ? { kind: 'human' } : prepared.modelSelection,
    black: prepared.humanSide === 'black' ? { kind: 'human' } : prepared.modelSelection,
  };
  return {
    schemaVersion: 1,
    gameId,
    namespace: structuredClone(prepared.namespace),
    revision: 1,
    ownershipEpoch: prepared.ownershipEpoch,
    segmentId: prepared.segmentId,
    positionRevision: 0,
    requestGeneration: 0,
    analysisGeneration: 0,
    updatedAtMs: decisionTimeMs,
    rules: {
      variant: 'orthodox',
      startingFen: prepared.startingFen,
      currentFen: prepared.position.fen,
      sideToMove: fromPositionColor(prepared.position.sideToMove),
      castlingRights: prepared.position.castlingRights,
      enPassantSquare: prepared.position.enPassantSquare,
      halfmoveClock: prepared.position.halfmoveClock,
      fullmoveNumber: prepared.position.fullmoveNumber,
      repetitionLedger: {
        version: 1,
        positions: ledger.entries.map((entry) => ({ ...entry })),
      },
      moves: [],
    },
    history: {
      currentSegmentId: prepared.segmentId,
      segments: [
        {
          segmentId: prepared.segmentId,
          providerId: prepared.modelSelection.providerId,
          modelRoutingId: prepared.modelSelection.modelRoutingId,
          connectionRevision: prepared.modelSelection.configurationRevision,
          startedAtMs: decisionTimeMs,
          messageIds: [],
        },
      ],
      messages: [],
    },
    clocks: clock === null
      ? pausedClockCheckpoint(
          prepared.timeControl,
          {
            whiteMs: prepared.timeControl.startingTimeMs,
            blackMs: prepared.timeControl.startingTimeMs,
          },
          decisionTimeMs,
        )
      : checkpointClock(clock, decisionTimeMs),
    budgets: {
      formattingCorrectionsRemaining: 3,
      illegalMoveAttemptsRemaining: { white: 4, black: 4 },
      manualRetriesBySide: { white: 0, black: 0 },
    },
    selections: { players },
    archive: {
      egressStatus: 'eligible',
      currentLine: { lineId: prepared.lineId, eventIds: [createdEventId] },
      discardedLines: [],
    },
    result,
    practice: {
      mode: 'ordinary',
      scored: true,
      sourceGameId: null,
      sourcePositionFen: null,
      originalResult: null,
    },
    extensions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkedClockSnapshot(value: unknown): value is GameCheckpointV1['clocks'] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.timeControl) || !isRecord(value.banksAtAnchor)) {
    return false;
  }
  if (
    !Number.isFinite(value.timeControl.startingTimeMs) ||
    (value.timeControl.startingTimeMs as number) <= 0 ||
    !Number.isFinite(value.timeControl.incrementMs) ||
    (value.timeControl.incrementMs as number) < 0 ||
    !Number.isFinite(value.banksAtAnchor.whiteMs) ||
    (value.banksAtAnchor.whiteMs as number) < 0 ||
    !Number.isFinite(value.banksAtAnchor.blackMs) ||
    (value.banksAtAnchor.blackMs as number) < 0 ||
    !Number.isFinite(value.lastReconciledAtMs)
  ) return false;
  if (value.activeSide !== null && value.activeSide !== 'white' && value.activeSide !== 'black') return false;
  if (value.anchor === null) return value.activeSide === null;
  if (!isRecord(value.anchor) || value.activeSide === null) return false;
  return Number.isFinite(value.anchor.monotonicMs) &&
    Number.isFinite(value.anchor.wallTimeMs) &&
    (value.anchor.hostOffsetMs === undefined || Number.isFinite(value.anchor.hostOffsetMs));
}

function adjudicationExtension(
  checkpoint: GameCheckpointV1,
): AdjudicationExtensionV1 | null {
  const raw = checkpoint.extensions[ADJUDICATION_EXTENSION_KEY];
  if (!raw || raw.version !== 1 || !isRecord(raw.data)) return null;
  const data = raw.data;
  if (
    (data.workflow !== 'setup' && data.workflow !== 'game') ||
    (data.status !== 'pending' && data.status !== 'setup-ready') ||
    !Array.isArray(data.candidates)
  ) return null;
  const candidates: PendingAdjudicationCandidateV1[] = [];
  let previousAt = Number.NEGATIVE_INFINITY;
  for (const item of data.candidates) {
    if (!isRecord(item) || !isRecord(item.query) || !checkedClockSnapshot(item.clockAtEvent)) return null;
    const candidate = item as unknown as PendingAdjudicationCandidateV1;
    const check = checkProofEvidence(candidate.query, undefined);
    if (
      (candidate.kind !== 'deadness' && candidate.kind !== 'timeout') ||
      typeof candidate.eventId !== 'string' || candidate.eventId.length === 0 ||
      !Number.isFinite(candidate.eventAtMs) || candidate.eventAtMs < previousAt ||
      (candidate.activeClockDeadlineMs !== null && !Number.isFinite(candidate.activeClockDeadlineMs)) ||
      typeof candidate.positionFen !== 'string' ||
      (candidate.status !== 'running' && candidate.status !== 'awaiting-continuation') ||
      !Number.isSafeInteger(candidate.attemptGeneration) || candidate.attemptGeneration < 0 ||
      check.status !== 'non-result' ||
      candidate.query.queryIdentity !== proofQueryIdentity(candidate.query) ||
      candidate.query.gameId !== checkpoint.gameId ||
      candidate.query.segmentId !== checkpoint.segmentId ||
      candidate.query.positionRevision !== String(checkpoint.positionRevision) ||
      candidate.query.ownershipEpoch !== String(checkpoint.ownershipEpoch) ||
      candidate.query.positionFen !== checkpoint.rules.currentFen ||
      candidate.positionFen !== checkpoint.rules.currentFen ||
      (candidate.kind === 'deadness' && candidate.query.predicate !== 'global-deadness') ||
      (candidate.kind === 'timeout' && candidate.query.predicate !== 'timeout-opponent-mating')
    ) return null;
    previousAt = candidate.eventAtMs;
    candidates.push(structuredClone(candidate));
  }
  if (data.status === 'pending' && candidates.length === 0) return null;
  if (data.status === 'setup-ready' && (data.workflow !== 'setup' || candidates.length !== 0)) return null;
  if (checkpoint.result.kind === 'pending-adjudication' && data.status !== 'pending') return null;
  if (checkpoint.result.kind === 'unresolved' && data.status === 'pending') return null;
  const result = checkpoint.result;
  if (result.kind === 'pending-adjudication' && candidates[0] !== undefined) {
    const first = candidates[0];
    if (
      result.eventId !== first.eventId || result.eventAtMs !== first.eventAtMs ||
      result.reason !== (first.kind === 'deadness' ? 'dead-position' : 'timeout') ||
      result.activeClockDeadlineMs !== first.activeClockDeadlineMs
    ) return null;
  }
  const state: ControllerAdjudicationStateV1 = {
    workflow: data.workflow,
    status: data.status,
    candidates,
  };
  if (data.setupProof !== undefined) {
    if (!isRecord(data.setupProof) || !isRecord(data.setupProof.query)) return null;
    const query = data.setupProof.query as unknown as ProofQuery;
    const evidence = data.setupProof.evidence as unknown as ProofEvidence;
    const checked = checkProofEvidence(query, evidence);
    if (
      data.workflow !== 'setup' || data.status !== 'setup-ready' ||
      checked.status !== 'accepted' || checked.conclusion !== 'not-dead' ||
      query.positionFen !== checkpoint.rules.startingFen ||
      query.positionRevision !== '0' || query.gameId !== checkpoint.gameId ||
      query.segmentId !== checkpoint.segmentId || query.ownershipEpoch !== String(checkpoint.ownershipEpoch)
    ) return null;
  } else if (data.workflow === 'setup' && data.status === 'setup-ready') {
    return null;
  }
  return {
    version: 1,
    data: data.setupProof === undefined
      ? state
      : { ...state, setupProof: structuredClone(data.setupProof) as unknown as { query: ProofQuery; evidence: ProofEvidence } },
  };
}

function withAdjudicationExtension(
  checkpoint: GameCheckpointV1,
  data: ControllerAdjudicationStateV1,
  setupProof?: { query: ProofQuery; evidence: ProofEvidence },
): GameCheckpointV1 {
  const extensionData = setupProof === undefined ? data : { ...data, setupProof };
  return {
    ...checkpoint,
    extensions: {
      ...checkpoint.extensions,
      [ADJUDICATION_EXTENSION_KEY]: {
        version: 1,
        data: structuredClone(extensionData) as unknown as JsonValue,
      },
    },
  };
}

function withoutAdjudicationExtension(checkpoint: GameCheckpointV1): GameCheckpointV1 {
  const extensions = { ...checkpoint.extensions };
  delete extensions[ADJUDICATION_EXTENSION_KEY];
  return { ...checkpoint, extensions };
}

function queryForCandidate(
  kind: AdjudicationCandidateKindV1,
  checkpoint: GameCheckpointV1,
  position: Position,
  expiredColor?: ClockSide,
): ProofQuery {
  const identity = {
    gameId: checkpoint.gameId,
    segmentId: checkpoint.segmentId,
    positionRevision: String(checkpoint.positionRevision),
    analysisGeneration: String(checkpoint.analysisGeneration),
    ownershipEpoch: String(checkpoint.ownershipEpoch),
    positionFen: position.fen,
  };
  if (kind === 'deadness') return createDeadnessQuery(identity);
  if (expiredColor === undefined) throw new GameControllerError('invalid-configuration', 'A timeout query needs its expired side.');
  return createTimeoutMatingQuery({ ...identity, expiredColor: expiredColor === 'white' ? 'w' : 'b' });
}

function resultForPendingCandidate(candidate: PendingAdjudicationCandidateV1): Extract<GameResultV1, { kind: 'pending-adjudication' }> {
  return {
    kind: 'pending-adjudication',
    reason: candidate.kind === 'deadness' ? 'dead-position' : 'timeout',
    eventId: candidate.eventId,
    eventAtMs: candidate.eventAtMs,
    activeClockDeadlineMs: candidate.activeClockDeadlineMs,
  };
}

function createPendingCandidate(input: {
  kind: AdjudicationCandidateKindV1;
  checkpoint: GameCheckpointV1;
  position: Position;
  eventId: string;
  eventAtMs: number;
  activeClockDeadlineMs: number | null;
  clockAtEvent: GameCheckpointV1['clocks'];
  status: AdjudicationCandidateStatusV1;
  attemptGeneration: number;
  expiredColor?: ClockSide;
}): PendingAdjudicationCandidateV1 {
  return {
    kind: input.kind,
    eventId: input.eventId,
    eventAtMs: input.eventAtMs,
    activeClockDeadlineMs: input.activeClockDeadlineMs,
    positionFen: input.position.fen,
    clockAtEvent: structuredClone(input.clockAtEvent),
    query: queryForCandidate(input.kind, input.checkpoint, input.position, input.expiredColor),
    status: input.status,
    attemptGeneration: input.attemptGeneration,
  };
}

function sameFence(left: ControllerFenceV1, right: ControllerFenceV1): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.gameId === right.gameId &&
    left.segmentId === right.segmentId &&
    left.side === right.side &&
    left.revision === right.revision &&
    left.positionRevision === right.positionRevision &&
    left.requestGeneration === right.requestGeneration &&
    left.analysisGeneration === right.analysisGeneration &&
    left.ownershipEpoch === right.ownershipEpoch &&
    left.modelConfigurationIdentity === right.modelConfigurationIdentity;
}

function validCoordinateMove(move: CoordinateMove): boolean {
  if (typeof move !== 'object' || move === null || Array.isArray(move)) return false;
  const keys = Object.keys(move);
  if (keys.some((key) => key !== 'from' && key !== 'to' && key !== 'promotion')) return false;
  if (typeof move.from !== 'string' || typeof move.to !== 'string') return false;
  return move.promotion === undefined ||
    move.promotion === 'q' ||
    move.promotion === 'r' ||
    move.promotion === 'b' ||
    move.promotion === 'n';
}

function nextUniqueId(idFactory: () => string, used: Set<string>): string {
  const id = idFactory();
  if (typeof id !== 'string' || id.length === 0 || used.has(id)) {
    throw new GameControllerError('invalid-configuration', 'The identifier source returned an empty or duplicate ID.');
  }
  used.add(id);
  return id;
}

function eventPayload(
  fence: ControllerFenceV1,
  details: unknown,
): ArchiveEventV1['payload'] {
  const versionedPayload = {
    schemaVersion: 1,
    fence: {
      schemaVersion: fence.schemaVersion,
      gameId: fence.gameId,
      segmentId: fence.segmentId,
      side: fence.side,
      revision: fence.revision,
      positionRevision: fence.positionRevision,
      requestGeneration: fence.requestGeneration,
      analysisGeneration: fence.analysisGeneration,
      ownershipEpoch: fence.ownershipEpoch,
      modelConfigurationIdentity: fence.modelConfigurationIdentity,
    },
    details,
  };
  return structuredClone(versionedPayload) as unknown as ArchiveEventV1['payload'];
}

function algebraicNotation(
  position: Position,
  move: CoordinateMove,
  facts: ReturnType<typeof observeEndingFacts>,
  isCapture: boolean,
): string {
  const movingPiece = position.pieces.find((piece) => piece.square === move.from);
  if (movingPiece === undefined) throw new Error('The legal move has no moving piece.');

  let notation: string;
  const fileDelta = move.to.charCodeAt(0) - move.from.charCodeAt(0);
  if (movingPiece.type === 'k' && Math.abs(fileDelta) === 2) {
    notation = fileDelta > 0 ? 'O-O' : 'O-O-O';
  } else {
    const isPawn = movingPiece.type === 'p';
    let disambiguation = '';
    if (!isPawn) {
      const alternatives = legalMoves(position).filter((candidate) => {
        if (candidate.from === move.from || candidate.to !== move.to) return false;
        return position.pieces.some(
          (piece) => piece.square === candidate.from && piece.type === movingPiece.type,
        );
      });
      if (alternatives.length > 0) {
        const sharesFile = alternatives.some((candidate) => candidate.from[0] === move.from[0]);
        const sharesRank = alternatives.some((candidate) => candidate.from[1] === move.from[1]);
        if (!sharesFile) disambiguation = move.from[0] ?? '';
        else if (!sharesRank) disambiguation = move.from[1] ?? '';
        else disambiguation = move.from;
      }
    }

    const pieceLetter = isPawn ? '' : movingPiece.type.toUpperCase();
    const captureMarker = isCapture ? 'x' : '';
    const pawnFile = isPawn && isCapture ? move.from[0] : '';
    const promotion = move.promotion === undefined ? '' : `=${move.promotion.toUpperCase()}`;
    notation = `${pieceLetter}${disambiguation}${pawnFile}${captureMarker}${move.to}${promotion}`;
  }

  if (facts.checkmate) return `${notation}#`;
  return facts.inCheck ? `${notation}+` : notation;
}

function recoveryReading(state: ClockState, sample: TimeSample, policy: ClockComparisonPolicy): RecoveryReading {
  const recovery = recoverClockAfterAbsence(state, sample, policy);
  if (recovery.status === 'recovered' || recovery.status === 'expired') {
    return {
      reading: {
        status: recovery.status === 'recovered' ? 'running' : 'expired',
        activeSide: state.activeSide,
        remaining: recovery.remaining,
        elapsedMs: recovery.elapsedChargedMs,
        deadline: recovery.deadline,
        evidence: recovery.evidence,
      },
      readiness: recovery.status === 'recovered'
        ? 'restore-recovery-pending'
        : 'expiry-persistence-pending',
    };
  }
  return {
    reading: {
      status: 'reconciliation-required',
      activeSide: state.activeSide,
      remaining: null,
      elapsedMs: null,
      deadline: recovery.deadline,
      evidence: recovery.evidence,
      reason: recovery.reason,
    },
    readiness: 'clock-reconciliation-required',
  };
}

interface ControllerDecisionContext {
  readonly checkpoint: GameCheckpointV1;
  readonly position: Position;
  readonly clockState: ClockState | null;
  readonly decisionTimeMs: number;
  readonly at: TimeSample;
  createEvent(
    kind: string,
    occurredAtMs: number,
    fence: ControllerFenceV1,
    details: Record<string, unknown>,
  ): ArchiveEventV1;
  createEventId(): string;
}

interface ControllerDecisionCandidate<Value> {
  readonly checkpoint: GameCheckpointV1;
  readonly position: Position;
  readonly clockState: ClockState | null;
  readonly value: Value;
}

type IntentMutationValue =
  | { kind: 'started' }
  | { kind: 'accepted' }
  | { kind: 'reconciled' }
  | { kind: 'expired' }
  | { kind: 'clock-reconciliation-required' }
  | { kind: 'rejected'; reason: 'not-actionable' | 'wrong-side' | 'illegal-move' };

class IndexedGameController implements GameController {
  private checkpoint: GameCheckpointV1 | null = null;
  private position: Position | null = null;
  private clockState: ClockState | null = null;
  private restored = false;
  private clockReconciliationRequired = false;
  private pendingClockDiscrepancy: ClockDiscrepancyReading | null = null;
  private activeRequest: ModelTurnRequestV1 | null = null;
  private activeAdjudication: {
    readonly queryIdentity: string;
    readonly attemptGeneration: number;
    readonly abortController: AbortController;
  } | null = null;
  private initialization: Promise<ControllerSnapshotV1> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: ControllerSnapshotV1) => void>();

  constructor(
    private readonly gameId: string,
    private readonly store: GameStore,
    private readonly timeSource: ControllerTimeSource,
    private readonly clockPolicy: ClockComparisonPolicy,
    private readonly idFactory: () => string,
    private readonly randomSide: () => ClockSide,
    private readonly adjudicationRunner: ProofAdjudicationRunnerV1,
  ) {}

  initialize(setup?: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
    if (this.checkpoint !== null) return Promise.resolve(this.snapshot());
    if (this.initialization !== null) return this.initialization;
    let capturedSetup = setup;
    if (setup !== undefined) {
      try {
        capturedSetup = structuredClone(setup);
      } catch {
        return Promise.reject(new GameControllerError('invalid-setup', 'The game setup must be cloneable.'));
      }
    }
    const initialization = this.loadOrCreate(capturedSetup);
    this.initialization = initialization;
    const clearInitialization = () => {
      if (this.initialization === initialization) this.initialization = null;
    };
    void initialization.then(clearInitialization, clearInitialization);
    return initialization;
  }

  classifySetup(setup: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
    if (this.checkpoint !== null) return Promise.resolve(this.snapshot());
    if (this.initialization !== null) return this.initialization;
    let capturedSetup: GameControllerSetupV1;
    try {
      capturedSetup = structuredClone(setup);
    } catch {
      return Promise.reject(new GameControllerError('invalid-setup', 'The game setup must be cloneable.'));
    }
    const initialization = this.createClassifiedSetup(capturedSetup);
    this.initialization = initialization;
    const clearInitialization = () => {
      if (this.initialization === initialization) this.initialization = null;
    };
    void initialization.then(clearInitialization, clearInitialization);
    return initialization;
  }

  startClassifiedSetup(setup: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
    let capturedSetup: GameControllerSetupV1;
    try {
      capturedSetup = structuredClone(setup);
    } catch {
      return Promise.reject(new GameControllerError('invalid-setup', 'The game setup must be cloneable.'));
    }
    const operation = this.operationQueue.then(() => this.startClassifiedSetupReady(capturedSetup));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  dispatch(intent: GameControllerIntentV1): Promise<GameControllerIntentResultV1> {
    let frozenIntent: GameControllerIntentV1;
    try {
      frozenIntent = structuredClone(intent);
    } catch {
      return Promise.reject(new GameControllerError('invalid-intent', 'The controller intent must be cloneable.'));
    }
    const operation = this.operationQueue.then(() => this.dispatchReady(frozenIntent));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  reconcile(): Promise<ControllerSnapshotV1> {
    const operation = this.operationQueue.then(() => this.reconcileReady());
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  snapshot(): ControllerSnapshotV1 {
    const checkpoint = this.checkpoint;
    const position = this.position;
    if (checkpoint === null || position === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before requesting a snapshot.');
    }
    let clockReading: ClockReading | null = null;
    let readiness: ControllerSnapshotV1['readiness'] = 'ready';
    const adjudication = adjudicationExtension(checkpoint)?.data ?? null;
    const hasNoActiveDeadline =
      checkpoint.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs === null;
    if (this.clockState !== null && checkpoint.result.kind !== 'final' && !hasNoActiveDeadline) {
      const sample = this.timeSource.sample();
      if (this.restored) {
        const recovery = recoveryReading(this.clockState, sample, this.clockPolicy);
        clockReading = recovery.reading;
        readiness = recovery.readiness;
      } else {
        clockReading = readClockAt(this.clockState, sample, this.clockPolicy);
      }
      if (clockReading.status === 'reconciliation-required') {
        this.rememberClockDiscrepancy(clockReading);
      }
      if (!this.restored && clockReading.status === 'expired') {
        readiness = 'expiry-persistence-pending';
      } else if (!this.restored && clockReading.status === 'reconciliation-required') {
        readiness = 'clock-reconciliation-required';
      }
    }
    if (this.clockReconciliationRequired) readiness = 'clock-reconciliation-required';
    if (checkpoint.result.kind === 'pending-adjudication') readiness = 'adjudication-pending';
    else if (adjudication?.workflow === 'setup' && adjudication.status === 'setup-ready') {
      readiness = 'setup-classified';
    }
    const diagnosticPassed = Object.values(checkpoint.selections.players).some(
      (selection) => selection.kind === 'model' && selection.diagnostic === 'passed-current-session',
    );
    return {
      checkpoint: structuredClone(checkpoint),
      position,
      clockReading,
      fence: createFence(checkpoint),
      startAvailable: adjudication?.workflow === 'setup' && adjudication.status === 'setup-ready' && diagnosticPassed,
      adjudication: adjudication === null
        ? (checkpoint.result.kind === 'pending-adjudication'
            ? { workflow: 'game', status: 'pending', candidates: [] }
            : null)
        : {
            workflow: adjudication.workflow,
            status: adjudication.status,
            candidates: structuredClone(adjudication.candidates),
          },
      readiness,
    };
  }

  subscribe(listener: (snapshot: ControllerSnapshotV1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enqueueSerialized<Value>(operation: () => Promise<Value>): Promise<Value> {
    const queued = this.operationQueue.then(operation);
    this.operationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private scheduleAdjudicationPass(): void {
    queueMicrotask(() => this.startPendingAdjudicationPass());
  }

  private startPendingAdjudicationPass(): void {
    if (this.activeAdjudication !== null || this.checkpoint === null) return;
    const state = adjudicationExtension(this.checkpoint)?.data;
    const candidate = state?.status === 'pending' ? state.candidates[0] : undefined;
    if (candidate === undefined || candidate.status !== 'running') return;

    const abortController = new AbortController();
    const running = {
      queryIdentity: candidate.query.queryIdentity,
      attemptGeneration: candidate.attemptGeneration,
      abortController,
    };
    this.activeAdjudication = running;
    void this.adjudicationRunner.runPass({
      namespace: this.checkpoint.namespace,
      query: structuredClone(candidate.query),
      signal: abortController.signal,
    }).then(
      (result) => this.enqueueSerialized(() => this.acceptAdjudicationPass(
        running.queryIdentity,
        running.attemptGeneration,
        result,
      )),
      () => this.enqueueSerialized(() => this.persistAdjudicationPassEnd(
        running.queryIdentity,
        running.attemptGeneration,
        'search-error',
      )),
    ).catch(() => {
      if (
        this.activeAdjudication?.queryIdentity === running.queryIdentity &&
        this.activeAdjudication.attemptGeneration === running.attemptGeneration
      ) this.activeAdjudication = null;
      const state = this.checkpoint === null ? null : adjudicationExtension(this.checkpoint)?.data;
      const candidate = state?.status === 'pending' ? state.candidates[0] : undefined;
      if (
        candidate?.status === 'running' && candidate.query.queryIdentity === running.queryIdentity &&
        candidate.attemptGeneration === running.attemptGeneration
      ) {
        void this.enqueueSerialized(() => this.persistAdjudicationPassEnd(
          running.queryIdentity,
          running.attemptGeneration,
          'search-error',
        )).catch(() => undefined);
      }
    });
  }

  private async acceptAdjudicationPass(
    queryIdentity: string,
    attemptGeneration: number,
    pass: ProofSearchPassResult,
  ): Promise<void> {
    if (
      this.activeAdjudication?.queryIdentity === queryIdentity &&
      this.activeAdjudication.attemptGeneration === attemptGeneration
    ) this.activeAdjudication = null;
    const checkpoint = this.checkpoint;
    if (checkpoint === null || checkpoint.result.kind !== 'pending-adjudication') return;
    const state = adjudicationExtension(checkpoint)?.data;
    const candidate = state?.status === 'pending' ? state.candidates[0] : undefined;
    if (
      candidate === undefined || candidate.status !== 'running' ||
      candidate.attemptGeneration !== attemptGeneration ||
      candidate.query.queryIdentity !== queryIdentity ||
      candidate.query.positionFen !== checkpoint.rules.currentFen ||
      candidate.query.ownershipEpoch !== String(checkpoint.ownershipEpoch)
    ) return;
    if (
      pass.status !== 'accepted' ||
      pass.queryIdentity !== candidate.query.queryIdentity
    ) {
      await this.persistAdjudicationPassEnd(
        queryIdentity,
        attemptGeneration,
        pass.status === 'non-result' ? pass.reason : 'invalid-query',
      );
      return;
    }

    const checked = checkProofEvidence(candidate.query, pass.evidence);
    if (
      checked.status !== 'accepted' ||
      checked.queryIdentity !== candidate.query.queryIdentity
    ) {
      await this.persistAdjudicationPassEnd(
        queryIdentity,
        attemptGeneration,
        checked.status === 'rejected' ? 'checker-rejected' : 'checker-non-result',
      );
      return;
    }
    let evidence: ProofEvidence;
    try {
      evidence = structuredClone(pass.evidence);
    } catch {
      await this.persistAdjudicationPassEnd(queryIdentity, attemptGeneration, 'checker-rejected');
      return;
    }
    await this.persistAcceptedAdjudication(queryIdentity, attemptGeneration, checked.conclusion, evidence);
  }

  private async persistAdjudicationPassEnd(
    queryIdentity: string,
    attemptGeneration: number,
    reason: string,
  ): Promise<void> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null || checkpoint.result.kind !== 'pending-adjudication') return;
    const currentState = adjudicationExtension(checkpoint)?.data;
    const current = currentState?.status === 'pending' ? currentState.candidates[0] : undefined;
    if (
      current === undefined || current.query.queryIdentity !== queryIdentity ||
      current.attemptGeneration !== attemptGeneration || current.status !== 'running'
    ) return;

    const committed = await this.commitMutation<IntentMutationValue>(null, (context) => {
      const data = adjudicationExtension(context.checkpoint)?.data;
      const first = data?.status === 'pending' ? data.candidates[0] : undefined;
      if (
        data === undefined || first === undefined || first.query.queryIdentity !== queryIdentity ||
        first.attemptGeneration !== attemptGeneration || first.status !== 'running'
      ) return { checkpoint: context.checkpoint, position: context.position, clockState: context.clockState, value: { kind: 'accepted' } };

      const candidates = [...data.candidates];
      candidates[0] = { ...first, status: 'awaiting-continuation' };
      const nextState = { ...data, status: 'pending' as const, candidates };
      const clockState = context.clockState;
      if (clockState !== null) {
        const reading = readClockAt(clockState, context.at, this.clockPolicy);
        if (reading.status === 'expired') return this.expiryCandidate(context, createFence(context.checkpoint), reading);
        if (reading.status === 'reconciliation-required') {
          const discrepancy = this.clockDiscrepancyCandidate(context, createFence(context.checkpoint), reading);
          return {
            ...discrepancy,
            checkpoint: withAdjudicationExtension(discrepancy.checkpoint, nextState),
          };
        }
      }
      const event = context.createEvent(
        'adjudication-pass-ended',
        context.decisionTimeMs,
        createFence(context.checkpoint),
        { candidateEventId: first.eventId, queryIdentity, reason },
      );
      const nextCheckpoint = withAdjudicationExtension({
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        result: resultForPendingCandidate(candidates[0]!),
        archive: {
          ...context.checkpoint.archive,
          currentLine: {
            ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId],
          },
        },
      }, nextState);
      return { checkpoint: nextCheckpoint, position: context.position, clockState, value: { kind: 'accepted' } };
    });
    if (committed.value.kind === 'clock-reconciliation-required') this.clockReconciliationRequired = true;
  }

  private async persistAcceptedAdjudication(
    queryIdentity: string,
    attemptGeneration: number,
    conclusion: ProofConclusion,
    evidence: ProofEvidence,
  ): Promise<void> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null || checkpoint.result.kind !== 'pending-adjudication') return;
    const currentState = adjudicationExtension(checkpoint)?.data;
    const current = currentState?.status === 'pending' ? currentState.candidates[0] : undefined;
    if (
      current === undefined || current.status !== 'running' ||
      current.query.queryIdentity !== queryIdentity || current.attemptGeneration !== attemptGeneration
    ) return;
    await this.commitMutation<IntentMutationValue>(null, (context) => {
      const data = adjudicationExtension(context.checkpoint)?.data;
      const first = data?.status === 'pending' ? data.candidates[0] : undefined;
      if (
        data === undefined || first === undefined || first.status !== 'running' ||
        first.query.queryIdentity !== queryIdentity || first.attemptGeneration !== attemptGeneration
      ) return { checkpoint: context.checkpoint, position: context.position, clockState: context.clockState, value: { kind: 'accepted' } };

      const currentFence = createFence(context.checkpoint);
      let baseCheckpoint = context.checkpoint;
      let candidates = [...data.candidates];
      let clockState = context.clockState;
      if (clockState !== null) {
        const reading = readClockAt(clockState, context.at, this.clockPolicy);
        if (reading.status === 'reconciliation-required') {
          const discrepancy = this.clockDiscrepancyCandidate(context, currentFence, reading);
          const heldCandidates = [...candidates];
          heldCandidates[0] = { ...first, status: 'awaiting-continuation' };
          return {
            ...discrepancy,
            checkpoint: withAdjudicationExtension(discrepancy.checkpoint, {
              ...data,
              candidates: heldCandidates,
            }),
          };
        }
        if (isExpiredClockReading(reading) && !candidates.some((candidate) => candidate.kind === 'timeout')) {
          const timeout = this.createTimeoutCandidate(context, currentFence, reading, candidates);
          baseCheckpoint = timeout.checkpoint;
          candidates = timeout.candidates;
          clockState = null;
        }
      }

      const settlementEvent = context.createEvent(
        'adjudication-evidence-accepted',
        context.decisionTimeMs,
        currentFence,
        { candidateEventId: first.eventId, query: first.query, conclusion, evidence },
      );
      candidates = candidates.slice(1);
      if (conclusion === 'dead' || conclusion === 'opponent-can-mate' || conclusion === 'opponent-cannot-mate') {
        const finalResult: Extract<GameResultV1, { kind: 'final' }> = first.kind === 'deadness'
          ? {
              kind: 'final', winner: 'draw', reason: 'dead-position',
              eventId: first.eventId, decidedAtMs: first.eventAtMs,
            }
          : {
              kind: 'final',
              winner: conclusion === 'opponent-can-mate'
                ? (first.query.predicate === 'timeout-opponent-mating' && first.query.expiredColor === 'w' ? 'black' : 'white')
                : 'draw',
              reason: 'timeout',
              eventId: first.eventId,
              decidedAtMs: first.eventAtMs,
            };
        const paused = pausedClockCheckpoint(
          first.clockAtEvent.timeControl,
          first.clockAtEvent.banksAtAnchor,
          first.eventAtMs,
          first.clockAtEvent.schemaVersion,
        );
        const finalized = withoutAdjudicationExtension({
          ...baseCheckpoint,
          clocks: paused,
          result: finalResult,
          archive: {
            ...baseCheckpoint.archive,
            currentLine: {
              ...baseCheckpoint.archive.currentLine,
              eventIds: [...baseCheckpoint.archive.currentLine.eventIds, settlementEvent.eventId],
            },
          },
        });
        return { checkpoint: finalized, position: context.position, clockState: null, value: { kind: 'accepted' } };
      }

      let nextState: ControllerAdjudicationStateV1;
      let setupProof: { query: ProofQuery; evidence: ProofEvidence } | undefined;
      if (candidates.length > 0) {
        candidates[0] = {
          ...candidates[0]!,
          status: 'running',
          attemptGeneration: candidates[0]!.attemptGeneration + 1,
        };
        nextState = { ...data, status: 'pending', candidates };
      } else if (data.workflow === 'setup') {
        setupProof = { query: first.query, evidence };
        nextState = { workflow: 'setup', status: 'setup-ready', candidates: [] };
      } else {
        const completed = withoutAdjudicationExtension({
          ...baseCheckpoint,
          result: { kind: 'unresolved' },
          archive: {
            ...baseCheckpoint.archive,
            currentLine: {
              ...baseCheckpoint.archive.currentLine,
              eventIds: [...baseCheckpoint.archive.currentLine.eventIds, settlementEvent.eventId],
            },
          },
        });
        return { checkpoint: completed, position: context.position, clockState, value: { kind: 'accepted' } };
      }
      if (setupProof !== undefined) {
        const ready = withAdjudicationExtension({
          ...baseCheckpoint,
          result: { kind: 'unresolved' },
          archive: {
            ...baseCheckpoint.archive,
            currentLine: {
              ...baseCheckpoint.archive.currentLine,
              eventIds: [...baseCheckpoint.archive.currentLine.eventIds, settlementEvent.eventId],
            },
          },
        }, nextState, setupProof);
        return { checkpoint: ready, position: context.position, clockState, value: { kind: 'accepted' } };
      }
      const nextFirst = candidates[0];
      if (nextFirst === undefined) throw new GameControllerError('invalid-configuration', 'A pending adjudication has no next candidate.');
      const withEvent = {
        ...baseCheckpoint,
        result: resultForPendingCandidate(nextFirst),
        archive: {
          ...baseCheckpoint.archive,
          currentLine: {
            ...baseCheckpoint.archive.currentLine,
            eventIds: [...baseCheckpoint.archive.currentLine.eventIds, settlementEvent.eventId],
          },
        },
      };
      const nextCheckpoint = withAdjudicationExtension(withEvent, nextState, setupProof);
      return { checkpoint: nextCheckpoint, position: context.position, clockState, value: { kind: 'accepted' } };
    });
    this.activeRequest = null;
    if (this.checkpoint?.result.kind === 'pending-adjudication') this.scheduleAdjudicationPass();
  }

  private rememberClockDiscrepancy(reading: ClockDiscrepancyReading): void {
    if (!this.clockReconciliationRequired) {
      this.pendingClockDiscrepancy = structuredClone(reading);
    }
    this.clockReconciliationRequired = true;
  }

  private async persistPendingClockDiscrepancy(): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    const reading = this.pendingClockDiscrepancy;
    if (checkpoint === null || reading === null) return this.snapshot();
    const committed = await this.commitMutation<IntentMutationValue>(createFence(checkpoint), (context) =>
      this.clockDiscrepancyCandidate(context, createFence(context.checkpoint), reading),
    );
    return committed.snapshot;
  }

  private async dispatchReady(intent: GameControllerIntentV1): Promise<GameControllerIntentResultV1> {
    if (!isGameControllerIntentKind(intent.kind)) {
      throw new GameControllerError('invalid-intent', 'The controller intent kind is unsupported.');
    }
    if (intent.schemaVersion !== 1 || !intent.fence || intent.fence.schemaVersion !== 1) {
      throw new GameControllerError('invalid-intent', 'The controller intent version or fence is invalid.');
    }
    const checkpoint = this.checkpoint;
    const position = this.position;
    if (checkpoint === null || position === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before dispatching an intent.');
    }
    let snapshot = this.snapshot();
    if (this.clockReconciliationRequired) {
      if (this.pendingClockDiscrepancy !== null) {
        snapshot = await this.persistPendingClockDiscrepancy();
      }
      return { kind: 'clock-reconciliation-required', snapshot };
    }
    if (!sameFence(createFence(checkpoint), intent.fence)) {
      return { kind: 'rejected', reason: 'stale-fence', snapshot };
    }
    if (this.restored || checkpoint.result.kind === 'final') {
      return { kind: 'rejected', reason: 'not-actionable', snapshot };
    }
    if (checkpoint.result.kind === 'pending-adjudication') {
      if (intent.kind === 'continue-adjudication') return this.continueAdjudication(intent.fence);
      if (intent.kind === 'stop-adjudication') return this.stopAdjudication(intent.fence);
      return { kind: 'rejected', reason: 'not-actionable', snapshot };
    }
    const setupState = adjudicationExtension(checkpoint)?.data;
    if (setupState?.workflow === 'setup' && setupState.status === 'setup-ready') {
      return { kind: 'rejected', reason: 'not-actionable', snapshot };
    }
    if (intent.kind === 'begin-model-turn') return this.beginModelTurn(intent.fence);
    if (intent.kind === 'stop-model-turn') return this.stopModelTurn(intent.fence);
    if (intent.kind === 'continue-adjudication' || intent.kind === 'stop-adjudication') {
      return { kind: 'rejected', reason: 'not-actionable', snapshot };
    }
    return this.acceptMove(intent);
  }

  private async reconcileReady(): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before reconciling its clock.');
    }
    if (
      this.clockState === null ||
      (checkpoint.result.kind !== 'unresolved' && checkpoint.result.kind !== 'pending-adjudication')
    ) return this.snapshot();

    await this.commitMutation<IntentMutationValue>(null, (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, createFence(context.checkpoint));
      const eventFence = createFence(context.checkpoint);
      if (this.restored) {
        const recovery = recoverClockAfterAbsence(clockState, context.at, this.clockPolicy);
        if (recovery.status === 'expired') {
          return this.expiryCandidate(context, eventFence, {
            status: 'expired',
            activeSide: clockState.activeSide,
            remaining: recovery.remaining,
            elapsedMs: recovery.elapsedChargedMs,
            deadline: recovery.deadline,
            evidence: recovery.evidence,
          });
        }
        if (recovery.status === 'reconciliation-required') {
          return this.clockDiscrepancyCandidate(context, eventFence, this.pendingClockDiscrepancy ?? {
            status: 'reconciliation-required',
            activeSide: clockState.activeSide,
            remaining: null,
            elapsedMs: null,
            deadline: recovery.deadline,
            evidence: recovery.evidence,
            reason: recovery.reason,
          });
        }
        const priorDiscrepancyEvent = this.pendingClockDiscrepancy === null
          ? null
          : context.createEvent(
              'clock-reconciliation-required',
              context.decisionTimeMs,
              eventFence,
              {
                reason: this.pendingClockDiscrepancy.reason,
                evidence: this.pendingClockDiscrepancy.evidence,
              },
            );
        const event = context.createEvent(
          'clock-absence-reconciled',
          context.decisionTimeMs,
          eventFence,
          { elapsedChargedMs: recovery.elapsedChargedMs, evidence: recovery.evidence },
        );
        return {
          checkpoint: {
            ...context.checkpoint,
            requestGeneration: context.checkpoint.requestGeneration + 1,
            analysisGeneration: context.checkpoint.analysisGeneration + 1,
            clocks: checkpointClock(recovery.clock, context.decisionTimeMs),
            archive: {
              ...context.checkpoint.archive,
              currentLine: {
                ...context.checkpoint.archive.currentLine,
                eventIds: [
                  ...context.checkpoint.archive.currentLine.eventIds,
                  ...(priorDiscrepancyEvent === null ? [] : [priorDiscrepancyEvent.eventId]),
                  event.eventId,
                ],
              },
            },
          },
          position: context.position,
          clockState: recovery.clock,
          value: { kind: 'reconciled' },
        };
      }

      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, eventFence, reading);
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(
          context,
          eventFence,
          this.pendingClockDiscrepancy ?? reading,
        );
      }
      const priorDiscrepancyEvent = this.pendingClockDiscrepancy === null
        ? null
        : context.createEvent(
            'clock-reconciliation-required',
            context.decisionTimeMs,
            eventFence,
            {
              reason: this.pendingClockDiscrepancy.reason,
              evidence: this.pendingClockDiscrepancy.evidence,
            },
          );
      const event = context.createEvent(
        'clock-reference-reconciled',
        context.decisionTimeMs,
        eventFence,
        { evidence: reading.evidence },
      );
      return {
        checkpoint: {
          ...context.checkpoint,
          requestGeneration: context.checkpoint.requestGeneration + 1,
          analysisGeneration: context.checkpoint.analysisGeneration + 1,
          clocks: checkpointClock(clockState, context.decisionTimeMs),
          archive: {
            ...context.checkpoint.archive,
            currentLine: {
              ...context.checkpoint.archive.currentLine,
              eventIds: [
                ...context.checkpoint.archive.currentLine.eventIds,
                ...(priorDiscrepancyEvent === null ? [] : [priorDiscrepancyEvent.eventId]),
                event.eventId,
              ],
            },
          },
        },
        position: context.position,
        clockState,
        value: { kind: 'reconciled' },
      };
    });
    this.activeRequest = null;
    return this.snapshot();
  }

  private async continueAdjudication(fence: ControllerFenceV1): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) throw new GameControllerError('setup-required', 'Initialize the game before continuing adjudication.');
    const state = adjudicationExtension(checkpoint)?.data;
    const candidate = state?.status === 'pending' ? state.candidates[0] : undefined;
    if (checkpoint.result.kind !== 'pending-adjudication' || candidate === undefined) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    if (
      candidate.status === 'running' && this.activeAdjudication?.queryIdentity === candidate.query.queryIdentity &&
      this.activeAdjudication.attemptGeneration === candidate.attemptGeneration
    ) return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };

    const committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
      const current = adjudicationExtension(context.checkpoint)?.data;
      const first = current?.status === 'pending' ? current.candidates[0] : undefined;
      if (
        current === undefined || first === undefined || first.query.queryIdentity !== candidate.query.queryIdentity ||
        first.status === 'running'
      ) {
        return { checkpoint: context.checkpoint, position: context.position, clockState: context.clockState, value: { kind: 'rejected', reason: 'not-actionable' } };
      }
      const clockState = context.clockState;
      if (clockState !== null) {
        const reading = readClockAt(clockState, context.at, this.clockPolicy);
        if (reading.status === 'expired') return this.expiryCandidate(context, fence, reading);
        if (reading.status === 'reconciliation-required') {
          return this.clockDiscrepancyCandidate(context, fence, reading);
        }
      }
      const nextCandidates = [...current.candidates];
      nextCandidates[0] = {
        ...first,
        status: 'running',
        attemptGeneration: first.attemptGeneration + 1,
      };
      const nextState = { ...current, status: 'pending' as const, candidates: nextCandidates };
      const nextCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
      };
      const event = context.createEvent(
        'adjudication-continued',
        context.decisionTimeMs,
        fence,
        { candidateEventId: first.eventId, queryIdentity: first.query.queryIdentity, attemptGeneration: nextCandidates[0]!.attemptGeneration },
      );
      const withEvent = {
        ...nextCheckpoint,
        result: resultForPendingCandidate(nextCandidates[0]!),
        archive: {
          ...nextCheckpoint.archive,
          currentLine: {
            ...nextCheckpoint.archive.currentLine,
            eventIds: [...nextCheckpoint.archive.currentLine.eventIds, event.eventId],
          },
        },
      };
      return {
        checkpoint: withAdjudicationExtension(withEvent, nextState),
        position: context.position,
        clockState,
        value: { kind: 'accepted' },
      };
    });
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'rejected') {
      return { kind: 'rejected', reason: committed.value.reason, snapshot: committed.snapshot };
    }
    return { kind: 'accepted', snapshot: committed.snapshot };
  }

  private async stopAdjudication(fence: ControllerFenceV1): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) throw new GameControllerError('setup-required', 'Initialize the game before stopping adjudication.');
    const state = adjudicationExtension(checkpoint)?.data;
    const candidate = state?.status === 'pending' ? state.candidates[0] : undefined;
    if (
      checkpoint.result.kind !== 'pending-adjudication' || candidate === undefined ||
      candidate.status !== 'running' || this.activeAdjudication?.queryIdentity !== candidate.query.queryIdentity ||
      this.activeAdjudication.attemptGeneration !== candidate.attemptGeneration
    ) return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };

    const committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
      const current = adjudicationExtension(context.checkpoint)?.data;
      const first = current?.status === 'pending' ? current.candidates[0] : undefined;
      if (
        current === undefined || first === undefined || first.query.queryIdentity !== candidate.query.queryIdentity ||
        first.status !== 'running' || first.attemptGeneration !== candidate.attemptGeneration
      ) {
        return { checkpoint: context.checkpoint, position: context.position, clockState: context.clockState, value: { kind: 'rejected', reason: 'not-actionable' } };
      }
      const clockState = context.clockState;
      if (clockState !== null) {
        const reading = readClockAt(clockState, context.at, this.clockPolicy);
        if (reading.status === 'expired') return this.expiryCandidate(context, fence, reading);
        if (reading.status === 'reconciliation-required') {
          return this.clockDiscrepancyCandidate(context, fence, reading);
        }
      }
      const nextCandidates = [...current.candidates];
      nextCandidates[0] = {
        ...first,
        status: 'awaiting-continuation',
        attemptGeneration: first.attemptGeneration + 1,
      };
      const nextState = { ...current, candidates: nextCandidates };
      const nextCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
      };
      const event = context.createEvent(
        'adjudication-stopped',
        context.decisionTimeMs,
        fence,
        { candidateEventId: first.eventId, queryIdentity: first.query.queryIdentity, stoppedAttemptGeneration: first.attemptGeneration },
      );
      return {
        checkpoint: withAdjudicationExtension({
          ...nextCheckpoint,
          result: resultForPendingCandidate(nextCandidates[0]!),
          archive: {
            ...nextCheckpoint.archive,
            currentLine: {
              ...nextCheckpoint.archive.currentLine,
              eventIds: [...nextCheckpoint.archive.currentLine.eventIds, event.eventId],
            },
          },
        }, nextState),
        position: context.position,
        clockState,
        value: { kind: 'accepted' },
      };
    });
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'rejected') {
      return { kind: 'rejected', reason: committed.value.reason, snapshot: committed.snapshot };
    }
    return { kind: 'accepted', snapshot: committed.snapshot };
  }

  private async beginModelTurn(fence: ControllerFenceV1): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    const position = this.position;
    if (checkpoint === null || position === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before starting a model turn.');
    }
    const side = sideForCheckpoint(checkpoint);
    if (checkpoint.selections.players[side].kind !== 'model') {
      return { kind: 'rejected', reason: 'wrong-side', snapshot: this.snapshot() };
    }
    if (this.activeRequest !== null) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    const currentFacts = observeEndingFacts(
      position,
      restoreRepetitionLedger({
        version: checkpoint.rules.repetitionLedger.version,
        entries: checkpoint.rules.repetitionLedger.positions.map((entry) => ({ ...entry })),
      }),
    );
    if (!currentFacts.hasLegalMoves) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }

    const committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
      const clockState = context.clockState;
      if (clockState === null) {
        return this.noClockCandidate(context, fence);
      }
      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, fence, reading);
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, fence, reading);
      }

      const requestCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
      };
      const requestFence = createFence(requestCheckpoint);
      const event = context.createEvent(
        'model-turn-started',
        context.decisionTimeMs,
        requestFence,
        { requestGeneration: requestCheckpoint.requestGeneration },
      );
      const nextCheckpoint = {
        ...requestCheckpoint,
        archive: {
          ...requestCheckpoint.archive,
          currentLine: {
            ...requestCheckpoint.archive.currentLine,
            eventIds: [...requestCheckpoint.archive.currentLine.eventIds, event.eventId],
          },
        },
      };
      return {
        checkpoint: nextCheckpoint,
        position: context.position,
        clockState,
        value: { kind: 'started' as const },
      };
    });

    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
    }
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'clock-reconciliation-required') {
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    const clockReading = committed.snapshot.clockReading;
    if (clockReading === null || clockReading.status !== 'running') {
      if (clockReading?.status === 'expired') {
        const expired = await this.persistCurrentExpiry();
        return { kind: 'expired', snapshot: expired };
      }
      if (clockReading?.status === 'reconciliation-required') {
        await this.persistCurrentClockDiscrepancy();
        return { kind: 'clock-reconciliation-required', snapshot: this.snapshot() };
      }
      return { kind: 'rejected', reason: 'not-actionable', snapshot: committed.snapshot };
    }
    const request = {
      fence: committed.snapshot.fence,
      position: committed.snapshot.position,
      clockReading,
    };
    this.activeRequest = request;
    return {
      kind: 'model-turn-started',
      snapshot: committed.snapshot,
      request,
    };
  }

  private async stopModelTurn(fence: ControllerFenceV1): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before stopping a model turn.');
    }
    const side = sideForCheckpoint(checkpoint);
    if (
      checkpoint.selections.players[side].kind !== 'model' ||
      this.activeRequest === null ||
      !sameFence(this.activeRequest.fence, fence)
    ) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    const committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, fence);
      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') return this.expiryCandidate(context, fence, reading);
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, fence, reading);
      }
      const nextCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
      };
      const event = context.createEvent(
        'model-turn-stopped',
        context.decisionTimeMs,
        fence,
        { stoppedRequestGeneration: fence.requestGeneration },
      );
      return {
        checkpoint: {
          ...nextCheckpoint,
          archive: {
            ...nextCheckpoint.archive,
            currentLine: {
              ...nextCheckpoint.archive.currentLine,
              eventIds: [...nextCheckpoint.archive.currentLine.eventIds, event.eventId],
            },
          },
        },
        position: context.position,
        clockState,
        value: { kind: 'accepted' },
      };
    });
    this.activeRequest = null;
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'rejected') {
      return { kind: 'rejected', reason: committed.value.reason, snapshot: committed.snapshot };
    }
    return { kind: 'accepted', snapshot: committed.snapshot };
  }

  private async acceptMove(event: ControllerMoveEventV1): Promise<GameControllerIntentResultV1> {
    const checkpoint = this.checkpoint;
    const position = this.position;
    if (checkpoint === null || position === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before accepting a move.');
    }
    const side = sideForCheckpoint(checkpoint);
    const expectedPlayer = event.kind === 'human-move' ? 'human' : 'model';
    if (checkpoint.selections.players[side].kind !== expectedPlayer) {
      return { kind: 'rejected', reason: 'wrong-side', snapshot: this.snapshot() };
    }
    if (
      event.kind === 'model-move' &&
      (this.activeRequest === null || !sameFence(this.activeRequest.fence, event.fence))
    ) {
      return { kind: 'rejected', reason: 'not-actionable', snapshot: this.snapshot() };
    }
    if (!validCoordinateMove(event.move)) {
      return { kind: 'rejected', reason: 'illegal-move', snapshot: this.snapshot() };
    }

    const committed = await this.commitMutation<IntentMutationValue>(event.fence, (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, event.fence);
      const clockCandidate = calculateMoveClockCandidate(
        clockState,
        side,
        context.at,
        this.clockPolicy,
      );
      if (clockCandidate.status === 'expired') {
        return this.expiryCandidate(context, event.fence, clockCandidate.reading);
      }
      if (clockCandidate.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, event.fence, clockCandidate.reading);
      }
      if (clockCandidate.status === 'wrong-side') {
        return {
          checkpoint: context.checkpoint,
          position: context.position,
          clockState,
          value: { kind: 'rejected' as const, reason: 'wrong-side' as const },
        };
      }

      let transition;
      try {
        transition = applyCoordinateMove(position, event.move);
      } catch (error) {
        if (!(error instanceof IllegalMoveError)) throw error;
        const nextCheckpoint = {
          ...context.checkpoint,
          revision: context.checkpoint.revision + 1,
          requestGeneration: context.checkpoint.requestGeneration + 1,
          analysisGeneration: context.checkpoint.analysisGeneration + 1,
        };
        const rejectionFence = createFence(nextCheckpoint);
        const rejectedEvent = context.createEvent(
          'illegal-move-rejected',
          context.decisionTimeMs,
          event.fence,
          { rejectedMove: { ...event.move } },
        );
        return {
          checkpoint: {
            ...nextCheckpoint,
            archive: {
              ...nextCheckpoint.archive,
              currentLine: {
                ...nextCheckpoint.archive.currentLine,
                eventIds: [...nextCheckpoint.archive.currentLine.eventIds, rejectedEvent.eventId],
              },
            },
          },
          position: context.position,
          clockState,
          value: { kind: 'rejected' as const, reason: 'illegal-move' as const, rejectionFence },
        };
      }

      const priorLedger = restoreRepetitionLedger({
        version: context.checkpoint.rules.repetitionLedger.version,
        entries: context.checkpoint.rules.repetitionLedger.positions.map((entry) => ({ ...entry })),
      });
      const nextLedger = recordPosition(priorLedger, transition.position);
      const endingFacts = observeEndingFacts(transition.position, nextLedger);
      const san = algebraicNotation(position, transition.move, endingFacts, transition.isCapture);
      const nextCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        positionRevision: context.checkpoint.positionRevision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
      };
      const moveEvent = context.createEvent(
        event.kind === 'human-move' ? 'human-move-accepted' : 'model-move-accepted',
        context.decisionTimeMs,
        event.fence,
        {
          move: {
            from: transition.move.from,
            to: transition.move.to,
            promotion: transition.move.promotion ?? null,
            san,
          },
          clock: {
            elapsedChargedMs: clockCandidate.elapsedChargedMs,
            incrementCredit: clockCandidate.incrementCredit,
            nextAnchor: clockCandidate.clock.anchor,
            evidence: clockCandidate.reading.evidence,
          },
        },
      );
      const appliedMove: AppliedMoveV1 = {
        moveId: context.createEventId(),
        from: transition.move.from,
        to: transition.move.to,
        promotion: transition.move.promotion ?? null,
        san,
        fenBefore: position.fen,
        fenAfter: transition.position.fen,
        eventId: moveEvent.eventId,
      };
      const finalResult = finalResultForPosition(
        transition.position,
        endingFacts,
        moveEvent.eventId,
        context.decisionTimeMs,
      );
      const result = finalResult ?? context.checkpoint.result;
      const rules = {
        ...context.checkpoint.rules,
        currentFen: transition.position.fen,
        sideToMove: fromPositionColor(transition.position.sideToMove),
        castlingRights: transition.position.castlingRights,
        enPassantSquare: transition.position.enPassantSquare,
        halfmoveClock: transition.position.halfmoveClock,
        fullmoveNumber: transition.position.fullmoveNumber,
        repetitionLedger: {
          version: 1 as const,
          positions: nextLedger.entries.map((entry) => ({ ...entry })),
        },
        moves: [...context.checkpoint.rules.moves, appliedMove],
      };
      let nextCheckpointWithMove: GameCheckpointV1 = {
        ...nextCheckpoint,
        rules,
        clocks: finalResult === null
          ? checkpointClock(clockCandidate.clock, context.decisionTimeMs)
          : stopClock(clockCandidate.clock, context.decisionTimeMs),
        archive: {
          ...nextCheckpoint.archive,
          currentLine: {
            ...nextCheckpoint.archive.currentLine,
            eventIds: [...nextCheckpoint.archive.currentLine.eventIds, moveEvent.eventId],
          },
        },
        result,
      };
      if (finalResult === null) {
        const clockAfterMove = clockCandidate.clock;
        const nextClockReading = readClockAt(clockAfterMove, context.at, this.clockPolicy);
        const activeClockDeadlineMs = nextClockReading.status === 'running'
          ? nextClockReading.deadline.wallTimeMs
          : null;
        const query = queryForCandidate('deadness', nextCheckpointWithMove, transition.position);
        const pendingEvent = context.createEvent(
          'adjudication-pending',
          context.decisionTimeMs,
          createFence(nextCheckpointWithMove),
          {
            candidateKind: 'deadness',
            positionFen: transition.position.fen,
            eventAtMs: context.decisionTimeMs,
            activeClockDeadlineMs,
            query,
            candidateOrder: [{ kind: 'deadness', eventAtMs: context.decisionTimeMs, queryIdentity: query.queryIdentity }],
          },
        );
        const candidate = createPendingCandidate({
          kind: 'deadness',
          checkpoint: nextCheckpointWithMove,
          position: transition.position,
          eventId: pendingEvent.eventId,
          eventAtMs: context.decisionTimeMs,
          activeClockDeadlineMs,
          clockAtEvent: checkpointClock(clockAfterMove, context.decisionTimeMs),
          status: 'running',
          attemptGeneration: 1,
        });
        nextCheckpointWithMove = withAdjudicationExtension({
          ...nextCheckpointWithMove,
          result: resultForPendingCandidate(candidate),
          archive: {
            ...nextCheckpointWithMove.archive,
            currentLine: {
              ...nextCheckpointWithMove.archive.currentLine,
              eventIds: [...nextCheckpointWithMove.archive.currentLine.eventIds, pendingEvent.eventId],
            },
          },
        }, { workflow: 'game', status: 'pending', candidates: [candidate] });
      }
      return {
        checkpoint: nextCheckpointWithMove,
        position: transition.position,
        clockState: finalResult === null ? clockCandidate.clock : null,
        value: { kind: 'accepted' as const },
      };
    });

    this.activeRequest = null;
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
    }
    if (committed.value.kind === 'expired') return { kind: 'expired', snapshot: committed.snapshot };
    if (committed.value.kind === 'clock-reconciliation-required') {
      return { kind: 'clock-reconciliation-required', snapshot: committed.snapshot };
    }
    if (committed.value.kind === 'rejected') {
      return {
        kind: 'rejected',
        reason: committed.value.reason,
        snapshot: committed.snapshot,
      };
    }
    if (committed.snapshot.checkpoint.result.kind === 'pending-adjudication') this.scheduleAdjudicationPass();
    return { kind: 'accepted', snapshot: committed.snapshot };
  }

  private noClockCandidate(
    context: ControllerDecisionContext,
    fence: ControllerFenceV1,
  ): ControllerDecisionCandidate<{ kind: 'rejected'; reason: 'not-actionable' }> {
    const event = context.createEvent(
      'clock-state-invalid',
      context.decisionTimeMs,
      fence,
      { message: 'An actionable game has no running clock.' },
    );
    return {
      checkpoint: {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        archive: {
          ...context.checkpoint.archive,
          currentLine: {
            ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId],
          },
        },
      },
      position: context.position,
      clockState: null,
      value: { kind: 'rejected', reason: 'not-actionable' },
    };
  }

  private createTimeoutCandidate(
    context: ControllerDecisionContext,
    fence: ControllerFenceV1,
    reading: ExpiredClockReading,
    earlierCandidates: readonly PendingAdjudicationCandidateV1[],
  ): { checkpoint: GameCheckpointV1; candidates: PendingAdjudicationCandidateV1[] } {
    const activeClock = context.clockState;
    if (activeClock === null) {
      throw new GameControllerError('invalid-configuration', 'A timeout candidate requires its expired clock state.');
    }
    const eventAtMs = reading.deadline.wallTimeMs;
    const expiredColor = reading.activeSide;
    const expiredBank = expiredColor === 'white' ? 'whiteMs' : 'blackMs';
    const banksAtExpiry = { ...activeClock.banksAtAnchor, [expiredBank]: 0 };
    const clockAtEvent = pausedClockCheckpoint(
      activeClock.timeControl,
      banksAtExpiry,
      eventAtMs,
      activeClock.schemaVersion,
    );
    const nextBase = {
      ...context.checkpoint,
      requestGeneration: context.checkpoint.requestGeneration + 1,
      analysisGeneration: context.checkpoint.analysisGeneration + 1,
    };
    const query = queryForCandidate('timeout', nextBase, context.position, expiredColor);
    const event = context.createEvent(
      'timeout-candidate',
      eventAtMs,
      fence,
      {
        decisionTimeMs: context.decisionTimeMs,
        originalExpiryAtMs: eventAtMs,
        deadline: reading.deadline,
        evidence: reading.evidence,
        fenceGeneration: {
          revision: fence.revision,
          positionRevision: fence.positionRevision,
          analysisGeneration: fence.analysisGeneration,
          ownershipEpoch: fence.ownershipEpoch,
        },
        query,
        candidateOrder: [
          ...earlierCandidates.map((candidate) => ({
            eventId: candidate.eventId,
            kind: candidate.kind,
            eventAtMs: candidate.eventAtMs,
            queryIdentity: candidate.query.queryIdentity,
          })),
          {
            eventRef: 'current-event',
            kind: 'timeout',
            eventAtMs,
            queryIdentity: query.queryIdentity,
          },
        ],
      },
    );
    const candidates: PendingAdjudicationCandidateV1[] = earlierCandidates.map((candidate) => ({
      ...candidate,
      status: 'awaiting-continuation' as const,
      attemptGeneration: candidate.attemptGeneration + (candidate.status === 'running' ? 1 : 0),
    }));
    candidates.push({
      kind: 'timeout',
      eventId: event.eventId,
      eventAtMs,
      activeClockDeadlineMs: null,
      positionFen: context.position.fen,
      clockAtEvent,
      query,
      status: earlierCandidates.length === 0 ? 'running' : 'awaiting-continuation',
      attemptGeneration: earlierCandidates.length === 0 ? 1 : 0,
    });
    candidates.sort((left, right) => left.eventAtMs - right.eventAtMs);
    const nextState: ControllerAdjudicationStateV1 = {
      workflow: adjudicationExtension(context.checkpoint)?.data.workflow ?? 'game',
      status: 'pending',
      candidates,
    };
    const nextCheckpoint = withAdjudicationExtension({
      ...nextBase,
      clocks: clockAtEvent,
      result: resultForPendingCandidate(candidates[0]!),
      archive: {
        ...context.checkpoint.archive,
        currentLine: {
          ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId],
        },
      },
    }, nextState);
    return { checkpoint: nextCheckpoint, candidates };
  }

  private expiryCandidate(
    context: ControllerDecisionContext,
    fence: ControllerFenceV1,
    reading: ClockReading,
  ): ControllerDecisionCandidate<IntentMutationValue> {
    if (!isExpiredClockReading(reading)) {
      throw new GameControllerError('invalid-configuration', 'An expiry decision needs an expired clock reading.');
    }
    const existing = adjudicationExtension(context.checkpoint)?.data;
    const savedTimeout = existing?.status === 'pending'
      ? existing.candidates.find((candidate) => candidate.kind === 'timeout')
      : undefined;
    if (savedTimeout !== undefined) {
      return {
        checkpoint: { ...context.checkpoint, clocks: structuredClone(savedTimeout.clockAtEvent) },
        position: context.position,
        clockState: null,
        value: { kind: 'expired' },
      };
    }
    const pending = this.createTimeoutCandidate(
      context,
      fence,
      reading,
      existing?.status === 'pending' ? existing.candidates : [],
    );
    return {
      checkpoint: pending.checkpoint,
      position: context.position,
      clockState: null,
      value: { kind: 'expired' },
    };
  }

  private clockDiscrepancyCandidate(
    context: ControllerDecisionContext,
    fence: ControllerFenceV1,
    reading: ClockReading,
  ): ControllerDecisionCandidate<IntentMutationValue> {
    if (reading.status !== 'reconciliation-required') {
      throw new GameControllerError('invalid-configuration', 'A clock discrepancy decision needs a reconciliation reading.');
    }
    const event = context.createEvent(
      'clock-reconciliation-required',
      context.decisionTimeMs,
      fence,
      { reason: reading.reason, evidence: reading.evidence },
    );
    return {
      checkpoint: {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        archive: {
          ...context.checkpoint.archive,
          currentLine: {
            ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId],
          },
        },
      },
      position: context.position,
      clockState: context.clockState,
      value: { kind: 'clock-reconciliation-required' },
    };
  }

  private async commitMutation<Value extends { kind: string }>(
    expectedFence: ControllerFenceV1 | null,
    decide: (context: ControllerDecisionContext) => ControllerDecisionCandidate<Value>,
  ): Promise<{ snapshot: ControllerSnapshotV1; value: Value }> {
    const baseCheckpoint = this.checkpoint;
    const basePosition = this.position;
    if (baseCheckpoint === null || basePosition === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before committing an intent.');
    }
    if (expectedFence !== null && !sameFence(createFence(baseCheckpoint), expectedFence)) {
      throw new GameControllerError('invalid-intent', 'The intent fence became stale before commit.');
    }

    const stored = await this.store.readGame(this.gameId);
    if (
      stored === null ||
      stored.checkpoint.revision !== baseCheckpoint.revision ||
      stored.checkpoint.ownershipEpoch !== baseCheckpoint.ownershipEpoch
    ) {
      throw new GameControllerError('revision-conflict', 'The saved checkpoint changed before the controller decision.');
    }
    const usedIds = new Set(stored.events.map((event) => event.eventId));
    let nextSequence = stored.events.reduce((highest, event) => Math.max(highest, event.sequence), -1) + 1;
    const acceptedCandidate: { value: ControllerDecisionCandidate<Value> | null } = { value: null };
    const generatedEvents: ArchiveEventV1[] = [];

    const result = await this.store.commitCheckpoint({
      gameId: this.gameId,
      expectedRevision: baseCheckpoint.revision,
      expectedEpoch: baseCheckpoint.ownershipEpoch,
      events: [],
      chunks: [],
      knownCredentials: [],
      decide: (decisionTimeMs) => {
        if (this.checkpoint !== baseCheckpoint) {
          throw new GameControllerError('revision-conflict', 'The controller checkpoint changed during the decision.');
        }
        if (expectedFence !== null && !sameFence(createFence(baseCheckpoint), expectedFence)) {
          throw new GameControllerError('invalid-intent', 'The intent fence changed before its decision.');
        }
        const at = sampleAtDecision(this.timeSource, decisionTimeMs);
        const context: ControllerDecisionContext = {
          checkpoint: baseCheckpoint,
          position: basePosition,
          clockState: this.clockState,
          decisionTimeMs,
          at,
          createEvent: (kind, occurredAtMs, fence, details) => {
            if (!Number.isFinite(occurredAtMs) || nextSequence > Number.MAX_SAFE_INTEGER) {
              throw new GameControllerError('invalid-configuration', 'A controller event has invalid time or sequence data.');
            }
            const eventId = nextUniqueId(this.idFactory, usedIds);
            const event: ArchiveEventV1 = {
              eventId,
              gameId: this.gameId,
              sequence: nextSequence,
              segmentId: baseCheckpoint.segmentId,
              kind,
              occurredAtMs,
              receiveState: 'complete',
              egressStatus: 'eligible',
              payload: eventPayload(fence, details),
              chunkIds: [],
            };
            nextSequence += 1;
            generatedEvents.push(event);
            return event;
          },
          createEventId: () => nextUniqueId(this.idFactory, usedIds),
        };
        const candidate = decide(context);
        const nextCheckpoint: GameCheckpointV1 = {
          ...candidate.checkpoint,
          revision: baseCheckpoint.revision + 1,
          updatedAtMs: decisionTimeMs,
        };
        acceptedCandidate.value = { ...candidate, checkpoint: nextCheckpoint };
        return {
          checkpoint: nextCheckpoint,
          events: generatedEvents,
          outboxOperationIds: [],
        };
      },
    });
    if (result.kind === 'revision-conflict') {
      throw new GameControllerError('revision-conflict', 'The persisted game revision or ownership epoch changed.');
    }
    if (acceptedCandidate.value === null) {
      throw new GameControllerError('revision-conflict', 'The checkpoint decision produced no controller state.');
    }
    this.checkpoint = result.checkpoint;
    this.position = acceptedCandidate.value.position;
    this.clockState = acceptedCandidate.value.clockState;
    if (acceptedCandidate.value.value.kind === 'expired') this.activeRequest = null;
    if (acceptedCandidate.value.value.kind === 'reconciled') this.restored = false;
    if (acceptedCandidate.value.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
      this.pendingClockDiscrepancy = null;
      this.activeRequest = null;
    } else if (acceptedCandidate.value.value.kind === 'reconciled') {
      this.clockReconciliationRequired = false;
      this.pendingClockDiscrepancy = null;
      this.activeRequest = null;
    }
    const pendingState = adjudicationExtension(this.checkpoint)?.data;
    const activeCandidate = pendingState?.status === 'pending' ? pendingState.candidates[0] : undefined;
    if (
      this.activeAdjudication !== null &&
      (activeCandidate === undefined || activeCandidate.status !== 'running' ||
        activeCandidate.query.queryIdentity !== this.activeAdjudication.queryIdentity ||
        activeCandidate.attemptGeneration !== this.activeAdjudication.attemptGeneration)
    ) {
      this.activeAdjudication.abortController.abort();
      this.activeAdjudication = null;
    }
    const snapshot = this.snapshot();
    this.publish(snapshot);
    if (activeCandidate?.status === 'running' && this.activeAdjudication === null) this.scheduleAdjudicationPass();
    return { snapshot, value: acceptedCandidate.value.value };
  }

  private async persistCurrentExpiry(): Promise<ControllerSnapshotV1> {
    return this.persistCurrentClockStatus();
  }

  private async persistCurrentClockDiscrepancy(): Promise<ControllerSnapshotV1> {
    return this.persistCurrentClockStatus();
  }

  private async persistCurrentClockStatus(): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before reconciling its clock.');
    }
    const committed = await this.commitMutation<IntentMutationValue>(createFence(checkpoint), (context) => {
      const clockState = context.clockState;
      if (clockState === null) return this.noClockCandidate(context, createFence(context.checkpoint));
      const reading = readClockAt(clockState, context.at, this.clockPolicy);
      if (reading.status === 'expired') {
        return this.expiryCandidate(context, createFence(context.checkpoint), reading);
      }
      if (reading.status === 'reconciliation-required') {
        return this.clockDiscrepancyCandidate(context, createFence(context.checkpoint), reading);
      }
      const currentFence = createFence(context.checkpoint);
      const event = context.createEvent(
        'clock-reference-rechecked',
        context.decisionTimeMs,
        currentFence,
        { status: reading.status, evidence: reading.evidence },
      );
      return {
        checkpoint: {
          ...context.checkpoint,
          revision: context.checkpoint.revision + 1,
          requestGeneration: context.checkpoint.requestGeneration + 1,
          analysisGeneration: context.checkpoint.analysisGeneration + 1,
          archive: {
            ...context.checkpoint.archive,
            currentLine: {
              ...context.checkpoint.archive.currentLine,
              eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId],
            },
          },
        },
        position: context.position,
        clockState,
        value: { kind: 'accepted' },
      };
    });
    if (committed.value.kind === 'clock-reconciliation-required') {
      this.clockReconciliationRequired = true;
    }
    return committed.snapshot;
  }

  private async createClassifiedSetup(setup: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
    const existing = await this.store.readGame(this.gameId);
    if (existing !== null) {
      this.restore(existing.checkpoint, existing.events);
      const snapshot = this.snapshot();
      this.publish(snapshot);
      return snapshot;
    }
    const prepared = prepareSetup({
      ...setup,
      modelSelection: { ...setup.modelSelection, diagnostic: 'not-run' },
    }, this.idFactory, this.randomSide, false);
    let decisionCompleted = false;
    const result = await this.store.commitCheckpoint({
      gameId: this.gameId,
      expectedRevision: null,
      expectedEpoch: prepared.ownershipEpoch,
      events: [],
      chunks: [],
      knownCredentials: [],
      decide: (decisionTimeMs) => {
        const usedIds = new Set([prepared.segmentId, prepared.lineId]);
        const createdEventId = nextUniqueId(this.idFactory, usedIds);
        const startingFacts = observeEndingFacts(prepared.position, createRepetitionLedger(prepared.position));
        const terminalResult = finalResultForPosition(
          prepared.position,
          startingFacts,
          createdEventId,
          decisionTimeMs,
        );
        const eventFence = {
          gameId: this.gameId,
          segmentId: prepared.segmentId,
          side: fromPositionColor(prepared.position.sideToMove),
          revision: 1,
          positionRevision: 0,
          requestGeneration: 0,
          analysisGeneration: terminalResult === null ? 1 : 0,
          ownershipEpoch: prepared.ownershipEpoch,
          modelConfigurationIdentity: modelConfigurationIdentity(prepared.modelSelection),
          schemaVersion: 1 as const,
        } satisfies ControllerFenceV1;
        let checkpoint = makeCheckpoint(
          this.gameId,
          prepared,
          null,
          decisionTimeMs,
          createdEventId,
          terminalResult ?? { kind: 'unresolved' },
        );
        if (terminalResult === null) checkpoint = { ...checkpoint, analysisGeneration: 1 };
        const createdEvent: ArchiveEventV1 = {
          eventId: createdEventId,
          gameId: this.gameId,
          sequence: 0,
          segmentId: prepared.segmentId,
          kind: 'game-created',
          occurredAtMs: decisionTimeMs,
          receiveState: 'complete',
          egressStatus: 'eligible',
          payload: eventPayload(eventFence, {
            humanSide: prepared.humanSide,
            startingFen: prepared.startingFen,
            timeControl: prepared.timeControl,
            classifiedBeforeClock: true,
            ...(terminalResult === null ? {} : { result: terminalResult }),
          }),
          chunkIds: [],
        };
        let events: ArchiveEventV1[] = [createdEvent];
        if (terminalResult === null) {
          const query = queryForCandidate('deadness', checkpoint, prepared.position);
          const eventId = nextUniqueId(this.idFactory, usedIds);
          const pendingEvent: ArchiveEventV1 = {
            eventId,
            gameId: this.gameId,
            sequence: 1,
            segmentId: prepared.segmentId,
            kind: 'setup-classification-pending',
            occurredAtMs: decisionTimeMs,
            receiveState: 'complete',
            egressStatus: 'eligible',
            payload: eventPayload(eventFence, {
              candidateKind: 'deadness',
              positionFen: prepared.position.fen,
              eventAtMs: decisionTimeMs,
              activeClockDeadlineMs: null,
              query,
              candidateOrder: [{ kind: 'deadness', eventAtMs: decisionTimeMs, queryIdentity: query.queryIdentity }],
            }),
            chunkIds: [],
          };
          const candidate = createPendingCandidate({
            kind: 'deadness',
            checkpoint,
            position: prepared.position,
            eventId,
            eventAtMs: decisionTimeMs,
            activeClockDeadlineMs: null,
            clockAtEvent: checkpoint.clocks,
            status: 'running',
            attemptGeneration: 1,
          });
          checkpoint = withAdjudicationExtension({
            ...checkpoint,
            result: resultForPendingCandidate(candidate),
            archive: {
              ...checkpoint.archive,
              currentLine: {
                ...checkpoint.archive.currentLine,
                eventIds: [...checkpoint.archive.currentLine.eventIds, eventId],
              },
            },
          }, { workflow: 'setup', status: 'pending', candidates: [candidate] });
          events = [...events, pendingEvent];
        }
        decisionCompleted = true;
        return { checkpoint, events, outboxOperationIds: [] };
      },
    });
    if (result.kind === 'revision-conflict') {
      throw new GameControllerError('revision-conflict', 'A game with this ID already has a saved checkpoint.');
    }
    if (!decisionCompleted) {
      throw new GameControllerError('invalid-configuration', 'The setup classification decision produced no checkpoint.');
    }
    this.checkpoint = result.checkpoint;
    this.position = prepared.position;
    this.clockState = null;
    this.restored = false;
    const snapshot = this.snapshot();
    this.publish(snapshot);
    if (snapshot.checkpoint.result.kind === 'pending-adjudication') this.scheduleAdjudicationPass();
    return snapshot;
  }

  private async startClassifiedSetupReady(setup: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    const position = this.position;
    if (checkpoint === null || position === null) {
      throw new GameControllerError('setup-required', 'Classify the setup before starting its clock.');
    }
    if (setup.modelSelection.diagnostic !== 'passed-current-session') {
      throw new GameControllerError('invalid-setup', 'A current-session model diagnostic must pass before the clock starts.');
    }
    const setupState = adjudicationExtension(checkpoint);
    const setupProof = setupState?.data.setupProof;
    if (
      checkpoint.result.kind !== 'unresolved' ||
      setupState?.data.workflow !== 'setup' || setupState.data.status !== 'setup-ready' ||
      setupProof === undefined || setupState.data.candidates.length !== 0 ||
      checkpoint.rules.moves.length !== 0 || this.clockState !== null
    ) throw new GameControllerError('setup-required', 'The saved setup has no checked non-deadness result ready to start.');

    const checked = checkProofEvidence(setupProof.query, setupProof.evidence);
    if (checked.status !== 'accepted' || checked.conclusion !== 'not-dead') {
      throw new GameControllerError('saved-game-invalid', 'The saved setup proof no longer passes the independent checker.');
    }
    const expectedFen = setup.startingFen ?? INITIAL_POSITION;
    const expectedTimeControl = setup.timeControl ?? DEFAULT_TIME_CONTROL;
    const namespace = copyNamespace(setup.namespace);
    const modelSide = checkpoint.selections.players.white.kind === 'human' ? 'black' : 'white';
    const savedModel = checkpoint.selections.players[modelSide];
    if (
      expectedFen !== checkpoint.rules.startingFen ||
      setup.ownershipEpoch !== checkpoint.ownershipEpoch ||
      namespace.kind !== checkpoint.namespace.kind ||
      (namespace.kind === 'account' && checkpoint.namespace.kind === 'account' && namespace.accountId !== checkpoint.namespace.accountId) ||
      expectedTimeControl.startingTimeMs !== checkpoint.clocks.timeControl.startingTimeMs ||
      expectedTimeControl.incrementMs !== checkpoint.clocks.timeControl.incrementMs ||
      savedModel.kind !== 'model' ||
      modelConfigurationIdentity(setup.modelSelection) !== modelConfigurationIdentity(savedModel) ||
      (setup.humanSide !== 'random' && setup.humanSide !== modelSide && setup.humanSide !== (modelSide === 'white' ? 'black' : 'white'))
    ) throw new GameControllerError('invalid-setup', 'The started setup does not match the classified game.');
    if (
      setup.humanSide !== 'random' &&
      checkpoint.selections.players[setup.humanSide].kind !== 'human'
    ) throw new GameControllerError('invalid-setup', 'The selected human side does not match the classified game.');

    const committed = await this.commitMutation<IntentMutationValue>(createFence(checkpoint), (context) => {
      const currentState = adjudicationExtension(context.checkpoint);
      const proof = currentState?.data.setupProof;
      if (
        context.checkpoint.result.kind !== 'unresolved' || currentState?.data.workflow !== 'setup' ||
        currentState.data.status !== 'setup-ready' || proof === undefined ||
        checkProofEvidence(proof.query, proof.evidence).status !== 'accepted'
      ) return { checkpoint: context.checkpoint, position: context.position, clockState: null, value: { kind: 'rejected', reason: 'not-actionable' } };

      const clock = startClock({
        at: context.at,
        activeSide: fromPositionColor(context.position.sideToMove),
        timeControl: context.checkpoint.clocks.timeControl,
      });
      const nextCheckpoint = withoutAdjudicationExtension({
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        clocks: checkpointClock(clock, context.decisionTimeMs),
        history: {
          ...context.checkpoint.history,
          segments: context.checkpoint.history.segments.map((segment) => ({
            ...segment,
            startedAtMs: context.decisionTimeMs,
          })),
        },
        selections: {
          players: {
            ...context.checkpoint.selections.players,
            [modelSide]: structuredClone(setup.modelSelection),
          },
        },
      });
      const event = context.createEvent(
        'game-started-after-setup-classification',
        context.decisionTimeMs,
        createFence(nextCheckpoint),
        { setupQueryIdentity: proof.query.queryIdentity, checkedConclusion: 'not-dead' },
      );
      return {
        checkpoint: {
          ...nextCheckpoint,
          archive: {
            ...nextCheckpoint.archive,
            currentLine: {
              ...nextCheckpoint.archive.currentLine,
              eventIds: [...nextCheckpoint.archive.currentLine.eventIds, event.eventId],
            },
          },
        },
        position: context.position,
        clockState: clock,
        value: { kind: 'accepted' },
      };
    });
    if (committed.value.kind === 'rejected') {
      throw new GameControllerError('setup-required', 'The setup changed before its clock could start.');
    }
    return committed.snapshot;
  }

  private async loadOrCreate(setup?: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
    if (setup !== undefined) return this.createClassifiedSetup(setup);
    const existing = await this.store.readGame(this.gameId);
    if (existing !== null) {
      this.restore(existing.checkpoint, existing.events);
      const snapshot = this.snapshot();
      this.publish(snapshot);
      return snapshot;
    }
    throw new GameControllerError('setup-required', 'A new game requires exact setup classification before its clock can start.');
  }

  private restore(checkpoint: GameCheckpointV1, events: readonly ArchiveEventV1[]): void {
    if (checkpoint.gameId !== this.gameId) {
      throw new GameControllerError('saved-game-invalid', 'The saved checkpoint has a different game ID.');
    }
    const position = parsePosition(checkpoint.rules.currentFen);
    if (fromPositionColor(position.sideToMove) !== checkpoint.rules.sideToMove) {
      throw new GameControllerError('saved-game-invalid', 'The saved rules turn does not match the saved FEN.');
    }
    restoreRepetitionLedger({
      version: checkpoint.rules.repetitionLedger.version,
      entries: checkpoint.rules.repetitionLedger.positions.map((entry) => ({ ...entry })),
    });
    this.checkpoint = structuredClone(checkpoint);
    const savedAdjudication = adjudicationExtension(this.checkpoint);
    if (savedAdjudication?.data.status === 'pending' && savedAdjudication.data.candidates[0]?.status === 'running') {
      const candidates = [...savedAdjudication.data.candidates];
      candidates[0] = {
        ...candidates[0]!,
        status: 'awaiting-continuation',
        attemptGeneration: candidates[0]!.attemptGeneration + 1,
      };
      this.checkpoint = withAdjudicationExtension(this.checkpoint, {
        ...savedAdjudication.data,
        candidates,
      });
    }
    this.position = position;
    this.clockState = createClockState(checkpoint);
    this.restored = this.clockState !== null;
    this.pendingClockDiscrepancy = null;
    const latestClockResolution = events
      .filter((event) =>
        event.kind === 'clock-reconciliation-required' ||
        event.kind === 'clock-absence-reconciled' ||
        event.kind === 'clock-reference-reconciled',
      )
      .reduce<ArchiveEventV1 | null>(
        (latest, event) => latest === null || event.sequence > latest.sequence ? event : latest,
        null,
      );
    this.clockReconciliationRequired = latestClockResolution?.kind === 'clock-reconciliation-required';
    if (
      this.clockState !== null &&
      this.clockState.activeSide !== fromPositionColor(position.sideToMove)
    ) {
      throw new GameControllerError('saved-game-invalid', 'The saved clock side does not match the saved FEN.');
    }
  }

  private publish(snapshot: ControllerSnapshotV1): void {
    for (const listener of this.listeners) {
      try {
        listener(copySnapshot(snapshot));
      } catch {
        // A view listener cannot change the durable controller result.
      }
    }
  }
}

function samePolicy(left: ClockComparisonPolicy, right: ClockComparisonPolicy): boolean {
  return left.maxReferenceDivergenceMs === right.maxReferenceDivergenceMs;
}

/** Returns the one actionable controller associated with a game for this page lifetime. */
export function getOrCreateGameController(options: GameControllerOptions): GameController {
  if (typeof options.gameId !== 'string' || options.gameId.length === 0) {
    throw new GameControllerError('invalid-configuration', 'The game ID must be a nonempty string.');
  }
  assertClockPolicy(options.clockPolicy);
  const timeSource = options.timeSource ?? defaultTimeSource;
  const existing = registry.get(options.gameId);
  if (existing !== undefined) {
    const configured = existing.configuration;
    if (
      configured.store !== options.store ||
      configured.timeSource !== timeSource ||
      configured.adjudicationRunner !== options.adjudicationRunner ||
      !samePolicy(configured.clockPolicy, options.clockPolicy)
    ) {
      throw new GameControllerError(
        'invalid-configuration',
        'A game ID cannot be rebound to another store, time source, or clock policy.',
      );
    }
    return existing.controller;
  }
  const controller = new IndexedGameController(
    options.gameId,
    options.store,
    timeSource,
    { ...options.clockPolicy },
    options.idFactory ?? defaultIdFactory,
    options.randomSide ?? defaultRandomSide,
    options.adjudicationRunner ?? createProofAdjudicationRunner(),
  );
  registry.set(options.gameId, {
    controller,
    configuration: {
      store: options.store,
      timeSource,
      ...(options.adjudicationRunner === undefined
        ? {}
        : { adjudicationRunner: options.adjudicationRunner }),
      clockPolicy: { ...options.clockPolicy },
    },
  });
  return controller;
}

interface RegisteredController {
  readonly controller: IndexedGameController;
  readonly configuration: RegistryConfiguration;
}

// Use a registered wrapper so accidental factory calls cannot create a second writer.
const registry = new Map<string, RegisteredController>();
