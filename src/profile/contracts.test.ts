import { describe, expect, it } from 'vitest';
import {
  PROFILE_AVATAR_CHOICES,
  ProfileContractError,
  createProfileUpdateBody,
  isAcceptableAvatar,
  isAcceptableUsername,
  parseGuestLink,
  parseGuestOwnershipProof,
  parseOwnProfile,
  parsePublicProfile,
} from './contracts';

const publicProfile = {
  schemaVersion: 1,
  profileId: 'kp_alphaalphaalpha',
  username: 'Alice',
  avatar: { kind: 'chosen', value: 'harbor' },
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:05:00Z',
};

describe('public profile contracts', () => {
  it('reads the allowlisted public payload', () => {
    const profile = parsePublicProfile(publicProfile);
    expect(profile.profileId).toBe('kp_alphaalphaalpha');
    expect(profile.username).toBe('Alice');
    expect(profile.avatar).toEqual({ kind: 'chosen', value: 'harbor' });
  });

  it('refuses a payload that carries a private identity', () => {
    for (const extra of [{ accountId: 'user_a' }, { email: 'a@example.com' }, { legalName: 'A Person' }, { sessionId: 'sess_1' }]) {
      expect(() => parsePublicProfile({ ...publicProfile, ...extra })).toThrow(ProfileContractError);
    }
  });

  it('refuses a payload that is missing a field', () => {
    const { username, ...withoutUsername } = publicProfile;
    expect(username).toBe('Alice');
    expect(() => parsePublicProfile(withoutUsername)).toThrow(/missing field username/);
  });

  it('refuses an unsupported schema version', () => {
    expect(() => parsePublicProfile({ ...publicProfile, schemaVersion: 2 })).toThrow(/unsupported schema version/);
  });

  it('refuses a name or an avatar outside the contract', () => {
    expect(() => parsePublicProfile({ ...publicProfile, username: 'a b' })).toThrow(/expected a public name/);
    expect(() => parsePublicProfile({ ...publicProfile, username: 'guest' })).toThrow(/expected a public name/);
    expect(() => parsePublicProfile({ ...publicProfile, avatar: { kind: 'chosen', value: 'https://x' } })).toThrow(/catalog/);
    expect(() => parsePublicProfile({ ...publicProfile, avatar: { kind: 'other', value: 'harbor' } })).toThrow(/expected a generated or chosen avatar/);
  });

  it('reads the own profile with its linked guest seats', () => {
    const own = parseOwnProfile({
      ...publicProfile,
      guestLinks: [{
        schemaVersion: 1,
        linkId: 'kl_linklinklink',
        profileId: 'kp_alphaalphaalpha',
        matchId: 'match_alpha',
        seat: 'white',
        linkedAt: '2026-10-20T10:10:00Z',
      }],
    });
    expect(own.guestLinks).toHaveLength(1);
    expect(own.guestLinks[0]?.seat).toBe('white');
  });

  it('refuses a guest seat that is not a seat', () => {
    expect(() => parseGuestLink({
      schemaVersion: 1,
      linkId: 'kl_linklinklink',
      profileId: 'kp_alphaalphaalpha',
      matchId: 'match_alpha',
      seat: 'green',
      linkedAt: '2026-10-20T10:10:00Z',
    })).toThrow(/expected white or black/);
  });

  it('reads a guest ownership proof', () => {
    const proof = parseGuestOwnershipProof({
      schemaVersion: 1,
      proofId: 'kgp_proofproofproof',
      secret: 'kgp1_secretsecretsecret',
      matchId: 'match_alpha',
      seat: 'white',
      expiresAt: '2026-10-20T10:30:00Z',
    });
    expect(proof.secret).toBe('kgp1_secretsecretsecret');
    expect(proof.matchId).toBe('match_alpha');
  });

  it('builds an update body that never names an account or a profile', () => {
    expect(createProfileUpdateBody({ username: 'Alice' })).toEqual({ username: 'Alice' });
    expect(createProfileUpdateBody({ username: null, avatar: 'tide' })).toEqual({ username: null, avatar: 'tide' });
    expect(createProfileUpdateBody({})).toEqual({});
  });

  it('accepts only the shapes the service accepts', () => {
    expect(isAcceptableUsername('Alice')).toBe(true);
    expect(isAcceptableUsername('a_b-1')).toBe(true);
    expect(isAcceptableUsername('ab')).toBe(false);
    expect(isAcceptableUsername('a b')).toBe(false);
    expect(isAcceptableUsername('a@example.com')).toBe(false);
    expect(isAcceptableUsername('-alice')).toBe(false);
    expect(isAcceptableUsername('alice-')).toBe(false);
    expect(isAcceptableAvatar('harbor')).toBe(true);
    expect(isAcceptableAvatar('')).toBe(true);
    expect(isAcceptableAvatar('Harbor')).toBe(false);
    expect(isAcceptableAvatar('https://tracker.example/pixel.png')).toBe(false);
    expect(PROFILE_AVATAR_CHOICES).toHaveLength(8);
  });
});
