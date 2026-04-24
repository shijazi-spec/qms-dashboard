import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

// Pre-installed Chromium binary on Replit (managed by the platform). Falls
// back to whatever Playwright finds in its own browser cache otherwise.
const replitChromium = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;

// Firefox + WebKit projects are scoped to the streaming-download smoke test
// only — every other Playwright spec stays Chromium-only because the rest of
// the suite (CSP / a11y / i18n) doesn't need cross-browser coverage. The
// streaming-download path however depends on transferable `ReadableStream`
// over `postMessage`, which has a real history of breaking on Firefox/WebKit
// updates (the very regression class this smoke test exists to catch).
const STREAMING_SMOKE_TEST = '**/streamingDownload.spec.ts';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'a11y-playwright-report.json' }]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: process.env.TEST_ADMIN_KEY
      ? { 'X-Admin-Key': process.env.TEST_ADMIN_KEY }
      : undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(replitChromium ? { launchOptions: { executablePath: replitChromium } } : {}),
      },
    },
    {
      name: 'firefox-streaming',
      testMatch: STREAMING_SMOKE_TEST,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit-streaming',
      testMatch: STREAMING_SMOKE_TEST,
      use: { ...devices['Desktop Safari'] },
    },
  ],
  timeout: 60000,
});
