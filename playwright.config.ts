import { defineConfig, devices } from '@playwright/test';

/**
 * The port of the preview server of the rendered suite.
 *
 * A run that needs its own build (the signed-in account build of the online
 * fixture, for example) can move the preview server out of the way of another
 * run with `KAMKM_E2E_PORT`.
 */
const port = Number(process.env.KAMKM_E2E_PORT ?? '5175');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm preview --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
