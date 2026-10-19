export const SIDEBAR_STORAGE_KEY = 'kamkmchess.game-options.v1';
export const SIDEBAR_MIN_WIDTH = 320;
export const SIDEBAR_MAX_WIDTH = 720;
export const SIDEBAR_DEFAULT_WIDTH = 420;

export interface SidebarPreferences {
  readonly collapsed: boolean;
  readonly width: number;
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function readSidebarPreferences(): SidebarPreferences {
  const defaults = { collapsed: true, width: SIDEBAR_DEFAULT_WIDTH };
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) ?? 'null');
    if (typeof saved !== 'object' || saved === null) return defaults;
    const width: unknown = Reflect.get(saved, 'width');
    return {
      collapsed: Reflect.get(saved, 'collapsed') !== false,
      width: typeof width === 'number' && Number.isFinite(width) ? clampSidebarWidth(width) : defaults.width,
    };
  } catch { return defaults; }
}

export function saveSidebarPreferences(preferences: SidebarPreferences): void {
  try { window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(preferences)); }
  catch { /* The sidebar remains usable when storage is disabled. */ }
}
