/**
 * MODULE: simulation — tool action validation + application (module-internal API).
 * Owner: simulation agent.
 *
 * Rules (authoritative, mirrored in ARCHITECTURE.md §11.4):
 *  road     : Empty land (decor cleared, +treeClear), Empty water (= bridge, TOOL_COSTS.bridge),
 *             Zoned without building (de-zones it). Existing road tiles: valid, cost 0, not "changed".
 *             Invalid: Park, tiles with a building.
 *  zone     : Empty land, or Zoned with another zone and no building. Same zone: skipped (cost 0).
 *             Invalid: water, Road, Park, tiles with a building.
 *  park     : Empty land or Zoned without building. Invalid: water, Road, building tiles, Park.
 *  bulldoze : Road / Zoned / Park / Empty-with-decor → Empty (decor removed). A building on any
 *             dragged tile is removed entirely (+bulldozeBuildingPerLevel × level, once);
 *             non-dragged footprint tiles stay Zoned (empty lots). Empty tiles without decor: invalid.
 *  civic    : one building at `origin` (rules: CIVIC_SPECS doc comment in src/types.ts; see civics.ts).
 *             All-or-nothing: preview.valid has one entry per footprint tile (row-major, size²).
 *             Bulldozing any Civic footprint tile removes the whole civic building (no refund);
 *             its whole footprint becomes Empty. Civic tiles are invalid for road / zone / park.
 *  Rejected entirely when cost > money. Max MAX_ACTION_TILES tiles. Duplicate tiles count once.
 *
 * previewAction and applyAction share `evaluate` (pure), so validation is identical.
 * The caller (Simulation) recomputes derived state and emits events after applyAction.
 */
import {
  MAP_TILES,
  MAX_ACTION_TILES,
  TILE_FLAG_DECOR,
  TOOL_COSTS,
  TileKind,
  ZoneType,
  type ActionPreview,
  type ActionResult,
  type TerrainReader,
  type ToolAction,
} from '../types';
import type { CityState } from './cityState';
import { removeBuilding } from './growth';
import { evaluateCivic, placeCivic, removeCivic } from './civics';

const R_OK = 0;
const R_WATER = 1;
const R_BUILDING = 2;
const R_OTHER = 3;

interface Evaluation {
  valid: boolean[];
  validCount: number;
  cost: number;
  /** Valid tiles that would actually change (existing roads in a road path don't). */
  changing: number;
  reason: number;
}

/** Pure: never mutates city state (only the dedup scratch stamp). */
function evaluate(state: CityState, terrain: TerrainReader, action: Exclude<ToolAction, { type: 'civic' }>): Evaluation {
  const tiles = Array.isArray(action.tiles) ? action.tiles : [];
  const valid: boolean[] = new Array<boolean>(tiles.length).fill(false);
  const gen = state.nextSeen();
  const seen = state.seenStamp;
  let validCount = 0;
  let changing = 0;
  let cost = 0;
  let worst = R_OK;
  let seenBuildings: Set<number> | null = null;
  const type = action.type;
  const zoneArg = type === 'zone' ? action.zone : 0;
  const zoneOk = zoneArg === ZoneType.Residential || zoneArg === ZoneType.Commercial || zoneArg === ZoneType.Industrial;

  for (let n = 0; n < tiles.length; n++) {
    if (n >= MAX_ACTION_TILES) break;
    const t = tiles[n];
    if (!t) continue;
    const tx = t.tx;
    const tz = t.tz;
    if (!Number.isInteger(tx) || !Number.isInteger(tz) || tx < 0 || tz < 0 || tx >= MAP_TILES || tz >= MAP_TILES) continue;
    const i = tz * MAP_TILES + tx;
    if (seen[i] === gen) continue;
    seen[i] = gen;
    const k = state.kind[i];
    const water = terrain.isWater(tx, tz);
    const hasB = state.buildingAt[i] !== 0 || k === TileKind.Civic;
    const decor = (state.flags[i] & TILE_FLAG_DECOR) !== 0 ? TOOL_COSTS.treeClear : 0;
    let c = -1;
    let reason = R_OTHER;
    let changes = true;
    switch (type) {
      case 'road':
        if (k === TileKind.Road) {
          c = 0;
          changes = false;
        } else if (k === TileKind.Empty) c = (water ? TOOL_COSTS.bridge : TOOL_COSTS.road) + decor;
        else if (k === TileKind.Zoned && !hasB) c = TOOL_COSTS.road;
        else if (hasB) reason = R_BUILDING;
        break;
      case 'zone':
        if (!zoneOk) break;
        if (water) reason = R_WATER;
        else if (k === TileKind.Empty) c = TOOL_COSTS.zone + decor;
        else if (k === TileKind.Zoned && !hasB && state.zone[i] !== zoneArg) c = TOOL_COSTS.zone;
        else if (hasB) reason = R_BUILDING;
        break;
      case 'park':
        if (water) reason = R_WATER;
        else if (k === TileKind.Empty) c = TOOL_COSTS.park + decor;
        else if (k === TileKind.Zoned && !hasB) c = TOOL_COSTS.park;
        else if (hasB) reason = R_BUILDING;
        break;
      case 'bulldoze':
        if (k !== TileKind.Empty || decor > 0) {
          c = TOOL_COSTS.bulldoze + decor;
          if (k === TileKind.Civic) {
            // whole civic building goes; no extra charge
          } else if (hasB) {
            const id = state.buildingAt[i];
            if (!seenBuildings) seenBuildings = new Set();
            if (!seenBuildings.has(id)) {
              seenBuildings.add(id);
              const b = state.buildings.get(id);
              c += TOOL_COSTS.bulldozeBuildingPerLevel * (b ? b.level : 1);
            }
          }
        }
        break;
    }
    if (c < 0) {
      if (reason < R_OTHER && (worst === R_OK || reason < worst)) worst = reason;
      else if (worst === R_OK) worst = R_OTHER;
      continue;
    }
    valid[n] = true;
    validCount++;
    if (changes) changing++;
    cost += c;
  }
  return { valid, validCount, cost, changing, reason: worst };
}

