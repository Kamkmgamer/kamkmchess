import {
  applyCoordinateMove,
  createRepetitionLedger,
  IllegalMoveError,
  legalMoves,
  observeEndingFacts,
  parsePosition,
  repetitionIdentity,
  type Color,
  type CoordinateMove,
  type Position,
} from '../rules/index.js';
import { proofQueryIdentity } from './queries.js';
import {
  PROOF_CHECKER_VERSION,
  PROOF_PREDICATE_VERSION,
  PROOF_SCHEMA_VERSION,
  RULES_ADAPTER_VERSION,
  type CanonicalProofStateKey,
  type ProofCheckResult,
  type ProofConclusion,
  type ProofQuery,
} from './types.js';

const MAX_WITNESS_PLIES = 100_000;
const MAX_CERTIFICATE_STATES = 10_000;
const MAX_CERTIFICATE_EDGES = 100_000;
const MAX_CHECK_TIME_MS = 5_000;
const MAX_RECORD_FIELDS = 16;

type RecordValue = Record<string, unknown>;
type SubmittedSuccessor = Readonly<{
  move: CoordinateMove;
  target: CanonicalProofStateKey;
}>;

class EvidenceRejection extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

class CheckerLimit extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function reject(reason: string): never {
  throw new EvidenceRejection(reason);
}

function stop(reason: string): never {
  throw new CheckerLimit(reason);
}

function snapshotRecord(value: unknown, invalidReason: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject(invalidReason);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject(invalidReason);

  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_RECORD_FIELDS) reject(invalidReason);

  const snapshot = Object.create(null) as RecordValue;
  for (const key of keys) {
    if (typeof key !== 'string') reject(invalidReason);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      reject(invalidReason);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function hasExactKeys(record: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function snapshotArray(
  value: unknown,
  maximumLength: number,
  invalidReason: string,
  limitReason: string,
  startedAt: number,
): unknown[] {
  if (!Array.isArray(value)) reject(invalidReason);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    reject(invalidReason);
  }

  const length = lengthDescriptor.value as number;
  if (length > maximumLength) stop(limitReason);

  const snapshot = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    if (index % 256 === 0) checkTime(startedAt);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      reject(invalidReason);
    }
    snapshot[index] = descriptor.value;
  }
  checkTime(startedAt);
  return snapshot;
}

function isColor(value: unknown): value is Color {
  return value === 'w' || value === 'b';
}

function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function checkTime(startedAt: number): void {
  if (now() - startedAt > MAX_CHECK_TIME_MS) stop('time-limit');
}

function commonQueryKeys(): readonly string[] {
  return [
    'schemaVersion',
    'proofCheckerVersion',
    'rulesAdapterVersion',
    'predicateVersion',
    'gameId',
    'segmentId',
    'positionRevision',
    'analysisGeneration',
    'ownershipEpoch',
    'positionFen',
    'queryIdentity',
    'predicate',
  ];
}

function validateQuery(input: unknown): { query: ProofQuery; position: Position } {
  const fields = snapshotRecord(input, 'invalid-query');
  const predicate = fields.predicate;
  const expectedKeys =
    predicate === 'cooperative-mating-reachability'
      ? [...commonQueryKeys(), 'intendedColor']
      : predicate === 'timeout-opponent-mating'
        ? [...commonQueryKeys(), 'expiredColor']
        : predicate === 'global-deadness'
          ? commonQueryKeys()
          : null;
  if (expectedKeys === null || !hasExactKeys(fields, expectedKeys)) reject('invalid-query-shape');
  if (
    fields.schemaVersion !== PROOF_SCHEMA_VERSION ||
    fields.proofCheckerVersion !== PROOF_CHECKER_VERSION ||
    fields.rulesAdapterVersion !== RULES_ADAPTER_VERSION ||
    fields.predicateVersion !== PROOF_PREDICATE_VERSION
  ) {
    reject('unsupported-query-version');
  }
  for (const field of [
    'gameId',
    'segmentId',
    'positionRevision',
    'analysisGeneration',
    'ownershipEpoch',
    'positionFen',
    'queryIdentity',
  ]) {
    if (typeof fields[field] !== 'string' || fields[field].length === 0) reject('invalid-query-identity');
  }
  if (
    (predicate === 'cooperative-mating-reachability' && !isColor(fields.intendedColor)) ||
    (predicate === 'timeout-opponent-mating' && !isColor(fields.expiredColor))
  ) {
    reject('invalid-query-color');
  }

  let position: Position;
  try {
    position = parsePosition(fields.positionFen as string);
  } catch {
    reject('invalid-query-position');
  }

  const query = fields as unknown as ProofQuery;
  if (query.queryIdentity !== proofQueryIdentity(query)) reject('query-identity-mismatch');
  return { query, position };
}

