import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readPublicConfig } from './src/public-config.js';

const browserConfig = readPublicConfig({
  accountsEnabled: process.env.KAMKM_PUBLIC_ACCOUNTS_ENABLED === 'true',
  clerkPublishableKey: process.env.KAMKM_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
  apiBaseUrl: process.env.KAMKM_PUBLIC_API_BASE_URL ?? null,
});
if (process.env.KAMKM_PUBLIC_ACCOUNTS_ENABLED === 'true' && !browserConfig.accountsEnabled) {
  throw new Error('Account builds require a valid Clerk publishable key and an HTTPS API origin, or HTTP localhost for development.');
}

export default defineConfig({
  plugins: [react()],
  // Public configuration will be allowlisted when hosted accounts are implemented.
  envPrefix: [],
  // Each setting below is public by design. No other environment value enters
  // the browser bundle, including database, Clerk secret or provider credentials.
  define: {
    __KAMKM_PUBLIC_CONFIG__: JSON.stringify(browserConfig),
  },
  build: {
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    modulePreload: { polyfill: false },
  },
});
