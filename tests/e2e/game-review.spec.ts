import { expect, test } from '@playwright/test';
import { recapCheckpoint } from '../support/recap.js';

test('opens a completed game for analysis and navigates its reviewed moves', async ({ page }) => {
  test.setTimeout(90_000);
  const checkpoint = recapCheckpoint();
  await page.route('**/v1/mcp?watch=review-fixture', route => route.fulfill({ json: {
    gameId: 'review-fixture', status: 'completed', fen: checkpoint.rules.currentFen,
    moves: checkpoint.rules.moves.map(move => move.san), players: { white: 'White', black: 'Black' },
    clock: { whiteMs: 90000, blackMs: 90000, incrementMs: 0, activeSeat: null },
    result: { kind: 'win', winner: 'black', reason: 'checkmate' }, watch_url: '/play/agent?watch=review-fixture',
  } }));
  await page.goto('/play/agent?watch=review-fixture');
  await page.getByRole('button', { name: 'Review game', exact: true }).click();
  const review = page.getByRole('region', { name: 'Game review' });
  await expect(review.getByRole('heading', { name: 'Game summary' })).toBeVisible({ timeout: 60_000 });
  await review.getByRole('button', { name: 'Start reviewing', exact: true }).click();
  await review.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(review.getByText('Find the move Stockfish prefers.')).toBeVisible();
  await review.getByRole('button', { name: 'Show best line', exact: true }).click();
  await expect(review.getByText('Possible continuation')).toBeVisible();
  await expect(review.getByText(/^Showing the position after/)).toBeVisible();
  await review.getByRole('button', { name: 'First position', exact: true }).click();
  await review.getByRole('button', { name: 'Next move', exact: true }).click();
  await expect(review.getByRole('heading', { name: '1.f3' })).toBeVisible();
  await review.getByRole('button', { name: 'Last move', exact: true }).click();
  await expect(review.getByRole('heading', { name: '2...Qh4#' })).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await review.getByRole('button', { name: 'Close review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review game', exact: true })).toBeVisible();
});
