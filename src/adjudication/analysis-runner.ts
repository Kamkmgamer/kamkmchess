import {
  checkProofEvidence,
  createProofSearchWorker,
  proofQueryIdentity,
  validateProofSearchCheckpoint,
} from '../proofs/index.js';
import type {
  ProofQuery,
  ProofSearchPassResult,
  ProofSearchWorkerReplyV1,
} from '../proofs/index.js';
import { openProofSearchStore } from '../storage/index.js';
import type {
  ProofSearchCheckpointLoadV1,
  ProofSearchStoreV1,
} from '../storage/index.js';
import type { GameNamespaceV1 } from '../storage/types.js';

export interface AdjudicationAnalysisRequestV1 {
  /** Stable controller request token. Query identity binds generation and ownership epoch. */
  readonly requestId: string;
  readonly namespace: GameNamespaceV1;
  readonly query: ProofQuery;
}

export interface AdjudicationAnalysisRunnerOptionsV1 {
  readonly maxDiscoveredStates?: number;
  readonly timeBudgetMs?: number;
  readonly createWorker?: () => ProofSearchWorkerPortV1;
  readonly store?: ProofSearchStoreV1;
  readonly openStore?: () => Promise<ProofSearchStoreV1>;
}

/** Minimal Worker surface used by the browser implementation and deterministic tests. */
export interface ProofSearchWorkerPortV1 {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface AdjudicationAnalysisRunnerV1 {
  continueAnalysis(input: AdjudicationAnalysisRequestV1): Promise<ProofSearchPassResult>;
  stopAnalysis(requestId: string): boolean;
  close(): void;
}

const DEFAULT_MAX_DISCOVERED_STATES = 10_000;
const DEFAULT_TIME_BUDGET_MS = 5_000;

function emptyPass(maxDiscoveredStates: number, timeBudgetMs: number) {
  return {
    maxDiscoveredStates,
    timeBudgetMs,
    discoveredStateCount: 0,
    processedEdgeCount: 0,
    expandedStateCount: 0,
    totalDiscoveredStateCount: 0,
    totalDiscoveredEdgeCount: 0,
    elapsedMs: 0,
  } as const;
}

function nonResult(
  reason: Extract<ProofSearchPassResult, { status: 'non-result' }>['reason'],
  queryIdentity: string,
  maxDiscoveredStates: number,
  timeBudgetMs: number,
  checkpoint: Extract<ProofSearchPassResult, { status: 'non-result' }>['checkpoint'] = null,
  checkpointDisposition: Extract<ProofSearchPassResult, { status: 'non-result' }>['checkpointDisposition'] = 'fresh',
): ProofSearchPassResult {
  return {
    status: 'non-result', reason, queryIdentity, checkpoint, checkpointDisposition,
    pass: emptyPass(maxDiscoveredStates, timeBudgetMs),
  };
}

function validRequest(input: AdjudicationAnalysisRequestV1): boolean {
  return typeof input.requestId === 'string' && input.requestId.length > 0 &&
    typeof input.query.queryIdentity === 'string' &&
    proofQueryIdentity(input.query) === input.query.queryIdentity &&
    (input.namespace.kind === 'guest' ||
      (input.namespace.kind === 'account' && typeof input.namespace.accountId === 'string' && input.namespace.accountId.length > 0));
}

function resultFromReply(
  reply: unknown,
  requestId: string,
  query: ProofQuery,
  maxDiscoveredStates: number,
  timeBudgetMs: number,
): ProofSearchPassResult | null {
  if (typeof reply !== 'object' || reply === null) return null;
  const record = reply as Partial<ProofSearchWorkerReplyV1>;
  if (record.requestId !== requestId) return null;
  if (record.type === 'error') return nonResult('search-error', query.queryIdentity, maxDiscoveredStates, timeBudgetMs);
  if (record.type !== 'result' || !record.result || typeof record.result !== 'object') return null;
  const result = record.result as ProofSearchPassResult;
  if (result.status === 'accepted') {
    if (result.queryIdentity !== query.queryIdentity) return null;
    const checked = checkProofEvidence(query, result.evidence);
    if (checked.status !== 'accepted' || checked.queryIdentity !== query.queryIdentity || checked.conclusion !== result.conclusion) {
      return nonResult('checker-rejected', query.queryIdentity, maxDiscoveredStates, timeBudgetMs);
    }
    return result;
  }
  if (result.status === 'non-result') {
    if (result.queryIdentity !== undefined && result.queryIdentity !== query.queryIdentity) return null;
    if (result.checkpoint !== null) {
      const checkpoint = validateProofSearchCheckpoint(result.checkpoint);
      if (checkpoint.status !== 'valid' || checkpoint.checkpoint.queryIdentity !== query.queryIdentity) {
        return nonResult('invalid-checkpoint', query.queryIdentity, maxDiscoveredStates, timeBudgetMs);
      }
    }
    return { ...result, queryIdentity: query.queryIdentity };
  }
  return null;
}

interface ActiveRequest {
  readonly requestId: string;
  readonly scope: string;
  readonly query: ProofQuery;
  readonly worker: ProofSearchWorkerPortV1;
  readonly resolve: (result: ProofSearchPassResult) => void;
  settled: boolean;
}

/** Runs exactly one bounded proof pass per explicit Continue action. */
export function createAdjudicationAnalysisRunner(
  options: AdjudicationAnalysisRunnerOptionsV1 = {},
): AdjudicationAnalysisRunnerV1 {
  const maxDiscoveredStates = options.maxDiscoveredStates ?? DEFAULT_MAX_DISCOVERED_STATES;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const makeWorker: () => ProofSearchWorkerPortV1 = options.createWorker ??
    (() => createProofSearchWorker() as unknown as ProofSearchWorkerPortV1);
  let storePromise: Promise<ProofSearchStoreV1> | null = options.store ? Promise.resolve(options.store) : null;
  const active = new Map<string, ActiveRequest>();
  const byScope = new Map<string, ActiveRequest>();
  let idleWorker: ProofSearchWorkerPortV1 | null = null;
  let closed = false;

  const getStore = () => {
    storePromise ??= (options.openStore ?? (() => openProofSearchStore()))();
    return storePromise;
  };

  const settle = (request: ActiveRequest, result: ProofSearchPassResult) => {
    if (request.settled) return;
    request.settled = true;
    if (result.status === 'accepted' && !closed && idleWorker === null) {
      // Retain one successful worker so later moves reuse its loaded modules
      // and optimized search code. Stop/errors always terminate the worker.
      idleWorker = request.worker;
      request.worker.onmessage = null;
      const discardIdle = () => {
        if (idleWorker !== request.worker) return;
        idleWorker = null;
        request.worker.terminate();
      };
      request.worker.onerror = discardIdle;
      request.worker.onmessageerror = discardIdle;
    } else {
      request.worker.terminate();
    }
    if (active.get(request.requestId) === request) active.delete(request.requestId);
    if (byScope.get(request.scope) === request) byScope.delete(request.scope);
    request.resolve(result);
  };

  const cancel = (request: ActiveRequest) => {
    if (request.settled) return;
    try { request.worker.postMessage({ type: 'cancel', requestId: request.requestId }); } catch { /* termination is the cancellation boundary */ }
    settle(request, nonResult('cancelled', request.query.queryIdentity, maxDiscoveredStates, timeBudgetMs));
  };

  return {
    continueAnalysis(input) {
      if (closed) return Promise.resolve(nonResult('search-error', input.query.queryIdentity, maxDiscoveredStates, timeBudgetMs));
      let query: ProofQuery;
      let namespace: GameNamespaceV1;
      try {
        query = structuredClone(input.query);
        namespace = structuredClone(input.namespace);
      } catch {
        return Promise.resolve(nonResult('invalid-query', '', maxDiscoveredStates, timeBudgetMs));
      }
      const requestInput = { ...input, namespace, query };
      if (!Number.isSafeInteger(maxDiscoveredStates) || maxDiscoveredStates < 1 || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || !validRequest(requestInput)) {
        return Promise.resolve(nonResult('invalid-query', input.query.queryIdentity, maxDiscoveredStates, timeBudgetMs));
      }
      const scope = JSON.stringify([namespace, query.gameId, query.queryIdentity]);
      const priorId = active.get(input.requestId);
      if (priorId) cancel(priorId);
      const priorScope = byScope.get(scope);
      if (priorScope) cancel(priorScope);

      let worker: ProofSearchWorkerPortV1;
      try {
        worker = idleWorker ?? makeWorker();
        idleWorker = null;
      } catch {
        return Promise.resolve(nonResult('search-error', input.query.queryIdentity, maxDiscoveredStates, timeBudgetMs));
      }

      return new Promise<ProofSearchPassResult>((resolve) => {
        const request: ActiveRequest = {
          requestId: input.requestId, scope, query, worker, resolve, settled: false,
        };
        active.set(input.requestId, request);
        byScope.set(scope, request);

        const stillCurrent = () => !request.settled && !closed &&
          active.get(request.requestId) === request && byScope.get(scope) === request;
        const fail = (reason: 'search-error' | 'invalid-checkpoint') => {
          settle(request, nonResult(reason, query.queryIdentity, maxDiscoveredStates, timeBudgetMs));
        };

        worker.onmessage = (event) => {
          if (!stillCurrent()) return;
          const message = event.data;
          if (typeof message === 'object' && message !== null &&
            'requestId' in message && message.requestId !== input.requestId) return;
          const result = resultFromReply(event.data, input.requestId, query, maxDiscoveredStates, timeBudgetMs);
          if (!result) { fail('search-error'); return; }
          void (async () => {
            if (result.status === 'non-result' && result.checkpoint) {
              try {
                const store = await getStore();
                if (!stillCurrent()) return;
                await store.saveCheckpoint({ namespace, checkpoint: result.checkpoint });
              } catch {
                if (stillCurrent()) fail('search-error');
                return;
              }
            }
            if (stillCurrent()) settle(request, result);
          })();
        };
        worker.onerror = () => { if (stillCurrent()) fail('search-error'); };
        worker.onmessageerror = () => { if (stillCurrent()) fail('search-error'); };

        void (async () => {
          let loaded: ProofSearchCheckpointLoadV1;
          try {
            loaded = await (await getStore()).loadCheckpoint({
              namespace,
              gameId: query.gameId,
              queryIdentity: query.queryIdentity,
            });
          } catch {
            if (stillCurrent()) fail('search-error');
            return;
          }
          if (!stillCurrent()) return;
          const checkpoint = loaded.status === 'found'
            ? loaded.checkpoint
            : loaded.status === 'restart-required' ? {} : undefined;
          try {
            worker.postMessage({
              type: checkpoint !== undefined ? 'resume' : 'start',
              requestId: input.requestId,
              query,
              ...(checkpoint !== undefined ? { checkpoint } : {}),
              maxDiscoveredStates,
              timeBudgetMs,
            });
          } catch {
            if (stillCurrent()) fail('search-error');
          }
        })();
      });
    },

    stopAnalysis(requestId) {
      const request = active.get(requestId);
      if (!request) return false;
      cancel(request);
      return true;
    },

    close() {
      if (closed) return;
      closed = true;
      for (const request of [...active.values()]) cancel(request);
      idleWorker?.terminate();
      idleWorker = null;
      if (!options.store) void storePromise?.then((store) => store.close()).catch(() => undefined);
    },
  };
}
