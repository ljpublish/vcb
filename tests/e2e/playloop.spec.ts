/**
 * Gameplay play-tests: road → zone → let the sim run → the city grows.
 *
 * Each test skips itself (shows as "skipped" with a `pending: …` reason) until the modules it needs
 * are merged into main; see tests/support/pending.ts. When a module lands, its tests switch on.
 */
import { test, expect, type GameHandle } from './fixtures';
import { pendingReason } from '../support/pending';

/**
 * Lays a town next to the free starter road (sim brief: along tz = MAP_TILES/2 from the west edge to
 * the centre): a parallel road two rows north, R between them, C and I on the outer sides.
 * Only tiles the sim's own previewAction calls valid are used, so it works on any seed.
 */
async function buildTown(game: GameHandle) {
  return game.page.evaluate(() => {
    const g = window.__vcb!;
    const sim = g.sim;
    const mid = sim.mapTiles >> 1;
    const row = (tz: number, x0: number, x1: number) => {
      const out: { tx: number; tz: number }[] = [];
      for (let tx = x0; tx <= x1; tx++) out.push({ tx, tz });
      return out;
    };
    const valid = (tiles: { tx: number; tz: number }[], zone: 1 | 2 | 3) => {
      const p = sim.previewAction({ type: 'zone', zone, tiles });
      return tiles.filter((_, i) => p.valid[i]);
    };
    sim.addMoney(50_000);
    const road = sim.applyAction({ type: 'road', tiles: row(mid - 3, 2, mid - 2) });
    // Connect the new road to the starter road at both ends of the R block.
    sim.applyAction({ type: 'road', tiles: [{ tx: 2, tz: mid - 2 }, { tx: 2, tz: mid - 1 }] });
    sim.applyAction({ type: 'road', tiles: [{ tx: mid - 2, tz: mid - 2 }, { tx: mid - 2, tz: mid - 1 }] });

    const res = [...valid(row(mid - 2, 3, mid - 3), 1), ...valid(row(mid - 1, 3, mid - 3), 1)];
    const com = valid(row(mid + 1, 2, mid - 2), 2);
    const ind = valid(row(mid - 4, 2, mid - 2), 3);
    const r = sim.applyAction({ type: 'zone', zone: 1, tiles: res });
    const c = sim.applyAction({ type: 'zone', zone: 2, tiles: com });
    const i = sim.applyAction({ type: 'zone', zone: 3, tiles: ind });
    // Look at the town.
    g.rig.setState({ x: (mid / 2) * 8, z: (mid - 2) * 8, yaw: 0.6, pitch: 0.75, distance: 150 }, true);
    return { road: road.applied, r: r.applied, c: c.applied, i: i.applied, stats: sim.getStats() };
  });
}

/** Runs `days` sim ticks in batches, yielding frames so structures and meshes keep up. */
async function runDays(game: GameHandle, days: number, batch = 30) {
  for (let done = 0; done < days; done += batch) {
    await game.page.evaluate((n) => window.__vcb!.sim.tick(n), Math.min(batch, days - done));
    await game.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  return game.page.evaluate(() => window.__vcb!.sim.getStats());
}

test.describe('play loop (scripted through the sim API)', () => {
  test.skip(!!pendingReason('simulation'), pendingReason('simulation'));

  test('road + zones grow population', async ({ game }) => {
    await game.boot();
    const town = await buildTown(game);
    expect(town.road, 'road tiles placed').toBeGreaterThan(0);
    expect(town.r, 'residential tiles zoned').toBeGreaterThan(10);
    expect(town.stats.population).toBe(0);
    await game.settle();
    await game.shot('town-zoned');

    const stats = await runDays(game, 720);
    expect(stats.day).toBeGreaterThanOrEqual(720);
    expect(stats.population, 'population after two years').toBeGreaterThan(0);
    expect(stats.buildings.r).toBeGreaterThan(0);
    await game.settle();
    await game.shot('town-grown');
    console.log(`[playloop] day=${stats.day} pop=${stats.population} jobs=${stats.jobsTotal} money=${stats.money}`);
  });

  test('real-time speed advances the calendar and pause stops it', async ({ game }) => {
    await game.boot();
    const page = game.page;
    await page.evaluate(() => window.__vcb!.sim.setSpeed(3));
    const d0 = await page.evaluate(() => window.__vcb!.sim.getStats().day);
    await page.waitForFunction((d) => window.__vcb!.sim.getStats().day > d + 5, d0, { timeout: 30_000 });
    await page.evaluate(() => window.__vcb!.sim.setSpeed(0));
    const paused = await page.evaluate(() => window.__vcb!.sim.getStats().day);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__vcb!.sim.getStats().day)).toBe(paused);
  });
});

