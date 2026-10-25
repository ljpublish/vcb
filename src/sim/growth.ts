/**
 * MODULE: simulation — building growth, upgrades, merges, abandonment (module-internal API).
 * Owner: simulation agent.
 *
 * Per-tick logic (see ARCHITECTURE.md §11.2):
 *  - advance construction (stage = min(2, floor(progress × 3))), completion → Active
 *  - occupancy drifts toward capacity × fill factor (R: demand + happiness; C/I: workforce)
 *  - upgrade L1→L2→L3 (occupancy / demand / age / land value gates), L2+ blocks may merge 2×2 L3
 *  - abandon (no access, negative demand, pollution for R), revive, decay (long abandoned → removed)
 *  - spawn L1 (Constructing, stage 0) on empty zoned tiles with CONNECTED access when demand > 0
 * Every visual change adds all footprint tile indices to `changed`.
 * All randomness comes from state.rng (persisted) → deterministic.
 */
import {
  BuildingState,
  MAP_TILES,
  ROAD_ACCESS_DISTANCE,
  TILE_COUNT,
  TileKind,
  ZoneType,
  type Building,
  type BuildingLevel,
  type Dir,
  type RCI,
  type RCIZone,
  type TerrainReader,
} from '../types';
import type { Rng } from '../core/rng';
import { addFootprint, type CityState } from './cityState';
import type { Aggregates } from './economy';

export interface GrowthContext {
  terrain: TerrainReader;
  /** Smoothed RCI demand −1..1. */
  demand: RCI;
  happiness: number;
  agg: Aggregates;
}

/** Construction duration in days per level. */
export const CONSTRUCTION_DAYS = [0, 6, 10, 16];
const CAPACITY: Record<number, readonly [number, number][]> = {
  [ZoneType.Residential]: [
    [0, 0],
    [8, 14],
    [40, 70],
    [150, 300],
  ],
  [ZoneType.Commercial]: [
    [0, 0],
    [6, 10],
    [30, 50],
    [120, 220],
  ],
  [ZoneType.Industrial]: [
    [0, 0],
    [10, 16],
    [40, 70],
    [120, 200],
  ],
};
const MERGE_FACTOR = 3.5;
const NO_ACCESS_DAYS = 30;
const BAD_DEMAND_DAYS = 60;
const POLLUTED_DAYS = 60;
const ABANDONED_REMOVE_DAYS = 120;
const BAD_DEMAND = -0.5;
const HEAVY_POLLUTION = Math.round(0.7 * 255);
const UPGRADE_AGE = [0, 90, 240];
const UPGRADE_LV = [0, 0.3 * 255, 0.45 * 255];
/** School coverage needed for residential level 3 (incl. merges). */
const SCHOOL_FOR_L3 = 0.5 * 255;
/** Hospital coverage needed for residential level >= 2 once the city is this big. */
const HOSPITAL_POP = 2000;
const HOSPITAL_FOR_L2 = 0.5 * 255;
/** Daily abandonment chance for buildings without fire (any zone) / police (C/I) coverage. */
const NO_FIRE_RISK = 0.00015;
const NO_POLICE_RISK = 0.0002;
/** Service risks only apply once the city is this big (no early-game punishment). */
const SERVICE_RISK_POP = 1000;

export function zoneDemand(d: RCI, zone: number): number {
  return zone === ZoneType.Residential ? d.r : zone === ZoneType.Commercial ? d.c : d.i;
}

export function rollCapacity(rng: Rng, zone: RCIZone, level: BuildingLevel, size: number): number {
  const [lo, hi] = CAPACITY[zone][level];
  const c = rng.int(lo, hi + 1);
  return size === 2 ? Math.round(c * MERGE_FACTOR) : c;
}

function minDist(field: Uint8Array, b: Readonly<Building>): number {
  let m = 255;
  for (let dz = 0; dz < b.size; dz++)
    for (let dx = 0; dx < b.size; dx++) {
      const v = field[(b.tz + dz) * MAP_TILES + b.tx + dx];
      if (v < m) m = v;
    }
  return m;
}

