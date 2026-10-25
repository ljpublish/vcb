/**
 * MODULE: buildings — civic building generators (module-internal API; may change).
 * Owner: buildings agent (civic/parks). Follows the rules in buildingGen.ts: deterministic from
 * `variant`, authored with the front facing +Z (the sidewalk edge is z = S-1), layer y = 0 is the
 * ground surface layer, structure from y = 1, never writes outside the footprint.
 *
 * NOT YET WIRED: the frozen contract (src/types.ts) has no civic tile kind / tool / sim effect yet.
 * These generators are ready for structureSync once a Civic kind is added.
 */
import { Rng } from '../../core/rng';
import { B, type BlockId } from '../../voxel/blocks';
import { TILE_SIZE, type BuildingSize, type Dir } from '../../types';
import type { GeneratedStructure, LocalEmitter } from '../buildingGen';
import { emit, ground } from '../parts';
import { rotatePoint, StampBuilder } from '../stamp';
import { flag, leafyTree as tree, windows } from './kit';

export type CivicKind = 'town_hall' | 'police' | 'fire' | 'school' | 'hospital';
export const CIVIC_KINDS: readonly CivicKind[] = ['town_hall', 'police', 'fire', 'school', 'hospital'];

/** Footprint in tiles per civic kind. */
export const CIVIC_SIZE: Readonly<Record<CivicKind, BuildingSize>> = {
  town_hall: 2,
  police: 1,
  fire: 1,
  school: 2,
  hospital: 2,
};

export interface CivicSpec {
  kind: CivicKind;
  facing: Dir;
  variant: number;
}

const H = 32;

/** Generate a civic building stamp. `groundHeight` = terrain.getTileHeight of the footprint. */
export function generateCivic(spec: CivicSpec, groundHeight: number): GeneratedStructure {
  const S = CIVIC_SIZE[spec.kind] * TILE_SIZE;
  const s = new StampBuilder(S, H, S);
  const rng = new Rng(spec.variant >>> 0);
  const emitters: LocalEmitter[] = [];
  const seed = spec.variant >>> 0;
  switch (spec.kind) {
    case 'town_hall': townHall(s, rng, seed); break;
    case 'police': police(s, rng, seed); break;
    case 'fire': fireStation(s, rng, seed); break;
    case 'school': school(s, rng, seed); break;
    case 'hospital': hospital(s, rng, seed, emitters); break;
  }
  for (const e of emitters) [e.x, e.z] = rotatePoint(e.x, e.z, S, spec.facing);
  return { stamp: s.rotateY(spec.facing).toStamp(), originY: groundHeight - 1, emitters };
}

// ------------------------------------------------------------------------------------------------
// Town hall (2×2): plinth, columned portico with pediment, central drum + dome, clock, flags.

