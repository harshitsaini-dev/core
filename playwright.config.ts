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
 *   WORKERS=1           run one at a time, and slow it down so it is followable
 *   SLOWMO=500          milliseconds of delay between actions
 *   DEVTOOLS=1          open Chrome DevTools alongside the run
 *
 * One caveat worth knowing: the specs under `e2e/api` drive HTTP directly, so a
 * headed run shows a browser window sitting on a blank page. There is nothing
 * to render until there is a UI. They also run on the desktop project only —
 * see the note on the mobile project below.
 */

const isCI = !!process.env.CI;

/**
 * Headless by default, headed on request.
 *
 * This used to be the other way round, on the grounds that a run you can watch
 * catches what a summary line never will — which is true, and is why
 * `pnpm e2e:headed` still exists.
 *
 * What made it the wrong default is that the suite runs for half an hour at
 * four workers, and four browser windows appearing and disappearing on top of
 * whatever else is on the screen is not a run being watched. It is an
 * interruption, repeated a few hundred times, on a machine somebody is trying
 * to work on.
 *
 *   pnpm e2e              headless, four workers, full speed
 *   pnpm e2e:headed       visible, and with WORKERS=1 paced to be followable
 */
const headed = !isCI && process.env.HEADED === '1';

/**
 * How many at once.
 *
 * Four locally, on a machine with cores to spare. The ceiling is not the CPU —
 * it is the single `next dev` process every worker shares, which compiles
 * routes on demand and serves them from one event loop. Past four, workers
 * spend their time queueing behind each other rather than doing anything.
 *
 * CI stays at two: those runners have far less to work with, and a suite that
 * thrashes is slower than one that queues.
 */
const workers = Number(process.env.WORKERS ?? (isCI ? 2 : 4));

/**
 * Pacing, and why it is not on by default any more.
 *
 * A headed run exists to be watched, and 300ms between actions is what makes
 * one followable. But it is also the single largest cost in the suite: several
 * hundred tests times dozens of actions each, and the delay dwarfs the work.
 *
 * With four browsers open at once there is nothing to follow anyway — they
 * overlap and none of them is legible. So the pacing now comes with the thing
 * that makes it useful: `WORKERS=1 pnpm e2e` runs one window, slowly, the way
 * it was before. Everything else runs at full speed, still headed, still
 * visible.
 */
const slowMo = Number(process.env.SLOWMO ?? (headed && workers === 1 ? 300 : 0));

export default defineConfig({
  testDir: './apps/web/e2e',
  globalSetup: './apps/web/e2e/global-setup.ts',
  outputDir: './test-results',

  // Parallel everywhere. Tests share one dev server and one local D1, so this
  // only works because each one creates its own account and touches nothing it
  // did not make — which is worth keeping true, and is the kind of thing that
  // breaks quietly the first time a test reaches for "the newest session".
  fullyParallel: true,
  workers,
  // Unretried locally, so a flake is seen rather than smoothed over.
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
    // `on-first-retry` captures nothing locally, because there are no retries
    // here — which is exactly when a failure that only appears under a full
    // parallel run has to be explicable from the artefacts alone. A trace has
    // the network, the console and the DOM at each step; a screenshot has the
    // end state and no idea how it got there.
    trace: isCI ? 'on-first-retry' : 'retain-on-failure',
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
      /*
       * Everything under `e2e/api` drives HTTP directly and never opens a page.
       * Running it a second time at a phone's viewport asserts nothing a
       * desktop run did not already assert — it is the same requests, the same
       * responses, and half the suite.
       *
       * The split is a directory rather than a per-file annotation so that a
       * new spec lands on the right side of it by where it is put, rather than
       * by somebody remembering to add a line.
       */
      testIgnore: '**/api/**',
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

  /*
   * The server under test.
   *
   * Normally `next dev`, because it is the only way to get the Cloudflare
   * bindings locally. When WORKERS_BUILD is set the workflow has already
   * started a real Workers preview, so Playwright attaches to it instead of
   * starting anything — that is the environment where the two assertions
   * `next dev` cannot settle finally mean something.
   */
  ...(process.env.WORKERS_BUILD === '1'
    ? {}
    : {
        webServer: {
          command: 'pnpm dev',
          url: 'http://localhost:3000',
          reuseExistingServer: !isCI,
          timeout: 120_000,
          stdout: 'ignore' as const,
          stderr: 'pipe' as const,
        },
      }),
});
