import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { createDeadnessQuery, runProofSearchPass } from '../proofs/index.js';
import { openProofSearchStore } from './index.js';
import type { GameNamespaceV1 } from './index.js';

const scope = {
  gameId: 'persisted-search-game',
  segmentId: 'segment-9',
  positionRevision: '8',
  analysisGeneration: '5',
  ownershipEpoch: '2',
};

function databaseName(): string {
  return `proof-search-fixture-${Math.random().toString(36).slice(2)}`;
}

it('saves a multi-chunk checkpoint and resumes it after reopening the database', async () => {
  const query = createDeadnessQuery({
    ...scope,
    positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
  });
  const partial = await runProofSearchPass(query, { maxDiscoveredStates: 3 });
  if (partial.status !== 'non-result' || partial.checkpoint === null) {
    throw new Error('The state budget must produce a persisted checkpoint.');
  }
  const namespace: GameNamespaceV1 = { kind: 'account', accountId: 'account-21' };
  const name = databaseName();
  const factory = new IDBFactory();
  const firstStore = await openProofSearchStore({ databaseName: name, factory, chunkItemLimit: 2 });

  try {
    expect(await firstStore.loadCheckpoint({ namespace, gameId: query.gameId, queryIdentity: query.queryIdentity }))
      .toEqual({ status: 'missing' });
    const saved = await firstStore.saveCheckpoint({ namespace, checkpoint: partial.checkpoint });
    expect(saved).toMatchObject({ status: 'saved', chunkCount: 5 });
  } finally {
    firstStore.close();
  }

  const reopened = await openProofSearchStore({ databaseName: name, factory, chunkItemLimit: 2 });
  try {
    const loaded = await reopened.loadCheckpoint({ namespace, gameId: query.gameId, queryIdentity: query.queryIdentity });
    expect(loaded.status).toBe('found');
    expect(await reopened.loadCheckpoint({ namespace: { kind: 'guest' }, gameId: query.gameId, queryIdentity: query.queryIdentity }))
      .toEqual({ status: 'missing' });
    expect(await reopened.loadCheckpoint({ namespace, gameId: query.gameId, queryIdentity: 'changed-query-identity' }))
      .toEqual({ status: 'missing' });
    if (loaded.status !== 'found') throw new Error('The committed checkpoint must reload.');
    expect(loaded.checkpoint).toEqual(partial.checkpoint);

    let result = await runProofSearchPass(query, { checkpoint: loaded.checkpoint, maxDiscoveredStates: 1 });
    while (result.status === 'non-result' && result.checkpoint !== null && result.pass.totalDiscoveredStateCount < 8) {
      result = await runProofSearchPass(query, { checkpoint: result.checkpoint, maxDiscoveredStates: 1 });
    }
    expect(result).toMatchObject({ status: 'accepted', conclusion: 'dead' });
  } finally {
    reopened.close();
  }
});

it('refuses to persist a checkpoint with a forged legal edge', async () => {
  const query = createDeadnessQuery({
    ...scope,
    positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
  });
  const partial = await runProofSearchPass(query, { maxDiscoveredStates: 2 });
  if (partial.status !== 'non-result' || partial.checkpoint === null) throw new Error('The cycle pass must retain a checkpoint.');
  const corrupt = structuredClone(partial.checkpoint) as unknown as {
    stateRecords: Array<{ successors: Array<{ move: { from: string; to: string }; target: string }> }>;
    parentRecords: Array<{ stateKey: string; move: { from: string; to: string } | null }>;
  };
  const edge = corrupt.stateRecords[0]?.successors[0];
  if (!edge) throw new Error('The cycle root must have a successor.');
  edge.move = { from: 'a1', to: 'a2' };
  const parent = corrupt.parentRecords.find((record) => record.stateKey === edge.target);
  if (!parent) throw new Error('The cycle successor must have a parent.');
  parent.move = { from: 'a1', to: 'a2' };

  const namespace: GameNamespaceV1 = { kind: 'guest' };
  const name = databaseName();
  const store = await openProofSearchStore({ databaseName: name, factory: new IDBFactory() });
  try {
    await expect(store.saveCheckpoint({
      namespace,
      checkpoint: corrupt as unknown as typeof partial.checkpoint,
    })).rejects.toMatchObject({ code: 'invalid-data' });
    expect(await store.loadCheckpoint({ namespace, gameId: query.gameId, queryIdentity: query.queryIdentity }))
      .toEqual({ status: 'missing' });
  } finally {
    store.close();
  }
});

it('restarts from the saved query when a stored chunk fails its integrity check', async () => {
  const query = createDeadnessQuery({
    ...scope,
    positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
  });
  const partial = await runProofSearchPass(query, { maxDiscoveredStates: 1 });
  if (partial.status !== 'non-result' || partial.checkpoint === null) throw new Error('The search must pause.');
  const name = databaseName();
  const factory = new IDBFactory();
  const store = await openProofSearchStore({ databaseName: name, factory });
  const namespace: GameNamespaceV1 = { kind: 'guest' };
  const lookup = { namespace, gameId: query.gameId, queryIdentity: query.queryIdentity };

  try {
    await store.saveCheckpoint({ namespace, checkpoint: partial.checkpoint });
    const request = factory.open(name, 1);
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(['proofSearchChunks'], 'readwrite');
        const chunks = transaction.objectStore('proofSearchChunks');
        const read = chunks.getAll();
        read.onsuccess = () => {
          const first = read.result[0] as { chunkKey: string; sha256: string } | undefined;
          if (!first) {
            transaction.abort();
            reject(new Error('The checkpoint chunk is missing.'));
            return;
          }
          chunks.put({ ...first, sha256: '0'.repeat(64) });
        };
        read.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });

    expect(await store.loadCheckpoint(lookup)).toMatchObject({ status: 'restart-required', reason: 'corrupt-checkpoint', query });
    const restartQuery = await store.loadCheckpoint(lookup);
    if (restartQuery.status !== 'restart-required' || !restartQuery.query) throw new Error('The saved query must be available for a safe restart.');
    const restarted = await runProofSearchPass(restartQuery.query, { maxDiscoveredStates: 1 });
    expect(restarted).toMatchObject({ status: 'non-result', reason: 'state-budget', checkpointDisposition: 'fresh' });
  } finally {
    store.close();
  }
});

