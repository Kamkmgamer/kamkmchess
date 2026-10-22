/**
 * The takeover of a seat of the online screen (KHA-74).
 *
 * The module owns the question "how is this seat taken over?" and it never
 * hides an outcome: an accepted takeover, a refusal of the service and an
 * unknown outcome reach the screen as they are.
 *
 * The rules this module keeps:
 *
 * - A seat the browser plays with its own agent is taken over through the
 *   decision of the composition. That path stops the runner of the seat,
 *   releases the lease of the seat and drops the private binding of the
 *   seat, so no agent of this browser stays alive after the service changed
 *   the control of the seat.
 * - A human seat and a seat of the browser engine keep the direct control
 *   change of the service: they have no runner of this browser to stop and
 *   no private binding to drop.
 * - The browser never sends both commands. One seat is taken over once, and
 *   the screen never reports a takeover it cannot prove.
 */
import type { AgentDecisionOutcome, OnlineComposition } from '../online/composition.js';
import type { Seat, SeatControl } from '../online/contracts.js';
import type { OnlineMatchCommandClient } from '../online/match-client.js';

/**
 * The way one seat is taken over.
 *
 * The two ways are never mixed: a seat is taken over either by the decision
 * of the composition or by the direct control change of the service.
 */
export type OnlineTakeoverRoute =
  /** The decision of the composition takes the seat over. */
  | 'agent-decision'
  /** The service changes the control of the seat directly. */
  | 'direct-control';

/** The seat the owner takes over. */
export interface OnlineTakeoverSeat {
  /** The match of the seat. */
  readonly matchId: string;
  /** The seat of the owner. */
  readonly seat: Seat;
  /** The control the service published for the seat. */
  readonly control: SeatControl | null;
  /** The version of the canonical view of the match. */
  readonly version: number;
  /** The control epoch of the canonical view of the match. */
  readonly controlEpoch: number;
  /**
   * True when this browser plays the seat with its own agent.
   *
   * The browser holds the private selection of the seat, so it owns the
   * runner of the seat, the lease of the seat and the private binding of the
   * seat. Only the decision of the composition may end them.
   */
  readonly browserRunsAgent: boolean;
}

/** The port the takeover of a seat uses. */
export interface OnlineTakeoverPort {
  /**
   * The decision of the composition.
   *
   * It is the only path that stops the runner of the seat, releases the
   * lease of the seat and drops the private binding of the seat.
   */
  readonly agentDecision: (matchId: string, seat: Seat) => Promise<AgentDecisionOutcome>;
  /** The command client of the seat, when the browser holds one. */
  readonly commandClient: (matchId: string, seat: Seat) => OnlineMatchCommandClient | null;
}

/** The outcome of a takeover. */
export type OnlineTakeoverOutcome =
  /** The service proved the takeover. The seat belongs to the owner. */
  | { readonly kind: 'accepted'; readonly detail: string }
  /** The service refused the takeover. The seat keeps its control. */
  | { readonly kind: 'refused'; readonly detail: string }
  /** The outcome could not be established. The owner may try again. */
  | { readonly kind: 'unknown'; readonly detail: string };

/**
 * The port of the composition for the takeover of a seat.
 *
 * The decision of the composition is the only path that ends the runner, the
 * lease and the private binding of a seat this browser plays, so the port
 * asks for the decision of the takeover and for nothing else.
 */
export function onlineTakeoverPort(composition: OnlineComposition): OnlineTakeoverPort {
  return {
    agentDecision: (matchId, seat) => composition.agentDecision(matchId, seat, 'takeover'),
    commandClient: (matchId, seat) => composition.commandClient(matchId, seat),
  };
}

/**
 * True when this browser plays the seat with its own agent.
 *
 * The service declares the seat as an agent seat and the browser holds the
 * private selection of the owner for it, so the browser owns the runner of
 * the seat, the lease of the seat and the private binding of the seat. Only
 * the decision of the composition may end them.
 */
export function onlineSeatRunsAgent(control: SeatControl | null, browserHoldsBinding: boolean): boolean {
  if (control === null || control.kind !== 'agent') return false;
  return browserHoldsBinding;
}

/**
 * The way one seat is taken over.
 *
 * The seat of the browser engine and the seat of a human keep the direct
 * control change: they have no runner of this browser. The seat of an agent
 * this browser plays is taken over by the decision of the composition, and
 * only that decision stops the runner, releases the lease and drops the
 * private binding of the seat.
 */
export function onlineTakeoverRoute(seat: OnlineTakeoverSeat): OnlineTakeoverRoute {
  // A human seat and a seat of the browser engine have no runner of this
  // browser, so the direct control change is the only command they need.
  if (seat.control === null || seat.control.kind !== 'agent') return 'direct-control';
  // An agent seat this browser does not play belongs to the service and to
  // another player. The browser changes the control of the seat and touches
  // nothing of an agent it does not own.
  if (!seat.browserRunsAgent) return 'direct-control';
  return 'agent-decision';
}

/**
 * Takes one seat over.
 *
 * The seat of an agent this browser plays goes through the decision of the
 * composition, so the runner of the seat, its lease and its private binding
 * end with the takeover. Every other seat keeps the direct control change of
 * the service.
 *
 * The outcome of the composition is reported as it is: a refused takeover and
 * an unknown takeover never read as a seat the owner owns.
 */
export async function takeOverOnlineSeat(
  seat: OnlineTakeoverSeat,
  port: OnlineTakeoverPort,
): Promise<OnlineTakeoverOutcome> {
  if (onlineTakeoverRoute(seat) === 'agent-decision') {
    const outcome = await port.agentDecision(seat.matchId, seat.seat);
    if (outcome.kind === 'accepted') return { kind: 'accepted', detail: 'The seat is yours.' };
    if (outcome.kind === 'refused') return { kind: 'refused', detail: outcome.detail };
    return { kind: 'unknown', detail: outcome.detail };
  }
  const client = port.commandClient(seat.matchId, seat.seat);
  if (!client) return { kind: 'refused', detail: 'The seat is not authorized.' };
  // The command names the version and the epoch of the canonical view, so the
  // service refuses a command of a state it already left.
  client.setVersion(seat.version);
  client.setControlEpoch(seat.controlEpoch);
  await client.setControl({ kind: 'human' });
  return { kind: 'accepted', detail: 'The seat is yours.' };
}
