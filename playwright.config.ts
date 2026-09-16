import { defineConfig, devices } from '@playwright/test';

/**
 * The offline suite is the acceptance test for this package.
 *
 * It loads the playground, warms the cache, drops the network with
 * `context.setOffline(true)`, and then opens documents. Unit tests cannot
 * catch the failures that matter here — a missing worker chunk, an asset
 * fetched from a CDN, a cache generation deleted too eagerly — because all of
 * them only appear in a real browser with real service-worker interception.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3210',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build -w @lookglass/example-next && npm run start -w @lookglass/example-next',
    url: 'http://localhost:3210',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
