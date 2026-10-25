/**
 * MODULE: buildings — industrial building generators (module-internal API; may change).
 * Owner: buildings agent. See buildingGen.ts for the rules every generator follows.
 *
 * Every generator authors its building with the FRONT (road side) facing +Z, i.e. z = S-1 is the
 * street edge. Layer y = 0 is the lot's ground surface (repainted as yard), the structure starts at
 * y = 1. Shared helpers come from parts.ts; industrial-specific ones (stacks, tanks, pipes, sawtooth
 * roofs, cranes, containers) are local below.
 *
 * Looks per level (3 variants each, picked by the variant-seeded rng):
 *   I1 — gable warehouse, quonset hangar, shed with brick office + loading dock and truck.
 *   I2 — sawtooth factory + smokestack, brick mill with twin stacks, chemical plant with tanks.
 *   I3 1×1 — grain silos, power plant with a tall stack, container depot with a gantry crane.
 *   I3 2×2 — steel works, refinery, logistics port.
 * Smokestacks publish 'smoke' emitters at their mouth; cooling vents publish 'steam'.
 */
import type { Rng } from '../core/rng';
import { B, type BlockId } from '../voxel/blocks';
import type { BuildingSpec, LocalEmitter } from './buildingGen';
import { emit, footprint, ground, newLot, rand3, windowBlock } from './parts';
import type { StampBuilder } from './stamp';

/** Industrial buildings are dimmer at night than offices. */
const LIT_RATIO = 0.35;

/** Builds an Active industrial building authored with its front facing +Z (caller rotates). */
export function generateIndustrial(spec: BuildingSpec, rng: Rng, emitters: LocalEmitter[]): StampBuilder {
  const S = footprint(spec);
  const b = newLot(spec);
  const v = rng.int(0, 3);
  const ctx: Ctx = { b, S, rng, emitters, seed: spec.variant | 0 };
  if (spec.level === 1) I1[v](ctx);
  else if (spec.level === 2) I2[v](ctx);
  else if (spec.size === 2) I3_BIG[v](ctx);
  else I3[v](ctx);
  return b;
}

interface Ctx {
  b: StampBuilder;
  S: number;
  rng: Rng;
  emitters: LocalEmitter[];
  seed: number;
}

// ---------------------------------------------------------------------------------------------
// Drawing helpers (half-open boxes, clipped by StampBuilder.set)
// ---------------------------------------------------------------------------------------------

function box(b: StampBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: BlockId): void {
  b.fill(x0, y0, z0, x1, y1, z1, id);
}

/** Vertical cylinder centred on the continuous point (cx, cz). */
function cyl(b: StampBuilder, cx: number, cz: number, r: number, y0: number, y1: number, id: BlockId): void {
  const r2 = r * r;
  for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x + 0.5 - cx;
      const dz = z + 0.5 - cz;
      if (dx * dx + dz * dz <= r2) for (let y = y0; y < y1; y++) b.set(x, y, z, id);
    }
  }
}

function isLit(c: Ctx, x: number, y: number, z: number, ratio = LIT_RATIO): boolean {
  return rand3(x, y, z, c.seed) < ratio;
}

function win(c: Ctx, x: number, y: number, z: number, ratio = LIT_RATIO): void {
  c.b.set(x, y, z, windowBlock(x, y, z, c.seed, ratio));
}

/** Yard: repaint the whole ground layer. */
function yard(c: Ctx, id: BlockId): void {
  ground(c.b, id);
}

/** Hazard stripe along x at row z (ground layer). */
function hazardRowX(c: Ctx, x0: number, x1: number, z: number, y = 0): void {
  for (let x = x0; x < x1; x++) c.b.set(x, y, z, (x & 1) === 0 ? B.HAZARD_YELLOW : B.HAZARD_BLACK);
}

/**
 * Round smokestack with red bands, built from y0 up to (excluding) top. A 'smoke' emitter is
 * published at the mouth. `r` ≈ 1 gives a 2×2 stack (with integer centre), 1.5 a 3×3 disc.
 */
