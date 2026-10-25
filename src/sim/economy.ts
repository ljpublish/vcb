/**
 * MODULE: simulation — aggregates, demand, land value, pollution, budget, happiness, stats
 * (module-internal API).
 * Owner: simulation agent.
 *
 *  - computeAggregates: population / workforce / jobs / employment from the building list.
 *  - computeDemand: RCI targets in −1..1 (unsmoothed; Simulation smooths with an EMA).
 *  - recomputeStaticLandValue: terrain-only part of land value (base, water, hills), once per city.
 *  - recomputePollution / recomputeLandValue: quantised tile fields (radius-limited loops).
 *  - monthlyBudget: taxes per zone, region trade, road/bridge/park upkeep (UPKEEP).
 *  - computeStats: fills CityStats in place.
 */
import {
  BASE_GROUND_HEIGHT,
  BuildingState,
  MAP_TILES,
  TILE_COUNT,
  TileKind,
  UPKEEP,
  ZoneType,
  type BudgetReport,
  type CityStats,
  type RCI,
  type TerrainReader,
} from '../types';
import type { CityState } from './cityState';
import { civicUpkeep } from './civics';

/** Per-tick aggregates of the building list. */
export interface Aggregates {
  population: number;
  workforce: number;
  jobsC: number;
  jobsI: number;
  jobsTotal: number;
  employed: number;
  employeesC: number;
  employeesI: number;
  unemployment: number;
  /** Capacity of buildings under construction, per zone. */
  pendingR: number;
  pendingC: number;
  pendingI: number;
  /** Constructing + active buildings per zone. */
  countR: number;
  countC: number;
  countI: number;
  abandoned: number;
}

export function emptyAggregates(): Aggregates {
  return {
    population: 0,
    workforce: 0,
    jobsC: 0,
    jobsI: 0,
    jobsTotal: 0,
    employed: 0,
    employeesC: 0,
    employeesI: 0,
    unemployment: 0,
    pendingR: 0,
    pendingC: 0,
    pendingI: 0,
    countR: 0,
    countC: 0,
    countI: 0,
    abandoned: 0,
  };
}

export const WORKFORCE_RATIO = 0.55;

export function computeAggregates(state: CityState, a: Aggregates): Aggregates {
  let pop = 0;
  let jobsC = 0;
  let jobsI = 0;
  let occC = 0;
  let occI = 0;
  let pendR = 0;
  let pendC = 0;
  let pendI = 0;
  let cR = 0;
  let cC = 0;
  let cI = 0;
  let ab = 0;
  for (const b of state.buildings.values()) {
    if (b.state === BuildingState.Abandoned) {
      ab++;
      continue;
    }
    const active = b.state === BuildingState.Active;
    if (b.zone === ZoneType.Residential) {
      cR++;
      pop += b.occupants;
      if (!active) pendR += Math.max(0, b.capacity - b.occupants);
    } else if (b.zone === ZoneType.Commercial) {
      cC++;
      occC += b.occupants;
      if (active) jobsC += b.capacity;
      else pendC += b.capacity;
    } else {
      cI++;
      occI += b.occupants;
      if (active) jobsI += b.capacity;
      else pendI += b.capacity;
    }
  }
  const w = Math.floor(pop * WORKFORCE_RATIO);
  const occ = occC + occI;
  const employed = Math.min(w, occ);
  const f = occ > 0 ? employed / occ : 0;
  a.population = pop;
  a.workforce = w;
  a.jobsC = jobsC;
  a.jobsI = jobsI;
  a.jobsTotal = jobsC + jobsI;
  a.employed = employed;
  a.employeesC = occC * f;
  a.employeesI = occI * f;
  a.unemployment = w > 0 ? 1 - employed / w : 0;
  a.pendingR = pendR;
  a.pendingC = pendC;
  a.pendingI = pendI;
  a.countR = cR;
  a.countC = cC;
  a.countI = cI;
  a.abandoned = ab;
  return a;
}

