import { ConnectionError } from './types';
import type { ConnectionProfile } from './types';

export interface ManualModelReference {
  readonly connectionId: string;
  readonly requestedModelId: string;
  readonly source: 'manual';
}

export function createManualModelReference(profile: ConnectionProfile, input: string): ManualModelReference {
  if (input.length === 0 || input.trim() !== input) {
    throw new ConnectionError('invalid-model-id', 'Enter a model ID without leading or trailing whitespace.');
  }
  return {
    connectionId: profile.id,
    requestedModelId: input,
    source: 'manual',
  };
}
