import { defineConfig, devices } from '@playwright/test';

/**
 * Mocked e2e: the real Angular app in a real browser, with HTTP + WebSocket traffic served by an
 * in-test fake backend. Fast, deterministic, needs no Rust toolchain.
 *   npm run e2e
 * For tests against the real Rust server see playwright.integration.config.ts.
 */
export default defineConfig({
  testDir: './e2e/mocked',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4200',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx ng serve --port 4200',
    url: 'http://localhost:4200',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
