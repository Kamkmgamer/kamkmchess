import {
  canonicalProofStateKey,
  checkProofEvidence,
  proofQueryIdentity,
  PROOF_CHECKER_VERSION,
  PROOF_PREDICATE_VERSION,
  PROOF_SCHEMA_VERSION,
  RULES_ADAPTER_VERSION,
  type ProofEvidence,
  type ProofQuery,
} from '../index.js';
import {
  applyCoordinateMove,
  createRepetitionLedger,
  legalMoves,
  observeEndingFacts,
  parsePosition,
  type Color,
  type CoordinateMove,
  type Position,
} from '../../rules/index.js';
import {
  PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION,
  PROOF_SEARCH_VERSION,
  type ProofSearchCheckpointDisposition,
  type ProofSearchCheckpointV1,
  type ProofSearchPassOptionsV1,
  type ProofSearchPassResult,
  type ProofSearchPassStatisticsV1,
  type ProofSearchParentRecordV1,
  type ProofSearchStateRecordV1,
  type ProofSearchSuccessorV1,
  type ProofSearchVersionsV1,
} from './types.js';
import { validateProofSearchCheckpoint } from './checkpoint.js';
import { proofSearchStatePositionFen } from './state-position.js';
import { tryFastMatingWitness } from './fast-witness.js';

const DEFAULT_DISCOVERED_STATE_BUDGET = 10_000;
const DEFAULT_PASS_TIME_BUDGET_MS = 5_000;
const MAX_CHECKED_CLOSURE_STATES = 10_000;
const MAX_CHECKED_CLOSURE_EDGES = 100_000;
const COOPERATIVE_YIELD_EDGE_INTERVAL = 64;
const COOPERATIVE_YIELD_STATE_INTERVAL = 16;

interface MutableSearchState {
  stateKey: string;
  positionFen: string;
  status: ProofSearchStateRecordV1['status'];
  nextMoveIndex: number;
  successors: ProofSearchSuccessorV1[];
}

interface ValidatedQuery {
  readonly query: ProofQuery;
  readonly position: Position;
}

function safeQuerySnapshot(value: unknown): ValidatedQuery | null {
  const result = checkProofEvidence(value, undefined);
  if (result.status === 'rejected') return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot[key] = descriptor.value;
  }
  const query = Object.freeze({ ...snapshot }) as unknown as ProofQuery;
  if (
    checkProofEvidence(query, undefined).status === 'rejected' ||
    query.queryIdentity !== proofQueryIdentity(query)
  ) return null;
  try {
    return { query, position: parsePosition(query.positionFen) };
  } catch {
    return null;
  }
}

function versions(): ProofSearchVersionsV1 {
  return {
    checkpointSchemaVersion: PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION,
    proofSchemaVersion: PROOF_SCHEMA_VERSION,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    predicateVersion: PROOF_PREDICATE_VERSION,
    searchVersion: PROOF_SEARCH_VERSION,
  };
}

function newRootState(position: Position): MutableSearchState {
  const stateKey = canonicalProofStateKey(position);
  return {
    stateKey,
    positionFen: proofSearchStatePositionFen(stateKey),
    status: 'queued',
    nextMoveIndex: 0,
    successors: [],
  };
}

function freshCheckpoint(query: ProofQuery, position: Position): ProofSearchCheckpointV1 {
  const rootState = newRootState(position);
  return {
    schemaVersion: PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION,
    searchVersion: PROOF_SEARCH_VERSION,
    versions: versions(),
    query,
    queryIdentity: query.queryIdentity,
    root: rootState.stateKey,
    stateRecords: [rootState],
    frontier: [rootState.stateKey],
    parentRecords: [{ stateKey: rootState.stateKey, parentStateKey: null, move: null }],
    discoveredStateCount: 1,
    discoveredEdgeCount: 0,
    completedPasses: 0,
  };
}

function mutableState(value: ProofSearchStateRecordV1): MutableSearchState {
  return {
    stateKey: value.stateKey,
    positionFen: value.positionFen,
    status: value.status,
    nextMoveIndex: value.nextMoveIndex,
    successors: value.successors.map((successor) => ({ move: { ...successor.move }, target: successor.target })),
  };
}

