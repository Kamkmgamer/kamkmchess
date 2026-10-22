/**
 * The explicit erasure of the shared replays (KHA-79).
 *
 * The fixture drives the two explicit removals of the profile panel, the
 * rendered panel itself and the visible copy of the panel. It reaches a stub
 * service only, and it spends nothing.
 *
 * The rules the fixture proves:
 *
 * - The visible copy of the profile panel stays inside the twenty-word
 *   convention of the product, and the regression measures the words of the
 *   default state instead of claiming the convention.
 * - The erasure of the shared replays asks before it acts. The question names
 *   the consequence for both participants, and the owner may keep the shared
 *   replays.
 * - The request leaves the browser only from the confirmed step, and the
 *   request that leaves keeps its scope: the account-wide erasure reaches the
 *   account route with the signed-in credential, and the erasure of the guest
 *   seat stays on the guest path with the seat credential.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnlineProfileRemovals, OnlineReplayErasurePanel, OnlineWorkspace } from './online-workspace';
import {
  createOnlineAccountDeletion,
  createOnlineReplayErasure,
  onlineAccountDeletionLabel,
  onlineAccountReplayRemovalLabel,
  onlineGuestReplayRemovalLabel,
  onlineReplayErasureCancelLabel,
  onlineReplayErasureConfirmGroup,
  onlineReplayErasureConfirmLabel,
  onlineReplayErasureConsequence,
  onlineReplayErasureCopy,
} from './online-account-removal';
import { createOnlineComposition } from '../online/composition';
import { createGuestCredential } from '../online/auth';
import type { OnlineComposition } from '../online/composition';
import type { OnlineReplayErasure } from './online-account-removal';

/** The answer of the service for the removal of the shared replays. */
const REPLAY_REMOVAL_REPORT = {
  schemaVersion: 1,
  removalId: 'rm_public_2',
  scope: 'explicit_removal',
  status: 'applied',
  anonymizedMatches: 0,
  removedMatches: 3,
  verifiedAt: '2026-10-21T10:00:00Z',
  liveDeletedAt: '2026-10-21T10:00:05Z',
  liveDeleteDueAt: '2026-10-22T10:00:00Z',
  recoverySanitizeDueAt: '2026-11-20T10:00:00Z',
};

/** One request the browser sent. */
interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A stub service that records every request of the browser.
 *
 * The service answers the explicit removal of the shared replays, and it
 * refuses every other request.
 */
function replayRemovalService(): {
  readonly fetcher: typeof fetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers ?? {}) as Readonly<Record<string, string>>,
    });
    if (url.endsWith('/v1/privacy/account/removal') || url.endsWith('/v1/privacy/guest/removal')) {
      return new Response(JSON.stringify(REPLAY_REMOVAL_REPORT), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetcher: fetcher as unknown as typeof fetch, requests };
}

/** A composition of a signed-in account. */
function accountComposition(fetcher: typeof fetch): OnlineComposition {
  return createOnlineComposition({
    baseUrl: 'https://api.example.test',
    features: { friends: true, queue: true },
    accountSession: {
      identity: { accountId: 'account-00000001', token: async () => 'account-token' },
      subscribe: () => () => undefined,
    },
    fetch: fetcher,
  });
}

/** A composition of a guest browser. */
function guestComposition(fetcher: typeof fetch): OnlineComposition {
  return createOnlineComposition({
    baseUrl: 'https://api.example.test',
    features: { friends: true, queue: false },
    fetch: fetcher,
  });
}

/**
 * A composition of a guest browser that owns one seat of a match.
 *
 * The guest holds the seat credential, so the guest path can act for the
 * seat of the match.
 */
function guestSeatComposition(fetcher: typeof fetch): OnlineComposition {
  const composition = guestComposition(fetcher);
  composition.registerGuestCredential(createGuestCredential({
    guestId: 'guest-00000001',
    matchId: 'match-00000001',
    seat: 'white',
    token: 'guest-seat-token',
  }));
  return composition;
}

/**
 * The markup of one part of the rendered screen.
 *
 * The screen renders the parts of the online screen next to each other, so
 * the count of the words of one part needs the markup of that part alone.
 * The part ends where its own closing tag closes it, and the parts nested
 * inside it stay inside it.
 */
function partMarkup(markup: string, label: string): string {
  const open = [...markup.matchAll(/<section\b[^>]*>/g)].find(match => match[0].includes(`aria-label="${label}"`));
  if (!open) throw new Error(`the screen has no part named ${label}`);
  const openAt = open.index;
  const tags = /<(\/?)section\b[^>]*>/g;
  tags.lastIndex = openAt;
  let depth = 0;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(markup)) !== null) {
    depth += tag[1] === '/' ? -1 : 1;
    if (depth === 0) return markup.slice(openAt, tag.index);
  }
  throw new Error(`the part named ${label} is never closed`);
}

