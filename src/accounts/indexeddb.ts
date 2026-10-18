import { openGameStore } from '../storage';
import { openDatabase } from '../storage/database';
import type { GameCheckpointV1, GameNamespaceV1, StoredGameV1 } from '../storage';
import type { GuestGameSummary, GuestImportPort } from './guest-import';
import { assertArchiveReferenceIntegrity, readArchiveChunk, readArchiveEvent, readGameCheckpoint, sha256Hex } from '../archive';
import { prepareOwnershipTakeover } from '../controller';

const GUEST_DATABASE = 'kamkmchess-local';

export interface IndexedDbAccountDataOptions {
  readonly factory?: IDBFactory;
  readonly guestDatabaseName?: string;
  readonly accountDatabasePrefix?: string;
  readonly now?: () => number;
}

export interface AccountGameRepository extends GuestImportPort {
  listAccountGames(accountId: string): Promise<readonly GuestGameSummary[]>;
  readAccountGame(accountId: string, gameId: string): Promise<StoredGameV1 | null>;
  deleteAccountGame(accountId: string, gameId: string): Promise<void>;
  adoptCloudSnapshot(accountId: string, game: StoredGameV1, epoch: number): Promise<{ readonly databaseName: string; readonly registryScope: string }>;
  resolveActiveGameDatabaseName(accountId: string, gameId: string): Promise<string>;
  close(): void;
}

