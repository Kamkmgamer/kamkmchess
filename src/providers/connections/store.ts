import { getConnectionEndpoints } from './profile';
import { updateCatalogSnapshot } from './catalog-cache';
import { openConnectionPersistence } from './indexeddb';
import { hasCurrentDisclosureConsent, recordDisclosureChoice } from './disclosure';
import type { DisclosureChoice } from './disclosure';
import {
  bindCredentialValues,
  captureCredentialBindingGeneration,
  createCredentialBindingOwner,
  revokeAllBindings,
  revokeNamespaceBindings,
  revokeProfileBindings,
} from './credential-binding';
import {
  localReadError,
  restoreCatalogSnapshot,
  restoreCredentialRecord,
  restoreDisclosureRecord,
  restoreProfile,
  validateCredentialValues,
  validatePersistableProfile,
} from './restore-validation';
import { ConnectionError } from './types';
import type {
  BoundConnectionCredentials,
  ConnectionCredentials,
  ConnectionCatalogSnapshot,
  ConnectionNamespace,
  ConnectionPersistence,
  ConnectionProfile,
  DisclosureDecisionRecord,
  CredentialResolution,
  StoredCredentialRecord,
} from './types';
import type { OpenConnectionStoreOptions } from './indexeddb';
import type { CatalogCheckResult } from './catalog';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLERK_USER_ID = /^user_[A-Za-z0-9]{16,}$/;
const bindingOwners = new WeakMap<ConnectionPersistence, object>();

export interface ConnectionStore {
  saveProfile(namespace: ConnectionNamespace, profile: ConnectionProfile): Promise<void>;
  getProfile(namespace: ConnectionNamespace, profileId: string): Promise<ConnectionProfile | undefined>;
  listProfiles(namespace: ConnectionNamespace): Promise<readonly ConnectionProfile[]>;
  forgetProfile(namespace: ConnectionNamespace, profileId: string): Promise<void>;
  assignCredential(namespace: ConnectionNamespace, profileId: string, values: ConnectionCredentials): Promise<number>;
  resolveCredentials(namespace: ConnectionNamespace, profile: ConnectionProfile): Promise<CredentialResolution>;
  forgetCredential(namespace: ConnectionNamespace, profileId: string): Promise<void>;
  clearCredentialsForNamespace(namespace: ConnectionNamespace): Promise<void>;
  clearAllLocalCredentials(): Promise<void>;
  snapshotKnownCredentials(namespace: ConnectionNamespace): Promise<readonly string[]>;
  recordDisclosureChoice(namespace: ConnectionNamespace, profile: ConnectionProfile, choice: DisclosureChoice): Promise<DisclosureDecisionRecord>;
  getDisclosureChoice(namespace: ConnectionNamespace, profile: ConnectionProfile): Promise<DisclosureDecisionRecord | undefined>;
  getCatalogSnapshot(namespace: ConnectionNamespace, profile: ConnectionProfile): Promise<ConnectionCatalogSnapshot | undefined>;
  recordCatalogCheck(namespace: ConnectionNamespace, profile: ConnectionProfile, result: CatalogCheckResult): Promise<ConnectionCatalogSnapshot>;
}

export async function openConnectionStore(options: OpenConnectionStoreOptions = {}): Promise<ConnectionStore> {
  const persistence = await openConnectionPersistence(options);
  return createConnectionStore(persistence);
}

