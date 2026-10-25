/**
 * MODULE: simulation — road network analysis (module-internal API; may change).
 * Owner: simulation agent.
 *
 * STUB. Intended:
 *  - recomputeRoadMasks: DIR_BIT mask of 4-neighbour road tiles for every road tile.
 *  - recomputeRoadAccess: multi-source BFS from all road tiles → roadDist (capped at 255);
 *    access = roadDist <= ROAD_ACCESS_DISTANCE.
 *  - recomputeComponents: flood-fill road components; flag components touching the map edge
 *    (isEdgeTile) as region-connected.
 * Run these only when roads change (dirty flag), not every tick. 4096 tiles → well under 1 ms.
 */
import type { CityState } from './cityState';

export function recomputeRoadMasks(state: CityState): void {
  // TODO(simulation)
}

export function recomputeRoadAccess(state: CityState): void {
  // TODO(simulation)
}

/** Returns, per component id, whether that component touches the map edge. */
export function recomputeComponents(state: CityState): boolean[] {
  // TODO(simulation)
  return [];
}