/**
 * The visible words of one part of the rendered screen.
 *
 * The count follows the convention of the product:
 *
 * - The visible copy counts: the text of the screen and the placeholder of a
 *   field, because the placeholder is what the owner reads in the field.
 * - The names that only a screen reader or a hover label carries do not
 *   count: the accessible name of an icon action is not visible copy.
 * - The game data does not count: the value of a field is the data of a
 *   match, and no identifier of a match is a word of the screen.
 */
function visibleWords(markup: string, label: string): string[] {
  const part = partMarkup(markup, label);
  const placeholders = [...part.matchAll(/placeholder="([^"]*)"/g)].map(match => match[1] ?? '');
  const text = part.replace(/<[^>]*>/g, ' ');
  return `${text} ${placeholders.join(' ')}`.match(/[a-z0-9]+/gi) ?? [];
}

/**
 * The visible copy of the profile panel (UX-03).
 *
 * The profile panel carries the removals of the owner, and the convention of
 * the screen keeps its visible copy inside twenty words. The regression counts
 * the words of the default state of the panel, so a later copy change cannot
 * claim the convention without measuring it.
 */
describe('the visible copy of the profile panel', () => {
  it('keeps the visible words of the default profile state inside twenty words', () => {
    const service = replayRemovalService();
    const account = accountComposition(service.fetcher);
    const markup = renderToStaticMarkup(
      <OnlineWorkspace composition={account} onClose={() => {}} initialTab="profile" />,
    );
    const words = visibleWords(markup, 'Profile and history');
    // The count of the words of the panel is the measurement of the
    // convention, and the panel of the default state stays inside it. The
    // panel counted about fifty words before this change: the three removals
    // and their two notes carried their full visible labels.
    expect(words.length).toBeLessThanOrEqual(20);
    // The measurement reads the visible copy of the panel, and it reads no
    // name that only an icon action carries.
    expect(words).toContain('Deleted');
    expect(words).toContain('replays');
    expect(words).not.toContain('Erase');
    expect(words).not.toContain('Delete');
    account.dispose();
  });

  it('keeps the visible words of the profile state of a guest inside twenty words', () => {
    const service = replayRemovalService();
    const guest = guestComposition(service.fetcher);
    const markup = renderToStaticMarkup(
      <OnlineWorkspace composition={guest} onClose={() => {}} initialTab="profile" />,
    );
    const words = visibleWords(markup, 'Profile and history');
    // A guest owns no account, so the panel of a guest carries even less
    // copy, and it stays inside the convention.
    expect(words.length).toBeLessThanOrEqual(20);
    expect(words).not.toContain('Deleted');
    guest.dispose();
  });

  it('keeps the names of the removals with their accessible names', () => {
    const service = replayRemovalService();
    const account = accountComposition(service.fetcher);
    const markup = renderToStaticMarkup(
      <OnlineWorkspace composition={account} onClose={() => {}} initialTab="profile" />,
    );
    // The removals are icon actions, and every one of them keeps its own
    // accessible name and its own hover label.
    expect(markup).toMatch(/<button[^>]*aria-label="Delete online account data"[^>]*title="Delete online account data"/);
    expect(markup).toMatch(/<button[^>]*aria-label="Erase every shared replay of this account"[^>]*title="Erase every shared replay of this account"/);
    expect(markup).toMatch(/<button[^>]*aria-label="Erase the shared replays of this guest seat"[^>]*title="Erase the shared replays of this guest seat"/);
    account.dispose();
  });
});

/**
 * The confirmation of the explicit erasure of the shared replays.
 *
 * The erasure is irreversible and it removes the shared replays of both
 * participants, so the panel asks before it sends anything and names the
 * consequence of the erasure.
 */
