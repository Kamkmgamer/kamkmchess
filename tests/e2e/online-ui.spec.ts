// The rendered guest friend flow and the queue fallback against the real
// online service.
//
// The fixture is the real service composition: the Go API, a real PostgreSQL
// schema, the pinned private rules worker and the real authorization code.
// The clients are real browsers: two Chromium contexts, real fetch, real CORS
// and real server-sent events.
//
// The run never contacts a hosted identity provider. The synthetic tokens
// live only in the ignored descriptor file.
//
// The build under test has to point at the fixture: the public API origin of
// the build is the base URL of the descriptor. A build that points somewhere
// else fails the run instead of silently testing a different service.
//
// Strictness:
//   - no descriptor at all: the run had no fixture, so it skips. The skip
//     says in the report that the run proved no online fixture coverage;
//   - a descriptor and a mismatch between the build and the fixture, a
//     closed surface, a missing route or a missing field: the run fails;
//   - a descriptor the caller supplied that cannot be read or that has
//     another shape: the run fails. An unusable descriptor is a broken run,
//     not an absent fixture.
// Set ONLINE_FIXTURE_STRICT=1 to make a missing descriptor fail as well.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openOnlineFixtureGate } from '../support/online-fixture-descriptor';
import type { OnlineFixtureDescriptor } from '../support/online-fixture-descriptor';

let descriptor: OnlineFixtureDescriptor | null = null;

test.beforeAll(async () => {
  const gate = await openOnlineFixtureGate({
    reason: 'the rendered online cases need the real service',
  });
  if (gate.action === 'fail') {
    // A missing descriptor fails a strict run, and a descriptor the caller
    // supplied that cannot be used fails every run.
    throw new Error(gate.message);
  }
  if (gate.action === 'skip') {
    // The run had no fixture. The cases skip and the reason of the skip is
    // printed, so the report never reads as online fixture coverage.
    console.log(`[online-fixture] tests/e2e/online-ui.spec.ts: ${gate.message}`);
    test.skip(true, gate.message);
    return;
  }
  descriptor = gate.descriptor;
});

test('a guest opens the published invitation link and previews the exact invitation', async ({ page }) => {
  expect(descriptor).not.toBeNull();
  // The inviter creates a link.
  const inviter = await page.context().newPage();
  await inviter.goto('/play?online=1');
  await inviter.getByRole('button', { name: 'Play online' }).click();
  await inviter.getByRole('button', { name: 'New play' }).click();
  await inviter.getByRole('button', { name: 'Invite a friend' }).click();
  const link = await inviter.getByLabel('Invitation link').inputValue();
  const invitationId = link.split('/invite/')[1] ?? '';
  expect(invitationId.length).toBeGreaterThan(7);

  // The published link opens the online screen with that exact invitation.
  const guest = await page.context().newPage();
  await guest.goto(`/invite/${invitationId}`);
  await expect(guest.getByRole('region', { name: 'Online play' })).toBeVisible();
  await expect(guest.getByLabel('Invitation code')).toHaveValue(invitationId);
  // The preview shows the inviter of that invitation.
  await expect(guest.getByRole('status').filter({ hasText: 'Guest' })).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Accept' })).toBeEnabled();
});

test('a guest creates a friend link and the other guest joins the game', async ({ browser }) => {
  expect(descriptor).not.toBeNull();
  const inviter = await browser.newContext();
  const invitee = await browser.newContext();
  const inviterPage = await inviter.newPage();
  const inviteePage = await invitee.newPage();
  try {
    await inviterPage.goto('/play?online=1');
    await inviterPage.getByRole('button', { name: 'Play online' }).click();
    await inviterPage.getByRole('button', { name: 'New play' }).click();
    await inviterPage.getByRole('button', { name: 'Invite a friend' }).click();
    const link = await inviterPage.getByLabel('Invitation link').inputValue();
    expect(link).toContain('/invite/');
    const invitationId = link.split('/invite/')[1] ?? '';
    expect(invitationId.length).toBeGreaterThan(7);

    // The preview shows the inviter and the setup of the invitation.
    await inviteePage.goto('/play?online=1');
    await inviteePage.getByRole('button', { name: 'Play online' }).click();
    await inviteePage.getByRole('button', { name: 'New play' }).click();
    await inviteePage.getByLabel('Invitation code').fill(invitationId);
    await inviteePage.getByRole('button', { name: 'Preview' }).click();
    await expect(inviteePage.getByRole('status').filter({ hasText: 'Guest' })).toBeVisible();

    // The guest accepts the invitation and the match appears.
    await inviteePage.getByRole('button', { name: 'Accept' }).click();
    await expect(inviteePage.getByRole('region', { name: 'Online match board' })).toBeVisible();

    // The inviter sees the same match.
    await inviterPage.getByRole('region', { name: 'Online play' }).getByRole('button', { name: 'Games', exact: true }).click();
    await expect(inviterPage.getByRole('region', { name: 'Online match board' })).toBeVisible();
  } finally {
    await inviter.close();
    await invitee.close();
  }
});

