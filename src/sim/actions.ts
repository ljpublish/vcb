/**
 * MODULE: simulation — tool action validation + application (module-internal API; may change).
 * Owner: simulation agent.
 *
 * STUB. Rules (authoritative, mirrored in ARCHITECTURE.md §11.4):
 *  road     : Empty land (decor cleared, +treeClear), Empty water (= bridge, TOOL_COSTS.bridge),
 *             Zoned without building (de-zones it). Existing road tiles: valid, cost 0, not "changed".
 *             Invalid: Park, tiles with a building.
 *  zone     : Empty land, or Zoned with another zone and no building. Same zone: skipped (cost 0).
 *             Invalid: water, Road, Park, tiles with a building.
 *  park     : Empty land or Zoned without building. Invalid: water, Road, building tiles, Park.
 *  bulldoze : Road / Zoned / Park / Empty-with-decor → Empty (decor removed). A building on any
 *             dragged tile is removed entirely (+bulldozeBuildingPerLevel × level, once);
 *             non-dragged footprint tiles stay Zoned (empty lots). Empty tiles without decor: invalid.
 *  Rejected entirely when cost > money. Max MAX_ACTION_TILES tiles. Duplicate tiles count once.
 */
import type { ActionPreview, ActionResult, TerrainReader, ToolAction } from '../types';
import type { CityState } from './cityState';

export function previewAction(state: CityState, terrain: TerrainReader, action: ToolAction): ActionPreview {
  // TODO(simulation)
  return { cost: 0, valid: action.tiles.map(() => false), validCount: 0, affordable: true };
}

export function applyAction(state: CityState, terrain: TerrainReader, action: ToolAction, changed: Set<number>): ActionResult {
  // TODO(simulation)
  return { ok: false, cost: 0, applied: 0, changedTiles: [] };
}
