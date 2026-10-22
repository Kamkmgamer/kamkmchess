import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { readPublicConfig } from './src/public-config.js';
import { createProviderRelay } from './server/provider-relay.js';
import type { Connect } from 'vite';

function providerRelay() {
  const handler = createProviderRelay();
  const configure = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use('/api/provider-relay', handler);
  };
  return { name: 'provider-relay', configureServer: configure, configurePreviewServer: configure };
}

/**
 * The synthetic account session of a local fixture run.
 *
 * The seam hands a signed-in identity to the page so a browser can drive the
 * account surfaces of the local online fixture. It carries no credential: the
 * identity and its session token are read at run time from the page, where
 * the harness put them.
 *
 * The flag is refused unless the build says that it is a fixture build, so an
 * ordinary release build can never carry the bridge. The branch that loads
 * the bridge is removed from the bundle of every build that does not set the
 * flag.
 */
const testSessionRequested = process.env.KAMKM_PUBLIC_TEST_SESSION === 'true';
if (testSessionRequested && process.env.KAMKM_BUILD_FLAVOR !== 'fixture') {
  throw new Error('The synthetic account session needs KAMKM_BUILD_FLAVOR=fixture. It is never part of an ordinary build.');
}

const browserConfig = readPublicConfig({
  accountsEnabled: process.env.KAMKM_PUBLIC_ACCOUNTS_ENABLED === 'true',
  clerkPublishableKey: process.env.KAMKM_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
  apiBaseUrl: process.env.KAMKM_PUBLIC_API_BASE_URL ?? null,
  testSession: testSessionRequested,
});
if (process.env.KAMKM_PUBLIC_ACCOUNTS_ENABLED === 'true' && !browserConfig.accountsEnabled) {
  throw new Error('Account builds require a valid Clerk publishable key and an HTTPS API origin, or HTTP localhost for development.');
}

export default defineConfig({
  plugins: [react(), tailwindcss(), providerRelay()],
  // Public configuration will be allowlisted when hosted accounts are implemented.
  envPrefix: [],
  // Each setting below is public by design. No other environment value enters
  // the browser bundle, including database, Clerk secret or provider credentials.
  define: {
    __KAMKM_PUBLIC_CONFIG__: JSON.stringify(browserConfig),
    // The synthetic account session of a local fixture run. The constant is
    // false in every ordinary build, so the branch that loads the bridge is
    // removed from the bundle instead of only being switched off.
    __KAMKM_TEST_SESSION__: JSON.stringify(testSessionRequested),
  },
  build: {
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    modulePreload: { polyfill: false },
  },
});
