export { checkProofEvidence } from './checker.js';
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
