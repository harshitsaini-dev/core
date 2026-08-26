import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Runs headed by default. CI is always headless.
 *
 *   pnpm e2e            headed, slowed so it is followable
 *   pnpm e2e:ui         time-travel UI, watch mode, locator picker
 *   pnpm e2e:debug      step through with the Playwright Inspector
 *   pnpm e2e:headless   unattended run, what CI does
 *
 * Extra knobs:
 *   HEADED=0            force headless
 *   SLOWMO=500          milliseconds of delay between actions
 *   DEVTOOLS=1          open Chrome DevTools alongside the run
 *
 * One caveat worth knowing: the API specs (prelogin, signup, login) drive HTTP
 * directly, so a headed run shows a browser window sitting on a blank page.
 * There is nothing to render until there is a UI. The smoke spec is the one
 * that actually paints Core.
 */

const isCI = !!process.env.CI;

// Headed by default outside CI: a test run you can watch catches things a
// summary line never will. Opt out with HEADED=0 for a quick unattended run.
const headed = !isCI && process.env.HEADED !== '0';

// A run you cannot follow is not much use, so headed runs are slowed by default.
const slowMo = Number(process.env.SLOWMO ?? (headed ? 300 : 0));

export default defineConfig({
  testDir: './apps/web/e2e',
  globalSetup: './apps/web/e2e/global-setup.ts',
  outputDir: './test-results',

  // Serial and unretried locally: a flaky headed run is confusing to watch.
  fullyParallel: isCI,
  workers: isCI ? 2 : 1,
  retries: isCI ? 2 : 0,
  forbidOnly: isCI,

  timeout: headed ? 120_000 : 60_000,
  expect: { timeout: headed ? 15_000 : 10_000 },

  reporter: isCI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    headless: !headed,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
    // Generous even headless. The suite runs against `next dev` — production
    // `next start` gets no Cloudflare bindings, so there is no faster option —
    // and the first request to a cold route waits on compilation. Five seconds
    // was enough locally, where routes are already warm, and produced flakes in
    // CI that had nothing to do with the code under test.
    actionTimeout: headed ? 15_000 : 20_000,
    launchOptions: {
      slowMo,
      devtools: process.env.DEVTOOLS === '1',
    },
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // A window large enough to actually see what is happening.
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
    },
    /*
     * Firefox and WebKit are opt-in, via E2E_ALL_BROWSERS=1.
     *
     * They were briefly enabled for every CI run, which was wrong twice over:
     * the workflow installs only Chromium, so they failed on a missing browser
     * rather than on anything real, and running four projects would roughly
     * double an eight-minute suite on every push.
     *
     * They run on a schedule and on demand instead. WebKit genuinely matters
     * for a mobile-first PWA — every iOS browser is Safari underneath — so this
     * is a cadence decision, not a coverage one.
     */
    ...(process.env.E2E_ALL_BROWSERS === '1'
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],

  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