function smokestack(c: Ctx, cx: number, cz: number, r: number, y0: number, top: number, strength: number): void {
  const { b } = c;
  cyl(b, cx, cz, r + 0.5, y0, y0 + 1, B.CONCRETE_DARK); // plinth
  cyl(b, cx, cz, r, y0 + 1, top, B.SMOKESTACK);
  // two warning bands near the top, one in the middle on tall stacks
  cyl(b, cx, cz, r, top - 2, top - 1, B.SMOKESTACK_BAND);
  cyl(b, cx, cz, r, top - 4, top - 3, B.SMOKESTACK_BAND);
  if (top - y0 > 22) cyl(b, cx, cz, r, Math.floor((y0 + top) / 2), Math.floor((y0 + top) / 2) + 1, B.SMOKESTACK_BAND);
  const beacon = top - y0 > 26;
  if (beacon) b.set(Math.floor(cx), top, Math.floor(cz), B.BEACON_RED);
  emit(c.emitters, cx, beacon ? top + 1 : top, cz, 'smoke', strength);
}

/** Vertical tank with a domed cap. */
function tank(c: Ctx, cx: number, cz: number, r: number, y0: number, h: number, id: BlockId, band: BlockId | null = null): void {
  cyl(c.b, cx, cz, r, y0, y0 + h, id);
  if (r >= 1.4) cyl(c.b, cx, cz, r - 0.8, y0 + h, y0 + h + 1, id);
  if (band !== null) cyl(c.b, cx, cz, r, y0 + Math.floor(h * 0.6), y0 + Math.floor(h * 0.6) + 1, band);
}

/** Crate stack: random heights 1..maxH at a few cells inside [x0,x1)×[z0,z1). */
function crates(c: Ctx, x0: number, z0: number, x1: number, z1: number, n: number, maxH: number): void {
  for (let i = 0; i < n; i++) {
    const x = c.rng.int(x0, x1);
    const z = c.rng.int(z0, z1);
    const h = c.rng.int(1, maxH + 1);
    for (let y = 1; y <= h; y++) if (c.b.get(x, y, z) === 255) c.b.set(x, y, z, B.CRATE);
  }
}

const CONTAINERS: readonly BlockId[] = [B.CONTAINER_RED, B.CONTAINER_BLUE, B.CONTAINER_GREEN];

/** Shipping container lying along x (len × 2 wide × 2 tall), base at y. */
function containerX(c: Ctx, x0: number, z0: number, y: number, len: number, id: BlockId): void {
  box(c.b, x0, y, z0, x0 + len, y + 2, z0 + 2, id);
}

/** Shipping container lying along z. */
function containerZ(c: Ctx, x0: number, z0: number, y: number, len: number, id: BlockId): void {
  box(c.b, x0, y, z0, x0 + 2, y + 2, z0 + len, id);
}

/** Corrugated siding: alternate rib colour every other column along the given axis. */
function sidingWall(c: Ctx, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, a: BlockId, rib: BlockId): void {
  for (let y = y0; y < y1; y++)
    for (let z = z0; z < z1; z++)
      for (let x = x0; x < x1; x++) {
        const edge = x === x0 || x === x1 - 1 || z === z0 || z === z1 - 1;
        c.b.set(x, y, z, edge && ((x + z) & 1) === 1 ? rib : a);
      }
}

/** Roll-up loading door on the +Z face (z) spanning [x0,x1)×[1,h], hazard posts each side. */
function loadingDoor(c: Ctx, x0: number, x1: number, z: number, h: number): void {
  for (let y = 1; y <= h; y++) {
    for (let x = x0; x < x1; x++) c.b.set(x, y, z, (y & 1) === 0 ? B.METAL_SHEET_DARK : B.METAL_SHEET);
    c.b.set(x0 - 1, y, z, (y & 1) === 0 ? B.HAZARD_YELLOW : B.HAZARD_BLACK);
    c.b.set(x1, y, z, (y & 1) === 0 ? B.HAZARD_BLACK : B.HAZARD_YELLOW);
  }
  // apron with hazard stripe in front of the door
  hazardRowX(c, x0 - 1, x1 + 1, z + 1);
}

/** Pipe run along x at height y. */
function pipeX(c: Ctx, x0: number, x1: number, y: number, z: number): void {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) if (c.b.get(x, y, z) === 255) c.b.set(x, y, z, B.PIPE);
}

