/**
 * The online view models (KHA-74).
 *
 * The module turns a canonical online snapshot into the compact strings and
 * rows the interface shows. It is pure: it renders nothing and owns no
 * state.
 *
 * The rules this module keeps:
 *
 * - The interface copy stays inside the twenty-word convention. The copy in
 *   this module is the copy of the screen; the player names, the model
 *   labels, the clocks and the notation are game data and are not counted.
 * - There is no separate per-move declared-models block. The declared
 *   control of a seat is one compact label, and the per-move attribution
 *   stays in the replay metadata.
 * - The engine screens stay inside the ten-word convention.
 * - A result is described once. The interface never shows two different
 *   results for the same match.
 */
import type { AppliedMoveV1 } from '../storage/index.js';
import type { Seat, SeatControl } from '../online/contracts.js';
import type { OnlineMatchView } from '../online/updates.js';
import type { OnlineClockReading } from '../online/clock.js';

/** One seat of the board. */
export interface OnlineSeatRow {
  readonly seat: Seat;
  /** The public name of the participant. It is game data. */
  readonly label: string;
  /** The compact declared control of the seat. */
  readonly controlLabel: string;
  /** True when the owner of this browser plays the seat. */
  readonly yours: boolean;
}

/**
 * The compact control label of a seat.
 *
 * The label is a declaration, never a provider attestation. The browser
 * engine is named as such. A seat the view does not name has no declared
 * control, and the interface never invents one.
 */
export function onlineControlLabel(control: SeatControl | null | undefined): string {
  if (!control) return 'Unknown';
  if (control.kind === 'human') return 'Human';
  if (control.kind === 'engine') {
    const label = control.modelLabel ?? 'Stockfish 19 Lite';
    return `Engine · ${label} (browser)`;
  }
  const label = control.modelLabel ?? 'Agent';
  return `Agent · ${label}`;
}

/** The two seat rows of a match, white first. */
export function onlineSeatRows(view: OnlineMatchView, yourSeat: Seat | null): OnlineSeatRow[] {
  const rows: OnlineSeatRow[] = [];
  for (const seat of ['white', 'black'] as const) {
    const found = view.seats.find(candidate => candidate.seat === seat);
    rows.push({
      seat,
      label: found?.publicLabel ?? (seat === 'white' ? 'White' : 'Black'),
      controlLabel: onlineControlLabel(found?.control ?? null),
      yours: yourSeat === seat,
    });
  }
  return rows;
}

/**
 * The status line of a match.
 *
 * The line names the side to move, the pending reply, the result or the
 * connection state. It never names a provider route and never claims a
 * provider-verified attribution.
 */
export function onlineStatusText(view: OnlineMatchView, reading: OnlineClockReading): string {
  if (view.result !== null) return onlineResultText(view);
  if (view.status === 'aborted') return 'Aborted.';
  if (reading.replySeat !== null) {
    return reading.replySeat === 'white' ? 'White to reply.' : 'Black to reply.';
  }
  const side = view.positionFen.split(' ')[1] === 'b' ? 'Black' : 'White';
  return `${side} to move.`;
}

/** The result line of a finished match. */
export function onlineResultText(view: OnlineMatchView): string {
  const result = view.result;
  if (result === null) return '';
  if (result.kind === 'abort') return 'Aborted.';
  if (result.kind === 'draw') return 'Draw.';
  return result.winner === 'white' ? 'White wins.' : 'Black wins.';
}

/**
 * The accepted moves of a match, shaped for the shared move list.
 *
 * The list is the game data of the match. It carries no per-move model
 * declaration.
 */
export function onlineAppliedMoves(view: OnlineMatchView): AppliedMoveV1[] {
  const moves: AppliedMoveV1[] = [];
  let fenBefore = view.startingFen;
  for (const move of view.moves) {
    const uci = move.uci;
    moves.push({
      moveId: `online-${move.version}`,
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4, 5) : null,
      san: move.san,
      fenBefore,
      fenAfter: move.resultingFen,
      eventId: `online-${move.version}`,
    });
    fenBefore = move.resultingFen;
  }
  return moves;
}

/** The position of a move number of the match. */
export function onlinePositionFen(view: OnlineMatchView, ply: number): string {
  if (ply <= 0) return view.startingFen;
  const move = view.moves[ply - 1];
  return move ? move.resultingFen : view.positionFen;
}

/** The compact title of a match. */
export function onlineGameTitle(view: OnlineMatchView, yourSeat: Seat | null): string {
  const opponent = view.seats.find(candidate => candidate.seat !== yourSeat);
  const label = opponent?.publicLabel ?? 'Opponent';
  const control = onlineControlLabel(opponent?.control ?? null);
  return `${label} · ${control}`;
}

/**
 * The connection state of a match.
 *
 * The interface shows a reconnecting state instead of a frozen board, so the
 * owner never mistakes a suspended tab for a live game.
 */
export function onlineConnectionText(status: 'connecting' | 'live' | 'reconnecting' | 'stopped' | 'unauthorized' | 'not-found'): string {
  switch (status) {
    case 'connecting': return 'Connecting…';
    case 'reconnecting': return 'Reconnecting…';
    case 'unauthorized': return 'Not a participant.';
    case 'not-found': return 'The match is gone.';
    case 'stopped': return 'Stopped.';
    default: return '';
  }
}
