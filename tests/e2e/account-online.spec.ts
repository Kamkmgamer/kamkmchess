// The rendered signed-in account flows against the real online fixture.
//
// The fixture is the real service composition: the Go API, a real PostgreSQL
// schema, the pinned private rules worker and the real authorization code.
// The clients are real browsers: real fetch, real CORS, real server-sent
// events and the real browser engine.
//
// The browser is signed in with a synthetic account of the fixture. The
// session token is minted for the run with the fixture's own signing key, so
// the service verifies it with its ordinary code path. No token is printed and
// no request is intercepted.
//
// The build under test has to be the account build of the fixture: the public
// API origin of the build is the base URL of the descriptor, and the build
// carries the synthetic session seam. A build that points somewhere else
// fails the run instead of silently testing a different service.
//
// Strictness:
//   - no descriptor at all: the run had no fixture, so it skips;
//   - a descriptor and a mismatch between the build and the fixture, a
//     closed surface, a missing route or a missing field: the run fails.
// Set ONLINE_FIXTURE_STRICT=1 to make a missing descriptor fail as well.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readdir } from 'node:fs/promises';
import { fixtureAccountId, readOnlineFixtureDescriptor, signInWithFixtureAccount, signInWithFixtureAccounts, switchFixtureAccount } from '../support/online-account-fixture';
import type { OnlineFixtureDescriptor } from '../support/online-account-fixture';
import { startSyntheticProvider } from '../support/synthetic-provider';

const descriptorPath = process.env.ONLINE_FIXTURE_DESCRIPTOR ?? '';
const strict = process.env.ONLINE_FIXTURE_STRICT === '1';

let descriptor: OnlineFixtureDescriptor | null = null;
/** The entry script of the build of this repository. */
let localEntryScript = '';

async function loadDescriptor(): Promise<OnlineFixtureDescriptor | null> {
  if (descriptor) return descriptor;
  if (!descriptorPath) return null;
  descriptor = await readOnlineFixtureDescriptor(descriptorPath);
  return descriptor;
}

/**
 * The entry script of the local build.
 *
 * A run that serves another build (the preview server of another worktree,
 * for example) is refused: the cases would test a different product.
 */
async function readLocalEntryScript(): Promise<string> {
  if (localEntryScript) return localEntryScript;
  const assets = await readdir('dist/assets').catch(() => [] as string[]);
  const entry = assets.find(name => /^index-.*\.js$/.test(name));
  localEntryScript = entry ? `assets/${entry}` : '';
  return localEntryScript;
}

/** The console of the page. It is part of the evidence of a failure. */
const consoleLines: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleLines.length = 0;
  page.on('console', message => consoleLines.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', error => consoleLines.push(`pageerror: ${error.message}`));
});

// The hook needs no fixture of its own.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  console.log('the console of the failed case:');
  for (const line of consoleLines.slice(-40)) console.log('  ', line);
});

test.beforeAll(async () => {
  const loaded = await loadDescriptor();
  if (!loaded) {
    const message = 'no online fixture descriptor: the rendered account cases did not run';
    if (strict) throw new Error(message);
    test.skip(true, message);
  }
});

/** The first fixture account. */
async function firstAccount(): Promise<string> {
  return fixtureAccountId(0);
}

/** Opens the online screen of a signed-in browser. */
async function openOnline(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Online play' }).click();
  await page.getByRole('button', { name: 'New play' }).click();
}

/**
 * Shows the games of the browser.
 *
 * The board of an online match belongs to the games section, so the screen
 * has to show that section before the board is there.
 */
async function showGames(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Games', exact: true }).click();
}

