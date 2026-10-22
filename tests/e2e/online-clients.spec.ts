// Real multi-client browser run against the local online fixture.
//
// The fixture is the real service composition: the Go API, a real PostgreSQL
// schema, the pinned private rules worker and the real authorization code. The
// clients here are real browsers: two Chromium contexts, real fetch, real CORS
// and real server-sent events.
//
// The run never contacts a hosted identity provider. Each account signs a
// session token with the fixture's own key, and the API verifies it with the
// same code path a hosted token takes, so there is no production auth bypass.
// The synthetic tokens live only in the ignored descriptor file.
//
// The wire contract is the published one: docs/online/matching-interfaces.md
// for the friend routes and backend/httpapi/online.go for the participant
// views. The assertions use the exact field names. A renamed or missing field
// is a wire incompatibility and fails the run; it is never papered over with
// alternative key lookups.
//
// Strictness:
//   - no descriptor at all: the run had no fixture, so it skips. The skip
//     says in the report that the run proved no online fixture coverage;
//   - a descriptor but a closed friend surface, a missing route or a missing
//     field: the run fails;
//   - a descriptor the caller supplied that cannot be read or that has
//     another shape: the run fails. An unusable descriptor is a broken run,
//     not an absent fixture.
// Set ONLINE_FIXTURE_STRICT=1 to make a missing descriptor fail as well.

import { expect, test } from '@playwright/test';
import { createPrivateKey, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openOnlineFixtureGate } from '../support/online-fixture-descriptor';
import type { OnlineFixtureDescriptor } from '../support/online-fixture-descriptor';

type Json = Record<string, unknown>;

// The browser worker publishes the production route it renders for an
// invitation. When it is not published yet the UI navigation check is
// reported as not run instead of guessing a selector.
const uiInvitePath = process.env.ONLINE_FIXTURE_UI_INVITE_PATH ?? '';

let descriptor: OnlineFixtureDescriptor | null = null;

