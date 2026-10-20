/**
 * Client for the public profile service (KHA-72).
 *
 * The client has two kinds of call, and they never mix:
 *
 * - a **public read**, which needs no credential at all. A signed-out visitor
 *   can read a public profile and look a public name up.
 * - an **account call**, which needs the verified session of the signed-in
 *   account. The account is never named in a request body: the service takes
 *   it from the credential it verified.
 *
 * The guest link is a deliberate two-step action. The browser first proves
 * that it controls a guest seat by minting an ownership proof from the seat
 * credential, and then it binds that proof to the account. Signing in never
 * performs either step on its own.
 *
 * Every credential travels in a request header only. It never enters a URL, a
 * query string, or a request body, and the destination is checked against the
 * trusted service origin before a credential is minted.
 */
import {
  PROFILE_AVATAR_CHOICES,
  createProfileUpdateBody,
  parseGuestLink,
  parseGuestOwnershipProof,
  parseOwnProfile,
  parsePublicProfile,
} from './contracts';
import type { GuestOwnershipProof, OwnProfile, ProfileGuestLink, ProfileUpdate, PublicProfile } from './contracts';

/** The seat a guest seat credential is bound to. */
export type ProfileSeat = 'white' | 'black';

/** A guest seat this browser controls. */
export interface GuestSeatBinding {
  readonly matchId: string;
  readonly seat: ProfileSeat;
}

