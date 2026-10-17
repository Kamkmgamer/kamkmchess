import { describe, expect, it, vi } from 'vitest';
import { createDeadnessQuery, runProofSearchPass } from '../proofs/index.js';
import type { ProofSearchPassResult, ProofSearchWorkerReplyV1 } from '../proofs/index.js';
import type { ProofSearchCheckpointLoadV1, ProofSearchStoreV1 } from '../storage/proof-search.js';
import type { GameNamespaceV1 } from '../storage/types.js';
import { createAdjudicationAnalysisRunner } from './analysis-runner.js';
import type { ProofSearchWorkerPortV1 } from './analysis-runner.js';

const namespace: GameNamespaceV1 = { kind: 'guest' };
const query = createDeadnessQuery({
  gameId: 'runner-game', segmentId: 'segment-1', positionRevision: '3',
  analysisGeneration: '8', ownershipEpoch: '2',
  positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
});

class FakeWorker implements ProofSearchWorkerPortV1 {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  postMessage(message: unknown) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  reply(data: unknown) { this.onmessage?.({ data } as MessageEvent<unknown>); }
}

function memoryStore(initial: ProofSearchCheckpointLoadV1 = { status: 'missing' }) {
  const saved: unknown[] = [];
  const store: ProofSearchStoreV1 = {
    loadCheckpoint: vi.fn(async () => initial),
    saveCheckpoint: vi.fn(async (input) => {
      saved.push(input);
      return { status: 'saved' as const, checkpointKey: 'key', chunkCount: 1 };
    }),
    deleteCheckpoint: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  return { store, saved };
}

function workerRequest(worker: FakeWorker) {
  return worker.posted[0] as { type: string; requestId: string; checkpoint?: unknown };
}

describe('bounded adjudication analysis runner', () => {
  it('starts one bounded pass and persists its resumable non-result', async () => {
    const worker = new FakeWorker();
    const { store, saved } = memoryStore();
    const runner = createAdjudicationAnalysisRunner({
      createWorker: () => worker, store, maxDiscoveredStates: 7, timeBudgetMs: 90,
    });
    const pending = runner.continueAnalysis({ requestId: 'continue-1', namespace, query });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    expect(workerRequest(worker)).toMatchObject({ type: 'start', maxDiscoveredStates: 7, timeBudgetMs: 90 });

    const partial = await runProofSearchPass(query, { maxDiscoveredStates: 1 });
    expect(partial.status).toBe('non-result');
    worker.reply({ type: 'result', requestId: 'continue-1', result: partial });
    await expect(pending).resolves.toMatchObject({ status: 'non-result', queryIdentity: query.queryIdentity });
    expect(saved).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it('resumes a compatible saved checkpoint and explicitly restarts an incompatible one', async () => {
    const partial = await runProofSearchPass(query, { maxDiscoveredStates: 1 });
    if (partial.status !== 'non-result' || !partial.checkpoint) throw new Error('Fixture should produce a checkpoint.');
    const resumeWorker = new FakeWorker();
    const resumed = createAdjudicationAnalysisRunner({
      createWorker: () => resumeWorker,
      store: memoryStore({ status: 'found', checkpoint: partial.checkpoint }).store,
    });
    const resumePending = resumed.continueAnalysis({ requestId: 'continue-resume', namespace, query });
    await vi.waitFor(() => expect(resumeWorker.posted).toHaveLength(1));
    expect(workerRequest(resumeWorker)).toMatchObject({ type: 'resume', checkpoint: partial.checkpoint });
    resumeWorker.reply({
      type: 'result', requestId: 'continue-resume',
      result: { ...partial, checkpointDisposition: 'resumed' },
    } satisfies ProofSearchWorkerReplyV1);
    await resumePending;

    const corruptWorker = new FakeWorker();
    const corruptRunner = createAdjudicationAnalysisRunner({
      createWorker: () => corruptWorker,
      store: memoryStore({ status: 'restart-required', reason: 'corrupt-checkpoint' }).store,
    });
    const restartPending = corruptRunner.continueAnalysis({ requestId: 'continue-restart', namespace, query });
    await vi.waitFor(() => expect(corruptWorker.posted).toHaveLength(1));
    expect(workerRequest(corruptWorker)).toMatchObject({ type: 'resume', checkpoint: {} });
    corruptWorker.reply({
      type: 'result', requestId: 'continue-restart',
      result: { ...partial, checkpointDisposition: 'restarted', reason: 'invalid-checkpoint' },
    } satisfies ProofSearchWorkerReplyV1);
    await restartPending;
  });

  it('cancels and terminates the worker, ignoring a late positive reply', async () => {
    const worker = new FakeWorker();
    const runner = createAdjudicationAnalysisRunner({ createWorker: () => worker, store: memoryStore().store });
    const pending = runner.continueAnalysis({ requestId: 'cancel-me', namespace, query });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    expect(runner.stopAnalysis('cancel-me')).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'non-result', reason: 'cancelled' });
    expect(worker.terminated).toBe(true);

    const accepted = await runProofSearchPass(query);
    expect(accepted.status).toBe('accepted');
    worker.reply({ type: 'result', requestId: 'cancel-me', result: accepted });
    expect(runner.stopAnalysis('cancel-me')).toBe(false);
  });

  it('rechecks worker evidence and turns forged or mismatched results into safe non-results', async () => {
    const worker = new FakeWorker();
    const runner = createAdjudicationAnalysisRunner({ createWorker: () => worker, store: memoryStore().store });
    const pending = runner.continueAnalysis({ requestId: 'forged', namespace, query });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const forged = {
      status: 'accepted', conclusion: 'dead', queryIdentity: query.queryIdentity,
      evidence: {}, checkpointDisposition: 'fresh', pass: {},
    } as unknown as ProofSearchPassResult;
    worker.reply({ type: 'result', requestId: 'forged', result: forged });
    await expect(pending).resolves.toMatchObject({ status: 'non-result', reason: 'checker-rejected' });
  });

  it('returns valid checked evidence for the controller to check again', async () => {
    const worker = new FakeWorker();
    const runner = createAdjudicationAnalysisRunner({ createWorker: () => worker, store: memoryStore().store });
    const pending = runner.continueAnalysis({ requestId: 'checked', namespace, query });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const accepted = await runProofSearchPass(query);
    expect(accepted.status).toBe('accepted');
    worker.reply({ type: 'result', requestId: 'checked', result: accepted });
    await expect(pending).resolves.toMatchObject({ status: 'accepted', conclusion: 'dead' });
    expect(worker.terminated).toBe(true);
  });

  it('ignores replies with a different transport request ID', async () => {
    const worker = new FakeWorker();
    const runner = createAdjudicationAnalysisRunner({ createWorker: () => worker, store: memoryStore().store });
    const pending = runner.continueAnalysis({ requestId: 'expected', namespace, query });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    worker.reply({ type: 'error', requestId: 'stale', reason: 'search-error' });
    expect(runner.stopAnalysis('expected')).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'non-result', reason: 'cancelled' });
  });
});
