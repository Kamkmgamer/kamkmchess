#!/usr/bin/env node
// The kamkm chess agent runner: plays games against the server's Stockfish
// through the remote MCP endpoint, with the model locked down so a result
// means the model chose its own moves.
//
//   node scripts/agent-runner.mjs --via api --model anthropic/claude-opus-5.5
//   node scripts/agent-runner.mjs --via claude-code --model opus
//   node scripts/agent-runner.mjs --via codex
//
// Routes:
//   api          The runner talks to an OpenAI-compatible chat API
//                (OpenRouter by default) and shows the model only the turn
//                input. The model has no tools at all.
//   claude-code  `claude -p` with every built-in tool switched off and only
//                this server's MCP tools available.
//   codex        `codex exec` with a read-only sandbox. Codex can still run
//                shell commands, so its games never use an invite code and
//                always count on the community board.
//
// An operator-issued invite code (--invite or KAMKM_INVITE_CODE) puts api
// and claude-code games on the verified board. The code goes to the server
// from the runner only; the model never sees it.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

/** @type {Record<string, number>} */
const LEVELS = { casual: 100, club: 1000, strong: 5000 };
const VERIFIED_ROUTES = new Set(['api', 'claude-code']);

export const SYSTEM_PROMPT = [
  'You are playing a game of chess against Stockfish. Each turn you get the current position as JSON:',
  'fen, the moves so far, the clocks, the illegal moves you have left this turn and your plan from last turn.',
  'Choose exactly one legal move for your side. Answer with only a JSON object:',
  '{"move": "<from><to>[promotion]", "plan": "<at most 80 words>"}, for example {"move": "e2e4", "plan": "Take the centre."}.',
  'Use coordinate form: from and to squares, with q, r, b or n appended to promote (e7e8q).',
  'Think for yourself. Four illegal moves in one turn lose the game.',
].join(' ');

/**
 * A tool answer: a board, a move result or { error }. The server owns its shape.
 * @typedef {Record<string, any>} ToolAnswer
 */

/**
 * @typedef {object} RunOptions
 * @property {string} via
 * @property {string} server
 * @property {string | undefined} model
 * @property {string} name
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} color
 * @property {string} level
 * @property {number} minutes
 * @property {number} increment
 * @property {string} invite
 */

/** A minimal MCP Streamable HTTP client for the server's JSON answers. */
export class McpClient {
  /**
   * @param {string} url
   * @param {typeof fetch} [fetcher]
   */
  constructor(url, fetcher = fetch) {
    this.url = url;
    this.fetcher = fetcher;
    /** @type {string | null} */
    this.session = null;
    this.nextId = 0;
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  async rpc(method, params = {}) {
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.session) headers['mcp-session-id'] = this.session;
    const response = await this.fetcher(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.nextId, method, params }) });
    const session = response.headers.get('mcp-session-id');
    if (session) this.session = session;
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }

  async connect() {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kamkm-runner', version: '1' } });
  }

  /**
   * Calls a tool; a tool error is returned as { error }.
   * @param {string} name
   * @param {object} [args]
   * @returns {Promise<ToolAnswer>}
   */
  async call(name, args = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (result.isError) return { error: result.content?.[0]?.text ?? 'tool error' };
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }
}

/**
 * Reads a {move, plan} answer, tolerating a fenced block or prose around it.
 * @param {string | null | undefined} text
 * @returns {{ move: string, plan: string } | null}
 */
export function parseAnswer(text) {
  const match = /\{[\s\S]*\}/.exec(text ?? '');
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    return typeof value.move === 'string' ? { move: value.move.trim(), plan: typeof value.plan === 'string' ? value.plan : '' } : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ baseUrl: string, apiKey: string, model?: string | undefined }} options
 * @param {{ role: string, content: string }[]} messages
 * @param {typeof fetch} [fetcher]
 * @returns {Promise<string>}
 */
