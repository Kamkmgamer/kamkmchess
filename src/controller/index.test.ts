import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { CoordinateMove } from '../rules/index.js';
import { createTurnBudgets, decideModelTurn } from '../moves/index.js';
import type { ModelTurnDecision } from '../moves/index.js';
import { validateGameArchive } from '../archive/index.js';
import { openGameStore } from '../storage/index.js';
import { getOrCreateGameController, modelConfigurationIdentity, prepareOwnershipTakeover } from './index.js';
import { checkProofEvidence, PROOF_CHECKER_VERSION, RULES_ADAPTER_VERSION, runProofSearchPass } from '../proofs/index.js';
import type { ProofEvidence, ProofQuery, ProofSearchPassResult } from '../proofs/index.js';
import type {
  ControllerFenceV1,
  ControllerSnapshotV1,
  ControllerTimeSource,
  GameControllerIntentV1,
  GameControllerSetupV1,
  ModelSelection,
} from './index.js';
import type { CheckpointCommitInputV1, GameCheckpointV1, GameStore } from '../storage/index.js';

function knownInitialDeadnessWitness(query: ProofQuery): ProofSearchPassResult | null {
  const witnessByFenPrefix: ReadonlyArray<{ prefix: string; intendedColor: 'w' | 'b'; moves: CoordinateMove[] }> = [
    {
      prefix: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', intendedColor: 'b',
      moves: [{ from: 'f2', to: 'f3' }, { from: 'e7', to: 'e5' }, { from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' }],
    },
    {
      prefix: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq -', intendedColor: 'b',
      moves: [{ from: 'e7', to: 'e5' }, { from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' }],
    },
    {
      prefix: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq e6', intendedColor: 'b',
      moves: [{ from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' }],
    },
    {
      prefix: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPP2P1/RNBQKBNR b KQkq g3', intendedColor: 'b',
      moves: [{ from: 'd8', to: 'h4' }],
    },
    {
      prefix: '7k/8/6K1/5Q2/8/8/8/8 w - -', intendedColor: 'w',
      moves: [{ from: 'f5', to: 'f8' }],
    },
  ];
  const witness = witnessByFenPrefix.find((item) => query.positionFen.startsWith(item.prefix));
  if (!witness) return null;
  const evidence: ProofEvidence = {
    schemaVersion: 1,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    queryIdentity: query.queryIdentity,
    kind: 'mate-witness',
    intendedColor: witness.intendedColor,
    moves: witness.moves,
  };
  const checked = checkProofEvidence(query, evidence);
  if (checked.status !== 'accepted') return null;
  return {
    status: 'accepted',
    conclusion: checked.conclusion,
    queryIdentity: query.queryIdentity,
    evidence,
    checkpointDisposition: 'fresh',
    pass: { maxDiscoveredStates: 0, timeBudgetMs: 0, discoveredStateCount: 0,
      processedEdgeCount: 0, expandedStateCount: 0, totalDiscoveredStateCount: 0,
      totalDiscoveredEdgeCount: 0, elapsedMs: 0 },
  };
}

async function settlePendingAdjudication(
  controller: ReturnType<typeof getOrCreateGameController>,
  initial: ControllerSnapshotV1,
): Promise<ControllerSnapshotV1> {
  let snapshot = initial;
  for (let attempt = 0; attempt < 8 && snapshot.adjudication.status !== 'none' && snapshot.adjudication.status !== 'setup-ready'; attempt += 1) {
    const work = await controller.continueAdjudication(snapshot.fence);
    if (work === null) throw new Error('The pending adjudication did not start.');
    const result = knownInitialDeadnessWitness(work.query) ?? await runProofSearchPass(work.query, {
          checkpoint: work.searchCheckpoint ?? undefined,
          maxDiscoveredStates: 10_000,
          timeBudgetMs: 5_000,
        });
    snapshot = await controller.acceptAdjudicationResult({
      requestId: work.requestId,
      fence: work.fence,
      query: work.query,
      result,
    });
  }
  if (snapshot.adjudication.status !== 'none' && snapshot.adjudication.status !== 'setup-ready') {
    throw new Error('The fixture did not produce checked adjudication evidence within eight explicit passes.');
  }
  return snapshot;
}

async function initializePlayable(
  controller: ReturnType<typeof getOrCreateGameController>,
  setup: GameControllerSetupV1,
): Promise<ControllerSnapshotV1> {
  const initialized = await controller.initialize(setup);
  const adjudicated = initialized.adjudication.status === 'queued'
    ? await settlePendingAdjudication(controller, initialized)
    : initialized;
  return adjudicated.adjudication.status === 'setup-ready'
    ? controller.startGame(adjudicated.fence, setup.modelSelection)
    : adjudicated;
}

const model: ModelSelection = {
  kind: 'model',
  providerId: 'openrouter',
  connectionId: 'connection-primary',
  configurationRevision: 7,
  modelRoutingId: 'My/Model:latest',
  protocol: 'chat-completions',
  diagnostic: 'passed-current-session',
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

describe('queued model handoff', () => {
  it('scopes controller single-writer registration by stable namespace and game ID', async () => {
    const testId = 'controller-registry-scope';
    const factory = new IDBFactory();
    const guestStore = await openGameStore({ databaseName: `${testId}-guest`, factory });
    const accountStore = await openGameStore({ databaseName: `${testId}-account`, factory });
    const options = { gameId: 'preserved-game-id', timeSource: { sample(at?: number) {
      return { monotonicMs: at ?? 1_000, wallTimeMs: at ?? 1_000 };
    } }, clockPolicy: { maxReferenceDivergenceMs: 0 } };
    try {
      const guest = getOrCreateGameController({ positionChecks: 'legacy-proof', ...options, registryScope: JSON.stringify({ kind: 'guest' }), store: guestStore });
      const account = getOrCreateGameController({ positionChecks: 'legacy-proof', ...options, registryScope: JSON.stringify({ kind: 'account', accountId: 'account-1' }), store: accountStore });
      expect(account).not.toBe(guest);
      expect(() => getOrCreateGameController({ positionChecks: 'legacy-proof', ...options, registryScope: JSON.stringify({ kind: 'guest' }), store: accountStore }))
        .toThrow(/cannot be rebound/);
    } finally {
      guestStore.close();
      accountStore.close();
    }
  });

  it('rebinds cloud checkpoint ownership and rejects a prior-owner request fence', async () => {
    const testId = 'controller-ownership-takeover';
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => 2_000 });
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId, registryScope: 'old-owner', store,
      timeSource: { sample(at) { return { monotonicMs: at ?? 2_000, wallTimeMs: at ?? 2_000 }; } },
      clockPolicy: { maxReferenceDivergenceMs: 0 }, idFactory: (() => { let id = 0; return () => `${testId}-${++id}`; })(),
    });
    try {
      const ready = await initializePlayable(controller, {
        humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
      });
      const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: ready.fence });
      if (started.kind !== 'model-turn-started') throw new Error('Expected a request under the old owner.');
      const checkpointBefore = started.snapshot.checkpoint;
      const adopted = prepareOwnershipTakeover(checkpointBefore, 1);
      expect(adopted.ownershipEpoch).toBe(1);
      expect(adopted.requestGeneration).toBe(checkpointBefore.requestGeneration + 1);
      expect(adopted.analysisGeneration).toBe(checkpointBefore.analysisGeneration + 1);
      expect(adopted.rules).toEqual(checkpointBefore.rules);
      expect(adopted.history).toEqual(checkpointBefore.history);
      expect(adopted.clocks).toEqual(checkpointBefore.clocks);
      expect(adopted.result).toEqual(checkpointBefore.result);
      expect(adopted.extensions['model-handoff']?.data).toMatchObject({ producing: null });
      const committed = await store.commitCheckpoint({ gameId: testId, expectedRevision: checkpointBefore.revision,
        expectedEpoch: checkpointBefore.ownershipEpoch, events: [], chunks: [], knownCredentials: [],
        decide: () => ({ checkpoint: adopted, events: [], outboxOperationIds: [] }) });
      expect(committed.kind).toBe('committed');
      const nextOwner = getOrCreateGameController({ positionChecks: 'legacy-proof',
        gameId: testId, registryScope: 'new-owner', store,
        timeSource: { sample(at) { return { monotonicMs: at ?? 2_000, wallTimeMs: at ?? 2_000 }; } },
        clockPolicy: { maxReferenceDivergenceMs: 0 },
      });
      const restored = await nextOwner.initialize();
      expect(restored.checkpoint.ownershipEpoch).toBe(1);
      expect(restored.fence.requestGeneration).toBe(started.request.fence.requestGeneration + 1);
      const stale = await nextOwner.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: started.request.fence });
      expect(stale).toMatchObject({ kind: 'rejected', reason: 'stale-fence' });
    } finally {
      store.close();
    }
  });

  it('keeps a failed candidate blocked until the user resumes the prior model', async () => {
    const testId = 'controller-candidate-failure-resume';
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => 2_000 });
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId, store, timeSource: { sample(at) { return { monotonicMs: at ?? 2_000, wallTimeMs: at ?? 2_000 }; } },
      clockPolicy: { maxReferenceDivergenceMs: 0 }, idFactory: (() => { let id = 0; return () => `${testId}-${++id}`; })(),
    });
    try {
      let snapshot = await initializePlayable(controller, {
        humanSide: 'white', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
      });
      const candidate: ModelSelection = { ...model, providerId: 'anthropic', connectionId: 'connection-anthropic',
        configurationRevision: 8, modelRoutingId: 'claude/test', protocol: 'messages' };
      snapshot = await controller.queueModelSelection(snapshot.fence, candidate);
      expect(snapshot.modelHandoff.queued).toMatchObject({ selection: candidate, state: 'queued' });
      const humanMove = await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: snapshot.fence,
        move: { from: 'e2', to: 'e4' } });
      expect(humanMove.kind).toBe('accepted');
      if (humanMove.kind !== 'accepted') throw new Error('Expected the human move while the candidate was queued.');
      snapshot = await settlePendingAdjudication(controller, humanMove.snapshot);
      const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: snapshot.fence });
      if (started.kind !== 'model-turn-started') throw new Error('Expected the candidate model request to start.');
      expect(started.request.selection).toMatchObject(candidate);
      const formattingFailure = decideModelTurn({ budgets: createTurnBudgets(), position: started.request.position,
        classification: { kind: 'format-failure', reason: 'no-action', fragment: '', retainedFields: [] },
        modelConfigurationIdentity: started.request.fence.modelConfigurationIdentity });
      expect(formattingFailure.kind).toBe('format-correction');
      if (formattingFailure.kind !== 'format-correction') throw new Error('Expected a terminal format failure.');
      const failed = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence: started.request.fence, effect: formattingFailure });
      expect(failed.kind).toBe('accepted');
      expect(failed.snapshot.modelHandoff.queued).toMatchObject({ selection: candidate, state: 'failed' });
      const retriedCandidate = await controller.retryModelSelection(failed.snapshot.fence);
      const candidateRetry = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: retriedCandidate.fence });
      if (candidateRetry.kind !== 'model-turn-started') throw new Error('Expected the candidate retry to start.');
      const providerFailed = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-interrupted', fence: candidateRetry.request.fence, reason: 'failed' });
      expect(providerFailed.kind).toBe('accepted');
      expect(providerFailed.snapshot.modelHandoff.queued).toMatchObject({ selection: candidate, state: 'failed' });
      snapshot = await controller.resumePriorModel(providerFailed.snapshot.fence);
      expect(snapshot.modelHandoff.committed).toMatchObject(model);
      expect(snapshot.modelHandoff.queued).toBeNull();
      const retry = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: snapshot.fence });
      expect(retry.kind).toBe('model-turn-started');
      if (retry.kind !== 'model-turn-started') throw new Error('Expected the prior model to resume.');
      expect(retry.request.selection).toMatchObject(model);
      const stoppedPrior = await controller.dispatch({ schemaVersion: 1, kind: 'stop-model-turn', fence: retry.request.fence });
      expect(stoppedPrior.kind).toBe('accepted');
      if (stoppedPrior.kind !== 'accepted') throw new Error('Expected the prior request to stop.');
      const queuedAgain = await controller.queueModelSelection(stoppedPrior.snapshot.fence, candidate);
      const candidateStarted = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: queuedAgain.fence });
      if (candidateStarted.kind !== 'model-turn-started') throw new Error('Expected the queued candidate request to start.');
      const stoppedCandidate = await controller.dispatch({ schemaVersion: 1, kind: 'stop-model-turn', fence: candidateStarted.request.fence });
      expect(stoppedCandidate.kind).toBe('accepted');
      expect(stoppedCandidate.snapshot.modelHandoff.producing).toBeNull();
      expect(stoppedCandidate.snapshot.modelHandoff.queued).toMatchObject({ selection: candidate, state: 'failed' });
    } finally {
      store.close();
    }
  });

  it('queues on the human turn and promotes only after the candidate legal reply', async () => {
    const testId = 'controller-queue-on-human-turn';
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => 2_000 });
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId, store, timeSource: { sample(at) { return { monotonicMs: at ?? 2_000, wallTimeMs: at ?? 2_000 }; } },
      clockPolicy: { maxReferenceDivergenceMs: 0 }, idFactory: (() => { let id = 0; return () => `${testId}-${++id}`; })(),
    });
    try {
      let snapshot = await initializePlayable(controller, {
        humanSide: 'white', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
      });
      const candidate: ModelSelection = { ...model, providerId: 'anthropic', connectionId: 'connection-anthropic',
        configurationRevision: 8, modelRoutingId: 'claude/test', protocol: 'messages' };
      snapshot = await controller.queueModelSelection(snapshot.fence, candidate);
      expect(snapshot.modelHandoff).toMatchObject({ committed: model, producing: null, queued: { selection: candidate, state: 'queued' } });
      const humanMove = await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: snapshot.fence,
        move: { from: 'e2', to: 'e4' } });
      expect(humanMove.kind).toBe('accepted');
      if (humanMove.kind !== 'accepted') throw new Error('Expected the human move to commit.');
      snapshot = await settlePendingAdjudication(controller, humanMove.snapshot);
      const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: snapshot.fence });
      if (started.kind !== 'model-turn-started') throw new Error('Expected the queued candidate turn to start.');
      expect(started.request.selection).toMatchObject(candidate);
      expect(started.snapshot.modelHandoff.committed).toMatchObject(model);
      const reply = decideModelTurn({ budgets: createTurnBudgets(), position: started.request.position,
        classification: { kind: 'move', move: { from: 'e7', to: 'e5' }, text: 'e7e5', origin: 'json-move', retainedFields: [] },
        modelConfigurationIdentity: started.request.fence.modelConfigurationIdentity });
      expect(reply.kind).toBe('accepted-move');
      if (reply.kind !== 'accepted-move') throw new Error('Expected the candidate reply to be legal.');
      const applied = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence: started.request.fence, effect: reply });
      expect(applied.kind).toBe('accepted');
      expect(applied.snapshot.modelHandoff.committed).toMatchObject(candidate);
      expect(applied.snapshot.modelHandoff.queued).toBeNull();
    } finally {
      store.close();
    }
  });

  it('replaces a cross-provider candidate while an old-model request completes under its original selection', async () => {
    const testId = 'controller-queued-model-handoff';
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => 2_000 });
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId, store, timeSource: { sample(at) { return { monotonicMs: at ?? 2_000, wallTimeMs: at ?? 2_000 }; } },
      clockPolicy: { maxReferenceDivergenceMs: 0 }, idFactory: (() => { let id = 0; return () => `${testId}-${++id}`; })(),
    });
    try {
      const snapshot = await initializePlayable(controller, {
        humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
      });
      const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: snapshot.fence });
      if (started.kind !== 'model-turn-started') throw new Error('Expected the prior model request to start.');
      const candidateA: ModelSelection = { ...model, providerId: 'anthropic', connectionId: 'connection-anthropic',
        configurationRevision: 8, modelRoutingId: 'claude/test', protocol: 'messages' };
      const candidateB: ModelSelection = { ...model, providerId: 'openai', connectionId: 'connection-openai',
        configurationRevision: 4, modelRoutingId: 'gpt-test', protocol: 'responses' };
      let current = await controller.queueModelSelection(controller.snapshot().fence, candidateA);
      expect(current.modelHandoff).toMatchObject({ committed: model, producing: model, queued: { selection: candidateA, state: 'queued' } });
      current = await controller.queueModelSelection(current.fence, candidateB);
      expect(current.modelHandoff.queued?.selection).toMatchObject(candidateB);
      const savedFence = await controller.appendModelTurnArchive(started.request.fence, {
        kind: 'terminal', requestId: 'old-model-request', outcome: 'complete', details: {},
        messages: [{ role: 'assistant', content: 'e2e4' }],
      });
      expect(savedFence).not.toBeNull();
      const effect = decideModelTurn({ budgets: createTurnBudgets(), position: started.request.position,
        classification: { kind: 'move', move: { from: 'e2', to: 'e4' }, text: 'e2e4', origin: 'json-move', retainedFields: [] },
        modelConfigurationIdentity: started.request.fence.modelConfigurationIdentity });
      expect(effect.kind).toBe('accepted-move');
      if (effect.kind !== 'accepted-move' || savedFence === null) throw new Error('Expected the old model reply to be interpretable.');
      const applied = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence: savedFence, effect });
      expect(applied.kind).toBe('accepted');
      expect(applied.snapshot.modelHandoff.committed).toMatchObject(model);
      expect(applied.snapshot.modelHandoff.queued?.selection).toMatchObject(candidateB);
      expect(applied.snapshot.modelHandoff.producing).toBeNull();
      const priorReady = await settlePendingAdjudication(controller, applied.snapshot);
      const humanMove = await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: priorReady.fence,
        move: { from: 'e7', to: 'e5' } });
      expect(humanMove.kind).toBe('accepted');
      if (humanMove.kind !== 'accepted') throw new Error('Expected the human reply to be accepted.');
      const ready = await settlePendingAdjudication(controller, humanMove.snapshot);
      const candidateTurn = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: ready.fence });
      expect(candidateTurn.kind).toBe('model-turn-started');
      if (candidateTurn.kind !== 'model-turn-started') throw new Error('Expected the queued model to produce the next turn.');
      expect(candidateTurn.request.selection).toMatchObject(candidateB);
      const candidateEffect = decideModelTurn({ budgets: createTurnBudgets(), position: candidateTurn.request.position,
        classification: { kind: 'move', move: { from: 'g1', to: 'f3' }, text: 'g1f3', origin: 'json-move', retainedFields: [] },
        modelConfigurationIdentity: candidateTurn.request.fence.modelConfigurationIdentity });
      expect(candidateEffect.kind).toBe('accepted-move');
      if (candidateEffect.kind !== 'accepted-move') throw new Error('Expected an interpretable candidate reply.');
      const promoted = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence: candidateTurn.request.fence, effect: candidateEffect });
      expect(promoted.kind).toBe('accepted');
      expect(promoted.snapshot.modelHandoff.committed).toMatchObject(candidateB);
      expect(promoted.snapshot.modelHandoff.queued).toBeNull();
      expect(promoted.snapshot.checkpoint.history.segments.at(-1)).toMatchObject({ providerId: 'openai', modelRoutingId: 'gpt-test' });
    } finally {
      store.close();
    }
  });
});

