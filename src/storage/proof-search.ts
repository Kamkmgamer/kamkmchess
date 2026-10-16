import {
  PROOF_CHECKER_VERSION,
  PROOF_PREDICATE_VERSION,
  PROOF_SCHEMA_VERSION,
  PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION,
  PROOF_SEARCH_VERSION,
  RULES_ADAPTER_VERSION,
  createDeadnessQuery,
  createMatingReachabilityQuery,
  createTimeoutMatingQuery,
  proofQueryIdentity,
  validateProofSearchCheckpoint,
} from '../proofs/index.js';
import type { ProofQuery, ProofSearchCheckpointV1, ProofSearchVersionsV1 } from '../proofs/index.js';
import { abortTransaction, transactionCompletion } from './database.js';
import { classifyStorageFailure } from './errors.js';
import type { GameNamespaceV1, StorageFailureCodeV1 } from './types.js';

const PROOF_SEARCH_DATABASE_VERSION = 1;
const PROOF_SEARCH_DATABASE_NAME = 'kamkmchess-proof-search';
const DEFAULT_CHUNK_ITEM_LIMIT = 128;
const STORES = ['proofSearchCheckpoints', 'proofSearchChunks'] as const;
const FRAGMENT_KINDS = ['states', 'frontier', 'parents'] as const;

type FragmentKind = (typeof FRAGMENT_KINDS)[number];
type StoredRecord = Record<string, unknown>;

interface StoredChunkReference {
  readonly kind: FragmentKind;
  readonly index: number;
  readonly itemCount: number;
  readonly sha256: string;
}

interface StoredCheckpointHeader {
  readonly checkpointKey: string;
  readonly scopeKey: string;
  readonly namespace: GameNamespaceV1;
  readonly gameId: string;
  readonly queryIdentity: string;
  readonly schemaVersion: number;
  readonly searchVersion: string;
  readonly versions: ProofSearchVersionsV1;
  readonly query: ProofQuery;
  readonly root: string;
  readonly discoveredStateCount: number;
  readonly discoveredEdgeCount: number;
  readonly completedPasses: number;
  readonly chunkRefs: readonly StoredChunkReference[];
}

interface StoredProofSearchChunk {
  readonly chunkKey: string;
  readonly scopeKey: string;
  readonly checkpointKey: string;
  readonly kind: FragmentKind;
  readonly index: number;
  readonly items: readonly unknown[];
  readonly sha256: string;
}

export interface ProofSearchCheckpointLookupV1 {
  readonly namespace: GameNamespaceV1;
  readonly gameId: string;
  readonly queryIdentity: string;
}

export type ProofSearchCheckpointLoadV1 =
  | { readonly status: 'missing' }
  | { readonly status: 'found'; readonly checkpoint: ProofSearchCheckpointV1 }
  | {
      readonly status: 'restart-required';
      readonly reason: 'corrupt-checkpoint' | 'incompatible-checkpoint';
      readonly query?: ProofQuery;
    };

export interface ProofSearchCheckpointSaveV1 {
  readonly namespace: GameNamespaceV1;
  readonly checkpoint: ProofSearchCheckpointV1;
}

export interface ProofSearchCheckpointSaveResultV1 {
  readonly status: 'saved';
  readonly checkpointKey: string;
  readonly chunkCount: number;
}

export interface OpenProofSearchStoreOptionsV1 {
  readonly databaseName?: string;
  readonly factory?: IDBFactory;
  /** Defaults to 128 records per chunk. Smaller values are useful for storage fixtures. */
  readonly chunkItemLimit?: number;
}

export interface ProofSearchStoreV1 {
  saveCheckpoint(input: ProofSearchCheckpointSaveV1): Promise<ProofSearchCheckpointSaveResultV1>;
  loadCheckpoint(input: ProofSearchCheckpointLookupV1): Promise<ProofSearchCheckpointLoadV1>;
  deleteCheckpoint(input: ProofSearchCheckpointLookupV1): Promise<void>;
  close(): void;
}

