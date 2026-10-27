import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { checkProofEvidence, PROOF_CHECKER_VERSION, RULES_ADAPTER_VERSION } from '../proofs/index.js';
import type { ProofEvidence } from '../proofs/index.js';
import { createTurnBudgets, decideModelTurn, classifyCompletedAnswer } from '../moves/index.js';
import { openGameStore } from '../storage/index.js';
import { getOrCreateGameController } from '../controller/index.js';
import type { GameController, GameControllerSetupV1, ModelSelection } from '../controller/index.js';
import type { ControllerSnapshotV1 } from '../controller/index.js';
import type { CoordinateMove } from '../rules/index.js';
import { composeMoveInput, latestThinking } from '../history-cost/index.js';
import { getGenerationJournal, runGenerationTurn } from './generation-runner.js';
import { createConnectionProfile, openConnectionStore } from '../providers/connections/index.js';
import type { ProtocolStreamDecoder, ProtocolStreamResult, ProviderProtocol } from '../providers/protocols/index.js';
import { isLocalBoardInputDisabled, parseCoordinateMove, startClassifiedLocalGame, submitBoardMove } from '../ui/board-input.js';

const modelSelection: ModelSelection = {
  kind: 'model',
  providerId: 'fixture-provider',
  connectionId: 'fixture-connection',
  configurationRevision: 1,
  modelRoutingId: 'fixture-model',
  protocol: 'responses',
  diagnostic: 'passed-current-session',
};

async function acceptInitialPositionClassification(controller: GameController) {
  const initial = await controller.initialize({
    humanSide: 'white',
    namespace: { kind: 'guest' },
    ownershipEpoch: 0,
  });
  const work = await controller.continueAdjudication(initial.fence);
  if (!work) throw new Error('Expected setup classification work.');
  const evidence: ProofEvidence = {
    schemaVersion: 1,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    queryIdentity: work.query.queryIdentity,
    kind: 'mate-witness',
    intendedColor: 'b',
    moves: [
      { from: 'f2', to: 'f3' },
      { from: 'e7', to: 'e5' },
      { from: 'g2', to: 'g4' },
      { from: 'd8', to: 'h4' },
    ],
  };
  const checked = checkProofEvidence(work.query, evidence);
  if (checked.status !== 'accepted') throw new Error('Expected accepted setup evidence.');
  return controller.acceptAdjudicationResult({
    requestId: work.requestId,
    fence: work.fence,
    query: work.query,
    result: {
      status: 'accepted',
      conclusion: checked.conclusion,
      queryIdentity: checked.queryIdentity,
      evidence,
      checkpointDisposition: 'fresh',
      pass: {
        maxDiscoveredStates: 0,
        timeBudgetMs: 0,
        discoveredStateCount: 0,
        processedEdgeCount: 0,
        expandedStateCount: 0,
        totalDiscoveredStateCount: 0,
        totalDiscoveredEdgeCount: 0,
        elapsedMs: 0,
      },
    },
  });
}

async function acceptWitness(
  controller: GameController,
  current: ControllerSnapshotV1,
  intendedColor: 'w' | 'b',
  moves: readonly CoordinateMove[],
) {
  const work = await controller.continueAdjudication(current.fence);
  if (!work) throw new Error('Expected adjudication work.');
  const evidence: ProofEvidence = {
    schemaVersion: 1,
    proofCheckerVersion: PROOF_CHECKER_VERSION,
    rulesAdapterVersion: RULES_ADAPTER_VERSION,
    queryIdentity: work.query.queryIdentity,
    kind: 'mate-witness',
    intendedColor,
    moves,
  };
  const checked = checkProofEvidence(work.query, evidence);
  if (checked.status !== 'accepted') throw new Error('Expected accepted checkmate witness.');
  return controller.acceptAdjudicationResult({
    requestId: work.requestId,
    fence: work.fence,
    query: work.query,
    result: {
      status: 'accepted',
      conclusion: checked.conclusion,
      queryIdentity: checked.queryIdentity,
      evidence,
      checkpointDisposition: 'fresh',
      pass: {
        maxDiscoveredStates: 0,
        timeBudgetMs: 0,
        discoveredStateCount: 0,
        processedEdgeCount: 0,
        expandedStateCount: 0,
        totalDiscoveredStateCount: 0,
        totalDiscoveredEdgeCount: 0,
        elapsedMs: 0,
      },
    },
  });
}

