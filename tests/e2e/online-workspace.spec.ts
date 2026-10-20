import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/**
 * The online workspace (KHA-74, UX-03, UX-04).
 *
 * The build under test has no online service, so the online surfaces stay
 * closed. The test proves that the surface is reachable, that the closed
 * surfaces offer no entry, and that the offline game survives the visit.
 */
test('the online workspace is reachable and keeps the offline game intact', async ({ page }) => {
  await page.goto('/play?online=1');
  await expect(page.getByRole('region', { name: 'Chess match board' })).toBeVisible();
  await page.getByRole('button', { name: 'Online play' }).click();
  await expect(page.getByRole('region', { name: 'Online play' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New play' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Games' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Profile and history' })).toBeVisible();
  // The queue is closed, so the entry actions are unavailable.
  await page.getByRole('button', { name: 'New play' }).click();
  await expect(page.getByRole('button', { name: 'Play yourself' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Watch agent' })).toBeDisabled();
  // The offline game is untouched by the visit.
  await page.getByRole('button', { name: 'Close online play' }).click();
  await expect(page.getByRole('region', { name: 'Chess match board' })).toBeVisible();
});

test('the offline game never shows the online entry without the deliberate switch', async ({ page }) => {
  await page.goto('/play');
  await expect(page.getByRole('region', { name: 'Chess match board' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Online play' })).toHaveCount(0);
});

test('the online workspace fits a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/play?online=1');
  await page.getByRole('button', { name: 'Online play' }).click();
  await expect(page.getByRole('region', { name: 'Online play' })).toBeVisible();
  await expectNoOverflow(page);
  await page.getByRole('button', { name: 'Close online play' }).click();
  await expect(page.getByRole('region', { name: 'Chess match board' })).toBeVisible();
  await expectNoOverflow(page);
});

test('the online workspace actions keep an accessible name and a visible focus', async ({ page }) => {
  await page.goto('/play?online=1');
  await page.getByRole('button', { name: 'Online play' }).click();
  const newPlay = page.getByRole('button', { name: 'New play' });
  await expect(newPlay).toBeVisible();
  await expect(newPlay).toHaveAttribute('title', 'New play');
  await newPlay.focus();
  const outline = await newPlay.evaluate(element => {
    const style = getComputedStyle(element);
    return `${style.outlineStyle}:${style.outlineWidth}`;
  });
  expect(outline).not.toBe('none:0px');
});
