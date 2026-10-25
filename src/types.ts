/**
 * FROZEN CONTRACT — shared types, constants and cross-module interfaces.
 * Owner: integrator. Module agents MUST NOT edit this file.
 *
 * Rules:
 *  - This file has NO runtime imports (only `import type`) and no side effects, so it is safe to
 *    import from the meshing Web Worker.
 *  - Every cross-module boundary in the game is one of the interfaces below. Modules depend on
 *    these interfaces, never on each other's concrete classes. Only src/game.ts (integrator)
 *    instantiates concrete classes.
 *  - Enum-like values are `as const` objects + same-named union types (no TS `enum`).
 *
 * Coordinate systems (see ARCHITECTURE.md §3):
 *  - Voxel space: integer (x, y, z), y up. Voxel (x,y,z) occupies the unit cube [x,x+1]×[y,y+1]×[z,z+1].
 *    1 voxel = 1 three.js world unit. World spans x∈[0,WORLD_SIZE_X), y∈[0,WORLD_HEIGHT), z∈[0,WORLD_SIZE_Z).
 *  - Tile (city grid) space: integer (tx, tz). Tile (tx,tz) covers voxel columns
 *    x∈[tx*TILE_SIZE, tx*TILE_SIZE+TILE_SIZE), z∈[tz*TILE_SIZE, tz*TILE_SIZE+TILE_SIZE).
 *    Tile index = tz * MAP_TILES + tx.
 *  - Directions: N = -Z, E = +X, S = +Z, W = -X.
 */
import type * as THREE from 'three';
import type { BlockId } from './voxel/blocks';
import type { GameBus } from './core/events';

export type { BlockId } from './voxel/blocks';
export type { GameBus, GameEvents } from './core/events';

// ============================================================================================
// 1. World geometry constants
// ============================================================================================

/** Voxels per tile edge. 1 tile = TILE_SIZE × TILE_SIZE voxel columns. */
export const TILE_SIZE = 8;
/** City grid is MAP_TILES × MAP_TILES tiles. Must be a multiple of CHUNK_SIZE / TILE_SIZE (= 4). */
export const MAP_TILES = 64;
/** Total number of tiles. */
export const TILE_COUNT = MAP_TILES * MAP_TILES;

/** Chunks are cubic, CHUNK_SIZE³ voxels. One chunk = 4×4 tiles horizontally. */
export const CHUNK_SIZE = 32;
/** log2(CHUNK_SIZE). */
export const CHUNK_SHIFT = 5;
/** CHUNK_SIZE - 1, for `x & CHUNK_MASK`. */
export const CHUNK_MASK = CHUNK_SIZE - 1;
/** Voxels per chunk. */
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

/** World extent in voxels. */
export const WORLD_SIZE_X = MAP_TILES * TILE_SIZE; // 512
export const WORLD_SIZE_Z = MAP_TILES * TILE_SIZE; // 512
export const WORLD_HEIGHT = 128;

/** World extent in chunks. */
export const CHUNKS_X = WORLD_SIZE_X / CHUNK_SIZE; // 16
export const CHUNKS_Y = WORLD_HEIGHT / CHUNK_SIZE; // 4
export const CHUNKS_Z = WORLD_SIZE_Z / CHUNK_SIZE; // 16
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z; // 1024

/** Padded chunk edge for meshing: the chunk plus a 1-voxel border on every side. */
export const PADDED_SIZE = CHUNK_SIZE + 2; // 34
export const PADDED_VOLUME = PADDED_SIZE * PADDED_SIZE * PADDED_SIZE; // 39304

/**
 * Water surface height. Water voxels fill y ∈ [bed, WATER_LEVEL-1]; the visible water top face is
 * at y = WATER_LEVEL.
 */
export const WATER_LEVEL = 10;
/** Ground height of the flat central plain (top face of grass at y = 12; top grass voxel at y = 11). */
export const BASE_GROUND_HEIGHT = 12;
/** Lowest ground height anywhere (deepest water bed). */
export const MIN_GROUND_HEIGHT = 4;
/** Highest ground height anywhere (hill tops). */
export const MAX_GROUND_HEIGHT = 36;
/** Road surface height on bridge (road-on-water) tiles: the deck's top face is at this y. */
export const BRIDGE_DECK_HEIGHT = WATER_LEVEL + 2; // 12
/** Max height (voxels) of any structure above its tile's ground height. */
export const MAX_STRUCTURE_HEIGHT = 80;

// ============================================================================================
// 2. Directions
// ============================================================================================

/** 0 = N (-Z), 1 = E (+X), 2 = S (+Z), 3 = W (-X). */
export type Dir = 0 | 1 | 2 | 3;
export const DIR_N: Dir = 0;
export const DIR_E: Dir = 1;
export const DIR_S: Dir = 2;
export const DIR_W: Dir = 3;
export const DIRS: readonly Dir[] = [0, 1, 2, 3];
/** Tile/voxel x step for each Dir. */
export const DIR_DX: readonly number[] = [0, 1, 0, -1];
/** Tile/voxel z step for each Dir. */
export const DIR_DZ: readonly number[] = [-1, 0, 1, 0];
/** Bit for each Dir in a 4-bit connectivity mask (road masks, lot edge masks). */
export const DIR_BIT: readonly number[] = [1, 2, 4, 8];

