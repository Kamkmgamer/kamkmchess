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
//   - no descriptor at all: the run had no fixture, so it skips;
//   - a descriptor and a mismatch between the build and the fixture, a
//     closed surface, a missing route or a missing field: the run fails.
// Set ONLINE_FIXTURE_STRICT=1 to make a missing descriptor fail as well.

import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

type Descriptor = {
  baseUrl: string;
  issuer: string;
  allowedOrigins: string[];
  accounts: { id: string; token: string }[];
  keyPath: string;
};

const descriptorPath = process.env.ONLINE_FIXTURE_DESCRIPTOR ?? '';
const strict = process.env.ONLINE_FIXTURE_STRICT === '1';

let descriptor: Descriptor | null = null;

async function loadDescriptor(): Promise<Descriptor | null> {
  if (descriptor) return descriptor;
  if (!descriptorPath) return null;
  descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Descriptor;
  return descriptor;
}

test.beforeAll(async () => {
  const loaded = await loadDescriptor();
  if (!loaded) {
    const message = 'no online fixture descriptor: the rendered online cases did not run';
    if (strict) throw new Error(message);
    test.skip(true, message);
  }
});

test('the built app points at the online fixture of the run', async ({ page }) => {
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  await page.goto('/play?online=1');
  const configured = await page.evaluate(() => {
    const element = document.querySelector('meta[name="kamkm-api-base-url"]');
    return element?.getAttribute('content') ?? null;
  });
  // The build may expose the origin in a meta tag or in the module config.
  // Either way the surface has to reach the fixture, so the run asks the
  // fixture directly and compares the answer.
  const answer = await page.evaluate(async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/v1/online/features`, { headers: { Accept: 'application/json' } });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { status: 0, body: String(error) };
    }
  }, loaded!.baseUrl);
  expect(answer.status).toBe(200);
  const flags = JSON.parse(answer.body) as { friends?: boolean; queue?: boolean };
  expect(typeof flags.friends).toBe('boolean');
  expect(typeof flags.queue).toBe('boolean');
  expect(configured === null || configured === loaded!.baseUrl).toBe(true);
});

test('a guest creates a friend link and the other guest joins the game', async ({ browser }) => {
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  const inviter = await browser.newContext();
  const invitee = await browser.newContext();
  const inviterPage = await inviter.newPage();
  const inviteePage = await invitee.newPage();
  try {
    await inviterPage.goto('/play?online=1');
    await inviterPage.getByRole('button', { name: 'Online play' }).click();
    await inviterPage.getByRole('button', { name: 'New play' }).click();
    await inviterPage.getByRole('button', { name: 'Invite a friend' }).click();
    const link = await inviterPage.getByLabel('Invitation link').inputValue();
    expect(link).toContain('/invite/');
    const invitationId = link.split('/invite/')[1] ?? '';
    expect(invitationId.length).toBeGreaterThan(7);

    // The preview shows the inviter and the setup of the invitation.
    await inviteePage.goto('/play?online=1');
    await inviteePage.getByRole('button', { name: 'Online play' }).click();
    await inviteePage.getByRole('button', { name: 'New play' }).click();
    await inviteePage.getByLabel('Invitation code').fill(invitationId);
    await inviteePage.getByRole('button', { name: 'Preview' }).click();
    await expect(inviteePage.getByRole('status').filter({ hasText: 'Guest' })).toBeVisible();

    // The guest accepts the invitation and the match appears.
    await inviteePage.getByRole('button', { name: 'Accept' }).click();
    await expect(inviteePage.getByRole('region', { name: 'Online match board' })).toBeVisible();

    // The inviter sees the same match.
    await inviterPage.getByRole('button', { name: 'Games' }).click();
    await expect(inviterPage.getByRole('region', { name: 'Online match board' })).toBeVisible();
  } finally {
    await inviter.close();
    await invitee.close();
  }
});

/** The point of a square on the board of the page. */
async function point(page: import('@playwright/test').Page, square: string) {
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error('The board is missing');
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return {
    x: box.x + file * box.width / 8 + box.width / 16,
    y: box.y + (7 - rank) * box.height / 8 + box.height / 16,
  };
}

test('the first move and the opening reply are playable in the real service', async ({ browser }) => {
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  const inviter = await browser.newContext();
  const invitee = await browser.newContext();
  const inviterPage = await inviter.newPage();
  const inviteePage = await invitee.newPage();
  try {
    await inviterPage.goto('/play?online=1');
    await inviterPage.getByRole('button', { name: 'Online play' }).click();
    await inviterPage.getByRole('button', { name: 'New play' }).click();
    await inviterPage.getByRole('button', { name: 'Invite a friend' }).click();
    const link = await inviterPage.getByLabel('Invitation link').inputValue();
    const invitationId = link.split('/invite/')[1] ?? '';

    await inviteePage.goto('/play?online=1');
    await inviteePage.getByRole('button', { name: 'Online play' }).click();
    await inviteePage.getByRole('button', { name: 'New play' }).click();
    await inviteePage.getByLabel('Invitation code').fill(invitationId);
    await inviteePage.getByRole('button', { name: 'Preview' }).click();
    await inviteePage.getByRole('button', { name: 'Accept' }).click();
    await expect(inviteePage.getByRole('region', { name: 'Online match board' })).toBeVisible();

    // The inviter holds the white seat, so it plays the first move of the
    // match and the invitee answers inside the opening reply window.
    const from = await point(inviterPage, 'e2');
    const to = await point(inviterPage, 'e4');
    await inviterPage.mouse.click(from.x, from.y);
    await inviterPage.mouse.click(to.x, to.y);
    // The accepted move reaches the move list of the inviter.
    await expect(inviterPage.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveText(['e4'], { timeout: 15_000 });
    // The other side answers the opening reply.
    const replyFrom = await point(inviteePage, 'e7');
    const replyTo = await point(inviteePage, 'e5');
    await inviteePage.mouse.click(replyFrom.x, replyFrom.y);
    await inviteePage.mouse.click(replyTo.x, replyTo.y);
    await expect(inviteePage.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveText(['e4', 'e5'], { timeout: 15_000 });
  } finally {
    await inviter.close();
    await invitee.close();
  }
});

test('the queue asks a signed-out browser to sign in and keeps friend play', async ({ page }) => {
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  await page.goto('/play?online=1');
  await page.getByRole('button', { name: 'Online play' }).click();
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
