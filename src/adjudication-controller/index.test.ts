import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { AdjudicationAnalysisRunnerV1 } from '../adjudication/index.js';
import { getOrCreateGameController } from '../controller/index.js';
import type { ModelSelection } from '../controller/index.js';
import { runProofSearchPass } from '../proofs/index.js';
import type { ProofSearchPassResult } from '../proofs/index.js';
import { openGameStore } from '../storage/index.js';
import { createControllerAnalysis } from './index.js';

const wall = 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1';
const model: ModelSelection = {
  kind: 'model', providerId: 'fixture', connectionId: 'local', configurationRevision: 1,
  modelRoutingId: 'fixture', protocol: 'chat-completions', diagnostic: 'not-run',
};

async function fixture(gameId: string) {
  const store = await openGameStore({ databaseName: gameId, factory: new IDBFactory(), now: () => 1000 });
  let id = 0;
  const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
    gameId, store, clockPolicy: { maxReferenceDivergenceMs: 10 },
    timeSource: { sample: (at = 1000) => ({ monotonicMs: 100, wallTimeMs: at }) },
    idFactory: () => `${gameId}-${++id}`,
  });
  await controller.initialize({
    humanSide: 'white', modelSelection: model, namespace: { kind: 'guest' },
    ownershipEpoch: 0, startingFen: wall,
  });
  return { controller, store };
}

