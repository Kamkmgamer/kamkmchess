import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createConnectionProfile, openConnectionStore } from '../providers/connections/index.js';
import { openGameStore } from '../storage/index.js';
import { controllerRevisionForConfig } from './opponent-selection.js';

const fixtureModel = {
  kind: 'model' as const,
  providerId: 'fixture',
  connectionId: 'fixture-connection',
  configurationRevision: 1,
  modelRoutingId: 'fixture-model',
  protocol: 'chat-completions' as const,
  diagnostic: 'passed-current-session' as const,
};

describe('match composition namespace boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses injected stores and keeps active games separate by namespace', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    let now = 1_000;
    const { MatchComposition } = await import('./match-composition.js');
    const gameStore = openGameStore({ databaseName: 'ui-match-composition-games', factory, now: () => now });
    const connectionStore = openConnectionStore({ databaseName: 'ui-match-composition-connections', factory });
    const guest = new MatchComposition({ gameStore, connectionStore });
    const account = new MatchComposition({
      namespace: { kind: 'account', accountId: 'account-A' }, gameStore, connectionStore,
    });

    try {
      const guestGame = await guest.startNewLocalGame({ humanSide: 'white' });
      now += 1_000;
      const accountGame = await account.openActiveGame();
      expect(accountGame.gameId).not.toBe(guestGame.gameId);
      expect(accountGame.restored).toBe(false);

      const guestReload = await guest.openActiveGame();
      expect(guestReload.gameId).toBe(guestGame.gameId);
      expect(guestReload.restored).toBe(true);
      expect(guestReload.controller.snapshot().checkpoint.namespace).toEqual({ kind: 'guest' });
      expect(account.namespace).toEqual({ kind: 'account', accountId: 'account-A' });
      expect(guest.registryScope).toBe(JSON.stringify({ kind: 'guest' }));
      expect(account.registryScope).toBe(JSON.stringify({ kind: 'account', accountId: 'account-A' }));
    } finally {
      (await gameStore).close();
    }
  });

  it('uses an explicit registry scope and suspends a producing turn without pausing its clock', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const { MatchComposition } = await import('./match-composition.js');
    const gameStore = openGameStore({ databaseName: 'ui-match-composition-suspend', factory });
    const connectionStore = openConnectionStore({ databaseName: 'ui-match-composition-suspend-connections', factory });
    const connections = await connectionStore;
    const namespace = { kind: 'account' as const, accountId: '123e4567-e89b-12d3-a456-426614174000' };
    const profile = await createConnectionProfile({ id: 'fixture-connection', name: 'Fixture', provider: 'openrouter' });
    await connections.saveProfile(namespace, profile);
    await connections.assignCredential(namespace, profile.id, { apiKey: 'synthetic-dispose-test-key' });
    await connections.recordDisclosureChoice(namespace, profile, { decision: 'accepted', recordedAtMs: Date.now() });
    const runSelection = {
      ...fixtureModel,
      providerId: profile.provider,
      connectionId: profile.id,
      configurationRevision: controllerRevisionForConfig(profile.configRevision),
      protocol: profile.protocol,
    };
    const composition = new MatchComposition({
      namespace,
      registryScope: 'cloud-db:suspend-account',
      gameStore,
      connectionStore,
    });
    const closeGameStore = vi.spyOn(await gameStore, 'close');
    let freshComposition: InstanceType<typeof MatchComposition> | null = null;

    try {
      expect(composition.registryScope).toBe('cloud-db:suspend-account');
      const session = await composition.startNewLocalGame({ humanSide: 'black', modelSelection: runSelection });
      let snapshot = session.controller.snapshot();
      expect(snapshot.adjudication.status).toBe('none');
      snapshot = await session.controller.startGame(snapshot.fence, runSelection);
      expect(snapshot.checkpoint.clocks.activeSide).toBe('white');
      const producing = await session.controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: snapshot.fence,
      });
      expect(producing.kind).toBe('model-turn-started');
      expect(producing.snapshot.modelHandoff.producing).not.toBeNull();
      const requestGeneration = producing.snapshot.checkpoint.requestGeneration;

      await composition.suspend();

      snapshot = session.controller.snapshot();
      expect(snapshot.checkpoint.requestGeneration).toBeGreaterThan(requestGeneration);
      expect(snapshot.checkpoint.result).toEqual({ kind: 'unresolved' });
      expect(snapshot.checkpoint.clocks.activeSide).toBe('white');
      expect(snapshot.clockReading?.status).toBe('running');
      expect((await composition.readSavedGame(session.gameId))?.checkpoint).toEqual(snapshot.checkpoint);
      const stoppedGeneration = snapshot.checkpoint.requestGeneration;
      await composition.suspend();
      expect(session.controller.snapshot().checkpoint.requestGeneration).toBe(stoppedGeneration);

      const reopened = await composition.openActiveGame();
      expect(reopened.gameId).toBe(session.gameId);
      expect(reopened.restored).toBe(true);
      const resumed = await reopened.controller.dispatch({
        schemaVersion: 1,
        kind: 'begin-model-turn',
        fence: reopened.controller.snapshot().fence,
      });
      expect(resumed.kind).toBe('model-turn-started');
      if (resumed.kind !== 'model-turn-started') throw new Error('The restored model turn did not reopen.');
      const manuallyStopped = await reopened.controller.dispatch({
        schemaVersion: 1, kind: 'stop-model-turn', fence: resumed.request.fence,
      });
      expect(manuallyStopped.kind).toBe('accepted');
      await composition.suspend();
      expect(reopened.controller.snapshot().checkpoint.requestGeneration).toBe(manuallyStopped.snapshot.checkpoint.requestGeneration);

      await composition.dispose();
      expect(closeGameStore).toHaveBeenCalledTimes(1);
      const lateCallback = await reopened.controller.dispatch({
        schemaVersion: 1,
        kind: 'model-turn-interrupted',
        reason: 'incomplete',
        fence: resumed.request.fence,
      });
      expect(lateCallback).toMatchObject({ kind: 'rejected', reason: 'stale-fence' });

      await composition.dispose();
      expect(closeGameStore).toHaveBeenCalledTimes(1);
      await expect(composition.openActiveGame()).rejects.toThrow(/disposed/);

      const reopenedStore = openGameStore({ databaseName: 'ui-match-composition-suspend', factory });
      freshComposition = new MatchComposition({
        namespace,
        registryScope: 'cloud-db:suspend-account',
        gameStore: reopenedStore,
        connectionStore,
      });
      const freshSession = await freshComposition.openActiveGame();
      const closeReopenedStore = vi.spyOn(await reopenedStore, 'close');
      expect(freshSession.controller).not.toBe(reopened.controller);
      expect(freshSession.gameId).toBe(session.gameId);
      expect(freshSession.restored).toBe(true);
      await freshSession.controller.reconcile();
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted by disposal fixture'), { name: 'AbortError' }));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener('abort', fail, { once: true });
      }));
      vi.stubGlobal('fetch', fetchMock);
      const pendingGeneration = freshComposition.runModelTurn(freshSession, profile.configRevision);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const lateFence = freshSession.controller.snapshot().fence;
      expect(freshSession.controller.snapshot().modelHandoff.producing).not.toBeNull();
      await freshComposition.dispose();
      expect(closeReopenedStore).toHaveBeenCalledTimes(1);
      expect((await pendingGeneration).kind).toBe('interrupted');
      const freshLateCallback = await freshSession.controller.dispatch({
        schemaVersion: 1, kind: 'model-turn-interrupted', reason: 'incomplete', fence: lateFence,
      });
      expect(freshLateCallback).toMatchObject({ kind: 'rejected', reason: 'stale-fence' });
      await expect(freshComposition.runModelTurn(freshSession, profile.configRevision)).rejects.toThrow(/disposed/);
    } finally {
      if (freshComposition !== null) await freshComposition.dispose();
      await composition.dispose();
    }
  });

  it('does not bind a session when disposal wins a pending active-game read', async () => {
    const values = new Map<string, string>([
      ['kamkmchess.active-game.v1:account:123e4567-e89b-12d3-a456-426614174000', 'pending-open-game'],
    ]);
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const { MatchComposition } = await import('./match-composition.js');
    const namespace = { kind: 'account' as const, accountId: '123e4567-e89b-12d3-a456-426614174000' };
    const originalStore = await openGameStore({ databaseName: 'ui-match-composition-open-race', factory });
    let finishRead!: (stored: null) => void;
    const readGate = new Promise<null>((resolve) => { finishRead = resolve; });
    const readGame = vi.spyOn(originalStore, 'readGame').mockReturnValue(readGate);
    const connectionStore = openConnectionStore({ databaseName: 'ui-match-composition-open-race-connections', factory });
    const composition = new MatchComposition({
      namespace,
      registryScope: 'cloud-db:open-race',
      gameStore: Promise.resolve(originalStore),
      connectionStore,
    });

    let replacement: InstanceType<typeof MatchComposition> | null = null;
    try {
      const opening = composition.openActiveGame();
      await vi.waitFor(() => expect(readGame).toHaveBeenCalledTimes(1));
      const disposal = composition.dispose();
      await disposal;
      finishRead(null);
      await expect(opening).rejects.toThrow(/disposed/);

      const replacementStore = openGameStore({ databaseName: 'ui-match-composition-open-race', factory });
      replacement = new MatchComposition({
        namespace,
        registryScope: 'cloud-db:open-race',
        gameStore: replacementStore,
        connectionStore,
      });
      const opened = await replacement.openActiveGame();
      expect(opened.gameId).toBe('pending-open-game');
      expect(opened.restored).toBe(false);
    } finally {
      if (replacement !== null) await replacement.dispose();
      await composition.dispose();
    }
  });
});