function validateEvidenceBase(
  evidence: RecordValue,
  query: ProofQuery,
  expectedKeys: readonly string[],
): void {
  if (!hasExactKeys(evidence, expectedKeys)) reject('invalid-evidence-shape');
  if (
    evidence.schemaVersion !== PROOF_SCHEMA_VERSION ||
    evidence.proofCheckerVersion !== PROOF_CHECKER_VERSION ||
    evidence.rulesAdapterVersion !== RULES_ADAPTER_VERSION
  ) {
    reject('unsupported-evidence-version');
  }
  if (typeof evidence.queryIdentity !== 'string' || evidence.queryIdentity !== query.queryIdentity) {
    reject('evidence-query-identity-mismatch');
  }
}

function evidenceBaseKeys(): readonly string[] {
  return ['schemaVersion', 'proofCheckerVersion', 'rulesAdapterVersion', 'kind', 'queryIdentity'];
}

function parseMove(input: unknown): CoordinateMove {
  const move = snapshotRecord(input, 'invalid-coordinate-move');
  const hasPromotion = Object.hasOwn(move, 'promotion');
  const keys = hasPromotion ? ['from', 'to', 'promotion'] : ['from', 'to'];
  if (!hasExactKeys(move, keys)) reject('invalid-coordinate-move');
  if (
    typeof move.from !== 'string' || !/^[a-h][1-8]$/.test(move.from) ||
    typeof move.to !== 'string' || !/^[a-h][1-8]$/.test(move.to)
  ) {
    reject('invalid-coordinate-move');
  }
  if (hasPromotion && move.promotion !== 'q' && move.promotion !== 'r' && move.promotion !== 'b' && move.promotion !== 'n') {
    reject('invalid-coordinate-move');
  }
  return hasPromotion
    ? { from: move.from as CoordinateMove['from'], to: move.to as CoordinateMove['to'], promotion: move.promotion as NonNullable<CoordinateMove['promotion']> }
    : { from: move.from as CoordinateMove['from'], to: move.to as CoordinateMove['to'] };
}

function moveKey(move: CoordinateMove): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

function stateKey(position: Position): CanonicalProofStateKey {
  return repetitionIdentity(position);
}

function parseStateKey(input: unknown): { key: CanonicalProofStateKey; position: Position } {
  if (typeof input !== 'string') reject('invalid-state-key');
  const fields = input.split(' ');
  if (fields.length !== 4 || fields.some((field) => field.length === 0)) reject('noncanonical-state-key');

  let position: Position;
  try {
    position = parsePosition(`${input} 0 2`);
  } catch {
    reject('invalid-state-position');
  }
  if (stateKey(position) !== input) reject('noncanonical-state-key');
  return { key: input, position };
}

function targetColors(query: ProofQuery): readonly Color[] {
  if (query.predicate === 'cooperative-mating-reachability') return [query.intendedColor];
  if (query.predicate === 'timeout-opponent-mating') return [opposite(query.expiredColor)];
  return ['w', 'b'];
}

function isMateDeliveredBy(position: Position, colors: readonly Color[]): boolean {
  const facts = observeEndingFacts(position, createRepetitionLedger(position));
  return facts.checkmate && colors.includes(opposite(position.sideToMove));
}

function positiveConclusion(query: ProofQuery): ProofConclusion {
  if (query.predicate === 'cooperative-mating-reachability') return 'mate-reachable';
  if (query.predicate === 'timeout-opponent-mating') return 'opponent-can-mate';
  return 'not-dead';
}