// ============================================================================================
// 3. Enum-like values
// ============================================================================================

/** What occupies a city tile. A building always sits on a `Zoned` tile. */
export const TileKind = {
  Empty: 0,
  Road: 1,
  Zoned: 2,
  Park: 3,
  /** Footprint tile of a civic service building (see CivicBuilding). */
  Civic: 4,
} as const;
export type TileKind = (typeof TileKind)[keyof typeof TileKind];

export const ZoneType = {
  None: 0,
  Residential: 1,
  Commercial: 2,
  Industrial: 3,
} as const;
export type ZoneType = (typeof ZoneType)[keyof typeof ZoneType];
/** A real zone (R, C or I). */
export type RCIZone = 1 | 2 | 3;

export const BuildingState = {
  /** Under construction; `stage` (0..CONSTRUCTION_STAGES-1) is the visual progress. */
  Constructing: 0,
  Active: 1,
  /** Abandoned (no road access, no demand, pollution …). Rendered dark/derelict, no lit windows. */
  Abandoned: 2,
} as const;
export type BuildingState = (typeof BuildingState)[keyof typeof BuildingState];

/** Density level: 1 = low, 2 = medium, 3 = high. */
export type BuildingLevel = 1 | 2 | 3;
/** Footprint edge in tiles. Level-3 buildings may be 2×2, everything else is 1×1. */
export type BuildingSize = 1 | 2;
/** Number of visual construction stages a Constructing building passes through. */
export const CONSTRUCTION_STAGES = 3;

/** 0 = paused, 1 = normal, 2 = fast, 3 = ultra. */
export type SimSpeed = 0 | 1 | 2 | 3;

/** Placeable civic service buildings (player-placed, not grown). Generators: src/build/civic/. */
export type CivicKind = 'town_hall' | 'police' | 'fire' | 'school' | 'hospital';
export const CIVIC_KINDS: readonly CivicKind[] = ['town_hall', 'police', 'fire', 'school', 'hospital'];
/** One tool per civic kind, e.g. 'civic_police'. */
export type CivicToolId = `civic_${CivicKind}`;

export type ToolId = 'select' | 'road' | 'zone_r' | 'zone_c' | 'zone_i' | 'park' | 'bulldoze' | CivicToolId;
export const TOOL_IDS: readonly ToolId[] = [
  'select', 'road', 'zone_r', 'zone_c', 'zone_i', 'park', 'bulldoze',
  'civic_town_hall', 'civic_police', 'civic_fire', 'civic_school', 'civic_hospital',
];
export function civicKindOfTool(tool: ToolId): CivicKind | null {
  return tool.startsWith('civic_') ? (tool.slice(6) as CivicKind) : null;
}

export interface CivicDef {
  label: string;
  /** Footprint edge in tiles. Must match CIVIC_SIZE in src/build/civic. */
  size: BuildingSize;
  /** One-off $ when placed. */
  cost: number;
  /** Monthly $ upkeep (BudgetReport.serviceUpkeep). */
  upkeep: number;
  /** Coverage radius in tiles (Chebyshev distance from the footprint). 0 = citywide. */
  radius: number;
  /** Max number of this kind in a city (0 = unlimited). */
  maxCount: number;
}

/**
 * Civic placement rules (validated by the simulation): every footprint tile must be in bounds,
 * dry land, Empty or decor-only, and the same terrain height; at least one footprint edge tile must be
 * next to a road (the building faces that road). Placing it clears decor. Bulldozing any footprint
 * tile removes the whole building (refund 0).
 *
 * Effects (applied by the simulation each tick; tuning may change but the meaning may not):
 *  - town_hall: citywide; +happiness, +10% tax income. Max 1.
 *  - police:    tiles in radius get +land value; without coverage, C/I buildings may abandon a bit more.
 *  - fire:      tiles in radius get +land value; uncovered buildings have a small chance to abandon.
 *  - school:    residential level 3 requires school coverage; +land value for R in radius.
 *  - hospital:  residential level >= 2 needs hospital coverage once population > 2000; +happiness.
 */
export const CIVIC_SPECS: Readonly<Record<CivicKind, CivicDef>> = {
  town_hall: { label: 'Town Hall', size: 2, cost: 3000, upkeep: 60, radius: 0, maxCount: 1 },
  police: { label: 'Police Station', size: 1, cost: 1200, upkeep: 40, radius: 12, maxCount: 0 },
  fire: { label: 'Fire Station', size: 1, cost: 1200, upkeep: 40, radius: 12, maxCount: 0 },
  school: { label: 'School', size: 2, cost: 2000, upkeep: 50, radius: 14, maxCount: 0 },
  hospital: { label: 'Hospital', size: 2, cost: 2500, upkeep: 70, radius: 16, maxCount: 0 },
};

/** Service coverage of a tile (or city average), each 0..1. */
export interface ServiceCoverage {
  police: number;
  fire: number;
  education: number;
  health: number;
}

