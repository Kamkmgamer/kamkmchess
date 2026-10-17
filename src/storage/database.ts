import { GameStorageError, classifyStorageFailure } from './errors';

export const DATABASE_VERSION = 1;
export const DATABASE_STORES = ['checkpoints', 'events', 'chunks', 'outbox'] as const;

export function openDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, DATABASE_VERSION);
    let settled = false;
    let upgradeStarted = false;
    request.onupgradeneeded = () => {
      upgradeStarted = true;
      const database = request.result;
      if (!database.objectStoreNames.contains('checkpoints')) {
        database.createObjectStore('checkpoints', { keyPath: 'gameId' });
      }
      if (!database.objectStoreNames.contains('events')) {
        const events = database.createObjectStore('events', { keyPath: 'eventId' });
        events.createIndex('byGame', 'gameId', { unique: false });
        events.createIndex('byGameSequence', ['gameId', 'sequence'], { unique: true });
      }
      if (!database.objectStoreNames.contains('chunks')) {
        const chunks = database.createObjectStore('chunks', { keyPath: 'chunkId' });
        chunks.createIndex('byGame', 'gameId', { unique: false });
        chunks.createIndex('byGameSequence', ['gameId', 'sequence'], { unique: true });
      }
      if (!database.objectStoreNames.contains('outbox')) {
        const outbox = database.createObjectStore('outbox', { keyPath: 'operationId' });
        outbox.createIndex('byGame', 'gameId', { unique: false });
      }
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new GameStorageError('upgrade-blocked', 'A previous tab is blocking the local database upgrade.'));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(
        upgradeStarted
          ? new GameStorageError('upgrade-failed', 'The local database upgrade did not complete.')
          : classifyStorageFailure(request.error),
      );
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
  });
}

export function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(classifyStorageFailure(transaction.error));
    transaction.onerror = () => {
      // The abort event carries the final transaction error.
    };
  });
}

export function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // An inactive transaction is already unable to commit further writes.
  }
}
