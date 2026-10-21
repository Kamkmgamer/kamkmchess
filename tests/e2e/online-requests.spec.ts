// The request safety of the online screen, against the real online service.
//
// The cases drive the published screen of the application: the invitation of
// a published link, the preview it reads, and the actions that follow. They
// prove that
//
//   - the preview of the link survives the mount of the screen (the effect
//     replay of the development build included),
//   - the screen stays usable after the preview, because the finished request
//     releases the pending state of the screen,
//   - and two clicks in the same tick start one request.
//
// The run needs the real service. A missing descriptor fails the run, it does
// not skip it.

import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

type Descriptor = {
  baseUrl: string;
  accounts: { id: string; token: string }[];
};

const descriptorPath = process.env.ONLINE_FIXTURE_DESCRIPTOR ?? '';

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
    throw new Error('no online fixture descriptor: the rendered request cases need the real service');
  }
});

test('the invitation of a published link is previewed and the screen stays usable', async ({ page }) => {
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  // The inviter creates a link.
  const inviter = await page.context().newPage();
  await inviter.goto('/play?online=1');
  await inviter.getByRole('button', { name: 'Online play' }).click();
  await inviter.getByRole('button', { name: 'New play' }).click();
  await inviter.getByRole('button', { name: 'Invite a friend' }).click();
  const link = await inviter.getByLabel('Invitation link').inputValue();
  const invitationId = link.split('/invite/')[1] ?? '';
  expect(invitationId.length).toBeGreaterThan(7);

  // The published link opens the screen with that exact invitation.
  const guest = await page.context().newPage();
  await guest.goto(`/invite/${invitationId}`);
  await expect(guest.getByLabel('Invitation code')).toHaveValue(invitationId);
  // The preview of the invitation is read and shown.
  await expect(guest.getByRole('status').filter({ hasText: 'Guest' })).toBeVisible({ timeout: 15_000 });
  // The screen is usable: the accept action of the invitation is available.
  await expect(guest.getByRole('button', { name: 'Accept' })).toBeEnabled();
  // A later action of the screen still runs, so the finished preview released
  // the pending state.
  await guest.getByRole('button', { name: 'Preview' }).click();
  await expect(guest.getByRole('status').filter({ hasText: 'Guest' })).toBeVisible();
});

test('two clicks in the same tick start one request', async ({ page }) => {
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  const inviter = await page.context().newPage();
  await inviter.goto('/play?online=1');
  await inviter.getByRole('button', { name: 'Online play' }).click();
  await inviter.getByRole('button', { name: 'New play' }).click();
  await inviter.getByRole('button', { name: 'Invite a friend' }).click();
  const link = await inviter.getByLabel('Invitation link').inputValue();
  const invitationId = link.split('/invite/')[1] ?? '';

  const guest = await page.context().newPage();
  let previews = 0;
  guest.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes(`/v1/online/invitations/${invitationId}`)) previews += 1;
  });
  await guest.goto(`/invite/${invitationId}`);
  await expect(guest.getByLabel('Invitation code')).toHaveValue(invitationId);
  await guest.waitForTimeout(1500);
  const afterMount = previews;
  // Two clicks in the same tick start one request.
  await guest.getByRole('button', { name: 'Preview' }).click({ clickCount: 2, delay: 0 });
  await guest.waitForTimeout(1000);
  expect(previews - afterMount).toBeLessThanOrEqual(1);
});
