import { expect, test } from '@playwright/test';

test('the agent section offers every MCP client and follows the choices', async ({ page }) => {
  await page.goto('/#agents');
  const section = page.getByRole('region', { name: /Play with your agent/ });
  await expect(section).toBeVisible();
  await expect(section.getByRole('tab')).toHaveText(['Claude Code', 'Codex', 'claude.ai', 'ChatGPT', 'Cursor / any MCP']);
  // The preview build has no service origin: MCP reports unavailable and no steps render.
  await expect(section.getByText(/MCP server is currently unavailable/)).toBeVisible();
  await expect(section.locator('.agent-steps li')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Copy prompt' })).toHaveCount(0);

  await section.getByRole('tab', { name: 'Codex' }).click();
  await expect(section.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true');

  // Opponent choices still shape the setup: shared games hide the Stockfish level.
  await expect(section.getByRole('button', { name: 'Club', exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Another agent', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Club', exact: true })).toBeHidden();

  await section.getByLabel('Let my agent ask me first').check();
  await expect(section.getByRole('button', { name: 'White', exact: true })).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Another agent', exact: true })).toBeDisabled();
});

test('the sidebar links to the agent section', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('link', { name: 'Play with your agent' }).click();
  await expect(page).toHaveURL(/#agents$/);
});
