import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVEL_STORAGE_KEY,
  readReasoningLevel,
  saveReasoningLevel,
} from './reasoning-preferences.js';

function storage(initial?: string): Storage {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
    removeItem: () => { value = null; },
    clear: () => { value = null; },
    key: () => null,
    get length() { return value === null ? 0 : 1; },
  };
}

describe('reasoning preferences', () => {
  it('accepts all supported levels and persists them', () => {
    const target = storage();
    for (const level of ['low', 'medium', 'high', 'x-high', 'max'] as const) {
      saveReasoningLevel(level, target);
      expect(readReasoningLevel(target)).toBe(level);
    }
  });

  it('falls back for missing or invalid storage values', () => {
    expect(readReasoningLevel(storage())).toBe(DEFAULT_REASONING_LEVEL);
    expect(readReasoningLevel(storage('invalid'))).toBe(DEFAULT_REASONING_LEVEL);
  });

  it('uses the stable storage key', () => {
    const target = storage();
    saveReasoningLevel('max', target);
    expect(target.getItem(REASONING_LEVEL_STORAGE_KEY)).toBe('max');
  });
});
