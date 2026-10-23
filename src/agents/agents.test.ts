import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { getOrCreateGameController, releaseGameController } from '../controller/index.js';
import type { ControllerSnapshotV1, GameController } from '../controller/index.js';
import { openGameStore } from '../storage/index.js';
import type { GameStore } from '../storage/index.js';
import { AgentBridge } from './bridge.js';
import type { AgentGameView } from './bridge.js';
import { createAgentSelection, cleanAgentName, isAgentSelection } from './seat.js';
import { runAgentTurn } from './turn.js';
import { callAgentTool, createAgentTools } from './tools.js';

interface Fixture { controller: GameController; store: GameStore; gameId: string; bridge: AgentBridge }
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const { controller, store, gameId } of fixtures.splice(0)) {
    releaseGameController({ gameId, registryScope: 'guest', controller });
    store.close();
  }
});

function view(snapshot: ControllerSnapshotV1): AgentGameView {
  const players = snapshot.checkpoint.selections.players;
  return {
    gameId: snapshot.checkpoint.gameId,
    agentSides: (['white', 'black'] as const).filter(side => isAgentSelection(players[side])),
    sideToMove: snapshot.position.sideToMove === 'w' ? 'white' : 'black',
    fen: snapshot.checkpoint.rules.currentFen,
    moves: snapshot.checkpoint.rules.moves.map(move => move.san).join(' '),
    status: snapshot.checkpoint.result.kind === 'final' ? 'finished' : 'active',
    result: snapshot.checkpoint.result.kind === 'final' ? snapshot.checkpoint.result.reason : null,
    clock: null,
  };
}

/** An agent playing White against a person, on a real controller and store. */
async function agentGame(): Promise<Fixture> {
  const store = await openGameStore({ factory: new IDBFactory(), databaseName: crypto.randomUUID() });
  const gameId = crypto.randomUUID();
  const controller = getOrCreateGameController({ gameId, store, clockPolicy: { maxReferenceDivergenceMs: 5000 } });
  const initial = await controller.initialize({ humanSide: 'black', players: { white: createAgentSelection(), black: { kind: 'human' } },
    namespace: { kind: 'guest' }, ownershipEpoch: 0 });
  await controller.startGame(initial.fence);
  const bridge = new AgentBridge();
  bridge.attachHost({ view: () => view(controller.snapshot()), startGame: () => Promise.reject<string>(new Error('not in this test')) });
  const fixture = { controller, store, gameId, bridge };
  fixtures.push(fixture);
  return fixture;
}

/** Drives agent turns the way the match page does: one fenced turn at a time, retrying after a correction. */
function driveTurns(fixture: Fixture, turns: number) {
  const abort = new AbortController();
  const done = (async () => {
    const outcomes = [];
    for (let index = 0; index < turns; index += 1) {
      const result = await runAgentTurn(fixture.controller, fixture.bridge, abort.signal);
      if (result.kind !== 'settled') break;
      outcomes.push(result.outcome);
      fixture.bridge.notify();
    }
    return outcomes;
  })();
  return { abort, done };
}

describe('agent seats', () => {
  it('cleans self-reported names', () => {
    expect(cleanAgentName('  Claude\u0000 Opus\n5.5 ')).toBe('Claude Opus 5.5');
    expect(cleanAgentName('')).toBeNull();
    expect(cleanAgentName(42)).toBeNull();
  });

  it('offers the compact model input, accepts a move and carries the plan into the next turn', async () => {
    const fixture = await agentGame();
    const tools = createAgentTools(fixture.bridge);
    const run = driveTurns(fixture, 1);
    await fixture.bridge.waitFor(() => fixture.bridge.currentTurn() !== null, 2000);
    const board = await callAgentTool(tools, 'get_board', {});
    expect(board).toMatchObject({ ok: true, result: { status: 'your-turn', yourSide: 'white', input: { kind: 'current-match-input', sideToMove: 'white' } } });
    expect(JSON.stringify(board.result)).not.toContain('legal');

    // make_move waits for the opponent's reply, so the person moves while it waits.
    const moving = callAgentTool(tools, 'make_move', { move: 'e2e4', plan: 'Take the centre, then develop the kingside.' });
    await run.done;
    expect(fixture.controller.snapshot().checkpoint.rules.moves.map(move => move.san)).toEqual(['e4']);
    const human = fixture.controller.snapshot();
    await fixture.controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: human.fence, move: { from: 'e7', to: 'e5' } });
    const next = driveTurns(fixture, 1);
    await expect(moving).resolves.toMatchObject({ ok: true, result: { result: 'accepted', board: { status: 'your-turn' } } });
    expect(fixture.bridge.currentTurn()?.input).toMatchObject({ previousThinking: { move: 'e2e4', plan: 'Take the centre, then develop the kingside.' } });
    next.abort.abort();
    await next.done.catch(() => undefined);
  });

  it('applies the illegal-move budget of API models: corrections, then a loss on the fourth', async () => {
    const fixture = await agentGame();
    const tools = createAgentTools(fixture.bridge);
    const run = driveTurns(fixture, 4);
    const results = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await fixture.bridge.waitFor(() => fixture.bridge.currentTurn() !== null, 2000);
      if (attempt > 0) expect(fixture.bridge.currentTurn()?.input).toMatchObject({ rejectedMoves: expect.any(Array) as unknown });
      results.push(await callAgentTool(tools, 'make_move', { move: 'e2e5' }));
    }
    await run.done;
    expect(results.slice(0, 3).map(result => (result.result as { result: string }).result)).toEqual(['illegal', 'illegal', 'illegal']);
    expect((results[3]!.result as { message: string }).message).toContain('fourth illegal move');
    expect(fixture.controller.snapshot().checkpoint.result).toMatchObject({ kind: 'final', winner: 'black' });
  });

  it('rejects moves out of turn and fences a stopped turn', async () => {
    const fixture = await agentGame();
    const tools = createAgentTools(fixture.bridge);
    await expect(callAgentTool(tools, 'make_move', { move: 'e2e4' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('not your turn') as unknown });
    const run = driveTurns(fixture, 1);
    await fixture.bridge.waitFor(() => fixture.bridge.currentTurn() !== null, 2000);
    run.abort.abort();
    await expect(run.done).rejects.toThrow();
    expect(fixture.bridge.currentTurn()).toBeNull();
    expect(fixture.controller.snapshot().checkpoint.rules.moves).toHaveLength(0);
    await expect(callAgentTool(tools, 'nope', {})).resolves.toMatchObject({ ok: false });
  });
});
