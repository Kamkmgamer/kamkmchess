import {
  calculateMoveClockCandidate,
  calculateUndoClockCandidate,
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
import { checkProofEvidence, createDeadnessQuery, createTimeoutMatingQuery, proofQueryIdentity } from '../proofs/index.js';
import type { ProofQuery, ProofSearchPassResult } from '../proofs/index.js';
import type {
  AppliedMoveV1,
  ArchiveEventV1,
  DiscardedLineReferenceV1,
  GameCheckpointV1,
  GameNamespaceV1,
  GameResultV1,
  GameStore,
  PlayerSelectionV1,
} from '../storage/index.js';

export type ModelSelection = Extract<PlayerSelectionV1, { kind: 'model' }>;
export type HumanSideChoice = ClockSide | 'random';
type ClockDiscrepancyReading = Extract<ClockReading, { status: 'reconciliation-required' }>;

const INITIAL_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const GAME_CONTROLLER_INTENT_KINDS: ReadonlySet<string> = new Set([
  'begin-model-turn',
  'stop-model-turn',
  'human-move',
  'model-move',
]);

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
  readiness:
    | 'ready'
    | 'restore-recovery-pending'
    | 'expiry-persistence-pending'
    | 'clock-reconciliation-required';
  adjudication: {
    readonly status: 'none' | 'queued' | 'running' | 'stopped' | 'setup-ready';
    readonly query: ProofQuery | null;
    readonly requestId: string | null;
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
  dispatch(intent: GameControllerIntentV1): Promise<GameControllerIntentResultV1>;
  reconcile(): Promise<ControllerSnapshotV1>;
  snapshot(): ControllerSnapshotV1;
  subscribe(listener: (snapshot: ControllerSnapshotV1) => void): () => void;
  continueAdjudication(fence: ControllerFenceV1): Promise<AdjudicationWorkV1 | null>;
  stopAdjudication(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  acceptAdjudicationResult(input: AdjudicationResultInputV1): Promise<ControllerSnapshotV1>;
  startGame(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1>;
  undo(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  undoMove(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  takeback(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  startPractice(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1>;
  beginPractice(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1>;
}

export interface AdjudicationWorkV1 {
  readonly requestId: string;
  readonly fence: ControllerFenceV1;
  readonly query: ProofQuery;
  readonly searchCheckpoint: unknown;
}

export interface AdjudicationResultInputV1 {
  readonly requestId: string;
  readonly fence: ControllerFenceV1;
  readonly query: ProofQuery;
  readonly result: ProofSearchPassResult;
}

interface AdjudicationCandidateV1 {
  readonly kind: 'deadness' | 'timeout';
  readonly eventId: string;
  readonly eventAtMs: number;
  readonly deadlineMs: number | null;
  readonly query: ProofQuery;
  readonly searchCheckpoint: unknown;
  readonly status: 'queued' | 'running' | 'stopped' | 'accepted';
  readonly requestId: string | null;
  readonly acceptedConclusion?: string;
  readonly acceptedEvidence?: unknown;
}

interface AdjudicationExtensionV1 {
  readonly version: 1;
  readonly data: {
    readonly candidates: readonly AdjudicationCandidateV1[];
    readonly activeQueryIdentity: string | null;
  };
}

const ADJUDICATION_EXTENSION = 'adjudication';

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

function adjudicationExtension(checkpoint: GameCheckpointV1): AdjudicationExtensionV1 {
  const section = checkpoint.extensions[ADJUDICATION_EXTENSION];
  if (section === undefined) {
    return { version: 1, data: { candidates: [], activeQueryIdentity: null } };
  }
  if (section.version !== 1 || typeof section.data !== 'object' || section.data === null) {
    throw new GameControllerError('saved-game-invalid', 'The saved adjudication extension is invalid.');
  }
  const data = section.data as unknown as AdjudicationExtensionV1['data'];
  if (!Array.isArray(data.candidates) || !(data.activeQueryIdentity === null || typeof data.activeQueryIdentity === 'string')) {
    throw new GameControllerError('saved-game-invalid', 'The saved adjudication candidate list is invalid.');
  }
  for (const candidate of data.candidates) {
    if (typeof candidate !== 'object' || candidate === null || typeof candidate.query !== 'object' || candidate.query === null) {
      throw new GameControllerError('saved-game-invalid', 'The saved adjudication candidate is malformed.');
    }
    const queryIsCanonical = (() => {
      try {
        return candidate.query.queryIdentity === proofQueryIdentity(candidate.query) &&
          parsePosition(candidate.query.positionFen).fen === candidate.query.positionFen;
      } catch {
        return false;
      }
    })();
    if ((candidate.kind !== 'deadness' && candidate.kind !== 'timeout') ||
        typeof candidate.eventId !== 'string' || candidate.eventId.length === 0 ||
        !Number.isFinite(candidate.eventAtMs) ||
        !(candidate.deadlineMs === null || Number.isFinite(candidate.deadlineMs)) ||
        !['queued', 'running', 'stopped', 'accepted'].includes(candidate.status) ||
        !(candidate.requestId === null || typeof candidate.requestId === 'string') ||
        !queryIsCanonical || candidate.query.gameId !== checkpoint.gameId || candidate.query.segmentId !== checkpoint.segmentId ||
        candidate.query.ownershipEpoch !== String(checkpoint.ownershipEpoch) ||
        (candidate.kind === 'deadness' && candidate.query.predicate !== 'global-deadness') ||
        (candidate.kind === 'timeout' && candidate.query.predicate !== 'timeout-opponent-mating') ||
        (candidate.status === 'running' ? candidate.requestId === null : candidate.requestId !== null) ||
        (candidate.status !== 'accepted' && (candidate.query.positionFen !== checkpoint.rules.currentFen ||
          candidate.query.positionRevision !== String(checkpoint.positionRevision) ||
          candidate.query.analysisGeneration !== String(checkpoint.analysisGeneration)))) {
      throw new GameControllerError('saved-game-invalid', 'The saved adjudication candidate is malformed or bound to another game.');
    }
  }
  const runningCandidates = data.candidates.filter((candidate) => candidate.status === 'running');
  if (runningCandidates.length > 1 ||
      (runningCandidates.length === 1 && data.activeQueryIdentity !== runningCandidates[0]?.query.queryIdentity) ||
      (runningCandidates.length === 0 && data.activeQueryIdentity !== null)) {
    throw new GameControllerError('saved-game-invalid', 'The saved active adjudication request does not match its candidate.');
  }
  return structuredClone({ version: 1, data });
}

function validateAcceptedAdjudicationEvidence(checkpoint: GameCheckpointV1): GameCheckpointV1 {
  const extension = adjudicationExtension(checkpoint);
  let changed = false;
  const candidates = extension.data.candidates.map((candidate) => {
    if (candidate.status !== 'accepted') return candidate;
    if (candidate.acceptedEvidence === undefined || typeof candidate.acceptedConclusion !== 'string') {
      changed = true;
      return { ...candidate, status: 'queued' as const, requestId: null, searchCheckpoint: null };
    }
    const checked = checkProofEvidence(candidate.query, candidate.acceptedEvidence);
    const resultMatchesProof = checkpoint.result.kind !== 'final' || candidate.eventId !== checkpoint.result.eventId ||
      (checkpoint.result.reason === 'dead-position' && candidate.kind === 'deadness' && checked.status === 'accepted' && checked.conclusion === 'dead') ||
      (checkpoint.result.reason === 'timeout' && candidate.kind === 'timeout' && checked.status === 'accepted' &&
        ((checked.conclusion === 'opponent-can-mate' && checkpoint.result.winner !== 'draw') ||
          (checked.conclusion === 'opponent-cannot-mate' && checkpoint.result.winner === 'draw')));
    if (checked.status !== 'accepted' || checked.conclusion !== candidate.acceptedConclusion || !resultMatchesProof) {
      if (checkpoint.result.kind === 'final' && (checkpoint.result.reason === 'dead-position' || checkpoint.result.reason === 'timeout')) {
        throw new GameControllerError('saved-game-invalid', 'A final adjudication result has no matching checked proof.');
      }
      changed = true;
      return { ...candidate, status: 'queued' as const, requestId: null, searchCheckpoint: null };
    }
    return candidate;
  });
  return changed ? { ...checkpoint, extensions: withAdjudicationExtension(checkpoint, { version: 1,
    data: { candidates, activeQueryIdentity: null } }) } : checkpoint;
}

function withAdjudicationExtension(
  checkpoint: GameCheckpointV1,
  extension: AdjudicationExtensionV1,
): GameCheckpointV1['extensions'] {
  return {
    ...checkpoint.extensions,
    [ADJUDICATION_EXTENSION]: {
      version: 1,
      data: JSON.parse(JSON.stringify(extension.data)) as GameCheckpointV1['extensions'][string]['data'],
    },
  };
}

function deadnessQuery(checkpoint: GameCheckpointV1): ProofQuery {
  return createDeadnessQuery({
    gameId: checkpoint.gameId,
    segmentId: checkpoint.segmentId,
    positionRevision: String(checkpoint.positionRevision),
    analysisGeneration: String(checkpoint.analysisGeneration),
    ownershipEpoch: String(checkpoint.ownershipEpoch),
    positionFen: checkpoint.rules.currentFen,
  });
}

function timeoutQuery(checkpoint: GameCheckpointV1, expiredSide: ClockSide): ProofQuery {
  return createTimeoutMatingQuery({
    gameId: checkpoint.gameId,
    segmentId: checkpoint.segmentId,
    positionRevision: String(checkpoint.positionRevision),
    analysisGeneration: String(checkpoint.analysisGeneration),
    ownershipEpoch: String(checkpoint.ownershipEpoch),
    positionFen: checkpoint.rules.currentFen,
    expiredColor: expiredSide === 'white' ? 'w' : 'b',
  });
}

function jsonSafe(value: unknown): GameCheckpointV1['extensions'][string]['data'] {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : JSON.parse(serialized) as GameCheckpointV1['extensions'][string]['data'];
  } catch {
    return null;
  }
}

function rebindPendingCandidates(
  prior: GameCheckpointV1,
  next: GameCheckpointV1,
): GameCheckpointV1['extensions'] {
  const extension = adjudicationExtension(prior);
  const candidates = extension.data.candidates.map((candidate) => {
    if (candidate.status === 'accepted') return candidate;
    const query = candidate.kind === 'timeout'
      ? timeoutQuery(next, candidate.query.predicate === 'timeout-opponent-mating' && candidate.query.expiredColor === 'w' ? 'white' : 'black')
      : deadnessQuery(next);
    return { ...candidate, query, searchCheckpoint: null, status: 'queued' as const, requestId: null };
  });
  return withAdjudicationExtension(prior, { version: 1, data: { candidates, activeQueryIdentity: null } });
}

function copySnapshot(snapshot: ControllerSnapshotV1): ControllerSnapshotV1 {
  return {
    checkpoint: structuredClone(snapshot.checkpoint),
    position: snapshot.position,
    clockReading: snapshot.clockReading === null ? null : structuredClone(snapshot.clockReading),
    fence: { ...snapshot.fence },
    readiness: snapshot.readiness,
    adjudication: structuredClone(snapshot.adjudication),
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
): PreparedSetup {
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
    extensions: {},
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
    return {
      checkpoint: structuredClone(checkpoint),
      position,
      clockReading,
      fence: createFence(checkpoint),
      readiness,
      adjudication: this.adjudicationStatus(checkpoint),
    };
  }

  private adjudicationStatus(checkpoint: GameCheckpointV1): ControllerSnapshotV1['adjudication'] {
    const extension = adjudicationExtension(checkpoint);
    const active = extension.data.candidates.find((candidate) => candidate.query.queryIdentity === extension.data.activeQueryIdentity) ??
      extension.data.candidates.find((candidate) => candidate.status !== 'accepted');
    if (active === undefined) {
      return {
        status: checkpoint.result.kind === 'pending-adjudication' && checkpoint.result.reason === 'dead-position'
          ? 'setup-ready'
          : 'none',
        query: null,
        requestId: null,
      };
    }
    return { status: active.status === 'accepted' ? 'none' : active.status, query: structuredClone(active.query), requestId: active.requestId };
  }

  subscribe(listener: (snapshot: ControllerSnapshotV1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  continueAdjudication(fence: ControllerFenceV1): Promise<AdjudicationWorkV1 | null> {
    const operation = this.operationQueue.then(async () => {
      const checkpoint = this.checkpoint;
      if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
          this.snapshot().clockReading?.status === 'expired' &&
          !adjudicationExtension(checkpoint).data.candidates.some((item) => item.kind === 'timeout')) {
        await this.reconcileReady();
        return null;
      }
      if (checkpoint === null || !sameFence(createFence(checkpoint), fence)) return null;
      const extension = adjudicationExtension(checkpoint);
      const candidate = extension.data.candidates.find((item) => item.status !== 'accepted');
      if (candidate === undefined || checkpoint.result.kind === 'final') return null;
      if (candidate.status === 'running' && candidate.requestId !== null) return null;
      const requestId = candidate.query.queryIdentity;
      const committed = await this.commitMutation<{ kind: 'accepted' }>(fence, (context) => {
        const current = adjudicationExtension(context.checkpoint);
        const candidates = current.data.candidates.map((item) => item.query.queryIdentity === candidate.query.queryIdentity
          ? { ...item, status: 'running' as const, requestId }
          : item);
        const event = context.createEvent('adjudication-analysis-continued', context.decisionTimeMs, fence, {
          queryIdentity: candidate.query.queryIdentity,
          requestId,
        });
        const next = { ...context.checkpoint, extensions: withAdjudicationExtension(context.checkpoint, {
          version: 1,
          data: { candidates, activeQueryIdentity: candidate.query.queryIdentity },
        }), archive: { ...context.checkpoint.archive, currentLine: {
          ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId],
        } } };
        return { checkpoint: next, position: context.position, clockState: context.clockState, value: { kind: 'accepted' } };
      });
      const updated = adjudicationExtension(committed.snapshot.checkpoint).data.candidates.find((item) => item.query.queryIdentity === candidate.query.queryIdentity);
      if (updated === undefined || updated.status !== 'running') return null;
      return { requestId, fence: committed.snapshot.fence, query: structuredClone(updated.query), searchCheckpoint: structuredClone(updated.searchCheckpoint) };
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  stopAdjudication(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    const operation = this.operationQueue.then(async () => {
      const checkpoint = this.checkpoint;
      if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
          this.snapshot().clockReading?.status === 'expired' &&
          !adjudicationExtension(checkpoint).data.candidates.some((item) => item.kind === 'timeout')) {
        await this.reconcileReady();
        return this.snapshot();
      }
      if (checkpoint === null || !sameFence(createFence(checkpoint), fence)) return this.snapshot();
      const extension = adjudicationExtension(checkpoint);
      const candidate = extension.data.candidates.find((item) => item.status === 'running');
      if (candidate === undefined) return this.snapshot();
      const committed = await this.commitMutation<{ kind: 'accepted' }>(fence, (context) => {
        const nextBase = { ...context.checkpoint, analysisGeneration: context.checkpoint.analysisGeneration + 1 };
        const reboundExtension = adjudicationExtension({ ...context.checkpoint,
          extensions: rebindPendingCandidates(context.checkpoint, nextBase),
          analysisGeneration: nextBase.analysisGeneration,
        });
        const reboundCandidate = reboundExtension.data.candidates.find((item) => item.kind === candidate.kind &&
          item.eventId === candidate.eventId);
        if (reboundCandidate === undefined) throw new GameControllerError('saved-game-invalid', 'The active adjudication candidate disappeared.');
        const rebound = reboundCandidate.query;
        const candidates = reboundExtension.data.candidates.map((item) => item.eventId === candidate.eventId
          ? { ...item, searchCheckpoint: null, status: 'stopped' as const, requestId: null }
          : item);
        const event = context.createEvent('adjudication-analysis-stopped', context.decisionTimeMs, fence, {
          stoppedRequestId: candidate.requestId,
          priorQueryIdentity: candidate.query.queryIdentity,
          queryIdentity: rebound.queryIdentity,
        });
        return { checkpoint: { ...nextBase,
          extensions: withAdjudicationExtension(context.checkpoint, { version: 1, data: {
            candidates, activeQueryIdentity: null,
          } }),
          archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
        }, position: context.position, clockState: context.clockState, value: { kind: 'accepted' } };
      });
      return committed.snapshot;
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  acceptAdjudicationResult(input: AdjudicationResultInputV1): Promise<ControllerSnapshotV1> {
    const frozen = structuredClone(input);
    const operation = this.operationQueue.then(async () => {
      const checkpoint = this.checkpoint;
      if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
          this.snapshot().clockReading?.status === 'expired' &&
          !adjudicationExtension(checkpoint).data.candidates.some((item) => item.kind === 'timeout')) {
        await this.reconcileReady();
        return this.snapshot();
      }
      if (checkpoint === null || checkpoint.result.kind === 'final' || !sameFence(createFence(checkpoint), frozen.fence)) return this.snapshot();
      const extension = adjudicationExtension(checkpoint);
      const candidate = extension.data.candidates.find((item) => item.query.queryIdentity === frozen.query.queryIdentity);
      if (candidate === undefined || candidate.status !== 'running' || candidate.requestId !== frozen.requestId ||
          candidate.query.queryIdentity !== frozen.query.queryIdentity || frozen.result.queryIdentity !== frozen.query.queryIdentity ||
          frozen.query.ownershipEpoch !== String(checkpoint.ownershipEpoch) || frozen.query.gameId !== checkpoint.gameId ||
          frozen.query.segmentId !== checkpoint.segmentId || frozen.query.positionFen !== checkpoint.rules.currentFen) return this.snapshot();

      if (frozen.result.status === 'accepted') {
        const checked = checkProofEvidence(frozen.query, frozen.result.evidence);
        if (checked.status !== 'accepted' || checked.conclusion !== frozen.result.conclusion || checked.queryIdentity !== frozen.query.queryIdentity) {
          throw new GameControllerError('invalid-intent', 'The adjudication proof did not pass the independent checker.');
        }
      }
      const committed = await this.commitMutation<{ kind: 'accepted' }>(frozen.fence, (context) => {
        const current = adjudicationExtension(context.checkpoint);
        const isAccepted = frozen.result.status === 'accepted';
        const candidates = current.data.candidates.map((item) => item.query.queryIdentity === candidate.query.queryIdentity
          ? { ...item, searchCheckpoint: isAccepted ? null : jsonSafe(frozen.result.checkpoint), status: isAccepted ? 'accepted' as const : 'queued' as const, requestId: null,
              ...(isAccepted ? { acceptedConclusion: frozen.result.conclusion, acceptedEvidence: jsonSafe(frozen.result.evidence) } : {}) }
          : item);
        let result = context.checkpoint.result;
        let clockState = context.clockState;
        let clocks = context.checkpoint.clocks;
        if (isAccepted) {
          const event = context.createEvent('adjudication-proof-accepted', candidate.eventAtMs, frozen.fence, {
            queryIdentity: frozen.query.queryIdentity,
            conclusion: frozen.result.conclusion,
            evidenceKind: frozen.result.evidence.kind,
          });
          if (candidate.kind === 'deadness' && frozen.result.conclusion === 'dead') {
            result = { kind: 'final', winner: 'draw', reason: 'dead-position', eventId: candidate.eventId, decidedAtMs: candidate.eventAtMs };
            if (clockState !== null) clocks = stopClock(clockState, context.decisionTimeMs);
            clockState = null;
          } else if (candidate.kind === 'timeout') {
            const canMate = frozen.result.conclusion === 'opponent-can-mate';
            const expired = candidate.query.predicate === 'timeout-opponent-mating' && candidate.query.expiredColor === 'w' ? 'white' : 'black';
            result = { kind: 'final', winner: canMate ? (expired === 'white' ? 'black' : 'white') : 'draw', reason: 'timeout', eventId: candidate.eventId, decidedAtMs: candidate.eventAtMs };
            if (clockState !== null) clocks = stopClock(clockState, context.decisionTimeMs);
            clockState = null;
          } else if (candidate.kind === 'deadness' && frozen.result.conclusion === 'not-dead') {
            const setupPending = candidate.deadlineMs === null && context.checkpoint.result.kind === 'pending-adjudication' &&
              context.checkpoint.clocks.activeSide === null;
            const timeoutCandidate = candidates.find((item) => item.kind === 'timeout' && item.status !== 'accepted');
            if (setupPending) {
              result = context.checkpoint.result;
            } else if (timeoutCandidate !== undefined) {
              result = { kind: 'pending-adjudication', reason: 'timeout', eventId: timeoutCandidate.eventId,
                eventAtMs: timeoutCandidate.eventAtMs, activeClockDeadlineMs: null };
              if (clockState !== null) clocks = stopClock(clockState, context.decisionTimeMs);
              clockState = null;
            } else {
              result = { kind: 'unresolved' };
            }
          }
          const next = { ...context.checkpoint, clocks, result,
            extensions: withAdjudicationExtension(context.checkpoint, { version: 1, data: {
              candidates, activeQueryIdentity: null,
            } }),
            archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
              eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
          };
          return { checkpoint: next, position: context.position, clockState, value: { kind: 'accepted' } };
        }
        return { checkpoint: { ...context.checkpoint, extensions: withAdjudicationExtension(context.checkpoint, { version: 1, data: {
          candidates, activeQueryIdentity: null,
        } }) }, position: context.position, clockState, value: { kind: 'accepted' } };
      });
      return committed.snapshot;
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  startGame(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1> {
    const operation = this.operationQueue.then(async () => {
      const checkpoint = this.checkpoint;
      if (checkpoint === null || !sameFence(createFence(checkpoint), fence) || checkpoint.result.kind !== 'pending-adjudication' ||
          checkpoint.result.reason !== 'dead-position' || checkpoint.clocks.activeSide !== null ||
          this.adjudicationStatus(checkpoint).status !== 'setup-ready') return this.snapshot();
      if (modelSelection.diagnostic !== 'passed-current-session') throw new GameControllerError('invalid-setup', 'A current-session diagnostic must pass before clocks start.');
      modelConfigurationIdentity(modelSelection);
      const committed = await this.commitMutation<{ kind: 'accepted' }>(fence, (context) => {
        const clock = startClock({ at: context.at, activeSide: fromPositionColor(context.position.sideToMove), timeControl: context.checkpoint.clocks.timeControl });
        const players = { ...context.checkpoint.selections.players };
        const modelSide = players.white.kind === 'human' ? 'black' : 'white';
        players[modelSide] = freezeModelSelection(modelSelection);
        const currentSegment = context.checkpoint.history.segments.findIndex((segment) => segment.segmentId === context.checkpoint.segmentId);
        const segments = context.checkpoint.history.segments.map((segment, index) => index === currentSegment
          ? { ...segment, providerId: modelSelection.providerId, modelRoutingId: modelSelection.modelRoutingId,
              connectionRevision: modelSelection.configurationRevision }
          : segment);
        const event = context.createEvent('game-started-after-classification', context.decisionTimeMs, fence, {
          modelSelection: { providerId: modelSelection.providerId, connectionId: modelSelection.connectionId,
            configurationRevision: modelSelection.configurationRevision, modelRoutingId: modelSelection.modelRoutingId,
            protocol: modelSelection.protocol },
        });
        return { checkpoint: { ...context.checkpoint, selections: { players }, history: { ...context.checkpoint.history, segments }, result: { kind: 'unresolved' },
          clocks: checkpointClock(clock, context.decisionTimeMs),
          archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
        }, position: context.position, clockState: clock, value: { kind: 'accepted' } };
      });
      return committed.snapshot;
    });
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async undoImplementation(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    if (this.restored) {
      await this.reconcileReady();
      return this.snapshot();
    }
    const checkpoint = this.checkpoint;
    if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
        this.snapshot().clockReading?.status === 'expired') {
      await this.reconcileReady();
    }
    const current = this.checkpoint;
    if (current === null || !sameFence(createFence(current), fence)) return this.snapshot();
    if (current.result.kind !== 'unresolved') return this.snapshot();
    const baselineExtension = current.extensions['undo-baseline'];
    const baseline = (baselineExtension as { data?: { checkpoint?: GameCheckpointV1 } } | undefined)?.data?.checkpoint;
    if (baseline === undefined) return this.snapshot();

    const humanSide: ClockSide = current.selections.players.white.kind === 'human' ? 'white' : 'black';
    const removedCount = current.rules.moves.length - baseline.rules.moves.length;
    if (removedCount <= 0) return this.snapshot();
    let whiteRemoved = 0;
    let blackRemoved = 0;
    let removedPlySide: ClockSide = baseline.rules.sideToMove === 'white' ? 'white' : 'black';
    for (let index = baseline.rules.moves.length; index < current.rules.moves.length; index += 1) {
      if (removedPlySide === 'white') whiteRemoved += 1;
      else blackRemoved += 1;
      removedPlySide = removedPlySide === 'white' ? 'black' : 'white';
    }
    const incrementMs = current.clocks.timeControl.incrementMs;
    const credits = { whiteMs: whiteRemoved * incrementMs, blackMs: blackRemoved * incrementMs };

    const clockState = this.clockState;
    if (clockState === null) return this.snapshot();

    let committed: { snapshot: ControllerSnapshotV1; value: IntentMutationValue };
    let rejectedCreditRemoval = false;
    try {
      committed = await this.commitMutation<IntentMutationValue>(fence, (context) => {
        const contextClockState = context.clockState;
        if (contextClockState === null) {
          throw new GameControllerError('invalid-intent', 'Undo requires a running clock.');
        }
        const candidate = calculateUndoClockCandidate(
          contextClockState,
          { resumedSide: humanSide, incrementCreditsToRemove: credits },
          context.at,
          this.clockPolicy,
        );
        if (candidate.status === 'expired') {
          return this.expiryCandidate(context, fence, candidate.reading);
        }
        if (candidate.status === 'reconciliation-required') {
          return this.clockDiscrepancyCandidate(context, fence, candidate.reading);
        }
        if (candidate.status === 'rejected-credit-removal') {
          rejectedCreditRemoval = true;
          throw new GameControllerError('invalid-intent', 'Undo would leave a clock bank nonpositive.');
        }
        if (candidate.status !== 'candidate') {
          throw new GameControllerError('invalid-intent', 'Undo clock candidate is unavailable.');
        }

        const restoredBase = structuredClone(baseline);
      const oldLineId = context.checkpoint.archive.currentLine.lineId;
      const newLineId = this.idFactory();
      if (
        typeof newLineId !== 'string' ||
        newLineId.length === 0 ||
        newLineId === oldLineId ||
        context.checkpoint.archive.discardedLines.some((line) => line.lineId === newLineId)
      ) {
        throw new GameControllerError('invalid-configuration', 'The identifier source must return distinct nonempty IDs.');
      }
      const discardedLine: DiscardedLineReferenceV1 = {
        lineId: oldLineId,
        eventIds: [...context.checkpoint.archive.currentLine.eventIds],
        discardedAtRevision: context.checkpoint.revision + 1,
        reason: 'undo',
      };
      const event = context.createEvent('undo-accepted', context.decisionTimeMs, fence, {
        removedMoveCount: removedCount,
      });
      restoredBase.archive.currentLine = {
        ...restoredBase.archive.currentLine,
        lineId: newLineId,
      };
      const baselineMessageIds = new Set(restoredBase.history.messages.map((message) => message.messageId));
      const restoredSegmentIds = new Set(restoredBase.history.segments.map((segment) => segment.segmentId));
      const mergedSegments = [
        ...restoredBase.history.segments,
        ...context.checkpoint.history.segments.filter((segment) => !restoredSegmentIds.has(segment.segmentId)),
      ];
      const mergedMessages = context.checkpoint.history.messages.map((message) => {
        if (baselineMessageIds.has(message.messageId)) {
          const baseMessage = restoredBase.history.messages.find((entry) => entry.messageId === message.messageId)!;
          return {
            ...baseMessage,
            lineId: baseMessage.lineId === oldLineId ? newLineId : baseMessage.lineId,
            disposition: baseMessage.lineId === oldLineId ? ('retained' as const) : baseMessage.disposition,
          };
        }
        return message.lineId === oldLineId
          ? { ...message, lineId: oldLineId, disposition: 'discarded' as const }
          : { ...message };
      });
      for (const baseMessage of restoredBase.history.messages) {
        if (!mergedMessages.some((message) => message.messageId === baseMessage.messageId)) {
          mergedMessages.push(
            baseMessage.lineId === oldLineId
              ? { ...baseMessage, lineId: newLineId, disposition: 'retained' as const }
              : { ...baseMessage },
          );
        }
      }
      const restoredCheckpoint: GameCheckpointV1 = {
        ...restoredBase,
        revision: context.checkpoint.revision + 1,
        updatedAtMs: context.decisionTimeMs,
        positionRevision: context.checkpoint.positionRevision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        clocks: checkpointClock(candidate.clock, context.decisionTimeMs),
        history: {
          ...restoredBase.history,
          currentSegmentId: restoredBase.history.currentSegmentId,
          segments: mergedSegments,
          messages: mergedMessages,
        },
        archive: {
          ...restoredBase.archive,
          discardedLines: [...restoredBase.archive.discardedLines, discardedLine],
          currentLine: {
            ...restoredBase.archive.currentLine,
            lineId: newLineId,
            eventIds: [...restoredBase.archive.currentLine.eventIds, event.eventId],
          },
        },
        extensions: restoredBase.extensions,
      };
      return {
        checkpoint: restoredCheckpoint,
        position: parsePosition(restoredBase.rules.currentFen),
        clockState: candidate.clock,
        value: { kind: 'accepted' },
      };
    });
      if (committed.value.kind === 'clock-reconciliation-required') {
        this.clockReconciliationRequired = true;
      }
      if (committed.value.kind === 'accepted') {
        this.activeRequest = null;
      }
      return committed.snapshot;
    } catch (error) {
      if (rejectedCreditRemoval) return this.snapshot();
      throw error;
    }
  }

  undo(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    return this.undoImplementation(fence);
  }
  undoMove(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    return this.undoImplementation(fence);
  }
  takeback(fence: ControllerFenceV1): Promise<ControllerSnapshotV1> {
    return this.undoImplementation(fence);
  }

  private async startPracticeImplementation(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint?.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null &&
        this.snapshot().clockReading?.status === 'expired') {
      await this.reconcileReady();
    }
    const current = this.checkpoint;
    if (current === null || !sameFence(createFence(current), fence)) return this.snapshot();
    if (current.result.kind !== 'final') return this.snapshot();
    const position = this.position;
    if (position === null) return this.snapshot();
    const facts = observeEndingFacts(position, restoreRepetitionLedger({
      version: current.rules.repetitionLedger.version,
      entries: current.rules.repetitionLedger.positions.map((entry) => ({ ...entry })),
    }));
    if (!facts.hasLegalMoves) return this.snapshot();
    const humanSide: ClockSide = current.selections.players.white.kind === 'human' ? 'white' : 'black';
    const approvedPracticeReasons = new Set(['resignation', 'illegal-move', 'timeout']);
    if (!approvedPracticeReasons.has(current.result.reason)) return this.snapshot();
    if (current.result.winner !== humanSide) return this.snapshot();
    if (modelSelection.diagnostic !== 'passed-current-session') {
      throw new GameControllerError('invalid-setup', 'A current-session diagnostic must pass before clocks start.');
    }
    modelConfigurationIdentity(modelSelection);

    const newSegmentId = this.idFactory();
    const newLineId = this.idFactory();
    if (typeof newSegmentId !== 'string' || newSegmentId.length === 0 ||
        typeof newLineId !== 'string' || newLineId.length === 0 || newSegmentId === newLineId ||
        newLineId === current.archive.currentLine.lineId ||
        current.archive.discardedLines.some((line) => line.lineId === newLineId)) {
      throw new GameControllerError('invalid-configuration', 'The identifier source must return distinct nonempty IDs.');
    }

    const originalResult = current.result as Extract<GameResultV1, { kind: 'final' }>;
    const timeControl = current.clocks.timeControl;
    const clock = startClock({ at: this.timeSource.sample(), activeSide: fromPositionColor(position.sideToMove), timeControl });

    const committed = await this.commitMutation<{ kind: 'accepted' }>(fence, (context) => {
      const players = { ...context.checkpoint.selections.players };
      const modelSide = players.white.kind === 'human' ? 'black' : 'white';
      players[modelSide] = freezeModelSelection(modelSelection);
      const segments = [...context.checkpoint.history.segments, {
        segmentId: newSegmentId,
        providerId: modelSelection.providerId,
        modelRoutingId: modelSelection.modelRoutingId,
        connectionRevision: modelSelection.configurationRevision,
        startedAtMs: context.decisionTimeMs,
        messageIds: [],
      }];
      const event = context.createEvent('practice-started', context.decisionTimeMs, fence, {
        sourceResult: originalResult,
      });
      const nextCheckpoint: GameCheckpointV1 = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        segmentId: newSegmentId,
        positionRevision: context.checkpoint.positionRevision,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        updatedAtMs: context.decisionTimeMs,
        rules: { ...context.checkpoint.rules },
        history: {
          currentSegmentId: newSegmentId,
          segments,
          messages: context.checkpoint.history.messages.map((message) =>
            message.lineId === context.checkpoint.archive.currentLine.lineId
              ? { ...message, disposition: 'discarded' as const }
              : { ...message },
          ),
        },
        clocks: checkpointClock(clock, context.decisionTimeMs),
        budgets: {
          formattingCorrectionsRemaining: 3,
          illegalMoveAttemptsRemaining: { white: 4, black: 4 },
          manualRetriesBySide: { white: 0, black: 0 },
        },
        selections: { players },
        archive: {
          ...context.checkpoint.archive,
          currentLine: { lineId: newLineId, eventIds: [event.eventId] },
          discardedLines: [...context.checkpoint.archive.discardedLines, {
            lineId: context.checkpoint.archive.currentLine.lineId,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds],
            discardedAtRevision: context.checkpoint.revision + 1,
            reason: 'branch',
          }],
        },
        result: { kind: 'unresolved' },
        practice: {
          mode: 'practice',
          scored: false,
          sourceGameId: context.checkpoint.gameId,
          sourcePositionFen: context.checkpoint.rules.currentFen,
          originalResult,
        },
        extensions: context.checkpoint.extensions,
      };
      return {
        checkpoint: nextCheckpoint,
        position: context.position,
        clockState: clock,
        value: { kind: 'accepted' },
      };
    });
    this.activeRequest = null;
    return committed.snapshot;
  }

  startPractice(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1> {
    return this.startPracticeImplementation(fence, modelSelection);
  }
  beginPractice(fence: ControllerFenceV1, modelSelection: ModelSelection): Promise<ControllerSnapshotV1> {
    return this.startPracticeImplementation(fence, modelSelection);
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
    if (this.restored || checkpoint.result.kind !== 'unresolved') {
      return { kind: 'rejected', reason: 'not-actionable', snapshot };
    }
    if (intent.kind === 'begin-model-turn') return this.beginModelTurn(intent.fence);
    if (intent.kind === 'stop-model-turn') return this.stopModelTurn(intent.fence);
    return this.acceptMove(intent);
  }

  private async reconcileReady(): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) {
      throw new GameControllerError('setup-required', 'Initialize the game before reconciling its clock.');
    }
    if (this.clockState === null || (checkpoint.result.kind !== 'unresolved' &&
        !(checkpoint.result.kind === 'pending-adjudication' && checkpoint.result.activeClockDeadlineMs !== null))) return this.snapshot();
    if (checkpoint.result.kind === 'pending-adjudication' && adjudicationExtension(checkpoint).data.candidates.some((item) => item.kind === 'timeout')) {
      return this.snapshot();
    }

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
        const nextCheckpoint = {
          ...context.checkpoint,
          requestGeneration: context.checkpoint.requestGeneration + 1,
          analysisGeneration: context.checkpoint.analysisGeneration + 1,
          clocks: checkpointClock(recovery.clock, context.decisionTimeMs),
          archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds,
              ...(priorDiscrepancyEvent === null ? [] : [priorDiscrepancyEvent.eventId]), event.eventId] } },
        };
        return {
          checkpoint: { ...nextCheckpoint, extensions: rebindPendingCandidates(context.checkpoint, nextCheckpoint) },
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
      const nextCheckpoint = {
        ...context.checkpoint,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        clocks: checkpointClock(clockState, context.decisionTimeMs),
        archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds,
            ...(priorDiscrepancyEvent === null ? [] : [priorDiscrepancyEvent.eventId]), event.eventId] } },
      };
      return {
        checkpoint: { ...nextCheckpoint, extensions: rebindPendingCandidates(context.checkpoint, nextCheckpoint) },
        position: context.position,
        clockState,
        value: { kind: 'reconciled' },
      };
    });
    this.activeRequest = null;
    return this.snapshot();
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
      const result = finalResult ?? {
        kind: 'pending-adjudication' as const,
        reason: 'dead-position' as const,
        eventId: moveEvent.eventId,
        eventAtMs: context.decisionTimeMs,
        activeClockDeadlineMs: clockCandidate.reading.deadline.wallTimeMs,
      };
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
      const nextCheckpointWithMove = {
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
      let finalCheckpoint = nextCheckpointWithMove;
      if (finalResult === null) {
        const query = deadnessQuery(nextCheckpointWithMove);
        const candidateEvent = context.createEvent('deadness-candidate-created', context.decisionTimeMs, createFence(nextCheckpointWithMove), {
          queryIdentity: query.queryIdentity,
          reason: 'position-entry',
          precedingMoveEventId: moveEvent.eventId,
        });
        const currentExtension = adjudicationExtension(context.checkpoint);
        const candidates = [...currentExtension.data.candidates, {
          kind: 'deadness' as const,
          eventId: candidateEvent.eventId,
          eventAtMs: context.decisionTimeMs,
          deadlineMs: clockCandidate.reading.deadline.wallTimeMs,
          query,
          searchCheckpoint: null,
          status: 'queued' as const,
          requestId: null,
        }];
        finalCheckpoint = {
          ...nextCheckpointWithMove,
          extensions: withAdjudicationExtension(nextCheckpointWithMove, { version: 1, data: {
            candidates, activeQueryIdentity: null,
          } }),
          archive: { ...nextCheckpointWithMove.archive, currentLine: { ...nextCheckpointWithMove.archive.currentLine,
            eventIds: [...nextCheckpointWithMove.archive.currentLine.eventIds, candidateEvent.eventId] } },
        };
      }
      const checkpointWithUndoBaseline = event.kind === 'human-move'
        ? {
            ...finalCheckpoint,
            extensions: {
              ...finalCheckpoint.extensions,
              'undo-baseline': {
                version: 1,
                data: { checkpoint: context.checkpoint } as never,
              },
            },
          }
        : finalCheckpoint;
      return {
        checkpoint: checkpointWithUndoBaseline,
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

  private expiryCandidate(
    context: ControllerDecisionContext,
    fence: ControllerFenceV1,
    reading: ClockReading,
  ): ControllerDecisionCandidate<IntentMutationValue> {
    if (reading.status !== 'expired') {
      throw new GameControllerError('invalid-configuration', 'An expiry decision needs an expired clock reading.');
    }
    const event = context.createEvent(
      'timeout-candidate',
      reading.deadline.wallTimeMs,
      fence,
      {
        decisionTimeMs: context.decisionTimeMs,
        deadline: reading.deadline,
        evidence: reading.evidence,
      },
    );
    const nextBase = {
      ...context.checkpoint,
      revision: context.checkpoint.revision + 1,
      requestGeneration: context.checkpoint.requestGeneration + 1,
      analysisGeneration: context.checkpoint.analysisGeneration + 1,
    };
    const query = timeoutQuery(nextBase, reading.activeSide);
    const timeoutEvent = context.createEvent('timeout-adjudication-candidate-created', reading.deadline.wallTimeMs, fence, {
      queryIdentity: query.queryIdentity,
      expiredSide: reading.activeSide,
      deadline: reading.deadline,
    });
    const currentExtension = adjudicationExtension(context.checkpoint);
    const reboundCandidates = currentExtension.data.candidates.map((candidate) => {
      if (candidate.status === 'accepted') return candidate;
      const reboundQuery = candidate.kind === 'timeout'
        ? timeoutQuery(nextBase, candidate.query.predicate === 'timeout-opponent-mating' && candidate.query.expiredColor === 'w' ? 'white' : 'black')
        : deadnessQuery(nextBase);
      return { ...candidate, query: reboundQuery, searchCheckpoint: null, status: 'queued' as const, requestId: null };
    });
    const candidates = [...reboundCandidates, {
      kind: 'timeout' as const,
      eventId: timeoutEvent.eventId,
      eventAtMs: reading.deadline.wallTimeMs,
      deadlineMs: reading.deadline.wallTimeMs,
      query,
      searchCheckpoint: null,
      status: 'queued' as const,
      requestId: null,
    }];
    const earlierDeadness = currentExtension.data.candidates.find((candidate) =>
      candidate.kind === 'deadness' && candidate.eventAtMs <= reading.deadline.wallTimeMs && candidate.status !== 'accepted');
    return {
      checkpoint: {
        ...nextBase,
        archive: {
          ...context.checkpoint.archive,
          currentLine: {
            ...context.checkpoint.archive.currentLine,
            eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId, timeoutEvent.eventId],
          },
        },
        extensions: withAdjudicationExtension(context.checkpoint, { version: 1, data: {
          candidates, activeQueryIdentity: null,
        } }),
        clocks: pausedClockCheckpoint(
          context.clockState?.timeControl ?? context.checkpoint.clocks.timeControl,
          reading.remaining,
          context.decisionTimeMs,
        ),
        result: earlierDeadness === undefined
          ? { kind: 'pending-adjudication', reason: 'timeout', eventId: timeoutEvent.eventId,
              eventAtMs: reading.deadline.wallTimeMs, activeClockDeadlineMs: null }
          : context.checkpoint.result.kind === 'pending-adjudication'
            ? { ...context.checkpoint.result, activeClockDeadlineMs: null }
            : context.checkpoint.result,
      },
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
    const nextCheckpoint = {
      ...context.checkpoint,
      revision: context.checkpoint.revision + 1,
      requestGeneration: context.checkpoint.requestGeneration + 1,
      analysisGeneration: context.checkpoint.analysisGeneration + 1,
      archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
        eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
    };
    return {
      checkpoint: { ...nextCheckpoint, extensions: rebindPendingCandidates(context.checkpoint, nextCheckpoint) },
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
    const snapshot = this.snapshot();
    this.publish(snapshot);
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
      const nextCheckpoint = {
        ...context.checkpoint,
        revision: context.checkpoint.revision + 1,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
        archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
      };
      return {
        checkpoint: { ...nextCheckpoint, extensions: rebindPendingCandidates(context.checkpoint, nextCheckpoint) },
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

  private async loadOrCreate(setup?: GameControllerSetupV1): Promise<ControllerSnapshotV1> {
    const existing = await this.store.readGame(this.gameId);
    if (existing !== null) {
      this.restore(existing.checkpoint, existing.events);
      let snapshot = this.snapshot();
      if (existing.checkpoint.extensions[ADJUDICATION_EXTENSION] === undefined &&
          existing.checkpoint.result.kind === 'unresolved') {
        snapshot = await this.createRestoredPositionCandidate();
      }
      if (snapshot.clockReading?.status === 'expired') snapshot = await this.reconcileReady();
      this.publish(snapshot);
      return snapshot;
    }
    if (setup === undefined) {
      throw new GameControllerError('setup-required', 'A new game requires a validated setup.');
    }

    const prepared = prepareSetup(setup, this.idFactory, this.randomSide);
    let acceptedClock: ClockState | null = null;
    let decisionCompleted = false;
    const result = await this.store.commitCheckpoint({
      gameId: this.gameId,
      expectedRevision: null,
      expectedEpoch: prepared.ownershipEpoch,
      events: [],
      chunks: [],
      knownCredentials: [],
      decide: (decisionTimeMs) => {
        sampleAtDecision(this.timeSource, decisionTimeMs);
        const usedIds = new Set([prepared.segmentId, prepared.lineId]);
        const eventId = nextUniqueId(this.idFactory, usedIds);
        const startingFacts = observeEndingFacts(
          prepared.position,
          createRepetitionLedger(prepared.position),
        );
        const initialResult = finalResultForPosition(
          prepared.position,
          startingFacts,
          eventId,
          decisionTimeMs,
        );
        const setupCandidateEventId = initialResult === null ? nextUniqueId(this.idFactory, usedIds) : null;
        const checkpointBase = makeCheckpoint(
          this.gameId,
          prepared,
          null,
          decisionTimeMs,
          eventId,
          initialResult ?? {
            kind: 'pending-adjudication',
            reason: 'dead-position',
            eventId: setupCandidateEventId as string,
            eventAtMs: decisionTimeMs,
            activeClockDeadlineMs: null,
          },
        );
        const checkpoint = initialResult === null
          ? {
              ...checkpointBase,
              archive: { ...checkpointBase.archive, currentLine: {
                ...checkpointBase.archive.currentLine,
                eventIds: [...checkpointBase.archive.currentLine.eventIds, setupCandidateEventId as string],
              } },
              extensions: withAdjudicationExtension(checkpointBase, {
                version: 1,
                data: {
                  candidates: [{
                    kind: 'deadness' as const,
                    eventId: setupCandidateEventId as string,
                    eventAtMs: decisionTimeMs,
                    deadlineMs: null,
                    query: deadnessQuery(checkpointBase),
                    searchCheckpoint: null,
                    status: 'queued' as const,
                    requestId: null,
                  }],
                  activeQueryIdentity: null,
                },
              }),
            }
          : checkpointBase;
        const details: Record<string, unknown> = {
          humanSide: prepared.humanSide,
          startingFen: prepared.startingFen,
          timeControl: prepared.timeControl,
        };
        if (initialResult !== null) details.result = initialResult;
        const event: ArchiveEventV1 = {
          eventId,
          gameId: this.gameId,
          sequence: 0,
          segmentId: prepared.segmentId,
          kind: 'game-created',
          occurredAtMs: decisionTimeMs,
          receiveState: 'complete',
          egressStatus: 'eligible',
          payload: eventPayload(createFence(checkpoint), details),
          chunkIds: [],
        };
        const events = [event];
        if (initialResult === null) {
          const query = deadnessQuery(checkpoint);
          const candidateEvent: ArchiveEventV1 = {
            eventId: setupCandidateEventId as string,
            gameId: this.gameId,
            sequence: 1,
            segmentId: prepared.segmentId,
            kind: 'deadness-candidate-created',
            occurredAtMs: decisionTimeMs,
            receiveState: 'complete',
            egressStatus: 'eligible',
            payload: eventPayload(createFence(checkpoint), { queryIdentity: query.queryIdentity, reason: 'setup-classification' }),
            chunkIds: [],
          };
          events.push(candidateEvent);
        }
        acceptedClock = null;
        decisionCompleted = true;
        return {
          checkpoint,
          events,
          outboxOperationIds: [],
        };
      },
    });
    if (result.kind === 'revision-conflict') {
      throw new GameControllerError('revision-conflict', 'A game with this ID already has a saved checkpoint.');
    }
    if (!decisionCompleted) {
      throw new GameControllerError('invalid-configuration', 'The checkpoint decision did not produce controller state.');
    }
    this.checkpoint = result.checkpoint;
    this.position = prepared.position;
    this.clockState = acceptedClock;
    this.restored = false;
    const snapshot = this.snapshot();
    this.publish(snapshot);
    return snapshot;
  }

  private async createRestoredPositionCandidate(): Promise<ControllerSnapshotV1> {
    const checkpoint = this.checkpoint;
    if (checkpoint === null) throw new GameControllerError('setup-required', 'Initialize the game before classifying a restored position.');
    const committed = await this.commitMutation<{ kind: 'accepted' }>(null, (context) => {
      const reading = context.clockState === null ? null : readClockAt(context.clockState, context.at, this.clockPolicy);
      const nextCheckpoint = {
        ...context.checkpoint,
        requestGeneration: context.checkpoint.requestGeneration + 1,
        analysisGeneration: context.checkpoint.analysisGeneration + 1,
      };
      const query = deadnessQuery(nextCheckpoint);
      const deadlineMs = reading === null || reading.status === 'reconciliation-required' ? null : reading.deadline.wallTimeMs;
      const event = context.createEvent('deadness-candidate-created', context.checkpoint.updatedAtMs,
        createFence(nextCheckpoint), { queryIdentity: query.queryIdentity, reason: 'restored-position-classification' });
      const candidate: AdjudicationCandidateV1 = {
        kind: 'deadness', eventId: event.eventId, eventAtMs: context.checkpoint.updatedAtMs,
        deadlineMs, query, searchCheckpoint: null, status: 'queued', requestId: null,
      };
      const result: GameResultV1 = {
        kind: 'pending-adjudication', reason: 'dead-position', eventId: event.eventId,
        eventAtMs: context.checkpoint.updatedAtMs, activeClockDeadlineMs: deadlineMs,
      };
      return { checkpoint: {
        ...nextCheckpoint, result,
        extensions: withAdjudicationExtension(context.checkpoint, { version: 1,
          data: { candidates: [candidate], activeQueryIdentity: null } }),
        archive: { ...context.checkpoint.archive, currentLine: { ...context.checkpoint.archive.currentLine,
          eventIds: [...context.checkpoint.archive.currentLine.eventIds, event.eventId] } },
      }, position: context.position, clockState: context.clockState, value: { kind: 'accepted' } };
    });
    return committed.snapshot;
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
    const verifiedCheckpoint = validateAcceptedAdjudicationEvidence(checkpoint);
    const adjudication = adjudicationExtension(verifiedCheckpoint);
    const abandonedRunning = adjudication.data.candidates.some((candidate) => candidate.status === 'running');
    const recoveredCheckpoint = abandonedRunning
      ? (() => {
          const reboundBase = { ...verifiedCheckpoint, analysisGeneration: verifiedCheckpoint.analysisGeneration + 1 };
          const candidates = adjudication.data.candidates.map((candidate) => {
            if (candidate.status !== 'running') return candidate;
            const query = candidate.kind === 'timeout'
              ? timeoutQuery(reboundBase, candidate.query.predicate === 'timeout-opponent-mating' && candidate.query.expiredColor === 'w' ? 'white' : 'black')
              : deadnessQuery(reboundBase);
            return { ...candidate, query, status: 'queued' as const, requestId: null, searchCheckpoint: null };
          });
          return { ...reboundBase, extensions: withAdjudicationExtension(reboundBase, { version: 1,
            data: { candidates, activeQueryIdentity: null } }) };
        })()
      : verifiedCheckpoint;
    this.checkpoint = structuredClone(recoveredCheckpoint);
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
  );
  registry.set(options.gameId, {
    controller,
    configuration: {
      store: options.store,
      timeSource,
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
export function createRestartSetup(source: ControllerSnapshotV1): GameControllerSetupV1 {
  const checkpoint = source.checkpoint;
  const modelSelection = checkpoint.selections.players.white.kind === 'model'
    ? checkpoint.selections.players.white
    : checkpoint.selections.players.black;
  return {
    humanSide: checkpoint.selections.players.white.kind === 'human' ? 'white' : 'black',
    modelSelection: structuredClone(modelSelection) as ModelSelection,
    namespace: structuredClone(checkpoint.namespace),
    ownershipEpoch: checkpoint.ownershipEpoch,
    startingFen: checkpoint.rules.startingFen,
    timeControl: { ...checkpoint.clocks.timeControl },
  };
}

export function createRematchSetup(source: ControllerSnapshotV1): GameControllerSetupV1 {
  const setup = createRestartSetup(source);
  setup.humanSide = setup.humanSide === 'white' ? 'black' : 'white';
  return setup;
}

export const prepareRestart = createRestartSetup;
export const prepareRematch = createRematchSetup;
export const createRestartGameSetup = createRestartSetup;
export const createRematchGameSetup = createRematchSetup;

const registry = new Map<string, RegisteredController>();
