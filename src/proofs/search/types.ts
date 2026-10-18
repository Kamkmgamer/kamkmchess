import type { CoordinateMove } from '../../rules/index.js';
import type { ProofCheckResult, ProofEvidence, ProofQuery } from '../index.js';

export const PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const PROOF_SEARCH_VERSION = 'kha31-cooperative-search/2' as const;

export interface ProofSearchVersionsV1 {
  readonly checkpointSchemaVersion: typeof PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION;
  readonly proofSchemaVersion: number;
  readonly proofCheckerVersion: string;
  readonly rulesAdapterVersion: string;
  readonly predicateVersion: string;
  readonly searchVersion: typeof PROOF_SEARCH_VERSION;
}

export interface ProofSearchSuccessorV1 {
  readonly move: CoordinateMove;
  readonly target: string;
}

export interface ProofSearchStateRecordV1 {
  readonly stateKey: string;
  readonly positionFen: string;
  readonly status: 'queued' | 'expanding' | 'expanded';
  readonly nextMoveIndex: number;
  readonly successors: readonly ProofSearchSuccessorV1[];
}

export interface ProofSearchParentRecordV1 {
  readonly stateKey: string;
  readonly parentStateKey: string | null;
  readonly move: CoordinateMove | null;
}

export interface ProofSearchCheckpointV1 {
  readonly schemaVersion: typeof PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION;
  readonly searchVersion: typeof PROOF_SEARCH_VERSION;
  readonly versions: ProofSearchVersionsV1;
  readonly query: ProofQuery;
  readonly queryIdentity: string;
  readonly root: string;
  readonly stateRecords: readonly ProofSearchStateRecordV1[];
  readonly frontier: readonly string[];
  readonly parentRecords: readonly ProofSearchParentRecordV1[];
  readonly discoveredStateCount: number;
  readonly discoveredEdgeCount: number;
  readonly completedPasses: number;
}

export type ProofSearchCheckpointDisposition = 'fresh' | 'resumed' | 'restarted';

export interface ProofSearchPassStatisticsV1 {
  readonly maxDiscoveredStates: number;
  readonly timeBudgetMs: number;
  readonly discoveredStateCount: number;
  readonly processedEdgeCount: number;
  readonly expandedStateCount: number;
  readonly totalDiscoveredStateCount: number;
  readonly totalDiscoveredEdgeCount: number;
  readonly elapsedMs: number;
}

export type ProofSearchNonResultReason =
  | 'state-budget'
  | 'time-budget'
  | 'cancelled'
  | 'certificate-state-limit'
  | 'certificate-edge-limit'
  | 'checker-non-result'
  | 'checker-rejected'
  | 'invalid-checkpoint'
  | 'invalid-query'
  | 'search-error';

export type ProofSearchPassResult =
  | {
      readonly status: 'accepted';
      readonly conclusion: Extract<ProofCheckResult, { status: 'accepted' }>['conclusion'];
      readonly queryIdentity: string;
      readonly evidence: ProofEvidence;
      readonly checkpointDisposition: ProofSearchCheckpointDisposition;
      readonly pass: ProofSearchPassStatisticsV1;
    }
  | {
      readonly status: 'non-result';
      readonly reason: ProofSearchNonResultReason;
      readonly queryIdentity?: string;
      readonly checkpoint: ProofSearchCheckpointV1 | null;
      readonly checkpointDisposition: ProofSearchCheckpointDisposition;
      readonly pass: ProofSearchPassStatisticsV1;
    };

export interface ProofSearchPassOptionsV1 {
  /** Maximum number of new states in this pass. Defaults to 10,000. */
  readonly maxDiscoveredStates?: number;
  /** Maximum graph traversal time for this pass. Defaults to 5,000 ms. */
  readonly timeBudgetMs?: number;
  readonly checkpoint?: unknown;
  readonly signal?: AbortSignal;
  /** Skip positive witness discovery when explicitly requesting graph exploration. */
  readonly fastWitness?: boolean;
}

export type ProofSearchCheckpointValidation =
  | { readonly status: 'valid'; readonly checkpoint: ProofSearchCheckpointV1 }
  | {
      readonly status: 'restart-required';
      readonly reason: 'corrupt-checkpoint' | 'incompatible-checkpoint' | 'query-mismatch';
    };