function pipeZ(c: Ctx, z0: number, z1: number, y: number, x: number): void {
  for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) if (c.b.get(x, y, z) === 255) c.b.set(x, y, z, B.PIPE);
}

function pipeY(c: Ctx, x: number, y0: number, y1: number, z: number): void {
  for (let y = y0; y <= y1; y++) if (c.b.get(x, y, z) === 255) c.b.set(x, y, z, B.PIPE);
}

/** Sawtooth roof over [x0,x1)×[z0,z1) starting at layer y; teeth rise toward +Z, glazed drop faces. */
function sawtooth(c: Ctx, x0: number, z0: number, x1: number, z1: number, y: number, period: number, roof: BlockId): void {
  for (let z = z0; z < z1; z++) {
    const k = (z - z0) % period;
    for (let x = x0; x < x1; x++) {
      for (let h = 0; h <= k; h++) {
        const top = h === k;
        // the tallest column's +Z face is the glazed north-light
        const glass = k === period - 1 && !top && x > x0 && x < x1 - 1;
        c.b.set(x, y + h, z, top ? roof : glass ? (isLit(c, x, y + h, z, 0.5) ? B.GLASS_LIT : B.GLASS_BLUE) : roof);
      }
    }
  }
}

/** Gantry crane straddling [x0,x1) along x, legs at z0 and z1, beam at height h. */
function gantry(c: Ctx, x0: number, x1: number, z0: number, z1: number, h: number): void {
  for (let y = 1; y < h; y++) {
    c.b.set(x0, y, z0, B.CRANE_YELLOW);
    c.b.set(x0, y, z1, B.CRANE_YELLOW);
    c.b.set(x1, y, z0, B.CRANE_YELLOW);
    c.b.set(x1, y, z1, B.CRANE_YELLOW);
  }
  for (let z = z0; z <= z1; z++) {
    c.b.set(x0, h, z, B.CRANE_YELLOW);
    c.b.set(x1, h, z, B.CRANE_YELLOW);
  }
  for (let x = x0; x <= x1; x++) {
    c.b.set(x, h, z0, B.CRANE_YELLOW);
    c.b.set(x, h, z1, B.CRANE_YELLOW);
  }
  // trolley + hanging hook line
  const tx = c.rng.int(x0 + 1, x1);
  box(c.b, tx, h, z0 + 1, tx + 1, h + 1, z1, B.CRANE_YELLOW);
  const tz = Math.floor((z0 + z1) / 2);
  c.b.set(tx, h - 1, tz, B.HAZARD_BLACK);
  c.b.set(tx, h - 2, tz, B.METAL_POLE);
}

/** Small parked truck (cab facing +Z) at (x, z): 2 wide, 3 long. */
function truck(c: Ctx, x: number, z: number): void {
  const body = c.rng.pick(CONTAINERS);
  box(c.b, x, 1, z, x + 2, 3, z + 2, body);
  box(c.b, x, 1, z + 2, x + 2, 2, z + 3, B.METAL_SHEET);
  c.b.set(x, 2, z + 2, B.GLASS_DARK);
  c.b.set(x + 1, 2, z + 2, B.GLASS_DARK);
}

// ---------------------------------------------------------------------------------------------
// I1 — light industry (1×1)
// ---------------------------------------------------------------------------------------------

const SIDING: readonly BlockId[] = [B.METAL_SHEET, B.METAL_BLUE, B.METAL_GREEN];

