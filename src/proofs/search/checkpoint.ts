import {
  canonicalProofStateKey,
  checkProofEvidence,
  proofQueryIdentity,
  PROOF_CHECKER_VERSION,
  PROOF_PREDICATE_VERSION,
  PROOF_SCHEMA_VERSION,
  RULES_ADAPTER_VERSION,
} from '../index.js';
import { applyCoordinateMove, legalMoves, parsePosition, type CoordinateMove } from '../../rules/index.js';
import type { ProofQuery } from '../types.js';
import { proofSearchStatePositionFen } from './state-position.js';
import {
  PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION,
  PROOF_SEARCH_VERSION,
  type ProofSearchCheckpointValidation,
  type ProofSearchCheckpointV1,
  type ProofSearchParentRecordV1,
  type ProofSearchStateRecordV1,
  type ProofSearchSuccessorV1,
  type ProofSearchVersionsV1,
} from './types.js';

type DataRecord = Record<string, unknown>;

function invalidCheckpoint(): ProofSearchCheckpointValidation {
  return { status: 'restart-required', reason: 'corrupt-checkpoint' };
}

function dataRecord(value: unknown): DataRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function hasExactKeys(record: DataRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function dataArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || (length as number) < 0) return null;
  const items: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    items.push(descriptor.value);
  }
  return items;
}

function copyMove(value: unknown): CoordinateMove | null {
  const move = dataRecord(value);
  if (!move) return null;
  const hasPromotion = Object.hasOwn(move, 'promotion');
  if (!hasExactKeys(move, hasPromotion ? ['from', 'to', 'promotion'] : ['from', 'to'])) return null;
  if (
    typeof move.from !== 'string' || !/^[a-h][1-8]$/.test(move.from) ||
    typeof move.to !== 'string' || !/^[a-h][1-8]$/.test(move.to) ||
    (hasPromotion && move.promotion !== 'q' && move.promotion !== 'r' && move.promotion !== 'b' && move.promotion !== 'n')
  ) return null;
  return hasPromotion
    ? { from: move.from as CoordinateMove['from'], to: move.to as CoordinateMove['to'], promotion: move.promotion as NonNullable<CoordinateMove['promotion']> }
    : { from: move.from as CoordinateMove['from'], to: move.to as CoordinateMove['to'] };
}

function copyQuery(value: unknown): ProofQuery | null {
  const checked = checkProofEvidence(value, undefined);
  if (checked.status === 'rejected') return null;
  const query = dataRecord(value);
  if (!query) return null;
  const copied = Object.freeze({ ...query }) as unknown as ProofQuery;
  const secondCheck = checkProofEvidence(copied, undefined);
  if (
    secondCheck.status === 'rejected' ||
    copied.queryIdentity !== proofQueryIdentity(copied)
  ) return null;
  return copied;
}

function compatibleVersions(value: unknown): ProofSearchVersionsV1 | null {
  const versions = dataRecord(value);
  if (!versions || !hasExactKeys(versions, [
    'checkpointSchemaVersion',
    'proofSchemaVersion',
    'proofCheckerVersion',
    'rulesAdapterVersion',
    'predicateVersion',
    'searchVersion',
  ])) return null;
  if (
    versions.checkpointSchemaVersion !== PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION ||
    versions.proofSchemaVersion !== PROOF_SCHEMA_VERSION ||
    versions.proofCheckerVersion !== PROOF_CHECKER_VERSION ||
    versions.rulesAdapterVersion !== RULES_ADAPTER_VERSION ||
    versions.predicateVersion !== PROOF_PREDICATE_VERSION ||
    versions.searchVersion !== PROOF_SEARCH_VERSION
  ) return null;
  return {
    checkpointSchemaVersion: PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION,
    proofSchemaVersion: PROOF_SCHEMA_VERSION,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    predicateVersion: PROOF_PREDICATE_VERSION,
    searchVersion: PROOF_SEARCH_VERSION,
  };
}

function copySuccessor(value: unknown): ProofSearchSuccessorV1 | null {
  const successor = dataRecord(value);
  if (!successor || !hasExactKeys(successor, ['move', 'target']) || typeof successor.target !== 'string') return null;
  const move = copyMove(successor.move);
  return move ? { move, target: successor.target } : null;
}