export class ProofSearchStorageError extends Error {
  constructor(readonly code: StorageFailureCodeV1, message: string) {
    super(message);
    this.name = 'ProofSearchStorageError';
  }
}

function storageFailure(code: StorageFailureCodeV1, message: string): ProofSearchStorageError {
  return new ProofSearchStorageError(code, message);
}

function asStorageError(error: unknown): ProofSearchStorageError {
  if (error instanceof ProofSearchStorageError) return error;
  const classified = classifyStorageFailure(error);
  return storageFailure(classified.code, classified.message);
}

function exactDataRecord(value: unknown, expectedKeys?: readonly string[]): StoredRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = Object.create(null) as StoredRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    record[key] = descriptor.value;
  }
  if (expectedKeys) {
    const actual = Object.keys(record);
    if (actual.length !== expectedKeys.length || actual.some((key) => !expectedKeys.includes(key))) return null;
  }
  return record;
}

function denseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Number.isSafeInteger(descriptor.value)) return null;
  const items: unknown[] = [];
  for (let index = 0; index < (descriptor.value as number); index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (item === undefined || !item.enumerable || !Object.hasOwn(item, 'value')) return null;
    items.push(item.value);
  }
  return items;
}

function normalizedNamespace(value: unknown): GameNamespaceV1 | null {
  const namespace = exactDataRecord(value);
  if (!namespace || typeof namespace.kind !== 'string') return null;
  if (namespace.kind === 'guest' && Object.keys(namespace).length === 1) return { kind: 'guest' };
  if (
    namespace.kind === 'account' &&
    Object.keys(namespace).length === 2 &&
    typeof namespace.accountId === 'string' &&
    namespace.accountId.length > 0
  ) return { kind: 'account', accountId: namespace.accountId };
  return null;
}

function namespaceIdentity(namespace: GameNamespaceV1): readonly unknown[] {
  return namespace.kind === 'guest' ? ['guest'] : ['account', namespace.accountId];
}

function scopeKey(namespace: GameNamespaceV1, gameId: string, queryIdentity: string): string {
  return JSON.stringify([namespaceIdentity(namespace), gameId, queryIdentity]);
}

function checkpointKey(scope: string, versions: unknown): string {
  return JSON.stringify([scope, versions]);
}

function storedChunkKey(checkpoint: string, kind: FragmentKind, index: number): string {
  return JSON.stringify([checkpoint, kind, index]);
}

function readVersions(value: unknown): ProofSearchVersionsV1 | null {
  const record = exactDataRecord(value, [
    'checkpointSchemaVersion',
    'proofSchemaVersion',
    'proofCheckerVersion',
    'rulesAdapterVersion',
    'predicateVersion',
    'searchVersion',
  ]);
  if (!record) return null;
  if (
    !Number.isSafeInteger(record.checkpointSchemaVersion) ||
    typeof record.proofSchemaVersion !== 'number' ||
    typeof record.proofCheckerVersion !== 'string' ||
    typeof record.rulesAdapterVersion !== 'string' ||
    typeof record.predicateVersion !== 'string' ||
    typeof record.searchVersion !== 'string'
  ) return null;
  return {
    checkpointSchemaVersion: record.checkpointSchemaVersion as ProofSearchVersionsV1['checkpointSchemaVersion'],
    proofSchemaVersion: record.proofSchemaVersion,
    proofCheckerVersion: record.proofCheckerVersion,
    rulesAdapterVersion: record.rulesAdapterVersion,
    predicateVersion: record.predicateVersion,
    searchVersion: record.searchVersion as ProofSearchVersionsV1['searchVersion'],
  };
}

function isFragmentKind(value: unknown): value is FragmentKind {
  return value === 'states' || value === 'frontier' || value === 'parents';
}

