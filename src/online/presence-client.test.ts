import { describe, expect, it } from 'vitest';
import { createOnlinePresenceClient, onlineClaimPath, onlinePresencePath } from './presence-client';
import { createAuthorizedRequester } from './request';
import { createParticipantSession } from './session';
import type { AuthorizedRequester } from './request';
import type { ParticipantSession } from './session';

/**
 * The presence client (KHA-70, KHA-73).
 *
 * The client owns no authority: it sends the seat of the caller and reads the
 * answers of the service. The tests prove the routes it uses and the closed
 * envelope of the abandonment claim.
 */

/** One request the fake transport received. */
interface Wire {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

/** A transport that records the requests and answers with one payload. */
function recordingTransport(answer: unknown, status = 200): { fetch: typeof fetch; wires: Wire[] } {
  const wires: Wire[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    wires.push({
      path: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
    });
    return new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: fetcher, wires };
}

/** A client of one seat with a guest credential. */
function seatClient(fetchImpl: typeof fetch): {
  client: ReturnType<typeof createOnlinePresenceClient>;
  requester: AuthorizedRequester;
  session: ParticipantSession;
} {
  const session = createParticipantSession();
  session.selectGuest({
    kind: 'guest',
    guestId: 'guest-00000001',
    matchId: 'match-00000001',
    seat: 'white',
    issue: async () => 'guest-token',
  });
  const requester = createAuthorizedRequester({
    session,
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
  });
  const client = createOnlinePresenceClient({
    requester,
    session,
    matchId: 'match-00000001',
    seat: 'white',
  });
  return { client, requester, session };
}

/** The presence view the service answers with. */
function presenceView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    matchId: 'match-00000001',
    version: 7,
    controlEpoch: 3,
    status: 'active',
    seats: [
      { seat: 'white', state: 'connected', lastHeartbeatAt: null, leaseExpiresAt: null, offlineSince: null, keepWaitingAt: null },
      { seat: 'black', state: 'offline', lastHeartbeatAt: null, leaseExpiresAt: null, offlineSince: null, keepWaitingAt: null },
    ],
    serviceState: 'healthy',
    recovered: true,
    claim: { eligible: true, reason: 'eligible', opponentSeat: 'black', offlineSince: null, graceSecondsLeft: 0, waitingSince: null },
    yourSeat: 'white',
    ...overrides,
  };
}

