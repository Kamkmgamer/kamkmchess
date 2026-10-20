/**
 * The online composition (KHA-74, KHA-77).
 *
 * The composition is the single place where the online browser parts meet the
 * service. It owns the workspace, the queue flow, the command clients, the
 * browser engine seats, the presence heartbeats and the feature flags, and it
 * publishes one state to the interface.
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
 * - An identity change fences the state of the previous identity at once. A
 *   token refresh of the same account changes nothing: the games, the queue
 *   and the engine seats keep their authority.
 * - A committed assignment is attached to the workspace and shown. The engine
 *   seat of a fallback game plays its own turns, in every attached game.
 * - A waiting entry is polled in the background, and every attached match
 *   reports in, so a responsive background tab stays eligible.
 */
import { createOnlineWorkspace } from './workspace';
import type { OnlineWorkspace, OnlineSeatBinding } from './workspace';
import { createOnlineQueueController } from './readiness';
import type { OnlineQueueController, OnlineQueueState, OnlineQueueAssignment } from './readiness';
import { createQueueClient, queueOperationBody } from './queue';
import type { QueueAssignment, QueueClient } from './queue';
import { createOnlineMatchCommandClient } from './match-client';
import type { OnlineMatchCommandClient } from './match-client';
import { createOnlineEngineSeat } from './engine-seat';
import type { OnlineEngineSeat } from './engine-seat';
import { createOnlineAgentSeat, createAgentProviderPort, providerRunnerSnapshot } from './agent-seat';
import type { OnlineProviderRunner, ProviderRunnerState } from './provider-runner';
import { createOnlineRunnerLeaseClient } from './runner-lease';
import { createOnlinePresenceClient } from './presence-client';
import type { OnlinePresenceClient } from './presence-client';
import { createFriendClient } from './friend-routes';
import type { FriendClient } from './friend-routes';
import { fetchOnlineProfileHistory, fetchOnlinePublicReplay } from './history';
import type { OnlineProfileHistory, OnlinePublicReplay } from './history';
import {
  registerPublicModelLabel,
  requestAccountDeletion,
  requestExplicitRemoval,
  requestGuestRemoval,
} from './privacy';
import type { OnlinePublicModelLabel, OnlineRemovalReport } from './privacy';
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
import { ONLINE_CONTRACTS_SCHEMA_VERSION } from './contracts';
import type { OnlineMatchView } from './updates';
import type { Seat, SeatControl, TimeControl } from './contracts';
import type { OnlineAgentCheck } from './readiness';
import type { ModelSelection } from '../controller/index.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';

/** The route that answers which online surfaces are open. */
export const ONLINE_FEATURES_ROUTE = '/v1/online/features';

/** The local key of the pending queue intent. */
export const ONLINE_QUEUE_INTENT_KEY = 'kamkmchess.online.queue.intent.v1';

/**
 * The intent of one queue entry.
 *
 * The intent carries the settings it was created with. A settings change is
 * a new explicit intent, so a stored intent never blocks the owner with a
 * conflict.
 */
interface QueueIntent {
  readonly accountId: string;
  readonly clientRequestId: string;
  /** The settings of the entry, so a change can be detected. */
  readonly settings: string;
}

/** The interval of the background poll of a waiting entry. */
export const ONLINE_QUEUE_POLL_INTERVAL_MS = 2_000;

/** The interval of the presence heartbeat of an attached match. */
export const ONLINE_PRESENCE_HEARTBEAT_MS = 5_000;

/** The own agent of the owner. */
export interface OnlineAgent {
  /** The public label the other participants see. */
  readonly label: string;
  /** The private selection. It never leaves the browser. */
  readonly selection: ModelSelection;
}

