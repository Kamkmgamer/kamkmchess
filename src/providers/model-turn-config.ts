import type { ReasoningLevel } from './reasoning-preferences.js';

/**
 * Maximum completion budget for one chess move request.
 *
 * Reasoning models can spend completion tokens on hidden reasoning before
 * emitting the small JSON move. Keep this above the visible answer size so a
 * provider such as CLIProxyAPI does not finish with `length` first.
 */
export const MODEL_TURN_MAX_OUTPUT_TOKENS = 4096;
/** CLIProxyAPI's current Claude model catalog ceiling for Opus 5.5. */
export const CLI_PROXY_CLAUDE_MAX_OUTPUT_TOKENS = 128_000;

/** Values accepted by the OpenAI-compatible reasoning_effort field. */
export type ModelReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Keep the selected effort independent of model names and providers. Each
 * protocol encoder translates this common value into its native request
 * shape, so newly advertised models inherit the setting automatically.
 */
export function reasoningEffortForModel(
  provider: string,
  protocol: string,
  _model: string,
  requestedLevel: ReasoningLevel | ModelReasoningEffort = 'low',
): ModelReasoningEffort | undefined {
  void provider;
  void protocol;
  void _model;
  return requestedLevel === 'x-high' ? 'xhigh' : requestedLevel;
}

export function outputTokensForModel(provider: string, protocol: string, model: string): number {
  return provider === 'cliproxy' && protocol === 'chat-completions' && /claude/i.test(model)
    ? CLI_PROXY_CLAUDE_MAX_OUTPUT_TOKENS
    : MODEL_TURN_MAX_OUTPUT_TOKENS;
}