function currentQueryForRestart(value: unknown, gameId: string, queryIdentity: string): ProofQuery | undefined {
  const record = exactDataRecord(value);
  if (!record) return undefined;
  const predicate = record.predicate;
  const expectedKeys = predicate === 'cooperative-mating-reachability'
    ? ['schemaVersion', 'proofCheckerVersion', 'rulesAdapterVersion', 'predicateVersion', 'gameId', 'segmentId', 'positionRevision', 'analysisGeneration', 'ownershipEpoch', 'positionFen', 'queryIdentity', 'predicate', 'intendedColor']
    : predicate === 'timeout-opponent-mating'
      ? ['schemaVersion', 'proofCheckerVersion', 'rulesAdapterVersion', 'predicateVersion', 'gameId', 'segmentId', 'positionRevision', 'analysisGeneration', 'ownershipEpoch', 'positionFen', 'queryIdentity', 'predicate', 'expiredColor']
      : predicate === 'global-deadness'
        ? ['schemaVersion', 'proofCheckerVersion', 'rulesAdapterVersion', 'predicateVersion', 'gameId', 'segmentId', 'positionRevision', 'analysisGeneration', 'ownershipEpoch', 'positionFen', 'queryIdentity', 'predicate']
        : null;
  if (!expectedKeys || !exactDataRecord(record, expectedKeys)) return undefined;
  for (const field of ['gameId', 'segmentId', 'positionRevision', 'analysisGeneration', 'ownershipEpoch', 'positionFen', 'queryIdentity']) {
    if (typeof record[field] !== 'string' || record[field].length === 0) return undefined;
  }
  if (
    record.gameId !== gameId ||
    record.queryIdentity !== queryIdentity ||
    !Number.isSafeInteger(record.schemaVersion) ||
    typeof record.proofCheckerVersion !== 'string' ||
    typeof record.rulesAdapterVersion !== 'string' ||
    typeof record.predicateVersion !== 'string'
  ) return undefined;
  try {
    if (proofQueryIdentity(record as unknown as ProofQuery) !== queryIdentity) return undefined;
    const scope = {
      gameId: record.gameId,
      segmentId: record.segmentId as string,
      positionRevision: record.positionRevision as string,
      analysisGeneration: record.analysisGeneration as string,
      ownershipEpoch: record.ownershipEpoch as string,
      positionFen: record.positionFen as string,
    };
    if (predicate === 'global-deadness') return createDeadnessQuery(scope);
    if (predicate === 'cooperative-mating-reachability') {
      if (record.intendedColor !== 'w' && record.intendedColor !== 'b') return undefined;
      return createMatingReachabilityQuery({ ...scope, intendedColor: record.intendedColor });
    }
    if (record.expiredColor !== 'w' && record.expiredColor !== 'b') return undefined;
    return createTimeoutMatingQuery({ ...scope, expiredColor: record.expiredColor });
  } catch {
    return undefined;
  }
}

function fragmentPayload(kind: FragmentKind, index: number, items: readonly unknown[]): string {
  return JSON.stringify({ kind, index, items });
}

async function digest(payload: string): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw storageFailure('unavailable', 'Checkpoint integrity hashing is unavailable.');
  const bytes = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function checkpointFragments(checkpoint: ProofSearchCheckpointV1, limit: number): Array<{ kind: FragmentKind; index: number; items: readonly unknown[] }> {
  const collections: ReadonlyArray<{ kind: FragmentKind; items: readonly unknown[] }> = [
    { kind: 'states', items: checkpoint.stateRecords },
    { kind: 'frontier', items: checkpoint.frontier },
    { kind: 'parents', items: checkpoint.parentRecords },
  ];
  const fragments: Array<{ kind: FragmentKind; index: number; items: readonly unknown[] }> = [];
  for (const collection of collections) {
    for (let offset = 0, index = 0; offset < collection.items.length; offset += limit, index += 1) {
      fragments.push({ kind: collection.kind, index, items: collection.items.slice(offset, offset + limit) });
    }
  }
  return fragments;
}

function createDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, PROOF_SEARCH_DATABASE_VERSION);
    let upgradeStarted = false;
    let settled = false;
    request.onupgradeneeded = () => {
      upgradeStarted = true;
      const database = request.result;
      if (!database.objectStoreNames.contains('proofSearchCheckpoints')) {
        const headers = database.createObjectStore('proofSearchCheckpoints', { keyPath: 'checkpointKey' });
        headers.createIndex('byScope', 'scopeKey', { unique: false });
      }
      if (!database.objectStoreNames.contains('proofSearchChunks')) {
        const chunks = database.createObjectStore('proofSearchChunks', { keyPath: 'chunkKey' });
        chunks.createIndex('byScope', 'scopeKey', { unique: false });
      }
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(storageFailure('upgrade-blocked', 'A previous tab is blocking the proof checkpoint database.'));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      const classified = classifyStorageFailure(request.error);
      reject(upgradeStarted
        ? storageFailure('upgrade-failed', 'The proof checkpoint database could not be upgraded.')
        : asStorageError(classified));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function readCheckpointHeader(value: unknown): StoredCheckpointHeader | null {
  const header = exactDataRecord(value, [
    'checkpointKey',
    'scopeKey',
    'namespace',
    'gameId',
    'queryIdentity',
    'schemaVersion',
    'searchVersion',
    'versions',
    'query',
    'root',
    'discoveredStateCount',
    'discoveredEdgeCount',
    'completedPasses',
    'chunkRefs',
  ]);
  if (!header) return null;
  const namespace = normalizedNamespace(header.namespace);
  const versions = readVersions(header.versions);
  const rawRefs = denseArray(header.chunkRefs);
  if (
    typeof header.checkpointKey !== 'string' ||
    typeof header.scopeKey !== 'string' ||
    !namespace ||
    typeof header.gameId !== 'string' ||
    typeof header.queryIdentity !== 'string' ||
    !Number.isSafeInteger(header.schemaVersion) ||
    typeof header.searchVersion !== 'string' ||
    !versions ||
    !header.query ||
    typeof header.root !== 'string' ||
    !Number.isSafeInteger(header.discoveredStateCount) ||
    !Number.isSafeInteger(header.discoveredEdgeCount) ||
    !Number.isSafeInteger(header.completedPasses) ||
    !rawRefs
  ) return null;
  const chunkRefs: StoredChunkReference[] = [];
  for (const rawRef of rawRefs) {
    const reference = exactDataRecord(rawRef, ['kind', 'index', 'itemCount', 'sha256']);
    if (
      !reference ||
      !isFragmentKind(reference.kind) ||
      !Number.isSafeInteger(reference.index) ||
      (reference.index as number) < 0 ||
      !Number.isSafeInteger(reference.itemCount) ||
      (reference.itemCount as number) < 1 ||
      typeof reference.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(reference.sha256)
    ) return null;
    chunkRefs.push({
      kind: reference.kind,
      index: reference.index as number,
      itemCount: reference.itemCount as number,
      sha256: reference.sha256,
    });
  }
  return {
    checkpointKey: header.checkpointKey,
    scopeKey: header.scopeKey,
    namespace,
    gameId: header.gameId,
    queryIdentity: header.queryIdentity,
    schemaVersion: header.schemaVersion as number,
    searchVersion: header.searchVersion,
    versions,
    query: header.query as ProofQuery,
    root: header.root,
    discoveredStateCount: header.discoveredStateCount as number,
    discoveredEdgeCount: header.discoveredEdgeCount as number,
    completedPasses: header.completedPasses as number,
    chunkRefs,
  };
}

function sameNamespace(left: GameNamespaceV1, right: GameNamespaceV1): boolean {
  return JSON.stringify(namespaceIdentity(left)) === JSON.stringify(namespaceIdentity(right));
}

function isSupportedStoredVersion(header: StoredCheckpointHeader): boolean {
  const expectedKey = checkpointKey(header.scopeKey, header.versions);
  return header.checkpointKey === expectedKey &&
    header.schemaVersion === PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION &&
    header.searchVersion === PROOF_SEARCH_VERSION &&
    header.versions.checkpointSchemaVersion === PROOF_SEARCH_CHECKPOINT_SCHEMA_VERSION &&
    header.versions.proofSchemaVersion === PROOF_SCHEMA_VERSION &&
    header.versions.proofCheckerVersion === PROOF_CHECKER_VERSION &&
    header.versions.rulesAdapterVersion === RULES_ADAPTER_VERSION &&
    header.versions.predicateVersion === PROOF_PREDICATE_VERSION &&
    header.versions.searchVersion === PROOF_SEARCH_VERSION;
}

function checkpointFromHeader(
  header: StoredCheckpointHeader,
  stateRecords: readonly unknown[],
  frontier: readonly unknown[],
  parentRecords: readonly unknown[],
): unknown {
  return {
    schemaVersion: header.schemaVersion,
    searchVersion: header.searchVersion,
    versions: header.versions,
    query: header.query,
    queryIdentity: header.queryIdentity,
    root: header.root,
    stateRecords,
    frontier,
    parentRecords,
    discoveredStateCount: header.discoveredStateCount,
    discoveredEdgeCount: header.discoveredEdgeCount,
    completedPasses: header.completedPasses,
  };
}

class IndexedDbProofSearchStore implements ProofSearchStoreV1 {
  constructor(private readonly database: IDBDatabase, private readonly chunkItemLimit: number) {}

  async saveCheckpoint(input: ProofSearchCheckpointSaveV1): Promise<ProofSearchCheckpointSaveResultV1> {
    const validation = validateProofSearchCheckpoint(input.checkpoint);
    if (validation.status !== 'valid') {
      throw storageFailure('invalid-data', 'The proof search checkpoint is corrupt or incompatible.');
    }
    const namespace = normalizedNamespace(input.namespace);
    if (
      !namespace ||
      validation.checkpoint.query.gameId.length === 0 ||
      validation.checkpoint.query.queryIdentity !== validation.checkpoint.queryIdentity
    ) throw storageFailure('invalid-data', 'The proof search checkpoint identity is invalid.');

    const checkpoint = validation.checkpoint;
    const gameId = checkpoint.query.gameId;
    const queryIdentity = checkpoint.queryIdentity;
    const scope = scopeKey(namespace, gameId, queryIdentity);
    const key = checkpointKey(scope, checkpoint.versions);
    const fragments = checkpointFragments(checkpoint, this.chunkItemLimit);
    const refs: StoredChunkReference[] = [];
    const chunks: StoredProofSearchChunk[] = [];
    try {
      for (const fragment of fragments) {
        const sha256 = await digest(fragmentPayload(fragment.kind, fragment.index, fragment.items));
        const chunk: StoredProofSearchChunk = {
          chunkKey: storedChunkKey(key, fragment.kind, fragment.index),
          scopeKey: scope,
          checkpointKey: key,
          kind: fragment.kind,
          index: fragment.index,
          items: fragment.items,
          sha256,
        };
        chunks.push(chunk);
        refs.push({ kind: fragment.kind, index: fragment.index, itemCount: fragment.items.length, sha256 });
      }
    } catch (error) {
      throw asStorageError(error);
    }

    const header: StoredCheckpointHeader = {
      checkpointKey: key,
      scopeKey: scope,
      namespace,
      gameId,
      queryIdentity,
      schemaVersion: checkpoint.schemaVersion,
      searchVersion: checkpoint.searchVersion,
      versions: checkpoint.versions,
      query: checkpoint.query,
      root: checkpoint.root,
      discoveredStateCount: checkpoint.discoveredStateCount,
      discoveredEdgeCount: checkpoint.discoveredEdgeCount,
      completedPasses: checkpoint.completedPasses,
      chunkRefs: refs,
    };

    let transaction: IDBTransaction;
    try {
      transaction = this.database.transaction([...STORES], 'readwrite');
    } catch (error) {
      throw asStorageError(error);
    }
    const completed = transactionCompletion(transaction);
    const headerStore = transaction.objectStore('proofSearchCheckpoints');
    const chunkStore = transaction.objectStore('proofSearchChunks');
    const headerKeysRequest = headerStore.index('byScope').getAllKeys(scope);
    const chunkKeysRequest = chunkStore.index('byScope').getAllKeys(scope);
    let requestFailure: ProofSearchStorageError | null = null;
    let pending = 2;
    let headerKeys: IDBValidKey[] = [];
    let chunkKeys: IDBValidKey[] = [];
    const fail = (request: IDBRequest) => {
      if (requestFailure) return;
      requestFailure = asStorageError(request.error);
      abortTransaction(transaction);
    };
    const ready = () => {
      pending -= 1;
      if (pending !== 0 || requestFailure) return;
      try {
        for (const oldKey of headerKeys) headerStore.delete(oldKey);
        for (const oldKey of chunkKeys) chunkStore.delete(oldKey);
        headerStore.put(header);
        for (const chunk of chunks) chunkStore.put(chunk);
      } catch (error) {
        requestFailure = asStorageError(error);
        abortTransaction(transaction);
      }
    };
    headerKeysRequest.onsuccess = () => {
      headerKeys = headerKeysRequest.result;
      ready();
    };
    chunkKeysRequest.onsuccess = () => {
      chunkKeys = chunkKeysRequest.result;
      ready();
    };
    headerKeysRequest.onerror = () => fail(headerKeysRequest);
    chunkKeysRequest.onerror = () => fail(chunkKeysRequest);
    try {
      await completed;
    } catch (error) {
      throw requestFailure ?? asStorageError(error);
    }
    if (requestFailure) throw requestFailure;
    return { status: 'saved', checkpointKey: key, chunkCount: chunks.length };
  }

  async loadCheckpoint(input: ProofSearchCheckpointLookupV1): Promise<ProofSearchCheckpointLoadV1> {
    const namespace = normalizedNamespace(input.namespace);
    if (!namespace || typeof input.gameId !== 'string' || input.gameId.length === 0 || typeof input.queryIdentity !== 'string' || input.queryIdentity.length === 0) {
      throw storageFailure('invalid-data', 'The proof checkpoint lookup identity is invalid.');
    }
    const scope = scopeKey(namespace, input.gameId, input.queryIdentity);
    let transaction: IDBTransaction;
    try {
      transaction = this.database.transaction([...STORES], 'readonly');
    } catch (error) {
      throw asStorageError(error);
    }
    const completed = transactionCompletion(transaction);
    const headersRequest = transaction.objectStore('proofSearchCheckpoints').index('byScope').getAll(scope);
    const chunksRequest = transaction.objectStore('proofSearchChunks').index('byScope').getAll(scope);
    let requestFailure: ProofSearchStorageError | null = null;
    let headers: unknown[] = [];
    let chunks: unknown[] = [];
    let pending = 2;
    await new Promise<void>((resolve) => {
      const received = () => {
        pending -= 1;
        if (pending === 0 || requestFailure) resolve();
      };
      const failed = (request: IDBRequest) => {
        if (requestFailure) return;
        requestFailure = asStorageError(request.error);
        abortTransaction(transaction);
        resolve();
      };
      headersRequest.onsuccess = () => {
        headers = headersRequest.result;
        received();
      };
      chunksRequest.onsuccess = () => {
        chunks = chunksRequest.result;
        received();
      };
      headersRequest.onerror = () => failed(headersRequest);
      chunksRequest.onerror = () => failed(chunksRequest);
    });
    try {
      await completed;
    } catch (error) {
      throw requestFailure ?? asStorageError(error);
    }
    if (requestFailure) throw requestFailure;
    if (headers.length === 0 && chunks.length === 0) return { status: 'missing' };
    if (headers.length !== 1) return { status: 'restart-required', reason: 'corrupt-checkpoint' };

    const rawHeader = exactDataRecord(headers[0]);
    const restartQuery = currentQueryForRestart(rawHeader?.query, input.gameId, input.queryIdentity);
    const restartRequired = (reason: 'corrupt-checkpoint' | 'incompatible-checkpoint'): ProofSearchCheckpointLoadV1 =>
      restartQuery === undefined ? { status: 'restart-required', reason } : { status: 'restart-required', reason, query: restartQuery };
    const header = readCheckpointHeader(headers[0]);
    if (!header || header.scopeKey !== scope || !sameNamespace(namespace, header.namespace) || header.gameId !== input.gameId || header.queryIdentity !== input.queryIdentity) {
      return restartRequired('corrupt-checkpoint');
    }
    if (!restartQuery) return restartRequired('corrupt-checkpoint');
    if (!isSupportedStoredVersion(header)) return restartRequired('incompatible-checkpoint');
    if (header.chunkRefs.length !== chunks.length || header.chunkRefs.length === 0) {
      return restartRequired('corrupt-checkpoint');
    }

    const referenceKeys = new Set<string>();
    const chunkMap = new Map<string, StoredRecord>();
    for (const rawChunk of chunks) {
      const chunk = exactDataRecord(rawChunk, ['chunkKey', 'scopeKey', 'checkpointKey', 'kind', 'index', 'items', 'sha256']);
      if (
        !chunk ||
        typeof chunk.chunkKey !== 'string' ||
        typeof chunk.scopeKey !== 'string' ||
        typeof chunk.checkpointKey !== 'string' ||
        !isFragmentKind(chunk.kind) ||
        !Number.isSafeInteger(chunk.index) ||
        (chunk.index as number) < 0 ||
        typeof chunk.sha256 !== 'string'
      ) return restartRequired('corrupt-checkpoint');
      const id = `${chunk.kind}:${chunk.index}`;
      if (chunkMap.has(id)) return restartRequired('corrupt-checkpoint');
      chunkMap.set(id, chunk);
    }

    const grouped = new Map<FragmentKind, Array<{ index: number; items: unknown[] }>>();
    for (const kind of FRAGMENT_KINDS) grouped.set(kind, []);
    try {
      for (const reference of header.chunkRefs) {
        const id = `${reference.kind}:${reference.index}`;
        if (referenceKeys.has(id)) return restartRequired('corrupt-checkpoint');
        referenceKeys.add(id);
        const chunk = chunkMap.get(id);
        if (
          !chunk ||
          chunk.scopeKey !== scope ||
          chunk.checkpointKey !== header.checkpointKey ||
          chunk.chunkKey !== storedChunkKey(header.checkpointKey, reference.kind, reference.index) ||
          chunk.sha256 !== reference.sha256
        ) return restartRequired('corrupt-checkpoint');
        const items = denseArray(chunk.items);
        if (!items || items.length !== reference.itemCount) return restartRequired('corrupt-checkpoint');
        if (await digest(fragmentPayload(reference.kind, reference.index, items)) !== reference.sha256) {
          return restartRequired('corrupt-checkpoint');
        }
        grouped.get(reference.kind)?.push({ index: reference.index, items });
      }
    } catch (error) {
      throw asStorageError(error);
    }
    if (referenceKeys.size !== chunkMap.size) return restartRequired('corrupt-checkpoint');

    const collections = new Map<FragmentKind, unknown[]>();
    for (const kind of FRAGMENT_KINDS) {
      const fragments = grouped.get(kind) ?? [];
      fragments.sort((left, right) => left.index - right.index);
      const combined: unknown[] = [];
      for (let index = 0; index < fragments.length; index += 1) {
        const fragment = fragments[index];
        if (!fragment || fragment.index !== index) return restartRequired('corrupt-checkpoint');
        combined.push(...fragment.items);
      }
      collections.set(kind, combined);
    }

    const validation = validateProofSearchCheckpoint(checkpointFromHeader(
      header,
      collections.get('states') ?? [],
      collections.get('frontier') ?? [],
      collections.get('parents') ?? [],
    ));
    if (validation.status !== 'valid') {
      return restartRequired(validation.reason === 'incompatible-checkpoint' ? 'incompatible-checkpoint' : 'corrupt-checkpoint');
    }
    return { status: 'found', checkpoint: validation.checkpoint };
  }

  async deleteCheckpoint(input: ProofSearchCheckpointLookupV1): Promise<void> {
    const namespace = normalizedNamespace(input.namespace);
    if (!namespace || typeof input.gameId !== 'string' || input.gameId.length === 0 || typeof input.queryIdentity !== 'string' || input.queryIdentity.length === 0) {
      throw storageFailure('invalid-data', 'The proof checkpoint lookup identity is invalid.');
    }
    const scope = scopeKey(namespace, input.gameId, input.queryIdentity);
    let transaction: IDBTransaction;
    try {
      transaction = this.database.transaction([...STORES], 'readwrite');
    } catch (error) {
      throw asStorageError(error);
    }
    const completed = transactionCompletion(transaction);
    const headerStore = transaction.objectStore('proofSearchCheckpoints');
    const chunkStore = transaction.objectStore('proofSearchChunks');
    const headerKeysRequest = headerStore.index('byScope').getAllKeys(scope);
    const chunkKeysRequest = chunkStore.index('byScope').getAllKeys(scope);
    let requestFailure: ProofSearchStorageError | null = null;
    let pending = 2;
    let headerKeys: IDBValidKey[] = [];
    let chunkKeys: IDBValidKey[] = [];
    const fail = (request: IDBRequest) => {
      if (requestFailure) return;
      requestFailure = asStorageError(request.error);
      abortTransaction(transaction);
    };
    const remove = () => {
      pending -= 1;
      if (pending !== 0 || requestFailure) return;
      try {
        for (const key of headerKeys) headerStore.delete(key);
        for (const key of chunkKeys) chunkStore.delete(key);
      } catch (error) {
        requestFailure = asStorageError(error);
        abortTransaction(transaction);
      }
    };
    headerKeysRequest.onsuccess = () => {
      headerKeys = headerKeysRequest.result;
      remove();
    };
    chunkKeysRequest.onsuccess = () => {
      chunkKeys = chunkKeysRequest.result;
      remove();
    };
    headerKeysRequest.onerror = () => fail(headerKeysRequest);
    chunkKeysRequest.onerror = () => fail(chunkKeysRequest);
    try {
      await completed;
    } catch (error) {
      throw requestFailure ?? asStorageError(error);
    }
    if (requestFailure) throw requestFailure;
  }

  close(): void {
    this.database.close();
  }
}

export async function openProofSearchStore(options: OpenProofSearchStoreOptionsV1 = {}): Promise<ProofSearchStoreV1> {
  const factory = options.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  if (!factory) throw storageFailure('unavailable', 'This browser does not provide IndexedDB.');
  const databaseName = options.databaseName ?? PROOF_SEARCH_DATABASE_NAME;
  const chunkItemLimit = options.chunkItemLimit ?? DEFAULT_CHUNK_ITEM_LIMIT;
  if (!Number.isSafeInteger(chunkItemLimit) || chunkItemLimit < 1 || chunkItemLimit > 10_000) {
    throw storageFailure('invalid-data', 'The proof checkpoint chunk size is invalid.');
  }
  try {
    const database = await createDatabase(factory, databaseName);
    return new IndexedDbProofSearchStore(database, chunkItemLimit);
  } catch (error) {
    throw asStorageError(error);
  }
}
