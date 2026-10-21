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
import { createFriendSurface } from './friend-routes';
import { createFriendSecretStore } from './friend-secrets';
import type { FriendSurface } from './friend-routes';
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
import type { QueueEntry, Seat, SeatControl, TimeControl } from './contracts';
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
  readonly key: string;
  readonly settings: string;
  readonly control: SeatControl;
  readonly timeControl: TimeControl;
  readonly entryId: string | null;
  readonly recordId: string;
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

/** One explicit queue entry of the browser. */
export interface OnlineQueueEntryView {
  /** The local identifier of the entry. */
  readonly id: string;
  /** The identifier of the entry in the service, when it was created. */
  readonly entryId: string | null;
  /** The state of the entry. */
  readonly state: OnlineQueueState;
  /** Cancels this entry. An older entry keeps its own state and timer. */
  cancel(): Promise<void>;
  /** Shows this entry in the interface. */
  focus(): void;
  /** Feeds a service answer into this entry. */
  observe(entry: QueueEntry): void;
}

export interface OnlineComposition {
  /** The open online surfaces. */
  readonly features: OnlineFeatureFlags;
  /** The concurrent game workspace. */
  readonly workspace: OnlineWorkspace;
  /** The queue flow of this browser. */
  readonly queue: OnlineQueueController;
  /** Every explicit entry of this browser. */
  readonly queueEntries: readonly OnlineQueueEntryView[];
  /** The current queue state. */
  readonly queueState: OnlineQueueState;
  /** The friend invitation and rematch client of this browser. */
  readonly friends: FriendSurface;
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
  /** True when a signed-in account owns this composition. */
  readonly accountSignedIn: boolean;
  /** Sets the own agent of the owner. */
  setAgent(agent: OnlineAgent | null): void;
  /**
   * Publishes the agents the owner may play.
   *
   * The catalog maps a public label to a private selection. A switch resolves
   * the private selection of the new label, so an old selection is never
   * relabelled as a new model.
   */
  setAgentCatalog(entries: readonly { label: string; selection: ModelSelection }[]): void;
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
  resumeMatches(): void;
  /** Reads the feature flags of the service. */
  loadFeatures(): Promise<OnlineFeatureFlags>;
  /** Registers a listener for every change. */
  subscribe(listener: () => void): () => void;
  /**
   * Stops the background work of this composition.
   *
   * The poll, the presence heartbeat and the browser runners stop, and the
   * runner leases are released. The games stay visible and the composition
   * can be resumed.
   */
  suspend(): void;
  /** Starts the background work of this composition again. */
  resume(): void;
  /** Releases every resource. */
  dispose(): void;
}


/** One registered seat credential of this browser. */
interface RegisteredSeat {
  readonly credential: GuestOnlineCredential;
  /** The identity that owns the seat authority. */
  readonly owner: 'account' | 'guest';
}

/** Reads every intent of one identity. */
function readIntents(storage: OnlineCompositionOptions['storage'], identity: string): QueueIntent[] {
  try {
    const raw = storage?.getItem(intentKey(identity));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const intents: QueueIntent[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const key = record.key;
      if (typeof key !== 'string' || key.length < 8) continue;
      const control = record.control;
      if (typeof control !== 'object' || control === null) continue;
      const timeControl = record.timeControl;
      if (typeof timeControl !== 'object' || timeControl === null) continue;
      intents.push({
        key,
        settings: typeof record.settings === 'string' ? record.settings : '',
        control: control as SeatControl,
        timeControl: timeControl as TimeControl,
        entryId: typeof record.entryId === 'string' ? record.entryId : null,
        recordId: typeof record.recordId === 'string' ? record.recordId : '',
      });
    }
    return intents;
  } catch {
    return [];
  }
}

/** Writes the intents of one identity. */
function writeIntents(storage: OnlineCompositionOptions['storage'], identity: string, intents: readonly QueueIntent[]): void {
  try {
    if (intents.length === 0) {
      storage?.removeItem(intentKey(identity));
      return;
    }
    storage?.setItem(intentKey(identity), JSON.stringify(intents));
  } catch {
    // A browser that refuses the storage keeps the intent in memory only.
  }
}

/**
 * The storage key of the intents of one identity.
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

/**
 * True when the service definitively refused a request.
 *
 * A refusal with a status means the service did not perform the operation.
 * A transport failure or a server failure means the outcome is unknown: the
 * service may have committed it, so the idempotency key has to survive.
 */
function isDefinitiveRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== 'number' || !Number.isFinite(status)) return false;
  return status >= 400 && status < 500;
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
  /**
   * The private binding of one seat.
   *
   * The binding is per seat of one match, never per public label: two private
   * models can carry the same canonical public label, and a seat must never
   * be played by another model.
   */
  const agentBindings = new Map<string, { readonly label: string; readonly selection: ModelSelection }>();
  /** The agents the owner may play, by their public label. */
  const agentCatalog = new Map<string, ModelSelection>();
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
  let heartbeatTimer: unknown = null;
  /** True while the composition is superseded by another identity. */
  let suspended = false;
  let disposed = false;

  /** The browser owned secrets of the friend surface. */
  const friendSecrets = createFriendSecretStore({ identity: 'guest' });

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
      // The secrets of the friend surface follow the identity. The records of
      // the previous identity never reach the new one.
      friendSecrets.setIdentity(queueIdentity());
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

  friendSecrets.setIdentity(queueIdentity());
  const friends: FriendSurface = createFriendSurface({
    baseUrl,
    ...(fetcher ? { fetch: fetcher } : {}),
    credential: () => credentialHeader(),
    secrets: friendSecrets,
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

  /**
   * The ports of one queue entry.
   *
   * Every explicit entry owns its own controller, its own poll timer and its
   * own state. An older entry keeps waiting while a newer one is created.
   */
  function queuePortsFor(record: QueueRecord) {
    return {
      checkAgent: async (control: SeatControl): Promise<OnlineAgentCheck> => {
        if (control.kind !== 'agent') return { ready: true, detail: '' };
        if (!agent) return { ready: false, detail: 'Choose your agent first.' };
        if (!options.checkModel) return { ready: false, detail: 'The agent check is unavailable.' };
        return options.checkModel(agent.selection);
      },
      prepareEngine: options.prepareEngine ?? (async () => {
        throw new Error('The browser engine is not available.');
      }),
      acceptReady: async (request: { control: SeatControl; timeControl: TimeControl }) => {
        const identity = queueIdentity();
        const settings = intentSettings(request.control, request.timeControl);
        const intents = readIntents(storage, identity);
        const own = intents.filter(intent => intent.recordId === record.id);
        const previous = own.length > 0 ? own[own.length - 1]! : null;
        if (previous && previous.settings !== settings) {
          // A settings change resolves the entry of the previous intent
          // first, so the service never keeps an abandoned entry.
          await resolveIntentEntry(previous, identity);
        }
        const current = readIntents(storage, identity);
        const reusable = previous !== null && previous.settings === settings
          ? current.find(intent => intent.key === previous.key) ?? previous
          : null;
        const intent: QueueIntent = reusable ?? {
          key: createIntentId(),
          settings,
          control: request.control,
          timeControl: request.timeControl,
          entryId: null,
          recordId: record.id,
        };
        writeIntents(storage, identity, [
          ...current.filter(existing => existing.key !== intent.key),
          intent,
        ]);
        try {
          const created = await queueClient.createEntry({
            schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
            control: request.control,
            timeControl: request.timeControl,
            clientRequestId: intent.key,
          });
          // The entry of the intent is tracked, so a later settings change can
          // resolve it instead of abandoning it.
          upsertIntent(intent.key, { ...intent, entryId: created.entryId });
          // The seat of the entry is the seat of the owner. The private
          // selection of the owner is bound to it, so the seat is never played
          // by another model.
          if (created.control.kind === 'agent') {
            bindAgentSeat(created.entryId, 'white', created.control.modelLabel ?? agent?.label ?? 'Agent');
          }
          return created;
        } catch (error) {
          // A definitive refusal releases the intent. An unknown answer keeps
          // it, so the retry reaches the same entry instead of a second one.
          if (isDefinitiveRefusal(error)) removeIntent(intent.key);
          throw error;
        }
      },
      readEntry: (entryId: string) => queueClient.readEntry(entryId),
      readyEntry: (entryId: string) => queueClient.ready(entryId),
      readMatch: async (matchId: string) => {
        const requester = accountRequester();
        if (!requester) throw new Error('No participant credential is available.');
        const result = await requester.request({ kind: 'account' }, { path: `/v1/online/matches/${encodeURIComponent(matchId)}` });
        if (!result.ok) throw new Error('The match could not be read.');
        return parseOnlineMatchView(result.data, matchId);
      },
      cancelEntry: (entryId: string) => queueClient.cancel(entryId, queueOperationBody(operationId('cancel', entryId))),
      keepSearching: (entryId: string) => queueClient.keepSearching(entryId, queueOperationBody(operationId('keep', entryId))),
      findCompatibleEntry: async (entryId: string) => {
        try {
          const assignment = await queueClient.match(entryId, queueOperationBody(operationId('match', entryId)));
          return toQueueAssignment(assignment);
        } catch (error) {
          // A missing candidate is not an error.
          if ((error as { status?: number }).status === 404) return null;
          throw error;
        }
      },
      commitFallback: async (entryId: string) => {
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
    };
  }

  /** Replaces one intent of the active identity. */
  function upsertIntent(key: string, intent: QueueIntent): void {
    const identity = queueIdentity();
    const intents = readIntents(storage, identity);
    writeIntents(storage, identity, [
      ...intents.filter(existing => existing.key !== key),
      intent,
    ]);
  }

  /** Removes one intent of the active identity. */
  function removeIntent(key: string): void {
    const identity = queueIdentity();
    const intents = readIntents(storage, identity);
    writeIntents(storage, identity, intents.filter(existing => existing.key !== key));
  }

  /**
   * Resolves the entry of one intent.
   *
   * The entry id can be unknown when the creation answer was lost. The same
   * key with the original settings answers with the same entry, so the entry
   * is recovered before it is cancelled. A cancellation whose outcome is
   * unknown keeps the entry tracked.
   */
  async function resolveIntentEntry(intent: QueueIntent, identity: string): Promise<void> {
    let entryId = intent.entryId;
    if (entryId === null) {
      try {
        const recovered = await queueClient.createEntry({
          schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
          control: intent.control,
          timeControl: intent.timeControl,
          clientRequestId: intent.key,
        });
        entryId = recovered.entryId;
        upsertIntent(intent.key, { ...intent, entryId });
      } catch {
        // The outcome is unknown. The entry stays tracked, so a later retry
        // resolves it instead of abandoning it.
        return;
      }
    }
    try {
      await queueClient.cancel(entryId, queueOperationBody(operationId('cancel', entryId)));
      removeIntent(intent.key);
    } catch (error) {
      // A definitive refusal means the entry is gone or committed. An
      // unknown outcome keeps the entry tracked.
      if (isDefinitiveRefusal(error)) removeIntent(intent.key);
    }
    void identity;
  }

  /**
   * One explicit queue entry of this browser.
   *
   * The record owns its controller, its state and its poll timer. An older
   * entry keeps its own timer, so it stays eligible while a newer entry is
   * created.
   */
  interface QueueRecord {
    readonly id: string;
    controller: OnlineQueueController;
    state: OnlineQueueState;
    pollTimer: unknown;
  }

  const queueRecords = new Map<string, QueueRecord>();
  let activeQueueId: string | null = null;

  function createQueueRecord(): QueueRecord {
    const id = `queue-${queueRecords.size + 1}`;
    const record: QueueRecord = {
      id,
      controller: null as unknown as OnlineQueueController,
      state: {
        phase: 'idle',
        entry: null,
        detail: '',
        assignment: null,
        engineState: 'idle',
        cutoffAt: null,
        options: [],
      },
      pollTimer: null,
    };
    record.controller = createOnlineQueueController({
      timers,
      ports: queuePortsFor(record),
      onState: state => {
        record.state = state;
        if (activeQueueId === id) queueState = state;
        // A terminal entry releases the intent of *this* record. The intent of
        // another entry stays untouched.
        if (state.phase === 'matched' || state.phase === 'cancelled' || state.phase === 'expired') {
          const identity = queueIdentity();
          for (const intent of readIntents(storage, identity)) {
            if (intent.recordId === id) removeIntent(intent.key);
          }
        }
        // A committed assignment is attached and shown.
        if (state.phase === 'matched' && state.assignment) {
          attachAndFocus(state.assignment.matchId, state.assignment.seat);
        }
        notify();
        scheduleQueueWork(record);
      },
    });
    queueRecords.set(id, record);
    activeQueueId = id;
    return record;
  }

  /** The controller of the active entry. */
  const queue: OnlineQueueController = {
    get state() {
      const record = activeQueueId === null ? null : queueRecords.get(activeQueueId) ?? null;
      return record?.state ?? queueState;
    },
    enter: async (request: { control: SeatControl; timeControl: TimeControl }) => {
      const record = createQueueRecord();
      await record.controller.enter(request);
    },
    retry: async () => {
      const record = activeQueueId === null ? null : queueRecords.get(activeQueueId) ?? null;
      await record?.controller.retry();
    },
    playYourself: async () => {
      const record = activeQueueId === null ? null : queueRecords.get(activeQueueId) ?? null;
      await record?.controller.playYourself();
    },
    keepSearching: async () => {
      const record = activeQueueId === null ? null : queueRecords.get(activeQueueId) ?? null;
      await record?.controller.keepSearching();
    },
    cancel: async () => {
      const record = activeQueueId === null ? null : queueRecords.get(activeQueueId) ?? null;
      await record?.controller.cancel();
    },
    rejoin: async () => {
      const record = activeQueueId === null ? null : queueRecords.get(activeQueueId) ?? null;
      await record?.controller.rejoin();
    },
    observe: (entry) => {
      const record = activeQueueId === null ? null : queueRecords.get(activeQueueId) ?? null;
      record?.controller.observe(entry);
    },
    reset: () => {
      for (const record of queueRecords.values()) record.controller.reset();
    },
    dispose: () => {
      for (const record of queueRecords.values()) record.controller.dispose();
    },
  };

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
    if (suspended) return;
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
    try {
      const label = await privacy.registerPublicModelLabel(agent.label);
      return label.publicLabel;
    } catch {
      // A registration that fails leaves the chosen label. The service then
      // canonicalizes it, and the public label of the seat carries the
      // canonical form.
      return null;
    }
  }

  /**
   * Binds the private selection of the owner to one seat of one match.
   *
   * The binding is stored per seat, so two private models that carry the same
   * canonical public label never share it, and a seat is never played by
   * another model. The binding stays in the browser.
   */
  function bindAgentSeat(matchId: string, seat: Seat, label: string): void {
    if (!agent) return;
    agentBindings.set(`${matchId}:${seat}`, { label, selection: agent.selection });
  }

  /**
   * Plays the turn of the owner's own agent seat.
   *
   * The runner of the provider module owns the turn: it takes the lease,
   * asks the provider and submits the answer. The composition only feeds it
   * the canonical state and shows its decisions.
   */
  function driveAgentSeats(): void {
    if (!agent || suspended) return;
    for (const game of workspace.games) {
      const view = game.snapshot;
      if (!view || view.status !== 'active') continue;
      const ownSeat = view.yourSeat;
      if (ownSeat === null) continue;
      const seatView = view.seats.find(candidate => candidate.seat === ownSeat);
      if (!seatView || seatView.control.kind !== 'agent') continue;
      // The browser runs the agent of the owner. The binding is the private
      // selection of this seat, never a guess from the public label: two
      // private models can carry the same canonical label.
      const key = `${view.matchId}:${ownSeat}`;
      const binding = agentBindings.get(key) ?? (
        agent ? { label: seatView.control.modelLabel ?? agent.label, selection: agent.selection } : null
      );
      if (!binding) continue;
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
          publicModelLabel: binding.label,
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

  /**
   * Arms the background work of one entry and of the attached matches.
   *
   * Every entry keeps its own poll timer, so an older entry stays eligible
   * while a newer entry is created.
   */
  function scheduleBackgroundWork(): void {
    if (disposed || suspended) return;
    for (const record of queueRecords.values()) scheduleQueueWork(record);
    scheduleHeartbeat();
  }

  /** Renews the readiness lease of one entry and reads its answer. */
  function scheduleQueueWork(record: QueueRecord): void {
    if (suspended) return;
    if (record.pollTimer !== null) {
      timers.clearTimer(record.pollTimer);
      record.pollTimer = null;
    }
    if (disposed) return;
    const entry = record.state.entry;
    if (record.state.phase !== 'searching' || !entry) return;
    record.pollTimer = timers.setTimer(() => {
      record.pollTimer = null;
      // The entry is renewed and read. The heartbeat keeps the readiness
      // lease alive while the owner waits.
      void queueClient.heartbeat(entry.entryId).catch(() => undefined);
      void queueClient.readEntry(entry.entryId).then(current => {
        if (disposed) return;
        record.controller.observe(current);
      }).catch(() => {
        // A failed poll is retried by the next interval.
      });
      scheduleQueueWork(record);
    }, ONLINE_QUEUE_POLL_INTERVAL_MS);
  }

  /** Reports in for every attached match. */
  function scheduleHeartbeat(): void {
    if (suspended) return;
    if (heartbeatTimer !== null) {
      timers.clearTimer(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (disposed) return;
    const attached = workspace.games;
    if (attached.length === 0) return;
    heartbeatTimer = timers.setTimer(() => {
      heartbeatTimer = null;
      for (const game of attached) {
        const client = presenceClient(game.matchId, game.seat);
        if (!client) continue;
        void client.heartbeat().catch(() => {
          // A failed heartbeat is retried by the next interval.
        });
      }
      scheduleHeartbeat();
    }, ONLINE_PRESENCE_HEARTBEAT_MS);
  }

  return {
    get features() {
      return features;
    },
    workspace,
    queue,
    get queueEntries() {
      return [...queueRecords.values()].map(record => ({
        id: record.id,
        entryId: record.state.entry?.entryId ?? null,
        state: record.state,
        cancel: async () => { await record.controller.cancel(); },
        focus: () => {
          activeQueueId = record.id;
          queueState = record.state;
          notify();
        },
        observe: (answer: QueueEntry) => {
          record.controller.observe(answer);
        },
      }));
    },
    friends,
    publicHistory,
    privacy,
    get queueState() {
      return queueState;
    },
    get agent() {
      return agent;
    },
    get accountSignedIn() {
      return accountParticipant?.credential?.kind === 'account';
    },
    setAgent(next) {
      agent = next;
      if (next) agentCatalog.set(next.label, next.selection);
      notify();
    },
    setAgentCatalog(entries) {
      agentCatalog.clear();
      for (const entry of entries) agentCatalog.set(entry.label, entry.selection);
      notify();
    },
    async enterQueue(request, enterOptions) {
      if (enterOptions?.intent === 'new') {
        // An explicit second game owns its own intent. The intents of the
        // older entries stay untouched.
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
      const key = `${matchId}:${seat}`;
      if (decision === 'switch-model') {
        // A switch changes the private selection of the seat. The old
        // selection is never relabelled as the new model, and the runner is
        // rebuilt with the destination of the new selection.
        const label = publicModelLabel ?? agent?.label ?? '';
        const selection = agentCatalog.get(label);
        if (!selection) {
          throw new Error('That agent is not connected.');
        }
        const runner = agentRunners.get(key);
        if (!runner) {
          agentBindings.set(key, { label, selection });
          return;
        }
        await runner.switchModel(label);
        agentBindings.set(key, { label, selection });
        await runner.stop().catch(() => undefined);
        agentRunners.delete(key);
        // The canonical snapshot is fed again, so the new runner plays the seat.
        driveAgentSeats();
        return;
      }
      const runner = agentRunners.get(key);
      if (!runner) return;
      if (decision === 'retry') {
        await runner.retry();
        return;
      }
      // A takeover hands the seat to the owner, so the browser stops playing
      // it.
      await runner.takeover();
      agentBindings.delete(key);
      agentRunners.delete(key);
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
    resumeMatches() {
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
    suspend() {
      if (disposed) return;
      suspended = true;
      if (heartbeatTimer !== null) {
        timers.clearTimer(heartbeatTimer);
        heartbeatTimer = null;
      }
      for (const record of queueRecords.values()) {
        if (record.pollTimer !== null) {
          timers.clearTimer(record.pollTimer);
          record.pollTimer = null;
        }
      }
      // The runners stop, and their leases are released, so a superseded
      // composition never keeps a provider request or a heartbeat alive.
      for (const runner of agentRunners.values()) void runner.stop().catch(() => undefined);
      agentRunners.clear();
      for (const engine of engineSeats.values()) void engine.dispose().catch(() => undefined);
      engineSeats.clear();
      engineTurns.clear();
    },
    resume() {
      if (disposed) return;
      suspended = false;
      scheduleBackgroundWork();
      driveAgentSeats();
      driveEngineSeats();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeAccount?.();
      unsubscribeAccount = null;
      if (heartbeatTimer !== null) timers.clearTimer(heartbeatTimer);
      for (const record of queueRecords.values()) {
        if (record.pollTimer !== null) timers.clearTimer(record.pollTimer);
        record.pollTimer = null;
      }
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
