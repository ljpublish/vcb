/**
 * MODULE: buildings — residential building generators (module-internal API; may change).
 * Owner: buildings agent. See buildingGen.ts for the rules every generator follows.
 *
 * Every model is authored with its front facing +Z (z = S-1 is the sidewalk edge); the caller
 * rotates. Layer y = 0 repaints the lot surface (yard, paths, plaza); the structure starts at y = 1.
 * Floors are 3 voxels tall. All drawing goes through the small local helpers below (they only use
 * StampBuilder.set/get, so they clip to the footprint and never write outside it).
 *
 *  L1 (1×1) small houses: cottage (gable), two-storey (hip), gable-front bungalow with porch,
 *     L-shaped farmhouse. Yards with fence/hedge, path to the street, flower beds, trees, chimney smoke.
 *  L2 (1×1) townhouses / walk-ups: brick walk-up with balconies, Dutch gable townhouse,
 *     modern plaster walk-up with balcony bands and a roof garden or solar panels.
 *  L3 (1×1, 20–40 tall) towers: brick tower with setback crown + water tank, white balcony tower,
 *     colour-panel slab. (2×2, 28–56 tall): podium tower, twin towers, stepped terraced block.
 */
import { hash3, type Rng } from '../core/rng';
import { B, STAMP_KEEP, type BlockId } from '../voxel/blocks';
import { MAX_STRUCTURE_HEIGHT, TILE_SIZE } from '../types';
import type { BuildingSpec, LocalEmitter } from './buildingGen';
import { newLot } from './parts';
import type { StampBuilder } from './stamp';

const FLOOR_H = 3;
const MAX_H = MAX_STRUCTURE_HEIGHT + 1;

const PLASTERS: readonly BlockId[] = [
  B.PLASTER_WHITE,
  B.PLASTER_CREAM,
  B.PLASTER_YELLOW,
  B.PLASTER_PEACH,
  B.PLASTER_BLUE,
  B.PLASTER_MINT,
  B.PLASTER_PINK,
];
const BRICKS: readonly BlockId[] = [B.BRICK_RED, B.BRICK_BROWN, B.BRICK_TAN];
const HOUSE_WALLS: readonly BlockId[] = [...PLASTERS, ...BRICKS, B.WOOD_SIDING, B.WOOD_SIDING];
const ROOFS: readonly BlockId[] = [B.ROOF_RED, B.ROOF_BROWN, B.ROOF_GRAY, B.ROOF_BLUE, B.ROOF_GREEN];
const LEAVES: readonly BlockId[] = [B.LEAVES, B.LEAVES_DARK, B.LEAVES_LIGHT, B.LEAVES_AUTUMN, B.LEAVES_PINK];
const FLOWERS: readonly BlockId[] = [B.FLOWER_RED, B.FLOWER_YELLOW, B.FLOWER_WHITE, B.FLOWER_PURPLE];

/** Builds an Active residential building authored with its front facing +Z (caller rotates). */
export function generateResidential(spec: BuildingSpec, rng: Rng, emitters: LocalEmitter[]): StampBuilder {
  const S = spec.size * TILE_SIZE;
  const ctx: Ctx = { b: newLot(spec), rng, emitters, S, seed: rng.nextU32() };
  if (spec.level === 1) {
    HOUSES[rng.int(0, HOUSES.length)](ctx);
  } else if (spec.level === 2) {
    WALKUPS[rng.int(0, WALKUPS.length)](ctx);
  } else if (spec.size === 2) {
    TOWERS_2X2[rng.int(0, TOWERS_2X2.length)](ctx);
  } else {
    TOWERS_1X1[rng.int(0, TOWERS_1X1.length)](ctx);
  }
  return ctx.b;
}

interface Ctx {
  b: StampBuilder;
  rng: Rng;
  emitters: LocalEmitter[];
  S: number;
  /** Per-building salt for hashed per-window decisions. */
  seed: number;
}

// ───────────────────────────── drawing helpers ─────────────────────────────

/** Half-open box fill, clipped to the stamp. */
function box(b: StampBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: BlockId): void {
  for (let y = Math.max(0, y0); y < Math.min(b.sy, y1); y++)
    for (let z = Math.max(0, z0); z < Math.min(b.sz, z1); z++)
      for (let x = Math.max(0, x0); x < Math.min(b.sx, x1); x++) b.set(x, y, z, id);
}

/** Only writes where the stamp is still KEEP or AIR. */
function setIfFree(b: StampBuilder, x: number, y: number, z: number, id: BlockId): void {
  const cur = b.get(x, y, z);
  if (cur === STAMP_KEEP || cur === B.AIR) b.set(x, y, z, id);
}

/** Perimeter ring of the rectangle [x0,x1)×[z0,z1) at layer y. */
function ring(b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, id: BlockId): void {
  for (let x = x0; x < x1; x++) {
    b.set(x, y, z0, id);
    b.set(x, y, z1 - 1, id);
  }
  for (let z = z0; z < z1; z++) {
    b.set(x0, y, z, id);
    b.set(x1 - 1, y, z, id);
  }
}

function lit(ctx: Ctx, x: number, y: number, z: number, p: number): BlockId {
  return (hash3(x, y, z, ctx.seed) >>> 8) / 16777216 < p ? B.WINDOW_LIT : B.WINDOW;
}

