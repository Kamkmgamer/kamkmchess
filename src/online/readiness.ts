/**
 * Queue readiness and Stockfish fallback orchestration (KHA-77).
 *
 * The module owns the *browser* half of one queue entry:
 *
 * - the own-agent readiness check that decides whether an agent seat may enter
 *   the queue at all,
 * - the ten-second search window that starts when the service accepts the
 *   ready entry,
 * - the browser Stockfish 19 Lite preparation that runs during the search and
 *   never blocks it, and
 * - the cutoff decision that either keeps the committed opponent, commits the
 *   Stockfish fallback, or asks the owner to retry or to keep searching.
 *
 * It owns no transport, no chess authority and no provider request. Every
 * service interaction is an injected port, so the rules below are testable
 * without a network, a database or an engine download.
 *
 * The rules this module keeps:
 *
 * - No search time elapses during an own-agent check. The window belongs to
 *   the service and starts when the service accepts the ready entry, so a
 *   slow readiness check never costs the owner search time.
 * - A failed agent readiness blocks the entry. The owner may retry or play
 *   themselves; no human or engine seat is ever substituted silently.
 * - A failed engine preparation never blocks an agent search. The engine is a
 *   fallback, not a condition for the search.
 * - At the cutoff a compatible candidate wins over the fallback, including a
 *   candidate that becomes available at exactly the cutoff instant. A later
 *   candidate cannot replace a committed opponent.
 * - The service owns the cutoff. The browser arms the cutoff from the
 *   *duration* of the window that the service published, never from the
 *   absolute clock of the browser, so a browser whose clock runs ahead of
 *   the service waits exactly as long as one whose clock is exact.
 * - A refusal of the service is not a failure of the engine. The queue keeps
 *   searching and the fallback is tried again after a growing delay, within a
 *   bounded budget. The browser names the early window of the service only
 *   when the clock of the service confirms it; every other refusal is
 *   reported as the refusal it is.
 * - One fallback runs at a time. A poll of the service that arrives while an
 *   attempt waits for the service never starts a second attempt.
 * - `Retry` readies the engine and checks once more for a compatible entry
 *   before the fallback is committed. `Keep searching` explicitly removes the
 *   cutoff.
 * - A frozen or disconnected waiting entry expires and needs an explicit
 *   rejoin. A responsive background owner session stays eligible: nothing here
 *   cancels an entry because the document became hidden.
 * - The opponent is authoritative. The module never guesses a seat, a color
 *   or an opponent identity; it reads them from the participant match view.
 * - The first canonical assignment wins. A late answer, a late fallback or a
 *   late retry can never replace a committed opponent or move a matched
 *   entry back into a search.
 * - A cancellation that races with the creation of an entry cleans the
 *   created entry up. A late entry never matches behind a cancelled
 *   interface.
 */
import type { QueueEntry, Seat, SeatControl, TimeControl } from './contracts';
import type { OnlineMatchView } from './updates';

/** The phase of one queue entry in the browser. */
export type OnlineQueuePhase =
  | 'idle'
  | 'checking-agent'
  | 'agent-failed'
  | 'ready'
  | 'searching'
  | 'engine-unavailable'
  | 'assigned'
  | 'matched'
  | 'expired'
  | 'cancelled';

/** The state of the browser engine used as the fallback opponent. */
export type OnlineEngineState = 'idle' | 'preparing' | 'ready' | 'failed';

/** The action the owner may take next. */
export type OnlineQueueOption = 'retry' | 'play-yourself' | 'keep-searching' | 'cancel' | 'rejoin';

/** The opponent the service or the fallback committed. */
export interface OnlineQueueAssignment {
  readonly matchId: string;
  /** The seat the owner plays in the committed match. */
  readonly seat: Seat;
  /** The public label of the opponent. */
  readonly opponentLabel: string;
  /**
   * The declared control of the opponent.
   *
   * It is null when the participant view does not name the opponent seat. The
   * browser never asserts a control it did not read.
   */
  readonly control: SeatControl | null;
}

/** The public state the interface renders. */
export interface OnlineQueueState {
  readonly phase: OnlineQueuePhase;
  readonly entry: QueueEntry | null;
  /** A short reason for the current phase. */
  readonly detail: string;
  readonly assignment: OnlineQueueAssignment | null;
  readonly engineState: OnlineEngineState;
  /** The absolute cutoff of the current search window, or null when removed. */
  readonly cutoffAt: string | null;
  /** The actions the owner may take now. */
  readonly options: readonly OnlineQueueOption[];
}

/** The result of an own-agent readiness check. */
export interface OnlineAgentCheck {
  readonly ready: boolean;
  /** A short reason shown when the check failed. */
  readonly detail: string;
}

/** The ports the readiness flow needs. */
export interface OnlineQueuePorts {
  /**
   * Validates the selected connection and model of an agent seat.
   *
   * The check is browser-owned: the provider credential never leaves the
   * browser and the check never reaches the service.
   */
  readonly checkAgent: (control: SeatControl) => Promise<OnlineAgentCheck>;
  /** Prepares the browser Stockfish 19 Lite engine. */
  readonly prepareEngine: () => Promise<void>;
  /** Creates the queue entry and returns the accepted entry. */
  readonly acceptReady: (request: { control: SeatControl; timeControl: TimeControl }) => Promise<QueueEntry>;
  /** Reads the current entry, for example while polling for an assignment. */
  readonly readEntry: (entryId: string) => Promise<QueueEntry>;
  /**
   * Re-arms the readiness of an existing entry.
   *
   * It is the explicit rejoin of an expired entry. The service keeps the
   * entry and starts a fresh window.
   */
  readonly readyEntry: (entryId: string) => Promise<QueueEntry>;
  /**
   * Reads the authoritative participant view of a match.
   *
   * The view owns the seat of the owner, the public label of the opponent
   * and the declared control of the opponent. The module never guesses them.
   */
  readonly readMatch: (matchId: string) => Promise<OnlineMatchView>;
  /** Cancels the entry. */
  readonly cancelEntry: (entryId: string) => Promise<QueueEntry>;
  /** Removes the automatic cutoff and keeps the entry waiting. */
  readonly keepSearching: (entryId: string) => Promise<QueueEntry>;
  /**
   * Checks once for a compatible ready entry.
   *
   * The service owns the compatibility rule. The browser only asks.
   */
  readonly findCompatibleEntry: (entryId: string) => Promise<OnlineQueueAssignment | null>;
  /** Commits the Stockfish fallback and returns the created match. */
  readonly commitFallback: (entryId: string) => Promise<OnlineQueueAssignment>;
}

