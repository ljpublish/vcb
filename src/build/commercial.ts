/**
 * MODULE: buildings — commercial building generators (module-internal API; may change).
 * Owner: buildings agent. See buildingGen.ts for the rules every generator follows.
 *
 * Self-contained: only StampBuilder.set/get are used, so this file does not depend on the
 * drawing helpers in stamp.ts. Everything is authored with the front (street side) at z = S-1.
 *
 *  C1 (1×1, 4–9 tall): corner shop, two-storey shop with flat upstairs, diner with pole sign
 *     and striped parking, kiosk/mini-mart with a canopy on poles.
 *  C2 (1×1, 13–25 tall, 4–8 storeys): ribbon-glass office, gridded panel office, podium + teal
 *     tower, steel/glass office with a rooftop billboard.
 *  C3 (1×1 24–44 tall, 2×2 40–78 tall): setback tower with spire, chamfered glass tower with a
 *     helipad, slab with a lit crown, stepped twin-tier tower. Marble lobbies, plazas, beacons,
 *     rooftop vents with steam emitters.
 */
import { B, type BlockId } from '../voxel/blocks';
import { hash3, hashToUnit, type Rng } from '../core/rng';
import { MAX_STRUCTURE_HEIGHT } from '../types';
import type { BuildingSpec, LocalEmitter } from './buildingGen';
import type { StampBuilder } from './stamp';
import { newLot } from './parts';

/** Builds an Active commercial building authored with its front facing +Z (caller rotates). */
export function generateCommercial(spec: BuildingSpec, rng: Rng, emitters: LocalEmitter[]): StampBuilder {
  const S = spec.size * 8;
  const seed = rng.nextU32();
  const ctx: Ctx = { S, seed, rng, emitters, b: newLot(spec) };
  if (spec.level === 1) {
    const v = spec.variant % 4;
    if (v === 0) cornerShop(ctx);
    else if (v === 1) twoStoreyShop(ctx);
    else if (v === 2) diner(ctx);
    else kiosk(ctx);
  } else if (spec.level === 2) {
    const v = spec.variant % 4;
    if (v === 0) ribbonOffice(ctx);
    else if (v === 1) gridOffice(ctx);
    else if (v === 2) podiumOffice(ctx);
    else billboardOffice(ctx);
  } else {
    const v = spec.variant % 4;
    if (v === 0) setbackTower(ctx);
    else if (v === 1) chamferTower(ctx);
    else if (v === 2) crownSlab(ctx);
    else steppedTower(ctx);
  }
  return ctx.b;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

interface Ctx {
  S: number;
  seed: number;
  rng: Rng;
  emitters: LocalEmitter[];
  b: StampBuilder;
}

const FLOOR = 3;
const MAX_Y = MAX_STRUCTURE_HEIGHT; // highest usable layer index (stamp has MAX+1 layers)

const AWNINGS: readonly BlockId[] = [B.AWNING_RED, B.AWNING_BLUE, B.AWNING_GREEN, B.AWNING_ORANGE];
const SIGNS: readonly BlockId[] = [B.SIGN_YELLOW, B.SIGN_CYAN, B.SIGN_MAGENTA, B.SIGN_GREEN, B.SIGN_WHITE];
const SHOP_WALLS: readonly BlockId[] = [
  B.BRICK_RED, B.BRICK_TAN, B.PLASTER_CREAM, B.PLASTER_YELLOW, B.PLASTER_MINT, B.PLASTER_PEACH, B.COM_PANEL,
];
const LIT_FRACTION = 0.55;

/** Half-open box fill, clipped to the stamp and to MAX_Y. */
function box(c: Ctx, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: BlockId): void {
  const b = c.b;
  const ya = Math.max(0, y0);
  const yb = Math.min(y1, MAX_Y + 1);
  for (let y = ya; y < yb; y++)
    for (let z = Math.max(0, z0); z < Math.min(z1, c.S); z++)
      for (let x = Math.max(0, x0); x < Math.min(x1, c.S); x++) b.set(x, y, z, id);
}

function set(c: Ctx, x: number, y: number, z: number, id: BlockId): void {
  if (y > MAX_Y || x < 0 || z < 0 || x >= c.S || z >= c.S) return;
  c.b.set(x, y, z, id);
}

function lit(c: Ctx, a: number, f: number, face: number): boolean {
  return hashToUnit(hash3(a, f, face, c.seed)) < LIT_FRACTION;
}

/** Ground layer (y = 0) paved across the whole lot. */
function pave(c: Ctx, id: BlockId): void {
  box(c, 0, 0, 0, c.S, 1, c.S, id);
}

/** Striped parking lot on layer 0 over [x0,x1)×[z0,z1), stripes run along z every 2 voxels. */
function parking(c: Ctx, x0: number, z0: number, x1: number, z1: number): void {
  box(c, x0, 0, z0, x1, 1, z1, B.ASPHALT);
  for (let x = x0; x < x1; x += 2) for (let z = z0; z < z1 - 1; z++) set(c, x, 0, z, B.ROAD_LINE_WHITE);
}

function emit(c: Ctx, x: number, y: number, z: number, strength: number): void {
  c.emitters.push({ x: x + 0.5, y, z: z + 0.5, kind: 'steam', strength });
}

function tree(c: Ctx, x: number, z: number): void {
  set(c, x, 0, z, B.GRASS);
  set(c, x, 1, z, B.WOOD);
  set(c, x, 2, z, B.WOOD);
  const leaf = (hash3(x, 7, z, c.seed) & 1) ? B.LEAVES : B.LEAVES_LIGHT;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) set(c, x + dx, 3, z + dz, leaf);
  set(c, x, 4, z, leaf);
}

