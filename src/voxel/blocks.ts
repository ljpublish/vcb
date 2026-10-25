/**
 * FROZEN CONTRACT — Block / voxel palette.
 * Owner: integrator. Module agents MUST NOT edit this file. If you need a new block,
 * reuse the closest existing one (there are plenty) and note it in your final report.
 *
 * Worker-safe: no DOM, no three.js, no imports. Imported by the meshing Web Worker.
 *
 * A voxel is a single byte (Uint8). 0 = AIR. 255 is reserved as STAMP_KEEP
 * (a "leave existing voxel unchanged" marker inside VoxelStamp data; never stored in the world).
 *
 * Colors are authored in sRGB hex and used AS-IS as vertex colors. The renderer runs a
 * "WYSIWYG" color pipeline (THREE.ColorManagement disabled + LinearSRGBColorSpace output,
 * see src/render/colorSetup.ts), so no sRGB<->linear conversion is ever needed.
 *
 * Emissive blocks carry an emissive color that the chunk material adds on top of the lit color,
 * scaled by sharedUniforms.uNight (0 at day, 1 at night). They look like their normal `color`
 * during the day.
 *
 * Id ranges (by convention, to keep things organised):
 *   1..15    terrain            16..31  vegetation          32..47  road & infrastructure
 *   48..55   zone lots          56..79  generic building    80..95  residential materials
 *   96..111  commercial         112..127 industrial         128..143 parks & misc
 */

/** A block id (0..254). */
export type BlockId = number;

/** Block ids. Use as `B.GRASS`. */
export const B = {
  AIR: 0,

  // ---- terrain (1..15) ----
  STONE: 1,
  DIRT: 2,
  GRASS: 3,
  GRASS_DARK: 4,
  GRASS_LIGHT: 5,
  SAND: 6,
  GRAVEL: 7,
  /** The only transparent block. Rendered in the transparent pass. */
  WATER: 8,
  CLAY: 9,
  ROCK: 10,
  SNOW: 11,
  BEDROCK: 12,

  // ---- vegetation (16..31) ----
  WOOD: 16,
  LEAVES: 17,
  LEAVES_DARK: 18,
  LEAVES_LIGHT: 19,
  LEAVES_AUTUMN: 20,
  LEAVES_PINK: 21,
  PINE: 22,
  BUSH: 23,
  HEDGE: 24,
  FLOWER_RED: 25,
  FLOWER_YELLOW: 26,
  FLOWER_WHITE: 27,
  FLOWER_PURPLE: 28,

  // ---- road & infrastructure (32..47) ----
  ASPHALT: 32,
  ASPHALT_DARK: 33,
  ROAD_LINE_WHITE: 34,
  ROAD_LINE_YELLOW: 35,
  SIDEWALK: 36,
  CURB: 37,
  CONCRETE: 38,
  CONCRETE_DARK: 39,
  METAL_POLE: 40,
  /** Emissive lamp head. */
  STREET_LAMP: 41,
  RAILING: 42,
  BRIDGE_STEEL: 43,

  // ---- zone lots (48..55): ground tint of zoned-but-undeveloped tiles ----
  LOT_RES: 48,
  LOT_RES_EDGE: 49,
  LOT_COM: 50,
  LOT_COM_EDGE: 51,
  LOT_IND: 52,
  LOT_IND_EDGE: 53,

  // ---- generic building (56..79) ----
  FOUNDATION: 56,
  /** Unlit window glass. */
  WINDOW: 57,
  /** Window that glows warm yellow at night (looks like WINDOW-ish glass by day). */
  WINDOW_LIT: 58,
  GLASS_BLUE: 59,
  GLASS_TEAL: 60,
  GLASS_DARK: 61,
  /** Curtain-wall glass that glows at night. */
  GLASS_LIT: 62,
  DOOR: 63,
  DOOR_GLASS: 64,
  ROOF_FLAT: 65,
  ROOF_RED: 66,
  ROOF_BROWN: 67,
  ROOF_GRAY: 68,
  ROOF_BLUE: 69,
  ROOF_GREEN: 70,
  AC_UNIT: 71,
  CHIMNEY: 72,
  ANTENNA: 73,
  /** Emissive red aircraft-warning light (tops of towers, chimneys, cranes). */
  BEACON_RED: 74,
  SCAFFOLD: 75,
  CRANE_YELLOW: 76,
  RUBBLE: 77,
  BOARDED: 78,
  SOLAR_PANEL: 79,

  // ---- residential materials (80..95) ----
  BRICK_RED: 80,
  BRICK_BROWN: 81,
  BRICK_TAN: 82,
  PLASTER_WHITE: 83,
  PLASTER_CREAM: 84,
  PLASTER_YELLOW: 85,
  PLASTER_PEACH: 86,
  PLASTER_BLUE: 87,
  PLASTER_MINT: 88,
  PLASTER_PINK: 89,
  WOOD_SIDING: 90,
  WOOD_PLANK: 91,
  WOOD_DARK: 92,
  FENCE_WHITE: 93,
  BALCONY: 94,

  // ---- commercial (96..111) ----
  COM_CONCRETE: 96,
  COM_PANEL: 97,
  COM_STEEL: 98,
  COM_MARBLE: 99,
  AWNING_RED: 100,
  AWNING_BLUE: 101,
  AWNING_GREEN: 102,
  AWNING_ORANGE: 103,
  /** Emissive shop signs. */
  SIGN_YELLOW: 104,
  SIGN_CYAN: 105,
  SIGN_MAGENTA: 106,
  SIGN_GREEN: 107,
  SIGN_WHITE: 108,
  HELIPAD: 109,
  HELIPAD_MARK: 110,

  // ---- industrial (112..127) ----
  METAL_SHEET: 112,
  METAL_SHEET_DARK: 113,
  METAL_RUST: 114,
  METAL_BLUE: 115,
  METAL_GREEN: 116,
  HAZARD_YELLOW: 117,
  HAZARD_BLACK: 118,
  SMOKESTACK: 119,
  SMOKESTACK_BAND: 120,
  TANK_WHITE: 121,
  TANK_SILVER: 122,
  PIPE: 123,
  CRATE: 124,
  CONTAINER_RED: 125,
  CONTAINER_BLUE: 126,
  CONTAINER_GREEN: 127,

  // ---- parks & misc (128..143) ----
  PARK_PATH: 128,
  BENCH_WOOD: 129,
  FOUNTAIN_STONE: 130,
  PLAY_RED: 131,
  PLAY_BLUE: 132,
  STATUE: 133,
} as const;