function townHall(s: StampBuilder, rng: Rng, seed: number): void {
  const wall = rng.pick([B.PLASTER_CREAM, B.BRICK_TAN, B.PLASTER_WHITE] as const);
  const dome = rng.pick([B.ROOF_GREEN, B.ROOF_BLUE, B.ROOF_GRAY] as const);
  const clothA = rng.pick([B.AWNING_RED, B.AWNING_BLUE] as const);
  const clothB = rng.pick([B.AWNING_GREEN, B.AWNING_ORANGE, B.AWNING_RED] as const);

  ground(s, B.GRASS_LIGHT);
  s.fill(0, 0, 12, 16, 1, 16, B.SIDEWALK); // front plaza
  s.fill(6, 0, 13, 10, 1, 16, B.CONCRETE); // forecourt
  // hedges framing the lawn, flower beds by the plaza
  s.fill(0, 1, 0, 1, 2, 12, B.HEDGE);
  s.fill(15, 1, 0, 16, 2, 12, B.HEDGE);
  s.fill(1, 0, 13, 5, 1, 15, B.DIRT);
  s.fill(11, 0, 13, 15, 1, 15, B.DIRT);
  for (let x = 1; x < 5; x++) { s.set(x, 1, 13, B.FLOWER_RED); s.set(x, 1, 14, B.FLOWER_YELLOW); }
  for (let x = 11; x < 15; x++) { s.set(x, 1, 13, B.FLOWER_YELLOW); s.set(x, 1, 14, B.FLOWER_RED); }

  // plinth + front steps
  s.fill(2, 1, 2, 14, 2, 12, B.CONCRETE);
  s.fill(5, 1, 12, 11, 2, 13, B.CONCRETE);
  // main body, two tall floors
  s.fill(3, 2, 3, 13, 8, 10, wall);
  windows(s, 3, 3, 13, 10, 2, 2, seed, 2);
  s.fill(3, 8, 3, 13, 9, 10, B.COM_MARBLE); // cornice
  s.fill(4, 9, 4, 12, 10, 9, B.ROOF_FLAT);
  // portico: columns + entablature + stepped pediment
  for (const x of [4, 6, 9, 11]) s.fill(x, 2, 11, x + 1, 8, 12, B.COM_MARBLE);
  s.fill(4, 2, 10, 12, 3, 12, B.COM_MARBLE);
  s.fill(3, 8, 10, 13, 9, 12, B.COM_MARBLE);
  s.fill(4, 9, 11, 12, 10, 12, wall);
  s.fill(6, 10, 11, 10, 11, 12, wall);
  s.fill(3, 9, 10, 13, 10, 11, B.COM_MARBLE);
  s.fill(5, 10, 10, 11, 11, 11, B.COM_MARBLE);
  s.fill(7, 11, 10, 9, 12, 11, B.COM_MARBLE);
  // entrance
  s.fill(7, 3, 9, 9, 6, 10, B.DOOR_GLASS);
  // drum + dome
  s.fill(5, 10, 4, 11, 13, 10, B.COM_MARBLE);
  windows(s, 5, 4, 11, 10, 10, 1, seed ^ 0x51, 2, B.GLASS_BLUE, B.GLASS_LIT);
  s.set(7, 11, 9, B.SIGN_WHITE); s.set(8, 11, 9, B.SIGN_WHITE); // clock face
  s.fill(5, 13, 5, 11, 14, 9, dome);
  s.fill(6, 13, 4, 10, 14, 10, dome);
  s.fill(6, 14, 5, 10, 15, 9, dome);
  s.fill(7, 15, 6, 9, 16, 8, dome);
  s.fill(7, 16, 7, 8, 18, 8, B.METAL_POLE);
  s.set(7, 18, 7, B.BEACON_RED);
  // flags and trees
  flag(s, 1, 1, 12, 7, clothA);
  flag(s, 13, 1, 12, 7, clothB);
  tree(s, 2, 1, 1, B.LEAVES, 4);
  tree(s, 13, 1, 1, B.LEAVES_DARK, 4);
}

// ------------------------------------------------------------------------------------------------
// Police station (1×1): blue-trimmed two-storey block, lit sign, roof antenna + light bar, cruisers.

