import type { AccountGameRepository } from '../accounts/indexeddb';
import type { CloudLocalPort } from './sync';
import type { ArchiveChunkV1, ArchiveEventV1, StoredGameV1 } from '../storage';
import { assertArchiveReferenceIntegrity, readArchiveChunk, readArchiveEvent, readGameCheckpoint, sha256Hex } from '../archive';

export interface IndexedDbCloudLocalOptions {
  readonly accountId: string;
  readonly games: AccountGameRepository;
  readonly factory?: IDBFactory;
  readonly metadataDatabaseName?: string;
  readonly knownCredentials?: (accountId: string) => Promise<readonly string[]>;
  readonly idFactory?: () => string;
  readonly now?: () => number;
}

interface CloudMetadataRecord {
  readonly gameId: string;
  readonly acknowledgedRevision: number | null;
  readonly ownershipEpoch: number;
  readonly checkpointRevision: number | null;
  readonly eventsThrough: number | null;
  readonly chunksThrough: number | null;
}

interface OperationRecord { readonly key: string; readonly gameId: string; readonly checkpointRevision: number; readonly operationId: string; readonly state: 'pending' | 'synced' }
interface PendingTakeoverRecord { readonly gameId: string; readonly expectedRevision: number; readonly expectedEpoch: number; readonly startedAtMs: number }

