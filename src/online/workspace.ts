/**
 * The online workspace (KHA-74).
 *
 * One owner can have several live online matches at the same time. The
 * workspace owns those matches: it keeps every attached match subscribed, it
 * tracks the connection state of each one, it holds the committed result, and
 * it decides which match the interface shows.
 *
 * The rules this module keeps:
 *
 * - Switching the visible match never disposes another match. A live game
 *   keeps receiving its snapshots while another game is shown, so navigation
 *   cannot lose shared state.
 * - The workspace never joins a queue, never creates an entry and never sends
 *   a command on its own. Navigation is read-only with respect to the
 *   service.
 * - A snapshot replaces the state of its match. The workspace never merges a
 *   snapshot into an older one and never reorders moves.
 * - The committed result of a match is kept. A later reconnect never clears
 *   it, and a finished match never returns to the active phase.
 * - **Every match is authorized on its own.** A guest seat credential is
 *   bound to exactly one match and one seat, so several guest games need
 *   several credentials. The workspace never replaces the authority of one
 *   match with the authority of another.
 * - **The local registry is namespaced by the participant identity.** The
 *   games of one owner never appear under another owner, and a signed-out
 *   browser shows no games at all.
 * - **An account identity change disposes the matches of the old identity
 *   at once.** Their snapshots and their registry entries disappear
 *   synchronously, so no state of the previous owner stays on screen.
 * - **Signing in never takes a guest seat.** A guest match keeps its own
 *   credential and is never linked to the signed-in account.
 * - **A token refresh of the same account keeps every match.** The credential
 *   object of one account stays valid across a refresh, so nothing is
 *   disposed.
 * - A late answer of a disposed subscriber is discarded. A detached match can
 *   never write into the workspace again.
 */
import { createOnlineUpdatesSubscriber } from './updates';
import type { OnlineCursorStorage, OnlineUpdatesSubscriber, OnlineUpdateStopReason } from './updates';
import type { OnlineMatchView } from './updates';
import { createAuthorizedRequester } from './request';
import type { AuthorizedRequester } from './request';
import { createParticipantSession } from './session';
import type { AccountSessionPort, ParticipantSession } from './session';
import type { OnlineCredential } from './auth';
import type { Result, Seat } from './contracts';

/** The connection state of one attached match. */
export type OnlineGameStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'stopped'
  | 'unauthorized'
  | 'not-found';

/** The state of one attached match. */
export interface OnlineGameState {
  readonly matchId: string;
  readonly seat: Seat;
  readonly status: OnlineGameStatus;
  /** The last accepted snapshot, or null when none arrived yet. */
  readonly snapshot: OnlineMatchView | null;
  /** The committed result, or null while the match is unfinished. */
  readonly result: Result | null;
  /** A short reason for the current status. */
  readonly detail: string;
  /** The instant of the last accepted snapshot. */
  readonly updatedAt: string | null;
  /** The local identity key of the owner of this match. */
  readonly identityKey: string;
}

/** One seat the browser may follow. */
export interface OnlineSeatBinding {
  readonly matchId: string;
  readonly seat: Seat;
  /**
   * The credential that authorizes this seat.
   *
   * A guest credential authorizes exactly one match and one seat. An account
   * credential authorizes the matches of that account.
   */
  readonly credential: OnlineCredential;
}

/** The durable list of attached matches. */
export interface OnlineGameRegistryEntry {
  readonly matchId: string;
  readonly seat: Seat;
  /** The local identity key the entry belongs to. */
  readonly identityKey: string;
}

/** The durable storage seam. The default keeps the list in local storage. */
export interface OnlineGameRegistryStorage {
  read(identityKey: string): readonly OnlineGameRegistryEntry[];
  write(identityKey: string, entries: readonly OnlineGameRegistryEntry[]): void;
}

/** The prefix of the namespaced registry keys. */
export const ONLINE_GAME_REGISTRY_PREFIX = 'kamkmchess.online.games.v1';

/**
 * The default durable storage.
 *
 * Every identity owns its own list. The list holds no credential and no
 * private identifier: it names a match and a seat, which the participant
 * credential still has to authorize.
 */