const I1: ReadonlyArray<(c: Ctx) => void> = [
  // Gable-roof warehouse with a big loading door and a crate yard.
  (c) => {
    const { b, rng } = c;
    yard(c, B.CONCRETE);
    const siding = rng.pick(SIDING);
    const roof = rng.chance(0.5) ? B.ROOF_GRAY : B.METAL_SHEET_DARK;
    const d = 5; // depth of the hall (z 0..d)
    const wh = 4;
    sidingWall(c, 0, 1, 0, 8, wh + 1, d, siding, B.METAL_SHEET_DARK);
    // gable roof, ridge along x; gable ends keep the siding
    for (let k = 0; k < 3; k++) {
      const y = wh + 1 + k;
      for (let z = k; z < d - k; z++)
        for (let x = 0; x < 8; x++) {
          const end = x === 0 || x === 7;
          const slope = z === k || z === d - 1 - k;
          b.set(x, y, z, end && !slope ? siding : roof);
        }
    }
    loadingDoor(c, 2, 5, d - 1, 3);
    b.set(6, 1, d - 1, B.DOOR);
    b.set(6, 2, d - 1, B.DOOR);
    for (let x = 1; x < 7; x++) if (x !== 3) win(c, x, 4, 0);
    // yard: crates and pallets
    crates(c, 5, d + 1, 8, 8, 4, 2);
    if (rng.chance(0.5)) truck(c, 0, d);
    hazardRowX(c, 0, 8, 7);
  },
  // Quonset hangar: barrel roof along z, rust patches, door on the front end.
  (c) => {
    const { b, rng } = c;
    yard(c, B.GRAVEL);
    const siding = rng.pick(SIDING);
    const prof = [3, 5, 6, 6, 5, 3]; // heights across x = 1..6
    for (let i = 0; i < prof.length; i++) {
      const x = i + 1;
      for (let z = 0; z < 6; z++)
        for (let y = 1; y <= prof[i]; y++) {
          const shell = y === prof[i] || i === 0 || i === prof.length - 1;
          const rusty = shell && rand3(x, y, z, c.seed + 7) < 0.2;
          b.set(x, y, z, rusty ? B.METAL_RUST : (z & 1) === 0 ? siding : B.METAL_SHEET_DARK);
        }
      // front end wall
      for (let y = 1; y <= prof[i]; y++) b.set(x, y, 5, B.METAL_SHEET);
    }
    loadingDoor(c, 3, 5, 5, 3);
    win(c, 2, 4, 5);
    win(c, 5, 4, 5);
    box(b, 3, 1, 6, 5, 1, 8, B.ASPHALT);
    crates(c, 0, 6, 2, 8, 3, 2);
    crates(c, 6, 6, 8, 8, 3, 1);
    if (rng.chance(0.6)) {
      // fuel drum / small tank on the side
      tank(c, 7, 1.5, 0.9, 1, 3, B.HAZARD_YELLOW);
    }
  },
  // Flat shed with a brick office annex, loading dock and a delivery truck.
  (c) => {
    const { b, rng } = c;
    yard(c, B.CONCRETE_DARK);
    const siding = rng.pick(SIDING);
    // shed at the back
    sidingWall(c, 0, 1, 0, 6, 5, 5, siding, B.METAL_SHEET_DARK);
    box(b, 0, 5, 0, 6, 6, 5, B.ROOF_FLAT);
    loadingDoor(c, 1, 3, 4, 3);
    loadingDoor(c, 4, 5, 4, 3);
    // raised dock in front of the doors
    box(b, 0, 1, 5, 4, 2, 6, B.CONCRETE);
    // brick office on the right
    const brick = rng.pick([B.BRICK_TAN, B.BRICK_RED, B.BRICK_BROWN] as const);
    box(b, 6, 1, 1, 8, 4, 7, brick);
    box(b, 6, 4, 1, 8, 5, 7, B.ROOF_FLAT);
    b.set(6, 1, 6, B.DOOR);
    b.set(7, 2, 6, isLit(c, 7, 2, 6, 0.6) ? B.WINDOW_LIT : B.WINDOW);
    for (let z = 2; z < 6; z += 2) win(c, 7, 2, z, 0.6);
    b.set(1, 6, 1, B.AC_UNIT);
    if (rng.chance(0.5)) b.set(4, 6, 2, B.AC_UNIT);
    hazardRowX(c, 0, 6, 7);
    truck(c, 4, 5);
  },
];

// ---------------------------------------------------------------------------------------------
// I2 — factories (1×1)
// ---------------------------------------------------------------------------------------------

