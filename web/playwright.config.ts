import { defineConfig } from '@playwright/test'

/**
 * E2E against the running dev server and the real project.
 *
 * Serial, and one worker. The suite creates comments and reads shared state, so parallel
 * workers interfere with each other's fixtures — and the failure surfaces in whichever
 * assertion loses the race, which reads as a product bug rather than a scheduling one.
 * That is the worst way for an isolation suite in particular to fail.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    viewport: { width: 1500, height: 940 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
