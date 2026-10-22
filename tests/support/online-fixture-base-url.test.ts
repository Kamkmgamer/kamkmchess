/**
 * One rule for the address of the local online fixture.
 *
 * The base URL of the descriptor is the address the credential of the fixture
 * travels to: the browser and the Node tooling mint a signed session token and
 * send it to that address. The address is therefore checked by parsing it,
 * never by comparing a prefix of its text, because a prefix accepts
 * `http://127.0.0.1:18099@attacker.example`, which starts with the loopback
 * address and sends the token to another host.
 *
 * Two readers of the descriptor exist: the Node tooling of the fixture and the
 * browser suites. They share one definition of the accepted shape, the module
 * `scripts/shared/fixture-base-url.mjs`, and this suite proves that the rule
 * and the browser-side reader agree on every address of a corpus of
 * lookalikes. A change to the rule, or a reader that stops applying it,
 * fails here instead of leaving one of them sending a fixture token off the
 * host of the fixture. The Node tooling applies the same module, and its own
 * suite (`scripts/online/fixture-client.test.mjs`) proves that it refuses a
 * descriptor that names another host before a token is minted or a request is
 * sent.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeFixtureBaseUrlProblem } from '../../scripts/shared/fixture-base-url.mjs';
import { resolveOnlineFixtureDescriptor } from './online-fixture-descriptor';

/** A descriptor of a fixture, as the fixture writes it. */
const DESCRIPTOR = {
  baseUrl: 'http://127.0.0.1:18099',
  issuer: 'http://127.0.0.1:18098',
  allowedOrigins: ['http://127.0.0.1:5175'],
  accounts: [{ id: 'fixture-owner-a', token: 'synthetic-token' }],
  keyPath: 'C:/fixture/keys/signing-key.pem',
};

/** The base URLs the fixture itself writes. */
const FIXTURE_BASE_URLS = ['http://127.0.0.1:18099', 'http://127.0.0.1:5175/'];

/**
 * The base URLs that only look like the address of the fixture.
 *
 * Every one of them would send a minted token to another host or along
 * another route than the fixture serves.
 */
const HOSTILE_BASE_URLS = [
  'http://127.0.0.1:18099@attacker.example',
  'http://127.0.0.1.attacker.example:18099',
  'http://localhost:18099',
  'http://127.0.0.2:18099',
  'http://[::1]:18099',
  'http://user:password@127.0.0.1:18099',
  'http://127.0.0.1:18099/attacker',
  'http://127.0.0.1:18099?token=leak',
  'http://127.0.0.1:18099#attacker',
  'https://127.0.0.1:18099',
  'file:///etc/passwd',
  'http://127.0.0.1:0',
  'http://127.0.0.1:18099 ',
  'http://127.0.0.1:18099\t',
  'http://127.0.0.1:18\u0000099',
  'not-a-url',
  '',
];

/**
 * Writes a descriptor with a base URL into a throwaway file.
 * @param {unknown} baseUrl
 * @returns {Promise<string>} the path of the descriptor
 */
async function withDescriptor(baseUrl: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kamkm-online-fixture-base-url-'));
  const path = join(directory, 'descriptor.json');
  await writeFile(path, JSON.stringify({ ...DESCRIPTOR, baseUrl }), 'utf8');
  return path;
}

/**
 * Whether the browser side accepts a base URL.
 * @param {unknown} baseUrl
 * @returns {Promise<boolean>}
 */
async function browserAccepts(baseUrl: unknown): Promise<boolean> {
  const path = await withDescriptor(baseUrl);
  try {
    const state = await resolveOnlineFixtureDescriptor({ path, env: {} });
    return state.kind === 'present';
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
}

describe('the address of the online fixture', () => {
  it('accepts the base URL the Go fixture writes', async () => {
    for (const baseUrl of FIXTURE_BASE_URLS) {
      expect(describeFixtureBaseUrlProblem(baseUrl)).toBeNull();
      expect(await browserAccepts(baseUrl)).toBe(true);
    }
  });

  it('refuses every base URL that only looks like the address of the fixture', async () => {
    for (const baseUrl of HOSTILE_BASE_URLS) {
      expect(describeFixtureBaseUrlProblem(baseUrl)).not.toBeNull();
      expect(await browserAccepts(baseUrl)).toBe(false);
    }
  });

  it('refuses the lookalike that carries the loopback address as user info', async () => {
    const reason = describeFixtureBaseUrlProblem('http://127.0.0.1:18099@attacker.example');
    expect(reason ?? '').toContain('user name');
    expect(await browserAccepts('http://127.0.0.1:18099@attacker.example')).toBe(false);
  });

  it('accepts a notation of the loopback address that the URL parser normalizes', async () => {
    // `2130706433` is the decimal form of 127.0.0.1 and the trailing dot is
    // the root label of the host. The URL parser reads both as the loopback
    // host itself, so the credential still goes to the fixture and not to
    // another host.
    expect(describeFixtureBaseUrlProblem('http://2130706433:18099')).toBeNull();
    expect(await browserAccepts('http://2130706433:18099')).toBe(true);
    expect(describeFixtureBaseUrlProblem('http://127.0.0.1.:18099')).toBeNull();
    expect(await browserAccepts('http://127.0.0.1.:18099')).toBe(true);
  });

  it('refuses a base URL that is not a string or is empty', () => {
    expect(describeFixtureBaseUrlProblem(undefined) ?? '').toContain('not a string');
    expect(describeFixtureBaseUrlProblem(42) ?? '').toContain('not a string');
    expect(describeFixtureBaseUrlProblem('') ?? '').toContain('empty');
  });
});