export function createLocalGameRegistryStorage(prefix: string = ONLINE_GAME_REGISTRY_PREFIX): OnlineGameRegistryStorage {
  const keyFor = (identityKey: string): string => `${prefix}:${encodeURIComponent(identityKey)}`;
  return {
    read(identityKey) {
      try {
        const raw = globalThis.localStorage?.getItem(keyFor(identityKey));
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const entries: OnlineGameRegistryEntry[] = [];
        for (const item of parsed) {
          if (typeof item !== 'object' || item === null) continue;
          const record = item as Record<string, unknown>;
          const matchId = record.matchId;
          const seat = record.seat;
          const key = record.identityKey;
          if (typeof matchId !== 'string' || matchId.length === 0 || matchId.length > 64) continue;
          if (seat !== 'white' && seat !== 'black') continue;
          if (typeof key !== 'string' || key.length === 0) continue;
          entries.push({ matchId, seat, identityKey: key });
        }
        return entries;
      } catch {
        return [];
      }
    },
    write(identityKey, entries) {
      try {
        globalThis.localStorage?.setItem(keyFor(identityKey), JSON.stringify(entries));
      } catch {
        // A browser that refuses the storage keeps the list in memory only.
      }
    },
  };
}

/**
 * The local identity key of a credential.
 *
 * The key never leaves the browser. It namespaces the durable registry and
 * it tells the workspace which matches belong to which owner.
 */
export function onlineIdentityKey(credential: OnlineCredential): string {
  return credential.kind === 'account'
    ? `account:${credential.accountId}`
    : `guest:${credential.guestId}`;
}

export interface OnlineWorkspaceOptions {
  /** The trusted service origin. A credential is never sent outside it. */
  readonly baseUrl: string;
  /** The transport used by every requester of this workspace. */
  readonly fetch?: typeof fetch;
  /**
   * The signed-in account session.
   *
   * The workspace watches it. An identity change disposes the matches of the
   * previous identity at once.
   */
  readonly accountSession?: AccountSessionPort | null;
  /** The durable list of attached matches, namespaced by identity. */
  readonly registry?: OnlineGameRegistryStorage;
  /** The durable cursor store handed to each subscriber. */
  readonly cursorStorage?: OnlineCursorStorage;
  /** Receives every change of the workspace. */
  readonly onChange?: () => void;
  /** Creates the update subscriber. Tests inject a deterministic one. */
  readonly createSubscriber?: (input: OnlineSubscriberInput) => OnlineUpdatesSubscriber;
}

/** The input of the subscriber factory. */
export interface OnlineSubscriberInput {
  readonly requester: AuthorizedRequester;
  readonly session: ParticipantSession;
  readonly matchId: string;
  readonly seat: Seat;
  readonly storage?: OnlineCursorStorage;
  readonly onSnapshot: (snapshot: OnlineMatchView) => void;
  readonly onError: (error: Error) => void;
  readonly onStop: (reason: OnlineUpdateStopReason) => void;
}

/** The workspace of one owner. */
export interface OnlineWorkspace {
  /** Attaches a match with its own credential and starts reading updates. */
  attach(binding: OnlineSeatBinding): void;
  /** Detaches a match and stops reading its updates. */
  detach(matchId: string): void;
  /** Shows one match. Other matches keep running. */
  focus(matchId: string | null): void;
  /** The match the interface shows, or null. */
  readonly focusedMatchId: string | null;
  /** Every attached match, in the order it was attached. */
  readonly games: readonly OnlineGameState[];
  /** The state of one match, or null when it is not attached. */
  state(matchId: string): OnlineGameState | null;
  /** Reconnects one match at once. */
  wake(matchId: string): void;
  /**
   * Restores the durable matches of one identity.
   *
   * Only the matches whose credential the caller still holds are restored. A
   * guest seat credential lives in memory only, so a guest match resumes
   * only while this browser still holds it.
   */
  restore(identityKey: string, bindings: readonly OnlineSeatBinding[]): void;
  /** The durable entries of one identity. */
  persisted(identityKey: string): readonly OnlineGameRegistryEntry[];
  /** Stops every subscriber and releases the durable list. */
  dispose(): void;
  /** Registers a listener for every change. */
  subscribe(listener: () => void): () => void;
}

/** Maps a stop reason onto the connection state. */
function stoppedStatus(reason: OnlineUpdateStopReason): { status: OnlineGameStatus; detail: string } {
  switch (reason) {
    case 'unauthorized':
      return { status: 'unauthorized', detail: 'The seat credential was refused.' };
    case 'forbidden':
      return { status: 'unauthorized', detail: 'The seat is not a participant.' };
    case 'not-found':
      return { status: 'not-found', detail: 'The match is gone.' };
    case 'no-participant':
      return { status: 'unauthorized', detail: 'Sign in to follow this match.' };
    case 'session-invalidated':
      return { status: 'unauthorized', detail: 'The identity changed.' };
    default:
      return { status: 'stopped', detail: 'The match stopped updating.' };
  }
}