/** Data overlays drawn on top of the terrain by the input module. */
export type OverlayMode = 'none' | 'landValue' | 'pollution' | 'roadAccess';

export type NotifyKind = 'info' | 'success' | 'warning' | 'error';

/** Why tiles changed (in 'tiles:changed'). */
export type ChangeCause = 'tool' | 'growth' | 'decay' | 'load';

export type EmitterKind = 'smoke' | 'steam' | 'fountain';

/** Per-tile flag bits in CitySnapshot.tileFlags / Simulation state. */
export const TILE_FLAG_DECOR = 1; // natural decoration (tree/flowers) still present on the tile
// bits 1..7 are reserved for the simulation module's private use (persisted verbatim).

// ============================================================================================
// 4. Simulation constants that other modules rely on
// ============================================================================================

/** Simulation ticks per real second for each SimSpeed. 1 tick = 1 in-game day. */
export const SIM_TICKS_PER_SECOND: readonly [0, 5, 12, 30] = [0, 5, 12, 30];
/** Upper bound of ticks run inside one sim.update() call (prevents spiral of death). */
export const MAX_TICKS_PER_FRAME = 8;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 360
/** Year shown for day 0. */
export const START_YEAR = 2000;

/** A zoned tile has road access if a road tile is within this Manhattan distance (in tiles). */
export const ROAD_ACCESS_DISTANCE = 3;

export const START_MONEY = 25000;
export const TAX_DEFAULT = 9;
export const TAX_MIN = 0;
export const TAX_MAX = 20;

/** Costs in $ (one-off, charged when an action is applied). */
export const TOOL_COSTS = {
  /** Per new road tile on land. */
  road: 10,
  /** Per new road tile on water (bridge). */
  bridge: 60,
  /** Per tile zoned (re-zoning to the same zone is free). */
  zone: 5,
  /** Per park tile. */
  park: 40,
  /** Per non-empty tile bulldozed (roads, lots, parks, trees). */
  bulldoze: 2,
  /** Extra per building level when bulldozing a building (charged once per building). */
  bulldozeBuildingPerLevel: 15,
  /** Extra when a tile with a natural tree is cleared by any action. */
  treeClear: 3,
} as const;

/** Monthly upkeep in $. */
export const UPKEEP = {
  roadPerTile: 1,
  bridgePerTile: 4,
  parkPerTile: 3,
} as const;

/** Maximum number of tiles in a single ToolAction. */
export const MAX_ACTION_TILES = 1024;

// ============================================================================================
// 5. Road layout constants (shared by the road stamper in src/build and the traffic in src/fx)
// ============================================================================================

/**
 * Road tile cross-section (TILE_SIZE = 8 voxels), along the axis perpendicular to travel:
 *   [0]      sidewalk (only on edges that do NOT connect to another road; connected edges are asphalt)
 *   [1..6]   asphalt, two lanes of 3 voxels; centre line between voxel 3 and 4 (local coordinate 4.0)
 *   [7]      sidewalk
 * The road surface is flush with the ground: road blocks replace the top ground voxel at
 * y = groundHeight-1, so vehicles drive on y = groundHeight (BRIDGE_DECK_HEIGHT on bridges).
 * Traffic drives on the right.
 */
export const ROAD_SIDEWALK_WIDTH = 1;
/** Distance (voxels) from the tile centre line to the centre of a lane. */
export const ROAD_LANE_OFFSET = 1.5;

// ============================================================================================
// 6. Storage / persistence constants
// ============================================================================================

/** Current save-file format version. Bump + add a migration in src/persist when the format changes. */
export const SAVE_VERSION = 1;
/** localStorage key prefix; full key = SAVE_KEY_PREFIX + slot. */
export const SAVE_KEY_PREFIX = 'vcb:save:';
export const AUTOSAVE_SLOT = 'autosave';
export const QUICKSAVE_SLOT = 'quick';
export const AUTOSAVE_INTERVAL_MS = 60_000;
/** localStorage key for UI/view preferences (owned by src/ui). */
export const SETTINGS_KEY = 'vcb:settings';

// ============================================================================================
// 7. Keyboard map (KeyboardEvent.code values). Each module handles only its own actions.
// ============================================================================================

