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
/**
 * Tests run a production build on their own port, so they never attach to a
 * `next dev` server on the playground's usual 3210. A dev server has no
 * service worker, and the offline tests would fail against it for reasons
 * that have nothing to do with the code under test.
 */
const PORT = Number(process.env.LOOKGLASS_E2E_PORT ?? 3211);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Run from the app directory: its file API resolves `files/` against the
    // working directory, as a deployed Next.js app would.
    cwd: 'examples/next-app',
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
