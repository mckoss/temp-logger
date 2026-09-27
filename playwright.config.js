import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  webServer: {
    command: 'node server.js --demo',
    port: 3101,
    env: { PORT: '3101' },
    reuseExistingServer: true,
    stdout: 'pipe',
  },
  use: {
    baseURL: 'http://localhost:3101',
  },
});
