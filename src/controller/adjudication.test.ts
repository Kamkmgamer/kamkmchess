import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { runProofSearchPass } from '../proofs/index.js';
import type { ProofSearchPassResult } from '../proofs/index.js';
import type { CoordinateMove } from '../rules/index.js';
import { openGameStore } from '../storage/index.js';
import { getOrCreateGameController } from './index.js';
import type { AdjudicationWorkV1, ModelSelection } from './index.js';

const model: ModelSelection = {
  kind: 'model', providerId: 'fixture', connectionId: 'local', configurationRevision: 0,
  modelRoutingId: 'fixture', protocol: 'chat-completions', diagnostic: 'passed-current-session',
};
const queenPosition = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';

function witness(work: AdjudicationWorkV1, moves: CoordinateMove[]): ProofSearchPassResult {
  return {
    status: 'accepted', conclusion: work.query.predicate === 'global-deadness' ? 'not-dead' : 'opponent-can-mate',
    queryIdentity: work.query.queryIdentity, checkpointDisposition: 'fresh',
    evidence: {
      kind: 'mate-witness', schemaVersion: 1, proofCheckerVersion: work.query.proofCheckerVersion,
      rulesAdapterVersion: work.query.rulesAdapterVersion, queryIdentity: work.query.queryIdentity,
      intendedColor: 'w', moves,
    },
    pass: {
      maxDiscoveredStates: 10, timeBudgetMs: 5000, discoveredStateCount: 0, processedEdgeCount: 0,
      expandedStateCount: 0, totalDiscoveredStateCount: 0, totalDiscoveredEdgeCount: 0, elapsedMs: 0,
    },
  };
}

async function playableFixture(gameId: string) {
  let wall = 1000;
  let monotonic = 0;
  let id = 0;
  const store = await openGameStore({ databaseName: gameId, factory: new IDBFactory(), now: () => wall });
  const controller = getOrCreateGameController({
    gameId, store, clockPolicy: { maxReferenceDivergenceMs: 5 },
    timeSource: { sample: (at = wall) => ({ monotonicMs: monotonic, wallTimeMs: at }) },
    idFactory: () => `${gameId}-${++id}`,
  });
  await controller.initialize({
    humanSide: 'white', modelSelection: { ...model, diagnostic: 'not-run' },
    namespace: { kind: 'guest' }, ownershipEpoch: 0, startingFen: queenPosition,
    timeControl: { startingTimeMs: 100, incrementMs: 0 },
  });
  const work = await controller.continueAdjudication(controller.snapshot().fence);
  if (!work) throw new Error('Setup analysis not authorized.');
  await controller.acceptAdjudicationResult({ ...work, result: witness(work, [{ from: 'f7', to: 'g7' }]) });
  await controller.startGame(controller.snapshot().fence, model);
  return { store, controller, at: (time: number) => { wall = time; monotonic = time - 1000; } };
}