export interface ProfileClientOptions {
  /** The trusted service origin. A credential is never sent outside it. */
  readonly baseUrl: string;
  /** The session token of the signed-in account. */
  readonly accountToken: () => Promise<string>;
  /** The private guest seat credential of the seat this browser controls. */
  readonly guestSeatToken?: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

export interface ProfileClient {
  /** Reads one public profile. It works without signing in. */
  readPublicProfile(profileId: string): Promise<PublicProfile>;
  /** Looks a public name up. It works without signing in. */
  readPublicProfileByUsername(username: string): Promise<PublicProfile>;
  /** Reads the signed-in account's own profile. */
  readOwnProfile(): Promise<OwnProfile>;
  /** Applies an ownership-checked change to the signed-in account's profile. */
  updateOwnProfile(update: ProfileUpdate): Promise<PublicProfile>;
  /** Mints a guest ownership proof from the guest seat credential. */
  mintOwnershipProof(): Promise<GuestOwnershipProof>;
  /** Binds a guest seat to the signed-in account with a fresh ownership proof. */
  linkGuestSeat(seat: GuestSeatBinding): Promise<ProfileGuestLink>;
}

/** The catalog of chosen avatars, for an interface that offers the choice. */
export const PROFILE_AVATARS = PROFILE_AVATAR_CHOICES;

export function createProfileClient(options: ProfileClientOptions): ProfileClient {
  const base = parseBaseUrl(options.baseUrl);
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(
    path: string,
    init: { method?: string; body?: unknown; credential?: { kind: 'account' | 'guest'; token: string }; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: unknown }> {
    const url = resolveUrl(base, path);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.credential) {
      // The credential header slot belongs to the boundary. A caller header
      // never overrides it.
      if (init.credential.kind === 'account') headers.Authorization = `Bearer ${init.credential.token}`;
      else headers['X-Guest-Seat-Token'] = init.credential.token;
    }
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      headers[name] = value;
    }
    const requestInit: RequestInit = {
      method: init.method ?? 'GET',
      headers,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestInit.body = JSON.stringify(init.body);
    }
    const response = await fetcher(url, requestInit);
    const text = await response.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        throw new ProfileRequestError('The profile service returned an invalid response.', response.status);
      }
    }
    return { status: response.status, data };
  }

  async function accountRequest(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: unknown }> {
    const token = await options.accountToken();
    if (typeof token !== 'string' || token.trim() === '') {
      throw new ProfileRequestError('Sign in before changing your profile.', 401);
    }
    return request(path, { ...init, credential: { kind: 'account', token } });
  }

  async function mintOwnershipProof(): Promise<GuestOwnershipProof> {
    if (!options.guestSeatToken) {
      throw new ProfileRequestError('No guest seat is open in this browser.', 400);
    }
    const token = await options.guestSeatToken();
    if (typeof token !== 'string' || token.trim() === '') {
      throw new ProfileRequestError('No guest seat is open in this browser.', 400);
    }
    const result = await request('/v1/guest-seats/ownership-proof', {
      method: 'POST',
      credential: { kind: 'guest', token },
    });
    if (result.status === 401) throw new ProfileRequestError('That guest seat is no longer yours.', 401);
    if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status);
    return parseGuestOwnershipProof(result.data);
  }

  return {
    async readPublicProfile(profileId) {
      const result = await request(`/v1/profiles/${encodeURIComponent(profileId)}`);
      if (result.status === 404) throw new ProfileRequestError('That profile does not exist.', 404);
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status);
      return parsePublicProfile(result.data);
    },
    async readPublicProfileByUsername(username) {
      const result = await request(`/v1/profiles/username/${encodeURIComponent(username.trim())}`);
      if (result.status === 404) throw new ProfileRequestError('No player uses that name.', 404);
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status);
      return parsePublicProfile(result.data);
    },
    async readOwnProfile() {
      const result = await accountRequest('/v1/account/profile');
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status);
      return parseOwnProfile(result.data);
    },
    async updateOwnProfile(update) {
      const result = await accountRequest('/v1/account/profile', { method: 'PUT', body: createProfileUpdateBody(update) });
      if (result.status === 409) throw new ProfileRequestError('That name is already taken.', 409);
      if (result.status === 400) throw new ProfileRequestError('That name or avatar is not allowed.', 400);
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status);
      return parsePublicProfile(result.data);
    },
    mintOwnershipProof,
    async linkGuestSeat(seat) {
      // The proof is minted from the seat credential first, so the link never
      // runs on a shareable invitation.
      const proof = await mintOwnershipProof();
      if (proof.matchId !== seat.matchId || proof.seat !== seat.seat) {
        throw new ProfileRequestError('That proof names another seat.', 409);
      }
      const result = await accountRequest('/v1/account/profile/guest-links', {
        method: 'POST',
        body: { matchId: seat.matchId, seat: seat.seat },
        headers: { 'X-Guest-Ownership-Proof': proof.secret },
      });
      if (result.status === 409) throw new ProfileRequestError('That guest seat is already linked.', 409);
      if (result.status === 401) throw new ProfileRequestError('That guest seat is no longer yours.', 401);
      if (result.status !== 200) throw new ProfileRequestError('The profile service is unavailable.', result.status);
      return parseGuestLink(result.data);
    },
  };
}

/** A failed profile request. */
export class ProfileRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProfileRequestError';
    this.status = status;
  }
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Parses the trusted service origin. */
function parseBaseUrl(value: string): URL {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('The profile service base URL is required.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The profile service base URL is invalid.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The profile service base URL is invalid.');
  }
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error('The profile service must use HTTPS outside loopback development.');
  }
  return url;
}

/**
 * Resolves a request destination against the trusted service origin.
 *
 * A foreign origin, a non-HTTP scheme, embedded user information, and a
 * credential-shaped query value are all refused here, before a credential is
 * minted.
 */
function resolveUrl(base: URL, path: string): URL {
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    throw new Error('The profile service request path is invalid.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('A profile service request must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('A profile service request must not carry credentials.');
  }
  if (url.origin !== base.origin) {
    throw new Error('A profile service request must stay on the trusted service origin.');
  }
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
      throw new Error(`A profile service request must not carry a "${key}" parameter.`);
    }
  }
  return url;
}

/** Query parameter names that must never carry a participant credential. */
const CREDENTIAL_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_secret',
  'credential',
  'credentials',
  'guest_token',
  'id_token',
  'jwt',
  'password',
  'refresh_token',
  'secret',
  'session_token',
  'token',
]);
