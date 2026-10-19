import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Chess } from 'chess.js';

async function startLocal(page: Page, fen?: string) {
  await page.goto('/play');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  if (fen) {
    await page.getByRole('button', { name: 'Custom starting position', exact: true }).click();
    await page.getByLabel('Custom starting position (six-field FEN)').fill(fen);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
}
async function move(page: Page, coordinate: string) {
  await page.getByRole('button', { name: 'Type a move', exact: true }).click();
  await page.getByLabel('Enter a move by coordinates').fill(coordinate);
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeVisible();
}
async function selectedIsInScrollport(page: Page) {
  return page.locator('.move-scroll').evaluate(container => {
    const target = container.querySelector('[aria-current="step"]')?.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    return Boolean(target && target.top >= bounds.top - 1 && target.bottom <= bounds.bottom + 1);
  });
}

test('paired move history scrolls, reviews, survives reload and Undo, and stacks on mobile', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 844 });
  await startLocal(page);
  const chess = new Chess();
  const line = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 c4 c6 Nc3 Bb7 a3 b4 axb4 exd4 Nxd4 Re8 Nf5 Bf8'.split(' ');
  for (const san of line) {
    const next = chess.move(san);
    await move(page, next.from + next.to);
  }
  const table = page.getByRole('table', { name: 'Committed moves' });
  await expect(table.getByRole('button')).toHaveCount(line.length);
  await expect(table.locator('tbody tr')).toHaveCount(16);
  await expect(table.locator('tbody tr').first()).toHaveText('1.e4e5');
  await expect(table.locator('tbody tr').last()).toHaveText('16.Nf5Bf8');
  await expect.poll(() => page.locator('.move-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => selectedIsInScrollport(page)).toBe(true);
  const board = await page.locator('.board-host').boundingBox();
  const sidebar = await page.getByRole('complementary', { name: 'Moves' }).boundingBox();
  expect(sidebar!.x).toBeGreaterThan(board!.x + board!.width);
  await page.screenshot({ path: testInfo.outputPath('sidebar-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'First', exact: true }).click();
  await expect(table.locator('[aria-current]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeDisabled();
  await table.getByRole('button', { name: 'View move 2: e5', exact: true }).click();
  await expect(page.locator('.match-status')).toContainText('2/32');
  await expect(table.getByRole('button', { name: 'View move 2: e5', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect.poll(() => selectedIsInScrollport(page)).toBe(true);
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect.poll(() => selectedIsInScrollport(page)).toBe(true);
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  await page.reload();
  await expect(table.getByRole('button')).toHaveCount(32);
  await expect.poll(() => selectedIsInScrollport(page)).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(table.getByRole('button')).toHaveCount(31);
  await expect(table.getByRole('button', { name: 'View move 31: Nf5', exact: true })).toHaveAttribute('aria-current', 'step');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const mobileBoard = await page.locator('.board-host').boundingBox();
    const mobileSidebar = await page.getByRole('complementary', { name: 'Moves' }).boundingBox();
    expect(mobileSidebar!.y).toBeGreaterThan(mobileBoard!.y + mobileBoard!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'First', exact: true }).click();
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect.poll(() => selectedIsInScrollport(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sidebar-mobile-${width}.png`), fullPage: true });
  }
});

test('a custom Black-to-move position keeps the correct column and full-move number', async ({ page }) => {
  await startLocal(page, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 17');
  await move(page, 'e7e5');
  await move(page, 'g1f3');
  const rows = page.getByRole('table', { name: 'Committed moves' }).locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByRole('rowheader')).toHaveText('17.');
  await expect(rows.first().getByRole('cell').nth(0)).toBeEmpty();
  await expect(rows.first().getByRole('cell').nth(1)).toHaveText('e5');
  await expect(rows.last().getByRole('rowheader')).toHaveText('18.');
  await expect(rows.last().getByRole('cell').nth(0)).toHaveText('Nf3');
  await expect(rows.last().getByRole('cell').nth(1)).toBeEmpty();
});
