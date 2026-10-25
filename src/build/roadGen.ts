/**
 * MODULE: buildings — road / bridge tile stamps (module-internal API; may change).
 * Owner: buildings agent (props/roads).
 *
 * Layout (must match ROAD_* constants in src/types.ts — the traffic in src/fx relies on it):
 *  - Stamp is TILE_SIZE × H × TILE_SIZE. Land: stamp y = 0 is world y = groundHeight - 1 (the road
 *    surface layer replaces the top ground voxel, flush with neighbours); lamp posts etc. above.
 *  - Cross-section perpendicular to travel: voxel 0 and 7 = SIDEWALK on edges WITHOUT a road
 *    neighbour (connected edges continue the asphalt to the tile border), 1..6 = ASPHALT.
 *    Centre markings: dashed ROAD_LINE_YELLOW in voxels 3–4 along straight segments (period 4, so
 *    dashes run seamlessly across tiles) and as a dashed arc through curves.
 *    Intersections (≥3 connections): no centre line, ROAD_LINE_WHITE zebra crossings on the
 *    connected edges, sidewalk squares at the 4 corners, traffic lights on 4-way crossings.
 *    Curves (2 adjacent connections): quarter-circle asphalt (lane radii 2.5 / 5.5 around the inner
 *    corner), curved sidewalk and a grass verge with a small tree or flowers on the outer corner.
 *    Dead ends: sidewalk cap with bollards. Isolated tile (mask 0): turning circle with an island.
 *  - Street props on sidewalk voxels only (never on asphalt; lamp arms overhang 5 voxels up):
 *    street lamps on alternating tiles (checkerboard of tx+tz), plus hashed bins, hydrants,
 *    benches and bus stops on straight segments.
 *  - Bridge (water tile): deck voxel layer at world y = BRIDGE_DECK_HEIGHT - 1 with the same lane
 *    layout, RAILING on the unconnected edges, steel girders under the edges, a CONCRETE pillar
 *    (2×2) at the tile centre down to the bed. Everything else below the deck is STAMP_KEEP so the
 *    water stays. originY = groundHeight (bed height; first water layer) for bridges.
 *
 * Generated stamps depend only on (mask, bridge, roadVariant, bed height for bridges) and are cached
 * and shared: callers must treat the returned stamp as read-only.
 */
import { B, STAMP_KEEP, type BlockId } from '../voxel/blocks';
import { hash2, hash3, hashToUnit } from '../core/rng';
import { BRIDGE_DECK_HEIGHT, TILE_SIZE } from '../types';
import type { GeneratedStructure } from './buildingGen';
import { StampBuilder } from './stamp';
import { drawBench, drawBin, drawBollard, drawBusStop, drawFlowerBed, drawHydrant, drawStreetLamp, drawTree } from './props';

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

const S = TILE_SIZE; // 8
const N = 1;
const E = 2;
const SO = 4;
const W = 8;

/** Height of a land road stamp: surface + lamp (pole 5 + arm). */
const LAND_H = 7;

/**
 * Per-tile prop variant (0..15). Include it in StructureSync's visual key (e.g.
 * `R:${mask}:${bridge}:${roadVariant(tx, tz, seed)}`) so road stamps can be cached per key.
 *  bit 0: street lamp on this tile (checkerboard → "every other tile")
 *  bit 1: which side gets the lamp
 *  bits 2–3: extra sidewalk props (0 none, 1 bin + hydrant, 2 bench, 3 bus stop)
 */
export function roadVariant(tx: number, tz: number, seed: number): number {
  const lamp = ((tx + tz) & 1) === 0 ? 1 : 0;
  const h = hash2(tx, tz, seed ^ 0x51ed);
  const side = h & 1;
  const e = (h >>> 1) & 15;
  const extra = e < 2 ? 3 : e < 5 ? 2 : e < 9 ? 1 : 0;
  return lamp | (side << 1) | (extra << 2);
}

const cache = new Map<number, GeneratedStructure>();

