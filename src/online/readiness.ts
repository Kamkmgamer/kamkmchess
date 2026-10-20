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

/** The options the owner may take in every phase. */
function optionsFor(phase: OnlineQueuePhase): readonly OnlineQueueOption[] {
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
      return ['cancel'];
    case 'expired':
      return ['rejoin', 'cancel'];
    case 'ready':
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
      options: optionsFor(phase),
    };
    options.onState?.(state);
  }

  function setPhase(next: OnlineQueuePhase, nextDetail?: string): void {
    // A committed opponent is never undone by a late asynchronous phase.
    if (phase === 'matched' && next !== 'matched' && next !== 'cancelled') return;
    phase = next;
    detail = nextDetail ?? PHASE_DETAIL[next];
  }

  function clearCutoffTimer(): void {
    if (cutoffTimer !== null) {
      timers.clearTimer(cutoffTimer);
      cutoffTimer = null;
    }
  }

  /** Arms the cutoff timer from the absolute instant the service answered. */
  function armCutoff(absolute: string | null): void {
    clearCutoffTimer();
    cutoffAt = absolute;
    if (absolute === null) return;
    const deadline = Date.parse(absolute);
    if (Number.isNaN(deadline)) return;
    const delay = Math.max(0, deadline - now());
    const ticket = generation;
    cutoffTimer = timers.setTimer(() => {
      cutoffTimer = null;
      if (disposed || ticket !== generation) return;
      void reachCutoff(ticket);
    }, delay);
  }

  /**
   * Starts the engine preparation during the search.
   *
   * A failure is recorded and never blocks the search.
   */
  async function prepareEngine(ticket: number): Promise<void> {
    engineState = 'preparing';
    publish();
    try {
      await ports.prepareEngine();
      if (disposed || ticket !== generation) return;
      engineState = 'ready';
    } catch {
      if (disposed || ticket !== generation) return;
      engineState = 'failed';
    }
    publish();
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
      publish();
      return;
    }
    if (next.readyAt !== null) {
      setPhase('searching');
      armCutoff(next.cutoffAt);
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
    // A lost answer can hide a committed assignment. The entry is re-read
    // before anything that could create a second game.
    if (await reconcile(ticket)) return;
    if (disposed || ticket !== generation || assignment !== null) return;
    // A candidate that is already assigned wins, even at the cutoff.
    const assigned = await safeFind(ticket);
    if (disposed || ticket !== generation || assignment !== null) return;
    if (assigned !== null) {
      commitAssignment(assigned);
      return;
    }
    if (engineState === 'ready') {
      const fallback = await safeFallback(ticket);
      if (disposed || ticket !== generation || assignment !== null) return;
      if (fallback !== null) {
        commitAssignment(fallback);
        return;
      }
      // The fallback answer was lost. The entry decides whether the service
      // committed it anyway.
      if (await reconcile(ticket)) return;
      if (disposed || ticket !== generation || assignment !== null) return;
    }
    setPhase('engine-unavailable', engineState === 'failed'
      ? 'Stockfish could not start. Retry or keep searching.'
      : 'Stockfish is still starting. Retry or keep searching.');
    publish();
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

  async function safeFallback(ticket: number): Promise<OnlineQueueAssignment | null> {
    if (!entry) return null;
    try {
      return await ports.commitFallback(entry.entryId);
    } catch {
      return null;
    } finally {
      void ticket;
    }
  }

  /**
   * Reconciles the local state with the service.
   *
   * A lost answer is the normal failure of a suspended tab: the service may
   * have committed an assignment that the browser never saw. The entry is
   * therefore re-read before every decision that could create a second game.
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
      entry = current;
      setPhase('cancelled');
      clearCutoffTimer();
      publish();
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
    // A lost answer of an earlier attempt can hide a committed assignment.
    // The entry is re-read first, so one entry never produces two games.
    if (await reconcile(ticket)) return;
    if (disposed || ticket !== generation || assignment !== null) return;
    const prepared = await prepareEngineSafe(ticket);
    if (disposed || ticket !== generation || assignment !== null) return;
    const candidate = await safeFind(ticket);
    if (disposed || ticket !== generation || assignment !== null) return;
    if (candidate !== null) {
      commitAssignment(candidate);
      return;
    }
    if (!prepared) {
      setPhase('engine-unavailable', 'Stockfish could not start. Retry or keep searching.');
      publish();
      return;
    }
    const fallback = await safeFallback(ticket);
    if (disposed || ticket !== generation || assignment !== null) return;
    if (fallback !== null) {
      commitAssignment(fallback);
      return;
    }
    // The fallback answer was lost. The entry decides whether the service
    // committed it anyway.
    if (await reconcile(ticket)) return;
    if (disposed || ticket !== generation || assignment !== null) return;
    setPhase('engine-unavailable', 'Stockfish could not start. Retry or keep searching.');
    publish();
  }

  async function prepareEngineSafe(ticket: number): Promise<boolean> {
    engineState = 'preparing';
    publish();
    try {
      await ports.prepareEngine();
    } catch {
      if (disposed || ticket !== generation) return false;
      engineState = 'failed';
      publish();
      return false;
    }
    if (disposed || ticket !== generation) return false;
    engineState = 'ready';
    publish();
    return true;
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
      // The cutoff is explicitly removed.
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
    let confirmed = false;
    if (entry) {
      try {
        const next = await ports.cancelEntry(entry.entryId);
        if (!disposed && ticket === generation) {
          entry = next;
          confirmed = next.status === 'cancelled';
        }
      } catch {
        // The service refused the cancellation. The entry decides whether the
        // service committed an assignment anyway.
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
    // Only a confirmed cancellation reports the cancelled phase. A refused
    // cancellation keeps the committed opponent visible.
    setPhase(confirmed ? 'cancelled' : 'searching', confirmed ? PHASE_DETAIL.cancelled : 'The entry could not be cancelled.');
    publish();
  }

  async function rejoin(): Promise<void> {
    if (disposed || request === null) return;
    // A rejoin is explicit. It creates a fresh entry with a fresh window.
    entry = null;
    assignment = null;
    engineState = 'idle';
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
    if (next.status === 'waiting' && next.readyAt === null && phase === 'searching') {
      // The entry expired or was suspended by the service.
      setPhase('expired');
      clearCutoffTimer();
      publish();
      return;
    }
    applyEntry(next, generation);
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
        options: optionsFor(phase),
      };
    },
    enter,
    retry,
    playYourself,
    keepSearching,
    cancel,
    rejoin,
    observe,
    reset() {
      // The attempt of the previous identity is fenced at once.
      generation += 1;
      clearCutoffTimer();
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
    },
  };
}
