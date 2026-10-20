/**
 * The browser owned secrets of the friend surface (KHA-75).
 *
 * Two secrets never leave the browser and never reach the service in clear
 * form:
 *
 * - the **acceptance key** of an accept intent, which is the only capability
 *   that resumes a guest acceptance, and
 * - the **owner token** of an invitation this browser created, which is its
 *   recoverable ownership of the invitation and of the created match.
 *
 * The rules this module keeps:
 *
 * - The acceptance key is written **before** the acceptance is sent. A lost
 *   answer therefore replays the same key, and a reload finds the same key.
 *   The guest never needs the credential of a lost answer to recover.
 * - The key is namespaced by the identity, so two identities of one browser
 *   never share an accept intent.
 * - The owner token is kept for the invitations of this browser. The browser
 *   never accepts an invitation it created itself.
 * - Nothing here is ever sent to the service in another request. The secrets
 *   are used in the one request they belong to.
 */
import { createAcceptanceKey } from './friends';

/** The local store of the accept intents and of the owner tokens. */
export interface FriendSecretStore {
  /** The identity that owns the stored secrets. */
  readonly identity: string;
  /**
   * Changes the identity that owns the stored secrets.
   *
   * The records of the previous identity stay on the device. The new identity
   * never sees them.
   */
  setIdentity(identity: string): void;
  /**
   * The acceptance key of one invitation.
   *
   * The key is created once, stored, and returned again on every later call,
   * so the same accept intent always carries the same key.
   */
  acceptanceKey(invitationId: string): string;
  /** The stored key of an invitation, or null when there is none. */
  readAcceptanceKey(invitationId: string): string | null;
  /** Forgets the key of a consumed invitation. */
  forgetAcceptanceKey(invitationId: string): void;
  /** Stores the owner token of an invitation this browser created. */
  rememberOwnerToken(invitationId: string, ownerToken: string): void;
  /** The owner token of an invitation, or null. */
  readOwnerToken(invitationId: string): string | null;
  /** True when this browser created the invitation. */
  ownsInvitation(invitationId: string): boolean;
}

export interface FriendSecretStoreOptions {
  /** The local storage seam. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The identity that owns the secrets. */
  readonly identity?: string;
  /** The key prefix of the stored records. */
  readonly prefix?: string;
  /** The source of the random part of a key. */
  readonly random?: () => string;
}

const DEFAULT_PREFIX = 'kamkmchess.online.friend-secrets.v1';

/**
 * Creates the local store of the friend secrets.
 *
 * The store never throws: a browser that refuses the storage keeps the
 * secrets in memory for the lifetime of the page.
 */
export function createFriendSecretStore(options: FriendSecretStoreOptions = {}): FriendSecretStore {
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  let identity = options.identity ?? 'guest';
  const random = options.random;
  const memory = new Map<string, string>();

  const keyOf = (kind: string, id: string): string =>
    `${prefix}:${encodeURIComponent(identity)}:${kind}:${encodeURIComponent(id)}`;

  function read(kind: string, id: string): string | null {
    const key = keyOf(kind, id);
    try {
      const stored = storage?.getItem(key);
      if (stored) return stored;
    } catch {
      // The memory record is used instead.
    }
    return memory.get(key) ?? null;
  }

  function write(kind: string, id: string, value: string): void {
    const key = keyOf(kind, id);
    memory.set(key, value);
    try {
      storage?.setItem(key, value);
    } catch {
      // The memory record is used instead.
    }
  }

  function remove(kind: string, id: string): void {
    const key = keyOf(kind, id);
    memory.delete(key);
    try {
      storage?.removeItem(key);
    } catch {
      // Nothing to remove.
    }
  }

  return {
    get identity() {
      return identity;
    },
    setIdentity(next: string) {
      identity = next;
    },
    acceptanceKey(invitationId) {
      const existing = read('acceptance', invitationId);
      if (existing) return existing;
      // The key is stored before the acceptance is sent.
      const created = createAcceptanceKey(random);
      write('acceptance', invitationId, created);
      return created;
    },
    readAcceptanceKey(invitationId) {
      return read('acceptance', invitationId);
    },
    forgetAcceptanceKey(invitationId) {
      remove('acceptance', invitationId);
    },
    rememberOwnerToken(invitationId, ownerToken) {
      write('owner', invitationId, ownerToken);
    },
    readOwnerToken(invitationId) {
      return read('owner', invitationId);
    },
    ownsInvitation(invitationId) {
      return read('owner', invitationId) !== null;
    },
  };
}
