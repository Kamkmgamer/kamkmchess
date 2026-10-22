/**
 * The hand-back of a seat to the agent of the owner (KHA-74).
 *
 * The module owns the question "how does a seat go back to the agent?" and it
 * never hides an outcome: a hand-back the service proved, a hand-back the
 * service refused and a hand-back whose outcome could not be established reach
 * the screen as they are.
 *
 * The rules this module keeps:
 *
 * - The hand-back is the decision of the composition. The composition asks the
 *   service for the control change, keeps the private binding of the seat and
 *   replaces the runner of the seat, so the seat never waits for the deadline
 *   of its turn with a runner that gave up.
 * - The browser sends one command, never two. The service decides whether the
 *   control of the seat changes, and the screen never reports a hand-back it
 *   cannot prove.
 * - A refused hand-back and an unknown hand-back are visible failures with
 *   the reason the composition gave, and the reason names what the owner can
 *   do about it. The screen never claims a seat the agent does not play.
 */
import type { AgentDecisionOutcome, OnlineComposition } from '../online/composition.js';
import type { Seat } from '../online/contracts.js';

/** The seat the owner hands to its agent. */
export interface OnlineAgentHandoffSeat {
  /** The match of the seat. */
  readonly matchId: string;
  /** The seat of the owner. */
  readonly seat: Seat;
}

/** The port the hand-back of a seat uses. */
export interface OnlineAgentHandoffPort {
  /**
   * The decision of the composition.
   *
   * It is the only path that changes the control of the seat, binds the
   * private selection of the seat and replaces the runner of the seat.
   */
  readonly handToAgent: (matchId: string, seat: Seat) => Promise<AgentDecisionOutcome>;
}

/** The outcome of a hand-back. */
export type OnlineAgentHandoffOutcome =
  /** The service proved the hand-back. The seat plays the agent. */
  | { readonly kind: 'accepted'; readonly detail: string }
  /** The service refused the hand-back. The seat keeps its control. */
  | { readonly kind: 'refused'; readonly detail: string }
  /** The outcome could not be established. The owner may try again. */
  | { readonly kind: 'unknown'; readonly detail: string };

/**
 * The port of the composition for the hand-back of a seat.
 *
 * The composition owns the private binding and the runner of the seat, so the
 * port asks for the decision of the hand-back and for nothing else.
 */
export function onlineAgentHandoffPort(composition: OnlineComposition): OnlineAgentHandoffPort {
  return {
    handToAgent: (matchId, seat) => composition.handSeatToAgent(matchId, seat),
  };
}

/**
 * Hands one seat to the agent of the owner.
 *
 * The outcome of the composition is reported as it is: a refused hand-back and
 * an unknown hand-back never read as a seat the agent plays.
 */
export async function handSeatToAgent(
  seat: OnlineAgentHandoffSeat,
  port: OnlineAgentHandoffPort,
): Promise<OnlineAgentHandoffOutcome> {
  const outcome = await port.handToAgent(seat.matchId, seat.seat);
  if (outcome.kind === 'accepted') {
    return { kind: 'accepted', detail: `The seat plays ${outcome.publicModelLabel} now.` };
  }
  // The reason of the composition is kept as it is: the owner reads the reason
  // the composition gave, including what the owner can do about it.
  return outcome.kind === 'refused'
    ? { kind: 'refused', detail: outcome.detail }
    : { kind: 'unknown', detail: outcome.detail };
}

/** The feedback of a hand-back. */
export type OnlineAgentHandoffFeedback =
  /** The service proved the hand-back. The seat plays the agent. */
  | { readonly kind: 'status'; readonly detail: string }
  /** The hand-back did not happen. The seat keeps its control. */
  | { readonly kind: 'failure'; readonly detail: string };

/**
 * The surfaces of the screen that show the outcome of a hand-back.
 *
 * The status is the polite region of the screen and the failure is the
 * visible error region of the screen. The two are never both written, so the
 * owner reads one outcome and not two.
 */
export interface OnlineAgentHandoffSurfaces {
  /** The polite status of the screen. */
  readonly status: (text: string) => void;
  /** The visible failure of the screen. */
  readonly failure: (text: string) => void;
}

/**
 * The feedback of an outcome of the hand-back.
 *
 * The service decides the outcome, so the browser only routes it: a proved
 * hand-back is a status and every other outcome is a failure the owner has to
 * see.
 */
export function onlineAgentHandoffFeedback(outcome: OnlineAgentHandoffOutcome): OnlineAgentHandoffFeedback {
  if (outcome.kind === 'accepted') return { kind: 'status', detail: outcome.detail };
  return { kind: 'failure', detail: outcome.detail };
}

/**
 * Shows the feedback of a hand-back on the screen.
 *
 * A status closes the visible failure and a failure closes the polite status,
 * so the screen shows exactly one outcome of the hand-back.
 */
export function reportOnlineAgentHandoff(
  surfaces: OnlineAgentHandoffSurfaces,
  feedback: OnlineAgentHandoffFeedback,
): void {
  if (feedback.kind === 'status') {
    surfaces.status(feedback.detail);
    return;
  }
  surfaces.failure(feedback.detail);
}
