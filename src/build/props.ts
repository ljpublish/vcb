/**
 * MODULE: buildings — reusable street props (module-internal API; may change).
 * Owner: buildings agent (props/roads).
 *
 * Small voxel props drawn straight into a StampBuilder at a local position. Every function is
 * deterministic (randomness only from the `seed` argument via hash3), clips at the stamp bounds and
 * never allocates per voxel. Used by roadGen (lamps, bins, hydrants, benches, bus stops) and
 * available to lotGen / building generators (trees, bushes, flower beds, planters).
 *
 * Convention: (x, y, z) is the voxel the prop stands ON TOP of is (x, y-1, z), i.e. y is the first
 * layer above the ground surface (stamp layer 1 for road/lot stamps).
 */
import { B, type BlockId } from '../voxel/blocks';
import { hash3, hashToUnit } from '../core/rng';
import { StampBuilder } from './stamp';


export type TreeStyle = 'round' | 'pine' | 'autumn' | 'blossom' | 'bush' | 'poplar';
export const TREE_STYLES: readonly TreeStyle[] = ['round', 'pine', 'autumn', 'blossom', 'bush', 'poplar'];

/** Fill the half-open box [x0,x1)×[y0,y1)×[z0,z1); out-of-bounds voxels are skipped. */
export function box(sb: StampBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: BlockId): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) sb.set(x, y, z, id);
}

/** Write only where the stamp is still KEEP or AIR (props never overwrite structure). */
function soft(sb: StampBuilder, x: number, y: number, z: number, id: BlockId): void {
  const cur = sb.get(x, y, z);
  if (cur === 255 || cur === B.AIR) sb.set(x, y, z, id);
}

/**
 * Street lamp: METAL_POLE `height` tall, an arm one voxel towards (armDx, armDz) with the emissive
 * STREET_LAMP head hanging under it. Pass armDx = armDz = 0 for a park-style post lamp (head on top).
 * Total height = height + 1.
 */
export function drawStreetLamp(sb: StampBuilder, x: number, y: number, z: number, armDx: number, armDz: number, height = 5): void {
  for (let i = 0; i < height; i++) sb.set(x, y + i, z, B.METAL_POLE);
  if (armDx === 0 && armDz === 0) {
    sb.set(x, y + height, z, B.STREET_LAMP);
    return;
  }
  sb.set(x, y + height, z, B.METAL_POLE);
  sb.set(x + armDx, y + height, z + armDz, B.METAL_POLE);
  sb.set(x + armDx, y + height - 1, z + armDz, B.STREET_LAMP);
}

/** Fire hydrant: red body with a cap. 2 tall. */
export function drawHydrant(sb: StampBuilder, x: number, y: number, z: number): void {
  sb.set(x, y, z, B.PLAY_RED);
  sb.set(x, y + 1, z, B.SIGN_WHITE);
}

/** Litter bin: dark metal, 1 tall. */
export function drawBin(sb: StampBuilder, x: number, y: number, z: number): void {
  sb.set(x, y, z, B.METAL_SHEET_DARK);
}

/** Bollard: 1-voxel hazard post. */
export function drawBollard(sb: StampBuilder, x: number, y: number, z: number): void {
  sb.set(x, y, z, B.HAZARD_YELLOW);
}

/** Bench of `len` voxels running along X (alongX) or Z, seat only (reads as a bench at voxel scale). */
export function drawBench(sb: StampBuilder, x: number, y: number, z: number, alongX: boolean, len = 2): void {
  for (let i = 0; i < len; i++) sb.set(alongX ? x + i : x, y, alongX ? z : z + i, B.BENCH_WOOD);
}

/**
 * Bus stop shelter on a 1-voxel sidewalk strip, 3 long along X (alongX) or Z, starting at (x, z):
 * glass end panels, a bench in the middle, flat roof and an emissive sign post.
 */