function planter(c: Ctx, x: number, z: number): void {
  set(c, x, 0, z, B.GRASS);
  set(c, x, 1, z, B.HEDGE);
}

type Footprint = (x: number, z: number) => boolean;

function rect(x0: number, z0: number, x1: number, z1: number, chamfer = 0): Footprint {
  return (x, z) => {
    if (x < x0 || z < z0 || x >= x1 || z >= z1) return false;
    if (chamfer <= 0) return true;
    const dx = Math.min(x - x0, x1 - 1 - x);
    const dz = Math.min(z - z0, z1 - 1 - z);
    return dx + dz >= chamfer;
  };
}

type Pattern = 'ribbon' | 'grid' | 'curtain';

interface Facade {
  frame: BlockId;
  glass: BlockId;
  glassLit: BlockId;
  pattern: Pattern;
  /** Window bay width in voxels (grid / curtain mullions). */
  bay: number;
  /** Treat floors [y0, y0 + lobbyFloors*3) as an open lobby: glass + DOOR_GLASS front, marble posts. */
  lobbyFloors?: number;
  lobbyFrame?: BlockId;
}

/**
 * Extruded prism over `fp` from layer y0 (inclusive) to y1 (exclusive) with a windowed facade on
 * every outward face; interior solid frame. Floors are 3 voxels: layer 0 of each floor is the
 * spandrel/slab line, layers 1–2 are glazing.
 */
