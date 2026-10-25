import { defineConfig, devices } from '@playwright/test';

/**
 * Integration e2e: Angular dev server + the REAL Rust backend (../backend), no mocks.
 *   npm run e2e:integration
 *
 * - Starts `cargo run` with API_KEYS=kiosk-key-123 (the key the kiosk ships with) unless a backend is
 *   already answering on :3000, in which case that one is reused (handy while the backend is being developed).
 * - The first run compiles the backend, hence the generous timeout.
 * - Each test uses its own tenant, so tests are isolated and can run in parallel against one server.
 */
export default defineConfig({
  testDir: './e2e/integration',
  // The backend has only 2 resource workers shared by ALL tenants, so tests that occupy them must not
  // overlap. Tenants still isolate queue contents; they do not isolate worker capacity.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-integration' }]],
  use: {
    baseURL: 'http://localhost:4200',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'cargo run',
      cwd: '../backend',
      url: 'http://localhost:3000/health',
      env: { API_KEYS: 'kiosk-key-123', RUST_LOG: 'warn' },
      reuseExistingServer: true,
      timeout: 600_000,
      stdout: 'pipe',
    },
    {
      command: 'npx ng serve --port 4200',
      url: 'http://localhost:4200',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
