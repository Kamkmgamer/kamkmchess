import { getConnectionEndpoints } from './profile';
import { prepareCatalogRequest } from './requests';
import { readBoundCredentialValues } from './credential-binding';
import { ConnectionError } from './types';
import type { BoundConnectionCredentials, ConnectionProfile } from './types';

export interface CatalogModel {
  readonly id: string;
  readonly displayName?: string;
  readonly ownedBy?: string;
}

export type CatalogCheckResult =
  | {
      readonly status: 'unavailable';
      readonly checkedAtMs: number;
      readonly models: readonly [];
      readonly error: ConnectionError;
    }
  | {
      readonly status: 'success';
      readonly requestedUrl: string;
      readonly checkedAtMs: number;
      readonly models: readonly CatalogModel[];
    }
  | {
      readonly status: 'partial';
      readonly requestedUrl: string;
      readonly checkedAtMs: number;
      readonly models: readonly CatalogModel[];
      readonly nextUrl?: string;
      readonly error?: ConnectionError;
    }
  | {
      readonly status: 'failure';
      readonly requestedUrl: string;
      readonly checkedAtMs: number;
      readonly error: ConnectionError;
      readonly models: readonly CatalogModel[];
    };

export interface CheckConnectionOptions {
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
}

export async function checkConnection(
  profile: ConnectionProfile,
  credentials: BoundConnectionCredentials,
  options: CheckConnectionOptions,
): Promise<CatalogCheckResult> {
  const checkedAtMs = (options.now ?? Date.now)();
  const maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new ConnectionError('invalid-profile', 'Catalog checks need a positive page limit.');
  }
  if (!getCatalogUrl(profile)) {
    return {
      status: 'unavailable',
      checkedAtMs,
      models: [],
      error: new ConnectionError('catalog-unavailable', 'This connection has no configured model catalog. Enter an exact model ID manually.'),
    };
  }
  const prepared = prepareCatalogRequest(profile, credentials);
  const requestedUrl = prepared.url;

  const models = new Map<string, CatalogModel>();
  const cursors = new Set<string>();
  let pageUrl = requestedUrl;
  for (let page = 0; page < maxPages; page += 1) {
    let response: Response;
    try {
      response = await options.fetch(pageUrl, {
        ...prepared.init,
        cache: 'no-store',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      const error = requestError(cause, options.signal);
      return failedOrPartial(requestedUrl, checkedAtMs, [...models.values()], error);
    }

    if (!response.ok) {
      const error = await httpError(response, credentials, checkedAtMs);
      return failedOrPartial(requestedUrl, checkedAtMs, [...models.values()], error);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failedOrPartial(
        requestedUrl,
        checkedAtMs,
        [...models.values()],
        new ConnectionError('malformed-catalog', 'The endpoint returned a successful response that was not readable JSON.', response.status),
      );
    }

    const parsed = parseCatalogPage(payload, response.status);
    if (parsed.error) return failedOrPartial(requestedUrl, checkedAtMs, [...models.values()], parsed.error);
    for (const model of parsed.models) {
      if (!models.has(model.id)) models.set(model.id, model);
    }
    if (!parsed.hasMore) {
      return { status: 'success', requestedUrl, checkedAtMs, models: [...models.values()] };
    }

    const cursor = parsed.lastId ?? parsed.models.at(-1)?.id;
    if (!cursor || profile.catalogPagination === 'none') {
      const error = new ConnectionError(
        'malformed-catalog',
        'This catalog reports more models, but the connection has no matching pagination method. Keep existing entries and use a manual model ID if needed.',
        response.status,
      );
      return { status: 'partial', requestedUrl, checkedAtMs, models: [...models.values()], error };
    }
    if (cursors.has(cursor)) {
      const error = new ConnectionError('malformed-catalog', 'The catalog repeated a pagination cursor. Keep existing entries and use a manual model ID if needed.', response.status);
      return { status: 'partial', requestedUrl, checkedAtMs, models: [...models.values()], error };
    }
    cursors.add(cursor);
    pageUrl = cursorUrl(pageUrl, profile.catalogPagination, cursor);
  }

  return {
    status: 'partial',
    requestedUrl,
    checkedAtMs,
    models: [...models.values()],
    nextUrl: pageUrl,
  };
}

function getCatalogUrl(profile: ConnectionProfile): string | undefined {
  return getConnectionEndpoints(profile).catalogUrl;
}

function parseCatalogPage(payload: unknown, status: number): {
  models: CatalogModel[];
  hasMore: boolean;
  lastId?: string;
  error?: ConnectionError;
} {
  if (!isRecord(payload)) return { models: [], hasMore: false, error: malformed(status) };
  const rawModels = Array.isArray(payload.data) ? payload.data : payload.models;
  if (!Array.isArray(rawModels)) return { models: [], hasMore: false, error: malformed(status) };

  const models: CatalogModel[] = [];
  for (const value of rawModels) {
    if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) {
      return { models: [], hasMore: false, error: malformed(status) };
    }
    const displayName = stringValue(value.name) ?? stringValue(value.display_name);
    const ownedBy = stringValue(value.owned_by);
    models.push({
      id: value.id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(ownedBy === undefined ? {} : { ownedBy }),
    });
  }

  if (payload.has_more !== undefined && typeof payload.has_more !== 'boolean') {
    return { models: [], hasMore: false, error: malformed(status) };
  }
  const lastId = stringValue(payload.last_id) ?? stringValue(payload.lastId);
  return { models, hasMore: payload.has_more === true, ...(lastId === undefined ? {} : { lastId }) };
}

