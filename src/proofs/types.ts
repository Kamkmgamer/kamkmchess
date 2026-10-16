import type { Color, CoordinateMove } from '../rules/index.js';

export const PROOF_SCHEMA_VERSION = 1 as const;
export const PROOF_CHECKER_VERSION = 'kha30-proof-checker/1' as const;
export const RULES_ADAPTER_VERSION = 'kha27-authoritative-transitions/1' as const;
export const PROOF_PREDICATE_VERSION = 'cooperative-legal-mate-no-future-draws/1' as const;

export interface ProofQueryScope {
  readonly gameId: string;
  readonly segmentId: string;
  readonly positionRevision: string;
  readonly analysisGeneration: string;
  readonly ownershipEpoch: string;
}

interface ProofQueryBase extends ProofQueryScope {
  readonly schemaVersion: typeof PROOF_SCHEMA_VERSION;
  readonly proofCheckerVersion: typeof PROOF_CHECKER_VERSION;
  readonly rulesAdapterVersion: typeof RULES_ADAPTER_VERSION;
  readonly predicateVersion: typeof PROOF_PREDICATE_VERSION;
  readonly positionFen: string;
  readonly queryIdentity: string;
}

export interface MatingReachabilityQuery extends ProofQueryBase {
  readonly predicate: 'cooperative-mating-reachability';
  readonly intendedColor: Color;
}

export interface DeadnessQuery extends ProofQueryBase {
  readonly predicate: 'global-deadness';
}

export interface TimeoutMatingQuery extends ProofQueryBase {
  readonly predicate: 'timeout-opponent-mating';
  readonly expiredColor: Color;
}

export type ProofQuery = MatingReachabilityQuery | DeadnessQuery | TimeoutMatingQuery;
export type CanonicalProofStateKey = string;

interface ProofEvidenceBase {
  readonly schemaVersion: typeof PROOF_SCHEMA_VERSION;
  readonly proofCheckerVersion: typeof PROOF_CHECKER_VERSION;
  readonly rulesAdapterVersion: typeof RULES_ADAPTER_VERSION;
  readonly queryIdentity: string;
}

export interface MateWitnessEvidence extends ProofEvidenceBase {
  readonly kind: 'mate-witness';
  readonly intendedColor: Color;
  readonly moves: readonly CoordinateMove[];
}

export interface ClosedSetSuccessor {
  readonly move: CoordinateMove;
  readonly target: CanonicalProofStateKey;
}

export interface ClosedSetNode {
  readonly state: CanonicalProofStateKey;
  readonly successors: readonly ClosedSetSuccessor[];
}

export interface ClosedSuccessorSetEvidence extends ProofEvidenceBase {
  readonly kind: 'closed-successor-set';
  readonly root: CanonicalProofStateKey;
  readonly nodes: readonly ClosedSetNode[];
}

export type ProofEvidence = MateWitnessEvidence | ClosedSuccessorSetEvidence;

export type ProofConclusion =
  | 'mate-reachable'
  | 'mate-unreachable'
  | 'dead'
  | 'not-dead'
  | 'opponent-can-mate'
  | 'opponent-cannot-mate';

export type ProofCheckResult =
  | {
      readonly status: 'accepted';
      readonly conclusion: ProofConclusion;
      readonly queryIdentity: string;
      readonly evidenceKind: ProofEvidence['kind'];
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly queryIdentity?: string;
    }
  | {
      readonly status: 'non-result';
      readonly reason: string;
      readonly queryIdentity?: string;
    };
