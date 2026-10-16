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

type RecordValue = Record<string, unknown>;

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

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
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
  if (!isRecord(input)) reject('invalid-query');
  const predicate = input.predicate;
  const expectedKeys =
    predicate === 'cooperative-mating-reachability'
      ? [...commonQueryKeys(), 'intendedColor']
      : predicate === 'timeout-opponent-mating'
        ? [...commonQueryKeys(), 'expiredColor']
        : predicate === 'global-deadness'
          ? commonQueryKeys()
          : null;
  if (expectedKeys === null || !hasExactKeys(input, expectedKeys)) reject('invalid-query-shape');
  if (
    input.schemaVersion !== PROOF_SCHEMA_VERSION ||
    input.proofCheckerVersion !== PROOF_CHECKER_VERSION ||
    input.rulesAdapterVersion !== RULES_ADAPTER_VERSION ||
    input.predicateVersion !== PROOF_PREDICATE_VERSION
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
    if (typeof input[field] !== 'string' || input[field].length === 0) reject('invalid-query-identity');
  }
  if (
    (predicate === 'cooperative-mating-reachability' && !isColor(input.intendedColor)) ||
    (predicate === 'timeout-opponent-mating' && !isColor(input.expiredColor))
  ) {
    reject('invalid-query-color');
  }

  let position: Position;
  try {
    position = parsePosition(input.positionFen as string);
  } catch {
    reject('invalid-query-position');
  }

  const query = input as unknown as ProofQuery;
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
  if (!isRecord(input)) reject('invalid-coordinate-move');
  const hasPromotion = Object.hasOwn(input, 'promotion');
  const keys = hasPromotion ? ['from', 'to', 'promotion'] : ['from', 'to'];
  if (!hasExactKeys(input, keys)) reject('invalid-coordinate-move');
  if (
    typeof input.from !== 'string' || !/^[a-h][1-8]$/.test(input.from) ||
    typeof input.to !== 'string' || !/^[a-h][1-8]$/.test(input.to)
  ) {
    reject('invalid-coordinate-move');
  }
  if (hasPromotion && input.promotion !== 'q' && input.promotion !== 'r' && input.promotion !== 'b' && input.promotion !== 'n') {
    reject('invalid-coordinate-move');
  }
  return hasPromotion
    ? { from: input.from as CoordinateMove['from'], to: input.to as CoordinateMove['to'], promotion: input.promotion as NonNullable<CoordinateMove['promotion']> }
    : { from: input.from as CoordinateMove['from'], to: input.to as CoordinateMove['to'] };
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
  if (!Array.isArray(evidence.moves)) reject('incomplete-witness');
  if (evidence.moves.length > MAX_WITNESS_PLIES) stop('witness-ply-limit');

  const moves = evidence.moves.map(parseMove);
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
  if (typeof evidence.root !== 'string' || !Array.isArray(evidence.nodes)) reject('incomplete-closed-set');
  if (evidence.nodes.length === 0) reject('empty-closed-set');
  if (evidence.nodes.length > MAX_CERTIFICATE_STATES) stop('certificate-state-limit');

  const rootKey = stateKey(initial);
  if (evidence.root !== rootKey) reject('closed-set-root-mismatch');

  const states = new Map<CanonicalProofStateKey, Position>();
  const rawNodes = new Map<CanonicalProofStateKey, RecordValue>();
  let declaredEdgeCount = 0;
  for (const rawNode of evidence.nodes) {
    checkTime(startedAt);
    if (!isRecord(rawNode) || !hasExactKeys(rawNode, ['state', 'successors'])) reject('invalid-closed-set-node');
    if (typeof rawNode.state !== 'string' || !Array.isArray(rawNode.successors)) reject('invalid-closed-set-node');
    if (states.has(rawNode.state)) reject('duplicate-closed-set-state');
    const parsed = parseStateKey(rawNode.state);
    states.set(parsed.key, parsed.position);
    rawNodes.set(parsed.key, rawNode);
    declaredEdgeCount += rawNode.successors.length;
    if (declaredEdgeCount > MAX_CERTIFICATE_EDGES) stop('certificate-edge-limit');
  }
  if (!states.has(rootKey)) reject('closed-set-root-missing');

  const targetColorsInQuery = targetColors(query);
  const adjacency = new Map<CanonicalProofStateKey, readonly CanonicalProofStateKey[]>();
  let regeneratedEdgeCount = 0;

  for (const [key, position] of states) {
    checkTime(startedAt);
    const node = rawNodes.get(key);
    if (node === undefined || !Array.isArray(node.successors)) reject('invalid-closed-set-node');

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
    for (const rawSuccessor of node.successors) {
      if (!isRecord(rawSuccessor) || !hasExactKeys(rawSuccessor, ['move', 'target'])) reject('invalid-closed-set-successor');
      const move = parseMove(rawSuccessor.move);
      if (typeof rawSuccessor.target !== 'string') reject('invalid-closed-set-successor');
      const targetKey = rawSuccessor.target;
      const keyForMove = moveKey(move);
      if (declared.has(keyForMove)) reject('duplicate-closed-set-edge');
      declared.set(keyForMove, targetKey);
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
    if (!isRecord(evidenceInput) || typeof evidenceInput.kind !== 'string') reject('invalid-evidence');
    if (evidenceInput.kind === 'mate-witness') {
      return checkMateWitness(query, position, evidenceInput, startedAt);
    }
    if (evidenceInput.kind === 'closed-successor-set') {
      return validateClosedSet(query, position, evidenceInput, startedAt);
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
