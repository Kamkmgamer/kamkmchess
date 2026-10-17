import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import researchedPositiveWitnessesRaw from '../proofs/fixtures/researched-positive-witnesses.json?raw';
import { openGameStore } from '../storage/index.js';
import type { ProofAdjudicationPassInputV1, ProofAdjudicationRunnerV1 } from '../adjudication/index.js';
import {
  checkProofEvidence,
  PROOF_CHECKER_VERSION,
  PROOF_SCHEMA_VERSION,
  RULES_ADAPTER_VERSION,
  runProofSearchPass,
} from '../proofs/index.js';
import type { ProofEvidence, ProofQuery, ProofSearchPassResult } from '../proofs/index.js';
import { getOrCreateGameController } from './index.js';
import type { ControllerTimeSource, ModelSelection } from './index.js';
import type { CoordinateMove } from '../rules/index.js';
import { initializeLegacyActiveGame, seedLegacyActiveGame } from './controller-test-support.js';

interface PositiveWitnessFixture {
  readonly fen: string;
  readonly intendedColor: 'w' | 'b';
  readonly moves: readonly string[];
}

const researchedPositiveWitnesses = JSON.parse(researchedPositiveWitnessesRaw) as Record<string, PositiveWitnessFixture>;

const model: ModelSelection = {
  kind: 'model',
  providerId: 'openrouter',
  connectionId: 'connection-adjudication-test',
  configurationRevision: 1,
  modelRoutingId: 'test/model',
  protocol: 'chat-completions',
  diagnostic: 'passed-current-session',
};

class ControlledAdjudicationRunner implements ProofAdjudicationRunnerV1 {
  readonly calls: Array<{
    input: ProofAdjudicationPassInputV1;
    resolve: (result: ProofSearchPassResult) => void;
  }> = [];

  runPass(input: ProofAdjudicationPassInputV1): Promise<ProofSearchPassResult> {
    return new Promise((resolve) => this.calls.push({ input, resolve }));
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('The controller did not reach the expected public state.');
}

function checkedNotDeadPass(query: ProofQuery): ProofSearchPassResult {
  const evidence: ProofEvidence = {
    schemaVersion: PROOF_SCHEMA_VERSION,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    kind: 'mate-witness',
    queryIdentity: query.queryIdentity,
    intendedColor: 'w',
    moves: [{ from: 'd6', to: 'f7' }],
  };
  const checked = checkProofEvidence(query, evidence);
  if (checked.status !== 'accepted' || checked.conclusion !== 'not-dead') {
    throw new Error('The independent checker rejected the known one-move mate witness.');
  }
  return {
    status: 'accepted',
    conclusion: checked.conclusion,
    queryIdentity: query.queryIdentity,
    evidence,
    checkpointDisposition: 'fresh',
    pass: {
      maxDiscoveredStates: 10_000,
      timeBudgetMs: 5_000,
      discoveredStateCount: 1,
      processedEdgeCount: 1,
      expandedStateCount: 1,
      totalDiscoveredStateCount: 1,
      totalDiscoveredEdgeCount: 1,
      elapsedMs: 1,
    },
  };
}

function unknownPass(query: ProofQuery): ProofSearchPassResult {
  return {
    status: 'non-result',
    reason: 'time-budget',
    queryIdentity: query.queryIdentity,
    checkpoint: null,
    checkpointDisposition: 'fresh',
    pass: {
      maxDiscoveredStates: 10_000,
      timeBudgetMs: 5_000,
      discoveredStateCount: 0,
      processedEdgeCount: 0,
      expandedStateCount: 0,
      totalDiscoveredStateCount: 0,
      totalDiscoveredEdgeCount: 0,
      elapsedMs: 5_000,
    },
  };
}

function forgedDeadPass(query: ProofQuery): ProofSearchPassResult {
  const evidence: ProofEvidence = {
    schemaVersion: PROOF_SCHEMA_VERSION,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    kind: 'mate-witness',
    queryIdentity: query.queryIdentity,
    intendedColor: 'w',
    moves: [],
  };
  return {
    status: 'accepted',
    conclusion: 'dead',
    queryIdentity: query.queryIdentity,
    evidence,
    checkpointDisposition: 'fresh',
    pass: {
      maxDiscoveredStates: 10_000,
      timeBudgetMs: 5_000,
      discoveredStateCount: 0,
      processedEdgeCount: 0,
      expandedStateCount: 0,
      totalDiscoveredStateCount: 0,
      totalDiscoveredEdgeCount: 0,
      elapsedMs: 1,
    },
  };
}

function checkedTimeoutPass(query: ProofQuery): ProofSearchPassResult {
  const fixture = researchedPositiveWitnesses.knightAssistedByRookBlack;
  if (fixture === undefined || query.predicate !== 'timeout-opponent-mating' || query.expiredColor !== 'w') {
    throw new Error('The checked white-flag/black-mating fixture does not match this query.');
  }
  const evidence: ProofEvidence = {
    schemaVersion: PROOF_SCHEMA_VERSION,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    kind: 'mate-witness',
    queryIdentity: query.queryIdentity,
    intendedColor: fixture.intendedColor,
    moves: fixture.moves.map((move): CoordinateMove => {
      const from = move.slice(0, 2);
      const to = move.slice(2, 4);
      const promotion = move[4];
      if (
        !/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to) ||
        (promotion !== undefined && !['q', 'r', 'b', 'n'].includes(promotion))
      ) throw new Error('The researched witness contains an invalid coordinate move.');
      return {
        from: from as CoordinateMove['from'],
        to: to as CoordinateMove['to'],
        ...(promotion === undefined ? {} : { promotion: promotion as NonNullable<CoordinateMove['promotion']> }),
      };
    }),
  };
  const checked = checkProofEvidence(query, evidence);
  if (checked.status !== 'accepted' || checked.conclusion !== 'opponent-can-mate') {
    throw new Error('The independent checker rejected the researched timeout witness.');
  }
  return {
    status: 'accepted',
    conclusion: checked.conclusion,
    queryIdentity: query.queryIdentity,
    evidence,
    checkpointDisposition: 'fresh',
    pass: {
      maxDiscoveredStates: 10_000,
      timeBudgetMs: 5_000,
      discoveredStateCount: 0,
      processedEdgeCount: 0,
      expandedStateCount: 0,
      totalDiscoveredStateCount: 0,
      totalDiscoveredEdgeCount: 0,
      elapsedMs: 1,
    },
  };
}

