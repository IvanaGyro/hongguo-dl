// SPDX-License-Identifier: GPL-3.0-only
// Browser behaviour specs. Every spec runs unchanged in Chromium, Firefox and
// WebKit; where a browser lacks a capability, the spec skips that step with
// the capability as the reason. Media and API responses are local fixtures.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '*.spec.mjs',
  globalSetup: './tests/browser/support/fixtures.mjs',
  outputDir: 'test-results/browser',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // Long playback runs only on request: `--grep @slow`.
  grepInvert: process.env.HONGGUO_SLOW ? undefined : /@slow/,
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/hongguo-dl/`,
    trace: 'retain-on-first-failure',
    acceptDownloads: true,
    actionTimeout: 15_000
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: { firefoxUserPrefs: { 'media.eme.enabled': true, 'media.autoplay.default': 0 } }
      }
    },
    // Playwright cannot route requests from a service-worker-controlled page
    // in WebKit, so the site's worker (registered at startup for COOP/COEP)
    // would bypass every mocked API/CDN response. WebKit has no COEP
    // `credentialless` (no isolation) and its ZIP step is skipped anyway.
    { name: 'webkit', use: { ...devices['Desktop Safari'], serviceWorkers: 'block' } }
  ],
  webServer: {
    command: `bun run build && bunx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    env: { VITE_BASE_PATH: '/hongguo-dl/' },
    url: `http://127.0.0.1:${PORT}/hongguo-dl/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000
  }
});