/**
 * Windows on the four faces of the body [x0,x1)×[z0,z1), layers [y0, y0+h). A window column is
 * placed where (u + phase) % every === 0 along each face, never on corners. One lit decision per
 * window (all its voxels share it).
 */
function windows(
  ctx: Ctx,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y0: number,
  h: number,
  every: number,
  phase: number,
  litP: number,
  faces = 0b1111,
): void {
  const b = ctx.b;
  const put = (x: number, z: number, nx: number, nz: number): void => {
    const id = lit(ctx, x * 2 + nx, y0, z * 2 + nz, litP);
    for (let y = y0; y < y0 + h; y++) b.set(x, y, z, id);
  };
  // front (+Z), back (-Z)
  for (let x = x0 + 1; x < x1 - 1; x++) {
    if ((x - x0 + phase) % every !== 0) continue;
    if (faces & 1) put(x, z1 - 1, 0, 1);
    if (faces & 2) put(x, z0, 0, 0);
  }
  // sides (-X, +X)
  for (let z = z0 + 1; z < z1 - 1; z++) {
    if ((z - z0 + phase) % every !== 0) continue;
    if (faces & 4) put(x0, z, 0, 0);
    if (faces & 8) put(x1 - 1, z, 1, 0);
  }
}

/** Stepped gable roof, ridge along X. Eave strips overhang by `oh`; gable triangles in `wall`. */
function gableX(b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, roof: BlockId, wall: BlockId, oh = 1): number {
  let za = z0 - oh;
  let zb = z1 + oh; // exclusive
  let k = 0;
  while (zb - za > 0) {
    for (let x = x0 - oh; x < x1 + oh; x++) {
      b.set(x, y + k, za, roof);
      b.set(x, y + k, zb - 1, roof);
    }
    for (let z = za + 1; z < zb - 1; z++) {
      for (let x = x0; x < x1; x++) b.set(x, y + k, z, z === za + 1 || z === zb - 2 ? roof : wall);
    }
    za++;
    zb--;
    k++;
  }
  return y + k;
}

/** Stepped gable roof, ridge along Z (gable end faces the street). */
function gableZ(b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, roof: BlockId, wall: BlockId, oh = 1): number {
  let xa = x0 - oh;
  let xb = x1 + oh;
  let k = 0;
  while (xb - xa > 0) {
    for (let z = z0 - oh; z < z1 + oh; z++) {
      b.set(xa, y + k, z, roof);
      b.set(xb - 1, y + k, z, roof);
    }
    for (let x = xa + 1; x < xb - 1; x++) {
      for (let z = z0; z < z1; z++) b.set(x, y + k, z, x === xa + 1 || x === xb - 2 ? roof : wall);
    }
    xa++;
    xb--;
    k++;
  }
  return y + k;
}

/** Stepped hip roof (shrinks on all four sides). Returns the layer above the top. */
function hip(b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, roof: BlockId, oh = 1): number {
  let xa = x0 - oh;
  let xb = x1 + oh;
  let za = z0 - oh;
  let zb = z1 + oh;
  let k = 0;
  while (xb - xa > 0 && zb - za > 0) {
    box(b, xa, y + k, za, xb, y + k + 1, zb, roof);
    xa++;
    xb--;
    za++;
    zb--;
    k++;
  }
  return y + k;
}

/** Chimney column from y0 up to (and including) yTop, with a smoke emitter on top. */
function chimney(ctx: Ctx, x: number, z: number, y0: number, yTop: number): void {
  for (let y = y0; y <= yTop; y++) ctx.b.set(x, y, z, B.CHIMNEY);
  ctx.emitters.push({ x: x + 0.5, y: yTop + 1, z: z + 0.5, kind: 'smoke', strength: 0.25 });
}

/** Small deciduous tree: trunk then a rounded crown. Only fills free voxels. */
function tree(ctx: Ctx, x: number, z: number, y0: number, trunk: number, leaves: BlockId): void {
  const b = ctx.b;
  for (let y = y0; y < y0 + trunk; y++) b.set(x, y, z, B.WOOD);
  const cy = y0 + trunk;
  for (let dy = 0; dy < 3; dy++) {
    const r = dy === 2 ? 0 : 1;
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (dy === 0 && Math.abs(dx) + Math.abs(dz) === 2 && (hash3(x + dx, cy, z + dz, ctx.seed) & 1)) continue;
        setIfFree(b, x + dx, cy + dy, z + dz, leaves);
      }
  }
  setIfFree(b, x, cy + 2, z, leaves);
}

/** Tall slim conifer. */
function pine(ctx: Ctx, x: number, z: number, y0: number, h: number): void {
  const b = ctx.b;
  b.set(x, y0, z, B.WOOD);
  for (let y = y0 + 1; y < y0 + h; y++) {
    const r = y < y0 + h - 2 && (y - y0) % 2 === 1 ? 1 : 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (Math.abs(dx) + Math.abs(dz) <= 1) setIfFree(b, x + dx, y, z + dz, B.PINE);
  }
}

