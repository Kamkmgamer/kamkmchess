import assert from 'node:assert/strict';
import test from 'node:test';
import { McpClient, parseAnswer, playApiGame } from './agent-runner.mjs';

test('parseAnswer reads the move from plain, fenced and chatty answers', () => {
  assert.deepEqual(parseAnswer('{"move":"e2e4","plan":"centre"}'), { move: 'e2e4', plan: 'centre' });
  assert.deepEqual(parseAnswer('Sure!\n```json\n{"move": " g1f3 "}\n```'), { move: 'g1f3', plan: '' });
  assert.equal(parseAnswer('I play e4'), null);
  assert.equal(parseAnswer('{"plan":"no move"}'), null);
});

/** A scripted MCP server and model: the model is wrong once, then plays. */
function fakes() {
  /** @type {{ name: string, arguments: Record<string, unknown> }[]} */
  const calls = [];
  let moves = 0;
  /** @param {string} status */
  const board = (status) => ({ status, gameId: 'g1', yourSide: 'white', moves: [], input: { kind: 'current-match-input', fen: 'x' } });
  /** @type {typeof fetch} */
  const mcp = async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body));
    let result = {};
    if (method === 'tools/call') {
      calls.push(params);
      let value;
      switch (params.name) {
        case 'start_game': value = { ...board('your-turn'), board: 'verified' }; break;
        case 'make_move':
          if (params.arguments.move === 'e2e5') value = { result: 'illegal', message: 'e2e5 is illegal here.', board: board('your-turn') };
          else value = { result: 'accepted', board: board(++moves >= 2 ? 'finished' : 'your-turn') };
          break;
        default: value = board('your-turn');
      }
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'mcp-session-id': 's1' } });
  };
  const answers = ['e5 please', '{"move":"e2e5"}', '{"move":"e2e4","plan":"centre"}', '{"move":"d2d4"}'];
  /** @type {unknown[]} */
  const prompts = [];
  /** @type {typeof fetch} */
  const model = async (_url, init) => {
    prompts.push(JSON.parse(String(init?.body)).messages);
    return new Response(JSON.stringify({ choices: [{ message: { content: answers.shift() } }] }));
  };
  return { calls, mcp, model, prompts };
}

test('the api route shows the model only the input and keeps the invite to itself', async () => {
  const { calls, mcp, model, prompts } = fakes();
  const client = new McpClient('https://chess.example/v1/mcp', mcp);
  await client.connect();
  const options = { name: 'Model X', color: 'white', level: 'casual', minutes: 10, increment: 0, invite: 'kinv_secret', baseUrl: 'https://api.example', apiKey: 'k', model: 'x' };
  const final = await playApiGame(client, options, () => {}, model);
  assert.equal(final.status, 'finished');
  const start = calls.find((call) => call.name === 'start_game');
  assert.ok(start, 'the runner never started a game');
  assert.equal(start.arguments.invite_code, 'kinv_secret');
  assert.equal(start.arguments.runner, 'kamkm-runner/api');
  assert.equal(start.arguments.engine_think_ms, 100);
  for (const messages of prompts) assert.ok(!JSON.stringify(messages).includes('kinv_secret'), 'the model saw the invite code');
  // The chatty answer was corrected, the illegal move was fed back, then two moves were played.
  assert.deepEqual(calls.filter((call) => call.name === 'make_move').map((call) => call.arguments.move), ['e2e5', 'e2e4', 'd2d4']);
  assert.ok(JSON.stringify(prompts[2]).includes('e2e5 is illegal here.'));
});
