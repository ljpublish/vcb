import { defineConfig, devices } from '@playwright/test';

/**
 * Browser play-tests (tests/e2e). By default this builds the game and serves the production bundle
 * with `vite preview`, so the tests exercise what actually ships.
 *
 *   npm run test:e2e                         build + preview + run
 *   VCB_E2E_URL=http://127.0.0.1:5199 npm run test:e2e   run against an already running server
 *
 * WebGL runs on SwiftShader (software) in headless Chromium: slow, so timeouts are generous and
 * tests check correctness, never frame rate.
 */
const CI = !!process.env.CI;
const PORT = Number(process.env.VCB_E2E_PORT ?? 4179);
const external = process.env.VCB_E2E_URL;
const baseURL = external ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/artifacts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // One browser at a time: software WebGL is CPU-bound and the runners are small.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions: {
          args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
        },
      },
    },
  ],
  webServer: external
    ? undefined
    : {
        command: `npx vite build --outDir .e2e-dist --emptyOutDir && npx vite preview --outDir .e2e-dist --port ${PORT} --strictPort`,
        url: baseURL,
        reuseExistingServer: !CI,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
