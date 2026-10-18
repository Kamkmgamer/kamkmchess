// Separate entry chunks keep Quartz's reset and landing styles out of gameplay.
void (window.location.pathname === '/'
  ? import('./landing-entry.js')
  : import('./game-entry.js'));
