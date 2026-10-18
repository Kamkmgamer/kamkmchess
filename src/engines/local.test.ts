import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createEngineSelection, engineSettings, recommendEngine, runEngineTurn } from './local.js';
import { getOrCreateGameController, releaseGameController } from '../controller/index.js';
import { openGameStore } from '../storage/index.js';
import { exportGameArchive, unpackGameArchive } from '../archive/index.js';
import { searchBrowserEngine } from './browser.js';
vi.mock('./browser.js', async importOriginal => ({ ...await importOriginal<typeof import('./browser.js')>(), searchBrowserEngine: vi.fn() }));

const settings = { engineId: 'stockfish-lite' as const, hashMb: 32, moveTimeMs: 1000 };
afterEach(() => vi.unstubAllGlobals());

describe('local engines', () => {
  it('recommends conservative CPU and memory settings, including unknown hardware', () => {
    expect(recommendEngine({ logicalCores: 2, memoryGb: 2 })).toMatchObject({ engineId: 'stockfish-lite', hashMb: 16 });
    expect(recommendEngine({ logicalCores: 32, memoryGb: 64 })).toMatchObject({ engineId: 'stockfish-full', hashMb: 64 });
    expect(recommendEngine({ logicalCores: NaN, memoryGb: null })).toMatchObject({ engineId: 'stockfish-lite', hashMb: 16 });
  });

  it('validates saved engine identity and resource limits', () => {
    const selection = createEngineSelection(settings);
    expect(engineSettings(selection)).toEqual(settings);
    expect(() => engineSettings({ ...selection, modelRoutingId: 'lc0' })).toThrow();
    expect(() => createEngineSelection({ ...settings, hashMb: 999 })).toThrow();
  });

  it('runs both engine seats through fenced moves, archives each turn, and survives reload', async () => {
    const store = await openGameStore({ factory: new IDBFactory(), databaseName: crypto.randomUUID() });
    const gameId = crypto.randomUUID();
    const options = { gameId, store, clockPolicy: { maxReferenceDivergenceMs: 5000 } };
    let controller = getOrCreateGameController(options);
    const black = createEngineSelection({ ...settings, engineId: 'stockfish-full' });
    try {
      const initial = await controller.initialize({ humanSide: 'white', players: { white: createEngineSelection(settings), black },
        namespace: { kind: 'guest' }, ownershipEpoch: 0 });
      await controller.startGame(initial.fence);
      const requests: { engineId: string; moves: string[] }[] = [];
      vi.mocked(searchBrowserEngine).mockImplementation(async (engine, position) => {
        requests.push({ engineId: engine.engineId, moves: [...position.moves] });
        return { move: requests.length === 1 ? 'e2e4' : 'e7e5', engineName: engine.engineId, elapsedMs: 1 };
      });
      expect(await runEngineTurn(controller, new AbortController().signal)).toBe(true);
      expect(await runEngineTurn(controller, new AbortController().signal)).toBe(true);
      expect(requests).toMatchObject([{ engineId: 'stockfish-lite', moves: [] }, { engineId: 'stockfish-full', moves: ['e2e4'] }]);
      expect(controller.snapshot().checkpoint.rules.moves.map(move => move.san)).toEqual(['e4', 'e5']);
      const saved = (await store.readGame(gameId))!;
      expect(saved.events.filter(event => event.kind === 'model-turn-started')).toHaveLength(2);
      expect(saved.events.filter(event => event.kind === 'model-turn-transcript-finalized')).toHaveLength(2);
      const archive = await exportGameArchive(saved, []);
      expect((await unpackGameArchive(archive)).checkpoint.selections.players.black).toEqual(black);
      releaseGameController({ gameId, registryScope: 'guest', controller });
      controller = getOrCreateGameController(options);
      await controller.initialize(); await controller.reconcile();
      expect(controller.snapshot().checkpoint.selections.players.black).toEqual(black);
      expect(controller.snapshot().checkpoint.rules.moves).toHaveLength(2);
    } finally { releaseGameController({ gameId, registryScope: 'guest', controller }); store.close(); }
  });
});