export function createConnectionStore(persistence: ConnectionPersistence): ConnectionStore {
  const owner = getBindingOwner(persistence);
  return {
    async saveProfile(namespace, profile) {
      const key = namespaceKey(namespace);
      const validated = await validatePersistableProfile(profile);
      const previous = await readSavedProfile(persistence, key, validated.id);
      if (previous && previous.configRevision !== validated.configRevision) {
        const [credential, disclosure, catalog] = await Promise.all([
          performRead(() => persistence.getCredential(key, previous.id)),
          performRead(() => persistence.getDisclosure(key, previous.id)),
          performRead(() => persistence.getCatalogSnapshot(key, previous.id, previous.configRevision)),
        ]);
        if (credential !== undefined) restoreCredentialRecord(previous, credential);
        if (disclosure !== undefined) restoreDisclosureRecord(previous, disclosure);
        if (catalog !== undefined) restoreCatalogSnapshot(previous, catalog);
      }
      await performWrite(() => persistence.putProfile(key, validated), 'The connection profile was not saved in this browser.');
      revokeProfileBindings(owner, key, validated.id);
    },

    async getProfile(namespace, profileId) {
      const key = namespaceKey(namespace);
      return readSavedProfile(persistence, key, profileId);
    },

    async listProfiles(namespace) {
      const key = namespaceKey(namespace);
      const rows = await performRead(() => persistence.listProfiles(key));
      if (!Array.isArray(rows)) throw localReadError();
      const profiles = await Promise.all(rows.map((row) => restoreProfile(row)));
      if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw localReadError();
      return profiles;
    },

    async forgetProfile(namespace, profileId) {
      const key = namespaceKey(namespace);
      await performWrite(() => persistence.deleteProfile(key, profileId), 'The connection profile could not be removed from this browser.');
      revokeProfileBindings(owner, key, profileId);
    },

    async assignCredential(namespace, profileId, values) {
      const key = namespaceKey(namespace);
      const profile = await readSavedProfile(persistence, key, profileId);
      const previousRow = await performRead(() => persistence.getCredential(key, profileId));
      if (!profile) throw new ConnectionError('profile-not-found', 'Save this connection profile before assigning a credential.');
      const previous = previousRow === undefined ? undefined : restoreCredentialRecord(profile, previousRow);
      const endpoints = getConnectionEndpoints(profile);
      const priorRevision = previous?.credentialRevision ?? 0;
      if (!Number.isSafeInteger(priorRevision) || priorRevision < 0) {
        throw new ConnectionError('local-read-failed', 'Local credential metadata is invalid.');
      }
      const credentialRevision = priorRevision + 1;
      const record: StoredCredentialRecord = {
        profileId,
        configRevision: profile.configRevision,
        credentialRevision,
        generationUrl: endpoints.generationUrl,
        ...(endpoints.catalogUrl === undefined ? {} : { catalogUrl: endpoints.catalogUrl }),
        values: validateCredentialValues(profile, values),
      };
      await performWrite(() => persistence.putCredential(key, record), 'The credential was not saved in this browser.');
      revokeProfileBindings(owner, key, profileId);
      return credentialRevision;
    },

    async resolveCredentials(namespace, profile) {
      const key = namespaceKey(namespace);
      const validatedProfile = await validatePersistableProfile(profile);
      const bindingGeneration = captureCredentialBindingGeneration(owner, key, validatedProfile.id);
      const [savedProfile, storedRow] = await Promise.all([
        readSavedProfile(persistence, key, validatedProfile.id),
        performRead(() => persistence.getCredential(key, validatedProfile.id)),
      ]);
      if (!savedProfile) return { status: 'profile-not-found' };
      const stored = storedRow === undefined ? undefined : restoreCredentialRecord(savedProfile, storedRow);
      if (savedProfile.configRevision !== validatedProfile.configRevision) return { status: 'destination-changed' };
      const endpoints = getConnectionEndpoints(validatedProfile);
      if (!stored) {
        if (needsCredential(validatedProfile)) return { status: 'missing' };
        return { status: 'bound', credentials: bindCredentials(bindingGeneration, validatedProfile, 0, endpoints.generationUrl, endpoints.catalogUrl, {}) };
      }
      if (stored.configRevision !== validatedProfile.configRevision
        || stored.generationUrl !== endpoints.generationUrl
        || stored.catalogUrl !== endpoints.catalogUrl) {
        return { status: 'destination-changed' };
      }
      return {
        status: 'bound',
        credentials: bindCredentials(bindingGeneration, validatedProfile, stored.credentialRevision, stored.generationUrl, stored.catalogUrl, stored.values),
      };
    },

    async forgetCredential(namespace, profileId) {
      const key = namespaceKey(namespace);
      await performWrite(() => persistence.deleteCredential(key, profileId), 'The credential could not be removed from this browser.');
      revokeProfileBindings(owner, key, profileId);
    },

    async clearCredentialsForNamespace(namespace) {
      const key = namespaceKey(namespace);
      await performWrite(() => persistence.clearCredentials(key), 'Credentials for this account could not be cleared from this browser.');
      revokeNamespaceBindings(owner, key);
    },

    async clearAllLocalCredentials() {
      await performWrite(() => persistence.clearCredentials(), 'Local AI credentials could not be cleared from this browser.');
      revokeAllBindings(owner);
    },

    async snapshotKnownCredentials(namespace) {
      const key = namespaceKey(namespace);
      const records = await performRead(() => persistence.listCredentialRecords(key));
      if (!Array.isArray(records)) throw localReadError();
      const values = new Set<string>();
      for (const row of records) {
        if (!isRecord(row) || typeof row.profileId !== 'string' || row.profileId.length === 0) throw localReadError();
        const profile = await readSavedProfile(persistence, key, row.profileId);
        if (!profile) throw localReadError();
        const { values: recordValues } = restoreCredentialRecord(profile, row);
        if (recordValues.apiKey) values.add(recordValues.apiKey);
        for (const value of Object.values(recordValues.headers ?? {})) values.add(value);
      }
      return Object.freeze([...values]);
    },

    async recordDisclosureChoice(namespace, profile, choice) {
      const key = namespaceKey(namespace);
      const validatedProfile = await validatePersistableProfile(profile);
      const savedProfile = await readSavedProfile(persistence, key, validatedProfile.id);
      if (!savedProfile) throw new ConnectionError('profile-not-found', 'Save this connection before recording its disclosure choice.');
      if (savedProfile.configRevision !== validatedProfile.configRevision) {
        throw new ConnectionError('credential-destination-mismatch', 'The disclosure choice must match the saved connection configuration.');
      }
      const previous = await performRead(() => persistence.getDisclosure(key, validatedProfile.id));
      if (previous !== undefined) restoreDisclosureRecord(savedProfile, previous);
      const record = recordDisclosureChoice(validatedProfile, choice);
      await performWrite(() => persistence.putDisclosure(key, record), 'The disclosure choice was not saved in this browser.');
      return record;
    },

    async getDisclosureChoice(namespace, profile) {
      const key = namespaceKey(namespace);
      const validatedProfile = await validatePersistableProfile(profile);
      const [savedProfile, row] = await Promise.all([
        readSavedProfile(persistence, key, validatedProfile.id),
        performRead(() => persistence.getDisclosure(key, validatedProfile.id)),
      ]);
      if (!savedProfile) {
        if (row !== undefined) throw localReadError();
        return undefined;
      }
      if (row === undefined) return undefined;
      const record = restoreDisclosureRecord(savedProfile, row);
      if (savedProfile.configRevision !== validatedProfile.configRevision) return undefined;
      return hasCurrentDisclosureConsent(validatedProfile, record)
        || (record.decision === 'declined' && sameDisclosureTarget(validatedProfile, record))
        ? record
        : undefined;
    },

    async getCatalogSnapshot(namespace, profile) {
      const key = namespaceKey(namespace);
      const validated = await validatePersistableProfile(profile);
      const savedProfile = await readSavedProfile(persistence, key, validated.id);
      if (!savedProfile || savedProfile.configRevision !== validated.configRevision) return undefined;
      const row = await performRead(() => persistence.getCatalogSnapshot(key, validated.id, validated.configRevision));
      return row === undefined ? undefined : restoreCatalogSnapshot(savedProfile, row);
    },

    async recordCatalogCheck(namespace, profile, result) {
      const key = namespaceKey(namespace);
      const validated = await validatePersistableProfile(profile);
      const savedProfile = await readSavedProfile(persistence, key, validated.id);
      if (!savedProfile || savedProfile.configRevision !== validated.configRevision) {
        throw new ConnectionError('credential-destination-mismatch', 'This catalog result belongs to an older connection configuration.');
      }
      const previousRow = await performRead(() => persistence.getCatalogSnapshot(key, validated.id, validated.configRevision));
      const previous = previousRow === undefined ? undefined : restoreCatalogSnapshot(savedProfile, previousRow);

      const endpoints = getConnectionEndpoints(validated);
      if (result.status === 'unavailable') {
        if (endpoints.catalogUrl !== undefined) {
          throw new ConnectionError('invalid-profile', 'A catalog result for this connection has an unexpected unavailable status.');
        }
      } else if (result.requestedUrl !== endpoints.catalogUrl) {
        throw new ConnectionError('credential-destination-mismatch', 'This catalog result does not match the saved catalog destination.');
      }

      const snapshot = updateCatalogSnapshot(validated, previous, result);
      await performWrite(() => persistence.putCatalogSnapshot(key, snapshot), 'The model catalog was not saved in this browser.');
      return snapshot;
    },
  };
}