function prism(c: Ctx, fp: Footprint, y0: number, y1: number, f: Facade): void {
  const S = c.S;
  const lobbyTop = y0 + (f.lobbyFloors ?? 0) * FLOOR;
  for (let z = 0; z < S; z++) {
    for (let x = 0; x < S; x++) {
      if (!fp(x, z)) continue;
      // outward faces: N(-z)=0, E(+x)=1, S(+z)=2, W(-x)=3
      const out = [!fp(x, z - 1) || z === 0, !fp(x + 1, z) || x === S - 1, !fp(x, z + 1) || z === S - 1, !fp(x - 1, z) || x === 0];
      const nOut = (out[0] ? 1 : 0) + (out[1] ? 1 : 0) + (out[2] ? 1 : 0) + (out[3] ? 1 : 0);
      if (nOut === 0) {
        box(c, x, y0, z, x + 1, y1, z + 1, f.frame);
        continue;
      }
      // corner if two perpendicular faces are exposed, or a diagonal neighbour is missing (chamfer step)
      const diagMissing = !fp(x - 1, z - 1) || !fp(x + 1, z - 1) || !fp(x - 1, z + 1) || !fp(x + 1, z + 1);
      const corner = nOut >= 2 || (diagMissing && nOut === 1 && isStepCorner(fp, x, z));
      const face = out[2] ? 2 : out[1] ? 1 : out[3] ? 3 : 0;
      const u = face === 0 || face === 2 ? x : z;
      for (let y = y0; y < y1; y++) {
        const r = (y - y0) % FLOOR;
        const fl = Math.floor((y - y0) / FLOOR);
        let id: BlockId;
        if (y < lobbyTop) {
          id = lobbyVoxel(c, f, x, y - y0, z, face, u, corner);
        } else if (corner) {
          id = f.pattern === 'curtain' ? B.COM_STEEL : f.frame;
        } else if (f.pattern === 'ribbon') {
          id = r === 0 ? f.frame : lit(c, Math.floor(u / 2), fl, face) ? f.glassLit : f.glass;
        } else if (f.pattern === 'grid') {
          id = r === 0 || u % f.bay === 0 ? f.frame : lit(c, Math.floor(u / f.bay), fl, face) ? f.glassLit : f.glass;
        } else {
          // curtain wall: all glass, steel mullions every bay, thin dark slab lines
          if (u % f.bay === 0) id = B.COM_STEEL;
          else if (r === 0) id = B.GLASS_DARK;
          else id = lit(c, Math.floor(u / f.bay), fl, face) ? f.glassLit : f.glass;
        }
        set(c, x, y, z, id);
      }
    }
  }
}

function isStepCorner(fp: Footprint, x: number, z: number): boolean {
  // On a chamfer staircase every exposed cell is effectively a corner post; keeps diagonals crisp.
  let exposedDiag = 0;
  if (!fp(x - 1, z - 1)) exposedDiag++;
  if (!fp(x + 1, z - 1)) exposedDiag++;
  if (!fp(x - 1, z + 1)) exposedDiag++;
  if (!fp(x + 1, z + 1)) exposedDiag++;
  return exposedDiag >= 3;
}

function lobbyVoxel(c: Ctx, f: Facade, x: number, ly: number, z: number, face: number, u: number, corner: boolean): BlockId {
  const post = f.lobbyFrame ?? B.COM_MARBLE;
  if (corner) return post;
  const lobbyH = (f.lobbyFloors ?? 1) * FLOOR;
  if (ly === lobbyH - 1) return post; // lintel
  if (face === 2) {
    const mid = c.S / 2;
    if ((u === mid - 1 || u === mid) && ly < 2) return B.DOOR_GLASS;
    return u % 3 === 0 ? post : B.GLASS_LIT;
  }
  return u % 3 === 0 ? post : B.GLASS_BLUE;
}

/** Flat roof cap over `fp` at layer y; the outer ring is a 2-high parapet (y, y+1). Returns y + 1. */
function roof(c: Ctx, fp: Footprint, y: number, parapet: BlockId, top: BlockId = B.ROOF_FLAT): number {
  for (let z = 0; z < c.S; z++)
    for (let x = 0; x < c.S; x++) {
      if (!fp(x, z)) continue;
      const edge = !fp(x - 1, z) || !fp(x + 1, z) || !fp(x, z - 1) || !fp(x, z + 1) || x === 0 || z === 0 || x === c.S - 1 || z === c.S - 1;
      set(c, x, y, z, edge ? parapet : top);
      if (edge) set(c, x, y + 1, z, parapet);
    }
  return y + 1;
}

/** A few AC units on the roof area [x0,x1)×[z0,z1) at layer y. */
function acUnits(c: Ctx, x0: number, z0: number, x1: number, z1: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const x = c.rng.int(x0, x1);
    const z = c.rng.int(z0, z1);
    set(c, x, y, z, B.AC_UNIT);
  }
}

/** Vent stack (2 tall) with a steam emitter on top. */
function vent(c: Ctx, x: number, z: number, y: number, strength: number): void {
  set(c, x, y, z, B.COM_STEEL);
  set(c, x, y + 1, z, B.AC_UNIT);
  emit(c, x, y + 2, z, strength);
}

/** Antenna mast of height h with an optional red beacon; returns top layer. */
function mast(c: Ctx, x: number, z: number, y: number, h: number, beacon: boolean): number {
  const top = Math.min(y + h, MAX_Y);
  for (let yy = y; yy < top; yy++) set(c, x, yy, z, B.ANTENNA);
  if (beacon) set(c, x, top, z, B.BEACON_RED);
  return top;
}

