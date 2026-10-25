# Voxel City Builder — Architecture

A browser 3D voxel city builder: **TypeScript + Three.js (r186) + Vite 8**, no external assets — every
voxel, sound and icon is procedural. The player lays roads, zones Residential / Commercial /
Industrial land and parks; zones with road access grow into procedurally generated voxel buildings
that look different per zone type and density; a tick-based simulation drives population, jobs,
RCI demand and the budget. The voxel world is stored in chunks and greedy-meshed in Web Workers.

This document is the contract between the module agents. The frozen code contracts are
`src/types.ts`, `src/core/*.ts`, `src/voxel/blocks.ts`, `src/mesh/protocol.ts`,
`src/render/sharedUniforms.ts`, `src/render/colorSetup.ts`. When this document and the code
disagree, **the code wins**.

---

## 1. Stack & commands

| What | Command |
|---|---|
| Type-check (must pass) | `npx tsc --noEmit` (TypeScript 7 / tsgo, strict) |
| Dev server | `VCB_VITE_CACHE=<scratch>/vite-cache node /home/claude/vcb/node_modules/vite/bin/vite.js /home/claude/vcb --port <free port> --strictPort > <scratch>/vite.log 2>&1 &` then `echo $!` (kill that PID when done) |
| Production build | `npx vite build --outDir <scratch dir>` (do not leave `dist/` in the repo) |
| Headless browser smoke test | `node scripts/smoke.mjs --url "http://127.0.0.1:<port>/?fresh&seed=1" --wait 8000 --shot <png> --eval "<js>"` |
| Headless unit test of pure TS | `npx rolldown <entry.ts> --format esm --platform node --file <out.mjs> && node <out.mjs>` |
| Isolated runnable copy (skeleton + your live files) | `bash scripts/harness.sh <fresh scratch dir> src/<your-dir> [other live paths]` |

* `tsconfig.json`: ES2022, `moduleResolution: bundler`, `strict`, `verbatimModuleSyntax` (use
  `import type` / inline `type` for type-only imports), `isolatedModules`, libs DOM + DOM.Iterable +
  WebWorker (with `skipLibCheck`), `types: ["vite/client"]` (CSS imports, `import.meta`).
* No TS `enum`s anywhere: enum-like values are `as const` objects + same-named union types
  (`TileKind`, `ZoneType`, `BuildingState`).
* No new npm packages. Three.js addons (`three/examples/jsm/...`) are allowed.
* Several agents run dev servers concurrently: always pick your own port (e.g. 5200 + a random
  offset), set `VCB_VITE_CACHE` to a private directory, never `cd … &&` in front of a backgrounded
  server (so `$!` is the server PID), and kill it before you finish (`pgrep -af vite` must not show
  yours).
* URL parameters: `?fresh` (ignore autosave), `?seed=N` (new city with seed N, implies fresh),
  `?debug` (UI shows the debug overlay initially).
* Debug handle in the browser console: `window.__vcb` is the `Game` (fields `sim`, `world`, `view`,
  `meshes`, `structures`, `rig`, `tools`, `fx`, `saves`, `ui`, `bus`, `terrain`).

---

## 2. Module map & file ownership

Every file has exactly one owner. **Never edit a file you do not own.** You may add new files only
inside your own directory prefix (e.g. a sim helper `src/sim/pathing.ts`). Do not create files in
another module's directory.

