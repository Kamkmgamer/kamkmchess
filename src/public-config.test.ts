import { describe, expect, it } from 'vitest';
import { readPublicConfig } from './public-config';

describe('deliberately public configuration', () => {
  it('discards private and malformed values before build serialization', () => {
    const config = readPublicConfig({ accountsEnabled: true, clerkPublishableKey: 'sk_private_fixture', apiBaseUrl: 'https://user:password@example.test', DATABASE_URL: 'private-database' });
    expect(config).toEqual({ accountsEnabled: false, clerkPublishableKey: null, apiBaseUrl: null });
    expect(JSON.stringify(config)).not.toContain('private');
  });

  it('requires an explicit boolean enablement and a secure origin', () => {
    expect(readPublicConfig({ accountsEnabled: 'true', clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'https://chess.example/v1' }).accountsEnabled).toBe(false);
    expect(readPublicConfig({ accountsEnabled: true, clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'http://remote.example' }).accountsEnabled).toBe(false);
    expect(readPublicConfig({ accountsEnabled: true, clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'https://chess.example' })).toEqual({ accountsEnabled: true, clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'https://chess.example' });
    expect(readPublicConfig({ accountsEnabled: true, clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'http://127.0.0.1:8080' }).accountsEnabled).toBe(true);
  });
});