const facingScratch: Dir[] = [];

/** Direction of an adjacent road (random among several), else towards the nearest road. */
export function pickFacing(state: CityState, tx: number, tz: number, size: number, rng: Rng): Dir {
  facingScratch.length = 0;
  let best: Dir = 2;
  let bestDist = 256;
  for (let d = 0; d < 4; d++) {
    let road = false;
    for (let k = 0; k < size; k++) {
      // tile just outside edge d
      const x = d === 1 ? tx + size : d === 3 ? tx - 1 : tx + k;
      const z = d === 2 ? tz + size : d === 0 ? tz - 1 : tz + k;
      if (x < 0 || z < 0 || x >= MAP_TILES || z >= MAP_TILES) continue;
      const i = z * MAP_TILES + x;
      if (state.kind[i] === TileKind.Road) road = true;
      if (state.roadDist[i] < bestDist) {
        bestDist = state.roadDist[i];
        best = d as Dir;
      }
    }
    if (road) facingScratch.push(d as Dir);
  }
  if (facingScratch.length === 1) return facingScratch[0];
  if (facingScratch.length > 1) return facingScratch[rng.int(0, facingScratch.length)];
  return best;
}

function setChanged(b: Building, changed: Set<number>): void {
  addFootprint(b, changed);
}

function getCounters(state: CityState, id: number) {
  let c = state.counters.get(id);
  if (!c) {
    c = { noAccess: 0, badDemand: 0, polluted: 0 };
    state.counters.set(id, c);
  }
  return c;
}

export function removeBuilding(state: CityState, b: Readonly<Building>, changed: Set<number>): void {
  addFootprint(b, changed);
  for (let dz = 0; dz < b.size; dz++)
    for (let dx = 0; dx < b.size; dx++) state.buildingAt[(b.tz + dz) * MAP_TILES + b.tx + dx] = 0;
  state.buildings.delete(b.id);
  state.counters.delete(b.id);
}

function addBuilding(state: CityState, b: Building, changed: Set<number>): void {
  state.buildings.set(b.id, b);
  state.counters.set(b.id, { noAccess: 0, badDemand: 0, polluted: 0 });
  for (let dz = 0; dz < b.size; dz++)
    for (let dx = 0; dx < b.size; dx++) state.buildingAt[(b.tz + dz) * MAP_TILES + b.tx + dx] = b.id;
  addFootprint(b, changed);
}

const removals: Building[] = [];
const mergeCandidates: Building[] = [];

/** Can the 2×2 block with min corner (cx,cz) merge into one L3? Returns the 4 buildings or null. */
function mergeBlock(state: CityState, terrain: TerrainReader, cx: number, cz: number, zone: number, out: Building[]): boolean {
  if (cx < 0 || cz < 0 || cx + 1 >= MAP_TILES || cz + 1 >= MAP_TILES) return false;
  out.length = 0;
  const h = terrain.getTileHeight(cx, cz);
  for (let dz = 0; dz < 2; dz++)
    for (let dx = 0; dx < 2; dx++) {
      const x = cx + dx;
      const z = cz + dz;
      const id = state.buildingAt[z * MAP_TILES + x];
      if (id === 0) return false;
      const b = state.buildings.get(id);
      if (!b || b.size !== 1 || b.zone !== zone || b.level < 2 || b.state !== BuildingState.Active) return false;
      if (terrain.isWater(x, z) || terrain.getTileHeight(x, z) !== h) return false;
      out.push(b);
    }
  return true;
}

const block: Building[] = [];

/** Civic gates for residential density: L3 needs a school, L2+ needs a hospital in big cities. */
function residentialServicesOk(state: CityState, zone: number, level: BuildingLevel, ti: number, pop: number): boolean {
  if (zone !== ZoneType.Residential) return true;
  if (level >= 3 && state.covEducation[ti] < SCHOOL_FOR_L3) return false;
  if (level >= 2 && pop > HOSPITAL_POP && state.covHealth[ti] < HOSPITAL_FOR_L2) return false;
  return true;
}

