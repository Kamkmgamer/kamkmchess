import {
  createProofSearchWorker,
  validateProofSearchCheckpoint,
} from '../proofs/index.js';
import type {
  ProofQuery,
  ProofSearchCheckpointV1,
  ProofSearchPassResult,
  ProofSearchWorkerReplyV1,
  ProofSearchWorkerRequestV1,
} from '../proofs/index.js';
import { openProofSearchStore } from '../storage/index.js';
import type {
  GameNamespaceV1,
  ProofSearchStoreV1,
} from '../storage/index.js';

export interface ProofSearchWorkerPortV1 {
  onmessage: ((event: MessageEvent<ProofSearchWorkerReplyV1>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: ProofSearchWorkerRequestV1): void;
  terminate(): void;
}

export interface ProofAdjudicationPassInputV1 {
  readonly namespace: GameNamespaceV1;
  readonly query: ProofQuery;
  readonly signal?: AbortSignal;
}

export interface ProofAdjudicationRunnerV1 {
  runPass(input: ProofAdjudicationPassInputV1): Promise<ProofSearchPassResult>;
}

export interface ProofAdjudicationRunnerOptionsV1 {
  readonly createWorker?: () => ProofSearchWorkerPortV1;
  readonly openCheckpointStore?: () => Promise<ProofSearchStoreV1>;
  readonly requestIdFactory?: () => string;
}

const openDefaultCheckpointStore = (): Promise<ProofSearchStoreV1> => openProofSearchStore();
const createRequestId = (): string => globalThis.crypto.randomUUID();

function isSearchResult(value: unknown): value is ProofSearchPassResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.status === 'accepted') {
    return typeof result.queryIdentity === 'string' &&
      typeof result.evidence === 'object' && result.evidence !== null &&
      typeof result.conclusion === 'string';
  }
  if (result.status === 'non-result') {
    return typeof result.reason === 'string' &&
      (result.checkpoint === null || typeof result.checkpoint === 'object') &&
      typeof result.checkpointDisposition === 'string';
  }
  return false;
}

function nonResult(
  query: ProofQuery,
  reason: Extract<ProofSearchPassResult, { status: 'non-result' }>['reason'],
  checkpoint: ProofSearchCheckpointV1 | null,
  disposition: Extract<ProofSearchPassResult, { status: 'non-result' }>['checkpointDisposition'],
): Extract<ProofSearchPassResult, { status: 'non-result' }> {
  return {
    status: 'non-result',
    reason,
    queryIdentity: query.queryIdentity,
    checkpoint,
    checkpointDisposition: disposition,
    pass: {
      maxDiscoveredStates: 10_000,
      timeBudgetMs: 5_000,
      discoveredStateCount: 0,
      processedEdgeCount: 0,
      expandedStateCount: 0,
      totalDiscoveredStateCount: checkpoint?.discoveredStateCount ?? 0,
      totalDiscoveredEdgeCount: checkpoint?.discoveredEdgeCount ?? 0,
      elapsedMs: 0,
    },
  };
}

function readReply(event: MessageEvent<ProofSearchWorkerReplyV1>): ProofSearchWorkerReplyV1 | null {
  const value: unknown = event.data;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const reply = value as Record<string, unknown>;
  if (reply.type === 'error' && typeof reply.requestId === 'string' &&
      (reply.reason === 'invalid-message' || reply.reason === 'search-error')) {
    return reply as unknown as ProofSearchWorkerReplyV1;
  }
  if (reply.type !== 'result' || typeof reply.requestId !== 'string' || !isSearchResult(reply.result)) {
    return null;
  }
  return reply as unknown as ProofSearchWorkerReplyV1;
}

async function saveNonResultCheckpoint(
  store: ProofSearchStoreV1,
  namespace: GameNamespaceV1,
  query: ProofQuery,
  result: Extract<ProofSearchPassResult, { status: 'non-result' }>,
): Promise<ProofSearchPassResult> {
  if (result.queryIdentity !== undefined && result.queryIdentity !== query.queryIdentity) {
    return nonResult(query, 'invalid-query', null, result.checkpointDisposition);
  }
  if (result.checkpoint === null) return result;

  const validation = validateProofSearchCheckpoint(result.checkpoint);
  if (
    validation.status !== 'valid' ||
    validation.checkpoint.queryIdentity !== query.queryIdentity ||
    validation.checkpoint.query.queryIdentity !== query.queryIdentity
  ) {
    return nonResult(query, 'invalid-checkpoint', null, 'restarted');
  }

  try {
    await store.saveCheckpoint({ namespace, checkpoint: validation.checkpoint });
    return { ...result, checkpoint: validation.checkpoint };
  } catch {
    return { ...result, checkpoint: null, reason: 'search-error' };
  }
}