| Module (agent) | Files (owned) | Implements |
|---|---|---|
| **integrator** (frozen) | `index.html`, `src/style.css`, `tsconfig.json`, `vite.config.ts`, `package.json`, `ARCHITECTURE.md`, `scripts/smoke.mjs`, `src/main.ts`, `src/game.ts`, `src/types.ts`, `src/core/events.ts`, `src/core/rng.ts`, `src/core/coords.ts`, `src/core/util.ts`, `src/voxel/blocks.ts`, `src/mesh/protocol.ts`, `src/render/sharedUniforms.ts`, `src/render/colorSetup.ts` | composition root, contracts |
| **voxel-world** | `src/voxel/world.ts`, `src/voxel/terrain.ts`, `src/voxel/noise.ts`, `src/voxel/decor.ts` (+ new `src/voxel/*`) | `IVoxelWorld`, `ITerrain` |
| **meshing** | `src/mesh/greedy.ts`, `src/mesh/mesher.worker.ts`, `src/mesh/chunkMeshManager.ts`, `src/mesh/materials.ts` (+ new `src/mesh/*`) | `IChunkMeshManager` |
| **simulation** | `src/sim/*` | `ISimulation` (⊃ `CityReader`) |
| **buildings** | `src/build/*` | `IStructureSync` |
| **input** | `src/input/*` | `ICameraRig`, `IToolController` |
| **atmosphere** | `src/render/scene.ts`, `src/render/sky.ts` (+ new `src/render/*`), `src/fx/*` | `ISceneContext`, `IEffects` |
| **ui** | `src/ui/*` (incl. `src/ui/ui.css`) | `IGameUI` |
| **persistence** | `src/persist/*` | `ISaveManager` |

Dependency rule: modules import **only** `src/types.ts`, `src/core/*`, `src/voxel/blocks.ts`,
`src/mesh/protocol.ts`, `src/render/sharedUniforms.ts`, `three`, and their own files. They never
import another module's implementation files. All cross-module calls go through the interfaces in
`src/types.ts`, which `src/game.ts` wires together.

Module-internal files (everything not listed as "Implements") contain *suggested* signatures; the
owning agent may change them freely.

---

## 3. Coordinate systems & world dimensions

```
            -Z (North, DIR_N=0)
                 ^
   -X (W=3) <----+----> +X (East, DIR_E=1)
                 v
            +Z (South, DIR_S=2)          y is up
```

| Constant | Value | Meaning |
|---|---|---|
| `TILE_SIZE` | 8 | voxels per tile edge — **1 city tile = 8 × 8 voxel columns** |
| `MAP_TILES` | 64 | city grid is 64 × 64 tiles (`TILE_COUNT` = 4096) |
| `WORLD_SIZE_X/Z` | 512 | voxels |
| `WORLD_HEIGHT` | 128 | voxels |
| `CHUNK_SIZE` | 32 | cubic chunks, 32³ voxels = 4 × 4 tiles horizontally |
| `CHUNKS_X/Y/Z` | 16 / 4 / 16 | `CHUNK_COUNT` = 1024 |
| `PADDED_SIZE` | 34 | chunk + 1-voxel border, for meshing |
| `WATER_LEVEL` | 10 | water voxels fill y < 10; water top face at y = 10 |
| `BASE_GROUND_HEIGHT` | 12 | ground height of the central plain |
| `MIN/MAX_GROUND_HEIGHT` | 4 / 36 | deepest bed / highest hill |
| `BRIDGE_DECK_HEIGHT` | 12 | road surface y on water tiles |
| `MAX_STRUCTURE_HEIGHT` | 80 | above a tile's ground height |

* **Voxel space**: integer `(x, y, z)`; voxel occupies `[x,x+1]×[y,y+1]×[z,z+1]`. 1 voxel = 1 three.js
  unit. Out-of-bounds reads return AIR.
* **Tile space**: `(tx, tz)`, tile covers voxels `x ∈ [8tx, 8tx+8)`, `z ∈ [8tz, 8tz+8)`.
  `tileIndex = tz * 64 + tx`. Tile centre (world) = `tileCenter(t) = 8t + 4`.
* **Ground height h** of a tile: ground voxels occupy `y ∈ [0, h-1]`; things built on the tile start
  at `y = h`. Every land tile is perfectly flat (all 64 columns share h).
* **Chunk key**: `chunkKey(cx,cy,cz) = (cy*16 + cz)*16 + cx`. Voxel index inside a chunk:
  `lx + 32*(lz + 32*ly)`. Padded index: `px + 34*(pz + 34*py)` with `p = local + 1`.
* **Directions**: `Dir` 0..3 = N, E, S, W; `DIR_DX = [0,1,0,-1]`, `DIR_DZ = [-1,0,1,0]`,
  `DIR_BIT = [1,2,4,8]` for 4-bit connectivity masks (road masks, lot edges).