/**
 * Creates the online workspace.
 *
 * The workspace owns no chess authority and no transport: it composes the
 * existing update subscriber and keeps the state that the interface shows.
 */
export function createOnlineWorkspace(options: OnlineWorkspaceOptions): OnlineWorkspace {
  const registry = options.registry ?? createLocalGameRegistryStorage();
  const factory = options.createSubscriber ?? defaultSubscriberFactory;
  const listeners = new Set<() => void>();
  const games = new Map<string, OnlineGameState>();
  const subscribers = new Map<string, OnlineUpdatesSubscriber>();
  const sessions = new Map<string, ParticipantSession>();
  const requesters = new Map<string, AuthorizedRequester>();
  const order: string[] = [];
  /** The epoch of every attachment. A late answer of an old epoch is dropped. */
  const epochs = new Map<string, number>();
  let epochCounter = 0;
  let focused: string | null = null;
  let disposed = false;
  let unsubscribeAccount: (() => void) | null = null;

  function publish(): void {
    if (disposed) return;
    // The owner of the workspace learns about every change. The drivers of the
    // engine seats and of the agent seats react to the new snapshot here.
    try {
      options.onChange?.();
    } catch {
      // A failing driver never breaks the workspace.
    }
    for (const listener of [...listeners]) listener();
  }

  function setState(matchId: string, epoch: number, next: Partial<OnlineGameState>): void {
    if (disposed || epochs.get(matchId) !== epoch) return;
    const current = games.get(matchId);
    if (!current) return;
    games.set(matchId, { ...current, ...next });
    publish();
  }

  /** Rewrites the durable list of one identity. */
  function persist(identityKey: string): void {
    const entries: OnlineGameRegistryEntry[] = [];
    for (const matchId of order) {
      const game = games.get(matchId);
      if (game && game.identityKey === identityKey) {
        entries.push({ matchId, seat: game.seat, identityKey });
      }
    }
    registry.write(identityKey, entries);
  }

  /** Removes the matches of one identity from the screen and from the disk. */
  function forgetIdentity(identityKey: string): void {
    const owned = order.filter(matchId => games.get(matchId)?.identityKey === identityKey);
    for (const matchId of owned) detach(matchId);
    if (owned.length === 0) return;
    // The durable list of the old identity is emptied as well.
    registry.write(identityKey, []);
    if (focused !== null && owned.includes(focused)) focused = order[0] ?? null;
    publish();
  }

  /**
   * Builds the scoped session of one match.
   *
   * A guest seat keeps its own private credential. An account credential
   * keeps the account identity, so a token refresh of the same account does
   * not change the session and no match is disposed.
   */
  function scopedSession(credential: OnlineCredential): ParticipantSession {
    if (credential.kind === 'guest') {
      const session = createParticipantSession();
      session.selectGuest(credential);
      return session;
    }
    const identity = {
      accountId: credential.accountId,
      token: () => credential.issue(),
    };
    const port: AccountSessionPort = {
      identity,
      subscribe: () => () => undefined,
    };
    return createParticipantSession({ accountSession: port });
  }

  function attach(binding: OnlineSeatBinding): void {
    if (disposed) return;
    const { matchId, seat, credential } = binding;
    const identityKey = onlineIdentityKey(credential);
    const existing = games.get(matchId);
    if (existing) {
      // The same match stays attached. Its authority is never replaced by the
      // authority of another seat or another owner.
      if (existing.identityKey === identityKey) {
        setState(matchId, epochs.get(matchId) ?? 0, { seat });
        return;
      }
      // A different owner of the same match replaces the previous
      // attachment. Its snapshots are dropped with it.
      detach(matchId);
    }
    const epoch = (epochCounter += 1);
    epochs.set(matchId, epoch);
    const state: OnlineGameState = {
      matchId,
      seat,
      status: 'connecting',
      snapshot: null,
      result: null,
      detail: 'Connecting…',
      updatedAt: null,
      identityKey,
    };
    games.set(matchId, state);
    if (!order.includes(matchId)) order.push(matchId);
    const session = scopedSession(credential);
    sessions.set(matchId, session);
    const requester = createAuthorizedRequester({
      session,
      baseUrl: options.baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    requesters.set(matchId, requester);
    const subscriber = factory({
      requester,
      session,
      matchId,
      seat,
      ...(options.cursorStorage ? { storage: options.cursorStorage } : {}),
      onSnapshot: (snapshot) => {
        if (disposed || epochs.get(matchId) !== epoch) return;
        // A snapshot replaces the state. It is never merged into an older one.
        setState(matchId, epoch, {
          snapshot,
          status: 'live',
          detail: '',
          updatedAt: snapshot.updatedAt,
          result: snapshot.result,
        });
      },
      onError: () => {
        if (disposed || epochs.get(matchId) !== epoch) return;
        setState(matchId, epoch, { status: 'reconnecting', detail: 'Reconnecting…' });
      },
      onStop: (reason) => {
        if (disposed || epochs.get(matchId) !== epoch) return;
        setState(matchId, epoch, stoppedStatus(reason));
      },
    });
    subscribers.set(matchId, subscriber);
    subscriber.start();
    persist(identityKey);
    publish();
  }

  function detach(matchId: string): void {
    // The epoch moves, so a late answer of the detached subscriber is dropped.
    epochs.set(matchId, (epochCounter += 1));
    const subscriber = subscribers.get(matchId);
    if (subscriber) {
      subscriber.dispose();
      subscribers.delete(matchId);
    }
    const session = sessions.get(matchId);
    if (session) {
      session.dispose();
      sessions.delete(matchId);
    }
    const requester = requesters.get(matchId);
    if (requester) {
      requester.dispose();
      requesters.delete(matchId);
    }
    const game = games.get(matchId);
    games.delete(matchId);
    epochs.delete(matchId);
    const index = order.indexOf(matchId);
    if (index >= 0) order.splice(index, 1);
    if (game) persist(game.identityKey);
    if (focused === matchId) focused = order[0] ?? null;
    publish();
  }

  if (options.accountSession) {
    const accountSession = options.accountSession;
    unsubscribeAccount = accountSession.subscribe((identity) => {
      if (disposed) return;
      const current = identity === null ? null : `account:${identity.accountId}`;
      // The matches of the previous account are disposed at once. Their
      // snapshots and their durable entries disappear with them.
      for (const matchId of [...order]) {
        const game = games.get(matchId);
        if (!game || !game.identityKey.startsWith('account:')) continue;
        if (game.identityKey === current) continue;
        forgetIdentity(game.identityKey);
      }
      publish();
    });
  }

  return {
    attach,
    detach,
    focus(matchId) {
      if (matchId !== null && !games.has(matchId)) return;
      // Focusing another match never disposes the previous one.
      focused = matchId;
      publish();
    },
    get focusedMatchId() {
      return focused;
    },
    get games() {
      return order.map(matchId => games.get(matchId)).filter((game): game is OnlineGameState => game !== undefined);
    },
    state(matchId) {
      return games.get(matchId) ?? null;
    },
    wake(matchId) {
      subscribers.get(matchId)?.wake();
    },
    restore(identityKey, bindings) {
      if (disposed) return;
      for (const binding of bindings) {
        if (onlineIdentityKey(binding.credential) !== identityKey) continue;
        attach(binding);
      }
    },
    persisted(identityKey) {
      return registry.read(identityKey);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeAccount?.();
      unsubscribeAccount = null;
      for (const subscriber of subscribers.values()) subscriber.dispose();
      for (const session of sessions.values()) session.dispose();
      for (const requester of requesters.values()) requester.dispose();
      subscribers.clear();
      sessions.clear();
      requesters.clear();
      games.clear();
      epochs.clear();
      order.length = 0;
      focused = null;
      listeners.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/**
 * The default subscriber factory.
 *
 * It wires the canonical update subscriber. The transport, the credential
 * and the durable cursor stay owned by that module.
 */
function defaultSubscriberFactory(input: OnlineSubscriberInput): OnlineUpdatesSubscriber {
  return createOnlineUpdatesSubscriber({
    requester: input.requester,
    session: input.session,
    matchId: input.matchId,
    seat: input.seat,
    ...(input.storage ? { storage: input.storage } : {}),
    onSnapshot: (update) => input.onSnapshot(update.snapshot),
    onError: (error) => input.onError(error),
    onStop: (reason) => input.onStop(reason),
  });
}
