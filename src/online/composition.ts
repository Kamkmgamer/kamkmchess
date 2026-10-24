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
 * - The default enter joins the entry the owner already waits with. A second
 *   tab, a second click and a reload reach the same entry, and only an
 *   explicit second game asks for another one.
 * - An identity change fences the state of the previous identity at once. A
 *   token refresh of the same account changes nothing: the games, the queue
 *   and the engine seats keep their authority. The browser runners of the
 *   previous identity stop with it, so a private provider request of an
 *   identity that left never keeps running and never submits a move.
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
import { createOnlineMatchCommandClient, OnlineCommandError } from './match-client';
import type { OnlineMatchCommandClient } from './match-client';
import { createOnlineEngineSeat } from './engine-seat';
import type { OnlineEngineSeat, OnlineEngineSeatOptions } from './engine-seat';
import { createOnlineAgentSeat, createAgentProviderPort, providerRunnerSnapshot } from './agent-seat';
import type { OnlineProviderRunner, ProviderRunnerState } from './provider-runner';
import { createLocalPendingStore } from './provider-runner';
import { createOnlineRunnerLeaseClient } from './runner-lease';
import { createOnlinePresenceClient } from './presence-client';
import type { OnlinePresenceClient } from './presence-client';
import { createFriendSurface } from './friend-routes';
import { createFriendSecretStore } from './friend-secrets';
import type { FriendInvitation, FriendSurface } from './friend-routes';
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
import { ONLINE_FEATURES_DISABLED, ONLINE_FEATURES_PATH, ONLINE_FEATURES_STATUS_UNKNOWN } from './features';
import type { OnlineFeatureFlags, OnlineFeaturesStatus } from './features';
import { parseOnlineMatchView } from './updates';
import { onlineSideToMove } from './turn';
import { ONLINE_CONTRACTS_SCHEMA_VERSION } from './contracts';
import type { OnlineMatchView } from './updates';
import type { QueueEntry, Receipt, Seat, SeatControl, TimeControl } from './contracts';
import type { OnlineAgentCheck } from './readiness';
import type { ModelSelection } from '../controller/index.js';
import { privateAgentId } from '../accounts/agent-catalog.js';
import type { ConnectionNamespace, ConnectionStore } from '../providers/connections/index.js';

/** The local key of the pending queue intent. */
export const ONLINE_QUEUE_INTENT_KEY = 'kamkmchess.online.queue.intent.v1';

/** The local key of the persisted seat bindings of the own agent. */
export const ONLINE_AGENT_BINDING_KEY = 'kamkmchess.online.agent-bindings.v1';

/**
 * The state of the entry an intent names.
 *
 * A live intent names an entry that may still be reached. A terminal intent
 * names an entry that produced its game or that left the queue, and it never
 * authorizes another entry.
 */
type QueueIntentState = 'live' | 'terminal';

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
   * The state of the entry the intent names.
   *
   * A completed game keeps its intent, because the recovery of the engine
   * seat needs it, and the intent is terminal: the key of a finished entry
   * never reaches the service again.
   */
  readonly state: QueueIntentState;
  /**
   * True when the creation request was sent to the service.
   *
   * A false value means the request never left the browser: the readiness of
   * an agent failed, so the service knows nothing about this entry. The
   * recovery of such an intent never creates an entry, so a failed readiness
   * never leaves a queue entry behind.
   *
   * A true value means the request was sent and its answer may be lost. The
   * same key reaches the same entry, so the recovery asks again with that
   * key instead of creating a second entry.
   */
  readonly sent: boolean;
  /**
   * True when the intent owns the shared entry of the identity.
   *
   * The shared entry is the entry the default enter joins: a second tab, a
   * reload and a settings change reach it. An explicit second game owns its
   * own entry, and the default enter never joins it, never replaces it and
   * never cancels it.
   */
  readonly shared: boolean;
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
  /**
   * True when the entry of this intent has to be cancelled.
   *
   * The obligation is written when the identity changed while the creation
   * of the entry was on the wire. The service may have accepted the entry
   * under the identity that asked, and that entry must never wait behind the
   * owner's back: it is recovered with the same key and cancelled when the
   * identity returns.
   *
   * The obligation lives in the namespace of the identity that asked, so it is
   * resolved by that identity and never by another one. An intent with the
   * obligation never authorizes an entry: the default enter skips it and the
   * claim of the shared entry never names it.
   */
  readonly cleanup: boolean;
}

/**
 * The outcome of the resolution of the entry of one intent.
 *
 * `resolved` means the entry is over: it was cancelled, it is gone, or the
 * game it produced ended. The intent of the entry can go.
 *
 * `pending` means the outcome is unknown: the entry may still wait, or the
 * game it produced may still play. The intent keeps its obligation, so a
 * later try resolves it instead of abandoning it.
 */
type IntentResolution = 'resolved' | 'pending';

/**
 * The state of one game, as the participant view of the service reports it.
 *
 * An absent game is over. An unknown answer leaves the outcome open, so the
 * obligation of the intent survives it.
 */
type GameRead =
  | { readonly kind: 'view'; readonly view: OnlineMatchView }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };

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
  /**
   * The lock of the shared queue entry.
   *
   * The lock is held while the browser claims the shared entry, so two tabs
   * of the same browser never claim two keys for the same entry. The default
   * uses the lock of the browser, when it has one, and refuses the queue
   * without it: the browser cannot share one entry between its tabs when it
   * cannot lock them.
   */
  readonly queueLock?: <T>(name: string, run: () => Promise<T>) => Promise<T>;
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
  /**
   * How the feature answer was last obtained. A closed surface and an
   * unreachable service both close every flag; the status says which one the
   * browser is looking at.
   */
  readonly featuresStatus: OnlineFeaturesStatus;
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
   * The invitations this identity owns, with the state the service published.
   *
   * The list belongs to the identity that created the invitations. Another
   * identity never sees it, and the owner token of an invitation never
   * reaches it: the list carries the public metadata of the invitation only.
   */
  readonly ownedInvitations: readonly FriendInvitation[];
  /**
   * True when this identity owns the invitation.
   *
   * The answer comes from the identity scoped secret store, so a browser that
   * signs in as another account never owns the invitation of the first one.
   */
  ownsInvitation(invitationId: string): boolean;
  /**
   * Publishes the state of an invitation this identity owns.
   *
   * The invitation is published only when the identity owns it, so a state
   * of another identity never reaches the screen.
   */
  publishOwnedInvitation(invitation: FriendInvitation): void;
  /**
   * Reads the invitations this identity owns.
   *
   * The read uses the owner token of the identity scoped record, so the
   * service sees the owner of the invitation and nobody else. The answer of
   * an identity that is no longer current never reaches the current one.
   */
  refreshOwnedInvitations(): Promise<void>;
  /**
   * Cancels an invitation this identity owns.
   *
   * The owner token stays in the browser and travels in the private header of
   * the surface. The record of the invitation is settled only when the
   * service confirms a terminal state.
   */
  cancelOwnedInvitation(invitationId: string): Promise<FriendInvitation>;
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
   * Hands the seat of the owner to its agent.
   *
   * The transition belongs to the composition: the control change of the
   * service, the private binding of the seat and the runner of the seat are
   * one change. The seat never waits for the deadline of its turn with a
   * runner that gave up, and the browser never plays the seat with a model
   * the owner did not choose.
   *
   * The outcome is the outcome of the service: a refused or an unknown
   * hand-back never reads as a seat the agent plays.
   */
  handSeatToAgent(matchId: string, seat: Seat): Promise<AgentDecisionOutcome>;
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
        // An intent of an older build carries no state: it names an entry that
        // may still be reached.
        state: record.state === 'terminal' ? 'terminal' : 'live',
        // An intent of an older build carries no answer state: the request may
        // have been sent, so the recovery asks again with the same key.
        sent: record.sent !== false,
        // An intent of an older build carries no role: it may be the shared
        // entry of the owner, so the default enter still reaches it.
        shared: record.shared !== false,
        selection: parseModelSelection(record.selection),
        // An intent of an older build carries no game: the recovery reads the
        // state of the entry first.
        engineMatchId: typeof record.engineMatchId === 'string' ? record.engineMatchId : null,
        // An intent of an older build carries no obligation: it names an
        // entry the owner still waits with.
        cleanup: record.cleanup === true,
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
 * The durable claim of the shared entry of one identity.
 *
 * The claim names the key of the entry the owner waits with. It lives beside
 * the intents, so a write of the intents never drops it, and it is taken
 * under the lock of the browser: two tabs of the same browser that enter the
 * queue at the same moment claim one key and reach one entry.
 */
interface SharedClaimRecord {
  /** The idempotency key of the claimed entry. */
  readonly key: string;
  /** The settings of the claimed entry. */
  readonly settings: string;
  /** The instant the claim was taken. */
  readonly at: number;
}

/** The storage key of the claim of one identity. */
function claimKey(identity: string): string {
  return `${ONLINE_QUEUE_INTENT_KEY}:claim:${encodeURIComponent(identity)}`;
}

/** Reads the claim of one identity. */
function readSharedClaim(storage: OnlineCompositionOptions['storage'], identity: string): SharedClaimRecord | null {
  try {
    const raw = storage?.getItem(claimKey(identity));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== 'string' || key.length < 8) return null;
    const settings = record.settings;
    if (typeof settings !== 'string') return null;
    return { key, settings, at: typeof record.at === 'number' ? record.at : 0 };
  } catch {
    return null;
  }
}

/** Writes the claim of one identity. */
function writeSharedClaim(storage: OnlineCompositionOptions['storage'], identity: string, claim: SharedClaimRecord): void {
  try {
    storage?.setItem(claimKey(identity), JSON.stringify(claim));
  } catch {
    // A browser that refuses the storage keeps the claim in memory only.
  }
}

/**
 * Releases the claim of one identity.
 *
 * The claim is released when it names another key, so a claim of a terminal
 * entry never blocks the next entry of the owner.
 */
function releaseSharedClaim(storage: OnlineCompositionOptions['storage'], identity: string, key: string): void {
  try {
    const claim = readSharedClaim(storage, identity);
    if (claim === null || claim.key !== key) return;
    storage?.removeItem(claimKey(identity));
  } catch {
    // A browser that refuses the storage keeps the claim in memory only.
  }
}