/** Lawn with a little colour noise on layer 0. */
function lawn(ctx: Ctx, x0: number, z0: number, x1: number, z1: number): void {
  for (let z = z0; z < z1; z++)
    for (let x = x0; x < x1; x++) {
      const h = hash3(x, 0, z, ctx.seed ^ 0x5a5a) & 7;
      ctx.b.set(x, 0, z, h === 0 ? B.GRASS_DARK : h < 4 ? B.GRASS_LIGHT : B.GRASS);
    }
}

function rooftop(ctx: Ctx, x0: number, z0: number, x1: number, z1: number, y: number, parapet: BlockId): void {
  const b = ctx.b;
  box(b, x0, y, z0, x1, y + 1, z1, B.ROOF_FLAT);
  ring(b, x0, z0, x1, z1, y + 1, parapet);
}

/** Front door (2 tall) set into the wall at z, plus optional step/canopy. */
function door(b: StampBuilder, x: number, y: number, z: number, id: BlockId = B.DOOR, w = 1): void {
  for (let i = 0; i < w; i++) {
    b.set(x + i, y, z, id);
    b.set(x + i, y + 1, z, id);
  }
}

/** Path on layer 0 from (x, zFrom) to the front edge. */
function path(ctx: Ctx, x: number, zFrom: number, w = 1, id: BlockId = B.PARK_PATH): void {
  for (let z = zFrom; z < ctx.S; z++) for (let i = 0; i < w; i++) ctx.b.set(x + i, 0, z, id);
}

/** Fence/hedge around the lot perimeter on layer 1, skipping occupied voxels and the path gap. */
function yardBorder(ctx: Ctx, id: BlockId, gapX0: number, gapX1: number, front = true): void {
  const { b, S } = ctx;
  for (let i = 0; i < S; i++) {
    setIfFree(b, 0, 1, i, id);
    setIfFree(b, S - 1, 1, i, id);
    setIfFree(b, i, 1, 0, id);
    if (front && (i < gapX0 || i >= gapX1)) setIfFree(b, i, 1, S - 1, id);
  }
}

function flowerBed(ctx: Ctx, x0: number, z0: number, x1: number, z1: number): void {
  for (let z = z0; z < z1; z++)
    for (let x = x0; x < x1; x++) {
      const h = hash3(x, 1, z, ctx.seed ^ 0x77);
      ctx.b.set(x, 0, z, B.DIRT);
      setIfFree(ctx.b, x, 1, z, (h & 3) === 0 ? B.BUSH : FLOWERS[(h >>> 2) % FLOWERS.length]);
    }
}

/**
 * Multi-storey box body: solid core, a `trim` slab line at the base of every floor (from floor 1
 * up), and windows `winH` tall per floor. Returns the first layer above the body.
 */
function storeys(
  ctx: Ctx,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y0: number,
  floors: number,
  wall: BlockId,
  trim: BlockId,
  every: number,
  winH: number,
  litP: number,
  phase = 0,
): number {
  const b = ctx.b;
  const top = y0 + floors * FLOOR_H;
  box(b, x0, y0, z0, x1, top, z1, wall);
  for (let f = 0; f < floors; f++) {
    const yb = y0 + f * FLOOR_H;
    if (f > 0 && trim !== wall) ring(b, x0, z0, x1, z1, yb, trim);
    windows(ctx, x0, z0, x1, z1, yb + 1, winH, every, phase, litP);
  }
  return top;
}

/** Protruding balcony slab + railing on the front (+Z) face at layer y over x∈[xa,xb). */
function balconyFront(b: StampBuilder, xa: number, xb: number, z: number, y: number): void {
  // discrete 2-wide balconies with 1-voxel gaps so the windows between them stay visible
  for (let x = xa; x < xb; x++) {
    if ((x - xa) % 3 === 2) continue;
    b.set(x, y, z, B.BALCONY);
    b.set(x, y + 1, z, B.RAILING);
  }
}

/** Balcony ring around a whole body at layer y (one voxel outside the body). */
function balconyRing(b: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, railing: boolean): void {
  ring(b, x0 - 1, z0 - 1, x1 + 1, z1 + 1, y, B.BALCONY);
  if (railing) ring(b, x0 - 1, z0 - 1, x1 + 1, z1 + 1, y + 1, B.RAILING);
}

/** Rooftop water tank on legs (classic NYC style). */
function waterTank(b: StampBuilder, x: number, z: number, y: number): number {
  b.set(x, y, z, B.WOOD_DARK);
  b.set(x + 1, y, z + 1, B.WOOD_DARK);
  b.set(x + 1, y, z, B.WOOD_DARK);
  b.set(x, y, z + 1, B.WOOD_DARK);
  box(b, x, y + 1, z, x + 2, y + 3, z + 2, B.WOOD_PLANK);
  box(b, x, y + 3, z, x + 2, y + 4, z + 2, B.ROOF_BROWN);
  return y + 4;
}

/** Antenna mast; a red beacon on top when the building is tall. */
function antenna(b: StampBuilder, x: number, z: number, y: number, h: number, beacon: boolean): void {
  const hh = Math.min(h, MAX_H - 1 - y - (beacon ? 1 : 0));
  for (let i = 0; i < hh; i++) b.set(x, y + i, z, B.ANTENNA);
  if (beacon) b.set(x, y + hh, z, B.BEACON_RED);
}

