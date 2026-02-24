import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/unit/dashboard',
  testMatch: ['dashboard-browser.test.ts', 'dashboard-synthetic.test.ts'],
  timeout: 30_000,
  retries: 0,
  workers: 1, // Run test files sequentially to avoid port conflicts between server instances
  use: {
    baseURL: 'http://localhost:7071',
  },
  webServer: undefined, // Tests manage their own server lifecycle
});