function police(s: StampBuilder, rng: Rng, seed: number): void {
  const wall = rng.pick([B.PLASTER_WHITE, B.PLASTER_BLUE, B.CONCRETE] as const);
  ground(s, B.GRASS);
  s.fill(0, 0, 5, 8, 1, 8, B.ASPHALT);
  s.fill(4, 0, 5, 5, 1, 8, B.ROAD_LINE_WHITE);
  s.fill(0, 0, 4, 8, 1, 5, B.SIDEWALK);

  s.fill(1, 1, 0, 7, 7, 4, wall);
  s.fill(1, 1, 0, 7, 2, 4, B.METAL_BLUE); // base band
  s.fill(1, 4, 0, 7, 5, 4, B.METAL_BLUE); // floor band
  windows(s, 1, 0, 7, 4, 4, 1, seed, 2);
  s.fill(3, 1, 3, 5, 3, 4, B.DOOR_GLASS);
  s.fill(2, 3, 3, 6, 4, 4, B.SIGN_WHITE); // "POLICE" board
  s.set(2, 3, 3, B.SIGN_CYAN);
  s.set(5, 3, 3, B.SIGN_CYAN);
  // roof
  s.fill(1, 7, 0, 7, 8, 4, B.ROOF_FLAT);
  s.walls(1, 8, 0, 7, 9, 4, B.CONCRETE_DARK);
  s.set(4, 8, 1, B.AC_UNIT);
  s.fill(2, 8, 1, 3, 13, 2, B.ANTENNA);
  s.set(2, 13, 1, B.BEACON_RED);
  // cruisers
  car(s, 1, B.PLASTER_WHITE, B.SIGN_CYAN, B.BEACON_RED);
  if (rng.chance(0.7)) car(s, 5, B.METAL_BLUE, B.BEACON_RED, B.SIGN_CYAN);
  // flag + shrub
  flag(s, 0, 1, 3, 6, B.AWNING_BLUE);
  s.set(7, 1, 3, B.BUSH);
}

/** 2-wide, 3-long car parked nose-out at x, z ∈ [5,8). */
function car(s: StampBuilder, x: number, body: BlockId, lightA: BlockId, lightB: BlockId): void {
  s.fill(x, 1, 5, x + 2, 2, 8, body);
  s.fill(x, 2, 6, x + 2, 3, 7, B.GLASS_DARK);
  s.set(x, 3, 6, lightA);
  s.set(x + 1, 3, 6, lightB);
}

// ------------------------------------------------------------------------------------------------
// Fire station (1×1): red brick hall with two roller doors, hose-drying tower, engine on the apron.

function fireStation(s: StampBuilder, rng: Rng, seed: number): void {
  const brick = rng.pick([B.BRICK_RED, B.BRICK_RED, B.BRICK_BROWN] as const);
  ground(s, B.GRASS);
  s.fill(0, 0, 5, 7, 1, 8, B.CONCRETE);
  for (let x = 0; x < 7; x += 2) s.set(x, 0, 7, B.HAZARD_YELLOW);

  // hall
  s.fill(0, 1, 0, 7, 7, 5, brick);
  s.fill(1, 1, 4, 3, 4, 5, B.METAL_SHEET); // roller doors
  s.fill(4, 1, 4, 6, 4, 5, B.METAL_SHEET);
  for (let x = 1; x < 6; x++) if (x !== 3) s.set(x, 3, 4, B.METAL_SHEET_DARK);
  s.fill(1, 4, 4, 6, 5, 5, B.SIGN_WHITE); // station number board
  windows(s, 0, 0, 7, 5, 4, 1, seed, 2);
  s.fill(0, 7, 0, 7, 8, 5, B.ROOF_FLAT);
  s.walls(0, 8, 0, 7, 9, 5, brick);
  s.set(3, 9, 2, B.BEACON_RED);
  // hose tower
  s.fill(6, 1, 0, 8, 12, 2, brick);
  for (let y = 3; y < 12; y += 3) { s.set(6, y, 1, B.WINDOW); s.set(7, y, 1, B.WINDOW_LIT); }
  s.fill(6, 12, 0, 8, 13, 2, B.ROOF_GRAY);
  s.fill(7, 13, 0, 8, 15, 1, B.METAL_POLE);
  // engine, nose out of the left bay
  s.fill(1, 1, 5, 3, 3, 8, B.AWNING_RED);
  s.fill(1, 2, 7, 3, 3, 8, B.GLASS_DARK);
  s.fill(1, 3, 5, 3, 4, 7, B.METAL_POLE); // ladder
  s.set(1, 3, 7, B.BEACON_RED);
  s.set(2, 3, 7, B.BEACON_RED);
  // hydrant
  s.set(7, 1, 4, B.AWNING_RED);
}

