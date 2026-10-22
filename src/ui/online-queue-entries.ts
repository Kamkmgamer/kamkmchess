/**
 * The queue entries of the online screen (KHA-74).
 *
 * The module owns the accessible names of the controls of the explicit queue
 * entries and the attempt to enter the queue. It is pure: it renders nothing
 * and owns no state.
 *
 * The rules this module keeps:
 *
 * - Two entries of the owner may differ only in their seat, their clock or
 *   their state, so the name of a control carries that context. The
 *   identifier of the entry stays in the name, so the name of one entry never
 *   proves the name of the next one.
 * - The failure of an attempt is the actionable message of the browser or of
 *   the service, so the owner knows what to do about it. A browser without
 *   the lock of the origin fails closed with a message of its own.
 */
import type { OnlineComposition, OnlineQueueEntryView } from '../online/composition.js';
import type { SeatControl, TimeControl } from '../online/contracts.js';
import type { OnlineQueuePhase, OnlineQueueState } from '../online/readiness.js';

/**
 * The phase of one queue entry, as an accessible name reads it.
 *
 * The phase is a short word, so the name of a control stays short enough to
 * be read at a glance.
 */
const QUEUE_PHASE_LABELS: Record<OnlineQueuePhase, string> = {
  idle: 'idle',
  'checking-agent': 'checking the agent',
  'agent-failed': 'not ready',
  ready: 'ready',
  searching: 'searching',
  'engine-unavailable': 'the engine is unavailable',
  assigned: 'assigned',
  matched: 'matched',
  expired: 'expired',
  cancelled: 'cancelled',
};

/**
 * The clock of one queue entry, as the owner reads it.
 *
 * The clock is written the way the clock buttons of the screen write it, so
 * the name of a control and the visible choice of the owner agree.
 */
function queueEntryClockLabel(timeControl: TimeControl): string {
  const minutes = Math.round(timeControl.startingTimeMs / 60_000);
  const increment = Math.round(timeControl.incrementMs / 1_000);
  return `${minutes}+${increment}`;
}

/**
 * The seat one queue entry asks for, as the owner reads it.
 *
 * A human entry plays the seat of the owner and an agent entry plays the
 * seat of the selected model. An entry the service did not accept yet has no
 * seat at all, and the name says so instead of guessing one.
 */
function queueEntrySeatLabel(state: OnlineQueueState): string {
  const control = state.entry?.control ?? null;
  if (control === null) return 'Pending seat';
  if (control.kind === 'human') return 'Human seat';
  if (control.kind === 'engine') return 'Engine seat';
  return control.modelLabel ? `Agent seat ${control.modelLabel}` : 'Agent seat';
}

/**
 * The context of one queue entry, for the accessible name of its controls.
 *
 * The context names the seat, the control, the clock and the state of the
 * entry, so the owner tells his own entries apart.
 */
export function queueEntryContext(entry: OnlineQueueEntryView): string {
  const state = entry.state;
  const parts = [queueEntrySeatLabel(state)];
  const clock = state.entry === null ? null : queueEntryClockLabel(state.entry.timeControl);
  if (clock !== null) parts.push(clock);
  const seat = state.assignment?.seat ?? null;
  if (seat !== null) parts.push(`as ${seat}`);
  parts.push(QUEUE_PHASE_LABELS[state.phase]);
  return parts.join(', ');
}

/**
 * The accessible name of one control of a queue entry.
 *
 * The name carries the context of the entry, so the owner tells his own
 * entries apart without reading a counter of the browser.
 */
export function queueEntryControlLabel(entry: OnlineQueueEntryView, action: 'show' | 'cancel'): string {
  const verb = action === 'show' ? 'Show' : 'Cancel';
  return `${verb} queue entry ${entry.id}: ${queueEntryContext(entry)}`;
}

/**
 * Enters the queue and returns the failure of the attempt.
 *
 * The failure is the actionable message of the browser or of the service, so
 * the screen shows the owner what to do about it. A successful attempt
 * returns null.
 */
export async function enterOnlineQueue(
  composition: OnlineComposition,
  request: { readonly control: SeatControl; readonly timeControl: TimeControl },
  intent: 'reuse' | 'new',
): Promise<string | null> {
  try {
    await composition.enterQueue(request, { intent });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'The entry could not be created.';
  }
}
