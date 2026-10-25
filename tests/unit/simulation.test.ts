/**
 * Simulation contract tests (ISimulation in src/types.ts, rules in ARCHITECTURE.md §11).
 * Skipped while src/sim/simulation.ts is still the skeleton stub.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/simulation';
import { createGameBus, type GameBus } from '../../src/core/events';
import { rectTiles, lPathTiles } from '../../src/core/coords';
import { START_MONEY, TileKind, ZoneType, type CitySnapshot, type TileCoord } from '../../src/types';
import { flatTerrain } from '../support/fakeTerrain';
import { pendingReason } from '../support/pending';

const pending = pendingReason('simulation');

/** JSON with typed arrays as plain arrays, so snapshots compare structurally. */
function canonical(snap: CitySnapshot): string {
  return JSON.stringify(snap, (_k, v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as Uint8Array) : v));
}

// A small edge-connected town: an east-west road from the west map edge, R/C/I lots on both sides.
const ROAD: TileCoord[] = lPathTiles({ tx: 0, tz: 20 }, { tx: 24, tz: 20 });
const RES = [...rectTiles({ tx: 2, tz: 19 }, { tx: 12, tz: 19 }), ...rectTiles({ tx: 2, tz: 21 }, { tx: 12, tz: 21 })];
const COM = [...rectTiles({ tx: 13, tz: 19 }, { tx: 18, tz: 19 }), ...rectTiles({ tx: 13, tz: 21 }, { tx: 18, tz: 21 })];
const IND = [...rectTiles({ tx: 19, tz: 19 }, { tx: 24, tz: 19 }), ...rectTiles({ tx: 19, tz: 21 }, { tx: 24, tz: 21 })];
// Zoned far from any road: must never grow.
const ISOLATED = rectTiles({ tx: 50, tz: 50 }, { tx: 53, tz: 53 });

describe.skipIf(!!pending)(`simulation${pending ? ` (${pending})` : ''}`, () => {
  let bus: GameBus;
  let sim: Simulation;

  function buildTown(): void {
    expect(sim.applyAction({ type: 'road', tiles: ROAD }).ok).toBe(true);
    expect(sim.applyAction({ type: 'zone', zone: ZoneType.Residential, tiles: RES }).ok).toBe(true);
    expect(sim.applyAction({ type: 'zone', zone: ZoneType.Commercial, tiles: COM }).ok).toBe(true);
    expect(sim.applyAction({ type: 'zone', zone: ZoneType.Industrial, tiles: IND }).ok).toBe(true);
    expect(sim.applyAction({ type: 'zone', zone: ZoneType.Residential, tiles: ISOLATED }).ok).toBe(true);
  }

  beforeEach(() => {
    bus = createGameBus();
    sim = new Simulation({ bus, terrain: flatTerrain(7) });
    sim.newCity({ seed: 7, name: 'Testville' });
  });

  it('starts a new city with the contract defaults', () => {
    const s = sim.getStats();
    expect(s.day).toBe(0);
    expect(s.money).toBe(START_MONEY);
    expect(s.population).toBe(0);
    expect(sim.name).toBe('Testville');
  });

  it('previewAction is pure and agrees with applyAction', () => {
    const before = canonical(sim.serialize());
    const preview = sim.previewAction({ type: 'road', tiles: ROAD });
    expect(canonical(sim.serialize())).toBe(before);
    expect(preview.valid).toHaveLength(ROAD.length);
    expect(preview.validCount).toBeGreaterThan(0);
    expect(preview.affordable).toBe(true);

    const res = sim.applyAction({ type: 'road', tiles: ROAD });
    expect(res.ok).toBe(true);
    expect(res.cost).toBe(preview.cost);
    expect(res.applied).toBe(preview.validCount);
    expect(sim.getStats().money).toBe(START_MONEY - res.cost);
  });

  it('applies roads and zones and emits tiles:changed', () => {
    const changed: number[] = [];
    bus.on('tiles:changed', (e) => changed.push(...e.tiles));
    buildTown();
    expect(changed.length).toBeGreaterThan(0);
    for (const t of ROAD) expect(sim.getTileKind(t.tx, t.tz)).toBe(TileKind.Road);
    for (const t of RES) expect(sim.getZone(t.tx, t.tz)).toBe(ZoneType.Residential);
    expect(sim.getStats().zonedTiles).toMatchObject({ c: COM.length, i: IND.length });
    expect(sim.hasRoadAccess(5, 19)).toBe(true);
    expect(sim.hasRoadAccess(51, 51)).toBe(false);
  });

  it('rejects zoning on top of a road', () => {
    sim.applyAction({ type: 'road', tiles: ROAD });
    const p = sim.previewAction({ type: 'zone', zone: ZoneType.Residential, tiles: [ROAD[3]] });
    expect(p.valid).toEqual([false]);
    expect(p.validCount).toBe(0);
  });

  it('grows population with road access, and nothing without it', () => {
    buildTown();
    sim.tick(365);
    const s = sim.getStats();
    expect(s.day).toBe(365);
    expect(s.population).toBeGreaterThan(0);
    expect(s.buildings.r).toBeGreaterThan(0);
    for (const t of ISOLATED) expect(sim.getBuildingIdAt(t.tx, t.tz)).toBe(0);
    expect(sim.getHistory().length).toBeGreaterThan(0);
  });

  it('serialize → load → tick is deterministic (ARCHITECTURE §11)', () => {
    buildTown();
    sim.tick(120);
    const snap = sim.serialize();
    sim.tick(150);

    const other = new Simulation({ bus: createGameBus(), terrain: flatTerrain(7) });
    other.load(snap);
    other.tick(150);
    expect(canonical(other.serialize())).toBe(canonical(sim.serialize()));
  });

  it('pausing stops update() but not tick()', () => {
    sim.setSpeed(0);
    sim.update(5);
    expect(sim.getStats().day).toBe(0);
    sim.tick(3);
    expect(sim.getStats().day).toBe(3);
  });
});
