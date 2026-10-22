/**
 * The side to move of an online match (KHA-74, KHA-77).
 *
 * The service does not arm a main clock for the seat that has to move first,
 * and it does not arm one during the opening reply window. The main clock is
 * therefore never the authority for the turn.
 *
 * The rules this module keeps:
 *
 * - While the opening reply window is open, the seat that owes the reply
 *   moves. No main clock runs in that window.
 * - Otherwise the active seat of the main clock moves.
 * - Otherwise the canonical position names the side to move. A custom
 *   starting position that starts with Black therefore starts with Black.
 *
 * The interface, the browser engine seat and the browser agent runner all use
 * this one rule, so they can never disagree about the turn.
 */
import type { OnlineMatchView } from './updates';
import type { Seat } from './contracts';

/**
 * The seat that owes the next move.
 *
 * It is null when the match is finished.
 */
export function onlineSideToMove(view: OnlineMatchView): Seat | null {
  if (view.status !== 'active') return null;
  const replySeat = view.clock.replySeat;
  if (replySeat !== null) return replySeat;
  const activeSeat = view.clock.activeSeat;
  if (activeSeat !== null) return activeSeat;
  const side = view.positionFen.split(' ')[1];
  if (side === 'w') return 'white';
  if (side === 'b') return 'black';
  return null;
}

/**
 * True when the seat owes the next move.
 *
 * The interface uses it to enable the board, the engine seat to decide
 * whether it plays and the agent runner to decide whether it acts.
 */
export function onlineSeatToMove(view: OnlineMatchView, seat: Seat): boolean {
  return onlineSideToMove(view) === seat;
}
