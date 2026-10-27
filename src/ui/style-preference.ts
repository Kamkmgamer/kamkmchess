/** A localStorage-backed string choice shared by every picker and surface in this tab, and across tabs. */
export function createStylePreference<T extends string>(config: {
  readonly options: Record<T, unknown>;
  readonly fallback: T;
  readonly storageKey: string;
  readonly changeEvent: string;
}) {
  let current: T | undefined;

  function isOption(value: unknown): value is T {
    return typeof value === 'string' && Object.hasOwn(config.options, value);
  }

  function readStored(): T {
    try {
      const saved = window.localStorage.getItem(config.storageKey);
      return isOption(saved) ? saved : config.fallback;
    } catch {
      return current ?? config.fallback;
    }
  }

  return {
    isOption,
    get(): T {
      return current ??= readStored();
    },
    /** Select an option, keep it for the next visit and notify every picker in this tab. */
    set(value: string): void {
      if (!isOption(value)) return;
      current = value;
      try { window.localStorage.setItem(config.storageKey, value); }
      catch { /* Keep the selected style for this page when storage is unavailable. */ }
      window.dispatchEvent(new Event(config.changeEvent));
    },
    subscribe(onChange: () => void): () => void {
      const update = (event: StorageEvent) => {
        if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
        if (event.key !== config.storageKey && event.key !== null) return;
        current = readStored();
        onChange();
      };
      window.addEventListener(config.changeEvent, onChange);
      window.addEventListener('storage', update);
      return () => {
        window.removeEventListener(config.changeEvent, onChange);
        window.removeEventListener('storage', update);
      };
    },
  };
}