function copyStateRecord(value: unknown): ProofSearchStateRecordV1 | null {
  const state = dataRecord(value);
  if (!state || !hasExactKeys(state, ['stateKey', 'positionFen', 'status', 'nextMoveIndex', 'successors'])) return null;
  if (
    typeof state.stateKey !== 'string' ||
    typeof state.positionFen !== 'string' ||
    (state.status !== 'queued' && state.status !== 'expanding' && state.status !== 'expanded') ||
    !Number.isSafeInteger(state.nextMoveIndex) ||
    (state.nextMoveIndex as number) < 0
  ) return null;
  const successors = dataArray(state.successors);
  if (!successors) return null;
  const copiedSuccessors: ProofSearchSuccessorV1[] = [];
  for (const rawSuccessor of successors) {
    const successor = copySuccessor(rawSuccessor);
    if (!successor) return null;
    copiedSuccessors.push(successor);
  }
  if (state.nextMoveIndex !== copiedSuccessors.length) return null;
  if (state.status === 'queued' && copiedSuccessors.length !== 0) return null;
  if (state.status === 'expanded' && state.nextMoveIndex !== copiedSuccessors.length) return null;
  try {
    const position = parsePosition(state.positionFen);
    if (
      canonicalProofStateKey(position) !== state.stateKey ||
      proofSearchStatePositionFen(state.stateKey) !== state.positionFen
    ) return null;
  } catch {
    return null;
  }
  return {
    stateKey: state.stateKey,
    positionFen: state.positionFen,
    status: state.status,
    nextMoveIndex: state.nextMoveIndex as number,
    successors: copiedSuccessors,
  };
}

function copyParentRecord(value: unknown): ProofSearchParentRecordV1 | null {
  const parent = dataRecord(value);
  if (!parent || !hasExactKeys(parent, ['stateKey', 'parentStateKey', 'move']) || typeof parent.stateKey !== 'string') return null;
  if (parent.parentStateKey === null && parent.move === null) {
    return { stateKey: parent.stateKey, parentStateKey: null, move: null };
  }
  if (typeof parent.parentStateKey !== 'string') return null;
  const move = copyMove(parent.move);
  return move ? { stateKey: parent.stateKey, parentStateKey: parent.parentStateKey, move } : null;
}