export interface OnlineCompositionOptions {
  /** The trusted service origin. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** The signed-in account session, when the build has one. */
  readonly accountSession?: AccountSessionPort | null;
  /** The known feature flags. They are read from the service when omitted. */
  readonly features?: OnlineFeatureFlags;
  /**
   * The own-agent readiness check of a selected model.
   *
   * The check runs in the browser: it validates the selected connection and
   * model without sending a credential to the service.
   */
  readonly checkModel?: (selection: ModelSelection) => Promise<OnlineAgentCheck>;
  /** Prepares the browser Stockfish 19 Lite engine. */
  readonly prepareEngine?: () => Promise<void>;
  /** The local search string of the page, used for the loopback test opt-in. */
  readonly search?: string;
  /** The local storage seam of the queue intent. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The timer seam of the background poll and the heartbeat. */
  readonly timers?: {
    readonly setTimer: (callback: () => void, delayMs: number) => unknown;
    readonly clearTimer: (handle: unknown) => void;
  };
  /**
   * The browser owned connection store.
   *
   * The agent seat resolves its provider destination and its credential from
   * it. The credential never leaves the browser.
   */
  readonly connectionStore?: Promise<ConnectionStore>;
  /** The namespace of the connection store. */
  readonly namespace?: ConnectionNamespace;
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
  /** The friend invitation and rematch client. */
  readonly friends: FriendClient;
  /** The public reads of the replay and the game history. */
  readonly publicHistory: {
    /** Reads the public replay of a completed match. */
    replay(matchId: string): Promise<OnlinePublicReplay>;
    /** Reads the public game history of a profile. */
    history(profileId: string): Promise<OnlineProfileHistory>;
  };
  /** The privacy actions of the owner. */
  readonly privacy: {
    /** Deletes the account and anonymizes the shared games. */
    deleteAccount(): Promise<OnlineRemovalReport>;
    /** Erases the shared replays of the signed-in account. */
    removeAccount(): Promise<OnlineRemovalReport>;
    /** Erases the shared replays of a guest seat owner. */
    removeGuest(matchId: string, seat: Seat): Promise<OnlineRemovalReport>;
    /** Registers the public label of the owner's own agent. */
    registerPublicModelLabel(publicLabel: string): Promise<OnlinePublicModelLabel>;
  };
  /** The own agent of the owner, when one is selected. */
  readonly agent: OnlineAgent | null;
  /** Sets the own agent of the owner. */
  setAgent(agent: OnlineAgent | null): void;
  /**
   * Registers the public label of the owner's own agent.
   *
   * The service canonicalizes a model label. The registration keeps the label
   * the owner chose, and the canonical answer binds the private selection.
   */
  registerAgentLabel(): Promise<string | null>;
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
  registerGuestCredential(credential: GuestOnlineCredential, owner?: 'account' | 'guest'): void;
  /** Creates the browser engine seat of a fallback game. */
  engineSeat(matchId: string, seat: Seat, credential: GuestOnlineCredential): OnlineEngineSeat;
  /** The presence client of one seat. */
  presenceClient(matchId: string, seat: Seat, credential?: OnlineCredential): OnlinePresenceClient | null;
  /**
   * The state of the browser runner of the owner's own agent seat.
   *
   * The state carries the phase and the decisions the owner may take.
   */
  agentRunnerState(matchId: string, seat: Seat): ProviderRunnerState | null;
  /**
   * Applies an explicit decision of the owner to the agent runner.
   *
   * The decision is never automatic: the runner never leaves an uncertain,
   * paused or failed phase by itself.
   */
  agentDecision(matchId: string, seat: Seat, decision: 'retry' | 'switch-model' | 'takeover', publicModelLabel?: string): Promise<void>;
  /**
   * Attaches a match and shows it.
   *
   * The credential authorizes the seat. A committed assignment uses it.
   */
  attachAndFocus(matchId: string, seat: Seat, credential?: OnlineCredential): void;
  /**
   * Resumes the durable matches of the current identity.
   *
   * Only the matches whose credential the browser still holds are resumed.
   */
  resume(): void;
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

/** One registered seat credential of this browser. */
interface RegisteredSeat {
  readonly credential: GuestOnlineCredential;
  /** The identity that owns the seat authority. */
  readonly owner: 'account' | 'guest';
}

function readIntent(storage: OnlineCompositionOptions['storage'], identity: string): QueueIntent | null {
  try {
    const raw = storage?.getItem(intentKey(identity));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.accountId !== identity) return null;
    const id = record.clientRequestId;
    if (typeof id !== 'string' || id.length < 8) return null;
    const settings = typeof record.settings === 'string' ? record.settings : '';
    return { accountId: identity, clientRequestId: id, settings };
  } catch {
    return null;
  }
}

