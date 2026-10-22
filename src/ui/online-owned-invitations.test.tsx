/**
 * The recovery of an owned invitation (KHA-75).
 *
 * The product contract says that an invitation lasts twelve hours and that
 * the inviter may cancel it. The inviter therefore has to find its pending
 * invitation again after a reload or a navigation, and it has to be able to
 * cancel it there.
 *
 * The tests of this file reproduce the defect of the screen:
 *
 * - an invitation is created, the browser reloads, and the pending invitation
 *   is still visible and cancellable, and
 * - another identity never sees the invitation and can never cancel it.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnlineWorkspace } from './online-workspace';
import {
  ownedInvitationAcceptable,
  ownedInvitationCancelTarget,
  ownedInvitationCancelable,
  ownedInvitationStateLabel,
} from './online-owned-invitations';
import { createOnlineComposition } from '../online/composition';
import type { OnlineComposition } from '../online/composition';
import type { FriendInvitation } from '../online/friend-routes';

const timeControl = { startingTimeMs: 300_000, incrementMs: 2_000 };

/** A storage of one browser. */
interface Storage {
  readonly data: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
}

/** The state of one invitation of the fake service. */
type ServiceStatus = 'open' | 'consumed' | 'cancelled' | 'expired';

/** One wire of the fake service. */
interface Wire {
  readonly path: string;
  readonly method: string;
  readonly ownerToken: string | null;
  readonly body: string | null;
}

/** The public answer of one invitation. */
function invitationAnswer(invitationId: string, status: ServiceStatus): Record<string, unknown> {
  return {
    schemaVersion: 2,
    invitationId,
    kind: 'link',
    status,
    inviterLabel: 'Guest',
    inviterSeat: 'white',
    inviterControl: { kind: 'human' },
    timeControl,
    startingFen: null,
    expiresAt: '2026-10-22T10:00:00.000Z',
    createdAt: '2026-10-21T10:00:00.000Z',
    consumedAt: null,
    cancelledAt: null,
    matchId: null,
  };
}

/**
 * A fake friend service.
 *
 * The service keeps the owner token of every invitation it created, so a
 * cancellation with the wrong owner token is refused exactly as the real
 * service refuses it.
 */
function createFriendService() {
  const invitations = new Map<string, { status: ServiceStatus; ownerToken: string }>();
  const wires: Wire[] = [];
  let created = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ownerToken = Object.entries(headers)
      .find(([name]) => name.toLowerCase() === 'x-online-owner-token')?.[1] ?? null;
    wires.push({ path, method, ownerToken, body: init?.body === undefined ? null : String(init.body) });
    const answer = (status: number, data: unknown): Response => new Response(
      JSON.stringify(data),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
    if (path.endsWith('/v1/online/invitations') && method === 'POST') {
      created += 1;
      const invitationId = `invitation-0000000${created}`;
      const token = `owner-token-0000000${created}`;
      invitations.set(invitationId, { status: 'open', ownerToken: token });
      return answer(200, {
        schemaVersion: 2,
        invitation: invitationAnswer(invitationId, 'open'),
        ownerToken: token,
      });
    }
    const route = /\/v1\/online\/invitations\/([^/?]+)(?:\/([a-z-]+))?$/.exec(path);
    if (route) {
      const invitationId = decodeURIComponent(route[1] ?? '');
      const action = route[2] ?? null;
      const record = invitations.get(invitationId);
      if (!record) return answer(404, { error: 'not_found' });
      if (action === 'cancel') {
        // The service proves the ownership itself: the owner token of another
        // identity never cancels the invitation.
        if (record.ownerToken !== ownerToken) return answer(404, { error: 'not_found' });
        record.status = 'cancelled';
        return answer(200, invitationAnswer(invitationId, record.status));
      }
      return answer(200, invitationAnswer(invitationId, record.status));
    }
    return answer(404, { error: 'not_found' });
  }) as unknown as typeof fetch;
  return { fetcher, invitations, wires };
}