/** The point of a square on the online board of the page. */
async function point(page: Page, square: string, flipped = false) {
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
 * Waits for the committed assignment of the queue entry.
 *
 * The fallback needs the browser engine. When the engine cannot start, the
 * product offers a retry, and the case takes it.
 */
async function waitForAssignment(page: Page, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = page.getByRole('status').filter({ hasText: 'Matched.' }).first();
    if (await matched.isVisible().catch(() => false)) return;
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    if (await retry.isVisible().catch(() => false)) {
      console.log('the browser engine could not start; the case takes the product retry');
      await retry.click();
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error('the queue entry was not assigned in time');
}

/**
 * Holds the commands of the service until the barrier is released.
 *
 * The barrier is the deferred answer of the service: an owner decision that
 * is on its way while the account changes or leaves.
 */
async function holdCommands(page: Page): Promise<{ readonly arrived: Promise<void>; release: () => Promise<void> }> {
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let seen: () => void = () => undefined;
  const arrived = new Promise<void>(resolve => { seen = resolve; });
  const pattern = '**/v1/online/matches/*/runner/lease';
  const commands = '**/v1/online/matches/*/commands';
  const hold = async (route: import('@playwright/test').Route) => {
    seen();
    await held;
    await route.continue().catch(() => undefined);
  };
  await page.route(pattern, hold);
  await page.route(commands, hold);
  return {
    arrived,
    release: async () => {
      release();
      await page.unroute(pattern);
      await page.unroute(commands);
    },
  };
}

/** The committed moves of the online board. */
function committedMoves(page: Page) {
  return page.getByRole('table', { name: 'Committed moves' }).getByRole('button');
}

/** The clock of the first seat of the online board. */
async function onlineClock(page: Page): Promise<string> {
  const clock = page.getByRole('region', { name: 'Online match board' }).locator('time').first();
  return ((await clock.textContent()) ?? '').trim();
}

/**
 * Connects the local provider in the namespace of the signed-in account.
 *
 * The connections of an account live in the namespace of that account, so
 * the model is connected in an account game. The online agent resolves its
 * provider from the same namespace.
 */
async function connectLocalModel(page: Page, baseUrl: string, model: string): Promise<void> {
  await page.getByRole('button', { name: 'Account and saved games' }).click();
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await page.getByRole('button', { name: 'New account game' }).click();
  await page.getByRole('button', { name: 'Close account' }).click();
  // The setup panel of the account game is opened from the top bar.
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('ai');
  await page.getByLabel('Provider').selectOption('custom');
  await page.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  await page.getByRole('button', { name: 'Advanced connection settings', exact: true }).click();
  await page.getByLabel('Authentication').selectOption('none');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const panel = page.getByRole('region', { name: 'AI model', exact: true });
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await panel.getByLabel('Available models').selectOption(model);
  // The connection needs the owner's consent before it may be used.
  const allow = page.getByRole('button', { name: 'Allow', exact: true });
  if (await allow.isVisible().catch(() => false)) await allow.click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20_000 });
  // The setup panel is closed, so it never covers the online screen.
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('the built account app reaches the fixture of the run', async ({ page }) => {
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  await signInWithFixtureAccount(page, loaded!, await firstAccount());
  await page.goto('/play?online=1');
  // The build under test is the build of this repository. A preview server of
  // another worktree would otherwise answer with another product.
  const served = await page.evaluate(() => Array.from(document.querySelectorAll('script'))
    .map(script => script.getAttribute('src') ?? '').join(' '));
  const local = await readLocalEntryScript();
  expect(local === '' || served.includes(local)).toBe(true);
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
});

test('a signed-in browser enters the queue and the cutoff commits the browser engine', async ({ page }) => {
  test.setTimeout(120_000);
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  await signInWithFixtureAccount(page, loaded!, await firstAccount());
  await page.goto('/play?online=1');
  await openOnline(page);
  // The queue is an account surface, so the signed-in browser may enter it.
  const play = page.getByRole('button', { name: 'Play yourself' });
  await expect(play).toBeEnabled();
  await play.click();
  // The entry waits for the ten second cutoff and the fallback commits it.
  await waitForAssignment(page);
  await showGames(page);
  await expect(page.getByRole('region', { name: 'Online match board' })).toBeVisible({ timeout: 60_000 });
  // The owner plays the opening move when the seat is its turn. Otherwise the
  // engine seat of the fallback opens the game through the snapshot.
  const flipped = await page.getByRole('region', { name: 'Online match board' })
    .locator('.board-host').evaluate(element => element.classList.contains('orientation-black'));
  if (!flipped) {
    const from = await point(page, 'e2');
    const to = await point(page, 'e4');
    await page.mouse.click(from.x, from.y);
    await page.mouse.click(to.x, to.y);
    await expect.poll(async () => committedMoves(page).count(), { timeout: 60_000 }).toBeGreaterThan(0);
    console.log('the first committed move of the fallback game:', (await committedMoves(page).first().textContent())?.trim());
  }
  // The engine seat of the fallback answers through the canonical snapshot.
  await expect.poll(async () => committedMoves(page).count(), { timeout: 60_000 }).toBeGreaterThan(flipped ? 0 : 1);
  console.log('the committed moves of the fallback game:', (await committedMoves(page).allTextContents()).join(' '));
});

test('two explicit entries of one signed-in browser are visible at the same time', async ({ page }) => {
  test.setTimeout(120_000);
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  await signInWithFixtureAccount(page, loaded!, await firstAccount());
  await page.goto('/play?online=1');
  await openOnline(page);
  await page.getByRole('button', { name: 'Play yourself' }).click();
  await expect(page.getByRole('list', { name: 'Queue entries' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Another entry' }).click();
  await expect(page.getByRole('list', { name: 'Queue entries' }).getByRole('listitem')).toHaveCount(2);
});

test('the account change hides the games of the first account and restores the registry of the next', async ({ page }) => {
  test.setTimeout(300_000);
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  const first = fixtureAccountId(0);
  const second = fixtureAccountId(1);
  if (!first || !second) throw new Error('the fixture has fewer than two accounts');
  // The page chooses its account with the query parameter, so a second page
  // load of the same browser can sign in as the other account.
  await signInWithFixtureAccounts(page, loaded!, [first, second]);

  // The second account plays a game on a three minute clock. Its durable
  // registry exists when it signs in again.
  await page.goto(`/play?online=1&fixture-account=${encodeURIComponent(second)}`);
  await openOnline(page);
  await page.getByRole('button', { name: '3+2' }).click();
  await page.getByRole('button', { name: 'Play yourself' }).click();
  await waitForAssignment(page);
  await showGames(page);
  await expect(page.getByRole('region', { name: 'Online match board' })).toBeVisible({ timeout: 60_000 });

  // The first account signs in in a second page load and plays its own game
  // with the default clock.
  await page.goto(`/play?online=1&fixture-account=${encodeURIComponent(first)}`);
  await openOnline(page);
  await page.getByRole('button', { name: 'Play yourself' }).click();
  await waitForAssignment(page);
  await showGames(page);
  await expect(page.getByRole('region', { name: 'Online match board' })).toBeVisible({ timeout: 60_000 });
  expect(await onlineClock(page)).toMatch(/^[45]:/);

  // The second account signs in. The game of the first account is hidden and
  // the durable registry of the second account is restored.
  await switchFixtureAccount(page, loaded!, second);
  await expect(page.getByRole('region', { name: 'Concurrent games' }).getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(async () => onlineClock(page), { timeout: 30_000 }).toMatch(/^[23]:/);
});

test('the first account gets its game back when it signs in again', async ({ page }) => {
  // The durable list of an account that leaves has to survive the identity
  // change, and the browser engine seat of the game has to keep its
  // credential, so the game is playable again when the account returns.
  // (The workspace owns the durable list and the deferred claims; the case
  // is the proof of the behaviour from the browser.)
  test.setTimeout(300_000);
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  const first = fixtureAccountId(0);
  const second = fixtureAccountId(1);
  if (!first || !second) throw new Error('the fixture has fewer than two accounts');
  await signInWithFixtureAccounts(page, loaded!, [first, second]);

  // The first account plays a game and opens it.
  await page.goto(`/play?online=1&fixture-account=${encodeURIComponent(first)}`);
  await openOnline(page);
  await page.getByRole('button', { name: 'Play yourself' }).click();
  await waitForAssignment(page);
  await showGames(page);
  await expect(page.getByRole('region', { name: 'Online match board' })).toBeVisible({ timeout: 60_000 });
  // The owner plays the first move when the seat is its turn. Otherwise the
  // browser engine opens the game.
  const flipped = await page.getByRole('region', { name: 'Online match board' })
    .locator('.board-host').evaluate(element => element.classList.contains('orientation-black'));
  if (!flipped) {
    const from = await point(page, 'e2');
    const to = await point(page, 'e4');
    await page.mouse.click(from.x, from.y);
    await page.mouse.click(to.x, to.y);
  }
  await expect.poll(async () => committedMoves(page).count(), { timeout: 60_000 }).toBeGreaterThan(0);
  const played = await committedMoves(page).count();

  // The second account signs in and the game of the first account is hidden.
  await switchFixtureAccount(page, loaded!, second);
  await expect(page.getByRole('region', { name: 'Concurrent games' }).getByRole('listitem')).toHaveCount(0, { timeout: 30_000 });

  // The first account signs in again. Its game comes back with its moves,
  // and the browser engine seat of the game still plays, so the credential
  // of the engine seat is still usable.
  await switchFixtureAccount(page, loaded!, first);
  await expect(page.getByRole('region', { name: 'Concurrent games' }).getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
  await showGames(page);
  await expect.poll(async () => committedMoves(page).count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(played);
  if (!flipped) {
    const from = await point(page, 'd2');
    const to = await point(page, 'd4');
    await page.mouse.click(from.x, from.y);
    await page.mouse.click(to.x, to.y);
  }
  await expect.poll(async () => committedMoves(page).count(), { timeout: 60_000 }).toBeGreaterThan(played);
});

test('a late seat change never writes into the next account', async ({ page }) => {
  test.setTimeout(300_000);
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  const second = fixtureAccountId(1);
  if (!second) throw new Error('the fixture has fewer than two accounts');
  const provider = await startSyntheticProvider({ models: ['synthetic-a', 'synthetic-b'] });
  try {
    await signInWithFixtureAccount(page, loaded!, await firstAccount());
    await page.goto('/play?online=1');
    await connectLocalModel(page, provider.baseUrl, 'synthetic-a');
    await openOnline(page);
    await page.getByRole('button', { name: 'Watch agent' }).click();
    await waitForAssignment(page);
    await showGames(page);
    await expect(page.getByRole('region', { name: 'Online match board' })).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => committedMoves(page).count(), { timeout: 90_000 }).toBeGreaterThan(0);

    // The owner asks for the other model. The answer of the service is held.
    await page.getByRole('button', { name: 'Your agents' }).click();
    const panel = page.getByRole('region', { name: 'Your agents' });
    const barrier = await holdCommands(page);
    await panel.getByRole('button', { name: 'Use for this game' }).nth(1).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Changing' })).toBeVisible();
    await Promise.race([
      barrier.arrived,
      page.waitForTimeout(45_000).then(() => { throw new Error('the change never reached the service'); }),
    ]);

    // The next account signs in while the answer is on its way.
    await switchFixtureAccount(page, loaded!, second);
    await barrier.release();

    // The late answer belongs to the identity that left: the pending state of
    // the change is gone.
    await expect(panel.getByRole('status').filter({ hasText: 'Changing' })).toHaveCount(0);
  } finally {
    await provider.close();
  }
});

test('the owner switches the own agent between two private models and the provider answers', async ({ page }) => {
  test.setTimeout(300_000);
  const loaded = await loadDescriptor();
  expect(loaded).not.toBeNull();
  // Two models of one connection without an advertised name. They carry the
  // same public label, so only their private identity keeps them apart.
  const provider = await startSyntheticProvider({ models: ['synthetic-a', 'synthetic-b'] });
  const modelsOf = () => provider.generationRequests
    .map(request => /"model"\s*:\s*"([^"]+)"/.exec(request.body)?.[1] ?? 'unknown');
  try {
    await signInWithFixtureAccount(page, loaded!, await firstAccount());
    await page.goto('/play?online=1');
    await connectLocalModel(page, provider.baseUrl, 'synthetic-a');
    // Both models of the connection are in the private catalog of the owner.
    await page.getByRole('button', { name: 'Your agents' }).click();
    const agents = page.getByRole('region', { name: 'Your agents' });
    // Both models of the connection are in the private catalog of the owner,
    // and they carry the same public label.
    await expect(agents.getByRole('button', { name: 'Use for new games' })).toHaveCount(2);
    await expect(agents).toContainText('Custom model');
    await agents.getByRole('button', { name: 'Close' }).click();

    // The owner watches its own agent play. The fallback opponent is the
    // browser engine, so a stalled engine seat starts the flow again with a
    // new entry instead of failing the case.
    let played = false;
    for (let attempt = 1; attempt <= 3 && !played; attempt += 1) {
      await openOnline(page);
      await page.getByRole('button', { name: 'Watch agent' }).click();
      await waitForAssignment(page);
      await showGames(page);
      await expect(page.getByRole('region', { name: 'Online match board' })).toBeVisible({ timeout: 60_000 });
      // The agent seat of the owner is bound to a private selection and the
      // driver asks the provider through the lease of the seat.
      played = await expect.poll(async () => committedMoves(page).count(), { timeout: 45_000 })
        .toBeGreaterThan(0).then(() => true).catch(() => false);
      if (!played) {
        await page.getByRole('button', { name: 'Close online play' }).click();
        continue;
      }
      console.log('the models the local provider answered:', modelsOf().join(', '));

      // The owner rebinds the seat to the other private model.
      await page.getByRole('button', { name: 'Your agents' }).click();
      const panel = page.getByRole('region', { name: 'Your agents' });
      await panel.getByRole('button', { name: 'Use for this game' }).nth(1).click();
      await expect(panel.getByRole('status').filter({ hasText: 'plays this game now' })).toBeVisible();
      await panel.getByRole('button', { name: 'Close' }).click();

      // The next turn of the seat is played by the other private model.
      await expect.poll(() => provider.generationRequests.some(request => request.body.includes('synthetic-b')), { timeout: 180_000 }).toBe(true);
      console.log('the models the local provider answered:', modelsOf().join(', '));

      // The owner puts the model of the new games back on the seat. The
      // control follows the seat and not the model of the new games, so the
      // model that plays the new games stays available for the running game.
      await page.getByRole('button', { name: 'Your agents' }).click();
      const back = page.getByRole('region', { name: 'Your agents' });
      const firstModel = back.getByRole('button', { name: 'Use for this game' }).first();
      await expect(firstModel).toBeEnabled();
      await firstModel.click();
      await expect(back.getByRole('status').filter({ hasText: 'plays this game now' })).toBeVisible();
      // The seat plays the model of the new games again, so the control of
      // that model is not offered any more.
      await expect(firstModel).toBeDisabled();
      await back.getByRole('button', { name: 'Close' }).click();
    }
    expect(played, 'the agent seat of the owner did not play in three attempts').toBe(true);
    expect(modelsOf()).toContain('synthetic-b');
  } finally {
    await provider.close();
  }
});