export function namespaceKey(namespace: ConnectionNamespace): string {
  if (namespace.kind === 'guest') return 'guest';
  if (namespace.kind === 'account' && UUID.test(namespace.accountId)) return `account:${namespace.accountId.toLowerCase()}`;
  if (namespace.kind === 'account' && CLERK_USER_ID.test(namespace.accountId)) return `account:${namespace.accountId}`;
  throw new ConnectionError('invalid-profile', 'Account connection storage requires a valid account identifier.');
}

export function assertCredentialBinding(
  profile: ConnectionProfile,
  credentials: BoundConnectionCredentials,
): void {
  const endpoints = getConnectionEndpoints(profile);
  if (credentials.profileId !== profile.id
    || credentials.configRevision !== profile.configRevision
    || !Number.isSafeInteger(credentials.credentialRevision)
    || credentials.credentialRevision < 0
    || credentials.generationUrl !== endpoints.generationUrl
    || credentials.catalogUrl !== endpoints.catalogUrl) {
    throw new ConnectionError('credential-destination-mismatch', 'This credential is not assigned to the current connection destination and configuration.');
  }
}

function bindCredentials(
  generation: ReturnType<typeof captureCredentialBindingGeneration>,
  profile: ConnectionProfile,
  credentialRevision: number,
  generationUrl: string,
  catalogUrl: string | undefined,
  values: ConnectionCredentials,
): BoundConnectionCredentials {
  return bindCredentialValues({
    profileId: profile.id,
    configRevision: profile.configRevision,
    credentialRevision,
    generationUrl,
    ...(catalogUrl === undefined ? {} : { catalogUrl }),
  }, values, generation);
}

function needsCredential(profile: ConnectionProfile): boolean {
  return profile.auth.kind !== 'none' || profile.headers.some((header) => header.source === 'credential');
}

function sameDisclosureTarget(profile: ConnectionProfile, record: DisclosureDecisionRecord): boolean {
  const endpoints = getConnectionEndpoints(profile);
  return record.profileId === profile.id
    && record.configRevision === profile.configRevision
    && record.destinationUrl === endpoints.generationUrl;
}

async function performRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw localReadError();
  }
}

function getBindingOwner(persistence: ConnectionPersistence): object {
  let owner = bindingOwners.get(persistence);
  if (!owner) {
    owner = createCredentialBindingOwner();
    bindingOwners.set(persistence, owner);
  }
  return owner;
}

async function readSavedProfile(
  persistence: ConnectionPersistence,
  key: string,
  profileId: string,
): Promise<ConnectionProfile | undefined> {
  const row = await performRead(() => persistence.getProfile(key, profileId));
  return row === undefined ? undefined : restoreProfile(row, profileId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function performWrite(write: () => Promise<void>, message: string): Promise<void> {
  try {
    await write();
  } catch {
    throw new ConnectionError('local-write-failed', message);
  }
}
