import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page, baseURL }) => {
  const configuration = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] };
  const csp = configuration.headers[0]!.headers.find(header => header.key === 'Content-Security-Policy')!.value;
  await page.route(url => url.origin === new URL(baseURL!).origin && /^\/(?:play\/?)?$/.test(url.pathname), async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': csp } });
  });
});

for (const [device, viewport] of [
  ['desktop', { width: 1280, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
] as const) {
  test(`${device} homepage starts a playable game and restores moves after reload`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Chess against a');
    await page.screenshot({ path: testInfo.outputPath(`homepage-${device}.png`) });
    await page.locator('#opening-preview').getByRole('button', { name: 'Pause game', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`demo-${device}.png`), fullPage: true });
    await page.goto('/');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.locator('.hero-introduction [data-slot="button"]').click();
    await expect(page.locator('.right-game-sidebar')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await page.getByLabel('Game mode').selectOption('local');
    await page.getByRole('button', { name: 'Start game', exact: true }).click();
    await expect(page).toHaveURL(/\/play$/);
    await expect(page.locator('body')).not.toHaveClass(/quartz/);
    for (const move of ['e2e4', 'e7e5']) {
      await page.getByRole('button', { name: 'Type a move', exact: true }).click();
      await page.getByLabel('Enter a move by coordinates', { exact: true }).fill(move);
      await page.getByRole('button', { name: 'Play move', exact: true }).click();
    }
    const moves = page.getByRole('table', { name: 'Committed moves' }).getByRole('button');
    await expect(moves).toHaveText(['e4', 'e5']);
    await page.reload();
    await expect(moves).toHaveText(['e4', 'e5']);
    await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`game-${device}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('the mobile demo autoplays locally and navigation opens real game options', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const providerCalls: string[] = [];
  page.on('request', request => { if (request.url().includes('/v1/')) providerCalls.push(request.url()); });
  await page.goto('/');
  const preview = page.locator('#opening-preview');
  await expect(preview.getByAltText('Stockfish logo')).toBeVisible();
  await expect(preview.getByAltText('ChatGPT logo')).toBeVisible();
  await expect.poll(async () => Number((await preview.locator('.move-count').innerText()).split(' ')[0])).toBeGreaterThan(6);
  await preview.getByRole('button', { name: 'Pause game', exact: true }).click();
  const pausedCount = await preview.locator('.move-count').innerText();
  await page.waitForTimeout(750);
  await expect(preview.locator('.move-count')).toHaveText(pausedCount);
  await preview.getByRole('button', { name: 'Resume game', exact: true }).click();
  await expect(preview.locator('.move-count')).not.toHaveText(pausedCount);
  await preview.getByRole('button', { name: 'Restart game', exact: true }).click();
  await preview.getByRole('button', { name: 'Pause game', exact: true }).click();
  expect(Number((await preview.locator('.move-count').innerText()).split(' ')[0])).toBeLessThan(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Board options', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Visual starting position board' })).toBeVisible();
  await page.getByLabel('Custom starting position (six-field FEN)').fill('4k3/8/8/8/8/8/8/4K2R w - - 0 1');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  expect(providerCalls).toEqual([]);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'AI opponent', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('local');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page).toHaveURL(/\/play$/);
  await expect(page.getByRole('button', { name: 'New game', exact: true })).toBeVisible();
});