export function growthTick(state: CityState, ctx: GrowthContext, changed: Set<number>): void {
  const { demand, agg, terrain } = ctx;
  const rng = state.rng;
  const h = ctx.happiness;
  const ciJobs = agg.jobsTotal;
  const workerRatio = ciJobs > 0 ? Math.min(1, agg.workforce / ciJobs) : 0;
  removals.length = 0;
  mergeCandidates.length = 0;

  for (const b of state.buildings.values()) {
    b.stateDays++;
    if (b.state === BuildingState.Constructing) {
      const dur = CONSTRUCTION_DAYS[b.level];
      if (b.stateDays >= dur) {
        b.state = BuildingState.Active;
        b.stateDays = 0;
        b.stage = 0;
        setChanged(b, changed);
      } else {
        const st = Math.min(2, Math.floor((b.stateDays / dur) * 3));
        if (st !== b.stage) {
          b.stage = st;
          setChanged(b, changed);
        }
      }
      continue;
    }

    const access = minDist(state.roadDist, b) <= ROAD_ACCESS_DISTANCE;
    const connected = minDist(state.connDist, b) <= ROAD_ACCESS_DISTANCE;
    const d = zoneDemand(demand, b.zone);
    const pol = state.pollution[b.tz * MAP_TILES + b.tx];
    const polluted = b.zone === ZoneType.Residential && pol > HEAVY_POLLUTION;

    if (b.state === BuildingState.Abandoned) {
      if (b.stateDays >= ABANDONED_REMOVE_DAYS) {
        removals.push(b);
      } else if (connected && d > 0 && !polluted && rng.chance(0.03)) {
        b.state = BuildingState.Active;
        b.stateDays = 0;
        const c = getCounters(state, b.id);
        c.noAccess = c.badDemand = c.polluted = 0;
        setChanged(b, changed);
      }
      continue;
    }

    // ---- Active ----
    const c = getCounters(state, b.id);
    c.noAccess = access ? 0 : c.noAccess + 1;
    c.badDemand = d < BAD_DEMAND ? c.badDemand + 1 : 0;
    c.polluted = polluted ? c.polluted + 1 : 0;
    const ti = b.tz * MAP_TILES + b.tx;
    let risk = 0;
    if (agg.population >= SERVICE_RISK_POP) {
      if (state.covFire[ti] < 64) risk += NO_FIRE_RISK;
      if (b.zone !== ZoneType.Residential && state.covPolice[ti] < 64) risk += NO_POLICE_RISK;
    }
    if (
      c.noAccess >= NO_ACCESS_DAYS ||
      c.badDemand >= BAD_DEMAND_DAYS ||
      c.polluted >= POLLUTED_DAYS ||
      (risk > 0 && rng.chance(risk))
    ) {
      b.state = BuildingState.Abandoned;
      b.occupants = 0;
      b.stateDays = 0;
      b.stage = 0;
      state.priv.abandonedThisMonth++;
      setChanged(b, changed);
      continue;
    }

    // occupancy drift
    let fill: number;
    if (b.zone === ZoneType.Residential) {
      fill = 0.8 + 0.4 * d + 0.4 * (h - 0.5);
      fill = fill < 0.3 ? 0.3 : fill > 1 ? 1 : fill;
    } else {
      fill = workerRatio * (0.95 + 0.05 * (d > 0 ? d : 0));
    }
    if (!connected) fill *= 0.5;
    const target = Math.round(b.capacity * fill);
    const diff = target - b.occupants;
    if (diff !== 0) {
      const step = Math.max(1, Math.round(Math.abs(diff) * 0.08));
      b.occupants += diff > 0 ? Math.min(step, diff) : -Math.min(step, -diff);
    }

    // upgrade
    if (
      b.level < 3 &&
      b.size === 1 &&
      connected &&
      d > 0.05 &&
      b.occupants >= b.capacity * 0.88 &&
      b.stateDays >= UPGRADE_AGE[b.level] &&
      (b.zone === ZoneType.Industrial || state.landValue[ti] >= UPGRADE_LV[b.level]) &&
      residentialServicesOk(state, b.zone, (b.level + 1) as BuildingLevel, ti, agg.population) &&
      rng.chance(b.level === 1 ? 0.012 : 0.006)
    ) {
      b.level = (b.level + 1) as BuildingLevel;
      b.state = BuildingState.Constructing;
      b.stage = 0;
      b.stateDays = 0;
      b.variant = rng.nextU32();
      b.capacity = rollCapacity(rng, b.zone, b.level, 1);
      if (b.occupants > b.capacity) b.occupants = b.capacity;
      setChanged(b, changed);
      continue;
    }

    // merge candidate
    if (
      b.level >= 2 &&
      b.size === 1 &&
      connected &&
      d > 0.1 &&
      b.stateDays >= 120 &&
      (b.zone === ZoneType.Industrial || state.landValue[ti] >= UPGRADE_LV[2]) &&
      residentialServicesOk(state, b.zone, 3, ti, agg.population) &&
      rng.chance(0.004)
    ) {
      mergeCandidates.push(b);
    }
  }

  for (const b of removals) removeBuilding(state, b, changed);

  // merges (at most one per tick)
  for (const b of mergeCandidates) {
    if (state.buildings.get(b.id) !== b || b.state !== BuildingState.Active) continue;
    let done = false;
    for (let o = 0; o < 4 && !done; o++) {
      const cx = b.tx - (o & 1);
      const cz = b.tz - (o >> 1);
      if (!mergeBlock(state, terrain, cx, cz, b.zone, block)) continue;
      let occ = 0;
      for (const m of block) {
        occ += m.occupants;
        removeBuilding(state, m, changed);
      }
      const cap = rollCapacity(rng, b.zone, 3, 2);
      const nb: Building = {
        id: state.nextBuildingId++,
        zone: b.zone,
        level: 3,
        tx: cx,
        tz: cz,
        size: 2,
        facing: pickFacing(state, cx, cz, 2, rng),
        variant: rng.nextU32(),
        state: BuildingState.Constructing,
        stage: 0,
        stateDays: 0,
        occupants: Math.min(cap, occ),
        capacity: cap,
        builtDay: state.day,
      };
      addBuilding(state, nb, changed);
      done = true;
    }
    if (done) break;
  }

  // spawning
  const dr = demand.r;
  const dc = demand.c;
  const di = demand.i;
  if (dr <= 0.02 && dc <= 0.02 && di <= 0.02) return;
  const maxSpawn = Math.min(8, 2 + Math.floor(agg.population / 1500));
  let spawned = 0;
  const start = rng.int(0, TILE_COUNT);
  const { kind, zone, buildingAt, connDist, landValue, pollution } = state;
  for (let n = 0; n < TILE_COUNT && spawned < maxSpawn; n++) {
    let i = start + n;
    if (i >= TILE_COUNT) i -= TILE_COUNT;
    if (kind[i] !== TileKind.Zoned || buildingAt[i] !== 0 || connDist[i] > ROAD_ACCESS_DISTANCE) continue;
    const z = zone[i] as RCIZone;
    const d = z === ZoneType.Residential ? dr : z === ZoneType.Commercial ? dc : di;
    if (d <= 0.02) continue;
    if (z === ZoneType.Residential && pollution[i] > HEAVY_POLLUTION) continue;
    const p = 0.025 * d * (0.5 + landValue[i] / 255);
    if (!rng.chance(p)) continue;
    const tx = i % MAP_TILES;
    const tz = (i - tx) / MAP_TILES;
    const cap = rollCapacity(rng, z, 1, 1);
    const nb: Building = {
      id: state.nextBuildingId++,
      zone: z,
      level: 1,
      tx,
      tz,
      size: 1,
      facing: pickFacing(state, tx, tz, 1, rng),
      variant: rng.nextU32(),
      state: BuildingState.Constructing,
      stage: 0,
      stateDays: 0,
      occupants: 0,
      capacity: cap,
      builtDay: state.day,
    };
    addBuilding(state, nb, changed);
    spawned++;
  }
}
