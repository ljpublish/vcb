/**
 * Shared Playwright fixtures for the browser play-tests.
 *
 * `game` opens a fresh seeded city, waits until it is fully booted (not busy, meshing idle), and
 * collects console errors / uncaught exceptions. Any error fails the test at teardown.
 */
import { mkdirSync } from 'node:fs';
import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

export const SEED = 12345;
const BOOT_TIMEOUT_MS = 90_000;

/** Console messages matching these are not treated as failures (keep this list short). */
const IGNORED_ERRORS: RegExp[] = [
  // SwiftShader / headless GPU noise, not game bugs.
  /GPU stall due to ReadPixels/,
  /WebGL: INVALID_OPERATION: .*performance warning/i,
];

export interface GameHandle {
  page: Page;
  /** Console errors + page errors seen so far. */
  errors: string[];
  /** Open `/?seed=<seed>` (implies fresh) and wait for the boot to finish. */
  boot(seed?: number, extraQuery?: string): Promise<void>;
  /** Wait until the game is idle again (not busy, meshes idle, structures flushed). */
  settle(timeoutMs?: number): Promise<void>;
  /** Full-page screenshot into test-results/screenshots/<name>.png, attached to the report. */
  shot(name: string): Promise<void>;
}

async function waitForIdle(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const g = window.__vcb;
      return !!g && !g.busy && g.meshes.idle && g.structures.pending === 0;
    },
    undefined,
    { timeout: timeoutMs, polling: 250 },
  );
}

async function screenshot(page: Page, info: TestInfo, name: string): Promise<void> {
  const dir = 'test-results/screenshots';
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${info.project.name}-${name}.png`;
  await page.screenshot({ path: file });
  await info.attach(name, { path: file, contentType: 'image/png' });
}

export const test = base.extend<{ game: GameHandle }>({
  game: async ({ page }, use, info) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (!IGNORED_ERRORS.some((re) => re.test(text))) errors.push(`[console.error] ${text}`);
    });
    page.on('pageerror', (err) => errors.push(`[pageerror] ${err.stack ?? err.message}`));

    const handle: GameHandle = {
      page,
      errors,
      async boot(seed = SEED, extraQuery = '') {
        await page.goto(`/?seed=${seed}${extraQuery ? `&${extraQuery}` : ''}`, { waitUntil: 'load' });
        await page.waitForFunction(() => !!window.__vcb, undefined, { timeout: 30_000 });
        await waitForIdle(page, BOOT_TIMEOUT_MS);
      },
      settle: (timeoutMs = 60_000) => waitForIdle(page, timeoutMs),
      shot: (name) => screenshot(page, info, name),
    };

    await use(handle);

    if (info.status !== info.expectedStatus) await screenshot(page, info, 'failure').catch(() => {});
    expect(errors, 'console errors / uncaught exceptions during the test').toEqual([]);
  },
});

export { expect };