/** Helipad (5×5) centred at (cx,cz) on layer y. */
function helipad(c: Ctx, cx: number, cz: number, y: number): void {
  box(c, cx - 2, y, cz - 2, cx + 3, y + 1, cz + 3, B.HELIPAD);
  // "H"
  for (let d = -1; d <= 1; d++) {
    set(c, cx - 1, y, cz + d, B.HELIPAD_MARK);
    set(c, cx + 1, y, cz + d, B.HELIPAD_MARK);
  }
  set(c, cx, y, cz, B.HELIPAD_MARK);
  set(c, cx - 2, y + 1, cz - 2, B.BEACON_RED);
  set(c, cx + 2, y + 1, cz + 2, B.BEACON_RED);
}

/** Glowing sign strip on the front face (z = zf) across [x0,x1) at layers [y0,y1). */
function frontSign(c: Ctx, x0: number, x1: number, y0: number, y1: number, zf: number, id: BlockId): void {
  box(c, x0, y0, zf, x1, y1, zf + 1, id);
}

// ---------------------------------------------------------------------------------------------
// C1 — shops
// ---------------------------------------------------------------------------------------------

/** Shopfront along the front wall at z = zf over [x0,x1): DOOR_GLASS door + glass display windows. */
function shopfront(c: Ctx, x0: number, x1: number, zf: number, wall: BlockId): void {
  const door = c.rng.int(x0 + 1, x1 - 2);
  for (let x = x0; x < x1; x++) {
    const edge = x === x0 || x === x1 - 1;
    set(c, x, 1, zf, edge ? wall : x === door || x === door + 1 ? B.DOOR_GLASS : B.GLASS_LIT);
    set(c, x, 2, zf, edge ? wall : x === door || x === door + 1 ? B.DOOR_GLASS : B.GLASS_LIT);
  }
}

/** Striped awning one voxel out from the front wall (z = zf + 1) at layer y over [x0,x1). */
function awning(c: Ctx, x0: number, x1: number, y: number, zf: number, colour: BlockId): void {
  for (let x = x0; x < x1; x++) set(c, x, y, zf + 1, x % 2 === 0 ? colour : B.PLASTER_WHITE);
}

function cornerShop(c: Ctx): void {
  const { rng } = c;
  pave(c, B.SIDEWALK);
  const wall = rng.pick(SHOP_WALLS);
  const zf = 5; // front wall row
  const h = 4; // 3 walls + roof
  box(c, 1, 1, 1, 7, h, zf + 1, wall);
  shopfront(c, 1, 7, zf, wall);
  // side windows
  for (const x of [1, 6]) for (let z = 2; z < zf; z += 2) set(c, x, 2, z, lit(c, x, z, 1) ? B.WINDOW_LIT : B.WINDOW);
  roof(c, rect(1, 1, 7, zf + 1), h, wall);
  awning(c, 1, 7, 3, zf, rng.pick(AWNINGS));
  // sign board on the parapet above the awning
  frontSign(c, 2, 6, h + 1, h + 2, zf, rng.pick(SIGNS));
  acUnits(c, 2, 2, 6, 4, h + 1, 1);
  // back service strip + a planter at the front corner
  box(c, 0, 0, 0, 8, 1, 1, B.CONCRETE);
  planter(c, 0, 7);
  planter(c, 7, 7);
}

