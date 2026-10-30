import { describe, expect, it } from 'vitest';
import { EMPTY_SEAT_PROFILES, markMissed, markResolved, missingLabels } from './online-identities.js';
import type { PublicProfile } from '../profile/contracts.js';

function profile(username: string): PublicProfile {
  return {
    schemaVersion: 1, profileId: `kp_${username.toLowerCase()}`, username,
    avatar: { kind: 'chosen', value: 'ember' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('the seat profile state', () => {
  it('asks only for labels no cached state answers yet', () => {
    const state = markResolved(markMissed(EMPTY_SEAT_PROFILES, 'Guest'), 'Alex', profile('Alex'));
    expect(missingLabels(['Alex', 'Guest', 'Sam'], state)).toEqual(['Sam']);
    // An in-flight lookup is not started twice.
    const pending = markResolved(EMPTY_SEAT_PROFILES, 'x', profile('x'));
    const withPending = { ...pending, pending: new Set(['Sam']) };
    expect(missingLabels(['Sam'], withPending)).toEqual([]);
  });

  it('records a resolved profile and clears its pending mark', () => {
    const pending = { ...EMPTY_SEAT_PROFILES, pending: new Set(['Alex']) };
    const next = markResolved(pending, 'Alex', profile('Alex'));
    expect(next.profiles.get('Alex')?.username).toBe('Alex');
    expect(next.pending.has('Alex')).toBe(false);
    expect(pending.pending.has('Alex')).toBe(true);
  });

  it('records a miss once, so guests never refetch', () => {
    const next = markMissed(markMissed(EMPTY_SEAT_PROFILES, 'Guest'), 'Guest');
    expect(next.missed.has('Guest')).toBe(true);
    expect(next.profiles.has('Guest')).toBe(false);
    expect(missingLabels(['Guest'], next)).toEqual([]);
  });
});