function buildCheckpoint(
  query: ProofQuery,
  root: string,
  states: readonly MutableSearchState[],
  frontier: readonly string[],
  parents: readonly ProofSearchParentRecordV1[],
  completedPasses: number,
): ProofSearchCheckpointV1 {
  const stateRecords: ProofSearchStateRecordV1[] = states.map((state) => ({
    stateKey: state.stateKey,
    positionFen: state.positionFen,
    status: state.status,
    nextMoveIndex: state.nextMoveIndex,
    successors: state.successors.map((successor) => ({
      move: { ...successor.move },
      target: successor.target,
    })),
  }));
  const discoveredEdgeCount = stateRecords.reduce((count, state) => count + state.successors.length, 0);
  return {
    schemaVersion: PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION,
    searchVersion: PROOF_SEARCH_VERSION,
    versions: versions(),
    query,
    queryIdentity: query.queryIdentity,
    root,
    stateRecords,
    frontier: [...frontier],
    parentRecords: parents.map((parent) => ({
      stateKey: parent.stateKey,
      parentStateKey: parent.parentStateKey,
      move: parent.move === null ? null : { ...parent.move },
    })),
    discoveredStateCount: stateRecords.length,
    discoveredEdgeCount,
    completedPasses,
  };
}

function resultStatistics(
  startedAt: number,
  maxDiscoveredStates: number,
  timeBudgetMs: number,
  passDiscoveredStates: number,
  passEdges: number,
  passExpandedStates: number,
  states: readonly MutableSearchState[],
): ProofSearchPassStatisticsV1 {
  return {
    maxDiscoveredStates,
    timeBudgetMs,
    discoveredStateCount: passDiscoveredStates,
    processedEdgeCount: passEdges,
    expandedStateCount: passExpandedStates,
    totalDiscoveredStateCount: states.length,
    totalDiscoveredEdgeCount: states.reduce((count, state) => count + state.successors.length, 0),
    elapsedMs: Math.max(0, monotonicNow() - startedAt),
  };
}

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function targetMateColor(query: ProofQuery, position: Position): Color | null {
  const facts = observeEndingFacts(position, createRepetitionLedger(position));
  if (!facts.checkmate) return null;
  const deliveredBy: Color = position.sideToMove === 'w' ? 'b' : 'w';
  if (query.predicate === 'global-deadness') return deliveredBy;
  if (query.predicate === 'cooperative-mating-reachability') {
    return query.intendedColor === deliveredBy ? deliveredBy : null;
  }
  const opponent: Color = query.expiredColor === 'w' ? 'b' : 'w';
  return opponent === deliveredBy ? deliveredBy : null;
}

function positiveEvidence(query: ProofQuery, color: Color, moves: readonly CoordinateMove[]): ProofEvidence {
  return Object.freeze({
    schemaVersion: PROOF_SCHEMA_VERSION,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    kind: 'mate-witness',
    queryIdentity: query.queryIdentity,
    intendedColor: color,
    moves: Object.freeze(moves.map((move) => Object.freeze({ ...move }))),
  });
}

function pathTo(stateKey: string, parents: ReadonlyMap<string, ProofSearchParentRecordV1>): CoordinateMove[] | null {
  const reversed: CoordinateMove[] = [];
  let current = stateKey;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current)) return null;
    visited.add(current);
    const parent = parents.get(current);
    if (!parent) return null;
    if (parent.parentStateKey === null) return parent.move === null ? reversed.reverse() : null;
    if (parent.move === null) return null;
    reversed.push(parent.move);
    current = parent.parentStateKey;
  }
}

