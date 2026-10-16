import {
  ArchiveError,
  checkpointHasCredentialEcho,
  checkpointWithQuarantine,
  exportGameArchive as buildGameArchiveExport,
  prepareArchiveRecords,
  unpackGameArchive,
} from '../archive';
import {
  assertArchiveReferenceIntegrity,
  readArchiveChunk,
  readArchiveEvent,
  readGameCheckpoint,
  verifyChunkDigest,
} from '../archive/validation';
import type { GameArchiveExportV1 } from '../archive/types';
import type { PreparedArchiveRecordsV1 } from '../archive';
import { abortTransaction, DATABASE_STORES, openDatabase, transactionCompletion } from './database';
import { GameStorageError, classifyStorageFailure } from './errors';
import type {
  CheckpointCommitInputV1,
  CheckpointCommitResultV1,
  CommitDecisionV1,
  GameCheckpointV1,
  GameNamespaceV1,
  GameStorageStatusV1,
  PersistencePermissionV1,
  StorageFailureCodeV1,
  StorageFailureV1,
  StoredGameV1,
  StoredOutboxRecordV1,
  SyncStatusV1,
} from './types';

const DEFAULT_DATABASE_NAME = 'kamkmchess-local';

export interface StorageManagerPort {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

export interface OpenGameStoreOptions {
  databaseName?: string;
  factory?: IDBFactory;
  now?: () => number;
  syncConfigured?: boolean;
}

export interface GameStore {
  commitCheckpoint(input: CheckpointCommitInputV1): Promise<CheckpointCommitResultV1>;
  readGame(gameId: string): Promise<StoredGameV1 | null>;
  readOutboxOperation(operationId: string): Promise<StoredOutboxRecordV1 | null>;
  markOutboxSynced(operationId: string, syncedRevision: number): Promise<StoredOutboxRecordV1>;
  markOutboxFailed(
    operationId: string,
    failureCode: NonNullable<StoredOutboxRecordV1['failureCode']>,
  ): Promise<StoredOutboxRecordV1>;
  exportGameArchive(gameId: string, knownCredentials: readonly string[]): Promise<GameArchiveExportV1>;
  importGameArchive(value: unknown, knownCredentials?: readonly string[]): Promise<StoredGameV1>;
  requestPersistentStorage(storageManager?: StorageManagerPort): Promise<PersistencePermissionV1>;
  status(gameId: string): Promise<GameStorageStatusV1>;
  close(): void;
}

interface ReadGameRawV1 {
  checkpoint: unknown;
  events: unknown[];
  chunks: unknown[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storageFailure(code: StorageFailureCodeV1, message: string): GameStorageError {
  return new GameStorageError(code, message);
}

function readGameNamespace(value: unknown): GameNamespaceV1 {
  if (!isPlainRecord(value)) throw storageFailure('invalid-data', 'The saved ownership namespace is invalid.');
  if (value.kind === 'guest' && Object.keys(value).length === 1) return { kind: 'guest' };
  if (
    value.kind === 'account' &&
    Object.keys(value).length === 2 &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0
  ) {
    return { kind: 'account', accountId: value.accountId };
  }
  throw storageFailure('invalid-data', 'The saved ownership namespace is invalid.');
}

function sameNamespace(left: GameNamespaceV1, right: GameNamespaceV1): boolean {
  return left.kind === right.kind && (left.kind === 'guest' || (right.kind === 'account' && left.accountId === right.accountId));
}

function readOutboxRecord(value: unknown): StoredOutboxRecordV1 {
  if (!isPlainRecord(value)) throw storageFailure('invalid-data', 'The saved outbox record is invalid.');
  const keys = [
    'operationId',
    'gameId',
    'namespace',
    'checkpointRevision',
    'ownershipEpoch',
    'createdAtMs',
    'state',
    'blockedReason',
    'failureCode',
    'syncedRevision',
  ];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw storageFailure('invalid-data', 'The saved outbox record has an unsupported shape.');
  }
  if (
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    typeof value.gameId !== 'string' ||
    value.gameId.length === 0 ||
    typeof value.checkpointRevision !== 'number' ||
    !Number.isSafeInteger(value.checkpointRevision) ||
    value.checkpointRevision < 1 ||
    typeof value.ownershipEpoch !== 'number' ||
    !Number.isSafeInteger(value.ownershipEpoch) ||
    value.ownershipEpoch < 0 ||
    typeof value.createdAtMs !== 'number' ||
    !Number.isFinite(value.createdAtMs)
  ) {
    throw storageFailure('invalid-data', 'The saved outbox record contains invalid metadata.');
  }
  if (value.state !== 'pending' && value.state !== 'blocked' && value.state !== 'synced' && value.state !== 'failed') {
    throw storageFailure('invalid-data', 'The saved outbox record has an unsupported state.');
  }
  if (value.blockedReason !== null && value.blockedReason !== 'credential-echo') {
    throw storageFailure('invalid-data', 'The saved outbox record has an unsupported block reason.');
  }
  if (
    value.failureCode !== null &&
    value.failureCode !== 'network' &&
    value.failureCode !== 'authentication' &&
    value.failureCode !== 'conflict' &&
    value.failureCode !== 'unknown'
  ) {
    throw storageFailure('invalid-data', 'The saved outbox record has an unsupported failure code.');
  }
  if (
    value.syncedRevision !== null &&
    (typeof value.syncedRevision !== 'number' || !Number.isSafeInteger(value.syncedRevision) || value.syncedRevision < 0)
  ) {
    throw storageFailure('invalid-data', 'The saved outbox record has an invalid synced revision.');
  }
  if (
    (value.state === 'blocked') !== (value.blockedReason === 'credential-echo') ||
    (value.state === 'synced') !== (value.syncedRevision !== null) ||
    (value.state === 'failed') !== (value.failureCode !== null)
  ) {
    throw storageFailure('invalid-data', 'The saved outbox record has inconsistent status metadata.');
  }
  return {
    operationId: value.operationId,
    gameId: value.gameId,
    namespace: readGameNamespace(value.namespace),
    checkpointRevision: value.checkpointRevision,
    ownershipEpoch: value.ownershipEpoch,
    createdAtMs: value.createdAtMs,
    state: value.state,
    blockedReason: value.blockedReason,
    failureCode: value.failureCode,
    syncedRevision: value.syncedRevision,
  };
}

function storageManagerFromBrowser(): StorageManagerPort | undefined {
  if (typeof navigator === 'undefined' || !('storage' in navigator)) return undefined;
  return navigator.storage;
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    return typeof Reflect.get(value, 'then') === 'function';
  } catch {
    return true;
  }
}

function decisionObject(value: unknown): CommitDecisionV1 {
  if (!isPlainRecord(value)) throw storageFailure('invalid-data', 'The commit decision must be a plain object.');
  const expectedKeys = ['checkpoint', 'outboxOperationIds'];
  if (
    Object.keys(value).some((key) => !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw storageFailure('invalid-data', 'The commit decision has an unsupported shape.');
  }
  if (!Array.isArray(value.outboxOperationIds)) {
    throw storageFailure('invalid-data', 'The commit decision outbox IDs must be an array.');
  }
  const outboxOperationIds = value.outboxOperationIds.map((operationId) => {
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw storageFailure('invalid-data', 'The commit decision contains an invalid outbox ID.');
    }
    return operationId;
  });
  if (new Set(outboxOperationIds).size !== outboxOperationIds.length) {
    throw storageFailure('invalid-data', 'The commit decision repeats an outbox ID.');
  }
  return { checkpoint: readGameCheckpoint(value.checkpoint), outboxOperationIds };
}

function sameOutboxOperation(left: StoredOutboxRecordV1, right: StoredOutboxRecordV1): boolean {
  return (
    left.operationId === right.operationId &&
    left.gameId === right.gameId &&
    sameNamespace(left.namespace, right.namespace) &&
    left.checkpointRevision === right.checkpointRevision &&
    left.ownershipEpoch === right.ownershipEpoch &&
    left.createdAtMs === right.createdAtMs
  );
}

function safeTransaction(database: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  try {
    return database.transaction([...DATABASE_STORES], mode);
  } catch (error) {
    throw classifyStorageFailure(error);
  }
}

class IndexedDbGameStore implements GameStore {
  private persistenceState: PersistencePermissionV1 = 'not-requested';
  private lastFailure: StorageFailureV1 | null = null;
  private lastFailureGameId: string | null = null;
  private closed = false;