* All helpers live in `src/core/coords.ts` (`tileIndex`, `inMap`, `rectTiles`, `lPathTiles`,
  `roadSurfaceY`, `chunkKey`, `paddedIndex`, …). Use them; don't re-derive.

---

## 4. Terrain model (voxel-world)

* Per-tile heightmap, deterministic from the seed: a large flat central plain at
  `BASE_GROUND_HEIGHT` (≥ ~55 % of tiles; the central 16 × 16 tiles always dry plain), gentle
  terraced hills toward the edges (|Δh| ≤ 2 between 4-neighbouring land tiles), a meandering river
  and/or lakes (≥ 70 % land), sandy beaches at h = 11 next to water.
* Layers per column: y=0 BEDROCK, STONE, DIRT (3 voxels), ground block on top (grass shades in large
  patches, SAND on beaches, ROCK/SNOW on high tops). Water tiles: bed of SAND/GRAVEL/CLAY, WATER up
  to y = 9.
* Natural decor (trees, bushes, flowers) is generated per tile, at most one tree per tile and
  **entirely inside the tile's 8 × 8 footprint** — clearing a tile never leaves half a tree.
* `ITerrain.restoreTile(world, tx, tz, withDecor)` rewrites a tile's full column stack exactly as
  generated (with or without its decor). It is how bulldozed land returns to nature.
* `TerrainReader` (read-only) is what the sim, camera, tools, fx and UI see. Before the first city
  exists, `src/game.ts`'s `TerrainProxy` answers with a flat dry plain.

---

## 5. Block palette (`src/voxel/blocks.ts`, frozen)

One byte per voxel. `0 = AIR`, `255 = STAMP_KEEP` (only inside stamps). ~110 named blocks with sRGB
colors in id ranges: terrain 1–15, vegetation 16–31, road & infrastructure 32–47, zone lots 48–55,
generic building 56–79, residential 80–95, commercial 96–111, industrial 112–127, parks 128–143.
Lookup tables for the mesher: `BLOCK_FLAGS` (SOLID, TRANSPARENT, EMISSIVE, OPAQUE, AO),
`BLOCK_RGB`, `BLOCK_EMISSIVE_RGB`. Unknown ids render magenta.

* **WATER** is the only transparent block (own render pass).
* **Emissive** blocks (WINDOW_LIT, GLASS_LIT, DOOR_GLASS, STREET_LAMP, BEACON_RED, SIGN_*) look like
  their normal color by day and glow with their emissive color at night (`uNight`).
* Notable: zone lots `LOT_RES/COM/IND` (+ `_EDGE` borders), road `ASPHALT`, `ROAD_LINE_WHITE/YELLOW`,
  `SIDEWALK`, construction `FOUNDATION`, `SCAFFOLD`, `CRANE_YELLOW`, decay `BOARDED`, `RUBBLE`.

If you miss a block, use the closest existing one — the palette is frozen.

---

## 6. Voxel storage & dirty tracking (voxel-world)

* `VoxelWorld`: flat array of 1024 chunk slots, each `Uint8Array(32768) | null` (null = all AIR,
  lazily allocated, released when empty). Per-chunk non-air count → O(1) `isChunkEmpty`.
* Single writer: the main thread (terrain generation + StructureSync stamping).
* A voxel change marks its chunk dirty **and** every neighbour chunk whose padded border contains the
  voxel (faces + AO need the border). Each dirty mark bumps that chunk's version.
* `takeDirtyChunks()` hands the dirty keys to the ChunkMeshManager once per frame.
* Bulk writes: `fillBox` (half-open boxes, clipped) and `applyStamp` (skips `STAMP_KEEP`).
* `extractPadded(cx,cy,cz,out)`: 34³ copy with border; outside the world: below y=0 → BEDROCK (no
  bottom faces), elsewhere → AIR (so the map edge shows a diorama cross-section).

---

## 7. Meshing pipeline & worker protocol (meshing)