/**
 * Moves the claim of the shared entry to the key of a record.
 *
 * A settings change replaces the entry of the owner with a fresh one, and the
 * claim follows the record: the key of the replaced entry is terminal, and a
 * terminal key never reaches the service again. A claim of another entry is
 * left alone, so the shared entry of another tab keeps its claim.
 *
 * A record without a key of its own never moves the claim: an explicit second
 * game owns its own entry, and it never takes the shared entry of the owner
 * away from the tabs that wait with it.
 */
function moveSharedClaim(
  storage: OnlineCompositionOptions['storage'],
  identity: string,
  previousKey: string | null,
  intent: QueueIntent,
): void {
  try {
    if (previousKey === null) return;
    const claim = readSharedClaim(storage, identity);
    if (claim === null) return;
    if (claim.key !== previousKey) return;
    writeSharedClaim(storage, identity, { key: intent.key, settings: intent.settings, at: Date.now() });
  } catch {
    // A browser that refuses the storage keeps the claim in memory only.
  }
}

/**
 * The lock manager of the browser.
 *
 * The lock of the browser is held across the tabs of the same origin.
 */
interface BrowserLockManager {
  request<R>(name: string, callback: () => Promise<R>): Promise<R>;
}

/**
 * The lock of the browser, when it has one.
 *
 * The Web Locks API is the lock of the origin, so every tab of the browser
 * waits for the lock of the other tabs.
 */
function browserLockManager(): BrowserLockManager | null {
  const scope = globalThis as unknown as { navigator?: { locks?: BrowserLockManager } };
  return scope.navigator?.locks ?? null;
}

/**
 * The queue cannot take the lock of the shared entry.
 *
 * The browser cannot serialize the tabs of the origin, so the claim of the
 * shared entry cannot be taken safely. The queue fails closed with this
 * error, instead of racing the other tabs of the browser.
 */
export class OnlineQueueLockUnavailableError extends Error {
  constructor(
    message = 'This browser cannot share one queue entry between its tabs. Use a browser with the Web Locks API.',
  ) {
    super(message);
    this.name = 'OnlineQueueLockUnavailableError';
  }
}

/**
 * The identity changed while the queue entry was created.
 *
 * The entry may exist under the identity that asked for it, so the browser
 * keeps a durable obligation to cancel it in the namespace of that identity.
 * The enter that started the work reports this failure instead of pretending
 * that the entry was created.
 */
export class OnlineQueueIdentityChangedError extends Error {
  constructor(
    message = 'The account changed before the queue entry was created. The entry is cancelled when the account returns.',
  ) {
    super(message);
    this.name = 'OnlineQueueIdentityChangedError';
  }
}

/**
 * The entry of a deliberate selection change could not be resolved.
 *
 * The owner asked for a new entry, and the entry of the old settings won the
 * race against its cancellation: it produced exactly one game. The game is
 * cancelled through the participant command route, and no second entry is
 * created while that cancellation is unconfirmed, so the owner never ends up
 * with two eligible shared entries and the assignment is never abandoned.
 *
 * The obligation of the replaced entry survives the failure, so a later try
 * resolves the game instead of starting a second search.
 */
export class OnlineQueueUnresolvedEntryError extends Error {
  constructor(
    message = 'The previous queue entry could not be cancelled, so no new entry was created. Try again.',
  ) {
    super(message);
    this.name = 'OnlineQueueUnresolvedEntryError';
  }
}

/**
 * The default lock of the shared queue entry.
 *
 * The lock of the origin is held across the tabs of the same browser, so two
 * tabs that enter the queue at the same moment claim one key and reach one
 * entry.
 *
 * A runtime without the lock of the origin cannot serialize its tabs. The
 * claim of the shared entry is a read-modify-write of the storage, and two
 * tabs would interleave it and mint two keys for the same logical entry -
 * two entries, two games and two consents where the owner asked for one.
 *
 * There is no sound fallback for that write: the storage of the browser has
 * no compare-and-swap, so a lock that is not held by the origin cannot make
 * the claim atomic. The queue therefore fails closed with an actionable error
 * wherever the lock of the origin is missing, instead of racing the other
 * tabs of the browser.
 */
async function defaultQueueLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  const manager = browserLockManager();
  if (manager === null) throw new OnlineQueueLockUnavailableError();
  return manager.request(name, run);
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
 * The idempotency key of the cancellation of an assigned game.
 *
 * The key is stable: the same intent always cancels its game with the same
 * key, so a retry of the cancellation answers with the same receipt instead
 * of acting twice. One entry produces exactly one game, so the key of the
 * intent names that game and nothing else.
 */
