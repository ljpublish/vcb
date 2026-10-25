/**
 * MODULE: simulation — raw city state container (module-internal API).
 * Owner: simulation agent.
 *
 * The single mutable state object behind Simulation, struct-of-arrays for tiles.
 * Persisted fields map 1:1 to CitySnapshot; `priv` is persisted through CitySnapshot.extra.
 * Derived fields are recomputed after load and whenever their inputs change; they are never saved,
 * except land value / pollution, which are only refreshed monthly and after actions and therefore
 * ARE part of the future-relevant state: they are kept quantised (Uint8, 0..255) and saved in extra
 * so that a loaded city continues bit-identically (determinism requirement).
 */
import { CIVIC_SPECS, MAP_TILES, TILE_COUNT, type Building, type BudgetReport, type CivicBuilding, type HistorySample, type RCI, type SimSpeed, type TaxRates } from '../types';
import { Rng } from '../core/rng';
import { emptyBudget } from './stats';

/** Per-building decline counters (days). */
export interface BuildingCounters {
  /** Consecutive days without road access (any network). */
  noAccess: number;
  /** Consecutive days with strongly negative demand for the zone. */
  badDemand: number;
  /** Consecutive days with heavy pollution (residential only). */
  polluted: number;
}

/** Simulation-private persisted data (stored in CitySnapshot.extra.sim). */
export interface SimPrivate {
  /** Smoothed RCI demand −1..1. */
  demand: RCI;
  /** Smoothed happiness 0..1. */
  happiness: number;
  /** Last completed month. */
  lastMonth: BudgetReport;
  /** Index of the next population milestone to announce. */
  milestone: number;
  /** Last day a notification of each kind was sent. */
  notifyDay: Record<string, number>;
  /** Buildings abandoned since the last month end (for "abandonment wave" notifications). */
  abandonedThisMonth: number;
}

export function defaultPrivate(): SimPrivate {
  return {
    demand: { r: 0, c: 0, i: 0 },
    happiness: 0.6,
    lastMonth: emptyBudget(),
    milestone: 0,
    notifyDay: {},
    abandonedThisMonth: 0,
  };
}

export class CityState {
  // ---- persisted ----
  name = 'New City';
  seed = 0;
  day = 0;
  money = 0;
  speed: SimSpeed = 1;
  taxRates: TaxRates = { r: 9, c: 9, i: 9 };
  rng = new Rng(1);
  nextBuildingId = 1;
  readonly kind = new Uint8Array(TILE_COUNT);
  readonly zone = new Uint8Array(TILE_COUNT);
  readonly flags = new Uint8Array(TILE_COUNT);
  /** Insertion order = deterministic iteration order (kept across save/load). */
  readonly buildings = new Map<number, Building>();
  readonly counters = new Map<number, BuildingCounters>();
  /** Civic buildings (ids share the Building id space). Insertion order = deterministic order. */
  readonly civics = new Map<number, CivicBuilding>();
  history: HistorySample[] = [];
  priv: SimPrivate = defaultPrivate();
  /** Unknown keys of snapshot.extra, round-tripped verbatim. */
  extraOther: Record<string, unknown> = {};

  // ---- quantised fields (persisted in extra, see header) ----
  /** Land value × 255. */
  readonly landValue = new Uint8Array(TILE_COUNT);
  /** Pollution × 255. */
  readonly pollution = new Uint8Array(TILE_COUNT);

  // ---- derived (never persisted) ----
  /** Building id per tile (0 = none), rebuilt from `buildings`. */
  readonly buildingAt = new Int32Array(TILE_COUNT);
  /** Civic id per tile (0 = none), rebuilt from `civics`. */
  readonly civicAt = new Int32Array(TILE_COUNT);
  /** Service coverage × 255 per tile (derived from civics). */
  readonly covPolice = new Uint8Array(TILE_COUNT);
  readonly covFire = new Uint8Array(TILE_COUNT);
  readonly covEducation = new Uint8Array(TILE_COUNT);
  readonly covHealth = new Uint8Array(TILE_COUNT);
  hasTownHall = false;
  /** DIR_BIT mask of road neighbours for road tiles. */
  readonly roadMask = new Uint8Array(TILE_COUNT);
  /** Manhattan distance to the nearest road tile (255 = far). */
  readonly roadDist = new Uint8Array(TILE_COUNT);
  /** Manhattan distance to the nearest road tile of an edge-connected network (255 = far). */
  readonly connDist = new Uint8Array(TILE_COUNT);
  /** Road network component id per road tile (-1 = not a road). */
  readonly roadComponent = new Int32Array(TILE_COUNT);
  /** Per component id: 1 if the component touches the map edge. */
  readonly componentEdge = new Uint8Array(TILE_COUNT);
  componentCount = 0;
  /** At least one road network touches the map edge (region connection). */
  regionConnected = false;
  landRoadTiles = 0;
  bridgeTiles = 0;
  parkTiles = 0;
  /** Static (terrain-only) land value component: base + water + hills. Rebuilt per city. */
  readonly staticLV = new Float32Array(TILE_COUNT);
  staticReady = false;

  // ---- scratch ----
  readonly queue = new Int32Array(TILE_COUNT);
  readonly fieldA = new Float32Array(TILE_COUNT);
  readonly fieldB = new Float32Array(TILE_COUNT);
  readonly seenStamp = new Uint32Array(TILE_COUNT);
  seenGen = 0;

  /** Rebuilds buildingAt from buildings. */
  rebuildBuildingAt(): void {
    this.buildingAt.fill(0);
    for (const b of this.buildings.values()) {
      for (let dz = 0; dz < b.size; dz++)
        for (let dx = 0; dx < b.size; dx++) this.buildingAt[(b.tz + dz) * MAP_TILES + b.tx + dx] = b.id;
    }
  }

  /** Rebuilds civicAt from civics. */
  rebuildCivicAt(): void {
    this.civicAt.fill(0);
    this.hasTownHall = false;
    for (const c of this.civics.values()) {
      const size = CIVIC_SPECS[c.kind].size;
      if (c.kind === 'town_hall') this.hasTownHall = true;
      for (let dz = 0; dz < size; dz++)
        for (let dx = 0; dx < size; dx++) this.civicAt[(c.tz + dz) * MAP_TILES + c.tx + dx] = c.id;
    }
  }

  /** New generation for seenStamp (dedup without clearing). */
  nextSeen(): number {
    this.seenGen = (this.seenGen + 1) >>> 0;
    if (this.seenGen === 0) {
      this.seenStamp.fill(0);
      this.seenGen = 1;
    }
    return this.seenGen;
  }
}

/** Adds all footprint tile indices of a building to `changed`. */
export function addFootprint(b: Readonly<Building>, changed: Set<number>): void {
  for (let dz = 0; dz < b.size; dz++) for (let dx = 0; dx < b.size; dx++) changed.add((b.tz + dz) * MAP_TILES + b.tx + dx);
}