export const KEYMAP = {
  // --- camera (handled by src/input/cameraRig.ts, bubble-phase listener on window) ---
  panForward: ['KeyW', 'ArrowUp'],
  panBack: ['KeyS', 'ArrowDown'],
  panLeft: ['KeyA', 'ArrowLeft'],
  panRight: ['KeyD', 'ArrowRight'],
  rotateLeft: ['KeyQ'],
  rotateRight: ['KeyE'],
  tiltUp: ['KeyR'],
  tiltDown: ['KeyF'],
  zoomIn: ['KeyZ', 'PageUp'],
  zoomOut: ['KeyX', 'PageDown'],
  resetView: ['Home'],
  // --- tools (handled by src/ui, which calls tools.setTool) ---
  toolSelect: ['Digit1'],
  toolRoad: ['Digit2'],
  toolResidential: ['Digit3'],
  toolCommercial: ['Digit4'],
  toolIndustrial: ['Digit5'],
  toolPark: ['Digit6'],
  toolBulldoze: ['Digit7', 'KeyB', 'Delete'],
  /** Opens the civic menu / cycles the selected civic tool (handled by src/ui). */
  toolCivic: ['Digit8'],
  // --- cancel drag / back to select (handled by src/input/toolController.ts) ---
  cancel: ['Escape'],
  // --- simulation speed (handled by src/ui) ---
  togglePause: ['Space'],
  slower: ['BracketLeft', 'Minus', 'NumpadSubtract'],
  faster: ['BracketRight', 'Equal', 'NumpadAdd'],
  // --- game (handled by src/ui) ---
  quickSave: ['F5'],
  quickLoad: ['F9'],
  toggleGrid: ['KeyG'],
  toggleHelp: ['KeyH', 'F1'],
  toggleDebug: ['Backquote', 'F3'],
  cycleOverlay: ['KeyO'],
} as const satisfies Record<string, readonly string[]>;
export type KeyAction = keyof typeof KEYMAP;

// ============================================================================================
// 8. Plain data structures
// ============================================================================================

export interface TileCoord {
  tx: number;
  tz: number;
}

/** A building record. Owned and mutated only by the simulation; everyone else sees Readonly<Building>. */
export interface Building {
  /** Unique id ≥ 1 (0 means "no building"). */
  id: number;
  zone: RCIZone;
  level: BuildingLevel;
  /** Min-corner tile of the footprint. */
  tx: number;
  tz: number;
  /** Footprint edge in tiles (1 or 2). All footprint tiles are Zoned with the same zone & height. */
  size: BuildingSize;
  /** Direction the front/entrance faces (towards an adjacent road when possible). */
  facing: Dir;
  /** uint32 seed for the procedural look. Same record ⇒ same voxels, always. */
  variant: number;
  state: BuildingState;
  /** Construction stage 0..CONSTRUCTION_STAGES-1 (meaningful while Constructing; 0 otherwise). */
  stage: number;
  /** Days spent in the current state. */
  stateDays: number;
  /** Residents (R) or employees (C/I). */
  occupants: number;
  /** Max residents (R) or jobs (C/I). */
  capacity: number;
  /** Day the building record was created. */
  builtDay: number;
}

/** A civic service building. Owned and mutated only by the simulation. Ids share the Building id space. */
export interface CivicBuilding {
  id: number;
  kind: CivicKind;
  /** Min-corner tile of the footprint; size = CIVIC_SPECS[kind].size. */
  tx: number;
  tz: number;
  /** Direction the entrance faces (towards an adjacent road). */
  facing: Dir;
  /** uint32 seed for the procedural look. */
  variant: number;
  builtDay: number;
}

/** Everything about one tile, for tooltips / inspect panel. */
export interface TileInfo {
  tx: number;
  tz: number;
  index: number;
  kind: TileKind;
  zone: ZoneType;
  /** Terrain ground height (see TerrainReader.getTileHeight). */
  height: number;
  water: boolean;
  /** Natural tree/decor still present. */
  decor: boolean;
  /** 4-bit road connectivity mask (DIR_BIT) if kind === Road, else 0. */
  roadMask: number;
  roadAccess: boolean;
  /** 0..1 */
  landValue: number;
  /** 0..1 */
  pollution: number;
  building: Readonly<Building> | null;
  civic: Readonly<CivicBuilding> | null;
  /** Service coverage at this tile. */
  coverage: ServiceCoverage;
}

export interface RCI {
  r: number;
  c: number;
  i: number;
}

/** Tax rates in percent (TAX_MIN..TAX_MAX). */
export type TaxRates = RCI;

/** One month of budget. All values are non-negative $; net = income - expenses. */
export interface BudgetReport {
  /** Tax income per zone. */
  taxes: RCI;
  /** Other income (e.g. trade with neighbour cities via edge road connections). */
  other: number;
  roadUpkeep: number;
  parkUpkeep: number;
  /** Civic building upkeep (sum of CIVIC_SPECS[kind].upkeep). */
  serviceUpkeep: number;
  income: number;
  expenses: number;
  net: number;
}

/** Aggregate city statistics, recomputed by the simulation (at least once per tick). */
export interface CityStats {
  /** Absolute in-game day index since founding (0-based). See formatDate() in src/core/util.ts. */
  day: number;
  money: number;
  population: number;
  /** Working-age residents. */
  workforce: number;
  jobsCommercial: number;
  jobsIndustrial: number;
  jobsTotal: number;
  employed: number;
  /** 0..1 */
  unemployment: number;
  /** RCI demand, each in -1..1 (positive = wants to grow). */
  demand: RCI;
  /** Number of zoned tiles per zone. */
  zonedTiles: RCI;
  /** Number of buildings (constructing + active) per zone. */
  buildings: RCI;
  abandoned: number;
  roadTiles: number;
  parkTiles: number;
  /** Average land value over zoned tiles, 0..1. */
  landValueAvg: number;
  /** Average pollution over zoned tiles, 0..1. */
  pollutionAvg: number;
  /** Citizen approval 0..1. */
  happiness: number;
  /** Number of civic buildings per kind. */
  civics: Record<CivicKind, number>;
  /** Average service coverage over residential tiles. */
  coverage: ServiceCoverage;
  /** The last completed month. */
  lastMonth: BudgetReport;
  /** Running estimate for the current month (full-month projection). */
  projected: BudgetReport;
}

