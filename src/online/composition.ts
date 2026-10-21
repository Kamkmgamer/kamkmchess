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
import { createQueueClient, queueOperationBody, isAssignedEntry, isSearchingEntry } from './queue';
import type { QueueAssignment, QueueClient } from './queue';
import { createOnlineMatchCommandClient } from './match-client';
import type { OnlineMatchCommandClient } from './match-client';
import { createOnlineEngineSeat } from './engine-seat';
import type { OnlineEngineSeat, OnlineEngineSeatOptions } from './engine-seat';
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
import { onlineSideToMove } from './turn';
import { ONLINE_CONTRACTS_SCHEMA_VERSION } from './contracts';
import type { OnlineMatchView } from './updates';
import type { QueueEntry, Seat, SeatControl, TimeControl } from './contracts';
import type { OnlineAgentCheck } from './readiness';
import type { ModelSelection } from '../controller/index.js';
import { privateAgentId } from '../accounts/agent-catalog.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';

/** The route that answers which online surfaces are open. */
export const ONLINE_FEATURES_ROUTE = '/v1/online/features';

/** The local key of the pending queue intent. */
export const ONLINE_QUEUE_INTENT_KEY = 'kamkmchess.online.queue.intent.v1';

/** The local key of the persisted seat bindings of the own agent. */
export const ONLINE_AGENT_BINDING_KEY = 'kamkmchess.online.agent-bindings.v1';

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
  /**
   * The private selection of the agent at the moment the entry was created.
   *
   * The selection is captured before the service is asked, so a model the
   * owner picks later never replaces the agent of a waiting entry.
   */
  readonly selection: ModelSelection | null;
  /**
   * The game the entry produced with a browser engine.
   *
   * It is set when the entry is assigned to the browser engine, so the
   * recovery of the engine credential only asks the service about an entry
   * that already produced its game. An entry that is still searching, or a
   * game with a human opponent, never carries it.
   */
  readonly engineMatchId: string | null;
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
  /**
   * The seat factory of the browser engine.
   *
   * The composition owns the seats of the fallback games. The factory is a
   * seam, so a test can drive the turn of a seat without a real engine.
   */
  readonly createEngineSeat?: (seat: OnlineEngineSeatOptions) => OnlineEngineSeat;
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
  /**
   * The namespace of the connections of the active identity.
   *
   * The namespace is resolved when a request needs it, so the connections of
   * the signed-in account are used and the guest connections of another
   * identity never are.
   */
  readonly resolveNamespace?: () => ConnectionNamespace;
  /**
   * The namespace of the connections, when it never changes.
   *
   * The seam resolveNamespace wins: the namespace of the connections
   * follows the active identity.
   */
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

/**
 * The outcome of an owner decision on an agent seat.
 *
 * The outcome never carries a routing identifier, a credential or a private
 * selection. It carries the public label the seat declares.
 */
export type AgentDecisionOutcome =
  | { readonly kind: 'accepted'; readonly publicModelLabel: string; readonly detail?: string }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string };

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
  /**
   * The invitation of a published link, when the page was opened with one.
   *
   * The shell of the page opens the online screen with it, so the
   * invitation is previewed and accepted with the identity of the owner.
   */
  readonly pendingInvitation: string | null;
  /** The own agent of the owner, when one is selected. */
  readonly agent: OnlineAgent | null;
  /**
   * The live identity key of the composition.
   *
   * It moves with every identity change, and the generation moves with it,
   * so a screen can tell an identity that came back from one that never
   * left.
   */
  readonly identityKey: string | null;
  /** The generation of the identity. It moves on every identity change. */
  readonly identityGeneration: number;
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
  setAgentCatalog(entries: readonly { id: string; label: string; selection: ModelSelection }[]): void;
  /** The public labels the owner may choose for a seat. */
  readonly agentCatalog: readonly { readonly id: string; readonly label: string }[];
  /**
   * The exact private identity of the binding of one seat.
   *
   * Two private models of the owner can carry the same public label, so the
   * binding is published by its private identity and never by its label: the
   * interface resolves the seat to exactly one model. The identity stays in
   * the browser and never leaves it.
   */
  agentBindingFor(matchId: string, seat: Seat): string | null;
  /** The public label of the binding of one seat, for the display. */
  agentBindingLabelFor(matchId: string, seat: Seat): string | null;
  /** Binds the chosen private selection to one seat of one match. */
  bindAgentSeat(matchId: string, seat: Seat, choice: string): void;
  /**
   * Binds the private selection that the owner chose for a seat.
   *
   * It replaces an existing binding, because the owner asked for it.
   */
  rebindAgentSeat(matchId: string, seat: Seat, choice: string): void;
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
  /**
   * Tracks an invitation this browser created.
   *
   * When the invitee accepts it, the inviter claims the seat credential
   * of the created match and follows it.
   */
  trackInvitation(invitationId: string, ownerToken: string, selection?: ModelSelection | null): void;
  /**
   * Tracks a rematch this browser proposed.
   *
   * The proposer claims the seat of the new match after the opponent accepted
   * it, and the seat keeps the model the owner chose for the proposal.
   */
  trackRematch(rematchId: string, matchId: string, selection?: ModelSelection | null): void;
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
  agentDecision(matchId: string, seat: Seat, decision: 'retry' | 'switch-model' | 'takeover', choice?: string): Promise<AgentDecisionOutcome>;
  /**
   * Attaches a match and shows it.
   *
   * The credential authorizes the seat. A committed assignment uses it.
   */
  attachAndFocus(matchId: string, seat: Seat, credential?: OnlineCredential, selection?: ModelSelection | null): void;
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
  /**
   * Disposes the composition and waits for the cleanup of its engine seats.
   *
   * The disposal itself is synchronous: the composition stops acting at once.
   * An engine seat releases the lease of its turn when the turn ends, so the
   * promise settles when the seats released their leases. The transport of
   * the composition goes away with them, so a release that is still on the
   * wire keeps a usable requester and a usable session.
   *
   * The promise belongs to a caller that owns the lifetime of the
   * composition. The React callers cannot await it: their effect cleanup
   * returns nothing, so the transport of the composition goes away in the
   * background, after the engine seats released their leases.
   */
  disposeAsync(): Promise<void>;
}