// ------------------------------------------------------------------------------------------------
// School (2×2): L-shaped brick building with pitched roofs and bell cupola, sports court, playground.

function school(s: StampBuilder, rng: Rng, seed: number): void {
  const brick = rng.pick([B.BRICK_TAN, B.BRICK_RED, B.PLASTER_CREAM] as const);
  const roof = rng.pick([B.ROOF_RED, B.ROOF_BROWN, B.ROOF_GRAY] as const);
  ground(s, B.GRASS_LIGHT);

  // main wing along x, wing along z
  s.fill(1, 1, 1, 15, 7, 6, brick);
  s.fill(1, 1, 6, 6, 7, 12, brick);
  windows(s, 1, 1, 15, 6, 1, 2, seed, 2);
  windows(s, 1, 6, 6, 12, 1, 2, seed ^ 0x77, 2);
  s.fill(1, 1, 1, 15, 2, 6, B.CONCRETE_DARK);
  s.fill(1, 1, 6, 6, 2, 12, B.CONCRETE_DARK);
  for (let k = 0; k < 3; k++) {
    s.fill(1, 7 + k, 1 + k, 15, 8 + k, 6 - k, roof);
    s.fill(1 + k, 7 + k, 6, 6 - k, 8 + k, 12, roof);
  }
  // entrance at the end of the wing
  s.fill(2, 2, 11, 5, 4, 12, B.DOOR_GLASS);
  s.fill(2, 4, 12, 5, 5, 13, B.CONCRETE); // canopy
  // bell cupola
  s.fill(9, 10, 3, 11, 12, 4, B.PLASTER_WHITE);
  s.set(9, 11, 3, B.SIGN_WHITE);
  s.fill(9, 12, 3, 11, 13, 4, roof);

  // path to the street
  s.fill(2, 0, 12, 5, 1, 16, B.PARK_PATH);
  // sports court
  s.fill(7, 0, 7, 15, 1, 15, B.CONCRETE);
  s.walls(7, 0, 7, 15, 1, 15, B.ROAD_LINE_WHITE);
  s.fill(7, 0, 11, 15, 1, 12, B.ROAD_LINE_WHITE);
  for (const z of [7, 14]) { s.fill(11, 1, z, 12, 4, z + 1, B.METAL_POLE); s.set(11, 4, z, B.SIGN_WHITE); }
  // playground
  s.fill(0, 0, 13, 2, 1, 16, B.SAND);
  s.fill(0, 1, 13, 1, 4, 14, B.PLAY_RED);
  s.fill(0, 1, 15, 1, 4, 16, B.PLAY_RED);
  s.fill(0, 4, 13, 1, 5, 16, B.PLAY_RED);
  s.fill(5, 1, 13, 6, 3, 14, B.PLAY_BLUE);
  s.set(5, 1, 14, B.PLAY_BLUE);
  // fence along the street and the east edge, gates at the path and court
  for (let x = 6; x < 16; x++) s.set(x, 1, 15, B.FENCE_WHITE);
  for (let z = 6; z < 16; z++) s.set(15, 1, z, B.FENCE_WHITE);
  s.set(10, 1, 15, B.AIR); s.set(11, 1, 15, B.AIR);
  flag(s, 6, 1, 13, 7, rng.pick([B.AWNING_BLUE, B.AWNING_GREEN] as const));
  tree(s, 13, 1, 3, B.LEAVES_LIGHT, 3);
}

// ------------------------------------------------------------------------------------------------
// Hospital (2×2): four-storey white block with glass bands, red cross, rooftop helipad, ER canopy.

