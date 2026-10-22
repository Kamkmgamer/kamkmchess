import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGuestCredential } from '../../src/online/auth';
import { parseRunnerRequestEnvelope } from '../../src/online/contracts';
import { createOnlineRunnerLeaseClient } from '../../src/online/runner-lease';
import { createAuthorizedRequester } from '../../src/online/request';
import { createParticipantSession } from '../../src/online/session';
import type { AccountSessionPort } from '../../src/online/session';

// The emitted wire body of the runner request route.
//
// The transport is the production one. A real participant session holds a
// real credential, the real authorized requester mints it, and the real runner
// lease client sends the request. The fetch is captured instead of sent, so
// the bytes on the wire are the proof: the route, the method, the credential
// header and the exact body.
//
// The service owns the strict decoder and the shared fixture, so the body the
// browser really sends is compared with the fixture of the service, and the
// emitted body is parsed with the same rules the service applies.

const fixturePath = 'backend/online/testdata/online-contracts.json';
const matchID = 'match-contract-01';
const serviceOrigin = 'https://service.example';

interface ContractFixture {
  readonly runnerRequest: unknown;
  readonly runnerLease: {
    readonly leaseId: string;
    readonly runnerId: string;
    readonly seat: string;
    readonly controlEpoch: number;
    readonly turnVersion: number | null;
  };
}

interface CapturedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

function loadFixture(): ContractFixture {
  const raw = readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw) as ContractFixture;
}

/** The header map of a captured request, in lower case. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = init?.headers;
  if (!raw) return headers;
  if (raw instanceof Headers) {
    raw.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return headers;
  }
  if (Array.isArray(raw)) {
    for (const [name, value] of raw) headers[name.toLowerCase()] = value;
    return headers;
  }
  for (const [name, value] of Object.entries(raw)) headers[name.toLowerCase()] = value;
  return headers;
}

/**
 * Creates the transport that captures the requests.
 *
 * The answer is the lease of the shared fixture, so the client accepts the
 * answer and the test reads the request that produced it.
 */