/** One registered seat credential of this browser. */
interface RegisteredSeat {
  readonly credential: GuestOnlineCredential;
  /** The identity that owns the seat authority. */
  readonly owner: 'account' | 'guest';
  /** The identity that held the credential when it was registered. */
  readonly identityKey: string;
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
        selection: parseModelSelection(record.selection),
        // An intent of an older build carries no game: the recovery reads the
        // state of the entry first.
        engineMatchId: typeof record.engineMatchId === 'string' ? record.engineMatchId : null,
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
 * Reads the invitation of a published link.
 *
 * The link carries the exact invitation, in the query or in the path.
 */
function readPendingInvitation(search: string | undefined): string | null {
  const query = search ?? (typeof window === 'undefined' ? '' : window.location.search);
  const linked = new URLSearchParams(query).get('invite');
  if (linked) return linked;
  if (typeof window === 'undefined') return null;
  const segments = window.location.pathname.split('/').filter(Boolean);
  const index = segments.indexOf('invite');
  return index >= 0 ? segments[index + 1] ?? null : null;
}

/**
 * Reads a persisted model selection.
 *
 * The record has to be a real selection: the kind, the provider, the
 * connection, the numeric configuration revision, the routing identifier, the
 * protocol and the diagnostic all have to be the values the shared contract
 * declares. A record of another shape is dropped, so a damaged storage never
 * binds a wrong model to a seat.
 */
function parseModelSelection(value: unknown): ModelSelection | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'model') return null;
  const providerId = record.providerId;
  const connectionId = record.connectionId;
  const modelRoutingId = record.modelRoutingId;
  const configurationRevision = record.configurationRevision;
  const protocol = record.protocol;
  const diagnostic = record.diagnostic;
  if (typeof providerId !== 'string' || providerId.length === 0) return null;
  if (typeof connectionId !== 'string' || connectionId.length === 0) return null;
  if (typeof modelRoutingId !== 'string' || modelRoutingId.length === 0) return null;
  if (typeof configurationRevision !== 'number' || !Number.isSafeInteger(configurationRevision)) return null;
  if (protocol !== 'chat-completions' && protocol !== 'responses' && protocol !== 'messages' && protocol !== 'custom') return null;
  if (diagnostic !== 'not-run' && diagnostic !== 'passed-current-session' && diagnostic !== 'failed' && diagnostic !== 'unknown') return null;
  return {
    kind: 'model',
    providerId,
    connectionId,
    configurationRevision,
    modelRoutingId,
    protocol,
    diagnostic,
  };
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
  /** The identities whose seat authority was revoked. */
  const revokedIdentities = new Set<string>();
  /** The private binding of a canonical public label of the service. */
  /**
   * The private binding of one seat.
   *
   * The binding is per seat of one match, never per public label: two private
   * models can carry the same canonical public label, and a seat must never
   * be played by another model. The binding is stored in the browser, so a
   * reload keeps the exact selection of the seat.
   */
  const agentBindings = new Map<string, { readonly label: string; readonly selection: ModelSelection }>();
  /**
   * The agents the owner may play.
   *
   * The key is the stable private identity of the selection, never the
   * public label: two private models can carry the same display name.
   */
  const agentCatalog = new Map<string, { readonly label: string; readonly selection: ModelSelection }>();
  /**
   * The private selection captured for a seat, before the service was asked.
   *
   * The records are namespaced by the identity that captured them, so the
   * records of one identity never reach another one, and an identity that
   * returns finds its own records again.
   */
  const capturedSelections = new Map<string, Map<string, ModelSelection>>();

  /**
   * The decision of the owner that a seat waits for.
   *
   * A handoff whose acknowledgement is lost is a decision the browser cannot
   * prove. The decision is captured before the service is asked, so the
   * private selection of the owner never changes while the decision waits: a
   * later catalog entry, an identity that comes and goes and a newer decision
   * never replace it. The record is dropped when the decision is proven.
   */
  interface PendingAgentDecision {
    /** The decision the owner took. */
    readonly kind: 'switch' | 'takeover';
    /** The public label the owner declared, when the decision declared one. */
    readonly label: string | null;
    /** The private selection the owner chose, captured before the await. */
    readonly selection: ModelSelection | null;
    /**
     * The generation of the identity that took the decision.
     *
     * The generation is monotonic, so an identity that leaves and comes back
     * is a different generation and never inherits the decision of the older
     * one. The identity itself is not enough: the same identity can return.
     */
    readonly generation: number;
  }

  /** The decisions of the owner that the seats wait for. */
  const pendingAgentDecisions = new Map<string, PendingAgentDecision>();

  /**
   * Reports whether a captured decision is still the decision of the seat.
   *
   * The decision is the one the browser waits for when the record of the seat
   * still names it, when the identity of the browser is the identity that
   * took it and when the runner of the seat is the runner that waited for it.
   * A newer decision of the owner, an identity that came and went and a
   * runner that was replaced all end the decision.
   */
  function intentIsCurrent(
    key: string,
    intent: PendingAgentDecision,
    runner: OnlineProviderRunner | undefined,
  ): boolean {
    if (pendingAgentDecisions.get(key) !== intent) return false;
    if (intent.generation !== identityGeneration) return false;
    if (runner !== undefined && agentRunners.get(key) !== runner) return false;
    return true;
  }

  /** Drops the record of a decision, when it still names that decision. */
  function clearIntent(key: string, intent: PendingAgentDecision): void {
    if (pendingAgentDecisions.get(key) === intent) pendingAgentDecisions.delete(key);
  }

  /**
   * The control epoch of a seat that a proven control change produced.
   *
   * The receipt of the service is a fact, and it can be newer than the
   * canonical view the browser holds. The epoch keeps the runner of the seat
   * from binding the older epoch of a stale view, which would make it stand
   * down for a control change the owner asked for.
   */
  const provenSeatEpochs = new Map<string, number>();

  /** The captured selections of one identity. */
  function capturedFor(identity: string): Map<string, ModelSelection> {
    const existing = capturedSelections.get(identity);
    if (existing) return existing;
    const created = new Map<string, ModelSelection>();
    capturedSelections.set(identity, created);
    return created;
  }

  /** The local key of the persisted seat bindings of one identity. */
  function agentBindingKey(identity: string): string {
    return `${ONLINE_AGENT_BINDING_KEY}:${encodeURIComponent(identity)}`;
  }

  /** Reads the persisted seat bindings of one identity. */
  function readAgentBindings(identity: string): { readonly matchId: string; readonly seat: Seat; readonly label: string; readonly selection: ModelSelection }[] {
    try {
      const raw = storage?.getItem(agentBindingKey(identity));
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const bindings: { matchId: string; seat: Seat; label: string; selection: ModelSelection }[] = [];
      for (const item of parsed) {
        if (typeof item !== 'object' || item === null) continue;
        const record = item as Record<string, unknown>;
        const matchId = record.matchId;
        const seat = record.seat;
        const label = record.label;
        const selection = record.selection;
        if (typeof matchId !== 'string' || matchId.length === 0) continue;
        if (seat !== 'white' && seat !== 'black') continue;
        if (typeof label !== 'string' || label.length === 0) continue;
        if (typeof selection !== 'object' || selection === null) continue;
        bindings.push({ matchId, seat, label, selection: selection as ModelSelection });
      }
      return bindings;
    } catch {
      return [];
    }
  }

  /** Writes the persisted seat bindings of one identity. */
  function writeAgentBindings(identity: string, bindings: readonly { matchId: string; seat: Seat; label: string; selection: ModelSelection }[]): void {
    try {
      if (bindings.length === 0) {
        storage?.removeItem(agentBindingKey(identity));
        return;
      }
      storage?.setItem(agentBindingKey(identity), JSON.stringify(bindings));
    } catch {
      // A browser that refuses the storage keeps the binding in memory only.
    }
  }
  /** The presence clients of the attached matches. */
  const presenceClients = new Map<string, OnlinePresenceClient>();
  /** The version the engine seat already played. */
  const engineTurns = new Map<string, number>();
  let features: OnlineFeatureFlags = options.features ?? ONLINE_FEATURES_DISABLED;
  let agent: OnlineAgent | null = null;
  /** The generation of the identity. It moves on every identity change. */
  let identityGeneration = 0;
  /** The invitation of the published link, when the page carries one. */
  const pendingInvitation = readPendingInvitation(options.search);
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
  /** Restores the durable matches of the current identity. */
  function restorePersistedMatches(): void {
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
  }

  let disposed = false;

  /** The browser owned secrets of the friend surface. */
  const friendSecrets = createFriendSecretStore({ identity: 'guest', ...(storage ? { storage } : {}) });
  /** True when the composition finished its construction. */
  let ready = false;

  const workspace = createOnlineWorkspace({
    baseUrl,
    ...(fetcher ? { fetch: fetcher } : {}),
    ...(options.accountSession ? { accountSession: options.accountSession } : {}),
    onChange: () => {
      // The drivers read the state of the composition. They run only after the
      // composition finished its construction.
      if (!ready) return;
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
      const previousKey = accountKey;
      accountKey = nextKey;
      // The generation moves on every identity change, so an answer of an
      // older identity never reaches the current one, even when the identity
      // comes back.
      identityGeneration += 1;
      if (previousKey !== null) revokedIdentities.add(previousKey);
      // An identity that becomes active again is usable again. Its seat
      // credentials are issued again, and its private model bindings are
      // restored from the device.
      if (nextKey !== null) revokedIdentities.delete(nextKey);
      // The secrets of the friend surface follow the identity. The records of
      // the previous identity never reach the new one.
      friendSecrets.setIdentity(queueIdentity());
      // The seat authority of the previous identity is fenced, and its
      // private bindings leave the memory. The persisted records of that
      // identity stay on the device, so the identity finds them again when it
      // returns.
      queue.reset();
      fenceAccountSeats();
      agentBindings.clear();
      // The decisions of the owner and the epochs they proved belong to the
      // identity that took them.
      pendingAgentDecisions.clear();
      provenSeatEpochs.clear();
      // The deferred claims of the previous identity are dropped. They are
      // restored from the device when the identity comes back.
      for (const [invitationId, tracked] of [...createdInvitations]) {
        if (tracked.identityKey === previousKey) createdInvitations.delete(invitationId);
      }
      for (const [rematchId, tracked] of [...proposedRematches]) {
        if (tracked.identityKey === previousKey) proposedRematches.delete(rematchId);
      }
      restoreTrackedInvitations();
      restoreAcceptedSeats();
      restorePersistedMatches();
      // The waiting entries of the identity are shown again, with the cutoff
      // the service gave them. The restoration reads the entries and never
      // creates one.
      restoreWaitingEntries();
      // The engine seats of the games of this identity need a usable
      // credential again.
      recoverEngineCredentials();
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
  async function credentialHeader(matchId: string | null = null): Promise<Record<string, string> | null> {
    const account = accountParticipant?.credential ?? null;
    if (account) {
      const token = await account.issue();
      return account.kind === 'account'
        ? { Authorization: `Bearer ${token}` }
        : { 'X-Guest-Seat-Token': token };
    }
    // A guest acts with the seat credential of the match it acts on. The
    // credential is seat scoped, so it never authorizes another match, and it
    // never follows the focus of the interface.
    const target = matchId ?? workspace.focusedMatchId;
    if (!target) return null;
    for (const [key, registered] of seats) {
      if (!key.startsWith(`${target}:`)) continue;
      const token = await registered.credential.issue();
      return { 'X-Guest-Seat-Token': token };
    }
    return null;
  }

  friendSecrets.setIdentity(queueIdentity());
  const friends: FriendSurface = createFriendSurface({
    baseUrl,
    ...(fetcher ? { fetch: fetcher } : {}),
    credentialFor: (matchId) => credentialHeader(matchId),
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

  /**
   * Detaches the transport of one seat.
   *
   * The requester and the session leave the maps at once, so a new seat of
   * the same match never reuses the transport of the old one. The caller
   * keeps the detached objects and disposes them itself, when the engine
   * seat that used them released its lease. The transport is never looked up
   * by its key after an await: a replacement seat would lose its own
   * transport.
   */
  function detachSeatTransport(key: string): { readonly requester: AuthorizedRequester | null; readonly session: ParticipantSession | null } {
    const requester = guestRequesters.get(key) ?? null;
    const session = guestSessions.get(key) ?? null;
    guestRequesters.delete(key);
    guestSessions.delete(key);
    return { requester, session };
  }

  /** Disposes the seat authority the previous account held. */
  function fenceAccountSeats(): void {
    for (const [key, registered] of [...seats]) {
      if (registered.owner !== 'account') continue;
      // The authority of the seat is invalid at once.
      seats.delete(key);
      engineTurns.delete(key);
      // The transport of the seat is detached at once, so a new seat of the
      // same match gets a transport of its own.
      const transport = detachSeatTransport(key);
      const engine = engineSeats.get(key);
      if (!engine) {
        transport.requester?.dispose();
        transport.session?.dispose();
        continue;
      }
      engineSeats.delete(key);
      // The engine seat releases the lease of its turn with the transport it
      // used, and that transport is disposed afterwards.
      void engine.dispose().catch(() => undefined).then(() => {
        transport.requester?.dispose();
        transport.session?.dispose();
      });
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
  }, { holdsEngineCredential });

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
          // The private selection of the agent is captured before the service
          // is asked. A model the owner picks later never replaces the agent
          // of this entry.
          selection: request.control.kind === 'agent' ? agent?.selection ?? null : null,
          // The entry has no game yet.
          engineMatchId: null,
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
          // The record of the browser owns the entry, so a reload resumes
          // the same record instead of showing the entry twice.
          entryRecords.set(created.entryId, record.id);
          // The seat of the entry is the seat of the owner. The binding of
          // the private selection happens when the match is assigned, because
          // only the assignment knows the seat of the owner.
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
  /**
   * The entries whose engine credential is being recovered right now.
   *
   * The claim names the identity and the generation that made it, so a
   * superseded recovery never blocks the recovery of the identity that came
   * back, and a finished recovery only removes its own claim.
   */
  const recoveringEntries = new Map<string, string>();
  /**
   * The entries whose waiting state is being restored right now.
   *
   * The claim names the identity and the generation that made it, like the
   * claim of the credential recovery.
   */
  const restoringEntries = new Map<string, string>();
  /** The record that owns an entry of the service. */
  const entryRecords = new Map<string, string>();
  /** The cleanup of the engine seats, awaited by `disposeAsync()`. */
  let engineCleanup: Promise<void> = Promise.resolve();

  /**
   * The claim of one recovery.
   *
   * The claim names the identity and the generation that started it, so the
   * recovery of an identity that came back is never blocked by the recovery
   * of the identity that left.
   */
  function recoveryClaim(identityKey: string, generation: number, entryId: string): string {
    return `${identityKey}:${generation}:${entryId}`;
  }

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
        // another entry stays untouched. A matched entry keeps its intent:
        // the entry id is the only way to ask the service to rotate the
        // credential of the engine seat when the identity comes back, and the
        // credential of a lost answer never returns on its own.
        if (state.phase === 'cancelled' || state.phase === 'expired') {
          const identity = queueIdentity();
          for (const intent of readIntents(storage, identity)) {
            if (intent.recordId === id) removeIntent(intent.key);
          }
        }
        // A committed assignment is attached and shown. The seat keeps the
        // private selection the entry was created with.
        if (state.phase === 'matched' && state.assignment) {
          const identity = queueIdentity();
          const intent = readIntents(storage, identity)
            .filter(candidate => candidate.recordId === id)
            .slice(-1)[0] ?? null;
          // The game of a browser engine fallback is remembered with the
          // intent, so the recovery of the engine credential only ever asks
          // the service about an entry that already produced its game.
          if (intent && state.assignment.control?.kind === 'engine' && intent.engineMatchId !== state.assignment.matchId) {
            upsertIntent(intent.key, { ...intent, engineMatchId: state.assignment.matchId });
          }
          attachAndFocus(state.assignment.matchId, state.assignment.seat, undefined, intent?.selection ?? null);
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
    adopt: (entry) => {
      const record = activeQueueId === null ? null : queueRecords.get(activeQueueId) ?? null;
      record?.controller.adopt(entry);
    },
    reset: () => {
      for (const record of queueRecords.values()) record.controller.reset();
    },
    dispose: () => {
      for (const record of queueRecords.values()) record.controller.dispose();
    },
  };

  /**
   * The invitations this browser created.
   *
   * The inviter holds the owner token of its invitation. When the invitee
   * accepts, the inviter claims the seat credential of the created match and
   * follows it, so the inviter can play its own seat.
   */
  const createdInvitations = new Map<string, { ownerToken: string; selection: ModelSelection | null; identityKey: string }>();
  /** The rematches this browser proposed, with the selection of the proposer. */
  const proposedRematches = new Map<string, { matchId: string; selection: ModelSelection | null; identityKey: string }>();
  let invitationTimer: unknown = null;

  /**
   * Tracks an invitation this browser created.
   *
   * The private selection of the agent is captured with the invitation, so
   * the seat of the created match keeps the model the owner chose when the
   * invitation was made. The owner token and the selection are durable, so a
   * reload can still claim the seat.
   */
  function trackInvitation(invitationId: string, ownerToken: string, selection: ModelSelection | null = null): void {
    const identityKey = queueIdentity();
    createdInvitations.set(invitationId, { ownerToken, selection, identityKey });
    friendSecrets.rememberOwnerToken(invitationId, ownerToken, selection);
    scheduleInvitationWork();
  }

  /**
   * Recovers the engine credentials of the entries of this identity.
   *
   * An identity change revokes the seat authority of the browser. When the
   * identity returns, the browser holds no usable credential of the engine
   * seat of its games, and the queue client asks for the explicit recovery
   * once. A routine retry never rotates a credential the browser still has.
   *
   * Only an entry that already produced a game is recovered. The fallback
   * route of the service is the authoritative allocation of the browser
   * engine, so a waiting entry must never be sent to it: the engine would be
   * committed before the deadline of the search, without the readiness flow
   * and without an owner action. The state of the entry is read first, and
   * the read never allocates.
   */
  function recoverEngineCredentials(): void {
    if (disposed) return;
    // The recovery belongs to the identity and the generation that asked for
    // it. A later identity, even the same one again, never receives the
    // answer of an older request.
    const identityKey = queueIdentity();
    const generation = identityGeneration;
    const owner: 'account' | 'guest' = accountParticipant?.accountId ? 'account' : 'guest';
    for (const intent of readIntents(storage, identityKey)) {
      const entryId = intent.entryId;
      if (!entryId) continue;
      // One recovery per entry at a time. A reload and an identity change in
      // the same moment never rotate the same credential twice, so the engine
      // seat is never replaced while its turn runs. The claim belongs to the
      // identity and the generation that made it: a superseded recovery never
      // blocks the recovery of the identity that came back.
      const claim = recoveryClaim(identityKey, generation, entryId);
      if (recoveringEntries.get(entryId) === claim) continue;
      recoveringEntries.set(entryId, claim);
      void recoverEngineCredential(intent, identityKey, generation, owner).finally(() => {
        // Only the claim of this recovery is removed. A newer recovery of the
        // identity that came back keeps its own claim.
        if (recoveringEntries.get(entryId) === claim) recoveringEntries.delete(entryId);
      });
    }
  }

  /**
   * Recovers the engine credential of one entry.
   *
   * The entry is read first. Only an assigned entry is recovered, and only
   * when its game has an engine seat: a game with a human opponent owns no
   * engine credential.
   */
  async function recoverEngineCredential(
    intent: QueueIntent,
    identityKey: string,
    generation: number,
    owner: 'account' | 'guest',
  ): Promise<void> {
    const entryId = intent.entryId;
    if (!entryId) return;
    let entry: QueueEntry;
    try {
      entry = await queueClient.readEntry(entryId);
    } catch {
      // The entry is gone, or the service cannot answer.
      return;
    }
    if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) return;
    // A waiting, a cancelled or an expired entry never produced a game.
    if (!isAssignedEntry(entry)) return;
    const matchId = entry.assignedMatchId;
    if (!matchId) return;
    // The match of the entry is the match the intent knows.
    if (intent.engineMatchId && intent.engineMatchId !== matchId) return;
    // The game must have an engine seat. A game with a human opponent owns no
    // engine credential, so the service must not be asked for one.
    if (!(await hasEngineSeat(matchId, identityKey, generation))) return;
    let assignment: QueueAssignment;
    try {
      // The entry already produced its game, so the fallback route only
      // rotates the credential of the engine seat.
      assignment = await queueClient.fallback(entryId);
    } catch {
      // The service has no engine seat for the entry, or the entry is gone.
      return;
    }
    if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) return;
    if (!assignment.guestCredential) return;
    registerGuestCredential(createGuestCredential({
      guestId: assignment.guestCredential.guestId,
      matchId: assignment.guestCredential.matchId,
      seat: assignment.guestCredential.seat,
      token: assignment.guestCredential.token,
    }), owner);
  }

  /**
   * True when the game of a match has an engine seat.
   *
   * The match is read with the credential of the account, so the read never
   * allocates and never rotates a credential.
   */
  async function hasEngineSeat(matchId: string, identityKey: string, generation: number): Promise<boolean> {
    const requester = accountRequester();
    if (!requester) return false;
    let view: OnlineMatchView;
    try {
      const result = await requester.request({ kind: 'account' }, { path: `/v1/online/matches/${encodeURIComponent(matchId)}` });
      if (!result.ok) return false;
      view = parseOnlineMatchView(result.data, matchId);
    } catch {
      return false;
    }
    if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) return false;
    return view.seats.some(seat => seat.control.kind === 'engine');
  }

  /**
   * True when the entry of the service is already shown by a record.
   *
   * A restored entry never joins an entry that is already shown, so a reload
   * and an identity change in the same moment never show the same entry
   * twice.
   */
  function entryIsShown(entryId: string): boolean {
    const recordId = entryRecords.get(entryId);
    if (recordId === undefined) return false;
    const record = queueRecords.get(recordId);
    if (!record) return false;
    return record.state.phase === 'searching'
      || record.state.phase === 'matched'
      || record.state.phase === 'assigned';
  }

  /**
   * Restores the waiting entries of the current identity.
   *
   * A reload or an identity change must show the entry the owner created.
   * The entry is read from the service, and the read never allocates: the
   * entry is the same canonical entry, with the same cutoff. Nothing is
   * created here, and the service is never asked to commit the browser
   * engine of a waiting entry - the cutoff of the entry does that, and only
   * when it arrives.
   */
  function restoreWaitingEntries(): void {
    if (disposed) return;
    // The restoration belongs to the identity and the generation that asked
    // for it. A later identity, even the same one again, never receives the
    // answer of an older request.
    const identityKey = queueIdentity();
    const generation = identityGeneration;
    for (const intent of readIntents(storage, identityKey)) {
      const entryId = intent.entryId;
      if (!entryId) continue;
      // One restoration per entry at a time. A reload and an identity change
      // in the same moment never restore the same entry twice. The claim
      // belongs to the identity and the generation that made it: a
      // superseded restoration never blocks the restoration of the identity
      // that came back.
      const claim = recoveryClaim(identityKey, generation, entryId);
      if (restoringEntries.get(entryId) === claim) continue;
      restoringEntries.set(entryId, claim);
      void restoreWaitingEntry(intent, entryId, identityKey, generation).finally(() => {
        // Only the claim of this restoration is removed. A newer restoration
        // of the identity that came back keeps its own claim.
        if (restoringEntries.get(entryId) === claim) restoringEntries.delete(entryId);
      });
    }
  }

  /**
   * Restores one waiting entry of the current identity.
   *
   * The entry is read first, and the read never allocates. Only an entry
   * that is still waiting is resumed: an entry that already produced its
   * game, a cancelled entry and an expired entry never wait again.
   */
  async function restoreWaitingEntry(
    intent: QueueIntent,
    entryId: string,
    identityKey: string,
    generation: number,
  ): Promise<void> {
    let entry: QueueEntry;
    try {
      entry = await queueClient.readEntry(entryId);
    } catch {
      // The entry is gone, or the service cannot answer.
      return;
    }
    if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) return;
    // Only a waiting entry with a ready time is resumed. The expired entry
    // needs an explicit rejoin, and an assigned entry already produced its
    // game.
    if (!isSearchingEntry(entry)) return;
    // The entry is shown already: the search of this browser continues.
    if (entryIsShown(entryId)) return;
    // The record of the entry may still exist: an identity change fences the
    // state of the previous identity, and the record is resumed instead of
    // showing the entry twice.
    const recordId = entryRecords.get(entryId);
    const tracked = recordId === undefined ? null : queueRecords.get(recordId) ?? null;
    if (tracked) {
      tracked.controller.adopt(entry);
      return;
    }
    const record = createQueueRecord();
    entryRecords.set(entryId, record.id);
    // The intent follows the record of the entry, so the entry keeps its own
    // intent and the recovery of its engine credential knows it.
    upsertIntent(intent.key, { ...intent, recordId: record.id });
    // The entry is adopted with its original cutoff. The controller never
    // creates an entry and never asks for the fallback.
    record.controller.adopt(entry);
  }

  /**
   * Restores the seats of the invitations this browser accepted.
   *
   * The credential of an accepted seat is the authority of the seat of the
   * match the invitation produced. It is kept on the device, so a reload
   * still owns the seat: the seat is registered again and the game of the
   * accepted seat is attached again.
   */
  function restoreAcceptedSeats(): void {
    if (disposed) return;
    for (const accepted of friendSecrets.listAcceptedSeats()) {
      const credential = accepted.credential;
      const key = `${credential.matchId}:${credential.seat}`;
      // The seat of this browser is registered already.
      if (seats.has(key)) continue;
      const guest = createGuestCredential({
        guestId: credential.guestId,
        matchId: credential.matchId,
        seat: credential.seat,
        token: credential.token,
      });
      registerGuestCredential(guest, 'guest');
      // The game of the accepted seat is attached again, so the owner still
      // sees it after a reload.
      workspace.attach({ matchId: credential.matchId, seat: credential.seat, credential: guest });
    }
  }

  /**
   * Restores the invitations and the rematches of this identity.
   *
   * The inviter claims the seat of a consumed invitation even after a
   * reload, and the proposer claims the seat of an accepted rematch. The
   * restoration also runs when the identity comes back.
   */
  function restoreTrackedInvitations(): void {
    const identityKey = queueIdentity();
    for (const invitationId of friendSecrets.listOwnedInvitations()) {
      if (createdInvitations.has(invitationId)) continue;
      const ownerToken = friendSecrets.readOwnerToken(invitationId);
      if (!ownerToken) continue;
      createdInvitations.set(invitationId, {
        ownerToken,
        selection: friendSecrets.readOwnerSelection(invitationId),
        identityKey,
      });
    }
    for (const record of friendSecrets.listRematches()) {
      if (proposedRematches.has(record.rematchId)) continue;
      proposedRematches.set(record.rematchId, {
        matchId: record.matchId,
        selection: record.selection,
        identityKey,
      });
    }
    scheduleInvitationWork();
  }

  /** Polls the tracked invitations and claims the seat of a consumed one. */
  function scheduleInvitationWork(): void {
    if (invitationTimer !== null) {
      timers.clearTimer(invitationTimer);
      invitationTimer = null;
    }
    if (disposed || suspended) return;
    if (createdInvitations.size === 0 && proposedRematches.size === 0) return;
    invitationTimer = timers.setTimer(() => {
      invitationTimer = null;
      for (const [invitationId, tracked] of [...createdInvitations]) {
        // The claim belongs to the identity that created the invitation. A
        // deferred answer of another identity is discarded.
        const identityKey = tracked.identityKey;
        const generation = identityGeneration;
        void (async () => {
          try {
            const invitation = await friends.preview(invitationId);
            if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) return;
            if (invitation.status !== 'consumed' || !invitation.matchId) return;
            const claimed = await friends.claimSeatCredential(invitationId, tracked.ownerToken, invitation.matchId);
            if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) return;
            if (claimed.guestCredential) {
              registerGuestCredential(createGuestCredential({
                guestId: claimed.guestCredential.guestId,
                matchId: claimed.guestCredential.matchId,
                seat: claimed.guestCredential.seat,
                token: claimed.guestCredential.token,
              }), 'guest');
            }
            // The answer names the match and the seat even for an account
            // inviter, so the inviter follows its own match.
            attachAndFocus(claimed.matchId, claimed.seat, undefined, tracked.selection);
            createdInvitations.delete(invitationId);
            friendSecrets.forgetOwnerToken(invitationId);
            notify();
          } catch {
            // The invitation is not consumed yet, or the claim is refused. The
            // next interval tries again, so a lost claim answer is recovered.
          }
        })();
      }
      for (const [rematchId, tracked] of [...proposedRematches]) {
        const identityKey = tracked.identityKey;
        const generation = identityGeneration;
        void (async () => {
          try {
            const rematch = await friends.pendingRematch(tracked.matchId);
            if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) return;
            if (!rematch || rematch.status !== 'accepted' || !rematch.newMatchId) return;
            const claimed = await friends.claimRematchSeatCredential(rematchId, tracked.matchId);
            if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) return;
            if (claimed.guestCredential) {
              registerGuestCredential(createGuestCredential({
                guestId: claimed.guestCredential.guestId,
                matchId: claimed.guestCredential.matchId,
                seat: claimed.guestCredential.seat,
                token: claimed.guestCredential.token,
              }), 'guest');
            }
            attachAndFocus(claimed.matchId, claimed.seat, undefined, tracked.selection);
            proposedRematches.delete(rematchId);
            friendSecrets.forgetRematch(rematchId);
            notify();
          } catch {
            // The rematch is not accepted yet, or the claim is refused. The
            // next interval tries again.
          }
        })();
      }
      scheduleInvitationWork();
    }, ONLINE_QUEUE_POLL_INTERVAL_MS);
  }

  /**
   * The usable engine credential of one match.
   *
   * The browser owns the credential of its engine seat. A credential of a
   * revoked identity is not usable, even while the record of it still exists.
   */
  function holdsEngineCredential(matchId: string): boolean {
    for (const [key, registered] of seats) {
      if (!key.startsWith(`${matchId}:`)) continue;
      if (revokedIdentities.has(registered.identityKey)) continue;
      return true;
    }
    return false;
  }

  function registerGuestCredential(credential: GuestOnlineCredential, owner: 'account' | 'guest' = 'guest'): void {
    const key = `${credential.matchId}:${credential.seat}`;
    const previous = seats.get(key);
    if (previous && previous.credential !== credential) {
      // A re-minted credential replaces the old one. The old session and its
      // requester are released, so the seat never keeps a revoked token.
      // The browser engine seat of the match used the revoked credential, so
      // it is released and built again with the fresh one. The transport of
      // the seat is detached at once, so the new seat of the same match gets
      // a transport of its own, and the old transport is disposed when the
      // engine seat released the lease of its turn.
      const engine = engineSeats.get(key);
      engineTurns.delete(key);
      const transport = detachSeatTransport(key);
      if (engine) {
        engineSeats.delete(key);
        void engine.dispose().catch(() => undefined).then(() => {
          transport.requester?.dispose();
          transport.session?.dispose();
        });
      } else {
        transport.requester?.dispose();
        transport.session?.dispose();
      }
    }
    seats.set(key, { credential, owner, identityKey: queueIdentity() });
    if (owner === 'guest') guestSeats.add(key);
    notify();
    // A recovered credential makes the engine seat of the match usable again,
    // so the turn that waits for it is played without waiting for another
    // snapshot of the game.
    if (ready) driveEngineSeats();
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

  function attachAndFocus(matchId: string, seat: Seat, credential?: OnlineCredential, selection?: ModelSelection | null): void {
    const authority = credential ?? credentialFor(matchId, seat);
    if (!authority) return;
    const binding: OnlineSeatBinding = { matchId, seat, credential: authority };
    workspace.attach(binding);
    workspace.focus(matchId);
    // The seat keeps the private selection that was captured when the entry
    // or the invitation was created. A seat without a captured selection stays
    // unbound, and the interface asks the owner to choose.
    if (selection) bindCapturedAgentSeat(matchId, seat, selection, agent?.label ?? 'Agent');
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
      const sideToMove = onlineSideToMove(view);
      const isTurn = sideToMove === engineSeat.seat;
      if (!isTurn) continue;
      engineTurns.set(key, view.version);
      let engine = engineSeats.get(key);
      if (!engine) {
        engine = (options.createEngineSeat ?? createOnlineEngineSeat)({
          matchId: view.matchId,
          seat: engineSeat.seat,
          credential: registered.credential,
          baseUrl,
          ...(fetcher ? { fetch: fetcher } : {}),
          ...(options.prepareEngine ? { prepareEngine: options.prepareEngine } : {}),
        });
        engineSeats.set(key, engine);
      }
      // The bookkeeping of the turn belongs to this seat and to this version.
      // A seat that was replaced - a new credential, a new identity - and a
      // turn of an older version never clear the record of the current turn,
      // so the current turn is never played twice.
      const turn = { engine, version: view.version, generation: identityGeneration };
      void engine.play(view).then(result => {
        if (result.kind === 'moved') return;
        if (!ownsTurn(key, turn)) return;
        // A stopped turn - a search of a seat that lost its credential, or a
        // fenced answer - is not a failure of the engine, so the turn is
        // played again with the next snapshot. A failed turn is reported to
        // the owner, who may take over the seat.
        engineTurns.delete(key);
        if (result.kind === 'failed') notify();
      }).catch(() => {
        if (!ownsTurn(key, turn)) return;
        engineTurns.delete(key);
      });
    }
  }

  /**
   * True when a turn of an engine seat still owns the record of that turn.
   *
   * The seat of a match is replaced when its credential is replaced, and the
   * record of a turn names the version it played. A turn that answered late -
   * a seat that was disposed while it searched - therefore never clears the
   * record of the turn that runs now.
   */
  function ownsTurn(key: string, turn: { readonly engine: OnlineEngineSeat; readonly version: number; readonly generation: number }): boolean {
    if (identityGeneration !== turn.generation) return false;
    if (engineSeats.get(key) !== turn.engine) return false;
    return engineTurns.get(key) === turn.version;
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
  /**
   * Resolves one choice of the owner.
   *
   * The choice is the stable private identity of a catalog entry. A label is
   * accepted as well, so both sides of the interface work while they are
   * integrated, and an ambiguous label resolves to nothing.
   */
  function resolveChoice(choice: string): { readonly label: string; readonly selection: ModelSelection } | null {
    const byId = agentCatalog.get(choice);
    if (byId) return byId;
    const byLabel = [...agentCatalog.values()].filter(entry => entry.label === choice);
    return byLabel.length === 1 ? byLabel[0]! : null;
  }

  /**
   * Binds the private selection of the owner to one seat of one match.
   *
   * The selection is the one the owner chose for this seat. It is never
   * inferred from a public label, because two private models can carry the
   * same canonical label.
   *
   * The binding of a seat that already has one is never replaced here: the
   * selection that was captured for the entry or the invitation of the seat
   * stays authoritative. The explicit choice of the owner uses
   * {@link rebindAgentSeat}.
   */
  function bindAgentSeat(matchId: string, seat: Seat, choice: string): void {
    const key = `${matchId}:${seat}`;
    if (agentBindings.has(key)) return;
    const resolved = resolveChoice(choice);
    // A choice the owner never connected binds nothing, and a seat without a
    // selection stays unbound: the browser then asks the owner to choose.
    if (!resolved) return;
    bindResolvedAgentSeat(matchId, seat, resolved);
  }

  /**
   * Binds a private selection that was already resolved.
   *
   * The selection is the one the owner chose, so it is never inferred from a
   * public label: two private models can carry the same canonical label. The
   * binding stays in the browser and on the device.
   */
  function bindResolvedAgentSeat(
    matchId: string,
    seat: Seat,
    resolved: { readonly label: string; readonly selection: ModelSelection },
  ): void {
    const key = `${matchId}:${seat}`;
    agentBindings.set(key, { label: resolved.label, selection: resolved.selection });
    const identity = queueIdentity();
    const bindings = readAgentBindings(identity)
      .filter(binding => !(binding.matchId === matchId && binding.seat === seat));
    bindings.push({ matchId, seat, label: resolved.label, selection: resolved.selection });
    writeAgentBindings(identity, bindings);
  }

  /**
   * Replaces the private binding of a seat with a resolved selection.
   *
   * It replaces an existing binding, because the owner asked for it. The
   * selection is the captured one and is never resolved again: a catalog that
   * changed while the decision waited never replaces the choice of the owner.
   */
  function rebindCapturedAgentSeat(
    matchId: string,
    seat: Seat,
    resolved: { readonly label: string; readonly selection: ModelSelection },
  ): void {
    agentBindings.delete(`${matchId}:${seat}`);
    bindResolvedAgentSeat(matchId, seat, resolved);
  }

  /**
   * Removes the private binding of a seat.
   *
   * The binding leaves the memory and the device, so a seat that belongs to
   * the human owner is never played by the browser again.
   */
  function removeAgentBinding(matchId: string, seat: Seat): void {
    agentBindings.delete(`${matchId}:${seat}`);
    const identity = queueIdentity();
    const bindings = readAgentBindings(identity)
      .filter(binding => !(binding.matchId === matchId && binding.seat === seat));
    writeAgentBindings(identity, bindings);
  }

  /**
   * Binds the private selection that the owner chose for a seat.
   *
   * It replaces an existing binding, because the owner asked for it.
   */
  function rebindAgentSeat(matchId: string, seat: Seat, choice: string): void {
    const key = `${matchId}:${seat}`;
    agentBindings.delete(key);
    bindAgentSeat(matchId, seat, choice);
  }

  /**
   * Binds the selection that was captured for a seat before the service was
   * asked.
   *
   * A queue entry and a friend invitation capture the private selection of
   * the agent when they are created, so a model the owner picks later never
   * replaces the agent of a waiting entry.
   */
  /** The local display label of a captured selection, when the catalog knows it. */
  function catalogLabelOf(selection: ModelSelection): string | null {
    for (const entry of agentCatalog.values()) {
      if (
        entry.selection.modelRoutingId === selection.modelRoutingId
        && entry.selection.connectionId === selection.connectionId
      ) {
        return entry.label;
      }
    }
    return null;
  }

  function bindCapturedAgentSeat(
    matchId: string,
    seat: Seat,
    selection: ModelSelection | null,
    label: string,
  ): void {
    if (!selection) return;
    const key = `${matchId}:${seat}`;
    capturedFor(queueIdentity()).set(key, selection);
    // The local display label of the captured selection wins over the label of
    // the agent the owner happens to have selected now.
    const display = catalogLabelOf(selection) ?? label;
    agentBindings.set(key, { label: display, selection });
    const identity = queueIdentity();
    const bindings = readAgentBindings(identity)
      .filter(binding => !(binding.matchId === matchId && binding.seat === seat));
    bindings.push({ matchId, seat, label: display, selection });
    writeAgentBindings(identity, bindings);
  }

  /**
   * The private identity of the binding of one seat.
   *
   * The identity of the catalog entry of that selection is the identity the
   * interface resolves, so the binding names the same model the catalog
   * publishes. A selection the catalog does not know keeps the identity of its
   * own private facts.
   */
  function identityOfSelection(selection: ModelSelection): string {
    const identity = privateAgentId(selection);
    for (const [id, entry] of agentCatalog) {
      if (privateAgentId(entry.selection) === identity) return id;
    }
    return identity;
  }

  /**
   * The private selection bound to one seat.
   *
   * The answer is null when the seat has no binding. The interface then asks
   * the owner to choose the agent of the seat; the browser never guesses.
   */
  function agentBindingFor(matchId: string, seat: Seat): { readonly label: string; readonly selection: ModelSelection } | null {
    const key = `${matchId}:${seat}`;
    const inMemory = agentBindings.get(key);
    if (inMemory) return inMemory;
    const identity = queueIdentity();
    const persisted = readAgentBindings(identity)
      .find(binding => binding.matchId === matchId && binding.seat === seat);
    if (!persisted) return null;
    agentBindings.set(key, { label: persisted.label, selection: persisted.selection });
    return { label: persisted.label, selection: persisted.selection };
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
      // private models can carry the same canonical label. A seat without a
      // binding waits for the owner to choose the agent of the seat.
      const key = `${view.matchId}:${ownSeat}`;
      const binding = agentBindingFor(view.matchId, ownSeat);
      if (!binding) continue;
      let runner = agentRunners.get(key);
      let created = false;
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
            namespace: options.resolveNamespace?.() ?? options.namespace ?? { kind: 'guest' },
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
        created = true;
      }
      const snapshot = providerRunnerSnapshot(view, ownSeat);
      // The receipt of a proven control change can be newer than the canonical
      // view the browser holds. The runner binds the proven epoch, so it does
      // not stand down for a control change the owner asked for.
      const proven = provenSeatEpochs.get(key);
      runner.applySnapshot(
        proven !== undefined && proven > snapshot.seatControlEpoch
          ? { ...snapshot, seatControlEpoch: proven }
          : snapshot,
      );
      // Only a new runner starts on its own. A snapshot never resumes a
      // runner the owner stopped, and it never resets the phase of an owner
      // decision.
      if (created) void runner.start().catch(() => undefined);
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

  ready = true;
  // The invitations of this identity are restored, so a reload still claims
  // the seat of a consumed invitation.
  restoreTrackedInvitations();
  // The seats of the accepted invitations are restored, so a reload still
  // owns the seat of the match it accepted.
  restoreAcceptedSeats();

  /**
   * Disposes the composition.
   *
   * The disposal is synchronous in its effect: the composition stops acting
   * at once. An engine seat releases the lease of its turn when the turn
   * ends, so the cleanup of the seats is awaited by `disposeAsync()` and the
   * requester and the session of a seat go away with it.
   */
  function disposeComposition(): void {
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
    // The authority of the browser is invalid at once: the seats, the engine
    // turns and the listeners of this composition never act again.
    const engines = [...engineSeats.values()];
    engineSeats.clear();
    seats.clear();
    presenceClients.clear();
    engineTurns.clear();
    listeners.clear();
    // The account session and the account requester leave the composition at
    // once, so no answer of the previous identity can reach it. Their
    // transport stays usable until the engine seats released their leases.
    const account = accountParticipant;
    const accountRequester = accountRequesterInstance;
    accountParticipant = null;
    accountRequesterInstance = null;
    // The transport of the guest seats is detached at once, so a seat that is
    // created later never reuses the transport of a disposed one.
    const guestTransport = [...guestRequesters.values()];
    const guestSessionsOfComposition = [...guestSessions.values()];
    guestRequesters.clear();
    guestSessions.clear();
    // The engine seats release the lease of their turn while the transport of
    // the composition is still usable. The requesters and the sessions go
    // away afterwards, so a release that is still on the wire is never lost.
    engineCleanup = (async () => {
      await Promise.all(engines.map(engine => engine.dispose().catch(() => undefined)));
      account?.dispose();
      accountRequester?.dispose();
      for (const requester of guestTransport) requester.dispose();
      for (const session of guestSessionsOfComposition) session.dispose();
    })();
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
    get pendingInvitation() {
      return pendingInvitation;
    },
    get identityKey() {
      return accountKey;
    },
    get identityGeneration() {
      return identityGeneration;
    },
    get agent() {
      return agent;
    },
    get accountSignedIn() {
      return accountParticipant?.credential?.kind === 'account';
    },
    setAgent(next) {
      agent = next;
      // The current agent lives outside the catalog. The catalog is keyed by
      // the stable private identity of a selection, and the public label of
      // the current agent never overwrites an entry of the catalog.
      notify();
    },
    setAgentCatalog(entries) {
      agentCatalog.clear();
      for (const entry of entries) {
        agentCatalog.set(entry.id, { label: entry.label, selection: entry.selection });
      }
      // A seat that was attached before the catalog knew its selection gets
      // its captured selection now, so the runner of the seat starts.
      for (const [key, captured] of capturedFor(queueIdentity())) {
        const separator = key.lastIndexOf(':');
        const matchId = key.slice(0, separator);
        const seat = key.slice(separator + 1) as Seat;
        if (agentBindings.has(key)) continue;
        bindCapturedAgentSeat(matchId, seat, captured, agent?.label ?? 'Agent');
      }
      driveAgentSeats();
      notify();
    },
    get agentCatalog() {
      return [...agentCatalog.entries()].map(([id, entry]) => ({ id, label: entry.label }));
    },
    agentBindingFor(matchId: string, seat: Seat) {
      // The binding is published by its private identity, so a seat whose two
      // private models share the public label still resolves to one model.
      const binding = agentBindingFor(matchId, seat);
      return binding === null ? null : identityOfSelection(binding.selection);
    },
    agentBindingLabelFor(matchId: string, seat: Seat) {
      return agentBindingFor(matchId, seat)?.label ?? null;
    },
    bindAgentSeat(matchId: string, seat: Seat, choice: string) {
      bindAgentSeat(matchId, seat, choice);
      driveAgentSeats();
      notify();
    },
    rebindAgentSeat(matchId: string, seat: Seat, choice: string) {
      rebindAgentSeat(matchId, seat, choice);
      driveAgentSeats();
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
    trackInvitation,
    trackRematch(rematchId: string, matchId: string, selection?: ModelSelection | null) {
      proposedRematches.set(rematchId, { matchId, selection: selection ?? null, identityKey: queueIdentity() });
      friendSecrets.rememberRematch(rematchId, matchId, selection ?? null);
      scheduleInvitationWork();
    },
    presenceClient,
    agentRunnerState(matchId, seat) {
      return agentRunners.get(`${matchId}:${seat}`)?.state ?? null;
    },
    async agentDecision(matchId, seat, decision, choice): Promise<AgentDecisionOutcome> {
      const key = `${matchId}:${seat}`;
      if (decision === 'switch-model') {
        // A switch changes the private selection of the seat. The old
        // selection is never relabelled as the new model, and the runner is
        // rebuilt with the destination of the new selection.
        const resolved = choice ? resolveChoice(choice) : null;
        if (!resolved) {
          return { kind: 'refused', detail: 'That agent is not connected.' };
        }
        // The decision of the owner is captured before the service is asked.
        // The private selection never changes while the decision waits, so a
        // later catalog entry, an identity that comes and goes and a newer
        // decision never replace it. A lost acknowledgement leaves the record
        // in place, so the owner may replay the decision and the browser still
        // knows what the decision was.
        const intent: PendingAgentDecision = {
          kind: 'switch',
          label: resolved.label,
          selection: resolved.selection,
          generation: identityGeneration,
        };
        pendingAgentDecisions.set(key, intent);
        const runner = agentRunners.get(key);
        if (!runner) {
          rebindCapturedAgentSeat(matchId, seat, resolved);
          clearIntent(key, intent);
          driveAgentSeats();
          return { kind: 'accepted', publicModelLabel: resolved.label };
        }
        // The runner reports the outcome of the decision. A refused or an
        // unknown outcome keeps the runner and the binding of the seat.
        const outcome = await runner.switchModel(resolved.label);
        if (outcome.kind !== 'accepted') {
          // A refused switch is proven negative: the seat did not change, so
          // the record of the decision is dropped. An unknown switch keeps it,
          // so the owner may replay the decision. A newer decision of the
          // owner keeps its own record.
          if (outcome.kind === 'refused') clearIntent(key, intent);
          return outcome;
        }
        // The decision is applied only while it is the decision the browser
        // waits for: a newer decision of the owner, an identity that came and
        // went and a runner that was replaced all end it.
        if (!intentIsCurrent(key, intent, runner)) {
          return { kind: 'unknown', detail: 'A newer decision of the owner ended the switch.' };
        }
        if (outcome.control !== undefined) {
          provenSeatEpochs.set(key, outcome.control.controlEpoch);
        }
        // The switch is the explicit choice of the owner, so it replaces the
        // private binding of the seat.
        rebindCapturedAgentSeat(matchId, seat, resolved);
        await runner.stop().catch(() => undefined);
        // The stop waits for the service, so the decision is checked again
        // before the record of the seat and the runner of the seat change.
        if (!intentIsCurrent(key, intent, runner)) {
          return { kind: 'unknown', detail: 'A newer decision of the owner ended the switch.' };
        }
        clearIntent(key, intent);
        agentRunners.delete(key);
        // The canonical snapshot is fed again, so the new runner plays the seat.
        driveAgentSeats();
        // The detail of the runner names what it had to leave out, for
        // example a handoff that could not take the lease of the seat.
        return outcome.detail === undefined
          ? { kind: 'accepted', publicModelLabel: outcome.publicModelLabel }
          : { kind: 'accepted', publicModelLabel: outcome.publicModelLabel, detail: outcome.detail };
      }
      const runner = agentRunners.get(key);
      if (!runner) {
        return { kind: 'refused', detail: 'The seat has no runner.' };
      }
      if (decision === 'retry') {
        // The decision the browser waits for is captured before the runner
        // waits for the service. A newer decision of the owner, an identity
        // that comes and goes and a runner that is replaced while the receipt
        // of the replay is on its way all end the captured decision.
        const intent = pendingAgentDecisions.get(key);
        const outcome = await runner.retry();
        if (outcome.kind !== 'accepted') return outcome;
        // The decision of the owner is applied only when the outcome proves
        // it. The receipt of the service names the control of the seat, the
        // captured decision has to be the decision that was replayed, and the
        // identity that took the decision has to be the identity of the
        // browser now.
        if (intent === undefined) return outcome;
        if (!intentIsCurrent(key, intent, runner)) {
          return { kind: 'unknown', detail: 'A newer decision of the owner ended the retry.' };
        }
        const control = outcome.control;
        if (control === undefined) return outcome;
        if (intent.kind === 'switch' && control.kind !== 'agent') return outcome;
        if (intent.kind === 'takeover' && control.kind !== 'human') return outcome;
        provenSeatEpochs.set(key, control.controlEpoch);
        if (control.kind === 'human') {
          // The seat belongs to the human owner now: the browser stops playing
          // it and the private binding of the seat leaves the browser.
          await runner.stop().catch(() => undefined);
          if (!intentIsCurrent(key, intent, runner)) {
            return { kind: 'unknown', detail: 'A newer decision of the owner ended the retry.' };
          }
          clearIntent(key, intent);
          removeAgentBinding(matchId, seat);
          agentRunners.delete(key);
          return outcome;
        }
        // The switch is proven. The seat plays the selection the owner chose,
        // the one that was captured before the service was asked.
        if (intent.selection !== null && intent.label !== null) {
          rebindCapturedAgentSeat(matchId, seat, {
            label: intent.label,
            selection: intent.selection,
          });
        }
        await runner.stop().catch(() => undefined);
        // The stop waits for the service, so the decision is checked again
        // before the runner of the seat is replaced. A newer decision of the
        // owner keeps its own binding and its own runner.
        if (!intentIsCurrent(key, intent, runner)) {
          return { kind: 'unknown', detail: 'A newer decision of the owner ended the retry.' };
        }
        clearIntent(key, intent);
        agentRunners.delete(key);
        // The canonical snapshot is fed again, so the new runner plays the seat
        // with the new selection and its own credential.
        driveAgentSeats();
        return outcome;
      }
      // A takeover hands the seat to the owner, so the browser stops playing
      // it. A refused or an unknown takeover keeps the runner and the binding
      // of the seat.
      const intent: PendingAgentDecision = {
        kind: 'takeover',
        label: null,
        selection: null,
        generation: identityGeneration,
      };
      pendingAgentDecisions.set(key, intent);
      const outcome = await runner.takeover();
      if (outcome.kind !== 'accepted') {
        // A refused takeover is proven negative: the seat did not change, so
        // the record of the decision is dropped. An unknown takeover keeps it,
        // so the owner may replay the decision. A newer decision of the owner
        // keeps its own record.
        if (outcome.kind === 'refused') clearIntent(key, intent);
        return outcome;
      }
      if (!intentIsCurrent(key, intent, runner)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the takeover.' };
      }
      await runner.stop().catch(() => undefined);
      if (!intentIsCurrent(key, intent, runner)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the takeover.' };
      }
      clearIntent(key, intent);
      removeAgentBinding(matchId, seat);
      agentRunners.delete(key);
      return outcome;
    },    attachAndFocus,
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
      restorePersistedMatches();
      // The waiting entries of the identity are shown again, with the cutoff
      // the service gave them. The restoration reads the entries and never
      // creates one.
      restoreWaitingEntries();
      // The engine seats of the restored games need a usable credential. The
      // browser holds none after a reload, so the service is asked to rotate
      // it.
      recoverEngineCredentials();
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
      // The engine seats release the lease of their turn. The transport of
      // the composition stays usable, because the composition is only
      // suspended: it can be resumed, and the release is never lost.
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
      disposeComposition();
    },
    async disposeAsync() {
      disposeComposition();
      await engineCleanup;
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