describe('the presence client', () => {
  it('reads the presence of both seats from the presence route', async () => {
    const { fetch: fetcher, wires } = recordingTransport(presenceView());
    const { client } = seatClient(fetcher);
    const view = await client.view();
    expect(view.claim.eligible).toBe(true);
    expect(view.claim.reason).toBe('eligible');
    expect(wires[0]?.path).toContain(onlinePresencePath('match-00000001'));
  });

  it('keeps the recovered flag and the waiting moment of the claim', async () => {
    const { fetch: fetcher } = recordingTransport(presenceView({
      recovered: false,
      claim: {
        eligible: true,
        reason: 'eligible',
        opponentSeat: 'black',
        offlineSince: '2026-10-21T10:00:15.000Z',
        graceSecondsLeft: 0,
        waitingSince: '2026-10-21T10:00:30.000Z',
      },
    }));
    const { client } = seatClient(fetcher);
    const view = await client.view();
    // The state of the service and the moment the opponent chose to wait
    // survive the reading. The client never hides them behind a default.
    expect(view.recovered).toBe(false);
    expect(view.claim.waitingSince).toBe('2026-10-21T10:00:30.000Z');
  });

  it('refuses a presence view with an unknown field', async () => {
    const { fetch: fetcher } = recordingTransport(presenceView({ participantId: 'user_0001' }));
    const { client } = seatClient(fetcher);
    await expect(client.view()).rejects.toThrow(/unexpected field participantId/);
  });

  it('refuses a presence view with an unknown claim reason', async () => {
    const { fetch: fetcher } = recordingTransport(presenceView({
      claim: { eligible: true, reason: 'because', opponentSeat: 'black', offlineSince: null, graceSecondsLeft: 0, waitingSince: null },
    }));
    const { client } = seatClient(fetcher);
    await expect(client.view()).rejects.toThrow(/invalid claim reason/);
  });

  it('refuses a presence view without a required field', async () => {
    const { fetch: fetcher } = recordingTransport((() => {
      const view = presenceView();
      delete view.version;
      return view;
    })());
    const { client } = seatClient(fetcher);
    await expect(client.view()).rejects.toThrow(/missing field version/);
  });

  it('refuses a seat presence with an unknown field', async () => {
    const { fetch: fetcher } = recordingTransport({
      seat: 'white',
      state: 'connected',
      lastHeartbeatAt: null,
      leaseExpiresAt: null,
      offlineSince: null,
      keepWaitingAt: null,
      credential: 'secret',
    });
    const { client } = seatClient(fetcher);
    await expect(client.heartbeat()).rejects.toThrow(/unexpected field credential/);
  });

  it('refuses a seat presence without a required field', async () => {
    const { fetch: fetcher } = recordingTransport({ state: 'connected' });
    const { client } = seatClient(fetcher);
    await expect(client.keepWaiting()).rejects.toThrow(/missing field seat/);
  });

  it('refuses a presence view of another match', async () => {
    const { fetch: fetcher } = recordingTransport(presenceView({ matchId: 'match-00000002' }));
    const { client } = seatClient(fetcher);
    await expect(client.view()).rejects.toThrow(/another match/);
  });

  it('records the choice to keep waiting on the keep waiting route', async () => {
    const { fetch: fetcher, wires } = recordingTransport({
      seat: 'black',
      state: 'offline',
      lastHeartbeatAt: null,
      leaseExpiresAt: null,
      offlineSince: null,
      keepWaitingAt: '2026-10-21T10:02:00.000Z',
    });
    const { client } = seatClient(fetcher);
    await client.keepWaiting();
    expect(wires[0]?.path).toContain('/presence/keep-waiting');
    expect(wires[0]?.method).toBe('POST');
    // The body carries the seat of the caller and never the seat of the
    // opponent.
    expect(wires[0]?.body).toEqual({ seat: 'white' });
  });

  it('sends the claim in the closed envelope of the service', async () => {
    const { fetch: fetcher, wires } = recordingTransport({
      schemaVersion: 2,
      matchId: 'match-00000001',
      operationId: 'operation-0001',
      outcome: 'accepted',
      version: 8,
      controlEpoch: 3,
      decidedAt: '2026-10-21T10:02:00.000Z',
    });
    const { client } = seatClient(fetcher);
    const receipt = await client.claimAbandonment({
      expectedVersion: 7,
      controlEpoch: 3,
      operationId: 'operation-0001',
    });
    expect(receipt.outcome).toBe('accepted');
    expect(receipt.version).toBe(8);
    // The claim rides its own route, never the presence route.
    expect(wires[0]?.path).toContain(onlineClaimPath('match-00000001'));
    expect(wires[0]?.method).toBe('POST');
    // The envelope is closed: it carries the facts the service checks again
    // and nothing else.
    expect(wires[0]?.body).toEqual({
      schemaVersion: 2,
      matchId: 'match-00000001',
      operationId: 'operation-0001',
      expectedVersion: 7,
      seat: 'white',
      controlEpoch: 3,
    });
  });

  it('refuses a claim the service rejected', async () => {
    const { fetch: fetcher } = recordingTransport({ error: 'not_allowed' }, 409);
    const { client } = seatClient(fetcher);
    await expect(client.claimAbandonment({ expectedVersion: 7, controlEpoch: 3 }))
      .rejects.toThrow(/refused the claim/);
  });

  it('refuses a receipt of another match', async () => {
    const { fetch: fetcher } = recordingTransport({
      schemaVersion: 2,
      matchId: 'match-00000002',
      operationId: 'operation-0001',
      outcome: 'accepted',
      version: 8,
      controlEpoch: 3,
      decidedAt: '2026-10-21T10:02:00.000Z',
    });
    const { client } = seatClient(fetcher);
    await expect(client.claimAbandonment({ expectedVersion: 7, controlEpoch: 3 }))
      .rejects.toThrow(/another match/);
  });
});
