import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './scripts',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'a11y-playwright-report.json' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5000',
    headless: true,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  timeout: 45000,
});