const clampD = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Unsmoothed demand targets. Capacity under construction counts as already built (no overshoot). */
export function computeDemand(state: CityState, a: Aggregates, happiness: number, out: RCI): RCI {
  const t = state.taxRates;
  const P = a.population + a.pendingR;
  const W = P * WORKFORCE_RATIO;
  const jobs = a.jobsTotal + a.pendingC + a.pendingI;
  const jobsC = a.jobsC + a.pendingC;
  const jobsI = a.jobsI + a.pendingI;
  out.r = clampD(0.4 + (0.9 * (jobs - W)) / Math.max(40, W + 40) + 0.3 * (happiness - 0.5) - 0.04 * (t.r - 9));
  out.c = clampD((1.5 * (0.2 * P - jobsC)) / Math.max(30, 0.2 * P + 30) - 0.04 * (t.c - 9));
  out.i = clampD(
    (state.regionConnected ? 0.35 : 0) + (1.2 * (0.62 * W - jobsI)) / Math.max(40, 0.62 * W + 40) - 0.04 * (t.i - 9),
  );
  return out;
}

/** Target happiness 0..1 from employment, land value, pollution, taxes and parks. */
export function targetHappiness(
  state: CityState,
  a: Aggregates,
  lvAvg: number,
  polAvg: number,
  zonedR: number,
  healthAvg: number,
): number {
  const t = state.taxRates;
  const avgTax = (t.r + t.c + t.i) / 3;
  const parks = Math.min(0.1, (state.parkTiles / Math.max(1, zonedR)) * 0.5);
  // civics: town hall +0.05 citywide; hospitals +0.1 × average health coverage of residents
  const civic = (state.hasTownHall ? 0.05 : 0) + 0.1 * healthAvg;
  return clamp01(0.35 + 0.3 * (1 - a.unemployment) + 0.3 * lvAvg - 0.4 * polAvg - 0.02 * (avgTax - 9) + parks + civic);
}

// ------------------------------------------------------------------ land value & pollution

/** Terrain-only land value: base 0.3 + water proximity (+0.15 within 2) + slight hill bonus. */
export function recomputeStaticLandValue(state: CityState, terrain: TerrainReader): void {
  const out = state.staticLV;
  for (let tz = 0; tz < MAP_TILES; tz++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      const i = tz * MAP_TILES + tx;
      let v = 0.3;
      if (!terrain.isWater(tx, tz)) {
        let near = 3;
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const d = Math.abs(dx) + Math.abs(dz);
            if (d === 0 || d > 2 || d >= near) continue;
            const x = tx + dx;
            const z = tz + dz;
            if (x < 0 || z < 0 || x >= MAP_TILES || z >= MAP_TILES) continue;
            if (terrain.isWater(x, z)) near = d;
          }
        }
        if (near <= 2) v += near === 1 ? 0.15 : 0.1;
        const h = terrain.getTileHeight(tx, tz) - BASE_GROUND_HEIGHT;
        if (h > 0) v += Math.min(0.08, h * 0.006);
      }
      out[i] = v;
    }
  }
}

/** Adds `amount × (1 − d/(r+1))` to `field` over the Manhattan diamond of radius r around (tx,tz). */
function splat(field: Float32Array, tx: number, tz: number, r: number, amount: number, mode: 0 | 1 | 2): void {
  const inv = 1 / (r + 1);
  const z0 = Math.max(0, tz - r);
  const z1 = Math.min(MAP_TILES - 1, tz + r);
  for (let z = z0; z <= z1; z++) {
    const rz = r - Math.abs(z - tz);
    const x0 = Math.max(0, tx - rz);
    const x1 = Math.min(MAP_TILES - 1, tx + rz);
    const row = z * MAP_TILES;
    for (let x = x0; x <= x1; x++) {
      const f = 1 - (Math.abs(x - tx) + Math.abs(z - tz)) * inv;
      const v = amount * (mode === 2 ? f * f : f);
      const i = row + x;
      if (mode !== 1) field[i] += v;
      else if (v > field[i]) field[i] = v;
    }
  }
}

const POLLUTION_BY_LEVEL = [0, 0.12, 0.2, 0.3];