export function createProofAdjudicationRunner(
  options: ProofAdjudicationRunnerOptionsV1 = {},
): ProofAdjudicationRunnerV1 {
  const createWorker = options.createWorker ?? createProofSearchWorker;
  const openCheckpointStore = options.openCheckpointStore ?? openDefaultCheckpointStore;
  const requestIdFactory = options.requestIdFactory ?? createRequestId;

  return {
    async runPass(input) {
      let store: ProofSearchStoreV1 | null = null;
      let savedCheckpoint: ProofSearchCheckpointV1 | null = null;
      let disposition: Extract<ProofSearchPassResult, { status: 'non-result' }>['checkpointDisposition'] = 'fresh';

      try {
        store = await openCheckpointStore();
        const loaded = await store.loadCheckpoint({
          namespace: input.namespace,
          gameId: input.query.gameId,
          queryIdentity: input.query.queryIdentity,
        });
        if (loaded.status === 'found') {
          savedCheckpoint = loaded.checkpoint;
          disposition = 'resumed';
        } else if (loaded.status === 'restart-required') {
          disposition = 'restarted';
          await store.deleteCheckpoint({
            namespace: input.namespace,
            gameId: input.query.gameId,
            queryIdentity: input.query.queryIdentity,
          });
        }
      } catch {
        // A fresh pass can still prove a positive result when checkpoint storage is unavailable.
      }

      if (input.signal?.aborted) {
        return nonResult(input.query, 'cancelled', savedCheckpoint, disposition);
      }

      let worker: ProofSearchWorkerPortV1;
      try {
        worker = createWorker();
      } catch {
        return nonResult(input.query, 'search-error', savedCheckpoint, disposition);
      }

      const requestId = requestIdFactory();
      const request: ProofSearchWorkerRequestV1 = savedCheckpoint === null
        ? { type: 'start', requestId, query: input.query }
        : { type: 'resume', requestId, query: input.query, checkpoint: savedCheckpoint };

      try {
        const replyResult = await new Promise<ProofSearchPassResult>((resolve) => {
          let settled = false;
          const finish = (result: ProofSearchPassResult) => {
            if (settled) return;
            settled = true;
            input.signal?.removeEventListener('abort', cancel);
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            worker.terminate();
            resolve(result);
          };
          const cancel = () => {
            try {
              worker.postMessage({ type: 'cancel', requestId });
            } catch {
              finish(nonResult(input.query, 'cancelled', savedCheckpoint, disposition));
            }
          };
          worker.onmessage = (event) => {
            const reply = readReply(event);
            if (reply === null || reply.requestId !== requestId) return;
            if (reply.type === 'error') {
              finish(nonResult(input.query, 'search-error', savedCheckpoint, disposition));
              return;
            }
            const result = reply.result;
            if (result.status === 'accepted') {
              if (result.queryIdentity !== input.query.queryIdentity) {
                finish(nonResult(input.query, 'invalid-query', savedCheckpoint, disposition));
              } else {
                finish(result);
              }
              return;
            }
            finish(result);
          };
          worker.onerror = () => finish(nonResult(input.query, 'search-error', savedCheckpoint, disposition));
          worker.onmessageerror = () => finish(nonResult(input.query, 'search-error', savedCheckpoint, disposition));
          input.signal?.addEventListener('abort', cancel, { once: true });
          try {
            worker.postMessage(request);
          } catch {
            finish(nonResult(input.query, 'search-error', savedCheckpoint, disposition));
          }
        });

        if (replyResult.status === 'accepted') return replyResult;
        if (store === null) return { ...replyResult, checkpoint: savedCheckpoint };
        return await saveNonResultCheckpoint(store, input.namespace, input.query, {
          ...replyResult,
          checkpoint: replyResult.checkpoint ?? savedCheckpoint,
          checkpointDisposition: disposition === 'fresh' ? replyResult.checkpointDisposition : disposition,
        });
      } catch {
        return nonResult(input.query, 'search-error', savedCheckpoint, disposition);
      } finally {
        store?.close();
      }
    },
  };
}