/** Validates saved search state before it can be resumed or persisted. */
export function validateProofSearchCheckpoint(value: unknown): ProofSearchCheckpointValidation {
  try {
    const checkpoint = dataRecord(value);
    if (!checkpoint || !hasExactKeys(checkpoint, [
      'schemaVersion',
      'searchVersion',
      'versions',
      'query',
      'queryIdentity',
      'root',
      'stateRecords',
      'frontier',
      'parentRecords',
      'discoveredStateCount',
      'discoveredEdgeCount',
      'completedPasses',
    ])) return invalidCheckpoint();

    const versions = compatibleVersions(checkpoint.versions);
    if (
      checkpoint.schemaVersion !== PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION ||
      checkpoint.searchVersion !== PROOF_SEARCH_VERSION ||
      versions === null
    ) return { status: 'restart-required', reason: 'incompatible-checkpoint' };

    const query = copyQuery(checkpoint.query);
    if (!query || query.queryIdentity !== checkpoint.queryIdentity) {
      return { status: 'restart-required', reason: 'query-mismatch' };
    }
    const queryPosition = parsePosition(query.positionFen);
    const expectedRoot = canonicalProofStateKey(queryPosition);
    if (checkpoint.root !== expectedRoot || typeof checkpoint.root !== 'string') return invalidCheckpoint();

    const rawStates = dataArray(checkpoint.stateRecords);
    const rawFrontier = dataArray(checkpoint.frontier);
    const rawParents = dataArray(checkpoint.parentRecords);
    if (!rawStates || !rawFrontier || !rawParents || rawStates.length === 0) return invalidCheckpoint();
    const stateRecords: ProofSearchStateRecordV1[] = [];
    for (const item of rawStates) {
      const state = copyStateRecord(item);
      if (!state) return invalidCheckpoint();
      stateRecords.push(state);
    }
    const parentRecords: ProofSearchParentRecordV1[] = [];
    for (const item of rawParents) {
      const parent = copyParentRecord(item);
      if (!parent) return invalidCheckpoint();
      parentRecords.push(parent);
    }
    if (rawFrontier.some((key) => typeof key !== 'string')) return invalidCheckpoint();
    const frontier = rawFrontier as string[];

    const statesByKey = new Map(stateRecords.map((state) => [state.stateKey, state]));
    const parentsByKey = new Map(parentRecords.map((parent) => [parent.stateKey, parent]));
    const stateIndexByKey = new Map(stateRecords.map((state, index) => [state.stateKey, index]));
    if (
      statesByKey.size !== stateRecords.length ||
      parentsByKey.size !== parentRecords.length ||
      parentRecords.length !== stateRecords.length ||
      stateRecords[0]?.stateKey !== expectedRoot ||
      parentRecords[0]?.stateKey !== expectedRoot ||
      frontier.length !== new Set(frontier).size
    ) return invalidCheckpoint();

    const frontierSet = new Set(frontier);
    const expectedFrontier = stateRecords.filter((state) => state.status !== 'expanded').map((state) => state.stateKey);
    if (
      frontierSet.size !== expectedFrontier.length ||
      frontier.length !== expectedFrontier.length ||
      frontier.some((key, index) => key !== expectedFrontier[index])
    ) return invalidCheckpoint();
    if (frontier.length > 0 && stateRecords.find((state) => state.stateKey === frontier[0])?.status === 'expanded') return invalidCheckpoint();

    let edgeCount = 0;
    const firstParentsByKey = new Map<string, { parentStateKey: string; move: CoordinateMove }>();
    for (let index = 0; index < stateRecords.length; index += 1) {
      const state = stateRecords[index];
      const parent = parentRecords[index];
      if (!state || !parent || parent.stateKey !== state.stateKey) return invalidCheckpoint();
      edgeCount += state.successors.length;
      const position = parsePosition(state.positionFen);
      const legalSuccessors = legalMoves(position);
      if (
        state.successors.length > legalSuccessors.length ||
        (state.status === 'expanded' && state.successors.length !== legalSuccessors.length)
      ) return invalidCheckpoint();
      for (let edgeIndex = 0; edgeIndex < state.successors.length; edgeIndex += 1) {
        const successor = state.successors[edgeIndex];
        const expectedMove = legalSuccessors[edgeIndex];
        if (
          !successor ||
          !expectedMove ||
          !statesByKey.has(successor.target) ||
          moveIdentity(successor.move) !== moveIdentity(expectedMove)
        ) return invalidCheckpoint();
        const expectedTarget = canonicalProofStateKey(applyCoordinateMove(position, expectedMove).position);
        if (successor.target !== expectedTarget) return invalidCheckpoint();
        if (successor.target !== expectedRoot && !firstParentsByKey.has(successor.target)) {
          firstParentsByKey.set(successor.target, { parentStateKey: state.stateKey, move: expectedMove });
        }
      }
      if (state.stateKey === expectedRoot) {
        if (parent.parentStateKey !== null || parent.move !== null) return invalidCheckpoint();
        continue;
      }
      if (parent.parentStateKey === null || parent.move === null) return invalidCheckpoint();
      const parentIndex = stateIndexByKey.get(parent.parentStateKey) ?? -1;
      const parentState = statesByKey.get(parent.parentStateKey);
      if (parentIndex < 0 || parentIndex >= index || !parentState) return invalidCheckpoint();
      const firstParent = firstParentsByKey.get(state.stateKey);
      if (
        !firstParent ||
        firstParent.parentStateKey !== parent.parentStateKey ||
        moveIdentity(firstParent.move) !== moveIdentity(parent.move)
      ) {
        return invalidCheckpoint();
      }
    }
    if (
      !Number.isSafeInteger(checkpoint.discoveredStateCount) ||
      checkpoint.discoveredStateCount !== stateRecords.length ||
      !Number.isSafeInteger(checkpoint.discoveredEdgeCount) ||
      checkpoint.discoveredEdgeCount !== edgeCount ||
      !Number.isSafeInteger(checkpoint.completedPasses) ||
      (checkpoint.completedPasses as number) < 0
    ) return invalidCheckpoint();

    const normalized: ProofSearchCheckpointV1 = {
      schemaVersion: PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION,
      searchVersion: PROOF_SEARCH_VERSION,
      versions,
      query,
      queryIdentity: query.queryIdentity,
      root: expectedRoot,
      stateRecords,
      frontier,
      parentRecords,
      discoveredStateCount: stateRecords.length,
      discoveredEdgeCount: edgeCount,
      completedPasses: checkpoint.completedPasses as number,
    };
    return { status: 'valid', checkpoint: normalized };
  } catch {
    return invalidCheckpoint();
  }
}

function moveIdentity(move: CoordinateMove): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}