/** Copies versioned game records between physically separate guest/account IndexedDB databases. */
export function createIndexedDbAccountData(options: IndexedDbAccountDataOptions = {}): AccountGameRepository {
  const factory = options.factory ?? indexedDB;
  const guestDatabaseName = options.guestDatabaseName ?? GUEST_DATABASE;
  const accountDatabasePrefix = options.accountDatabasePrefix ?? 'kamkmchess-account-';
  const now = options.now ?? Date.now;
  const databaseName = (accountId: string) => `${accountDatabasePrefix}${encodeURIComponent(accountId)}`;
  const accountDataName = (accountId: string) => `${databaseName(accountId)}-account-data`;

  return {
    async listGuestGames() {
      const guest = await openGameStore({ factory, databaseName: guestDatabaseName });
      try {
        const checkpoints = await readAllCheckpoints(factory, guestDatabaseName);
        const summaries: GuestGameSummary[] = [];
        for (const value of checkpoints) {
          if (!isCheckpoint(value) || value.namespace.kind !== 'guest') continue;
          const game = await guest.readGame(value.gameId);
          if (game) summaries.push(toSummary(game));
        }
        return summaries.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      } finally { guest.close(); }
    },
    async importGuestGame(gameId, accountId) {
      if (!accountId.trim()) throw new Error('A signed-in account is required to import guest games.');
      if (await hasTombstone(factory, accountDataName(accountId), gameId)) throw new Error('This account game has a deletion tombstone and cannot be restored by guest import.');
      const guest = await openGameStore({ factory, databaseName: guestDatabaseName });
      const account = await openGameStore({ factory, databaseName: databaseName(accountId) });
      try {
        const source = await guest.readGame(gameId);
        if (!source || source.checkpoint.namespace.kind !== 'guest') throw new Error('The selected guest game is unavailable. Refresh the import preview.');
        const checkpoint: GameCheckpointV1 = { ...source.checkpoint, namespace: { kind: 'account', accountId } };
        await account.importGameArchive(toArchive({ ...source, checkpoint }), []);
      } finally { guest.close(); account.close(); }
    },
    async listAccountGames(accountId) {
      const name = databaseName(accountId);
      const checkpoints = await readAllCheckpoints(factory, name);
      const candidates = new Set<string>();
      for (const value of checkpoints) if (isCheckpoint(value) && value.namespace.kind === 'account' && value.namespace.accountId === accountId) candidates.add(value.gameId);
      const active = await listActiveContinuations(factory, accountDataName(accountId));
      for (const pointer of active) {
        candidates.add(pointer.gameId);
        for (const value of await readAllCheckpoints(factory, pointer.databaseName)) {
          if (isCheckpoint(value) && value.namespace.kind === 'account' && value.namespace.accountId === accountId) candidates.add(value.gameId);
        }
      }
      const summaries: GuestGameSummary[] = [];
      for (const gameId of candidates) {
        if (await hasTombstone(factory, accountDataName(accountId), gameId)) continue;
        const game = await readFromDatabase(factory, await resolveDatabaseName(factory, accountDataName(accountId), name, gameId), gameId);
        if (game?.checkpoint.namespace.kind === 'account' && game.checkpoint.namespace.accountId === accountId) summaries.push(toSummary(game));
      }
      return summaries.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    },
    async readAccountGame(accountId, gameId) {
      if (await hasTombstone(factory, accountDataName(accountId), gameId)) return null;
      const game = await readFromDatabase(factory, await resolveDatabaseName(factory, accountDataName(accountId), databaseName(accountId), gameId), gameId);
      return game?.checkpoint.namespace.kind === 'account' && game.checkpoint.namespace.accountId === accountId ? game : null;
    },
    async deleteAccountGame(accountId, gameId) {
      const name = await resolveDatabaseName(factory, accountDataName(accountId), databaseName(accountId), gameId);
      await assertAccountGameOwner(factory, name, accountId, gameId);
      await addLocalTombstone(factory, accountDataName(accountId), gameId, now());
      let database: IDBDatabase | null = null;
      try {
        database = await openDatabase(factory, name);
        const transaction = database.transaction(['checkpoints', 'events', 'chunks', 'outbox'], 'readwrite');
        const checkpointStore = transaction.objectStore('checkpoints');
        const current = await requestResult(checkpointStore.get(gameId));
        if (current !== undefined && (!isCheckpoint(current) || current.namespace.kind !== 'account' || current.namespace.accountId !== accountId)) {
          transaction.abort();
          await transactionComplete(transaction).catch(() => undefined);
          throw new Error('A different identity owns this local account game.');
        }
        checkpointStore.delete(gameId);
        deleteByGame(transaction.objectStore('events').index('byGame'), gameId);
        deleteByGame(transaction.objectStore('chunks').index('byGame'), gameId);
        deleteByGame(transaction.objectStore('outbox').index('byGame'), gameId);
        await transactionComplete(transaction);
      } catch (error) {
        await removeLocalTombstone(factory, accountDataName(accountId), gameId).catch(() => undefined);
        throw error;
      } finally { database?.close(); }
    },
    async adoptCloudSnapshot(accountId, game, epoch) {
      if (!accountId.trim() || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('The accepted cloud identity is invalid.');
      const checkpoint = readGameCheckpoint(game.checkpoint);
      if (checkpoint.namespace.kind !== 'account' || checkpoint.namespace.accountId !== accountId || checkpoint.ownershipEpoch >= epoch) throw new Error('The accepted cloud game does not precede this account ownership epoch.');
      const events = game.events.map((event) => readArchiveEvent(event));
      const chunks = game.chunks.map((chunk) => readArchiveChunk(chunk));
      if (events.some((event) => event.egressStatus !== 'eligible') || chunks.some((chunk) => chunk.egressStatus !== 'eligible')) throw new Error('A quarantined cloud archive cannot become the active account game.');
      assertStrictSequence(events.map((event) => event.sequence), 'events');
      assertStrictSequence(chunks.map((chunk) => chunk.sequence), 'chunks');
      for (const chunk of chunks) if ((await sha256Hex(chunk.bytes)) !== chunk.sha256) throw new Error(`Cloud archive chunk ${chunk.chunkId} failed its digest check.`);
      assertArchiveReferenceIntegrity(checkpoint, events, chunks);
      const adoptedCheckpoint = prepareOwnershipTakeover(checkpoint, epoch);
      const continuationName = accountCloudContinuationDatabaseName(accountId, checkpoint.gameId, epoch, accountDatabasePrefix);
      const existing = await readFromDatabase(factory, continuationName, checkpoint.gameId);
      if (existing) {
        if (JSON.stringify(existing.checkpoint) !== JSON.stringify(adoptedCheckpoint) || JSON.stringify(existing.events) !== JSON.stringify(events) ||
            JSON.stringify(existing.chunks.map(chunkMetadata)) !== JSON.stringify(chunks.map(chunkMetadata)) ||
            existing.chunks.some((chunk, index) => !equalBytes(chunk.bytes, chunks[index]?.bytes))) {
          throw new Error('The existing takeover continuation does not match the verified accepted cloud snapshot.');
        }
        await setActiveContinuation(factory, accountDataName(accountId), { gameId: checkpoint.gameId, databaseName: continuationName, epoch });
        return { databaseName: continuationName, registryScope: JSON.stringify({ kind: 'account', accountId, databaseName: continuationName, gameId: checkpoint.gameId, ownershipEpoch: epoch }) };
      }
      const continuation = await openGameStore({ factory, databaseName: continuationName });
      try { await continuation.importGameArchive(toArchive({ checkpoint: adoptedCheckpoint, events, chunks }), []); }
      finally { continuation.close(); }
      await setActiveContinuation(factory, accountDataName(accountId), { gameId: checkpoint.gameId, databaseName: continuationName, epoch });
      return { databaseName: continuationName, registryScope: JSON.stringify({ kind: 'account', accountId, databaseName: continuationName, gameId: checkpoint.gameId, ownershipEpoch: epoch }) };
    },
    resolveActiveGameDatabaseName(accountId, gameId) {
      return resolveDatabaseName(factory, accountDataName(accountId), databaseName(accountId), gameId);
    },
    close() {},
  };
}

function toSummary(game: StoredGameV1): GuestGameSummary {
  const result = game.checkpoint.result.kind === 'final' ? `${game.checkpoint.result.winner} · ${game.checkpoint.result.reason}` : game.checkpoint.result.kind;
  return {
    gameId: game.checkpoint.gameId,
    updatedAtMs: game.checkpoint.updatedAtMs,
    revision: game.checkpoint.revision,
    result,
    hasDiscardedLines: game.checkpoint.archive.discardedLines.length > 0,
    practice: game.checkpoint.practice.mode === 'practice',
    unsynced: true,
  };
}

function toArchive(game: StoredGameV1): Record<string, unknown> {
  return {
    format: 'kamkmchess.game-archive',
    schemaVersion: 1,
    exportedAtMs: Date.now(),
    checkpoint: game.checkpoint,
    events: game.events,
    chunks: game.chunks.map(({ bytes, ...chunk }) => ({ ...chunk, bytesBase64: encodeBase64(bytes) })),
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function readAllCheckpoints(factory: IDBFactory, name: string): Promise<unknown[]> {
  const database = await openLocalDatabase(factory, name);
  try {
    const transaction = database.transaction('checkpoints', 'readonly');
    const done = transactionComplete(transaction);
    const values = await requestResult(transaction.objectStore('checkpoints').getAll());
    await done;
    return values;
  } finally { database.close(); }
}

function openLocalDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return openDatabase(factory, name);
}

function isCheckpoint(value: unknown): value is GameCheckpointV1 {
  return typeof value === 'object' && value !== null && 'gameId' in value && 'namespace' in value && 'updatedAtMs' in value;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error); });
}

