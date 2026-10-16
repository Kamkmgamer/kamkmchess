import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Public configuration will be allowlisted when hosted accounts are implemented.
  envPrefix: [],
  build: {
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    modulePreload: { polyfill: false },
  },
});
