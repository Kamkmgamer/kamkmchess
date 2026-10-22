/**
 * The account removal actions of the profile panel (KHA-79).
 *
 * The fixture drives the ordinary account deletion of the profile panel and
 * the rendered panel itself. It reaches a stub service only, and it spends
 * nothing.
 *
 * The rules the fixture proves:
 *
 * - A signed-in account may delete its own online account data, and a guest
 *   may not: a guest owns no account, and the guest keeps the removal of the
 *   seat it owns.
 * - The request leaves the browser only after the owner confirmed it, and the
 *   request that leaves is the ordinary deletion. The explicit removal of the
 *   shared replays is never sent by this flow.
 * - The copy of the account deletion tells the owner what it removes and what
 *   it keeps, so it never reads as the erasure of the shared replays.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnlineAccountDeletionPanel, OnlineWorkspace } from './online-workspace';
import {
  createOnlineAccountDeletion,
  eraseGuestSeatReplays,
  onlineAccountDeletionCopy,
  onlineAccountDeletionLabel,
  onlineAccountDeletionNote,
  onlineAccountDeletionVisible,
  onlineAccountReplayRemovalLabel,
  onlineAccountReplayRemovalVisible,
  onlineGuestReplayRemovalLabel,
  onlineReplayErasureNote,
} from './online-account-removal';
import { createOnlineComposition } from '../online/composition';
import { createGuestCredential } from '../online/auth';
import type { OnlineComposition } from '../online/composition';

/** The answer of the service for the ordinary account deletion. */
const REMOVAL_REPORT = {
  schemaVersion: 1,
  removalId: 'rm_public_1',
  scope: 'account_deletion',
  status: 'applied',
  anonymizedMatches: 2,
  removedMatches: 0,
  verifiedAt: '2026-10-21T10:00:00Z',
  liveDeletedAt: '2026-10-21T10:00:05Z',
  liveDeleteDueAt: '2026-10-22T10:00:00Z',
  recoverySanitizeDueAt: '2026-11-20T10:00:00Z',
};

/** The answer of the service for the removal of the shared replays. */
const REPLAY_REMOVAL_REPORT = {
  ...REMOVAL_REPORT,
  removalId: 'rm_public_2',
  scope: 'explicit_removal',
  anonymizedMatches: 0,
  removedMatches: 3,
};

/** One request the browser sent. */
interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A stub service that records every request of the browser.
 *
 * The service answers the ordinary account deletion, and it refuses every
 * other request.
 */
