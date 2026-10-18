export { checkProofEvidence } from './checker.js';
export { runProofSearchPass } from './search/search.js';
export { tryFastMatingWitness } from './search/fast-witness.js';
export type { FastMatingWitnessResult } from './search/fast-witness.js';
export { validateProofSearchCheckpoint } from './search/checkpoint.js';
export { createProofSearchWorker } from './search/worker.js';
export {
  canonicalProofStateKey,
  createDeadnessQuery,
  createMatingReachabilityQuery,
  createTimeoutMatingQuery,
  proofQueryIdentity,
} from './queries.js';
export {
  PROOF_CHECKER_VERSION,
  PROOF_PREDICATE_VERSION,
  PROOF_SCHEMA_VERSION,
  RULES_ADAPTER_VERSION,
} from './types.js';
export {
  PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION,
  PROOF_SEARCH_VERSION,
} from './search/types.js';
export type {
  CanonicalProofStateKey,
  ClosedSetNode,
  ClosedSetSuccessor,
  ClosedSuccessorSetEvidence,
  DeadnessQuery,
  MateWitnessEvidence,
  MatingReachabilityQuery,
  ProofCheckResult,
  ProofConclusion,
  ProofEvidence,
  ProofQuery,
  ProofQueryScope,
  TimeoutMatingQuery,
} from './types.js';
export type {
  ProofSearchCheckpointDisposition,
  ProofSearchCheckpointValidation,
  ProofSearchCheckpointV1,
  ProofSearchNonResultReason,
  ProofSearchParentRecordV1,
  ProofSearchPassOptionsV1,
  ProofSearchPassResult,
  ProofSearchPassStatisticsV1,
  ProofSearchStateRecordV1,
  ProofSearchSuccessorV1,
  ProofSearchVersionsV1,
} from './search/types.js';
export type { ProofSearchWorkerReplyV1, ProofSearchWorkerRequestV1 } from './search/worker.js';
