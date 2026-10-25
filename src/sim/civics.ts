/**
 * MODULE: simulation — civic service buildings (module-internal API).
 * Owner: simulation agent.
 *
 *  - evaluateCivic: placement rules from the CIVIC_SPECS doc comment in src/types.ts (pure).
 *  - placeCivic / removeCivic: mutate state (tiles become TileKind.Civic / Empty).
 *  - recomputeCoverage: per-tile police / fire / education / health coverage (0..255), derived
 *    from the civic list only (so it never needs saving). Full coverage within half the radius,
 *    linear falloff to 0 just past the radius (Chebyshev distance from the footprint).
 */
import {
  CIVIC_KINDS,
  CIVIC_SPECS,
  MAP_TILES,
  TILE_FLAG_DECOR,
  TOOL_COSTS,
  TileKind,
  ZoneType,
  type CivicBuilding,
  type CivicKind,
  type TerrainReader,
  type TileCoord,
} from '../types';
import type { CityState } from './cityState';
import { pickFacing } from './growth';

export interface CivicEvaluation {
  ok: boolean;
  cost: number;
  /** Footprint tiles, row-major (size² entries). */
  tiles: number[];
  reason?: string;
}

export function isCivicKind(k: unknown): k is CivicKind {
  return typeof k === 'string' && (CIVIC_KINDS as readonly string[]).includes(k);
}

/** Pure placement check. */
export function evaluateCivic(state: CityState, terrain: TerrainReader, kind: unknown, origin: TileCoord | undefined): CivicEvaluation {
  const out: CivicEvaluation = { ok: false, cost: 0, tiles: [] };
  if (!isCivicKind(kind)) {
    out.reason = 'Unknown building';
    return out;
  }
  const spec = CIVIC_SPECS[kind];
  const size = spec.size;
  const ox = origin?.tx;
  const oz = origin?.tz;
  if (!Number.isInteger(ox) || !Number.isInteger(oz)) {
    out.reason = 'Invalid location';
    return out;
  }
  const x0 = ox as number;
  const z0 = oz as number;
  for (let dz = 0; dz < size; dz++) for (let dx = 0; dx < size; dx++) out.tiles.push((z0 + dz) * MAP_TILES + x0 + dx);
  if (x0 < 0 || z0 < 0 || x0 + size > MAP_TILES || z0 + size > MAP_TILES) {
    out.reason = 'Outside the map';
    return out;
  }
  if (spec.maxCount > 0) {
    let n = 0;
    for (const c of state.civics.values()) if (c.kind === kind) n++;
    if (n >= spec.maxCount) {
      out.reason = spec.maxCount === 1 ? `Only one ${spec.label} allowed` : `At most ${spec.maxCount} allowed`;
      return out;
    }
  }
  const h = terrain.getTileHeight(x0, z0);
  let cost = spec.cost;
  for (let dz = 0; dz < size; dz++)
    for (let dx = 0; dx < size; dx++) {
      const x = x0 + dx;
      const z = z0 + dz;
      const i = z * MAP_TILES + x;
      if (terrain.isWater(x, z)) {
        out.reason = 'Cannot build on water';
        return out;
      }
      if (state.kind[i] !== TileKind.Empty) {
        out.reason = 'Needs empty land';
        return out;
      }
      if (terrain.getTileHeight(x, z) !== h) {
        out.reason = 'Ground is not flat';
        return out;
      }
      if (state.flags[i] & TILE_FLAG_DECOR) cost += TOOL_COSTS.treeClear;
    }
  // at least one footprint edge tile next to a road
  let road = false;
  for (let k = 0; k < size && !road; k++) {
    const cand = [
      [x0 + k, z0 - 1],
      [x0 + k, z0 + size],
      [x0 - 1, z0 + k],
      [x0 + size, z0 + k],
    ];
    for (const [x, z] of cand)
      if (x >= 0 && z >= 0 && x < MAP_TILES && z < MAP_TILES && state.kind[z * MAP_TILES + x] === TileKind.Road) road = true;
  }
  if (!road) {
    out.reason = 'Must be next to a road';
    return out;
  }
  out.ok = true;
  out.cost = cost;
  return out;
}

export function placeCivic(state: CityState, kind: CivicKind, tx: number, tz: number, changed: Set<number>): CivicBuilding {
  const size = CIVIC_SPECS[kind].size;
  const c: CivicBuilding = {
    id: state.nextBuildingId++,
    kind,
    tx,
    tz,
    facing: pickFacing(state, tx, tz, size, state.rng),
    variant: state.rng.nextU32(),
    builtDay: state.day,
  };
  state.civics.set(c.id, c);
  for (let dz = 0; dz < size; dz++)
    for (let dx = 0; dx < size; dx++) {
      const i = (tz + dz) * MAP_TILES + tx + dx;
      state.kind[i] = TileKind.Civic;
      state.zone[i] = ZoneType.None;
      state.flags[i] &= ~TILE_FLAG_DECOR;
      state.civicAt[i] = c.id;
      changed.add(i);
    }
  return c;
}

/** Removes the whole civic building; its footprint becomes Empty. */
export function removeCivic(state: CityState, c: Readonly<CivicBuilding>, changed: Set<number>): void {
  const size = CIVIC_SPECS[c.kind].size;
  for (let dz = 0; dz < size; dz++)
    for (let dx = 0; dx < size; dx++) {
      const i = (c.tz + dz) * MAP_TILES + c.tx + dx;
      state.kind[i] = TileKind.Empty;
      state.civicAt[i] = 0;
      changed.add(i);
    }
  state.civics.delete(c.id);
}

function fieldFor(state: CityState, kind: CivicKind): Uint8Array | null {
  switch (kind) {
    case 'police':
      return state.covPolice;
    case 'fire':
      return state.covFire;
    case 'school':
      return state.covEducation;
    case 'hospital':
      return state.covHealth;
    default:
      return null;
  }
}

export function recomputeCoverage(state: CityState): void {
  state.covPolice.fill(0);
  state.covFire.fill(0);
  state.covEducation.fill(0);
  state.covHealth.fill(0);
  for (const c of state.civics.values()) {
    const spec = CIVIC_SPECS[c.kind];
    const field = fieldFor(state, c.kind);
    if (!field || spec.radius <= 0) continue;
    const r = spec.radius;
    const full = r / 2;
    const x0 = c.tx;
    const z0 = c.tz;
    const x1 = c.tx + spec.size - 1;
    const z1 = c.tz + spec.size - 1;
    for (let z = Math.max(0, z0 - r); z <= Math.min(MAP_TILES - 1, z1 + r); z++) {
      const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
      for (let x = Math.max(0, x0 - r); x <= Math.min(MAP_TILES - 1, x1 + r); x++) {
        const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
        const d = dx > dz ? dx : dz;
        const v = d <= full ? 255 : Math.round(255 * (1 - (d - full) / (r - full + 1)));
        const i = z * MAP_TILES + x;
        if (v > field[i]) field[i] = v;
      }
    }
  }
}

/** Monthly upkeep of all civic buildings. */
export function civicUpkeep(state: CityState): number {
  let u = 0;
  for (const c of state.civics.values()) u += CIVIC_SPECS[c.kind].upkeep;
  return u;
}
