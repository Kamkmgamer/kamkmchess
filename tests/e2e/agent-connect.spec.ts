import { expect, test } from '@playwright/test';

test('the agent section gives a browser agent a ready prompt and follows the choices', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#agents');
  const section = page.getByRole('region', { name: /Play with your agent/ });
  await expect(section).toBeVisible();
  // Without the remote endpoint only the browser route is offered.
  await expect(section.getByRole('tab')).toHaveText(['Claude in Chrome']);
  await expect(section.getByText(/not switched on for this site yet/)).toBeVisible();

  await section.getByRole('button', { name: 'Black', exact: true }).click();
  await section.getByRole('button', { name: 'Strong', exact: true }).click();
  await section.getByRole('button', { name: 'Copy prompt' }).click();
  await expect(section.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('/play and play one game of chess');
  expect(copied).toContain('color: "black", engine_think_ms: 5000');

  await section.getByRole('button', { name: 'Me', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Strong', exact: true })).toBeHidden();
  await expect(section.locator('pre')).toContainText('opponent: "human"');

  await section.getByLabel('Let my agent ask me first').check();
  await expect(section.locator('pre')).toContainText('ask me whether I want to play you myself');
});

test('the sidebar links to the agent section', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('link', { name: 'Play with your agent' }).click();
  await expect(page).toHaveURL(/#agents$/);
});