function cursorUrl(currentUrl: string, method: 'after' | 'after_id' | 'none', cursor: string): string {
  const url = new URL(currentUrl);
  url.searchParams.set(method, cursor);
  return url.toString();
}

async function httpError(
  response: Response,
  credentials: BoundConnectionCredentials,
  nowMs: number,
): Promise<ConnectionError> {
  let bodyText = '';
  try {
    bodyText = (await response.text()).slice(0, 8192);
  } catch {
    // The status remains useful when the response body cannot be read.
  }
  const parsed = parseProviderError(bodyText, readBoundCredentialValues(credentials));
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), nowMs);
  const status = response.status;
  const code = status === 401 ? 'http-authentication'
    : status === 403 ? 'http-permission'
      : status === 402 ? 'http-quota'
      : status === 429 ? 'http-rate-limited'
        : [413, 503, 507, 529].includes(status) ? 'http-capacity'
          : [404, 405].includes(status) ? 'http-endpoint'
            : 'http-failure';
  const defaultMessage = status === 401 ? 'The endpoint rejected this connection credential.'
    : status === 403 ? 'The endpoint denied this catalog request.'
      : status === 402 ? 'The endpoint reported that available quota or credit is insufficient.'
      : status === 429 ? 'The endpoint rate-limited this catalog request.'
        : [413, 503, 507, 529].includes(status) ? 'The endpoint could not return this catalog response because of a capacity or availability limit.'
          : [404, 405].includes(status) ? 'The configured catalog endpoint was not found or does not allow this request.'
            : `The catalog endpoint returned HTTP ${status}.`;
  return new ConnectionError(
    code,
    parsed.message ?? defaultMessage,
    status,
    parsed.code,
    retryAfterMs,
  );
}

function parseProviderError(bodyText: string, credentials: { readonly apiKey?: string; readonly headers?: Readonly<Record<string, string>> }): { message?: string; code?: string } {
  if (!bodyText) return {};
  let values: { message?: string; code?: string } = {};
  try {
    const body: unknown = JSON.parse(bodyText);
    const error = isRecord(body) && isRecord(body.error) ? body.error : body;
    if (isRecord(error)) {
      const message = stringValue(error.message) ?? stringValue(error.detail);
      const code = stringValue(error.code) ?? stringValue(error.type);
      values = {
        ...(message === undefined ? {} : { message }),
        ...(code === undefined ? {} : { code }),
      };
    }
  } catch {
    values = { message: bodyText };
  }

  const secrets = [credentials.apiKey, ...Object.values(credentials.headers ?? {})].filter((value): value is string => Boolean(value));
  const redact = (value: string) => {
    let safe = value;
    for (const secret of secrets) safe = safe.replaceAll(secret, '[redacted]');
    return safe
      .replace(/https?:\/\/[^\s"'<>]+/gi, '[endpoint URL]')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 400);
  };
  const message = values.message === undefined ? undefined : redact(values.message);
  const code = values.code === undefined ? undefined : redact(values.code);
  return {
    ...(message === undefined || message.length === 0 ? {} : { message }),
    ...(code === undefined || code.length === 0 ? {} : { code }),
  };
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - nowMs);
}

function requestError(cause: unknown, signal?: AbortSignal): ConnectionError {
  if (signal?.aborted || (isRecord(cause) && cause.name === 'AbortError')) {
    return new ConnectionError('request-interrupted', 'The catalog request was interrupted.');
  }
  return new ConnectionError('request-failed', 'The browser could not complete the catalog request. Its cause is unknown.');
}

function failedOrPartial(
  requestedUrl: string,
  checkedAtMs: number,
  models: readonly CatalogModel[],
  error: ConnectionError,
): CatalogCheckResult {
  return models.length === 0
    ? { status: 'failure', requestedUrl, checkedAtMs, error, models }
    : { status: 'partial', requestedUrl, checkedAtMs, error, models };
}

function malformed(status: number): ConnectionError {
  return new ConnectionError('malformed-catalog', 'The endpoint returned a catalog response with an unsupported shape.', status);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
