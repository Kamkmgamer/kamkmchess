declare const __KAMKM_PUBLIC_CONFIG__: unknown;

export interface PublicConfig {
  readonly accountsEnabled: boolean;
  readonly clerkPublishableKey: string | null;
  readonly apiBaseUrl: string | null;
}

/** This object contains only the build's three deliberately public settings. */
export function readPublicConfig(value: unknown): PublicConfig {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const key = typeof input.clerkPublishableKey === 'string' && /^pk_(test|live)_[A-Za-z0-9_=-]+$/.test(input.clerkPublishableKey)
    ? input.clerkPublishableKey : null;
  let apiBaseUrl: string | null = null;
  if (typeof input.apiBaseUrl === 'string') {
    try {
      const url = new URL(input.apiBaseUrl);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol === 'https:' || url.protocol === 'http:' && loopback) && !url.username && !url.password && !url.search && !url.hash) {
        apiBaseUrl = url.origin;
      }
    } catch { /* Invalid public configuration leaves accounts disabled. */ }
  }
  return { accountsEnabled: input.accountsEnabled === true && key !== null && apiBaseUrl !== null, clerkPublishableKey: key, apiBaseUrl };
}

export const publicConfig = readPublicConfig(typeof __KAMKM_PUBLIC_CONFIG__ === 'undefined' ? {} : __KAMKM_PUBLIC_CONFIG__);
