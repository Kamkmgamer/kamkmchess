import { describe, expect, it, vi } from 'vitest';
import { createAccountControls } from './account-controls';
import type { ClerkBrowserPort, ClerkUserPort } from './clerk';

function fixture() {
  let notify = () => {};
  const client: ClerkBrowserPort & { user: ClerkUserPort | null; session: ClerkBrowserPort['session'] } = {
    user: null, session: null,
    signInWithGoogle: vi.fn(async () => {}),
    openUserProfile: vi.fn(),
    signOut: vi.fn(async () => {}),
    subscribe: vi.fn(listener => { notify = listener; return unsubscribe; }),
  };
  const unsubscribe = vi.fn();
  const load = vi.fn(async () => client);
  const controls = createAccountControls('pk_test_example', { sdk: { load }, currentUrl: () => 'https://chess.example/#home' });
  return { client, load, controls, unsubscribe, notify: () => notify() };
}

describe('sidebar account controls', () => {
  it('opens sign-in for guests, reflects sign-in and profile edits, then returns to guest on sign-out', async () => {
    const { client, controls, load, notify, unsubscribe } = fixture();
    const stop = controls.subscribe(vi.fn());
    await vi.waitFor(() => expect(controls.getSnapshot().status).toBe('ready'));
    await controls.openSettings();
    expect(client.signInWithGoogle).toHaveBeenCalledWith('https://chess.example/#home');
    expect(client.openUserProfile).not.toHaveBeenCalled();

    client.user = { id: 'user_a', fullName: 'Alex Player', primaryEmailAddress: { emailAddress: 'alex@example.com' }, imageUrl: 'https://img.clerk.com/avatar.png' };
    client.session = { getToken: async () => 'token' };
    notify();
    expect(controls.getSnapshot().user).toEqual({ name: 'Alex Player', email: 'alex@example.com', imageUrl: 'https://img.clerk.com/avatar.png' });
    await controls.openSettings();
    expect(client.openUserProfile).toHaveBeenCalledOnce();
    expect(client.signInWithGoogle).toHaveBeenCalledOnce();

    client.user = { ...client.user, fullName: 'Updated Player' };
    notify();
    expect(controls.getSnapshot().user?.name).toBe('Updated Player');
    client.user = null;
    client.session = null;
    notify();
    expect(controls.getSnapshot().user).toBeNull();
    expect(load).toHaveBeenCalledOnce();
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not load Clerk when accounts are disabled', async () => {
    const load = vi.fn();
    const controls = createAccountControls(null, { sdk: { load } });
    const stop = controls.subscribe(vi.fn());
    await controls.openSettings();
    expect(controls.getSnapshot().status).toBe('disabled');
    expect(load).not.toHaveBeenCalled();
    stop();
  });

  it('retries a failed load and opens settings using the current session', async () => {
    const { client, controls, load } = fixture();
    load.mockRejectedValueOnce(new Error('offline'));
    const stop = controls.subscribe(vi.fn());
    await vi.waitFor(() => expect(controls.getSnapshot().status).toBe('error'));
    expect(controls.getSnapshot().message).toContain('Try again');
    await controls.openSettings();
    expect(client.signInWithGoogle).toHaveBeenCalledOnce();
    expect(controls.getSnapshot()).toMatchObject({ status: 'ready', busy: false, message: '' });
    stop();
  });

  it('does not attach a listener when unmounted during loading, and supports resubscribing', async () => {
    const { client, controls, load } = fixture();
    let finish!: (client: ClerkBrowserPort) => void;
    load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const stop = controls.subscribe(vi.fn());
    stop();
    finish(client);
    await Promise.resolve();
    expect(client.subscribe).not.toHaveBeenCalled();
    const stopAgain = controls.subscribe(vi.fn());
    await vi.waitFor(() => expect(controls.getSnapshot().status).toBe('ready'));
    expect(client.subscribe).toHaveBeenCalledOnce();
    stopAgain();
  });

  it('keeps both navigation views synchronized and exposes modal failures for retry', async () => {
    const { client, controls, unsubscribe } = fixture();
    const stopDesktop = controls.subscribe(vi.fn());
    const stopMobile = controls.subscribe(vi.fn());
    await vi.waitFor(() => expect(controls.getSnapshot().status).toBe('ready'));
    stopMobile();
    expect(unsubscribe).not.toHaveBeenCalled();
    vi.mocked(client.signInWithGoogle).mockRejectedValueOnce(new Error('unavailable'));
    await controls.openSettings();
    expect(controls.getSnapshot()).toMatchObject({ busy: false, message: "Couldn't open account settings. Try again." });
    await controls.openSettings();
    expect(controls.getSnapshot().message).toBe('');
    stopDesktop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
