import { createAdjudicationAnalysisRunner } from '/src/adjudication/index.ts';
import { createControllerAnalysis } from '/src/adjudication-controller/index.ts';
import { getOrCreateGameController } from '/src/controller/index.ts';
import { openGameStore, openProofSearchStore } from '/src/storage/index.ts';

// Run through Vite in a browser. All data and computation stay on this device.
export async function runAdjudicationSmoke() {
  const suffix = crypto.randomUUID();
  const gameDatabase = `kha32-game-${suffix}`;
  const searchDatabase = `kha32-search-${suffix}`;
  const gameId = `kha32-${suffix}`;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  let gameStore;
  let searchStore;
  let analysis;
  const namespace = { kind: 'guest' };
  try {
    gameStore = await openGameStore({ databaseName: gameDatabase });
    searchStore = await openProofSearchStore({ databaseName: searchDatabase });
    let controller = getOrCreateGameController({
      gameId, store: gameStore, clockPolicy: { maxReferenceDivergenceMs: 50 },
    });
    const setup = await controller.initialize({
      humanSide: 'white', namespace, ownershipEpoch: 0,
      startingFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
      modelSelection: {
        kind: 'model', providerId: 'fixture', connectionId: 'local', configurationRevision: 0,
        modelRoutingId: 'unused', protocol: 'chat-completions', diagnostic: 'not-run',
      },
    });
    assert(setup.checkpoint.result.kind === 'pending-adjudication' &&
      setup.checkpoint.clocks.activeSide === null, 'Unknown setup must be saved with unstarted clocks.');
    const entryTime = setup.checkpoint.result.eventAtMs;
    const entryEvent = setup.checkpoint.result.eventId;
    analysis = createControllerAnalysis(controller, createAdjudicationAnalysisRunner({
      store: searchStore, maxDiscoveredStates: 1, timeBudgetMs: 5000,
    }));
    const partial = await analysis.continueAnalysis(setup.fence);
    assert(partial.checkpoint.result.kind === 'pending-adjudication' &&
      partial.checkpoint.clocks.activeSide === null, 'A bounded non-result must stay pending and unstarted.');
    await analysis.close();
    gameStore.close();
    searchStore.close();

    gameStore = await openGameStore({ databaseName: gameDatabase });
    searchStore = await openProofSearchStore({ databaseName: searchDatabase });
    // A fresh module instance models the controller registry of a reloaded page.
    const fresh = await import(`/src/controller/index.ts?reload=${suffix}`);
    controller = fresh.getOrCreateGameController({
      gameId, store: gameStore, clockPolicy: { maxReferenceDivergenceMs: 50 },
    });
    const restored = await controller.initialize();
    assert(restored.checkpoint.result.kind === 'pending-adjudication' &&
      restored.checkpoint.result.eventAtMs === entryTime, 'Reload must preserve the original candidate.');
    analysis = createControllerAnalysis(controller, createAdjudicationAnalysisRunner({
      store: searchStore, maxDiscoveredStates: 10, timeBudgetMs: 5000,
    }));
    const completed = await analysis.continueAnalysis(restored.fence);
    const result = completed.checkpoint.result;
    assert(result.kind === 'final' && result.winner === 'draw' && result.reason === 'dead-position' &&
      result.eventId === entryEvent && result.decidedAtMs === entryTime,
    'Checked deadness must settle the original position-entry event.');
    const saved = await gameStore.readGame(gameId);
    assert(saved?.checkpoint.result.kind === 'final', 'The accepted final result must be durable.');
    return {
      passed: true, userAgent: navigator.userAgent, origin: location.origin,
      setup: 'pending-unstarted', boundedPass: 'pending-unstarted',
      nativeIndexedDbReopen: true, realModuleWorker: true,
      final: { winner: result.winner, reason: result.reason, originalEventPreserved: true },
    };
  } finally {
    await analysis?.close(); gameStore?.close(); searchStore?.close();
    for (const name of [gameDatabase, searchDatabase]) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Smoke database cleanup blocked.'));
      });
    }
  }
}
