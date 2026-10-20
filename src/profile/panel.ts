/**
 * Profile panel state (KHA-72).
 *
 * The panel is a small, pure state machine. It owns the drafts, the busy
 * state, and the one status line the interface shows, and it never touches
 * the DOM. The React component renders the state and forwards intent, so the
 * behaviour can be exercised without a browser.
 *
 * The status line is the whole feedback surface, so every outcome has one
 * short sentence: what happened, or what to do next.
 */
import type { ProfileClient, GuestSeatBinding } from './client';
import { isAcceptableAvatar, isAcceptableUsername } from './contracts';
import type { OwnProfile } from './contracts';

export type ProfilePanelStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'linking' | 'error';

export interface ProfilePanelState {
  readonly status: ProfilePanelStatus;
  /** The loaded profile, or null before the first load. */
  readonly profile: OwnProfile | null;
  /** The public name the owner is editing. */
  readonly usernameDraft: string;
  /** The avatar the owner is choosing. An empty value is the generated one. */
  readonly avatarDraft: string;
  /** The one status line. It is empty when there is nothing to say. */
  readonly message: string;
  /** The guest seat this browser controls, when there is one. */
  readonly guestSeat: GuestSeatBinding | null;
}

export interface ProfilePanelOptions {
  readonly client: ProfileClient;
  /** The guest seat this browser controls, when there is one. */
  readonly guestSeat?: GuestSeatBinding | null;
}

export interface ProfilePanel {
  getSnapshot(): ProfilePanelState;
  subscribe(listener: () => void): () => void;
  /** Loads the signed-in account's profile. */
  load(): Promise<void>;
  setUsernameDraft(value: string): void;
  setAvatarDraft(value: string): void;
  /** Saves the chosen name and avatar. */
  save(): Promise<void>;
  /** Links the guest seat this browser controls to the account. */
  linkGuestSeat(): Promise<void>;
  dispose(): void;
}

export function createProfilePanel(options: ProfilePanelOptions): ProfilePanel {
  const listeners = new Set<() => void>();
  let disposed = false;
  let state: ProfilePanelState = {
    status: 'idle',
    profile: null,
    usernameDraft: '',
    avatarDraft: '',
    message: '',
    guestSeat: options.guestSeat ?? null,
  };

  function publish(next: Partial<ProfilePanelState>): void {
    if (disposed) return;
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  }

  async function load(): Promise<void> {
    if (disposed) return;
    publish({ status: 'loading', message: '' });
    try {
      const profile = await options.client.readOwnProfile();
      if (disposed) return;
      publish({
        status: 'ready',
        profile,
        usernameDraft: profile.username ?? '',
        avatarDraft: profile.avatar.kind === 'chosen' ? profile.avatar.value : '',
        message: '',
      });
    } catch (error) {
      if (disposed) return;
      publish({ status: 'error', message: messageFor(error, 'Could not load your profile. Retry.') });
    }
  }

  async function save(): Promise<void> {
    if (disposed) return;
    const username = state.usernameDraft.trim();
    if (username.length > 0 && !isAcceptableUsername(username)) {
      publish({ status: 'ready', message: 'Use 3 to 24 letters, digits, dashes.' });
      return;
    }
    if (!isAcceptableAvatar(state.avatarDraft)) {
      publish({ status: 'ready', message: 'Choose an avatar from the list.' });
      return;
    }
    publish({ status: 'saving', message: 'Saving…' });
    try {
      const profile = await options.client.updateOwnProfile({
        username: username.length > 0 ? username : null,
        avatar: state.avatarDraft,
      });
      if (disposed) return;
      publish({
        status: 'ready',
        profile: state.profile ? { ...state.profile, ...profile } : null,
        usernameDraft: profile.username ?? '',
        avatarDraft: profile.avatar.kind === 'chosen' ? profile.avatar.value : '',
        message: 'Profile saved.',
      });
    } catch (error) {
      if (disposed) return;
      publish({ status: 'ready', message: messageFor(error, 'Could not save your profile. Retry.') });
    }
  }

  async function linkGuestSeat(): Promise<void> {
    if (disposed) return;
    const seat = state.guestSeat;
    if (!seat) {
      publish({ status: state.status, message: 'No guest seat is open in this browser.' });
      return;
    }
    publish({ status: 'linking', message: 'Linking guest seat…' });
    try {
      await options.client.linkGuestSeat(seat);
      if (disposed) return;
      const profile = await options.client.readOwnProfile();
      if (disposed) return;
      publish({ status: 'ready', profile, message: 'Guest seat linked to your account.' });
    } catch (error) {
      if (disposed) return;
      publish({ status: 'ready', message: messageFor(error, 'Could not link the guest seat. Retry.') });
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    setUsernameDraft(value) {
      publish({ usernameDraft: value, message: '' });
    },
    setAvatarDraft(value) {
      publish({ avatarDraft: value, message: '' });
    },
    save,
    linkGuestSeat,
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

/**
 * Turns a failed request into one short sentence.
 *
 * The message names the problem and the recovery. It never carries a status
 * code, a URL, or a service detail.
 */
function messageFor(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const detail = error.message;
    if (/taken/i.test(detail)) return 'That name is already taken.';
    if (/not allowed/i.test(detail)) return 'Use 3 to 24 letters, digits, dashes.';
    if (/already linked/i.test(detail)) return 'That guest seat is already linked.';
    if (/no longer yours/i.test(detail)) return 'That guest seat is no longer yours.';
    if (/sign in/i.test(detail)) return 'Sign in to edit your profile.';
    if (/unavailable|invalid response/i.test(detail)) return fallback;
  }
  return fallback;
}