describe('game controller setup', () => {
  it('runs a local two-human game through the same committed controller transitions', async () => {
    const testId = 'controller-local-two-human';
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => 1_000 });
    let generatedId = 0;
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId,
      store,
      timeSource: { sample: (decisionTimeMs) => ({ monotonicMs: 5_000, wallTimeMs: decisionTimeMs ?? 1_000 }) },
      clockPolicy: { maxReferenceDivergenceMs: 5 },
      idFactory: () => `controller-local-two-human-${++generatedId}`,
    });
    try {
      const setup: GameControllerSetupV1 = {
        humanSide: 'white',
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
      };
      const initial = await controller.initialize(setup);
      expect(initial.checkpoint.selections.players).toEqual({ white: { kind: 'human' }, black: { kind: 'human' } });
      const ready = await settlePendingAdjudication(controller, initial);
      const started = await controller.startGame(ready.fence);
      expect(started.clockReading?.status).toBe('running');
      expect(started.checkpoint.history.segments[0]).toMatchObject({
        providerId: null,
        modelRoutingId: null,
        connectionRevision: null,
      });

      const whiteMove = await controller.dispatch({
        schemaVersion: 1,
        kind: 'human-move',
        fence: started.fence,
        move: { from: 'e2', to: 'e4' },
      });
      expect(whiteMove.kind).toBe('accepted');
      expect(whiteMove.snapshot.checkpoint.rules.moves.map((move) => move.san)).toEqual(['e4']);
      expect(whiteMove.snapshot.checkpoint.result.kind).toBe('pending-adjudication');
    } finally {
      store.close();
    }
  });

  it('classifies setup with checked evidence before diagnostics or clocks', async () => {
    const testId = 'controller-setup-adjudication-order';
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => 1_000 });
    let generatedId = 0;
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId,
      store,
      timeSource: { sample: (decisionTimeMs) => ({ monotonicMs: 5_000, wallTimeMs: decisionTimeMs ?? 1_000 }) },
      clockPolicy: { maxReferenceDivergenceMs: 5 },
      idFactory: () => `controller-setup-adjudication-${++generatedId}`,
    });
    try {
      const setup = {
        humanSide: 'white' as const,
        modelSelection: { ...model, diagnostic: 'not-run' as const },
        namespace: { kind: 'guest' as const },
        ownershipEpoch: 0,
      };
      const initial = await controller.initialize(setup);
      expect(initial.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position' });
      expect(initial.checkpoint.clocks.activeSide).toBeNull();
      expect(initial.adjudication.status).toBe('queued');

      const work = await controller.continueAdjudication(initial.fence);
      if (work === null) throw new Error('Setup adjudication did not start.');
      const evidence: ProofEvidence = {
        schemaVersion: 1,
        proofCheckerVersion: PROOF_CHECKER_VERSION,
        rulesAdapterVersion: RULES_ADAPTER_VERSION,
        queryIdentity: work.query.queryIdentity,
        kind: 'mate-witness' as const,
        intendedColor: 'b' as const,
        moves: [
          { from: 'f2', to: 'f3' },
          { from: 'e7', to: 'e5' },
          { from: 'g2', to: 'g4' },
          { from: 'd8', to: 'h4' },
        ],
      };
      const started = await controller.acceptAdjudicationResult({
        requestId: work.requestId,
        fence: work.fence,
        query: work.query,
        result: {
          status: 'accepted',
          conclusion: 'not-dead',
          queryIdentity: work.query.queryIdentity,
          evidence,
          checkpointDisposition: 'fresh',
          pass: { maxDiscoveredStates: 0, timeBudgetMs: 0, discoveredStateCount: 0,
            processedEdgeCount: 0, expandedStateCount: 0, totalDiscoveredStateCount: 0,
            totalDiscoveredEdgeCount: 0, elapsedMs: 0 },
        },
      });
      expect(started.checkpoint.clocks.activeSide).toBeNull();
      expect(started.adjudication.status).toBe('setup-ready');

      const playable = await controller.startGame(started.fence, model);
      expect(playable.checkpoint.result).toEqual({ kind: 'unresolved' });
      expect(playable.checkpoint.clocks.activeSide).toBe('white');
    } finally {
      store.close();
    }
  });

  it('keeps an in-game deadness candidate ahead of a later timeout candidate', async () => {
    const testId = 'controller-pending-ordering';
    let monotonicMs = 5_000;
    let wallTimeMs = 1_000;
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => wallTimeMs });
    let generatedId = 0;
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId,
      store,
      timeSource: { sample: (decisionTimeMs) => ({ monotonicMs, wallTimeMs: decisionTimeMs ?? wallTimeMs }) },
      clockPolicy: { maxReferenceDivergenceMs: 5 },
      idFactory: () => `controller-pending-ordering-${++generatedId}`,
    });
    try {
      const setup = { humanSide: 'white' as const, modelSelection: model, namespace: { kind: 'guest' as const }, ownershipEpoch: 0 };
      const initial = await controller.initialize(setup);
      const work = await controller.continueAdjudication(initial.fence);
      if (work === null) throw new Error('The setup query did not start.');
      const evidence: ProofEvidence = {
        schemaVersion: 1, proofCheckerVersion: PROOF_CHECKER_VERSION, rulesAdapterVersion: RULES_ADAPTER_VERSION,
        queryIdentity: work.query.queryIdentity, kind: 'mate-witness' as const, intendedColor: 'b' as const,
        moves: [{ from: 'f2', to: 'f3' }, { from: 'e7', to: 'e5' }, { from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' }],
      };
      const classified = await controller.acceptAdjudicationResult({ requestId: work.requestId, fence: work.fence, query: work.query,
        result: { status: 'accepted', conclusion: 'not-dead', queryIdentity: work.query.queryIdentity, evidence,
          checkpointDisposition: 'fresh', pass: { maxDiscoveredStates: 0, timeBudgetMs: 0, discoveredStateCount: 0,
            processedEdgeCount: 0, expandedStateCount: 0, totalDiscoveredStateCount: 0,
            totalDiscoveredEdgeCount: 0, elapsedMs: 0 } } });
      const playing = await controller.startGame(classified.fence, model);
      const moved = await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: playing.fence,
        move: { from: 'e2', to: 'e4' } });
      expect(moved.kind).toBe('accepted');
      expect(moved.snapshot.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position' });
      expect(moved.snapshot.checkpoint.clocks.activeSide).toBe('black');
      expect(moved.snapshot.clockReading?.status).toBe('running');
      const blocked = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: moved.snapshot.fence });
      expect(blocked).toMatchObject({ kind: 'rejected', reason: 'not-actionable' });

      wallTimeMs = 901_000;
      monotonicMs = 905_000;
      const expired = await controller.reconcile();
      expect(expired.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position' });
      const candidates = expired.checkpoint.extensions.adjudication?.data as { candidates: Array<{ kind: string; eventAtMs: number; status: string }> };
      const unresolvedCandidates = candidates.candidates.filter((candidate) => candidate.status !== 'accepted');
      expect(unresolvedCandidates.map((candidate) => candidate.kind)).toEqual(['deadness', 'timeout']);
      expect(unresolvedCandidates[0]?.eventAtMs).toBeLessThan(unresolvedCandidates[1]?.eventAtMs ?? 0);
    } finally {
      store.close();
    }
  });

  it('migrates an unresolved legacy active checkpoint into checked deadness adjudication before moves', async () => {
    const testId = 'controller-legacy-active-migration';
    const factory = new IDBFactory();
    const store = await openGameStore({ databaseName: testId, factory, now: () => 1_000 });
    let generatedId = 0;
    const timeSource: ControllerTimeSource = {
      sample: (decisionTimeMs) => ({ monotonicMs: 5_000, wallTimeMs: decisionTimeMs ?? 1_000 }),
    };
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId, store, timeSource, clockPolicy: { maxReferenceDivergenceMs: 5 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const playing = await initializePlayable(controller, {
        humanSide: 'white', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
      });
      const legacyCheckpoint: GameCheckpointV1 = {
        ...playing.checkpoint,
        revision: playing.checkpoint.revision + 1,
        extensions: {},
      };
      const savedLegacy = await store.commitCheckpoint({
        gameId: testId,
        expectedRevision: playing.checkpoint.revision,
        expectedEpoch: playing.checkpoint.ownershipEpoch,
        events: [], chunks: [], knownCredentials: [],
        decide: (decisionTimeMs) => ({
          checkpoint: { ...legacyCheckpoint, updatedAtMs: decisionTimeMs },
          outboxOperationIds: [],
        }),
      });
      expect(savedLegacy.kind).toBe('committed');
      store.close();

      vi.resetModules();
      const restoredStore = await openGameStore({ databaseName: testId, factory, now: () => 1_000 });
      const controllerModule = await import('./index.js');
      const restoredController = controllerModule.getOrCreateGameController({ positionChecks: 'legacy-proof',
        gameId: testId, store: restoredStore, timeSource, clockPolicy: { maxReferenceDivergenceMs: 5 },
        idFactory: () => `${testId}-restored-${++generatedId}`,
      });
      try {
        const restored = await restoredController.initialize();
        expect(restored.checkpoint.extensions.adjudication).toBeDefined();
        expect(restored.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position' });
        expect(restored.checkpoint.clocks.activeSide).toBe('white');
        const blocked = await restoredController.dispatch({
          schemaVersion: 1, kind: 'human-move', fence: restored.fence, move: { from: 'e2', to: 'e4' },
        });
        expect(blocked).toMatchObject({ kind: 'rejected', reason: 'not-actionable' });
        const classified = await settlePendingAdjudication(restoredController, blocked.snapshot);
        expect(classified.checkpoint.result).toEqual({ kind: 'unresolved' });
        expect(classified.checkpoint.clocks.activeSide).toBe('white');
        const saved = await restoredStore.readGame(testId);
        expect(saved?.events.at(-1)).toMatchObject({ kind: 'adjudication-proof-accepted' });
      } finally {
        restoredStore.close();
      }
    } finally {
      store.close();
    }
  });

  it('starts the selected side with the persisted 15+10 clock after setup', async () => {
    const testId = 'controller-setup-default';
    let monotonicMs = 5_000;
    let wallTimeMs = 1_000;
    const store = await openGameStore({
      databaseName: testId,
      factory: new IDBFactory(),
      now: () => wallTimeMs,
    });
    let generatedId = 0;
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
    const controller = getOrCreateGameController({ ...options, positionChecks: 'legacy-proof' });
    const remountedController = getOrCreateGameController({ positionChecks: 'legacy-proof',
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

      let snapshot = controller.snapshot();
      expect(snapshot.checkpoint.revision).toBe(1);
      expect(firstInitialization.checkpoint.revision).toBe(1);
      expect(remountInitialization.checkpoint.revision).toBe(1);
      expect(snapshot.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'dead-position' });
      expect(snapshot.checkpoint.clocks.activeSide).toBeNull();
      snapshot = await settlePendingAdjudication(controller, snapshot);
      expect(snapshot.adjudication.status).toBe('setup-ready');
      snapshot = await controller.startGame(snapshot.fence, model);
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
      const expiryRevision = controller.snapshot().checkpoint.revision;
      const reconciledExpiry = await controller.reconcile();
      expect(reconciledExpiry.checkpoint.revision).toBeGreaterThan(expiryRevision);
      expect(reconciledExpiry.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'timeout', activeClockDeadlineMs: null });
      expect(reconciledExpiry.checkpoint.clocks.activeSide).toBeNull();
      expect((await store.readGame(testId))?.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'timeout' });
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      setup.modelSelection!.modelRoutingId = 'mutated/after-call';
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const snapshot = await initializePlayable(controller, {
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
        revision: 4,
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(controller, {
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
    });

    try {
      const initial = await initializePlayable(controller, {
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
      expect(accepted.snapshot.checkpoint.revision).toBe(6);
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
        'deadness-candidate-created',
        'adjudication-analysis-continued',
        'adjudication-proof-accepted',
        'game-started-after-classification',
        'model-turn-started',
        'model-move-accepted',
        'deadness-candidate-created',
      ]);
      const moveEvent = saved?.events.find((event) => event.kind === 'model-move-accepted');
      expect(moveEvent).toMatchObject({
        sequence: 6,
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

  it('[MOV-08] accepts controller effects only for the current full fence and only once', async () => {
    const testId = 'controller-move-effect-full-fence';
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => 2_000 });
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId, store, timeSource: { sample(at) { return { monotonicMs: at ?? 2_000, wallTimeMs: at ?? 2_000 }; } },
      clockPolicy: { maxReferenceDivergenceMs: 0 }, idFactory: (() => { let id = 0; return () => `${testId}-${++id}`; })(),
    });
    try {
      const snapshot = await initializePlayable(controller, {
        humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
      });
      const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: snapshot.fence });
      if (started.kind !== 'model-turn-started') throw new Error('Expected a model request.');
      const effect = decideModelTurn({
        budgets: createTurnBudgets(), position: started.request.position,
        classification: { kind: 'move', move: { from: 'e2', to: 'e4' }, text: 'e2e4', origin: 'json-move', retainedFields: [] },
        modelConfigurationIdentity: started.request.fence.modelConfigurationIdentity,
      });
      if (effect.kind !== 'accepted-move') throw new Error('Expected an accepted-move effect.');

      const staleFences: ControllerFenceV1[] = [
        { ...started.request.fence, gameId: 'another-game' },
        { ...started.request.fence, segmentId: 'another-segment' },
        { ...started.request.fence, side: 'black' },
        { ...started.request.fence, revision: started.request.fence.revision + 1 },
        { ...started.request.fence, positionRevision: started.request.fence.positionRevision + 1 },
        { ...started.request.fence, requestGeneration: started.request.fence.requestGeneration + 1 },
        { ...started.request.fence, analysisGeneration: started.request.fence.analysisGeneration + 1 },
        { ...started.request.fence, ownershipEpoch: started.request.fence.ownershipEpoch + 1 },
        { ...started.request.fence, modelConfigurationIdentity: 'another-model' },
      ];
      for (const fence of staleFences) {
        const rejected = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence, effect });
        expect(rejected).toMatchObject({ kind: 'rejected', reason: 'stale-fence' });
      }

      const accepted = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence: started.request.fence, effect });
      expect(accepted.kind).toBe('accepted');
      if (accepted.kind !== 'accepted') throw new Error('Expected the current effect to commit.');
      const duplicate = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence: started.request.fence, effect });
      expect(duplicate).toMatchObject({ kind: 'rejected', reason: 'stale-fence' });
      expect(duplicate.snapshot.checkpoint.rules.moves).toHaveLength(1);
      expect(controller.snapshot().checkpoint.rules.moves).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('persists classified illegal attempts and latches the fourth as an immutable loss', async () => {
    const testId = 'controller-classified-illegal-attempts';
    let decisionTimeMs = 2_000;
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => decisionTimeMs });
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId, store, timeSource: { sample(at) { return { monotonicMs: at ?? decisionTimeMs, wallTimeMs: at ?? decisionTimeMs }; } },
      clockPolicy: { maxReferenceDivergenceMs: 0 }, idFactory: (() => { let id = 0; return () => `${testId}-${++id}`; })(),
    });
    try {
      let snapshot = await initializePlayable(controller, {
        humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 0 },
      });
      let budgets = createTurnBudgets();
      let firstAttemptSnapshot: ControllerSnapshotV1 | null = null;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: snapshot.fence });
        expect(started.kind).toBe('model-turn-started');
        if (started.kind !== 'model-turn-started') throw new Error('Expected a model request.');
        const decision = decideModelTurn({
          budgets, position: started.request.position,
          classification: { kind: 'move', move: { from: 'e2', to: 'e5' }, text: 'e2e5', origin: 'json-move', retainedFields: [] },
          modelConfigurationIdentity: started.request.fence.modelConfigurationIdentity,
        });
        expect(decision.kind).toBe('illegal-attempt');
        if (decision.kind !== 'illegal-attempt') throw new Error('Expected an illegal-attempt effect.');
        budgets = decision.budgets;
        decisionTimeMs += 10;
        const applied = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence: started.request.fence, effect: decision });
        expect(applied.kind).toBe('accepted');
        if (applied.kind !== 'accepted') throw new Error('Expected the effect checkpoint to commit.');
        snapshot = applied.snapshot;
        if (attempt === 1) firstAttemptSnapshot = snapshot;
        expect(snapshot.checkpoint.budgets.illegalMoveAttemptsRemaining.white).toBe(4 - attempt);
        expect(snapshot.checkpoint.result.kind === 'final' ? snapshot.checkpoint.result.reason : null)
          .toBe(attempt === 4 ? 'illegal-move' : null);
      }
      const saved = await store.readGame(testId);
      expect(saved?.events.filter((event) => event.kind === 'illegal-move-rejected')).toHaveLength(4);
      expect(saved?.checkpoint.extensions['move-attempts']?.data).toMatchObject({ white: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }, { attempt: 4 }] });
      const feedbackText = 'e2e5 is not legal in this position. Please choose a legal move yourself.';
      expect(saved?.checkpoint.history.messages.filter((message) => message.role === 'user').map((message) => message.content))
        .toEqual(Array(4).fill(feedbackText));
      const feedback = firstAttemptSnapshot?.checkpoint.history.messages.at(-1);
      expect(feedback).toMatchObject({ role: 'user', content: feedbackText, disposition: 'retained' });
      expect(feedback?.eventIds).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('archives formatting corrections and pauses after three automatic corrections', async () => {
    const testId = 'controller-format-correction-feedback';
    let decisionTimeMs = 2_000;
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => decisionTimeMs });
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId, store, timeSource: { sample(at) { return { monotonicMs: at ?? decisionTimeMs, wallTimeMs: at ?? decisionTimeMs }; } },
      clockPolicy: { maxReferenceDivergenceMs: 0 }, idFactory: (() => { let id = 0; return () => `${testId}-${++id}`; })(),
    });
    try {
      let snapshot = await initializePlayable(controller, { humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
        timeControl: { startingTimeMs: 30_000, incrementMs: 0 } });
      let budgets = createTurnBudgets();
      let firstCorrectionSnapshot: ControllerSnapshotV1 | null = null;
      for (let correction = 1; correction <= 4; correction += 1) {
        const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: snapshot.fence });
        if (started.kind !== 'model-turn-started') throw new Error('Expected a model request.');
        const effect = decideModelTurn({ budgets, position: started.request.position,
          classification: { kind: 'format-failure', reason: 'no-action', fragment: '', retainedFields: [] },
          modelConfigurationIdentity: started.request.fence.modelConfigurationIdentity });
        if (effect.kind !== 'format-correction') throw new Error('Expected a format-correction effect.');
        budgets = effect.budgets;
        decisionTimeMs += 10;
        const applied = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence: started.request.fence, effect });
        if (applied.kind !== 'accepted') throw new Error('Expected the correction to commit.');
        snapshot = applied.snapshot;
        if (correction === 1) firstCorrectionSnapshot = snapshot;
        expect(effect.automatic).toBe(correction <= 3);
        expect(snapshot.checkpoint.budgets.formattingCorrectionsRemaining).toBe(Math.max(0, 3 - correction));
      }
      const feedback = firstCorrectionSnapshot!.checkpoint.history.messages.at(-1);
      expect(feedback).toMatchObject({ role: 'user', content: 'Your last message did not contain a move. Reply with one JSON object such as {"move":"e2e4"} using four coordinate squares, or {"resign":true} to resign. Do not send prose without a Move line.', disposition: 'retained' });
      expect(snapshot.checkpoint.history.messages.filter((message) => message.role === 'user')).toHaveLength(4);
    } finally {
      store.close();
    }
  });

  it('rejects forged attempt counters, records, losses, and accepted moves through public dispatch', async () => {
    const testId = 'controller-rejects-forged-effects';
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => 2_000 });
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId, store, timeSource: { sample(at) { return { monotonicMs: at ?? 2_000, wallTimeMs: at ?? 2_000 }; } },
      clockPolicy: { maxReferenceDivergenceMs: 0 }, idFactory: (() => { let id = 0; return () => `${testId}-${++id}`; })(),
    });
    try {
      const snapshot = await initializePlayable(controller, {
        humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
      });
      const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: snapshot.fence });
      if (started.kind !== 'model-turn-started') throw new Error('Expected a model request.');
      const decision = decideModelTurn({
        budgets: createTurnBudgets(), position: started.request.position,
        classification: { kind: 'move', move: { from: 'e2', to: 'e5' }, text: 'e2e5', origin: 'json-move', retainedFields: [] },
        modelConfigurationIdentity: started.request.fence.modelConfigurationIdentity,
      });
      if (decision.kind !== 'illegal-attempt') throw new Error('Expected an illegal-attempt effect.');
      const send = (effect: ModelTurnDecision, fence = started.request.fence) => controller.dispatch({
        schemaVersion: 1, kind: 'model-turn-effect', fence, effect,
      });
      await expect(send({ ...decision, attempt: 1, loss: { winner: 'human', reason: 'illegal-move' } }))
        .rejects.toMatchObject({ code: 'invalid-intent' });
      await expect(send({ ...decision, attempt: 4, record: { ...decision.record, attempt: 4 }, loss: null }))
        .rejects.toMatchObject({ code: 'invalid-intent' });
      await expect(send({ ...decision, attempt: 2, record: { ...decision.record, attempt: 2 } }))
        .rejects.toMatchObject({ code: 'invalid-intent' });
      await expect(send({ ...decision, record: { ...decision.record, move: { from: 'e2', to: 'e4' } } }))
        .rejects.toMatchObject({ code: 'invalid-intent' });
      await expect(send({ ...decision, budgets: { ...decision.budgets, formatCorrections: 1 } }))
        .rejects.toMatchObject({ code: 'invalid-intent' });
      const accepted = decideModelTurn({
        budgets: createTurnBudgets(), position: started.request.position,
        classification: { kind: 'move', move: { from: 'e2', to: 'e4' }, text: 'e2e4', origin: 'json-move', retainedFields: [] },
        modelConfigurationIdentity: started.request.fence.modelConfigurationIdentity,
      });
      if (accepted.kind !== 'accepted-move') throw new Error('Expected an accepted-move effect.');
      const forgedAccepted = await controller.dispatch({
        schemaVersion: 1, kind: 'model-turn-effect', fence: started.request.fence,
        effect: { ...accepted, move: { from: 'e2', to: 'e5' } },
      });
      expect(forgedAccepted).toMatchObject({ kind: 'rejected', reason: 'illegal-move' });
      const retry = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: forgedAccepted.snapshot.fence });
      if (retry.kind !== 'model-turn-started') throw new Error('Expected a replacement model request.');
      const committed = await send(decision, retry.request.fence);
      expect(committed.kind).toBe('accepted');
      if (committed.kind !== 'accepted') throw new Error('Expected the valid attempt to commit.');
      const stale = await send(decision, retry.request.fence);
      expect(stale).toMatchObject({ kind: 'rejected', reason: 'stale-fence' });
      expect(stale.snapshot.checkpoint.budgets.illegalMoveAttemptsRemaining.white).toBe(3);
      expect(controller.snapshot().checkpoint.budgets.illegalMoveAttemptsRemaining.white).toBe(3);
      expect(controller.snapshot().checkpoint.result.kind).toBe('unresolved');
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initialized = await initializePlayable(controller, {
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(controller, {
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(controller, {
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
      expect(afterAbort?.events.map((event) => event.kind)).toEqual([
        'game-created', 'deadness-candidate-created', 'adjudication-analysis-continued',
        'adjudication-proof-accepted', 'game-started-after-classification',
      ]);
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(controller, {
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
      expect(saved?.events.map((event) => event.kind)).toEqual([
        'game-created', 'deadness-candidate-created', 'adjudication-analysis-continued',
        'adjudication-proof-accepted', 'game-started-after-classification', 'model-turn-started',
      ]);
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
      const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
        const initial = await initializePlayable(controller, {
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
            kind: 'timeout-adjudication-candidate-created',
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(controller, {
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

  it('settles a failed model request with a safe archive event and keeps budgets unchanged', async () => {
    const testId = 'controller-model-turn-interrupted';
    let decisionTimeMs = 4_000;
    let monotonicMs = 8_000;
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => decisionTimeMs });
    let generatedId = 0;
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId,
      store,
      timeSource: { sample: (atDecisionTimeMs) => ({ monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs }) },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await initializePlayable(controller, {
        humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
        timeControl: { startingTimeMs: 60_000, incrementMs: 500 },
      });
      const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: initial.fence });
      if (started.kind !== 'model-turn-started') throw new Error('Expected a model request.');
      decisionTimeMs += 1_250;
      monotonicMs += 1_250;
      const settled = await controller.dispatch({
        schemaVersion: 1,
        kind: 'model-turn-interrupted',
        fence: started.request.fence,
        reason: 'failed',
      });
      expect(settled.kind).toBe('accepted');
      expect(settled.snapshot.checkpoint.rules.currentFen).toBe(initial.checkpoint.rules.currentFen);
      expect(settled.snapshot.checkpoint.rules.moves).toHaveLength(0);
      expect(settled.snapshot.checkpoint.budgets).toEqual(initial.checkpoint.budgets);
      expect(settled.snapshot.clockReading).toMatchObject({ status: 'running', remaining: { whiteMs: 58_750, blackMs: 60_000 } });

      const saved = await store.readGame(testId);
      const interrupted = saved?.events.find((event) => event.kind === 'model-turn-interrupted');
      expect(interrupted?.payload).toMatchObject({
        schemaVersion: 1,
        fence: { requestGeneration: started.request.fence.requestGeneration },
        details: { interruptedRequestGeneration: started.request.fence.requestGeneration, reason: 'failed' },
      });
      expect(JSON.stringify(interrupted?.payload)).not.toContain('provider response');
      expect(saved?.checkpoint.archive.currentLine.eventIds).toContain(interrupted?.eventId);

      const archive = await store.exportGameArchive(testId, []);
      const validated = await validateGameArchive(JSON.parse(JSON.stringify(archive)));
      expect(validated.events.find((event) => event.kind === 'model-turn-interrupted')).toEqual(interrupted);
      const restoreStore = await openGameStore({ databaseName: `${testId}-restore`, factory: new IDBFactory(), now: () => decisionTimeMs });
      try {
        const restored = await restoreStore.importGameArchive(validated);
        expect(restored.events.find((event) => event.kind === 'model-turn-interrupted')?.payload).toEqual(interrupted?.payload);
      } finally {
        restoreStore.close();
      }

      const lateReply = await controller.dispatch({
        schemaVersion: 1, kind: 'model-move', fence: started.request.fence, move: { from: 'e2', to: 'e4' },
      });
      expect(lateReply.kind).toBe('rejected');
      const explicitRetry = await controller.dispatch({
        schemaVersion: 1, kind: 'begin-model-turn', fence: settled.snapshot.fence,
      });
      expect(explicitRetry.kind).toBe('model-turn-started');
      const staleSettlement = await controller.dispatch({
        schemaVersion: 1, kind: 'model-turn-interrupted', fence: started.request.fence, reason: 'aborted',
      });
      expect(staleSettlement).toMatchObject({ kind: 'rejected', reason: 'stale-fence' });
    } finally {
      store.close();
    }
  });

  it('settles an expired model request through timeout adjudication without recording interruption', async () => {
    const testId = 'controller-model-turn-interrupted-expiry';
    let decisionTimeMs = 5_000;
    let monotonicMs = 9_000;
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => decisionTimeMs });
    let generatedId = 0;
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId,
      store,
      timeSource: { sample: (atDecisionTimeMs) => ({ monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs }) },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await initializePlayable(controller, {
        humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
        timeControl: { startingTimeMs: 100, incrementMs: 0 },
      });
      const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: initial.fence });
      if (started.kind !== 'model-turn-started') throw new Error('Expected a model request.');
      decisionTimeMs += 150;
      monotonicMs += 150;
      const settled = await controller.dispatch({
        schemaVersion: 1, kind: 'model-turn-interrupted', fence: started.request.fence, reason: 'incomplete',
      });
      expect(settled.kind).toBe('expired');
      expect(settled.snapshot.checkpoint.budgets).toEqual(initial.checkpoint.budgets);
      const saved = await store.readGame(testId);
      expect(saved?.events.some((event) => event.kind === 'timeout-candidate')).toBe(true);
      expect(saved?.events.some((event) => event.kind === 'model-turn-interrupted')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('does not accept a model reply after a later accepted move changes the position', async () => {
    const testId = 'controller-repeated-fen-stale-reply';
    let decisionTimeMs = 5_000;
    let monotonicMs = 8_000;
    const store = await openGameStore({ databaseName: testId, factory: new IDBFactory(), now: () => decisionTimeMs });
    let generatedId = 0;
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId,
      store,
      timeSource: { sample: (atDecisionTimeMs) => ({ monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs }) },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const state = await initializePlayable(controller, {
        humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
        timeControl: { startingTimeMs: 60_000, incrementMs: 0 },
      });
      const firstRequest = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: state.fence });
      if (firstRequest.kind !== 'model-turn-started') throw new Error('The first model turn did not start.');
      decisionTimeMs += 1_000;
      monotonicMs += 1_000;
      const accepted = await controller.dispatch({
        schemaVersion: 1, kind: 'model-move', fence: firstRequest.request.fence, move: { from: 'g1', to: 'f3' },
      });
      if (accepted.kind !== 'accepted') throw new Error('The first model move was not accepted.');
      expect(accepted.snapshot.adjudication.status).toBe('queued');
      expect(accepted.snapshot.fence.positionRevision).toBe(1);

      const staleReply = await controller.dispatch({
        schemaVersion: 1, kind: 'model-move', fence: firstRequest.request.fence, move: { from: 'e2', to: 'e4' },
      });
      expect(staleReply).toMatchObject({ kind: 'rejected', reason: 'stale-fence' });
      expect(staleReply.snapshot.checkpoint.revision).toBe(accepted.snapshot.checkpoint.revision);
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId,
      store: delayedStore,
      timeSource: {
        sample(atDecisionTimeMs) {
          return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
        },
      },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });

    try {
      const initial = await initializePlayable(controller, {
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(controller, {
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
      expect(saved?.events.map((event) => event.kind)).toEqual([
        'game-created', 'deadness-candidate-created', 'adjudication-analysis-continued',
        'adjudication-proof-accepted', 'game-started-after-classification', 'model-turn-started',
      ]);
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
    const firstController = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(firstController, {
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
      const completedOldRequest = await firstController.dispatch({
        schemaVersion: 1, kind: 'model-turn-interrupted', fence: oldRequest.request.fence, reason: 'failed',
      });
      const activeRequest = await firstController.dispatch({
        schemaVersion: 1, kind: 'begin-model-turn', fence: completedOldRequest.snapshot.fence,
      });
      if (activeRequest.kind !== 'model-turn-started') throw new Error(`The follow-up model turn did not start: ${activeRequest.kind}.`);
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
      const restoredController = controllerModule.getOrCreateGameController({ positionChecks: 'legacy-proof',
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
        kind: 'model-turn-interrupted',
        occurredAtMs: 21_000,
        payload: {
          details: { interruptedRequestGeneration: activeRequest.request.fence.requestGeneration, reason: 'incomplete' },
        },
      });
      expect(saved?.events.filter((event) => event.kind === 'model-turn-interrupted')).toHaveLength(2);
      expect(saved?.events.find((event) => event.kind === 'model-turn-interrupted')?.payload).toMatchObject({
        details: { interruptedRequestGeneration: oldRequest.request.fence.requestGeneration, reason: 'failed' },
      });
      expect(saved?.events.find((event) => event.kind === 'model-turn-interrupted' &&
        (event.payload as { details?: { interruptedRequestGeneration?: number } }).details?.interruptedRequestGeneration ===
          activeRequest.request.fence.requestGeneration)?.payload).toMatchObject({
        details: { interruptedRequestGeneration: activeRequest.request.fence.requestGeneration },
      });
      expect(activeRequest.request.fence.requestGeneration).toBeGreaterThan(oldRequest.request.fence.requestGeneration);
      const repeatedRecovery = await restoredController.reconcile();
      expect(repeatedRecovery.readiness).toBe('ready');
      expect((await restoredStore.readGame(testId))?.events.filter((event) => event.kind === 'model-turn-interrupted')).toHaveLength(2);
      expect(saved?.checkpoint.rules.moves).toHaveLength(0);
      restoredStore.close();
    } finally {
      store.close();
    }
  });

  it('keeps expiry precedence when restoring an unsettled model request', async () => {
    const testId = 'controller-restore-unsettled-model-expiry';
    const factory = new IDBFactory();
    let decisionTimeMs = 1_000;
    let monotonicMs = 5_000;
    const firstStore = await openGameStore({ databaseName: testId, factory, now: () => decisionTimeMs });
    let generatedId = 0;
    const firstController = getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId: testId,
      store: firstStore,
      timeSource: { sample: (at) => ({ monotonicMs, wallTimeMs: at ?? decisionTimeMs }) },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
      idFactory: () => `${testId}-id-${++generatedId}`,
    });
    try {
      const initial = await initializePlayable(firstController, {
        humanSide: 'black', modelSelection: model, namespace: { kind: 'guest' }, ownershipEpoch: 0,
        timeControl: { startingTimeMs: 100, incrementMs: 0 },
      });
      const started = await firstController.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: initial.fence });
      if (started.kind !== 'model-turn-started') throw new Error('The model turn did not start.');
      firstStore.close();

      vi.resetModules();
      decisionTimeMs = 1_150;
      monotonicMs = 100;
      const restoredStore = await openGameStore({ databaseName: testId, factory, now: () => decisionTimeMs });
      const controllerModule = await import('./index.js');
      const restoredController = controllerModule.getOrCreateGameController({ positionChecks: 'legacy-proof',
        gameId: testId,
        store: restoredStore,
        timeSource: { sample: (at) => ({ monotonicMs, wallTimeMs: at ?? decisionTimeMs }) },
        clockPolicy: { maxReferenceDivergenceMs: 0 },
        idFactory: () => `${testId}-restored-${++generatedId}`,
      });
      await restoredController.initialize();
      const reconciled = await restoredController.reconcile();
      expect(reconciled.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'timeout' });
      const saved = await restoredStore.readGame(testId);
      expect(saved?.events.some((event) => event.kind === 'timeout-candidate')).toBe(true);
      expect(saved?.events.some((event) => event.kind === 'model-turn-interrupted')).toBe(false);
      restoredStore.close();
    } finally {
      firstStore.close();
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
    const firstController = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(firstController, {
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
      const resumedController = controllerModule.getOrCreateGameController({ positionChecks: 'legacy-proof',
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
        expect(afterAbort?.events.map((event) => event.kind)).toEqual([
          'game-created', 'deadness-candidate-created', 'adjudication-analysis-continued',
          'adjudication-proof-accepted', 'game-started-after-classification',
        ]);
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
          'deadness-candidate-created',
          'adjudication-analysis-continued',
          'adjudication-proof-accepted',
          'game-started-after-classification',
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
          'deadness-candidate-created',
          'adjudication-analysis-continued',
          'adjudication-proof-accepted',
          'game-started-after-classification',
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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      let state = await initializePlayable(controller, {
        humanSide: 'black',
        modelSelection: model,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
        timeControl: { startingTimeMs: 60_000, incrementMs: 0 },
      });

      const playModel = async (move: CoordinateMove) => {
        const started = await controller.dispatch({
          schemaVersion: 1,
          kind: 'begin-model-turn',
          fence: state.fence,
        });
        if (started.kind !== 'model-turn-started') throw new Error('The model turn did not start.');
        decisionTimeMs += 1_000;
        monotonicMs += 1_000;
        const accepted = await controller.dispatch({
          schemaVersion: 1,
          kind: 'model-move',
          fence: started.request.fence,
          move,
        });
        if (accepted.kind !== 'accepted') throw new Error(`The model move failed: ${accepted.kind}`);
        state = await settlePendingAdjudication(controller, accepted.snapshot);
      };
      const playHuman = async (move: CoordinateMove) => {
        decisionTimeMs += 1_000;
        monotonicMs += 1_000;
        const accepted = await controller.dispatch({
          schemaVersion: 1,
          kind: 'human-move',
          fence: state.fence,
          move,
        });
        if (accepted.kind !== 'accepted') throw new Error(`The human move failed: ${accepted.kind}`);
        state = await settlePendingAdjudication(controller, accepted.snapshot);
      };

      await playModel({ from: 'f2', to: 'f3' });
      await playHuman({ from: 'e7', to: 'e5' });
      await playModel({ from: 'g2', to: 'g4' });
      await playHuman({ from: 'd8', to: 'h4' });

      expect(state.checkpoint.result).toEqual({
        kind: 'final',
        winner: 'black',
        reason: 'checkmate',
        eventId: state.checkpoint.rules.moves.at(-1)?.eventId,
        decidedAtMs: decisionTimeMs,
      });
      expect(state.checkpoint.rules.moves.map((move) => move.san)).toEqual(['f3', 'e5', 'g4', 'Qh4#']);

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
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(controller, {
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
    const firstController = getOrCreateGameController({ positionChecks: 'legacy-proof',
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
      const initial = await initializePlayable(firstController, {
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
      const restoredController = controllerModule.getOrCreateGameController({ positionChecks: 'legacy-proof',
        gameId: testId,
        store: restoredStore,
        timeSource: {
          sample(atDecisionTimeMs) {
            return { monotonicMs, wallTimeMs: atDecisionTimeMs ?? decisionTimeMs };
          },
        },
        clockPolicy: { maxReferenceDivergenceMs: 0 },
        idFactory: () => `${testId}-restored-${++generatedId}`,
      });
      const restored = await restoredController.initialize();
      expect(restored.readiness).toBe('ready');
      expect(restored.checkpoint.rules.moves).toHaveLength(0);
      expect(restored.checkpoint.result).toMatchObject({ kind: 'pending-adjudication', reason: 'timeout', eventAtMs: 31_000 });

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
        'deadness-candidate-created',
        'adjudication-analysis-continued',
        'adjudication-proof-accepted',
        'game-started-after-classification',
        'model-turn-started',
        'timeout-candidate',
        'timeout-adjudication-candidate-created',
      ]);
      expect(saved?.events.at(-1)).toMatchObject({
        kind: 'timeout-adjudication-candidate-created',
        occurredAtMs: 31_000,
        payload: { details: { expiredSide: 'white', queryIdentity: expect.any(String) } },
      });
      restoredStore.close();
    } finally {
      store.close();
    }
  });
});