function matchCancelOperationId(intentKey: string): string {
  return `cancel-${intentKey}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
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

/**
 * True when the service refused a request with a conflict.
 *
 * A conflict is not a final answer: it means the state of the service moved
 * on. The queue refuses the cancellation of an assigned entry with a
 * conflict, because the entry produced exactly one game and the game is
 * cancelled through the participant command route, not through the queue.
 *
 * A conflict therefore never releases an obligation on its own: the browser
 * reconciles the state first.
 */
function isConflictRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isFinite(status) && status === 409;
}

function createIntentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `intent${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * Mints the identity of the runner of this browser tab.
 *
 * The identity is opaque and unique to the tab. The service refuses a second
 * runner of a seat that a live lease holds, so two tabs of one owner need two
 * identities: a tab that shares the identity of another tab is taken for the
 * holder of the lease instead of for a duplicate, and both tabs drive the
 * seat and ask the provider a second time.
 *
 * The identity of a tab never changes while the tab lives, so the runner of a
 * seat keeps the lease it took when it renews it and when it takes a new one
 * after a loss.
 */
function createRunnerTabIdentity(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  const random = `${Math.random().toString(36)}${Math.random().toString(36)}`.replace(/[^a-z0-9]/g, '');
  return `runner${random}`.slice(0, 40);
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

/** The state of a queue entry that owns nothing. */
function idleQueueState(): OnlineQueueState {
  return {
    phase: 'idle',
    entry: null,
    detail: '',
    assignment: null,
    engineState: 'idle',
    cutoffAt: null,
    options: [],
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
  /**
   * The lock of the shared queue entry.
   *
   * The claim of the shared entry is taken under it, so the tabs of the same
   * browser never claim two keys for the same entry.
   */
  const queueLock: <T>(name: string, run: () => Promise<T>) => Promise<T> = options.queueLock ?? defaultQueueLock;
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
  /**
   * The pending record of the agent seats of this composition.
   *
   * The record names the provider request that may still be running. It
   * belongs to the seat and not to one runner, so a runner that replaces
   * another one still sees it and never asks the provider for a second answer
   * by itself.
   */
  const agentPendingStore = createLocalPendingStore();
  /**
   * The identity of the runner of this browser tab.
   *
   * The lease of a seat is held by one runner, and the service refuses a
   * second runner of a seat that a live lease holds. The identity is unique to
   * the tab, so a duplicate tab of the owner is refused instead of being taken
   * for the holder of the lease. It never changes while the tab lives, so the
   * runner of a seat keeps the lease it took.
   */
  const runnerTabIdentity = createRunnerTabIdentity();
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
    readonly kind: 'switch' | 'takeover' | 'handoff';
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
  let featuresStatus: OnlineFeaturesStatus = ONLINE_FEATURES_STATUS_UNKNOWN;
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
  /**
   * The published state of the invitations this identity owns.
   *
   * The view is the public metadata of the invitation. The owner token stays
   * in the secret store, so the screen never carries it.
   */
  const ownedInvitationViews = new Map<string, FriendInvitation>();
  /** The published list of the owned invitations. */
  let ownedInvitationList: readonly FriendInvitation[] = [];
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
      //
      // The runners of the previous identity stop at once. A runner holds a
      // provider request that may still be on the wire and the lease of a
      // seat: a runner that keeps working after the identity left would keep
      // a private model request of the previous identity alive, and it could
      // submit a move of it. The runners give their leases back with the
      // authority that took them, so the transport of a seat stays usable
      // until they released them.
      const releasedRunners = fenceAgentRunners();
      // The queue records of the previous identity leave the browser as
      // well. A record belongs to the identity that created it: the new
      // identity never shows the idle row of another account, and it never
      // controls the entry of that account. The durable intents and the claim
      // of the previous identity stay in its own namespace on the device, so
      // that identity finds them again when it returns.
      fenceQueueRecords();
      fenceAccountSeats(releasedRunners);
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
      // The published invitations belong to the identity that created them.
      // The new identity finds its own invitations again in the read that
      // follows.
      ownedInvitationViews.clear();
      ownedInvitationList = [];
      restoreTrackedInvitations();
      restoreAcceptedSeats();
      restorePersistedMatches();
      // The waiting entries of the identity are shown again, with the cutoff
      // the service gave them. The restoration reads the entries and never
      // creates one.
      restoreWaitingEntries();
      // The entries the identity left behind while a creation was on the wire
      // are resolved now. The obligation belongs to the identity that asked
      // for them, so the cancellation runs with the credential of that
      // identity and never with the credential of another one.
      resolvePendingCleanups(queueIdentity(), identityGeneration);
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

  /**
   * Stops the browser runners of this composition.
   *
   * A runner holds the lease of a seat and may hold a provider request that is
   * still on the wire. A runner that keeps working after its owner left would
   * keep a private provider request of the previous identity alive, and it
   * could submit a move of it. The runners are stopped at once: the pending
   * provider request is aborted, the lease of the seat is given back with the
   * authority that took it, and the runners leave the map, so a fenced runner
   * is never driven again.
   *
   * The promise settles when every runner released its lease. The caller keeps
   * the transport of a seat usable until it settles, so a release that is
   * still on the wire never loses its requester.
   */
  function fenceAgentRunners(): Promise<void> {
    const runners = [...agentRunners.values()];
    agentRunners.clear();
    if (runners.length === 0) return Promise.resolve();
    return Promise.all(runners.map(runner => runner.dispose().catch(() => undefined)))
      .then(() => undefined);
  }

  /**
   * Disposes the transport of one seat after its runners released their leases.
   *
   * A runner gives its lease back with the authority that took it, so the
   * transport of the seat stays usable until the runners released them. A
   * release that could not be made never blocks the disposal of the seat.
   */
  async function disposeSeatTransport(
    transport: { readonly requester: AuthorizedRequester | null; readonly session: ParticipantSession | null },
    released: Promise<unknown>,
  ): Promise<void> {
    try {
      await released;
    } catch {
      // A lease that could not be released never blocks the disposal.
    }
    transport.requester?.dispose();
    transport.session?.dispose();
  }

  /**
   * Disposes the seat authority the previous account held.
   *
   * The runners of the previous identity release their leases with the
   * authority that took them, so the transport of a seat stays usable until
   * the runners gave their leases back.
   */
  function fenceAccountSeats(released: Promise<unknown>): void {
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
        void disposeSeatTransport(transport, released);
        continue;
      }
      engineSeats.delete(key);
      // The engine seat releases the lease of its turn with the transport it
      // used, and that transport is disposed afterwards.
      void engine.dispose().catch(() => undefined).then(() => disposeSeatTransport(transport, released));
    }
  }

  /**
   * Removes the queue records of the identities that are no longer current.
   *
   * A record belongs to the identity that created it, so the identity change
   * takes the records of the previous identity away. The new identity never
   * shows the idle row of another account, and it never controls the entry of
   * that account: a cancel of a record of another identity would release the
   * claim and the intent under the wrong namespace.
   *
   * The durable intents and the claim of the previous identity stay in its
   * own namespace on the device, so that identity finds them again when it
   * returns.
   */
  function fenceQueueRecords(): void {
    const current = queueIdentity();
    let removed = false;
    for (const record of [...queueRecords.values()]) {
      if (record.identity === current) continue;
      removed = true;
      queueRecords.delete(record.id);
      // The controller of the record is disposed, so the attempt of the
      // previous identity is fenced and its timer stops.
      record.controller.dispose();
      if (record.pollTimer !== null) {
        timers.clearTimer(record.pollTimer);
        record.pollTimer = null;
      }
      // The entry of the record is not shown by this browser any more.
      for (const [entryId, recordId] of [...entryRecords]) {
        if (recordId === record.id) entryRecords.delete(entryId);
      }
    }
    if (!removed) return;
    const active = activeQueueId === null ? null : queueRecords.get(activeQueueId) ?? null;
    activeQueueId = active?.id ?? null;
    queueState = active?.state ?? idleQueueState();
    notify();
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
        // The generation fences the whole preparation of the entry. An
        // identity that leaves and comes back is a different generation, so
        // the entry of the older one never reaches the current identity.
        const generation = identityGeneration;
        const settings = intentSettings(request.control, request.timeControl);
        // The record owns the entry of these settings from now on, so a
        // second request knows whether it asks for the entry of the owner or
        // for another one.
        record.settings = settings;
        const intents = readIntents(storage, identity);
        // The intent of the record is the one it claimed. The intent of an
        // older session of the browser never becomes the intent of this
        // record. An intent with a cleanup obligation is never reused: it
        // names an entry that has to be cancelled, not an entry to wait with.
        const own = record.intentKey === null
          ? []
          : intents.filter(intent => intent.key === record.intentKey && !intent.cleanup);
        const previous = own.length > 0 ? own[own.length - 1]! : null;
        // The planned intent is the entry of the owner: the answer of its
        // creation was lost, and the same key reaches the same entry.
        const planned = record.planned !== null && record.planned.settings === settings
          ? record.planned
          : null;
        record.planned = null;
        if (previous && previous.settings !== settings) {
          // A settings change resolves the entry of the previous intent
          // first, so the service never keeps an abandoned entry.
          const resolution = await resolveIntentEntry(previous, identity, generation);
          assertCurrentIdentity(identity, generation);
          if (resolution !== 'resolved') {
            // The entry of the previous intent is not over, so no new entry
            // is created: the owner never ends up with two eligible shared
            // entries. The obligation of the previous entry survives, so a
            // later try resolves it instead of abandoning it.
            await markCleanupObligation(identity, previous.key, previous.entryId);
            throw new OnlineQueueUnresolvedEntryError();
          }
        }
        // A deliberate selection change replaces the entry of the previous
        // settings. The entry is cancelled after the readiness of the new
        // settings, so a failed readiness never abandons it. The other
        // entries of the owner keep waiting.
        if (record.replaces !== null) {
          const replaced = record.replaces;
          const resolution = await resolveIntentEntry(replaced, identity, generation);
          assertCurrentIdentity(identity, generation);
          if (resolution !== 'resolved') {
            // The entry of the replaced settings won the race against its
            // cancellation and its game could not be cancelled, so no second
            // entry is created: the owner never ends up with two eligible
            // shared entries, and the assignment is never abandoned.
            //
            // The replaced intent keeps the obligation, so a later try
            // resolves the game instead of starting a second search.
            record.replaces = replaced;
            await markCleanupObligation(identity, replaced.key, replaced.entryId);
            throw new OnlineQueueUnresolvedEntryError();
          }
          record.replaces = null;
        }
        const current = readIntents(storage, identity);
        // A terminal intent never reaches the service again: the owner asked
        // for a game, so a fresh entry is created instead of the finished one.
        const reusable = planned ?? (previous !== null && previous.settings === settings && previous.state !== 'terminal'
          ? current.find(intent => intent.key === previous.key) ?? previous
          : null);
        const intent: QueueIntent = reusable !== null
          ? { ...reusable, recordId: record.id }
          : {
          key: createIntentId(),
          settings,
          control: request.control,
          timeControl: request.timeControl,
          entryId: null,
          recordId: record.id,
          // The intent names an entry that may still be reached.
          state: 'live',
          // The request has not left the browser yet.
          sent: false,
          // The record owns the shared entry of the owner, or an explicit
          // entry of its own.
          shared: record.shared,
          // The private selection of the agent is captured before the service
          // is asked. A model the owner picks later never replaces the agent
          // of this entry.
          selection: request.control.kind === 'agent' ? agent?.selection ?? null : null,
          // The entry has no game yet.
          engineMatchId: null,
          // The entry has no cleanup obligation: it is an entry the owner
          // waits with.
          cleanup: false,
        };
        // The readiness of the seat succeeded, so the request leaves the
        // browser now. The intent says so before it goes, so a lost answer is
        // recovered with the same key and never with a second entry.
        const sending: QueueIntent = { ...intent, sent: true };
        // The key of the record changes when the settings change. The claim of
        // the shared entry follows the record, so no tab ever reaches the
        // terminal key of the replaced entry.
        const previousKey = record.intentKey;
        await withQueueLock(identity, async () => {
          // The identity may have changed while the lock was waited for.
          assertCurrentIdentity(identity, generation);
          const stored = readIntents(storage, identity);
          writeIntents(storage, identity, [
            ...stored.filter(existing => existing.key !== sending.key),
            sending,
          ]);
          moveSharedClaim(storage, identity, previousKey, sending);
        });
        // The record owns the intent from now on, so its retry reaches the
        // same entry.
        record.intentKey = sending.key;
        // The identity may have changed while the lock was held. The entry of
        // the older identity never reaches the service.
        assertCurrentIdentity(identity, generation);
        let created: QueueEntry;
        try {
          created = await queueClient.createEntry({
            schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
            control: request.control,
            timeControl: request.timeControl,
            clientRequestId: sending.key,
          });
        } catch (error) {
          // A definitive refusal releases the intent and the claim of it. An
          // unknown answer keeps them, so the retry reaches the same entry
          // instead of a second one.
          if (isDefinitiveRefusal(error)) {
            await withQueueLock(identity, async () => {
              const stored = readIntents(storage, identity);
              writeIntents(storage, identity, stored.filter(existing => existing.key !== sending.key));
              releaseSharedClaim(storage, identity, sending.key);
            });
          } else if (!identityIs(identity, generation)) {
            // The identity changed while the creation was on the wire. The
            // service may have accepted the entry under the identity that
            // asked, and the answer never arrives. The obligation to cancel
            // that entry is persisted in the namespace of the identity that
            // asked, so the entry is recovered with the same key and
            // cancelled when that identity returns.
            //
            // The new identity never issues a request for the entry of the
            // old one: a cancel under the credential of another identity would
            // be a request of the old entry made by the wrong participant.
            await markCleanupObligation(identity, sending.key, null);
            record.failure = new OnlineQueueIdentityChangedError();
          }
          throw error;
        }
        if (!identityIs(identity, generation)) {
          // The identity changed while the entry was created. The entry
          // belongs to the identity that asked for it, so the obligation to
          // cancel it is persisted in the namespace of that identity and the
          // entry is cancelled when that identity returns. The entry is never
          // stored under the identity that signed in in the meantime.
          await markCleanupObligation(identity, sending.key, created.entryId);
          record.failure = new OnlineQueueIdentityChangedError();
          throw record.failure;
        }
        // The entry of the intent is tracked, so a later settings change can
        // resolve it instead of abandoning it.
        await upsertIntent(identity, sending.key, { ...sending, entryId: created.entryId });
        // The record of the browser owns the entry, so a reload resumes
        // the same record instead of showing the entry twice.
        entryRecords.set(created.entryId, record.id);
        // The seat of the entry is the seat of the owner. The binding of
        // the private selection happens when the match is assigned, because
        // only the assignment knows the seat of the owner.
        return created;
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

  /**
   * Replaces one intent of an identity, under the lock.
   *
   * The intents of an identity live in one storage key, so a write of one
   * tab and a write of another tab have to be serialized: the lock of the
   * origin makes the read-modify-write of the list atomic.
   */
  async function upsertIntent(identity: string, key: string, intent: QueueIntent): Promise<void> {
    await withQueueLock(identity, async () => {
      const intents = readIntents(storage, identity);
      const stored = intents.find(existing => existing.key === key);
      // A terminal intent stays terminal: the key of a finished entry never
      // reaches the service again, whatever the browser writes into it.
      const next = stored !== undefined && stored.state === 'terminal'
        ? { ...intent, state: 'terminal' as QueueIntentState }
        : intent;
      writeIntents(storage, identity, [
        ...intents.filter(existing => existing.key !== key),
        next,
      ]);
    });
  }

  /**
   * Removes one intent of an identity, under the lock.
   *
   * The removal is serialized with the writes of the other tabs, so a tab
   * never drops the intent of an entry that another tab still waits with.
   */
  async function removeIntent(identity: string, key: string): Promise<void> {
    await withQueueLock(identity, async () => {
      const intents = readIntents(storage, identity);
      writeIntents(storage, identity, intents.filter(existing => existing.key !== key));
    });
  }

  /**
   * Marks one intent of an identity as terminal, under the lock.
   *
   * A completed game keeps its intent, because the recovery of the engine
   * seat needs it. The intent is terminal, so the key of the finished entry
   * never reaches the service again and never pins the next entry.
   */
  async function markIntentTerminal(identity: string, key: string): Promise<void> {
    await withQueueLock(identity, async () => {
      const intents = readIntents(storage, identity);
      writeIntents(storage, identity, intents.map(existing => existing.key === key
        ? { ...existing, state: 'terminal' as QueueIntentState }
        : existing));
    });
  }

  /**
   * Releases the claim of the shared entry of an identity, under the lock.
   *
   * The release is serialized with the claim of the other tabs, so a claim of
   * a terminal entry never survives the terminal state of that entry.
   */
  async function releaseSharedClaimOf(identity: string, key: string): Promise<void> {
    await withQueueLock(identity, async () => {
      releaseSharedClaim(storage, identity, key);
    });
  }

  /**
   * Discards an intent whose entry is over, under the lock.
   *
   * A cancelled, an expired or a completed entry never waits again. The
   * intent is marked terminal and the claim of the shared entry is released,
   * so the next enter of the owner reaches a fresh entry and never the
   * terminal one: the read of the service wins over a stale claim and a
   * stale intent.
   */
  async function discardTerminalIntent(
    identity: string,
    generation: number,
    intent: QueueIntent,
  ): Promise<void> {
    if (!identityIs(identity, generation)) return;
    await withQueueLock(identity, async () => {
      const intents = readIntents(storage, identity);
      if (!intents.some(existing => existing.key === intent.key)) return;
      writeIntents(storage, identity, intents.map(existing => existing.key === intent.key
        ? { ...existing, state: 'terminal' as QueueIntentState }
        : existing));
      releaseSharedClaim(storage, identity, intent.key);
    });
  }

  /**
   * Resolves the entry of one intent.
   *
   * The entry id can be unknown when the creation answer was lost. The same
   * key with the original settings answers with the same entry, so the entry
   * is recovered before it is cancelled. A cancellation whose outcome is
   * unknown keeps the entry tracked.
   *
   * An intent whose request never left the browser has no entry at all: the
   * readiness of an agent failed, so the service knows nothing about it. The
   * intent is dropped without asking the service for an entry, so a failed
   * readiness never creates a queue entry that could be matched.
   *
   * The work belongs to the identity that owns the intent. When the
   * generation is given, the resolution stops as soon as that identity is no
   * longer the current one, so a cancellation is never issued under the
   * credential of another identity. The learned entry id is kept in the
   * namespace of the identity that owns the intent, so a later return of that
   * identity cancels the entry without asking the service for it again.
   *
   * The answer tells the caller whether the entry is over. An unknown answer
   * keeps the entry tracked, so a later try resolves it.
   */
  async function resolveIntentEntry(
    intent: QueueIntent,
    identity: string,
    generation?: number,
  ): Promise<IntentResolution> {
    const current = (): boolean => generation === undefined || identityIs(identity, generation);
    let entryId = intent.entryId;
    if (entryId === null) {
      if (!intent.sent) {
        // The request was never sent, so there is no entry to recover.
        await removeIntent(identity, intent.key);
        return 'resolved';
      }
      try {
        const recovered = await queueClient.createEntry({
          schemaVersion: ONLINE_CONTRACTS_SCHEMA_VERSION,
          control: intent.control,
          timeControl: intent.timeControl,
          clientRequestId: intent.key,
        });
        entryId = recovered.entryId;
        // The learned entry id belongs to the identity that asked, so it is
        // kept in its own namespace even when that identity is no longer the
        // current one.
        await upsertIntent(identity, intent.key, { ...intent, entryId });
      } catch {
        // The outcome is unknown. The entry stays tracked, so a later retry
        // resolves it instead of abandoning it.
        return 'pending';
      }
    }
    // The identity may have changed while the entry was recovered. The
    // cancellation is not issued then: a request for the entry of another
    // identity would be made with the credential of the wrong participant.
    // The entry id is already known, so the identity that owns the intent
    // cancels it when it returns.
    if (!current()) return 'pending';
    try {
      await queueClient.cancel(entryId, queueOperationBody(operationId('cancel', entryId)));
      await removeIntent(identity, intent.key);
      return 'resolved';
    } catch (error) {
      // A conflict means the entry won the race against the cancellation: it
      // is assigned and it produced exactly one game. The game is cancelled
      // through the participant command route, not through the queue.
      if (isConflictRefusal(error)) {
        return resolveAssignedGame(intent, identity, entryId, current);
      }
      // A definitive refusal means the entry is gone. An unknown outcome
      // keeps the entry tracked.
      if (isDefinitiveRefusal(error)) {
        await removeIntent(identity, intent.key);
        return 'resolved';
      }
      return 'pending';
    }
  }

  /**
   * Resolves the game of an entry that won the race against a cancellation.
   *
   * The queue refuses the cancellation of an assigned entry with a conflict:
   * the entry produced exactly one game, and the game is cancelled through the
   * participant command route, not through the queue. The service decides what
   * the cancellation means: a cancellation before the first accepted move of
   * the seat aborts the game, and a cancellation afterwards resigns it.
   *
   * The command carries a stable operation identifier, so a retry answers with
   * the same receipt instead of acting twice. The version and the control
   * epoch come from the authoritative view of the game, so the command names
   * the state the service holds and the seat is the seat of the owner.
   *
   * The obligation of the intent survives an unknown outcome: the entry stays
   * tracked, so a later try cancels the game instead of abandoning it. The
   * work never leaves the identity that owns the intent, so a cancellation is
   * never issued under the credential of another identity.
   */
  async function resolveAssignedGame(
    intent: QueueIntent,
    identity: string,
    entryId: string,
    current: () => boolean,
  ): Promise<IntentResolution> {
    // The entry is read again. The refusal may have changed it: the entry may
    // be cancelled already, or it may be assigned.
    const read = await readQueueEntry(entryId);
    if (read.kind === 'unknown') {
      // The service did not answer, so the outcome is unknown.
      return 'pending';
    }
    if (!current()) return 'pending';
    if (read.kind === 'absent') {
      // The entry is gone.
      await removeIntent(identity, intent.key);
      return 'resolved';
    }
    const entry = read.entry;
    if (entry.status === 'cancelled') {
      // The cancellation of the entry happened after all.
      await removeIntent(identity, intent.key);
      return 'resolved';
    }
    if (entry.status !== 'assigned' || entry.assignedMatchId === null) {
      // The entry still waits. The conflict named another state of the entry,
      // so the cancellation is tried once more with the same operation key.
      try {
        await queueClient.cancel(entryId, queueOperationBody(operationId('cancel', entryId)));
      } catch {
        return 'pending';
      }
      await removeIntent(identity, intent.key);
      return 'resolved';
    }
    // The entry produced its game. The state of the game is read from the
    // service: the browser never guesses the seat of the owner, the version of
    // the game or its outcome.
    const game = await readGame(entry.assignedMatchId);
    if (!current()) return 'pending';
    if (game.kind === 'absent') {
      // The game is gone.
      await removeIntent(identity, intent.key);
      return 'resolved';
    }
    if (game.kind === 'unknown') {
      // The service did not answer, so the outcome is unknown.
      return 'pending';
    }
    const view = game.view;
    if (view.status !== 'active') {
      // The game is over. Nothing is left to cancel.
      await removeIntent(identity, intent.key);
      return 'resolved';
    }
    const seat = view.yourSeat;
    if (seat === null) return 'pending';
    const client = commandClient(view.matchId, seat);
    if (client === null) {
      // The browser holds no authority for the seat of the owner, so the game
      // cannot be cancelled. The obligation survives.
      return 'pending';
    }
    try {
      await client.cancel({
        operationId: matchCancelOperationId(intent.key),
        expectedVersion: view.version,
        controlEpoch: view.controlEpoch,
      });
    } catch {
      // The service refused the command or its answer was lost. The game
      // decides: a game that ended is over, and a game that still plays keeps
      // the obligation of the intent.
      const confirmed = await readGame(view.matchId);
      if (confirmed.kind === 'absent') {
        await removeIntent(identity, intent.key);
        return 'resolved';
      }
      if (confirmed.kind === 'view' && confirmed.view.status !== 'active') {
        await removeIntent(identity, intent.key);
        return 'resolved';
      }
      return 'pending';
    }
    await removeIntent(identity, intent.key);
    return 'resolved';
  }

  /**
   * Reads the authoritative view of one game.
   *
   * The view is the participant view of the service. It owns the seat of the
   * owner, the version of the game and its outcome, and the browser reads them
   * instead of guessing them.
   */
  async function readGame(matchId: string): Promise<GameRead> {
    const requester = accountRequester();
    if (!requester) return { kind: 'unknown' };
    let result: { readonly status: number; readonly ok: boolean; readonly data: unknown };
    try {
      result = await requester.request({ kind: 'account' }, {
        path: `/v1/online/matches/${encodeURIComponent(matchId)}`,
      });
    } catch {
      return { kind: 'unknown' };
    }
    if (!result.ok) return result.status === 404 ? { kind: 'absent' } : { kind: 'unknown' };
    try {
      return { kind: 'view', view: parseOnlineMatchView(result.data, matchId) };
    } catch {
      return { kind: 'unknown' };
    }
  }

  /**
   * Persists the obligation to cancel the entry of one intent.
   *
   * The obligation is written in the namespace of the identity that asked for
   * the entry, so it belongs to that identity alone. Another identity never
   * reads it and never resolves it.
   *
   * The intent of the entry keeps its key, so the entry is recovered with the
   * same key and the service never sees a second entry for it.
   */
  async function markCleanupObligation(
    identity: string,
    key: string,
    entryId: string | null,
  ): Promise<void> {
    await withQueueLock(identity, async () => {
      const intents = readIntents(storage, identity);
      if (!intents.some(existing => existing.key === key)) return;
      writeIntents(storage, identity, intents.map(existing => existing.key === key
        ? { ...existing, cleanup: true, ...(entryId === null ? {} : { entryId }) }
        : existing));
    });
  }

  /**
   * Resolves the obligations of the entries of one identity.
   *
   * An obligation is the entry that the service may have accepted under an
   * identity that left while the creation was on the wire. The identity that
   * owns the obligation resolves it when it returns: the entry is recovered
   * with the same key and cancelled, so it never waits behind the owner's
   * back and never matches as abandoned work.
   *
   * The obligation of another identity is never resolved here: the request
   * would be made with the credential of the wrong participant.
   */
  function resolvePendingCleanups(identityKey: string, generation: number): void {
    if (disposed) return;
    for (const intent of readIntents(storage, identityKey)) {
      if (!intent.cleanup) continue;
      if (intent.state === 'terminal') continue;
      void resolveCleanupObligation(intent, identityKey, generation);
    }
  }

  /**
   * Resolves one obligation of an entry.
   *
   * The claim of the shared entry is released with the intent, so a claim
   * never names an entry that is over.
   */
  async function resolveCleanupObligation(
    intent: QueueIntent,
    identityKey: string,
    generation: number,
  ): Promise<void> {
    const resolution = await resolveIntentEntry(intent, identityKey, generation);
    if (resolution !== 'resolved') return;
    await withQueueLock(identityKey, async () => {
      releaseSharedClaim(storage, identityKey, intent.key);
    });
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
    /**
     * True when the record owns the shared entry of the owner.
     *
     * The shared entry is the entry the default enter joins: a second tab, a
     * reload and a settings change reach it. An explicit second game owns
     * its own record, and the default enter never joins it, never replaces
     * it and never cancels it.
     */
    shared: boolean;
    /**
     * The identity that owns the record.
     *
     * A record belongs to the identity that created it. The identity change
     * removes the records of the previous identity, so the new identity never
     * shows the row of another account and never controls its entry. The
     * terminal handling of the record - the release of the claim and the
     * removal of the intent - is scoped to this identity, so it never touches
     * the namespace of another one.
     */
    identity: string;
    /**
     * The settings of the entry the record owns.
     *
     * The settings are locked while the entry waits, so a later request
     * knows whether it asks for the entry of the owner or for another one.
     */
    settings: string;
    /**
     * The key of the intent the record owns.
     *
     * The record knows its own intent, so the intent of an older session of
     * the browser never becomes the intent of a new record. The durable
     * intent of the owner is found by its settings, not by the name of a
     * record.
     */
    intentKey: string | null;
    /**
     * The intent the record must use, when the owner reached an entry whose
     * creation answer was lost.
     *
     * The key of the intent reaches the entry of the owner, so the recovery
     * of a lost answer never creates a second entry.
     */
    planned: QueueIntent | null;
    /**
     * The intent of the entry a deliberate selection change replaces.
     *
     * The entry is cancelled after the readiness of the new settings, so a
     * failed readiness never abandons the entry of the owner.
     */
    replaces: QueueIntent | null;
    /**
     * The failure of the last attempt of the record.
     *
     * The failure is kept when the attempt could not be proven, so the enter
     * that started it reports it instead of pretending that the entry was
     * created. A record of another identity never carries the failure of the
     * identity that left.
     */
    failure: Error | null;
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

  function createQueueRecord(options: {
    readonly settings: string;
    readonly planned?: QueueIntent | null;
    readonly replaces?: QueueIntent | null;
    readonly shared?: boolean;
    readonly identity?: string;
  }): QueueRecord {
    const id = `queue-${queueRecords.size + 1}`;
    const record: QueueRecord = {
      id,
      shared: options.shared ?? false,
      identity: options.identity ?? queueIdentity(),
      settings: options.settings,
      intentKey: null,
      planned: options.planned ?? null,
      replaces: options.replaces ?? null,
      failure: null,
      controller: null as unknown as OnlineQueueController,
      state: idleQueueState(),
      pollTimer: null,
    };
    record.controller = createOnlineQueueController({
      timers,
      ports: queuePortsFor(record),
      onState: state => {
        record.state = state;
        if (activeQueueId === id) queueState = state;
        // A terminal entry releases the claim of the shared entry, and it does
        // so before the intent of the record leaves. The claim of the owner
        // names the entry that waits, so a cancelled, an expired and a
        // completed entry never hold the next entry of the owner.
        //
        // The claim is released by the key of the record, never by a scan of
        // the intents: the intent of a cancelled entry is gone by then, and a
        // scan would keep the claim of the cancelled key and pin the next
        // enter of the owner to it.
        //
        // The claim belongs to the identity that owns the record. The
        // identity that owns the entry releases its own claim, never the
        // claim of the identity that is signed in now.
        if (state.phase === 'cancelled' || state.phase === 'expired' || state.phase === 'matched') {
          const identity = record.identity;
          const key = record.intentKey;
          if (key !== null) {
            void releaseSharedClaimOf(identity, key).catch(() => undefined);
          }
        }
        // A terminal entry releases the intent of *this* record. The intent of
        // another entry stays untouched. A matched entry keeps its intent:
        // the entry id is the only way to ask the service to rotate the
        // credential of the engine seat when the identity comes back, and the
        // credential of a lost answer never returns on its own. The intent of
        // a matched entry is terminal, so the key of the finished entry never
        // reaches the service again.
        if (state.phase === 'cancelled' || state.phase === 'expired') {
          const identity = record.identity;
          const key = record.intentKey;
          if (key !== null) {
            void removeIntent(identity, key).catch(() => undefined);
          }
        }
        if (state.phase === 'matched') {
          const identity = record.identity;
          const key = record.intentKey;
          if (key !== null) {
            void markIntentTerminal(identity, key).catch(() => undefined);
          }
        }
        // A committed assignment is attached and shown. The seat keeps the
        // private selection the entry was created with.
        if (state.phase === 'matched' && state.assignment) {
          const identity = record.identity;
          const intent = readIntents(storage, identity)
            .filter(candidate => candidate.key === record.intentKey)
            .slice(-1)[0] ?? null;
          // The game of a browser engine fallback is remembered with the
          // intent, so the recovery of the engine credential only ever asks
          // the service about an entry that already produced its game.
          if (intent && state.assignment.control?.kind === 'engine' && intent.engineMatchId !== state.assignment.matchId) {
            void upsertIntent(identity, intent.key, { ...intent, engineMatchId: state.assignment.matchId })
              .catch(() => undefined);
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
      await enterSharedEntry(request);
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
   * The enter that runs right now.
   *
   * The enters are serialized: a second click waits for the first one, so
   * two simultaneous calls never create two entries.
   */
  let enterChain: Promise<void> = Promise.resolve();

  /**
   * The plan of the shared enter.
   *
   * The plan names the entry of the owner: the entry that waits with the
   * requested settings, the entry of another tab of this browser, the entry
   * whose creation answer was lost, or the entry a deliberate selection change
   * replaces.
   */
  interface SharedPlan {
    readonly kind: 'stale' | 'joined' | 'adopt' | 'reuse' | 'replace' | 'create';
    /** The record of this browser that waits already. */
    readonly record: QueueRecord | null;
    /** The intent of the entry of the owner. */
    readonly intent: QueueIntent | null;
    /** The entry of another tab of this browser. */
    readonly entry: QueueEntry | null;
    /** The entry a deliberate selection change replaces. */
    readonly replaced: QueueIntent | null;
  }

  /**
   * The claim of the shared entry.
   *
   * The claim carries the key of the entry the owner waits with. The entry is
   * created with that key, so the service answers with the entry of the owner
   * and never with a second one.
   */
  type SharedClaim =
    | { readonly kind: 'adopt'; readonly intent: QueueIntent; readonly entry: QueueEntry }
    | { readonly kind: 'enter'; readonly intent: QueueIntent };

  /**
   * Enters the queue with the entry the owner already waits with.
   *
   * The default joins the entry of the owner: a second tab, a second click
   * and a reload reach the same entry. Only an explicit second game asks for
   * another one.
   */
  async function enterSharedEntry(request: { control: SeatControl; timeControl: TimeControl }): Promise<void> {
    // The identity of the enter is captured when it is scheduled. The same
    // account that signs in again is a different generation, so an enter of
    // an older identity never reaches the current one.
    const identity = queueIdentity();
    const generation = identityGeneration;
    const run = enterChain.then(async () => {
      if (!identityIs(identity, generation)) return;
      await runSharedEnter(request, identity, generation);
    });
    // The chain never rejects, so a failed enter never blocks a later one.
    enterChain = run.then(() => undefined, () => undefined);
    await run;
  }

  /**
   * Creates an explicit parallel entry.
   *
   * The entry owns its own intent, its own key and its own timer. The
   * entries of the owner stay untouched, and the entry of the owner is never
   * cancelled by it.
   */
  async function enterExplicitEntry(request: { control: SeatControl; timeControl: TimeControl }): Promise<void> {
    const record = createQueueRecord({ settings: intentSettings(request.control, request.timeControl) });
    await record.controller.enter(request);
    // The attempt that could not be proven is reported, so the owner never
    // reads a success that never happened.
    if (record.failure !== null) throw record.failure;
  }

  /**
   * Joins the entry of the owner, or creates the shared one.
   *
   * A record of this browser that already waits with the requested settings
   * is joined, never duplicated. The durable intent of the identity is the
   * entry of another tab of the same browser, so the entry of the owner is
   * reached instead of a second one.
   */
  async function runSharedEnter(
    request: { control: SeatControl; timeControl: TimeControl },
    identity: string,
    generation: number,
  ): Promise<void> {
    const settings = intentSettings(request.control, request.timeControl);
    // The shared entry of this browser that waits with the requested settings
    // is the entry of the owner. It is joined.
    //
    // An explicit second game owns its own entry. The default enter never
    // joins it, never replaces it and never cancels it, so an explicit entry
    // with the same settings is never the target of the default action.
    const matching = liveRecords().filter(record => record.shared && record.settings === settings);
    if (matching.length > 0) {
      await focusSharedRecord(matching[matching.length - 1]!, identity, generation);
      return;
    }
    const plan = await planSharedEnter(identity, generation, settings);
    if (plan.kind === 'stale') return;
    if (plan.kind === 'joined') {
      focusRecord(plan.record!);
      return;
    }
    // The record of the entry is created before the claim, so the claim names
    // the record that owns it.
    const previousActiveId = activeQueueId;
    const record = createQueueRecord({
      settings,
      replaces: plan.kind === 'replace' ? plan.replaced : null,
      // The default enter owns the shared entry of the owner.
      shared: true,
    });
    let claim: SharedClaim | null;
    try {
      claim = await claimSharedEntry(identity, generation, settings, request, record, plan);
    } catch (error) {
      // The claim failed, so the record owns no entry. It leaves again, so the
      // owner never sees an idle entry that the service does not know. The
      // error is not swallowed: the owner learns that the browser cannot
      // share one entry between its tabs.
      discardQueueRecord(record, previousActiveId);
      throw error;
    }
    if (claim === null || !identityIs(identity, generation)) {
      // The claim was refused, so the record owns no entry either.
      discardQueueRecord(record, previousActiveId);
      return;
    }
    if (claim.kind === 'adopt') {
      // The entry of another tab of this browser is adopted. Nothing is
      // created: the entry already exists in the service.
      entryRecords.set(claim.entry.entryId, record.id);
      record.controller.adopt(claim.entry);
      return;
    }
    // The claim carries the key of the entry, so the service answers with the
    // entry of the owner.
    record.planned = claim.intent;
    await record.controller.enter(request);
    // The attempt that could not be proven is reported, so the owner never
    // reads a success that never happened.
    if (record.failure !== null) throw record.failure;
  }

  /**
   * Shows the shared entry of the owner and names it in the claim.
   *
   * The claim of the shared entry is the durable name of the entry the owner
   * waits with. The default enter shows the shared record, so the claim is
   * written for that record: the other tabs of the browser reach the same
   * entry, and the explicit entries of the owner keep their own key.
   */
  async function focusSharedRecord(
    record: QueueRecord,
    identity: string,
    generation: number,
  ): Promise<void> {
    focusRecord(record);
    const key = record.intentKey;
    if (key === null) return;
    await withQueueLock(identity, async () => {
      // The identity may have changed while the lock was waited for.
      if (!identityIs(identity, generation)) return;
      const claim = readSharedClaim(storage, identity);
      if (claim !== null && claim.key === key) return;
      writeSharedClaim(storage, identity, { key, settings: record.settings, at: Date.now() });
    });
  }

  /**
   * Removes a record that never owned an entry.
   *
   * The record of an entry is created before the claim of the shared entry, so
   * a refused claim - a browser that cannot lock its tabs - would leave an
   * idle record that the service knows nothing about. The record leaves
   * again, so the owner never sees an entry that does not exist.
   */
  function discardQueueRecord(record: QueueRecord, previousActiveId: string | null): void {
    if (!queueRecords.delete(record.id)) return;
    record.controller.dispose();
    if (activeQueueId !== record.id) return;
    activeQueueId = previousActiveId;
    const previous = previousActiveId === null ? null : queueRecords.get(previousActiveId) ?? null;
    if (previous) queueState = previous.state;
    notify();
  }

  /**
   * Reads the plan of the shared enter from the durable intents.
   *
   * The intents are ordered from the oldest to the newest, so the newest one
   * is the current entry of the owner. A completed game keeps its intent -
   * the recovery of the engine seat needs it - and never authorizes another
   * entry by itself: only the request of the owner creates one.
   *
   * The shared entry of the owner is the one a deliberate settings change
   * replaces. An explicit second game owns its own entry, and the default
   * enter never takes it away from the owner.
   */
  async function planSharedEnter(identity: string, generation: number, settings: string): Promise<SharedPlan> {
    const intents = readIntents(storage, identity);
    let replaceable: QueueIntent | null = null;
    for (const intent of [...intents].reverse()) {
      const record = recordOfIntent(intent);
      const live = record !== null && isLivePhase(record.state.phase);
      // A finished entry never waits again and never authorizes another
      // entry. Its intent stays for the recovery of the engine seat, and the
      // plan ignores it.
      if (intent.state === 'terminal') continue;
      // An entry with a cleanup obligation is never joined and never
      // replaced here: it names an entry that has to be cancelled, and the
      // obligation is resolved by the identity that owns it.
      if (intent.cleanup) continue;
      if (intent.settings === settings) {
        // An explicit second game owns its own entry. The default enter never
        // joins it, never replaces it and never cancels it.
        if (!intent.shared) continue;
        // The entry of this browser waits already.
        if (live) return sharedPlan('joined', { record });
        // The answer of the creation was lost. The same key reaches the same
        // entry, so the entry of the owner is recovered instead of a second
        // one.
        if (intent.entryId === null) return sharedPlan('reuse', { intent });
        const read = await readQueueEntry(intent.entryId);
        if (!identityIs(identity, generation)) return sharedPlan('stale');
        if (read.kind === 'unknown') {
          // The service did not answer. The entry may exist, so the intent of
          // the owner is preserved and its key is reused: the service answers
          // with the same entry instead of a second one.
          return sharedPlan('reuse', { intent });
        }
        // A definitive refusal means the entry is gone.
        if (read.kind === 'absent') {
          await discardTerminalIntent(identity, generation, intent);
          continue;
        }
        if (isSearchingEntry(read.entry)) {
          // The entry is shown already: it is joined, never shown twice.
          const shown = recordOfEntry(read.entry.entryId);
          if (shown !== null) return sharedPlan('joined', { record: shown });
          // The entry of another tab of this browser is adopted, so both tabs
          // show the same entry.
          return sharedPlan('adopt', { intent, entry: read.entry });
        }
        // A matched entry produced its game already. A cancelled or an
        // expired entry never waits again. The owner asked for a game, so a
        // new entry is created. The terminal entry is discarded here, so the
        // stale claim and the stale intent of it never win over the read of
        // the service.
        await discardTerminalIntent(identity, generation, intent);
        continue;
      }
      // Another settings. The shared entry of the owner is the one a
      // deliberate selection change replaces. An explicit entry of the owner
      // is never replaced by the default enter.
      if (!intent.shared) continue;
      if (replaceable !== null) continue;
      if (live) {
        replaceable = intent;
        continue;
      }
      if (intent.entryId === null) {
        // The answer of the creation was lost, so the entry may exist under
        // the old settings. The intent is resolved before the new entry is
        // created, so the owner never ends up with two eligible shared
        // entries.
        replaceable = intent;
        continue;
      }
      const read = await readQueueEntry(intent.entryId);
      if (!identityIs(identity, generation)) return sharedPlan('stale');
      if (read.kind === 'found' && isSearchingEntry(read.entry)) {
        replaceable = intent;
        continue;
      }
      if (read.kind === 'found') {
        await discardTerminalIntent(identity, generation, intent);
        continue;
      }
      // The service did not answer. The entry may still wait, so it is never
      // treated as absent: the intent is resolved before the new entry is
      // created, and the resolution recovers the entry with the same key and
      // cancels it. The owner never ends up with two eligible shared
      // entries, and the key of the old entry survives the uncertainty.
      replaceable = intent;
    }
    return replaceable === null
      ? sharedPlan('create')
      : sharedPlan('replace', { replaced: replaceable });
  }

  /** Builds one plan of the shared enter. */
  function sharedPlan(kind: SharedPlan['kind'], extra: Partial<SharedPlan> = {}): SharedPlan {
    return { kind, record: null, intent: null, entry: null, replaced: null, ...extra };
  }

  /**
   * Claims the shared entry of the owner.
   *
   * The claim is durable and it names the key of the entry the owner waits
   * with. It is taken under the lock of the browser, so two tabs of the same
   * browser that enter the queue at the same moment claim one key and reach
   * one entry. The claim of the other tab is adopted when it is visible, so
   * the entry of the owner is reached even without the lock.
   */
  async function claimSharedEntry(
    identity: string,
    generation: number,
    settings: string,
    request: { control: SeatControl; timeControl: TimeControl },
    record: QueueRecord,
    plan: SharedPlan,
  ): Promise<SharedClaim | null> {
    return withQueueLock(identity, async () => {
      if (!identityIs(identity, generation)) return null;
      // The entry of the owner is known: its key is reused, so the service
      // answers with the same entry.
      if (plan.kind === 'adopt' || plan.kind === 'reuse') {
        const intent = plan.intent!;
        const owned: QueueIntent = { ...intent, recordId: record.id };
        // The claim of the owner names the key of the entry, so the other
        // tabs of the browser reach it too.
        writeSharedClaim(storage, identity, { key: owned.key, settings: owned.settings, at: Date.now() });
        writeIntents(storage, identity, replaceIntent(readIntents(storage, identity), owned));
        record.intentKey = owned.key;
        if (plan.kind === 'adopt') return { kind: 'adopt', intent: owned, entry: plan.entry! };
        return { kind: 'enter', intent: owned };
      }
      // A new entry is created. The claim of another tab may have landed in
      // the meantime: the same key reaches the same entry.
      const claimed = readSharedClaim(storage, identity);
      if (claimed !== null && claimed.settings === settings) {
        // The claim is usable only when a live intent of these settings backs
        // it. A claim that no intent backs is an orphan, and a claim of a
        // terminal entry - a cancelled, an expired or a completed one - never
        // pins the next entry of the owner: the service would answer with the
        // terminal entry and the owner would wait for a game that is over.
        //
        // A claim of an entry with a cleanup obligation is never used: that
        // entry has to be cancelled, so the owner reaches a fresh one.
        const backed = readIntents(storage, identity)
          .find(candidate => candidate.key === claimed.key);
        if (backed !== undefined && backed.state === 'live' && !backed.cleanup && backed.settings === settings) {
          // The claim of the owner is reached: the same key reaches the same
          // entry of the service.
          const owned: QueueIntent = { ...backed, recordId: record.id };
          writeIntents(storage, identity, replaceIntent(readIntents(storage, identity), owned));
          record.intentKey = owned.key;
          return { kind: 'enter', intent: owned };
        }
        // The claim names a key that no live intent backs. It is released, so
        // the next entry of the owner is a fresh one.
        releaseSharedClaim(storage, identity, claimed.key);
      }
      // The claim of the entry is written before the service is asked, so a
      // lost answer and a second tab reach the same entry.
      const intent = intentForClaim(createIntentId(), settings, request, record.id);
      writeSharedClaim(storage, identity, { key: intent.key, settings, at: Date.now() });
      writeIntents(storage, identity, [...readIntents(storage, identity), intent]);
      record.intentKey = intent.key;
      return { kind: 'enter', intent };
    });
  }

  /** Builds the intent of a claimed entry. */
  function intentForClaim(    key: string,
    settings: string,
    request: { control: SeatControl; timeControl: TimeControl },
    recordId: string,
  ): QueueIntent {
    return {
      key,
      settings,
      control: request.control,
      timeControl: request.timeControl,
      entryId: null,
      recordId,
      // The intent names an entry that may still be reached.
      state: 'live',
      // The request has not left the browser yet. The readiness of an agent
      // may still fail, and a failed readiness never reaches the service.
      sent: false,
      // The claim of the shared entry names this intent, so it is the entry
      // the default enter of the owner joins.
      shared: true,
      // The private selection of the agent is captured before the service is
      // asked. A model the owner picks later never replaces the agent of this
      // entry.
      selection: request.control.kind === 'agent' ? agent?.selection ?? null : null,
      // The entry has no game yet.
      engineMatchId: null,
      // The entry has no cleanup obligation: it is an entry the owner waits
      // with.
      cleanup: false,
    };
  }

  /** Replaces one intent of a list, and keeps the order of the list. */
  function replaceIntent(intents: readonly QueueIntent[], intent: QueueIntent): QueueIntent[] {
    return intents.map(candidate => candidate.key === intent.key ? intent : candidate);
  }

  /**
   * Runs one part of the queue flow under the lock of the browser.
   *
   * The lock belongs to the origin, so the tabs of the same browser never
   * claim two keys for the same entry.
   */
  async function withQueueLock<T>(identity: string, run: () => Promise<T>): Promise<T> {
    const name = `${ONLINE_QUEUE_INTENT_KEY}:lock:${encodeURIComponent(identity)}`;
    return queueLock(name, run);
  }

  /**
   * True while a record still owns an entry that waits.
   *
   * A matched entry produced its game, and a cancelled or an expired entry
   * never waits again, so neither of them is the entry of the owner.
   */
  function isLivePhase(phase: OnlineQueueState['phase']): boolean {
    return phase === 'checking-agent'
      || phase === 'ready'
      || phase === 'searching'
      || phase === 'engine-unavailable';
  }

  /** The records of this browser whose entry still waits. */
  function liveRecords(): QueueRecord[] {
    return [...queueRecords.values()].filter(record => isLivePhase(record.state.phase));
  }

  /**
   * The record of this browser that shows one entry of the service.
   *
   * An entry that is shown already is never shown twice.
   */
  function recordOfEntry(entryId: string): QueueRecord | null {
    const recordId = entryRecords.get(entryId);
    if (recordId === undefined) return null;
    return queueRecords.get(recordId) ?? null;
  }

  /**
   * The record of this browser that owns one intent.
   *
   * The record knows the intent it claimed, so the intent of an older
   * session of the browser never reaches the record of a new one.
   */
  function recordOfIntent(intent: QueueIntent): QueueRecord | null {
    for (const record of queueRecords.values()) {
      if (record.intentKey === intent.key) return record;
    }
    return null;
  }

  /** Shows one entry of this browser in the interface. */
  function focusRecord(record: QueueRecord): void {
    activeQueueId = record.id;
    queueState = record.state;
    notify();
  }

  /**
   * The answer of a read of one entry.
   *
   * A definitive refusal means the entry is gone. An unknown outcome means
   * the entry may exist, so the intent of the owner is preserved and its key
   * is reused: the entry of the owner is never replaced by a second one.
   */
  type EntryRead =
    | { readonly kind: 'found'; readonly entry: QueueEntry }
    | { readonly kind: 'absent' }
    | { readonly kind: 'unknown' };

  /** Reads one entry of the service. */
  async function readQueueEntry(entryId: string): Promise<EntryRead> {
    try {
      return { kind: 'found', entry: await queueClient.readEntry(entryId) };
    } catch (error) {
      // A definitive refusal means the service did not perform the read, so
      // the entry is gone. An unknown outcome means the entry may exist.
      return isDefinitiveRefusal(error) ? { kind: 'absent' } : { kind: 'unknown' };
    }
  }

  /**
   * True when the identity of the browser is still the one the work started
   * with.
   *
   * The generation moves with every identity change, so an account that
   * signs out and signs in again is a different identity even when its name
   * is the same. The answer of an older generation never reaches the current
   * one.
   */
  function identityIs(identity: string, generation: number): boolean {
    return !disposed && identityGeneration === generation && queueIdentity() === identity;
  }

  /**
   * Refuses the work of an identity that is no longer current.
   *
   * The work belongs to the identity that started it. An identity that signs
   * out, or that comes back after another identity was signed in, is a
   * different generation, so the entry of the older one never reaches the
   * service under the credential of the current one.
   */
  function assertCurrentIdentity(identity: string, generation: number): void {
    if (identityIs(identity, generation)) return;
    throw new Error('The identity changed before the queue entry was created.');
  }

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
   * Publishes the state of an invitation this identity owns.
   *
   * Only an invitation the identity owns is published, so the state of
   * another identity never reaches the screen. The published list is stable
   * between two publications, so the screen does not redraw for nothing.
   */
  function publishOwnedInvitation(invitation: FriendInvitation): void {
    if (!friendSecrets.ownsInvitation(invitation.invitationId)) return;
    const previous = ownedInvitationViews.get(invitation.invitationId);
    ownedInvitationViews.set(invitation.invitationId, invitation);
    ownedInvitationList = [...ownedInvitationViews.values()];
    if (previous && previous.status === invitation.status) return;
    notify();
  }

  /**
   * Settles an invitation whose terminal state the service confirmed.
   *
   * A cancelled or an expired invitation never produces a match, so its
   * record can go and the poll of the composition stops following it. A
   * consumed invitation is never settled here: the inviter still claims the
   * seat of its match.
   */
  function settleOwnedInvitation(invitationId: string): void {
    createdInvitations.delete(invitationId);
    friendSecrets.forgetOwnerToken(invitationId);
  }

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
      // An entry with a cleanup obligation is never resumed: it has to be
      // cancelled, not waited with.
      if (intent.cleanup) continue;
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
      // An entry with a cleanup obligation is never resumed: it has to be
      // cancelled, not waited with.
      if (intent.cleanup) continue;
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
    const record = createQueueRecord({ settings: intent.settings, shared: intent.shared });
    entryRecords.set(entryId, record.id);
    // The intent follows the record of the entry, so the entry keeps its own
    // intent and the recovery of its engine credential knows it.
    record.intentKey = intent.key;
    await upsertIntent(identityKey, intent.key, { ...intent, recordId: record.id });
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

  /**
   * Reads the invitations this identity owns.
   *
   * The read uses the owner token of the identity scoped record, so the
   * service sees the owner of the invitation and nobody else. The answer of
   * an identity that is no longer current never reaches the current one.
   *
   * A record whose terminal state the service confirmed is settled here, so
   * the poll of the composition stops following it.
   */
  async function refreshOwnedInvitations(): Promise<void> {
    if (disposed) return;
    const identityKey = queueIdentity();
    const generation = identityGeneration;
    for (const invitationId of [...friendSecrets.listOwnedInvitations()]) {
      try {
        const invitation = await friends.preview(invitationId);
        if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) return;
        publishOwnedInvitation(invitation);
        if (invitation.status === 'cancelled' || invitation.status === 'expired') {
          settleOwnedInvitation(invitationId);
        }
      } catch {
        // The service did not answer, or the invitation is gone. The record
        // stays on the device, and the next read tries again.
      }
    }
  }

  /**
   * Cancels an invitation this identity owns.
   *
   * The owner token stays in the browser and travels in the private header of
   * the surface, so the service proves the ownership itself. The record of
   * the invitation is settled only when the service confirms a terminal
   * state: an invitation that is still open stays recoverable.
   *
   * The answer of an identity that is no longer current never settles the
   * record of another identity.
   */
  async function cancelOwnedInvitation(invitationId: string): Promise<FriendInvitation> {
    if (!friendSecrets.ownsInvitation(invitationId)) {
      throw new Error('This browser does not own the invitation.');
    }
    const identityKey = queueIdentity();
    const generation = identityGeneration;
    const cancelled = await friends.cancel(invitationId);
    if (disposed || identityGeneration !== generation || queueIdentity() !== identityKey) {
      // The identity changed while the cancellation was on the wire. The
      // record of the previous identity keeps its own namespace, and this
      // identity never settles it.
      return cancelled;
    }
    publishOwnedInvitation(cancelled);
    if (cancelled.status === 'cancelled' || cancelled.status === 'expired') {
      settleOwnedInvitation(invitationId);
    }
    notify();
    return cancelled;
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
            // The state of the invitation is published, so the inviter sees
            // the pending invitation of its own identity after a reload.
            publishOwnedInvitation(invitation);
            // A cancelled or an expired invitation never produces a match, so
            // the poll stops following it and its record is settled.
            if (invitation.status === 'cancelled' || invitation.status === 'expired') {
              settleOwnedInvitation(invitationId);
              return;
            }
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
            // The seat of the inviter is claimed, so the record of the
            // invitation is settled: the invitation is not followed any more.
            settleOwnedInvitation(invitationId);
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
    if (!agent || suspended || disposed) return;
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
      if (runner !== undefined && runner.state.superseded) {
        // The control epoch of the seat moved on while the runner played it.
        // The runner stood down, gave the lease of the seat back and it can
        // never play the seat again. The composition replaces it, so the seat
        // never waits for the deadline of its turn with a runner that gave up.
        void replaceSupersededRunner(key, runner);
        continue;
      }
      if (!runner) {
        const authority = seatAuthority(view.matchId, ownSeat);
        if (!authority) continue;
        const leases = createOnlineRunnerLeaseClient({
          requester: authority.requester,
          session: authority.session,
          matchId: view.matchId,
          seat: ownSeat,
          // The identity of the runner is the identity of this tab. Two tabs
          // of one owner never share it, so the service refuses the second
          // one instead of handing the lease of the seat to both of them.
          runnerId: `${view.matchId}-${ownSeat}-${runnerTabIdentity}`,
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
        const createdRunner = createOnlineAgentSeat({
          matchId: view.matchId,
          seat: ownSeat,
          publicModelLabel: binding.label,
          leases,
          commands,
          provider,
          // The pending record belongs to the seat and not to one runner, so a
          // runner that replaces another one still sees the request that may
          // be running and never asks the provider for a second answer.
          pending: agentPendingStore,
        });
        runner = createdRunner;
        agentRunners.set(key, createdRunner);
        createdRunner.subscribe(() => {
          notify();
          // A runner that the service superseded can never play the seat again,
          // so the composition replaces it with a runner of the epoch the
          // service publishes now. The seat never waits for the deadline of
          // its turn with a runner that gave up.
          if (agentRunners.get(key) === createdRunner && createdRunner.state.superseded) {
            void replaceSupersededRunner(key, createdRunner);
          }
        });
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
   * Replaces a runner that the service superseded.
   *
   * The runner of the seat gave the lease of the seat back and it can never
   * play the seat again, so the seat needs a runner that is bound to the
   * epoch the service publishes now. The replacement waits for the stop of
   * the old runner, so the lease of the seat is given back before the new
   * runner takes it.
   *
   * The replacement never asks the provider by itself when the request of the
   * old runner may still be running: the pending record of the seat stays
   * open, so the new runner waits for the decision of the owner.
   */
  async function replaceSupersededRunner(key: string, runner: OnlineProviderRunner): Promise<void> {
    if (agentRunners.get(key) !== runner) return;
    // The runner of the seat is gone at once: it gave the lease of the seat
    // back and it never plays the seat again.
    agentRunners.delete(key);
    await runner.stop().catch(() => undefined);
    driveAgentSeats();
  }

  /**
   * Hands the seat of the owner to its agent.
   *
   * The transition is one change: the control change of the service, the
   * private binding of the seat and the runner of the seat. The seat keeps a
   * runner that is bound to the epoch the service published, so it never waits
   * for the deadline of its turn with a runner that gave up.
   *
   * The private selection of the seat is the choice of the owner: the binding
   * of the seat when it has one, and the agent of the owner otherwise. The
   * routing identity of a model never leaves the browser, and the service only
   * ever sees the public label of the seat.
   */
  async function handSeatToAgent(matchId: string, seat: Seat): Promise<AgentDecisionOutcome> {
    const key = `${matchId}:${seat}`;
    const bound = agentBindingFor(matchId, seat);
    const target = bound ?? (agent ? { label: agent.label, selection: agent.selection } : null);
    if (!target) {
      // The browser never guesses a model for the seat, so the owner connects
      // one before the seat can play one.
      return {
        kind: 'refused',
        detail: 'The owner has no connected agent for this seat. Connect a model and hand the seat over again.',
      };
    }
    // The decision of the owner is captured before the service is asked, so a
    // newer decision, an identity that came and goes and a runner that was
    // replaced all end this decision.
    const intent: PendingAgentDecision = {
      kind: 'handoff',
      label: target.label,
      selection: target.selection,
      generation: identityGeneration,
    };
    pendingAgentDecisions.set(key, intent);
    const runner = agentRunners.get(key);
    if (runner) {
      // The runner of the seat owns the handoff: it takes the lease of the
      // seat, asks the service for the control change and settles the request
      // that may still be running, so the seat never pays twice for a turn.
      const outcome = await runner.switchModel(target.label);
      if (outcome.kind !== 'accepted') {
        // A refused hand-back is proven negative: the seat did not change, so
        // the record of the decision is dropped. An unknown hand-back keeps it,
        // so the owner may replay the decision.
        if (outcome.kind === 'refused') clearIntent(key, intent);
        return outcome;
      }
      if (!intentIsCurrent(key, intent, runner)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the hand-back.' };
      }
      if (outcome.control !== undefined) provenSeatEpochs.set(key, outcome.control.controlEpoch);
      // The seat plays the private selection the owner chose, so the runner of
      // the old epoch gives way to a runner of the new one.
      rebindCapturedAgentSeat(matchId, seat, target);
      await runner.stop().catch(() => undefined);
      if (!intentIsCurrent(key, intent, runner)) {
        return { kind: 'unknown', detail: 'A newer decision of the owner ended the hand-back.' };
      }
      clearIntent(key, intent);
      agentRunners.delete(key);
      driveAgentSeats();
      return {
        kind: 'accepted',
        publicModelLabel: outcome.publicModelLabel ?? target.label,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      };
    }
    // The seat has no runner of this browser: the owner is the only controller
    // of the seat, and the composition asks the service for the control change
    // itself. The command names the version and the epoch of the canonical
    // view, so the service refuses a command of a state it already left.
    const client = commandClient(matchId, seat);
    if (!client) {
      return { kind: 'refused', detail: 'The seat is not authorized. The owner of the seat has to hand it over.' };
    }
    const view = workspace.games.find(game => game.matchId === matchId)?.snapshot ?? null;
    if (!view) {
      return { kind: 'refused', detail: 'The match is not known to this browser. Open the game again and hand the seat over.' };
    }
    client.setVersion(view.version);
    client.setControlEpoch(view.controlEpoch);
    let receipt: Receipt;
    try {
      receipt = await client.setControl({ kind: 'agent', modelLabel: target.label });
    } catch (error) {
      // A refused command is proven negative: the seat kept its control. A
      // command that failed on its way may have been applied, so the outcome
      // stays unknown and the owner may hand the seat over again.
      if (error instanceof OnlineCommandError && error.code === 'refused') {
        clearIntent(key, intent);
        return { kind: 'refused', detail: 'The service refused the hand-back. The seat keeps its control.' };
      }
      return {
        kind: 'unknown',
        detail: 'The hand-back was not proved. The seat may play the agent now. Hand the seat over again to prove it.',
      };
    }
    if (!intentIsCurrent(key, intent, undefined)) {
      return { kind: 'unknown', detail: 'A newer decision of the owner ended the hand-back.' };
    }
    // The receipt is the proof of the control change, so the runner of the seat
    // binds the epoch the service published and not the older epoch of a
    // stale view.
    provenSeatEpochs.set(key, receipt.controlEpoch);
    // The seat plays the private selection the owner chose, and not a model
    // the public label names.
    rebindCapturedAgentSeat(matchId, seat, target);
    clearIntent(key, intent);
    driveAgentSeats();
    return { kind: 'accepted', publicModelLabel: target.label };
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
    if (!entry) return;
    // The entry keeps its lease while the owner decides. A waiting entry is
    // renewed in every phase in which it still waits, so the lease of the
    // service does not die while the owner weighs a retry against keeping the
    // search.
    if (record.state.phase !== 'searching' && record.state.phase !== 'engine-unavailable') return;
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
   * at once. The browser runners stop with it, so a provider request that is
   * still on the wire is aborted and no move of a disposed runner reaches the
   * service. An engine seat releases the lease of its turn when the turn
   * ends, so the cleanup of the seats is awaited by `disposeAsync()` and the
   * requester and the session of a seat go away with it.
   */
  function disposeComposition(): void {
    if (disposed) return;
    disposed = true;
    unsubscribeAccount?.();
    unsubscribeAccount = null;
    // The runners of the composition stop at once: a pending provider request
    // is aborted, and every lease of a seat is given back with the authority
    // that took it. The transport of the composition stays usable until the
    // runners released their leases.
    const releasedRunners = fenceAgentRunners();
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
    // The engine seats and the browser runners release the lease of their turn
    // while the transport of the composition is still usable. The requesters
    // and the sessions go away afterwards, so a release that is still on the
    // wire is never lost.
    engineCleanup = (async () => {
      await Promise.all(engines.map(engine => engine.dispose().catch(() => undefined)));
      await releasedRunners;
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
    get featuresStatus() {
      return featuresStatus;
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
      if (request.control.kind === 'agent') {
        // The chosen public label is registered before the service accepts
        // the seat, so the service keeps the label the owner chose.
        await registerAgentLabel();
      }
      if (enterOptions?.intent === 'new') {
        // An explicit second game owns its own entry, its own intent and its
        // own timer. The entries of the owner stay untouched.
        await enterExplicitEntry(request);
        return;
      }
      // The default joins the entry the owner already waits with. A second
      // tab, a second click and a reload reach the same entry.
      await enterSharedEntry(request);
    },
    async registerAgentLabel() {
      return registerAgentLabel();
    },
    commandClient,
    registerGuestCredential,
    trackInvitation,
    get ownedInvitations() {
      return ownedInvitationList;
    },
    ownsInvitation(invitationId: string) {
      return friendSecrets.ownsInvitation(invitationId);
    },
    publishOwnedInvitation(invitation: FriendInvitation) {
      publishOwnedInvitation(invitation);
    },
    refreshOwnedInvitations() {
      return refreshOwnedInvitations();
    },
    cancelOwnedInvitation(invitationId: string) {
      return cancelOwnedInvitation(invitationId);
    },
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
        if (intent.kind === 'handoff' && control.kind !== 'agent') return outcome;
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
    },
    handSeatToAgent,
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
      restorePersistedMatches();
      // The waiting entries of the identity are shown again, with the cutoff
      // the service gave them. The restoration reads the entries and never
      // creates one.
      restoreWaitingEntries();
      // The entries whose creation was left on the wire by an identity that
      // changed are resolved now. The obligation belongs to the identity that
      // asked for them, so the cancellation runs with the credential of that
      // identity.
      resolvePendingCleanups(queueIdentity(), identityGeneration);
      // The engine seats of the restored games need a usable credential. The
      // browser holds none after a reload, so the service is asked to rotate
      // it.
      recoverEngineCredentials();
    },
    async loadFeatures() {
      let service: OnlineFeatureFlags = ONLINE_FEATURES_DISABLED;
      let nextStatus: OnlineFeaturesStatus = 'answered';
      try {
        // The feature answer is public. It carries no participant credential.
        const response = await (fetcher ?? globalThis.fetch)(`${baseUrl}${ONLINE_FEATURES_PATH}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'omit',
        });
        if (response.ok) service = parseOnlineFeatureFlags(await response.json());
      } catch {
        // A service that cannot answer leaves every surface closed, and the
        // status says why the buttons are closed instead of leaving the
        // refusal unexplained.
        nextStatus = 'unreachable';
      }
      const local = readLocalOptIn(options.search ?? (typeof window === 'undefined' ? '' : window.location.search));
      features = combineOnlineFeatureFlags(service, local);
      featuresStatus = nextStatus;
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
      void fenceAgentRunners();
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