const I2: ReadonlyArray<(c: Ctx) => void> = [
  // Sawtooth-roof factory with a banded smokestack and a silver tank.
  (c) => {
    const { b, rng } = c;
    yard(c, B.CONCRETE);
    const wall = rng.pick([B.BRICK_RED, B.METAL_SHEET, B.CONCRETE] as const);
    box(b, 0, 1, 0, 6, 5, 6, wall);
    for (let x = 1; x < 6; x += 2) {
      win(c, x, 2, 5);
      win(c, x, 3, 5);
    }
    for (let z = 1; z < 5; z += 2) {
      win(c, 5, 3, z);
      win(c, 0, 3, z);
    }
    b.set(0, 1, 5, B.DOOR);
    b.set(0, 2, 5, B.DOOR);
    sawtooth(c, 0, 0, 6, 6, 5, 3, B.ROOF_GRAY);
    const top = rng.int(17, 22);
    smokestack(c, 7, 1, 1, 1, top, rng.range(0.6, 1.0));
    tank(c, 7, 5.5, 1.2, 1, 4, B.TANK_SILVER);
    pipeY(c, 6, 1, 4, 5);
    pipeZ(c, 1, 5, 4, 6);
    hazardRowX(c, 0, 6, 7);
  },
  // Two-storey brick mill with twin stacks.
  (c) => {
    const { b, rng } = c;
    yard(c, B.CONCRETE_DARK);
    const brick = rng.pick([B.BRICK_RED, B.BRICK_BROWN] as const);
    box(b, 0, 1, 1, 8, 7, 6, brick);
    // floor band + windows on the street side and the back
    for (let x = 0; x < 8; x++) b.set(x, 4, 5, B.CONCRETE);
    for (let x = 1; x < 7; x++) {
      if (x !== 3 && x !== 4) win(c, x, 2, 5);
      win(c, x, 5, 5);
      win(c, x, 5, 1);
    }
    box(b, 3, 1, 5, 5, 4, 6, B.METAL_SHEET_DARK); // goods door
    hazardRowX(c, 2, 6, 6);
    box(b, 0, 7, 1, 8, 8, 6, B.ROOF_FLAT);
    // parapet
    for (let x = 0; x < 8; x++) {
      b.set(x, 8, 1, brick);
      b.set(x, 8, 5, brick);
    }
    b.set(2, 8, 3, B.AC_UNIT);
    const top = rng.int(18, 23);
    smokestack(c, 2, 1, 1, 7, top, rng.range(0.6, 0.9));
    smokestack(c, 6, 1, 1, 7, top - rng.int(1, 4), rng.range(0.6, 0.9));
    crates(c, 0, 6, 2, 8, 2, 2);
  },
  // Chemical plant: control hall, two white tanks, pipe rack and a thin stack.
  (c) => {
    const { b, rng } = c;
    yard(c, B.CONCRETE);
    const wall = rng.pick([B.METAL_BLUE, B.METAL_GREEN, B.METAL_SHEET] as const);
    sidingWall(c, 0, 1, 3, 4, 5, 8, wall, B.METAL_SHEET_DARK);
    box(b, 0, 5, 3, 4, 6, 8, B.ROOF_FLAT);
    b.set(1, 1, 7, B.DOOR);
    b.set(1, 2, 7, B.DOOR);
    win(c, 2, 3, 7);
    win(c, 3, 3, 7);
    b.set(2, 6, 5, B.AC_UNIT);
    const h = rng.int(6, 9);
    tank(c, 6, 2, 1.6, 1, h, B.TANK_WHITE, B.HAZARD_YELLOW);
    tank(c, 6, 6, 1.6, 1, h - 2, B.TANK_WHITE, B.HAZARD_YELLOW);
    // pipe rack linking hall and tanks
    pipeX(c, 3, 6, 4, 4);
    pipeY(c, 4, 1, 4, 4);
    pipeZ(c, 2, 6, h - 1, 7);
    const top = rng.int(15, 19);
    smokestack(c, 1.5, 1.5, 1.0, 1, top, rng.range(0.6, 0.8));
  },
];

// ---------------------------------------------------------------------------------------------
// I3 — heavy industry (1×1)
// ---------------------------------------------------------------------------------------------