/** Monthly history sample (the simulation keeps at most the last 240). */
export interface HistorySample {
  day: number;
  population: number;
  money: number;
  jobs: number;
  demand: RCI;
}

/** Player actions, produced by the tool controller, validated and applied by the simulation. */
export type ToolAction =
  /** Ordered path of tiles (usually an L-shaped drag). Existing road tiles in the path are free/valid. */
  | { type: 'road'; tiles: TileCoord[] }
  | { type: 'zone'; zone: RCIZone; tiles: TileCoord[] }
  | { type: 'park'; tiles: TileCoord[] }
  /** Places one civic building with its min corner at `origin`. Facing is chosen by the simulation. */
  | { type: 'civic'; kind: CivicKind; origin: TileCoord }
  /** Removes roads, zones, parks, trees and whole buildings (any footprint tile removes the building). */
  | { type: 'bulldoze'; tiles: TileCoord[] };

export interface ActionPreview {
  /** Total $ the action would cost (only valid tiles counted). */
  cost: number;
  /**
   * Per input tile (same order/length as action.tiles): would this tile be changed?
   * For a 'civic' action: one flag per footprint tile, row-major from the origin
   * (index = dz * size + dx, size = CIVIC_SPECS[kind].size).
   */
  valid: boolean[];
  validCount: number;
  /** cost <= money. */
  affordable: boolean;
  /** Human-readable reason when validCount === 0 or !affordable (e.g. "Not enough money"). */
  reason?: string;
}

export interface ActionResult {
  /** True if at least one tile changed. Actions that are not affordable are rejected entirely. */
  ok: boolean;
  cost: number;
  /** Number of input tiles that changed. */
  applied: number;
  reason?: string;
  /** Tile indices that changed (also broadcast via 'tiles:changed'). */
  changedTiles: number[];
}

/** Complete, JSON-agnostic city state. Produced by sim.serialize(), consumed by sim.load(). */
export interface CitySnapshot {
  /** Schema version (= SAVE_VERSION at write time). */
  version: number;
  mapTiles: number;
  /** Terrain seed: voxels are regenerated from it on load, never stored. */
  seed: number;
  name: string;
  day: number;
  money: number;
  speed: SimSpeed;
  taxRates: TaxRates;
  /** Simulation RNG state (uint32). */
  rngState: number;
  nextBuildingId: number;
  /** Per tile (TILE_COUNT): TileKind. */
  tileKind: Uint8Array;
  /** Per tile: ZoneType. */
  tileZone: Uint8Array;
  /** Per tile: flag bits (TILE_FLAG_*). */
  tileFlags: Uint8Array;
  buildings: Building[];
  /** Civic buildings. Saves from before civics existed decode as []. */
  civics: CivicBuilding[];
  history: HistorySample[];
  /** Simulation-private, JSON-safe extension data; round-tripped verbatim by persistence. */
  extra: Record<string, unknown>;
}

/** Camera rig pose. */
export interface CameraState {
  /** Focus point on the ground (voxel units). */
  x: number;
  z: number;
  /** Radians, rotation around +Y. */
  yaw: number;
  /** Radians above the horizon (clamped by the rig, ~0.35..1.45). */
  pitch: number;
  /** Distance from focus point (voxel units). */
  distance: number;
}

/** What goes into a save slot. */
export interface SavePayload {
  city: CitySnapshot;
  camera?: CameraState;
}

export interface SaveSlotInfo {
  slot: string;
  name: string;
  /** ms since epoch. */
  savedAt: number;
  day: number;
  money: number;
  population: number;
  /** Size of the stored string (UTF-16 code units). */
  bytes: number;
  version: number;
}

export interface SaveResult {
  ok: boolean;
  bytes: number;
  error?: string;
}

/** A visual particle source (chimney top, fountain …) published by the structure module for the fx module. */
export interface Emitter {
  /** World position (voxel units) where particles spawn. */
  x: number;
  y: number;
  z: number;
  kind: EmitterKind;
  /** Relative intensity 0..1. */
  strength: number;
  buildingId: number;
}

/**
 * A box of voxels to write into the world. data index = x + sx * (z + sz * y).
 * Value STAMP_KEEP (255) means "leave the world voxel unchanged"; 0 (AIR) clears.
 */
export interface VoxelStamp {
  sx: number;
  sy: number;
  sz: number;
  data: Uint8Array;
}

export interface MeshStats {
  /** Chunk meshes currently in the scene. */
  meshes: number;
  triangles: number;
  /** Chunks waiting to be meshed. */
  queued: number;
  /** Jobs currently in workers. */
  inFlight: number;
  workers: number;
  /** Rolling average worker meshing time per chunk (ms). */
  avgMeshMs: number;
  /** Total chunks meshed since start. */
  meshedTotal: number;
}

