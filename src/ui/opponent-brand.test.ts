import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { OpponentBadge } from './OpponentBadge.js';
import { cleanReportedName, resolveOpponentBrand, resolveReportedBrand } from './opponent-brand.js';
import { createEngineSelection } from '../engines/local.js';
import { createAgentSelection } from '../agents/seat.js';

describe('opponent brand recognition', () => {
  it.each([
    ['gpt-5.2', 'chatgpt'], [' GPT-6.1 ', 'chatgpt'], ['gpt5', 'chatgpt'],
    ['openai/gpt-oss-120b', 'chatgpt'], ['chatgpt-4o-latest', 'chatgpt'],
    ['o1-preview', 'chatgpt'], ['openai/o3-mini', 'chatgpt'], ['o4-mini', 'chatgpt'],
    ['Codex', 'chatgpt'], ['gpt-5.3-codex', 'chatgpt'],
    ['anthropic/claude-sonnet-4.6', 'claude'], ['Claude Code', 'claude'], ['opus-4.6', 'claude'],
    ['google/gemini-2.5-pro:free', 'gemini'], ['Gemini CLI', 'gemini'],
    ['x-ai/grok-4-fast', 'grok'], ['moonshotai/kimi-k2-thinking', 'kimi'], ['Kimi CLI', 'kimi'],
    ['moonshot-v1-128k', 'kimi'], ['z-ai/glm-4.7', 'glm'], ['chatglm3-6b', 'glm'],
    ['deepseek/deepseek-r1', 'deepseek'], ['qwen/qwen3-235b-a22b', 'qwen'],
    ['Qwen3-Coder', 'qwen'], ['QwQ-32B', 'qwen'], ['meta-llama/llama-4-scout', 'llama'],
    ['mistralai/mistral-large', 'mistral'], ['codestral-latest', 'mistral'],
    ['MiniMax-M2.5', 'minimax'], ['stockfish-lite', 'stockfish'], ['Stockfish 19', 'stockfish'],
    ['stockfish-full', 'stockfish'], ['lc0', 'leela'], ['Leela Chess Zero', 'leela'], ['lczero', 'leela'],
    ['proxy/team/CLAUDE_OPUS_4_6', 'claude'],
  ])('recognizes %s as %s', (modelId, brand) => {
    expect(resolveOpponentBrand(modelId)).toBe(brand);
  });

  it('prefers the actual model over a routing namespace', () => {
    expect(resolveOpponentBrand('openai/claude-sonnet-4.6')).toBe('claude');
    expect(resolveOpponentBrand('anthropic/gpt-5.2')).toBe('chatgpt');
  });

  it('strips the self-reported marker from names an agent chose itself', () => {
    expect(cleanReportedName('GLM-4.7 (self-reported)')).toBe('GLM-4.7');
    expect(cleanReportedName('Kimi K2  (SELF-REPORTED) ')).toBe('Kimi K2');
    expect(cleanReportedName('Claude Opus')).toBe('Claude Opus');
  });

  it.each([
    ['GLM-4.7 (self-reported)', 'glm'], ['Kimi K2 (self-reported)', 'kimi'],
    ['MiniMax M2.5 (self-reported)', 'minimax'], ['Claude Opus 5.5 (self-reported)', 'claude'],
    ['GPT-5.2 (self-reported)', 'chatgpt'], ['Gemini 3 Pro (self-reported)', 'gemini'],
    ['Qwen3-Max (self-reported)', 'qwen'], ['Mistral Large (self-reported)', 'mistral'],
    ['Grok 4 (self-reported)', 'grok'], ['Human (self-reported)', null], ['Mystery agent', null],
  ])('resolves the family of a reported name: %s', (label, brand) => {
    expect(resolveReportedBrand(label)).toBe(brand);
  });

  it.each(['', 'offline-fixture', 'custom-agent', 'openrouter/auto', 'mygptwrapper', 'notclaude', 'o123', 'stockfisher'])('keeps unknown or unrelated names neutral: %s', modelId => {
    expect(resolveOpponentBrand(modelId)).toBeNull();
  });
});

describe('opponent badges', () => {
  const automated = createEngineSelection({ engineId: 'stockfish-lite', hashMb: 16, moveTimeMs: 1000 });

  it('uses the same model identity for either color, even through a proxy', () => {
    for (const side of ['white', 'black'] as const) {
      const html = renderToStaticMarkup(createElement(OpponentBadge, {
        side, player: { ...automated, providerId: 'cliproxy', modelRoutingId: 'anthropic/claude-sonnet-4.6' },
      }));
      expect(html).toContain('alt="Claude logo"');
      expect(html).not.toContain('dark-piece');
      expect(html).not.toContain('light-piece');
    }
  });

  it('identifies an engine and uses a neutral icon for an unknown AI', () => {
    expect(renderToStaticMarkup(createElement(OpponentBadge, { side: 'black', player: automated }))).toContain('alt="Stockfish logo"');
    const html = renderToStaticMarkup(createElement(OpponentBadge, {
      side: 'white', player: { ...automated, providerId: 'custom', modelRoutingId: 'unknown-agent' },
    }));
    expect(html).toContain('aria-label="AI opponent"');
    expect(html).not.toContain('<img');
  });

  it('preserves local human color badges', () => {
    expect(renderToStaticMarkup(createElement(OpponentBadge, { side: 'white', player: { kind: 'human' } }))).toContain('class="player-badge light-piece"');
    expect(renderToStaticMarkup(createElement(OpponentBadge, { side: 'black', player: { kind: 'human' } }))).toContain('class="player-badge dark-piece"');
  });

  it('brands an agent seat by the name it reported', () => {
    const agent = createAgentSelection();
    expect(renderToStaticMarkup(createElement(OpponentBadge, { side: 'white', player: agent }))).toContain('aria-label="AI opponent"');
    expect(renderToStaticMarkup(createElement(OpponentBadge, { side: 'white', player: agent, reportedName: 'GLM-4.7 (self-reported)' }))).toContain('data-brand="glm"');
  });

  it('shows the signed-in account photo on its own human seat', () => {
    const html = renderToStaticMarkup(createElement(OpponentBadge, {
      side: 'white', player: { kind: 'human' },
      accountUser: { name: 'Alex Player', imageUrl: 'https://img.clerk.com/account.png' },
    }));
    expect(html).toContain('src="https://img.clerk.com/account.png"');
    expect(html).toContain('title="Alex Player"');
    // A signed-in account without a photo keeps the neutral badge.
    const plain = renderToStaticMarkup(createElement(OpponentBadge, {
      side: 'white', player: { kind: 'human' }, accountUser: { name: 'Alex Player', imageUrl: null },
    }));
    expect(plain).toContain('player-badge light-piece');
    expect(plain).not.toContain('<img');
  });
});
