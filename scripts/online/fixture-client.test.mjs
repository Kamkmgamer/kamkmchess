// Offline tests for the descriptor reader of the online fixture.
//
// The base URL of the descriptor is the address the fixture credential
// travels to, so the reader has to refuse every base URL that is not the
// address of the fixture itself. These tests call the real reader and the
// real helpers of the tooling; no network request is made and no credential
// is minted for a descriptor that is refused.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { apiRequest, mintToken, readDescriptor, requireFixtureBaseUrl } from './fixture-client.mjs';

/** The base URL the Go fixture writes for a run. */
const FIXTURE_BASE_URL = 'http://127.0.0.1:18099';

/** A descriptor of a fixture, as the fixture writes it. */
const DESCRIPTOR = {
  baseUrl: FIXTURE_BASE_URL,
  issuer: 'http://127.0.0.1:18098',
  jwksUrl: 'http://127.0.0.1:18098/.well-known/jwks.json',
  allowedOrigins: ['http://127.0.0.1:5175'],
  accounts: [{ id: 'fixture-owner-a', token: 'synthetic-token' }],
  schema: 'kamkmchess_online_test',
  database: 'postgres://127.0.0.1/kamkmchess_online_test',
  rulesWorker: 'build/rules-worker/worker.mjs',
  keyPath: 'C:/fixture/keys/signing-key.pem',
  pid: 4242,
  startedAt: '2026-10-22T09:00:00Z',
  expiresAt: '2026-10-22T11:00:00Z',
};

/**
 * The base URLs that only look like the address of the fixture.
 *
 * Every one of them would send a minted token to another host or along
 * another route than the fixture serves.
 */
const HOSTILE_BASE_URLS = [
  // The reported vector: the text starts with the loopback address, and the
  // URL parser reads the host as `attacker.example`.
  'http://127.0.0.1:18099@attacker.example',
  // A host that starts with the loopback address.
  'http://127.0.0.1.attacker.example:18099',
  // A name that resolves to the loopback address instead of naming it.
  'http://localhost:18099',
  // Another address of the loopback range.
  'http://127.0.0.2:18099',
  // The loopback address in the notation of the IPv6 loopback.
  'http://[::1]:18099',
  // A user name and a password on the address of the fixture.
  'http://user:password@127.0.0.1:18099',
  // A route other than the root of the fixture.
  'http://127.0.0.1:18099/attacker',
  'http://127.0.0.1:18099?token=leak',
  'http://127.0.0.1:18099#attacker',
  // A scheme that is not the one of the fixture.
  'https://127.0.0.1:18099',
  'file:///etc/passwd',
  // A port that is not a port of the fixture.
  'http://127.0.0.1:0',
  // Whitespace and control characters, which the URL parser drops.
  'http://127.0.0.1:18099 ',
  'http://127.0.0.1:18099\t',
  'http://127.0.0.1:18\u0000099',
  // Not a URL at all.
  'not-a-url',
  '',
];

/** The number of requests the tests made. */
let requests = 0;

/** The real fetch, restored after the tests. */
let realFetch = globalThis.fetch;

before(() => {
  // The tests never reach a network service: a request would fail the test.
  globalThis.fetch = (...args) => {
    requests += 1;
    throw new Error(`the tests must not make a request: ${String(args[0])}`);
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

/**
 * Writes a descriptor with a base URL into a throwaway file.
 * @param {unknown} baseUrl
 * @param {object} [overrides]
 * @returns {Promise<string>} the path of the descriptor
 */
async function withDescriptor(baseUrl, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kamkm-online-fixture-client-'));
  const path = join(directory, 'descriptor.json');
  await writeFile(path, JSON.stringify({ ...DESCRIPTOR, baseUrl, ...overrides }), 'utf8');
  return path;
}

/**
 * The reason the reader refuses a descriptor, or null when it accepts it.
 * @param {unknown} baseUrl
 * @param {object} [overrides]
 * @returns {Promise<string|null>}
 */
async function reasonFor(baseUrl, overrides = {}) {
  const path = await withDescriptor(baseUrl, overrides);
  try {
    await readDescriptor(path);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
}

test('the reader accepts the base URL of the Go fixture', async () => {
  const path = await withDescriptor(FIXTURE_BASE_URL);
  try {
    const descriptor = await readDescriptor(path);
    assert.equal(descriptor.baseUrl, FIXTURE_BASE_URL);
    assert.equal(descriptor.accounts.length, 1);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('the reader accepts the base URL of the fixture with a root path', async () => {
  const reason = await reasonFor('http://127.0.0.1:5175/');
  assert.equal(reason, null);
});

test('the reader accepts a notation of the loopback address that the URL parser normalizes', async () => {
  // `2130706433` is the decimal form of 127.0.0.1 and the trailing dot is
  // the root label of the host. The URL parser reads both as the loopback host
  // itself, so the request still goes to the fixture and not to another host.
  assert.equal(await reasonFor('http://2130706433:18099'), null);
  assert.equal(await reasonFor('http://127.0.0.1.:18099'), null);
});

test('the reader refuses every base URL that is not the fixture itself', async () => {
  for (const baseUrl of HOSTILE_BASE_URLS) {
    const reason = await reasonFor(baseUrl);
    assert.notEqual(reason, null, `the reader accepted ${JSON.stringify(baseUrl)}`);
    assert.match(reason, /loopback base URL of the fixture/);
  }
});

test('the reader refuses a descriptor without a base URL', async () => {
  const reason = await reasonFor(undefined);
  assert.notEqual(reason, null);
  assert.match(reason, /loopback base URL of the fixture/);
});

test('the reader refuses a descriptor whose base URL is not a string', async () => {
  const reason = await reasonFor(42);
  assert.notEqual(reason, null);
  assert.match(reason, /loopback base URL of the fixture/);
});

test('the reader refuses a descriptor with no synthetic accounts', async () => {
  const reason = await reasonFor(FIXTURE_BASE_URL, { accounts: [] });
  assert.notEqual(reason, null);
  assert.match(reason, /no synthetic accounts/);
});

test('no token is minted for a descriptor that names another host', async () => {
  const hostile = {
    ...DESCRIPTOR,
    baseUrl: 'http://127.0.0.1:18099@attacker.example',
    keyPath: join(tmpdir(), 'kamkm-no-such-signing-key.pem'),
  };
  await assert.rejects(() => mintToken(hostile, 'fixture-owner-a'), /loopback base URL of the fixture/);
});

test('no request is sent to a descriptor that names another host', async () => {
  const hostile = { ...DESCRIPTOR, baseUrl: 'http://127.0.0.1:18099@attacker.example' };
  await assert.rejects(
    () => apiRequest(hostile, '/v1/online/features', { token: 'synthetic-token' }),
    /loopback base URL of the fixture/,
  );
  assert.equal(requests, 0);
});

test('the check of the base URL refuses the lookalike addresses', () => {
  assert.throws(
    () => requireFixtureBaseUrl({ ...DESCRIPTOR, baseUrl: 'http://127.0.0.1:18099@attacker.example' }),
    /loopback base URL of the fixture/,
  );
  assert.equal(requireFixtureBaseUrl({ ...DESCRIPTOR, baseUrl: FIXTURE_BASE_URL }), FIXTURE_BASE_URL);
});