describe('controller and analysis composition', () => {
  it('surfaces execution failure after returning the check to a retryable state', async () => {
    const { controller, store } = await fixture('analysis-composition-worker-recovery');
    let unavailable = true;
    const runner: AdjudicationAnalysisRunnerV1 = {
      continueAnalysis: vi.fn<AdjudicationAnalysisRunnerV1['continueAnalysis']>(async ({ query }) => {
        if (!unavailable) return runProofSearchPass(query);
        unavailable = false;
        return {
          status: 'non-result', reason: 'search-error', queryIdentity: query.queryIdentity,
          checkpoint: null, checkpointDisposition: 'fresh',
          pass: { maxDiscoveredStates: 10000, timeBudgetMs: 5000, discoveredStateCount: 0,
            processedEdgeCount: 0, expandedStateCount: 0, totalDiscoveredStateCount: 0,
            totalDiscoveredEdgeCount: 0, elapsedMs: 0 },
        };
      }),
      stopAnalysis: vi.fn(() => true), close: vi.fn(),
    };
    const analysis = createControllerAnalysis(controller, runner);
    try {
      await expect(analysis.continueAnalysis(controller.snapshot().fence)).rejects.toThrow('The position check could not run');
      expect(controller.snapshot().adjudication.status).toBe('queued');
      expect(controller.snapshot().checkpoint.result.kind).toBe('pending-adjudication');
      const recovered = await analysis.continueAnalysis(controller.snapshot().fence);
      expect(recovered.checkpoint.result).toMatchObject({ kind: 'final', winner: 'draw', reason: 'dead-position' });
    } finally { await analysis.close(); store.close(); }
  });

  it('ADJ-06 routes an explicitly authorized checked closure into the saved final latch', async () => {
    const { controller, store } = await fixture('analysis-composition-final');
    const runner: AdjudicationAnalysisRunnerV1 = {
      continueAnalysis: vi.fn(({ query }) => runProofSearchPass(query, { maxDiscoveredStates: 10, timeBudgetMs: 5000 })),
      stopAnalysis: vi.fn(() => true), close: vi.fn(),
    };
    const analysis = createControllerAnalysis(controller, runner);
    try {
      expect(controller.snapshot().checkpoint.clocks.activeSide).toBeNull();
      const snapshot = await analysis.continueAnalysis(controller.snapshot().fence);
      expect(snapshot.checkpoint.result).toMatchObject({ kind: 'final', winner: 'draw', reason: 'dead-position' });
      expect((await store.readGame(snapshot.checkpoint.gameId))?.checkpoint.result).toEqual(snapshot.checkpoint.result);
      expect(runner.continueAnalysis).toHaveBeenCalledTimes(1);
      const finalResult = snapshot.checkpoint.result;
      await analysis.continueAnalysis(snapshot.fence);
      expect(controller.snapshot().checkpoint.result).toEqual(finalResult);
      expect(runner.continueAnalysis).toHaveBeenCalledTimes(1);
    } finally { await analysis.close(); store.close(); }
  });

  it('ADJ-07 Stop fences an already produced proof before its late delivery', async () => {
    const { controller, store } = await fixture('analysis-composition-stop');
    let deliver: ((result: ProofSearchPassResult) => void) | undefined;
    let proof: ProofSearchPassResult | undefined;
    const runner: AdjudicationAnalysisRunnerV1 = {
      continueAnalysis: vi.fn(async ({ query }) => {
        proof = await runProofSearchPass(query, { maxDiscoveredStates: 10, timeBudgetMs: 5000 });
        return new Promise<ProofSearchPassResult>((resolve) => { deliver = resolve; });
      }),
      stopAnalysis: vi.fn(() => true), close: vi.fn(),
    };
    const analysis = createControllerAnalysis(controller, runner);
    try {
      const pending = analysis.continueAnalysis(controller.snapshot().fence);
      await vi.waitFor(() => expect(deliver).toBeDefined());
      const stopped = await analysis.stopAnalysis(controller.snapshot().fence);
      expect(runner.stopAnalysis).toHaveBeenCalledTimes(1);
      if (!deliver || !proof) throw new Error('The independent proof fixture did not complete.');
      deliver(proof);
      await pending;
      expect(controller.snapshot().checkpoint.result.kind).toBe('pending-adjudication');
      expect(controller.snapshot().checkpoint.revision).toBe(stopped.checkpoint.revision);
    } finally { await analysis.close(); store.close(); }
  });

  it('ADJ-08 closing composition cancels execution and suppresses late settlement', async () => {
    const { controller, store } = await fixture('analysis-composition-close');
    let deliver: ((result: ProofSearchPassResult) => void) | undefined;
    let proof: ProofSearchPassResult | undefined;
    const runner: AdjudicationAnalysisRunnerV1 = {
      continueAnalysis: vi.fn(async ({ query }) => {
        proof = await runProofSearchPass(query, { maxDiscoveredStates: 10, timeBudgetMs: 5000 });
        return new Promise<ProofSearchPassResult>((resolve) => { deliver = resolve; });
      }),
      stopAnalysis: vi.fn(() => true), close: vi.fn(),
    };
    const analysis = createControllerAnalysis(controller, runner);
    try {
      const pending = analysis.continueAnalysis(controller.snapshot().fence);
      await vi.waitFor(() => expect(deliver).toBeDefined());
      await analysis.close();
      const revision = controller.snapshot().checkpoint.revision;
      if (!deliver || !proof) throw new Error('The independent proof fixture did not complete.');
      deliver(proof);
      await pending;
      expect(runner.close).toHaveBeenCalledTimes(1);
      expect(runner.stopAnalysis).toHaveBeenCalledTimes(1);
      expect(controller.snapshot().checkpoint.revision).toBe(revision);
      expect(controller.snapshot().checkpoint.result.kind).toBe('pending-adjudication');
    } finally { await analysis.close(); store.close(); }
  });

  it('a stale Stop does not cancel the current authorized analysis', async () => {
    const { controller, store } = await fixture('analysis-composition-stale-stop');
    let deliver: ((result: ProofSearchPassResult) => void) | undefined;
    let proof: ProofSearchPassResult | undefined;
    const runner: AdjudicationAnalysisRunnerV1 = {
      continueAnalysis: vi.fn(async ({ query }) => {
        proof = await runProofSearchPass(query, { maxDiscoveredStates: 10, timeBudgetMs: 5000 });
        return new Promise<ProofSearchPassResult>((resolve) => { deliver = resolve; });
      }),
      stopAnalysis: vi.fn(() => true), close: vi.fn(),
    };
    const analysis = createControllerAnalysis(controller, runner);
    try {
      const oldFence = controller.snapshot().fence;
      const pending = analysis.continueAnalysis(oldFence);
      await vi.waitFor(() => expect(deliver).toBeDefined());
      await analysis.stopAnalysis(oldFence);
      expect(runner.stopAnalysis).not.toHaveBeenCalled();
      if (!deliver || !proof) throw new Error('The independent proof fixture did not complete.');
      deliver(proof);
      expect((await pending).checkpoint.result).toMatchObject({ kind: 'final', reason: 'dead-position' });
    } finally { await analysis.close(); store.close(); }
  });
});
