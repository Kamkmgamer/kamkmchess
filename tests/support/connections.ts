import { IDBFactory } from 'fake-indexeddb';
import { openConnectionStore } from '../../src/providers/connections';
import type { ConnectionCredentials, ConnectionProfile, BoundConnectionCredentials } from '../../src/providers/connections';

export async function bindTestCredentials(
  profile: ConnectionProfile,
  values: ConnectionCredentials,
): Promise<BoundConnectionCredentials> {
  const store = await openConnectionStore({ factory: new IDBFactory(), databaseName: 'connection-test' });
  const namespace = { kind: 'guest' } as const;
  await store.saveProfile(namespace, profile);
  if (values.apiKey !== undefined || Object.keys(values.headers ?? {}).length > 0) {
    await store.assignCredential(namespace, profile.id, values);
  }
  const result = await store.resolveCredentials(namespace, profile);
  if (result.status !== 'bound') throw new Error(`Expected a local binding, received ${result.status}.`);
  return result.credentials;
}