export type BlockName = keyof typeof B;

/** Reserved voxel value used only inside VoxelStamp data: "do not modify the world voxel here". */
export const STAMP_KEEP = 255;

/** Highest usable block id (inclusive). 255 is STAMP_KEEP. */
export const MAX_BLOCK_ID = 254;

/** Static definition of one block type. */
export interface BlockDef {
  readonly id: BlockId;
  readonly name: BlockName;
  /** sRGB 0xRRGGBB, used as-is as vertex color. */
  readonly color: number;
  /** Optional emissive sRGB 0xRRGGBB, added at night (scaled by uNight). 0/undefined = none. */
  readonly emissive?: number;
  /** Transparent blocks (only WATER) go to the transparent mesh pass and do not occlude/AO. */
  readonly transparent?: boolean;
  /** If true the block does not darken neighbours via ambient occlusion (lamps, flowers, glass signs). */
  readonly noAO?: boolean;
}

const DEFS: readonly BlockDef[] = [
  // terrain
  { id: B.STONE, name: 'STONE', color: 0x8a8d91 },
  { id: B.DIRT, name: 'DIRT', color: 0x8b5e3c },
  { id: B.GRASS, name: 'GRASS', color: 0x6aa84f },
  { id: B.GRASS_DARK, name: 'GRASS_DARK', color: 0x5b9443 },
  { id: B.GRASS_LIGHT, name: 'GRASS_LIGHT', color: 0x7fbf5a },
  { id: B.SAND, name: 'SAND', color: 0xe3d197 },
  { id: B.GRAVEL, name: 'GRAVEL', color: 0x9a958a },
  { id: B.WATER, name: 'WATER', color: 0x3b8fd9, transparent: true, noAO: true },
  { id: B.CLAY, name: 'CLAY', color: 0xb07a56 },
  { id: B.ROCK, name: 'ROCK', color: 0x6e7073 },
  { id: B.SNOW, name: 'SNOW', color: 0xf4f7fa },
  { id: B.BEDROCK, name: 'BEDROCK', color: 0x4a4c50 },

  // vegetation
  { id: B.WOOD, name: 'WOOD', color: 0x7a5232 },
  { id: B.LEAVES, name: 'LEAVES', color: 0x4c9a3f },
  { id: B.LEAVES_DARK, name: 'LEAVES_DARK', color: 0x3a7d34 },
  { id: B.LEAVES_LIGHT, name: 'LEAVES_LIGHT', color: 0x6fb84a },
  { id: B.LEAVES_AUTUMN, name: 'LEAVES_AUTUMN', color: 0xd9822b },
  { id: B.LEAVES_PINK, name: 'LEAVES_PINK', color: 0xf0a3c4 },
  { id: B.PINE, name: 'PINE', color: 0x2f6b3a },
  { id: B.BUSH, name: 'BUSH', color: 0x4f8f3a },
  { id: B.HEDGE, name: 'HEDGE', color: 0x3f7f37 },
  { id: B.FLOWER_RED, name: 'FLOWER_RED', color: 0xe04646, noAO: true },
  { id: B.FLOWER_YELLOW, name: 'FLOWER_YELLOW', color: 0xf2d43c, noAO: true },
  { id: B.FLOWER_WHITE, name: 'FLOWER_WHITE', color: 0xf5f5f0, noAO: true },
  { id: B.FLOWER_PURPLE, name: 'FLOWER_PURPLE', color: 0x9b6fd6, noAO: true },

  // road & infrastructure
  { id: B.ASPHALT, name: 'ASPHALT', color: 0x44474d },
  { id: B.ASPHALT_DARK, name: 'ASPHALT_DARK', color: 0x36383d },
  { id: B.ROAD_LINE_WHITE, name: 'ROAD_LINE_WHITE', color: 0xeeeeee },
  { id: B.ROAD_LINE_YELLOW, name: 'ROAD_LINE_YELLOW', color: 0xf0c419 },
  { id: B.SIDEWALK, name: 'SIDEWALK', color: 0xbdb8ad },
  { id: B.CURB, name: 'CURB', color: 0x9e998f },
  { id: B.CONCRETE, name: 'CONCRETE', color: 0xb3b3ad },
  { id: B.CONCRETE_DARK, name: 'CONCRETE_DARK', color: 0x7c7d7a },
  { id: B.METAL_POLE, name: 'METAL_POLE', color: 0x5a5e63 },
  { id: B.STREET_LAMP, name: 'STREET_LAMP', color: 0xfff1c2, emissive: 0xffd27a, noAO: true },
  { id: B.RAILING, name: 'RAILING', color: 0xc9ccd0 },
  { id: B.BRIDGE_STEEL, name: 'BRIDGE_STEEL', color: 0xb8492f },

  // zone lots
  { id: B.LOT_RES, name: 'LOT_RES', color: 0x9fd486 },
  { id: B.LOT_RES_EDGE, name: 'LOT_RES_EDGE', color: 0x55b04a },
  { id: B.LOT_COM, name: 'LOT_COM', color: 0x9ec3e6 },
  { id: B.LOT_COM_EDGE, name: 'LOT_COM_EDGE', color: 0x3f86d1 },
  { id: B.LOT_IND, name: 'LOT_IND', color: 0xe6d08a },
  { id: B.LOT_IND_EDGE, name: 'LOT_IND_EDGE', color: 0xd1a12e },

  // generic building
  { id: B.FOUNDATION, name: 'FOUNDATION', color: 0x8f8b82 },
  { id: B.WINDOW, name: 'WINDOW', color: 0x5d7fa3 },
  { id: B.WINDOW_LIT, name: 'WINDOW_LIT', color: 0x6d8fb3, emissive: 0xffd88a },
  { id: B.GLASS_BLUE, name: 'GLASS_BLUE', color: 0x4d84c4 },
  { id: B.GLASS_TEAL, name: 'GLASS_TEAL', color: 0x46a6a8 },
  { id: B.GLASS_DARK, name: 'GLASS_DARK', color: 0x2f3e52 },
  { id: B.GLASS_LIT, name: 'GLASS_LIT', color: 0x5592cf, emissive: 0xffe6a8 },
  { id: B.DOOR, name: 'DOOR', color: 0x6b4226 },
  { id: B.DOOR_GLASS, name: 'DOOR_GLASS', color: 0x87b5d8, emissive: 0xffe3a0 },
  { id: B.ROOF_FLAT, name: 'ROOF_FLAT', color: 0x6f7275 },
  { id: B.ROOF_RED, name: 'ROOF_RED', color: 0xb5443a },
  { id: B.ROOF_BROWN, name: 'ROOF_BROWN', color: 0x7d4f35 },
  { id: B.ROOF_GRAY, name: 'ROOF_GRAY', color: 0x5f666e },
  { id: B.ROOF_BLUE, name: 'ROOF_BLUE', color: 0x4b6a8f },
  { id: B.ROOF_GREEN, name: 'ROOF_GREEN', color: 0x527d5a },
  { id: B.AC_UNIT, name: 'AC_UNIT', color: 0xc3c7cb },
  { id: B.CHIMNEY, name: 'CHIMNEY', color: 0x8a4b3d },
  { id: B.ANTENNA, name: 'ANTENNA', color: 0xb0b4b8 },
  { id: B.BEACON_RED, name: 'BEACON_RED', color: 0xd92020, emissive: 0xff3030, noAO: true },
  { id: B.SCAFFOLD, name: 'SCAFFOLD', color: 0xc9963a },
  { id: B.CRANE_YELLOW, name: 'CRANE_YELLOW', color: 0xf2b705 },
  { id: B.RUBBLE, name: 'RUBBLE', color: 0x837b70 },
  { id: B.BOARDED, name: 'BOARDED', color: 0x7b6650 },
  { id: B.SOLAR_PANEL, name: 'SOLAR_PANEL', color: 0x27365a },

  // residential materials
  { id: B.BRICK_RED, name: 'BRICK_RED', color: 0xa8513f },
  { id: B.BRICK_BROWN, name: 'BRICK_BROWN', color: 0x80503a },
  { id: B.BRICK_TAN, name: 'BRICK_TAN', color: 0xc9a27a },
  { id: B.PLASTER_WHITE, name: 'PLASTER_WHITE', color: 0xf0ebe0 },
  { id: B.PLASTER_CREAM, name: 'PLASTER_CREAM', color: 0xeadcb8 },
  { id: B.PLASTER_YELLOW, name: 'PLASTER_YELLOW', color: 0xf0d278 },
  { id: B.PLASTER_PEACH, name: 'PLASTER_PEACH', color: 0xf2b98f },
  { id: B.PLASTER_BLUE, name: 'PLASTER_BLUE', color: 0xa9c4de },
  { id: B.PLASTER_MINT, name: 'PLASTER_MINT', color: 0xa8d8bf },
  { id: B.PLASTER_PINK, name: 'PLASTER_PINK', color: 0xeeb1b5 },
  { id: B.WOOD_SIDING, name: 'WOOD_SIDING', color: 0xc8a77d },
  { id: B.WOOD_PLANK, name: 'WOOD_PLANK', color: 0xa47b4f },
  { id: B.WOOD_DARK, name: 'WOOD_DARK', color: 0x5e4129 },
  { id: B.FENCE_WHITE, name: 'FENCE_WHITE', color: 0xf4f4f0 },
  { id: B.BALCONY, name: 'BALCONY', color: 0xd5d7d9 },

  // commercial
  { id: B.COM_CONCRETE, name: 'COM_CONCRETE', color: 0xd9d6cf },
  { id: B.COM_PANEL, name: 'COM_PANEL', color: 0xc8b89a },
  { id: B.COM_STEEL, name: 'COM_STEEL', color: 0x9aa4ae },
  { id: B.COM_MARBLE, name: 'COM_MARBLE', color: 0xe8e4dc },
  { id: B.AWNING_RED, name: 'AWNING_RED', color: 0xd9473b },
  { id: B.AWNING_BLUE, name: 'AWNING_BLUE', color: 0x3b7bd9 },
  { id: B.AWNING_GREEN, name: 'AWNING_GREEN', color: 0x3ba65a },
  { id: B.AWNING_ORANGE, name: 'AWNING_ORANGE', color: 0xf08a2c },
  { id: B.SIGN_YELLOW, name: 'SIGN_YELLOW', color: 0xf5d23a, emissive: 0xffe066, noAO: true },
  { id: B.SIGN_CYAN, name: 'SIGN_CYAN', color: 0x3fd9e6, emissive: 0x66f0ff, noAO: true },
  { id: B.SIGN_MAGENTA, name: 'SIGN_MAGENTA', color: 0xe64fb6, emissive: 0xff66cc, noAO: true },
  { id: B.SIGN_GREEN, name: 'SIGN_GREEN', color: 0x52d968, emissive: 0x77ff88, noAO: true },
  { id: B.SIGN_WHITE, name: 'SIGN_WHITE', color: 0xf2f2f2, emissive: 0xffffff, noAO: true },
  { id: B.HELIPAD, name: 'HELIPAD', color: 0x4b4e53 },
  { id: B.HELIPAD_MARK, name: 'HELIPAD_MARK', color: 0xf2f2f2 },

  // industrial
  { id: B.METAL_SHEET, name: 'METAL_SHEET', color: 0x9aa0a6 },
  { id: B.METAL_SHEET_DARK, name: 'METAL_SHEET_DARK', color: 0x6d7379 },
  { id: B.METAL_RUST, name: 'METAL_RUST', color: 0xa35d3a },
  { id: B.METAL_BLUE, name: 'METAL_BLUE', color: 0x4f6f94 },
  { id: B.METAL_GREEN, name: 'METAL_GREEN', color: 0x5b7f5f },
  { id: B.HAZARD_YELLOW, name: 'HAZARD_YELLOW', color: 0xf2c12e },
  { id: B.HAZARD_BLACK, name: 'HAZARD_BLACK', color: 0x2b2b2b },
  { id: B.SMOKESTACK, name: 'SMOKESTACK', color: 0xb8b2a8 },
  { id: B.SMOKESTACK_BAND, name: 'SMOKESTACK_BAND', color: 0xc23b30 },
  { id: B.TANK_WHITE, name: 'TANK_WHITE', color: 0xe6e6e1 },
  { id: B.TANK_SILVER, name: 'TANK_SILVER', color: 0xb9bec4 },
  { id: B.PIPE, name: 'PIPE', color: 0x8e9399 },
  { id: B.CRATE, name: 'CRATE', color: 0xb08850 },
  { id: B.CONTAINER_RED, name: 'CONTAINER_RED', color: 0xb83a2e },
  { id: B.CONTAINER_BLUE, name: 'CONTAINER_BLUE', color: 0x2e5fb8 },
  { id: B.CONTAINER_GREEN, name: 'CONTAINER_GREEN', color: 0x2e8f4a },

  // parks & misc
  { id: B.PARK_PATH, name: 'PARK_PATH', color: 0xd8c9a0 },
  { id: B.BENCH_WOOD, name: 'BENCH_WOOD', color: 0x8a5f3a },
  { id: B.FOUNTAIN_STONE, name: 'FOUNTAIN_STONE', color: 0xc7c2b8 },
  { id: B.PLAY_RED, name: 'PLAY_RED', color: 0xe04a3a },
  { id: B.PLAY_BLUE, name: 'PLAY_BLUE', color: 0x3a7ae0 },
  { id: B.STATUE, name: 'STATUE', color: 0x9c7a4a },
];

