/**
 * The browser engine seat (KHA-77).
 *
 * A fallback game is played against the browser Stockfish 19 Lite. The engine
 * runs in the owner's browser, so the browser also holds the seat credential
 * of the engine seat and submits the engine's moves through the ordinary
 * participant command route.
 *
 * The rules this module keeps:
 *
 * - The turn of the engine is decided by the canonical position and by the
 *   opening reply window, never by the main clock alone. During the opening
 *   reply no main clock runs, so the clock cannot decide whose turn it is.
 *   The engine moves when the position names its side to move, or when it
 *   owes the opening reply.
 * - The engine searches the canonical history of the match: the starting
 *   position and the accepted UCI moves. It never searches a position of its
 *   own and never loses the repetition history.
 * - The engine holds a runner lease for its turn. Every command carries the
 *   lease identifier, a lease of an older control epoch or of an older turn is
 *   fenced by the service, and the lease is released when the turn ends.
 * - A control change, a version change or a disposed seat aborts the search
 *   and fences the answer. An answer of an older turn is never submitted.
 * - A failure of the engine never ends the game. The service keeps the clock
 *   running and the owner may take over.
 */
import { searchBrowserEngine } from '../engines/browser';
import type { BrowserEngineId, BrowserEngineResult } from '../engines/browser';
import { createParticipantSession } from './session';
import { createAuthorizedRequester } from './request';
import { createOnlineMatchCommandClient } from './match-client';
import { createOnlineRunnerLeaseClient } from './runner-lease';
import type { ProviderRunnerLease } from './provider-runner';
import type { GuestOnlineCredential } from './auth';
import type { Seat } from './contracts';
import type { OnlineMatchView } from './updates';
import { onlineSeatToMove } from './turn';

/**
 * The time the engine seat waits for a busy engine worker.
 *
 * The browser engine worker is one worker for the whole page, so the offline
 * board and the online engine seat share it. A search of the offline board
 * holds the worker for the length of that search, and the engine seat waits
 * for it instead of losing the turn. The wait is bounded: a worker that stays
 * busy longer fails the turn, and the owner may take over the seat.
 */
export const ONLINE_ENGINE_BUSY_WAIT_MS = 20_000;

/** The poll of the wait for a busy engine worker. */
const ONLINE_ENGINE_BUSY_POLL_MS = 250;

/**
 * The message of a busy engine worker.
 *
 * The engine module names the condition in the error it throws. The engine
 * seat waits for that condition and never for a failure of its own.
 */
const ENGINE_BUSY_MESSAGE = 'still finishing another turn';

/** The outcome of one engine turn. */
export type OnlineEngineTurnResult =
  | { readonly kind: 'moved'; readonly move: string }
  | { readonly kind: 'not-turn' }
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'stopped' };

export interface OnlineEngineSeatOptions {
  readonly matchId: string;
  readonly seat: Seat;
  /** The seat credential of the engine seat. */
  readonly credential: GuestOnlineCredential;
  /** The trusted service origin. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** The engine build. The fallback always uses Stockfish 19 Lite. */
  readonly engineId?: BrowserEngineId;
  /** The thinking time of one engine move. */
  readonly moveTimeMs?: number;
  /** The engine hash size in megabytes. */
  readonly hashMb?: number;
  /** Prepares the engine before the first move. */
  readonly prepareEngine?: () => Promise<void>;
  /** The identifier of this browser runner. */
  readonly runnerId?: string;
}

/** The browser engine seat of one fallback game. */
export interface OnlineEngineSeat {
  /** The seat the engine plays. */
  readonly seat: Seat;
  /** Plays the engine turn of a match view, when the engine is to move. */
  play(view: OnlineMatchView, signal?: AbortSignal): Promise<OnlineEngineTurnResult>;
  /** True when the seat was disposed. */
  readonly stopped: boolean;
  /** Releases the engine seat. The lease of the seat is released with it. */
  dispose(): Promise<void>;
}

export { onlineSeatToMove } from './turn';

function defaultRunnerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `runner${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  return `runner${Math.random().toString(36).slice(2, 18)}`;
}

/**
 * Creates the browser engine seat.
 *
 * The seat owns a scoped participant session, so the engine credential never
 * authorizes another match and another seat.
 */
export function createOnlineEngineSeat(options: OnlineEngineSeatOptions): OnlineEngineSeat {
  const engineId = options.engineId ?? 'stockfish-lite';
  const moveTimeMs = options.moveTimeMs ?? 1_000;
  const hashMb = options.hashMb ?? 16;
  const runnerId = options.runnerId ?? defaultRunnerId();
  const session = createParticipantSession();
  session.selectGuest(options.credential);
  const requester = createAuthorizedRequester({
    session,
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const commands = createOnlineMatchCommandClient({
    requester,
    session,
    matchId: options.matchId,
    seat: options.seat,
  });
  const leases = createOnlineRunnerLeaseClient({
    requester,
    session,
    matchId: options.matchId,
    seat: options.seat,
    runnerId,
  });
  let stopped = false;
  let prepared = false;
  /** The lease of the current turn. */
  let lease: ProviderRunnerLease | null = null;
  /**
   * The controller of the running search.
   *
   * A disposed seat aborts its search, so a search of a seat that lost its
   * credential never holds the shared engine worker.
   */
  let searchController: AbortController | null = null;

  async function releaseLease(): Promise<void> {
    const current = lease;
    lease = null;
    if (!current) return;
    try {
      await leases.release({
        controlEpoch: current.controlEpoch,
        turnVersion: current.turnVersion ?? 0,
        leaseId: current.leaseId,
      });
    } catch {
      // A lease that cannot be released expires on its own.
    }
  }

  /** Waits for the given time, unless the seat stops or the caller aborts. */
  async function wait(ms: number, signal: AbortSignal | undefined, controller: AbortController): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = globalThis.setTimeout(finish, ms);
      const onAbort = () => finish();
      function finish(): void {
        globalThis.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Searches the engine turn.
   *
   * The engine worker is shared with the offline board. A search of the
   * offline board holds the worker for the length of that search, and the
   * engine seat waits for the worker and searches again. The wait is bounded,
   * so a worker that stays busy fails the turn instead of holding the seat.
   */
  async function searchTurn(
    position: { startingFen: string; moves: readonly string[] },
    controller: AbortController,
  ): Promise<BrowserEngineResult> {
    const deadline = Date.now() + ONLINE_ENGINE_BUSY_WAIT_MS;
    for (;;) {
      try {
        return await searchBrowserEngine(
          { engineId, hashMb, moveTimeMs },
          position,
          controller.signal,
        );
      } catch (error) {
        const busy = error instanceof Error && error.message.includes(ENGINE_BUSY_MESSAGE);
        if (!busy || Date.now() >= deadline) throw error;
        await wait(ONLINE_ENGINE_BUSY_POLL_MS, undefined, controller);
        if (controller.signal.aborted) throw error;
      }
    }
  }

  async function holdLease(view: OnlineMatchView): Promise<ProviderRunnerLease | null> {
    const current = lease;
    if (current && current.controlEpoch !== view.controlEpoch) {
      // A control change fences the old lease.
      await releaseLease();
    }
    if (!lease) {
      lease = await leases.acquire({
        controlEpoch: view.controlEpoch,
        turnVersion: view.version,
      });
      return lease;
    }
    const expiresAt = Date.parse(lease.expiresAt);
    const acquiredAt = Date.parse(lease.acquiredAt);
    const now = Date.now();
    if (Number.isNaN(expiresAt) || Number.isNaN(acquiredAt)) return lease;
    // A lease that is more than half spent is renewed before the answer.
    if (now - acquiredAt > (expiresAt - acquiredAt) / 2) {
      lease = await leases.renew({
        controlEpoch: view.controlEpoch,
        turnVersion: lease.turnVersion ?? view.version,
        leaseId: lease.leaseId,
      });
    }
    return lease;
  }

  return {
    seat: options.seat,
    get stopped() {
      return stopped;
    },
    async play(view, signal) {
      if (stopped) return { kind: 'stopped' };
      if (signal?.aborted) return { kind: 'stopped' };
      const seatView = view.seats.find(candidate => candidate.seat === options.seat);
      if (!seatView || seatView.control.kind !== 'engine') return { kind: 'not-turn' };
      if (!onlineSeatToMove(view, options.seat)) return { kind: 'not-turn' };
      const epoch = view.controlEpoch;
      const version = view.version;
      // The search of the turn runs under a controller of the seat, so a
      // disposed seat stops it and never holds the shared engine worker.
      const controller = new AbortController();
      searchController = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (!prepared && options.prepareEngine) {
          await options.prepareEngine();
          prepared = true;
        }
        if (stopped || signal?.aborted) return { kind: 'stopped' };
        const held = await holdLease(view);
        if (!held || held.status !== 'active') {
          return { kind: 'failed', detail: 'The engine could not take its seat lease.' };
        }
        const result = await searchTurn(
          { startingFen: view.startingFen, moves: view.moves.map(move => move.uci) },
          controller,
        );
        if (stopped || signal?.aborted) return { kind: 'stopped' };
        // A control change or a newer version fences the answer.
        if (held.controlEpoch !== epoch) return { kind: 'stopped' };
        const move = result.move.trim();
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
          return { kind: 'failed', detail: 'The engine returned no playable move.' };
        }
        commands.setVersion(version);
        commands.setControlEpoch(epoch);
        await commands.move(move, { expectedVersion: version, leaseId: held.leaseId });
        return { kind: 'moved', move };
      } catch (error) {
        if (stopped) return { kind: 'stopped' };
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (aborted) return { kind: 'stopped' };
        return {
          kind: 'failed',
          detail: error instanceof Error ? error.message : 'The engine move was not accepted.',
        };
      } finally {
        signal?.removeEventListener('abort', abort);
        if (searchController === controller) searchController = null;
        await releaseLease();
      }
    },
    async dispose() {
      stopped = true;
      // The search of the seat stops with it, so a search of a seat that lost
      // its credential never holds the shared engine worker.
      searchController?.abort();
      // The lease of the seat is released before the requester goes away, so
      // a new runner of the seat is never refused by an orphaned lease.
      await releaseLease();
      session.dispose();
      requester.dispose();
    },
  };
}