function twoStoreyShop(c: Ctx): void {
  const { rng } = c;
  pave(c, B.SIDEWALK);
  const wall = rng.pick(SHOP_WALLS);
  const zf = 5;
  const top = 1 + 2 * FLOOR; // 7
  box(c, 0, 1, 0, 8, top, zf + 1, wall);
  shopfront(c, 0, 8, zf, wall);
  // upstairs windows on all faces
  for (let x = 1; x < 7; x += 2) {
    set(c, x, 5, zf, lit(c, x, 1, 2) ? B.WINDOW_LIT : B.WINDOW);
    set(c, x + 1, 5, zf, lit(c, x, 1, 2) ? B.WINDOW_LIT : B.WINDOW);
  }
  for (let z = 1; z < zf; z += 2) {
    set(c, 0, 5, z, lit(c, z, 1, 3) ? B.WINDOW_LIT : B.WINDOW);
    set(c, 7, 5, z, lit(c, z, 1, 1) ? B.WINDOW_LIT : B.WINDOW);
  }
  // cornice band between floors
  for (let x = 0; x < 8; x++) set(c, x, 4, zf, B.COM_CONCRETE);
  awning(c, 0, 8, 3, zf, rng.pick(AWNINGS));
  roof(c, rect(0, 0, 8, zf + 1), top, B.COM_CONCRETE);
  // projecting blade sign at the corner
  const sign = rng.pick(SIGNS);
  set(c, 7, 4, zf + 1, sign);
  set(c, 7, 5, zf + 1, sign);
  set(c, 7, 6, zf + 1, sign);
  acUnits(c, 1, 1, 7, 4, top + 1, 2);
}

function diner(c: Ctx): void {
  const { rng } = c;
  // parking on the left half, building on the right, sidewalk in front
  pave(c, B.SIDEWALK);
  parking(c, 0, 0, 3, 7);
  const wall = rng.pick([B.PLASTER_WHITE, B.PLASTER_CREAM, B.COM_STEEL] as const);
  const zf = 5;
  box(c, 3, 1, 1, 8, 4, zf + 1, wall);
  // wrap-around diner glass
  for (let x = 4; x < 7; x++) {
    set(c, x, 2, zf, B.GLASS_LIT);
  }
  for (let z = 2; z < zf; z++) set(c, 3, 2, z, B.GLASS_LIT);
  set(c, 7, 1, zf, B.DOOR_GLASS);
  set(c, 7, 2, zf, B.DOOR_GLASS);
  // coloured band under the roof
  const band = rng.pick(AWNINGS);
  for (let x = 3; x < 8; x++) set(c, x, 3, zf, band);
  for (let z = 1; z <= zf; z++) set(c, 3, 3, z, band);
  roof(c, rect(3, 1, 8, zf + 1), 4, wall);
  acUnits(c, 4, 2, 7, 4, 5, 1);
  // tall pole sign at the front-left corner
  const sign = rng.pick(SIGNS);
  for (let y = 1; y < 6; y++) set(c, 1, y, 6, B.METAL_POLE);
  box(c, 0, 6, 6, 3, 8, 7, sign);
}

function kiosk(c: Ctx): void {
  const { rng } = c;
  pave(c, B.CONCRETE);
  // small shop at the back, canopy over the forecourt on 4 poles
  const wall = rng.pick(SHOP_WALLS);
  box(c, 1, 1, 0, 7, 4, 3, wall);
  for (let x = 2; x < 6; x++) {
    set(c, x, 1, 2, x === 3 || x === 4 ? B.DOOR_GLASS : B.GLASS_LIT);
    set(c, x, 2, 2, x === 3 || x === 4 ? B.DOOR_GLASS : B.GLASS_LIT);
  }
  roof(c, rect(1, 0, 7, 3), 4, wall);
  for (const [x, z] of [[1, 4], [6, 4], [1, 7], [6, 7]] as const) for (let y = 1; y < 4; y++) set(c, x, y, z, B.METAL_POLE);
  const canopyCol = rng.pick(AWNINGS);
  box(c, 0, 4, 3, 8, 5, 8, B.COM_CONCRETE);
  box(c, 0, 4, 7, 8, 5, 8, canopyCol);
  // glowing fascia on the canopy front + a couple of lit tiles underneath (lights)
  frontSign(c, 2, 6, 5, 6, 7, rng.pick(SIGNS));
  set(c, 3, 3, 5, B.STREET_LAMP);
  set(c, 4, 3, 5, B.STREET_LAMP);
  // islands with planters
  planter(c, 3, 6);
  planter(c, 4, 6);
}

// ---------------------------------------------------------------------------------------------
// C2 — offices (4–8 storeys)
// ---------------------------------------------------------------------------------------------

function storeys(c: Ctx, lo: number, hi: number): number {
  return c.rng.int(lo, hi + 1);
}