export function recomputePollution(state: CityState): void {
  const src = state.fieldA;
  const parks = state.fieldB;
  src.fill(0);
  parks.fill(0);
  for (const b of state.buildings.values()) {
    if (b.zone !== ZoneType.Industrial || b.state === BuildingState.Abandoned) continue;
    const s = POLLUTION_BY_LEVEL[b.level] * (b.state === BuildingState.Constructing ? 0.5 : 1);
    for (let dz = 0; dz < b.size; dz++) for (let dx = 0; dx < b.size; dx++) splat(src, b.tx + dx, b.tz + dz, 6, s, 2);
  }
  const kind = state.kind;
  for (let i = 0; i < TILE_COUNT; i++) {
    const k = kind[i];
    if (k === TileKind.Road) {
      const tx = i % MAP_TILES;
      splat(src, tx, (i - tx) / MAP_TILES, 1, 0.03, 0);
    } else if (k === TileKind.Park) {
      const tx = i % MAP_TILES;
      splat(parks, tx, (i - tx) / MAP_TILES, 2, 0.12, 0);
    }
  }
  const out = state.pollution;
  for (let i = 0; i < TILE_COUNT; i++) out[i] = Math.round(clamp01(src[i] - parks[i]) * 255);
}

/** Needs current pollution. */
export function recomputeLandValue(state: CityState): void {
  const dev = state.fieldA;
  const park = state.fieldB;
  dev.fill(0);
  park.fill(0);
  const kind = state.kind;
  for (let i = 0; i < TILE_COUNT; i++) {
    if (kind[i] !== TileKind.Park) continue;
    const tx = i % MAP_TILES;
    splat(park, tx, (i - tx) / MAP_TILES, 3, 0.25, 1);
  }
  for (const b of state.buildings.values()) {
    if (b.state !== BuildingState.Active) continue;
    const amt = b.zone === ZoneType.Commercial ? 0.02 + 0.015 * b.level : b.zone === ZoneType.Residential ? 0.012 : 0;
    if (amt === 0) continue;
    for (let dz = 0; dz < b.size; dz++) for (let dx = 0; dx < b.size; dx++) splat(dev, b.tx + dx, b.tz + dz, 3, amt, 0);
  }
  const out = state.landValue;
  const pol = state.pollution;
  for (let i = 0; i < TILE_COUNT; i++) {
    // services: police +0.06, fire +0.04, school +0.06 (residential only), each × coverage
    let svc = (0.06 * state.covPolice[i] + 0.04 * state.covFire[i]) / 255;
    if (state.zone[i] === ZoneType.Residential) svc += (0.06 * state.covEducation[i]) / 255;
    const v = state.staticLV[i] + park[i] + Math.min(0.2, dev[i]) + svc - (0.6 * pol[i]) / 255;
    out[i] = Math.round(clamp01(v) * 255);
  }
}

export function recomputeFields(state: CityState): void {
  recomputePollution(state);
  recomputeLandValue(state);
}

// ------------------------------------------------------------------ budget

/** Town hall: +10% tax income. */
export const TOWN_HALL_TAX_BONUS = 1.1;

export function monthlyBudget(state: CityState, a: Aggregates, out: BudgetReport): BudgetReport {
  const t = state.taxRates;
  const th = state.hasTownHall ? TOWN_HALL_TAX_BONUS : 1;
  out.taxes.r = Math.round(a.population * (t.r / 100) * 0.8 * th);
  out.taxes.c = Math.round(a.employeesC * (t.c / 100) * 1.0 * th);
  out.taxes.i = Math.round(a.employeesI * (t.i / 100) * 1.0 * th);
  out.other = state.regionConnected ? Math.round(a.employeesI * 0.08 + a.employeesC * 0.03) : 0;
  out.roadUpkeep = state.landRoadTiles * UPKEEP.roadPerTile + state.bridgeTiles * UPKEEP.bridgePerTile;
  out.parkUpkeep = state.parkTiles * UPKEEP.parkPerTile;
  out.serviceUpkeep = civicUpkeep(state);
  out.income = out.taxes.r + out.taxes.c + out.taxes.i + out.other;
  out.expenses = out.roadUpkeep + out.parkUpkeep + out.serviceUpkeep;
  out.net = out.income - out.expenses;
  return out;
}

