import { ConnectionError } from './types';
import type {
  ConnectionCatalogSnapshot,
  ConnectionPersistence,
  ConnectionProfile,
  DisclosureDecisionRecord,
  StoredCredentialRecord,
} from './types';

const DATABASE_VERSION = 1;
const PROFILE_STORE = 'profiles';
const CREDENTIAL_STORE = 'credentials';
const DISCLOSURE_STORE = 'disclosures';
const CATALOG_STORE = 'catalogs';

interface ProfileRow {
  readonly namespaceKey: string;
  readonly id: string;
  readonly profile: ConnectionProfile;
}

interface CredentialRow {
  readonly namespaceKey: string;
  readonly profileId: string;
  readonly record: StoredCredentialRecord;
}

interface DisclosureRow {
  readonly namespaceKey: string;
  readonly profileId: string;
  readonly record: DisclosureDecisionRecord;
}

interface CatalogRow {
  readonly namespaceKey: string;
  readonly profileId: string;
  readonly configRevision: string;
  readonly snapshot: ConnectionCatalogSnapshot;
}

export interface OpenConnectionStoreOptions {
  readonly databaseName?: string;
  readonly factory?: IDBFactory;
}

export async function openConnectionPersistence(options: OpenConnectionStoreOptions = {}): Promise<ConnectionPersistence> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) throw new ConnectionError('credential-store-unavailable', 'This browser does not provide local IndexedDB storage.');
  const databaseName = options.databaseName ?? 'kamkmchess-connections';
  let database: IDBDatabase;
  try {
    database = await openDatabase(factory, databaseName);
  } catch {
    throw new ConnectionError('credential-store-unavailable', 'Local connection storage could not be opened.');
  }
  return new IndexedDbConnectionPersistence(database);
}

class IndexedDbConnectionPersistence implements ConnectionPersistence {
  constructor(private readonly database: IDBDatabase) {}

  getProfile(namespaceKey: string, profileId: string): Promise<ConnectionProfile | undefined> {
    return this.transaction([PROFILE_STORE], 'readonly', (tx, setResult) => {
      const request = tx.objectStore(PROFILE_STORE).get([namespaceKey, profileId]) as IDBRequest<ProfileRow | undefined>;
      request.onsuccess = () => setResult(request.result?.profile);
    });
  }

  listProfiles(namespaceKey: string): Promise<readonly ConnectionProfile[]> {
    return this.transaction([PROFILE_STORE], 'readonly', (tx, setResult) => {
      const request = tx.objectStore(PROFILE_STORE).getAll() as IDBRequest<ProfileRow[]>;
      request.onsuccess = () => setResult(request.result
        .filter((row) => row.namespaceKey === namespaceKey)
        .map((row) => row.profile));
    });
  }

  putProfile(namespaceKey: string, profile: ConnectionProfile): Promise<void> {
    return this.transaction([PROFILE_STORE, CREDENTIAL_STORE, DISCLOSURE_STORE, CATALOG_STORE], 'readwrite', (tx) => {
      const profiles = tx.objectStore(PROFILE_STORE);
      const request = profiles.get([namespaceKey, profile.id]) as IDBRequest<ProfileRow | undefined>;
      request.onsuccess = () => {
        const previous = request.result?.profile;
        if (previous && previous.configRevision !== profile.configRevision) {
          tx.objectStore(CREDENTIAL_STORE).delete([namespaceKey, profile.id]);
          tx.objectStore(DISCLOSURE_STORE).delete([namespaceKey, profile.id]);
          const cursorRequest = tx.objectStore(CATALOG_STORE).index('byConnection').openCursor([namespaceKey, profile.id]);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
        }
        profiles.put({ namespaceKey, id: profile.id, profile } satisfies ProfileRow);
      };
    });
  }

  deleteProfile(namespaceKey: string, profileId: string): Promise<void> {
    return this.transaction([PROFILE_STORE, CREDENTIAL_STORE, DISCLOSURE_STORE, CATALOG_STORE], 'readwrite', (tx) => {
      tx.objectStore(PROFILE_STORE).delete([namespaceKey, profileId]);
      tx.objectStore(CREDENTIAL_STORE).delete([namespaceKey, profileId]);
      tx.objectStore(DISCLOSURE_STORE).delete([namespaceKey, profileId]);
      const catalogs = tx.objectStore(CATALOG_STORE);
      const request = catalogs.index('byConnection').openCursor([namespaceKey, profileId]);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    });
  }

  getCredential(namespaceKey: string, profileId: string): Promise<StoredCredentialRecord | undefined> {
    return this.transaction([CREDENTIAL_STORE], 'readonly', (tx, setResult) => {
      const request = tx.objectStore(CREDENTIAL_STORE).get([namespaceKey, profileId]) as IDBRequest<CredentialRow | undefined>;
      request.onsuccess = () => setResult(request.result?.record);
    });
  }

  listCredentialRecords(namespaceKey?: string): Promise<readonly StoredCredentialRecord[]> {
    return this.transaction([CREDENTIAL_STORE], 'readonly', (tx, setResult) => {
      const store = tx.objectStore(CREDENTIAL_STORE);
      const request = (namespaceKey === undefined
        ? store.getAll()
        : store.index('byNamespace').getAll(namespaceKey)) as IDBRequest<CredentialRow[]>;
      request.onsuccess = () => setResult(request.result
        .map((row) => row.record));
    });
  }