/** Lets every pending promise settle. */
function settle(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

/** A timer seam that never fires on its own. */function manualTimers(): {
  readonly timers: { setTimer: (callback: () => void, delayMs: number) => unknown; clearTimer: (handle: unknown) => void };
  fire: () => void;
} {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    timers: {
      setTimer(callback) {
        const handle = next;
        next += 1;
        pending.set(handle, callback);
        return handle;
      },
      clearTimer(handle) {
        pending.delete(handle as number);
      },
    },
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

/** A composition of a guest browser with the friend surface open. */
function guestComposition(options: {
  readonly fetcher: typeof fetch;
  readonly storage: Storage;
  readonly timers?: Parameters<typeof createOnlineComposition>[0]['timers'];
}): OnlineComposition {
  return createOnlineComposition({
    baseUrl: 'https://api.example.test',
    features: { friends: true, queue: false },
    fetch: options.fetcher,
    storage: options.storage,
    ...(options.timers ? { timers: options.timers } : {}),
  });
}

/** A composition of a signed-in account. */
function accountComposition(options: {
  readonly fetcher: typeof fetch;
  readonly storage: Storage;
  readonly accountId: string;
}): OnlineComposition {
  return createOnlineComposition({
    baseUrl: 'https://api.example.test',
    features: { friends: true, queue: false },
    fetch: options.fetcher,
    storage: options.storage,
    accountSession: {
      identity: { accountId: options.accountId, token: async () => 'account-token' },
      subscribe: () => () => undefined,
    },
  });
}

/** Creates an invitation the way the screen does. */
async function createInvitation(composition: OnlineComposition): Promise<FriendInvitation> {
  const created = await composition.friends.create({
    seat: 'white',
    timeControl,
    control: { kind: 'human' },
  });
  // The inviter tracks its own invitation, so the seat of the created match
  // stays recoverable.
  composition.trackInvitation(created.invitation.invitationId, created.ownerToken, null);
  composition.publishOwnedInvitation(created.invitation);
  return created.invitation;
}

describe('the state of an owned invitation', () => {
  const open: FriendInvitation = {
    schemaVersion: 2,
    invitationId: 'invitation-00000001',
    kind: 'link',
    status: 'open',
    inviterLabel: 'Guest',
    inviterSeat: 'white',
    inviterControl: { kind: 'human' },
    timeControl,
    startingFen: null,
    expiresAt: '2026-10-22T10:00:00.000Z',
    createdAt: '2026-10-21T10:00:00.000Z',
    consumedAt: null,
    cancelledAt: null,
    matchId: null,
  };

  it('names the state the service published', () => {
    expect(ownedInvitationStateLabel(open)).toBe('Open');
    expect(ownedInvitationStateLabel({ ...open, status: 'cancelled' })).toBe('Cancelled');
    expect(ownedInvitationStateLabel({ ...open, status: 'expired' })).toBe('Expired');
    // A consumed invitation is an accepted one: the invitee used it.
    expect(ownedInvitationStateLabel({ ...open, status: 'consumed' })).toBe('Accepted');
  });

  it('cancels only an open invitation', () => {
    expect(ownedInvitationCancelable(open)).toBe(true);
    expect(ownedInvitationCancelable({ ...open, status: 'cancelled' })).toBe(false);
    expect(ownedInvitationCancelable({ ...open, status: 'expired' })).toBe(false);
    expect(ownedInvitationCancelable({ ...open, status: 'consumed' })).toBe(false);
  });

  it('names the invitation the cancel action reaches', () => {
    const owned = (id: string): FriendInvitation => ({ ...open, invitationId: id });
    const isOwned = (id: string): boolean => id === 'invitation-00000001';
    // The invitation on the screen is preferred.
    expect(ownedInvitationCancelTarget(owned('invitation-00000001'), [], isOwned)).toBe('invitation-00000001');
    // A recovered invitation is the next one.
    expect(ownedInvitationCancelTarget(null, [owned('invitation-00000001')], isOwned)).toBe('invitation-00000001');
    // An invitation of another identity is never named.
    expect(ownedInvitationCancelTarget(owned('invitation-00000002'), [], isOwned)).toBeNull();
    // Nothing to cancel without an open invitation.
    expect(ownedInvitationCancelTarget(null, [], isOwned)).toBeNull();
  });

  it('never accepts an invitation of the own identity', () => {
    const isOwned = (): boolean => true;
    expect(ownedInvitationAcceptable(open, isOwned)).toBe(false);
    // The invitation of another identity is accepted as usual.
    expect(ownedInvitationAcceptable(open, () => false)).toBe(true);
    // A settled invitation is never accepted.
    expect(ownedInvitationAcceptable({ ...open, status: 'cancelled' }, () => false)).toBe(false);
    expect(ownedInvitationAcceptable(null, () => false)).toBe(false);
  });
});

describe('the pending invitation of the owner survives a reload', () => {
  it('shows the invitation again and lets the inviter cancel it', async () => {
    const service = createFriendService();
    const storage = createStorage();
    const clock = manualTimers();
    const first = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    const created = await createInvitation(first);
    first.dispose();

    // The browser reloads: a new composition of the same browser finds the
    // owner token and the list of the invitations on the device.
    const reloaded = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    await reloaded.refreshOwnedInvitations();

    // The pending invitation is published with the state of the service.
    expect(reloaded.ownedInvitations.map(view => view.invitationId)).toEqual([created.invitationId]);
    expect(reloaded.ownedInvitations[0]?.status).toBe('open');
    expect(reloaded.ownsInvitation(created.invitationId)).toBe(true);

    const markup = renderToStaticMarkup(<OnlineWorkspace composition={reloaded} onClose={() => {}} initialTab="new" />);
    // The invitation of the owner is listed, and the list names it.
    expect(markup).toContain('aria-label="Your invitations"');
    expect(markup).toContain('aria-label="Cancel invitation invitation-00000001"');
    // The invitation is open, so the cancel control of the owner is offered.
    expect(markup).not.toMatch(/<button[^>]*aria-label="Cancel invitation invitation-00000001"[^>]*disabled=""/);
    // The cancel action of the setup is offered too, because the owner has an
    // open invitation.
    expect(markup).not.toMatch(/<button[^>]*aria-label="Cancel invitation"[^>]*disabled=""/);
    // The owner token never reaches the screen.
    expect(markup).not.toContain('owner-token');
    reloaded.dispose();
  });

  it('cancels the recovered invitation and settles its record', async () => {
    const service = createFriendService();
    const storage = createStorage();
    const clock = manualTimers();
    const first = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    const created = await createInvitation(first);
    first.dispose();

    const reloaded = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    await reloaded.refreshOwnedInvitations();
    const cancelled = await reloaded.cancelOwnedInvitation(created.invitationId);

    // The service confirmed the cancellation, so the shown state is the
    // cancelled one.
    expect(cancelled.status).toBe('cancelled');
    expect(reloaded.ownedInvitations[0]?.status).toBe('cancelled');
    // The owner token stays in the browser, and the record of the invitation is
    // settled: the owner does not own it any more.
    expect(reloaded.ownsInvitation(created.invitationId)).toBe(false);
    // The owner token never travelled in a URL or in a body.
    const cancel = service.wires.find(wire => wire.path.endsWith('/cancel'));
    expect(cancel?.path.endsWith(`/v1/online/invitations/${created.invitationId}/cancel`)).toBe(true);
    expect(cancel?.ownerToken).toBe('owner-token-00000001');
    expect(cancel?.path).not.toContain('owner-token');
    expect(cancel?.body ?? '').not.toContain('owner-token');
    reloaded.dispose();

    // A later reload finds no invitation any more: the record was settled.
    const later = guestComposition({ fetcher: service.fetcher, storage });
    await later.refreshOwnedInvitations();
    expect(later.ownedInvitations).toEqual([]);
    later.dispose();
  });

  it('stops the poll of the composition when the service confirms a cancellation', async () => {
    const service = createFriendService();
    const storage = createStorage();
    const clock = manualTimers();
    const composition = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    const created = await createInvitation(composition);

    // The invitation was cancelled in another tab of the same browser.
    const record = service.invitations.get(created.invitationId);
    if (record) record.status = 'cancelled';
    clock.fire();
    await settle();

    // The terminal state settles the record, so the owner does not own the
    // invitation any more.
    expect(composition.ownsInvitation(created.invitationId)).toBe(false);
    const previews = service.wires.filter(wire => wire.method === 'GET' && wire.path.includes('/v1/online/invitations/'));
    // The poll of the composition stopped, so the invitation is not read
    // again.
    clock.fire();
    await settle();
    const later = service.wires.filter(wire => wire.method === 'GET' && wire.path.includes('/v1/online/invitations/'));
    expect(later.length).toBe(previews.length);
    composition.dispose();
  });

  it('keeps a consumed invitation recoverable', async () => {    const service = createFriendService();
    const storage = createStorage();
    const clock = manualTimers();
    const first = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    const created = await createInvitation(first);
    first.dispose();

    // The invitee accepted the invitation. The inviter still claims the seat
    // of the created match, so the record of the invitation stays: a consumed
    // invitation is never settled.
    const record = service.invitations.get(created.invitationId);
    if (record) record.status = 'consumed';
    const reloaded = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    await reloaded.refreshOwnedInvitations();
    expect(reloaded.ownsInvitation(created.invitationId)).toBe(true);
    expect(reloaded.ownedInvitations[0]?.status).toBe('consumed');
    reloaded.dispose();
  });
});

describe('another identity never sees the invitation of the owner', () => {
  it('shows nothing and refuses the cancellation', async () => {
    const service = createFriendService();
    const storage = createStorage();
    const clock = manualTimers();
    const owner = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    const created = await createInvitation(owner);
    owner.dispose();

    // Another identity of the same browser signs in.
    const other = accountComposition({ fetcher: service.fetcher, storage, accountId: 'account-00000002' });
    await other.refreshOwnedInvitations();

    // The other identity owns nothing, so it sees nothing.
    expect(other.ownedInvitations).toEqual([]);
    expect(other.ownsInvitation(created.invitationId)).toBe(false);
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={other} onClose={() => {}} initialTab="new" />);
    expect(markup).not.toContain(created.invitationId);
    expect(markup).not.toContain('aria-label="Your invitations"');

    // The other identity cannot cancel the invitation of the owner.
    await expect(other.cancelOwnedInvitation(created.invitationId)).rejects.toThrow();
    // It never even asks the service to cancel it.
    expect(service.wires.filter(wire => wire.path.endsWith('/cancel'))).toHaveLength(0);
    // The invitation of the owner is still open.
    expect(service.invitations.get(created.invitationId)?.status).toBe('open');
    other.dispose();
  });

  it('keeps the invitation of the owner for the owner that comes back', async () => {
    const service = createFriendService();
    const storage = createStorage();
    const clock = manualTimers();
    const owner = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    const created = await createInvitation(owner);
    owner.dispose();

    // Another identity of the same browser is active for a moment.
    const other = accountComposition({ fetcher: service.fetcher, storage, accountId: 'account-00000002' });
    await other.refreshOwnedInvitations();
    expect(other.ownedInvitations).toEqual([]);
    other.dispose();

    // The identity of the inviter comes back, and it finds its own pending
    // invitation again.
    const returning = guestComposition({ fetcher: service.fetcher, storage, timers: clock.timers });
    await returning.refreshOwnedInvitations();
    expect(returning.ownedInvitations.map(view => view.invitationId)).toEqual([created.invitationId]);
    returning.dispose();
  });
});
