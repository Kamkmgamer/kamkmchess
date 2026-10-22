/**
 * The explicit queue entries of the online screen (KHA-74).
 *
 * The module owns the attempt of the owner to create a second entry. It is
 * pure: it renders nothing and owns no state.
 *
 * The rules this module keeps:
 *
 * - A new entry is always explicit. The intent of an explicit entry is the
 *   new one, so the entry owns its own intent and its own timer and the
 *   entries of the owner stay untouched. A game never authorizes another
 *   entry on its own.
 * - The seat of an explicit entry is the seat of the owner or the seat of
 *   the own agent. A browser without a connected model never receives an
 *   agent seat, so the helper refuses the agent seat instead of naming a
 *   model it cannot run.
 * - The failure of the attempt is the actionable message of the browser or
 *   of the service, so the owner knows what to do about it.
 */
import type { OnlineComposition } from '../online/composition.js';
import type { SeatControl, TimeControl } from '../online/contracts.js';
import { enterOnlineQueue } from './online-queue-entries.js';

/**
 * The seat of an explicit new entry of the owner.
 *
 * A null seat means that the owner has no agent to play the entry with.
 */
function explicitQueueEntryControl(seat: 'human' | 'agent', agentLabel: string | null): SeatControl | null {
  if (seat === 'human') return { kind: 'human' };
  return agentLabel === null ? null : { kind: 'agent', modelLabel: agentLabel };
}

/**
 * Creates an explicit new entry of the owner.
 *
 * The helper is the one path of the screen that creates a second entry, so
 * the human entry and the agent entry of the screen share it. The default
 * actions of the screen keep the shared entry of the browser and never use
 * this helper.
 *
 * The failure of the attempt is the actionable message of the browser or of
 * the service, so the screen shows the owner what to do about it. A
 * successful attempt returns null.
 */
export async function enterExplicitQueueEntry(
  composition: OnlineComposition,
  seat: 'human' | 'agent',
  agentLabel: string | null,
  clock: TimeControl,
): Promise<string | null> {
  const control = explicitQueueEntryControl(seat, agentLabel);
  if (control === null) return 'The agent of the owner is not selected.';
  return enterOnlineQueue(composition, { control, timeControl: clock }, 'new');
}