describe('the confirmation of the erasure of the shared replays', () => {
  it('asks before it erases and names the consequence for both participants', () => {
    const markup = renderToStaticMarkup(
      <OnlineReplayErasurePanel scope="account" busy={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    // The confirmation is a named group, so a screen reader reads what it
    // asks for.
    expect(markup).toContain(`aria-label="${onlineReplayErasureConfirmGroup()}"`);
    // The question names the consequence of the erasure for both players.
    expect(markup).toContain(onlineReplayErasureConsequence());
    expect(markup).toContain('Both players lose the shared replays.');
    expect(markup).toContain('Only anonymous results stay.');
    // The panel offers the confirmation and the way back.
    expect(markup).toContain(onlineReplayErasureConfirmLabel());
    expect(markup).toContain(onlineReplayErasureCancelLabel());
  });

  it('names the scope of the erasure in the question', () => {
    // The account-wide erasure never reads as the erasure of the seat of
    // this browser, and the erasure of the guest seat never reads as the
    // erasure of the whole account.
    expect(onlineReplayErasureCopy('account')).toContain('Erase every shared replay of this account?');
    expect(onlineReplayErasureCopy('account')).not.toContain('guest seat');
    expect(onlineReplayErasureCopy('guest')).toContain('Erase the shared replays of this guest seat?');
    expect(onlineReplayErasureCopy('guest')).not.toContain('every shared replay of this account');
  });
});

/**
 * The removals of the profile panel.
 *
 * The panel asks before it acts, so the confirmation of an erasure is part of
 * the panel only after the owner opened it.
 */
describe('the removals of the profile panel', () => {
  it('shows no confirmation before the owner opened one', () => {
    const service = replayRemovalService();
    const account = accountComposition(service.fetcher);
    const deletion = createOnlineAccountDeletion({ privacy: account.privacy });
    const accountErasure = createOnlineReplayErasure({ scope: 'account', privacy: account.privacy });
    const guestErasure = createOnlineReplayErasure({
      scope: 'guest',
      privacy: account.privacy,
    });
    const markup = renderToStaticMarkup(
      <OnlineProfileRemovals
        busy={false}
        accountSignedIn
        guestSeatAvailable
        accountDeletion={deletion}
        accountErasure={accountErasure}
        guestErasure={guestErasure}
        onDeleteAccount={() => {}}
        onEraseAccount={() => {}}
        onEraseGuest={() => {}}
      />,
    );
    // The panel opens the question first, so no confirmation of an erasure is
    // part of the panel before the owner asked for it.
    expect(markup).not.toContain(onlineReplayErasureConfirmGroup());
    expect(markup).not.toContain(`>${onlineReplayErasureConfirmLabel()}</button>`);
    expect(markup).not.toContain(`>${onlineReplayErasureCancelLabel()}</button>`);
    // The three removals keep their own names.
    expect(markup).toContain(`aria-label="${onlineAccountDeletionLabel()}"`);
    expect(markup).toContain(`aria-label="${onlineAccountReplayRemovalLabel()}"`);
    expect(markup).toContain(`aria-label="${onlineGuestReplayRemovalLabel()}"`);
    account.dispose();
  });

  it('shows the question of the account-wide erasure after the owner opened it', () => {
    const service = replayRemovalService();
    const account = accountComposition(service.fetcher);
    const deletion = createOnlineAccountDeletion({ privacy: account.privacy });
    const accountErasure = createOnlineReplayErasure({ scope: 'account', privacy: account.privacy });
    const guestErasure = createOnlineReplayErasure({ scope: 'guest', privacy: account.privacy });
    // The owner opened the question of the account-wide erasure.
    accountErasure.open();
    expect(accountErasure.step).toBe('asking');
    const markup = renderToStaticMarkup(
      <OnlineProfileRemovals
        busy={false}
        accountSignedIn
        guestSeatAvailable
        accountDeletion={deletion}
        accountErasure={accountErasure}
        guestErasure={guestErasure}
        onDeleteAccount={() => {}}
        onEraseAccount={() => {}}
        onEraseGuest={() => {}}
      />,
    );
    // The question of the erasure names the scope and the consequence, and
    // the way back is next to it.
    expect(markup).toContain(onlineReplayErasureConfirmGroup());
    expect(markup).toContain('Erase every shared replay of this account?');
    expect(markup).toContain(onlineReplayErasureConsequence());
    expect(markup).toContain(onlineReplayErasureCancelLabel());
    // The question of the guest seat stays closed, and the question of the
    // ordinary account deletion stays closed too.
    expect(markup).not.toContain('Erase the shared replays of this guest seat?');
    expect(markup).not.toContain('Confirm account deletion');
    account.dispose();
  });

  it('shows the question of the guest seat after the owner opened it', () => {
    const service = replayRemovalService();
    const account = accountComposition(service.fetcher);
    const deletion = createOnlineAccountDeletion({ privacy: account.privacy });
    const accountErasure = createOnlineReplayErasure({ scope: 'account', privacy: account.privacy });
    const guestErasure = createOnlineReplayErasure({ scope: 'guest', privacy: account.privacy });
    // The owner opened the question of the erasure of the guest seat.
    guestErasure.open();
    expect(guestErasure.step).toBe('asking');
    const markup = renderToStaticMarkup(
      <OnlineProfileRemovals
        busy={false}
        accountSignedIn
        guestSeatAvailable
        accountDeletion={deletion}
        accountErasure={accountErasure}
        guestErasure={guestErasure}
        onDeleteAccount={() => {}}
        onEraseAccount={() => {}}
        onEraseGuest={() => {}}
      />,
    );
    // The question names the seat of this browser, and the question of the
    // whole account stays closed.
    expect(markup).toContain(onlineReplayErasureConfirmGroup());
    expect(markup).toContain('Erase the shared replays of this guest seat?');
    expect(markup).not.toContain('Erase every shared replay of this account?');
    account.dispose();
  });
});

/**
 * The request of the explicit erasure of the shared replays.
 *
 * The request leaves the browser only from the confirmed step, and it keeps
 * the scope of the question the owner confirmed.
 */
describe('the request of the erasure of the shared replays', () => {
  it('sends nothing until the owner confirmed the account-wide erasure', async () => {
    const service = replayRemovalService();
    const composition = accountComposition(service.fetcher);
    const erasure = createOnlineReplayErasure({ scope: 'account', privacy: composition.privacy });

    // Opening the question never reaches the service.
    erasure.open();
    expect(erasure.step).toBe('asking');
    expect(service.requests).toHaveLength(0);

    // An abandoned question never reaches the service either.
    erasure.cancel();
    expect(erasure.step).toBe('idle');
    expect(service.requests).toHaveLength(0);

    // A flow that was never confirmed refuses to send.
    await expect(erasure.confirm()).rejects.toThrow(/not confirmed/);
    expect(service.requests).toHaveLength(0);

    // The confirmed step erases the shared replays of the whole account.
    erasure.open();
    const report = await erasure.confirm();
    expect(report.scope).toBe('explicit_removal');
    expect(report.removedMatches).toBe(3);
    expect(service.requests).toHaveLength(1);
    const request = service.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.example.test/v1/privacy/account/removal');
    expect(request.headers['Authorization']).toBe('Bearer account-token');
    composition.dispose();
  });

  it('sends nothing until the owner confirmed the erasure of the guest seat', async () => {
    const service = replayRemovalService();
    const composition = guestSeatComposition(service.fetcher);
    const erasure = createOnlineReplayErasure({
      scope: 'guest',
      privacy: composition.privacy,
    });

    // Opening the question never reaches the service.
    erasure.open();
    expect(erasure.step).toBe('asking');
    expect(service.requests).toHaveLength(0);

    // An abandoned question never reaches the service either.
    erasure.cancel();
    expect(erasure.step).toBe('idle');
    expect(service.requests).toHaveLength(0);

    // A flow that was never confirmed refuses to send.
    await expect(erasure.confirm({ matchId: 'match-00000001', seat: 'white' })).rejects.toThrow(/not confirmed/);
    expect(service.requests).toHaveLength(0);

    // The confirmed step erases the shared replays of the seat of this
    // browser.
    erasure.open();
    const report = await erasure.confirm({ matchId: 'match-00000001', seat: 'white' });
    expect(report.scope).toBe('explicit_removal');
    expect(service.requests).toHaveLength(1);
    const request = service.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.example.test/v1/privacy/guest/removal');
    expect(request.headers['X-Guest-Seat-Token']).toBe('guest-seat-token');
    // The account-wide erasure never left the browser, so the erasure of a
    // guest seat never reaches the account route.
    expect(service.requests.some(entry => entry.url.includes('/v1/privacy/account/'))).toBe(false);
    composition.dispose();
  });

  it('refuses the erasure of a guest seat without a seat', async () => {
    const service = replayRemovalService();
    const composition = guestSeatComposition(service.fetcher);
    const erasure = createOnlineReplayErasure({
      scope: 'guest',
      privacy: composition.privacy,
    });
    erasure.open();
    await expect(erasure.confirm(null)).rejects.toThrow(/Open a game/);
    // The request never reached the service, and the question stays open, so
    // the owner may close it.
    expect(service.requests).toHaveLength(0);
    expect(erasure.step).toBe('asking');
    composition.dispose();
  });

  it('keeps the ordinary account deletion out of the erasure of the shared replays', async () => {
    const service = replayRemovalService();
    const composition = accountComposition(service.fetcher);
    const erasure: OnlineReplayErasure = createOnlineReplayErasure({
      scope: 'account',
      privacy: composition.privacy,
    });
    erasure.open();
    await erasure.confirm();
    // The erasure of the shared replays never deletes the account data.
    expect(service.requests.some(entry => entry.url.includes('/v1/privacy/account/deletion'))).toBe(false);
    composition.dispose();
  });
});