it('reports an aborted checkpoint write and leaves no partial save', async () => {
  const query = createDeadnessQuery({
    ...scope,
    positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
  });
  const partial = await runProofSearchPass(query, { maxDiscoveredStates: 1 });
  if (partial.status !== 'non-result' || partial.checkpoint === null) throw new Error('The search must pause.');
  const name = databaseName();
  const factory = new IDBFactory();
  let injectAbort = false;
  let abortScheduled = false;
  const originalOpen = factory.open.bind(factory);
  factory.open = ((databaseNameValue: string, version?: number) => {
    const request = originalOpen(databaseNameValue, version);
    request.addEventListener('success', () => {
      const database = request.result;
      const originalTransaction = database.transaction.bind(database);
      Object.defineProperty(database, 'transaction', {
        configurable: true,
        value: (storeNames: string | string[], mode?: IDBTransactionMode) => {
          const transaction = originalTransaction(storeNames as string[], mode);
          if (!injectAbort || mode !== 'readwrite') return transaction;
          injectAbort = false;
          const originalObjectStore = transaction.objectStore.bind(transaction);
          transaction.objectStore = ((storeName: string) => {
            const objectStore = originalObjectStore(storeName);
            if (storeName !== 'proofSearchChunks') return objectStore;
            const originalPut = objectStore.put.bind(objectStore);
            objectStore.put = ((value: unknown, key?: IDBValidKey) => {
              const write = key === undefined ? originalPut(value) : originalPut(value, key);
              if (abortScheduled) return write;
              abortScheduled = true;
              queueMicrotask(() => {
                (transaction as IDBTransaction & { error: DOMException | null }).error = new DOMException(
                  'Fixture quota failure',
                  'QuotaExceededError',
                );
                transaction.abort();
              });
              return write;
            }) as typeof objectStore.put;
            return objectStore;
          }) as IDBTransaction['objectStore'];
          return transaction;
        },
      });
    });
    return request;
  }) as IDBFactory['open'];
  const store = await openProofSearchStore({ databaseName: name, factory });
  const namespace: GameNamespaceV1 = { kind: 'guest' };
  const lookup = { namespace, gameId: query.gameId, queryIdentity: query.queryIdentity };
  injectAbort = true;

  try {
    await expect(store.saveCheckpoint({ namespace, checkpoint: partial.checkpoint })).rejects.toMatchObject({ code: 'quota' });
    expect(await store.loadCheckpoint(lookup)).toEqual({ status: 'missing' });
  } finally {
    store.close();
  }
});

it('recreates the saved query when a checkpoint version is incompatible', async () => {
  const query = createDeadnessQuery({
    ...scope,
    positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
  });
  const partial = await runProofSearchPass(query, { maxDiscoveredStates: 1 });
  if (partial.status !== 'non-result' || partial.checkpoint === null) throw new Error('The search must pause.');
  const name = databaseName();
  const factory = new IDBFactory();
  const store = await openProofSearchStore({ databaseName: name, factory });
  const namespace: GameNamespaceV1 = { kind: 'guest' };
  const lookup = { namespace, gameId: query.gameId, queryIdentity: query.queryIdentity };

  try {
    await store.saveCheckpoint({ namespace, checkpoint: partial.checkpoint });
    const request = factory.open(name, 1);
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(['proofSearchCheckpoints'], 'readwrite');
        const headers = transaction.objectStore('proofSearchCheckpoints');
        const read = headers.getAll();
        read.onsuccess = () => {
          const header = read.result[0] as { searchVersion: string; versions: { searchVersion: string } } | undefined;
          if (!header) {
            transaction.abort();
            reject(new Error('The checkpoint header is missing.'));
            return;
          }
          headers.put({
            ...header,
            searchVersion: 'kha31-cooperative-search/1',
            versions: { ...header.versions, searchVersion: 'kha31-cooperative-search/1' },
          });
        };
        read.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });

    const loaded = await store.loadCheckpoint(lookup);
    expect(loaded).toMatchObject({ status: 'restart-required', reason: 'incompatible-checkpoint', query });
    if (loaded.status !== 'restart-required' || !loaded.query) throw new Error('The saved query must be available.');
    const restarted = await runProofSearchPass(loaded.query, { maxDiscoveredStates: 1 });
    expect(restarted).toMatchObject({ status: 'non-result', reason: 'state-budget', checkpointDisposition: 'fresh' });
  } finally {
    store.close();
  }
});

it('closes its database connection when a newer tab requests an upgrade', async () => {
  const name = databaseName();
  const factory = new IDBFactory();
  const store = await openProofSearchStore({ databaseName: name, factory });

  try {
    const request = factory.open(name, 2);
    const outcome = await new Promise<'opened' | 'blocked'>((resolve) => {
      request.onblocked = () => resolve('blocked');
      request.onsuccess = () => {
        request.result.close();
        resolve('opened');
      };
      request.onerror = () => resolve('blocked');
    });

    expect(outcome).toBe('opened');
  } finally {
    store.close();
  }
});