function ribbonOffice(c: Ctx): void {
  const { rng } = c;
  pave(c, B.SIDEWALK);
  const n = storeys(c, 4, 8);
  const top = 1 + n * FLOOR;
  const fp = rect(0, 0, 8, 7);
  prism(c, fp, 1, top, {
    frame: rng.pick([B.COM_CONCRETE, B.COM_PANEL] as const),
    glass: rng.pick([B.GLASS_BLUE, B.GLASS_TEAL] as const),
    glassLit: B.GLASS_LIT,
    pattern: 'ribbon',
    bay: 2,
    lobbyFloors: 1,
  });
  const y = roof(c, fp, top, B.COM_CONCRETE);
  acUnits(c, 1, 1, 7, 5, y, 3);
  if (rng.chance(0.5)) vent(c, 2, 2, y, 0.25);
  frontSign(c, 2, 6, top - 2, top - 1, 7, rng.pick(SIGNS));
}

function gridOffice(c: Ctx): void {
  const { rng } = c;
  pave(c, B.SIDEWALK);
  const n = storeys(c, 4, 7);
  const top = 1 + n * FLOOR;
  const fp = rect(0, 0, 8, 7);
  prism(c, fp, 1, top, {
    frame: rng.pick([B.COM_PANEL, B.BRICK_TAN, B.COM_CONCRETE] as const),
    glass: B.WINDOW,
    glassLit: B.WINDOW_LIT,
    pattern: 'grid',
    bay: 2,
    lobbyFloors: 1,
    lobbyFrame: B.COM_CONCRETE,
  });
  // cornice + penthouse box
  const y = roof(c, fp, top, B.COM_CONCRETE);
  box(c, 2, y, 1, 5, y + 2, 4, B.COM_CONCRETE);
  set(c, 3, y + 1, 4, B.DOOR);
  acUnits(c, 5, 1, 7, 6, y, 2);
  mast(c, 3, 2, y + 2, 3, false);
}

function podiumOffice(c: Ctx): void {
  const { rng } = c;
  pave(c, B.SIDEWALK);
  // 2-floor podium on the full lot, slimmer teal tower above
  const pod = rect(0, 0, 8, 7);
  prism(c, pod, 1, 7, { frame: B.COM_MARBLE, glass: B.GLASS_BLUE, glassLit: B.GLASS_LIT, pattern: 'grid', bay: 3, lobbyFloors: 1 });
  roof(c, pod, 7, B.COM_MARBLE);
  const n = storeys(c, 3, 6);
  const top = 7 + n * FLOOR;
  const tw = rect(1, 1, 7, 6);
  prism(c, tw, 7, top, { frame: B.COM_STEEL, glass: B.GLASS_TEAL, glassLit: B.GLASS_LIT, pattern: 'curtain', bay: 3 });
  const y = roof(c, tw, top, B.COM_STEEL);
  acUnits(c, 2, 2, 6, 5, y, 2);
  vent(c, 5, 2, y, 0.3);
  // podium roof garden
  planter(c, 0, 7);
  for (const x of [1, 6]) set(c, x, 8, 6, B.HEDGE);
}

function billboardOffice(c: Ctx): void {
  const { rng } = c;
  pave(c, B.SIDEWALK);
  const n = storeys(c, 4, 6);
  const top = 1 + n * FLOOR;
  const fp = rect(0, 0, 8, 7, 1);
  prism(c, fp, 1, top, { frame: B.COM_STEEL, glass: B.GLASS_BLUE, glassLit: B.GLASS_LIT, pattern: 'curtain', bay: 2, lobbyFloors: 1, lobbyFrame: B.COM_STEEL });
  const y = roof(c, fp, top, B.COM_STEEL);
  // rooftop billboard: frame on two legs, glowing panel facing the street
  const sign = rng.pick(SIGNS);
  for (const x of [1, 6]) for (let yy = y; yy < y + 2; yy++) set(c, x, yy, 4, B.METAL_POLE);
  box(c, 0, y + 2, 4, 8, Math.min(y + 5, MAX_Y + 1), 5, B.METAL_POLE);
  box(c, 1, y + 2, 5, 7, Math.min(y + 5, MAX_Y + 1), 6, sign);
  acUnits(c, 2, 1, 6, 3, y, 2);
}

// ---------------------------------------------------------------------------------------------
// C3 — towers
// ---------------------------------------------------------------------------------------------