const I3: ReadonlyArray<(c: Ctx) => void> = [
  // Grain / cement silos with a conveyor tower.
  (c) => {
    const { b, rng } = c;
    yard(c, B.CONCRETE);
    const mat = rng.pick([B.TANK_WHITE, B.CONCRETE, B.TANK_SILVER] as const);
    const h = rng.int(16, 23);
    tank(c, 1.8, 1.8, 1.8, 1, h, mat);
    tank(c, 5.2, 1.8, 1.8, 1, h, mat);
    tank(c, 1.8, 5.0, 1.8, 1, h - 3, mat);
    // head house on top + conveyor tower in the free corner
    box(b, 1, h + 1, 1, 6, h + 3, 3, B.METAL_RUST);
    box(b, 5, 1, 4, 8, h - 2, 7, B.METAL_SHEET_DARK);
    for (let y = 3; y < h - 2; y += 3) win(c, 7, y, 6, 0.25);
    box(b, 5, h - 2, 4, 8, h - 1, 7, B.ROOF_GRAY);
    pipeY(c, 4, h - 1, h + 1, 3);
    b.set(5, h + 3, 2, B.PIPE); // dust vent
    emit(c.emitters, 5.5, h + 4, 2.5, 'steam', 0.3);
    // loading bay at the street
    loadingDoor(c, 6, 7, 6, 3);
    hazardRowX(c, 0, 8, 7);
  },
  // Power plant: rusty turbine hall, tall stack and a cooling vent (steam).
  (c) => {
    const { b, rng } = c;
    yard(c, B.CONCRETE_DARK);
    box(b, 0, 1, 2, 6, 8, 8, B.METAL_RUST);
    for (let x = 0; x < 6; x++) for (let y = 2; y < 8; y += 3) if (x > 0 && x < 5) win(c, x, y, 7, 0.3);
    box(b, 0, 8, 2, 6, 9, 8, B.METAL_SHEET_DARK);
    box(b, 2, 1, 7, 4, 4, 8, B.METAL_SHEET_DARK); // door
    // cooling vent on the roof
    cyl(b, 3, 5, 1.2, 9, 11, B.CONCRETE);
    emit(c.emitters, 3, 11, 5, 'steam', 0.5);
    const top = rng.int(30, 38);
    smokestack(c, 6.5, 1.5, 1.5, 1, top, rng.range(0.8, 1.0));
    pipeX(c, 4, 6, 6, 3);
    pipeY(c, 7, 1, 6, 4);
    b.set(1, 9, 3, B.AC_UNIT);
  },
  // Container depot with a gantry crane.
  (c) => {
    const { b, rng } = c;
    yard(c, B.ASPHALT);
    for (let x = 0; x < 8; x++) b.set(x, 0, 3, B.ROAD_LINE_YELLOW);
    for (let row = 0; row < 2; row++) {
      const z0 = row === 0 ? 0 : 4;
      const stack = rng.int(1, 4);
      for (let lvl = 0; lvl < stack; lvl++) containerX(c, 1, z0, 1 + lvl * 2, 6, rng.pick(CONTAINERS));
    }
    gantry(c, 0, 7, 0, 6, rng.int(9, 11));
    box(b, 0, 1, 7, 2, 3, 8, B.CONCRETE); // gate hut
    win(c, 1, 2, 7, 0.7);
    hazardRowX(c, 2, 8, 7);
  },
];

// ---------------------------------------------------------------------------------------------
// I3 — heavy industry (2×2)
// ---------------------------------------------------------------------------------------------

