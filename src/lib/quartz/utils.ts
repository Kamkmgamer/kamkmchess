import type * as React from 'react';
import {clsx, type ClassValue} from 'clsx';
import {extendTailwindMerge} from 'tailwind-merge';

// Quartz's own utilities, registered so tailwind-merge resolves conflicts between them:
// a later type-* role replaces an earlier one, and text-text-2 replaces text-text-1.
const twMerge = extendTailwindMerge<'type-role'>({
  extend: {
    classGroups: {
      'type-role': [{type: ['display-xl', 'display-lg', 'display', 'heading-lg', 'heading', 'heading-sm', 'heading-xs', 'body-lg', 'body', 'body-sm', 'button', 'label', 'label-sm', 'code', 'code-sm', 'code-display', 'code-touch', 'stat-xl', 'stat-lg', 'stat', 'state-word']}],
    },
  },
});

/**
 * The height of a one-line control, one formula for every control of that size: the size's token, or one line plus
 * 8, 12 or 24px of padding if the text grows past it. Button, Select and SegmentedControl take it from here; a
 * Field input never wraps, so its fixed token height is the same number.
 */
export const controlHeight = {
  xs: 'h-[max(var(--control-xs),1lh)]',
  sm: 'h-[max(var(--control-sm),calc(1lh+var(--space-2)))]',
  default: 'h-[max(var(--control),calc(1lh+var(--space-3)))]',
  lg: 'h-[max(var(--control-lg),calc(1lh+var(--space-6)))]',
} as const;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Quartz's classes and the caller's, for a Base UI part whose className may be a function of its state
 * (data-checked, open, disabled ...). A function is composed, not passed through, so Quartz's classes stay either way.
 * Pass several base parts as an array: mergeClass([variants({size}), 'gap-2'], className).
 */
export function mergeClass<State>(base: ClassValue, className: string | ((state: State) => string | undefined) | undefined): string | ((state: State) => string) {
  return typeof className === 'function' ? (state: State) => cn(base, className(state)) : cn(base, className);
}

/**
 * One callback ref that sets every ref it is given, for a component that keeps its own ref and forwards the caller's.
 * Wrap it in useMemo or useCallback when the element should not be detached and attached again on every render.
 */
export function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> {
  return node => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.RefObject<T | null>).current = node;
    }
  };
}

/**
 * A component's words: its defaults with the caller's on top. A key the caller left undefined keeps the
 * default, so `labels={{send: maybeTranslated}}` never blanks a button when a translation is missing.
 */
export function withDefaults<T extends object, G extends object = Partial<T>>(defaults: T, given?: G): T & Omit<G, keyof T> {
  const out = {...defaults} as Record<string, unknown>;
  if (given) for (const [key, value] of Object.entries(given)) if (value !== undefined) out[key] = value;
  return out as T & Omit<G, keyof T>;
}
