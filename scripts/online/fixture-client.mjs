// Shared helpers for the local online fixture.
//
// The fixture is a throwaway service composition: a real Go API, a real
// PostgreSQL schema and the pinned private rules worker, all on loopback.
// These helpers only read its descriptor and mint synthetic session tokens for
// the fixture's own accounts.
//
// Nothing here reaches a hosted service, reads a production credential or
// prints a secret. The database password is only ever held in memory and
// passed to a child process through the environment.

import { execFile } from 'node:child_process';
import { createPrivateKey, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describeFixtureBaseUrlProblem } from '../shared/fixture-base-url.mjs';

const run = promisify(execFile);

export const FIXTURE_DATABASE_ENV = 'ONLINE_FIXTURE_DATABASE_URL';
export const FIXTURE_DESCRIPTOR_ENV = 'ONLINE_FIXTURE_DESCRIPTOR';

/**
 * @typedef {object} FixtureAccount
 * @property {string} id
 * @property {string} token
 */

/**
 * @typedef {object} FixtureDescriptor
 * @property {string} baseUrl
 * @property {string} issuer
 * @property {string} jwksUrl
 * @property {string[]} allowedOrigins
 * @property {FixtureAccount[]} accounts
 * @property {string} schema
 * @property {string} database
 * @property {string} rulesWorker
 * @property {string} keyPath
 * @property {number} pid
 * @property {string} startedAt
 * @property {string} expiresAt
 */

/**
 * Reads and validates the fixture descriptor.
 *
 * The base URL of the descriptor is the address the credential of the fixture
 * travels to, so it is parsed and compared with the loopback origin of the
 * fixture. A prefix of the text of the URL is not a check:
 * `http://127.0.0.1:18099@attacker.example` starts with the loopback address
 * and sends the minted token to another host. The reader therefore refuses
 * every base URL that is not the address of the fixture itself, and it
 * refuses it before a token can be minted or a request sent.
 * @param {string} path
 * @returns {Promise<FixtureDescriptor>}
 */
export async function readDescriptor(path) {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('fixture descriptor is not an object');
  }
  const problem = describeFixtureBaseUrlProblem(parsed.baseUrl);
  if (problem) {
    throw new Error(`fixture descriptor does not name the loopback base URL of the fixture: ${problem}`);
  }
  if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    throw new Error('fixture descriptor has no synthetic accounts');
  }
  return parsed;
}

/**
 * The base URL of the fixture, checked again before a credential leaves.
 *
 * The reader of the descriptor is the usual way in, but a caller can hold a
 * descriptor of its own. The check runs again before a token is minted and
 * before a request is sent, so a descriptor that does not name the fixture is
 * refused in every path and not only in the one that read it from a file.
 * @param {FixtureDescriptor} descriptor
 * @returns {string} the base URL of the fixture
 */
export function requireFixtureBaseUrl(descriptor) {
  const problem = describeFixtureBaseUrlProblem(descriptor?.baseUrl);
  if (problem) {
    throw new Error(`the fixture descriptor does not name the loopback base URL of the fixture: ${problem}`);
  }
  return descriptor.baseUrl;
}

/**
 * Returns the descriptor path from the environment or throws a clear error.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function descriptorPathFromEnvironment(env = process.env) {
  const path = env[FIXTURE_DESCRIPTOR_ENV];
  if (!path) {
    throw new Error(`${FIXTURE_DESCRIPTOR_ENV} is not set; start the fixture with scripts/online/fixture-server.mjs`);
  }
  return path;
}

/**
 * Mints a short-lived session token for one of the fixture's accounts using
 * the fixture's own signing key. The API verifies it with the same code path
 * a hosted session token takes.
 * @param {FixtureDescriptor} descriptor
 * @param {string} accountId
 * @param {number} [lifetimeSeconds]
 * @returns {Promise<string>}
 */