function reasonText(type: ToolAction['type'], code: number): string {
  if (code === R_WATER) return 'Cannot build on water';
  if (code === R_BUILDING) return type === 'bulldoze' ? 'Nothing to bulldoze' : 'Tile is occupied by a building';
  return type === 'bulldoze' ? 'Nothing to bulldoze' : 'Nothing to build here';
}

export function previewAction(state: CityState, terrain: TerrainReader, action: ToolAction): ActionPreview {
  if (action.type === 'civic') {
    const c = evaluateCivic(state, terrain, action.kind, action.origin);
    const affordable = c.cost <= state.money;
    const out: ActionPreview = { cost: c.cost, valid: c.tiles.map(() => c.ok), validCount: c.ok ? c.tiles.length : 0, affordable };
    if (!c.ok) out.reason = c.reason;
    else if (!affordable) out.reason = 'Not enough money';
    return out;
  }
  const e = evaluate(state, terrain, action);
  const affordable = e.cost <= state.money;
  const out: ActionPreview = { cost: e.cost, valid: e.valid, validCount: e.validCount, affordable };
  if (e.validCount === 0) out.reason = reasonText(action.type, e.reason);
  else if (!affordable) out.reason = 'Not enough money';
  return out;
}

/**
 * Applies the action to the state (tiles, buildings, money). Changed tile indices (including every
 * footprint tile of removed buildings) go into `changed`. Returns `roadsChanged` via the result's
 * changedTiles; the caller recomputes derived state.
 */
export function applyAction(state: CityState, terrain: TerrainReader, action: ToolAction, changed: Set<number>): ActionResult {
  if (action.type === 'civic') {
    const c = evaluateCivic(state, terrain, action.kind, action.origin);
    if (!c.ok) return { ok: false, cost: 0, applied: 0, reason: c.reason, changedTiles: [] };
    if (c.cost > state.money) return { ok: false, cost: 0, applied: 0, reason: 'Not enough money', changedTiles: [] };
    placeCivic(state, action.kind, action.origin.tx, action.origin.tz, changed);
    state.money -= c.cost;
    return { ok: true, cost: c.cost, applied: c.tiles.length, changedTiles: Array.from(changed) };
  }
  const e = evaluate(state, terrain, action);
  if (e.validCount === 0 || e.changing === 0) {
    return { ok: false, cost: 0, applied: 0, reason: reasonText(action.type, e.reason), changedTiles: [] };
  }
  if (e.cost > state.money) {
    return { ok: false, cost: 0, applied: 0, reason: 'Not enough money', changedTiles: [] };
  }
  const tiles = action.tiles;
  let applied = 0;
  for (let n = 0; n < e.valid.length; n++) {
    if (!e.valid[n]) continue;
    const { tx, tz } = tiles[n];
    const i = tz * MAP_TILES + tx;
    const k = state.kind[i];
    switch (action.type) {
      case 'road':
        if (k === TileKind.Road) continue;
        state.kind[i] = TileKind.Road;
        state.zone[i] = ZoneType.None;
        break;
      case 'zone':
        state.kind[i] = TileKind.Zoned;
        state.zone[i] = action.zone;
        break;
      case 'park':
        state.kind[i] = TileKind.Park;
        state.zone[i] = ZoneType.None;
        break;
      case 'bulldoze': {
        if (k === TileKind.Civic) {
          const c = state.civics.get(state.civicAt[i]);
          if (c) removeCivic(state, c, changed);
          state.kind[i] = TileKind.Empty;
          break;
        }
        const id = state.buildingAt[i];
        if (id !== 0) {
          const b = state.buildings.get(id);
          if (b) removeBuilding(state, b, changed);
        }
        state.kind[i] = TileKind.Empty;
        state.zone[i] = ZoneType.None;
        break;
      }
    }
    state.flags[i] &= ~TILE_FLAG_DECOR;
    changed.add(i);
    applied++;
  }
  state.money -= e.cost;
  return { ok: applied > 0, cost: e.cost, applied, changedTiles: Array.from(changed) };
}