/** AC units scattered on a flat roof at layer y, avoiding the parapet. */
function acUnits(ctx: Ctx, x0: number, z0: number, x1: number, z1: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const x = ctx.rng.int(x0 + 1, Math.max(x0 + 2, x1 - 1));
    const z = ctx.rng.int(z0 + 1, Math.max(z0 + 2, z1 - 1));
    setIfFree(ctx.b, x, y, z, B.AC_UNIT);
  }
}

/** Ground floor lobby on the front face: glass doors flanked by lit glass. */
function lobby(ctx: Ctx, x0: number, x1: number, zFront: number, y: number, canopy: BlockId): void {
  const b = ctx.b;
  const mid = (x0 + x1) >> 1;
  for (let x = x0 + 1; x < x1 - 1; x++) {
    b.set(x, y, zFront, B.GLASS_LIT);
    b.set(x, y + 1, zFront, B.GLASS_LIT);
  }
  door(b, mid - 1, y, zFront, B.DOOR_GLASS, 2);
  for (let x = mid - 2; x < mid + 2; x++) b.set(x, y + 2, zFront + 1, canopy);
}

// ───────────────────────────── L1: houses ─────────────────────────────

type Gen = (ctx: Ctx) => void;

/** Single-storey cottage, gable ridge along X, chimney, picket fence, tree in the back corner. */
const cottage: Gen = (ctx) => {
  const { b, rng } = ctx;
  const wall = rng.pick(HOUSE_WALLS);
  const roof = rng.pick(ROOFS);
  const x0 = 1;
  const x1 = rng.chance(0.5) ? 7 : 6;
  const z0 = 1;
  const z1 = 5;
  lawn(ctx, 0, 0, ctx.S, ctx.S);
  box(b, x0, 1, z0, x1, 4, z1, wall);
  windows(ctx, x0, z0, x1, z1, 2, 1, 2, 1, 0.5);
  const dx = rng.chance(0.5) ? x0 + 1 : x1 - 2;
  door(b, dx, 1, z1 - 1);
  const top = gableX(b, x0, z0, x1, z1, 4, roof, wall);
  chimney(ctx, rng.chance(0.5) ? x0 + 1 : x1 - 2, z0 + 1, 4, top);
  path(ctx, dx, z1, 1);
  flowerBed(ctx, dx === x0 + 1 ? dx + 2 : x0, z1 + 1, dx === x0 + 1 ? x1 : dx - 1, z1 + 2);
  yardBorder(ctx, rng.chance(0.7) ? B.FENCE_WHITE : B.HEDGE, dx, dx + 1);
  if (x1 === 6) tree(ctx, 6, 2, 1, 2, rng.pick(LEAVES));
};

/** Two-storey house with a hip roof, side yard with tree, hedge. */
const twoStorey: Gen = (ctx) => {
  const { b, rng } = ctx;
  const wall = rng.pick(HOUSE_WALLS);
  const roof = rng.pick(ROOFS);
  const left = rng.chance(0.5);
  const x0 = left ? 1 : 3;
  const x1 = left ? 5 : 7;
  const z0 = 1;
  const z1 = 6;
  lawn(ctx, 0, 0, ctx.S, ctx.S);
  box(b, x0, 1, z0, x1, 7, z1, wall);
  // belt course between floors
  if (BRICKS.includes(wall)) ring(b, x0, z0, x1, z1, 4, B.PLASTER_WHITE);
  windows(ctx, x0, z0, x1, z1, 2, 1, 2, 0, 0.5);
  windows(ctx, x0, z0, x1, z1, 5, 1, 2, 0, 0.5);
  const dx = x0 + 1;
  door(b, dx, 1, z1 - 1);
  b.set(dx, 3, z1, roof); // little door canopy
  const top = hip(b, x0, z0, x1, z1, 7, roof);
  chimney(ctx, left ? x0 : x1 - 1, z0 + 1, 7, top);
  path(ctx, dx, z1, 1);
  const tx = left ? 6 : 1;
  tree(ctx, tx, 3, 1, 3, rng.pick(LEAVES));
  flowerBed(ctx, left ? 5 : 1, 6, left ? 7 : 3, 7);
  yardBorder(ctx, B.HEDGE, dx, dx + 1);
};

