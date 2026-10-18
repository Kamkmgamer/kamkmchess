import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { applyTheme, isAppearance, readThemePreferences, saveThemePreferences, THEME_STORAGE_KEY } from './theme.js';
import type { ThemePreferences } from './theme.js';
import { T3_PALETTES } from './ui/t3-palettes.js';

function subscribeToAppearance(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

const systemIsDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function useTheme() {
  const [preferences, setPreferences] = useState(readThemePreferences);
  const systemDark = useSyncExternalStore(subscribeToAppearance, systemIsDark, () => false);

  useLayoutEffect(() => applyTheme(preferences, systemDark), [preferences, systemDark]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setPreferences(readThemePreferences());
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);

  function update(next: ThemePreferences) {
    saveThemePreferences(next);
    setPreferences(next);
  }

  return {
    ...preferences,
    setTheme(theme: string) {
      if (T3_PALETTES.some(palette => palette.id === theme)) update({ ...preferences, theme });
    },
    setAppearance(appearance: string) {
      if (isAppearance(appearance)) update({ ...preferences, appearance });
    },
  };
}
