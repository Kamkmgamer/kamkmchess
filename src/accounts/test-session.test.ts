import { describe, expect, it } from 'vitest';
import { createTestAccountSession, isLoopbackOrigin } from './test-session';
import type { TestSessionWindow } from './test-session';
import type { AccountCredentialStore, IdentityFence } from './clerk';

class FakeWindow extends EventTarget {
  __KAMKM_TEST_SESSION__: { accountId: string; token: string } | null = null;
}

function identity(accountId: string) {
  return { accountId, token: `token-${accountId}` };
}

function fence(release: () => void = () => undefined): IdentityFence & { released: () => Promise<void>; entered: () => Promise<void> } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { open = resolve; });
  let enter: () => void = () => undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return {
    async fencePendingRequests() { enter(); await gate; },
    clearInMemoryIdentity() {},
    hidePrivateViews() {},
    entered: () => entered,
    released: () => { release(); open(); return gate; },
  };
}

function credentials(): AccountCredentialStore & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    async clearCredentialsForNamespace(namespace) { cleared.push(namespace.accountId); },
  };
}

describe('the synthetic account session of a fixture run', () => {
  it('refuses to act for a service that is not the loopback fixture', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:57170')).toBe(true);
    expect(isLoopbackOrigin('https://api.example.test')).toBe(false);
    expect(isLoopbackOrigin(null)).toBe(false);
    const target = new FakeWindow();
    target.__KAMKM_TEST_SESSION__ = identity('fixture-owner-a');
    const session = createTestAccountSession({
      credentials: credentials(),
      fence: fence(),
      apiBaseUrl: 'https://api.example.test',
      target: target as unknown as TestSessionWindow,
    });
    expect(session.enabled).toBe(false);
    expect(session.identity).toBeNull();
  });

  it('publishes the identity of the page and never a credential of its own', async () => {
    const target = new FakeWindow();
    target.__KAMKM_TEST_SESSION__ = identity('fixture-owner-a');
    const session = createTestAccountSession({
      credentials: credentials(),
      fence: fence(),
      apiBaseUrl: 'http://127.0.0.1:57170',
      target: target as unknown as TestSessionWindow,
    });
    expect(session.identity?.accountId).toBe('fixture-owner-a');
    await expect(session.identity?.token()).resolves.toBe('token-fixture-owner-a');
  });

  it('never publishes a stale identity after a newer one', async () => {
    const target = new FakeWindow();
    target.__KAMKM_TEST_SESSION__ = identity('fixture-owner-a');
    const gate = fence();
    const cleared = credentials();
    const session = createTestAccountSession({
      credentials: cleared,
      fence: gate,
      apiBaseUrl: 'http://127.0.0.1:57170',
      target: target as unknown as TestSessionWindow,
    });
    const published: (string | null)[] = [];
    session.subscribe(identity => { published.push(identity?.accountId ?? null); });

    // The first change waits for the fence while the second one is already
    // on its way.
    target.dispatchEvent(new CustomEvent('kamkm:test-session', { detail: identity('fixture-owner-b') }));
    await gate.entered();
    target.dispatchEvent(new CustomEvent('kamkm:test-session', { detail: identity('fixture-owner-c') }));
    await gate.released();
    // The changes settle in their own turns.
    await new Promise(resolve => setTimeout(resolve, 20));

    // The overtaken change never publishes, so the browser never sees the
    // older account again after the newer one.
    expect(published).toEqual(['fixture-owner-a', null, 'fixture-owner-c']);
    expect(session.identity?.accountId).toBe('fixture-owner-c');
    // The credentials of the account that leaves are cleared exactly once,
    // even though the change that carried them away was overtaken.
    expect(cleared.cleared).toEqual(['fixture-owner-a']);
  });
});
