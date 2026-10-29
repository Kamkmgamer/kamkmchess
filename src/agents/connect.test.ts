import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PREFERENCES, fetchMcpAvailability, mcpUrl, remotePrompt, setupSteps,
} from './connect.js';

const urls = { mcp: 'https://chess.example/v1/mcp' };

describe('agent connection setup', () => {
  it('builds the remote endpoint from the service origin', () => {
    expect(mcpUrl('https://api.example/')).toBe('https://api.example/v1/mcp');
  });

  it('writes the chosen color and strength into the remote prompt', () => {
    const prompt = remotePrompt({ ...DEFAULT_AGENT_PREFERENCES, color: 'black', level: 'strong' }, urls.mcp);
    expect(prompt).toContain('start_game with color: "black", engine_think_ms: 5000');
    expect(prompt).toContain('get_rules first');
    expect(prompt).toContain('do not run code');
    expect(prompt).toContain('15 seconds');
    expect(remotePrompt(DEFAULT_AGENT_PREFERENCES, urls.mcp)).not.toContain('15 seconds');
  });

  it('lets the agent ask instead of presetting', () => {
    const prompt = remotePrompt({ ...DEFAULT_AGENT_PREFERENCES, askMe: true }, urls.mcp);
    expect(prompt).toContain('ask me which color');
    expect(prompt).not.toContain('color: "white"');
  });

  it('hands a human opponent a shared game through MCP', () => {
    const prompt = remotePrompt({ ...DEFAULT_AGENT_PREFERENCES, opponent: 'human' }, urls.mcp);
    expect(prompt).toContain('https://chess.example/v1/mcp');
    expect(prompt).toContain('opponent: "human"');
    expect(prompt).not.toContain('engine_think_ms');
    expect(prompt).toContain('Do not use GUI, browser tools or computer use');
    expect(prompt).toContain('watch_url');
    expect(prompt).toContain('opponent_url');
  });

  it('gives each client its own install step and the same prompt', () => {
    expect(setupSteps('claude-code', DEFAULT_AGENT_PREFERENCES, urls)[0]?.copy?.value)
      .toBe('claude mcp add --transport http kamkm-chess https://chess.example/v1/mcp');
    expect(setupSteps('codex', DEFAULT_AGENT_PREFERENCES, urls)[0]?.copy?.value)
      .toBe('codex mcp add kamkm-chess --url https://chess.example/v1/mcp');
    expect(JSON.parse(setupSteps('mcp', DEFAULT_AGENT_PREFERENCES, urls)[0]?.copy?.value ?? ''))
      .toEqual({ mcpServers: { 'kamkm-chess': { url: urls.mcp } } });
    for (const client of ['claude-code', 'codex', 'claude-ai', 'chatgpt', 'mcp'] as const) {
      expect(setupSteps(client, DEFAULT_AGENT_PREFERENCES, urls).at(-1)?.copy?.value).toBe(remotePrompt(DEFAULT_AGENT_PREFERENCES, urls.mcp));
    }
  });

  it('shows no steps when MCP is unavailable', () => {
    expect(setupSteps('claude-code', DEFAULT_AGENT_PREFERENCES, { ...urls, mcp: null })).toEqual([]);
    expect(setupSteps('mcp', DEFAULT_AGENT_PREFERENCES, { ...urls, mcp: null })).toEqual([]);
  });

  it('reads the endpoint switch from the feature answer and fails closed', async () => {
    const answer = (body: unknown, ok = true) => (() => Promise.resolve({ ok, json: () => Promise.resolve(body) })) as unknown as typeof fetch;
    expect(await fetchMcpAvailability('https://api.example', answer({ friends: false, queue: false, mcp: true }))).toBe(true);
    expect(await fetchMcpAvailability('https://api.example', answer({ friends: true, queue: true }))).toBe(false);
    expect(await fetchMcpAvailability('https://api.example', answer({ mcp: true }, false))).toBe(false);
    expect(await fetchMcpAvailability(null, answer({ mcp: true }))).toBe(false);
    expect(await fetchMcpAvailability('https://api.example', (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).toBe(false);
  });
});