export interface DebugInfo {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  simMs: number;
  structuresPending: number;
  mesh: MeshStats;
}

/** Shown in the cursor tooltip while dragging/hovering with a build tool. */
export interface ToolPreviewInfo {
  tool: ToolId;
  cost: number;
  validCount: number;
  totalCount: number;
  affordable: boolean;
  reason?: string;
  /** Pointer position in CSS pixels (clientX/clientY). */
  screenX: number;
  screenY: number;
}

// ============================================================================================
// 9. Module interfaces
// ============================================================================================

// ---------- voxel-world (src/voxel/world.ts) ----------

/** Chunked voxel storage. Single writer thread (main). */
export interface IVoxelWorld {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly chunksZ: number;
  /** Increments on every effective voxel change (cheap global change detector). */
  readonly revision: number;

  inBounds(x: number, y: number, z: number): boolean;
  /** Block at voxel coords; AIR when out of bounds. */
  getBlock(x: number, y: number, z: number): BlockId;
  /** Sets a voxel. Out-of-bounds writes are ignored. Marks chunk(s) dirty only if the value changed. */
  setBlock(x: number, y: number, z: number, id: BlockId): void;
  /** Fills the half-open box [x0,x1)×[y0,y1)×[z0,z1) (clamped to bounds). */
  fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: BlockId): void;
  /** Writes a stamp with its min corner at (ox,oy,oz). STAMP_KEEP voxels are skipped. Clipped to bounds. */
  applyStamp(stamp: VoxelStamp, ox: number, oy: number, oz: number): void;
  /** Highest y with a non-AIR voxel in the column, or -1. */
  getColumnTop(x: number, z: number): number;

  /** True if the chunk holds no non-AIR voxel (unallocated chunks are empty). */
  isChunkEmpty(cx: number, cy: number, cz: number): boolean;
  /**
   * Copies the chunk plus a 1-voxel border into `out` (length PADDED_VOLUME, index
   * px + PADDED_SIZE*(pz + PADDED_SIZE*py), where p = local + 1). Border voxels come from neighbour
   * chunks; outside the world: y < 0 → B.BEDROCK (so no bottom faces), x/z/top outside → AIR.
   * Returns true if the chunk itself (not the border) contains any non-AIR voxel.
   */
  extractPadded(cx: number, cy: number, cz: number, out: Uint8Array): boolean;
  /** Version counter of a chunk (by chunkKey), incremented whenever the chunk is marked dirty. */
  getChunkVersion(key: number): number;
  /**
   * Returns and clears the set of dirty chunk keys (see chunkKey() in src/core/coords.ts).
   * A voxel change dirties its chunk and every neighbour chunk whose padded border contains the
   * voxel (faces + AO).
   */
  takeDirtyChunks(): number[];
  markChunkDirty(cx: number, cy: number, cz: number): void;
  markAllDirty(): void;
  /** Sets every voxel to AIR (marks previously non-empty chunks dirty). */
  clear(): void;
}

// ---------- terrain (src/voxel/terrain.ts) ----------

/**
 * Read-only per-tile terrain info. Every land tile is perfectly flat: all of its TILE_SIZE²
 * columns have ground height === getTileHeight(). Out-of-map queries are clamped to the edge.
 */
export interface TerrainReader {
  readonly seed: number;
  readonly mapTiles: number;
  /**
   * Ground height h of the tile: ground voxels occupy y ∈ [0, h-1], structures start at y = h.
   * For water tiles this is the bed height (< WATER_LEVEL).
   */
  getTileHeight(tx: number, tz: number): number;
  /** max(getTileHeight, WATER_LEVEL): y of the visible top surface (water surface on water tiles). */
  getSurfaceHeight(tx: number, tz: number): number;
  isWater(tx: number, tz: number): boolean;
  /** The terrain generator put a tree / natural decoration on this tile (entirely inside its footprint). */
  hasNaturalDecor(tx: number, tz: number): boolean;
  /** Natural top ground block of the tile (GRASS, GRASS_DARK, SAND, …; bed block for water). */
  getGroundBlock(tx: number, tz: number): BlockId;
}

export interface ITerrain extends TerrainReader {
  /** Writes the complete natural terrain (ground, water, decor) into an all-AIR world. Deterministic. */
  generateInto(world: IVoxelWorld): void;
  /**
   * Rewrites the tile's whole footprint (all y) to its natural state, exactly as generateInto
   * produced it, optionally without its decoration (tree/flowers).
   */
  restoreTile(world: IVoxelWorld, tx: number, tz: number, withDecor: boolean): void;
}

// ---------- simulation (src/sim/simulation.ts) ----------

