import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openGameStore } from '../storage/index.js';
import type { CoordinateMove } from '../rules/index.js';
import { createTurnBudgets, decideCompletedAnswer } from '../moves/index.js';
import type { ModelTurnDecision } from '../moves/index.js';
import { getOrCreateGameController } from './index.js';
import type { ControllerSnapshotV1, GameControllerSetupV1, ModelSelection } from './index.js';

const model: ModelSelection = { kind: 'model', providerId: 'fixture', connectionId: 'fixture',
  configurationRevision: 0, modelRoutingId: 'fixture', protocol: 'chat-completions', diagnostic: 'passed-current-session' };

async function fixture(players?: GameControllerSetupV1['players']) {
  let now = 1_000;
  const gameId = crypto.randomUUID();
  const store = await openGameStore({ factory: new IDBFactory(), databaseName: gameId, now: () => now });
  const controller = getOrCreateGameController({ gameId, store, clockPolicy: { maxReferenceDivergenceMs: 5 },
    timeSource: { sample: (at = now) => ({ monotonicMs: now, wallTimeMs: at }) } });
  const setup = { humanSide: 'white' as const, namespace: { kind: 'guest' } as const, ownershipEpoch: 0,
    ...(players === undefined ? { modelSelection: model } : { players }), timeControl: { startingTimeMs: 100_000, incrementMs: 0 } };
  const initial = await controller.initialize(setup);
  return { controller, initial, store, advance: (ms: number) => { now += ms; } };
}

/** Plays one model turn through the real pipeline: a JSON answer parsed into its effect. */
async function modelPlays(
  controller: ReturnType<typeof getOrCreateGameController>,
  snapshot: ControllerSnapshotV1,
  answer: Record<string, unknown>,
): Promise<ControllerSnapshotV1> {
  const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: snapshot.fence });
  if (started.kind !== 'model-turn-started') throw new Error(`the model turn did not start: ${started.kind}`);
  const effect: ModelTurnDecision = decideCompletedAnswer({ budgets: createTurnBudgets(),
    position: started.snapshot.position, answer: { answerText: JSON.stringify(answer), position: started.snapshot.position },
    modelConfigurationIdentity: null });
  const applied = await controller.dispatch({ schemaVersion: 1, kind: 'model-turn-effect', fence: started.snapshot.fence, effect });
  if (applied.kind !== 'accepted') throw new Error(`the model effect was not accepted: ${applied.kind}`);
  return applied.snapshot;
}

async function humanPlays(
  controller: ReturnType<typeof getOrCreateGameController>,
  snapshot: ControllerSnapshotV1,
  move: CoordinateMove,
): Promise<ControllerSnapshotV1> {
  const played = await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: snapshot.fence, move });
  if (played.kind !== 'accepted') throw new Error(`the human move was not accepted: ${played.kind}`);
  return played.snapshot;
}

function sansOf(snapshot: ControllerSnapshotV1): readonly string[] {
  return snapshot.checkpoint.rules.moves.map((move) => move.san);
}

