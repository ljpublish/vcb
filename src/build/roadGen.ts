/**
 * MODULE: buildings — road / bridge tile stamps (module-internal API; may change).
 * Owner: buildings agent.
 *
 * STUB.
 *
 * Layout (must match ROAD_* constants in src/types.ts — the traffic in src/fx relies on it):
 *  - Stamp is TILE_SIZE × H × TILE_SIZE. Land: stamp y = 0 is world y = groundHeight - 1 (the road
 *    surface layer replaces the top ground voxel, flush with neighbours); lamp posts etc. above.
 *  - Cross-section perpendicular to travel: voxel 0 and 7 = SIDEWALK on edges WITHOUT a road
 *    neighbour (connected edges continue the asphalt to the tile border), 1..6 = ASPHALT.
 *    Centre markings: dashed ROAD_LINE_YELLOW (or WHITE) in voxels 3–4 along straight segments.
 *    Intersections (≥3 connections): no centre line, ROAD_LINE_WHITE crosswalk stripes near the
 *    connected edges, sidewalk corner squares at the 4 corners. Dead ends: sidewalk cap.
 *    Isolated tile (mask 0): small plaza/turning circle.
 *  - Street lamps: METAL_POLE (height ~5) + STREET_LAMP head on sidewalk voxels, ~every other tile
 *    (hash of tx,tz), never on asphalt.
 *  - Bridge (water tile): deck top at BRIDGE_DECK_HEIGHT (deck voxel layer y = BRIDGE_DECK_HEIGHT-1),
 *    CONCRETE/ASPHALT deck, RAILING on unconnected-to-road edges that face water, BRIDGE_STEEL or
 *    CONCRETE pillars down to the bed at the tile centre every tile; water around pillars untouched
 *    (use STAMP_KEEP). originY = bed height for bridges.
 */
import type { GeneratedStructure } from './buildingGen';

export interface RoadSpec {
  /** DIR_BIT mask of connected road neighbours. */
  mask: number;
  /** Tile is water → bridge. */
  bridge: boolean;
  /** terrain.getTileHeight (bed height for water tiles). */
  groundHeight: number;
  tx: number;
  tz: number;
  /** Terrain seed (for deterministic lamp placement / wear patches). */
  seed: number;
}

export function generateRoad(spec: RoadSpec): GeneratedStructure {
  // TODO(buildings)
  return { stamp: { sx: 8, sy: 1, sz: 8, data: new Uint8Array(64).fill(255) }, originY: spec.groundHeight - 1, emitters: [] };
}