/** Durable, account scoped local adapter for the KHA-43 cloud sync coordinator. */
export function createIndexedDbCloudLocal(options: IndexedDbCloudLocalOptions): CloudLocalPort & {
  listConflicts(gameId?: string): Promise<readonly unknown[]>;
  readAcceptedSnapshot(gameId: string): Promise<unknown | null>;
  readMetadata(gameId: string): Promise<CloudMetadataRecord | null>;
  readPendingTakeover(gameId: string): Promise<PendingTakeoverRecord | null>;
} {
  const factory = options.factory ?? indexedDB;
  const databaseName = options.metadataDatabaseName ?? `kamkmchess-cloud-${encodeURIComponent(options.accountId)}`;
  const now = options.now ?? Date.now;
  const makeId = options.idFactory ?? (() => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${now()}-${Math.random()}`);

  return {
    async read(gameId) {
      await assertNotDeleted(factory, databaseName, gameId);
      return options.games.readAccountGame(options.accountId, gameId);
    },
    knownCredentials: async (accountId) => {
      if (accountId !== options.accountId) throw new Error('The requested account does not own this local cloud store.');
      if (!options.knownCredentials) throw new Error('The account credential inventory is unavailable; cloud sync is paused until it can be checked.');
      const values = await options.knownCredentials(accountId);
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) throw new Error('The account credential inventory is invalid; cloud sync is paused.');
      return values;
    },
    async acknowledgedArchiveCursor(gameId) {
      const record = await getRecord<CloudMetadataRecord>(factory, databaseName, 'metadata', gameId);
      return { eventsThrough: record?.eventsThrough ?? null, chunksThrough: record?.chunksThrough ?? null };
    },
    async stableOperationId(gameId, checkpointRevision) {
      await assertNotDeleted(factory, databaseName, gameId);
      const key = operationKey(gameId, checkpointRevision);
      const database = await openMetadataDatabase(factory, databaseName);
      try {
        const transaction = database.transaction('operations', 'readwrite');
        const completed = transactionDone(transaction);
        const store = transaction.objectStore('operations');
        const existing = await requestResult(store.get(key)) as OperationRecord | undefined;
        if (existing) { await completed; return existing.operationId; }
        const operationId = makeId();
        store.add({ key, gameId, checkpointRevision, operationId, state: 'pending' } satisfies OperationRecord);
        await completed;
        return operationId;
      } finally { database.close(); }
    },
    async prepareCloudCheckpoint(gameId, local, minimumRevision, epoch) {
      await assertNotDeleted(factory, databaseName, gameId);
      if (local.gameId !== gameId || local.namespace.kind !== 'account' || local.namespace.accountId !== options.accountId) throw new Error('The local checkpoint belongs to a different identity.');
      const metadata = await getRecord<CloudMetadataRecord>(factory, databaseName, 'metadata', gameId);
      const revision = Math.max(minimumRevision, (metadata?.checkpointRevision ?? 0) + 1, local.revision);
      return { ...local, revision, ownershipEpoch: epoch };
    },
    async recordAcknowledgement(gameId, cloudRevision, cloudEpoch, checkpointRevision, cursor) {
      const database = await openMetadataDatabase(factory, databaseName);
      try {
        const transaction = database.transaction(['metadata', 'operations'], 'readwrite');
        const completed = transactionDone(transaction);
        const metaStore = transaction.objectStore('metadata');
        const prior = await requestResult(metaStore.get(gameId)) as CloudMetadataRecord | undefined;
        if (prior && cloudRevision < (prior.acknowledgedRevision ?? 0)) {
          transaction.abort();
          await completed.catch(() => undefined);
          throw new Error('A stale cloud acknowledgement cannot replace newer local metadata.');
        }
        metaStore.put({
          gameId,
          acknowledgedRevision: cloudRevision,
          ownershipEpoch: cloudEpoch,
          checkpointRevision,
          eventsThrough: cursor.eventsThrough,
          chunksThrough: cursor.chunksThrough,
        } satisfies CloudMetadataRecord);
        const operations = transaction.objectStore('operations');
        const request = operations.index('byGame').openCursor();
        request.onsuccess = () => {
          const cursorValue = request.result;
          if (!cursorValue) return;
          const operation = cursorValue.value as OperationRecord;
          if (operation.gameId === gameId && operation.checkpointRevision <= checkpointRevision) cursorValue.update({ ...operation, state: 'synced' });
          cursorValue.continue();
        };
        await completed;
      } finally { database.close(); }
    },
    async preserveConflict(gameId, local, cloud) {
      const database = await openMetadataDatabase(factory, databaseName);
      try {
        const transaction = database.transaction('conflicts', 'readwrite');
        const completed = transactionDone(transaction);
        transaction.objectStore('conflicts').put({
          id: `${gameId}:${local.checkpoint.revision}:${local.checkpoint.ownershipEpoch}`,
          gameId,
          savedAtMs: now(),
          local: structuredClone(local),
          cloud: structuredClone(cloud),
        });
        await completed;
      } finally { database.close(); }
    },
    async preserveAcceptedCloudSnapshot(gameId, checkpoint, archiveBatch) {
      checkpoint = readGameCheckpoint(checkpoint);
      if (checkpoint.gameId !== gameId || checkpoint.namespace.kind !== 'account' || checkpoint.namespace.accountId !== options.accountId) throw new Error('The cloud snapshot belongs to a different identity.');
      const archive = await decodeArchiveBatch(archiveBatch, gameId, checkpoint);
      const database = await openMetadataDatabase(factory, databaseName);
      try {
        const transaction = database.transaction('acceptedSnapshots', 'readwrite');
        const completed = transactionDone(transaction);
        transaction.objectStore('acceptedSnapshots').put({ id: gameId, gameId, savedAtMs: now(), game: { checkpoint, events: archive.events, chunks: archive.chunks } satisfies StoredGameV1, archiveBatch });
        await completed;
      } finally { database.close(); }
      return { eventsThrough: archive.events.at(-1)?.sequence ?? null, chunksThrough: archive.chunks.at(-1)?.sequence ?? null };
    },
    async beginTakeoverAdoption(gameId, expectedRevision, expectedEpoch) {
      const db = await openMetadataDatabase(factory, databaseName);
      try {
        const transaction = db.transaction('pendingTakeovers', 'readwrite');
        const completed = transactionDone(transaction);
        transaction.objectStore('pendingTakeovers').put({ gameId, expectedRevision, expectedEpoch, startedAtMs: now() } satisfies PendingTakeoverRecord);
        await completed;
      } finally { db.close(); }
    },
    pendingTakeoverAdoption: (gameId) => getRecord(factory, databaseName, 'pendingTakeovers', gameId),
    async clearTakeoverAdoption(gameId) {
      const db = await openMetadataDatabase(factory, databaseName);
      try { const tx = db.transaction('pendingTakeovers', 'readwrite'); const done = transactionDone(tx); tx.objectStore('pendingTakeovers').delete(gameId); await done; }
      finally { db.close(); }
    },
    async adoptAcceptedCloudSnapshot(gameId, epoch) {
      const record = await getRecord<{ game?: StoredGameV1 }>(factory, databaseName, 'acceptedSnapshots', gameId);
      if (!record?.game || record.game.checkpoint.gameId !== gameId) throw new Error('The verified accepted cloud snapshot is unavailable for adoption.');
      return options.games.adoptCloudSnapshot(options.accountId, record.game, epoch);
    },
    async completeTakeoverAdoption(gameId, cloudRevision, cloudEpoch, checkpointRevision, cursor) {
      const db = await openMetadataDatabase(factory, databaseName);
      try {
        const tx = db.transaction(['metadata', 'operations', 'pendingTakeovers'], 'readwrite');
        const done = transactionDone(tx);
        tx.objectStore('metadata').put({ gameId, acknowledgedRevision: cloudRevision, ownershipEpoch: cloudEpoch, checkpointRevision, eventsThrough: cursor.eventsThrough, chunksThrough: cursor.chunksThrough } satisfies CloudMetadataRecord);
        tx.objectStore('pendingTakeovers').delete(gameId);
        const request = tx.objectStore('operations').index('byGame').openCursor();
        request.onsuccess = () => { const item = request.result; if (item) { const operation = item.value as OperationRecord; if (operation.gameId === gameId && operation.checkpointRevision <= checkpointRevision) item.update({ ...operation, state: 'synced' }); item.continue(); } };
        await done;
      } finally { db.close(); }
    },
    async applyOwnerDeletion(accountId, gameId) {
      if (accountId !== options.accountId) throw new Error('The requested account does not own this local cloud store.');
      const database = await openMetadataDatabase(factory, databaseName);
      try {
        const transaction = database.transaction(['metadata', 'operations', 'conflicts', 'acceptedSnapshots', 'tombstones', 'pendingTakeovers'], 'readwrite');
        const completed = transactionDone(transaction);
        transaction.objectStore('metadata').delete(gameId);
        transaction.objectStore('acceptedSnapshots').delete(gameId);
        transaction.objectStore('pendingTakeovers').delete(gameId);
        transaction.objectStore('tombstones').put({ gameId, deletedAtMs: now() });
        for (const storeName of ['operations', 'conflicts'] as const) {
          const request = transaction.objectStore(storeName).index('byGame').openCursor();
          request.onsuccess = () => { const cursor = request.result; if (cursor) { if ((cursor.value as { gameId?: string }).gameId === gameId) cursor.delete(); cursor.continue(); } };
        }
        await completed;
      } finally { database.close(); }
      await options.games.deleteAccountGame(accountId, gameId);
    },
    async listConflicts(gameId) { return (await listRecords(factory, databaseName, 'conflicts', gameId)).map((record) => deepFreeze(record)); },
    readAcceptedSnapshot: (gameId) => getRecord(factory, databaseName, 'acceptedSnapshots', gameId),
    readPendingTakeover: (gameId) => getRecord(factory, databaseName, 'pendingTakeovers', gameId),
    readMetadata: (gameId) => getRecord(factory, databaseName, 'metadata', gameId),
  };
}

async function decodeArchiveBatch(value: unknown, gameId: string, checkpoint: StoredGameV1['checkpoint']): Promise<{ events: ArchiveEventV1[]; chunks: ArchiveChunkV1[] }> {
  if (!isRecord(value) || value.format !== 'kamkmchess.cloud-archive-batch' || value.schemaVersion !== 1 || value.gameId !== gameId ||
      !Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 1 || !Number.isSafeInteger(value.baseOwnershipEpoch) || (value.baseOwnershipEpoch as number) < 1 ||
      value.checkpointRevision !== checkpoint.revision || !Array.isArray(value.events) || !Array.isArray(value.chunks)) throw new Error('The cloud archive batch is invalid.');
  const events = value.events.map((item) => readArchiveEvent(item));
  const chunks = value.chunks.map((item): ArchiveChunkV1 => {
    if (!isRecord(item) || typeof item.bytesBase64 !== 'string' || item.gameId !== gameId || item.egressStatus !== 'eligible') throw new Error('The cloud archive chunk is invalid or quarantined.');
    return readArchiveChunk({
      chunkId: item.chunkId, gameId: item.gameId, sequence: item.sequence, receivedAtMs: item.receivedAtMs,
      isFinal: item.isFinal, egressStatus: item.egressStatus, bytes: decodeBase64(item.bytesBase64), sha256: item.sha256,
    });
  });
  if (events.some((event) => event.gameId !== gameId || event.egressStatus !== 'eligible')) throw new Error('The cloud archive contains an event for another game or a quarantined event.');
  assertIncreasing(events.map((event) => event.sequence));
  assertIncreasing(chunks.map((chunk) => chunk.sequence));
  for (const chunk of chunks) if (await sha256Hex(chunk.bytes) !== chunk.sha256) throw new Error(`Cloud archive chunk ${chunk.chunkId} failed its digest check.`);
  assertArchiveReferenceIntegrity(checkpoint, events, chunks);
  return { events, chunks };
}

function operationKey(gameId: string, revision: number): string { return `${gameId}:${revision}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function assertIncreasing(values: readonly number[]): void {
  for (let index = 0; index < values.length; index += 1) if (!Number.isSafeInteger(values[index]) || values[index]! < 0 || (index > 0 && values[index]! <= values[index - 1]!)) throw new Error('The cloud archive sequence numbers are invalid.');
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('The cloud archive contains invalid base64 data.');
  let binary: string;
  try { binary = atob(value); } catch { throw new Error('The cloud archive contains invalid base64 data.'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  if (btoa(encoded) !== value) throw new Error('The cloud archive contains non-canonical base64 data.');
  return bytes;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function openMetadataDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'gameId' });
      if (!db.objectStoreNames.contains('operations')) { const store = db.createObjectStore('operations', { keyPath: 'key' }); store.createIndex('byGame', 'gameId', { unique: false }); }
      if (!db.objectStoreNames.contains('conflicts')) { const store = db.createObjectStore('conflicts', { keyPath: 'id' }); store.createIndex('byGame', 'gameId', { unique: false }); }
      if (!db.objectStoreNames.contains('acceptedSnapshots')) db.createObjectStore('acceptedSnapshots', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'gameId' });
      if (!db.objectStoreNames.contains('pendingTakeovers')) db.createObjectStore('pendingTakeovers', { keyPath: 'gameId' });
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open cloud sync metadata storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function getRecord<T>(factory: IDBFactory, databaseName: string, storeName: string, key: IDBValidKey): Promise<T | null> {
  const db = await openMetadataDatabase(factory, databaseName);
  try {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = transactionDone(transaction);
    const value = await requestResult(transaction.objectStore(storeName).get(key));
    await completed;
    return (value as T | undefined) ?? null;
  } finally { db.close(); }
}

async function assertNotDeleted(factory: IDBFactory, databaseName: string, gameId: string): Promise<void> {
  if (await getRecord(factory, databaseName, 'tombstones', gameId)) throw new Error('This account game has a deletion tombstone and cannot be synced.');
}

async function listRecords(factory: IDBFactory, databaseName: string, storeName: string, gameId?: string): Promise<readonly unknown[]> {
  const db = await openMetadataDatabase(factory, databaseName);
  try {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = transactionDone(transaction);
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    const result = await requestResult(request);
    await completed;
    return (result as Array<{ gameId?: string }>).filter((record) => !gameId || record.gameId === gameId);
  } finally { db.close(); }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function transactionDone(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error); }); }