/** Gable-front bungalow with a covered porch on posts. */
const bungalow: Gen = (ctx) => {
  const { b, rng } = ctx;
  const wall = rng.pick([...PLASTERS, B.WOOD_SIDING, B.WOOD_SIDING, B.WOOD_SIDING]);
  const roof = rng.pick(ROOFS);
  const x0 = 1;
  const x1 = 7;
  const z0 = 1;
  const z1 = 5;
  lawn(ctx, 0, 0, ctx.S, ctx.S);
  box(b, x0, 1, z0, x1, 4, z1, wall);
  windows(ctx, x0, z0, x1, z1, 2, 1, 2, 1, 0.5);
  door(b, 3, 1, z1 - 1);
  // porch: deck, posts, flat roof extension
  box(b, x0, 0, z1, x1, 1, z1 + 1, B.WOOD_PLANK);
  b.set(x0, 1, z1, B.WOOD);
  b.set(x0, 2, z1, B.WOOD);
  b.set(x1 - 1, 1, z1, B.WOOD);
  b.set(x1 - 1, 2, z1, B.WOOD);
  b.set(x0 + 1, 1, z1, B.FENCE_WHITE);
  b.set(x1 - 2, 1, z1, B.FENCE_WHITE);
  box(b, x0 - 1, 3, z1, x1 + 1, 4, z1 + 1, roof);
  const top = gableZ(b, x0, z0, x1, z1, 4, roof, wall);
  // attic window in the street-facing gable
  b.set(3, 5, z1 - 1, lit(ctx, 3, 5, z1, 0.4));
  b.set(4, 5, z1 - 1, b.get(3, 5, z1 - 1));
  chimney(ctx, x1 - 2, z0, 4, top - 1);
  path(ctx, 3, z1 + 1, 2);
  flowerBed(ctx, 1, 7, 3, 8);
  flowerBed(ctx, 5, 7, 7, 8);
  for (let x = 0; x < ctx.S; x++) {
    if (x === 0 || x === 7) setIfFree(b, x, 1, 7, B.HEDGE);
  }
  for (let z = 0; z < 7; z++) {
    setIfFree(b, 0, 1, z, B.HEDGE);
    setIfFree(b, 7, 1, z, B.HEDGE);
  }
};

/** L-shaped house: main gable along X at the back plus a gable-front wing. */
const lShape: Gen = (ctx) => {
  const { b, rng } = ctx;
  const wall = rng.pick(HOUSE_WALLS);
  const roof = rng.pick(ROOFS);
  const flip = rng.chance(0.5);
  lawn(ctx, 0, 0, ctx.S, ctx.S);
  // main body
  box(b, 1, 1, 1, 7, 4, 4, wall);
  windows(ctx, 1, 1, 7, 4, 2, 1, 2, 1, 0.5);
  // wing
  const wx0 = flip ? 4 : 1;
  const wx1 = wx0 + 3;
  box(b, wx0, 1, 4, wx1, 4, 6, wall);
  b.set(wx0 + 1, 2, 5, lit(ctx, wx0 + 1, 2, 6, 0.5));
  const dx = flip ? 2 : 5;
  door(b, dx, 1, 3);
  const top = gableX(b, 1, 1, 7, 4, 4, roof, wall);
  gableZ(b, wx0, 4, wx1, 6, 4, roof, wall, 0);
  chimney(ctx, flip ? 1 : 6, 2, 4, top);
  path(ctx, dx, 4, 1);
  flowerBed(ctx, flip ? 1 : 6, 6, flip ? 2 : 7, 7);
  yardBorder(ctx, B.FENCE_WHITE, dx, dx + 1);
  if (rng.chance(0.6)) pine(ctx, flip ? 1 : 6, 5, 1, 5);
};

const HOUSES: readonly Gen[] = [cottage, twoStorey, bungalow, lShape];

// ───────────────────────────── L2: walk-ups ─────────────────────────────

/** 3–5 storey brick walk-up: stone base, stoop, front balconies, cornice, flat roof with AC. */
const brickWalkup: Gen = (ctx) => {
  const { b, rng, S } = ctx;
  const wall = rng.pick(BRICKS);
  const floors = rng.int(3, 6);
  const x0 = rng.chance(0.5) ? 0 : 1;
  const x1 = S - x0;
  const z0 = 1;
  const z1 = 6;
  box(b, 0, 0, 0, S, 1, S, B.SIDEWALK);
  const top = storeys(ctx, x0, z0, x1, z1, 1, floors, wall, B.CONCRETE, 2, 2, 0.5, 1);
  ring(b, x0, z0, x1, z1, 1, B.CONCRETE_DARK); // stone plinth
  door(b, 3, 1, z1 - 1, B.DOOR, 2);
  b.set(3, 1, z1, B.CONCRETE);
  b.set(4, 1, z1, B.CONCRETE);
  for (let f = 1; f < floors; f++) {
    if (rng.chance(0.75)) balconyFront(b, x0 + 1, x1 - 1, z1, 1 + f * FLOOR_H);
  }
  // cornice
  for (let x = x0; x < x1; x++) b.set(x, top, z1, B.CONCRETE);
  rooftop(ctx, x0, z0, x1, z1, top, wall);
  acUnits(ctx, x0, z0, x1, z1, top + 1, 2);
  if (rng.chance(0.5)) waterTank(b, x0 + 1, z0 + 1, top + 1);
  // planters
  b.set(0, 1, 7, B.HEDGE);
  b.set(S - 1, 1, 7, B.HEDGE);
};

