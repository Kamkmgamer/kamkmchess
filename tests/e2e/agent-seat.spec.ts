import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { PageAgentApi } from '../../src/agents/webmcp.js';

declare global { interface Window { kamkmChessAgent?: PageAgentApi } }

async function hostedGame(page: Page) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  await page.route('**/v1/mcp*', async route => {
    const origin = new URL(route.request().url()).origin;
    const watch = `${origin}/play/agent?watch=match-fixture`;
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { gameId: 'match-fixture', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', status: 'waiting-for-players', players: { white: 'GLM-4.7 (self-reported)', black: 'Kimi K2 (self-reported)' }, moves: [], clock: { whiteMs: 10800000, blackMs: 10800000 }, result: null, watch_url: watch } });
      return;
    }
    const rpc = route.request().postDataJSON() as { id: number; method: string; params: { name: string; arguments: Record<string, unknown> } };
    if (rpc.method === 'initialize') {
      await route.fulfill({ headers: { 'Mcp-Session-Id': 'fixture-session' }, json: { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } } });
      return;
    }
    calls.push(rpc.params);
    const color = rpc.params.arguments.color === 'black' ? 'black' : 'white';
    const other = color === 'white' ? 'black' : 'white';
    await route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { gameId: 'match-fixture', watch_url: watch, seat_url: `${watch}&side=${color}#seat=${color}-secret`, opponent_url: `${watch}&side=${other}#seat=${other}-secret` } } } });
  });
  return calls;
}

test('the page advertises MCP instead of local gameplay tools', async ({ page }) => {
  await page.goto('/play');
  await expect.poll(() => page.evaluate(() => window.kamkmChessAgent?.tools.map(tool => tool.name))).toEqual(['connect_chess_mcp']);
  const connection = await page.evaluate(() => window.kamkmChessAgent!.call('connect_chess_mcp'));
  expect(connection.ok).toBe(true);
  const refused = await page.evaluate(() => window.kamkmChessAgent!.call('start_game', { model_name: 'Test' }));
  expect(refused.ok).toBe(false);
});

test('Agent seats have separate invitations and a public live viewer', async ({ page }) => {
  const calls = await hostedGame(page);
  await page.goto('/play?setup=new');
  await page.getByLabel('White', { exact: true }).selectOption('agent');
  await page.getByLabel('Black', { exact: true }).selectOption('agent');
  await expect(page.getByLabel('Starting minutes')).toHaveValue('180');
  await expect(page.getByLabel('Increment seconds')).toHaveValue('60');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  // The game plays on the shared board, like every other mode.
  await expect(page.getByLabel('Chess match board')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for players' })).toBeVisible();
  // Reported model names lose the marker and show their family logo.
  await expect(page.locator('.opponent-logo[data-brand="glm"]')).toHaveCount(1);
  await expect(page.locator('.opponent-logo[data-brand="kimi"]')).toHaveCount(1);
  await expect(page.locator('.player-name strong', { hasText: 'GLM-4.7' })).toHaveText('GLM-4.7');
  expect(calls[0]).toMatchObject({ name: 'start_game', arguments: { opponent: 'agent', color: 'white', defer_join: true } });
  const white = await page.getByRole('button', { name: 'Copy white invite' }).getAttribute('data-copy');
  const black = await page.getByRole('button', { name: 'Copy black invite' }).getAttribute('data-copy');
  expect(white).toContain('Play as white');
  expect(white).toContain('white-secret');
  expect(white).not.toContain('black-secret');
  expect(black).toContain('Play as black');
  expect(black).toContain('black-secret');
  expect(black).not.toContain('white-secret');
  expect(white).toContain('Do not call start_game');
  const viewing = await page.getByRole('button', { name: 'Copy viewing link' }).getAttribute('data-copy');
  expect(viewing).not.toContain('secret');
  expect(viewing).not.toContain('#');
  await expect(page.getByRole('button', { name: /^Play (white|black)$/ })).toHaveCount(0);
});

test('a human joins their side while the opposite agent gets its prompt', async ({ page }) => {
  const calls = await hostedGame(page);
  await page.goto('/play?setup=new');
  await page.getByLabel('Black', { exact: true }).selectOption('agent');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  expect(calls[0]).toMatchObject({ name: 'start_game', arguments: { opponent: 'human', color: 'black', defer_join: true } });
  await expect(page.getByRole('button', { name: 'Copy black invite' })).toHaveAttribute('data-copy', /Play as black/);
  await page.getByRole('button', { name: 'Play white' }).click();
  await expect(page.getByText('Playing white')).toBeVisible();
  expect(calls[1]).toMatchObject({ name: 'join_seat', arguments: { resume_token: 'white-secret', model_name: 'Human' } });
  await expect(page.getByRole('button', { name: 'Resign' })).toBeVisible();
});