export function drawBusStop(sb: StampBuilder, x: number, y: number, z: number, alongX: boolean): void {
  const at = (i: number, dy: number, id: BlockId): void => sb.set(alongX ? x + i : x, y + dy, alongX ? z : z + i, id);
  at(0, 0, B.GLASS_TEAL);
  at(0, 1, B.GLASS_TEAL);
  at(1, 0, B.BENCH_WOOD);
  at(2, 0, B.GLASS_TEAL);
  at(2, 1, B.GLASS_TEAL);
  for (let i = 0; i < 3; i++) at(i, 2, B.ROOF_FLAT);
  // Sign post just past the shelter.
  at(3, 0, B.METAL_POLE);
  at(3, 1, B.METAL_POLE);
  at(3, 2, B.SIGN_CYAN);
}

/** Flower bed filling [x0,x1)×[z0,z1) on layer y, hashed flower colours with a hedge-free border. */
export function drawFlowerBed(sb: StampBuilder, x0: number, y: number, z0: number, x1: number, z1: number, seed: number): void {
  const flowers = [B.FLOWER_RED, B.FLOWER_YELLOW, B.FLOWER_WHITE, B.FLOWER_PURPLE];
  for (let z = z0; z < z1; z++)
    for (let x = x0; x < x1; x++) {
      const h = hash3(x, y, z, seed);
      sb.set(x, y, z, (h & 3) === 0 ? B.BUSH : flowers[(h >>> 4) & 3]);
    }
}

/** Concrete planter box (1 tall rim) with a bush or flowers on top. */
export function drawPlanter(sb: StampBuilder, x: number, y: number, z: number, seed: number): void {
  sb.set(x, y, z, B.CONCRETE);
  const h = hash3(x, y, z, seed);
  sb.set(x, y + 1, z, (h & 1) === 0 ? B.BUSH : B.FLOWER_RED + ((h >>> 3) & 3));
}

/**
 * Tree centred on column (x, z), standing on layer y. size 0 = small (fits a 3×3 footprint),
 * 1 = medium (5×5), 2 = large (7×7). Canopy voxels never overwrite non-air structure.
 * Returns the height used (layers above y).
 */
export function drawTree(sb: StampBuilder, x: number, y: number, z: number, style: TreeStyle, size: 0 | 1 | 2, seed: number): number {
  const r = size === 0 ? 1 : size === 1 ? 2 : 3;
  switch (style) {
    case 'bush': {
      const rr = Math.max(1, r - 1);
      blob(sb, x, y + rr - 1, z, rr + 0.4, rr, B.BUSH, B.HEDGE, seed);
      return rr * 2;
    }
    case 'pine': {
      const trunk = 1 + size;
      for (let i = 0; i < trunk; i++) sb.set(x, y + i, z, B.WOOD_DARK);
      // Stacked shrinking square layers → stepped cone.
      let top = y + trunk;
      const layers = 3 + size * 2;
      for (let l = 0; l < layers; l++) {
        const rad = Math.round(r * (1 - l / layers) + 0.3);
        for (let dz = -rad; dz <= rad; dz++)
          for (let dx = -rad; dx <= rad; dx++) {
            if (rad > 1 && Math.abs(dx) === rad && Math.abs(dz) === rad) continue;
            soft(sb, x + dx, top, z + dz, B.PINE);
          }
        top++;
      }
      soft(sb, x, top, z, B.PINE);
      return top + 1 - y;
    }
    case 'poplar': {
      const trunk = 1 + size;
      for (let i = 0; i < trunk; i++) sb.set(x, y + i, z, B.WOOD);
      const h = 4 + size * 3;
      const rad = Math.max(1, r - 1);
      for (let i = 0; i < h; i++) {
        const t = i / (h - 1);
        const rr = rad * Math.sin(Math.PI * (0.15 + 0.85 * t)) + 0.35;
        disc(sb, x, y + trunk + i, z, rr, B.LEAVES_DARK, B.LEAVES, seed);
      }
      return trunk + h;
    }
    default: {
      const leaves = style === 'autumn' ? B.LEAVES_AUTUMN : style === 'blossom' ? B.LEAVES_PINK : B.LEAVES;
      const alt = style === 'round' ? B.LEAVES_LIGHT : style === 'autumn' ? B.FLOWER_YELLOW : B.FLOWER_WHITE;
      const trunk = 2 + size;
      for (let i = 0; i < trunk + r - 1; i++) sb.set(x, y + i, z, B.WOOD);
      const cy = y + trunk + r - 1;
      blob(sb, x, cy, z, r + 0.5, r, leaves, alt, seed);
      return cy + r + 1 - y;
    }
  }
}

