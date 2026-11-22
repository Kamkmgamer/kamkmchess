import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Chess } from 'chess.js';

/**
 * The armed-premove notice sits inside `.playing-board`, which becomes a
 * two-column grid (evaluation bar | board) for spectators. The notice must
 * span the full width under the board, not collapse into the bar's 28px
 * column.
 */
async function aiFixture(page: Page) {
  let call = 0;
  await page.route('http://127.0.0.1:8317/v1/**', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      return;
    }
    if (route.request().url().endsWith('/models')) {
      await route.fulfill({ json: { data: ['white-fixture', 'black-fixture'].map(id => ({ id })) } });
      return;
    }
    const body = route.request().postDataJSON() as { model: string; messages: { role: string; content: string }[] };
    const text = JSON.stringify(body);
    const marker = /KAMKM-COMPAT-[a-zA-Z0-9-]+/.exec(text)?.[0];
    let answer: unknown;
    if (marker) {
      answer = { move: 'e2e4', marker, plan: /Unique plan marker: ([^\s.]+)/.exec(text)?.[1] };
    } else {
      const input = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as { fen: string };
      const move = new Chess(input.fen).moves({ verbose: true })[0]!;
      const index = call++;
      answer = { move: `${move.from}${move.to}${move.promotion ?? ''}`, plan: `Plan from ${body.model}` };
      if (index === 1) {
        answer = {
          ...answer as object,
          premoves: [
            { on: ['g1f3', 'b1c3'], then: 'g8f6' },
            { on: ['d2d4'], then: 'e5d4' },
            { on: ['f2f4'], then: 'e5f4' },
          ],
        };
      } else if (index === 2) {
        // Hold White's reply so the armed premoves stay on screen.
        await new Promise(() => undefined);
      }
    }
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
  });
}

async function prepareAi(page: Page, side: 'White' | 'Black', modelId: string) {
  const panel = page.getByRole('region', { name: `${side} opponent setup`, exact: true });
  await expect(panel.getByRole('region', { name: 'AI model', exact: true })).toHaveAttribute('aria-busy', 'false');
  if (await panel.getByLabel('API key', { exact: true }).isVisible()) {
    await panel.getByLabel('API key', { exact: true }).fill('offline-test-key');
    await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  }
  await panel.getByLabel('Available models', { exact: true }).selectOption(modelId);
  const consent = panel.getByRole('button', { name: 'Allow', exact: true });
  await expect(panel.getByLabel('Available models', { exact: true }).or(consent)).toBeVisible();
  if (await consent.isVisible()) await consent.click();
  await expect(panel.getByText('Ready', { exact: true })).toBeVisible();
}

test('armed premove notice spans the board width under the evaluation bar', async ({ page }, testInfo) => {
  await aiFixture(page);
  await page.goto('/play');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('White', { exact: true }).selectOption('ai');
  await page.getByLabel('Black', { exact: true }).selectOption('ai');
  await prepareAi(page, 'White', 'white-fixture');
  await prepareAi(page, 'Black', 'black-fixture');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  const notice = page.locator('.premove-plan');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('pre-moved');
  // The notice sits under the board, not squeezed into the 28px bar column.
  const noticeBox = (await notice.boundingBox())!;
  const boardBox = (await page.locator('.board-host').boundingBox())!;
  expect(noticeBox.width).toBeGreaterThan(boardBox.width * 0.9);
  await page.screenshot({ path: testInfo.outputPath('premove-notice.png'), fullPage: true });
});