function deleteByGame(index: IDBIndex, gameId: string): void {
  const request = index.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) { if ((cursor.value as { gameId?: string }).gameId === gameId) cursor.delete(); cursor.continue(); }
  };
}

async function addLocalTombstone(factory: IDBFactory, name: string, gameId: string, deletedAtMs: number): Promise<void> {
  const database = await openAccountDataDatabase(factory, name);
  try {
    const transaction = database.transaction('tombstones', 'readwrite');
    const completed = transactionComplete(transaction);
    transaction.objectStore('tombstones').put({ gameId, deletedAtMs });
    await completed;
  } finally { if (database.objectStoreNames.contains('tombstones')) database.close(); }
}

async function removeLocalTombstone(factory: IDBFactory, name: string, gameId: string): Promise<void> {
  const database = await openAccountDataDatabase(factory, name);
  try {
    const transaction = database.transaction('tombstones', 'readwrite');
    const completed = transactionComplete(transaction);
    transaction.objectStore('tombstones').delete(gameId);
    await completed;
  } finally { database.close(); }
}

async function assertAccountGameOwner(factory: IDBFactory, name: string, accountId: string, gameId: string): Promise<void> {
  const database = await openDatabase(factory, name);
  try {
    const transaction = database.transaction('checkpoints', 'readonly');
    const completed = transactionComplete(transaction);
    const current = await requestResult(transaction.objectStore('checkpoints').get(gameId));
    await completed;
    if (current !== undefined && (!isCheckpoint(current) || current.namespace.kind !== 'account' || current.namespace.accountId !== accountId)) {
      throw new Error('A different identity owns this local account game.');
    }
  } finally { database.close(); }
}

async function hasTombstone(factory: IDBFactory, name: string, gameId: string): Promise<boolean> {
  const exists = await new Promise<boolean>((resolve, reject) => {
    const request = factory.open(name, 2);
    request.onupgradeneeded = () => ensureAccountDataStores(request.result);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('tombstones', 'readonly');
      const get = transaction.objectStore('tombstones').get(gameId);
      get.onsuccess = () => { resolve(get.result !== undefined); db.close(); };
      get.onerror = () => { reject(get.error); db.close(); };
    };
  });
  return exists;
}

