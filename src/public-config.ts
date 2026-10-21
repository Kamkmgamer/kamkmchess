declare const __KAMKM_PUBLIC_CONFIG__: unknown;

export interface PublicConfig {
  readonly accountsEnabled: boolean;
  readonly clerkPublishableKey: string | null;
  readonly apiBaseUrl: string | null;
  /**
   * True when the build carries the synthetic account session of a fixture run.
   *
   * The flag is only ever set by a build that was explicitly marked as a
   * fixture build. It carries no credential: the identity and its session
   * token are read at run time from the page.
   */
  readonly testSession: boolean;
}

/** This object contains only the build's deliberately public settings. */
export function readPublicConfig(value: unknown): PublicConfig {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const key = typeof input.clerkPublishableKey === 'string' && /^pk_(test|live)_[A-Za-z0-9_=-]+$/.test(input.clerkPublishableKey)
    ? input.clerkPublishableKey : null;
  let apiBaseUrl: string | null = null;
  let loopbackOrigin = false;
  if (typeof input.apiBaseUrl === 'string') {
    try {
      const url = new URL(input.apiBaseUrl);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol === 'https:' || url.protocol === 'http:' && loopback) && !url.username && !url.password && !url.search && !url.hash) {
        apiBaseUrl = url.origin;
        loopbackOrigin = url.protocol === 'http:' && loopback;
      }
    } catch { /* Invalid public configuration leaves accounts disabled. */ }
  }
  // The synthetic session of a fixture run needs no hosted identity provider,
  // so it opens the account surface with the service origin alone. It is
  // never enabled without the explicit build flag and never for a service
  // that is not the local fixture.
  const testSession = input.testSession === true && loopbackOrigin;
  const accountsEnabled = input.accountsEnabled === true && apiBaseUrl !== null &&
    (key !== null || testSession);
  return { accountsEnabled, clerkPublishableKey: key, apiBaseUrl, testSession };
}

export const publicConfig = readPublicConfig(typeof __KAMKM_PUBLIC_CONFIG__ === 'undefined' ? {} : __KAMKM_PUBLIC_CONFIG__);
