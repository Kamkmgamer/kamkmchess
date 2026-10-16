import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openGameStore } from '../storage/index.js';
import { getOrCreateGameController, modelConfigurationIdentity } from './index.js';
import type {
  ControllerTimeSource,
  GameControllerIntentV1,
  GameControllerSetupV1,
  ModelSelection,
} from './index.js';
import type { ProofAdjudicationRunnerV1 } from '../adjudication/index.js';
import type { CheckpointCommitInputV1, GameStore } from '../storage/index.js';

const model: ModelSelection = {
  kind: 'model',
  providerId: 'openrouter',
  connectionId: 'connection-primary',
  configurationRevision: 7,
  modelRoutingId: 'My/Model:latest',
  protocol: 'chat-completions',
  diagnostic: 'passed-current-session',
};

const heldAdjudicationRunner: ProofAdjudicationRunnerV1 = {
  runPass: () => new Promise(() => {}),
};

describe('model configuration identity', () => {
  it('preserves exact routing identity without including diagnostic state', () => {
    expect(modelConfigurationIdentity(model)).toBe(
      '["openrouter","connection-primary",7,"My/Model:latest","chat-completions"]',
    );
    expect(modelConfigurationIdentity({ ...model, diagnostic: 'failed' })).toBe(
      '["openrouter","connection-primary",7,"My/Model:latest","chat-completions"]',
    );
  });

  it('changes identity when the selected model configuration changes', () => {
    expect(modelConfigurationIdentity({ ...model, configurationRevision: 8 })).not.toBe(
      '["openrouter","connection-primary",7,"My/Model:latest","chat-completions"]',
    );
    expect(modelConfigurationIdentity({ ...model, modelRoutingId: 'my/model:latest' })).not.toBe(
      '["openrouter","connection-primary",7,"My/Model:latest","chat-completions"]',
    );
  });

  it('rejects routing IDs with leading or trailing whitespace', () => {
    expect(() => modelConfigurationIdentity({ ...model, modelRoutingId: ' My/Model:latest' })).toThrow(
      RangeError,
    );
    expect(() => modelConfigurationIdentity({ ...model, modelRoutingId: 'My/Model:latest ' })).toThrow(
      RangeError,
    );
  });
});

