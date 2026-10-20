/**
 * The online composition (KHA-74, KHA-77).
 *
 * The composition is the single place where the online browser parts meet the
 * service. It owns the workspace, the queue flow, the command clients and the
 * feature flags, and it publishes one state to the interface.
 *
 * The rules this module keeps:
 *
 * - The service owns the rollout. The composition asks
 *   `GET /v1/online/features` without a credential, because the answer is
 *   public and a signed-out visitor must discover it too. A local test
 *   opt-in is honored only against a loopback origin.
 * - Every match is authorized on its own. A guest seat credential acts on its
 *   own match and its own seat, and the account session acts on the account
 *   matches.
 * - The browser owns every provider secret and every provider request. The
 *   agent readiness check runs in the browser and the service only receives a
 *   public label.
 * - One queue intent is one entry. The client request identifier stays in
 *   local storage until the entry reaches a terminal state, so a lost
 *   acknowledgement cannot create a second entry. A second explicit game
 *   replaces the intent with a new identifier.
 * - An identity change fences the queue state and the guest credentials of
 *   the previous identity at once.
 * - Nothing here starts a search on its own. The interface asks, and the
 *   service answers.
 */
import { createOnlineWorkspace } from './workspace';
import type { OnlineWorkspace, OnlineSeatBinding } from './workspace';
import { createOnlineQueueController } from './readiness';
import type { OnlineQueueController, OnlineQueueState, OnlineQueueAssignment } from './readiness';
import { createOnlineQueueClient } from './queue-client';
import type { OnlineQueueClient } from './queue-client';
import { createOnlineMatchCommandClient } from './match-client';
import type { OnlineMatchCommandClient } from './match-client';
import { createOnlineEngineSeat } from './engine-seat';
import type { OnlineEngineSeat } from './engine-seat';
import { createParticipantSession } from './session';
import type { AccountSessionPort, ParticipantSession } from './session';
import { createAuthorizedRequester } from './request';
import type { AuthorizedRequester } from './request';
import { createGuestCredential, describeCredential } from './auth';
import type { GuestOnlineCredential, OnlineCredential } from './auth';
import { combineOnlineFeatureFlags, parseOnlineFeatureFlags, readLocalOptIn } from './features';
import { ONLINE_FEATURES_DISABLED } from './features';
import type { OnlineFeatureFlags } from './features';
import { parseOnlineMatchView } from './updates';
import type { Seat, SeatControl, TimeControl } from './contracts';
import type { OnlineAgentCheck } from './readiness';

/** The route that answers which online surfaces are open. */
export const ONLINE_FEATURES_ROUTE = '/v1/online/features';

/** The local key of the pending queue intent. */
export const ONLINE_QUEUE_INTENT_KEY = 'kamkmchess.online.queue.intent.v1';

export interface OnlineCompositionOptions {
  /** The trusted service origin. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** The signed-in account session, when the build has one. */
  readonly accountSession?: AccountSessionPort | null;
  /** The known feature flags. They are read from the service when omitted. */
  readonly features?: OnlineFeatureFlags;
  /**
   * The own-agent readiness check.
   *
   * The check runs in the browser: it validates the selected connection and
   * model without sending a credential to the service.
   */
  readonly checkAgent?: (control: SeatControl) => Promise<OnlineAgentCheck>;
  /** Prepares the browser Stockfish 19 Lite engine. */
  readonly prepareEngine?: () => Promise<void>;
  /** The local search string of the page, used for the loopback test opt-in. */
  readonly search?: string;
  /** The local storage seam of the queue intent. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

export interface OnlineComposition {
  /** The open online surfaces. */
  readonly features: OnlineFeatureFlags;
  /** The concurrent game workspace. */
  readonly workspace: OnlineWorkspace;
  /** The queue flow of this browser. */
  readonly queue: OnlineQueueController;
  /** The current queue state. */
  readonly queueState: OnlineQueueState;
  /**
   * Enters the queue with one explicit intent.
   *
   * The default reuses the stored intent, so a second tab or a lost answer
   * reaches the same entry. A second explicit game asks for a new intent.
   */
  enterQueue(request: { control: SeatControl; timeControl: TimeControl }, options?: { intent?: 'reuse' | 'new' }): Promise<void>;
  /** The command client of one seat. */
  commandClient(matchId: string, seat: Seat, credential?: OnlineCredential): OnlineMatchCommandClient | null;
  /** Registers a guest seat credential so the seat can be followed and played. */
  registerGuestCredential(credential: GuestOnlineCredential): void;
  /** Creates the browser engine seat of a fallback game. */
  engineSeat(matchId: string, seat: Seat, credential: GuestOnlineCredential): OnlineEngineSeat;
  /** Reads the feature flags of the service. */
  loadFeatures(): Promise<OnlineFeatureFlags>;
  /** Registers a listener for every change. */
  subscribe(listener: () => void): () => void;
  /** Releases every resource. */
  dispose(): void;
}

/** The intent of one queue entry. */
interface QueueIntent {
  readonly accountId: string;
  readonly clientRequestId: string;
}