  constructor(
    private readonly database: IDBDatabase,
    private readonly now: () => number,
    private readonly syncConfigured: boolean,
  ) {
    database.onversionchange = () => {
      database.close();
      this.closed = true;
      this.recordFailure('upgrade-failed');
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private recordFailure(code: StorageFailureCodeV1, gameId: string | null = null): void {
    this.lastFailure = { code, occurredAtMs: this.now() };
    this.lastFailureGameId = gameId;
  }

  private recordSuccessfulSave(gameId: string): void {
    if (this.lastFailureGameId === null || this.lastFailureGameId === gameId) {
      this.lastFailure = null;
      this.lastFailureGameId = null;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw storageFailure('unavailable', 'The local database connection is closed.');
  }

  async commitCheckpoint(input: CheckpointCommitInputV1): Promise<CheckpointCommitResultV1> {
    this.ensureOpen();
    if (
      typeof input.gameId !== 'string' ||
      input.gameId.length === 0 ||
      !Number.isSafeInteger(input.expectedEpoch) ||
      input.expectedEpoch < 0 ||
      (input.expectedRevision !== null &&
        (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) ||
      !Array.isArray(input.events) ||
      !Array.isArray(input.chunks) ||
      !Array.isArray(input.knownCredentials) ||
      input.knownCredentials.some((credential) => typeof credential !== 'string') ||
      typeof input.decide !== 'function'
    ) {
      throw storageFailure('invalid-data', 'The checkpoint commit fence is invalid.');
    }
    const knownCredentials = [...input.knownCredentials];

    let prepared: PreparedArchiveRecordsV1;
    try {
      prepared = await prepareArchiveRecords(input.events, input.chunks, knownCredentials);
    } catch (error) {
      this.recordFailure(error instanceof ArchiveError ? 'invalid-data' : 'unknown', input.gameId);
      throw error instanceof ArchiveError
        ? storageFailure('invalid-data', 'The archive records could not be prepared for storage.')
        : classifyStorageFailure(error);
    }

    const transaction = safeTransaction(this.database, 'readwrite');
    const completed = transactionCompletion(transaction);
    const checkpointStore = transaction.objectStore('checkpoints');
    const eventStore = transaction.objectStore('events');
    const chunkStore = transaction.objectStore('chunks');
    const outboxStore = transaction.objectStore('outbox');
    const commitOutcome: { value: CheckpointCommitResultV1 | null } = { value: null };
    const transactionFailure: { operation: GameStorageError | null } = { operation: null };

    const work = new Promise<void>((resolve) => {
      const checkpointRequest = checkpointStore.get(input.gameId);
      const eventsRequest = eventStore.index('byGame').getAll(input.gameId);
      const chunksRequest = chunkStore.index('byGame').getAll(input.gameId);
      const outboxRequest = outboxStore.getAll();
      let pending = 4;
      let checkpointValue: unknown;
      let eventValues: unknown[] = [];
      let chunkValues: unknown[] = [];
      let outboxValues: unknown[] = [];
      let requestFailed = false;

      const failRequest = () => {
        if (requestFailed) return;
        requestFailed = true;
        transactionFailure.operation = storageFailure('transaction-aborted', 'A local read failed before the checkpoint write.');
        abortTransaction(transaction);
        resolve();
      };
      const received = () => {
        pending -= 1;
        if (pending !== 0 || requestFailed) return;
        try {
          const currentCheckpoint =
            checkpointValue === undefined ? null : readGameCheckpoint(checkpointValue);
          const actualRevision = currentCheckpoint?.revision ?? null;
          const actualEpoch = currentCheckpoint?.ownershipEpoch ?? null;
          if (actualRevision !== input.expectedRevision || (actualEpoch ?? input.expectedEpoch) !== input.expectedEpoch) {
            commitOutcome.value = { kind: 'revision-conflict', actualRevision, actualEpoch };
            resolve();
            return;
          }

          const existingEvents = eventValues.map((event) => readArchiveEvent(event));
          const existingChunks = chunkValues.map((chunk) => readArchiveChunk(chunk));
          const existingOutbox = outboxValues.map((record) => readOutboxRecord(record));
          const decisionTimeMs = this.now();
          const rawDecision: unknown = input.decide(decisionTimeMs);
          if (isThenable(rawDecision)) {
            if (rawDecision instanceof Promise) void rawDecision.catch(() => undefined);
            throw storageFailure('invalid-data', 'The checkpoint decision hook must return synchronously.');
          }
          const decision = decisionObject(rawDecision);
          const expectedRevision = input.expectedRevision === null ? 1 : input.expectedRevision + 1;
          const ownershipEpochIsValid = currentCheckpoint
            ? decision.checkpoint.ownershipEpoch >= input.expectedEpoch
            : decision.checkpoint.ownershipEpoch === input.expectedEpoch;
          if (
            decision.checkpoint.gameId !== input.gameId ||
            (currentCheckpoint !== null && !sameNamespace(decision.checkpoint.namespace, currentCheckpoint.namespace)) ||
            !Number.isSafeInteger(expectedRevision) ||
            decision.checkpoint.revision !== expectedRevision ||
            !ownershipEpochIsValid
          ) {
            throw storageFailure('invalid-data', 'The checkpoint does not match its commit fence.');
          }

          const allEvents = [...existingEvents, ...prepared.events].sort((left, right) => left.sequence - right.sequence);
          const allChunks = [...existingChunks, ...prepared.chunks].sort((left, right) => left.sequence - right.sequence);
          const quarantined =
            prepared.quarantined ||
            checkpointHasCredentialEcho(decision.checkpoint, knownCredentials) ||
            currentCheckpoint?.archive.egressStatus === 'credential-echo-quarantined' ||
            allEvents.some((event) => event.egressStatus === 'credential-echo-quarantined') ||
            allChunks.some((chunk) => chunk.egressStatus === 'credential-echo-quarantined');
          const committedCheckpoint = checkpointWithQuarantine(decision.checkpoint, quarantined);
          assertArchiveReferenceIntegrity(committedCheckpoint, allEvents, allChunks);

          const priorOutbox = new Map(existingOutbox.map((record) => [record.operationId, record]));
          for (const event of prepared.events) eventStore.add(event);
          for (const chunk of prepared.chunks) chunkStore.add(chunk);
          checkpointStore.put(committedCheckpoint);
          for (const operationId of decision.outboxOperationIds) {
            const proposed: StoredOutboxRecordV1 = {
              operationId,
              gameId: input.gameId,
              namespace: committedCheckpoint.namespace,
              checkpointRevision: committedCheckpoint.revision,
              ownershipEpoch: committedCheckpoint.ownershipEpoch,
              createdAtMs: decisionTimeMs,
              state: quarantined ? 'blocked' : 'pending',
              blockedReason: quarantined ? 'credential-echo' : null,
              failureCode: null,
              syncedRevision: null,
            };
            const previous = priorOutbox.get(operationId);
            if (previous) {
              if (!sameOutboxOperation(previous, proposed)) {
                throw storageFailure('invalid-data', 'An outbox ID was reused for a different operation.');
              }
            } else {
              outboxStore.add(proposed);
            }
          }
          commitOutcome.value = { kind: 'committed', checkpoint: committedCheckpoint, decisionTimeMs };
          resolve();
        } catch (error) {
          transactionFailure.operation =
            error instanceof GameStorageError
              ? error
              : storageFailure('transaction-aborted', 'The checkpoint transaction was aborted.');
          abortTransaction(transaction);
          resolve();
        }
      };

      checkpointRequest.onsuccess = () => {
        checkpointValue = checkpointRequest.result;
        received();
      };
      eventsRequest.onsuccess = () => {
        eventValues = eventsRequest.result;
        received();
      };
      chunksRequest.onsuccess = () => {
        chunkValues = chunksRequest.result;
        received();
      };
      outboxRequest.onsuccess = () => {
        outboxValues = outboxRequest.result;
        received();
      };
      checkpointRequest.onerror = failRequest;
      eventsRequest.onerror = failRequest;
      chunksRequest.onerror = failRequest;
      outboxRequest.onerror = failRequest;
    });

    await work;
    try {
      await completed;
    } catch (error) {
      const failure = transactionFailure.operation ?? classifyStorageFailure(error);
      this.recordFailure(failure.code, input.gameId);
      throw failure;
    }
    if (transactionFailure.operation) {
      this.recordFailure(transactionFailure.operation.code, input.gameId);
      throw transactionFailure.operation;
    }
    if (!commitOutcome.value) {
      this.recordFailure('transaction-aborted', input.gameId);
      throw storageFailure('transaction-aborted', 'The checkpoint transaction ended without a result.');
    }
    if (commitOutcome.value.kind === 'committed') this.recordSuccessfulSave(input.gameId);
    return commitOutcome.value;
  }

  async readGame(gameId: string): Promise<StoredGameV1 | null> {
    this.ensureOpen();
    const transaction = safeTransaction(this.database, 'readonly');
    const completed = transactionCompletion(transaction);
    const checkpointRequest = transaction.objectStore('checkpoints').get(gameId);
    const eventsRequest = transaction.objectStore('events').index('byGame').getAll(gameId);
    const chunksRequest = transaction.objectStore('chunks').index('byGame').getAll(gameId);
    const readFailure: { value: GameStorageError | null } = { value: null };
    const readResult = await new Promise<ReadGameRawV1>((resolve) => {
      let remaining = 3;
      let checkpoint: unknown;
      let events: unknown[] = [];
      let chunks: unknown[] = [];
      let failed = false;
      const done = () => {
        remaining -= 1;
        if (remaining === 0 && !failed) resolve({ checkpoint, events, chunks });
      };
      const fail = () => {
        if (failed) return;
        failed = true;
        readFailure.value = classifyStorageFailure(checkpointRequest.error ?? eventsRequest.error ?? chunksRequest.error);
        abortTransaction(transaction);
        resolve({ checkpoint: undefined, events: [], chunks: [] });
      };
      checkpointRequest.onsuccess = () => {
        checkpoint = checkpointRequest.result;
        done();
      };
      eventsRequest.onsuccess = () => {
        events = eventsRequest.result;
        done();
      };
      chunksRequest.onsuccess = () => {
        chunks = chunksRequest.result;
        done();
      };
      checkpointRequest.onerror = fail;
      eventsRequest.onerror = fail;
      chunksRequest.onerror = fail;
    });
    try {
      await completed;
    } catch (error) {
      const failure = readFailure.value ?? classifyStorageFailure(error);
      this.recordFailure(failure.code, gameId);
      throw failure;
    }
    if (readFailure.value) {
      this.recordFailure(readFailure.value.code, gameId);
      throw readFailure.value;
    }

    if (readResult.checkpoint === undefined) {
      if (readResult.events.length > 0 || readResult.chunks.length > 0) {
        this.recordFailure('invalid-data', gameId);
        throw storageFailure('invalid-data', 'Archive records exist without a committed checkpoint.');
      }
      return null;
    }

    try {
      const checkpoint = readGameCheckpoint(readResult.checkpoint);
      const events = readResult.events.map((event) => readArchiveEvent(event)).sort((a, b) => a.sequence - b.sequence);
      const chunks = readResult.chunks.map((chunk) => readArchiveChunk(chunk)).sort((a, b) => a.sequence - b.sequence);
      for (const chunk of chunks) await verifyChunkDigest(chunk);
      assertArchiveReferenceIntegrity(checkpoint, events, chunks);
      return { checkpoint, events, chunks };
    } catch {
      this.recordFailure('invalid-data', gameId);
      throw storageFailure('invalid-data', 'The saved game failed its integrity check.');
    }
  }

  async readOutboxOperation(operationId: string): Promise<StoredOutboxRecordV1 | null> {
    this.ensureOpen();
    const transaction = safeTransaction(this.database, 'readonly');
    const completed = transactionCompletion(transaction);
    const request = transaction.objectStore('outbox').get(operationId);
    let requestFailure: GameStorageError | null = null;
    const value = await new Promise<unknown>((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        requestFailure = classifyStorageFailure(request.error);
        abortTransaction(transaction);
        resolve(undefined);
      };
    });
    try {
      await completed;
    } catch (error) {
      throw requestFailure ?? classifyStorageFailure(error);
    }
    if (requestFailure) throw requestFailure;
    return value === undefined ? null : readOutboxRecord(value);
  }

  markOutboxSynced(operationId: string, syncedRevision: number): Promise<StoredOutboxRecordV1> {
    return this.updateOutbox(operationId, (record) => {
      if (record.state === 'blocked') {
        throw storageFailure('invalid-data', 'A blocked outbox operation cannot be marked synced.');
      }
      if (!Number.isSafeInteger(syncedRevision) || syncedRevision < 0) {
        throw storageFailure('invalid-data', 'The synced revision is invalid.');
      }
      if (record.state === 'synced') {
        if (record.syncedRevision === syncedRevision) return record;
        throw storageFailure('invalid-data', 'A synced outbox operation cannot change its acknowledged revision.');
      }
      return { ...record, state: 'synced', failureCode: null, syncedRevision };
    });
  }

  markOutboxFailed(
    operationId: string,
    failureCode: NonNullable<StoredOutboxRecordV1['failureCode']>,
  ): Promise<StoredOutboxRecordV1> {
    return this.updateOutbox(operationId, (record) => {
      if (record.state === 'blocked') return record;
      if (record.state === 'synced') {
        throw storageFailure('invalid-data', 'A synced outbox operation cannot be marked failed.');
      }
      if (!['network', 'authentication', 'conflict', 'unknown'].includes(failureCode)) {
        throw storageFailure('invalid-data', 'The outbox failure code is invalid.');
      }
      return { ...record, state: 'failed', failureCode, syncedRevision: null };
    });
  }

  private async updateOutbox(
    operationId: string,
    update: (record: StoredOutboxRecordV1) => StoredOutboxRecordV1,
  ): Promise<StoredOutboxRecordV1> {
    this.ensureOpen();
    const transaction = safeTransaction(this.database, 'readwrite');
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore('outbox');
    let updated: StoredOutboxRecordV1 | null = null;
    let failure: GameStorageError | null = null;
    const request = store.get(operationId);
    request.onsuccess = () => {
      try {
        if (request.result === undefined) throw storageFailure('invalid-data', 'The outbox operation does not exist.');
        updated = readOutboxRecord(update(readOutboxRecord(request.result)));
        store.put(updated);
      } catch (error) {
        failure = error instanceof GameStorageError ? error : storageFailure('invalid-data', 'The outbox update failed.');
        abortTransaction(transaction);
      }
    };
    request.onerror = () => abortTransaction(transaction);
    try {
      await completed;
    } catch (error) {
      const recorded = failure ?? classifyStorageFailure(error);
      this.recordFailure(recorded.code);
      throw recorded;
    }
    if (failure || !updated) {
      const recorded = failure ?? storageFailure('transaction-aborted', 'The outbox update did not complete.');
      this.recordFailure(recorded.code);
      throw recorded;
    }
    return updated;
  }

  async exportGameArchive(gameId: string, knownCredentials: readonly string[]): Promise<GameArchiveExportV1> {
    const snapshot = await this.readGame(gameId);
    if (!snapshot) throw storageFailure('invalid-data', 'The requested game has no committed checkpoint.');
    try {
      return await buildGameArchiveExport(snapshot, knownCredentials);
    } catch (error) {
      if (error instanceof ArchiveError && error.code === 'credential-echo') {
        await this.persistQuarantineMarker(gameId);
      }
      throw error;
    }
  }

  private async persistQuarantineMarker(gameId: string): Promise<void> {
    const transaction = safeTransaction(this.database, 'readwrite');
    const completed = transactionCompletion(transaction);
    const checkpointStore = transaction.objectStore('checkpoints');
    const outboxStore = transaction.objectStore('outbox');
    const checkpointRequest = checkpointStore.get(gameId);
    const outboxRequest = outboxStore.index('byGame').getAll(gameId);
    const failure: { value: GameStorageError | null } = { value: null };
    let checkpointValue: unknown;
    let outboxValues: unknown[] = [];
    let pending = 2;
    let settled = false;

    await new Promise<void>((resolve) => {
      const fail = (request: IDBRequest) => {
        if (settled) return;
        settled = true;
        failure.value = classifyStorageFailure(request.error);
        abortTransaction(transaction);
        resolve();
      };
      const received = () => {
        pending -= 1;
        if (pending !== 0 || settled) return;
        try {
          if (checkpointValue === undefined) {
            throw storageFailure('invalid-data', 'The game disappeared while its archive was being checked.');
          }
          const checkpoint = readGameCheckpoint(checkpointValue);
          checkpointStore.put(checkpointWithQuarantine(checkpoint, true));
          for (const value of outboxValues) {
            const record = readOutboxRecord(value);
            if (record.gameId !== gameId || (record.state !== 'pending' && record.state !== 'failed')) continue;
            outboxStore.put({
              ...record,
              state: 'blocked',
              blockedReason: 'credential-echo',
              failureCode: null,
            });
          }
          settled = true;
          resolve();
        } catch (error) {
          settled = true;
          failure.value =
            error instanceof GameStorageError
              ? error
              : storageFailure('invalid-data', 'The archive quarantine marker could not be saved.');
          abortTransaction(transaction);
          resolve();
        }
      };
      checkpointRequest.onsuccess = () => {
        checkpointValue = checkpointRequest.result;
        received();
      };
      outboxRequest.onsuccess = () => {
        outboxValues = outboxRequest.result;
        received();
      };
      checkpointRequest.onerror = () => fail(checkpointRequest);
      outboxRequest.onerror = () => fail(outboxRequest);
    });

    try {
      await completed;
    } catch (error) {
      const recorded = failure.value ?? classifyStorageFailure(error);
      this.recordFailure(recorded.code, gameId);
      throw recorded;
    }
    if (failure.value) {
      this.recordFailure(failure.value.code, gameId);
      throw failure.value;
    }
  }

  async importGameArchive(value: unknown, knownCredentials: readonly string[] = []): Promise<StoredGameV1> {
    this.ensureOpen();
    let snapshot: StoredGameV1;
    try {
      snapshot = await unpackGameArchive(value);
    } catch {
      this.recordFailure('invalid-data');
      throw storageFailure('invalid-data', 'The game archive failed version, digest, or reference validation.');
    }
    const prepared = await prepareArchiveRecords(snapshot.events, snapshot.chunks, knownCredentials);
    const checkpoint = checkpointWithQuarantine(
      snapshot.checkpoint,
      snapshot.checkpoint.archive.egressStatus === 'credential-echo-quarantined' ||
        prepared.quarantined ||
        checkpointHasCredentialEcho(snapshot.checkpoint, knownCredentials),
    );
    assertArchiveReferenceIntegrity(checkpoint, prepared.events, prepared.chunks);

    const transaction = safeTransaction(this.database, 'readwrite');
    const completed = transactionCompletion(transaction);
    const checkpointStore = transaction.objectStore('checkpoints');
    const eventStore = transaction.objectStore('events');
    const chunkStore = transaction.objectStore('chunks');
    let failure: GameStorageError | null = null;
    const request = checkpointStore.get(checkpoint.gameId);
    request.onsuccess = () => {
      try {
        if (request.result !== undefined) {
          throw storageFailure('revision-conflict', 'A game with this ID already exists on this device.');
        }
        checkpointStore.add(checkpoint);
        for (const event of prepared.events) eventStore.add(event);
        for (const chunk of prepared.chunks) chunkStore.add(chunk);
      } catch (error) {
        failure = error instanceof GameStorageError ? error : storageFailure('transaction-aborted', 'Archive import aborted.');
        abortTransaction(transaction);
      }
    };
    request.onerror = () => abortTransaction(transaction);
    try {
      await completed;
    } catch (error) {
      const recorded = failure ?? classifyStorageFailure(error);
      this.recordFailure(recorded.code, checkpoint.gameId);
      throw recorded;
    }
    this.recordSuccessfulSave(checkpoint.gameId);
    return { checkpoint, events: prepared.events, chunks: prepared.chunks };
  }

  async requestPersistentStorage(storageManager = storageManagerFromBrowser()): Promise<PersistencePermissionV1> {
    if (!storageManager?.persist) {
      this.persistenceState = 'unsupported';
      return this.persistenceState;
    }
    try {
      this.persistenceState = (await storageManager.persist()) ? 'granted' : 'denied';
    } catch {
      this.persistenceState = 'failed';
    }
    return this.persistenceState;
  }

  async status(gameId: string): Promise<GameStorageStatusV1> {
    this.ensureOpen();
    const transaction = safeTransaction(this.database, 'readonly');
    const completed = transactionCompletion(transaction);
    const checkpointRequest = transaction.objectStore('checkpoints').get(gameId);
    const outboxRequest = transaction.objectStore('outbox').index('byGame').getAll(gameId);
    let checkpointValue: unknown;
    let outboxValues: unknown[] = [];
    let remaining = 2;
    let requestFailure: GameStorageError | null = null;
    const read = new Promise<void>((resolve) => {
      const done = () => {
        remaining -= 1;
        if (remaining === 0) resolve();
      };
      const fail = (request: IDBRequest) => {
        if (requestFailure) return;
        requestFailure = classifyStorageFailure(request.error);
        abortTransaction(transaction);
        resolve();
      };
      checkpointRequest.onsuccess = () => {
        checkpointValue = checkpointRequest.result;
        done();
      };
      outboxRequest.onsuccess = () => {
        outboxValues = outboxRequest.result;
        done();
      };
      checkpointRequest.onerror = () => fail(checkpointRequest);
      outboxRequest.onerror = () => fail(outboxRequest);
    });
    await read;
    try {
      await completed;
    } catch (error) {
      throw requestFailure ?? classifyStorageFailure(error);
    }
    if (requestFailure) throw requestFailure;
    const checkpoint = checkpointValue === undefined ? null : readGameCheckpoint(checkpointValue);
    const outbox = outboxValues.map((record) => readOutboxRecord(record));
    const persistenceManager = storageManagerFromBrowser();
    if (persistenceManager?.persisted) {
      try {
        const persisted = await persistenceManager.persisted();
        if (persisted) this.persistenceState = 'granted';
        else if (this.persistenceState === 'granted') this.persistenceState = 'denied';
      } catch {
        this.persistenceState = 'failed';
      }
    }
    const sync = this.syncStatus(checkpoint, outbox);
    const visibleFailure =
      this.lastFailure && (this.lastFailureGameId === null || this.lastFailureGameId === gameId)
        ? this.lastFailure
        : null;
    return {
      local: visibleFailure
        ? { kind: 'failed', savedRevision: checkpoint?.revision ?? null, failure: visibleFailure }
        : checkpoint
          ? { kind: 'saved-locally', revision: checkpoint.revision }
          : { kind: 'memory-only' },
      persistentStorage: this.persistenceState,
      sync,
      lastFailure: visibleFailure,
    };
  }

  private syncStatus(checkpoint: GameCheckpointV1 | null, records: StoredOutboxRecordV1[]): SyncStatusV1 {
    if (!this.syncConfigured) return { kind: 'not-configured', syncedRevision: null };
    const blocked = records.some((record) => record.state === 'blocked');
    const failed = records.some((record) => record.state === 'failed');
    const pending = records.some((record) => record.state === 'pending');
    const syncedRecords = records.filter((record) => record.state === 'synced');
    const latest = syncedRecords.reduce<StoredOutboxRecordV1 | null>(
      (current, record) =>
        current === null || record.checkpointRevision > current.checkpointRevision ? record : current,
      null,
    );
    const syncedRevision = latest?.syncedRevision ?? null;
    if (checkpoint?.archive.egressStatus === 'credential-echo-quarantined' || blocked) {
      return { kind: 'blocked', syncedRevision };
    }
    if (failed) return { kind: 'failed', syncedRevision };
    if (pending) return { kind: 'pending', syncedRevision };
    if (checkpoint && latest && latest.checkpointRevision >= checkpoint.revision && syncedRevision !== null) {
      return { kind: 'current', syncedRevision };
    }
    return { kind: 'pending', syncedRevision };
  }
}

export async function openGameStore(options: OpenGameStoreOptions = {}): Promise<GameStore> {
  const factory = options.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  if (!factory) throw storageFailure('unavailable', 'This browser does not provide IndexedDB.');
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  let database: IDBDatabase;
  try {
    database = await openDatabase(factory, databaseName);
  } catch (error) {
    throw classifyStorageFailure(error);
  }
  return new IndexedDbGameStore(database, options.now ?? Date.now, options.syncConfigured ?? false);
}

export { GameStorageError } from './errors';
export type {
  AppliedMoveV1,
  ArchiveReferencesV1,
  ArchiveChunkV1,
  ArchiveEventV1,
  BudgetCheckpointV1,
  CheckpointExtensionsV1,
  CheckpointCommitInputV1,
  CheckpointCommitResultV1,
  ChessSideV1,
  ClockCheckpointV1,
  GameCheckpointV1,
  GameNamespaceV1,
  GameResultV1,
  GameStorageStatusV1,
  HistoryMessageV1,
  HistoryCheckpointV1,
  HistorySegmentV1,
  JsonValue,
  LocalSaveStatusV1,
  PersistencePermissionV1,
  PlayerSelectionV1,
  PracticeCheckpointV1,
  RulesCheckpointV1,
  SelectionCheckpointV1,
  StorageFailureCodeV1,
  StorageFailureV1,
  StoredGameV1,
  StoredOutboxRecordV1,
  SyncStatusV1,
  VersionedExtensionSectionV1,
} from './types';
