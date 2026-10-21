import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { Chess } from 'chess.js';
import { openGameStore } from '../storage/index.js';
import { getOrCreateGameController, releaseGameController } from './index.js';
import type { GameControllerOptions } from './index.js';
import type { ModelSelection } from './index.js';

async function fixture(positionChecks?: GameControllerOptions['positionChecks'], startingFen?: string, modelSelection?: ModelSelection) {
  let now = 1_000;
  const gameId = crypto.randomUUID();
  const store = await openGameStore({ factory: new IDBFactory(), databaseName: gameId, now: () => now });
  const options = { gameId, store, clockPolicy: { maxReferenceDivergenceMs: 5 },
    timeSource: { sample: (at = now) => ({ monotonicMs: now, wallTimeMs: at }) } };
  const controller = getOrCreateGameController({ ...options, ...(positionChecks ? { positionChecks } : {}) });
  const initial = await controller.initialize({ humanSide: 'white', namespace: { kind: 'guest' }, ownershipEpoch: 0,
    ...(modelSelection ? { modelSelection } : {}),
    ...(startingFen ? { startingFen } : {}), timeControl: { startingTimeMs: 100_000, incrementMs: 0 } });
  return { options, controller, initial, store, advance: (ms: number) => { now += ms; } };
}

describe('live Lichess position checks', () => {
  // The cases below assert a flow of thirty plies and a chain of undos, not
  // a duration. Their timeout is a guard against a hang, so the speed of the
  // host may not turn a correct behaviour into a failure.
  it('starts and plays thirty plies with no proof work or nested undo snapshots', async () => {
    const { controller, initial, store } = await fixture();
    try {
      expect(initial.checkpoint.result).toEqual({ kind: 'unresolved' });
      expect(initial.adjudication).toMatchObject({ status: 'none', query: null });
      expect(await controller.continueAdjudication(initial.fence)).toBeNull();
      let snapshot = await controller.startGame(initial.fence);
      const reference = new Chess();
      const line = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 Nbd2 Bb7 Bc2 Re8 Nf1 Bf8 Ng3 g6 a4 c5';
      for (const san of line.split(' ')) {
        const move = reference.move(san);
        const result = await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: snapshot.fence,
          move: { from: move.from, to: move.to } });
        expect(result.kind).toBe('accepted');
        snapshot = result.snapshot;
        expect(snapshot.checkpoint.result).toEqual({ kind: 'unresolved' });
        expect(snapshot.adjudication.status).toBe('none');
        expect(snapshot.checkpoint.extensions.adjudication).toBeUndefined();
        const baseline = snapshot.checkpoint.extensions['undo-baseline']?.data;
        expect(baseline).not.toHaveProperty('extensions.undo-baseline');
      }
      expect(snapshot.checkpoint.rules.moves).toHaveLength(30);
      expect(JSON.stringify(snapshot.checkpoint).length).toBeLessThan(60_000);
      expect((await store.readGame(snapshot.checkpoint.gameId))?.events.some(event => event.kind === 'deadness-candidate-created')).toBe(false);
      const undone = await controller.undo(snapshot.fence);
      expect(undone.checkpoint.rules.moves.length).toBeLessThan(30);
      expect(undone.checkpoint.result.kind).toBe('unresolved');
      expect(undone.checkpoint.extensions.adjudication).toBeUndefined();
      let rewind = undone;
      for (let remaining = 28; remaining >= 0; remaining -= 1) {
        rewind = await controller.undo(rewind.fence);
        expect(rewind.checkpoint.rules.moves).toHaveLength(remaining);
      }
    } finally { store.close(); }
  }, 60_000);

  it('keeps repeated AI takebacks across reload without nested checkpoint snapshots', async () => {
    const model: ModelSelection = { kind: 'model', providerId: 'fixture', connectionId: 'fixture',
      configurationRevision: 0, modelRoutingId: 'fixture', protocol: 'chat-completions', diagnostic: 'passed-current-session' };
    const { controller, initial, options, store } = await fixture(undefined, undefined, model);
    try {
      let snapshot = await controller.startGame(initial.fence, model);
      for (const [human, reply] of [
        [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }],
        [{ from: 'g1', to: 'f3' }, { from: 'b8', to: 'c6' }],
      ] as const) {
        const played = await controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: snapshot.fence,
          move: human });
        expect(played.kind).toBe('accepted');
        const started = await controller.dispatch({ schemaVersion: 1, kind: 'begin-model-turn', fence: played.snapshot.fence });
        expect(started.kind).toBe('model-turn-started');
        const response = await controller.dispatch({ schemaVersion: 1, kind: 'model-move', fence: started.snapshot.fence,
          move: reply });
        expect(response.kind).toBe('accepted');
        snapshot = response.snapshot;
      }
      snapshot = await controller.undo(snapshot.fence);
      expect(snapshot.checkpoint.rules.moves).toHaveLength(2);
      releaseGameController({ gameId: options.gameId, registryScope: 'guest', controller });
      const restored = getOrCreateGameController(options);
      await restored.initialize();
      snapshot = await restored.reconcile();
      snapshot = await restored.undo(snapshot.fence);
      expect(snapshot.checkpoint.rules.moves).toHaveLength(0);
      expect(snapshot.checkpoint.selections.players.black).toEqual(model);
      expect(snapshot.adjudication.status).toBe('none');
    } finally { store.close(); }
  }, 60_000);

  it('migrates and persists an old running setup check without retaining its graph', async () => {
    const { controller, initial, options, store } = await fixture('legacy-proof');
    try {
      const work = await controller.continueAdjudication(initial.fence);
      expect(work).not.toBeNull();
      releaseGameController({ gameId: options.gameId, registryScope: 'guest', controller });
      const replacement = getOrCreateGameController(options);
      const restored = await replacement.initialize();
      expect(restored.checkpoint.result.kind).toBe('unresolved');
      expect(restored.adjudication.status).toBe('none');
      expect(restored.checkpoint.extensions.adjudication).toBeUndefined();
      expect((await store.readGame(options.gameId))?.checkpoint.extensions.adjudication).toBeUndefined();
      const started = await replacement.startGame(restored.fence);
      expect(started.clockReading?.status).toBe('running');
    } finally { store.close(); }
  });

  it('restores a running game and reconciles elapsed time without adding proof work', async () => {
    const { controller, initial, options, store, advance } = await fixture();
    try {
      await controller.startGame(initial.fence);
      releaseGameController({ gameId: options.gameId, registryScope: 'guest', controller });
      advance(500);
      const restored = getOrCreateGameController(options);
      await restored.initialize();
      const ready = await restored.reconcile();
      expect(ready.clockReading?.remaining?.whiteMs).toBe(99_500);
      expect(ready.adjudication.status).toBe('none');
      expect(ready.checkpoint.result.kind).toBe('unresolved');
    } finally { store.close(); }
  });

  it('draws insufficient material immediately and settles a flag without a worker', async () => {
    const dead = await fixture(undefined, '7k/8/6K1/8/8/8/8/8 w - - 0 1');
    try {
      expect(dead.initial.checkpoint.result).toMatchObject({ kind: 'final', winner: 'draw', reason: 'dead-position' });
      expect(dead.initial.adjudication.status).toBe('none');
    } finally { dead.store.close(); }
    const game = await fixture(undefined, '7k/8/6K1/8/8/8/Q7/8 w - - 0 1');
    try {
      await game.controller.startGame(game.initial.fence);
      game.advance(100_001);
      const expired = await game.controller.reconcile();
      expect(expired.checkpoint.result).toMatchObject({ kind: 'final', winner: 'draw', reason: 'timeout', decidedAtMs: 101_000 });
      expect(expired.adjudication.status).toBe('none');
      expect(expired.checkpoint.clocks.activeSide).toBeNull();
    } finally { game.store.close(); }
  });
});