/** Plaza on layer 0 for big lots: pavers, planters and trees along the street edge. */
function plaza(c: Ctx, fpX0: number, fpZ0: number, fpX1: number, fpZ1: number): void {
  pave(c, B.SIDEWALK);
  const S = c.S;
  if (S >= 16) {
    // checkered pavers in front, trees at the front corners, hedges on the sides
    for (let z = fpZ1; z < S; z++) for (let x = 0; x < S; x++) if ((x + z) % 2 === 0) set(c, x, 0, z, B.CONCRETE);
    if (S - fpZ1 >= 3) {
      tree(c, 1, S - 2);
      tree(c, S - 2, S - 2);
    }
    for (let z = fpZ0; z < fpZ1; z += 2) {
      if (fpX0 >= 1) planter(c, 0, z);
      if (fpX1 <= S - 1) planter(c, S - 1, z);
    }
  } else if (fpZ1 < S) {
    for (let x = 0; x < S; x++) if (x % 3 === 0) set(c, x, 0, S - 1, B.CONCRETE);
  }
}

function towerHeight(c: Ctx): number {
  // total usable height for the main shaft (excluding spires)
  return c.S >= 16 ? c.rng.int(44, 70) : c.rng.int(24, 40);
}

function setbackTower(c: Ctx): void {
  const { S, rng } = c;
  const m = S >= 16 ? 1 : 0;
  plaza(c, m, m, S - m, S - (S >= 16 ? 3 : 1));
  const total = towerHeight(c);
  const glass = rng.pick([B.GLASS_BLUE, B.GLASS_TEAL] as const);
  const tiers = S >= 16 ? 3 : 2;
  let y = 1;
  let x0 = m;
  let z0 = m;
  let x1 = S - m;
  let z1 = S - (S >= 16 ? 3 : 1);
  for (let t = 0; t < tiers; t++) {
    const h = Math.max(2, Math.round((total * (tiers - t)) / ((tiers * (tiers + 1)) / 2) / FLOOR)) * FLOOR;
    const top = Math.min(y + h, MAX_Y - 10);
    const fp = rect(x0, z0, x1, z1);
    prism(c, fp, y, top, { frame: B.COM_STEEL, glass, glassLit: B.GLASS_LIT, pattern: 'curtain', bay: S >= 16 ? 3 : 2, lobbyFloors: t === 0 ? 1 : 0 });
    roof(c, fp, top, B.COM_STEEL);
    if (t < tiers - 1) {
      acUnits(c, x0, z0, x1, z1, top + 1, 2);
      if (t === 0) vent(c, x0, z0, top + 1, 0.4);
    }
    y = top + 1;
    const step = S >= 16 ? 2 : 1;
    x0 += step;
    z0 += step;
    x1 -= step;
    z1 -= step;
    if (x1 - x0 < 3 || z1 - z0 < 3) break;
  }
  // spire with beacon on the centre of the last tier
  const cx = Math.floor((x0 + x1 - 1) / 2);
  const cz = Math.floor((z0 + z1 - 1) / 2);
  set(c, cx, y, cz, B.COM_STEEL);
  mast(c, cx, cz, y + 1, S >= 16 ? 8 : 5, true);
}

function chamferTower(c: Ctx): void {
  const { S, rng } = c;
  const m = S >= 16 ? 2 : 0;
  const zEnd = S - (S >= 16 ? 4 : 1);
  plaza(c, m, m, S - m, zEnd);
  const total = towerHeight(c);
  const top = 1 + Math.floor(total / FLOOR) * FLOOR;
  const fp = rect(m, m, S - m, zEnd, S >= 16 ? 2 : 1);
  prism(c, fp, 1, top, {
    frame: B.COM_STEEL,
    glass: rng.pick([B.GLASS_TEAL, B.GLASS_BLUE] as const),
    glassLit: B.GLASS_LIT,
    pattern: 'curtain',
    bay: 2,
    lobbyFloors: S >= 16 ? 2 : 1,
  });
  const y = roof(c, fp, top, B.COM_STEEL);
  const cx = Math.floor(S / 2);
  const cz = Math.floor((m + zEnd) / 2);
  if (S >= 16) {
    helipad(c, cx, cz, y);
    vent(c, m + 2, m + 2, y, 0.45);
    vent(c, S - m - 3, m + 2, y, 0.45);
  } else {
    acUnits(c, 2, 2, 6, 5, y, 2);
    vent(c, 2, 2, y, 0.35);
    mast(c, 5, 4, y, 4, true);
  }
}