export function generateRoad(spec: RoadSpec): GeneratedStructure {
  const mask = spec.mask & 15;
  const variant = roadVariant(spec.tx, spec.tz, spec.seed);
  const bed = spec.bridge ? Math.max(0, Math.min(spec.groundHeight, BRIDGE_DECK_HEIGHT - 2)) : 0;
  const key = mask | (variant << 4) | ((spec.bridge ? 1 : 0) << 8) | (bed << 9);
  let g = cache.get(key);
  if (!g) {
    g = build(mask, variant, spec.bridge, bed);
    cache.set(key, g);
  }
  if (spec.bridge) return g;
  // Land stamps are height-independent; only the origin differs.
  return { stamp: g.stamp, originY: spec.groundHeight - 1, emitters: g.emitters };
}

// --------------------------------------------------------------------------------------------
// Canonical shapes. Each is authored for one mask and rotated clockwise (N → E → S → W).
// --------------------------------------------------------------------------------------------

const SHAPE = { ISOLATED: 0, DEAD_END: N, STRAIGHT: N | SO, CURVE: N | E, TEE: N | E | SO, CROSS: 15 } as const;
const CANON: readonly number[] = [SHAPE.ISOLATED, SHAPE.DEAD_END, SHAPE.STRAIGHT, SHAPE.CURVE, SHAPE.TEE, SHAPE.CROSS];

function rotMask(m: number): number {
  return ((m << 1) | (m >> 3)) & 15;
}

/** Find canonical mask + number of clockwise quarter turns that produce `mask`. */
function canonical(mask: number): [number, number] {
  for (const c of CANON) {
    let m = c;
    for (let k = 0; k < 4; k++) {
      if (m === mask) return [c, k];
      m = rotMask(m);
    }
  }
  return [0, 0];
}

/** Clockwise quarter turn (seen from above): (x, z) → (S-1-z, x); N edge → E edge. */
function rotateCW(src: StampBuilder): StampBuilder {
  const out = new StampBuilder(src.sx, src.sy, src.sz);
  const n = src.sx;
  for (let y = 0; y < src.sy; y++)
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) out.set(n - 1 - z, y, x, src.get(x, y, z));
  return out;
}

function build(mask: number, variant: number, bridge: boolean, bed: number): GeneratedStructure {
  const [canon, turns] = canonical(mask);
  // Deck layer index inside the stamp (land: 0).
  const L = bridge ? BRIDGE_DECK_HEIGHT - 1 - bed : 0;
  let sb = new StampBuilder(S, L + LAND_H, S);
  surface(sb, canon, L, bridge, variant);
  props(sb, canon, variant, L, bridge);
  if (bridge) substructure(sb, canon, L);
  for (let k = 0; k < turns; k++) sb = rotateCW(sb);
  const stamp = trim(sb);
  return { stamp, originY: bridge ? bed : 0, emitters: [] };
}

function trim(sb: StampBuilder): { sx: number; sy: number; sz: number; data: Uint8Array } {
  let top = 0;
  const layer = sb.sx * sb.sz;
  for (let i = 0; i < sb.data.length; i++) if (sb.data[i] !== STAMP_KEEP) top = Math.floor(i / layer) + 1;
  return { sx: sb.sx, sy: top, sz: sb.sz, data: sb.data.slice(0, top * layer) };
}

// Surface classes, painted afterwards.
const ASP = 0;
const WALK = 1;
const VERGE = 2;
const YELLOW = 3;
const WHITE = 4;