/** Read-only view of the city. Implemented by the simulation. Out-of-map queries return neutral values. */
export interface CityReader {
  readonly mapTiles: number;
  readonly name: string;
  readonly seed: number;
  inBounds(tx: number, tz: number): boolean;
  getTileKind(tx: number, tz: number): TileKind;
  getZone(tx: number, tz: number): ZoneType;
  /** Building id occupying the tile (any footprint tile), or 0. */
  getBuildingIdAt(tx: number, tz: number): number;
  getBuilding(id: number): Readonly<Building> | undefined;
  getBuildingAt(tx: number, tz: number): Readonly<Building> | undefined;
  forEachBuilding(cb: (b: Readonly<Building>) => void): void;
  /** Civic building occupying the tile (any footprint tile). */
  getCivicAt(tx: number, tz: number): Readonly<CivicBuilding> | undefined;
  forEachCivic(cb: (c: Readonly<CivicBuilding>) => void): void;
  getCoverage(tx: number, tz: number): ServiceCoverage;
  /** 4-bit DIR_BIT mask of road neighbours if the tile is a road, else 0. */
  getRoadMask(tx: number, tz: number): number;
  /** Natural tree/decor still present (TILE_FLAG_DECOR). */
  hasDecor(tx: number, tz: number): boolean;
  hasRoadAccess(tx: number, tz: number): boolean;
  /** 0..1 */
  getLandValue(tx: number, tz: number): number;
  /** 0..1 */
  getPollution(tx: number, tz: number): number;
  getTileInfo(tx: number, tz: number): TileInfo;
  getStats(): Readonly<CityStats>;
  getHistory(): ReadonlyArray<HistorySample>;
  getSpeed(): SimSpeed;
  getTaxRates(): Readonly<TaxRates>;
}

export interface SimulationDeps {
  bus: GameBus;
  /** Stable proxy; points at the current city's terrain before newCity()/load() are called. */
  terrain: TerrainReader;
}

/**
 * The city simulation. Emits: 'tiles:changed', 'stats:changed', 'sim:speed', 'sim:month',
 * 'action:applied', 'notify'.
 */
export interface ISimulation extends CityReader {
  /** Starts a fresh city on the current terrain (deps.terrain). Money = START_MONEY, day 0. */
  newCity(opts: { seed: number; name: string }): void;
  /** Replaces the whole state. Throws an Error if the snapshot is incompatible (e.g. mapTiles mismatch). */
  load(snapshot: CitySnapshot): void;
  /** Deep copy of the full state (safe to keep / encode). */
  serialize(): CitySnapshot;
  /** Advance by real time; runs dt * SIM_TICKS_PER_SECOND[speed] ticks (accumulated, capped). */
  update(dtSeconds: number): void;
  /** Runs `count` ticks immediately regardless of speed (debug/tests). */
  tick(count?: number): void;
  setSpeed(speed: SimSpeed): void;
  setTaxRate(zone: RCIZone, percent: number): void;
  setName(name: string): void;
  /** Pure: never mutates state. */
  previewAction(action: ToolAction): ActionPreview;
  /** Validates and applies; emits 'tiles:changed' + 'action:applied' (+ 'stats:changed'). */
  applyAction(action: ToolAction): ActionResult;
  /** Debug/cheat. */
  addMoney(amount: number): void;
}

// ---------- structures (src/build/structureSync.ts) ----------

export interface StructureSyncDeps {
  world: IVoxelWorld;
  terrain: ITerrain;
  city: CityReader;
  bus: GameBus;
}

/**
 * Keeps the voxel world in sync with the city: listens to 'tiles:changed', queues the tiles (plus
 * neighbours), and stamps roads / zone lots / buildings / parks / restored terrain into the world.
 */
export interface IStructureSync {
  /** Forget all caches and queue every tile (call after world regenerated + sim state replaced). */
  reset(): void;
  /** Process queued work for at most ~budgetMs milliseconds. */
  update(budgetMs: number): void;
  /** Process all queued work synchronously. */
  flush(): void;
  /** Number of queued tiles. */
  readonly pending: number;
  /** Current particle emitters (chimneys, fountains). */
  getEmitters(): readonly Emitter[];
  /** Increments whenever the emitter list changes. */
  readonly emittersVersion: number;
  dispose(): void;
}

// ---------- meshing (src/mesh/chunkMeshManager.ts) ----------

export interface ChunkMeshManagerDeps {
  world: IVoxelWorld;
  /** Chunk meshes are added as children of this object. */
  parent: THREE.Object3D;
  /** Worker count override (default: clamp(hardwareConcurrency - 1, 1, 4)). */
  workerCount?: number;
}

export interface IChunkMeshManager {
  /** Pulls dirty chunks from the world, schedules worker jobs (nearest to `focus` first), uploads results. */
  update(camera: THREE.Camera, focus: THREE.Vector3): void;
  /** Marks every chunk for remeshing. */
  rebuildAll(): void;
  /** True when nothing is queued or in flight. */
  readonly idle: boolean;
  getStats(): MeshStats;
  dispose(): void;
}

// ---------- scene / atmosphere (src/render/scene.ts) ----------

