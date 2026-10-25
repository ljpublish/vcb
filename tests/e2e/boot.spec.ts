/** Boot smoke test: must pass on main at all times (works with the skeleton stubs). */
import { test, expect, SEED } from './fixtures';

test('boots a seeded city without errors and renders chunks', async ({ game }) => {
  await game.boot();
  const { page } = game;

  await expect(page.locator('#viewport canvas')).toBeVisible();
  await expect(page.locator('.vcb-fatal')).toHaveCount(0);

  const info = await page.evaluate(() => {
    const g = window.__vcb!;
    return { seed: g.sim.seed, mesh: g.meshes.getStats(), day: g.sim.getStats().day };
  });
  expect(info.mesh.meshes, 'chunk meshes in the scene').toBeGreaterThan(0);
  expect(info.mesh.queued).toBe(0);

  await game.shot('boot');
  console.log(`[boot] seed=${SEED} meshes=${info.mesh.meshes} triangles=${info.mesh.triangles}`);
});

test('the same seed gives the same terrain', async ({ game }) => {
  const probe = () =>
    game.page.evaluate(() => {
      const t = window.__vcb!.terrain;
      const out: number[] = [];
      for (let tz = 0; tz < t.mapTiles; tz += 7) for (let tx = 0; tx < t.mapTiles; tx += 7) out.push(t.getTileHeight(tx, tz), t.isWater(tx, tz) ? 1 : 0);
      return out;
    });
  await game.boot(SEED);
  const first = await probe();
  await game.boot(SEED);
  expect(await probe()).toEqual(first);
});