function readIntent(storage: OnlineCompositionOptions['storage'], accountId: string): QueueIntent | null {
  try {
    const raw = storage?.getItem(ONLINE_QUEUE_INTENT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.accountId !== accountId) return null;
    const id = record.clientRequestId;
    if (typeof id !== 'string' || id.length < 8) return null;
    return { accountId, clientRequestId: id };
  } catch {
    return null;
  }
}

function writeIntent(storage: OnlineCompositionOptions['storage'], intent: QueueIntent): void {
  try {
    storage?.setItem(ONLINE_QUEUE_INTENT_KEY, JSON.stringify(intent));
  } catch {
    // A browser that refuses the storage keeps the intent in memory only.
  }
}

function clearIntent(storage: OnlineCompositionOptions['storage']): void {
  try {
    storage?.removeItem(ONLINE_QUEUE_INTENT_KEY);
  } catch {
    // Nothing to clear.
  }
}

function createIntentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `intent${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * Reads the expiry of a seat credential.
 *
 * The service answers an ISO timestamp. The local credential keeps an
 * instant in milliseconds.
 */
function readExpiry(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Creates the online composition.
 *
 * The composition is created once per page. It is mounted by the interface
 * and disposed with it.
 */
export function createOnlineComposition(options: OnlineCompositionOptions): OnlineComposition {
  const { baseUrl } = options;
  const fetcher = options.fetch;
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  const listeners = new Set<() => void>();
  const guestCredentials = new Map<string, GuestOnlineCredential>();
  /** The requesters of the guest seats, one per seat. */
  const guestRequesters = new Map<string, AuthorizedRequester>();
  const guestSessions = new Map<string, ParticipantSession>();
  let features: OnlineFeatureFlags = options.features ?? ONLINE_FEATURES_DISABLED;
  let queueState: OnlineQueueState = {
    phase: 'idle',
    entry: null,
    detail: '',
    assignment: null,
    engineState: 'idle',
    cutoffAt: null,
    options: [],
  };

  const workspace = createOnlineWorkspace({
    baseUrl,
    ...(fetcher ? { fetch: fetcher } : {}),
    ...(options.accountSession ? { accountSession: options.accountSession } : {}),
    onChange: () => notify(),
  });

  /** The participant session of the signed-in account, when there is one. */
  let accountParticipant: ParticipantSession | null = null;
  let accountRequesterInstance: AuthorizedRequester | null = null;
  let unsubscribeAccount: (() => void) | null = null;
  if (options.accountSession) {
    accountParticipant = createParticipantSession({ accountSession: options.accountSession });
    accountRequesterInstance = createAuthorizedRequester({
      session: accountParticipant,
      baseUrl,
      ...(fetcher ? { fetch: fetcher } : {}),
    });
    // An identity change fences the queue state and the guest credentials of
    // the previous identity at once.
    unsubscribeAccount = options.accountSession.subscribe(() => {
      queue.reset();
      for (const credential of guestCredentials.values()) {
        if (credential.kind === 'guest') continue;
        guestCredentials.delete(`${credential.matchId}:${credential.seat}`);
      }
      guestCredentials.clear();
      notify();
    });
  }

  function accountRequester(): AuthorizedRequester | null {
    return accountRequesterInstance;
  }

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  const queueClient: OnlineQueueClient = createOnlineQueueClient({
    requester: accountRequester() ?? createAuthorizedRequester({
      session: createParticipantSession(),
      baseUrl,
      ...(fetcher ? { fetch: fetcher } : {}),
    }),
  });

  const queue = createOnlineQueueController({
    ports: {
      checkAgent: options.checkAgent ?? (async () => ({
        ready: false,
        detail: 'Connect a model before watching your agent play.',
      })),
      prepareEngine: options.prepareEngine ?? (async () => {
        throw new Error('The browser engine is not available.');
      }),
      acceptReady: async request => {
        const accountId = accountParticipant?.accountId ?? null;
        const stored = accountId === null ? null : readIntent(storage, accountId);
        const intent = stored ?? { accountId: accountId ?? 'guest', clientRequestId: createIntentId() };
        if (accountId !== null && stored === null) writeIntent(storage, intent);
        // The intent stays stored until the entry reaches a terminal state.
        // A lost acknowledgement therefore reaches the same entry instead of
        // creating a second one.
        return queueClient.create({ ...request, clientRequestId: intent.clientRequestId });
      },
      readEntry: entryId => queueClient.read(entryId),
      readMatch: async matchId => {
        const requester = accountRequester();
        if (!requester) throw new Error('No participant credential is available.');
        const result = await requester.request({ kind: 'account' }, { path: `/v1/online/matches/${encodeURIComponent(matchId)}` });
        if (!result.ok) throw new Error('The match could not be read.');
        return parseOnlineMatchView(result.data, matchId);
      },
      cancelEntry: entryId => queueClient.cancel(entryId),
      keepSearching: entryId => queueClient.keepSearching(entryId),
      findCompatibleEntry: entryId => queueClient.findCompatible(entryId),
      commitFallback: async entryId => {
        const answer = await queueClient.commitFallback(entryId);
        const credential = answer.engineCredential;
        if (credential && typeof credential === 'object') {
          const record = credential as Record<string, unknown>;
          if (typeof record.token === 'string' && typeof record.guestId === 'string' &&
              typeof record.matchId === 'string' && (record.seat === 'white' || record.seat === 'black')) {
            const expiry = readExpiry(record.expiresAt);
            registerGuestCredential(createGuestCredential({
              guestId: record.guestId,
              matchId: record.matchId,
              seat: record.seat,
              token: record.token,
              ...(expiry === undefined ? {} : { expiresAt: expiry }),
            }));
          }
        }
        return answer;
      },
    },
    onState: state => {
      queueState = state;
      // A terminal entry releases the stored intent. The next explicit entry
      // starts a fresh one.
      if (state.phase === 'matched' || state.phase === 'cancelled' || state.phase === 'expired') {
        const accountId = accountParticipant?.accountId ?? null;
        if (accountId !== null) clearIntent(storage);
      }
      notify();
    },
  });

  function registerGuestCredential(credential: GuestOnlineCredential): void {
    guestCredentials.set(`${credential.matchId}:${credential.seat}`, credential);
    notify();
  }

  function commandClient(matchId: string, seat: Seat, credential?: OnlineCredential): OnlineMatchCommandClient | null {
    const key = `${matchId}:${seat}`;
    const guest = credential ?? guestCredentials.get(key) ?? null;
    if (guest && guest.kind === 'guest') {
      let session = guestSessions.get(key);
      if (!session) {
        session = createParticipantSession();
        session.selectGuest(guest);
        guestSessions.set(key, session);
        guestRequesters.set(key, createAuthorizedRequester({
          session,
          baseUrl,
          ...(fetcher ? { fetch: fetcher } : {}),
        }));
      }
      const requester = guestRequesters.get(key);
      if (!requester) return null;
      return createOnlineMatchCommandClient({ requester, session, matchId, seat });
    }
    if (!accountParticipant || !accountRequesterInstance) return null;
    return createOnlineMatchCommandClient({
      requester: accountRequesterInstance,
      session: accountParticipant,
      matchId,
      seat,
    });
  }

  return {
    get features() {
      return features;
    },
    workspace,
    queue,
    get queueState() {
      return queueState;
    },
    async enterQueue(request, enterOptions) {
      const accountId = accountParticipant?.accountId ?? null;
      if (enterOptions?.intent === 'new' && accountId !== null) {
        // An explicit second game replaces the stored intent.
        clearIntent(storage);
      }
      await queue.enter(request);
    },
    commandClient,
    registerGuestCredential,
    engineSeat(matchId, seat, credential) {
      return createOnlineEngineSeat({
        matchId,
        seat,
        credential,
        baseUrl,
        ...(fetcher ? { fetch: fetcher } : {}),
        ...(options.prepareEngine ? { prepareEngine: options.prepareEngine } : {}),
      });
    },
    async loadFeatures() {
      let service: OnlineFeatureFlags = ONLINE_FEATURES_DISABLED;
      try {
        // The feature answer is public. It carries no participant credential.
        const response = await (fetcher ?? globalThis.fetch)(`${baseUrl}${ONLINE_FEATURES_ROUTE}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'omit',
        });
        if (response.ok) service = parseOnlineFeatureFlags(await response.json());
      } catch {
        // A service that cannot answer leaves every surface closed.
      }
      const local = readLocalOptIn(options.search ?? (typeof window === 'undefined' ? '' : window.location.search));
      features = combineOnlineFeatureFlags(service, local);
      notify();
      return features;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      unsubscribeAccount?.();
      unsubscribeAccount = null;
      workspace.dispose();
      queue.dispose();
      accountParticipant?.dispose();
      accountParticipant = null;
      accountRequesterInstance?.dispose();
      accountRequesterInstance = null;
      for (const requester of guestRequesters.values()) requester.dispose();
      for (const session of guestSessions.values()) session.dispose();
      guestRequesters.clear();
      guestSessions.clear();
      guestCredentials.clear();
      listeners.clear();
    },
  };
}

/** The public label of a participant of a live match. */
export function onlineParticipantLabel(
  seats: readonly { readonly seat: Seat; readonly publicLabel: string }[],
  seat: Seat,
): string {
  const found = seats.find(candidate => candidate.seat === seat);
  return found?.publicLabel ?? (seat === 'white' ? 'White' : 'Black');
}

/** The local identity of the signed-in account, when there is one. */
export function onlineAccountIdentity(session: ParticipantSession | null): string | null {
  if (!session) return null;
  const described = describeCredential(session.credential);
  if (!described || described.kind !== 'account') return null;
  return described.accountId;
}

/** The assignment of a committed match, when the queue committed one. */
export function onlineQueueAssignment(state: OnlineQueueState): OnlineQueueAssignment | null {
  return state.assignment;
}

/** The bindings the workspace restores for one identity. */
export function onlineRestoreBindings(
  entries: readonly { readonly matchId: string; readonly seat: Seat }[],
  credential: OnlineCredential,
): OnlineSeatBinding[] {
  return entries.map(entry => ({
    matchId: entry.matchId,
    seat: entry.seat,
    credential,
  }));
}
