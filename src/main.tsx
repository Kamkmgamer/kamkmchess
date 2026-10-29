import { applyTheme, readThemePreferences } from './theme.js';

applyTheme(readThemePreferences(), window.matchMedia('(prefers-color-scheme: dark)').matches);

// Separate entry chunks keep Quartz's reset and landing styles out of gameplay.
void (window.location.pathname === '/play/agent'
  ? import('./agent-entry.js') : window.location.pathname === '/'
  ? import('./landing-entry.js')
  : import('./game-entry.js'));
