import { officialClerkSdk } from './clerk';
import type { ClerkBrowserPort, ClerkSdkLoader } from './clerk';

export interface AccountControlsState {
  readonly status: 'disabled' | 'loading' | 'ready' | 'error';
  readonly user: { readonly name: string; readonly email: string | null; readonly imageUrl: string | null } | null;
  readonly busy: boolean;
  readonly message: string;
}

/** Shared by the desktop rail and mobile drawer, without loading the game workspace. */
export function createAccountControls(publishableKey: string | null, options: {
  sdk?: ClerkSdkLoader;
  currentUrl?: () => string;
} = {}) {
  let state: AccountControlsState = { status: publishableKey ? 'loading' : 'disabled', user: null, busy: false, message: '' };
  let client: ClerkBrowserPort | null = null;
  let loading: Promise<ClerkBrowserPort | null> | null = null;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  const listeners = new Set<() => void>();

  function publish(next: AccountControlsState) {
    state = next;
    for (const listener of listeners) listener();
  }

  function refresh() {
    const user = client?.session ? client.user : null;
    const email = user?.primaryEmailAddress?.emailAddress ?? null;
    publish({ ...state, status: 'ready', user: user ? {
      name: user.fullName || user.username || email || 'Chess player',
      email,
      imageUrl: user.imageUrl || null,
    } : null, message: '' });
  }

  function connect(): Promise<ClerkBrowserPort | null> {
    if (!publishableKey) return Promise.resolve(null);
    if (client) return Promise.resolve(client);
    if (loading) return loading;
    const current = generation;
    publish({ ...state, status: 'loading', message: '' });
    loading = (options.sdk ?? officialClerkSdk).load(publishableKey).then(loaded => {
      if (generation !== current) return null;
      client = loaded;
      unsubscribe = loaded.subscribe(() => { if (generation === current) refresh(); });
      refresh();
      return loaded;
    }).catch(() => {
      if (generation === current) publish({ ...state, status: 'error', message: "Couldn't load your account. Try again." });
      return null;
    }).finally(() => { if (generation === current) loading = null; });
    return loading;
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1 && publishableKey) void connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        generation += 1;
        unsubscribe?.();
        unsubscribe = undefined;
        client = null;
        loading = null;
      };
    },
    async openSettings() {
      if (!publishableKey || state.busy) return;
      const current = generation;
      publish({ ...state, busy: true, message: '' });
      try {
        const active = await connect();
        if (!active || current !== generation) return;
        if (active.user && active.session) {
          if (!active.openUserProfile) throw new Error('Account settings are unavailable.');
          active.openUserProfile();
        } else {
          await active.signInWithGoogle(options.currentUrl?.() ?? window.location.href);
        }
      } catch {
        if (current === generation) publish({ ...state, message: "Couldn't open account settings. Try again." });
      } finally {
        if (current === generation) publish({ ...state, busy: false });
      }
    },
  };
}
