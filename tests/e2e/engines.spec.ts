import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';

const moves = (page: Page) => page.getByRole('table', { name: 'Committed moves' }).getByRole('button');

async function openMode(page: Page, mode: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption(mode);
  if (mode !== 'engine-ai') await page.getByRole('button', { name: 'Next', exact: true }).click();
}

async function prepareEngine(panel: Locator, engine = 'stockfish-lite') {
  await panel.getByRole('combobox', { name: 'Chess engine', exact: true }).selectOption(engine);
  await panel.getByRole('combobox', { name: 'Thinking time per move' }).selectOption('1000');
  await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
  await panel.page().getByRole('button', { name: 'Next', exact: true }).click();
}

async function prepareAi(page: Page, side: 'White' | 'Black', modelId = `${side.toLowerCase()}-fixture`) {
  await expect(page.getByRole('region', { name: 'AI model', exact: true })).toHaveAttribute('aria-busy', 'false');
  if (await page.getByLabel('API key', { exact: true }).isVisible()) {
    await page.getByLabel('API key', { exact: true }).fill('offline-test-key');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
  }
  await page.getByLabel('Available models').selectOption(modelId);
  const consent = page.getByRole('button', { name: 'Allow', exact: true });
  await expect(page.getByLabel('Available models').or(consent)).toBeVisible();
  if (await consent.isVisible()) await consent.click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
}

async function aiFixture(page: Page) {
  const turns: { model: string; side: string; thinking?: unknown }[] = [];
  await page.route('http://127.0.0.1:8317/v1/**', async route => {
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } }); return; }
    if (route.request().url().endsWith('/models')) { await route.fulfill({ json: { data: ['white-fixture', 'black-fixture', 'openai/gpt-5-codex', 'anthropic/claude-sonnet-4.6'].map(id => ({ id })) } }); return; }
    const body = route.request().postDataJSON() as { model: string; messages: { role: string; content: string }[] };
    const text = JSON.stringify(body);
    const marker = /KAMKM-COMPAT-[a-zA-Z0-9-]+/.exec(text)?.[0];
    let answer: unknown;
    if (marker) answer = { move: 'e2e4', marker, plan: /Unique plan marker: ([^\s.]+)/.exec(text)?.[1] };
    else {
      const input = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as { fen: string; sideToMove: string; previousThinking?: unknown };
      const chess = new Chess(input.fen);
      const move = chess.moves({ verbose: true })[0]!;
      turns.push({ model: body.model, side: input.sideToMove, thinking: input.previousThinking });
      answer = { move: `${move.from}${move.to}${move.promotion ?? ''}`, plan: `Plan from ${body.model}` };
    }
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
  });
  return turns;
}

test('downloads Stockfish in the browser under production CSP and resumes from cache after reload', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const configuration = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] };
  const csp = configuration.headers[0]!.headers.find(header => header.key === 'Content-Security-Policy')!.value;
  await page.route('http://127.0.0.1:5175/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': csp } });
  });
  await openMode(page, 'human-engine');
  const panel = page.getByRole('region', { name: 'Your engine opponent', exact: true });
  await expect(panel.getByRole('option', { name: /Leela.*Coming soon/ })).toHaveCount(0);
  await expect(panel.getByRole('option', { name: /AlphaZero|Torch/ })).toHaveCount(0);
  await prepareEngine(panel);
  await page.screenshot({ path: testInfo.outputPath('engine-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('engine-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page.locator('.player-row').getByRole('img', { name: 'Stockfish logo' })).toBeVisible();
  await expect(page.locator('.player-row .light-piece')).toBeVisible();
  await page.getByRole('button', { name: 'Type a move', exact: true }).click();
  await page.getByLabel('Enter a move by coordinates').fill('e2e4');
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Engine is choosing a move' })).toBeVisible();
  await page.route('**/engines/**', route => route.abort('connectionrefused'));
  await page.reload();
  await expect(page.locator('.player-row').getByRole('img', { name: 'Stockfish logo' })).toBeVisible();
  await expect(moves(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('two browser engines alternate, stop safely, and resume', async ({ page }) => {
  await openMode(page, 'engine-engine');
  await prepareEngine(page.getByRole('region', { name: 'White engine', exact: true }), 'stockfish-full');
  await prepareEngine(page.getByRole('region', { name: 'Black engine', exact: true }));
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect.poll(() => moves(page).count()).toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
  const count = await moves(page).count();
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry engine turn', exact: true }).click();
  await expect.poll(() => moves(page).count()).toBeGreaterThan(count);
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
});

test('a browser engine plays an LLM with either seat independently configured', async ({ page }) => {
  const turns = await aiFixture(page);
  await openMode(page, 'engine-ai');
  await page.getByLabel('Engine plays').selectOption('black');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await prepareAi(page, 'White');
  await prepareEngine(page.getByRole('region', { name: 'Black engine', exact: true }));
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect.poll(() => moves(page).count()).toBeGreaterThanOrEqual(4);
  await expect(page.locator('.player-row').getByRole('img', { name: 'Stockfish logo' })).toBeVisible();
  await expect(page.locator('.player-row').getByRole('img', { name: 'AI opponent', exact: true })).toBeVisible();
  expect(turns.length).toBeGreaterThanOrEqual(2);
  expect(turns.every(turn => turn.model === 'white-fixture' && turn.side === 'white')).toBe(true);
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
});

test('two LLMs alternate with separate routing IDs and side-specific plans', async ({ page }, testInfo) => {
  const turns = await aiFixture(page);
  await openMode(page, 'ai-ai');
  await prepareAi(page, 'White', 'openai/gpt-5-codex'); await prepareAi(page, 'Black', 'anthropic/claude-sonnet-4.6');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect.poll(() => moves(page).count()).toBeGreaterThanOrEqual(4);
  await expect(page.locator('.player-row').getByRole('img', { name: 'ChatGPT logo' })).toBeVisible();
  await expect(page.locator('.player-row').getByRole('img', { name: 'Claude logo' })).toBeVisible();
  expect(turns.slice(0, 4).map(turn => turn.model)).toEqual(['openai/gpt-5-codex', 'anthropic/claude-sonnet-4.6', 'openai/gpt-5-codex', 'anthropic/claude-sonnet-4.6']);
  expect(turns[2]?.thinking).toMatchObject({ plan: 'Plan from openai/gpt-5-codex' });
  expect(turns[3]?.thinking).toMatchObject({ plan: 'Plan from anthropic/claude-sonnet-4.6' });
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
  await expect.poll(() => page.locator('.player-row img').evaluateAll(images => images.every(image =>
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('opponent-logos-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('opponent-logos-mobile-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const badge of await page.locator('.player-row .opponent-logo').all()) {
    expect((await badge.boundingBox())?.width).toBe(30);
  }
  await page.reload();
  await expect(page.locator('.player-row').getByRole('img', { name: 'ChatGPT logo' })).toBeVisible();
  await expect(page.locator('.player-row').getByRole('img', { name: 'Claude logo' })).toBeVisible();
});
