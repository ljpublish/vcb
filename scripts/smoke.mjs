#!/usr/bin/env node
/**
 * INTEGRATOR-OWNED — headless browser smoke test (Playwright + headless Chromium, software WebGL).
 * Module agents may RUN it but must not edit it (copy it into your scratchpad if you need changes).
 *
 * Usage (start a dev server first on a free port in the background, and ALWAYS kill it afterwards).
 * Run vite through node directly, WITHOUT `cd … &&` in front (that would make $! a subshell PID;
 * npx also spawns a child), passing the project root as an argument, so $! is the server PID:
 *   VCB_VITE_CACHE=/path/to/scratchpad/vite-cache \
 *   node /home/claude/vcb/node_modules/vite/bin/vite.js /home/claude/vcb --port 5199 --strictPort \
 *        > /path/to/scratchpad/vite.log 2>&1 &
 *   echo $! > /path/to/scratchpad/vite.pid
 *   node scripts/smoke.mjs --url "http://127.0.0.1:5199/?fresh&seed=12345" \
 *        --wait 8000 --shot /path/to/scratchpad/shot.png \
 *        --eval "window.__vcb.sim.getStats().population"
 *   kill $(cat /path/to/scratchpad/vite.pid); pkill -f "vite.js .*--port 5199" || true
 * Then look at the PNG with your image-reading tool. Software WebGL (SwiftShader) is slow: expect
 * low FPS in headless runs — judge correctness/looks there, not performance.
 *
 * Options:
 *   --url <url>        page to open (default http://127.0.0.1:5173/?fresh&seed=1)
 *   --wait <ms>        wait after load before evaluating / screenshotting (default 6000)
 *   --shot <png>       write a screenshot
 *   --eval <js>        JS expression evaluated in the page after the wait (may return a Promise);
 *                      result printed as JSON. Repeatable; evaluated in order.
 *   --after <ms>       extra wait after the evals, before the screenshot (default 0)
 *   --width/--height   viewport size (default 1280×800)
 *   --timeout <ms>     overall timeout (default 120000)
 * Exit code 1 if the page logged uncaught errors (pageerror) or console.error messages, else 0.
 */
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const args = process.argv.slice(2);
const opts = { url: 'http://127.0.0.1:5173/?fresh&seed=1', wait: 6000, after: 0, shot: '', evals: [], width: 1280, height: 800, timeout: 120000 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  switch (a) {
    case '--url': opts.url = v; i++; break;
    case '--wait': opts.wait = Number(v); i++; break;
    case '--after': opts.after = Number(v); i++; break;
    case '--shot': opts.shot = v; i++; break;
    case '--eval': opts.evals.push(v); i++; break;
    case '--width': opts.width = Number(v); i++; break;
    case '--height': opts.height = Number(v); i++; break;
    case '--timeout': opts.timeout = Number(v); i++; break;
    default: console.error(`unknown arg ${a}`); process.exit(2);
  }
}

const killer = setTimeout(() => { console.error('[smoke] overall timeout'); process.exit(3); }, opts.timeout);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
let errors = 0;
try {
  const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error') errors++;
    if (t === 'error' || t === 'warning' || t === 'log' || t === 'info') console.log(`[page:${t}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => { errors++; console.log(`[pageerror] ${err.stack || err.message}`); });
  await page.goto(opts.url, { waitUntil: 'load' });
  await page.waitForTimeout(opts.wait);
  for (const expr of opts.evals) {
    try {
      const res = await page.evaluate(`(async () => (${expr}))()`);
      console.log(`[eval] ${expr}\n  => ${JSON.stringify(res)}`);
    } catch (err) {
      errors++;
      console.log(`[eval-error] ${expr}\n  => ${err.message}`);
    }
  }
  if (opts.after > 0) await page.waitForTimeout(opts.after);
  if (opts.shot) {
    await page.screenshot({ path: opts.shot });
    console.log(`[smoke] screenshot → ${opts.shot}`);
  }
} finally {
  await browser.close();
  clearTimeout(killer);
}
console.log(`[smoke] done, ${errors} error(s)`);
process.exit(errors > 0 ? 1 : 0);
