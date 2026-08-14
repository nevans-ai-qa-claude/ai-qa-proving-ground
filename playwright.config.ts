import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3100);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  outputDir: './artifacts/test-output',

  /**
   * Retries must be at least 1.
   *
   * Playwright only reports a test as `flaky` when it fails and then passes within its
   * retry budget. With retries at 0 that status can never occur, every flake is recorded
   * as a plain failure, and the flake ground truth in defects.json becomes unmeasurable.
   * This is the most common way a team accidentally destroys its own flake data.
   */
  retries: Number(process.env.RETRIES ?? 1),

  /**
   * Single worker by default.
   *
   * The system under test has deliberate process-global state and a global reset hook.
   * Under parallel workers those contend, and every downstream failure becomes a cascade
   * artefact rather than an observation about the injected fault — which would quietly
   * corrupt the labelled corpus.
   *
   * `npm run test:parallel` raises the worker count on purpose, to surface the
   * order-dependence faults (F003, D052, D012) that only appear under contention. Two
   * different corpora, two different questions.
   */
  workers: Number(process.env.WORKERS ?? 1),
  fullyParallel: false,

  forbidOnly: !!process.env.CI,
  timeout: 20_000,
  expect: { timeout: 5_000 },

  reporter: [
    ['list'],
    // The contract producer. Everything downstream in the portfolio reads its output.
    ['./reporters/run-event-reporter.ts', { outputDir: './artifacts/runs' }],
  ],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 5_000,
  },

  projects: [
    {
      name: 'api',
      testDir: './tests/api',
      use: {},
    },
    {
      name: 'e2e',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run start',
    url: `${BASE_URL}/api/_meta/injection`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    // Explicit passthrough. The server is a separate process; if the fault variables did
    // not reach it, the suite would run against a pristine app while the reporter
    // cheerfully labelled the run as containing defects.
    env: {
      DEFECTS: process.env.DEFECTS ?? 'none',
      FLAKES: process.env.FLAKES ?? 'none',
      FLAKE_SEED: process.env.FLAKE_SEED ?? '1337',
      CATALOG_ORDER: process.env.CATALOG_ORDER ?? 'default',
      CATALOG_EXTRA: process.env.CATALOG_EXTRA ?? '0',
      LOCALE: process.env.LOCALE ?? 'en-US',
      PORT: String(PORT),
    },
  },
});