export function copyBudget(src: Readonly<BudgetReport>, out: BudgetReport): BudgetReport {
  out.taxes.r = src.taxes.r;
  out.taxes.c = src.taxes.c;
  out.taxes.i = src.taxes.i;
  out.other = src.other;
  out.roadUpkeep = src.roadUpkeep;
  out.parkUpkeep = src.parkUpkeep;
  out.serviceUpkeep = src.serviceUpkeep;
  out.income = src.income;
  out.expenses = src.expenses;
  out.net = src.net;
  return out;
}

// ------------------------------------------------------------------ stats

/** Tile-derived numbers (zoned counts, averages over zoned tiles). */
export interface TileTotals {
  zonedR: number;
  zonedC: number;
  zonedI: number;
  lvAvg: number;
  polAvg: number;
  /** Average coverage over residential tiles, 0..1. */
  covPolice: number;
  covFire: number;
  covEducation: number;
  covHealth: number;
}

export function emptyTileTotals(): TileTotals {
  return { zonedR: 0, zonedC: 0, zonedI: 0, lvAvg: 0, polAvg: 0, covPolice: 0, covFire: 0, covEducation: 0, covHealth: 0 };
}

export function computeTileTotals(state: CityState, out: TileTotals): TileTotals {
  let r = 0;
  let c = 0;
  let ind = 0;
  let lv = 0;
  let pol = 0;
  let cp = 0;
  let cf = 0;
  let ce = 0;
  let ch = 0;
  const { kind, zone, landValue, pollution } = state;
  for (let i = 0; i < TILE_COUNT; i++) {
    if (kind[i] !== TileKind.Zoned) continue;
    const z = zone[i];
    if (z === ZoneType.Residential) {
      r++;
      cp += state.covPolice[i];
      cf += state.covFire[i];
      ce += state.covEducation[i];
      ch += state.covHealth[i];
    }
    else if (z === ZoneType.Commercial) c++;
    else ind++;
    lv += landValue[i];
    pol += pollution[i];
  }
  const n = r + c + ind;
  out.zonedR = r;
  out.zonedC = c;
  out.zonedI = ind;
  out.lvAvg = n > 0 ? lv / n / 255 : 0;
  out.polAvg = n > 0 ? pol / n / 255 : 0;
  const rr = r > 0 ? 1 / (r * 255) : 0;
  out.covPolice = cp * rr;
  out.covFire = cf * rr;
  out.covEducation = ce * rr;
  out.covHealth = ch * rr;
  return out;
}

/** Fills `s` in place (stable object). */
export function computeStats(
  state: CityState,
  a: Aggregates,
  tt: TileTotals,
  projected: BudgetReport,
  s: CityStats,
): CityStats {
  s.day = state.day;
  s.money = state.money;
  s.population = a.population;
  s.workforce = a.workforce;
  s.jobsCommercial = a.jobsC;
  s.jobsIndustrial = a.jobsI;
  s.jobsTotal = a.jobsTotal;
  s.employed = a.employed;
  s.unemployment = a.unemployment;
  s.demand.r = state.priv.demand.r;
  s.demand.c = state.priv.demand.c;
  s.demand.i = state.priv.demand.i;
  s.zonedTiles.r = tt.zonedR;
  s.zonedTiles.c = tt.zonedC;
  s.zonedTiles.i = tt.zonedI;
  s.buildings.r = a.countR;
  s.buildings.c = a.countC;
  s.buildings.i = a.countI;
  s.abandoned = a.abandoned;
  s.roadTiles = state.landRoadTiles + state.bridgeTiles;
  s.parkTiles = state.parkTiles;
  s.landValueAvg = tt.lvAvg;
  s.pollutionAvg = tt.polAvg;
  s.happiness = state.priv.happiness;
  s.civics.town_hall = s.civics.police = s.civics.fire = s.civics.school = s.civics.hospital = 0;
  for (const c of state.civics.values()) s.civics[c.kind]++;
  s.coverage.police = tt.covPolice;
  s.coverage.fire = tt.covFire;
  s.coverage.education = tt.covEducation;
  s.coverage.health = tt.covHealth;
  copyBudget(state.priv.lastMonth, s.lastMonth);
  copyBudget(projected, s.projected);
  return s;
}
