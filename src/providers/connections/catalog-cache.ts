import { ConnectionError } from './types';
import type { CachedCatalogEntry, ConnectionCatalogSnapshot, ConnectionProfile } from './types';
import type { CatalogCheckResult, CatalogModel } from './catalog';

export function updateCatalogSnapshot(
  profile: ConnectionProfile,
  previous: ConnectionCatalogSnapshot | undefined,
  result: CatalogCheckResult,
): ConnectionCatalogSnapshot {
  const base = {
    profileId: profile.id,
    configRevision: profile.configRevision,
    checkedAtMs: result.checkedAtMs,
  };
  if (result.status === 'unavailable') {
    return {
      ...base,
      state: 'unavailable',
      entries: previous?.entries.map((entry) => ({ ...entry, state: 'stale' })) ?? [],
      ...(previous?.lastSuccessfulAtMs === undefined ? {} : { lastSuccessfulAtMs: previous.lastSuccessfulAtMs }),
      error: cachedError(result.error),
    };
  }

  if (result.status === 'failure') {
    return {
      ...base,
      requestedUrl: result.requestedUrl,
      state: 'stale',
      entries: previous?.entries.map((entry) => ({ ...entry, state: 'stale' })) ?? [],
      ...(previous?.lastSuccessfulAtMs === undefined ? {} : { lastSuccessfulAtMs: previous.lastSuccessfulAtMs }),
      error: cachedError(result.error),
    };
  }

  if (result.status === 'partial') {
    const entries = new Map<string, CachedCatalogEntry>();
    for (const entry of previous?.entries ?? []) entries.set(entry.id, { ...entry, state: 'stale' });
    for (const model of result.models) entries.set(model.id, catalogEntry(model, 'advertised', result.checkedAtMs));
    return {
      ...base,
      requestedUrl: result.requestedUrl,
      state: 'partial',
      entries: [...entries.values()],
      ...(previous?.lastSuccessfulAtMs === undefined ? {} : { lastSuccessfulAtMs: previous.lastSuccessfulAtMs }),
      ...(result.nextUrl === undefined ? {} : { nextUrl: result.nextUrl }),
      ...(result.error === undefined ? {} : { error: cachedError(result.error) }),
    };
  }

  const entries: CachedCatalogEntry[] = result.models.map((model) => catalogEntry(model, 'advertised', result.checkedAtMs));
  const advertised = new Set(result.models.map((model) => model.id));
  for (const entry of previous?.entries ?? []) {
    if (!advertised.has(entry.id)) entries.push({ ...entry, state: 'not-advertised' });
  }
  return {
    ...base,
    requestedUrl: result.requestedUrl,
    state: 'complete',
    entries,
    lastSuccessfulAtMs: result.checkedAtMs,
  };
}

function catalogEntry(
  model: CatalogModel,
  state: CachedCatalogEntry['state'],
  lastAdvertisedAtMs: number,
): CachedCatalogEntry {
  return {
    id: model.id,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    ...(model.ownedBy === undefined ? {} : { ownedBy: model.ownedBy }),
    state,
    lastAdvertisedAtMs,
  };
}

function cachedError(error: ConnectionError): NonNullable<ConnectionCatalogSnapshot['error']> {
  return {
    code: error.code,
    message: error.message,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
}
