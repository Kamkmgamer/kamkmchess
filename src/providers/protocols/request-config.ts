import type { ProtocolGenerationConfig } from './types';

export function validateGenerationConfig(
  config: ProtocolGenerationConfig,
): void {
  if (config.model.length === 0 || config.model.trim() !== config.model) {
    throw new TypeError('Model ID must be non-empty and have no surrounding whitespace.');
  }
  if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) {
    throw new RangeError('maxOutputTokens must be a positive integer.');
  }
}
