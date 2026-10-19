import { describe, expect, it, vi } from 'vitest';
import { officialClerkSdk } from './clerk';

const sdk = vi.hoisted(() => ({
  load: vi.fn(async () => {}),
  openUserProfile: vi.fn(),
  openSignIn: vi.fn(),
  addListener: vi.fn(() => () => {}),
}));

vi.mock('@clerk/clerk-js', () => ({ Clerk: class {
  user = { id: 'user_a', fullName: 'Alex Player' };
  session = { id: 'session_a', getToken: async () => 'token' };
  load = sdk.load;
  openUserProfile = sdk.openUserProfile;
  openSignIn = sdk.openSignIn;
  addListener = sdk.addListener;
} }));
vi.mock('@clerk/ui', () => ({ ui: {} }));

describe('official Clerk browser adapter', () => {
  it('shares one loaded SDK and exposes its account management modal and profile', async () => {
    const [desktop, mobile] = await Promise.all([officialClerkSdk.load('pk_test_adapter'), officialClerkSdk.load('pk_test_adapter')]);
    expect(desktop).toBe(mobile);
    expect(sdk.load).toHaveBeenCalledOnce();
    expect(desktop.user?.fullName).toBe('Alex Player');
    desktop.openUserProfile?.();
    expect(sdk.openUserProfile).toHaveBeenCalledOnce();
    await desktop.signInWithGoogle('https://chess.example/');
    expect(sdk.openSignIn).toHaveBeenCalledWith({ forceRedirectUrl: 'https://chess.example/' });
  });
});
