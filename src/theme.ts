import { T3_PALETTES } from './ui/t3-palettes.js';
import { SCREEN_PALETTE } from './ui/screen-palette.js';

export type Appearance = 'light' | 'dark' | 'system';
export interface ThemePreferences {
  readonly theme: string;
  readonly appearance: Appearance;
}

export const THEME_STORAGE_KEY = 'kamkmchess.theme.v1';
const DEFAULTS: ThemePreferences = { theme: SCREEN_PALETTE.id, appearance: 'system' };

export function isAppearance(value: unknown): value is Appearance {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readThemePreferences(): ThemePreferences {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY) ?? 'null');
    if (typeof saved !== 'object' || saved === null) return DEFAULTS;
    const theme: unknown = Reflect.get(saved, 'theme');
    const appearance: unknown = Reflect.get(saved, 'appearance');
    return {
      theme: typeof theme === 'string' && T3_PALETTES.some(palette => palette.id === theme) ? theme : DEFAULTS.theme,
      appearance: isAppearance(appearance) ? appearance : DEFAULTS.appearance,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveThemePreferences(preferences: ThemePreferences): void {
  try { window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(preferences)); }
  catch { /* Theme changes still work when browser storage is unavailable. */ }
}

/** Both entry points use the same palette roles before rendering their UI. */
export function applyTheme(preferences: ThemePreferences, systemDark: boolean): void {
  const palette = (T3_PALETTES.find(item => item.id === preferences.theme) ?? SCREEN_PALETTE) as {
    id: string;
    colors: Record<string, string>;
    variants?: Partial<Record<'dark' | 'light', Record<string, string>>>;
  };
  const resolved = preferences.appearance === 'system' ? (systemDark ? 'dark' : 'light') : preferences.appearance;
  const colors = palette.variants?.[resolved] ?? palette.colors;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty('--t3-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value);
  }
  const aliases: Record<string, string> = {
    paper: 'canvas', surface: 'surface', ink: 'text', dim: 'textMuted', rule: 'border', green: 'accent',
    soft: 'secondary', focus: 'focus', warning: 'warningForeground', 'warning-bg': 'warningSurface',
    error: 'errorForeground', 'error-bg': 'errorSurface',
  };
  for (const [alias, role] of Object.entries(aliases)) {
    const value = colors[role];
    if (value !== undefined) root.style.setProperty('--' + alias, value);
  }
  root.dataset.theme = palette.id;
  root.dataset.appearance = resolved;
  root.style.colorScheme = resolved;
  document.body.dataset.theme = resolved;
}
