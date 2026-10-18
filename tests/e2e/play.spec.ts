import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const endpoint = 'https://offline-chess.example/v1';

interface FixtureProvider {
  readonly calls: unknown[];
  readonly modelCalls: unknown[];
  readonly respond: (route: Route, answer: string) => Promise<void>;
}

async function provider(page: Page, moves: readonly string[], intercept?: (route: Route, index: number, fixture: FixtureProvider) => Promise<void>, apiEndpoint = endpoint): Promise<FixtureProvider> {
  const calls: unknown[] = [];
  const modelCalls: unknown[] = [];
  const respond = async (route: Route, answer: string) => {
    const frames = [
      { model: 'offline-fixture', choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } } },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames, headers: { 'access-control-allow-origin': '*' } }).catch(() => undefined);
  };
  const fixture = { calls, modelCalls, respond };
  await page.route(`${apiEndpoint}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      return;
    }
    if (route.request().url().endsWith('/models')) {
      await route.fulfill({ json: { data: [{ id: 'offline-fixture' }] } });
      return;
    }
    const body: unknown = route.request().postDataJSON();
    calls.push(body);
    const text = JSON.stringify(body);
    const marker = /KAMKM-COMPAT-[a-zA-Z0-9-]+/.exec(text)?.[0];
    if (marker) {
      const plan = /Unique plan marker: ([^\s.]+)/.exec(text)?.[1];
      await respond(route, JSON.stringify({ move: 'e2e4', plan, marker }));
      return;
    }
    modelCalls.push(body);
    const index = modelCalls.length - 1;
    if (intercept) { await intercept(route, index, fixture); return; }
    const move = moves[index];
    await respond(route, move === 'resign' ? '{"resign":true}' : JSON.stringify({ move, plan: `retained plan ${index + 1}` }));
  });
  return fixture;
}

async function configure(page: Page, side = 'white') {
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('ai');
  await page.getByLabel('Your side').selectOption(side);
  await page.getByLabel('Provider').selectOption('custom');
  await page.getByLabel('Protocol').selectOption('chat-completions');
  await page.getByLabel('Connection name').fill('Offline fixture');
  await page.getByLabel('Base URL', { exact: true }).fill(endpoint);
  await page.getByLabel('Authentication').selectOption('none');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.getByLabel('Exact model routing ID').fill('offline-fixture');
  await page.getByRole('button', { name: 'Review request disclosure' }).click();
  await page.getByRole('button', { name: 'Accept and save consent' }).click();
  await page.getByRole('button', { name: 'Run explicit compatibility check' }).click();
  await page.getByRole('button', { name: /Use this model for.*new match/ }).click();
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
}

async function move(page: Page, coordinate: string) {
  await expect(page.getByRole('button', { name: 'Play move', exact: true })).toBeEnabled();
  await page.getByLabel('Enter a move by coordinates').fill(coordinate);
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
}

const movesOnBoard = (page: Page) => page.getByRole('list', { name: 'Committed moves' }).locator('li');

test('finishes a legal AI match, preserves plans, restores its result and fits mobile', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await provider(page, ['e7e5', 'b8c6', 'g8f6']);
  await page.goto('/');
  await configure(page);
  for (const [coordinate, count] of [['e2e4', 2], ['d1h5', 4], ['f1c4', 6]] as const) {
    await move(page, coordinate);
    await expect(movesOnBoard(page)).toHaveCount(count);
  }
  await move(page, 'h5f7');
  await expect(page.getByRole('heading', { name: 'White wins', exact: true })).toBeVisible();
  expect(fixture.calls).toHaveLength(4);
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('retained plan 1');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'White wins', exact: true })).toBeVisible();
  await expect(movesOnBoard(page)).toHaveCount(7);
  expect(fixture.calls).toHaveLength(4);
  await page.getByText('Match conversation and archive', { exact: true }).click();
  await expect(page.locator('.conversation-row').filter({ hasText: 'retained plan 1' }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('starts with a model playing White and offers practice after that model resigns', async ({ page }) => {
  const fixture = await provider(page, ['e2e4', 'resign']);
  await page.goto('/');
  await configure(page, 'black');
  await expect(movesOnBoard(page)).toHaveCount(1);
  await move(page, 'e7e5');
  await expect(page.getByRole('heading', { name: 'Black wins', exact: true })).toBeVisible();
  expect(fixture.modelCalls).toHaveLength(2);
  await page.getByRole('button', { name: 'Start practice from this position' }).click();
  await expect(page.getByText('Practice segment. Original result remains preserved in the saved match.')).toBeVisible();
});

test('Stop fences a delayed reply and Retry remains an explicit new request', async ({ page }) => {
  let release: (() => void) | undefined;
  const fixture = await provider(page, [], async (route, index, mock) => {
    if (index === 0) await new Promise<void>((resolve) => { release = resolve; });
    await mock.respond(route, '{"move":"e7e5","plan":"after explicit retry"}');
  });
  await page.goto('/');
  await configure(page);
  await move(page, 'e2e4');
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
  await expect.poll(() => fixture.modelCalls.length).toBe(1);
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
  release?.();
  await expect(page.getByRole('button', { name: 'Retry model request' })).toBeVisible();
  await expect(movesOnBoard(page)).toHaveCount(1);
  expect(fixture.modelCalls).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry model request' }).click();
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(fixture.modelCalls).toHaveLength(2);
});

test('Undo keeps the discarded conversation and the same model can start another game', async ({ page }) => {
  await provider(page, ['e7e5']);
  await page.goto('/');
  await configure(page);
  await move(page, 'e2e4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(movesOnBoard(page)).toHaveCount(0);
  await page.getByText('Match conversation and archive', { exact: true }).click();
  await expect(page.locator('.conversation-row.discarded').filter({ hasText: 'retained plan 1' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Saved connection').selectOption({ label: 'Offline fixture · Custom endpoint' });
  await page.getByLabel('Exact model routing ID').fill('offline-fixture');
  await page.getByRole('button', { name: 'Run explicit compatibility check' }).click();
  await page.getByRole('button', { name: /Use this model for.*new match/ }).click();
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'White to move', exact: true })).toBeVisible();
});

test('queues a different model and commits it only with its first legal reply', async ({ page }) => {
  let release: (() => void) | undefined;
  const fixture = await provider(page, [], async (route, _index, mock) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await mock.respond(route, '{"move":"e7e5","plan":"new model continuation"}');
  });
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: 'Choose another model', exact: true }).click();
  await page.getByLabel('Exact model routing ID').fill('offline-candidate');
  await page.getByRole('button', { name: 'Run explicit compatibility check' }).click();
  await page.getByRole('button', { name: 'Queue this model for play' }).click();
  await expect(page.getByText('Queued candidate: offline-candidate', { exact: false })).toBeVisible();
  await expect(page.getByText('Committed model: offline-fixture', { exact: true })).toBeVisible();
  expect(fixture.modelCalls).toHaveLength(0);
  await move(page, 'e2e4');
  await expect.poll(() => fixture.modelCalls.length).toBe(1);
  await expect(page.getByText('Committed model: offline-fixture', { exact: true })).toBeVisible();
  expect(fixture.modelCalls[0]).toMatchObject({ model: 'offline-candidate' });
  release?.();
  await expect(movesOnBoard(page)).toHaveCount(2);
  await expect(page.getByText('Committed model: offline-candidate', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Committed model: offline-candidate', { exact: true })).toBeVisible();
});

test('reload requires an explicit compatibility recheck before the next model request', async ({ page }) => {
  const fixture = await provider(page, ['e7e5', 'b8c6']);
  await page.goto('/');
  await configure(page);
  await move(page, 'e2e4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  await page.reload();
  await expect(movesOnBoard(page)).toHaveCount(2);
  await move(page, 'd1h5');
  await expect(page.getByRole('button', { name: 'Recheck connection to resume' })).toBeVisible();
  expect(fixture.modelCalls).toHaveLength(1);
  await page.getByRole('button', { name: 'Recheck connection to resume' }).click();
  await page.getByRole('button', { name: 'Run explicit compatibility check' }).click();
  await page.getByRole('button', { name: 'Queue this model for play' }).click();
  await expect(movesOnBoard(page)).toHaveCount(4);
  expect(fixture.modelCalls).toHaveLength(2);
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('retained plan 1');
});

test('automatically corrects malformed and illegal replies with retained feedback', async ({ page }) => {
  const fixture = await provider(page, [], async (route, index, mock) => {
    await mock.respond(route, ['I prefer the center.', '{"move":"e7e4"}', '{"move":"e7e5"}'][index] ?? '{"resign":true}');
  });
  await page.goto('/');
  await configure(page);
  await move(page, 'e2e4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(fixture.modelCalls).toHaveLength(3);
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('Your last message did not contain a move');
  expect(JSON.stringify(fixture.modelCalls[2])).toContain('e7e4');
  await expect(page.getByRole('heading', { name: 'White to move', exact: true })).toBeVisible();
});

test('pauses after the formatting budget and sends another request only on Retry', async ({ page }) => {
  const fixture = await provider(page, [], async (route, index, mock) => {
    await mock.respond(route, index < 4 ? 'I prefer the center.' : '{"move":"e7e5"}');
  });
  await page.goto('/');
  await configure(page);
  await move(page, 'e2e4');
  await expect(page.getByRole('button', { name: 'Retry model request' })).toBeVisible();
  expect(fixture.modelCalls).toHaveLength(4);
  await expect(movesOnBoard(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Retry model request' }).click();
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(fixture.modelCalls).toHaveLength(5);
});

test('a failed candidate keeps the prior model and can be retried explicitly', async ({ page }) => {
  const fixture = await provider(page, [], async (route, index, mock) => {
    await mock.respond(route, index === 0 ? 'I prefer the center.' : '{"move":"e7e5"}');
  });
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: 'Choose another model', exact: true }).click();
  await page.getByLabel('Exact model routing ID').fill('offline-candidate');
  await page.getByRole('button', { name: 'Run explicit compatibility check' }).click();
  await page.getByRole('button', { name: 'Queue this model for play' }).click();
  await move(page, 'e2e4');
  await expect(page.getByRole('button', { name: 'Retry queued model' })).toBeVisible();
  await expect(page.getByText('Committed model: offline-fixture', { exact: true })).toBeVisible();
  expect(fixture.modelCalls).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry queued model' }).click();
  await expect(movesOnBoard(page)).toHaveCount(2);
  await expect(page.getByText('Committed model: offline-candidate', { exact: true })).toBeVisible();
  expect(fixture.modelCalls).toHaveLength(2);
});

test('CLIProxyAPI connects with key and model, asks consent before requesting, and plays', async ({ page }, testInfo) => {
  const fixture = await provider(page, ['e7e5', 'b8c6', 'a7a6', 'g8f6'], undefined, 'http://127.0.0.1:8317/v1');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('ai');
  await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue('cliproxy');
  await expect(page.getByLabel('Proxy URL')).toHaveValue('http://127.0.0.1:8317/v1');
  await expect(page.getByLabel('Protocol', { exact: true })).not.toBeVisible();
  await page.getByLabel('Proxy API key').fill('offline-proxy-fixture-key');
  await page.getByLabel('Model ID', { exact: true }).fill('offline-fixture');
  await page.screenshot({ path: testInfo.outputPath('proxy-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('proxy-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Connect and use model' }).click();
  await expect(page.getByRole('button', { name: 'Accept and check model' })).toBeVisible();
  expect(fixture.calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(fixture.calls).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Connect and use model' }).click();
  await page.getByRole('button', { name: 'Accept and check model' }).click();
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeEnabled();
  expect(fixture.calls).toHaveLength(1);
  await page.getByLabel('Model ID', { exact: true }).fill('another-model');
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeDisabled();
  await page.getByLabel('Model ID', { exact: true }).fill('offline-fixture');
  await page.getByRole('button', { name: 'Connect and use model' }).click();
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeEnabled();
  expect(fixture.calls).toHaveLength(2);
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await move(page, 'e2e4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(fixture.modelCalls).toHaveLength(1);
  await move(page, 'g1f3');
  await expect(movesOnBoard(page)).toHaveCount(4);
  expect(fixture.modelCalls).toHaveLength(2);
  await move(page, 'f1b5');
  await expect(movesOnBoard(page)).toHaveCount(6);
  await move(page, 'b5a4');
  await expect(movesOnBoard(page)).toHaveCount(8);
  await expect(page.getByRole('button', { name: 'Play move', exact: true })).toBeEnabled();
  expect(fixture.modelCalls).toHaveLength(4);
  expect(errors).toEqual([]);
});

test('a model playing White continues through knight and bishop development', async ({ page }) => {
  const fixture = await provider(page, ['e2e4', 'g1f3', 'f1c4']);
  await page.goto('/');
  await configure(page, 'black');
  await expect(movesOnBoard(page)).toHaveCount(1);
  await move(page, 'e7e5');
  await expect(movesOnBoard(page)).toHaveCount(3);
  await move(page, 'b8c6');
  await expect(movesOnBoard(page)).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Play move', exact: true })).toBeEnabled();
  expect(fixture.modelCalls).toHaveLength(3);
});

test('CLIProxyAPI supports a prefixed endpoint and reports a failed check without starting play', async ({ page }) => {
  const apiEndpoint = 'https://offline-chess.example/proxy/v1';
  let attempts = 0;
  await page.route(`${apiEndpoint}/chat/completions`, async (route) => {
    attempts += 1;
    expect(route.request().headers().authorization).toBe('Bearer offline-proxy-fixture-key');
    expect(route.request().postDataJSON()).toMatchObject({ model: 'exact-routing-alias' });
    await route.fulfill({ status: 401, json: { error: { message: 'Fixture rejected this API key.' } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('ai');
  await page.getByLabel('Proxy URL').fill(`${apiEndpoint}/chat/completions`);
  await page.getByLabel('Proxy API key').fill('offline-proxy-fixture-key');
  await page.getByLabel('Model ID', { exact: true }).fill('exact-routing-alias');
  await page.getByRole('button', { name: 'Connect and use model' }).click();
  await expect(page.locator('.disclosure-panel')).toContainText(`${apiEndpoint}/chat/completions`);
  await page.getByRole('button', { name: 'Accept and check model' }).click();
  await expect(page.locator('.feedback-inline')).toContainText('401');
  await expect(page.getByRole('button', { name: 'Connect and use model' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeDisabled();
  expect(attempts).toBe(1);
});

test('CLIProxyAPI preserves saved providers, clears catalog overrides, and requires a key for changed destinations', async ({ page }) => {
  await provider(page, []);
  const changedProxy = 'http://127.0.0.1:8318/v1';
  const proxy = await provider(page, [], async () => { throw new Error('Unexpected game request'); }, changedProxy);
  const authHeaders: string[] = [];
  page.on('request', (request) => {
    if (request.url() === `${changedProxy}/chat/completions`) authHeaders.push(request.headers().authorization ?? '');
  });
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  const saved = page.getByLabel('Saved connection');
  await saved.selectOption({ label: 'Offline fixture · Custom endpoint' });
  const originalId = await saved.inputValue();
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('cliproxy');
  await expect(saved).toHaveValue('');
  await page.getByLabel('Proxy API key').fill('fixture-key-one');
  await page.getByLabel('Model ID', { exact: true }).fill('offline-fixture');
  await page.getByText('Advanced connection settings', { exact: true }).click();
  await page.getByLabel('Catalog URL override').fill('https://removed-catalog.example/models');
  await page.getByRole('button', { name: 'Connect and use model' }).click();
  await expect(page.locator('.disclosure-panel')).toContainText('https://removed-catalog.example/models');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Catalog URL override').fill('');
  await expect(page.getByLabel('Proxy API key')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Proxy API key')).toHaveAttribute('placeholder', 'Re-enter key for this connection');
  await page.getByLabel('Proxy API key').fill('fixture-key-one');
  await page.getByRole('button', { name: 'Connect and use model' }).click();
  await expect(page.locator('.disclosure-panel')).not.toContainText('removed-catalog.example');
  await expect(page.locator('.disclosure-panel')).toContainText('http://127.0.0.1:8317/v1/models');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Proxy URL').fill(changedProxy);
  await expect(page.getByLabel('Proxy API key')).toHaveAttribute('required', '');
  await page.getByRole('button', { name: 'Connect and use model' }).click();
  await expect(page.getByRole('button', { name: 'Accept and check model' })).not.toBeVisible();
  expect(proxy.calls).toHaveLength(0);
  await page.getByLabel('Proxy API key').fill('fixture-key-two');
  await page.getByRole('button', { name: 'Connect and use model' }).click();
  expect(proxy.calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Accept and check model' }).click();
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeEnabled();
  expect(proxy.calls).toHaveLength(1);
  expect(authHeaders).toEqual(['Bearer fixture-key-two']);
  await saved.selectOption(originalId);
  await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue('custom');
  await expect(page.getByLabel('Base URL', { exact: true })).toHaveValue(endpoint);
  await expect(page.getByLabel('Authentication')).toHaveValue('none');
  await saved.selectOption({ label: 'CLIProxyAPI · CLIProxyAPI' });
  await page.getByText('Advanced connection settings', { exact: true }).click();
  await page.getByLabel('Proxy API key').fill('discard-this-key');
  await page.getByLabel('Authentication').selectOption('none');
  await expect(page.getByLabel('Proxy API key')).not.toBeVisible();
  await page.getByLabel('Model ID', { exact: true }).fill('offline-fixture');
  await page.getByRole('button', { name: 'Connect and use model' }).click();
  await page.getByRole('button', { name: 'Accept and check model' }).click();
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeEnabled();
  expect(proxy.calls).toHaveLength(2);
  expect(authHeaders).toEqual(['Bearer fixture-key-two', '']);
});
