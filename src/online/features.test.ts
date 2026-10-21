import { describe, expect, it } from 'vitest';
import {
  ONLINE_FEATURES_DISABLED,
  combineOnlineFeatureFlags,
  isLoopbackOrigin,
  parseOnlineFeatureFlags,
  readLocalOptIn,
} from './features';
import type { PublicConfig } from '../public-config.js';

const deployed: PublicConfig = { accountsEnabled: true, clerkPublishableKey: 'pk_test_x', apiBaseUrl: 'https://api.example.test', testSession: false };
const loopback: PublicConfig = { accountsEnabled: true, clerkPublishableKey: 'pk_test_x', apiBaseUrl: 'http://127.0.0.1:8080', testSession: false };

describe('the feature answer is public and strict', () => {
  it('reads the two independent switches', () => {
    expect(parseOnlineFeatureFlags({ friends: true, queue: false })).toEqual({ friends: true, queue: false });
    expect(parseOnlineFeatureFlags({ friends: false, queue: true })).toEqual({ friends: false, queue: true });
  });

  it('closes a surface for an unknown, missing or malformed answer', () => {
    expect(parseOnlineFeatureFlags({ friends: 'yes', queue: true })).toEqual({ friends: false, queue: true });
    expect(parseOnlineFeatureFlags({ friends: true })).toEqual({ friends: true, queue: false });
    expect(parseOnlineFeatureFlags(null)).toEqual(ONLINE_FEATURES_DISABLED);
    expect(parseOnlineFeatureFlags([{ friends: true }])).toEqual(ONLINE_FEATURES_DISABLED);
  });

  it('ignores an additive field of the service (B-15)', () => {
    expect(parseOnlineFeatureFlags({ friends: true, queue: true, reason: 'rollout' })).toEqual({ friends: true, queue: true });
  });

  it('never opens a surface of a deployed service by itself', () => {
    const service = { friends: false, queue: false };
    const local = { friends: true, queue: true };
    expect(combineOnlineFeatureFlags(service, local, deployed)).toEqual(ONLINE_FEATURES_DISABLED);
    expect(combineOnlineFeatureFlags(service, local, loopback)).toEqual({ friends: true, queue: true });
  });

  it('keeps the service answer of a deployed service', () => {
    const service = { friends: true, queue: false };
    const local = { friends: false, queue: false };
    expect(combineOnlineFeatureFlags(service, local, deployed)).toEqual({ friends: true, queue: false });
  });
});

describe('the local opt-in is a loopback-only test switch', () => {
  it('ignores the opt-in of a deployed service', () => {
    expect(readLocalOptIn('?online=1', deployed)).toEqual(ONLINE_FEATURES_DISABLED);
  });

  it('opens both surfaces of a loopback service', () => {
    expect(readLocalOptIn('?online=1', loopback)).toEqual({ friends: true, queue: true });
  });

  it('opens one named surface of a loopback service', () => {
    expect(readLocalOptIn('?online=queue', loopback)).toEqual({ friends: false, queue: true });
    expect(readLocalOptIn('?online=friends', loopback)).toEqual({ friends: true, queue: false });
  });

  it('ignores the opt-in without a service origin', () => {
    expect(readLocalOptIn('?online=1', { accountsEnabled: false, clerkPublishableKey: null, apiBaseUrl: null, testSession: false })).toEqual(ONLINE_FEATURES_DISABLED);
  });

  it('recognizes the loopback origins', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:5175')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:5175')).toBe(true);
    expect(isLoopbackOrigin('https://api.example.test')).toBe(false);
    expect(isLoopbackOrigin('not a url')).toBe(false);
  });
});
