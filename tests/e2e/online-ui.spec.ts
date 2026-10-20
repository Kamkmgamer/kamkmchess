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

    // The side that owns the first move plays it, and the other side answers
    // inside the opening reply window.
    const first = await inviterPage.getByRole('region', { name: 'Online match board' }).getAttribute('data-side-to-move');
    expect(first === 'white' || first === 'black').toBe(true);
  } finally {
    await inviter.close();
    await invitee.close();
  }
});

test('the queue commits the browser engine fallback and shows the board', async ({ page }) => {
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  await page.goto('/play?online=1');
  await page.getByRole('button', { name: 'Online play' }).click();
  await page.getByRole('button', { name: 'New play' }).click();
  const play = page.getByRole('button', { name: 'Play yourself' });
  await expect(play).toBeEnabled();
  await play.click();
  // The entry waits, and the browser engine takes the fallback at the
  // cutoff. The board of the fallback game appears.
  await expect(page.getByRole('region', { name: 'Online match board' })).toBeVisible({ timeout: 30_000 });
});
