import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Chess } from 'chess.js';
import type { PageAgentApi } from '../../src/agents/webmcp.js';

declare global {
  interface Window { kamkmChessAgent?: PageAgentApi }
}

const moves = (page: Page) => page.getByRole('table', { name: 'Committed moves' }).getByRole('button');

type ToolResult = { ok: boolean; result?: Record<string, unknown>; error?: string };
const call = (page: Page, name: string, input: Record<string, unknown> = {}) =>
  page.evaluate(([tool, args]) => window.kamkmChessAgent!.call(tool, args), [name, input] as const) as Promise<ToolResult>;

test('a scripted agent plays Stockfish Lite through the page tools', async ({ page }) => {
  await page.goto('/play');
  await expect.poll(() => page.evaluate(() => window.kamkmChessAgent?.tools.map(tool => tool.name))).toEqual(
    ['get_rules', 'start_game', 'join_seat', 'get_board', 'make_move', 'wait_for_turn', 'resign']);
  expect((await call(page, 'get_rules')).result).toMatchObject({ fairness: expect.stringContaining('chess engine') as unknown });

  const started = await call(page, 'start_game', { model_name: 'Fixture Agent 1', color: 'white', opponent: 'engine', engine_think_ms: 100 });
  expect(started.result).toMatchObject({ status: 'your-turn', yourSide: 'white', agentName: 'Fixture Agent 1' });
  await expect(page.getByText('Fixture Agent 1 (self-reported)')).toBeVisible();

  for (let ply = 0; ply < 3; ply += 1) {
    const board = (await call(page, 'get_board')).result as { status: string; input: { fen: string } };
    expect(board.status).toBe('your-turn');
    const move = new Chess(board.input.fen).moves({ verbose: true })[0]!;
    const played = await call(page, 'make_move', { move: move.from + move.to + (move.promotion ?? ''), plan: `Plan ${ply}` });
    expect(played.result).toMatchObject({ result: 'accepted' });
  }
  await expect(moves(page)).toHaveCount(6, { timeout: 20_000 });
  const latest = (await call(page, 'get_board')).result as { input: { previousThinking?: { plan: string } } };
  expect(latest.input.previousThinking?.plan).toBe('Plan 2');

  const illegal = await call(page, 'make_move', { move: 'a1a8' });
  expect(illegal.result).toMatchObject({ result: 'illegal', message: expect.stringContaining('3 illegal attempts left') as unknown });
  await expect.poll(async () => ((await call(page, 'get_board')).result as { status: string }).status).toBe('your-turn');
  expect(((await call(page, 'resign')).result as { result: string }).result).toBe('resigned');
  expect(((await call(page, 'get_board')).result as { status: string }).status).toBe('finished');
});

async function typeMove(page: Page, uci: string) {
  const field = page.getByLabel('Enter a move by coordinates');
  // A click while the opponent's move is still settling can be lost, so open
  // the entry the way a person would: click again until it is there.
  await expect(async () => {
    if (!(await field.isVisible())) await page.getByRole('button', { name: 'Type a move', exact: true }).click({ timeout: 2_000 });
    await expect(field).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await field.fill(uci);
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
  // The entry closes after the move; its button toggles it, so wait first.
  await expect(field).toBeHidden();
}

test('agent modes sit beside the existing ones and default to the long clock', async ({ page }) => {
  await page.goto('/play?setup=new');
  const mode = page.getByLabel('Game mode');
  await expect(mode.locator('option')).toHaveText(['Human versus human', 'Human versus AI', 'Human versus engine', 'Engine versus engine',
    'Engine versus AI', 'AI versus AI', 'Human versus agent', 'Agent versus engine', 'Agent versus AI']);
  await mode.selectOption('human-agent');
  await expect(page.getByRole('region', { name: 'Agent opponent' })).toBeVisible();
  await expect(page.getByLabel('Starting minutes')).toHaveValue('180');
  await expect(page.getByLabel('Increment seconds')).toHaveValue('60');
  await mode.selectOption('local');
  await expect(page.getByLabel('Starting minutes')).toHaveValue('15');
  await mode.selectOption('human-agent');
  await page.getByRole('button', { name: 'Start game' }).click();

  const joined = await call(page, 'join_seat', { model_name: 'Fixture Agent 2' });
  expect(joined.result).toMatchObject({ yourSide: 'black', status: 'opponent-turn' });
  await typeMove(page, 'e2e4');
  const waited = await call(page, 'wait_for_turn', { timeout_seconds: 10 });
  expect(waited.result).toMatchObject({ status: 'your-turn', input: { sideToMove: 'black' } });
  // make_move returns once the person has replied, so the person moves while it waits.
  const reply = call(page, 'make_move', { move: 'e7e5', plan: 'Mirror.' });
  await expect(moves(page)).toHaveCount(2);
  await expect(page.getByText('Fixture Agent 2 (self-reported)')).toBeVisible();
  await typeMove(page, 'g1f3');
  expect((await reply).result).toMatchObject({ result: 'accepted', board: { status: 'your-turn', input: { previousThinking: { plan: 'Mirror.' } } } });
});