test.describe('buildings appear in the voxel world', () => {
  const reason = pendingReason('simulation', 'buildings');
  test.skip(!!reason, reason);

  test('a grown building has voxels above its lot', async ({ game }) => {
    await game.boot();
    await buildTown(game);
    await runDays(game, 720);
    await game.settle();
    const tallest = await game.page.evaluate(() => {
      const g = window.__vcb!;
      let best = 0;
      g.sim.forEachBuilding((b) => {
        const x = b.tx * 8 + 4;
        const z = b.tz * 8 + 4;
        best = Math.max(best, g.world.getColumnTop(x, z) - g.terrain.getTileHeight(b.tx, b.tz));
      });
      return best;
    });
    expect(tallest, 'voxels above ground at a building').toBeGreaterThan(2);
    await game.shot('buildings');
  });
});

test.describe('play loop through the real UI (hotkeys + mouse)', () => {
  const reason = pendingReason('simulation', 'input', 'camera', 'ui');
  test.skip(!!reason, reason);

  test('hotkey selects the road tool and a drag lays road', async ({ game }) => {
    await game.boot();
    const page = game.page;
    await page.evaluate(() => {
      const g = window.__vcb!;
      const mid = g.sim.mapTiles >> 1;
      g.rig.setState({ x: mid * 8, z: (mid + 6) * 8, yaw: 0, pitch: 1.2, distance: 120 }, true);
    });
    await game.settle();

    await page.keyboard.press('Digit2');
    await expect.poll(() => page.evaluate(() => window.__vcb!.tools.tool)).toBe('road');

    const before = await page.evaluate(() => window.__vcb!.sim.getStats().roadTiles);
    const box = (await page.locator('#viewport canvas').boundingBox())!;
    const y = box.y + box.height * 0.55;
    await page.mouse.move(box.x + box.width * 0.35, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.65, y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__vcb!.sim.getStats().roadTiles)).toBeGreaterThan(before);

    await page.keyboard.press('Digit3');
    await expect.poll(() => page.evaluate(() => window.__vcb!.tools.tool)).toBe('zone_r');
    await game.settle();
    await game.shot('ui-road');
  });
});

test.describe('save and load', () => {
  const reason = pendingReason('simulation', 'persistence', 'codec');
  test.skip(!!reason, reason);

  test('a saved city loads back with the same stats', async ({ game }) => {
    await game.boot();
    await buildTown(game);
    const saved = await runDays(game, 240);
    await game.settle();
    const res = await game.page.evaluate(() => window.__vcb!.saveGame('e2e'));
    expect(res.ok).toBe(true);

    // A different city, then load the slot back (localStorage survives the navigation).
    await game.boot(999);
    expect(await game.page.evaluate(() => window.__vcb!.loadGame('e2e'))).toBe(true);
    await game.settle();
    const loaded = await game.page.evaluate(() => window.__vcb!.sim.getStats());
    expect({ day: loaded.day, population: loaded.population, money: loaded.money }).toEqual({
      day: saved.day,
      population: saved.population,
      money: saved.money,
    });
    await game.shot('loaded');
  });
});
