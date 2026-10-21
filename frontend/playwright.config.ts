import { defineConfig, devices } from '@playwright/test'

/**
 * Smoke tests: does the dashboard actually work in a browser?
 *
 * These are deliberately few and deliberately broad. The unit tests cover
 * the logic; these cover the things only a browser can tell you - that the
 * application mounts, that every view renders, that the theme switch
 * repaints, and that nothing overflows sideways on a narrow screen.
 *
 * The app is served from the production build, so the smoke test exercises
 * the same bundle that is deployed.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // Two workers is enough to catch cross-test interference without starving
  // the renderer of CPU; chart libraries are large and the assertions time the
  // layout, not just the network.
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // A Chromium phone profile: the mobile viewport is what the test is
    // about, not the engine.
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
