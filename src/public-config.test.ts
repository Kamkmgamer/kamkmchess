import { describe, expect, it } from 'vitest';
import { readPublicConfig } from './public-config';

describe('deliberately public configuration', () => {
  it('discards private and malformed values before build serialization', () => {
    const config = readPublicConfig({ accountsEnabled: true, clerkPublishableKey: 'sk_private_fixture', apiBaseUrl: 'https://user:password@example.test', DATABASE_URL: 'private-database' });
    expect(config).toEqual({ accountsEnabled: false, clerkPublishableKey: null, apiBaseUrl: null, testSession: false });
    expect(JSON.stringify(config)).not.toContain('private');
  });

  it('requires an explicit boolean enablement and a secure origin', () => {
    expect(readPublicConfig({ accountsEnabled: 'true', clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'https://chess.example/v1' }).accountsEnabled).toBe(false);
    expect(readPublicConfig({ accountsEnabled: true, clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'http://remote.example' }).accountsEnabled).toBe(false);
    expect(readPublicConfig({ accountsEnabled: true, clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'https://chess.example' })).toEqual({ accountsEnabled: true, clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'https://chess.example', testSession: false });
    expect(readPublicConfig({ accountsEnabled: true, clerkPublishableKey: 'pk_test_fixture', apiBaseUrl: 'http://127.0.0.1:8080' }).accountsEnabled).toBe(true);
  });

  it('opens the account surface of a fixture build without a hosted identity provider', () => {
    const fixture = readPublicConfig({ accountsEnabled: true, clerkPublishableKey: null, apiBaseUrl: 'http://127.0.0.1:57108', testSession: true });
    expect(fixture.accountsEnabled).toBe(true);
    expect(fixture.testSession).toBe(true);
    expect(fixture.clerkPublishableKey).toBeNull();
  });

  it('never opens the account surface of a fixture build without the service origin', () => {
    expect(readPublicConfig({ accountsEnabled: true, clerkPublishableKey: null, apiBaseUrl: null, testSession: true }).accountsEnabled).toBe(false);
  });

  it('keeps the fixture session away from a hosted service', () => {
    const hosted = readPublicConfig({ accountsEnabled: true, clerkPublishableKey: null, apiBaseUrl: 'https://chess.example', testSession: true });
    expect(hosted.testSession).toBe(false);
    expect(hosted.accountsEnabled).toBe(false);
  });
});
