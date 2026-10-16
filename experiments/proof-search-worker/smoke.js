import { createDeadnessQuery } from '/src/proofs/queries.ts';
import { createProofSearchWorker } from '/src/proofs/search/worker.ts';
import { openProofSearchStore } from '/src/storage/proof-search.ts';

// Run through Vite in a real browser. No provider, account, or network API is used.
export async function runProofSearchSmoke() {
  const worker = createProofSearchWorker();
  const pending = new Map();
  worker.onmessage = ({ data }) => pending.get(data.requestId)?.(data);
  const exchange = (request, cancel = false) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.requestId);
      reject(new Error(`Worker timed out: ${request.requestId}`));
    }, 20_000);
    pending.set(request.requestId, (reply) => {
      clearTimeout(timer);
      pending.delete(request.requestId);
      if (reply.type !== 'result') reject(new Error(JSON.stringify(reply)));
      else resolve(reply.result);
    });
    worker.postMessage(request);
    if (cancel) worker.postMessage({ type: 'cancel', requestId: request.requestId });
  });
  const query = createDeadnessQuery({
    gameId: 'browser-smoke', segmentId: '1', positionRevision: '1',
    analysisGeneration: '1', ownershipEpoch: '1',
    positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
  });
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const databaseName = `kha31-smoke-${crypto.randomUUID()}`;
  let store;
  try {
    const first = await exchange({ type: 'start', requestId: 'partial', query, maxDiscoveredStates: 1 });
    assert(first.status === 'non-result' && first.reason === 'state-budget' && first.checkpoint,
      'Partial search must remain unknown with a checkpoint.');
    store = await openProofSearchStore({ databaseName });
    const namespace = { kind: 'guest' };
    await store.saveCheckpoint({ namespace, checkpoint: first.checkpoint });
    store.close();
    store = await openProofSearchStore({ databaseName });
    const loaded = await store.loadCheckpoint({ namespace, gameId: query.gameId, queryIdentity: query.queryIdentity });
    assert(loaded.status === 'found', 'Checkpoint must survive database reopen.');
    const resumed = await exchange({ type: 'resume', requestId: 'resume', query, checkpoint: loaded.checkpoint });
    assert(resumed.status === 'accepted' && resumed.conclusion === 'dead' &&
      resumed.checkpointDisposition === 'resumed' && resumed.pass.totalDiscoveredStateCount === 4 &&
      resumed.pass.totalDiscoveredEdgeCount === 4, 'Resume must check the four-state closure.');
    const largeQuery = createDeadnessQuery({ ...query,
      positionFen: 'kb6/b1p2p1p/1pP5/1P6/8/8/5P1P/5K2 w - - 0 1',
    });
    const cancelled = await exchange({ type: 'start', requestId: 'cancel', query: largeQuery }, true);
    assert(cancelled.status === 'non-result' && cancelled.reason === 'cancelled' && cancelled.checkpoint,
      'Cancellation must retain progress without a verdict.');
    return { passed: true, userAgent: navigator.userAgent, origin: location.origin,
      partial: first.reason, durableCheckpoint: loaded.status,
      resumed: { conclusion: resumed.conclusion, states: 4, edges: 4 }, cancelled: cancelled.reason };
  } finally {
    worker.terminate();
    store?.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Smoke database cleanup blocked.'));
    });
  }
}