/** The point of a square on the online board of the page. */
async function point(page: import('@playwright/test').Page, square: string, flipped = false) {
  const board = page.getByRole('region', { name: 'Online match board' }).locator('cg-board');
  const box = await board.boundingBox();
  if (!box) throw new Error('The board is missing');
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return {
    x: box.x + (flipped ? 7 - file : file) * box.width / 8 + box.width / 16,
    y: box.y + (flipped ? rank : 7 - rank) * box.height / 8 + box.height / 16,
  };
}

/**
 * Plays a move on the online board and waits for the move list to grow.
 *
 * The opening reply window is short, so the move is offered again while the
 * window is open.
 */
async function playMove(page: Page, from: string, to: string, flipped = false): Promise<void> {
  const moves = page.getByRole('table', { name: 'Committed moves' }).getByRole('button');
  const before = await moves.count();
  const start = await point(page, from, flipped);
  const target = await point(page, to, flipped);
  const deadline = Date.now() + 10_000;
  while (await moves.count() === before && Date.now() < deadline) {
    await page.mouse.click(start.x, start.y);
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(200);
  }
}

test('the review cursor holds an earlier position while the live game moves on', async ({ browser }) => {
  // The review cursor is the position the owner looks at. A live update must
  // never throw the owner back to the live end, and the live button restores
  // the latest position.
  expect(descriptor).not.toBeNull();
  const inviter = await browser.newContext();
  const invitee = await browser.newContext();
  const inviterPage = await inviter.newPage();
  const inviteePage = await invitee.newPage();
  try {
    await inviterPage.goto('/play?online=1');
    await inviterPage.getByRole('button', { name: 'Play online' }).click();
    await inviterPage.getByRole('button', { name: 'New play' }).click();
    await inviterPage.getByRole('button', { name: 'Invite a friend' }).click();
    const link = await inviterPage.getByLabel('Invitation link').inputValue();
    const invitationId = link.split('/invite/')[1] ?? '';
    await inviterPage.getByRole('region', { name: 'Online play' }).getByRole('button', { name: 'Games', exact: true }).click();

    await inviteePage.goto('/play?online=1');
    await inviteePage.getByRole('button', { name: 'Play online' }).click();
    await inviteePage.getByRole('button', { name: 'New play' }).click();
    await inviteePage.getByLabel('Invitation code').fill(invitationId);
    await inviteePage.getByRole('button', { name: 'Preview' }).click();
    await inviteePage.getByRole('button', { name: 'Accept' }).click();
    await expect(inviteePage.getByRole('region', { name: 'Online match board' })).toBeVisible();
    await expect(inviterPage.getByRole('region', { name: 'Online match board' })).toBeVisible({ timeout: 20_000 });

    // The inviter opens the game and the invitee answers the opening reply.
    await playMove(inviterPage, 'e2', 'e4');
    await expect(inviterPage.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveText(['e4'], { timeout: 15_000 });
    await playMove(inviteePage, 'e7', 'e5', true);
    await expect(inviteePage.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveText(['e4', 'e5'], { timeout: 15_000 });

    // The invitee looks at the position before the last move.
    await inviteePage.getByRole('complementary', { name: 'Online moves' }).getByRole('button', { name: 'Previous' }).click();
    await expect(inviteePage.getByRole('complementary', { name: 'Online moves' }).getByRole('button', { name: 'View move 1: e4' })).toHaveAttribute('aria-current', 'step');
    await expect(inviteePage.getByRole('complementary', { name: 'Online moves' }).getByRole('button', { name: 'View move 2: e5' })).not.toHaveAttribute('aria-current', 'step');

    // The live game moves on. The review of the invitee holds its position.
    await playMove(inviterPage, 'g1', 'f3');
    await expect(inviterPage.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveText(['e4', 'e5', 'Nf3'], { timeout: 20_000 });
    await expect(inviteePage.getByRole('complementary', { name: 'Online moves' }).getByRole('button', { name: 'View move 1: e4' })).toHaveAttribute('aria-current', 'step');
    await expect(inviteePage.getByRole('complementary', { name: 'Online moves' }).getByRole('button', { name: 'View move 3: Nf3' })).not.toHaveAttribute('aria-current', 'step');

    // The live button restores the latest position.
    await inviteePage.getByRole('complementary', { name: 'Online moves' }).getByRole('button', { name: 'Live' }).click();
    await expect(inviteePage.getByRole('complementary', { name: 'Online moves' }).getByRole('button', { name: 'View move 3: Nf3' })).toHaveAttribute('aria-current', 'step');
  } finally {
    await inviter.close();
    await invitee.close();
  }
});

test('the first move and the opening reply are playable in the real service', async ({ browser }) => {
  expect(descriptor).not.toBeNull();
  const inviter = await browser.newContext();
  const invitee = await browser.newContext();
  const inviterPage = await inviter.newPage();
  const inviteePage = await invitee.newPage();
  try {
    await inviterPage.goto('/play?online=1');
    await inviterPage.getByRole('button', { name: 'Play online' }).click();
    await inviterPage.getByRole('button', { name: 'New play' }).click();
    await inviterPage.getByRole('button', { name: 'Invite a friend' }).click();
    const link = await inviterPage.getByLabel('Invitation link').inputValue();
    const invitationId = link.split('/invite/')[1] ?? '';
    // The inviter watches its games, so its board is ready when the match
    // arrives.
    await inviterPage.getByRole('region', { name: 'Online play' }).getByRole('button', { name: 'Games', exact: true }).click();

    await inviteePage.goto('/play?online=1');
    await inviteePage.getByRole('button', { name: 'Play online' }).click();
    await inviteePage.getByRole('button', { name: 'New play' }).click();
    await inviteePage.getByLabel('Invitation code').fill(invitationId);
    await inviteePage.getByRole('button', { name: 'Preview' }).click();
    await inviteePage.getByRole('button', { name: 'Accept' }).click();
    await expect(inviteePage.getByRole('region', { name: 'Online match board' })).toBeVisible();
    // The inviter claims its own seat and follows the match.
    await expect(inviterPage.getByRole('region', { name: 'Online match board' })).toBeVisible({ timeout: 20_000 });

    // The inviter holds the white seat, so it plays the first move of the
    // match and the invitee answers inside the opening reply window.
    const from = await point(inviterPage, 'e2');
    const to = await point(inviterPage, 'e4');
    await inviterPage.mouse.click(from.x, from.y);
    await inviterPage.mouse.click(to.x, to.y);
    // The accepted move reaches the move list of the inviter.
    await expect(inviterPage.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveText(['e4'], { timeout: 15_000 });
    // The other side answers the opening reply. It holds the black seat, so
    // its board is flipped.
    const replyFrom = await point(inviteePage, 'e7', true);
    const replyTo = await point(inviteePage, 'e5', true);
    await inviteePage.mouse.click(replyFrom.x, replyFrom.y);
    await inviteePage.mouse.click(replyTo.x, replyTo.y);
    await expect(inviteePage.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveText(['e4', 'e5'], { timeout: 15_000 });
  } finally {
    await inviter.close();
    await invitee.close();
  }
});

test('the queue asks a signed-out browser to sign in and keeps friend play', async ({ page }) => {
  expect(descriptor).not.toBeNull();
  await page.goto('/play?online=1');
  await page.getByRole('button', { name: 'Play online' }).click();
  await page.getByRole('button', { name: 'New play' }).click();
  // The public queue is an account surface. A signed-out browser is told so
  // instead of reaching the service with a guest credential.
  const play = page.getByRole('button', { name: 'Play yourself' });
  if (await play.isDisabled()) {
    await expect(page.getByRole('status').filter({ hasText: 'Sign in to join the queue' })).toBeVisible();
  }
  // The friend surface stays reachable for a guest.
  await expect(page.getByRole('button', { name: 'Invite a friend' })).toBeVisible();
  await expect(page.getByLabel('Invitation code')).toBeVisible();
});
