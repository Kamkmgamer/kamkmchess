/**
 * The synthetic account session of a local fixture run.
 *
 * This module is a test seam, not a product feature. It exists so a browser
 * can be *signed in* against the local online fixture, whose accounts are
 * synthetic identities signed by the fixture's own key and verified by the
 * fixture's own JWKS document.
 *
 * The rules it keeps:
 *
 * - It is only reachable in a build that was explicitly flagged for it. The
 *   ordinary release build never contains the branch that loads it, and the
 *   build refuses to enable the flag without an explicit fixture purpose.
 * - No credential is compiled in. The identity and its session token are read
 *   at run time from the page, where the test harness puts them. The token is
 *   a real signed session token of the fixture, so the service verifies it
 *   with its ordinary code path. Nothing here bypasses an API check.
 * - The session refuses to act for a service that is not on loopback, so the
 *   seam can never weaken the authorization of a hosted service.
 */
import type { AccountCredentialStore, AccountIdentity, AccountSession, IdentityFence } from './clerk.js';

/** The identity the harness put into the page. */
export interface TestSessionIdentity {
  readonly accountId: string;
  readonly token: string;
}

/** The global the harness fills at run time. */
export interface TestSessionWindow extends Window {
  __KAMKM_TEST_SESSION__?: TestSessionIdentity | null;
}

/** The event the harness dispatches to change the signed-in account. */
export const TEST_SESSION_EVENT = 'kamkm:test-session';

export interface TestAccountSessionOptions {
  /** The credential store of the browser. */
  readonly credentials: AccountCredentialStore;
  /** The fence of the signed-in identity. */
  readonly fence: IdentityFence;
  /** The service origin the session may act for. */
  readonly apiBaseUrl: string | null;
  /** The page the harness controls. */
  readonly target?: TestSessionWindow;
}

/**
 * True when the service origin is a loopback origin.
 *
 * The seam is only ever used against the local fixture, so it fails closed
 * for every other origin.
 */
export function isLoopbackOrigin(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function readIdentity(source: TestSessionWindow | undefined): AccountIdentity | null {
  const raw = source?.__KAMKM_TEST_SESSION__;
  if (!raw || typeof raw.accountId !== 'string' || raw.accountId.length === 0) return null;
  if (typeof raw.token !== 'string' || raw.token.length === 0) return null;
  return {
    accountId: raw.accountId,
    async token() { return raw.token; },
  };
}

/**
 * Creates the account session of a fixture run.
 *
 * The session has the same contract as the Clerk session: it publishes the
 * current identity, it fences the pending work when the identity changes and
 * it clears the credentials of the account that leaves.
 */
export function createTestAccountSession(options: TestAccountSessionOptions): AccountSession {
  const target = options.target ?? (typeof window === 'undefined' ? undefined : window as TestSessionWindow);
  const listeners = new Set<(identity: AccountIdentity | null) => void>();
  let current: AccountIdentity | null = null;
  let disposed = false;

  if (!isLoopbackOrigin(options.apiBaseUrl)) {
    // The seam never acts for a hosted service. A build that points at one
    // keeps the ordinary signed-out behaviour.
    return {
      enabled: false,
      identity: null,
      client: null,
      async signInWithGoogle() { throw new Error('Accounts are not configured; guest play remains available.'); },
      async signOut() {},
      subscribe(listener) { listener(null); return () => {}; },
      dispose() {},
    };
  }

  current = readIdentity(target);

  /**
   * The order of the identity changes.
   *
   * The changes are serialized and every change carries its own number. A
   * change that is overtaken while it waits for the fence settles without
   * publishing, so a slow change can never publish a stale identity after a
   * newer one.
   */
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();

  function publish(identity: AccountIdentity | null): void {
    for (const listener of [...listeners]) {
      try { listener(identity); } catch { /* one listener must not block the rest */ }
    }
  }

  async function applyChange(next: AccountIdentity | null, mine: number): Promise<void> {
    if (disposed) return;
    const departing = current;
    current = null;
    // The change fences the pending work of the departing identity before the
    // new identity is published, exactly like the hosted session does.
    await options.fence.fencePendingRequests();
    // The credentials of the account that leaves are cleared even when the
    // change was overtaken while it waited: the next change sees no departing
    // identity any more, so the cleanup has to happen here.
    if (departing && departing.accountId !== next?.accountId) {
      try {
        await options.credentials.clearCredentialsForNamespace({ kind: 'account', accountId: departing.accountId });
      } catch { /* the identity change itself is not blocked by the cleanup */ }
    }
    // An overtaken change publishes nothing, so the browser never sees an
    // identity that is already gone.
    if (disposed || mine !== generation) return;
    options.fence.clearInMemoryIdentity();
    options.fence.hidePrivateViews();
    publish(null);
    if (disposed || mine !== generation) return;
    current = next;
    publish(next);
  }

  function change(next: AccountIdentity | null): Promise<void> {
    generation += 1;
    const mine = generation;
    queue = queue
      .then(() => applyChange(next, mine))
      .catch(() => undefined);
    return queue;
  }

  const onSwitch = (event: Event) => {
    const detail = (event as CustomEvent<Partial<TestSessionIdentity> | null>).detail;
    const next = detail && typeof detail.accountId === 'string' && typeof detail.token === 'string'
      ? { accountId: detail.accountId, token: detail.token }
      : null;
    void change(next ? { accountId: next.accountId, async token() { return next.token; } } : null);
  };
  target?.addEventListener(TEST_SESSION_EVENT, onSwitch as EventListener);

  return {
    enabled: true,
    client: null,
    get identity() { return current; },
    subscribe(listener) {
      if (disposed) { listener(null); return () => {}; }
      listeners.add(listener);
      listener(current);
      return () => { listeners.delete(listener); };
    },
    async signInWithGoogle() {
      throw new Error('This build signs in with the local fixture account.');
    },
    async signOut() {
      await change(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      target?.removeEventListener(TEST_SESSION_EVENT, onSwitch as EventListener);
      current = null;
      publish(null);
      listeners.clear();
    },
  };
}
