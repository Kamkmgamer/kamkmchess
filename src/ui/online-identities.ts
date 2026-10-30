import { useEffect, useState } from 'react';
import type { ProfileClient } from '../profile/client.js';
import type { PublicProfile } from '../profile/contracts.js';

/** What the seat-profile lookups of one workspace know. */
export interface SeatProfileState {
  /** The profiles whose lookups landed. */
  readonly profiles: ReadonlyMap<string, PublicProfile>;
  /** Labels whose lookup found no profile — guests, unnamed accounts. */
  readonly missed: ReadonlySet<string>;
  /** Labels with a lookup in flight, so a re-run never starts it twice. */
  readonly pending: ReadonlySet<string>;
}

export const EMPTY_SEAT_PROFILES: SeatProfileState = { profiles: new Map(), missed: new Set(), pending: new Set() };

/** Labels of a seat list that no cached state answers yet. */
export function missingLabels(labels: readonly string[], state: SeatProfileState): string[] {
  return labels.filter(label => !state.profiles.has(label) && !state.missed.has(label) && !state.pending.has(label));
}

/** The state with one profile recorded. */
export function markResolved(state: SeatProfileState, label: string, profile: PublicProfile): SeatProfileState {
  const pending = new Set(state.pending);
  pending.delete(label);
  return { profiles: new Map(state.profiles).set(label, profile), missed: state.missed, pending };
}

/** The state with one lookup recorded as finding nothing. */
export function markMissed(state: SeatProfileState, label: string): SeatProfileState {
  const pending = new Set(state.pending);
  pending.delete(label);
  return { profiles: state.profiles, missed: new Set(state.missed).add(label), pending };
}

/**
 * The public profiles behind a match's named seats.
 *
 * A signed-in seat's public label is the username that player chose in their
 * profile, so the label alone is enough to look their profile up — no
 * credential, no account id crosses anything. Misses are cached, so a live
 * match view that updates every move never refetches a guest.
 */
export function useSeatProfiles(labels: readonly string[], client: ProfileClient | null): ReadonlyMap<string, PublicProfile> {
  const [state, setState] = useState<SeatProfileState>(() => EMPTY_SEAT_PROFILES);
  useEffect(() => {
    const missing = missingLabels(labels, state);
    if (missing.length === 0 || !client) return;
    // The pending bookkeeping is synchronous, so a view update that re-runs
    // this effect never starts the same lookup twice.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(current => ({ ...current, pending: new Set([...current.pending, ...missing]) }));
    let live = true;
    for (const label of missing) {
      client.readPublicProfileByUsername(label).then(
        profile => { if (live) setState(current => markResolved(current, label, profile)); },
        () => { if (live) setState(current => markMissed(current, label)); });
    }
    return () => { live = false; };
  }, [labels, client, state]);
  return state.profiles;
}