function hospital(s: StampBuilder, rng: Rng, seed: number, emitters: LocalEmitter[]): void {
  const wall = rng.pick([B.PLASTER_WHITE, B.COM_PANEL, B.PLASTER_MINT] as const);
  ground(s, B.GRASS);
  s.fill(0, 0, 13, 16, 1, 16, B.ASPHALT); // drop-off loop
  s.fill(0, 0, 15, 16, 1, 16, B.SIDEWALK);
  s.fill(3, 0, 14, 13, 1, 15, B.ROAD_LINE_WHITE);
  s.fill(2, 0, 12, 14, 1, 13, B.SIDEWALK);

  // main block
  s.fill(2, 1, 2, 14, 13, 10, wall);
  for (let f = 0; f < 4; f++) {
    const y = 1 + f * 3 + 1;
    for (let x = 3; x < 13; x++) {
      s.set(x, y, 2, (x + f) % 3 ? B.GLASS_TEAL : B.GLASS_LIT);
      if (f < 2) continue;
      s.set(x, y, 9, (x * 7 + f) % 3 ? B.GLASS_TEAL : B.GLASS_LIT);
    }
    for (let z = 3; z < 9; z++) {
      s.set(2, y, z, (z + f) % 3 ? B.GLASS_TEAL : B.GLASS_LIT);
      s.set(13, y, z, (z + f + 1) % 3 ? B.GLASS_TEAL : B.GLASS_LIT);
    }
  }
  // red cross on the upper front face
  s.fill(7, 7, 9, 9, 13, 10, wall);
  s.fill(7, 8, 10, 9, 12, 11, B.BEACON_RED);
  s.fill(6, 9, 10, 10, 11, 11, B.BEACON_RED);
  // ER wing + canopy
  s.fill(3, 1, 10, 13, 5, 12, wall);
  windows(s, 3, 10, 13, 12, 1, 1, seed, 3, B.GLASS_TEAL, B.GLASS_LIT);
  s.fill(6, 1, 11, 10, 3, 12, B.DOOR_GLASS);
  s.fill(5, 4, 12, 11, 5, 15, B.CONCRETE);
  s.fill(5, 4, 14, 11, 5, 15, B.BEACON_RED);
  s.set(5, 1, 14, B.METAL_POLE); s.set(5, 2, 14, B.METAL_POLE); s.set(5, 3, 14, B.METAL_POLE);
  s.set(10, 1, 14, B.METAL_POLE); s.set(10, 2, 14, B.METAL_POLE); s.set(10, 3, 14, B.METAL_POLE);
  s.fill(3, 5, 10, 13, 6, 12, B.ROOF_FLAT);
  // roof: helipad, beacons, plant
  s.fill(2, 13, 2, 14, 14, 10, B.ROOF_FLAT);
  s.fill(4, 14, 3, 12, 15, 9, B.HELIPAD);
  s.fill(6, 14, 4, 7, 15, 8, B.HELIPAD_MARK);
  s.fill(9, 14, 4, 10, 15, 8, B.HELIPAD_MARK);
  s.fill(7, 14, 6, 9, 15, 7, B.HELIPAD_MARK);
  for (const [x, z] of [[4, 3], [11, 3], [4, 8], [11, 8]]) s.set(x, 15, z, B.BEACON_RED);
  s.fill(12, 14, 2, 14, 16, 4, B.AC_UNIT);
  emit(emitters, 13, 16, 3, 'steam', 0.3);
  // ambulance at the canopy
  s.fill(7, 1, 13, 9, 3, 16, B.PLASTER_WHITE);
  s.fill(7, 2, 15, 9, 3, 16, B.GLASS_DARK);
  s.set(7, 3, 14, B.BEACON_RED);
  s.set(8, 3, 14, B.SIGN_CYAN);
  // lawn trees
  if (rng.chance(0.9)) tree(s, 0 + 1, 1, 1, B.LEAVES, 3);
  tree(s, 14, 1, 11, B.LEAVES_DARK, 3);
  tree(s, 1, 1, 11, B.LEAVES_LIGHT, 3);
}