function createController(gameId: string, now: () => number) {
  return openGameStore({ databaseName: gameId, factory: new IDBFactory(), now }).then((store) => ({
    store,
    controller: getOrCreateGameController({ positionChecks: 'legacy-proof',
      gameId,
      store,
      timeSource: { sample: (decisionTimeMs) => ({ monotonicMs: now(), wallTimeMs: decisionTimeMs ?? now() }) },
      clockPolicy: { maxReferenceDivergenceMs: 0 },
    }),
  }));
}

describe('controller and retained history integration seams', () => {
  it('starts a model-less local match and commits alternating board moves through the controller', async () => {
    const nowMs = 1_000;
    const gameId = 'integration-local-two-human';
    const { store, controller } = await createController(gameId, () => nowMs);
    try {
      const ready = await acceptInitialPositionClassification(controller);
      const started = await startClassifiedLocalGame(controller, ready);
      expect(started.checkpoint.selections.players).toEqual({
        white: { kind: 'human' },
        black: { kind: 'human' },
      });
      expect(started.checkpoint.result.kind).toBe('unresolved');
      expect(started.checkpoint.clocks.activeSide).toBe('white');
      expect(isLocalBoardInputDisabled(started, false)).toBe(false);

      const white = await submitBoardMove(controller, started, parseCoordinateMove('e2e4')!);
      expect(white.kind).toBe('accepted');
      if (white.kind !== 'accepted') throw new Error('Expected White\'s move to commit.');
      expect(white.snapshot.checkpoint.clocks.activeSide).toBe('black');
      expect(white.snapshot.checkpoint.rules.moves.map(({ san }) => san)).toEqual(['e4']);

      const afterWhite = await acceptWitness(controller, white.snapshot, 'w', [
        { from: 'e7', to: 'e5' },
        { from: 'd1', to: 'h5' },
        { from: 'b8', to: 'c6' },
        { from: 'f1', to: 'c4' },
        { from: 'g8', to: 'f6' },
        { from: 'h5', to: 'f7' },
      ]);
      const black = await submitBoardMove(controller, afterWhite, parseCoordinateMove('e7e5')!);
      expect(black.kind).toBe('accepted');
      if (black.kind !== 'accepted') throw new Error('Expected Black\'s move to commit.');
      expect(black.snapshot.checkpoint.clocks.activeSide).toBe('white');
      expect(black.snapshot.checkpoint.rules.moves.map(({ san }) => san)).toEqual(['e4', 'e5']);
      const afterBlack = await acceptWitness(controller, black.snapshot, 'w', [
        { from: 'd1', to: 'h5' },
        { from: 'b8', to: 'c6' },
        { from: 'f1', to: 'c4' },
        { from: 'g8', to: 'f6' },
        { from: 'h5', to: 'f7' },
      ]);
      expect((await store.readGame(gameId))?.checkpoint.rules.moves.map(({ san }) => san)).toEqual(['e4', 'e5']);
      expect(afterBlack.checkpoint.history.segments[0]).toMatchObject({
        providerId: null,
        modelRoutingId: null,
        connectionRevision: null,
      });
    } finally {
      store.close();
    }
  }, 30_000);

  it('applies a typed accepted-move effect from a fenced model request', async () => {
    const nowMs = 2_000;
    const gameId = 'integration-typed-model-effect';
    const { store, controller } = await createController(gameId, () => nowMs);
    try {
      const setup: GameControllerSetupV1 = {
        humanSide: 'black',
        modelSelection,
        namespace: { kind: 'guest' },
        ownershipEpoch: 0,
      };
      const initial = await controller.initialize(setup);
      const work = await controller.continueAdjudication(initial.fence);
      if (!work) throw new Error('Expected model game setup classification.');
      const evidence: ProofEvidence = {
        schemaVersion: 1,
        proofCheckerVersion: PROOF_CHECKER_VERSION,
        rulesAdapterVersion: RULES_ADAPTER_VERSION,
        queryIdentity: work.query.queryIdentity,
        kind: 'mate-witness',
        intendedColor: 'b',
        moves: [
          { from: 'f2', to: 'f3' },
          { from: 'e7', to: 'e5' },
          { from: 'g2', to: 'g4' },
          { from: 'd8', to: 'h4' },
        ],
      };
      const checked = checkProofEvidence(work.query, evidence);
      if (checked.status !== 'accepted') throw new Error('Expected accepted model game setup evidence.');
      const ready = await controller.acceptAdjudicationResult({
        requestId: work.requestId,
        fence: work.fence,
        query: work.query,
        result: {
          status: 'accepted',
          conclusion: checked.conclusion,
          queryIdentity: checked.queryIdentity,
          evidence,
          checkpointDisposition: 'fresh',
          pass: {
            maxDiscoveredStates: 0,
            timeBudgetMs: 0,
            discoveredStateCount: 0,
            processedEdgeCount: 0,
            expandedStateCount: 0,
            totalDiscoveredStateCount: 0,
            totalDiscoveredEdgeCount: 0,
            elapsedMs: 0,
          },
        },
      });
      const playable = await controller.startGame(ready.fence, modelSelection);
      const request = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: playable.fence });
      expect(request.kind).toBe('model-turn-started');
      if (request.kind !== 'model-turn-started') throw new Error('Expected a fenced model turn request.');
      const effect = decideModelTurn({
        budgets: createTurnBudgets(),
        position: request.request.position,
        classification: classifyCompletedAnswer({ answerText: 'e2e4', position: request.request.position }),
        modelConfigurationIdentity: request.request.fence.modelConfigurationIdentity,
      });
      expect(effect.kind).toBe('accepted-move');
      const applied = await controller.dispatch({
        schemaVersion: 1,
        kind: 'model-turn-effect',
        fence: request.request.fence,
        effect,
      });
      expect(applied.kind).toBe('accepted');
      if (applied.kind !== 'accepted') throw new Error('Expected the controller to accept the typed effect.');
      expect(applied.snapshot.checkpoint.rules.moves.map(({ san }) => san)).toEqual(['e4']);
      expect(applied.snapshot.checkpoint.clocks.activeSide).toBe('black');
      expect(applied.snapshot.checkpoint.result.kind).toBe('pending-adjudication');
    } finally {
      store.close();
    }
  }, 30_000);

  it('composes local-game chess state without needing a provider conversation segment', async () => {
    const gameId = 'integration-nullable-local-history';
    const { store, controller } = await createController(gameId, () => 3_000);
    try {
      const ready = await acceptInitialPositionClassification(controller);
      const started = await startClassifiedLocalGame(controller, ready);
      const input = composeMoveInput(started.checkpoint.rules, 'Current move instructions.', {
        snapshotId: 'current-position',
        clock: { whiteMs: 60_000, blackMs: 60_000, incrementMs: 0 },
        budgets: createTurnBudgets(),
      });
      expect(input.history.records).toHaveLength(1);
      expect(JSON.parse(input.history.records[0]!.text)).toMatchObject({
        kind: 'current-match-input', fen: started.position.fen, sideToMove: 'white', moves: '',
      });
    } finally {
      store.close();
    }
  }, 15_000);

  it('archives provider turns and carries the latest complete thinking without raw records', async () => {
    const gameId = 'integration-durable-generation-history';
    const factory = new IDBFactory();
    const now = () => 5_000;
    const store = await openGameStore({ databaseName: gameId, factory, now });
    const controller = getOrCreateGameController({ positionChecks: 'legacy-proof', gameId, store,
      timeSource: { sample: (decisionTimeMs) => ({ monotonicMs: now(), wallTimeMs: decisionTimeMs ?? now() }) },
      clockPolicy: { maxReferenceDivergenceMs: 0 } });
    const namespace = { kind: 'guest' as const };
    const connections = await openConnectionStore({ databaseName: `${gameId}-connections`, factory });
    const profile = await createConnectionProfile({ id: 'durable-openai', name: 'Fixture', provider: 'openai' });
    await connections.saveProfile(namespace, profile);
    await connections.assignCredential(namespace, profile.id, { apiKey: 'fixture-private-secret' });
    await connections.recordDisclosureChoice(namespace, profile, { decision: 'accepted', recordedAtMs: now() });
    const selected: ModelSelection = {
      ...modelSelection, providerId: 'openai', connectionId: profile.id, protocol: 'responses',
      configurationRevision: 1, modelRoutingId: 'fixture-model',
    };
    try {
      const initialized = await controller.initialize({ humanSide: 'black', modelSelection: selected, namespace, ownershipEpoch: 0 });
      const setupWork = await controller.continueAdjudication(initialized.fence);
      if (!setupWork) throw new Error('Expected setup classification.');
      const setupEvidence: ProofEvidence = {
        schemaVersion: 1, proofCheckerVersion: PROOF_CHECKER_VERSION, rulesAdapterVersion: RULES_ADAPTER_VERSION,
        queryIdentity: setupWork.query.queryIdentity, kind: 'mate-witness', intendedColor: 'b',
        moves: [{ from: 'f2', to: 'f3' }, { from: 'e7', to: 'e5' }, { from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' }],
      };
      const setupChecked = checkProofEvidence(setupWork.query, setupEvidence);
      if (setupChecked.status !== 'accepted') throw new Error('Expected checked setup evidence.');
      const ready = await controller.acceptAdjudicationResult({ requestId: setupWork.requestId, fence: setupWork.fence,
        query: setupWork.query, result: { status: 'accepted', conclusion: setupChecked.conclusion,
          queryIdentity: setupChecked.queryIdentity, evidence: setupEvidence, checkpointDisposition: 'fresh',
          pass: { maxDiscoveredStates: 0, timeBudgetMs: 0, discoveredStateCount: 0, processedEdgeCount: 0,
            expandedStateCount: 0, totalDiscoveredStateCount: 0, totalDiscoveredEdgeCount: 0, elapsedMs: 0 } } });
      let active = await controller.startGame(ready.fence, selected);
      const responses: ProtocolStreamResult[] = [
        { protocol: 'responses', terminal: 'failed', content: 'empty', answerText: '', reasoningText: 'partial reasoning', planText: '', refusalText: '',
          usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } }, usageRecords: [], errors: [{ message: 'synthetic interruption' }],
          incompleteDetails: [], toolRecords: [], otherChoices: [], unknownEvents: [], raw: { chunks: [], events: [] } },
        { protocol: 'responses', terminal: 'complete', content: 'answer', answerText: '{"move":"e2e4"}', reasoningText: 'first reasoning', planText: 'first plan', refusalText: '',
          usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }, usageRecords: [], errors: [], incompleteDetails: [], toolRecords: [], otherChoices: [], unknownEvents: [], raw: { chunks: [], events: [] } },
        { protocol: 'responses', terminal: 'complete', content: 'answer', answerText: '{"move":"g1f3"}', reasoningText: 'second reasoning', planText: 'second plan', refusalText: '',
          usage: { input_tokens: 30, output_tokens: 6, input_tokens_details: { cached_tokens: 4 } }, usageRecords: [], errors: [], incompleteDetails: [], toolRecords: [], otherChoices: [], unknownEvents: [], raw: { chunks: [], events: [] } },
      ];
      const requestBodies: string[] = [];
      let runCount = 0;
      const fixtureFetch = async (_url: string, init: RequestInit) => {
        requestBodies.push(String(init.body));
        const body = requestBodies.length === 1 ? 'fixture-private-secret' : `wire-${runCount}`;
        return new Response(new TextEncoder().encode(body), { status: 200 });
      };
      const createDecoder = (protocol: ProviderProtocol): ProtocolStreamDecoder => {
        expect(protocol).toBe('responses');
        const result = responses[runCount++]!;
        return { push: () => undefined, abort: () => undefined, finish: () => result };
      };
      const run = () => runGenerationTurn({ controller, connections, namespace,
        expectedProfileConfigRevision: profile.configRevision, instructions: 'Play one legal move.',
        generation: { maxOutputTokens: 100 }, capacity: { maxOutputTokens: 100 }, fetch: fixtureFetch,
        createDecoder, now });
      const failed = await run();
      expect(failed).toMatchObject({ kind: 'interrupted', reason: 'failed', persistence: 'saved-locally-quarantined' });
      const first = await run();
      expect(first).toMatchObject({ kind: 'completed', dispatch: 'accepted', persistence: 'saved-locally-quarantined' });
      active = controller.snapshot();
      const afterFirst = await acceptWitness(controller, active, 'w', [
        { from: 'e7', to: 'e5' }, { from: 'd1', to: 'h5' }, { from: 'b8', to: 'c6' },
        { from: 'f1', to: 'c4' }, { from: 'g8', to: 'f6' }, { from: 'h5', to: 'f7' },
      ]);
      const black = await submitBoardMove(controller, afterFirst, parseCoordinateMove('e7e5')!);
      if (black.kind !== 'accepted') throw new Error('Expected the human reply to commit.');
      const afterBlack = await acceptWitness(controller, black.snapshot, 'w', [
        { from: 'd1', to: 'h5' }, { from: 'b8', to: 'c6' }, { from: 'f1', to: 'c4' },
        { from: 'g8', to: 'f6' }, { from: 'h5', to: 'f7' },
      ]);
      const second = await run();
      expect(second).toMatchObject({ kind: 'completed', dispatch: 'accepted' });
      expect(requestBodies[2]).toContain('first plan');
      expect(requestBodies[2]).not.toContain('first reasoning');
      expect(requestBodies[2]).not.toContain('partial reasoning');
      expect(requestBodies[2]).not.toContain('opaque-provider-record');
      expect(requestBodies[2]).toContain('e4 e5');
      expect(requestBodies[2]).toContain('rnbqkbnr/pppp1ppp/8/4p3');
      expect(requestBodies[2]).toContain('current-match-input');
      expect(requestBodies[0]).not.toContain('fixture-private-secret');
      const stored = await store.readGame(gameId);
      expect(stored?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
      await expect(store.exportGameArchive(gameId, ['fixture-private-secret'])).rejects.toMatchObject({ code: 'credential-echo' });
      expect(stored?.checkpoint.history.messages.map((message) => message.content)).toContain('first plan');
      expect(stored?.checkpoint.history.messages.map((message) => message.content)).toContain('partial reasoning');
      const journal = getGenerationJournal(stored!);
      expect(journal.retainedEvents.filter((event) => event.kind === 'model-request-persisted')).toHaveLength(3);
      expect(journal.retainedMessages.every((message) => !message.content.includes('opaque-provider-record'))).toBe(true);
      const terminalUsage = journal.retainedEvents.filter((event) => event.kind === 'model-turn-transcript-finalized');
      expect(JSON.stringify(terminalUsage)).toContain('input_tokens');
      expect(afterBlack.checkpoint.history.messages.some((message) => message.content === 'first plan')).toBe(true);
      store.close();
      const restoredStore = await openGameStore({ databaseName: gameId, factory, now });
      try {
        const restored = await restoredStore.readGame(gameId);
        expect(restored?.checkpoint.history.messages.find((message) => message.content === 'first plan')?.disposition).toBe('retained');
        expect(latestThinking(restored!.checkpoint.history, { ...restored!.checkpoint.rules, sideToMove: 'white' }))
          .toEqual(expect.objectContaining({ plan: 'second plan', move: 'g1f3' }));
        expect(latestThinking(restored!.checkpoint.history, { ...restored!.checkpoint.rules, sideToMove: 'white' }))
          .not.toHaveProperty('reasoning');
        expect(getGenerationJournal(restored!).retainedEvents.filter((event) => event.kind === 'model-request-persisted')).toHaveLength(3);
        expect(restored?.checkpoint.archive.egressStatus).toBe('credential-echo-quarantined');
      } finally {
        restoredStore.close();
      }
    } finally {
      store.close();
    }
  }, 30_000);
});