function surface(sb: StampBuilder, canon: number, L: number, bridge: boolean, variant: number): void {
  const cls = new Uint8Array(S * S);
  const at = (x: number, z: number): number => x + S * z;
  for (let z = 0; z < S; z++)
    for (let x = 0; x < S; x++) {
      let c = ASP;
      // Unconnected edges → sidewalk; corners are always sidewalk squares.
      const edge =
        (z === 0 && !(canon & N)) || (z === S - 1 && !(canon & SO)) || (x === 0 && !(canon & W)) || (x === S - 1 && !(canon & E));
      const corner = (x === 0 || x === S - 1) && (z === 0 || z === S - 1);
      if (edge || corner) c = WALK;
      cls[at(x, z)] = c;
    }

  switch (canon) {
    case SHAPE.STRAIGHT:
      for (const z of [1, 5]) cls[at(3, z)] = cls[at(4, z)] = YELLOW;
      break;
    case SHAPE.DEAD_END:
      for (const z of [1]) cls[at(3, z)] = cls[at(4, z)] = YELLOW;
      break;
    case SHAPE.CURVE: {
      // Quarter circle around the inner (NE) corner point (8, 0).
      for (let z = 0; z < S; z++)
        for (let x = 0; x < S; x++) {
          const dx = 8 - (x + 0.5);
          const dz = z + 0.5;
          const d = Math.hypot(dx, dz);
          let c = ASP;
          if (d < 1.2) c = WALK;
          else if (d > 8.2) c = VERGE;
          else if (d > 7.0) c = WALK;
          else if (d >= 3.4 && d <= 4.6) {
            const a = Math.atan2(dz, dx) / (Math.PI / 2); // 0..1 along the arc
            if ((Math.floor(a * 6) & 1) === 0) c = YELLOW;
          }
          cls[at(x, z)] = c;
        }
      break;
    }
    case SHAPE.TEE:
    case SHAPE.CROSS:
      zebra(cls, canon);
      break;
    case SHAPE.ISOLATED:
      for (let z = 1; z < S - 1; z++)
        for (let x = 1; x < S - 1; x++) {
          const d = Math.hypot(x + 0.5 - 4, z + 0.5 - 4);
          if (d < 1.5) cls[at(x, z)] = VERGE;
          else if (d < 2.2) cls[at(x, z)] = WHITE;
        }
      break;
  }

  for (let z = 0; z < S; z++)
    for (let x = 0; x < S; x++) {
      const c = cls[at(x, z)];
      let id: BlockId;
      if (c === WALK) id = B.SIDEWALK;
      else if (c === VERGE) id = bridge ? B.CONCRETE : B.GRASS_LIGHT;
      else if (c === YELLOW) id = B.ROAD_LINE_YELLOW;
      else if (c === WHITE) id = B.ROAD_LINE_WHITE;
      else {
        // Asphalt with hashed wear patches.
        const u = hashToUnit(hash3(x, canon, z, 0x9e37 + variant));
        id = u < 0.04 ? B.ASPHALT_DARK : B.ASPHALT;
      }
      sb.set(x, L, z, id);
    }
}

/** Zebra crossings (2 deep, stripes at 1,3,4,6) on every connected edge. */
function zebra(cls: Uint8Array, canon: number): void {
  const stripe = (i: number): boolean => i === 1 || i === 3 || i === 4 || i === 6;
  for (let d = 0; d < 2; d++)
    for (let i = 1; i < S - 1; i++) {
      if (!stripe(i)) continue;
      if (canon & N) cls[i + S * d] = WHITE;
      if (canon & SO) cls[i + S * (S - 1 - d)] = WHITE;
      if (canon & W) cls[d + S * i] = WHITE;
      if (canon & E) cls[S - 1 - d + S * i] = WHITE;
    }
}

