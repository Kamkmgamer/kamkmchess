import type { ProofQuery } from '../types.js';
import type { ProofSearchPassResult } from './types.js';

export type ProofSearchWorkerRequestV1 =
  | {
      readonly type: 'start';
      readonly requestId: string;
      readonly query: ProofQuery;
      readonly maxDiscoveredStates?: number;
      readonly timeBudgetMs?: number;
    }
  | {
      readonly type: 'resume';
      readonly requestId: string;
      readonly query: ProofQuery;
      readonly checkpoint: unknown;
      readonly maxDiscoveredStates?: number;
      readonly timeBudgetMs?: number;
    }
  | { readonly type: 'cancel'; readonly requestId: string };

export type ProofSearchWorkerReplyV1 =
  | { readonly type: 'result'; readonly requestId: string; readonly result: ProofSearchPassResult }
  | { readonly type: 'error'; readonly requestId: string; readonly reason: 'invalid-message' | 'search-error' };

/** Creates the isolated browser Worker used for cooperative proof-search passes. */
export function createProofSearchWorker(): Worker {
  return new Worker(new URL('../proof-search.worker.ts', import.meta.url), { type: 'module' });
}
