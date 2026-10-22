/**
 * The three modes of the descriptor of the online fixture.
 *
 * The fixture-dependent browser cases need the real service, and the run has
 * to say honestly what it did:
 *
 *   - no descriptor at all: the cases skip, and the run proves no online
 *     fixture coverage;
 *   - no descriptor in a strict run: the run fails;
 *   - a descriptor the caller supplied that cannot be used: the run fails,
 *     in a strict run and in a lenient one.
 *
 * The seam is the one the browser suites use, so the modes are proved once
 * for all of them.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openOnlineFixtureGate,
  onlineFixtureDescriptorPath,
  onlineFixtureIsStrict,
  resolveOnlineFixtureDescriptor,
} from './online-fixture-descriptor';

/** The reason the fixture-dependent cases of the browser suites give. */
const REASON = 'the rendered online cases need the real service';

/** A descriptor of a fixture, as the fixture writes it. */
const DESCRIPTOR = {
  baseUrl: 'http://127.0.0.1:18099',
  issuer: 'https://127.0.0.1:18098',
  allowedOrigins: ['http://127.0.0.1:5175'],
  accounts: [{ id: 'fixture-owner-a', token: 'synthetic-token' }],
  keyPath: 'C:/fixture/keys/signing-key.pem',
};

async function withDescriptorFile<T>(body: string | object, run: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'kamkm-online-fixture-'));
  try {
    const path = join(directory, 'descriptor.json');
    await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('the descriptor of the online fixture', () => {
  it('reads the path and the strictness of the environment', () => {
    expect(onlineFixtureDescriptorPath({ ONLINE_FIXTURE_DESCRIPTOR: ' C:/fixture/descriptor.json ' })).toBe('C:/fixture/descriptor.json');
    expect(onlineFixtureDescriptorPath({})).toBe('');
    expect(onlineFixtureIsStrict({ ONLINE_FIXTURE_STRICT: '1' })).toBe(true);
    expect(onlineFixtureIsStrict({ ONLINE_FIXTURE_STRICT: '0' })).toBe(false);
    expect(onlineFixtureIsStrict({})).toBe(false);
  });

  it('is absent when the run names no descriptor', async () => {
    const state = await resolveOnlineFixtureDescriptor({ path: '', env: {} });
    expect(state.kind).toBe('absent');
  });

  it('is present when the descriptor of the fixture can be read', async () => {
    await withDescriptorFile(DESCRIPTOR, async path => {
      const state = await resolveOnlineFixtureDescriptor({ path, env: {} });
      expect(state.kind).toBe('present');
      if (state.kind !== 'present') return;
      expect(state.descriptor.baseUrl).toBe(DESCRIPTOR.baseUrl);
      expect(state.descriptor.issuer).toBe(DESCRIPTOR.issuer);
      expect(state.descriptor.allowedOrigins).toEqual(DESCRIPTOR.allowedOrigins);
      expect(state.descriptor.accounts).toHaveLength(1);
      expect(state.descriptor.keyPath).toBe(DESCRIPTOR.keyPath);
    });
  });

  it('is invalid when the descriptor of the caller cannot be read', async () => {
    const state = await resolveOnlineFixtureDescriptor({ path: join(tmpdir(), 'kamkm-missing-descriptor.json'), env: {} });
    expect(state.kind).toBe('invalid');
    if (state.kind !== 'invalid') return;
    expect(state.reason).toContain('could not be read');
  });

  it('is invalid when the descriptor of the caller is not JSON', async () => {
    await withDescriptorFile('{ not json', async path => {
      const state = await resolveOnlineFixtureDescriptor({ path, env: {} });
      expect(state.kind).toBe('invalid');
      if (state.kind !== 'invalid') return;
      expect(state.reason).toContain('not valid JSON');
    });
  });

  it('is invalid when the descriptor of the caller has another shape', async () => {
    await withDescriptorFile({ baseUrl: 'https://online.example.com' }, async path => {
      const state = await resolveOnlineFixtureDescriptor({ path, env: {} });
      expect(state.kind).toBe('invalid');
      if (state.kind !== 'invalid') return;
      expect(state.reason).toContain('loopback base URL');
    });
    await withDescriptorFile({ ...DESCRIPTOR, accounts: [] }, async path => {
      const state = await resolveOnlineFixtureDescriptor({ path, env: {} });
      expect(state.kind).toBe('invalid');
      if (state.kind !== 'invalid') return;
      expect(state.reason).toContain('no accounts');
    });
  });
});

/**
 * The base URL of the descriptor is where the credential of the fixture goes:
 * the browser mints a signed session token and sends it to that address. A
 * base URL that only looks like the loopback address would send the
 * credential off the host of the fixture, so the descriptor is parsed and the
 * parse has to name the loopback origin of the fixture.
 */
describe('the base URL of the descriptor', () => {
  /** The reason a descriptor with this base URL is refused. */
  async function reasonFor(baseUrl: unknown): Promise<string> {
    let reason = '';
    await withDescriptorFile({ ...DESCRIPTOR, baseUrl }, async path => {
      const state = await resolveOnlineFixtureDescriptor({ path, env: {} });
      expect(state.kind).toBe('invalid');
      if (state.kind !== 'invalid') return;
      reason = state.reason;
    });
    return reason;
  }

  it('accepts the loopback base URL of the fixture', async () => {
    await withDescriptorFile({ ...DESCRIPTOR, baseUrl: 'http://127.0.0.1:18099' }, async path => {
      const state = await resolveOnlineFixtureDescriptor({ path, env: {} });
      expect(state.kind).toBe('present');
      if (state.kind !== 'present') return;
      expect(state.descriptor.baseUrl).toBe('http://127.0.0.1:18099');
    });
    await withDescriptorFile({ ...DESCRIPTOR, baseUrl: 'http://127.0.0.1:5175/' }, async path => {
      const state = await resolveOnlineFixtureDescriptor({ path, env: {} });
      expect(state.kind).toBe('present');
      if (state.kind !== 'present') return;
      expect(state.descriptor.baseUrl).toBe('http://127.0.0.1:5175/');
    });
  });

  it('refuses a host that only starts with the loopback address', async () => {
    const reason = await reasonFor('http://127.0.0.1.attacker.example:18099');
    expect(reason).toContain('loopback base URL');
    expect(reason).toContain('127.0.0.1.attacker.example');
  });

  it('refuses a scheme that is not http', async () => {
    expect(await reasonFor('https://127.0.0.1:18099')).toContain('not http');
    expect(await reasonFor('file:///etc/passwd')).toContain('not http');
  });

  it('refuses a base URL that carries a user name or a password', async () => {
    expect(await reasonFor('http://user:password@127.0.0.1:18099')).toContain('user name');
    expect(await reasonFor('http://127.0.0.1:18099@attacker.example')).toContain('user name');
  });

  it('refuses a base URL that is not a URL', async () => {
    expect(await reasonFor('not-a-url')).toContain('not a URL');
    expect(await reasonFor('')).toContain('empty');
    expect(await reasonFor(42)).toContain('not a string');
    expect(await reasonFor('http://127.0.0.1:18099 ')).toContain('whitespace');
  });

  it('refuses a base URL that names another route', async () => {
    expect(await reasonFor('http://127.0.0.1:18099/attacker')).toContain('path');
    expect(await reasonFor('http://127.0.0.1:18099?token=leak')).toContain('query');
    expect(await reasonFor('http://127.0.0.1:18099#attacker')).toContain('fragment');
  });

  it('refuses a host that is not the loopback host of the fixture', async () => {
    expect(await reasonFor('http://localhost:18099')).toContain('localhost');
    expect(await reasonFor('http://127.0.0.2:18099')).toContain('127.0.0.2');
  });

  it('fails the run when the base URL of the descriptor is a lookalike', async () => {
    await withDescriptorFile({ ...DESCRIPTOR, baseUrl: 'http://127.0.0.1.attacker.example:18099' }, async path => {
      const gate = await openOnlineFixtureGate({ reason: REASON, path, env: {} });
      expect(gate.action).toBe('fail');
      expect(gate.coverage).toBe('not_covered');
      expect(gate.descriptor).toBeNull();
      expect(gate.message).toContain('loopback base URL');
    });
  });
});

describe('the gate of the fixture-dependent cases', () => {
  it('skips a lenient run without a descriptor and covers nothing', async () => {
    const gate = await openOnlineFixtureGate({ reason: REASON, path: '', env: {} });
    expect(gate.action).toBe('skip');
    expect(gate.coverage).toBe('not_covered');
    expect(gate.descriptor).toBeNull();
    expect(gate.message).toContain('no online fixture descriptor');
    expect(gate.message).toContain('no online fixture coverage');
  });

  it('fails a strict run without a descriptor', async () => {
    const gate = await openOnlineFixtureGate({
      reason: REASON,
      path: '',
      env: { ONLINE_FIXTURE_STRICT: '1' },
    });
    expect(gate.action).toBe('fail');
    expect(gate.coverage).toBe('not_covered');
    expect(gate.message).toContain('ONLINE_FIXTURE_STRICT=1');
  });

  it('fails a lenient run with a descriptor that cannot be used', async () => {
    await withDescriptorFile('{ not json', async path => {
      const gate = await openOnlineFixtureGate({ reason: REASON, path, env: {} });
      expect(gate.action).toBe('fail');
      expect(gate.coverage).toBe('not_covered');
      expect(gate.message).toContain('not valid JSON');
    });
  });

  it('fails a strict run with a descriptor that cannot be used', async () => {
    await withDescriptorFile('{ not json', async path => {
      const gate = await openOnlineFixtureGate({
        reason: REASON,
        path,
        env: { ONLINE_FIXTURE_STRICT: '1' },
      });
      expect(gate.action).toBe('fail');
      expect(gate.message).toContain('not valid JSON');
    });
  });

  it('runs the cases with a usable descriptor', async () => {
    await withDescriptorFile(DESCRIPTOR, async path => {
      const gate = await openOnlineFixtureGate({
        reason: REASON,
        path,
        env: { ONLINE_FIXTURE_STRICT: '1' },
      });
      expect(gate.action).toBe('run');
      expect(gate.coverage).toBe('covered');
      expect(gate.descriptor?.baseUrl).toBe(DESCRIPTOR.baseUrl);
    });
  });
});