const I3_BIG: ReadonlyArray<(c: Ctx) => void> = [
  // Steel works: sawtooth hall, blast furnace with crossover pipe, two tall stacks, container yard.
  (c) => {
    const { b, rng } = c;
    yard(c, B.CONCRETE_DARK);
    // hall 12 × 8 at the back-left
    sidingWall(c, 0, 1, 0, 11, 8, 8, B.METAL_RUST, B.METAL_SHEET_DARK);
    sawtooth(c, 0, 0, 11, 8, 8, 4, B.METAL_SHEET_DARK);
    for (let x = 1; x < 10; x++) if (x % 3 !== 0) win(c, x, 5, 7, 0.4);
    loadingDoor(c, 4, 7, 7, 5);
    // blast furnace
    tank(c, 13.5, 4.5, 2.5, 1, 16, B.METAL_RUST, B.METAL_SHEET_DARK);
    cyl(b, 13.5, 4.5, 1.2, 17, 20, B.PIPE);
    for (let x = 10; x <= 13; x++) b.set(x, 18, 4, B.PIPE);
    pipeY(c, 10, 9, 18, 4);
    const top = rng.int(36, 46);
    smokestack(c, 13, 11, 1.5, 1, top, 1.0);
    smokestack(c, 9, 12, 1.0, 1, top - rng.int(4, 10), rng.range(0.7, 0.9));
    // container stacks at the street side
    for (let i = 0; i < 3; i++) {
      const lv = rng.int(1, 3);
      for (let l = 0; l < lv; l++) containerX(c, 0, 10 + i * 2, 1 + l * 2, 6, rng.pick(CONTAINERS));
    }
    hazardRowX(c, 0, 16, 15);
  },
  // Refinery: squat storage tanks, distillation columns with platforms, flare stack, pipe racks.
  (c) => {
    const { b, rng } = c;
    yard(c, B.CONCRETE);
    const tanks: Array<[number, number]> = [
      [3.5, 3.5],
      [3.5, 10],
      [9.5, 3.5],
    ];
    for (const [x, z] of tanks) tank(c, x, z, 3, 1, rng.int(5, 8), rng.chance(0.5) ? B.TANK_WHITE : B.TANK_SILVER, B.HAZARD_YELLOW);
    // two distillation columns
    const cols: Array<[number, number, number]> = [
      [10, 10, rng.int(22, 30)],
      [13, 10, rng.int(16, 22)],
    ];
    for (const [x, z, h] of cols) {
      cyl(b, x, z, 1.2, 1, h, B.TANK_SILVER);
      for (let y = 6; y < h; y += 6) {
        for (let dx = -2; dx <= 1; dx++) {
          b.set(x + dx, y, z - 2, B.RAILING);
          b.set(x + dx, y, z + 1, B.RAILING);
        }
      }
      emit(c.emitters, x, h, z, 'steam', 0.3);
    }
    // flare stack
    const ft = rng.int(30, 40);
    for (let y = 1; y < ft; y++) b.set(14, y, 3, y % 6 === 0 ? B.SMOKESTACK_BAND : B.SMOKESTACK);
    b.set(14, ft, 3, B.BEACON_RED);
    emit(c.emitters, 14.5, ft + 1, 3.5, 'smoke', 0.8);
    // pipe racks at y = 4
    pipeX(c, 3, 14, 4, 7);
    pipeX(c, 3, 14, 5, 8);
    pipeZ(c, 3, 10, 4, 7);
    pipeZ(c, 3, 10, 4, 13);
    for (let x = 3; x <= 13; x += 5) pipeY(c, x, 1, 3, 7);
    // control room at the gate
    box(b, 0, 1, 13, 4, 4, 16, B.CONCRETE);
    box(b, 0, 4, 13, 4, 5, 16, B.ROOF_FLAT);
    for (let x = 0; x < 4; x++) win(c, x, 2, 15, 0.6);
    hazardRowX(c, 4, 16, 15);
  },
  // Logistics port: big warehouse, container stacks under a gantry crane, a stack for the boiler.
  (c) => {
    const { b, rng } = c;
    yard(c, B.ASPHALT);
    const siding = rng.pick(SIDING);
    // warehouse along the back
    sidingWall(c, 0, 1, 0, 16, 7, 6, siding, B.METAL_SHEET_DARK);
    for (let k = 0; k < 3; k++) for (let z = k; z < 6 - k; z++) for (let x = 0; x < 16; x++) b.set(x, 7 + k, z, B.ROOF_GRAY);
    for (let i = 0; i < 3; i++) loadingDoor(c, 2 + i * 5, 4 + i * 5, 5, 4);
    // container yard
    for (let x = 0; x < 16; x++) b.set(x, 0, 7, B.ROAD_LINE_YELLOW);
    for (let i = 0; i < 4; i++) {
      const lv = rng.int(1, 4);
      for (let l = 0; l < lv; l++) containerZ(c, 1 + i * 3, 8, 1 + l * 2, 6, rng.pick(CONTAINERS));
    }
    gantry(c, 0, 12, 8, 14, rng.int(11, 14));
    smokestack(c, 14, 10, 1.0, 1, rng.int(18, 24), 0.6);
    truck(c, 13, 12);
    hazardRowX(c, 0, 16, 15);
  },
];
