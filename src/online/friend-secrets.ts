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
import type { ModelSelection } from '../controller/index.js';

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
  rememberOwnerToken(invitationId: string, ownerToken: string, selection?: ModelSelection | null): void;
  /** The owner token of an invitation, or null. */
  readOwnerToken(invitationId: string): string | null;
  /** Forgets an invitation that was settled. */
  forgetOwnerToken(invitationId: string): void;
  /** The private selection captured for an invitation, or null. */
  readOwnerSelection(invitationId: string): ModelSelection | null;
  /** True when this browser created the invitation. */
  ownsInvitation(invitationId: string): boolean;
  /**
   * Stores a rematch this browser proposed.
   *
   * The record is durable: after a reload the proposer still claims the seat
   * of the new match.
   */
  rememberRematch(rematchId: string, matchId: string, selection?: ModelSelection | null): void;
  /** The rematches this browser proposed. */
  listRematches(): readonly { rematchId: string; matchId: string; selection: ModelSelection | null }[];
  /** Forgets a rematch that was settled. */
  forgetRematch(rematchId: string): void;
  /**
   * Records that this browser started an acceptance of the invitation.
   *
   * The answer is true when the acceptance is a retry. Only a retry asks for
   * the explicit credential recovery, so a routine acceptance never rotates a
   * credential.
   */
  beginAcceptance(invitationId: string): boolean;
  /** Forgets the acceptance intent of an invitation. */
  forgetAcceptance(invitationId: string): void;
  /**
   * The invitations this browser created.
   *
   * The list survives a reload, so the inviter can still claim its seat
   * credential after the browser restarted.
   */
  listOwnedInvitations(): readonly string[];
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

  /** The key of the list of the invitations of one identity. */
  const listKey = (owner: string): string =>
    `${prefix}:${encodeURIComponent(owner)}:owned`;

  /** The key of the list of the rematches of one identity. */
  const rematchKey = (owner: string): string =>
    `${prefix}:${encodeURIComponent(owner)}:rematches`;

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
    rememberOwnerToken(invitationId, ownerToken, selection?: ModelSelection | null) {
      write('owner', invitationId, ownerToken);
      // The list of the invitations of this identity is durable, so a reload
      // can still claim the seat of a consumed invitation.
      const owned = this.listOwnedInvitations().filter(id => id !== invitationId);
      owned.push(invitationId);
      try {
        storage?.setItem(listKey(identity), JSON.stringify(owned));
      } catch {
        // The list is kept in memory only.
      }
      if (selection) {
        // The private selection of the agent of the invitation is kept with
        // it, so the claimed seat keeps the model the owner chose.
        write('selection', invitationId, JSON.stringify(selection));
      }
    },
    readOwnerToken(invitationId) {
      return read('owner', invitationId);
    },
    forgetOwnerToken(invitationId) {
      remove('owner', invitationId);
      remove('selection', invitationId);
      const owned = this.listOwnedInvitations().filter(id => id !== invitationId);
      try {
        storage?.setItem(listKey(identity), JSON.stringify(owned));
      } catch {
        // The list is kept in memory only.
      }
    },
    readOwnerSelection(invitationId) {
      const raw = read('selection', invitationId);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as ModelSelection;
      } catch {
        return null;
      }
    },
    ownsInvitation(invitationId) {
      return read('owner', invitationId) !== null;
    },
    /**
     * Records that this browser started an acceptance of the invitation.
     *
     * The record is durable. The answer is true when the acceptance is a
     * retry, and only a retry asks for the explicit credential recovery.
     */
    beginAcceptance(invitationId) {
      const retry = read('accepting', invitationId) !== null;
      write('accepting', invitationId, '1');
      return retry;
    },
    forgetAcceptance(invitationId) {
      remove('accepting', invitationId);
    },
    listOwnedInvitations() {
      const owned: string[] = [];
      try {
        const raw = storage?.getItem(listKey(identity));
        if (!raw) return owned;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return owned;
        for (const item of parsed) {
          if (typeof item === 'string' && item.length > 0) owned.push(item);
        }
      } catch {
        return owned;
      }
      return owned;
    },
    rememberRematch(rematchId, matchId, selection) {
      const rematches = this.listRematches().filter(record => record.rematchId !== rematchId);
      rematches.push({ rematchId, matchId, selection: selection ?? null });
      try {
        storage?.setItem(rematchKey(identity), JSON.stringify(rematches));
      } catch {
        // The records are kept in memory only.
      }
    },
    listRematches() {
      try {
        const raw = storage?.getItem(rematchKey(identity));
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const records: { rematchId: string; matchId: string; selection: ModelSelection | null }[] = [];
        for (const item of parsed) {
          if (typeof item !== 'object' || item === null) continue;
          const record = item as Record<string, unknown>;
          if (typeof record.rematchId !== 'string' || record.rematchId.length === 0) continue;
          if (typeof record.matchId !== 'string' || record.matchId.length === 0) continue;
          const selection = record.selection;
          records.push({
            rematchId: record.rematchId,
            matchId: record.matchId,
            selection: typeof selection === 'object' && selection !== null ? selection as ModelSelection : null,
          });
        }
        return records;
      } catch {
        return [];
      }
    },
    forgetRematch(rematchId) {
      const rematches = this.listRematches().filter(record => record.rematchId !== rematchId);
      try {
        storage?.setItem(rematchKey(identity), JSON.stringify(rematches));
      } catch {
        // The records are kept in memory only.
      }
    },
  };
}