async function chat({ baseUrl, apiKey, model }, messages, fetcher = fetch) {
  const response = await fetcher(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages }),
  });
  if (!response.ok) throw new Error(`the model API answered ${response.status}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? '';
}

/**
 * Plays one game with the runner choosing nothing: the model sees only the turn input.
 * @param {McpClient} client
 * @param {Omit<RunOptions, 'via' | 'server'>} options
 * @param {(line: string) => void} log
 * @param {typeof fetch} [fetcher]
 * @returns {Promise<ToolAnswer>}
 */
export async function playApiGame(client, options, log, fetcher = fetch) {
  let board = await client.call('start_game', startArgs(options, 'api'));
  if (board.error) throw new Error(board.error);
  log(`game ${board.gameId}: ${board.yourSide}, ${board.board ?? 'community'} board`);
  while (board.status !== 'finished') {
    if (board.status !== 'your-turn') {
      board = await client.call('wait_for_turn', { timeout_seconds: 25 });
      if (board.error) throw new Error(board.error);
      continue;
    }
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(board.input) }];
    let outcome = null;
    for (let formatTries = 0; outcome === null && formatTries < 3; formatTries++) {
      const text = await chat(options, messages, fetcher);
      const answer = parseAnswer(text);
      messages.push({ role: 'assistant', content: text });
      if (!answer) {
        messages.push({ role: 'user', content: 'Answer with only the JSON object {"move": "...", "plan": "..."}.' });
        continue;
      }
      const played = await client.call('make_move', { move: answer.move, plan: answer.plan });
      if (played.error) {
        messages.push({ role: 'user', content: `${played.error} Choose again.` });
        continue;
      }
      if (played.result === 'illegal' && played.board.status !== 'finished') {
        messages.push({ role: 'user', content: played.message });
        formatTries = -1;
        continue;
      }
      outcome = played;
      log(`${answer.move}: ${played.result}`);
    }
    if (outcome === null) {
      log('the model gave no usable move three times; resigning');
      outcome = await client.call('resign');
    }
    board = outcome.board;
  }
  return board;
}

/**
 * @param {Pick<RunOptions, 'name' | 'color' | 'level' | 'minutes' | 'increment' | 'invite'>} options
 * @param {string} route
 */
function startArgs(options, route) {
  return {
    model_name: options.name,
    color: options.color,
    engine_think_ms: LEVELS[options.level],
    minutes: options.minutes,
    increment_seconds: options.increment,
    runner: `kamkm-runner/${route}`,
    ...(options.invite && VERIFIED_ROUTES.has(route) ? { invite_code: options.invite } : {}),
  };
}

/** @param {string} token */
function cliPrompt(token) {
  return [
    'Play one game of chess with the kamkm-chess tools. Your game already exists:',
    `call resume_game with resume_token "${token}", then get_rules, and follow them.`,
    'On each turn read the input from the board, choose one move yourself and call make_move with it and a short plan.',
    'Use wait_for_turn while Stockfish thinks. Keep going until the game is over, then say the result in one line.',
  ].join(' ');
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {(line: string) => void} log
 * @returns {Promise<number | null>}
 */
function run(command, args, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => log(String(chunk).trimEnd()));
    child.stderr.on('data', (chunk) => log(String(chunk).trimEnd()));
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

/**
 * Starts the game itself, then lets a locked-down CLI agent play it.
 * @param {McpClient} client
 * @param {RunOptions} options
 * @param {(line: string) => void} log
 * @returns {Promise<ToolAnswer>}
 */
export async function playCliGame(client, options, log) {
  const started = await client.call('start_game', startArgs(options, options.via));
  if (started.error) throw new Error(started.error);
  log(`game ${started.gameId}: ${started.yourSide}, ${started.board ?? 'community'} board`);
  const directory = await mkdtemp(join(tmpdir(), 'kamkm-runner-'));
  try {
    if (options.via === 'claude-code') {
      const config = join(directory, 'mcp.json');
      await writeFile(config, JSON.stringify({ mcpServers: { 'kamkm-chess': { type: 'http', url: options.server } } }));
      await run('claude', ['-p', cliPrompt(started.resume_token), '--tools', '', '--strict-mcp-config', '--mcp-config', config,
        '--allowedTools', 'mcp__kamkm-chess__*', ...(options.model ? ['--model', options.model] : [])], log);
    } else {
      await run('codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', directory,
        '-c', `mcp_servers.kamkm-chess.url="${options.server}"`, '-c', 'mcp_servers.kamkm-chess.default_tools_approval_mode="approve"', ...(options.model ? ['-m', options.model] : []), cliPrompt(started.resume_token)], log);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // The runner's own session still holds the game; read how it ended.
  let board = await client.call('get_board');
  if (board.status !== 'finished') {
    log('the agent stopped before the game ended; resigning for it');
    board = (await client.call('resign')).board ?? board;
  }
  return board;
}

function usage() {
  return `Usage: node scripts/agent-runner.mjs --via api|claude-code|codex [options]

  --server URL         Remote MCP endpoint (default https://chess.khalil.mageed.net/v1/mcp)
  --model ID           Model id (api: required, e.g. anthropic/claude-opus-5.5)
  --name NAME          Name on the board (default: the model id)
  --base-url URL       OpenAI-compatible API (default https://openrouter.ai/api/v1)
  --api-key-env NAME   Environment variable with the API key (default OPENROUTER_API_KEY)
  --color white|black|random   (default white)
  --level casual|club|strong   Stockfish strength (default club)
  --minutes N --increment N    Clock (default 180 and 60)
  --games N            Games to play in a row (default 1)
  --invite CODE        Verified-board invite code (or KAMKM_INVITE_CODE)`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      via: { type: 'string' }, server: { type: 'string', default: 'https://chess.khalil.mageed.net/v1/mcp' },
      model: { type: 'string' }, name: { type: 'string' }, 'base-url': { type: 'string', default: 'https://openrouter.ai/api/v1' },
      'api-key-env': { type: 'string', default: 'OPENROUTER_API_KEY' }, color: { type: 'string', default: 'white' },
      level: { type: 'string', default: 'club' }, minutes: { type: 'string', default: '180' }, increment: { type: 'string', default: '60' },
      games: { type: 'string', default: '1' }, invite: { type: 'string' }, help: { type: 'boolean' },
    },
  });
  if (values.help || !['api', 'claude-code', 'codex'].includes(values.via ?? '') || !(values.level in LEVELS)) {
    process.stdout.write(`${usage()}\n`);
    process.exit(values.help ? 0 : 2);
  }
  /** @type {RunOptions} */
  const options = {
    via: values.via ?? '', server: values.server, model: values.model, baseUrl: values['base-url'],
    color: values.color, level: values.level, minutes: Number(values.minutes), increment: Number(values.increment),
    invite: values.invite ?? process.env.KAMKM_INVITE_CODE ?? '',
    name: values.name ?? values.model ?? (values.via === 'codex' ? 'Codex' : 'Claude'),
    apiKey: process.env[values['api-key-env']] ?? '',
  };
  if (options.via === 'api' && (!options.model || !options.apiKey)) {
    process.stderr.write(`--via api needs --model and an API key in ${values['api-key-env']}\n`);
    process.exit(2);
  }
  if (options.invite && !VERIFIED_ROUTES.has(options.via)) process.stderr.write('codex games are not locked down, so they go on the community board; the invite code is not used.\n');
  /** @param {string} line */
  const log = (line) => process.stderr.write(`${line}\n`);
  for (let game = 0; game < Number(values.games); game++) {
    const client = new McpClient(options.server);
    await client.connect();
    const board = options.via === 'api' ? await playApiGame(client, options, log) : await playCliGame(client, options, log);
    process.stdout.write(`${JSON.stringify({ gameId: board.gameId, side: board.yourSide, result: board.result, moves: board.moves?.length ?? 0 })}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