async function yieldControl(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function limitForStates(options: ProofSearchPassOptionsV1): number {
  const value = options.maxDiscoveredStates ?? DEFAULT_DISCOVERED_STATE_BUDGET;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('maxDiscoveredStates must be a positive safe integer.');
  return value;
}

function limitForTime(options: ProofSearchPassOptionsV1): number {
  const value = options.timeBudgetMs ?? DEFAULT_PASS_TIME_BUDGET_MS;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('timeBudgetMs must be a positive finite number.');
  return value;
}

export async function runProofSearchPass(
  queryInput: ProofQuery,
  options: ProofSearchPassOptionsV1 = {},
): Promise<ProofSearchPassResult> {
  const startedAt = monotonicNow();
  let maxDiscoveredStates: number;
  let timeBudgetMs: number;
  try {
    maxDiscoveredStates = limitForStates(options);
    timeBudgetMs = limitForTime(options);
  } catch {
    return {
      status: 'non-result',
      reason: 'search-error',
      checkpoint: null,
      checkpointDisposition: options.checkpoint === undefined ? 'fresh' : 'restarted',
      pass: {
        maxDiscoveredStates: DEFAULT_DISCOVERED_STATE_BUDGET,
        timeBudgetMs: DEFAULT_PASS_TIME_BUDGET_MS,
        discoveredStateCount: 0,
        processedEdgeCount: 0,
        expandedStateCount: 0,
        totalDiscoveredStateCount: 0,
        totalDiscoveredEdgeCount: 0,
        elapsedMs: Math.max(0, monotonicNow() - startedAt),
      },
    };
  }
  const querySnapshot = safeQuerySnapshot(queryInput);
  if (!querySnapshot) {
    return {
      status: 'non-result',
      reason: 'invalid-query',
      checkpoint: null,
      checkpointDisposition: options.checkpoint === undefined ? 'fresh' : 'restarted',
      pass: {
        maxDiscoveredStates,
        timeBudgetMs,
        discoveredStateCount: 0,
        processedEdgeCount: 0,
        expandedStateCount: 0,
        totalDiscoveredStateCount: 0,
        totalDiscoveredEdgeCount: 0,
        elapsedMs: Math.max(0, monotonicNow() - startedAt),
      },
    };
  }

  const query = querySnapshot.query;
  const checkpointValidation =
    options.checkpoint === undefined ? null : validateProofSearchCheckpoint(options.checkpoint);
  const canResume =
    checkpointValidation?.status === 'valid' &&
    checkpointValidation.checkpoint.queryIdentity === query.queryIdentity &&
    checkpointValidation.checkpoint.queryIdentity === proofQueryIdentity(query);
  const checkpointDisposition: ProofSearchCheckpointDisposition =
    options.checkpoint === undefined ? 'fresh' : canResume ? 'resumed' : 'restarted';
  if (options.checkpoint !== undefined && !canResume) {
    const restart = freshCheckpoint(query, querySnapshot.position);
    return {
      status: 'non-result',
      reason: 'invalid-checkpoint',
      queryIdentity: query.queryIdentity,
      checkpoint: restart,
      checkpointDisposition: 'restarted',
      pass: {
        maxDiscoveredStates,
        timeBudgetMs,
        discoveredStateCount: 0,
        processedEdgeCount: 0,
        expandedStateCount: 0,
        totalDiscoveredStateCount: restart.discoveredStateCount,
        totalDiscoveredEdgeCount: restart.discoveredEdgeCount,
        elapsedMs: Math.max(0, monotonicNow() - startedAt),
      },
    };
  }
  const remainingFastBudgetMs = timeBudgetMs - (monotonicNow() - startedAt);
  const fastWitness = options.fastWitness === false || remainingFastBudgetMs <= 0
    ? null
    : await tryFastMatingWitness(query, {
      timeBudgetMs: remainingFastBudgetMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  if (fastWitness && monotonicNow() - startedAt < timeBudgetMs) {
    if (options.signal?.aborted) {
      return {
        status: 'non-result', reason: 'cancelled', queryIdentity: query.queryIdentity,
        checkpoint: null, checkpointDisposition: options.checkpoint === undefined ? 'fresh' : 'resumed',
        pass: {
          ...fastWitness.pass, maxDiscoveredStates, timeBudgetMs,
          elapsedMs: Math.max(0, monotonicNow() - startedAt),
        },
      };
    }
    return {
      ...fastWitness,
      checkpointDisposition: options.checkpoint === undefined ? 'fresh' : 'resumed',
      pass: {
        ...fastWitness.pass, maxDiscoveredStates, timeBudgetMs,
        elapsedMs: Math.max(0, monotonicNow() - startedAt),
      },
    };
  }
  const previousCheckpoint = canResume ? checkpointValidation.checkpoint : null;
  const baseCheckpoint = previousCheckpoint ?? freshCheckpoint(query, querySnapshot.position);
  const stateRecords = baseCheckpoint.stateRecords.map(mutableState);
  const frontier = [...baseCheckpoint.frontier];
  let frontierHead = 0;
  const parentRecords = baseCheckpoint.parentRecords.map((parent) => ({
    stateKey: parent.stateKey,
    parentStateKey: parent.parentStateKey,
    move: parent.move === null ? null : { ...parent.move },
  }));
  const statesByKey = new Map(stateRecords.map((state) => [state.stateKey, state]));
  const parentsByKey = new Map(parentRecords.map((parent) => [parent.stateKey, parent]));
  let passDiscoveredStates = previousCheckpoint === null ? 1 : 0;
  let passEdges = 0;
  let passExpandedStates = 0;
  const completedPasses = baseCheckpoint.completedPasses;

  const statistics = () => resultStatistics(
    startedAt,
    maxDiscoveredStates,
    timeBudgetMs,
    passDiscoveredStates,
    passEdges,
    passExpandedStates,
    stateRecords,
  );
  const checkpoint = () => buildCheckpoint(
    query,
    baseCheckpoint.root,
    stateRecords,
    frontier.slice(frontierHead),
    parentRecords,
    completedPasses + 1,
  );
  const nonResult = (
    reason: Extract<ProofSearchPassResult, { status: 'non-result' }>['reason'],
    resultCheckpoint: ProofSearchCheckpointV1 | null = checkpoint(),
    resultDisposition: ProofSearchCheckpointDisposition = checkpointDisposition,
  ): ProofSearchPassResult => ({
    status: 'non-result',
    reason,
    queryIdentity: query.queryIdentity,
    checkpoint: resultCheckpoint,
    checkpointDisposition: resultDisposition,
    pass: statistics(),
  });
  const aborted = () => options.signal?.aborted === true;
  const expired = () => monotonicNow() - startedAt >= timeBudgetMs;

  try {
    if (aborted()) return nonResult('cancelled');
    if (expired()) return nonResult('time-budget');
    const rootMateColor = targetMateColor(query, querySnapshot.position);
    if (rootMateColor !== null) {
      const evidence = positiveEvidence(query, rootMateColor, []);
      const checked = checkProofEvidence(query, evidence);
      if (aborted()) return nonResult('cancelled', null);
      if (expired()) return nonResult('time-budget', null);
      if (checked.status === 'accepted') {
        return {
          status: 'accepted',
          conclusion: checked.conclusion,
          queryIdentity: query.queryIdentity,
          evidence,
          checkpointDisposition,
          pass: statistics(),
        };
      }
      return nonResult(checked.status === 'rejected' ? 'checker-rejected' : 'checker-non-result', null);
    }

    let processedStatesSinceYield = 0;
    while (frontierHead < frontier.length) {
      if (aborted()) return nonResult('cancelled');
      if (expired()) return nonResult('time-budget');

      const stateKey = frontier[frontierHead];
      const state = stateKey === undefined ? undefined : statesByKey.get(stateKey);
      if (!state) return nonResult('search-error');
      const position = parsePosition(state.positionFen);
      const moves = legalMoves(position);
      if (state.status === 'queued') state.status = 'expanding';
      if (state.nextMoveIndex > moves.length) return nonResult('search-error');

      while (state.nextMoveIndex < moves.length) {
        if (aborted()) return nonResult('cancelled');
        if (expired()) return nonResult('time-budget');

        const move = moves[state.nextMoveIndex];
        if (move === undefined) return nonResult('search-error');
        const transition = applyCoordinateMove(position, move);
        const targetKey = canonicalProofStateKey(transition.position);
        let mateColor: Color | null = null;
        if (!statesByKey.has(targetKey) && passDiscoveredStates >= maxDiscoveredStates) {
          return nonResult('state-budget');
        }

        if (!statesByKey.has(targetKey)) {
          const targetState = newRootState(transition.position);
          targetState.stateKey = targetKey;
          targetState.positionFen = proofSearchStatePositionFen(targetKey);
          statesByKey.set(targetKey, targetState);
          stateRecords.push(targetState);
          frontier.push(targetKey);
          const parent = { stateKey: targetKey, parentStateKey: state.stateKey, move: { ...move } };
          parentRecords.push(parent);
          parentsByKey.set(targetKey, parent);
          passDiscoveredStates += 1;
          mateColor = targetMateColor(query, transition.position);
        }

        state.successors.push({ move: { ...move }, target: targetKey });
        state.nextMoveIndex += 1;
        passEdges += 1;
        if (mateColor !== null) {
          const path = pathTo(targetKey, parentsByKey);
          if (!path) return nonResult('search-error');
          const evidence = positiveEvidence(query, mateColor, path);
          const checked = checkProofEvidence(query, evidence);
          if (aborted()) return nonResult('cancelled');
          if (expired()) return nonResult('time-budget');
          if (checked.status === 'accepted') {
            return {
              status: 'accepted',
              conclusion: checked.conclusion,
              queryIdentity: query.queryIdentity,
              evidence,
              checkpointDisposition,
              pass: statistics(),
            };
          }
          if (checkpointDisposition === 'resumed' && checked.status === 'rejected') {
            const reset = freshCheckpoint(query, querySnapshot.position);
            return nonResult('checker-rejected', reset, 'restarted');
          }
          return nonResult(checked.status === 'rejected' ? 'checker-rejected' : 'checker-non-result', null);
        }
        if (passEdges % COOPERATIVE_YIELD_EDGE_INTERVAL === 0) {
          await yieldControl();
          if (aborted()) return nonResult('cancelled');
          if (expired()) return nonResult('time-budget');
        }
      }

      state.status = 'expanded';
      frontierHead += 1;
      passExpandedStates += 1;
      processedStatesSinceYield += 1;
      if (processedStatesSinceYield >= COOPERATIVE_YIELD_STATE_INTERVAL) {
        processedStatesSinceYield = 0;
        await yieldControl();
        if (aborted()) return nonResult('cancelled');
        if (expired()) return nonResult('time-budget');
      }
    }

    const totalEdges = stateRecords.reduce((count, state) => count + state.successors.length, 0);
    if (stateRecords.length > MAX_CHECKED_CLOSURE_STATES) return nonResult('certificate-state-limit');
    if (totalEdges > MAX_CHECKED_CLOSURE_EDGES) return nonResult('certificate-edge-limit');

    await yieldControl();
    if (aborted()) return nonResult('cancelled');
    if (expired()) return nonResult('time-budget');

    const evidence: ProofEvidence = Object.freeze({
      schemaVersion: PROOF_SCHEMA_VERSION,
      proofCheckerVersion: PROOF_CHECKER_VERSION,
      rulesAdapterVersion: RULES_ADAPTER_VERSION,
      kind: 'closed-successor-set',
      queryIdentity: query.queryIdentity,
      root: baseCheckpoint.root,
      nodes: Object.freeze(stateRecords.map((state) => Object.freeze({
        state: state.stateKey,
        successors: Object.freeze(state.successors.map((successor) => Object.freeze({
          move: Object.freeze({ ...successor.move }),
          target: successor.target,
        }))),
      }))),
    });
    const checked = checkProofEvidence(query, evidence);
    if (aborted()) return nonResult('cancelled');
    if (expired()) return nonResult('time-budget');
    if (checked.status === 'accepted') {
      return {
        status: 'accepted',
        conclusion: checked.conclusion,
        queryIdentity: query.queryIdentity,
        evidence,
        checkpointDisposition,
        pass: statistics(),
      };
    }
    if (checkpointDisposition === 'resumed' && checked.status === 'rejected') {
      const reset = freshCheckpoint(query, querySnapshot.position);
      return nonResult('checker-rejected', reset, 'restarted');
    }
    return nonResult(checked.status === 'rejected' ? 'checker-rejected' : 'checker-non-result');
  } catch {
    return nonResult('search-error');
  }
}