function negativeConclusion(query: ProofQuery): ProofConclusion {
  if (query.predicate === 'cooperative-mating-reachability') return 'mate-unreachable';
  if (query.predicate === 'timeout-opponent-mating') return 'opponent-cannot-mate';
  return 'dead';
}

function expectedWitnessColor(query: ProofQuery, submitted: Color): boolean {
  if (query.predicate === 'cooperative-mating-reachability') return query.intendedColor === submitted;
  if (query.predicate === 'timeout-opponent-mating') return opposite(query.expiredColor) === submitted;
  return true;
}

function accepted(
  query: ProofQuery,
  evidenceKind: 'mate-witness' | 'closed-successor-set',
  conclusion: ProofConclusion,
): ProofCheckResult {
  return Object.freeze({ status: 'accepted', queryIdentity: query.queryIdentity, evidenceKind, conclusion });
}

function checkMateWitness(
  query: ProofQuery,
  initial: Position,
  evidence: RecordValue,
  startedAt: number,
): ProofCheckResult {
  validateEvidenceBase(evidence, query, [...evidenceBaseKeys(), 'intendedColor', 'moves']);
  if (!isColor(evidence.intendedColor) || !expectedWitnessColor(query, evidence.intendedColor)) {
    reject('wrong-witness-color');
  }
  const submittedMoves = snapshotArray(
    evidence.moves,
    MAX_WITNESS_PLIES,
    'incomplete-witness',
    'witness-ply-limit',
    startedAt,
  );
  const moves: CoordinateMove[] = [];
  let submittedMoveIndex = 0;
  for (const submittedMove of submittedMoves) {
    if (submittedMoveIndex % 256 === 0) checkTime(startedAt);
    moves.push(parseMove(submittedMove));
    submittedMoveIndex += 1;
  }
  checkTime(startedAt);
  let position = initial;
  for (const move of moves) {
    checkTime(startedAt);
    try {
      position = applyCoordinateMove(position, move).position;
    } catch (error) {
      if (error instanceof IllegalMoveError) reject('illegal-witness-move');
      throw error;
    }
  }
  checkTime(startedAt);
  if (!isMateDeliveredBy(position, [evidence.intendedColor])) reject('witness-does-not-end-in-intended-checkmate');
  return accepted(query, 'mate-witness', positiveConclusion(query));
}