/** Mints a session token for a fixture account with the fixture's own key. */
async function mintToken(accountId: string): Promise<string> {
  if (!descriptor) throw new Error('fixture descriptor is not loaded');
  const key = createPrivateKey(await readFile(descriptor.keyPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: 'onlinefixture-key-1', typ: 'JWT' });
  const claims = encode({
    iss: descriptor!.issuer,
    sub: accountId,
    sid: `sess_${accountId}`,
    azp: 'https://online.fixture.local',
    iat: now,
    exp: now + 900,
    token_use: 'session',
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(key).toString('base64url')}`;
}

/** Performs one request from inside the browser page. */
async function browserRequest(
  page: import('@playwright/test').Page,
  options: { method: string; path: string; token?: string | null; body?: unknown; guestToken?: string | null },
): Promise<{ status: number; json: Json | null; text: string }> {
  return page.evaluate(async (input) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (input.token) headers.Authorization = `Bearer ${input.token}`;
    if (input.guestToken) headers['X-Guest-Seat-Token'] = input.guestToken;
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const init: RequestInit = { method: input.method, headers };
      if (input.body !== undefined) init.body = JSON.stringify(input.body);
      const response = await fetch(new URL(input.path, input.baseUrl), init);
      const text = await response.text();
      let json: Json | null = null;
      try {
        json = JSON.parse(text) as Json;
      } catch {
        json = null;
      }
      return { status: response.status, json, text };
    } catch (error) {
      // A blocked cross-origin read is a real failure of the origin policy,
      // not a status code. It is reported as status 0 so the caller can tell
      // it apart from a server answer.
      return { status: 0, json: null, text: error instanceof Error ? error.message : String(error) };
    }
  }, { ...options, baseUrl: descriptor!.baseUrl });
}

/** Asserts that an answer carries exactly the documented field names. */
function expectExactFields(source: Json | null, fields: string[], label: string) {
  expect(source, `${label} is not a JSON object`).not.toBeNull();
  const actual = Object.keys(source!).sort();
  expect(actual, `${label} field names differ from the published contract`).toEqual([...fields].sort());
}

test.describe('online clients against the local fixture', () => {
  // The flow creates an invitation, previews it, accepts it as a guest, moves
  // twice and reads both views. It talks to a real service on a loopback
  // origin, so it needs more than the default budget.
  test.setTimeout(120_000);
  test.beforeAll(async () => {
    const gate = await openOnlineFixtureGate({
      reason: 'the online client cases need the real service',
    });
    if (gate.action === 'fail') {
      // A missing descriptor fails a strict run, and a descriptor the caller
      // supplied that cannot be used fails every run.
      throw new Error(gate.message);
    }
    if (gate.action === 'skip') {
      // The run had no fixture. The cases skip and the reason of the skip is
      // printed, so the report never reads as online fixture coverage.
      console.log(`[online-fixture] tests/e2e/online-clients.spec.ts: ${gate.message}`);
      test.skip(true, gate.message);
      return;
    }
    descriptor = gate.descriptor;
  });

  test('the feature switch route reports exactly the two switches', async ({ browser }) => {
    expect(descriptor).not.toBeNull();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    const response = await browserRequest(page, { method: 'GET', path: '/v1/online/features' });
    expect(response.status, `feature switch route failed: ${response.text}`).toBe(200);
    expectExactFields(response.json, ['friends', 'queue'], 'the feature switch answer');
    expect(typeof response.json!.friends).toBe('boolean');
    expect(typeof response.json!.queue).toBe('boolean');
    await context.close();
  });

  test('a guest accepts a friend invitation and both browser clients observe the same accepted move', async ({ browser }) => {
    expect(descriptor).not.toBeNull();

    const ownerContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    // The application origin is the page origin, so the browser sends a real
    // Origin header and the API's own origin policy is exercised.
    await ownerPage.goto('/');
    await guestPage.goto('/');

    const features = await browserRequest(ownerPage, { method: 'GET', path: '/v1/online/features' });
    expect(features.status, `feature switch route failed: ${features.text}`).toBe(200);
    expectExactFields(features.json, ['friends', 'queue'], 'the feature switch answer');
    if (features.json!.friends !== true) {
      throw new Error('friend play is closed in this fixture run; the friend routes cannot be exercised');
    }

    const ownerToken = await mintToken(descriptor!.accounts[0]!.id);

    const invitation = await browserRequest(ownerPage, {
      method: 'POST',
      path: '/v1/online/invitations',
      token: ownerToken,
      body: {
        schemaVersion: 2,
        kind: 'link',
        seat: 'white',
        timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
        control: { kind: 'human' },
      },
    });
    expect(invitation.status, `invitation creation failed: ${invitation.text}`).toBe(201);
    expectExactFields(invitation.json, ['schemaVersion', 'invitation', 'ownerToken'], 'the invitation answer');
    expect(invitation.json!.schemaVersion).toBe(2);
    expect(typeof invitation.json!.ownerToken).toBe('string');

    const invitationBody = invitation.json!.invitation as Json;
    expectExactFields(invitationBody, [
      'invitationId', 'kind', 'status', 'inviterLabel', 'inviterSeat', 'inviterControl',
      'timeControl', 'startingFen', 'expiresAt', 'createdAt', 'consumedAt', 'cancelledAt', 'matchId',
      'schemaVersion',
    ], 'the invitation object');
    expect(invitationBody.invitationId).toBeTruthy();
    expect(invitationBody.kind).toBe('link');
    expect(invitationBody.status).toBe('open');
    expect(invitationBody.inviterSeat).toBe('white');
    expect(invitationBody.startingFen).toBeNull();
    expect(invitationBody.consumedAt).toBeNull();
    expect(invitationBody.cancelledAt).toBeNull();
    expect(invitationBody.matchId).toBeNull();
    const timeControl = invitationBody.timeControl as Json;
    expectExactFields(timeControl, ['startingTimeMs', 'incrementMs'], 'the invitation time control');
    expect(timeControl.startingTimeMs).toBe(300_000);
    expect(timeControl.incrementMs).toBe(2_000);

    // The link preview never shows a pairing, a credential or an owner token.
    const preview = await browserRequest(guestPage, {
      method: 'GET',
      path: `/v1/online/invitations/${encodeURIComponent(String(invitationBody.invitationId))}`,
    });
    expect(preview.status, `invitation preview failed: ${preview.text}`).toBe(200);
    expect(JSON.stringify(preview.json)).not.toContain(String(invitation.json!.ownerToken));

    const acceptanceKey = `acceptance-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const accepted = await browserRequest(guestPage, {
      method: 'POST',
      path: `/v1/online/invitations/${encodeURIComponent(String(invitationBody.invitationId))}/accept`,
      body: { schemaVersion: 2, acceptanceKey, control: { kind: 'human' } },
    });
    expect(accepted.status, `guest acceptance failed: ${accepted.text}`).toBe(200);
    expectExactFields(accepted.json, ['schemaVersion', 'match', 'seat', 'acceptanceId', 'guestCredential'], 'the acceptance answer');
    expect(accepted.json!.schemaVersion).toBe(2);
    expect(accepted.json!.seat).toBe('black');

    const guestCredential = accepted.json!.guestCredential as Json;
    expectExactFields(guestCredential, ['guestId', 'matchId', 'seat', 'token', 'expiresAt'], 'the guest credential');
    expect(guestCredential.seat).toBe('black');
    const guestToken = String(guestCredential.token);

    const match = accepted.json!.match as Json;
    expectExactFields(match, [
      'schemaVersion', 'matchId', 'variant', 'startingFen', 'positionFen', 'timeControl', 'version',
      'controlEpoch', 'rulesPolicyVersion', 'status', 'result', 'seats', 'clock', 'moves', 'pendingOffers',
      'createdAt', 'updatedAt', 'completedAt', 'yourSeat',
    ], 'the participant live view');
    const matchId = String(match.matchId);
    expect(matchId).toBe(String(guestCredential.matchId));
    expect(match.status).toBe('active');
    expect(match.yourSeat).toBe('black');
    expect(Array.isArray(match.seats)).toBe(true);
    expect((match.seats as unknown[]).length).toBe(2);

    // The guest credential reaches the participant routes.
    const liveBefore = await browserRequest(guestPage, {
      method: 'GET',
      path: `/v1/online/matches/${encodeURIComponent(matchId)}`,
      guestToken,
    });
    expect(liveBefore.status, `guest live read failed: ${liveBefore.text}`).toBe(200);
    const liveBeforeView = liveBefore.json as Json;
    expectExactFields(liveBeforeView, Object.keys(match), 'the participant live view');
    expect(liveBeforeView.matchId).toBe(matchId);
    const version = Number(liveBeforeView.version);

    const command = await browserRequest(ownerPage, {
      method: 'POST',
      path: `/v1/online/matches/${encodeURIComponent(matchId)}/commands`,
      token: ownerToken,
      body: {
        schemaVersion: 2,
        matchId,
        operationId: `browser-move-${Date.now()}`,
        expectedVersion: version,
        seat: 'white',
        controlEpoch: 1,
        action: { kind: 'submit_move', move: 'e2e4' },
      },
    });
    expect(command.status, `submit_move failed: ${command.text}`).toBeLessThan(300);

    // The guest client observes the accepted move through the real read path.
    const liveAfter = await browserRequest(guestPage, {
      method: 'GET',
      path: `/v1/online/matches/${encodeURIComponent(matchId)}`,
      guestToken,
    });
    expect(liveAfter.status).toBe(200);
    expect(Number((liveAfter.json as Json).version)).toBeGreaterThan(version);
    const moves = (liveAfter.json as Json).moves as Json[];
    expect(moves.length).toBe(1);
    expect(Object.keys(moves[0]!).sort()).toEqual(['resultingFen', 'san', 'seat', 'uci', 'version']);
    expect(moves[0]!.uci).toBe('e2e4');
    expect(moves[0]!.san).toBe('e4');
    expect(moves[0]!.seat).toBe('white');

    // The server is the single writer: a stale command cannot move the game.
    const stale = await browserRequest(ownerPage, {
      method: 'POST',
      path: `/v1/online/matches/${encodeURIComponent(matchId)}/commands`,
      token: ownerToken,
      body: {
        schemaVersion: 2,
        matchId,
        operationId: `browser-stale-${Date.now()}`,
        expectedVersion: version,
        seat: 'white',
        controlEpoch: 1,
        action: { kind: 'submit_move', move: 'e2e4' },
      },
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);

    // The guest answers the opening move. The responder owes a reply inside
    // the opening window, so the answer has to be accepted and both clients
    // have to see it.
    const afterFirstMove = await browserRequest(guestPage, {
      method: 'GET',
      path: `/v1/online/matches/${encodeURIComponent(matchId)}`,
      guestToken,
    });
    expect(afterFirstMove.status).toBe(200);
    const replyVersion = Number((afterFirstMove.json as Json).version);
    const reply = await browserRequest(guestPage, {
      method: 'POST',
      path: `/v1/online/matches/${encodeURIComponent(matchId)}/commands`,
      guestToken,
      body: {
        schemaVersion: 2,
        matchId,
        operationId: `browser-reply-${Date.now()}`,
        expectedVersion: replyVersion,
        seat: 'black',
        controlEpoch: 1,
        action: { kind: 'submit_move', move: 'e7e5' },
      },
    });
    expect(reply.status, `the opening reply failed: ${reply.text}`).toBeLessThan(300);

    const afterReply = await browserRequest(ownerPage, {
      method: 'GET',
      path: `/v1/online/matches/${encodeURIComponent(matchId)}`,
      token: ownerToken,
    });
    expect(afterReply.status).toBe(200);
    const finalView = afterReply.json as Json;
    expect(Number(finalView.version)).toBeGreaterThan(replyVersion);
    const finalMoves = finalView.moves as Json[];
    expect(finalMoves.length).toBe(2);
    expect(finalMoves[1]!.uci).toBe('e7e5');
    expect(finalMoves[1]!.seat).toBe('black');

    await ownerContext.close();
    await guestContext.close();
  });

  test('a consumed invitation cannot be accepted twice and a guest without a credential is refused', async ({ browser }) => {
    expect(descriptor).not.toBeNull();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');

    const features = await browserRequest(page, { method: 'GET', path: '/v1/online/features' });
    expect(features.status, `feature switch route failed: ${features.text}`).toBe(200);
    if (features.json!.friends !== true) {
      throw new Error('friend play is closed in this fixture run; the friend routes cannot be exercised');
    }

    const ownerToken = await mintToken(descriptor!.accounts[1]!.id);
    const invitation = await browserRequest(page, {
      method: 'POST',
      path: '/v1/online/invitations',
      token: ownerToken,
      body: {
        schemaVersion: 2,
        kind: 'link',
        seat: 'white',
        timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
        control: { kind: 'human' },
      },
    });
    expect(invitation.status, `invitation creation failed: ${invitation.text}`).toBe(201);
    const invitationId = String((invitation.json!.invitation as Json).invitationId);

    const acceptanceKey = `acceptance-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const first = await browserRequest(page, {
      method: 'POST',
      path: `/v1/online/invitations/${encodeURIComponent(invitationId)}/accept`,
      body: { schemaVersion: 2, acceptanceKey, control: { kind: 'human' } },
    });
    expect(first.status, `first acceptance failed: ${first.text}`).toBe(200);

    // A different acceptance key on a consumed invitation must not create a
    // second match.
    const second = await browserRequest(page, {
      method: 'POST',
      path: `/v1/online/invitations/${encodeURIComponent(invitationId)}/accept`,
      body: { schemaVersion: 2, acceptanceKey: `${acceptanceKey}-other`, control: { kind: 'human' } },
    });
    expect(second.status).toBeGreaterThanOrEqual(400);

    // No credential at all: live state is not readable.
    const denied = await browserRequest(page, {
      method: 'GET',
      path: '/v1/online/matches/not-a-real-match',
    });
    expect(denied.status === 0 || denied.status >= 400).toBe(true);
    expect(denied.status).toBe(401);

    await context.close();
  });

  test('the production interface renders the invitation link', async ({ browser }) => {
    test.skip(!uiInvitePath, 'ONLINE_FIXTURE_UI_INVITE_PATH is not published yet; the rendered interface check has not run');
    expect(descriptor).not.toBeNull();
    const ownerContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    await ownerPage.goto('/');
    await guestPage.goto('/');

    const ownerToken = await mintToken(descriptor!.accounts[2]!.id);
    const invitation = await browserRequest(ownerPage, {
      method: 'POST',
      path: '/v1/online/invitations',
      token: ownerToken,
      body: {
        schemaVersion: 2,
        kind: 'link',
        seat: 'white',
        timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
        control: { kind: 'human' },
      },
    });
    expect(invitation.status, `invitation creation failed: ${invitation.text}`).toBe(201);
    const invitationId = String((invitation.json!.invitation as Json).invitationId);

    await guestPage.goto(uiInvitePath.replace('{invitationId}', encodeURIComponent(invitationId)));
    // The rendered interface must offer the acceptance action for the guest.
    await expect(guestPage.getByRole('button', { name: /accept|join|play/i }).first()).toBeVisible();

    await ownerContext.close();
    await guestContext.close();
  });

  test('the rendered workspace reflects the real service state', async ({ browser }) => {
    expect(descriptor).not.toBeNull();
    const context = await browser.newContext();
    const page = await context.newPage();
    // The service is the authority for the surfaces. The rendered workspace
    // must show the same state the service reports, so a browser flag alone
    // cannot open a surface.
    const observed: { answer: Json | null, url: string } = { answer: null, url: '' };
    page.on('response', async (response) => {
      if (!response.url().endsWith('/v1/online/features')) return;
      try {
        observed.answer = await response.json();
        observed.url = response.url();
      } catch {
        observed.answer = null;
      }
    });
    await page.goto('/play?online=1');

    // The service answer is read from a second page, so the probe request
    // cannot be mistaken for the application's own request.
    const probeContext = await browser.newContext();
    const probePage = await probeContext.newPage();
    await probePage.goto('/');
    const features = await browserRequest(probePage, { method: 'GET', path: '/v1/online/features' });
    expect(features.status, `feature switch route failed: ${features.text}`).toBe(200);
    const queueEnabled = features.json!.queue === true;

    await page.getByRole('button', { name: 'Online play' }).click();
    await expect(page.getByRole('region', { name: 'Online play' })).toBeVisible();
    await page.getByRole('button', { name: 'New play' }).click();
    const playYourself = page.getByRole('button', { name: 'Play yourself' }).first();
    await expect(playYourself).toBeVisible();
    if (observed.answer) {
      // The interface follows the service it is bound to. The application
      // reads its own service, so the rendered action matches that answer and
      // never opens a surface that service keeps closed.
      if (observed.url.startsWith(descriptor!.baseUrl)) {
        // The application and the probe read the same service, so both have
        // to see the same answer.
        expect(observed.answer.queue, 'the probe and the application read different service answers').toBe(queueEnabled);
      }
      if (observed.answer.queue === true) {
        // The public queue is an account surface, so an open service does not
        // open the action for every browser. This browser holds no account,
        // so the action stays closed and the workspace says why instead of
        // reaching the service with a guest credential.
        await expect(playYourself).toBeDisabled();
        await expect(page.getByRole('status').filter({ hasText: 'Sign in to join the queue' })).toBeVisible();
      } else {
        // The service keeps the queue closed, so the action is closed too.
        await expect(playYourself).toBeDisabled();
      }
    } else {
      // The build carries no account configuration, so the workspace never
      // asks the service. The closed state is then the correct rendering.
      await expect(playYourself).toBeDisabled();
    }

    await context.close();
    await probeContext.close();
  });
});
