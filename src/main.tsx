import { applyTheme, readThemePreferences } from './theme.js';

applyTheme(readThemePreferences(), window.matchMedia('(prefers-color-scheme: dark)').matches);

// Separate entry chunks keep Quartz's reset and landing styles out of gameplay.
// /play/agent is not a separate surface: the game entry boots the one play
// screen over the hosted MCP session.
void (window.location.pathname === '/'
  ? import('./landing-entry.js')
  : import('./game-entry.js'));