  putCredential(namespaceKey: string, record: StoredCredentialRecord): Promise<void> {
    return this.transaction([CREDENTIAL_STORE], 'readwrite', (tx) => {
      tx.objectStore(CREDENTIAL_STORE).put({ namespaceKey, profileId: record.profileId, record } satisfies CredentialRow);
    });
  }

  deleteCredential(namespaceKey: string, profileId: string): Promise<void> {
    return this.transaction([CREDENTIAL_STORE], 'readwrite', (tx) => {
      tx.objectStore(CREDENTIAL_STORE).delete([namespaceKey, profileId]);
    });
  }

  clearCredentials(namespaceKey?: string): Promise<void> {
    return this.transaction([CREDENTIAL_STORE], 'readwrite', (tx) => {
      const store = tx.objectStore(CREDENTIAL_STORE);
      if (namespaceKey === undefined) {
        store.clear();
        return;
      }
      const request = store.index('byNamespace').openCursor(namespaceKey);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    });
  }

  getDisclosure(namespaceKey: string, profileId: string): Promise<DisclosureDecisionRecord | undefined> {
    return this.transaction([DISCLOSURE_STORE], 'readonly', (tx, setResult) => {
      const request = tx.objectStore(DISCLOSURE_STORE).get([namespaceKey, profileId]) as IDBRequest<DisclosureRow | undefined>;
      request.onsuccess = () => setResult(request.result?.record);
    });
  }

  putDisclosure(namespaceKey: string, record: DisclosureDecisionRecord): Promise<void> {
    return this.transaction([DISCLOSURE_STORE], 'readwrite', (tx) => {
      tx.objectStore(DISCLOSURE_STORE).put({ namespaceKey, profileId: record.profileId, record } satisfies DisclosureRow);
    });
  }

  deleteDisclosure(namespaceKey: string, profileId: string): Promise<void> {
    return this.transaction([DISCLOSURE_STORE], 'readwrite', (tx) => {
      tx.objectStore(DISCLOSURE_STORE).delete([namespaceKey, profileId]);
    });
  }

  getCatalogSnapshot(
    namespaceKey: string,
    profileId: string,
    configRevision: string,
  ): Promise<ConnectionCatalogSnapshot | undefined> {
    return this.transaction([CATALOG_STORE], 'readonly', (tx, setResult) => {
      const request = tx.objectStore(CATALOG_STORE).get([namespaceKey, profileId, configRevision]) as IDBRequest<CatalogRow | undefined>;
      request.onsuccess = () => setResult(request.result?.snapshot);
    });
  }

  putCatalogSnapshot(namespaceKey: string, snapshot: ConnectionCatalogSnapshot): Promise<void> {
    return this.transaction([PROFILE_STORE, CATALOG_STORE], 'readwrite', (tx) => {
      const request = tx.objectStore(PROFILE_STORE).get([namespaceKey, snapshot.profileId]) as IDBRequest<ProfileRow | undefined>;
      request.onsuccess = () => {
        const profile = request.result?.profile;
        if (!profile || profile.configRevision !== snapshot.configRevision) {
          try { tx.abort(); } catch { /* The transaction already closed. */ }
          return;
        }
        tx.objectStore(CATALOG_STORE).put({
          namespaceKey,
          profileId: snapshot.profileId,
          configRevision: snapshot.configRevision,
          snapshot,
        } satisfies CatalogRow);
      };
    });
  }

  private transaction<T = void>(
    stores: string[],
    mode: IDBTransactionMode,
    schedule: (transaction: IDBTransaction, setResult: (value: T) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let result: T = undefined as T;
      let failed = false;
      let transaction: IDBTransaction;
      try {
        transaction = this.database.transaction(stores, mode);
      } catch {
        reject(new Error('IndexedDB transaction could not be started.'));
        return;
      }
      transaction.oncomplete = () => failed
        ? reject(new Error('IndexedDB transaction did not complete.'))
        : resolve(result);
      transaction.onerror = () => { failed = true; };
      transaction.onabort = () => reject(new Error('IndexedDB transaction was aborted.'));
      const setResult = (value: T) => { result = value; };
      try {
        schedule(transaction, setResult);
      } catch {
        failed = true;
        try { transaction.abort(); } catch { reject(new Error('IndexedDB transaction was aborted.')); }
      }
    });
  }
}

function openDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, DATABASE_VERSION);
    } catch {
      reject(new Error('IndexedDB open failed.'));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROFILE_STORE)) {
        const profiles = database.createObjectStore(PROFILE_STORE, { keyPath: ['namespaceKey', 'id'] });
        profiles.createIndex('byNamespace', 'namespaceKey', { unique: false });
      }
      if (!database.objectStoreNames.contains(CREDENTIAL_STORE)) {
        const credentials = database.createObjectStore(CREDENTIAL_STORE, { keyPath: ['namespaceKey', 'profileId'] });
        credentials.createIndex('byNamespace', 'namespaceKey', { unique: false });
      }
      if (!database.objectStoreNames.contains(DISCLOSURE_STORE)) {
        const disclosures = database.createObjectStore(DISCLOSURE_STORE, { keyPath: ['namespaceKey', 'profileId'] });
        disclosures.createIndex('byNamespace', 'namespaceKey', { unique: false });
      }
      if (!database.objectStoreNames.contains(CATALOG_STORE)) {
        const catalogs = database.createObjectStore(CATALOG_STORE, { keyPath: ['namespaceKey', 'profileId', 'configRevision'] });
        catalogs.createIndex('byNamespace', 'namespaceKey', { unique: false });
        catalogs.createIndex('byConnection', ['namespaceKey', 'profileId'], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked.'));
  });
}