/** All defined blocks (excluding AIR), in id order. */
export const BLOCK_DEFS: readonly BlockDef[] = [...DEFS].sort((a, b) => a.id - b.id);

/** Color used for ids that have no definition (makes mistakes obvious). */
export const UNKNOWN_BLOCK_COLOR = 0xff00ff;

// ---- flag bits in BLOCK_FLAGS ----
/** Non-air (has geometry). */
export const FLAG_SOLID = 1;
/** Transparent pass (WATER). */
export const FLAG_TRANSPARENT = 2;
/** Has an emissive color. */
export const FLAG_EMISSIVE = 4;
/** Opaque solid: hides neighbour faces. (= SOLID and not TRANSPARENT) */
export const FLAG_OPAQUE = 8;
/** Contributes to ambient occlusion of neighbouring faces (= OPAQUE and not noAO). */
export const FLAG_AO = 16;

/** Per-id flag bits (length 256). */
export const BLOCK_FLAGS: Uint8Array = new Uint8Array(256);
/** Per-id sRGB color as bytes, 3 per id (r,g,b) (length 768). */
export const BLOCK_RGB: Uint8Array = new Uint8Array(256 * 3);
/** Per-id emissive sRGB color as bytes, 3 per id (length 768). All zero for non-emissive. */
export const BLOCK_EMISSIVE_RGB: Uint8Array = new Uint8Array(256 * 3);
/** Per-id 0xRRGGBB color (length 256). */
export const BLOCK_COLOR: Uint32Array = new Uint32Array(256);