function validateClosedSet(
  query: ProofQuery,
  initial: Position,
  evidence: RecordValue,
  startedAt: number,
): ProofCheckResult {
  validateEvidenceBase(evidence, query, [...evidenceBaseKeys(), 'root', 'nodes']);
  if (typeof evidence.root !== 'string') reject('incomplete-closed-set');
  const submittedNodes = snapshotArray(
    evidence.nodes,
    MAX_CERTIFICATE_STATES,
    'incomplete-closed-set',
    'certificate-state-limit',
    startedAt,
  );
  if (submittedNodes.length === 0) reject('empty-closed-set');

  const rootKey = stateKey(initial);
  if (evidence.root !== rootKey) reject('closed-set-root-mismatch');

  const states = new Map<CanonicalProofStateKey, Position>();
  const submittedSuccessors = new Map<CanonicalProofStateKey, readonly SubmittedSuccessor[]>();
  let declaredEdgeCount = 0;
  for (const rawNode of submittedNodes) {
    checkTime(startedAt);
    const node = snapshotRecord(rawNode, 'invalid-closed-set-node');
    if (!hasExactKeys(node, ['state', 'successors'])) reject('invalid-closed-set-node');
    if (typeof node.state !== 'string') reject('invalid-closed-set-node');
    const successors = snapshotArray(
      node.successors,
      MAX_CERTIFICATE_EDGES - declaredEdgeCount,
      'invalid-closed-set-node',
      'certificate-edge-limit',
      startedAt,
    );
    if (states.has(node.state)) reject('duplicate-closed-set-state');
    const parsed = parseStateKey(node.state);
    declaredEdgeCount += successors.length;
    const checkedSuccessors: SubmittedSuccessor[] = [];
    let submittedSuccessorIndex = 0;
    for (const rawSuccessor of successors) {
      if (submittedSuccessorIndex % 256 === 0) checkTime(startedAt);
      const successor = snapshotRecord(rawSuccessor, 'invalid-closed-set-successor');
      if (!hasExactKeys(successor, ['move', 'target'])) reject('invalid-closed-set-successor');
      const move = parseMove(successor.move);
      if (typeof successor.target !== 'string') reject('invalid-closed-set-successor');
      checkedSuccessors.push({ move, target: successor.target });
      submittedSuccessorIndex += 1;
    }
    checkTime(startedAt);
    states.set(parsed.key, parsed.position);
    submittedSuccessors.set(parsed.key, checkedSuccessors);
  }
  if (!states.has(rootKey)) reject('closed-set-root-missing');

  const targetColorsInQuery = targetColors(query);
  const adjacency = new Map<CanonicalProofStateKey, readonly CanonicalProofStateKey[]>();
  let regeneratedEdgeCount = 0;

  for (const [key, position] of states) {
    checkTime(startedAt);
    const declaredSuccessors = submittedSuccessors.get(key);
    if (declaredSuccessors === undefined) reject('invalid-closed-set-node');

    const legal = legalMoves(position);
    if (legal.length === 0 && isMateDeliveredBy(position, targetColorsInQuery)) {
      reject('closed-set-contains-target-checkmate');
    }
    regeneratedEdgeCount += legal.length;
    if (regeneratedEdgeCount > MAX_CERTIFICATE_EDGES) stop('certificate-edge-limit');
    const expected = new Map<string, string>();
    for (const move of legal) {
      checkTime(startedAt);
      const transition = applyCoordinateMove(position, move);
      const targetKey = stateKey(transition.position);
      expected.set(moveKey(move), targetKey);
    }

    const declared = new Map<string, string>();
    for (const successor of declaredSuccessors) {
      const keyForMove = moveKey(successor.move);
      if (declared.has(keyForMove)) reject('duplicate-closed-set-edge');
      declared.set(keyForMove, successor.target);
    }

    if (declared.size !== expected.size) reject('closed-set-successor-count-mismatch');
    for (const [move, target] of expected) {
      if (declared.get(move) !== target) reject('closed-set-successor-mismatch');
      if (!states.has(target)) reject('closed-set-successor-state-missing');
    }
    adjacency.set(key, [...expected.values()]);
  }

  const reachable = new Set<CanonicalProofStateKey>([rootKey]);
  const frontier = [rootKey];
  while (frontier.length > 0) {
    checkTime(startedAt);
    const current = frontier.pop();
    if (current === undefined) break;
    for (const target of adjacency.get(current) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      frontier.push(target);
    }
  }
  if (reachable.size !== states.size) reject('closed-set-has-unreachable-state');

  return accepted(query, 'closed-successor-set', negativeConclusion(query));
}

export function checkProofEvidence(queryInput: unknown, evidenceInput: unknown): ProofCheckResult {
  let validated: { query: ProofQuery; position: Position };
  try {
    validated = validateQuery(queryInput);
  } catch (error) {
    return Object.freeze({ status: 'rejected', reason: error instanceof EvidenceRejection ? error.reason : 'invalid-query' });
  }

  const { query, position } = validated;
  if (evidenceInput === null || evidenceInput === undefined) {
    return Object.freeze({ status: 'non-result', reason: 'missing-evidence', queryIdentity: query.queryIdentity });
  }

  const startedAt = now();
  try {
    const evidence = snapshotRecord(evidenceInput, 'invalid-evidence');
    if (typeof evidence.kind !== 'string') reject('invalid-evidence');
    if (evidence.kind === 'mate-witness') {
      return checkMateWitness(query, position, evidence, startedAt);
    }
    if (evidence.kind === 'closed-successor-set') {
      return validateClosedSet(query, position, evidence, startedAt);
    }
    reject('unsupported-evidence-kind');
  } catch (error) {
    if (error instanceof CheckerLimit) {
      return Object.freeze({ status: 'non-result', reason: error.reason, queryIdentity: query.queryIdentity });
    }
    if (error instanceof EvidenceRejection) {
      return Object.freeze({ status: 'rejected', reason: error.reason, queryIdentity: query.queryIdentity });
    }
    return Object.freeze({ status: 'non-result', reason: 'checker-transition-error', queryIdentity: query.queryIdentity });
  }
}
