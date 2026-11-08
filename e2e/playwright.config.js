// ScanHub E2E: npm run e2e  (starts the app in Docker, runs every spec serially, writes e2e/results/index.html)
// E2E_BASE_URL=http://host:port  run against an instance that is already running
// E2E_DEV=1                      mount the working-copy server/ and public/ into the container
// E2E_KEEP=1                     keep the container after the run
import { defineConfig, devices } from '@playwright/test';
import { LOOK } from './lib/env.js';

const port = Number(process.env.E2E_PORT || 18080);

export default defineConfig({
  testDir: './specs',
  outputDir: './results/test-output',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  globalSetup: './global-setup.js',
  reporter: [
    ['list'],
    ['html', { outputFolder: './results/playwright', open: 'never' }],
    ['./reporter.js'],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL || `http://localhost:${port}`,
    viewport: { width: 1280, height: 800 },
    // dark by default (E2E_THEME=light for light), 2x pixels so GIF text stays sharp
    ...LOOK,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