describe('original adjudication event ordering', () => {
  it('ADJ-07 resolves earlier non-deadness before the original later timeout and rejects the pre-expiry proof', async () => {
    const { controller, store, at } = await playableFixture('adj-event-order');
    try {
      at(1010);
      const moved = await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: controller.snapshot().fence,
        move: { from: 'f7', to: 'e7' } });
      expect(moved.kind).toBe('accepted');
      expect(moved.snapshot.clockReading?.status).toBe('running');
      expect(moved.snapshot.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', eventAtMs: 1010 });
      const old = await controller.continueAdjudication(moved.snapshot.fence);
      if (!old) throw new Error('Position analysis not authorized.');
      const moves: CoordinateMove[] = [{ from: 'h8', to: 'g8' }, { from: 'e7', to: 'e8' }];
      at(1200);
      const expired = await controller.reconcile();
      expect(expired.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position', eventAtMs: 1010 });
      const afterStale = await controller.acceptAdjudicationResult({ ...old, result: witness(old, moves) });
      expect(afterStale.checkpoint.revision).toBe(expired.checkpoint.revision);
      const earlier = await controller.continueAdjudication(afterStale.fence);
      if (!earlier) throw new Error('Earlier candidate was lost at expiry.');
      expect(earlier.query.predicate).toBe('global-deadness');
      const pendingFlag = await controller.acceptAdjudicationResult({ ...earlier, result: witness(earlier, moves) });
      expect(pendingFlag.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'timeout', eventAtMs: 1110 });
      const flag = await controller.continueAdjudication(pendingFlag.fence);
      if (!flag) throw new Error('Timeout analysis not authorized.');
      expect(flag.query).toMatchObject({ predicate: 'timeout-opponent-mating', expiredColor: 'b' });
      const final = await controller.acceptAdjudicationResult({ ...flag, result: witness(flag, moves) });
      expect(final.checkpoint.result).toMatchObject({ kind: 'final', winner: 'white', reason: 'timeout', decidedAtMs: 1110 });
      const saved = await store.readGame(final.checkpoint.gameId);
      expect(saved?.events.find((event) => event.kind === 'timeout-candidate')?.occurredAtMs).toBe(1110);
      expect(saved?.checkpoint.result).toEqual(final.checkpoint.result);
      expect((await controller.acceptAdjudicationResult({ ...old, result: witness(old, moves) })).checkpoint.result)
        .toEqual(final.checkpoint.result);
    } finally { store.close(); }
  });

  it('ADJ-08 a non-expiring reconciliation leaves pending analysis explicitly continuable', async () => {
    const { controller, store, at } = await playableFixture('adj-reconcile-resume');
    try {
      at(1010);
      await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: controller.snapshot().fence,
        move: { from: 'f7', to: 'e7' } });
      const old = await controller.continueAdjudication(controller.snapshot().fence);
      if (!old) throw new Error('Position analysis not authorized.');
      at(1020);
      await controller.reconcile();
      const next = await controller.continueAdjudication(controller.snapshot().fence);
      expect(next).not.toBeNull();
      expect(next?.query.analysisGeneration).toBe(String(next?.fence.analysisGeneration));
    } finally { store.close(); }
  });

  it('ADJ-07 classifies a restored legacy position before its later flag', async () => {
    const gameId = 'adj-earlier-deadness';
    let now = 1000;
    let id = 0;
    const store = await openGameStore({ databaseName: gameId, factory: new IDBFactory(), now: () => now });
    const timeSource = { sample: (at = now) => ({ monotonicMs: now - 1000, wallTimeMs: at }) };
    const options = { gameId, store, timeSource, clockPolicy: { maxReferenceDivergenceMs: 5 },
      idFactory: () => `${gameId}-${++id}` };
    const original = getOrCreateGameController(options);
    try {
      const initial = await original.initialize({
        humanSide: 'white', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
        startingFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
        timeControl: { startingTimeMs: 100, incrementMs: 0 },
      });
      // KHA-29 active saves predate mandatory classification. Exercise that restore path
      // without inventing an accepted proof marker in a KHA-32 extension.
      await store.commitCheckpoint({
        gameId, expectedRevision: initial.checkpoint.revision, expectedEpoch: 0,
        events: [], chunks: [], knownCredentials: [],
        decide: () => ({ checkpoint: {
          ...initial.checkpoint, revision: initial.checkpoint.revision + 1,
          extensions: {}, result: { kind: 'unresolved' },
          clocks: { ...initial.checkpoint.clocks, activeSide: 'white',
            anchor: { monotonicMs: 0, wallTimeMs: 1000 }, lastReconciledAtMs: 1000 },
        }, outboxOperationIds: [] }),
      });
      vi.resetModules();
      const restoredModule = await import('./index.js');
      const controller = restoredModule.getOrCreateGameController(options);
      await controller.initialize();
      expect(controller.snapshot().checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position' });
      await controller.reconcile();
      expect(await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: controller.snapshot().fence,
        move: { from: 'h1', to: 'g1' } })).toMatchObject({ kind: 'rejected', reason: 'not-actionable' });
      now = 1200;
      await controller.reconcile();
      const work = await controller.continueAdjudication(controller.snapshot().fence);
      if (!work) throw new Error('Earlier deadness candidate was lost.');
      const result = await runProofSearchPass(work.query, { maxDiscoveredStates: 10, timeBudgetMs: 5000 });
      expect(result).toMatchObject({ status: 'accepted', conclusion: 'dead' });
      const final = await controller.acceptAdjudicationResult({ ...work, result });
      expect(final.checkpoint.result).toMatchObject({ kind: 'final', winner: 'draw', reason: 'dead-position', decidedAtMs: 1000 });
      const saved = await store.readGame(gameId);
      expect(saved?.events.find((event) => event.kind === 'timeout-adjudication-candidate-created')?.occurredAtMs).toBe(1100);
    } finally { store.close(); }
  });
});
