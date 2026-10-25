/**
 * MODULE: simulation — road network analysis (module-internal API).
 * Owner: simulation agent.
 *
 *  - recomputeRoadMasks: DIR_BIT mask of 4-neighbour road tiles for every road tile.
 *  - recomputeRoadAccess: multi-source BFS from all road tiles → roadDist (capped at 255);
 *    access = roadDist <= ROAD_ACCESS_DISTANCE.
 *  - recomputeComponents: flood-fill road components; flag components touching the map edge
 *    (isEdgeTile) as region-connected; then BFS from edge-connected roads only → connDist.
 * Run these only when roads change, not every tick. 4096 tiles → well under 1 ms.
 */
import { DIR_BIT, MAP_TILES, TILE_COUNT, TileKind } from '../types';
import type { TerrainReader } from '../types';
import { isEdgeTile } from '../core/coords';
import type { CityState } from './cityState';

export function recomputeRoadMasks(state: CityState): void {
  const { kind, roadMask } = state;
  for (let i = 0; i < TILE_COUNT; i++) {
    if (kind[i] !== TileKind.Road) {
      roadMask[i] = 0;
      continue;
    }
    const tx = i % MAP_TILES;
    const tz = (i - tx) / MAP_TILES;
    let m = 0;
    if (tz > 0 && kind[i - MAP_TILES] === TileKind.Road) m |= DIR_BIT[0];
    if (tx < MAP_TILES - 1 && kind[i + 1] === TileKind.Road) m |= DIR_BIT[1];
    if (tz < MAP_TILES - 1 && kind[i + MAP_TILES] === TileKind.Road) m |= DIR_BIT[2];
    if (tx > 0 && kind[i - 1] === TileKind.Road) m |= DIR_BIT[3];
    roadMask[i] = m;
  }
}

/** Multi-source BFS (4-neighbour = Manhattan) from every tile where `isSource` is set. */
function bfs(state: CityState, out: Uint8Array, isSource: (i: number) => boolean): void {
  const q = state.queue;
  let head = 0;
  let tail = 0;
  out.fill(255);
  for (let i = 0; i < TILE_COUNT; i++) {
    if (isSource(i)) {
      out[i] = 0;
      q[tail++] = i;
    }
  }
  while (head < tail) {
    const i = q[head++];
    const d = out[i] + 1;
    if (d >= 255) continue;
    const tx = i % MAP_TILES;
    if (i >= MAP_TILES && out[i - MAP_TILES] > d) (out[i - MAP_TILES] = d), (q[tail++] = i - MAP_TILES);
    if (i < TILE_COUNT - MAP_TILES && out[i + MAP_TILES] > d) (out[i + MAP_TILES] = d), (q[tail++] = i + MAP_TILES);
    if (tx > 0 && out[i - 1] > d) (out[i - 1] = d), (q[tail++] = i - 1);
    if (tx < MAP_TILES - 1 && out[i + 1] > d) (out[i + 1] = d), (q[tail++] = i + 1);
  }
}

export function recomputeRoadAccess(state: CityState): void {
  const kind = state.kind;
  bfs(state, state.roadDist, (i) => kind[i] === TileKind.Road);
}

/** Returns, per component id, whether that component touches the map edge. Also fills connDist. */
export function recomputeComponents(state: CityState): boolean[] {
  const { kind, roadComponent, componentEdge, queue: q } = state;
  roadComponent.fill(-1);
  componentEdge.fill(0);
  let comp = 0;
  for (let s = 0; s < TILE_COUNT; s++) {
    if (kind[s] !== TileKind.Road || roadComponent[s] !== -1) continue;
    let head = 0;
    let tail = 0;
    q[tail++] = s;
    roadComponent[s] = comp;
    let edge = 0;
    while (head < tail) {
      const i = q[head++];
      const tx = i % MAP_TILES;
      const tz = (i - tx) / MAP_TILES;
      if (isEdgeTile(tx, tz)) edge = 1;
      if (tz > 0 && kind[i - MAP_TILES] === TileKind.Road && roadComponent[i - MAP_TILES] === -1)
        (roadComponent[i - MAP_TILES] = comp), (q[tail++] = i - MAP_TILES);
      if (tz < MAP_TILES - 1 && kind[i + MAP_TILES] === TileKind.Road && roadComponent[i + MAP_TILES] === -1)
        (roadComponent[i + MAP_TILES] = comp), (q[tail++] = i + MAP_TILES);
      if (tx > 0 && kind[i - 1] === TileKind.Road && roadComponent[i - 1] === -1)
        (roadComponent[i - 1] = comp), (q[tail++] = i - 1);
      if (tx < MAP_TILES - 1 && kind[i + 1] === TileKind.Road && roadComponent[i + 1] === -1)
        (roadComponent[i + 1] = comp), (q[tail++] = i + 1);
    }
    componentEdge[comp] = edge;
    comp++;
  }
  state.componentCount = comp;
  let region = false;
  const out: boolean[] = [];
  for (let c = 0; c < comp; c++) {
    out.push(componentEdge[c] === 1);
    if (componentEdge[c] === 1) region = true;
  }
  state.regionConnected = region;
  bfs(state, state.connDist, (i) => roadComponent[i] >= 0 && componentEdge[roadComponent[i]] === 1);
  return out;
}

/** Counts land / bridge road tiles and park tiles. */
export function recomputeCounts(state: CityState, terrain: TerrainReader): void {
  let land = 0;
  let bridge = 0;
  let park = 0;
  for (let i = 0; i < TILE_COUNT; i++) {
    const k = state.kind[i];
    if (k === TileKind.Road) {
      const tx = i % MAP_TILES;
      if (terrain.isWater(tx, (i - tx) / MAP_TILES)) bridge++;
      else land++;
    } else if (k === TileKind.Park) park++;
  }
  state.landRoadTiles = land;
  state.bridgeTiles = bridge;
  state.parkTiles = park;
}

/** Everything road-related. */
export function recomputeRoads(state: CityState, terrain: TerrainReader): void {
  recomputeRoadMasks(state);
  recomputeRoadAccess(state);
  recomputeComponents(state);
  recomputeCounts(state, terrain);
}
