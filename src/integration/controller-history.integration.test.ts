import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { checkProofEvidence, PROOF_CHECKER_VERSION, RULES_ADAPTER_VERSION } from '../proofs/index.js';
import type { ProofEvidence } from '../proofs/index.js';
import { createTurnBudgets, decideModelTurn, classifyCompletedAnswer } from '../moves/index.js';
import { openGameStore } from '../storage/index.js';
import type { HistoryCheckpointV1 } from '../storage/index.js';
import { getOrCreateGameController } from '../controller/index.js';
import type { GameController, GameControllerSetupV1, ModelSelection } from '../controller/index.js';
import type { ControllerSnapshotV1 } from '../controller/index.js';
import type { CoordinateMove } from '../rules/index.js';
import { composeHistoryReplay } from '../history-cost/index.js';
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
    controller: getOrCreateGameController({
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

  it('replays retained records from a nullable guest segment as attributed text', async () => {
    const gameId = 'integration-nullable-local-history';
    const { store, controller } = await createController(gameId, () => 3_000);
    try {
      const ready = await acceptInitialPositionClassification(controller);
      const started = await startClassifiedLocalGame(controller, ready);
      const segment = started.checkpoint.history.segments[0];
      if (!segment) throw new Error('Expected the local history segment.');
      const localHistory: HistoryCheckpointV1 = {
        currentSegmentId: segment.segmentId,
        segments: [{ ...segment, messageIds: ['local-note'] }],
        messages: [{
          messageId: 'local-note',
          segmentId: segment.segmentId,
          lineId: started.checkpoint.archive.currentLine.lineId,
          role: 'assistant',
          content: 'local player note',
          eventIds: [],
          disposition: 'retained',
        }],
      };
      const replay = composeHistoryReplay(localHistory, 'Current move instructions.', {
        snapshotId: 'current-position',
        fen: started.position.fen,
        pieces: [],
        sideToMove: started.position.sideToMove === 'w' ? 'white' : 'black',
        colors: { white: 'human', black: 'human' },
        clock: {
          sampledAtMs: 3_000,
          whiteMs: 60_000,
          blackMs: 60_000,
          activeSide: 'white',
          startingTimeMs: 60_000,
          incrementMs: 0,
        },
      });
      const prior = JSON.parse(replay.history.records[0]?.text ?? '{}') as Record<string, unknown>;
      expect(prior).toMatchObject({
        kind: 'retained-match-record',
        sourceRole: 'assistant',
        content: 'local player note',
        providerId: null,
        modelRoutingId: null,
      });
      expect(replay.history.records.at(-1)?.text).toContain('current-position');
    } finally {
      store.close();
    }
  }, 15_000);
});
