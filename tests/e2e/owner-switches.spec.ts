// The site owner opens and closes the online surfaces from the account panel.
//
// Runs against the real online fixture started with --owner-accounts naming
// the first fixture account, and with friend play and the queue configured
// off. Without a fixture, or with a fixture that names no owner, it skips.

import { expect, test } from '@playwright/test';
import { fixtureAccountId, signInWithFixtureAccount } from '../support/online-account-fixture';
import { openOnlineFixtureGate } from '../support/online-fixture-descriptor';
import type { OnlineFixtureDescriptor } from '../support/online-fixture-descriptor';

let descriptor: OnlineFixtureDescriptor | null = null;

test.beforeAll(async () => {
  const gate = await openOnlineFixtureGate({ reason: 'the owner switches need the real service' });
  if (gate.action === 'fail') throw new Error(gate.message);
  if (gate.action === 'skip') {
    test.skip(true, gate.message);
    return;
  }
  descriptor = gate.descriptor;
  // A fixture without owners does not mount the route at all.
  const route = await fetch(`${descriptor.baseUrl}/v1/account/online-switches`);
  test.skip(route.status === 404, 'the fixture names no owner account (--owner-accounts)');
});

async function features(baseUrl: string): Promise<unknown> {
  return (await fetch(`${baseUrl}/v1/online/features`)).json();
}

test('the owner opens the public queue from the account panel and nobody else can', async ({ page, browser }) => {
  if (!descriptor) throw new Error('no fixture');
  const { baseUrl } = descriptor;
  expect(await features(baseUrl)).toEqual({ friends: false, queue: false });

  await signInWithFixtureAccount(page, descriptor, fixtureAccountId(0));
  await page.goto('/play');
  await page.getByRole('button', { name: 'Account and saved games' }).click();
  const switches = page.getByRole('group', { name: 'Online play (site owner)' });
  await expect(switches).toBeVisible();
  const queue = switches.getByRole('checkbox', { name: 'Public queue' });
  await expect(queue).not.toBeChecked();
  await queue.check();
  await expect(switches.getByRole('status')).toHaveText('Saved. Reload the game to see the change.');
  await expect(switches.getByText('configured off')).toBeVisible();
  expect(await features(baseUrl)).toEqual({ friends: false, queue: true });

  // Another signed-in account never sees the controls.
  const other = await browser.newPage();
  await signInWithFixtureAccount(other, descriptor, fixtureAccountId(1));
  await other.goto('/play');
  await other.getByRole('button', { name: 'Account and saved games' }).click();
  await expect(other.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(other.getByRole('group', { name: 'Online play (site owner)' })).toHaveCount(0);
  await other.close();

  // Back to the configured state.
  await queue.uncheck();
  await expect(switches.getByRole('status')).toHaveText('Saved. Reload the game to see the change.');
  await expect(switches.getByText('configured off')).toHaveCount(0);
  expect(await features(baseUrl)).toEqual({ friends: false, queue: false });
});
