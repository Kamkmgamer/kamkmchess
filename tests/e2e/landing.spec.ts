import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  const configuration = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] };
  const csp = configuration.headers[0]!.headers.find(header => header.key === 'Content-Security-Policy')!.value;
  await page.route(/http:\/\/127\.0\.0\.1:5175\/(?:play\/?)?$/, async route => {
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
    await page.locator('.hero-introduction [data-slot="button"]').click();
    await expect(page).toHaveURL(/\/play$/, { timeout: 2000 });
    await expect(page.locator('body')).not.toHaveClass(/quartz/);
    await page.getByRole('button', { name: 'New game', exact: true }).click();
    await page.getByLabel('Game mode').selectOption('local');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Start game', exact: true }).click();
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

test('the mobile preview stays local and navigation opens the full workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const providerCalls: string[] = [];
  page.on('request', request => { if (request.url().includes('/v1/')) providerCalls.push(request.url()); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Next move', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'White plays e4' })).toBeVisible();
  await page.getByRole('button', { name: 'Board options', exact: true }).click();
  await page.getByLabel('Opponent label').fill('My model');
  await page.getByRole('radio', { name: 'Black', exact: true }).click();
  await page.getByRole('button', { name: 'Update board preview', exact: true }).click();
  await expect(page.getByText('You play Black', { exact: true })).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:5175/');
  expect(providerCalls).toEqual([]);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Play against AI', exact: true }).click();
  await expect(page).toHaveURL(/\/play$/);
  await expect(page.getByRole('button', { name: 'New game', exact: true })).toBeVisible();
});
