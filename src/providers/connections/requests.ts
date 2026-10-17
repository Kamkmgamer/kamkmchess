import { getConnectionEndpoints } from './profile';
import { readBoundCredentialValues } from './credential-binding';
import { assertCredentialBinding } from './store';
import { ConnectionError } from './types';
import type { BoundConnectionCredentials, ConnectionProfile, ConnectionProtocol } from './types';
import type { ProtocolGenerationConfig } from '../protocols/types';

export interface PreparedProviderRequest {
  readonly url: string;
  readonly init: RequestInit & { readonly headers: Readonly<Record<string, string>> };
}

export function prepareGenerationRequest(
  profile: ConnectionProfile,
  credentials: BoundConnectionCredentials,
  body: BodyInit,
  config?: ProtocolGenerationConfig,
): PreparedProviderRequest {
  validateCacheRoute(profile, config, body);
  return prepareRequest(profile, credentials, 'POST', body);
}

function validateCacheRoute(
  profile: ConnectionProfile,
  config: ProtocolGenerationConfig | undefined,
  body: BodyInit,
): void {
  const cache = config?.cache;
  const bodyCache = readBodyCacheControls(body);

  const hasOpenAiCache = cache?.promptCacheKey !== undefined || cache?.promptCacheRetention !== undefined
    || bodyCache.promptCacheKey || bodyCache.promptCacheRetention;
  const hasOpenRouterSession = cache?.openRouterSessionId !== undefined || bodyCache.openRouterSession;
  const hasAnthropicCache = cache?.anthropicEphemeral !== undefined || cache?.anthropicCacheMinimumTokens !== undefined
    || bodyCache.anthropicCache;
  if (!hasOpenAiCache && !hasOpenRouterSession && !hasAnthropicCache) return;
  const supported = (!hasOpenAiCache || (profile.provider === 'openai' && ['chat-completions', 'responses'].includes(profile.protocol)))
    && (!hasOpenRouterSession || (profile.provider === 'openrouter' && profile.protocol === 'chat-completions'))
    && (!hasAnthropicCache || (profile.provider === 'anthropic' && profile.protocol === 'messages'));

  if (!supported) {
    throw new ConnectionError(
      'unsupported-cache-option',
      'The selected cache option is not supported by this connection provider and protocol.',
    );
  }
}

function readBodyCacheControls(body: BodyInit): {
  promptCacheKey: boolean;
  promptCacheRetention: boolean;
  openRouterSession: boolean;
  anthropicCache: boolean;
} {
  if (typeof body !== 'string') {
    return { promptCacheKey: false, promptCacheRetention: false, openRouterSession: false, anthropicCache: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { promptCacheKey: false, promptCacheRetention: false, openRouterSession: false, anthropicCache: false };
  }
  const found = { promptCacheKey: false, promptCacheRetention: false, openRouterSession: false, anthropicCache: false };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, nested] of Object.entries(value)) {
        if (key === 'prompt_cache_key') found.promptCacheKey = true;
        if (key === 'prompt_cache_retention') found.promptCacheRetention = true;
        if (key === 'session_id') found.openRouterSession = true;
        if (key === 'cache_control') found.anthropicCache = true;
        visit(nested);
      }
    }
  };
  visit(parsed);
  return found;
}

export function prepareCatalogRequest(
  profile: ConnectionProfile,
  credentials: BoundConnectionCredentials,
): PreparedProviderRequest {
  const endpoints = getConnectionEndpoints(profile);
  if (!endpoints.catalogUrl) throw new ConnectionError('catalog-unavailable', 'This connection has no configured model catalog. Enter an exact model ID manually.');
  return prepareRequest(profile, credentials, 'GET', undefined, endpoints.catalogUrl);
}

function prepareRequest(
  profile: ConnectionProfile,
  credentials: BoundConnectionCredentials,
  method: 'GET' | 'POST',
  body?: BodyInit,
  destinationUrl?: string,
): PreparedProviderRequest {
  assertCredentialBinding(profile, credentials);
  const values = readBoundCredentialValues(credentials);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method === 'POST') headers['content-type'] = 'application/json';

  if (profile.auth.kind === 'bearer') {
    headers.authorization = `Bearer ${requireApiKey(values)}`;
  } else if (profile.auth.kind === 'api-key-header') {
    headers[profile.auth.headerName.toLowerCase()] = requireApiKey(values);
  }

  for (const header of protocolHeaders(profile.provider, profile.protocol)) {
    headers[header.name] = header.value;
  }
  for (const header of profile.headers) {
    const value = header.source === 'literal'
      ? header.value
      : readSecretHeader(values, header.name);
    if (/\r|\n/.test(value)) throw new ConnectionError('invalid-header', `The value for "${header.name}" contains a line break.`);
    headers[header.name.toLowerCase()] = value;
  }

  const init: RequestInit & { headers: Readonly<Record<string, string>> } = {
    method,
    headers,
    credentials: 'omit',
    redirect: 'error',
    ...(body === undefined ? {} : { body }),
  };
  return { url: destinationUrl ?? getConnectionEndpoints(profile).generationUrl, init };
}

function requireApiKey(credentials: { readonly apiKey?: string }): string {
  const key = credentials.apiKey;
  if (typeof key !== 'string' || key.length === 0 || /\r|\n/.test(key)) {
    throw new ConnectionError('credential-required', 'Assign a credential to this connection before sending a request.');
  }
  return key;
}

function readSecretHeader(credentials: { readonly headers?: Readonly<Record<string, string>> }, name: string): string {
  const values = credentials.headers ?? {};
  const value = Object.entries(values).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (typeof value !== 'string' || value.length === 0 || /\r|\n/.test(value)) {
    throw new ConnectionError('credential-required', `Assign a credential for the "${name}" header before sending a request.`);
  }
  return value;
}

function protocolHeaders(
  provider: ConnectionProfile['provider'],
  protocol: ConnectionProtocol,
): readonly { name: string; value: string }[] {
  if (provider === 'anthropic' && protocol === 'messages') {
    return [
      { name: 'anthropic-version', value: '2023-06-01' },
      { name: 'anthropic-dangerous-direct-browser-access', value: 'true' },
    ];
  }
  return [];
}