/** The timer seam. The default uses the browser timer. */
export interface OnlineQueueTimers {
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface OnlineQueueOptions {
  readonly ports: OnlineQueuePorts;
  readonly now?: () => number;
  readonly timers?: OnlineQueueTimers;
  /** Receives every state change. */
  readonly onState?: (state: OnlineQueueState) => void;
}

const defaultTimers: OnlineQueueTimers = {
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The delay of the first try of the fallback.
 *
 * The service is asked again after a growing delay, so the service never
 * sees a tight loop of fallback requests.
 */
const EARLY_CUTOFF_BASE_DELAY_MS = 200;

/**
 * The largest delay between two tries of the fallback.
 */
const EARLY_CUTOFF_MAX_DELAY_MS = 2_000;

/**
 * The number of tries of the early window of the service.
 *
 * The budget is bounded, so a search never waits for the fallback forever.
 * The budget covers the rest of the window of the service, because the
 * service may refuse the fallback until its own window ends.
 */
const EARLY_CUTOFF_MAX_ATTEMPTS = 12;

/**
 * The number of tries of a refusal that the service did not name.
 *
 * A candidate that was dropped wins over the engine when the request is
 * repeated, so a refusal of that kind is repeated a few times. The budget is
 * small, because a refusal the service did not confirm is usually final.
 */
const CONFLICT_MAX_ATTEMPTS = 4;

/**
 * The number of tries of a lost answer of the service.
 *
 * The service may have committed the engine anyway, so the entry is read
 * again and the request is repeated a few times.
 */
const UNKNOWN_MAX_ATTEMPTS = 6;

/**
 * The detail of a search that waits for the window of the service.
 *
 * The service confirms the early window with its own clock, so the browser
 * says it only when the service wrote that the window was still running.
 */
const EARLY_CUTOFF_DETAIL =
  'The search window of the service has not ended yet. The queue keeps searching.';

/**
 * The detail of a refusal of the service that it did not name.
 *
 * The service refuses the engine before its window ends and when a candidate
 * wins over the engine, and it names neither reason. The browser says so
 * instead of guessing a reason the service never gave.
 */
const CONFLICT_DETAIL =
  'The service refused the engine fallback for now. The queue keeps searching.';

/**
 * The detail of a fallback whose answer the service did not send.
 */
const LOST_ANSWER_DETAIL =
  'The service did not answer the engine fallback. The queue keeps searching.';

/**
 * The HTTP status of a refused request, when the transport kept it.
 *
 * The queue client keeps the status of the refusal, so the browser can tell
 * a conflict of the service from a lost answer without guessing.
 */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const response = (error as { response?: { status?: unknown } }).response;
  if (typeof response === 'object' && response !== null) {
    const nested = response.status;
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  }
  return null;
}

/**
 * The state of the entry, as the service reports it.
 *
 * The entry is the authority on the life of the search: the browser reads it
 * before every decision that could create a second game.
 */
type EntryState =
  | { readonly kind: 'waiting'; readonly entry: QueueEntry }
  | { readonly kind: 'assigned'; readonly entry: QueueEntry }
  | { readonly kind: 'cancelled'; readonly entry: QueueEntry }
  | { readonly kind: 'expired'; readonly entry: QueueEntry }
  | { readonly kind: 'unknown' };

/**
 * The result of one attempt to commit the browser engine.
 */
type FallbackOutcome =
  /** The service committed the engine. */
  | { readonly kind: 'committed'; readonly assignment: OnlineQueueAssignment }
  /**
   * The service confirmed that its search window has not ended yet.
   *
   * The clock of the service confirmed it, so the browser names it.
   */
  | { readonly kind: 'early-cutoff' }
  /**
   * The service refused with a conflict it did not name.
   *
   * A candidate that was dropped wins over the engine when the request is
   * repeated, so the request is repeated a few times.
   */
  | { readonly kind: 'conflict' }
  /**
   * The service refused and the browser will not ask again.
   *
   * The entry keeps searching without a cutoff, so the engine is never
   * committed for it.
   */
  | { readonly kind: 'refused' }
  /** The entry is terminal, so the attempt ends the search. */
  | { readonly kind: 'terminal' }
  /** The answer was lost, so the outcome of the attempt is unknown. */
  | { readonly kind: 'unknown' }
  /** The entry could not be read, so the attempt cannot be classified. */
  | { readonly kind: 'unreadable' };

/**
 * The running preparation of the browser engine.
 *
 * The token identifies the preparation, so a preparation of an older attempt
 * never overwrites the engine state of a newer one.
 */
interface EnginePreparation {
  readonly promise: Promise<boolean>;
  readonly token: object;
}

/**
 * The browser queue controller.
 *
 * The controller is a plain object with an injected port set. It never reads
 * the document, never hides a timer and never cancels an entry because the
 * page became hidden: a responsive background owner session stays eligible.
 */
export interface OnlineQueueController {
  readonly state: OnlineQueueState;
  /**
   * Checks the own agent and enters the queue.
   *
   * A human seat enters without an agent check. An agent seat is blocked by a
   * failed check until the owner retries or plays themselves.
   */
  enter(request: { control: SeatControl; timeControl: TimeControl }): Promise<void>;
  /** Retries a failed readiness check or a failed engine preparation. */
  retry(): Promise<void>;
  /** Replaces an agent seat with an explicit human seat. */
  playYourself(): Promise<void>;
  /** Removes the cutoff and keeps the entry waiting. */
  keepSearching(): Promise<void>;
  /** Cancels the entry. */
  cancel(): Promise<void>;
  /** Rejoins an entry the service expired. */
  rejoin(): Promise<void>;
  /**
   * Feeds a service answer into the controller.
   *
   * A late answer never replaces a committed opponent.
   */
  observe(entry: QueueEntry): void;
  /**
   * Adopts an entry that this browser already owns.
   *
   * A reload or an identity change finds the entry of the owner again. The
   * entry is the same canonical entry, so the search continues with its
   * original cutoff and the browser engine prepares during the remaining
   * search, exactly as it does for a new entry. Nothing is created here: the
   * entry already exists in the service, and the service is never asked to
   * commit the engine before the cutoff of the entry.
   */
  adopt(entry: QueueEntry): void;
  /**
   * Fences the current attempt and clears the local state.
   *
   * An identity change uses it: the state of the previous identity leaves the
   * screen, and a late answer of the old attempt never applies.
   */
  reset(): void;
  /** Releases the timer and the listener. */
  dispose(): void;
}

/** The default detail text of every phase. */
const PHASE_DETAIL: Record<OnlineQueuePhase, string> = {
  idle: '',
  'checking-agent': 'Checking agent…',
  'agent-failed': 'Agent check failed.',
  ready: 'Ready.',
  searching: 'Searching for an opponent…',
  'engine-unavailable': 'Stockfish is unavailable.',
  assigned: 'Loading the match…',
  matched: 'Opponent found.',
  expired: 'The entry expired.',
  cancelled: 'The entry was cancelled.',
};

/**
 * The options the owner may take in every phase.
 *
 * The recovery of the owner is offered while the search waits for a decision
 * that the service has not made yet: the fallback was refused, or the service
 * did not answer. The owner may retry the engine or remove the cutoff
 * explicitly, exactly as at the cutoff itself.
 */
function optionsFor(phase: OnlineQueuePhase, recovery: boolean): readonly OnlineQueueOption[] {
  switch (phase) {
    case 'agent-failed':
      // A failed readiness blocks the entry. The owner retries or plays
      // themselves. No seat is ever substituted silently.
      return ['retry', 'play-yourself', 'cancel'];
    case 'engine-unavailable':
      // The cutoff arrived without a usable engine. The owner retries, which
      // readies the engine again, or explicitly removes the cutoff. The retry
      // stays available while the engine is still starting.
      return ['retry', 'keep-searching', 'cancel'];
    case 'searching':
      // The queue keeps searching. While the recovery of the owner is on the
      // table, the owner may retry the engine or remove the cutoff explicitly.
      return recovery ? ['retry', 'keep-searching', 'cancel'] : ['cancel'];
    case 'expired':
      return ['rejoin', 'cancel'];
    case 'ready':
      return ['cancel'];
    case 'checking-agent':
      // The owner can always leave an entry that is being checked.
      return ['cancel'];
    default:
      return [];
  }
}

/**
 * Creates the browser queue controller.
 */
export function createOnlineQueueController(options: OnlineQueueOptions): OnlineQueueController {
  const { ports } = options;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  let phase: OnlineQueuePhase = 'idle';
  let entry: QueueEntry | null = null;
  let detail = PHASE_DETAIL.idle;
  let assignment: OnlineQueueAssignment | null = null;
  let engineState: OnlineEngineState = 'idle';
  let cutoffAt: string | null = null;
  let cutoffTimer: unknown = null;
  /** The timer of the next try of the fallback. */
  let retryTimer: unknown = null;
  /** The number of tries of the early window of the service. */
  let earlyAttempts = 0;
  /** The number of tries of a refusal the service did not name. */
  let conflictAttempts = 0;
  /** The number of tries of a lost answer of the service. */
  let unknownAttempts = 0;
  /**
   * The number of attempts that run at the same time.
   *
   * One attempt at a time: a poll of the service that arrives while an
   * attempt waits for the service never starts a second attempt.
   */
  let runningAttempts = 0;
  /**
   * The browser instant at which the current window of the entry started.
   *
   * The window is measured in durations, so the clock of the browser never
   * decides that the cutoff of the service passed.
   */
  let windowStartedAt: number | null = null;
  /** The ready time of the current window of the entry, as the service wrote it. */
  let windowReadyAt: string | null = null;
  /**
   * True while the owner may recover the search.
   *
   * The recovery is on the table when the cutoff arrived and the fallback was
   * not committed: the engine is not ready, the service refused it, or the
   * service did not answer. The owner may retry the engine or remove the
   * cutoff explicitly while the search waits for the service.
   */
  let recoveryOffered = false;
  /** The running preparation of the engine, when one runs. */
  let enginePreparation: EnginePreparation | null = null;
  let disposed = false;
  /** The generation of the current attempt. A late answer never applies. */
  let generation = 0;
  /** The request the owner asked for, kept for a retry. */
  let request: { control: SeatControl; timeControl: TimeControl } | null = null;

  function publish(): void {
    if (disposed) return;
    const state: OnlineQueueState = {
      phase,
      entry,
      detail,
      assignment,
      engineState,
      cutoffAt,
      options: optionsFor(phase, recoveryOffered),
    };
    options.onState?.(state);
  }

  function setPhase(next: OnlineQueuePhase, nextDetail?: string): void {
    // A committed opponent is never undone by a late asynchronous phase.
    if (phase === 'matched' && next !== 'matched' && next !== 'cancelled') return;
    // A committed opponent is never undone by a late answer either. The
    // interface shows one truth about the entry.
    if (assignment !== null && next === 'cancelled') return;
    phase = next;
    detail = nextDetail ?? PHASE_DETAIL[next];
  }

  function clearCutoffTimer(): void {
    if (cutoffTimer !== null) {
      timers.clearTimer(cutoffTimer);
      cutoffTimer = null;
    }
  }

  /** Releases the timer of the next try of the fallback. */
  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      timers.clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  /** Starts the budgets of the tries of the fallback over. */
  function resetAttempts(): void {
    earlyAttempts = 0;
    conflictAttempts = 0;
    unknownAttempts = 0;
  }

  /**
   * The length of the search window of the service.
   *
   * Both ends of the window are written by the service, so the length is a
   * duration of the service. The absolute instants of the browser never enter
   * the comparison.
   */
  function windowLengthMs(next: QueueEntry): number | null {
    if (next.readyAt === null || next.cutoffAt === null) return null;
    const length = Date.parse(next.cutoffAt) - Date.parse(next.readyAt);
    if (!Number.isFinite(length) || length <= 0) return null;
    return length;
  }

  /**
   * The time the service already spent in its window.
   *
   * The service writes the entry with its own clock, so the difference of two
   * of its instants is a duration of the service. It is the observation the
   * browser uses for an entry it adopted in the middle of its window.
   */
  function serviceElapsedMs(next: QueueEntry): number | null {
    if (next.readyAt === null) return null;
    const elapsed = Date.parse(next.updatedAt) - Date.parse(next.readyAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) return null;
    return elapsed;
  }

  /**
   * The time the browser already waited for the window of the service.
   *
   * It is a duration of the browser: the difference of two instants of its own
   * clock. The absolute clock of the browser never decides that the cutoff of
   * the service passed.
   */
  function localElapsedMs(): number {
    if (windowStartedAt === null) return 0;
    return Math.max(0, now() - windowStartedAt);
  }

  /**
   * The time the browser still waits for the window of the service.
   *
   * The length of the window is a duration of the service, and the time that
   * already passed is a duration too, so a browser whose clock runs ahead of
   * the service waits exactly as long as one whose clock is exact.
   */
  function remainingWindowMs(next: QueueEntry): number | null {
    const length = windowLengthMs(next);
    if (length === null) return null;
    const elapsed = Math.max(serviceElapsedMs(next) ?? 0, localElapsedMs());
    return Math.max(0, length - elapsed);
  }

  /**
   * Arms the cutoff timer of the current window.
   *
   * The delay is a duration: the length of the window of the service minus
   * the time that already passed. The absolute clock of the browser never
   * decides when the cutoff of the service arrives.
   */
  function armCutoff(next: QueueEntry | null): void {
    clearCutoffTimer();
    if (next === null) {
      // The cutoff was removed explicitly. The entry waits without one.
      cutoffAt = null;
      return;
    }
    cutoffAt = next.cutoffAt;
    const remaining = remainingWindowMs(next);
    if (next.cutoffAt === null || remaining === null) return;
    const ticket = generation;
    cutoffTimer = timers.setTimer(() => {
      cutoffTimer = null;
      if (disposed || ticket !== generation) return;
      void reachCutoff(ticket);
    }, remaining);
  }

  /**
   * Starts the engine preparation during the search.
   *
   * A failure is recorded and never blocks the search. The running
   * preparation is kept, so the cutoff can wait for it instead of losing the
   * fallback of a slow engine.
   */
  async function prepareEngine(ticket: number): Promise<void> {
    await startEnginePreparation(ticket);
  }

  /**
   * Prepares the browser engine and reports whether it is ready.
   *
   * The engine prepares during the search. A failure never blocks the search.
   * A preparation of an older attempt never overwrites the engine state of a
   * newer one.
   */
  function startEnginePreparation(ticket: number): Promise<boolean> {
    engineState = 'preparing';
    publish();
    const token = {};
    const preparation = (async () => {
      let ready = false;
      try {
        await ports.prepareEngine();
        ready = true;
      } catch {
        // The engine did not start. The search is not blocked by it.
      }
      if (enginePreparation?.token === token) enginePreparation = null;
      if (disposed || ticket !== generation) return ready;
      engineState = ready ? 'ready' : 'failed';
      publish();
      return ready;
    })();
    enginePreparation = { promise: preparation, token };
    return preparation;
  }

  /**
   * Waits for the running engine preparation.
   *
   * The cutoff waits for the engine: a slow preparation never ends the
   * search and never loses the fallback of the entry.
   */
  async function waitForEngine(ticket: number): Promise<boolean> {
    const preparation = enginePreparation;
    if (preparation === null) return engineState === 'ready';
    const ready = await preparation.promise;
    if (disposed || ticket !== generation) return false;
    return ready && engineState === 'ready';
  }

  /**
   * Reads the authoritative assignment of a committed match.
   *
   * The seat, the opponent label and the declared control come from the
   * participant view. Nothing is guessed.
   */
  async function resolveAssignment(matchId: string, ticket: number): Promise<void> {
    let view: OnlineMatchView;
    try {
      view = await ports.readMatch(matchId);
    } catch {
      if (disposed || ticket !== generation) return;
      // The match exists but cannot be read yet. The phase stays assigned so
      // the interface never shows a guessed opponent.
      setPhase('assigned', PHASE_DETAIL.assigned);
      publish();
      return;
    }
    if (disposed || ticket !== generation) return;
    const seat = view.yourSeat;
    if (seat === null) {
      setPhase('assigned', PHASE_DETAIL.assigned);
      publish();
      return;
    }
    const opponent = view.seats.find(candidate => candidate.seat !== seat);
    commitAssignment({
      matchId,
      seat,
      opponentLabel: opponent?.publicLabel ?? '',
      // The control is only known when the view names the opponent seat. The
      // browser never declares a control it did not read.
      control: opponent?.control ?? null,
    });
  }

  /**
   * The first canonical assignment wins.
   *
   * A late fallback, a late retry or a late service answer never replaces a
   * committed opponent.
   */
  function commitAssignment(next: OnlineQueueAssignment): void {
    if (assignment !== null) return;
    assignment = next;
    setPhase('matched', PHASE_DETAIL.matched);
    clearCutoffTimer();
    publish();
  }

  /** The service answered with an entry. The window starts here. */
  function applyEntry(next: QueueEntry, ticket: number): void {
    if (disposed || ticket !== generation) return;
    entry = next;
    if (next.status === 'assigned' && next.assignedMatchId !== null) {
      // The service committed a match. The engine and the cutoff stop.
      clearCutoffTimer();
      clearRetryTimer();
      if (assignment !== null) {
        // A late answer never replaces a committed opponent.
        publish();
        return;
      }
      setPhase('assigned', PHASE_DETAIL.assigned);
      publish();
      void resolveAssignment(next.assignedMatchId, ticket);
      return;
    }
    if (next.status === 'cancelled') {
      setPhase('cancelled');
      clearCutoffTimer();
      clearRetryTimer();
      publish();
      return;
    }
    if (next.readyAt !== null) {
      if (next.readyAt !== windowReadyAt) {
        // A new window of the service starts here. The elapsed time of the
        // tries is measured from this instant, so it never depends on the
        // absolute clock of the browser.
        windowReadyAt = next.readyAt;
        windowStartedAt = now();
        resetAttempts();
        // The recovery of an older window does not belong to this one.
        recoveryOffered = false;
      }
      if (recoveryOffered) {
        // The owner may still recover the search. The choice stays on the
        // screen, and the cutoff is not armed a second time.
        publish();
        return;
      }
      if (retryTimer !== null || runningAttempts > 0) {
        // A try or a running attempt drives the next step. The cutoff is not
        // armed a second time, so two fallbacks never run at once.
        setPhase('searching', detail);
      } else {
        setPhase('searching');
        armCutoff(next);
      }
    } else {
      // The service accepted the entry but it is not ready. The entry either
      // expired or is still being prepared, and the owner leaves it with an
      // explicit rejoin or a cancel.
      setPhase('expired');
      clearCutoffTimer();
      clearRetryTimer();
    }
    publish();
  }

  /**
   * The cutoff arrived.
   *
   * A compatible candidate wins over the fallback, including a candidate at
   * exactly the cutoff instant. The fallback is committed only when no
   * candidate exists and the engine is ready.
   */
  async function reachCutoff(ticket: number): Promise<void> {
    if (disposed || ticket !== generation) return;
    if (phase === 'matched' || phase === 'assigned' || phase === 'cancelled') return;
    // One attempt at a time. A poll of the service that arrives while an
    // attempt waits for the service never starts a second attempt.
    if (runningAttempts > 0) return;
    runningAttempts += 1;
    try {
      // A lost answer can hide a committed assignment. The entry is re-read
      // before anything that could create a second game.
      const state = await readEntryState(ticket);
      if (disposed || ticket !== generation || assignment !== null) return;
      if (state.kind === 'assigned' || state.kind === 'cancelled' || state.kind === 'expired') {
        await applyEntryState(state, ticket);
        return;
      }
      if (state.kind === 'unknown') {
        // The entry could not be read, so the fallback is not committed: an
        // unknown state never authorises a fallback. The read is repeated
        // after the backoff, and the search continues meanwhile.
        setPhase('searching', LOST_ANSWER_DETAIL);
        recoveryOffered = true;
        publish();
        if (scheduleRetry(ticket, 'unknown')) return;
        reportUnknownRefusal();
        return;
      }
      // A candidate that is already assigned wins, even at the cutoff.
      const assigned = await safeFind(ticket);
      if (disposed || ticket !== generation || assignment !== null) return;
      if (assigned !== null) {
        commitAssignment(assigned);
        return;
      }
      if (engineState === 'preparing') {
        // The engine is still starting. The cutoff waits for it: the engine is
        // a fallback, and a slow preparation never ends the search.
        const ready = await waitForEngine(ticket);
        if (disposed || ticket !== generation || assignment !== null) return;
        if (!ready) {
          reportEngineFailure();
          return;
        }
      }
      if (engineState === 'ready') {
        await attemptWithRecovery(ticket);
        return;
      }
      // The engine did not start. The owner retries or keeps searching.
      reportEngineFailure();
    } finally {
      runningAttempts -= 1;
    }
  }

  async function safeFind(ticket: number): Promise<OnlineQueueAssignment | null> {
    if (!entry) return null;
    try {
      return await ports.findCompatibleEntry(entry.entryId);
    } catch {
      return null;
    } finally {
      void ticket;
    }
  }

  /**
   * Reads the entry and classifies its state.
   *
   * The entry is the authority on the life of the search. A read that fails
   * leaves the state unknown, and an unknown state never authorises a
   * fallback.
   */
  async function readEntryState(ticket: number): Promise<EntryState> {
    if (!entry) return { kind: 'unknown' };
    let current: QueueEntry;
    try {
      current = await ports.readEntry(entry.entryId);
    } catch {
      return { kind: 'unknown' };
    }
    if (disposed || ticket !== generation) return { kind: 'unknown' };
    entry = current;
    if (current.status === 'assigned' && current.assignedMatchId !== null) {
      return { kind: 'assigned', entry: current };
    }
    if (current.status === 'cancelled') {
      return { kind: 'cancelled', entry: current };
    }
    if (current.readyAt === null) {
      // The entry waits without a ready time: it expired and needs an
      // explicit rejoin.
      return { kind: 'expired', entry: current };
    }
    return { kind: 'waiting', entry: current };
  }

  /**
   * Publishes a terminal state of the entry.
   *
   * A committed assignment, a cancellation and an expiry end the search. The
   * timers of the entry stop with them.
   */
  async function applyEntryState(state: EntryState, ticket: number): Promise<void> {
    if (state.kind === 'assigned') {
      clearCutoffTimer();
      clearRetryTimer();
      if (assignment === null) {
        setPhase('assigned', PHASE_DETAIL.assigned);
        publish();
        await resolveAssignment(state.entry.assignedMatchId as string, ticket);
      }
      return;
    }
    if (state.kind === 'cancelled') {
      clearCutoffTimer();
      clearRetryTimer();
      if (assignment === null) {
        setPhase('cancelled');
        publish();
      }
      return;
    }
    if (state.kind === 'expired') {
      clearCutoffTimer();
      clearRetryTimer();
      if (assignment === null) {
        setPhase('expired');
        publish();
      }
    }
  }

  /**
   * Reports whether the search window of the service was still running.
   *
   * The browser never decides that the cutoff of the service passed: only
   * the service knows that. The browser knows the length of the window,
   * because the service wrote both ends of it, and it knows how long it
   * waited for it. Both are durations, so a clock of the browser that runs
   * ahead of the service cancels out.
   *
   * The observation of the service is the clock of the service: the entry
   * carries the instant of the last write of the service, so the browser
   * knows how much of the window the service itself saw.
   */
  function windowStillRunning(next: QueueEntry): boolean {
    const length = windowLengthMs(next);
    if (length === null) return false;
    const elapsed = Math.max(serviceElapsedMs(next) ?? 0, localElapsedMs());
    return elapsed < length;
  }

  /**
   * Decides what a refused fallback means.
   *
   * The service refuses the fallback with a conflict when the search window
   * of the entry has not ended yet, and it refuses it with the same conflict
   * when a candidate that was dropped wins over the engine. The contract of
   * the service names neither reason, so the browser confirms the early
   * window only when the clock of the service says that the window was still
   * running. Every other conflict is a neutral refusal.
   */
  function classifyRefusal(state: EntryState): 'early-cutoff' | 'conflict' | 'refused' {
    if (state.kind !== 'waiting') return 'conflict';
    if (state.entry.cutoffAt === null) {
      // The entry keeps searching. The engine is never committed for it, so
      // the service will refuse every attempt.
      return 'refused';
    }
    if (!windowStillRunning(state.entry)) return 'conflict';
    return 'early-cutoff';
  }

  /**
   * Commits the browser engine once.
   *
   * A conflict of the service is read with the entry: a terminal entry ends
   * the search, and the clock of the service says whether the conflict was
   * the early window of the service. Every other failure is a lost answer or
   * an unreachable service.
   */
  async function attemptFallback(ticket: number): Promise<FallbackOutcome> {
    if (!entry) return { kind: 'unknown' };
    let committed: OnlineQueueAssignment;
    try {
      committed = await ports.commitFallback(entry.entryId);
    } catch (error) {
      if (disposed || ticket !== generation) return { kind: 'unknown' };
      // Only a conflict of the service is a refusal the browser can read.
      // Every other failure is a lost answer or an unreachable service.
      if (statusOf(error) !== 409) return { kind: 'unknown' };
      // The entry is read again, because the refusal itself may have changed
      // its state: a committed assignment, a cancellation and an expiry all
      // end the search.
      const observed = await readEntryState(ticket);
      if (disposed || ticket !== generation) return { kind: 'unknown' };
      if (observed.kind === 'assigned' || observed.kind === 'cancelled' || observed.kind === 'expired') {
        await applyEntryState(observed, ticket);
        return { kind: 'terminal' };
      }
      if (observed.kind === 'unknown') {
        // The entry could not be read, so the refusal is not classified. The
        // read is repeated after the backoff instead of ending the search.
        return { kind: 'unreadable' };
      }
      const refusal = classifyRefusal(observed);
      if (refusal === 'early-cutoff') return { kind: 'early-cutoff' };
      if (refusal === 'refused') return { kind: 'refused' };
      return { kind: 'conflict' };
    }
    if (disposed || ticket !== generation) return { kind: 'unknown' };
    return { kind: 'committed', assignment: committed };
  }

  /**
   * Attempts to commit the engine and recovers from a refusal of the service.
   *
   * The engine is ready and the entry was read. A refusal of the service is
   * not a failure of the engine: the queue keeps searching, the owner may
   * recover the search, and the attempt is repeated after a growing delay
   * within a bounded budget.
   */
  async function attemptWithRecovery(ticket: number): Promise<void> {
    const outcome = await attemptFallback(ticket);
    if (disposed || ticket !== generation || assignment !== null) return;
    if (outcome.kind === 'committed') {
      commitAssignment(outcome.assignment);
      return;
    }
    if (outcome.kind === 'terminal') return;
    if (outcome.kind === 'early-cutoff') {
      // The service confirmed that its window has not ended yet. The search
      // continues and the fallback is tried again after a backoff.
      setPhase('searching', EARLY_CUTOFF_DETAIL);
      recoveryOffered = true;
      publish();
      if (scheduleRetry(ticket, 'early')) return;
      reportRefusedFallback();
      return;
    }
    if (outcome.kind === 'conflict') {
      // The service refused without naming a reason. The queue keeps
      // searching, and the request is repeated: a candidate that was dropped
      // wins over the engine when the request is repeated.
      setPhase('searching', CONFLICT_DETAIL);
      recoveryOffered = true;
      publish();
      if (scheduleRetry(ticket, 'conflict')) return;
      reportRefusedFallback();
      return;
    }
    if (outcome.kind === 'refused') {
      // The entry keeps searching without a cutoff. The engine is never
      // committed for it.
      reportRefusedFallback();
      return;
    }
    // The answer was lost or the entry could not be read. The entry decides
    // whether the service committed the engine anyway.
    if (await reconcile(ticket)) return;
    if (disposed || ticket !== generation || assignment !== null) return;
    setPhase('searching', LOST_ANSWER_DETAIL);
    recoveryOffered = true;
    publish();
    if (scheduleRetry(ticket, 'unknown')) return;
    reportUnknownRefusal();
  }

  /**
   * Schedules the next try of the fallback.
   *
   * The delay grows, so the service is never asked in a tight loop, and the
   * number of tries is bounded, so the search never waits for the fallback
   * forever. Every kind of refusal has its own budget: the window of the
   * service may need the rest of the search, a conflict of the service needs
   * a few tries, and a lost answer needs a few more.
   */
  function scheduleRetry(ticket: number, kind: 'early' | 'conflict' | 'unknown'): boolean {
    if (retryTimer !== null) return true;
    const attempts = kind === 'early' ? earlyAttempts : kind === 'conflict' ? conflictAttempts : unknownAttempts;
    const budget = kind === 'early'
      ? EARLY_CUTOFF_MAX_ATTEMPTS
      : kind === 'conflict'
        ? CONFLICT_MAX_ATTEMPTS
        : UNKNOWN_MAX_ATTEMPTS;
    if (attempts >= budget) return false;
    const delay = Math.min(EARLY_CUTOFF_BASE_DELAY_MS * 2 ** attempts, EARLY_CUTOFF_MAX_DELAY_MS);
    if (kind === 'early') earlyAttempts += 1;
    else if (kind === 'conflict') conflictAttempts += 1;
    else unknownAttempts += 1;
    retryTimer = timers.setTimer(() => {
      retryTimer = null;
      if (disposed || ticket !== generation) return;
      void runRetry(ticket);
    }, delay);
    return true;
  }

  /**
   * Tries the fallback again after the service refused it.
   *
   * The queue keeps searching, the generation and the dispose guards fence
   * the attempt, and the entry is read before every try, so a committed
   * assignment, a cancellation and an expiry end the try. A candidate wins
   * over the engine at every try.
   */
  async function runRetry(ticket: number): Promise<void> {
    if (disposed || ticket !== generation || assignment !== null) return;
    if (phase === 'matched' || phase === 'assigned' || phase === 'cancelled') return;
    if (runningAttempts > 0) return;
    runningAttempts += 1;
    try {
      const state = await readEntryState(ticket);
      if (disposed || ticket !== generation || assignment !== null) return;
      if (state.kind === 'assigned' || state.kind === 'cancelled' || state.kind === 'expired') {
        // The entry is terminal. The try stops and the state is reconciled.
        await applyEntryState(state, ticket);
        return;
      }
      if (state.kind === 'unknown') {
        // The state of the entry is unknown, so no fallback is committed. The
        // check is repeated after the backoff.
        setPhase('searching', LOST_ANSWER_DETAIL);
        recoveryOffered = true;
        publish();
        if (scheduleRetry(ticket, 'unknown')) return;
        reportUnknownRefusal();
        return;
      }
      const candidate = await safeFind(ticket);
      if (disposed || ticket !== generation || assignment !== null) return;
      if (candidate !== null) {
        commitAssignment(candidate);
        return;
      }
      if (engineState === 'preparing') {
        const ready = await waitForEngine(ticket);
        if (disposed || ticket !== generation || assignment !== null) return;
        if (!ready) {
          reportEngineFailure();
          return;
        }
      }
      if (engineState !== 'ready') {
        reportEngineFailure();
        return;
      }
      await attemptWithRecovery(ticket);
    } finally {
      runningAttempts -= 1;
    }
  }

  /**
   * Reports a refusal of the service that is not the early cutoff.
   *
   * The engine may be ready and the service may refuse for another reason.
   * The interface says so instead of blaming the engine.
   */
  function reportRefusedFallback(): void {
    setPhase('engine-unavailable', 'The service refused the engine fallback. Retry or keep searching.');
    recoveryOffered = true;
    publish();
  }

  /**
   * Reports a fallback whose outcome is unknown.
   *
   * The service never answered, so the entry decides whether it committed
   * the engine anyway.
   */
  function reportUnknownRefusal(): void {
    setPhase('engine-unavailable', 'The service did not answer the engine fallback. Retry or keep searching.');
    recoveryOffered = true;
    publish();
  }

  /**
   * Reports an engine that did not start.
   *
   * The failure of the engine is the failure of the engine: the service is
   * not blamed for it.
   */
  function reportEngineFailure(): void {
    setPhase('engine-unavailable', engineState === 'failed'
      ? 'Stockfish could not start. Retry or keep searching.'
      : 'Stockfish is still starting. Retry or keep searching.');
    recoveryOffered = true;
    publish();
  }

  /**
   * Reconciles the local state with the service.
   *
   * A lost answer is the normal failure of a suspended tab: the service may
   * have committed an assignment that the browser never saw. The entry is
   * therefore re-read before every decision that could create a second game.
   *
   * The reconciliation reads the terminal states of the entry: a committed
   * assignment, a cancellation and an expiry all end the search. An expired
   * entry is reported as waiting without a ready time, and it is never a
   * running search: only the explicit rejoin revives it.
   */
  async function reconcile(ticket: number): Promise<boolean> {
    if (!entry || disposed || ticket !== generation) return false;
    let current: QueueEntry;
    try {
      current = await ports.readEntry(entry.entryId);
    } catch {
      return false;
    }
    if (disposed || ticket !== generation) return false;
    if (current.status === 'assigned' && current.assignedMatchId !== null) {
      entry = current;
      clearCutoffTimer();
      if (assignment === null) {
        setPhase('assigned', PHASE_DETAIL.assigned);
        publish();
        await resolveAssignment(current.assignedMatchId, ticket);
      }
      return true;
    }
    if (current.status === 'cancelled') {
      if (assignment !== null) {
        // A late cancellation never replaces a committed opponent.
        return true;
      }
      entry = current;
      setPhase('cancelled');
      clearCutoffTimer();
      publish();
      return true;
    }
    if (current.readyAt === null) {
      // The entry expired: the owner stopped responding and the entry left
      // the eligibility. The search is over, so the browser never reports a
      // running search for it. The owner rejoins explicitly if he wants to
      // search again.
      entry = current;
      await applyEntryState({ kind: 'expired', entry: current }, ticket);
      return true;
    }
    entry = current;
    return false;
  }

  /** Cancels a remote entry that was created after the interface gave up. */
  async function cleanUpLateEntry(entryId: string): Promise<void> {
    try {
      await ports.cancelEntry(entryId);
    } catch {
      // The service decides whether the late entry is still cancelable.
    }
  }

  async function enter(next: { control: SeatControl; timeControl: TimeControl }): Promise<void> {
    if (disposed) return;
    request = next;
    const ticket = (generation += 1);
    clearCutoffTimer();
    clearRetryTimer();
    resetAttempts();
    recoveryOffered = false;
    assignment = null;
    setPhase('checking-agent');
    publish();
    if (next.control.kind === 'agent') {
      let check: OnlineAgentCheck;
      try {
        check = await ports.checkAgent(next.control);
      } catch (error) {
        check = { ready: false, detail: error instanceof Error ? error.message : 'The agent check failed.' };
      }
      if (disposed || ticket !== generation) return;
      if (!check.ready) {
        // A failed readiness blocks the entry.
        engineState = 'idle';
        setPhase('agent-failed', check.detail || PHASE_DETAIL['agent-failed']);
        publish();
        return;
      }
    }
    let accepted: QueueEntry;
    try {
      accepted = await ports.acceptReady(next);
    } catch (error) {
      if (disposed || ticket !== generation) return;
      setPhase('agent-failed', error instanceof Error ? error.message : 'The entry could not be created.');
      publish();
      return;
    }
    if (disposed || ticket !== generation) {
      // The interface cancelled or left while the entry was being created.
      // The created entry is cleaned up so it cannot match behind the owner.
      await cleanUpLateEntry(accepted.entryId);
      return;
    }
    entry = accepted;
    // The service answer decides the phase. An entry that was assigned at
    // once is never treated as a running search.
    applyEntry(accepted, ticket);
    if (phase === 'searching') {
      // The engine prepares during the search. Its failure never blocks it.
      void prepareEngine(ticket);
    }
  }

  async function retry(): Promise<void> {
    if (disposed) return;
    const ticket = (generation += 1);
    clearCutoffTimer();
    clearRetryTimer();
    resetAttempts();
    recoveryOffered = false;
    if (phase === 'agent-failed') {
      if (request === null) return;
      await enter(request);
      return;
    }
    if (assignment !== null) return;
    // A cutoff retry readies the engine and checks once more for a compatible
    // entry before the fallback is committed.
    setPhase('searching');
    publish();
    runningAttempts += 1;
    try {
      // A lost answer of an earlier attempt can hide a committed assignment.
      // The entry is re-read first, so one entry never produces two games.
      if (await reconcile(ticket)) return;
      if (disposed || ticket !== generation || assignment !== null) return;
      const prepared = await startEnginePreparation(ticket);
      if (disposed || ticket !== generation || assignment !== null) return;
      const candidate = await safeFind(ticket);
      if (disposed || ticket !== generation || assignment !== null) return;
      if (candidate !== null) {
        commitAssignment(candidate);
        return;
      }
      if (!prepared) {
        reportEngineFailure();
        return;
      }
      await attemptWithRecovery(ticket);
    } finally {
      runningAttempts -= 1;
    }
  }

  async function playYourself(): Promise<void> {
    if (disposed || request === null) return;
    // The human seat is an explicit owner action. It is never automatic.
    await enter({ control: { kind: 'human' }, timeControl: request.timeControl });
  }

  async function keepSearching(): Promise<void> {
    if (disposed || !entry) return;
    const ticket = generation;
    try {
      const next = await ports.keepSearching(entry.entryId);
      if (disposed || ticket !== generation || assignment !== null) return;
      entry = next;
      setPhase('searching');
      // The cutoff is explicitly removed, so the engine is never committed
      // for this entry and no try of a fallback is left.
      clearRetryTimer();
      resetAttempts();
      recoveryOffered = false;
      armCutoff(null);
      publish();
    } catch (error) {
      if (disposed || ticket !== generation) return;
      detail = error instanceof Error ? error.message : 'The cutoff could not be removed.';
      publish();
    }
  }

  async function cancel(): Promise<void> {
    if (disposed) return;
    const ticket = (generation += 1);
    clearCutoffTimer();
    clearRetryTimer();
    recoveryOffered = false;
    let confirmed = false;
    let expired = false;
    if (entry) {
      try {
        const next = await ports.cancelEntry(entry.entryId);
        if (!disposed && ticket === generation) {
          entry = next;
          confirmed = next.status === 'cancelled';
          // The service refuses to cancel an expired entry: the expiry is
          // cleared only by an explicit rejoin. An expired answer is not a
          // running search either, so the browser reports the expiry
          // instead of a search that nobody runs.
          expired = !confirmed && next.status === 'waiting' && next.readyAt === null;
        }
      } catch {
        // The service refused the cancellation. The entry decides whether the
        // service committed an assignment anyway, and the reconciliation
        // reports an expiry as the terminal state it is.
        const assigned = await reconcile(ticket);
        if (!disposed && ticket === generation && !assigned) {
          setPhase('searching', 'The entry could not be cancelled.');
          publish();
        }
        return;
      }
    } else {
      confirmed = true;
    }
    if (disposed || ticket !== generation) return;
    if (expired) {
      // The search is over. The owner rejoins explicitly if he wants to
      // search again.
      setPhase('expired');
      publish();
      return;
    }
    // Only a confirmed cancellation reports the cancelled phase. A refused
    // cancellation keeps the committed opponent visible.
    setPhase(confirmed ? 'cancelled' : 'searching', confirmed ? PHASE_DETAIL.cancelled : 'The entry could not be cancelled.');
    publish();
  }

  async function rejoin(): Promise<void> {
    if (disposed || request === null) return;
    const current = entry;
    if (current) {
      // The service re-arms the entry and starts a fresh window.
      try {
        const rearmed = await ports.readyEntry(current.entryId);
        if (disposed) return;
        entry = rearmed;
        assignment = null;
        engineState = 'idle';
        recoveryOffered = false;
        applyEntry(rearmed, generation);
        return;
      } catch {
        // A refused rejoin falls back to a new entry below.
      }
    }
    // A rejoin is explicit. It creates a fresh entry with a fresh window.
    entry = null;
    assignment = null;
    engineState = 'idle';
    recoveryOffered = false;
    await enter(request);
  }

  function observe(next: QueueEntry): void {
    if (disposed) return;
    if (assignment !== null) {
      // The opponent is committed. A late answer never replaces it.
      entry = next;
      publish();
      return;
    }
    if (next.status === 'waiting' && next.readyAt === null
      && (phase === 'searching' || phase === 'engine-unavailable')) {
      // The entry expired or was suspended by the service.
      setPhase('expired');
      clearCutoffTimer();
      clearRetryTimer();
      recoveryOffered = false;
      publish();
      return;
    }
    applyEntry(next, generation);
  }

  /**
   * Adopts an entry that this browser already owns.
   *
   * The entry is the same canonical entry, so the original cutoff decides
   * when the search ends. The engine prepares during the search, exactly as
   * it does for an entry this browser created, so the cutoff can commit it.
   *
   * The adoption never creates an entry, and it never asks the service to
   * commit the engine before the cutoff: the cutoff of the entry does that,
   * and only when it arrives. The settings of the entry are restored too, so
   * the explicit actions of the owner work again after a reload.
   */
  function adopt(next: QueueEntry): void {
    if (disposed) return;
    // A committed opponent is never undone by a late adoption.
    if (assignment !== null) return;
    const ticket = (generation += 1);
    clearCutoffTimer();
    clearRetryTimer();
    resetAttempts();
    recoveryOffered = false;
    assignment = null;
    // The entry carries the settings it was created with, so the explicit
    // actions of the owner - Play yourself and Rejoin - work again.
    request = { control: next.control, timeControl: next.timeControl };
    applyEntry(next, ticket);
    if (phase === 'searching') {
      // The engine prepares during the search. Its failure never blocks the
      // search, and the preparation never commits the engine.
      void prepareEngine(ticket);
    }
  }

  publish();

  return {
    get state() {
      return {
        phase,
        entry,
        detail,
        assignment,
        engineState,
        cutoffAt,
        options: optionsFor(phase, recoveryOffered),
      };
    },
    enter,
    retry,
    playYourself,
    keepSearching,
    cancel,
    rejoin,
    observe,
    adopt,
    reset() {
      // The attempt of the previous identity is fenced at once.
      generation += 1;
      clearCutoffTimer();
      clearRetryTimer();
      resetAttempts();
      recoveryOffered = false;
      windowStartedAt = null;
      windowReadyAt = null;
      phase = 'idle';
      entry = null;
      assignment = null;
      engineState = 'idle';
      cutoffAt = null;
      detail = PHASE_DETAIL.idle;
      publish();
    },
    dispose() {
      disposed = true;
      generation += 1;
      clearCutoffTimer();
      clearRetryTimer();
    },
  };
}