/** Narrow Dutch-gable townhouse, 3–4 storeys, gable front with a stepped outline. */
const dutchTownhouse: Gen = (ctx) => {
  const { b, rng, S } = ctx;
  const wall = rng.pick([...BRICKS, B.PLASTER_CREAM, B.PLASTER_WHITE, B.PLASTER_PEACH]);
  const roof = rng.pick([B.ROOF_GRAY, B.ROOF_RED, B.ROOF_BROWN]);
  const floors = rng.int(3, 5);
  const x0 = 1;
  const x1 = 7;
  const z0 = 0;
  const z1 = 6;
  box(b, 0, 0, 0, S, 1, S, B.SIDEWALK);
  const top = storeys(ctx, x0, z0, x1, z1, 1, floors, wall, wall, 2, 2, 0.5, 1);
  door(b, 2, 1, z1 - 1);
  b.set(2, 1, z1, B.CONCRETE_DARK);
  // stepped gable (front & back) with a white trim edge, roof between
  let xa = x0;
  let xb = x1;
  let y = top;
  while (xb - xa > 0) {
    for (let x = xa; x < xb; x++) {
      for (let z = z0 + 1; z < z1 - 1; z++) b.set(x, y, z, roof);
      b.set(x, y, z0, wall);
      b.set(x, y, z1 - 1, wall);
    }
    b.set(xa, y, z1 - 1, B.PLASTER_WHITE);
    b.set(xb - 1, y, z1 - 1, B.PLASTER_WHITE);
    y++;
    if ((y - top) % 2 === 0) {
      xa++;
      xb--;
    }
  }
  // hoist window in the gable
  b.set(3, top + 1, z1 - 1, lit(ctx, 3, top + 1, z1, 0.5));
  b.set(4, top + 1, z1 - 1, b.get(3, top + 1, z1 - 1));
  if (rng.chance(0.7)) balconyFront(b, 3, 6, z1, 1 + FLOOR_H);
  flowerBed(ctx, 4, 6, 7, 7);
  b.set(0, 1, 6, B.FENCE_WHITE);
  b.set(0, 1, 7, B.FENCE_WHITE);
};

/** Modern plaster walk-up: balcony bands, top floor set back with a roof garden or solar panels. */
const modernWalkup: Gen = (ctx) => {
  const { b, rng, S } = ctx;
  const wall = rng.pick(PLASTERS);
  const floors = rng.int(3, 5);
  const x0 = 1;
  const x1 = 7;
  const z0 = 1;
  const z1 = 6;
  box(b, 0, 0, 0, S, 1, S, B.CONCRETE);
  lawn(ctx, 0, 0, S, 1);
  const top = storeys(ctx, x0, z0, x1, z1, 1, floors, wall, B.PLASTER_WHITE, 1, 2, 0.45, 0);
  // solid wall columns between window pairs for rhythm
  for (let y = 1; y < top; y++) {
    b.set(x0 + 3, y, z1 - 1, wall);
    b.set(x0, y, z1 - 1, wall);
    b.set(x1 - 1, y, z1 - 1, wall);
  }
  lobby(ctx, x0, x1, z1 - 1, 1, B.PLASTER_WHITE);
  for (let f = 1; f < floors; f++) balconyFront(b, x0, x1, z1, 1 + f * FLOOR_H);
  rooftop(ctx, x0, z0, x1, z1, top, B.PLASTER_WHITE);
  if (rng.chance(0.5)) {
    box(b, x0 + 1, top, z0 + 1, x1 - 1, top + 1, z1 - 1, B.GRASS);
    tree(ctx, x0 + 2, z0 + 2, top + 1, 1, B.LEAVES_LIGHT);
    setIfFree(b, x1 - 2, top + 1, z1 - 2, B.BUSH);
  } else {
    for (let z = z0 + 1; z < z1 - 1; z += 2) box(b, x0 + 1, top + 1, z, x1 - 1, top + 2, z + 1, B.SOLAR_PANEL);
  }
  flowerBed(ctx, 0, 6, 2, 7);
  flowerBed(ctx, 6, 6, 8, 7);
};

const WALKUPS: readonly Gen[] = [brickWalkup, dutchTownhouse, modernWalkup];

// ───────────────────────────── L3: towers ─────────────────────────────

function towerFloors(rng: Rng, minH: number, maxH: number): number {
  return Math.floor(rng.int(minH, maxH + 1) / FLOOR_H);
}

/** Plaza ground with grass beds in the corners. */
function plaza(ctx: Ctx, bed: number): void {
  const { b, S } = ctx;
  box(b, 0, 0, 0, S, 1, S, B.CONCRETE);
  lawn(ctx, 0, 0, bed, bed);
  lawn(ctx, S - bed, 0, S, bed);
  for (let x = 0; x < S; x += 2) b.set(x, 0, S - 1, B.SIDEWALK);
}

/** Pre-war brick tower: stone base, setback crown, water tank, antenna. */
const brickTower: Gen = (ctx) => {
  const { b, rng, S } = ctx;
  const wall = rng.pick(BRICKS);
  const floors = towerFloors(rng, 20, 34);
  plaza(ctx, 1);
  let top = storeys(ctx, 1, 1, 7, 7, 1, floors, wall, wall, 2, 2, 0.5, 1);
  ring(b, 1, 1, 7, 7, 1, B.CONCRETE);
  ring(b, 1, 1, 7, 7, 2, B.CONCRETE);
  ring(b, 1, 1, 7, 7, 3, B.CONCRETE);
  lobby(ctx, 1, 7, 6, 1, B.ROOF_GRAY);
  // cornice every ~4 floors
  for (let f = 4; f < floors; f += 4) ring(b, 0, 0, 8, 8, 1 + f * FLOOR_H, B.CONCRETE);
  // setback crown
  top = storeys(ctx, 2, 2, 6, 6, top, 2, wall, B.CONCRETE, 2, 2, 0.5, 1);
  rooftop(ctx, 1, 1, 7, 7, top - 2 * FLOOR_H, B.CONCRETE);
  rooftop(ctx, 2, 2, 6, 6, top, B.CONCRETE);
  const ty = waterTank(b, 2, 2, top + 1);
  antenna(b, 5, 5, top + 1, 4, top > 30);
  void ty;
  void S;
};