function accountService(): {
  readonly fetcher: typeof fetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown;
    const headers = (init?.headers ?? {}) as Readonly<Record<string, string>>;
    requests.push({ method, url, body, headers });
    if (url.endsWith('/v1/privacy/account/deletion')) {
      return new Response(JSON.stringify(REMOVAL_REPORT), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/privacy/account/removal')) {
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
function guestComposition(): OnlineComposition {
  return createOnlineComposition({
    baseUrl: 'https://api.example.test',
    features: { friends: true, queue: false },
    fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
  });
}

/**
 * A composition of a guest browser that owns one seat of a match.
 *
 * The guest holds the seat credential, so the guest path can act for the seat
 * of the match.
 */
function guestSeatComposition(fetcher: typeof fetch): OnlineComposition {
  const composition = createOnlineComposition({
    baseUrl: 'https://api.example.test',
    features: { friends: true, queue: false },
    fetch: fetcher,
  });
  composition.registerGuestCredential(createGuestCredential({
    guestId: 'guest-00000001',
    matchId: 'match-00000001',
    seat: 'white',
    token: 'guest-seat-token',
  }));
  return composition;
}

/**
 * The account and the guest see different removals.
 *
 * The account deletion belongs to a signed-in account, and the guest keeps
 * the removal of the replays of its own seat. The explicit removal of the
 * shared replays stays a separate action of the panel.
 */
describe('the removals of the profile panel', () => {
  it('offers the account deletion to a signed-in account only', () => {
    const service = accountService();
    const account = accountComposition(service.fetcher);
    const accountMarkup = renderToStaticMarkup(
      <OnlineWorkspace composition={account} onClose={() => {}} initialTab="profile" />,
    );
    // The account may delete its own account data, and the panel says what
    // the deletion keeps.
    expect(accountMarkup).toContain('Delete online account data');
    expect(accountMarkup).toContain('Shared games stay as Deleted player.');
    // The explicit removal of the shared replays stays a separate action.
    expect(accountMarkup).toContain('Erase every shared replay of this account');
    expect(accountMarkup).toContain('Erase the shared replays of this guest seat');
    account.dispose();

    const guest = guestComposition();
    const guestMarkup = renderToStaticMarkup(
      <OnlineWorkspace composition={guest} onClose={() => {}} initialTab="profile" />,
    );
    // A guest owns no account, so the account deletion is not offered.
    expect(guestMarkup).not.toContain('Delete online account data');
    expect(guestMarkup).not.toContain('Shared games stay as Deleted player.');
    // The guest keeps the removal of the replays of its own seat.
    expect(guestMarkup).toContain('Erase the shared replays of this guest seat');
    guest.dispose();
  });

  it('offers the account deletion only to a signed-in account', () => {
    expect(onlineAccountDeletionVisible(true)).toBe(true);
    expect(onlineAccountDeletionVisible(false)).toBe(false);
  });
});

/**
 * The account-wide removal of the shared replays.
 *
 * The account-wide removal acts for the whole account, so it belongs to a
 * signed-in account. A guest owns no account: the panel offers the guest no
 * account-wide removal, and the guest keeps the removal of the seat it owns
 * on the guest path.
 */
describe('the account-wide removal of the shared replays', () => {
  it('is offered to a signed-in account only', () => {
    const service = accountService();
    const account = accountComposition(service.fetcher);
    const accountMarkup = renderToStaticMarkup(
      <OnlineWorkspace composition={account} onClose={() => {}} initialTab="profile" />,
    );
    // The signed-in account may erase every shared replay of its account.
    expect(accountMarkup).toContain(onlineAccountReplayRemovalLabel());
    // The removal of the seat of this browser stays a separate action.
    expect(accountMarkup).toContain(onlineGuestReplayRemovalLabel());
    account.dispose();

    const guest = guestComposition();
    const guestMarkup = renderToStaticMarkup(
      <OnlineWorkspace composition={guest} onClose={() => {}} initialTab="profile" />,
    );
    // A guest owns no account, so the account-wide removal is not offered.
    expect(guestMarkup).not.toContain(onlineAccountReplayRemovalLabel());
    // The guest keeps the removal of the replays of its own seat.
    expect(guestMarkup).toContain(onlineGuestReplayRemovalLabel());
    guest.dispose();
  });

  it('is visible for a signed-in account only', () => {
    expect(onlineAccountReplayRemovalVisible(true)).toBe(true);
    expect(onlineAccountReplayRemovalVisible(false)).toBe(false);
  });

  it('keeps the removal of the guest seat on the guest path', async () => {
    const requests: RecordedRequest[] = [];
    const composition = guestSeatComposition((async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown,
        headers: (init?.headers ?? {}) as Readonly<Record<string, string>>,
      });
      return new Response(JSON.stringify(REPLAY_REMOVAL_REPORT), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch);

    const report = await eraseGuestSeatReplays(composition.privacy, 'match-00000001', 'white');
    expect(report.scope).toBe('explicit_removal');
    expect(report.removedMatches).toBe(3);
    // The removal of the guest seat reached the guest route, and it proved the
    // ownership of the seat with the guest credential.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.example.test/v1/privacy/guest/removal');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['X-Guest-Seat-Token']).toBe('guest-seat-token');
    // The account-wide removal never left the browser, so a guest never
    // reaches the account route.
    expect(requests.some(entry => entry.url.includes('/v1/privacy/account/'))).toBe(false);
    composition.dispose();
  });

  it('keeps the account-wide removal of a signed-in account on the account path', async () => {
    const service = accountService();
    const composition = accountComposition(service.fetcher);

    const report = await composition.privacy.removeAccount();
    expect(report.scope).toBe('explicit_removal');
    // The account-wide removal reached the account route, and it proved the
    // ownership with the signed-in account credential.
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]?.url).toBe('https://api.example.test/v1/privacy/account/removal');
    expect(service.requests[0]?.method).toBe('POST');
    expect(service.requests[0]?.headers['Authorization']).toBe('Bearer account-token');
    composition.dispose();
  });

  it('refuses the account-wide removal for a guest', () => {
    const composition = guestComposition();
    // A guest owns no account, so the account-wide removal has no credential
    // to act with. The panel keeps that action away from the guest.
    expect(() => composition.privacy.removeAccount()).toThrow(/not signed in/);
    composition.dispose();
  });
});

/**
 * The confirmation of the account deletion.
 *
 * The panel of the profile panel asks before it sends anything, and the copy
 * of the question names what the deletion removes and what it keeps.
 */
describe('the confirmation of the account deletion', () => {
  it('asks before it deletes and names what the deletion keeps', () => {
    const markup = renderToStaticMarkup(
      <OnlineAccountDeletionPanel busy={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    // The confirmation is a named group, so a screen reader reads what it
    // asks for.
    expect(markup).toContain('aria-label="Confirm account deletion"');
    // The question names the effect of the deletion and what it keeps.
    expect(markup).toContain('Delete your online account data?');
    expect(markup).toContain('Shared games stay as Deleted player.');
    // The question never describes the erasure of the shared replays.
    expect(markup).not.toContain('replay');
    // The panel offers the confirmation and the way back.
    expect(markup).toContain('Delete the account data');
    expect(markup).toContain('Keep the account data');
  });

  it('sends no confirmation of its own from the panel of the profile panel', () => {
    const service = accountService();
    const account = accountComposition(service.fetcher);
    const markup = renderToStaticMarkup(
      <OnlineWorkspace composition={account} onClose={() => {}} initialTab="profile" />,
    );
    // The panel opens the question first, so the confirmation of the deletion
    // is not part of the panel before the owner asked for it.
    expect(markup).toContain('Delete online account data');
    expect(markup).not.toContain('Delete the account data');
    expect(markup).not.toContain('Confirm account deletion');
    account.dispose();
  });
});

/**
 * The request of the account deletion.
 *
 * The request leaves the browser only from the confirmed step, and the request
 * that leaves is the ordinary deletion of the account data.
 */
describe('the request of the account deletion', () => {
  it('sends the ordinary deletion only after the owner confirmed it', async () => {
    const service = accountService();
    const composition = accountComposition(service.fetcher);
    const deletion = createOnlineAccountDeletion({ privacy: composition.privacy });

    // Opening the confirmation never reaches the service.
    deletion.open();
    expect(deletion.step).toBe('asking');
    expect(service.requests).toHaveLength(0);

    // An abandoned confirmation never reaches the service either.
    deletion.cancel();
    expect(deletion.step).toBe('idle');
    expect(service.requests).toHaveLength(0);

    // A flow that was never confirmed refuses to send.
    await expect(deletion.confirm()).rejects.toThrow(/not confirmed/);
    expect(service.requests).toHaveLength(0);

    // The confirmed step sends the ordinary deletion of the account data.
    deletion.open();
    const report = await deletion.confirm();
    expect(report.scope).toBe('account_deletion');
    expect(report.anonymizedMatches).toBe(2);
    expect(service.requests).toHaveLength(1);
    const request = service.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.example.test/v1/privacy/account/deletion');
    expect(request.body).toEqual({ confirm: 'delete-account' });

    // The explicit removal of the shared replays never left the browser.
    expect(service.requests.some(entry => entry.url.includes('/v1/privacy/account/removal'))).toBe(false);
    composition.dispose();
  });

  it('keeps the confirmation open when the service refuses the deletion', async () => {
    const requests: string[] = [];
    const composition = createOnlineComposition({
      baseUrl: 'https://api.example.test',
      features: { friends: true, queue: true },
      accountSession: {
        identity: { accountId: 'account-00000001', token: async () => 'account-token' },
        subscribe: () => () => undefined,
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    const deletion = createOnlineAccountDeletion({ privacy: composition.privacy });
    deletion.open();
    await expect(deletion.confirm()).rejects.toThrow(/answered 403/);
    // The panel asks again, so the owner may try again without opening it
    // again.
    expect(deletion.step).toBe('asking');
    expect(requests).toHaveLength(1);
    composition.dispose();
  });
});

/**
 * The copy of the two removals.
 *
 * The copy of the account deletion tells the owner that the shared games stay,
 * and the copy of the explicit removal tells the owner that the shared replays
 * go. The owner tells the two actions apart before it acts.
 */
describe('the copy of the two removals', () => {
  it('separates the account deletion from the erasure of the shared replays', () => {
    expect(onlineAccountDeletionNote()).toContain('Shared games stay as Deleted player.');
    expect(onlineAccountDeletionNote()).not.toContain('replay');
    expect(onlineAccountDeletionCopy()).toContain('Shared games stay as Deleted player.');
    expect(onlineAccountDeletionCopy()).not.toContain('replay');
    expect(onlineReplayErasureNote()).toContain('shared replays');
  });

  it('never offers the deletion of the sign-in identity', () => {
    const copy = `${onlineAccountDeletionLabel()} ${onlineAccountDeletionCopy()}`.toLowerCase();
    // The flow removes the data of the online account. It never claims that it
    // removes the sign-in of the owner.
    expect(copy).not.toContain('sign-in');
    expect(copy).not.toContain('sign in');
    expect(copy).not.toContain('clerk');
  });
});
