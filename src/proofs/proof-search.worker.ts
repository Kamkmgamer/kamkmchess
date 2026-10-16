import { runProofSearchPass } from './search/search.js';
import type { ProofSearchWorkerReplyV1, ProofSearchWorkerRequestV1 } from './search/worker.js';

interface ProofSearchWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: ProofSearchWorkerReplyV1): void;
}

function ownDataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function requestFrom(value: unknown): ProofSearchWorkerRequestV1 | null {
  const request = ownDataRecord(value);
  if (!request || typeof request.requestId !== 'string' || request.requestId.length === 0) return null;
  if (request.type === 'cancel') {
    return Object.keys(request).length === 2 ? { type: 'cancel', requestId: request.requestId } : null;
  }
  if (request.type !== 'start' && request.type !== 'resume') return null;
  const expectedKeys = request.type === 'start'
    ? ['type', 'requestId', 'query', 'maxDiscoveredStates', 'timeBudgetMs']
    : ['type', 'requestId', 'query', 'checkpoint', 'maxDiscoveredStates', 'timeBudgetMs'];
  if (Object.keys(request).some((key) => !expectedKeys.includes(key)) || !Object.hasOwn(request, 'query')) return null;
  if (request.type === 'resume' && !Object.hasOwn(request, 'checkpoint')) return null;
  if (
    (request.maxDiscoveredStates !== undefined && !Number.isSafeInteger(request.maxDiscoveredStates)) ||
    (request.timeBudgetMs !== undefined && !Number.isFinite(request.timeBudgetMs))
  ) return null;
  return request as unknown as ProofSearchWorkerRequestV1;
}

const scope = self as unknown as ProofSearchWorkerScope;
const activeControllers = new Map<string, AbortController>();

scope.addEventListener('message', (event) => {
  const request = requestFrom(event.data);
  if (!request) {
    const record = ownDataRecord(event.data);
    const requestId = typeof record?.requestId === 'string' ? record.requestId : 'unknown';
    scope.postMessage({ type: 'error', requestId, reason: 'invalid-message' });
    return;
  }
  if (request.type === 'cancel') {
    activeControllers.get(request.requestId)?.abort();
    return;
  }

  activeControllers.get(request.requestId)?.abort();
  const controller = new AbortController();
  activeControllers.set(request.requestId, controller);
  void (async () => {
    try {
      const result = await runProofSearchPass(request.query, {
        ...(request.type === 'resume' ? { checkpoint: request.checkpoint } : {}),
        ...(request.maxDiscoveredStates === undefined ? {} : { maxDiscoveredStates: request.maxDiscoveredStates }),
        ...(request.timeBudgetMs === undefined ? {} : { timeBudgetMs: request.timeBudgetMs }),
        signal: controller.signal,
      });
      if (activeControllers.get(request.requestId) === controller) {
        scope.postMessage({ type: 'result', requestId: request.requestId, result });
      }
    } catch {
      if (activeControllers.get(request.requestId) === controller) {
        scope.postMessage({ type: 'error', requestId: request.requestId, reason: 'search-error' });
      }
    } finally {
      if (activeControllers.get(request.requestId) === controller) activeControllers.delete(request.requestId);
    }
  })();
});