/** White modern tower: balcony ring every floor, glass bands, rooftop terrace pergola. */
const balconyTower: Gen = (ctx) => {
  const { b, rng } = ctx;
  const wall = rng.pick([B.PLASTER_WHITE, B.PLASTER_CREAM, B.CONCRETE]);
  const floors = towerFloors(rng, 22, 38);
  plaza(ctx, 0);
  const top = storeys(ctx, 1, 1, 7, 7, 1, floors, wall, wall, 1, 2, 0.5, 0);
  // solid corners
  for (let y = 1; y < top; y++) {
    b.set(1, y, 1, wall);
    b.set(6, y, 1, wall);
    b.set(1, y, 6, wall);
    b.set(6, y, 6, wall);
  }
  for (let f = 1; f < floors; f++) {
    const y = 1 + f * FLOOR_H;
    if (f % 2 === 0) balconyRing(b, 1, 1, 7, 7, y, true);
    else ring(b, 1, 1, 7, 7, y, B.BALCONY);
  }
  lobby(ctx, 1, 7, 6, 1, B.BALCONY);
  rooftop(ctx, 1, 1, 7, 7, top, wall);
  acUnits(ctx, 1, 1, 7, 7, top + 1, 2);
  antenna(b, 2, 2, top + 1, 5, top > 28);
};

/** Colour-panel slab: plaster panels in two alternating colours per floor, staircase core on top. */
const panelSlab: Gen = (ctx) => {
  const { b, rng } = ctx;
  const ca = rng.pick(PLASTERS);
  let cb = rng.pick(PLASTERS);
  if (cb === ca) cb = B.PLASTER_WHITE;
  const floors = towerFloors(rng, 18, 30);
  plaza(ctx, 1);
  const top = storeys(ctx, 0, 2, 8, 6, 1, floors, ca, B.CONCRETE, 2, 1, 0.55, 1);
  // alternate panel colour per floor on the long faces
  for (let f = 0; f < floors; f++) {
    if (f % 2 === 0) continue;
    const y = 1 + f * FLOOR_H + 2;
    for (let x = 0; x < 8; x++) {
      b.set(x, y, 2, cb);
      b.set(x, y, 5, cb);
    }
  }
  // front loggias every other column
  for (let f = 1; f < floors; f++) for (let x = 1; x < 7; x += 3) balconyFront(b, x, x + 2, 6, 1 + f * FLOOR_H);
  lobby(ctx, 2, 6, 5, 1, B.CONCRETE_DARK);
  rooftop(ctx, 0, 2, 8, 6, top, B.CONCRETE);
  box(b, 3, top + 1, 3, 5, top + 4, 5, B.CONCRETE);
  antenna(b, 4, 4, top + 4, 3, top > 30);
};

const TOWERS_1X1: readonly Gen[] = [brickTower, balconyTower, panelSlab];

/** 2×2: tall tower on a 2-storey podium with landscaped corners. */
const podiumTower: Gen = (ctx) => {
  const { b, rng, S } = ctx;
  const wall = rng.pick([B.PLASTER_WHITE, B.CONCRETE, ...BRICKS]);
  const floors = towerFloors(rng, 30, 52);
  lawn(ctx, 0, 0, S, S);
  box(b, 0, 0, 12, S, 1, S, B.CONCRETE);
  path(ctx, 6, 12, 4, B.SIDEWALK);
  // podium
  const pTop = storeys(ctx, 1, 1, 15, 12, 1, 2, B.CONCRETE, B.CONCRETE_DARK, 1, 2, 0.6);
  lobby(ctx, 4, 12, 11, 1, B.CONCRETE_DARK);
  rooftop(ctx, 1, 1, 15, 12, pTop, B.CONCRETE);
  box(b, 2, pTop, 2, 4, pTop + 1, 11, B.GRASS);
  tree(ctx, 2, 9, pTop + 1, 2, B.LEAVES);
  // tower
  const top = storeys(ctx, 4, 2, 12, 10, pTop, floors - 2, wall, B.BALCONY, 1, 2, 0.5, 0);
  for (let f = 1; f < floors - 2; f += 2) balconyFront(b, 5, 11, 10, pTop + f * FLOOR_H);
  for (let y = pTop; y < top; y++) {
    b.set(4, y, 9, wall);
    b.set(11, y, 9, wall);
    b.set(4, y, 2, wall);
    b.set(11, y, 2, wall);
  }
  rooftop(ctx, 4, 2, 12, 10, top, wall);
  box(b, 6, top + 1, 4, 10, top + 3, 8, B.CONCRETE);
  acUnits(ctx, 4, 2, 12, 10, top + 1, 3);
  antenna(b, 8, 6, top + 3, 6, true);
  tree(ctx, 1, 14, 1, 3, rng.pick(LEAVES));
  tree(ctx, 14, 14, 1, 3, rng.pick(LEAVES));
};