function writeIntent(storage: OnlineCompositionOptions['storage'], intent: QueueIntent): void {
  try {
    storage?.setItem(intentKey(intent.accountId), JSON.stringify(intent));
  } catch {
    // A browser that refuses the storage keeps the intent in memory only.
  }
}

function clearIntent(storage: OnlineCompositionOptions['storage'], identity: string): void {
  try {
    storage?.removeItem(intentKey(identity));
  } catch {
    // Nothing to clear.
  }
}

/**
 * The storage key of the intent of one identity.
 *
 * The key is namespaced by the identity, so two accounts of one browser never
 * share an idempotency key.
 */
function intentKey(identity: string): string {
  return `${ONLINE_QUEUE_INTENT_KEY}:${encodeURIComponent(identity)}`;
}

/** The settings of one entry, as the service hashes them. */
function intentSettings(control: SeatControl, timeControl: TimeControl): string {
  const label = control.kind === 'human' ? '' : control.modelLabel ?? '';
  return [control.kind, label, timeControl.startingTimeMs, timeControl.incrementMs].join('|');
}

/**
 * The idempotency key of one queue operation.
 *
 * The same operation of the same entry always carries the same key, so a
 * retry answers with the stored result instead of performing it twice.
 */
function operationId(kind: string, entryId: string): string {
  return `${kind}-${entryId}`.replace(/[^A-Za-z0-9_-]/g, '-');
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

/** Reads the assignment of the typed queue client. */
function toQueueAssignment(assignment: QueueAssignment): OnlineQueueAssignment {
  return {
    matchId: assignment.matchId,
    seat: assignment.seat,
    opponentLabel: assignment.opponentLabel,
    control: assignment.control,
  };
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
  const timers = options.timers ?? {
    setTimer: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const listeners = new Set<() => void>();
  /** The registered seat credentials of this browser. */
  const seats = new Map<string, RegisteredSeat>();
  /** The requesters of the guest seats, one per seat. */
  const guestRequesters = new Map<string, AuthorizedRequester>();
  const guestSessions = new Map<string, ParticipantSession>();
  /** The browser engine seats of the fallback games. */
  const engineSeats = new Map<string, OnlineEngineSeat>();
  /** The browser runners of the owner's own agent seats. */
  const agentRunners = new Map<string, OnlineProviderRunner>();
  /** The seats that are driven by a guest seat credential. */
  const guestSeats = new Set<string>();
  /** The private binding of a canonical public label of the service. */
  const agentBindings = new Map<string, { readonly canonicalLabel: string; readonly selection: ModelSelection }>();
  /** The presence clients of the attached matches. */
  const presenceClients = new Map<string, OnlinePresenceClient>();
  /** The version the engine seat already played. */
  const engineTurns = new Map<string, number>();
  let features: OnlineFeatureFlags = options.features ?? ONLINE_FEATURES_DISABLED;
  let agent: OnlineAgent | null = null;
  let queueState: OnlineQueueState = {
    phase: 'idle',
    entry: null,
    detail: '',
    assignment: null,
    engineState: 'idle',
    cutoffAt: null,
    options: [],
  };
  let pollTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  let disposed = false;

  const workspace = createOnlineWorkspace({
    baseUrl,
    ...(fetcher ? { fetch: fetcher } : {}),
    ...(options.accountSession ? { accountSession: options.accountSession } : {}),
    onChange: () => {
      notify();
      driveEngineSeats();
      driveAgentSeats();
      scheduleBackgroundWork();
    },
  });

  /** The participant session of the signed-in account, when there is one. */
  let accountParticipant: ParticipantSession | null = null;
  let accountRequesterInstance: AuthorizedRequester | null = null;
  let unsubscribeAccount: (() => void) | null = null;
  /** The identity key of the account the session currently holds. */
  let accountKey: string | null = null;
  if (options.accountSession) {
    accountParticipant = createParticipantSession({ accountSession: options.accountSession });
    accountRequesterInstance = createAuthorizedRequester({
      session: accountParticipant,
      baseUrl,
      ...(fetcher ? { fetch: fetcher } : {}),
    });
    accountKey = accountParticipant.accountId === null ? null : `account:${accountParticipant.accountId}`;
    // An identity change fences the state of the previous identity. A token
    // refresh of the same account changes nothing.
    unsubscribeAccount = options.accountSession.subscribe(identity => {
      if (disposed) return;
      const nextKey = identity === null ? null : `account:${identity.accountId}`;
      if (nextKey === accountKey) {
        // The same account, a refreshed token. The games, the queue and the
        // engine seats keep their authority.
        return;
      }
      accountKey = nextKey;
      queue.reset();
      fenceAccountSeats();
      notify();
    });
  }

  function accountRequester(): AuthorizedRequester | null {
    return accountRequesterInstance;
  }

  /**
   * The identity that owns the queue entries of this browser.
   *
   * The signed-in account owns the queue, and a signed-out browser owns its
   * own entries. The intent key is namespaced by it, so two identities of one
   * browser never share an idempotency key.
   */
  function queueIdentity(): string {
    const accountId = accountParticipant?.accountId ?? null;
    return accountId === null ? 'guest' : `account:${accountId}`;
  }

  /**
   * The credential header of the active participant.
   *
   * The credential travels in the header only. The friend and the privacy
   * routes accept an account session, a guest seat credential or no
   * credential at all, and the browser never sends one it does not hold.
   */
  async function credentialHeader(): Promise<Record<string, string> | null> {
    const credential = accountParticipant?.credential ?? null;
    if (!credential) return null;
    const token = await credential.issue();
    return credential.kind === 'account'
      ? { Authorization: `Bearer ${token}` }
      : { 'X-Guest-Seat-Token': token };
  }

  const friends: FriendClient = createFriendClient({
    baseUrl,
    ...(fetcher ? { fetch: fetcher } : {}),
    credentials: { header: credentialHeader },
  });

  const publicHistory = {
    replay(matchId: string): Promise<OnlinePublicReplay> {
      return fetchOnlinePublicReplay(matchId, { baseUrl, ...(fetcher ? { fetch: fetcher } : {}) });
    },
    history(profileId: string): Promise<OnlineProfileHistory> {
      return fetchOnlineProfileHistory(profileId, { baseUrl, ...(fetcher ? { fetch: fetcher } : {}) });
    },
  };

  const privacy = {
    deleteAccount(): Promise<OnlineRemovalReport> {
      const requester = accountRequester();
      if (!requester) throw new Error('The account is not signed in.');
      return requestAccountDeletion(requester);
    },
    removeAccount(): Promise<OnlineRemovalReport> {
      const requester = accountRequester();
      if (!requester) throw new Error('The account is not signed in.');
      return requestExplicitRemoval(requester);
    },
    removeGuest(matchId: string, seat: Seat): Promise<OnlineRemovalReport> {
      const authority = seatAuthority(matchId, seat);
      if (!authority) throw new Error('The seat is not authorized.');
      return requestGuestRemoval(authority.requester, matchId, seat);
    },
    registerPublicModelLabel(publicLabel: string): Promise<OnlinePublicModelLabel> {
      const requester = accountRequester();
      if (!requester) throw new Error('The account is not signed in.');
      return registerPublicModelLabel(requester, publicLabel);
    },
  };

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  /** Disposes the seat authority the previous account held. */
  function fenceAccountSeats(): void {
    for (const [key, registered] of [...seats]) {
      if (registered.owner !== 'account') continue;
      seats.delete(key);
      const requester = guestRequesters.get(key);
      if (requester) {
        requester.dispose();
        guestRequesters.delete(key);
      }
      const session = guestSessions.get(key);
      if (session) {
        session.dispose();
        guestSessions.delete(key);
      }
      const engine = engineSeats.get(key);
      if (engine) {
        engine.dispose();
        engineSeats.delete(key);
      }
      engineTurns.delete(key);
    }
  }

  const queueRequester = createAuthorizedRequester({
    session: accountParticipant ?? createParticipantSession(),
    baseUrl,
    ...(fetcher ? { fetch: fetcher } : {}),
  });

  /**
   * The typed queue client of the queue worker.
   *
   * The client owns the routes and the answer shapes. The composition only
   * supplies the authorized request boundary.
   */
  const queueClient: QueueClient = createQueueClient(async (request) => {
    const result = await queueRequester.request({ kind: 'account' }, {
      path: request.path,
      method: request.method,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    if (!result.ok) {
      const failure = new Error(`The service refused the queue request (${result.status}).`);
      (failure as { status?: number }).status = result.status;
      throw failure;
    }
    return result.data;
  });

  const queue = createOnlineQueueController({
    timers,
    ports: {
      checkAgent: async (control: SeatControl): Promise<OnlineAgentCheck> => {
        if (control.kind !== 'agent') return { ready: true, detail: '' };
        if (!agent) return { ready: false, detail: 'Choose your agent first.' };
        if (!options.checkModel) return { ready: false, detail: 'The agent check is unavailable.' };
        return options.checkModel(agent.selection);
      },
      prepareEngine: options.prepareEngine ?? (async () => {
        throw new Error('The browser engine is not available.');
      }),
      acceptReady: async request => {
        const identity = queueIdentity();
        const settings = intentSettings(request.control, request.timeControl);
        const stored = readIntent(storage, identity);
        // A settings change is a new explicit intent. The stored intent never
        // blocks the owner with a conflict.
        const reusable = stored !== null && stored.settings === settings;
        const intent = reusable
          ? stored
          : { accountId: identity, clientRequestId: createIntentId(), settings };
        if (!reusable) {
          if (stored !== null) clearIntent(storage, identity);
          writeIntent(storage, intent);
        }
        try {
          const created = await queueClient.createEntry({
            schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
            control: request.control,
            timeControl: request.timeControl,
            clientRequestId: intent.clientRequestId,
          });
          // The service canonicalizes the label of the seat. The canonical
          // label binds the private selection of the agent.
          if (created.control.kind === 'agent' && created.control.modelLabel) {
            bindAgentLabel(created.control.modelLabel);
          }
          return created;
        } catch (error) {
          // A refused creation releases the intent, so the owner can try
          // again with the same or with other settings.
          clearIntent(storage, identity);
          throw error;
        }
      },
      readEntry: entryId => queueClient.readEntry(entryId),
      readyEntry: entryId => queueClient.ready(entryId),
      readMatch: async matchId => {
        const requester = accountRequester();
        if (!requester) throw new Error('No participant credential is available.');
        const result = await requester.request({ kind: 'account' }, { path: `/v1/online/matches/${encodeURIComponent(matchId)}` });
        if (!result.ok) throw new Error('The match could not be read.');
        return parseOnlineMatchView(result.data, matchId);
      },
      cancelEntry: entryId => queueClient.cancel(entryId, queueOperationBody(operationId('cancel', entryId))),
      keepSearching: entryId => queueClient.keepSearching(entryId, queueOperationBody(operationId('keep', entryId))),
      findCompatibleEntry: async entryId => {
        try {
          const assignment = await queueClient.match(entryId, queueOperationBody(operationId('match', entryId)));
          return toQueueAssignment(assignment);
        } catch (error) {
          // A missing candidate is not an error.
          if ((error as { status?: number }).status === 404) return null;
          throw error;
        }
      },
      commitFallback: async entryId => {
        const assignment = await queueClient.fallback(entryId, queueOperationBody(operationId('fallback', entryId)));
        const credential = assignment.guestCredential;
        if (credential) {
          const expiry = readExpiry(credential.expiresAt);
          registerGuestCredential(createGuestCredential({
            guestId: credential.guestId,
            matchId: credential.matchId,
            seat: credential.seat,
            token: credential.token,
            ...(expiry === undefined ? {} : { expiresAt: expiry }),
          }), 'account');
        }
        return toQueueAssignment(assignment);
      },
    },
    onState: state => {
      queueState = state;
      // A terminal entry releases the stored intent. The next explicit entry
      // starts a fresh one.
      if (state.phase === 'matched' || state.phase === 'cancelled' || state.phase === 'expired') {
        clearIntent(storage, queueIdentity());
      }
      // A committed assignment is attached and shown.
      if (state.phase === 'matched' && state.assignment) {
        attachAndFocus(state.assignment.matchId, state.assignment.seat);
      }
      notify();
      scheduleBackgroundWork();
    },
  });

  function registerGuestCredential(credential: GuestOnlineCredential, owner: 'account' | 'guest' = 'guest'): void {
    const key = `${credential.matchId}:${credential.seat}`;
    const previous = seats.get(key);
    if (previous && previous.credential !== credential) {
      // A re-minted credential replaces the old one. The old session and its
      // requester are released, so the seat never keeps a revoked token.
      const requester = guestRequesters.get(key);
      if (requester) {
        requester.dispose();
        guestRequesters.delete(key);
      }
      const session = guestSessions.get(key);
      if (session) {
        session.dispose();
        guestSessions.delete(key);
      }
    }
    seats.set(key, { credential, owner });
    if (owner === 'guest') guestSeats.add(key);
    notify();
  }

  function credentialFor(matchId: string, seat: Seat): OnlineCredential | null {
    const registered = seats.get(`${matchId}:${seat}`);
    if (registered) return registered.credential;
    if (accountParticipant && accountParticipant.credential) return accountParticipant.credential;
    return null;
  }

  function commandClient(matchId: string, seat: Seat, credential?: OnlineCredential): OnlineMatchCommandClient | null {
    const authority = seatAuthority(matchId, seat, credential);
    if (!authority) return null;
    return createOnlineMatchCommandClient({
      requester: authority.requester,
      session: authority.session,
      matchId,
      seat,
    });
  }

  /**
   * The authority of one seat.
   *
   * A guest seat owns a scoped session and a scoped requester. An account
   * seat uses the signed-in session. The authority of one seat never acts
   * for another seat.
   */
  function seatAuthority(
    matchId: string,
    seat: Seat,
    credential?: OnlineCredential,
  ): { session: ParticipantSession; requester: AuthorizedRequester } | null {
    const key = `${matchId}:${seat}`;
    const registered = seats.get(key);
    const guest = credential ?? registered?.credential ?? null;
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
      return { session, requester };
    }
    // A guest seat is never driven with the account credential. The seat
    // authority fails closed instead of acting for another participant.
    if (guestSeats.has(key)) return null;
    if (!accountParticipant || !accountRequesterInstance) return null;
    return { session: accountParticipant, requester: accountRequesterInstance };
  }

  function presenceClient(matchId: string, seat: Seat, credential?: OnlineCredential): OnlinePresenceClient | null {
    const authority = seatAuthority(matchId, seat, credential);
    if (!authority) return null;
    return createOnlinePresenceClient({
      requester: authority.requester,
      session: authority.session,
      matchId,
      seat,
    });
  }

  function attachAndFocus(matchId: string, seat: Seat, credential?: OnlineCredential): void {
    const authority = credential ?? credentialFor(matchId, seat);
    if (!authority) return;
    const binding: OnlineSeatBinding = { matchId, seat, credential: authority };
    workspace.attach(binding);
    workspace.focus(matchId);
  }

  /**
   * Plays the engine turn of every attached fallback game.
   *
   * The engine seat is the seat the service declared as an engine seat. The
   * turn belongs to it when the canonical position or the opening reply says
   * so, and the answer carries the runner lease of the turn.
   */
  function driveEngineSeats(): void {
    for (const game of workspace.games) {
      const view = game.snapshot;
      if (!view || view.status !== 'active') continue;
      const engineSeat = view.seats.find(candidate => candidate.seat !== view.yourSeat && candidate.control.kind === 'engine');
      if (!engineSeat) continue;
      const key = `${view.matchId}:${engineSeat.seat}`;
      const registered = seats.get(key);
      if (!registered) continue;
      if (engineTurns.get(key) === view.version) continue;
      const sideToMove = view.positionFen.split(' ')[1] === 'b' ? 'black' : 'white';
      const replySeat = view.clock.replySeat;
      const isTurn = replySeat !== null ? replySeat === engineSeat.seat : sideToMove === engineSeat.seat;
      if (!isTurn) continue;
      engineTurns.set(key, view.version);
      let engine = engineSeats.get(key);
      if (!engine) {
        engine = createOnlineEngineSeat({
          matchId: view.matchId,
          seat: engineSeat.seat,
          credential: registered.credential,
          baseUrl,
          ...(fetcher ? { fetch: fetcher } : {}),
          ...(options.prepareEngine ? { prepareEngine: options.prepareEngine } : {}),
        });
        engineSeats.set(key, engine);
      }
      void engine.play(view).then(result => {
        if (result.kind === 'failed') {
          // A failed engine turn is reported and never retried silently. The
          // owner may take over the seat.
          engineTurns.delete(key);
          notify();
        }
      }).catch(() => {
        engineTurns.delete(key);
      });
    }
  }

  /**
   * Registers the public label of the owner's own agent.
   *
   * The service canonicalizes a model label: a known public name becomes its
   * public form, and an unknown name becomes a generic one unless the owner
   * registered it. The registration therefore happens before the owner asks
   * for a queue entry, a friend invitation or a control change, and the
   * canonical label the service answers binds the private selection.
   */
  async function registerAgentLabel(): Promise<string | null> {
    if (!agent) return null;
    const registered = agentBindings.get(agent.label);
    if (registered) return registered.canonicalLabel;
    try {
      const label = await privacy.registerPublicModelLabel(agent.label);
      bindAgentLabel(label.publicLabel);
      return label.publicLabel;
    } catch {
      // A registration that fails leaves the chosen label. The service then
      // canonicalizes it, and the answer of the service binds the label.
      return null;
    }
  }

  /** Binds a canonical label of the service to the private selection. */
  function bindAgentLabel(canonicalLabel: string): void {
    if (!agent || canonicalLabel.length === 0) return;
    agentBindings.set(canonicalLabel, { canonicalLabel, selection: agent.selection });
  }

  /**
   * Plays the turn of the owner's own agent seat.
   *
   * The runner of the provider module owns the turn: it takes the lease,
   * asks the provider and submits the answer. The composition only feeds it
   * the canonical state and shows its decisions.
   */
  function driveAgentSeats(): void {
    if (!agent) return;
    for (const game of workspace.games) {
      const view = game.snapshot;
      if (!view || view.status !== 'active') continue;
      const ownSeat = view.yourSeat;
      if (ownSeat === null) continue;
      const seatView = view.seats.find(candidate => candidate.seat === ownSeat);
      if (!seatView || seatView.control.kind !== 'agent') continue;
      // The browser runs the agent of the owner. The binding is the one the
      // service answered, never a guess from the label of the routing
      // identity.
      const seatLabel = seatView.control.modelLabel;
      const binding = seatLabel ? agentBindings.get(seatLabel) : undefined;
      if (!binding) continue;
      const key = `${view.matchId}:${ownSeat}`;
      let runner = agentRunners.get(key);
      if (!runner) {
        const authority = seatAuthority(view.matchId, ownSeat);
        if (!authority) continue;
        const leases = createOnlineRunnerLeaseClient({
          requester: authority.requester,
          session: authority.session,
          matchId: view.matchId,
          seat: ownSeat,
          runnerId: `${view.matchId}-${ownSeat}-${agentRunners.size + 1}`,
        });
        const commands = commandClient(view.matchId, ownSeat);
        if (!commands) continue;
        const provider = options.connectionStore
          ? createAgentProviderPort({
            connectionStore: options.connectionStore,
            namespace: options.namespace ?? { kind: 'guest' },
            selection: binding.selection,
          })
          : null;
        if (!provider) continue;
        runner = createOnlineAgentSeat({
          matchId: view.matchId,
          seat: ownSeat,
          publicModelLabel: binding.canonicalLabel,
          leases,
          commands,
          provider,
        });
        agentRunners.set(key, runner);
        runner.subscribe(() => notify());
      }
      runner.applySnapshot(providerRunnerSnapshot(view, ownSeat));
      void runner.start().catch(() => undefined);
    }
  }

  /** Polls a waiting entry and reports in for every attached match. */
  function scheduleBackgroundWork(): void {
    if (pollTimer !== null) {
      timers.clearTimer(pollTimer);
      pollTimer = null;
    }
    if (heartbeatTimer !== null) {
      timers.clearTimer(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (disposed) return;
    const entry = queueState.entry;
    if (queueState.phase === 'searching' && entry) {
      pollTimer = timers.setTimer(() => {
        pollTimer = null;
        // The entry is renewed and read. The heartbeat keeps the readiness
        // lease alive while the owner waits.
        void queueClient.heartbeat(entry.entryId).catch(() => undefined);
        void queueClient.readEntry(entry.entryId).then(current => {
          if (disposed) return;
          queue.observe(current);
        }).catch(() => {
          // A failed poll is retried by the next interval.
        });
        scheduleBackgroundWork();
      }, ONLINE_QUEUE_POLL_INTERVAL_MS);
    }
    const attached = workspace.games;
    if (attached.length > 0) {
      heartbeatTimer = timers.setTimer(() => {
        heartbeatTimer = null;
        for (const game of attached) {
          const client = presenceClient(game.matchId, game.seat);
          if (!client) continue;
          void client.heartbeat().catch(() => {
            // A failed heartbeat is retried by the next interval.
          });
        }
        scheduleBackgroundWork();
      }, ONLINE_PRESENCE_HEARTBEAT_MS);
    }
  }

  return {
    get features() {
      return features;
    },
    workspace,
    queue,
    friends,
    publicHistory,
    privacy,
    get queueState() {
      return queueState;
    },
    get agent() {
      return agent;
    },
    setAgent(next) {
      agent = next;
      notify();
    },
    async enterQueue(request, enterOptions) {
      if (enterOptions?.intent === 'new') {
        // An explicit second game replaces the stored intent.
        clearIntent(storage, queueIdentity());
      }
      if (request.control.kind === 'agent') {
        // The chosen public label is registered before the service accepts
        // the seat, so the service keeps the label the owner chose.
        await registerAgentLabel();
      }
      await queue.enter(request);
    },
    async registerAgentLabel() {
      return registerAgentLabel();
    },
    commandClient,
    registerGuestCredential,
    presenceClient,
    agentRunnerState(matchId, seat) {
      return agentRunners.get(`${matchId}:${seat}`)?.state ?? null;
    },
    async agentDecision(matchId, seat, decision, publicModelLabel) {
      const runner = agentRunners.get(`${matchId}:${seat}`);
      if (!runner) return;
      if (decision === 'retry') await runner.retry();
      else if (decision === 'switch-model') await runner.switchModel(publicModelLabel ?? agent?.label ?? 'Agent');
      else await runner.takeover();
    },
    attachAndFocus,
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
    resume() {
      if (disposed) return;
      const accountId = accountParticipant?.accountId ?? null;
      if (accountId === null) return;
      const key = `account:${accountId}`;
      const entries = workspace.persisted(key);
      for (const entry of entries) {
        const credential = accountParticipant?.credential;
        if (!credential) continue;
        workspace.attach({ matchId: entry.matchId, seat: entry.seat, credential });
      }
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
      if (disposed) return;
      disposed = true;
      unsubscribeAccount?.();
      unsubscribeAccount = null;
      if (pollTimer !== null) timers.clearTimer(pollTimer);
      if (heartbeatTimer !== null) timers.clearTimer(heartbeatTimer);
      pollTimer = null;
      heartbeatTimer = null;
      workspace.dispose();
      queue.dispose();
      accountParticipant?.dispose();
      accountParticipant = null;
      accountRequesterInstance?.dispose();
      accountRequesterInstance = null;
      for (const engine of engineSeats.values()) engine.dispose();
      engineSeats.clear();
      for (const requester of guestRequesters.values()) requester.dispose();
      for (const session of guestSessions.values()) session.dispose();
      guestRequesters.clear();
      guestSessions.clear();
      seats.clear();
      presenceClients.clear();
      engineTurns.clear();
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

/** The match view of a participant, read from the service. */
export async function readOnlineMatch(
  requester: AuthorizedRequester,
  matchId: string,
): Promise<OnlineMatchView> {
  const result = await requester.request({ kind: 'account' }, { path: `/v1/online/matches/${encodeURIComponent(matchId)}` });
  if (!result.ok) throw new Error('The match could not be read.');
  return parseOnlineMatchView(result.data, matchId);
}