export async function mintToken(descriptor, accountId, lifetimeSeconds = 900) {
  requireFixtureBaseUrl(descriptor);
  const pem = await readFile(descriptor.keyPath, 'utf8');
  const key = createPrivateKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: 'onlinefixture-key-1', typ: 'JWT' });
  const claims = encode({
    iss: descriptor.issuer,
    sub: accountId,
    sid: `sess_${accountId}`,
    azp: 'https://online.fixture.local',
    iat: now,
    exp: now + lifetimeSeconds,
    token_use: 'session',
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

/**
 * Returns the bearer token for a fixture account, minting a fresh one when
 * the descriptor does not carry a usable token.
 * @param {FixtureDescriptor} descriptor
 * @param {string} accountId
 * @returns {Promise<string>}
 */
export async function tokenFor(descriptor, accountId) {
  const existing = descriptor.accounts.find((account) => account.id === accountId);
  if (existing && typeof existing.token === 'string' && existing.token.length > 0) {
    const payload = decodeSegment(existing.token.split('.')[1] ?? '');
    if (payload && typeof payload.exp === 'number' && payload.exp * 1000 > Date.now() + 60_000) {
      return existing.token;
    }
  }
  return mintToken(descriptor, accountId);
}

/**
 * @param {string} segment
 * @returns {Record<string, unknown>|null}
 */
function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Performs one API request against the fixture.
 * @param {FixtureDescriptor} descriptor
 * @param {string} path
 * @param {{method?: string, token?: string|null, body?: unknown, headers?: Record<string,string>, origin?: string}} [options]
 * @returns {Promise<{status: number, body: string, json: any}>}
 */
export async function apiRequest(descriptor, path, options = {}) {
  const baseUrl = requireFixtureBaseUrl(descriptor);
  const headers = { Accept: 'application/json', ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.origin) headers.Origin = options.origin;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.text();
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  return { status: response.status, body, json };}

/**
 * Reads a container's PostgreSQL password from the local Docker fixture without
 * printing it. The value stays in memory and is only used to build a local
 * connection URL.
 * @param {{container?: string, host?: string, port?: number, database?: string, user?: string}} [options]
 * @returns {Promise<string>} the connection URL
 */
export async function discoverLocalDatabaseUrl(options = {}) {
  const container = options.container ?? 'kamkmchess-kha67-local';
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 55467;
  const database = options.database ?? 'kamkmchess_online_test';
  const user = options.user ?? 'postgres';
  const { stdout } = await run('docker', [
    'inspect',
    '--format',
    '{{range .Config.Env}}{{println .}}{{end}}',
    container,
  ], { windowsHide: true });
  const passwordLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('POSTGRES_PASSWORD='));
  if (!passwordLine) {
    throw new Error(`local fixture container ${container} has no POSTGRES_PASSWORD entry`);
  }
  const password = passwordLine.slice('POSTGRES_PASSWORD='.length);
  const url = new URL('postgres://127.0.0.1');
  url.username = user;
  url.password = password;
  url.hostname = host;
  url.port = String(port);
  url.pathname = `/${database}`;
  url.searchParams.set('sslmode', 'disable');
  return url.toString();
}

/**
 * Returns the database URL for the fixture, preferring an explicit value.
 * @param {{env?: NodeJS.ProcessEnv, allowDockerDiscovery?: boolean}} [options]
 * @returns {Promise<string>}
 */
export async function resolveDatabaseUrl(options = {}) {
  const env = options.env ?? process.env;
  const explicit = env[FIXTURE_DATABASE_ENV] ?? env.KHA_ONLINE_TEST_DATABASE_URL ?? env.KHA41_TEST_DATABASE_URL;
  if (explicit) return explicit;
  if (options.allowDockerDiscovery === false) {
    throw new Error('no fixture database URL is configured');
  }
  return discoverLocalDatabaseUrl();
}

/**
 * Redacts a database URL so it can be printed in a report.
 * @param {string} databaseUrl
 * @returns {string}
 */
export function redactDatabaseUrl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = 'redacted';
    return url.toString();
  } catch {
    return 'redacted';
  }
}
