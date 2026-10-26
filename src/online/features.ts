/**
 * Online feature enablement (KHA-74, KHA-77).
 *
 * Online play is never enabled by the presence of a service origin. A
 * production account build already configures an API origin, so the origin
 * alone says nothing about the rollout.
 *
 * Two independent switches exist:
 *
 * - **friend play** (invitations, rematches), and
 * - **queue play** (public matchmaking and the Stockfish fallback).
 *
 * Both default to false. The service owns the rollout and answers which
 * surfaces are open. A test build can opt in locally, but only against a
 * loopback service origin, so a test opt-in can never reach a deployed
 * service by accident.
 *
 * Nothing here sends a request. The workspace asks the service once and
 * keeps the answer for the page lifetime.
 */
import { publicConfig } from '../public-config.js';
import type { PublicConfig } from '../public-config.js';

/** The two online surfaces and their rollout state. */
export interface OnlineFeatureFlags {
  /** Friend invitations, link joins and rematches. */
  readonly friends: boolean;
  /** The public queue, the readiness flow and the Stockfish fallback. */
  readonly queue: boolean;
}

/** Both surfaces are closed by default. */
export const ONLINE_FEATURES_DISABLED: OnlineFeatureFlags = { friends: false, queue: false };

/**
 * How the feature answer of the service was last obtained.
 *
 * The flags alone cannot tell a closed surface from an unreachable one: both
 * leave every surface closed. The status records which of the two the browser
 * is looking at, so the interface can say what happened instead of disabling
 * its buttons without a word.
 */
export type OnlineFeaturesStatus = 'unknown' | 'answered' | 'unreachable';

/** The status before the first answer. */
export const ONLINE_FEATURES_STATUS_UNKNOWN: OnlineFeaturesStatus = 'unknown';

/** The route the service answers with the open surfaces. */
export const ONLINE_FEATURES_PATH = '/v1/online/features';

/**
 * True when the origin is a loopback address.
 *
 * Only a loopback service origin accepts a local test opt-in.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * The local opt-in of a test build.
 *
 * The opt-in is read from the `online` query parameter of the current page.
 * It is honored only against a loopback service origin, so a deployed build
 * ignores it even when a visitor adds it to the URL.
 */
export function readLocalOptIn(search: string, config: PublicConfig = publicConfig): OnlineFeatureFlags {
  const origin = config.apiBaseUrl;
  if (origin === null || !isLoopbackOrigin(origin)) return ONLINE_FEATURES_DISABLED;
  const requested = new URLSearchParams(search).get('online');
  if (requested === null) return ONLINE_FEATURES_DISABLED;
  const value = requested.toLowerCase();
  if (value === '1' || value === 'true' || value === 'all') {
    return { friends: true, queue: true };
  }
  const parts = value.split(',').map(part => part.trim());
  return {
    friends: parts.includes('friends') || parts.includes('friend'),
    queue: parts.includes('queue'),
  };
}

/**
 * Parses the service answer.
 *
 * The answer carries the two independent booleans. A missing field or a
 * non-boolean value closes the surface it belongs to, and an unknown field is
 * ignored, so an additive change on the service never closes the product.
 */
export function parseOnlineFeatureFlags(value: unknown): OnlineFeatureFlags {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ONLINE_FEATURES_DISABLED;
  const record = value as Record<string, unknown>;
  return {
    friends: record.friends === true,
    queue: record.queue === true,
  };
}

/**
 * Combines the service answer with the local test opt-in.
 *
 * The local opt-in can only open a surface the service already allows, or a
 * surface on a loopback service origin. A closed service answer stays closed
 * for a deployed origin.
 */
export function combineOnlineFeatureFlags(
  service: OnlineFeatureFlags,
  local: OnlineFeatureFlags,
  config: PublicConfig = publicConfig,
): OnlineFeatureFlags {
  const origin = config.apiBaseUrl;
  if (origin !== null && isLoopbackOrigin(origin)) {
    return {
      friends: service.friends || local.friends,
      queue: service.queue || local.queue,
    };
  }
  return { friends: service.friends, queue: service.queue };
}

/** True when a surface is open. */
export function onlineFeatureEnabled(flags: OnlineFeatureFlags, surface: keyof OnlineFeatureFlags): boolean {
  return flags[surface];
}
