import { describe, expect, it } from 'vitest';
import { CLI_PROXY_CLAUDE_MAX_OUTPUT_TOKENS, MODEL_TURN_MAX_OUTPUT_TOKENS, outputTokensForModel, reasoningEffortForModel } from './model-turn-config';
import { encodeChatCompletionsRequest } from './protocols/chat-completions';

describe('model turn output budget', () => {
  it('leaves room for hidden reasoning before the move JSON', () => {
    const request = encodeChatCompletionsRequest({ instructions: 'Return one move.', records: [] }, {
      model: 'claude-opus-5-5',
      maxOutputTokens: MODEL_TURN_MAX_OUTPUT_TOKENS,
      reasoningEffort: 'none',
    });

    expect(MODEL_TURN_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(request.body.max_completion_tokens).toBe(4096);
    expect(request.body.reasoning_effort).toBe('none');
  });

  it('normalizes every configured level for every provider and protocol', () => {
    expect(reasoningEffortForModel('cliproxy', 'chat-completions', 'claude-opus-5-5')).toBe('low');
    expect(reasoningEffortForModel('cliproxy', 'chat-completions', 'gpt-6-astra')).toBe('low');
    expect(reasoningEffortForModel('cliproxy', 'chat-completions', 'claude-opus-5-5', 'medium')).toBe('medium');
    expect(reasoningEffortForModel('cliproxy', 'chat-completions', 'claude-opus-5-5', 'high')).toBe('high');
    expect(reasoningEffortForModel('cliproxy', 'chat-completions', 'claude-opus-5-5', 'x-high')).toBe('xhigh');
    expect(reasoningEffortForModel('cliproxy', 'chat-completions', 'claude-opus-5-5', 'xhigh')).toBe('xhigh');
    expect(reasoningEffortForModel('cliproxy', 'chat-completions', 'claude-opus-5-5', 'max')).toBe('max');
    expect(reasoningEffortForModel('openrouter', 'chat-completions', 'claude-opus-5-5')).toBe('low');
    expect(reasoningEffortForModel('anthropic', 'messages', 'claude-sonnet-4')).toBe('low');
    expect(reasoningEffortForModel('openai', 'responses', 'gpt-5', 'medium')).toBe('medium');
    expect(reasoningEffortForModel('custom', 'chat-completions', 'any-model', 'max')).toBe('max');
    expect(outputTokensForModel('cliproxy', 'chat-completions', 'claude-opus-5-5')).toBe(CLI_PROXY_CLAUDE_MAX_OUTPUT_TOKENS);
    expect(CLI_PROXY_CLAUDE_MAX_OUTPUT_TOKENS).toBe(128_000);
  });
});
