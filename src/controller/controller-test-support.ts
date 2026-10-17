import { DEFAULT_TIME_CONTROL } from '../clocks/index.js';
import { createRepetitionLedger, parsePosition } from '../rules/index.js';
import type { GameController, GameControllerSetupV1 } from './index.js';
import type { ArchiveEventV1, GameCheckpointV1, GameStore, PlayerSelectionV1 } from '../storage/index.js';

export interface LegacyClockAnchorFixtureV1 {
  monotonicMs: number;
  hostOffsetMs?: number;
  resolvedHumanSide?: 'white' | 'black';
}

/** Seeds a pre-KHA-32 active game through the public store so restore behavior stays covered. */
export async function seedLegacyActiveGame(
  gameId: string,
  store: GameStore,
  setup: GameControllerSetupV1,
  anchor: LegacyClockAnchorFixtureV1,
): Promise<void> {
  const position = parsePosition(setup.startingFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const timeControl = setup.timeControl ?? DEFAULT_TIME_CONTROL;
  const humanSide = setup.humanSide === 'random'
    ? anchor.resolvedHumanSide ?? 'white'
    : setup.humanSide;
  const modelSide = humanSide === 'white' ? 'black' : 'white';
  const players: Record<'white' | 'black', PlayerSelectionV1> = {
    white: humanSide === 'white' ? { kind: 'human' } : structuredClone(setup.modelSelection),
    black: humanSide === 'black' ? { kind: 'human' } : structuredClone(setup.modelSelection),
  };
  const segmentId = `${gameId}-legacy-segment`;
  const lineId = `${gameId}-legacy-line`;
  const eventId = `${gameId}-legacy-created`;
  const ledger = createRepetitionLedger(position);
  const modelSelection = setup.modelSelection;

  const result = await store.commitCheckpoint({
    gameId,
    expectedRevision: null,
    expectedEpoch: setup.ownershipEpoch,
    events: [],
    chunks: [],
    knownCredentials: [],
    decide(decisionTimeMs) {
      const checkpoint: GameCheckpointV1 = {
        schemaVersion: 1,
        gameId,
        namespace: structuredClone(setup.namespace),
        revision: 1,
        ownershipEpoch: setup.ownershipEpoch,
        segmentId,
        positionRevision: 0,
        requestGeneration: 0,
        analysisGeneration: 0,
        updatedAtMs: decisionTimeMs,
        rules: {
          variant: 'orthodox',
          startingFen: position.fen,
          currentFen: position.fen,
          sideToMove: position.sideToMove === 'w' ? 'white' : 'black',
          castlingRights: position.castlingRights,
          enPassantSquare: position.enPassantSquare,
          halfmoveClock: position.halfmoveClock,
          fullmoveNumber: position.fullmoveNumber,
          repetitionLedger: {
            version: 1,
            positions: ledger.entries.map((entry) => ({ ...entry })),
          },
          moves: [],
        },
        history: {
          currentSegmentId: segmentId,
          segments: [{
            segmentId,
            providerId: modelSelection.providerId,
            modelRoutingId: modelSelection.modelRoutingId,
            connectionRevision: modelSelection.configurationRevision,
            startedAtMs: decisionTimeMs,
            messageIds: [],
          }],
          messages: [],
        },
        clocks: {
          schemaVersion: 1,
          timeControl: { ...timeControl },
          banksAtAnchor: {
            whiteMs: timeControl.startingTimeMs,
            blackMs: timeControl.startingTimeMs,
          },
          activeSide: position.sideToMove === 'w' ? 'white' : 'black',
          anchor: anchor.hostOffsetMs === undefined
            ? { monotonicMs: anchor.monotonicMs, wallTimeMs: decisionTimeMs }
            : {
                monotonicMs: anchor.monotonicMs,
                wallTimeMs: decisionTimeMs,
                hostOffsetMs: anchor.hostOffsetMs,
              },
          lastReconciledAtMs: decisionTimeMs,
        },
        budgets: {
          formattingCorrectionsRemaining: 3,
          illegalMoveAttemptsRemaining: { white: 4, black: 4 },
          manualRetriesBySide: { white: 0, black: 0 },
        },
        selections: { players },
        archive: {
          egressStatus: 'eligible',
          currentLine: { lineId, eventIds: [eventId] },
          discardedLines: [],
        },
        result: { kind: 'unresolved' },
        practice: {
          mode: 'ordinary',
          scored: true,
          sourceGameId: null,
          sourcePositionFen: null,
          originalResult: null,
        },
        extensions: {},
      };
      const createdEvent: ArchiveEventV1 = {
        eventId,
        gameId,
        sequence: 0,
        segmentId,
        kind: 'game-created',
        occurredAtMs: decisionTimeMs,
        receiveState: 'complete',
        egressStatus: 'eligible',
        payload: {
          schemaVersion: 1,
          fence: {
            schemaVersion: 1,
            gameId,
            segmentId,
            side: position.sideToMove === 'w' ? 'white' : 'black',
            revision: 1,
            positionRevision: 0,
            requestGeneration: 0,
            analysisGeneration: 0,
            ownershipEpoch: setup.ownershipEpoch,
            modelConfigurationIdentity: JSON.stringify([
              modelSelection.providerId,
              modelSelection.connectionId,
              modelSelection.configurationRevision,
              modelSelection.modelRoutingId,
              modelSelection.protocol,
            ]),
          },
          details: { legacyCheckpoint: true, modelSide },
        },
        chunkIds: [],
      };
      return { checkpoint, events: [createdEvent], outboxOperationIds: [] };
    },
  });
  if (result.kind !== 'committed') throw new Error(`Could not seed legacy game ${gameId}.`);
}

/** Loads and reconciles a saved legacy game before a fixture exercises active play. */
export async function initializeLegacyActiveGame(
  controller: GameController,
  gameId: string,
  store: GameStore,
  setup: GameControllerSetupV1,
  anchor: LegacyClockAnchorFixtureV1,
) {
  await seedLegacyActiveGame(gameId, store, setup, anchor);
  await controller.initialize(setup);
  return controller.reconcile();
}