describe('AI conditional pre-moves', () => {
  it('arms a plan with the model move and fires it inside the human move dispatch', async () => {
    const { controller, initial, store } = await fixture();
    try {
      let snapshot = await controller.startGame(initial.fence, model);
      snapshot = await humanPlays(controller, snapshot, { from: 'e2', to: 'e4' });
      snapshot = await modelPlays(controller, snapshot, {
        move: 'e7e5', premoves: [{ on: ['g1f3', 'b1c3'], then: 'g8f6' }],
      });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5']);
      expect(snapshot.premoves).toEqual({ white: [], black: [
        { trigger: 'g1f3', reply: 'g8f6', san: 'Nf6' },
        { trigger: 'b1c3', reply: 'g8f6', san: 'Nf6' },
      ] });

      snapshot = await humanPlays(controller, snapshot, { from: 'g1', to: 'f3' });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5', 'Nf3', 'Nf6']);
      expect(snapshot.premoves).toBeNull();
      expect(snapshot.clockReading?.status).toBe('running');
      const game = await store.readGame(snapshot.checkpoint.gameId);
      expect(game?.events.some((event) => event.kind === 'model-move-accepted' &&
        JSON.stringify(event.payload).includes('"premove":true'))).toBe(true);
    } finally { store.close(); }
  });

  it('discards the armed plan when the human replies differently', async () => {
    const { controller, initial, store } = await fixture();
    try {
      let snapshot = await controller.startGame(initial.fence, model);
      snapshot = await humanPlays(controller, snapshot, { from: 'e2', to: 'e4' });
      snapshot = await modelPlays(controller, snapshot, { move: 'e7e5', premoves: [{ on: ['b1c3'], then: 'g8f6' }] });
      snapshot = await humanPlays(controller, snapshot, { from: 'g1', to: 'f3' });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5', 'Nf3']);
      expect(snapshot.premoves).toBeNull();
      // The discarded plan cannot fire on a later move either.
      snapshot = await modelPlays(controller, snapshot, { move: 'b8c6' });
      snapshot = await humanPlays(controller, snapshot, { from: 'b1', to: 'c3' });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Nc3']);
      expect(snapshot.premoves).toBeNull();
    } finally { store.close(); }
  });

  it('re-arms the nested plan after a fired reply and fires it on the next matching reply', async () => {
    const { controller, initial, store } = await fixture();
    try {
      let snapshot = await controller.startGame(initial.fence, model);
      snapshot = await humanPlays(controller, snapshot, { from: 'e2', to: 'e4' });
      snapshot = await modelPlays(controller, snapshot, {
        move: 'e7e5', premoves: [{ on: ['g1f3'], then: { move: 'g8f6', premoves: [{ on: ['b1c3'], then: 'd7d5' }] } }],
      });
      snapshot = await humanPlays(controller, snapshot, { from: 'g1', to: 'f3' });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5', 'Nf3', 'Nf6']);
      expect(snapshot.premoves).toEqual({ white: [], black: [{ trigger: 'b1c3', reply: 'd7d5', san: 'd5' }] });
      snapshot = await humanPlays(controller, snapshot, { from: 'b1', to: 'c3' });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5', 'Nf3', 'Nf6', 'Nc3', 'd5']);
      expect(snapshot.premoves).toBeNull();
    } finally { store.close(); }
  });

  it('drops a branch whose trigger or reply cannot legally happen, without a notice or a fire', async () => {
    const { controller, initial, store } = await fixture();
    try {
      let snapshot = await controller.startGame(initial.fence, model);
      snapshot = await humanPlays(controller, snapshot, { from: 'e2', to: 'e4' });
      snapshot = await modelPlays(controller, snapshot, {
        move: 'e7e5', premoves: [{ on: ['g1f3'], then: 'g8g6' }, { on: ['e2e4'], then: 'g8f6' }],
      });
      // A knight cannot step straight to g6 and the e2e4 trigger is White's own pawn
      // move from a square that is empty now, so nothing is armed and nothing fires.
      expect(snapshot.premoves).toBeNull();
      snapshot = await humanPlays(controller, snapshot, { from: 'g1', to: 'f3' });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5', 'Nf3']);
      expect(snapshot.premoves).toBeNull();
    } finally { store.close(); }
  });

  it('restores the armed plan on undo so a replayed reply fires again', async () => {
    const { controller, initial, store } = await fixture();
    try {
      let snapshot = await controller.startGame(initial.fence, model);
      snapshot = await humanPlays(controller, snapshot, { from: 'e2', to: 'e4' });
      snapshot = await modelPlays(controller, snapshot, { move: 'e7e5', premoves: [{ on: ['g1f3'], then: 'g8f6' }] });
      snapshot = await humanPlays(controller, snapshot, { from: 'g1', to: 'f3' });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5', 'Nf3', 'Nf6']);
      snapshot = await controller.undo(snapshot.fence);
      expect(sansOf(snapshot)).toEqual(['e4', 'e5']);
      expect(snapshot.premoves).toEqual({ white: [], black: [{ trigger: 'g1f3', reply: 'g8f6', san: 'Nf6' }] });
      snapshot = await humanPlays(controller, snapshot, { from: 'g1', to: 'f3' });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5', 'Nf3', 'Nf6']);
    } finally { store.close(); }
  });

  it('chains both sides\' plans in an agent-versus-agent game', async () => {
    const { controller, initial, store } = await fixture({ white: model, black: model });
      console.log('SETUP SEEN:', JSON.stringify(initial.checkpoint.selections.players));
    try {
      let snapshot = await controller.startGame(initial.fence);
      expect(snapshot.checkpoint.selections.players).toEqual({ white: model, black: model });
      snapshot = await modelPlays(controller, snapshot, { move: 'e2e4', premoves: [{ on: ['e7e5'], then: 'g1f3' }] });
      expect(sansOf(snapshot)).toEqual(['e4']);
      // Black's reply arms its own plan; White's armed plan fires, and the chain then
      // answers it from Black's armed plan inside the same dispatch.
      snapshot = await modelPlays(controller, snapshot, { move: 'e7e5', premoves: [{ on: ['g1f3'], then: 'b8c6' }] });
      expect(sansOf(snapshot)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
      expect(snapshot.premoves).toBeNull();
    } finally { store.close(); }
  });

  it('keeps the premove event out of the public dispatch vocabulary', async () => {
    const { controller, initial, store } = await fixture();
    try {
      const snapshot = await controller.startGame(initial.fence, model);
      await expect(controller.dispatch({
        schemaVersion: 1, kind: 'premove', fence: snapshot.fence, move: { from: 'e2', to: 'e4' },
      })).rejects.toThrow();
    } finally { store.close(); }
  });
});