const NAME_BY_ID: string[] = new Array<string>(256).fill('');

(function buildTables(): void {
  // Undefined ids 1..254 render as solid magenta so bugs are visible.
  for (let id = 1; id <= MAX_BLOCK_ID; id++) {
    BLOCK_FLAGS[id] = FLAG_SOLID | FLAG_OPAQUE | FLAG_AO;
    BLOCK_COLOR[id] = UNKNOWN_BLOCK_COLOR;
    NAME_BY_ID[id] = `UNKNOWN_${id}`;
  }
  BLOCK_FLAGS[0] = 0;
  BLOCK_COLOR[0] = 0;
  NAME_BY_ID[0] = 'AIR';
  BLOCK_FLAGS[STAMP_KEEP] = 0;
  NAME_BY_ID[STAMP_KEEP] = 'STAMP_KEEP';

  for (const d of BLOCK_DEFS) {
    let f = FLAG_SOLID;
    if (d.transparent) f |= FLAG_TRANSPARENT;
    else f |= FLAG_OPAQUE;
    if (d.emissive) f |= FLAG_EMISSIVE;
    if (!d.transparent && !d.noAO) f |= FLAG_AO;
    BLOCK_FLAGS[d.id] = f;
    BLOCK_COLOR[d.id] = d.color;
    NAME_BY_ID[d.id] = d.name;
  }
  for (let id = 0; id < 256; id++) {
    const c = BLOCK_COLOR[id];
    BLOCK_RGB[id * 3] = (c >> 16) & 255;
    BLOCK_RGB[id * 3 + 1] = (c >> 8) & 255;
    BLOCK_RGB[id * 3 + 2] = c & 255;
  }
  for (const d of BLOCK_DEFS) {
    const e = d.emissive ?? 0;
    BLOCK_EMISSIVE_RGB[d.id * 3] = (e >> 16) & 255;
    BLOCK_EMISSIVE_RGB[d.id * 3 + 1] = (e >> 8) & 255;
    BLOCK_EMISSIVE_RGB[d.id * 3 + 2] = e & 255;
  }
})();

/** Non-air block (has faces). */
export function isSolid(id: BlockId): boolean {
  return (BLOCK_FLAGS[id & 255] & FLAG_SOLID) !== 0;
}
/** Opaque solid (hides neighbour faces, never WATER). */
export function isOpaque(id: BlockId): boolean {
  return (BLOCK_FLAGS[id & 255] & FLAG_OPAQUE) !== 0;
}
/** Transparent-pass block (WATER). */
export function isTransparent(id: BlockId): boolean {
  return (BLOCK_FLAGS[id & 255] & FLAG_TRANSPARENT) !== 0;
}
/** Has an emissive (night glow) color. */
export function isEmissive(id: BlockId): boolean {
  return (BLOCK_FLAGS[id & 255] & FLAG_EMISSIVE) !== 0;
}
/** Contributes to ambient occlusion. */
export function castsAO(id: BlockId): boolean {
  return (BLOCK_FLAGS[id & 255] & FLAG_AO) !== 0;
}
/** Debug name of a block id. */
export function blockName(id: BlockId): string {
  return NAME_BY_ID[id & 255];
}
