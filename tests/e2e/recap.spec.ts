import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { recapCheckpoint } from '../support/recap.js';

async function finishedGame(page: Page): Promise<void> {
  const checkpoint = recapCheckpoint();
  await page.route('**/v1/mcp?watch=video-fixture', route => route.fulfill({ json: {
    gameId: 'video-fixture', status: 'completed', fen: checkpoint.rules.currentFen,
    moves: checkpoint.rules.moves.map(move => move.san), players: { white: 'White', black: 'Black' },
    clock: { whiteMs: 90000, blackMs: 90000, incrementMs: 0, activeSeat: null },
    result: { kind: 'win', winner: 'black', reason: 'checkmate' }, watch_url: '/play/agent?watch=video-fixture',
  } }));
  await page.goto('/play/agent?watch=video-fixture');
  await page.getByRole('button', { name: 'Make a video about it', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeVisible({ timeout: 60_000 });
}

test('reviews with real browser Stockfish and exports a playable video with music', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const calls: string[] = [], errors: string[] = [];
  page.on('request', request => calls.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  await finishedGame(page);
  const recap = page.getByRole('region', { name: 'Game video' });
  await expect(recap.locator('canvas')).toHaveAttribute('width', '720');
  await expect(recap.getByRole('heading', { name: 'Game video' })).toBeFocused();
  expect(calls.some(url => url.includes('stockfish-19-lite-single.wasm'))).toBe(true);
  expect(calls.some(url => url.includes('stockfish-19-single.wasm'))).toBe(false);
  expect(calls.some(url => /provider-relay|chat\/completions|\/v1\/messages/.test(url))).toBe(false);

  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await page.getByRole('slider', { name: 'Video position', exact: true }).press('End');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`recap-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  const link = page.getByRole('link', { name: 'Download video', exact: true });
  await expect(link).toBeVisible({ timeout: 100_000 });
  const download = page.waitForEvent('download'); await link.click();
  const file = await download;
  const target = testInfo.outputPath(file.suggestedFilename()); await file.saveAs(target);
  const input = new Input({ source: new BufferSource(await readFile(target)), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    expect(video).not.toBeNull(); expect(audio).not.toBeNull();
    expect(await video!.getCodedWidth()).toBe(720); expect(await video!.getCodedHeight()).toBe(1280);
    expect(await audio!.getNumberOfChannels()).toBe(2);
    const duration = await video!.computeDuration();
    expect(duration).toBeGreaterThan(9); expect(duration).toBeLessThan(25);
    expect(Math.abs(await audio!.computeDuration() - duration)).toBeLessThan(0.2);
  } finally { input.dispose(); }
  await page.getByRole('button', { name: 'Close video', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Make a video about it', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('cancels an export and reuses saved analysis after reopening', async ({ page }) => {
  test.setTimeout(90_000);
  await finishedGame(page);
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Download video', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close video', exact: true }).click();
  await page.getByRole('button', { name: 'Make a video about it', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Flip video board', exact: true }).click();
  await page.getByRole('radio', { name: 'Highlights', exact: true }).check();
  await page.getByRole('slider', { name: 'Music volume', exact: true }).press('Home');
  await expect(page.locator('.recap-canvas')).toBeVisible();
});

test('records a video with music through the foreground fallback', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { Object.defineProperty(globalThis, 'VideoEncoder', { value: undefined, configurable: true }); });
  await finishedGame(page); await page.bringToFront();
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await expect(page.getByText('Recording. Keep this tab visible.', { exact: true })).toBeVisible();
  const link = page.getByRole('link', { name: 'Download video', exact: true });
  await expect(link).toBeVisible({ timeout: 40_000 });
  const download = page.waitForEvent('download'); await link.click(); const file = await download;
  const target = testInfo.outputPath(file.suggestedFilename()); await file.saveAs(target);
  const input = new Input({ source: new BufferSource(await readFile(target)), formats: ALL_FORMATS });
  try {
    expect(await input.getPrimaryVideoTrack()).not.toBeNull();
    expect(await input.getPrimaryAudioTrack()).not.toBeNull();
    expect(await input.computeDuration()).toBeGreaterThan(13);
  } finally { input.dispose(); }
});