/** 2×2: twin towers of different heights linked by a shared podium and sky bridge. */
const twinTowers: Gen = (ctx) => {
  const { b, rng, S } = ctx;
  const wall = rng.pick([B.PLASTER_CREAM, B.PLASTER_WHITE, B.BRICK_TAN, B.PLASTER_BLUE]);
  const fa = towerFloors(rng, 34, 54);
  const fb = Math.max(9, fa - rng.int(3, 7));
  box(b, 0, 0, 0, S, 1, S, B.CONCRETE);
  lawn(ctx, 0, 0, S, 3);
  const pTop = storeys(ctx, 0, 3, S, 13, 1, 1, B.CONCRETE_DARK, B.CONCRETE_DARK, 1, 2, 0.6);
  lobby(ctx, 5, 11, 12, 1, B.CONCRETE);
  rooftop(ctx, 0, 3, S, 13, pTop, B.CONCRETE);
  const ta = storeys(ctx, 1, 4, 7, 11, pTop, fa - 1, wall, B.BALCONY, 2, 2, 0.5, 1);
  const tb = storeys(ctx, 9, 4, 15, 11, pTop, fb - 1, wall, B.BALCONY, 2, 2, 0.5, 1);
  for (let f = 2; f < fa - 1; f += 3) balconyFront(b, 2, 6, 11, pTop + f * FLOOR_H);
  for (let f = 2; f < fb - 1; f += 3) balconyFront(b, 10, 14, 11, pTop + f * FLOOR_H);
  // sky bridge two thirds up the shorter tower
  const yb = pTop + Math.floor((fb - 1) * 0.66) * FLOOR_H;
  box(b, 7, yb, 6, 9, yb + 3, 9, B.GLASS_LIT);
  box(b, 7, yb, 6, 9, yb + 1, 9, wall);
  rooftop(ctx, 1, 4, 7, 11, ta, wall);
  rooftop(ctx, 9, 4, 15, 11, tb, wall);
  antenna(b, 4, 7, ta + 1, 5, true);
  waterTank(b, 11, 6, tb + 1);
  for (let x = 1; x < S; x += 4) tree(ctx, x, 1, 1, 2, B.LEAVES_LIGHT);
};

/** 2×2: stepped terraced block (setbacks with planted terraces), ziggurat-like. */
const terracedBlock: Gen = (ctx) => {
  const { b, rng, S } = ctx;
  const wall = rng.pick([B.PLASTER_WHITE, B.PLASTER_CREAM, B.PLASTER_PEACH, B.BRICK_TAN]);
  const total = towerFloors(rng, 28, 48);
  box(b, 0, 0, 0, S, 1, S, B.CONCRETE);
  let x0 = 0;
  let z0 = 0;
  let x1 = S;
  let z1 = S - 2;
  let y = 1;
  let left = total;
  let tier = 0;
  while (left > 0 && x1 - x0 >= 4 && z1 - z0 >= 4) {
    const n = Math.min(left, tier === 0 ? 3 : rng.int(3, 7));
    const top = storeys(ctx, x0, z0, x1, z1, y, n, wall, B.PLASTER_WHITE, 2, 2, 0.5, tier & 1);
    for (let f = 1; f < n; f++) balconyFront(b, x0 + 1, x1 - 1, z1, y + f * FLOOR_H);
    if (tier === 0) lobby(ctx, 5, 11, z1 - 1, 1, B.PLASTER_WHITE);
    left -= n;
    y = top;
    // terrace: roof + greenery border on the inset strip
    box(b, x0, y, z0, x1, y + 1, z1, B.ROOF_FLAT);
    const nx0 = x0 + 1;
    const nz0 = z0 + 1;
    const nx1 = x1 - 1;
    const nz1 = z1 - 2;
    if (left > 0 && nx1 - nx0 >= 4 && nz1 - nz0 >= 4) {
      for (let x = x0; x < x1; x++) {
        b.set(x, y, z1 - 1, B.GRASS);
        b.set(x, y, z1 - 2, B.GRASS);
        if ((x & 1) === 0) setIfFree(b, x, y + 1, z1 - 1, B.BUSH);
      }
      ring(b, x0, z0, x1, z1, y + 1, B.RAILING);
      for (let x = x0 + 1; x < x1 - 1; x++) if ((x & 1) === 0) b.set(x, y + 1, z1 - 1, B.HEDGE);
    } else {
      ring(b, x0, z0, x1, z1, y + 1, wall);
      acUnits(ctx, x0, z0, x1, z1, y + 1, 3);
      antenna(b, (x0 + x1) >> 1, (z0 + z1) >> 1, y + 1, 5, y > 30);
      break;
    }
    x0 = nx0;
    z0 = nz0;
    x1 = nx1;
    z1 = nz1;
    y++;
    tier++;
  }
  for (let x = 0; x < S; x += 2) b.set(x, 0, S - 1, B.SIDEWALK);
  flowerBed(ctx, 0, S - 2, 4, S - 1);
  flowerBed(ctx, S - 4, S - 2, S, S - 1);
};

const TOWERS_2X2: readonly Gen[] = [podiumTower, twinTowers, terracedBlock];

/** Number of distinct archetypes per level (useful for galleries / tests). */
export const RESIDENTIAL_ARCHETYPES = { 1: HOUSES.length, 2: WALKUPS.length, 3: TOWERS_1X1.length, 32: TOWERS_2X2.length } as const;