function crownSlab(c: Ctx): void {
  const { S, rng } = c;
  // a wide slab facing the street, with a lit crown band near the top
  const zEnd = S - (S >= 16 ? 3 : 1);
  const z0 = S >= 16 ? 3 : 1;
  plaza(c, 0, z0, S, zEnd);
  const total = towerHeight(c);
  const top = 1 + Math.floor(total / FLOOR) * FLOOR;
  const fp = rect(0, z0, S, zEnd);
  const frame = rng.pick([B.COM_CONCRETE, B.COM_PANEL] as const);
  prism(c, fp, 1, top, { frame, glass: rng.pick([B.GLASS_BLUE, B.WINDOW] as const), glassLit: B.GLASS_LIT, pattern: 'grid', bay: 2, lobbyFloors: S >= 16 ? 2 : 1 });
  // crown: two glowing bands on the last floor
  const crown = rng.pick([B.SIGN_WHITE, B.SIGN_CYAN, B.SIGN_YELLOW] as const);
  for (let z = z0; z < zEnd; z++)
    for (let x = 0; x < S; x++) {
      const edge = x === 0 || x === S - 1 || z === z0 || z === zEnd - 1;
      if (edge) set(c, x, top - 2, z, crown);
    }
  const y = roof(c, fp, top, frame);
  // mechanical penthouse + vents
  const px0 = Math.floor(S / 4);
  const px1 = S - px0;
  box(c, px0, y, z0 + 1, px1, y + 3, zEnd - 1, B.COM_STEEL);
  for (let x = px0; x < px1; x += 2) vent(c, x, z0 + 1, y + 3, 0.35);
  set(c, Math.floor(S / 2), y + 3, Math.floor((z0 + zEnd) / 2), B.BEACON_RED);
}

function steppedTower(c: Ctx): void {
  const { S, rng } = c;
  // tall rear shaft + shorter front wing; marble lobby block at the front
  const big = S >= 16;
  pave(c, B.SIDEWALK);
  const total = towerHeight(c);
  const glass = rng.pick([B.GLASS_BLUE, B.GLASS_TEAL] as const);
  const rearTop = 1 + Math.floor(total / FLOOR) * FLOOR;
  const frontTop = 1 + Math.floor((total * 0.55) / FLOOR) * FLOOR;
  const mid = big ? 8 : 4;
  const rear = rect(big ? 1 : 0, big ? 1 : 0, big ? 11 : 6, mid);
  const front = rect(big ? 4 : 2, mid, big ? 15 : 8, big ? 13 : 7);
  prism(c, rear, 1, rearTop, { frame: B.COM_STEEL, glass, glassLit: B.GLASS_LIT, pattern: 'curtain', bay: 2 });
  prism(c, front, 1, frontTop, { frame: B.COM_MARBLE, glass: B.GLASS_BLUE, glassLit: B.GLASS_LIT, pattern: 'ribbon', bay: 2, lobbyFloors: big ? 2 : 1 });
  const yr = roof(c, rear, rearTop, B.COM_STEEL);
  const yf = roof(c, front, frontTop, B.COM_MARBLE);
  // front wing roof terrace
  if (big) {
    for (let x = 6; x < 14; x += 3) set(c, x, yf, 11, B.HEDGE);
    tree(c, 1, 14);
    planter(c, 14, 14);
    planter(c, 0, 10);
  }
  acUnits(c, big ? 5 : 3, big ? 9 : 5, big ? 14 : 7, big ? 12 : 6, yf, 2);
  vent(c, big ? 3 : 1, big ? 3 : 1, yr, 0.4);
  const cx = big ? 6 : 3;
  const cz = big ? 4 : 2;
  mast(c, cx, cz, yr, big ? 9 : 5, true);
  if (big) frontSign(c, 6, 13, frontTop - 2, frontTop - 1, 13, rng.pick(SIGNS));
}