export interface ISceneContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  /** Chunk meshes (meshing module). */
  readonly worldRoot: THREE.Group;
  /** Tool ghosts, grid, data overlays (input module). */
  readonly overlayRoot: THREE.Group;
  /** Cars, particles, clouds (fx module). */
  readonly fxRoot: THREE.Group;
  /** 0..1 time of day: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  timeOfDay: number;
  /** Advance timeOfDay automatically. */
  autoTime: boolean;
  /** 0 (full day) .. 1 (full night), derived from timeOfDay. */
  readonly nightFactor: number;
  shadowsEnabled: boolean;
  /** Per frame: advances time of day, writes sharedUniforms, moves sun/shadow camera to follow `focus`. */
  update(dt: number, focus: THREE.Vector3): void;
  render(): void;
  /** Re-reads container size (also done automatically on window resize). */
  resize(): void;
  dispose(): void;
}

// ---------- camera rig (src/input/cameraRig.ts) ----------

export interface CameraRigDeps {
  camera: THREE.PerspectiveCamera;
  /** Element receiving pointer/wheel input (the canvas). */
  dom: HTMLElement;
  terrain: TerrainReader;
}

export interface ICameraRig {
  /** When false, ignores all input (modal dialogs open). update() still applies smoothing. */
  enabled: boolean;
  update(dt: number): void;
  /** Current focus point on the ground (world coords). Do not mutate. */
  getFocus(): THREE.Vector3;
  lookAtTile(tx: number, tz: number, immediate?: boolean): void;
  /** Map centre, default yaw/pitch/distance. */
  reset(immediate?: boolean): void;
  getState(): CameraState;
  setState(state: CameraState, immediate?: boolean): void;
  dispose(): void;
}

// ---------- tools (src/input/toolController.ts) ----------

export interface ToolControllerDeps {
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  overlayRoot: THREE.Object3D;
  sim: ISimulation;
  terrain: TerrainReader;
  bus: GameBus;
}

/** Emits: 'tool:changed', 'tool:preview', 'tile:hover', 'inspect', 'overlay:changed', 'notify'. */
export interface IToolController {
  enabled: boolean;
  readonly tool: ToolId;
  setTool(tool: ToolId): void;
  /** Cancels the current drag (if any). */
  cancel(): void;
  overlay: OverlayMode;
  gridVisible: boolean;
  update(dt: number): void;
  dispose(): void;
}

// ---------- fx (src/fx/effects.ts) ----------

export interface EffectsDeps {
  root: THREE.Object3D;
  city: CityReader;
  terrain: TerrainReader;
  structures: IStructureSync;
  view: ISceneContext;
  bus: GameBus;
}

export interface IEffects {
  enabled: boolean;
  update(dt: number, camera: THREE.PerspectiveCamera): void;
  /** Drop all transient state (cars, particles) after a new city / load. */
  reset(): void;
  dispose(): void;
}

// ---------- persistence (src/persist/saveManager.ts) ----------

export interface SaveManagerDeps {
  /** null when localStorage is unavailable (private mode etc.) — then saving fails gracefully. */
  storage: Storage | null;
  bus: GameBus;
}

export interface ISaveManager {
  save(slot: string, payload: SavePayload): SaveResult;
  /** Decodes + migrates + validates. null if missing or corrupt (never throws). */
  load(slot: string): SavePayload | null;
  has(slot: string): boolean;
  /** All slots, newest first. Corrupt entries are listed with name "(corrupt)". */
  list(): SaveSlotInfo[];
  remove(slot: string): void;
  /** Self-contained text form of a save (for download / clipboard). */
  exportString(payload: SavePayload): string;
  /** Inverse of exportString; null if invalid. */
  importString(text: string): SavePayload | null;
  /** Calls provider() every intervalMs and saves to AUTOSAVE_SLOT (skips when it returns null). */
  startAutosave(provider: () => SavePayload | null, intervalMs: number): void;
  stopAutosave(): void;
  dispose(): void;
}

// ---------- ui (src/ui/gameUI.ts) ----------

export interface GameUIDeps {
  /** The #ui overlay element. */
  root: HTMLElement;
  bus: GameBus;
  sim: ISimulation;
  /** For the minimap (water / height shading). */
  terrain: TerrainReader;
  tools: IToolController;
  camera: ICameraRig;
  /** Settings: shadows, day/night (autoTime, timeOfDay). */
  view: ISceneContext;
  /** Settings: traffic/particles toggle (fx.enabled). */
  fx: IEffects;
  game: IGameController;
}

export interface IGameUI {
  /** Per frame; keep DOM writes throttled (≤ 10 Hz for stats). */
  update(dt: number): void;
  /** Full-screen loading overlay; null hides it. */
  showLoading(message: string | null): void;
  readonly modalOpen: boolean;
  dispose(): void;
}

// ---------- game controller (src/game.ts, integrator) ----------

export interface IGameController {
  readonly busy: boolean;
  newCity(opts?: { seed?: number; name?: string }): Promise<void>;
  /** Defaults to QUICKSAVE_SLOT. Emits a 'notify'. */
  saveGame(slot?: string): SaveResult;
  loadGame(slot: string): Promise<boolean>;
  listSaves(): SaveSlotInfo[];
  deleteSave(slot: string): void;
  exportSave(): string | null;
  importSave(text: string): Promise<boolean>;
  getDebugInfo(): DebugInfo;
}
