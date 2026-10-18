export interface CloudFence {
  readonly gameId: string;
  readonly revision: number;
  readonly epoch: number;
}

export interface CoordinationPort {
  run<T>(fence: CloudFence, action: () => Promise<T>): Promise<T>;
  publish(message: { gameId: string; revision?: number; epoch?: number; kind: 'changed' | 'taken-over' | 'deleted' }): void;
  subscribe(listener: (message: { gameId: string; revision?: number; epoch?: number; kind: 'changed' | 'taken-over' | 'deleted' }) => void): () => void;
  close(): void;
}

interface LockManagerPort { request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> }

/** Cross-tab lock with a transactional IndexedDB compare-and-set fallback. */
export function createCloudCoordination(options: {
  locks?: LockManagerPort | null;
  factory?: IDBFactory;
  databaseName?: string;
  channelFactory?: (name: string) => BroadcastChannel;
  now?: () => number;
} = {}): CoordinationPort {
  const factory = options.factory ?? indexedDB;
  const now = options.now ?? Date.now;
  const name = options.databaseName ?? 'kamkmchess-cloud-coordination';
  const locks = Object.hasOwn(options, 'locks')
    ? options.locks ?? undefined
    : (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManagerPort }).locks : undefined);
  const channel = options.channelFactory?.('kamkmchess-cloud') ?? (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('kamkmchess-cloud'));
  const listeners = new Set<(message: Parameters<CoordinationPort['publish']>[0]) => void>();
  if (channel) channel.onmessage = (event: MessageEvent) => {
    if (isMessage(event.data)) for (const listener of listeners) listener(event.data);
  };
  return {
    async run<T>(fence: CloudFence, action: () => Promise<T>): Promise<T> {
      const key = `kamkmchess:${fence.gameId}`;
      if (locks) return locks.request(key, { mode: 'exclusive' }, action);
      const lease = await acquireLease(factory, name, fence, now());
      let result: unknown;
      try {
        result = await action();
        await releaseLease(factory, name, lease, now(), result);
        return result as T;
      } catch (error) {
        await releaseLease(factory, name, lease, now()).catch(() => undefined);
        throw error;
      }
    },
    publish(message) { channel?.postMessage(message); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { listeners.clear(); channel?.close(); },
  };
}

interface LeaseRecord extends CloudFence { readonly key: string; readonly token: string; readonly expiresAt: number }

async function acquireLease(factory: IDBFactory, name: string, fence: CloudFence, timestamp: number): Promise<LeaseRecord> {
  const db = await openLeaseDatabase(factory, name);
  const transaction = db.transaction('leases', 'readwrite');
  const completed = transactionDone(transaction);
  const store = transaction.objectStore('leases');
  const key = `game:${fence.gameId}`;
  const current = await requestResult(store.get(key)) as LeaseRecord | undefined;
  if (current && current.expiresAt > timestamp) {
    transaction.abort(); db.close(); await completed.catch(() => undefined); throw new Error('Another tab is syncing this game.');
  }
  if (current && (fence.revision < current.revision || fence.epoch < current.epoch)) {
    transaction.abort(); db.close(); await completed.catch(() => undefined); throw new Error('This tab has a stale cloud revision or ownership epoch. Refresh before syncing.');
  }
  const lease: LeaseRecord = { ...fence, key, token: makeToken(), expiresAt: timestamp + 120_000 };
  store.put(lease);
  await completed;
  db.close();
  return lease;
}

async function releaseLease(factory: IDBFactory, name: string, lease: LeaseRecord, timestamp: number, result?: unknown): Promise<void> {
  const db = await openLeaseDatabase(factory, name);
  const transaction = db.transaction('leases', 'readwrite');
  const completed = transactionDone(transaction);
  const store = transaction.objectStore('leases');
  const current = await requestResult(store.get(lease.key)) as LeaseRecord | undefined;
  if (current?.token === lease.token) {
    const outcome = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {};
    const revision = typeof outcome.revision === 'number' && Number.isSafeInteger(outcome.revision) ? outcome.revision : current.revision;
    const epoch = typeof outcome.epoch === 'number' && Number.isSafeInteger(outcome.epoch) ? outcome.epoch : current.epoch;
    store.put({ ...current, revision, epoch, expiresAt: timestamp });
  }
  await completed;
  db.close();
}

function openLeaseDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('leases', { keyPath: 'key' });
    request.onerror = () => reject(request.error ?? new Error('Could not open the sync coordination store.'));
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error); });
}

function isMessage(value: unknown): value is Parameters<CoordinationPort['publish']>[0] {
  return typeof value === 'object' && value !== null && 'gameId' in value && 'kind' in value;
}

function makeToken(): string { return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Math.random()}-${Date.now()}`; }
