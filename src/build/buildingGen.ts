/**
 * MODULE: buildings — procedural building generator entry point (module-internal API; may change).
 * Owner: buildings agent.
 *
 * STUB: returns an empty stamp.
 *
 * Contract inside the module:
 *  - Deterministic: the same BuildingSpec always yields identical voxels (seed an Rng from
 *    spec.variant via src/core/rng.ts; never Math.random()).
 *  - Footprint: sx = sz = spec.size * TILE_SIZE. Stamp layer y = 0 is the tile's ground surface layer
 *    (world y = groundHeight - 1) so generators can repaint the lot (lawn, paths, parking);
 *    the structure itself starts at stamp y = 1. Total height ≤ MAX_STRUCTURE_HEIGHT + 1.
 *  - Never write outside the footprint (sx × sz). Use STAMP_KEEP for "untouched".
 *  - Author with the front facing +Z and rotate to spec.facing (StampBuilder.rotateY).
 *  - Look & feel per zone/level (each with several variants):
 *      R1 small houses with pitched/hip roofs, chimneys, colourful plaster/brick, yard, fence/hedge, tree.
 *      R2 townhouses / 3–5 storey walk-ups with balconies.  R3 apartment towers (1×1 ~20–40, 2×2 ~28–56 tall).
 *      C1 corner shops, awnings, glowing signs.  C2 4–8 storey offices with glass bands.
 *      C3 glass skyscrapers with setbacks, spires, helipads, beacons (2×2 up to ~78 tall).
 *      I1 sheds/warehouses with metal siding, loading doors, crates.  I2 factories with sawtooth roofs,
 *      smokestacks (smoke emitters), tanks.  I3 heavy industry: silos, big stacks, pipes, containers.
 *    Windows: 3-voxel floors; mix WINDOW and WINDOW_LIT (≈40–60% lit, hashed per window) so the city
 *    twinkles at night. Rooftops get detail (AC_UNIT, water tanks, antennas, BEACON_RED on tall towers).
 *  - state Constructing: FOUNDATION slab + SCAFFOLD frame up to (stage+1)/(CONSTRUCTION_STAGES+1) of
 *    the final height with partial walls; CRANE_YELLOW crane for level ≥ 2. No emitters.
 *  - state Abandoned: same silhouette but WINDOW_LIT → GLASS_DARK/BOARDED, some walls → BOARDED,
 *    RUBBLE patches in the yard, no emitters, no signs lit (swap SIGN_* → BOARDED).
 */
import {
  TILE_SIZE,
  type BuildingLevel,
  type BuildingSize,
  type BuildingState,
  type Dir,
  type EmitterKind,
  type RCIZone,
  type VoxelStamp,
} from '../types';

export interface BuildingSpec {
  zone: RCIZone;
  level: BuildingLevel;
  size: BuildingSize;
  facing: Dir;
  variant: number;
  state: BuildingState;
  stage: number;
}

/** Emitter position in STAMP-LOCAL voxel coordinates (structureSync converts to world). */
export interface LocalEmitter {
  x: number;
  y: number;
  z: number;
  kind: EmitterKind;
  strength: number;
}

export interface GeneratedStructure {
  stamp: VoxelStamp;
  /** World y of stamp layer 0. For buildings/lots/parks this is groundHeight - 1. */
  originY: number;
  emitters: LocalEmitter[];
}

/** Generate a building stamp. `groundHeight` = terrain.getTileHeight of the footprint. */
export function generateBuilding(spec: BuildingSpec, groundHeight: number): GeneratedStructure {
  // TODO(buildings): dispatch to residential.ts / commercial.ts / industrial.ts / construction.ts
  const s = spec.size * TILE_SIZE;
  return { stamp: { sx: s, sy: 1, sz: s, data: new Uint8Array(s * s).fill(255) }, originY: groundHeight - 1, emitters: [] };
}