export function accountGameDatabaseName(accountId: string, prefix = 'kamkmchess-account-'): string { return `${prefix}${encodeURIComponent(accountId)}`; }
export function accountCloudContinuationDatabaseName(accountId: string, gameId: string, epoch: number, prefix = 'kamkmchess-account-'): string {
  return `${accountGameDatabaseName(accountId, prefix)}-cloud-${encodeURIComponent(gameId)}-${epoch}`;
}

export async function resolveActiveAccountGameDatabaseName(
  accountId: string,
  gameId: string,
  options: { readonly factory?: IDBFactory; readonly accountDatabasePrefix?: string } = {},
): Promise<string> {
  const factory = options.factory ?? indexedDB;
  const fallback = accountGameDatabaseName(accountId, options.accountDatabasePrefix);
  return resolveDatabaseName(factory, `${fallback}-account-data`, fallback, gameId);
}

interface ActiveContinuation { readonly gameId: string; readonly databaseName: string; readonly epoch: number; }

async function resolveDatabaseName(factory: IDBFactory, metadataName: string, fallback: string, gameId: string): Promise<string> {
  const active = await readActiveContinuation(factory, metadataName, gameId);
  if (active) return active.databaseName;
  const seen = new Set<string>();
  for (const pointer of await listActiveContinuations(factory, metadataName)) {
    if (seen.has(pointer.databaseName)) continue;
    seen.add(pointer.databaseName);
    for (const checkpoint of await readAllCheckpoints(factory, pointer.databaseName)) {
      if (isCheckpoint(checkpoint) && checkpoint.gameId === gameId && checkpoint.namespace.kind === 'account') return pointer.databaseName;
    }
  }
  return fallback;
}

async function readActiveContinuation(factory: IDBFactory, name: string, gameId: string): Promise<ActiveContinuation | null> {
  const db = await openAccountDataDatabase(factory, name);
  try {
    const transaction = db.transaction('activeContinuations', 'readonly');
    const done = transactionComplete(transaction);
    const record = await requestResult(transaction.objectStore('activeContinuations').get(gameId)) as ActiveContinuation | undefined;
    await done;
    return record ?? null;
  } finally { db.close(); }
}

async function listActiveContinuations(factory: IDBFactory, name: string): Promise<ActiveContinuation[]> {
  const db = await openAccountDataDatabase(factory, name);
  try {
    const transaction = db.transaction('activeContinuations', 'readonly');
    const done = transactionComplete(transaction);
    const records = await requestResult(transaction.objectStore('activeContinuations').getAll()) as ActiveContinuation[];
    await done;
    return records;
  } finally { db.close(); }
}

async function setActiveContinuation(factory: IDBFactory, name: string, record: ActiveContinuation): Promise<void> {
  const db = await openAccountDataDatabase(factory, name);
  try {
    const transaction = db.transaction('activeContinuations', 'readwrite');
    const done = transactionComplete(transaction);
    transaction.objectStore('activeContinuations').put(record);
    await done;
  } finally { db.close(); }
}

function openAccountDataDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 2);
    request.onupgradeneeded = () => ensureAccountDataStores(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open account metadata storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

function ensureAccountDataStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'gameId' });
  if (!db.objectStoreNames.contains('activeContinuations')) db.createObjectStore('activeContinuations', { keyPath: 'gameId' });
}

async function readFromDatabase(factory: IDBFactory, databaseName: string, gameId: string): Promise<StoredGameV1 | null> {
  const store = await openGameStore({ factory, databaseName });
  try { return await store.readGame(gameId); }
  finally { store.close(); }
}

function assertStrictSequence(values: readonly number[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isSafeInteger(values[index]) || values[index]! < 0 || (index > 0 && values[index]! <= values[index - 1]!)) {
      throw new Error(`The cloud archive ${label} must have strictly increasing sequence numbers.`);
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array | undefined): boolean {
  return !!right && left.length === right.length && left.every((value, index) => value === right[index]);
}

function chunkMetadata<T extends object>(chunk: T): object {
  return Object.fromEntries(Object.entries(chunk).filter(([key]) => key !== 'bytes'));
}

export type { GameNamespaceV1 };
