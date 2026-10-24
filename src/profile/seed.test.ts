import { describe, expect, it, vi } from 'vitest';
import { accountNameCandidates, seedDefaultPublicName } from './seed';
import type { ProfileClient } from './client';
import type { OwnProfile, PublicProfile } from './contracts';

const namedProfile: PublicProfile = {
  schemaVersion: 1,
  profileId: 'kp_alphaalphaalpha',
  username: 'Alice',
  avatar: { kind: 'chosen', value: 'harbor' },
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:05:00Z',
};

const unnamedProfile: OwnProfile = {
  ...namedProfile,
  username: null,
  avatar: { kind: 'generated', value: 'kp_alphaalphaalpha' },
  guestLinks: [],
};

function clientStub(overrides: { readOwnProfile?: ProfileClient['readOwnProfile']; seedOwnProfileName?: ProfileClient['seedOwnProfileName'] } = {}): ProfileClient {
  return {
    readOwnProfile: overrides.readOwnProfile ?? vi.fn(async () => unnamedProfile),
    seedOwnProfileName: overrides.seedOwnProfileName ?? vi.fn(async () => namedProfile),
  } as unknown as ProfileClient;
}

describe('account name candidates', () => {
  it('orders the account fields as the account presents them', () => {
    const candidates = accountNameCandidates({
      username: 'kamkmgamer',
      fullName: 'Khalil Mageed',
      primaryEmailAddress: { emailAddress: 'khalil.mageed@example.com' },
    });
    expect(candidates).toEqual(['kamkmgamer', 'Khalil Mageed', 'khalil.mageed']);
  });

  it('skips absent fields and blank values', () => {
    expect(accountNameCandidates({ username: '   ', fullName: null, primaryEmailAddress: null })).toEqual([]);
    expect(accountNameCandidates({})).toEqual([]);
  });
});

describe('default public-name seeding', () => {
  it('does nothing when the profile already has a name', async () => {
    const seedOwnProfileName = vi.fn(async () => namedProfile);
    const client = clientStub({ readOwnProfile: async () => ({ ...unnamedProfile, username: 'Alice' }), seedOwnProfileName });

    await expect(seedDefaultPublicName(client, { username: 'kamkmgamer' })).resolves.toBeNull();
    expect(seedOwnProfileName).not.toHaveBeenCalled();
  });

  it('proposes the account fields when the profile has no name', async () => {
    const seeded: PublicProfile = { ...namedProfile, username: 'kamkmgamer' };
    const seedOwnProfileName = vi.fn(async () => seeded);
    const client = clientStub({ seedOwnProfileName });

    await expect(seedDefaultPublicName(client, { username: 'kamkmgamer', fullName: 'Khalil Mageed' })).resolves.toBe(seeded);
    expect(seedOwnProfileName).toHaveBeenCalledWith(['kamkmgamer', 'Khalil Mageed']);
  });

  it('proposes nothing when the account published no usable text', async () => {
    const seedOwnProfileName = vi.fn(async () => namedProfile);
    const client = clientStub({ seedOwnProfileName });

    await expect(seedDefaultPublicName(client, {})).resolves.toBeNull();
    expect(seedOwnProfileName).not.toHaveBeenCalled();
  });

  it('answers null when the seed changed nothing', async () => {
    const seedOwnProfileName = vi.fn(async () => unnamedProfile);
    const client = clientStub({ seedOwnProfileName });

    await expect(seedDefaultPublicName(client, { username: 'kamkmgamer' })).resolves.toBeNull();
  });
});
