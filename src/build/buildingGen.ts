/**
 * MODULE: buildings — procedural building generator entry point (module-internal API; may change).
 * Owner: buildings agent.
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
import { Rng, mixSeed } from '../core/rng';
import { B } from '../voxel/blocks';
import { applyAbandoned, generateConstruction } from './construction';
import { generateCommercial } from './commercial';
import { generateIndustrial } from './industrial';
import { generateResidential } from './residential';
import { StampBuilder, rotatePoint } from './stamp';
import {
  BuildingState,
  TILE_SIZE,
  type BuildingLevel,
  type BuildingSize,
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

/** Rng seed salt so building looks don't correlate with other uses of the variant. */
const VARIANT_SALT = 0x5eed_b11d;

/**
 * Generate a building stamp. `groundHeight` = terrain.getTileHeight of the footprint.
 * Pipeline: zone generator (authored facing +Z, Active look) → construction / abandoned transform
 * → rotate to spec.facing → trim. Never throws: a failing generator yields a plain FOUNDATION slab.
 */
export function generateBuilding(spec: BuildingSpec, groundHeight: number): GeneratedStructure {
  const S = spec.size * TILE_SIZE;
  const emitters: LocalEmitter[] = [];
  let b: StampBuilder;
  try {
    const rng = new Rng(mixSeed(spec.variant >>> 0, VARIANT_SALT));
    if (spec.zone === 1) b = generateResidential(spec, rng, emitters);
    else if (spec.zone === 2) b = generateCommercial(spec, rng, emitters);
    else b = generateIndustrial(spec, rng, emitters);
    if (b.sx !== S || b.sz !== S) throw new Error(`generator returned ${b.sx}×${b.sz}, expected ${S}×${S}`);
    if (spec.state === BuildingState.Constructing) {
      b = generateConstruction(spec, b, new Rng(mixSeed(spec.variant >>> 0, 0xc0de)));
      emitters.length = 0;
    } else if (spec.state === BuildingState.Abandoned) {
      applyAbandoned(b, new Rng(mixSeed(spec.variant >>> 0, 0xdead)));
      emitters.length = 0;
    }
  } catch (err) {
    reportGenError(err);
    b = new StampBuilder(S, 2, S);
    b.fill(0, 0, 0, S, 1, S, B.FOUNDATION);
    emitters.length = 0;
  }
  const rotated = b.rotateY(spec.facing);
  const stamp = rotated.toStamp();
  for (const e of emitters) {
    const [x, z] = rotatePoint(e.x, e.z, S, spec.facing);
    e.x = Math.max(0, Math.min(S, x));
    e.z = Math.max(0, Math.min(S, z));
    e.y = Math.max(0, Math.min(stamp.sy + 2, e.y));
  }
  return { stamp, originY: groundHeight - 1, emitters };
}

let genErrors = 0;
function reportGenError(err: unknown): void {
  if (genErrors++ < 5) console.warn('[buildings] generator failed', err);
}