describe('game controller setup', () => {
  it('starts the selected side with the persisted 15+10 clock after setup', async () => {
    const testId = 'controller-setup-default';
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => 1_000,
    });
    let generatedId = 0;
    let monotonicMs = 5_000;
    let wallTimeMs = 1_000;
    const timeSource: ControllerTimeSource = {
      sample(decisionTimeMs) {
        return {
          monotonicMs,
          wallTimeMs: decisionTimeMs ?? wallTimeMs,
          hostOffsetMs: 200,
        };
      },
    };
    const options = {
      gameId: testId,
      store,
      timeSource,
      clockPolicy: { maxReferenceDivergenceMs: 5 },
      idFactory: () => `controller-id-${++generatedId}`,
    };
    const controller = getOrCreateGameController(options);
    const remountedController = getOrCreateGameController({
      ...options,
      clockPolicy: { maxReferenceDivergenceMs: 5 },
    });

    try {
      expect(remountedController).toBe(controller);
      const setup: GameControllerSetupV1 = {
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
      };
      const [firstInitialization, remountInitialization] = await Promise.all([
        controller.initialize(setup),
        remountedController.initialize(setup),
      ]);

      const snapshot = controller.snapshot();
      expect(snapshot.checkpoint.revision).toBe(1);
      expect(firstInitialization.checkpoint.revision).toBe(1);
      expect(remountInitialization.checkpoint.revision).toBe(1);
      expect(snapshot.checkpoint.clocks).toEqual({
        schemaVersion: 1,
        timeControl: { startingTimeMs: 900_000, incrementMs: 10_000 },
        banksAtAnchor: { whiteMs: 900_000, blackMs: 900_000 },
        activeSide: 'white',
        anchor: { monotonicMs: 5_000, wallTimeMs: 1_000, hostOffsetMs: 200 },
        lastReconciledAtMs: 1_000,
      });
      expect(snapshot.clockReading).toMatchObject({
        status: 'running',
        activeSide: 'white',
        remaining: { whiteMs: 900_000, blackMs: 900_000 },
        evidence: {
          anchor: { hostOffsetMs: 200 },
        },
      });

      monotonicMs = 904_999;
      wallTimeMs = 900_999;
      expect(controller.snapshot().clockReading?.status).toBe('running');
      expect(controller.snapshot().clockReading?.remaining).toEqual({ whiteMs: 1, blackMs: 900_000 });

      monotonicMs = 905_000;
      wallTimeMs = 901_000;
      expect(controller.snapshot().clockReading?.status).toBe('expired');
      expect(controller.snapshot().readiness).toBe('expiry-persistence-pending');
    } finally {
      store.close();
    }
  });

  it('does not publish setup state until the checkpoint commit resolves', async () => {
    const testId = 'controller-delayed-setup-commit';
    const baseStore = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => 2_000,
    });
    let signalDurableCommit = () => {};
    const durableCommit = new Promise<void>((resolve) => {
      signalDurableCommit = resolve;
    });
    let releaseAcknowledgment = () => {};
    const acknowledgment = new Promise<void>((resolve) => {
      releaseAcknowledgment = resolve;
    });
    const delayedStore: GameStore = new Proxy(baseStore, {
      get(target, property) {
        if (property === 'commitCheckpoint') {
          return async (input: CheckpointCommitInputV1) => {
            const result = await target.commitCheckpoint(input);
            signalDurableCommit();
            await acknowledgment;
            return result;
          };
        }
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const timeSource: ControllerTimeSource = {
      sample(decisionTimeMs) {
        return { monotonicMs: 7_000, wallTimeMs: decisionTimeMs ?? 2_000 };
      },
    };
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store: delayedStore,
      timeSource,
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });
    let publicationCount = 0;
    const unsubscribe = controller.subscribe(() => {
      publicationCount += 1;
    });

    try {
      const initialization = controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
      });
      await durableCommit;
      expect(publicationCount).toBe(0);
      expect(() => controller.snapshot()).toThrow();

      releaseAcknowledgment();
      const snapshot = await initialization;
      expect(publicationCount).toBe(1);
      expect(snapshot.checkpoint.revision).toBe(1);
      expect(snapshot.checkpoint.selections.players.black).toEqual({ kind: 'human' });
      expect(snapshot.checkpoint.selections.players.white).toMatchObject({ kind: 'model' });
    } finally {
      releaseAcknowledgment();
      unsubscribe();
      baseStore.close();
    }
  });

  it('captures setup values before the saved-game read can yield', async () => {
    const testId = 'controller-setup-input-snapshot';
    const baseStore = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => 2_000,
    });
    let releaseRead = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const delayedReadStore: GameStore = new Proxy(baseStore, {
      get(target, property) {
        if (property === 'readGame') {
          return async (gameId: string) => {
            await readGate;
            return target.readGame(gameId);
          };
        }
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store: delayedReadStore,
      timeSource: {
        sample(decisionTimeMs) {
          return { monotonicMs: 300, wallTimeMs: decisionTimeMs ?? 2_000 };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });
    const setup: GameControllerSetupV1 = {
      humanSide: 'black',
      modelSelection: { ...model },
      namespace: { kind: 'guest' },
      ownershipEpoch: 0,
    };

    try {
      const initialization = controller.initialize(setup);
      setup.modelSelection.modelRoutingId = 'mutated/after-call';
      releaseRead();
      const snapshot = await initialization;

      expect(snapshot.checkpoint.selections.players.white).toMatchObject({
        kind: 'model',
        modelRoutingId: model.modelRoutingId,
      });
    } finally {
      releaseRead();
      baseStore.close();
    }
  });

  it('resolves Random once and fences the exact model on the position side to move', async () => {
    const testId = 'controller-random-side';
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => 10_000,
    });
    let generatedId = 0;
    let randomSelections = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(decisionTimeMs) {
          return { monotonicMs: 300, wallTimeMs: decisionTimeMs ?? 10_000 };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
      randomSide: () => {
        randomSelections += 1;
        return 'black';
      },
    });

    try {
      const snapshot = await controller.initialize({
        humanSide: 'random',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 3_000 },
      });

      expect(randomSelections).toBe(1);
      expect(snapshot.checkpoint.selections.players.black).toEqual({ kind: 'human' });
      expect(snapshot.checkpoint.selections.players.white).toMatchObject({ kind: 'model' });
      expect(snapshot.checkpoint.clocks).toMatchObject({
        timeControl: { startingTimeMs: 30_000, incrementMs: 3_000 },
        activeSide: 'white',
      });
      expect(snapshot.fence).toMatchObject({
        side: 'white',
        revision: 1,
        positionRevision: 0,
        requestGeneration: 0,
        analysisGeneration: 0,
        ownershipEpoch: 0,
        modelConfigurationIdentity: modelConfigurationIdentity(model),
      });
    } finally {
      store.close();
    }
  });

  it('finalizes a terminal custom start without starting a clock', async () => {
    const testId = 'controller-terminal-custom-start';
    let generatedId = 0;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => 15_000,
    });
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(decisionTimeMs) {
          return { monotonicMs: 200, wallTimeMs: decisionTimeMs ?? 15_000 };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const snapshot = await controller.initialize({
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        startingFen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
      });

      expect(snapshot.checkpoint.result).toEqual({
        kind: 'final',
        winner: 'draw',
        reason: 'stalemate',
        eventId: snapshot.checkpoint.archive.currentLine.eventIds[0],
        decidedAtMs: 15_000,
      });
      expect(snapshot.checkpoint.clocks).toMatchObject({ activeSide: null, anchor: null });
      expect(snapshot.clockReading).toBeNull();
      const request = await controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: snapshot.fence,
      });
      expect(request).toMatchObject({ kind: 'rejected', reason: 'not-actionable' });
    } finally {
      store.close();
    }
  });

  it('isolates committed request context from subscription snapshot mutation', async () => {
    const testId = 'controller-subscription-snapshot-isolation';
    let generatedId = 0;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => 10_000,
    });
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(decisionTimeMs) {
          return { monotonicMs: 300, wallTimeMs: decisionTimeMs ?? 10_000 };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });
    const unsubscribe = controller.subscribe((snapshot) => {
      if (snapshot.checkpoint.requestGeneration > 0) {
        snapshot.fence.requestGeneration = -1;
      }
    });

    try {
      const initial = await controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
      });
      const started = await controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: initial.fence,
      });

      if (started.kind !== 'model-turn-started') throw new Error('The model turn did not start.');
      expect(started.request.fence.requestGeneration).toBe(started.snapshot.checkpoint.requestGeneration);
    } finally {
      unsubscribe();
      store.close();
    }
  });

  it('commits a model move with the fenced decision time and one clock increment', async () => {
    const testId = 'controller-committed-model-move';
    let decisionTimeMs = 1_000;
    let monotonicMs = 5_000;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return {
            monotonicMs,
            wallTimeMs: atDecisionTimeMs ?? decisionTimeMs,
            hostOffsetMs: 100,
          };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
      adjudicationRunner: heldAdjudicationRunner,
    });

    try {
      const initial = await controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 3_000 },
      });
      const started = await controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: initial.fence,
      });

      expect(started.kind).toBe('model-turn-started');
      if (started.kind !== 'model-turn-started') throw new Error('The model turn did not start.');

      decisionTimeMs = 1_010;
      monotonicMs = 5_010;
      const accepted = await controller.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: started.request.fence,
        move: { from: 'e2', to: 'e4' },
      });

      expect(accepted.kind).toBe('accepted');
      expect(accepted.snapshot.checkpoint.revision).toBe(3);
      expect(accepted.snapshot.checkpoint.positionRevision).toBe(1);
      expect(accepted.snapshot.checkpoint.rules.moves).toEqual([
        expect.objectContaining({
          from: 'e2',
          to: 'e4',
          san: 'e4',
          fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        }),
      ]);
      expect(accepted.snapshot.checkpoint.clocks).toMatchObject({
        banksAtAnchor: { whiteMs: 32_990, blackMs: 30_000 },
        activeSide: 'black',
        anchor: { monotonicMs: 5_010, wallTimeMs: 1_010 },
      });

      const saved = await store.readGame(testId);
      expect(saved?.events.map((event) => event.kind)).toEqual([
        'game-created',
        'model-turn-started',
        'model-move-accepted',
        'adjudication-pending',
      ]);
      expect(saved?.events.find((event) => event.kind === 'model-move-accepted')).toMatchObject({
        sequence: 2,
        occurredAtMs: 1_010,
        payload: {
          schemaVersion: 1,
          fence: started.request.fence,
          details: {
            clock: {
              elapsedChargedMs: 10,
              incrementCredit: { side: 'white', milliseconds: 3_000 },
              nextAnchor: { monotonicMs: 5_010, wallTimeMs: 1_010, hostOffsetMs: 100 },
              evidence: {
                basis: 'monotonic',
                anchor: { monotonicMs: 5_000, wallTimeMs: 1_000, hostOffsetMs: 100 },
                observedAt: { monotonicMs: 5_010, wallTimeMs: 1_010, hostOffsetMs: 100 },
                elapsed: { monotonicMs: 10, wallMs: 10, hostAdjustedMs: 10 },
              },
            },
          },
        },
      });
    } finally {
      store.close();
    }
  });

  it('does not accept a model move unless its request generation is active', async () => {
    const testId = 'controller-model-move-needs-request';
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => 2_000,
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(decisionTimeMs) {
          return { monotonicMs: 2_000, wallTimeMs: decisionTimeMs ?? 2_000 };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initialized = await controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
      });
      const unsolicited = await controller.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: initialized.fence,
        move: { from: 'e2', to: 'e4' },
      });
      expect(unsolicited).toMatchObject({ kind: 'rejected', reason: 'not-actionable' });
      expect(unsolicited.snapshot.checkpoint.revision).toBe(initialized.checkpoint.revision);
      expect(unsolicited.snapshot.checkpoint.rules.moves).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('persists clock reference discrepancies and blocks a legal move', async () => {
    const testId = 'controller-clock-discrepancy';
    let decisionTimeMs = 5_000;
    const monotonicMs = 7_000;
    let wallTimeMs = 5_000;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return {
            monotonicMs,
            wallTimeMs: atDecisionTimeMs ?? wallTimeMs,
          };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 5 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await controller.initialize({
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
      });
      wallTimeMs = 6_000;
      const discrepancy = controller.snapshot();
      expect(discrepancy.clockReading?.status).toBe('reconciliation-required');
      expect(discrepancy.readiness).toBe('clock-reconciliation-required');
      if (discrepancy.clockReading?.status !== 'reconciliation-required') {
        throw new Error('The clock references did not report a discrepancy.');
      }
      expect(discrepancy.clockReading.evidence.maxObservedDivergenceMs).toBe(1_000);

      decisionTimeMs = 6_000;
      const blockedMove = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: initial.fence,
        move: { from: 'e2', to: 'e4' },
      });
      expect(blockedMove.kind).toBe('clock-reconciliation-required');
      expect(blockedMove.snapshot.checkpoint.rules.moves).toHaveLength(0);
      const saved = await store.readGame(testId);
      expect(saved?.events.at(-1)).toMatchObject({
        kind: 'clock-reconciliation-required',
        occurredAtMs: 6_000,
        payload: { details: { reason: 'reference-divergence' } },
      });
    } finally {
      store.close();
    }
  });

  it('preserves a preaction clock discrepancy across an aborted write and stable later samples', async () => {
    const testId = 'controller-preaction-clock-discrepancy';
    let decisionTimeMs = 1_000;
    let unanchoredSamples = 0;
    const baseStore = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let abortNextCommit = false;
    const store: GameStore = new Proxy(baseStore, {
      get(target, property) {
        if (property === 'commitCheckpoint') {
          return async (input: CheckpointCommitInputV1) => {
            if (!abortNextCommit) return target.commitCheckpoint(input);
            abortNextCommit = false;
            const decide = input.decide;
            return target.commitCheckpoint({
              ...input,
              decide(at) {
                decide(at);
                throw new Error('Injected abort after fenced decision.');
              },
            });
          };
        }
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          if (atDecisionTimeMs !== undefined) {
            return {
              monotonicMs: atDecisionTimeMs === 1_000 ? 0 : 500,
              wallTimeMs: atDecisionTimeMs,
            };
          }
          unanchoredSamples += 1;
          if (unanchoredSamples === 1) return { monotonicMs: 0, wallTimeMs: 1_000 };
          if (unanchoredSamples === 2) return { monotonicMs: 500, wallTimeMs: 2_500 };
          return { monotonicMs: 500, wallTimeMs: 1_500 };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await controller.initialize({
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 60_000, incrementMs: 1_000 },
      });
      decisionTimeMs = 1_500;
      abortNextCommit = true;
      await expect(controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: initial.fence,
        move: { from: 'e2', to: 'e4' },
      })).rejects.toMatchObject({ code: 'transaction-aborted' });

      const afterAbort = await baseStore.readGame(testId);
      expect(afterAbort?.checkpoint.revision).toBe(initial.checkpoint.revision);
      expect(afterAbort?.checkpoint.rules.moves).toHaveLength(0);
      expect(afterAbort?.events.map((event) => event.kind)).toEqual(['game-created']);
      expect(controller.snapshot().readiness).toBe('clock-reconciliation-required');

      const blocked = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: initial.fence,
        move: { from: 'e2', to: 'e4' },
      });

      expect(blocked.kind).toBe('clock-reconciliation-required');
      expect(blocked.snapshot.checkpoint.rules.moves).toHaveLength(0);
      expect(blocked.snapshot.readiness).toBe('clock-reconciliation-required');
      const saved = await baseStore.readGame(testId);
      expect(saved?.events.at(-1)).toMatchObject({
        kind: 'clock-reconciliation-required',
        occurredAtMs: 1_500,
        payload: {
          details: {
            reason: 'reference-divergence',
            evidence: {
              anchor: { monotonicMs: 0, wallTimeMs: 1_000 },
              observedAt: { monotonicMs: 500, wallTimeMs: 2_500 },
              elapsed: { monotonicMs: 500, wallMs: 1_500 },
              maxObservedDivergenceMs: 1_000,
            },
          },
        },
      });

      for (const kind of ['human-move', 'model-move', 'begin-model-turn', 'stop-model-turn'] as const) {
        const intent = kind === 'human-move' || kind === 'model-move'
          ? { schemaVersion: 1 as const, kind, fence: blocked.snapshot.fence, move: { from: 'e2' as const, to: 'e4' as const } }
          : { schemaVersion: 1 as const, kind, fence: blocked.snapshot.fence };
        const stillBlocked = await controller.dispatch(intent);
        expect(stillBlocked.kind).toBe('clock-reconciliation-required');
        expect(stillBlocked.snapshot.checkpoint.revision).toBe(blocked.snapshot.checkpoint.revision);
      }
      expect((await baseStore.readGame(testId))?.checkpoint.rules.moves).toHaveLength(0);
      expect((await baseStore.readGame(testId))?.events.filter(
        (event) => event.kind === 'clock-reconciliation-required',
      )).toHaveLength(1);

      const reconciled = await controller.reconcile();
      expect(reconciled.readiness).toBe('ready');
      expect(reconciled.checkpoint.rules.moves).toHaveLength(0);
      expect(reconciled.checkpoint.clocks).toMatchObject({
        banksAtAnchor: { whiteMs: 60_000, blackMs: 60_000 },
        anchor: { monotonicMs: 0, wallTimeMs: 1_000 },
      });
      expect((await baseStore.readGame(testId))?.events.slice(-1)[0]?.kind).toBe('clock-reference-reconciled');

      const accepted = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: reconciled.fence,
        move: { from: 'e2', to: 'e4' },
      });
      expect(accepted.kind).toBe('accepted');
      expect(accepted.snapshot.checkpoint.clocks.banksAtAnchor).toEqual({
        whiteMs: 60_500,
        blackMs: 60_000,
      });
    } finally {
      baseStore.close();
    }
  });

  it('rejects unknown runtime intent kinds before sampling or persistence', async () => {
    const testId = 'controller-unknown-intent-kind';
    const decisionTimeMs = 8_000;
    const monotonicMs = 12_000;
    let sampleCount = 0;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          sampleCount += 1;
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 60_000, incrementMs: 1_000 },
      });
      const started = await controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: initial.fence,
      });
      if (started.kind !== 'model-turn-started') throw new Error('The model turn did not start.');

      const samplesBeforeInvalidIntent = sampleCount;
      const invalidIntent = {
        schemaVersion: 1,
        kind: 'not-a-real-intent-kind',
        fence: started.request.fence,
        move: { from: 'e2', to: 'e4' },
      } as unknown as GameControllerIntentV1;
      await expect(controller.dispatch(invalidIntent)).rejects.toMatchObject({ code: 'invalid-intent' });

      expect(sampleCount).toBe(samplesBeforeInvalidIntent);
      const saved = await store.readGame(testId);
      expect(saved?.checkpoint.revision).toBe(started.snapshot.checkpoint.revision);
      expect(saved?.checkpoint.rules.moves).toHaveLength(0);
      expect(saved?.events.map((event) => event.kind)).toEqual(['game-created', 'model-turn-started']);
    } finally {
      store.close();
    }
  });

  it.each([
    { label: 'before', offsetMs: 29_999, expectedKind: 'accepted' },
    { label: 'at', offsetMs: 30_000, expectedKind: 'expired' },
    { label: 'after', offsetMs: 30_001, expectedKind: 'expired' },
  ] as const)(
    'uses expiry precedence at the $label deadline boundary',
    async ({ label, offsetMs, expectedKind }) => {
      const testId = `controller-deadline-${label}`;
      let decisionTimeMs = 1_000;
      let monotonicMs = 5_000;
      const store = await openGameStore({
        databaseName: testId,
        factory: new IDBFactory(),
        now: () => decisionTimeMs,
      });
      let generatedId = 0;
      const controller = getOrCreateGameController({
        gameId: testId,
        store,
        timeSource: {
          sample(atDecisionTimeMs) {
            return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
          },
        },
        clockPolicy: { maxReferenceDivergenceMs: 0 },
        idFactory: () => `${testId}-id-${++generatedId}`,
        adjudicationRunner: heldAdjudicationRunner,
      });

      try {
        const initial = await controller.initialize({
          humanSide: 'black',
          modelSelection: model,
          namespace: { kind: 'guest' },
          ownershipEpoch: 0,
          timeControl: { startingTimeMs: 30_000, incrementMs: 3_000 },
        });
        const started = await controller.dispatch({
          schemaVersion: 1,
          kind: 'begin-model-turn',
          fence: initial.fence,
        });
        if (started.kind !== 'model-turn-started') throw new Error('The model turn did not start.');

        decisionTimeMs = 1_000 + offsetMs;
        monotonicMs = 5_000 + offsetMs;
        const move = await controller.dispatch({
          schemaVersion: 1,
          kind: 'model-move',
          fence: started.request.fence,
          move: { from: 'e2', to: 'e4' },
        });

        expect(move.kind).toBe(expectedKind);
        if (expectedKind === 'accepted') {
          expect(move.snapshot.checkpoint.rules.moves).toHaveLength(1);
          expect(move.snapshot.checkpoint.clocks.banksAtAnchor.whiteMs).toBe(3_001);
        } else {
          expect(move.snapshot.checkpoint.rules.moves).toHaveLength(0);
          expect(move.snapshot.checkpoint.result).toMatchObject({
            kind: 'pending-adjudication',
            reason: 'timeout',
            eventAtMs: 31_000,
          });
          const saved = await store.readGame(testId);
          expect(saved?.events.at(-1)).toMatchObject({
            kind: 'timeout-candidate',
            occurredAtMs: 31_000,
          });
          const repeatedLateMove = await controller.dispatch({
            schemaVersion: 1,
            kind: 'model-move',
            fence: started.request.fence,
            move: { from: 'e2', to: 'e4' },
          });
          expect(repeatedLateMove.kind).toBe('rejected');
          expect(repeatedLateMove.snapshot.checkpoint.revision).toBe(move.snapshot.checkpoint.revision);
        }
      } finally {
        store.close();
      }
    },
  );

  it('fences stopped model work even when a later request has the same position', async () => {
    const testId = 'controller-stop-repeated-position';
    let decisionTimeMs = 4_000;
    let monotonicMs = 8_000;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
      });
      const firstRequest = await controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: initial.fence,
      });
      if (firstRequest.kind !== 'model-turn-started') throw new Error('The first model turn did not start.');

      decisionTimeMs = 4_050;
      monotonicMs = 8_050;
      const stopped = await controller.dispatch({
        schemaVersion: 1,
        kind: 'stop-model-turn',
        fence: firstRequest.request.fence,
      });
      expect(stopped.kind).toBe('accepted');
      expect(stopped.snapshot.checkpoint.rules.currentFen).toBe(initial.checkpoint.rules.currentFen);
      expect(stopped.snapshot.checkpoint.positionRevision).toBe(0);

      const lateReply = await controller.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: firstRequest.request.fence,
        move: { from: 'e2', to: 'e4' },
      });
      expect(lateReply.kind).toBe('rejected');
      expect(lateReply.snapshot.checkpoint.rules.moves).toHaveLength(0);

      const secondRequest = await controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: stopped.snapshot.fence,
      });
      if (secondRequest.kind !== 'model-turn-started') throw new Error('The replacement model turn did not start.');
      expect(secondRequest.request.position.fen).toBe(firstRequest.request.position.fen);
      expect(secondRequest.request.fence.revision).toBeGreaterThan(firstRequest.request.fence.revision);
      expect(secondRequest.request.fence.requestGeneration).toBeGreaterThan(
        firstRequest.request.fence.requestGeneration,
      );

      const duplicateOldReply = await controller.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: firstRequest.request.fence,
        move: { from: 'e2', to: 'e4' },
      });
      expect(duplicateOldReply.kind).toBe('rejected');
      expect(duplicateOldReply.snapshot.checkpoint.rules.moves).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('fences further play while exact deadness is unresolved', async () => {
    const testId = 'controller-pending-deadness-fence';
    let decisionTimeMs = 5_000;
    let monotonicMs = 8_000;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
      adjudicationRunner: heldAdjudicationRunner,
    });

    try {
      let state = await controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 60_000, incrementMs: 0 },
      });
      const firstRequest = await controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: state.fence,
      });
      if (firstRequest.kind !== 'model-turn-started') throw new Error('The first model turn did not start.');
      state = firstRequest.snapshot;
      decisionTimeMs += 1_000;
      monotonicMs += 1_000;
      const accepted = await controller.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: state.fence,
        move: { from: 'g1', to: 'f3' },
      });
      expect(accepted.kind).toBe('accepted');
      state = accepted.snapshot;
      expect(state.readiness).toBe('adjudication-pending');
      expect(state.adjudication?.candidates[0]).toMatchObject({ kind: 'deadness', status: 'running' });
      expect(state.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position' });

      const blockedMove = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: state.fence,
        move: { from: 'g8', to: 'f6' },
      });
      expect(blockedMove.kind).toBe('rejected');
      expect(blockedMove.snapshot.checkpoint.rules.moves).toHaveLength(1);

      const staleReply = await controller.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: firstRequest.request.fence,
        move: { from: 'g1', to: 'f3' },
      });
      expect(staleReply).toMatchObject({ kind: 'rejected', reason: 'stale-fence' });
      expect(staleReply.snapshot.checkpoint.revision).toBe(state.checkpoint.revision);
      expect(staleReply.snapshot.checkpoint.rules.moves).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('waits for the durable move commit and charges acknowledgment delay to the next bank', async () => {
    const testId = 'controller-delayed-move-commit';
    let decisionTimeMs = 6_000;
    let monotonicMs = 9_000;
    const baseStore = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let signalDurableCommit = () => {};
    const durableCommit = new Promise<void>((resolve) => {
      signalDurableCommit = resolve;
    });
    let releaseAcknowledgment = () => {};
    const acknowledgment = new Promise<void>((resolve) => {
      releaseAcknowledgment = resolve;
    });
    let delayNextCommit = false;
    const delayedStore: GameStore = new Proxy(baseStore, {
      get(target, property) {
        if (property === 'commitCheckpoint') {
          return async (input: CheckpointCommitInputV1) => {
            const result = await target.commitCheckpoint(input);
            if (delayNextCommit) {
              delayNextCommit = false;
              signalDurableCommit();
              await acknowledgment;
            }
            return result;
          };
        }
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store: delayedStore,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
      adjudicationRunner: heldAdjudicationRunner,
    });

    try {
      const initial = await controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 3_000 },
      });
      const started = await controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: initial.fence,
      });
      if (started.kind !== 'model-turn-started') throw new Error('The model turn did not start.');

      decisionTimeMs = 6_000 + 29_999;
      monotonicMs = 9_000 + 29_999;
      delayNextCommit = true;
      let accepted = false;
      const moveCommit = controller.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: started.request.fence,
        move: { from: 'e2', to: 'e4' },
      }).then((result) => {
        accepted = result.kind === 'accepted';
        return result;
      });

      await durableCommit;
      expect(accepted).toBe(false);
      expect(controller.snapshot().checkpoint.revision).toBe(started.snapshot.checkpoint.revision);
      expect(controller.snapshot().checkpoint.rules.moves).toHaveLength(0);

      decisionTimeMs = 6_000 + 30_010;
      monotonicMs = 9_000 + 30_010;
      releaseAcknowledgment();
      const result = await moveCommit;
      expect(result.kind).toBe('accepted');
      expect(controller.snapshot().checkpoint.revision).toBe(started.snapshot.checkpoint.revision + 1);
      expect(controller.snapshot().clockReading?.remaining).toEqual({ whiteMs: 3_001, blackMs: 29_989 });
      expect(controller.snapshot().checkpoint.clocks.anchor).toEqual({
        monotonicMs: 9_000 + 29_999,
        wallTimeMs: 6_000 + 29_999,
      });
    } finally {
      releaseAcknowledgment();
      baseStore.close();
    }
  });

  it('accepts no move or increment when the fenced checkpoint transaction aborts', async () => {
    const testId = 'controller-aborted-move-commit';
    let decisionTimeMs = 12_000;
    let monotonicMs = 15_000;
    const baseStore = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let abortNextCommit = false;
    const abortingStore: GameStore = new Proxy(baseStore, {
      get(target, property) {
        if (property === 'commitCheckpoint') {
          return async (input: CheckpointCommitInputV1) => {
            if (!abortNextCommit) return target.commitCheckpoint(input);
            abortNextCommit = false;
            const decide = input.decide;
            return target.commitCheckpoint({
              ...input,
              decide(at) {
                decide(at);
                throw new Error('Injected abort after fenced decision.');
              },
            });
          };
        }
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store: abortingStore,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 3_000 },
      });
      const started = await controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: initial.fence,
      });
      if (started.kind !== 'model-turn-started') throw new Error('The model turn did not start.');

      decisionTimeMs = 12_010;
      monotonicMs = 15_010;
      abortNextCommit = true;
      await expect(controller.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: started.request.fence,
        move: { from: 'e2', to: 'e4' },
      })).rejects.toMatchObject({ code: 'transaction-aborted' });

      const local = controller.snapshot();
      const saved = await baseStore.readGame(testId);
      expect(local.checkpoint.revision).toBe(started.snapshot.checkpoint.revision);
      expect(saved?.checkpoint.revision).toBe(started.snapshot.checkpoint.revision);
      expect(local.checkpoint.rules.moves).toHaveLength(0);
      expect(saved?.events.map((event) => event.kind)).toEqual(['game-created', 'model-turn-started']);
      expect(local.clockReading?.remaining).toEqual({ whiteMs: 29_990, blackMs: 30_000 });
    } finally {
      baseStore.close();
    }
  });

  it('reconciles elapsed absence before enabling a restored active game', async () => {
    const testId = 'controller-restore-clock-recovery';
    const factory = new IDBFactory();
    let decisionTimeMs = 1_000;
    let monotonicMs = 5_000;
    const store = await openGameStore({
      databaseName: testId,
      factory,
      now: () => decisionTimeMs,
    });
    let generatedId = 0;
    const firstController = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs, hostOffsetMs: 200 };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await firstController.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 3_000 },
      });
      const oldRequest = await firstController.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: initial.fence,
      });
      if (oldRequest.kind !== 'model-turn-started') throw new Error('The first model turn did not start.');
      store.close();

      vi.resetModules();
      decisionTimeMs = 21_000;
      monotonicMs = 100;
      const restoredStore = await openGameStore({
        databaseName: testId,
        factory,
        now: () => decisionTimeMs,
      });
      const controllerModule = await import('./index.js');
      const restoredController = controllerModule.getOrCreateGameController({
        gameId: testId,
        store: restoredStore,
        timeSource: {
          sample(atDecisionTimeMs) {
            return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs, hostOffsetMs: 200 };
          },
        },
        clockPolicy: { maxReferenceDivergenceMs: 0 },
        idFactory: () => `${testId}-restored-${++generatedId}`,
      });

      const restored = await restoredController.initialize();
      expect(restored.readiness).toBe('restore-recovery-pending');
      expect(restored.clockReading?.remaining).toEqual({ whiteMs: 10_000, blackMs: 30_000 });
      const beforeRecovery = await restoredController.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: oldRequest.request.fence,
        move: { from: 'e2', to: 'e4' },
      });
      expect(beforeRecovery.kind).toBe('rejected');
      expect(beforeRecovery.snapshot.checkpoint.rules.moves).toHaveLength(0);

      const recovered = await restoredController.reconcile();
      expect(recovered.readiness).toBe('ready');
      expect(recovered.checkpoint.revision).toBe(restored.checkpoint.revision + 1);
      expect(recovered.checkpoint.clocks).toMatchObject({
        schemaVersion: 1,
        banksAtAnchor: { whiteMs: 10_000, blackMs: 30_000 },
        activeSide: 'white',
        anchor: { monotonicMs: 100, wallTimeMs: 21_000, hostOffsetMs: 200 },
      });
      expect(recovered.clockReading?.remaining).toEqual({ whiteMs: 10_000, blackMs: 30_000 });
      const saved = await restoredStore.readGame(testId);
      expect(saved?.events.at(-1)).toMatchObject({
        kind: 'clock-absence-reconciled',
        occurredAtMs: 21_000,
      });
      expect(saved?.checkpoint.rules.moves).toHaveLength(0);
      restoredStore.close();
    } finally {
      store.close();
    }
  });

  it('keeps restored clock recovery enabled after an aborted and persisted discrepancy', async () => {
    const testId = 'controller-restored-clock-discrepancy-recovery';
    const factory = new IDBFactory();
    const firstStore = await openGameStore({
      databaseName: testId,
      factory,
      now: () => 1_000,
    });
    let generatedId = 0;
    const firstController = getOrCreateGameController({
      gameId: testId,
      store: firstStore,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs: 5_000, wallTimeMs: atDecisionTimeMs ?? 1_000 };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await firstController.initialize({
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
      });
      expect(initial.checkpoint.clocks.anchor).toEqual({ monotonicMs: 5_000, wallTimeMs: 1_000 });
      firstStore.close();

      vi.resetModules();
      let decisionTimeMs = 500;
      const monotonicMs = 100;
      let wallTimeMs = 500;
      const resumedBaseStore = await openGameStore({
        databaseName: testId,
        factory,
        now: () => decisionTimeMs,
      });
      let abortNextCommit = false;
      const resumedStore: GameStore = new Proxy(resumedBaseStore, {
        get(target, property) {
          if (property === 'commitCheckpoint') {
            return async (input: CheckpointCommitInputV1) => {
              if (!abortNextCommit) return target.commitCheckpoint(input);
              abortNextCommit = false;
              const decide = input.decide;
              return target.commitCheckpoint({
                ...input,
                decide(at) {
                  decide(at);
                  throw new Error('Injected abort after fenced decision.');
                },
              });
            };
          }
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
      const controllerModule = await import('./index.js');
      const resumedController = controllerModule.getOrCreateGameController({
        gameId: testId,
        store: resumedStore,
        timeSource: {
          sample(atDecisionTimeMs) {
            return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? wallTimeMs };
          },
        },
        clockPolicy: { maxReferenceDivergenceMs: 0 },
        idFactory: () => `${testId}-resumed-${++generatedId}`,
      });

      try {
        const restored = await resumedController.initialize();
        expect(restored.readiness).toBe('clock-reconciliation-required');
        expect(restored.clockReading).toMatchObject({
          status: 'reconciliation-required',
          reason: 'wall-clock-regression',
          evidence: {
            anchor: { monotonicMs: 5_000, wallTimeMs: 1_000 },
            observedAt: { monotonicMs: 100, wallTimeMs: 500 },
          },
        });

        abortNextCommit = true;
        await expect(resumedController.dispatch({
          schemaVersion: 1,
          kind: 'human-move',
          fence: restored.fence,
          move: { from: 'e2', to: 'e4' },
        })).rejects.toMatchObject({ code: 'transaction-aborted' });
        const afterAbort = await resumedBaseStore.readGame(testId);
        expect(afterAbort?.checkpoint.revision).toBe(restored.checkpoint.revision);
        expect(afterAbort?.checkpoint.rules.moves).toHaveLength(0);
        expect(afterAbort?.events.map((event) => event.kind)).toEqual(['game-created']);
        expect(resumedController.snapshot().readiness).toBe('clock-reconciliation-required');

        decisionTimeMs = 21_000;
        wallTimeMs = 21_000;
        const blocked = await resumedController.dispatch({
          schemaVersion: 1,
          kind: 'human-move',
          fence: restored.fence,
          move: { from: 'e2', to: 'e4' },
        });
        expect(blocked.kind).toBe('clock-reconciliation-required');
        expect(blocked.snapshot.checkpoint.rules.moves).toHaveLength(0);
        const savedDiscrepancy = await resumedBaseStore.readGame(testId);
        expect(savedDiscrepancy?.events.map((event) => event.kind)).toEqual([
          'game-created',
          'clock-reconciliation-required',
        ]);
        expect(savedDiscrepancy?.events.at(-1)).toMatchObject({
          kind: 'clock-reconciliation-required',
          occurredAtMs: 21_000,
          payload: {
            details: {
              reason: 'wall-clock-regression',
              evidence: {
                anchor: { monotonicMs: 5_000, wallTimeMs: 1_000 },
                observedAt: { monotonicMs: 100, wallTimeMs: 500 },
              },
            },
          },
        });

        const recovered = await resumedController.reconcile();
        expect(recovered.readiness).toBe('ready');
        expect(recovered.checkpoint.rules.moves).toHaveLength(0);
        expect(recovered.checkpoint.clocks).toMatchObject({
          banksAtAnchor: { whiteMs: 10_000, blackMs: 30_000 },
          activeSide: 'white',
          anchor: { monotonicMs: 100, wallTimeMs: 21_000 },
        });
        const savedRecovery = await resumedBaseStore.readGame(testId);
        expect(savedRecovery?.events.map((event) => event.kind)).toEqual([
          'game-created',
          'clock-reconciliation-required',
          'clock-absence-reconciled',
        ]);
        expect(savedRecovery?.events.at(-1)).toMatchObject({
          kind: 'clock-absence-reconciled',
          occurredAtMs: 21_000,
          payload: { details: { elapsedChargedMs: 20_000 } },
        });
      } finally {
        resumedBaseStore.close();
      }
    } finally {
      firstStore.close();
    }
  });

  it('latches a checkmate result and rejects later human or model actions', async () => {
    const testId = 'controller-final-checkmate-latch';
    let decisionTimeMs = 40_000;
    let monotonicMs = 50_000;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      let state = await controller.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        startingFen: 'rnbqkbnr/pppp1p1p/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2',
        timeControl: { startingTimeMs: 60_000, incrementMs: 0 },
      });
      decisionTimeMs += 1_000;
      monotonicMs += 1_000;
      const mate = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: state.fence,
        move: { from: 'd8', to: 'h4' },
      });
      expect(mate.kind).toBe('accepted');
      state = mate.snapshot;

      expect(state.checkpoint.result).toEqual({
        kind: 'final',
        winner: 'black',
        reason: 'checkmate',
        eventId: state.checkpoint.rules.moves.at(-1)?.eventId,
        decidedAtMs: decisionTimeMs,
      });
      expect(state.checkpoint.rules.moves.map((move) => move.san)).toEqual(['Qh4#']);

      const lateMove = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: state.fence,
        move: { from: 'f3', to: 'f4' },
      });
      expect(lateMove).toMatchObject({ kind: 'rejected', reason: 'not-actionable' });
      expect(lateMove.snapshot.checkpoint.result).toEqual(state.checkpoint.result);
      expect(lateMove.snapshot.checkpoint.revision).toBe(state.checkpoint.revision);

      const saved = await store.readGame(testId);
      expect(saved?.checkpoint.result).toEqual(state.checkpoint.result);
      expect(saved?.events.at(-1)).toMatchObject({ kind: 'human-move-accepted' });
    } finally {
      store.close();
    }
  });

  it('records stalemate as a distinct final draw and keeps the result immutable', async () => {
    const testId = 'controller-final-stalemate';
    let decisionTimeMs = 80_000;
    let monotonicMs = 90_000;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => decisionTimeMs,
    });
    let generatedId = 0;
    const controller = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await controller.initialize({
        humanSide: 'white',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        startingFen: '7k/8/6K1/5Q2/8/8/8/8 w - - 0 1',
        timeControl: { startingTimeMs: 60_000, incrementMs: 0 },
      });
      decisionTimeMs += 1_000;
      monotonicMs += 1_000;
      const accepted = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: initial.fence,
        move: { from: 'f5', to: 'f7' },
      });

      expect(accepted.kind).toBe('accepted');
      expect(accepted.snapshot.checkpoint.result).toEqual({
        kind: 'final',
        winner: 'draw',
        reason: 'stalemate',
        eventId: accepted.snapshot.checkpoint.rules.moves.at(-1)?.eventId,
        decidedAtMs: decisionTimeMs,
      });
      expect(accepted.snapshot.position.fen).toBe('7k/5Q2/6K1/8/8/8/8/8 b - - 1 1');
      expect(accepted.snapshot.clockReading).toBeNull();
      expect(accepted.snapshot.checkpoint.clocks).toMatchObject({
        schemaVersion: 1,
        activeSide: null,
        anchor: null,
        banksAtAnchor: { whiteMs: 59_000, blackMs: 60_000 },
      });

      const laterAction = await controller.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: accepted.snapshot.fence,
        move: { from: 'h8', to: 'h7' },
      });
      expect(laterAction).toMatchObject({ kind: 'rejected', reason: 'not-actionable' });
      expect(laterAction.snapshot.checkpoint.result).toEqual(accepted.snapshot.checkpoint.result);

      const saved = await store.readGame(testId);
      expect(saved?.checkpoint.result).toEqual(accepted.snapshot.checkpoint.result);
      expect(saved?.checkpoint.clocks).toMatchObject({ activeSide: null, anchor: null });
      expect(saved?.events.at(-1)).toMatchObject({
        kind: 'human-move-accepted',
        occurredAtMs: decisionTimeMs,
        payload: {
          details: {
            clock: {
              elapsedChargedMs: 1_000,
              incrementCredit: { side: 'white', milliseconds: 0 },
              nextAnchor: { wallTimeMs: decisionTimeMs },
            },
          },
        },
      });
    } finally {
      store.close();
    }
  });

  it('persists an expired restored clock at its old deadline without replaying a move', async () => {
    const testId = 'controller-restore-expired-no-replay';
    const factory = new IDBFactory();
    let decisionTimeMs = 1_000;
    let monotonicMs = 5_000;
    const store = await openGameStore({
      databaseName: testId,
      factory,
      now: () => decisionTimeMs,
    });
    let generatedId = 0;
    const firstController = getOrCreateGameController({
      gameId: testId,
      store,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await firstController.initialize({
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 3_000 },
      });
      const oldRequest = await firstController.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: initial.fence,
      });
      if (oldRequest.kind !== 'model-turn-started') throw new Error('The model turn did not start.');
      store.close();

      vi.resetModules();
      decisionTimeMs = 41_000;
      monotonicMs = 100;
      const restoredStore = await openGameStore({
        databaseName: testId,
        factory,
        now: () => decisionTimeMs,
      });
      const controllerModule = await import('./index.js');
      const restoredController = controllerModule.getOrCreateGameController({
        gameId: testId,
        store: restoredStore,
        timeSource: {
          sample(atDecisionTimeMs) {
            return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
          },
        },
        clockPolicy: { maxReferenceDivergenceMs: 0 },
        idFactory: () => `${testId}-restored-${++generatedId}`,
        adjudicationRunner: heldAdjudicationRunner,
      });
      const restored = await restoredController.initialize();
      expect(restored.readiness).toBe('expiry-persistence-pending');
      expect(restored.checkpoint.rules.moves).toHaveLength(0);
      expect(restored.checkpoint.result).toEqual({ kind: 'unresolved' });

      const reconciled = await restoredController.reconcile();
      expect(reconciled.checkpoint.rules.moves).toHaveLength(0);
      expect(reconciled.checkpoint.result).toMatchObject({
        kind: 'pending-adjudication',
        reason: 'timeout',
        eventAtMs: 31_000,
      });
      expect(reconciled.clockReading).toBeNull();
      const oldReply = await restoredController.dispatch({
        schemaVersion: 1,
        kind: 'model-move',
        fence: oldRequest.request.fence,
        move: { from: 'e2', to: 'e4' },
      });
      expect(oldReply.kind).toBe('rejected');
      expect(oldReply.snapshot.checkpoint.rules.moves).toHaveLength(0);
      const saved = await restoredStore.readGame(testId);
      expect(saved?.events.map((event) => event.kind)).toEqual([
        'game-created',
        'model-turn-started',
        'timeout-candidate',
      ]);
      expect(saved?.events.at(-1)).toMatchObject({
        kind: 'timeout-candidate',
        occurredAtMs: 31_000,
        payload: { details: { decisionTimeMs: 41_000 } },
      });
      restoredStore.close();
    } finally {
      store.close();
    }
  });
});