/** Ellipsoid canopy: horizontal radius rh, vertical radius rv around (cx, cy, cz). */
function blob(sb: StampBuilder, cx: number, cy: number, cz: number, rh: number, rv: number, id: BlockId, alt: BlockId, seed: number): void {
  const R = Math.ceil(rh);
  for (let dy = -rv; dy <= rv; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const d = (dx * dx + dz * dz) / (rh * rh) + (dy * dy) / ((rv + 0.5) * (rv + 0.5));
        if (d > 1) continue;
        const h = hash3(cx + dx, cy + dy, cz + dz, seed);
        // Ragged edge: drop some outer voxels.
        if (d > 0.7 && hashToUnit(h) < 0.3) continue;
        soft(sb, cx + dx, cy + dy, cz + dz, (h >>> 8) % 5 === 0 ? alt : id);
      }
}

function disc(sb: StampBuilder, cx: number, y: number, cz: number, r: number, id: BlockId, alt: BlockId, seed: number): void {
  const R = Math.ceil(r);
  for (let dz = -R; dz <= R; dz++)
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dz * dz > r * r) continue;
      const h = hash3(cx + dx, y, cz + dz, seed);
      soft(sb, cx + dx, y, cz + dz, (h & 3) === 0 ? alt : id);
    }
}

export type PropKind = 'lamp' | 'postLamp' | 'bench' | 'bin' | 'hydrant' | 'bollard' | 'busStop' | 'planter' | 'trafficLight';

/**
 * Stand-alone, blit-able prop stamp authored facing +Z (lamp arm / bench front / bus stop opening
 * point to +Z; rotate with rotateY). Layer 0 is the first layer ABOVE the ground: blit it at
 * oy = groundLayer + 1. Footprints: lamp 1×2, busStop 4×1, bench 2×1, trafficLight 1×2, others 1×1.
 */
export function makeProp(kind: PropKind, seed = 0): StampBuilder {
  switch (kind) {
    case 'lamp': { const sb = new StampBuilder(1, 6, 2); drawStreetLamp(sb, 0, 0, 0, 0, 1); return sb; }
    case 'postLamp': { const sb = new StampBuilder(1, 4, 1); drawStreetLamp(sb, 0, 0, 0, 0, 0, 3); return sb; }
    case 'bench': { const sb = new StampBuilder(2, 1, 1); drawBench(sb, 0, 0, 0, true, 2); return sb; }
    case 'bin': { const sb = new StampBuilder(1, 1, 1); drawBin(sb, 0, 0, 0); return sb; }
    case 'hydrant': { const sb = new StampBuilder(1, 2, 1); drawHydrant(sb, 0, 0, 0); return sb; }
    case 'bollard': { const sb = new StampBuilder(1, 1, 1); drawBollard(sb, 0, 0, 0); return sb; }
    case 'busStop': { const sb = new StampBuilder(4, 3, 1); drawBusStop(sb, 0, 0, 0, true); return sb; }
    case 'planter': { const sb = new StampBuilder(1, 2, 1); drawPlanter(sb, 0, 0, 0, seed); return sb; }
    case 'trafficLight': {
      const sb = new StampBuilder(1, 5, 2);
      for (let i = 0; i < 5; i++) sb.set(0, i, 0, B.METAL_POLE);
      sb.set(0, 4, 1, B.METAL_SHEET_DARK);
      sb.set(0, 3, 1, (seed & 1) === 0 ? B.SIGN_GREEN : B.BEACON_RED);
      return sb;
    }
  }
}

/** Stand-alone tree stamp (footprint 3/5/7 square for size 0/1/2), layer 0 = first layer above ground. */
export function makeTree(style: TreeStyle, size: 0 | 1 | 2, seed: number): StampBuilder {
  const w = size * 2 + 3;
  const sb = new StampBuilder(w, 16, w);
  drawTree(sb, w >> 1, 0, w >> 1, style, size, seed);
  return sb;
}
