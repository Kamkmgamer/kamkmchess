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
import type { BrowserEngineId } from '../engines/browser';
import { createParticipantSession } from './session';
import { createAuthorizedRequester } from './request';
import { createOnlineMatchCommandClient } from './match-client';
import { createOnlineRunnerLeaseClient } from './runner-lease';
import type { OnlineRunnerLease } from './runner-lease';
import type { GuestOnlineCredential } from './auth';
import type { Seat } from './contracts';
import type { OnlineMatchView } from './updates';

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
  /** Releases the engine seat. */
  dispose(): void;
}

/**
 * Decides whose turn it is.
 *
 * The canonical position owns the side to move. While the opening reply
 * window is open, the seat that owes the reply moves, and no main clock runs.
 */
export function onlineSeatToMove(view: OnlineMatchView, seat: Seat): boolean {
  if (view.status !== 'active') return false;
  const replySeat = view.clock.replySeat;
  if (replySeat !== null) {
    // The opening reply is outstanding. Only the seat that owes it moves.
    return replySeat === seat;
  }
  const activeSeat = view.clock.activeSeat;
  if (activeSeat !== null) return activeSeat === seat;
  const sideToMove = view.positionFen.split(' ')[1];
  if (sideToMove === 'w') return seat === 'white';
  if (sideToMove === 'b') return seat === 'black';
  return false;
}

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
  let lease: OnlineRunnerLease | null = null;

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

  async function holdLease(view: OnlineMatchView): Promise<OnlineRunnerLease | null> {
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
        const result = await searchBrowserEngine(
          { engineId, hashMb, moveTimeMs },
          { startingFen: view.startingFen, moves: view.moves.map(move => move.uci) },
          signal,
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
        await releaseLease();
      }
    },
    dispose() {
      stopped = true;
      lease = null;
      session.dispose();
      requester.dispose();
    },
  };
}
