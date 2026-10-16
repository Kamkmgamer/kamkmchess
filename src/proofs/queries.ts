import { parsePosition, repetitionIdentity, type Position } from '../rules/index.js';
import {
  PROOF_CHECKER_VERSION,
  PROOF_PREDICATE_VERSION,
  PROOF_SCHEMA_VERSION,
  RULES_ADAPTER_VERSION,
  type DeadnessQuery,
  type MatingReachabilityQuery,
  type ProofQuery,
  type ProofQueryScope,
  type TimeoutMatingQuery,
} from './types.js';
import type { Color } from '../rules/index.js';

type QueryInput = ProofQueryScope & { readonly positionFen: string };

type QueryFields =
  | Omit<MatingReachabilityQuery, 'queryIdentity'>
  | Omit<DeadnessQuery, 'queryIdentity'>
  | Omit<TimeoutMatingQuery, 'queryIdentity'>;

function identityFor(query: QueryFields | ProofQuery): string {
  const colorBinding =
    query.predicate === 'cooperative-mating-reachability'
      ? ['intended', query.intendedColor]
      : query.predicate === 'timeout-opponent-mating'
        ? ['expired', query.expiredColor]
        : ['global'];

  return `proof-query:${JSON.stringify([
    query.schemaVersion,
    query.proofCheckerVersion,
    query.rulesAdapterVersion,
    query.predicateVersion,
    query.predicate,
    query.gameId,
    query.segmentId,
    query.positionRevision,
    query.analysisGeneration,
    query.ownershipEpoch,
    query.positionFen,
    ...colorBinding,
  ])}`;
}

function createBaseQuery<T extends QueryFields>(
  fields: T,
): T & Pick<ProofQuery, 'queryIdentity'> {
  if (
    typeof fields.gameId !== 'string' || fields.gameId.length === 0 ||
    typeof fields.segmentId !== 'string' || fields.segmentId.length === 0 ||
    typeof fields.positionRevision !== 'string' || fields.positionRevision.length === 0 ||
    typeof fields.analysisGeneration !== 'string' || fields.analysisGeneration.length === 0 ||
    typeof fields.ownershipEpoch !== 'string' || fields.ownershipEpoch.length === 0
  ) {
    throw new TypeError('Proof query identity fields must be nonempty strings.');
  }

  if (typeof fields.positionFen !== 'string') {
    throw new TypeError('Proof query positionFen must be a string.');
  }
  parsePosition(fields.positionFen);

  const queryIdentity = identityFor(fields);
  return Object.freeze({ ...fields, queryIdentity }) as unknown as T & Pick<ProofQuery, 'queryIdentity'>;
}

function baseFields(input: QueryInput) {
  return {
    schemaVersion: PROOF_SCHEMA_VERSION,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    predicateVersion: PROOF_PREDICATE_VERSION,
    gameId: input.gameId,
    segmentId: input.segmentId,
    positionRevision: input.positionRevision,
    analysisGeneration: input.analysisGeneration,
    ownershipEpoch: input.ownershipEpoch,
    positionFen: input.positionFen,
  } as const;
}

export function createMatingReachabilityQuery(
  input: QueryInput & { readonly intendedColor: Color },
): MatingReachabilityQuery {
  if (input.intendedColor !== 'w' && input.intendedColor !== 'b') {
    throw new TypeError('A mating query needs an intended color.');
  }
  return createBaseQuery({
    ...baseFields(input),
    predicate: 'cooperative-mating-reachability',
    intendedColor: input.intendedColor,
  });
}

export function createDeadnessQuery(input: QueryInput): DeadnessQuery {
  return createBaseQuery({ ...baseFields(input), predicate: 'global-deadness' });
}

export function createTimeoutMatingQuery(
  input: QueryInput & { readonly expiredColor: Color },
): TimeoutMatingQuery {
  if (input.expiredColor !== 'w' && input.expiredColor !== 'b') {
    throw new TypeError('A timeout query needs the expired color.');
  }
  return createBaseQuery({
    ...baseFields(input),
    predicate: 'timeout-opponent-mating',
    expiredColor: input.expiredColor,
  });
}

export function canonicalProofStateKey(position: Position): string {
  if (position.enPassantSquare === null) {
    return [position.placement, position.sideToMove, position.castlingRights, '-'].join(' ');
  }
  return repetitionIdentity(position);
}

export function proofQueryIdentity(query: ProofQuery): string {
  return identityFor(query);
}