function props(sb: StampBuilder, canon: number, variant: number, L: number, bridge: boolean): void {
  const y = L + 1;
  const lamp = (variant & 1) !== 0;
  const side = (variant >> 1) & 1;
  const extra = (variant >> 2) & 3;

  if (bridge) railings(sb, canon, L);

  switch (canon) {
    case SHAPE.STRAIGHT: {
      // Lamp on one sidewalk, extras on the other.
      const lx = side ? S - 1 : 0;
      const ox = side ? 0 : S - 1;
      const inward = side ? -1 : 1;
      if (lamp) drawStreetLamp(sb, lx, y, 3, inward, 0);
      if (bridge) break;
      if (extra === 1) {
        drawBin(sb, ox, y, 1);
        drawHydrant(sb, ox, y, 6);
      } else if (extra === 2) {
        drawBench(sb, ox, y, 4, false, 2);
        drawBin(sb, ox, y, 2);
      } else if (extra === 3) {
        drawBusStop(sb, ox, y, 2, false);
      }
      break;
    }
    case SHAPE.DEAD_END:
      if (!bridge) for (const bx of [2, 5]) drawBollard(sb, bx, y, S - 1);
      if (lamp || !bridge) drawStreetLamp(sb, side ? S - 1 : 0, y, 4, side ? -1 : 1, 0);
      break;
    case SHAPE.CURVE:
      if (!bridge) {
        // Outer corner verge (SW): tree or flower bed.
        if (extra >= 2) drawTree(sb, 1, y, 6, side ? 'round' : 'blossom', 0, variant * 977);
        else drawFlowerBed(sb, 0, y, 6, 2, 8, variant * 131);
      }
      if (lamp) drawStreetLamp(sb, 2, y, 5, 1, -1);
      break;
    case SHAPE.TEE:
      // Sidewalk along the closed (W) side.
      if (lamp) drawStreetLamp(sb, 0, y, 4, 1, 0);
      if (!bridge && extra === 1) drawHydrant(sb, 0, y, 2);
      else if (!bridge && extra >= 2) drawBin(sb, 0, y, 2);
      break;
    case SHAPE.CROSS:
      // Traffic lights on two diagonal corners, a lamp on one of the others.
      trafficLight(sb, 0, y, 0, 1, 1, B.SIGN_GREEN);
      trafficLight(sb, S - 1, y, S - 1, -1, -1, B.BEACON_RED);
      if (lamp) {
        if (side) drawStreetLamp(sb, S - 1, y, 0, -1, 1);
        else drawStreetLamp(sb, 0, y, S - 1, 1, -1);
      }
      break;
    case SHAPE.ISOLATED:
      // Flower island in the turning circle (a tree would overhang the lanes).
      if (!bridge) drawFlowerBed(sb, 3, y, 3, 5, 5, variant * 313 + side);
      drawStreetLamp(sb, 0, y, 0, 1, 1);
      break;
  }
}

/** Pole with a dark housing and a glowing signal hanging over the corner diagonal. */
function trafficLight(sb: StampBuilder, x: number, y: number, z: number, dx: number, dz: number, light: BlockId): void {
  // Signal hangs at layer y+3 so cars (≤ 3 layers) pass underneath.
  for (let i = 0; i < 5; i++) sb.set(x, y + i, z, B.METAL_POLE);
  sb.set(x + dx, y + 4, z + dz, B.METAL_SHEET_DARK);
  sb.set(x + dx, y + 3, z + dz, light);
}

/** Bridge railings on the unconnected edges (lamps placed later override them). */
function railings(sb: StampBuilder, canon: number, L: number): void {
  const y = L + 1;
  for (let i = 0; i < S; i++) {
    if (!(canon & N)) sb.set(i, y, 0, B.RAILING);
    if (!(canon & SO)) sb.set(i, y, S - 1, B.RAILING);
    if (!(canon & W)) sb.set(0, y, i, B.RAILING);
    if (!(canon & E)) sb.set(S - 1, y, i, B.RAILING);
  }
}

/** Girders under unconnected edges, a cross beam and a 2×2 concrete pillar down to the bed. */
function substructure(sb: StampBuilder, canon: number, L: number): void {
  if (L < 1) return;
  const g = L - 1;
  for (let i = 0; i < S; i++) {
    if (!(canon & N)) sb.set(i, g, 0, B.BRIDGE_STEEL);
    if (!(canon & SO)) sb.set(i, g, S - 1, B.BRIDGE_STEEL);
    if (!(canon & W)) sb.set(0, g, i, B.BRIDGE_STEEL);
    if (!(canon & E)) sb.set(S - 1, g, i, B.BRIDGE_STEEL);
  }
  // Cross beams through the centre under the deck.
  for (let i = 1; i < S - 1; i++) {
    sb.set(i, g, 3, B.BRIDGE_STEEL);
    sb.set(i, g, 4, B.BRIDGE_STEEL);
    sb.set(3, g, i, B.BRIDGE_STEEL);
    sb.set(4, g, i, B.BRIDGE_STEEL);
  }
  for (let y = 0; y < g; y++)
    for (let z = 3; z <= 4; z++) for (let x = 3; x <= 4; x++) sb.set(x, y, z, y === g - 1 ? B.CONCRETE_DARK : B.CONCRETE);
}
