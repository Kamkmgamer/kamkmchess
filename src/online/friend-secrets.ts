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
import type { Seat } from './contracts';
import type { ModelSelection } from '../controller/index.js';

/** The local store of the accept intents and of the owner tokens. */
export interface FriendSecretStore {
  /** The identity that owns the stored secrets. */
  readonly identity: string;
  /**
   * The token of the records of this browser.
   *
   * The token names the identity and the version of the records. It moves on
   * every identity change, so a caller that captured it before an answer can
   * tell that the identity changed while the answer was on the wire. The
   * record of an older identity then never reaches the current one.
   */
  readonly context: string;
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
  /**
   * Stores the seat credential of an accepted invitation.
   *
   * The record is durable: after a reload the browser still owns the seat of
   * the match it accepted. The answer is true when the record reached the
   * device, and false when the browser refused the storage: the record would
   * be lost with the page, so the caller keeps its recovery intent and the
   * next attempt asks the service for the explicit recovery.
   */
  rememberAcceptedSeat(invitationId: string, credential: AcceptedSeatCredential): boolean;
  /** The stored seat credential of an accepted invitation, or null. */
  readAcceptedSeat(invitationId: string): AcceptedSeatCredential | null;
  /**
   * Every accepted seat of this identity.
   *
   * The browser reads the list to restore the seats it accepted, so a reload
   * still owns them.
   */
  listAcceptedSeats(): readonly { readonly invitationId: string; readonly credential: AcceptedSeatCredential }[];
  /** Forgets the accepted seat of an invitation. */
  forgetAcceptedSeat(invitationId: string): void;
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
 * The seat credential of an accepted invitation.
 *
 * It is the authority of the seat of the match the invitation produced. The
 * browser keeps it on the device, and it never leaves the browser.
 */
export interface AcceptedSeatCredential {
  readonly guestId: string;
  readonly matchId: string;
  readonly seat: Seat;
  readonly token: string;
}

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
  /** The version of the records. It moves on every identity change. */
  let version = 0;
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

  /** The key of the list of the accepted seats of one identity. */
  const acceptedListKey = (owner: string): string =>
    `${prefix}:${encodeURIComponent(owner)}:accepted-seats`;

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

  /**
   * Stores a value and reports whether it reached the device.
   *
   * A browser that refuses the storage keeps the value in memory for the
   * lifetime of the page. The answer is false then, so the caller knows that
   * the record did not survive a reload.
   */
  function writeKey(key: string, value: string): boolean {
    memory.set(key, value);
    if (!storage) return false;
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      // The memory record is used instead.
      return false;
    }
  }

  function write(kind: string, id: string, value: string): boolean {
    return writeKey(keyOf(kind, id), value);
  }

  /**
   * Reads a list of records of the identity.
   *
   * The list of the memory is used when the browser refused the storage, so
   * the page still knows its own records.
   */
  function readList(key: string): string[] {
    let raw: string | null;
    try {
      raw = storage?.getItem(key) ?? null;
    } catch {
      raw = null;
    }
    if (raw === null) raw = memory.get(key) ?? null;
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const ids: string[] = [];
      for (const item of parsed) {
        if (typeof item === 'string' && item.length > 0) ids.push(item);
      }
      return ids;
    } catch {
      return [];
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
    get context() {
      return `${identity}:${version}`;
    },
    setIdentity(next: string) {
      if (next === identity) return;
      identity = next;
      // The version moves with the identity, so a record of an older
      // identity never reaches the current one.
      version += 1;
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
    rememberAcceptedSeat(invitationId, credential) {
      const durable = write('accepted-seat', invitationId, JSON.stringify({
        guestId: credential.guestId,
        matchId: credential.matchId,
        seat: credential.seat,
        token: credential.token,
      }));
      // The list of the accepted seats is durable too, so a reload finds the
      // seats this browser accepted.
      const accepted = readList(acceptedListKey(identity)).filter(id => id !== invitationId);
      accepted.push(invitationId);
      const listed = writeKey(acceptedListKey(identity), JSON.stringify(accepted));
      // The answer is true when the record reached the device. A record that
      // stayed in memory would be lost with the page, so the caller keeps its
      // recovery intent and asks the service for the credential again.
      return durable && listed;
    },
    readAcceptedSeat(invitationId) {
      const raw = read('accepted-seat', invitationId);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<AcceptedSeatCredential>;
        if (typeof parsed.guestId !== 'string' || typeof parsed.matchId !== 'string') return null;
        if (parsed.seat !== 'white' && parsed.seat !== 'black') return null;
        if (typeof parsed.token !== 'string') return null;
        return {
          guestId: parsed.guestId,
          matchId: parsed.matchId,
          seat: parsed.seat,
          token: parsed.token,
        };
      } catch {
        return null;
      }
    },
    listAcceptedSeats() {
      const records: { invitationId: string; credential: AcceptedSeatCredential }[] = [];
      for (const invitationId of readList(acceptedListKey(identity))) {
        const credential = read('accepted-seat', invitationId);
        if (!credential) continue;
        try {
          const parsed = JSON.parse(credential) as Partial<AcceptedSeatCredential>;
          if (typeof parsed.guestId !== 'string' || typeof parsed.matchId !== 'string') continue;
          if (parsed.seat !== 'white' && parsed.seat !== 'black') continue;
          if (typeof parsed.token !== 'string') continue;
          records.push({
            invitationId,
            credential: {
              guestId: parsed.guestId,
              matchId: parsed.matchId,
              seat: parsed.seat,
              token: parsed.token,
            },
          });
        } catch {
          // A record that cannot be read is skipped.
        }
      }
      return records;
    },
    forgetAcceptedSeat(invitationId) {
      remove('accepted-seat', invitationId);
      const accepted = readList(acceptedListKey(identity)).filter(id => id !== invitationId);
      writeKey(acceptedListKey(identity), JSON.stringify(accepted));
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
