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
      await route.fulfill({ json: { gameId: 'match-fixture', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', status: 'waiting-for-players', players: { white: 'White agent', black: 'Black agent' }, moves: [], clock: { whiteMs: 10800000, blackMs: 10800000 }, result: null, watch_url: watch } });
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
  await expect(page.getByRole('heading', { name: 'Watch the agents play' })).toBeVisible();
  expect(calls[0]).toMatchObject({ name: 'start_game', arguments: { opponent: 'agent', color: 'white', defer_join: true } });
  const white = await page.getByLabel('white agent prompt', { exact: true }).inputValue();
  const black = await page.getByLabel('black agent prompt', { exact: true }).inputValue();
  expect(white).toContain('Play as white');
  expect(white).toContain('white-secret');
  expect(white).not.toContain('black-secret');
  expect(black).toContain('Play as black');
  expect(black).toContain('black-secret');
  expect(black).not.toContain('white-secret');
  expect(white).toContain('Do not call start_game');
  const viewing = await page.getByLabel('Viewing URL', { exact: true }).inputValue();
  expect(viewing).not.toContain('secret');
  expect(viewing).not.toContain('#');
  await expect(page.getByText('Waiting for both players to join')).toBeVisible();
  await expect(page.getByRole('button', { name: /Play .* myself/ })).toHaveCount(0);
});

test('a human joins their side while the opposite agent gets its prompt', async ({ page }) => {
  const calls = await hostedGame(page);
  await page.goto('/play?setup=new');
  await page.getByLabel('Black', { exact: true }).selectOption('agent');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'White invitation' })).toBeVisible();
  expect(calls[0]).toMatchObject({ name: 'start_game', arguments: { opponent: 'human', color: 'black', defer_join: true } });
  await expect(page.getByLabel('black agent prompt', { exact: true })).toHaveValue(/Play as black/);
  await page.getByRole('button', { name: 'Play white myself' }).click();
  await expect(page.getByText('You are playing white. Pawn promotions use a queen.')).toBeVisible();
  expect(calls[1]).toMatchObject({ name: 'join_seat', arguments: { resume_token: 'white-secret', model_name: 'Human' } });
});