```
world.takeDirtyChunks() ─▶ ChunkMeshManager (main) ── pending set, nearest-to-focus first
        │  world.extractPadded() into a pooled 34³ buffer
        ▼
  postMessage(MeshRequest{jobId,key,version,voxels}, [voxels.buffer])
        ▼
  mesher.worker.ts ─ greedyMesh(voxels) ─▶ ChunkMeshData{opaque, transparent}
        ▼
  postMessage(MeshResult{…, mesh, voxels}, [all buffers])   (voxels returned for pooling)
        ▼
  ChunkMeshManager: buildChunkGeometry → swap into the chunk's Mesh (child of scene.worldRoot)
```

* Protocol types: `src/mesh/protocol.ts` (`MeshRequest`, `MeshResult`, `MeshError`,
  `collectTransferables`). All buffers are transferred, never copied.
* Vertex format per chunk pass: `position` Float32×3 (chunk-local 0..32), `normal` Int8×3,
  `color` Uint8×3 normalized (block sRGB × AO), `aEmissive` Uint8×3 normalized (attribute name
  must not be `emissive`, which is a uniform in three's built-in shaders), index Uint16/Uint32.
* Face rules: opaque faces toward AIR or WATER; water faces only toward AIR. Per-vertex AO (0..3)
  baked into colors; greedy merge on (block id, 4×AO); diagonal flip for AO anisotropy.
* Pool: `clamp(hardwareConcurrency - 1, 1, 4)` workers, ≤ 2 jobs in flight per worker, one job per
  chunk at a time; re-dirtied chunks are re-sent after their result lands. Main-thread fallback if
  workers are unavailable.
* One `THREE.Mesh` per chunk per pass, `matrixAutoUpdate = false`, shared materials, opaque meshes
  cast + receive shadows, water receives only.

---

## 8. Rendering (atmosphere + meshing)

* **Color pipeline "WYSIWYG"**: `src/render/colorSetup.ts` (imported first by `main.ts`) disables
  `THREE.ColorManagement`; `scene.ts` sets `renderer.outputColorSpace = THREE.LinearSRGBColorSpace`
  and no tone mapping. Palette hex colors are used as-is everywhere (vertex colors, materials, fog,
  clear color). Never convert sRGB ↔ linear.
* **Scene roots** (`ISceneContext`): `worldRoot` (chunk meshes — meshing), `overlayRoot` (tool
  ghosts, grid, data overlays — input), `fxRoot` (cars, particles, clouds — atmosphere).
* **Lights**: hemisphere + directional sun with PCF soft shadows; the shadow camera follows the
  camera focus (texel-snapped) and its extent scales with zoom.
* **Day/night**: `timeOfDay` 0..1 (0 = midnight, 0.5 = noon), auto-advancing ~8 real minutes per
  day (toggleable in settings). `scene.update()` is the **only writer** of `sharedUniforms`
  (`uTime`, `uNight`, `uSun`); materials read them by reference (`shader.uniforms.uNight =
  sharedUniforms.uNight` in `onBeforeCompile`). Chunk material adds `emissive × uNight` → lit windows,
  street lamps, signs and beacons glow at night.
* Fog matches the sky/horizon color; the map edge should look intentional (ocean plane or diorama).

---

## 9. City model & state ownership

| State | Owner (single writer) | Readers |
|---|---|---|
| Voxels | VoxelWorld; written by Terrain (generation/restore) and StructureSync (stamps) | ChunkMeshManager |
| Terrain tile info | Terrain (immutable per city) | everyone via `TerrainReader` |
| Tiles, buildings, money, date, stats, demand | Simulation | everyone via `CityReader` |
| Tile visuals in the world (cache of what is stamped) | StructureSync | — |
| Emitters | StructureSync | Effects |
| Camera pose | CameraRig | Game (focus), saves |
| Active tool, overlays, drag state | ToolController | UI (via events) |
| Time of day, shadows | SceneContext | UI settings |
| Save slots | SaveManager (localStorage) | Game, UI via `IGameController` |
| UI preferences | GameUI (`localStorage[SETTINGS_KEY]`) | — |

**Tiles** (`TileKind`): `Empty`, `Road`, `Zoned` (zone R/C/I; may carry a building), `Park`.
Water tiles can only be `Empty` or `Road` (= bridge). Per-tile flags: `TILE_FLAG_DECOR` (natural
tree still present; bits 1–7 sim-private).

**Buildings** (`Building` in `types.ts`): id ≥ 1, zone, level 1–3, footprint `size` 1 or 2 (2×2 only for
level 3, all footprint tiles same zone & same ground height), `facing` (front toward a road),
`variant` (uint32 seed of the look), `state` (Constructing with `stage` 0..2 / Active / Abandoned),
occupants / capacity. Same record ⇒ identical voxels, always.

The simulation is the only writer of city state. Everyone else mutates it **only** through
`ISimulation.applyAction(ToolAction)` (tools) or the control methods (`setSpeed`, `setTaxRate`,
`setName`, `newCity`, `load` — UI/game).

---

## 10. Event bus (`src/core/events.ts`, frozen)

Typed, synchronous `EventBus<GameEvents>`; handler errors are caught and logged; `on()` returns an
unsubscribe function (call it in `dispose()`).

| Event | Payload | Emitter | Typical listeners |
|---|---|---|---|
| `tiles:changed` | `{ tiles: tileIndex[], cause }` | sim (per applyAction; ≤ 1 per `update()`) | StructureSync, Effects, UI minimap, tools (re-preview) |
| `city:loaded` | `{ seed, name, source }` | game | UI, Effects |
| `stats:changed` | `{ stats }` | sim (≤ once per update with ticks, after actions) | UI, tools (affordability) |
| `sim:speed` | `{ speed }` | sim | UI |
| `sim:month` | `{ day, report, money }` | sim | UI (budget, sfx) |
| `action:applied` | `{ action, result }` | sim (inside applyAction) | UI (sfx) |
| `notify` | `{ message, kind, durationMs? }` | anyone | UI toasts |
| `tool:changed` | `{ tool }` | tools | UI toolbar |
| `tool:preview` | `{ preview: ToolPreviewInfo \| null }` | tools | UI cursor tooltip |
| `tile:hover` | `{ tile \| null }` | tools (on change only) | UI status line |
| `inspect` | `{ tile \| null }` | tools (click), UI (close → null) | UI inspect panel, tools (selection outline) |
| `overlay:changed` | `{ mode }` | tools | UI |
| `save:written` | `{ slot, bytes, auto }` | SaveManager | UI (autosave indicator) |
| `ui:modal` | `{ open }` | UI | game (disables camera + tools) |

---

## 11. Simulation (simulation)

### 11.1 Time
* 1 tick = 1 in-game day. `SIM_TICKS_PER_SECOND = [0, 5, 12, 30]` for speeds 0 (pause) / 1 / 2 / 3.
  `update(dt)` accumulates and runs at most `MAX_TICKS_PER_FRAME` (8) ticks per frame.
* 30-day months, 12-month years starting in 2000 (`dayToDate` / `formatDate` in `src/core/util.ts`).
  Month end (`day % 30 === 0`): budget applied, `sim:month`, history sample (≤ 240 kept),
  land value / pollution refresh, rate-limited notifications.

### 11.2 Growth
* Empty zoned tile + road access (a road within `ROAD_ACCESS_DISTANCE` = 3 tiles, Manhattan) +
  positive demand for its zone → chance to spawn a level-1 building (Constructing, stage 0).
  Construction advances over ~6/10/16 days for L1/L2/L3 with `stage = floor(progress × 3)`; each
  stage change and completion is a visual change.
* Active buildings fill toward capacity; with high occupancy, positive demand, enough land value
  (R/C) and age they upgrade (L1→L2→L3, briefly Constructing again). Four adjacent level-2+ buildings
  of the same zone and height may merge into one 2×2 level-3 building.
* No road access for a while, strongly negative demand, or heavy pollution (R) → Abandoned; long
  abandoned → removed (tile stays zoned). Recovered conditions can revive buildings.
* Every visual change (add/remove, level, size, state, stage, facing, variant) adds **all footprint
  tiles** to the changed set → one batched `tiles:changed` per `update()`.

### 11.3 Economy
* Population = Σ residential occupants; workforce ≈ 55 %; jobs = Σ C/I capacity of active buildings.
* RCI demand in −1..1 (smoothed): R from available jobs + happiness − taxes; C from population
  (shoppers) vs commercial jobs; I from workforce + region trade (road component touching the map
  edge) vs industrial jobs. A fresh city starts with positive R and I demand.
* Land value 0..1: base + parks + water proximity + commerce − pollution. Pollution 0..1 from
  industry (distance falloff) and a little from roads.
* Monthly: taxes per zone (`taxRates` %, default 9, 0..20) + region trade − upkeep
  (`UPKEEP.roadPerTile` 1, `bridgePerTile` 4, `parkPerTile` 3). Money may go negative through upkeep,
  never through actions. Tuned so a sensible player reaches 10k+ population without going broke.
* `newCity` lays a free starter road from the west edge to the centre (row `MAP_TILES/2`, bridges
  over water) — the region connection.

### 11.4 Actions (`ToolAction` → `previewAction` / `applyAction`)
| Action | Valid tiles | Cost (`TOOL_COSTS`) |
|---|---|---|
| `road` (ordered path) | Empty land, Empty water (bridge), Zoned without building (de-zones). Existing roads valid but free. | 10 / tile, 60 / bridge tile |
| `zone` (R/C/I) | Empty land; Zoned of another zone without building. Same zone: skipped. | 5 / tile |
| `park` | Empty land; Zoned without building | 40 / tile |
| `bulldoze` | Road, Zoned, Park, Empty with decor; any building touched is removed whole | 2 / tile + 15 × level per building |
Clearing a natural tree adds 3. Unaffordable actions are rejected entirely; invalid tiles are skipped.
`previewAction` is pure and returns per-tile validity for ghost coloring. Max 1024 tiles per action.

---

## 12. Structures (buildings)

`StructureSync` turns city state into voxels:
1. On `tiles:changed`, enqueue the tiles **and their 4 neighbours** (road auto-connect, lot borders,
   park paths depend on neighbours).
2. Per tile compute a visual key from `CityReader`; skip when unchanged.
3. Non-building tile: `terrain.restoreTile(…, decor)` then stamp road / bridge / zone lot / park.
4. Building: restore all footprint tiles (no decor), stamp `generateBuilding(spec)` once for the
   whole footprint; stamp layer 0 = ground surface layer (`h - 1`) so lots get lawns/parking.
5. Publish emitters (chimneys → smoke, fountains, rooftop steam) in world coords.

Road tile layout (shared with fx): voxel 0 and 7 across the road are sidewalks on unconnected edges,
1–6 asphalt (two 3-voxel lanes, centre line at local 4.0, markings in voxels 3–4), surface flush
with the ground; vehicles drive on the right at `ROAD_LANE_OFFSET` = 1.5 voxels from the centre
line, at `y = roadSurfaceY()`. Bridges: deck top at `BRIDGE_DECK_HEIGHT`, pillars to the bed.

Generators are deterministic (seeded `Rng` from the building variant), never write outside the
footprint, author fronts facing +Z then rotate to `facing`. Distinct looks per zone and level
(houses with pitched roofs → apartment towers; corner shops → glass skyscrapers; sheds → factories
with smokestacks), construction sites with scaffolding/cranes, derelict abandoned variants, lit
windows mixed with dark ones for night.

---

## 13. Input (input)

* **Camera rig** (RTS): focus point on the ground + yaw/pitch/distance, smoothed. WASD/arrows pan,
  Q/E rotate, R/F tilt, Z/X/PageUp/PageDown zoom, Home reset; right-drag orbit, middle-drag (or
  Shift+right-drag) pan, wheel zoom toward the cursor. **Left button belongs to tools.**
* **Picking**: camera ray marched through the tile heightfield (flat-topped tile columns, water at
  `WATER_LEVEL`, bridges at the deck). Structures are ignored on purpose.
* **Tools**: select (inspect), road (L-shaped drag, Shift = straight), zone R/C/I, park, bulldoze
  (rectangle drags). Live ghost preview colored from `previewAction` validity, cost tooltip via
  `tool:preview`, Escape cancels / returns to select.
* **Overlays**: optional grid near the cursor; data overlays (land value, pollution, road access).
* Keys: `KEYMAP` in `src/types.ts`. Camera + tool controller listen on `window` (bubble phase); the
  UI listens in the **capture phase** and calls `stopPropagation()` for keys it consumes (open modal,
  text field focus). Everyone ignores keys when `isEditableTarget(e.target)`.

---

## 14. UI (ui)

DOM overlay in `#ui` (`pointer-events: none` on the root; panels opt in). Top HUD (name, date,
money, population, jobs, RCI bars, speed), tool palette with hotkeys and costs, cursor tooltip,
toasts, inspect panel, minimap, modals (budget, save/load + export/import, new city, settings, help),
debug overlay (`` ` `` / F3), loading overlay, tiny WebAudio SFX. Styles in `src/ui/ui.css` using the
CSS variables from `src/style.css`. All game actions go through `ISimulation`, `IToolController`,
`ICameraRig`, `ISceneContext`, `IEffects` and `IGameController`.

---

## 15. Persistence (persistence) — save format v1

* Key: `localStorage["vcb:save:" + slot]`; slots `autosave` (every 60 s + on tab hide/pagehide),
  `quick` (F5 / F9), and user slots.
* Voxels are **never** stored: terrain is regenerated from the seed and structures are re-stamped
  from building records (deterministic generators).
* Stored string = JSON envelope:

```jsonc
{
  "format": "vcb-save",
  "version": 1,                 // SAVE_VERSION
  "savedAt": 1761350000000,
  "meta": { "name": "Oakdale", "day": 913, "money": 18234, "population": 4210 },
  "payload": {
    "city": {
      "version": 1, "mapTiles": 64, "seed": 12345, "name": "Oakdale", "day": 913, "money": 18234,
      "speed": 1, "taxRates": { "r": 9, "c": 9, "i": 9 }, "rngState": 123456789, "nextBuildingId": 812,
      "tileKind": "<base64 RLE>", "tileZone": "<base64 RLE>", "tileFlags": "<base64 RLE>",
      "buildings": [[id, zone, level, tx, tz, size, facing, variant, state, stage, stateDays, occupants, capacity, builtDay], …],
      "history": [[day, population, money, jobs, demandR, demandC, demandI], …],
      "extra": { }
    },
    "camera": { "x": 256, "z": 256, "yaw": 0.78, "pitch": 0.9, "distance": 190 }
  }
}
```

* Decoding validates everything and migrates older versions step by step (`MIGRATIONS[v]`: v → v+1).
  Newer-than-supported or corrupt saves → `null` + error toast, never a crash.
* Export/import: a self-contained text form of the same envelope.

---

## 16. FX (atmosphere)

Traffic (instanced voxel cars on the road graph, right-hand lanes, headlights at night, count scales
with population/jobs, frozen when paused), smoke/steam/fountain particles from StructureSync
emitters, drifting voxel clouds tinted by time of day. Budget ≤ 1.5 ms/frame.

---

## 17. Startup / new city / load

```
main.ts: import colorSetup → style.css → new Game() → game.start()
start(): frame loop ▶ (autosave exists && !?fresh ? load autosave : newCity(seed from ?seed)) ▶ startAutosave

newCity(seed, name):                    load(payload):
  terrain = new Terrain(seed)             terrain = new Terrain(snap.seed)
  terrainProxy.set(terrain)               terrainProxy.set(terrain)
  sim.newCity({seed, name})               sim.load(snap)          ← throws before the world is touched
  world.clear(); terrain.generateInto     world.clear(); terrain.generateInto
  structures.reset(); structures.flush()  structures.reset(); structures.flush()
  meshes.rebuildAll(); fx.reset()         meshes.rebuildAll(); fx.reset()
  rig.reset(); tools.setTool('select')    rig.setState(camera); tools.setTool('select')
  wait for meshes.idle (≤ 12 s)           wait for meshes.idle
  emit city:loaded                        emit city:loaded       (on failure: previous city restored)
```

While `game.busy`, the sim and StructureSync are not updated, input is disabled and the UI shows
the loading overlay.

---

## 18. Frame loop (`src/game.ts`)

```
dt = min(0.1 s, frame delta)
rig.update(dt)
if !busy: sim.update(dt); structures.update(4 ms budget)
meshes.update(camera, focus)
tools.update(dt)
fx.update(dt, camera)
view.update(dt, focus)          // day/night, shadows, sharedUniforms
ui.update(dt)
view.render()
```
Every call is wrapped in an error guard (a throwing module logs and the frame continues).

---

## 19. Performance budgets (mid-range laptop, 64×64 map fully built)

| Item | Budget |
|---|---|
| Frame | 60 fps target; ≤ ~600 draw calls with shadows |
| `sim.update` | ≤ 1 ms avg at speed 3 |
| `structures.update` | ≤ 4 ms/frame (budgeted) |
| Initial world (terrain gen + flush + first meshing) | ≤ 3 s |
| Greedy mesh of a chunk (worker) | ≤ 3 ms typical, ≤ 8 ms worst |
| `meshes.update` main-thread cost | ≤ 2 ms incl. uploads |
| fx | ≤ 1.5 ms |
| Save / load encode-decode | ≤ 30 ms |

---

## 20. Rules for module agents

1. Edit only the files you own (§2). Never edit frozen contracts, `src/game.ts`, `src/main.ts`,
   `index.html`, configs or `package.json`. Never run `npm install`. Never `git commit`.
2. Implement your interfaces from `src/types.ts` exactly; keep exported class names, constructor
   signatures (single deps object) and file paths, because `src/game.ts` instantiates them.
3. `npx tsc --noEmit` must report **no errors in your files**. Other modules are being written in
   parallel — ignore errors that are only in files you do not own.
4. Determinism: anything regenerated on load (terrain, decor, buildings, roads, parks) must derive
   all randomness from seeds via `src/core/rng.ts`. Never `Math.random()` there.
5. Never throw out of per-frame methods; validate inputs; out-of-range queries return neutral values.
6. Subscribe to the bus in constructors and unsubscribe in `dispose()`; remove DOM/window listeners.
7. No per-frame allocations in hot paths (reuse vectors/arrays); typed arrays for bulk data.
8. If you start a dev server or any background process, kill it before you finish (verify with
   `pgrep -af vite`). Put scratch files in your scratchpad, not in the repo.
9. If a contract seems wrong or missing, do NOT change it: work around it inside your module and
   report the issue in your final message.

---

## 21. Testing recipes

* **Skeleton status**: the skeleton boots and renders. `src/voxel/world.ts`, `src/voxel/terrain.ts`
  (flat grass plain), `src/mesh/greedy.ts` (one quad per face, no AO) and
  `src/mesh/chunkMeshManager.ts` (synchronous main-thread meshing) contain NAIVE REFERENCE
  implementations so every agent can see voxels from day one; their owners replace them. Everything
  else is an inert stub (safe defaults, never throws). A pristine copy of the skeleton lives in
  `/home/claude/vcb-skeleton` (read-only reference; do not edit).
* **Shared tree vs. harness**: all agents edit `/home/claude/vcb` concurrently, so a file owned by
  someone else may be mid-rewrite when you test. If the page breaks because of another module, build
  an isolated copy with `bash scripts/harness.sh <new scratch dir> src/<your-dir>` (skeleton + your
  live files, `node_modules` symlinked), add private test pages there (e.g. a building gallery), and
  run vite on that directory.

* **Pure logic** (mesher, sim, codec, terrain): write a test entry in your scratchpad that imports
  your module by absolute path, bundle and run:
  `npx rolldown /scratch/test.ts --format esm --platform node --file /scratch/test.mjs && node /scratch/test.mjs`
  (rolldown resolves `three` and TS; avoid DOM-only code paths, or stub `globalThis` bits).
* **In the browser** (headless Chromium + SwiftShader WebGL via Playwright):
  start vite (§1, background, own port), run `node scripts/smoke.mjs --url "http://127.0.0.1:<port>/?fresh&seed=7" --wait 8000 --shot /scratch/a.png --eval "…"`,
  inspect the screenshot with your image viewer tool, then kill the server. Use `--eval` with
  `window.__vcb` to drive the game, e.g.
  `--eval "window.__vcb.sim.applyAction({type:'zone',zone:1,tiles:[{tx:33,tz:30},{tx:34,tz:30}]})"`
  `--eval "window.__vcb.sim.tick(200)"`. Software rendering is slow: judge looks, not FPS.