function capturingFetch(captured: CapturedRequest[], answer: unknown): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({
      url: new URL(input instanceof Request ? input.url : input.toString()),
      method: init?.method ?? 'GET',
      headers: headersOf(init),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** A signed-in account, shaped like the Clerk account session. */
function signedInAccount(accountId: string, token: string): AccountSessionPort {
  const identity = {
    accountId,
    token: async (): Promise<string> => token,
  };
  return {
    identity,
    subscribe: () => () => undefined,
  };
}

describe('the emitted runner request body', () => {
  it('sends the envelope of the shared fixture over the authorized transport', async () => {
    const fixture = loadFixture();
    const captured: CapturedRequest[] = [];
    const token = 'signed-in-session-token-of-the-account';
    const session = createParticipantSession({ accountSession: signedInAccount('user_a', token) });
    const requester = createAuthorizedRequester({
      session,
      baseUrl: serviceOrigin,
      fetch: capturingFetch(captured, fixture.runnerLease),
    });
    const client = createOnlineRunnerLeaseClient({
      requester,
      session,
      matchId: matchID,
      seat: fixture.runnerLease.seat === 'white' ? 'white' : 'black',
      runnerId: fixture.runnerLease.runnerId,
    });

    await client.beginRequest({
      controlEpoch: fixture.runnerLease.controlEpoch,
      turnVersion: fixture.runnerLease.turnVersion,
      leaseId: fixture.runnerLease.leaseId,
      requestId: 'request-contract-01',
    });

    expect(captured).toHaveLength(1);
    const wire = captured[0];
    expect(wire?.url.pathname).toBe(`/v1/online/matches/${matchID}/runner/request`);
    // The credential never travels in the URL.
    expect(wire?.url.search).toBe('');
    expect(wire?.method).toBe('POST');
    // The credential rides the account bearer transport and nowhere else.
    expect(wire?.headers.authorization).toBe(`Bearer ${token}`);
    expect(wire?.headers['content-type']).toBe('application/json');
    expect(wire?.headers.accept).toBe('application/json');
    const credentialCarriers = Object.entries(wire?.headers ?? {}).filter(
      ([name, value]) => name !== 'authorization' && name !== 'content-type' && name !== 'accept' && value.includes(token),
    );
    expect(credentialCarriers).toEqual([]);
    // The body is the envelope of the shared fixture, byte for byte.
    const body = JSON.parse(wire?.body ?? '') as unknown;
    expect(body).toEqual(fixture.runnerRequest);
    expect(parseRunnerRequestEnvelope(body)).toEqual(fixture.runnerRequest);
  });

  it('sends the guest seat credential on its own transport', async () => {
    const fixture = loadFixture();
    const captured: CapturedRequest[] = [];
    const session = createParticipantSession({ accountSession: null });
    session.selectGuest(
      createGuestCredential({
        guestId: 'guest-of-the-white-seat',
        matchId: matchID,
        seat: 'white',
        token: 'guest-seat-token-of-the-white-seat',
      }),
    );
    const requester = createAuthorizedRequester({
      session,
      baseUrl: serviceOrigin,
      fetch: capturingFetch(captured, fixture.runnerLease),
    });
    const client = createOnlineRunnerLeaseClient({
      requester,
      session,
      matchId: matchID,
      seat: 'white',
      runnerId: fixture.runnerLease.runnerId,
    });

    await client.beginRequest({
      controlEpoch: fixture.runnerLease.controlEpoch,
      turnVersion: fixture.runnerLease.turnVersion,
      leaseId: fixture.runnerLease.leaseId,
      requestId: 'request-contract-01',
    });

    expect(captured).toHaveLength(1);
    const wire = captured[0];
    // A guest credential never rides the account bearer transport.
    expect(wire?.headers.authorization).toBeUndefined();
    expect(wire?.headers['x-guest-seat-token']).toBe('guest-seat-token-of-the-white-seat');
    expect(JSON.parse(wire?.body ?? '')).toEqual(fixture.runnerRequest);
  });

  it('refuses a credential of another seat before anything is sent', async () => {
    const fixture = loadFixture();
    const captured: CapturedRequest[] = [];
    const session = createParticipantSession({ accountSession: null });
    session.selectGuest(
      createGuestCredential({
        guestId: 'guest-of-the-black-seat',
        matchId: matchID,
        seat: 'black',
        token: 'guest-seat-token-of-the-black-seat',
      }),
    );
    const requester = createAuthorizedRequester({
      session,
      baseUrl: serviceOrigin,
      fetch: capturingFetch(captured, fixture.runnerLease),
    });
    const client = createOnlineRunnerLeaseClient({
      requester,
      session,
      matchId: matchID,
      seat: 'white',
      runnerId: fixture.runnerLease.runnerId,
    });

    await expect(
      client.beginRequest({
        controlEpoch: fixture.runnerLease.controlEpoch,
        turnVersion: fixture.runnerLease.turnVersion,
        leaseId: fixture.runnerLease.leaseId,
        requestId: 'request-contract-01',
      }),
    ).rejects.toThrow(/different match or seat/);
    // The scope is checked before a credential is minted, so nothing was sent.
    expect(captured).toHaveLength(0);
  });

  it('sends an explicit zero turn version when the caller supplies none', async () => {
    const fixture = loadFixture();
    const captured: CapturedRequest[] = [];
    const session = createParticipantSession({
      accountSession: signedInAccount('user_a', 'signed-in-session-token-of-the-account'),
    });
    const requester = createAuthorizedRequester({
      session,
      baseUrl: serviceOrigin,
      fetch: capturingFetch(captured, fixture.runnerLease),
    });
    const client = createOnlineRunnerLeaseClient({
      requester,
      session,
      matchId: matchID,
      seat: 'white',
      runnerId: fixture.runnerLease.runnerId,
    });

    await client.beginRequest({
      controlEpoch: fixture.runnerLease.controlEpoch,
      turnVersion: null,
      leaseId: fixture.runnerLease.leaseId,
      requestId: 'request-contract-01',
    });

    expect(captured).toHaveLength(1);
    const body = JSON.parse(captured[0]?.body ?? '') as Record<string, unknown>;
    expect(body.turnVersion).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(body, 'turnVersion')).toBe(true);
  });

  it('sends a clear body that matches the shared envelope parser', async () => {
    const fixture = loadFixture();
    const captured: CapturedRequest[] = [];
    const session = createParticipantSession({
      accountSession: signedInAccount('user_a', 'signed-in-session-token-of-the-account'),
    });
    const requester = createAuthorizedRequester({
      session,
      baseUrl: serviceOrigin,
      fetch: capturingFetch(captured, fixture.runnerLease),
    });
    const client = createOnlineRunnerLeaseClient({
      requester,
      session,
      matchId: matchID,
      seat: 'white',
      runnerId: fixture.runnerLease.runnerId,
    });

    await client.clearRequest({
      controlEpoch: fixture.runnerLease.controlEpoch,
      turnVersion: fixture.runnerLease.turnVersion,
      leaseId: fixture.runnerLease.leaseId,
      requestId: 'request-contract-01',
    });

    expect(captured).toHaveLength(1);
    const envelope = parseRunnerRequestEnvelope(JSON.parse(captured[0]?.body ?? ''));
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.action).toBe('clear');
    expect(envelope.leaseId).toBe(fixture.runnerLease.leaseId);
  });
});
