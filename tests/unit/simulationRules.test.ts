/**
 * Simulation rule tests: action table, decor, civics, growth invariants, save/load validation.
 * Uses a terrain with a river (tx 40..42) so bridges and water rules are exercised.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/simulation';
import { createGameBus } from '../../src/core/events';
import { rectTiles } from '../../src/core/coords';
import { hash2 } from '../../src/core/rng';
import { B } from '../../src/voxel/blocks';
import { MAP_TILES, TileKind, ZoneType, type CitySnapshot, type TerrainReader } from '../../src/types';
import { pendingReason } from '../support/pending';

const pending = pendingReason('simulation');

const river = (tx: number): boolean => tx >= 40 && tx <= 42;
const terrain: TerrainReader = {
  seed: 7,
  mapTiles: MAP_TILES,
  getTileHeight: (tx) => (river(tx) ? 6 : 12),
  getSurfaceHeight: (tx) => (river(tx) ? 10 : 12),
  isWater: (tx) => river(tx),
  hasNaturalDecor: (tx, tz) => !river(tx) && hash2(tx, tz, 3) % 7 === 0,
  getGroundBlock: () => B.GRASS,
};

function canonical(snap: CitySnapshot): string {
  return JSON.stringify(snap, (_k, v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as Uint8Array) : v));
}

function make() {
  const bus = createGameBus();
  const events: string[] = [];
  for (const t of ['tiles:changed', 'stats:changed', 'action:applied'] as const) bus.on(t, () => events.push(t));
  const sim = new Simulation({ bus, terrain });
  sim.newCity({ seed: 7, name: 'Rules' });
  events.length = 0;
  return { sim, bus, events };
}

function town(sim: Simulation): void {
  sim.applyAction({ type: 'zone', zone: ZoneType.Residential, tiles: rectTiles({ tx: 1, tz: 30 }, { tx: 15, tz: 31 }) });
  sim.applyAction({ type: 'zone', zone: ZoneType.Industrial, tiles: rectTiles({ tx: 18, tz: 33 }, { tx: 25, tz: 34 }) });
  sim.applyAction({ type: 'zone', zone: ZoneType.Commercial, tiles: rectTiles({ tx: 1, tz: 33 }, { tx: 10, tz: 33 }) });
}

describe.skipIf(!!pending)('simulation rules', () => {
  it('lays the free starter road and starts with positive R/I demand', () => {
    const { sim } = make();
    expect(sim.getTileKind(0, 32)).toBe(TileKind.Road);
    expect(sim.getTileKind(32, 32)).toBe(TileKind.Road);
    expect(sim.getTileKind(33, 32)).toBe(TileKind.Empty);
    const d = sim.getStats().demand;
    expect(d.r).toBeGreaterThan(0.2);
    expect(d.i).toBeGreaterThan(0.2);
    expect(Math.abs(d.c)).toBeLessThan(0.05);
  });

  it('charges roads, bridges and tree clearing; existing roads are free', () => {
    const { sim, events } = make();
    let tree = -1;
    let plain = -1;
    for (let x = 1; x < 39; x++) {
      if (sim.hasDecor(x, 20) && tree < 0) tree = x;
      if (!sim.hasDecor(x, 20) && plain < 0) plain = x;
    }
    const tiles = [{ tx: plain, tz: 20 }, { tx: tree, tz: 20 }, { tx: 41, tz: 20 }, { tx: plain, tz: 20 }, { tx: 5, tz: 32 }];
    const p = sim.previewAction({ type: 'road', tiles });
    expect(p.valid).toEqual([true, true, true, false, true]);
    expect(p.cost).toBe(10 + 13 + 60);
    const r = sim.applyAction({ type: 'road', tiles });
    expect([r.ok, r.cost, r.applied]).toEqual([true, 83, 3]);
    expect(events).toEqual(['tiles:changed', 'action:applied', 'stats:changed']);
    expect(sim.hasDecor(tree, 20)).toBe(false);
  });

  it('applies zone / park / bulldoze rules and rejects unaffordable actions entirely', () => {
    const { sim } = make();
    sim.applyAction({ type: 'zone', zone: ZoneType.Residential, tiles: [{ tx: 10, tz: 31 }] });
    expect(sim.previewAction({ type: 'zone', zone: ZoneType.Residential, tiles: [{ tx: 10, tz: 31 }] }).validCount).toBe(0);
    expect(sim.previewAction({ type: 'zone', zone: ZoneType.Commercial, tiles: [{ tx: 10, tz: 31 }] }).cost).toBe(5);
    expect(sim.previewAction({ type: 'zone', zone: ZoneType.Commercial, tiles: [{ tx: 41, tz: 31 }] }).reason).toBe('Cannot build on water');
    expect(sim.previewAction({ type: 'park', tiles: [{ tx: 10, tz: 32 }] }).validCount).toBe(0);
    expect(sim.applyAction({ type: 'road', tiles: [{ tx: 10, tz: 31 }] }).ok).toBe(true);
    expect(sim.getZone(10, 31)).toBe(ZoneType.None);
    expect(sim.applyAction({ type: 'bulldoze', tiles: [{ tx: 10, tz: 31 }] }).cost).toBe(2);
    const big = sim.previewAction({ type: 'zone', zone: ZoneType.Industrial, tiles: rectTiles({ tx: 0, tz: 0 }, { tx: 63, tz: 20 }) });
    expect(big.valid.slice(1024).some(Boolean)).toBe(false);
    sim.addMoney(20 - sim.getStats().money);
    const r = sim.applyAction({ type: 'park', tiles: [{ tx: 3, tz: 3 }] });
    expect([r.ok, r.reason, sim.getTileKind(3, 3)]).toEqual([false, 'Not enough money', TileKind.Empty]);
  });

  it('keeps growth invariants and reports every footprint tile that changes', () => {
    const { sim, bus } = make();
    town(sim);
    let changed = new Set<number>();
    bus.on('tiles:changed', (e) => e.tiles.forEach((t) => changed.add(t)));
    const look = () => {
      const m = new Map<number, string>();
      sim.forEachBuilding((b) => m.set(b.id, `${b.tx},${b.tz},${b.size},${b.level},${b.state},${b.stage},${b.facing},${b.variant}`));
      return m;
    };
    let prev = look();
    let missing = 0;
    for (let d = 0; d < 1200; d++) {
      changed = new Set();
      sim.tick(1);
      const cur = look();
      const need = (v: string) => {
        const [x, z, s] = v.split(',').map(Number);
        for (let a = 0; a < s; a++) for (let b = 0; b < s; b++) if (!changed.has((z + b) * MAP_TILES + x + a)) missing++;
      };
      for (const [id, v] of cur) if (prev.get(id) !== v) need(v);
      for (const [id, v] of prev) if (!cur.has(id)) need(v);
      prev = cur;
    }
    expect(missing).toBe(0);
    sim.forEachBuilding((b) => {
      if (b.size === 2) expect(b.level).toBe(3);
      for (let dz = 0; dz < b.size; dz++)
        for (let dx = 0; dx < b.size; dx++) {
          expect(sim.getZone(b.tx + dx, b.tz + dz)).toBe(b.zone);
          expect(sim.getBuildingIdAt(b.tx + dx, b.tz + dz)).toBe(b.id);
        }
      expect(b.occupants).toBeLessThanOrEqual(b.capacity);
    });
    expect(sim.getStats().population).toBeGreaterThan(300);
  });

  it('round-trips, continues deterministically and rejects corrupt saves without changing state', () => {
    const { sim } = make();
    town(sim);
    sim.applyAction({ type: 'civic', kind: 'school', origin: { tx: 12, tz: 33 } });
    sim.tick(900);
    const snap = sim.serialize();
    const other = new Simulation({ bus: createGameBus(), terrain });
    other.load(snap);
    expect(canonical(other.serialize())).toBe(canonical(snap));
    sim.tick(400);
    other.tick(400);
    expect(canonical(other.serialize())).toBe(canonical(sim.serialize()));

    const before = canonical(other.serialize());
    const dup = sim.serialize();
    dup.buildings.push({ ...dup.buildings[0] });
    expect(() => other.load(dup)).toThrow(/duplicate id/);
    const short = sim.serialize();
    short.tileKind = new Uint8Array(10);
    expect(() => other.load(short)).toThrow();
    const orphan = sim.serialize();
    orphan.tileKind[0] = TileKind.Civic;
    expect(() => other.load(orphan)).toThrow();
    expect(canonical(other.serialize())).toBe(before);
  });

  it('places civic buildings per CIVIC_SPECS and bulldozes them whole', () => {
    const { sim } = make();
    expect(sim.previewAction({ type: 'civic', kind: 'police', origin: { tx: 10, tz: 25 } }).reason).toBe('Must be next to a road');
    const p = sim.previewAction({ type: 'civic', kind: 'school', origin: { tx: 10, tz: 30 } });
    expect([p.validCount, p.valid.length]).toEqual([4, 4]);
    const th = sim.applyAction({ type: 'civic', kind: 'town_hall', origin: { tx: 4, tz: 30 } });
    expect(th.ok).toBe(true);
    expect(sim.getCivicAt(5, 31)?.facing).toBe(2);
    expect(sim.previewAction({ type: 'civic', kind: 'town_hall', origin: { tx: 4, tz: 33 } }).validCount).toBe(0);
    sim.applyAction({ type: 'civic', kind: 'school', origin: { tx: 10, tz: 30 } });
    expect(sim.getCoverage(11, 31).education).toBe(1);
    expect(sim.getCoverage(50, 31).education).toBe(0);
    expect(sim.getStats().civics.school).toBe(1);
    expect(sim.getStats().projected.serviceUpkeep).toBe(110);
    const r = sim.applyAction({ type: 'bulldoze', tiles: [{ tx: 11, tz: 31 }] });
    expect([r.ok, r.changedTiles.length, sim.getTileKind(10, 30)]).toEqual([true, 4, TileKind.Empty]);
    expect(sim.getCivicAt(10, 30)).toBeUndefined();
  });
});
