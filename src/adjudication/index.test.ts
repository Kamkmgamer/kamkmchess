import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createDeadnessQuery, runProofSearchPass } from '../proofs/index.js';
import type { ProofSearchPassResult, ProofSearchWorkerReplyV1, ProofSearchWorkerRequestV1 } from '../proofs/index.js';
import { openProofSearchStore } from '../storage/index.js';
import type { GameNamespaceV1 } from '../storage/index.js';
import { createProofAdjudicationRunner } from './index.js';
import type { ProofSearchWorkerPortV1 } from './index.js';

const namespace: GameNamespaceV1 = { kind: 'guest' };
const query = createDeadnessQuery({
  gameId: 'adjudication-runner-test',
  segmentId: 'segment-1',
  positionRevision: '0',
  analysisGeneration: '1',
  ownershipEpoch: '0',
  positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
});

class ScriptedWorker implements ProofSearchWorkerPortV1 {
  onmessage: ((event: MessageEvent<ProofSearchWorkerReplyV1>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly requests: ProofSearchWorkerRequestV1[] = [];

  constructor(private readonly reply: (request: ProofSearchWorkerRequestV1) => ProofSearchPassResult) {}

  postMessage(request: ProofSearchWorkerRequestV1): void {
    this.requests.push(request);
    if (request.type === 'cancel') return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: { type: 'result', requestId: request.requestId, result: this.reply(request) },
      } as MessageEvent<ProofSearchWorkerReplyV1>);
    });
  }

  terminate(): void {}
}

describe('proof adjudication runner', () => {
  it('loads and saves versioned checkpoints through the public proof store before resuming', async () => {
    const partial = await runProofSearchPass(query, { maxDiscoveredStates: 1, timeBudgetMs: 5_000 });
    expect(partial.status).toBe('non-result');
    if (partial.status !== 'non-result' || partial.checkpoint === null) {
      throw new Error('The finite graph fixture did not produce a resumable checkpoint.');
    }

    const databaseName = 'adjudication-runner-checkpoint';
    const factory = new IDBFactory();
    const requests: ProofSearchWorkerRequestV1[] = [];
    const stores = [0, 1];
    const runner = createProofAdjudicationRunner({
      createWorker: () => new ScriptedWorker((request) => {
        requests.push(request);
        return {
          ...partial,
          checkpointDisposition: request.type === 'resume' ? 'resumed' : 'fresh',
        };
      }),
      openCheckpointStore: () => {
        stores.shift();
        return openProofSearchStore({ databaseName, factory });
      },
    });

    const first = await runner.runPass({ namespace, query });
    expect(first.status).toBe('non-result');
    expect(requests[0]?.type).toBe('start');

    const second = await runner.runPass({ namespace, query });
    expect(second.status).toBe('non-result');
    expect(requests[1]?.type).toBe('resume');
    if (requests[1]?.type !== 'resume') throw new Error('The saved proof checkpoint was not resumed.');
    expect(requests[1].checkpoint).toMatchObject({ queryIdentity: query.queryIdentity });
    expect(stores).toHaveLength(0);
  });

  it('does not accept a Worker result for a different query identity', async () => {
    const validNonResult = await runProofSearchPass(query, { maxDiscoveredStates: 1 });
    if (validNonResult.status !== 'non-result') throw new Error('Expected a bounded non-result.');
    const runner = createProofAdjudicationRunner({
      createWorker: () => new ScriptedWorker(() => ({
        ...validNonResult,
        queryIdentity: 'proof-query:some-other-query',
      })),
      openCheckpointStore: () => openProofSearchStore({ factory: new IDBFactory() }),
    });

    const result = await runner.runPass({ namespace, query });

    expect(result).toMatchObject({ status: 'non-result', reason: 'invalid-query' });
  });
});

