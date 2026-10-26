/** Shared reasoning levels mapped to each provider protocol at request time. */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'x-high', 'max'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'low';
export const REASONING_LEVEL_STORAGE_KEY = 'kamkmchess.reasoning-level.v1';

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value);
}

/** Read the user's preferred reasoning level, falling back safely outside a browser. */
export function readReasoningLevel(storage: Storage | null = typeof window === 'undefined' ? null : window.localStorage): ReasoningLevel {
  if (storage === null) return DEFAULT_REASONING_LEVEL;
  try {
    const value = storage.getItem(REASONING_LEVEL_STORAGE_KEY);
    return isReasoningLevel(value) ? value : DEFAULT_REASONING_LEVEL;
  } catch {
    return DEFAULT_REASONING_LEVEL;
  }
}

/** Persist a validated reasoning level for subsequent model turns. */
export function saveReasoningLevel(level: ReasoningLevel, storage: Storage | null = typeof window === 'undefined' ? null : window.localStorage): void {
  if (storage === null) return;
  try { storage.setItem(REASONING_LEVEL_STORAGE_KEY, level); } catch { /* Storage can be unavailable in private contexts. */ }
}
