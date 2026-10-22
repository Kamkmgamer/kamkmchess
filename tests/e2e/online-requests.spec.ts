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
// The run needs the real service.
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
import { openOnlineFixtureGate } from '../support/online-fixture-descriptor';
import type { OnlineFixtureDescriptor } from '../support/online-fixture-descriptor';

let descriptor: OnlineFixtureDescriptor | null = null;

test.beforeAll(async () => {
  const gate = await openOnlineFixtureGate({
    reason: 'the rendered request cases need the real service',
  });
  if (gate.action === 'fail') {
    // A missing descriptor fails a strict run, and a descriptor the caller
    // supplied that cannot be used fails every run.
    throw new Error(gate.message);
  }
  if (gate.action === 'skip') {
    // The run had no fixture. The cases skip and the reason of the skip is
    // printed, so the report never reads as online fixture coverage.
    console.log(`[online-fixture] tests/e2e/online-requests.spec.ts: ${gate.message}`);
    test.skip(true, gate.message);
    return;
  }
  descriptor = gate.descriptor;
});

test('the invitation of a published link is previewed and the screen stays usable', async ({ page }) => {
  expect(descriptor).not.toBeNull();
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

test('two clicks in the same tick start one request', async ({ page, browser }) => {
  expect(descriptor).not.toBeNull();
  const inviter = await page.context().newPage();
  await inviter.goto('/play?online=1');
  await inviter.getByRole('button', { name: 'Online play' }).click();
  await inviter.getByRole('button', { name: 'New play' }).click();
  await inviter.getByRole('button', { name: 'Invite a friend' }).click();
  const link = await inviter.getByLabel('Invitation link').inputValue();
  const invitationId = link.split('/invite/')[1] ?? '';

  // The other guest has its own storage. Sharing the inviter's context also
  // shares its owner token and starts the owner's invitation polling here.
  const guest = await browser.newPage({ baseURL: new URL(inviter.url()).origin });
  try {
    let previews = 0;
    guest.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes(`/v1/online/invitations/${invitationId}`)) previews += 1;
    });
    await guest.goto(`/invite/${invitationId}`);
    await expect(guest.getByLabel('Invitation code')).toHaveValue(invitationId);
    const preview = guest.getByRole('button', { name: 'Preview' });
    await expect(preview).toBeEnabled();
    const afterMount = previews;
    let releaseResponse: () => void = () => undefined;
    const heldResponse = new Promise<void>(resolve => { releaseResponse = resolve; });
    // Forward to the real service, but keep its answer pending until both
    // clicks have run. A fast answer must not turn the second click into a new
    // operation after the first has already finished.
    await guest.route(`**/v1/online/invitations/${invitationId}`, async route => {
      const response = await route.fetch();
      await heldResponse;
      await route.fulfill({ response });
    });
    try {
      await preview.evaluate(button => {
        if (!(button instanceof HTMLButtonElement)) throw new Error('Preview is not a button');
        button.click();
        button.click();
      });
      await expect.poll(() => previews - afterMount).toBe(1);
      await expect(preview).toBeDisabled();
    } finally {
      releaseResponse();
    }
    await expect(preview).toBeEnabled();
    expect(previews - afterMount).toBe(1);
    // Finishing the first operation releases ownership for a later click.
    await preview.click();
    await expect.poll(() => previews - afterMount).toBe(2);
    await expect(preview).toBeEnabled();
  } finally {
    await guest.close();
  }
});