describe('controller pending adjudication', () => {
  it('classifies a new initialize setup before exposing Start or a clock', async () => {
    const gameId = 'controller-adjudication-initialize-setup-gate';
    const decisionTimeMs = 1_000;
    const store = await openGameStore({
      databaseName: gameId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    const runner = new ControlledAdjudicationRunner();
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs: 5_000, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      adjudicationRunner: runner,
    });

    try {
      const setup = {
        humanSide: 'white' as const,
        modelSelection: model,
        namespace: { kind: 'guest' as const },
        ownershipEpoch: 0,
        startingFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
        timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
      };
      const pending = await controller.initialize(setup);

      expect(pending.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position' });
      expect(pending.adjudication?.workflow).toBe('setup');
      expect(pending.startAvailable).toBe(false);
      expect(pending.clockReading).toBeNull();
      expect(pending.checkpoint.clocks.activeSide).toBeNull();
      expect(pending.checkpoint.rules.currentFen).toBe(setup.startingFen);
      await waitFor(() => runner.calls.length === 1);

      runner.calls[0]!.resolve(unknownPass(runner.calls[0]!.input.query));
      await waitFor(() => controller.snapshot().adjudication?.candidates[0]?.status === 'awaiting-continuation');
      const unresolved = controller.snapshot();
      expect(unresolved.checkpoint.result.kind).toBe('pending-adjudication');
      expect(unresolved.startAvailable).toBe(false);
      expect(unresolved.clockReading).toBeNull();
      expect(unresolved.checkpoint.rules.currentFen).toBe(setup.startingFen);
      expect((await store.readGame(gameId))?.checkpoint.clocks.activeSide).toBeNull();
    } finally {
      store.close();
    }
  });

  it('restores a legacy active checkpoint when initialize receives its saved setup', async () => {
    const gameId = 'controller-adjudication-legacy-initialize-restore';
    const decisionTimeMs = 1_000;
    const store = await openGameStore({
      databaseName: gameId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs: 5_000, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
    });
    const setup = {
      humanSide: 'white' as const,
      modelSelection: model,
      namespace: { kind: 'guest' as const },
      ownershipEpoch: 0,
      timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
    };

    try {
      await seedLegacyActiveGame(gameId, store, setup, { monotonicMs: 5_000 });
      const restored = await controller.initialize(setup);

      expect(restored.checkpoint.revision).toBe(1);
      expect(restored.checkpoint.result).toEqual({ kind: 'unresolved' });
      expect(restored.checkpoint.clocks.activeSide).toBe('white');
      expect(restored.clockReading).toMatchObject({ status: 'running', remaining: { whiteMs: 30_000 } });
      expect(restored.adjudication).toBeNull();
      expect((await store.readGame(gameId))?.checkpoint.revision).toBe(1);
    } finally {
      store.close();
    }
  });

  it('finalizes supported setup deadness only from a replay-checked closed set', async () => {
    const gameId = 'controller-adjudication-known-dead-setup';
    const decisionTimeMs = 1_000;
    const store = await openGameStore({
      databaseName: gameId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    const runner = new ControlledAdjudicationRunner();
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs: 5_000, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      adjudicationRunner: runner,
    });

    try {
      await controller.classifySetup({
        humanSide: 'white',
        modelSelection: { ...model, diagnostic: 'failed' },
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        startingFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
      });
      await waitFor(() => runner.calls.length === 1);
      const proof = await runProofSearchPass(runner.calls[0]!.input.query);
      expect(proof).toMatchObject({ status: 'accepted', conclusion: 'dead', evidence: { kind: 'closed-successor-set' } });
      runner.calls[0]!.resolve(proof);
      await waitFor(() => controller.snapshot().checkpoint.result.kind === 'final');

      const final = controller.snapshot();
      expect(final.checkpoint.result).toMatchObject({ kind: 'final', winner: 'draw', reason: 'dead-position', decidedAtMs: 1_000 });
      expect(final.clockReading).toBeNull();
      expect(final.startAvailable).toBe(false);
      expect(final.adjudication).toBeNull();
    } finally {
      store.close();
    }
  });

  it('classifies setup before diagnosis and starts only after a checked non-dead proof', async () => {
    const gameId = 'controller-adjudication-setup-proof';
    const decisionTimeMs = 1_000;
    const monotonicMs = 5_000;
    const store = await openGameStore({
      databaseName: gameId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    const runner = new ControlledAdjudicationRunner();
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      adjudicationRunner: runner,
    });
    const setup = {
      humanSide: 'white' as const,
      modelSelection: model,
      namespace: { kind: 'guest' as const },
      ownershipEpoch: 0,
      startingFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
      timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
    };

    try {
      const pending = await controller.classifySetup(setup);
      await waitFor(() => runner.calls.length === 1);

      expect(pending.checkpoint.result.kind).toBe('pending-adjudication');
      expect(pending.readiness).toBe('adjudication-pending');
      expect(pending.clockReading).toBeNull();
      expect(pending.startAvailable).toBe(false);
      expect(runner.calls[0]?.input.query.predicate).toBe('global-deadness');

      runner.calls[0]!.resolve(checkedNotDeadPass(runner.calls[0]!.input.query));
      await waitFor(() => controller.snapshot().adjudication?.status === 'setup-ready');
      const ready = controller.snapshot();

      expect(ready.checkpoint.result).toEqual({ kind: 'unresolved' });
      expect(ready.clockReading).toBeNull();
      expect(ready.startAvailable).toBe(false);
      expect(ready.checkpoint.selections.players.black).toMatchObject({ kind: 'model', diagnostic: 'not-run' });
      expect(await store.readGame(gameId)).not.toBeNull();

      const started = await controller.startClassifiedSetup({
        ...setup,
        modelSelection: { ...model, diagnostic: 'passed-current-session' },
      });
      expect(started.checkpoint.clocks.activeSide).toBe('white');
      expect(started.clockReading?.status).toBe('running');
      expect(started.adjudication).toBeNull();
    } finally {
      store.close();
    }
  });

  it('reloads unknown setup facts without restarting the bounded pass automatically', async () => {
    const gameId = 'controller-adjudication-setup-reload';
    const factory = new IDBFactory();
    const decisionTimeMs = 1_000;
    const timeSource: ControllerTimeSource = {
      sample(atDecisionTimeMs) {
        return { monotonicMs: 5_000, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
      },
    };
    const store = await openGameStore({ databaseName: gameId, factory, now: () => decisionTimeMs });
    const runner = new ControlledAdjudicationRunner();
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource,
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      adjudicationRunner: runner,
    });
    const setup = {
      humanSide: 'white' as const,
      modelSelection: { ...model, diagnostic: 'failed' as const },
      namespace: { kind: 'guest' as const },
      ownershipEpoch: 0,
      startingFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
      timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
    };
    let restoredStore: Awaited<ReturnType<typeof openGameStore>> | null = null;

    try {
      await controller.classifySetup(setup);
      await waitFor(() => runner.calls.length === 1);
      runner.calls[0]!.resolve(unknownPass(runner.calls[0]!.input.query));
      await waitFor(() => controller.snapshot().adjudication?.candidates[0]?.status === 'awaiting-continuation');
      const beforeReload = controller.snapshot();
      const candidateBeforeReload = beforeReload.adjudication!.candidates[0]!;
      expect(runner.calls).toHaveLength(1);
      expect(beforeReload.clockReading).toBeNull();
      expect(beforeReload.checkpoint.result.kind).toBe('pending-adjudication');

      store.close();
      vi.resetModules();
      restoredStore = await openGameStore({ databaseName: gameId, factory, now: () => decisionTimeMs });
      const reloadedModule = await import('./index.js');
      const restoredRunner = new ControlledAdjudicationRunner();
      const reloadedController = reloadedModule.getOrCreateGameController({
        gameId,
        store: restoredStore,
        timeSource,
        clockPolicy: { maxReferenceDivergenceMs: 0 },
        adjudicationRunner: restoredRunner,
      });
      const restored = await reloadedController.classifySetup(setup);

      expect(restored.checkpoint.result).toEqual(beforeReload.checkpoint.result);
      expect(restored.clockReading).toBeNull();
      expect(restored.adjudication?.candidates[0]).toMatchObject({
        kind: 'deadness',
        eventId: candidateBeforeReload.eventId,
        eventAtMs: candidateBeforeReload.eventAtMs,
        positionFen: candidateBeforeReload.positionFen,
        query: { queryIdentity: candidateBeforeReload.query.queryIdentity },
        status: 'awaiting-continuation',
      });
      expect(restoredRunner.calls).toHaveLength(0);
      expect(reloadedController.snapshot().checkpoint.revision).toBe(restored.checkpoint.revision);
    } finally {
      store.close();
      restoredStore?.close();
    }
  });

  it('reloads an in-game pending query with its original event facts and a running clock', async () => {
    const gameId = 'controller-adjudication-game-reload';
    const factory = new IDBFactory();
    let decisionTimeMs = 1_000;
    let monotonicMs = 5_000;
    const timeSource: ControllerTimeSource = {
      sample(atDecisionTimeMs) {
        return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
      },
    };
    const store = await openGameStore({ databaseName: gameId, factory, now: () => decisionTimeMs });
    const runner = new ControlledAdjudicationRunner();
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource,
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      adjudicationRunner: runner,
    });
    let restoredStore: Awaited<ReturnType<typeof openGameStore>> | null = null;

    try {
      const started = await initializeLegacyActiveGame(controller, gameId, store, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
      }, { monotonicMs });
      const move = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: started.fence,
        move: { from: 'e2', to: 'e4' },
      });
      if (move.kind !== 'accepted') throw new Error('The initial legal move was not accepted.');
      await waitFor(() => runner.calls.length === 1);
      runner.calls[0]!.resolve(unknownPass(runner.calls[0]!.input.query));
      await waitFor(() => controller.snapshot().adjudication?.candidates[0]?.status === 'awaiting-continuation');
      const beforeReload = controller.snapshot().adjudication!.candidates[0]!;

      store.close();
      vi.resetModules();
      decisionTimeMs = 2_000;
      monotonicMs = 6_000;
      restoredStore = await openGameStore({ databaseName: gameId, factory, now: () => decisionTimeMs });
      const reloadedModule = await import('./index.js');
      const restoredRunner = new ControlledAdjudicationRunner();
      const restoredController = reloadedModule.getOrCreateGameController({
        gameId,
        store: restoredStore,
        timeSource,
        clockPolicy: { maxReferenceDivergenceMs: 0 },
        adjudicationRunner: restoredRunner,
      });
      await restoredController.initialize();
      const restored = await restoredController.reconcile();
      const afterReload = restored.adjudication!.candidates[0]!;

      expect(afterReload).toMatchObject({
        kind: 'deadness',
        eventId: beforeReload.eventId,
        eventAtMs: beforeReload.eventAtMs,
        activeClockDeadlineMs: beforeReload.activeClockDeadlineMs,
        positionFen: beforeReload.positionFen,
        query: { queryIdentity: beforeReload.query.queryIdentity },
        status: 'awaiting-continuation',
      });
      expect(restored.checkpoint.clocks.activeSide).toBe('black');
      expect(restored.clockReading).toMatchObject({ status: 'running', remaining: { blackMs: 29_000 } });
      expect(restoredRunner.calls).toHaveLength(0);
    } finally {
      store.close();
      restoredStore?.close();
    }
  });

  it('fences stopped results, checks Worker evidence, and requires explicit continuation', async () => {
    const gameId = 'controller-adjudication-stop-continue';
    const decisionTimeMs = 1_000;
    const monotonicMs = 5_000;
    const store = await openGameStore({
      databaseName: gameId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    const runner = new ControlledAdjudicationRunner();
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      adjudicationRunner: runner,
    });

    try {
      const started = await initializeLegacyActiveGame(controller, gameId, store, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
      }, { monotonicMs });
      const move = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: started.fence,
        move: { from: 'e2', to: 'e4' },
      });
      if (move.kind !== 'accepted') throw new Error('The initial legal move was not accepted.');
      await waitFor(() => runner.calls.length === 1);
      const query = runner.calls[0]!.input.query;
      const forged = forgedDeadPass(query);
      expect(checkProofEvidence(query, forged.status === 'accepted' ? forged.evidence : undefined).status).toBe('rejected');

      const stopped = await controller.dispatch({
        schemaVersion: 1,
        kind: 'stop-adjudication',
        fence: move.snapshot.fence,
      });
      expect(stopped.kind).toBe('accepted');
      expect(runner.calls[0]!.input.signal?.aborted).toBe(true);
      expect(stopped.snapshot.adjudication?.candidates[0]?.status).toBe('awaiting-continuation');

      runner.calls[0]!.resolve(forged);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(controller.snapshot().checkpoint.result.kind).toBe('pending-adjudication');

      const continued = await controller.dispatch({
        schemaVersion: 1,
        kind: 'continue-adjudication',
        fence: stopped.snapshot.fence,
      });
      expect(continued.kind).toBe('accepted');
      await waitFor(() => runner.calls.length === 2);
      expect(runner.calls[1]?.input.query.queryIdentity).toBe(query.queryIdentity);
      expect(continued.snapshot.clockReading?.status).toBe('running');

      runner.calls[1]!.resolve(forged);
      await waitFor(() => controller.snapshot().adjudication?.candidates[0]?.status === 'awaiting-continuation');
      const unresolved = controller.snapshot();
      expect(unresolved.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position' });
      expect(unresolved.clockReading?.status).toBe('running');
      expect(runner.calls).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('rejects a checked proof when the persisted ownership epoch changes during analysis', async () => {
    const gameId = 'controller-adjudication-ownership-change';
    const decisionTimeMs = 1_000;
    const store = await openGameStore({
      databaseName: gameId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    const runner = new ControlledAdjudicationRunner();
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs: 5_000, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      adjudicationRunner: runner,
    });

    try {
      await controller.classifySetup({
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        startingFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
      });
      await waitFor(() => runner.calls.length === 1);
      const beforeOwnershipChange = await store.readGame(gameId);
      if (beforeOwnershipChange === null) throw new Error('The classified setup was not saved.');
      const ownershipChange = await store.commitCheckpoint({
        gameId,
        expectedRevision: beforeOwnershipChange.checkpoint.revision,
        expectedEpoch: beforeOwnershipChange.checkpoint.ownershipEpoch,
        events: [],
        chunks: [],
        knownCredentials: [],
        decide(atDecisionTimeMs) {
          return {
            checkpoint: {
              ...beforeOwnershipChange.checkpoint,
              revision: beforeOwnershipChange.checkpoint.revision + 1,
              ownershipEpoch: beforeOwnershipChange.checkpoint.ownershipEpoch + 1,
              updatedAtMs: atDecisionTimeMs,
            },
            events: [],
            outboxOperationIds: [],
          };
        },
      });
      expect(ownershipChange.kind).toBe('committed');

      runner.calls[0]!.resolve(checkedNotDeadPass(runner.calls[0]!.input.query));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await controller.reconcile();

      const saved = await store.readGame(gameId);
      expect(saved?.checkpoint.ownershipEpoch).toBe(1);
      expect(saved?.checkpoint.result.kind).toBe('pending-adjudication');
      expect(saved?.events.map(({ kind }) => kind)).not.toContain('adjudication-evidence-accepted');
      expect(controller.snapshot().checkpoint.result.kind).toBe('pending-adjudication');
    } finally {
      store.close();
    }
  });

  it('settles a checked one-sided timeout proof at the persisted expiry time', async () => {
    const gameId = 'controller-adjudication-timeout-witness';
    let decisionTimeMs = 1_000;
    let monotonicMs = 5_000;
    const store = await openGameStore({
      databaseName: gameId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    const runner = new ControlledAdjudicationRunner();
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      adjudicationRunner: runner,
    });

    try {
      const started = await initializeLegacyActiveGame(controller, gameId, store, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        startingFen: '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
        timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
      }, { monotonicMs });
      expect(started.checkpoint.clocks.activeSide).toBe('white');

      decisionTimeMs = 32_000;
      monotonicMs = 36_000;
      const pending = await controller.reconcile();
      expect(pending.checkpoint.result).toMatchObject({
        kind: 'pending-adjudication',
        reason: 'timeout',
        eventAtMs: 31_000,
        activeClockDeadlineMs: null,
      });
      expect(pending.checkpoint.clocks).toMatchObject({
        activeSide: null,
        anchor: null,
        banksAtAnchor: { whiteMs: 0 },
        lastReconciledAtMs: 31_000,
      });
      await waitFor(() => runner.calls.length === 1);

      const proof = checkedTimeoutPass(runner.calls[0]!.input.query);
      expect(proof).toMatchObject({ status: 'accepted', conclusion: 'opponent-can-mate' });
      runner.calls[0]!.resolve(proof);
      await waitFor(() => controller.snapshot().checkpoint.result.kind === 'final');

      const final = controller.snapshot();
      expect(final.checkpoint.result).toMatchObject({
        kind: 'final',
        winner: 'black',
        reason: 'timeout',
        decidedAtMs: 31_000,
      });
      expect(final.checkpoint.clocks.activeSide).toBeNull();
      const saved = await store.readGame(gameId);
      expect(saved?.events.map(({ kind }) => kind)).toContain('adjudication-evidence-accepted');
    } finally {
      store.close();
    }
  });

  it('persists the original flag while an earlier deadness check is pending', async () => {
    const gameId = 'controller-adjudication-flag-order';
    let decisionTimeMs = 1_000;
    let monotonicMs = 5_000;
    const store = await openGameStore({
      databaseName: gameId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    const runner = new ControlledAdjudicationRunner();
    const timeSource: ControllerTimeSource = {
      sample(atDecisionTimeMs) {
        return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
      },
    };
    const controller = getOrCreateGameController({
      gameId,
      store,
      timeSource,
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: (() => {
        let id = 0;
        return () => `${gameId}-event-${++id}`;
      })(),
      adjudicationRunner: runner,
    });

    try {
      const setup = await initializeLegacyActiveGame(controller, gameId, store, {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
      }, { monotonicMs });
      const move = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: setup.fence,
        move: { from: 'e2', to: 'e4' },
      });
      expect(move.kind).toBe('accepted');
      expect(move.snapshot.checkpoint.result).toMatchObject({
        kind: 'pending-adjudication',
        reason: 'dead-position',
        eventAtMs: 1_000,
        activeClockDeadlineMs: 31_000,
      });
      await waitFor(() => runner.calls.length === 1);
      await store.readGame(gameId);

      decisionTimeMs = 32_000;
      monotonicMs = 36_000;
      const reconciled = await controller.reconcile();

      expect(reconciled.checkpoint.result).toMatchObject({
        kind: 'pending-adjudication',
        reason: 'dead-position',
        eventAtMs: 1_000,
        activeClockDeadlineMs: 31_000,
      });
      expect(reconciled.adjudication?.candidates.map(({ kind }) => kind)).toEqual(['deadness', 'timeout']);
      const timeout = reconciled.adjudication?.candidates[1];
      expect(timeout).toMatchObject({
        kind: 'timeout',
        eventAtMs: 31_000,
        activeClockDeadlineMs: null,
        status: 'awaiting-continuation',
      });
      const saved = await store.readGame(gameId);
      expect(saved?.events.at(-1)).toMatchObject({
        kind: 'timeout-candidate',
        occurredAtMs: 31_000,
        payload: {
          details: {
            decisionTimeMs: 32_000,
            originalExpiryAtMs: 31_000,
          },
        },
      });
    } finally {
      store.close();
    }
  });
});
