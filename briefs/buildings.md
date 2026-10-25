# Module: buildings

Status: QUEUED, available to hand off
Suggested effort: max

## Files you own (edit only these)
- src/build/structureSync.ts
- src/build/stamp.ts
- src/build/buildingGen.ts
- src/build/residential.ts
- src/build/commercial.ts
- src/build/industrial.ts
- src/build/construction.ts
- src/build/roadGen.ts
- src/build/lotGen.ts

## Brief

ROLE: You are the buildings agent, one of 8 agents building a browser 3D voxel city builder IN PARALLEL in the shared tree /home/claude/vcb (TypeScript 7/tsgo strict, three r186, Vite 8; no external assets, everything procedural). The architect wrote frozen contracts, the composition root (src/game.ts) and a runnable skeleton; you replace the stubs in src/build with complete implementations. Your job: turn city state into voxels — roads with markings and street lamps, bridges, clearly readable zone lots, parks, and charming procedurally generated buildings that look distinct per zone (R/C/I) and density level (L1–L3), plus construction sites and derelict variants. This module is what makes the city look alive.

READ FIRST: ARCHITECTURE.md (whole file; most relevant: §3 coordinates, §4 terrain, §5 palette, §9 city model, §12 structures, §19 budgets), src/types.ts (CityReader, IStructureSync, StructureSyncDeps, Building, Emitter, VoxelStamp, ROAD_* constants, BRIDGE_DECK_HEIGHT, MAX_STRUCTURE_HEIGHT, DIR_*), src/game.ts, src/voxel/blocks.ts (the complete palette B.* with colours; STAMP_KEEP), src/core/coords.ts, src/core/rng.ts, src/core/events.ts, and the doc comments in YOUR files (they are part of this spec; buildingGen.ts and roadGen.ts contain the detailed look and layout rules). If docs and frozen code disagree, the code wins.

YOU OWN (edit only these; new files allowed inside src/build/): src/build/structureSync.ts, stamp.ts, buildingGen.ts, residential.ts, commercial.ts, industrial.ts, construction.ts, roadGen.ts, lotGen.ts.

NEVER EDIT: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, src/render/colorSetup.ts, src/game.ts, src/main.ts, index.html, src/style.css, tsconfig.json, vite.config.ts, package.json, ARCHITECTURE.md, scripts/*, /home/claude/vcb-skeleton/*, node_modules, or any other module's files. Allowed imports: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, 'three' and your own files; never another module's implementation. The integrator will run the full game with every real module: code against the interface contracts, not against the skeleton stubs' current behaviour.

EXPORTS THAT MUST STAY:
- `export class StructureSync implements IStructureSync` with `constructor(deps: StructureSyncDeps)` ({ world: IVoxelWorld, terrain: ITerrain, city: CityReader, bus }).
- game.ts calls:
  • after a new city or load: structures.reset() then structures.flush() (synchronous, behind the loading overlay);
  • each frame unless busy: structures.update(4) (ms budget).
- `pending` feeds the debug overlay; the fx module polls emittersVersion / getEmitters().
- Everything else in src/build is module-internal; the signatures in the stubs are suggestions.
- Upstream contracts you rely on:
  • The simulation emits 'tiles:changed' with ALL footprint tiles of every changed building.
  • Decor (TILE_FLAG_DECOR, city.hasDecor) only exists on Empty tiles.
  • 2×2 buildings are level 3, with all four tiles Zoned with the same zone and at the same ground height.
  • terrain.restoreTile(world, tx, tz, withDecor) rewrites the tile's whole column stack to its natural state, with the natural top block at y = h-1.

A. StructureSync (spec in the structureSync.ts doc comment; ARCHITECTURE.md §12):
- Constructor: subscribe to 'tiles:changed' → enqueue each tile index AND its 4 neighbours (road masks, lot borders and park paths depend on neighbours). The queue is a Set<number> (dedupe). dispose(): unsubscribe and clear.
- Visual key per tile, computed from the CityReader and cached per tile; skip the tile when the key is unchanged:
  • Road: `R:${mask}:${bridge}` (bridge = terrain.isWater).
  • Zoned lot without a building: `Z:${zone}:${edgeMask}` (edgeMask = DIR_BIT for edges whose neighbour is not Zoned with the same zone).
  • Building: `B:${id}:${level}:${size}:${facing}:${variant}:${state}:${stage}`.
  • Park: `P:${parkMask}:${roadMask}`.
  • Empty: `E:${decor}` (decor = city.hasDecor).
  • Add anything else your generators depend on (e.g. neighbour heights) to the key.
- Non-building tile: call terrain.restoreTile(world, tx, tz, withDecor), with withDecor = city.hasDecor for Empty tiles and false otherwise. Then, unless the tile is Empty, call world.applyStamp(gen.stamp, tx*8, gen.originY, tz*8) with the roadGen / lotGen output. Bridges: restore first (brings the water back), then stamp the bridge.
- Buildings: process per building id; a 2×2 building is stamped ONCE.
  • Restore all footprint tiles without decor, then stamp generateBuilding(spec, h) at the min-corner tile (h = terrain.getTileHeight; originY = h - 1, so stamp layer 0 repaints the lot surface).
  • Update the cached key of every footprint tile and drop the other footprint tiles from the queue.
  • A queued tile that is any footprint tile of a building triggers the whole building (look it up with city.getBuildingAt).
  • Tiles of a removed building just get their new key (lot / empty) and are restamped as such.
- Guard: a water tile with a non-road kind (invalid state) → draw nothing for that tile and log once. Never throw from update/flush: try/catch per tile, rate-limited logging.
- update(budgetMs): process queued tiles until performance.now() passes the budget, always at least 1 tile. flush(): process everything. pending = queue size.
- reset(): clear caches and emitters; set every tile's cached key to the natural key `E:${terrain.hasNaturalDecor(tx,tz)}` (the world was just regenerated); then queue ALL tiles. Natural tiles are skipped cheaply.
- Emitters:
  • Keep a Map<buildingId, Emitter[]>, plus park fountains keyed per tile with buildingId 0, in WORLD coordinates (stamp origin + local position).
  • Rebuild the flat list lazily and bump emittersVersion whenever it changes.
  • Drop entries of removed buildings and changed tiles.
- Perf: a typical tile restamp (restore + 8×8×≤40 stamp) ≤ 0.3 ms; a full 64×64 city flush ≤ 1.5 s. Cache generated road/lot stamps by key, since they repeat a lot, and reuse scratch StampBuilders.

B. stamp.ts — finish StampBuilder:
- Methods: fill (half-open, clipped), walls, blit (skips KEEP), usedHeight (highest non-KEEP layer + 1), toStamp (trimming to usedHeight is fine), rotateY(facing).
- Authoring convention: every structure is authored with its FRONT facing +Z (DIR_S = 2) and rotated around the footprint centre (square footprint: sx === sz = S).
- Exact voxel mapping, source (x,z) → destination:
  • facing S: (x, z)
  • facing N: (S-1-x, S-1-z)
  • facing E: (z, S-1-x)
  • facing W: (S-1-z, x)
- Continuous points (emitters, x,z ∈ [0,S]):
  • S: (x, z)
  • N: (S-x, S-z)
  • E: (z, S-x)
  • W: (S-z, x)
- Rotate emitters together with the stamp.
- Tests: four quarter turns = identity; after rotating a test stamp with a door on its +Z side, the door ends up on the side facing `facing` (N = -Z, E = +X, S = +Z, W = -X).

C. Generators.

General rules for every generator:
- Deterministic: seed an Rng from spec.variant and use hash2 / hash3 for per-window decisions; never Math.random.
- Never write outside the footprint (sx = sz = size × 8); STAMP_KEEP = leave untouched.
- Total height ≤ MAX_STRUCTURE_HEIGHT (80) + 1 layers.
- Layer 0 = the ground surface layer (world y = h - 1), for lawns, paths and parking; the structure starts at layer 1.
- Look & feel: several variants each; the buildingGen.ts doc comment lists the full intent.

Residential (warm, homey):
- L1 — small houses:
  • pitched / hip roofs as stepped voxel roofs (ROOF_RED / BROWN / GRAY / BLUE / GREEN);
  • PLASTER_* / BRICK_* / WOOD_SIDING walls;
  • a front DOOR with a path to the front edge (z = S-1, where the road's sidewalk is);
  • a CHIMNEY (smoke emitter, strength ~0.25);
  • a GRASS_LIGHT / GRASS yard with FENCE_WHITE or HEDGE, and a small tree or flower bed.
- L2 — townhouses / 3–5 storey walk-ups with BALCONY and flat ROOF_FLAT roofs with AC_UNIT.
- L3 — apartment towers (1×1 ≈ 20–40 tall, 2×2 ≈ 28–56) with balcony bands, a rooftop water tank or ANTENNA, and BEACON_RED on top when tall.

Commercial (urban, glassy, colourful signs):
- L1 — corner shops with AWNING_* over DOOR_GLASS shopfronts, glowing SIGN_* boards, and a small parking lot (ASPHALT + ROAD_LINE_WHITE stripes) or plaza.
- L2 — 4–8 storey offices with GLASS_BLUE / GLASS_TEAL bands on COM_CONCRETE / COM_PANEL / COM_STEEL frames.
- L3 — glass skyscrapers:
  • setbacks and curtain walls (GLASS_* + GLASS_LIT), a COM_MARBLE lobby;
  • spires / ANTENNA, HELIPAD + HELIPAD_MARK, BEACON_RED;
  • 2×2 up to ~78 tall;
  • rooftop vents as steam emitters.

Industrial (gritty):
- L1 — sheds / warehouses in METAL_SHEET / METAL_SHEET_DARK / METAL_BLUE / METAL_GREEN with big loading doors, CRATE stacks, and a GRAVEL / CONCRETE yard with HAZARD_YELLOW / BLACK markings.
- L2 — factories with sawtooth roofs, SMOKESTACK + SMOKESTACK_BAND chimneys (smoke emitters, strength 0.6–1.0), TANK_WHITE / TANK_SILVER tanks and PIPE runs.
- L3 — heavy industry: silos, big stacks, CONTAINER_RED / BLUE / GREEN stacks, METAL_RUST, cranes.

Windows: 3-voxel floors. Mix WINDOW and WINDOW_LIT with ≈ 40–60% lit, hashed per window so the pattern is stable; the city twinkles at night because emissive blocks glow with uNight. C offices are more lit, I buildings less.

Constructing (construction.ts): a FOUNDATION slab plus a SCAFFOLD frame up to (stage+1)/(CONSTRUCTION_STAGES+1) of the final height, with partial walls; a CRANE_YELLOW crane for level ≥ 2; no emitters.

Abandoned (applyAbandoned): the same silhouette, with:
- WINDOW_LIT / GLASS_LIT → GLASS_DARK or BOARDED;
- some walls → BOARDED;
- SIGN_* → BOARDED;
- RUBBLE in the yard;
- no emitters.

Zone lots (lotGen.ts): replace the top ground voxel with LOT_RES / LOT_COM / LOT_IND, add a 1-voxel LOT_*_EDGE border on the edges in edgeMask, and a tiny marker post at one corner. Lots must read clearly from far away: they are the player's main feedback before buildings grow.

Parks (lotGen.ts):
- lawn (GRASS_LIGHT / GRASS);
- PARK_PATH paths connecting to neighbouring parks and roads (parkMask / roadMask);
- 1–3 trees (LEAVES*, WOOD), BENCH_WOOD and flower beds;
- variants by hash: fountain (FOUNTAIN_STONE + WATER, 'fountain' emitter), playground (PLAY_RED / PLAY_BLUE), STATUE, small pond;
- deterministic from (tx, tz, seed).

Roads (roadGen.ts). These MUST match the ROAD_* constants in src/types.ts, because the traffic in src/fx relies on them.
- Stamp size TILE_SIZE × H × TILE_SIZE. On land, layer 0 = world y = h - 1: the road surface replaces the top ground voxel, flush with the neighbours, and cars drive at y = h.
- Cross-section perpendicular to travel:
  • voxels 0 and 7 = SIDEWALK, only on edges WITHOUT a road neighbour (connected edges continue the asphalt to the tile border);
  • voxels 1..6 = ASPHALT (two 3-voxel lanes);
  • CURB is optional on sidewalk edges.
- Markings:
  • straight segments: a dashed ROAD_LINE_YELLOW centre line in voxels 3–4;
  • intersections (≥ 3 connections): no centre line, ROAD_LINE_WHITE crosswalk stripes near the connected edges, sidewalk squares at the 4 corners;
  • dead ends: a sidewalk cap;
  • isolated tile: a small plaza / turning circle.
- Street lamps: a METAL_POLE (~5 tall) with a STREET_LAMP head on sidewalk voxels, about every other tile (hash of tx,tz); never on asphalt.
- Bridges (water tiles):
  • deck top face at BRIDGE_DECK_HEIGHT (12), i.e. deck voxel layer y = 11 (the water top is at y = 10);
  • a CONCRETE / ASPHALT deck with the same lane layout;
  • RAILING on edges without a road neighbour;
  • a BRIDGE_STEEL or CONCRETE pillar at the tile centre down to the bed;
  • water around the pillars untouched (STAMP_KEEP); originY = bed height.
- Roads between terraces of different heights: a 1–2 voxel step is acceptable (a ramp detail is optional).

D. Perf: generateBuilding ≤ ~0.2 ms on average. Avoid per-voxel allocations; StampBuilder data is a Uint8Array.

RULES:
(1) No npm install, no git commit.
(2) `npx tsc --noEmit` (run in /home/claude/vcb) must report no errors in your files; ignore errors in files you don't own (others are mid-edit). verbatimModuleSyntax: type-only imports via `import type` / inline `type`. No TS enums. strict, noImplicitReturns, noFallthroughCasesInSwitch, noImplicitOverride.
(3) Keep the exported names, constructor signatures and file paths listed above.
(4) Never throw out of per-frame methods; validate inputs.
(5) No per-frame allocations in hot paths; typed arrays for bulk data.
(6) Subscribe to the bus in the constructor and unsubscribe in dispose().
(7) Determinism: buildings, roads, lots and parks are re-stamped on load, so all randomness comes from seeds (variant, terrain seed, tile coords) via src/core/rng.ts — never Math.random. Same record ⇒ identical voxels.
(8) Scratch / test files only in your session scratchpad, never in the repo (no dist/ in the repo).
(9) If a contract seems wrong or missing, do NOT change it: work around it inside your files and report it at the end.
(10) Kill every background process you start before you finish.

TESTING TOOLS:
(a) Pure TS in Node: put an entry .ts in your scratchpad that imports your module by absolute path (src/...). From /home/claude/vcb run `npx rolldown <entry.ts> --format esm --platform node --file <out.mjs> && node <out.mjs>`. Rolldown compiles TS and resolves 'three' for files inside the repo.
(b) Browser:
  • Start a dev server in the background WITHOUT `cd … &&` in front (so $! is the server PID): `VCB_VITE_CACHE=<scratch>/vite-cache node node_modules/vite/bin/vite.js <root dir> --port 5244 --strictPort > <scratch>/vite.log 2>&1 &` then `echo $! > <scratch>/vite.pid`.
  • Run `node scripts/smoke.mjs --url '<url>' --wait 8000 --shot <scratch>/a.png --eval '<js>'`. --eval is repeatable and may return a Promise; other options: --after, --width/--height, --timeout. Exit code 1 on page errors. Look at the PNG with your image-reading tool.
  • Headless Chromium renders with SwiftShader, which is slow: judge correctness and looks, not FPS.
  • Afterwards `kill $(cat <scratch>/vite.pid)` and check that `pgrep -af vite` no longer lists it.
  • Your port: 5244 (try the next ports if busy). Always set VCB_VITE_CACHE to a private directory.
(c) Isolation: other agents rewrite their modules concurrently.
  • `bash scripts/harness.sh <new empty dir in your scratchpad> src/build` builds a runnable copy = pristine skeleton + your live files (node_modules symlinked). Run vite with that dir as root.
  • Inside the copy you may add private test pages and fakes — never in the repo.
  • Skeleton state: naive VoxelWorld, flat dry Terrain at h 12, naive mesher (no AO), sync mesh manager, scene stub (daylight, no shadows, uNight 0). The sim, tools, fx and UI are inert stubs, so in the plain skeleton the city is empty.

TESTS FOR THIS MODULE:
1. Node (rolldown):
  • determinism (same spec → identical bytes, over many variants);
  • bounds: stamp size, no writes outside the footprint, height limit;
  • rotation (see B) and emitter positions (inside the stamp, rotated);
  • perf: 1000 random specs.
  • StructureSync with a fake CityReader plus the skeleton's naive world/terrain (/home/claude/vcb-skeleton/src/voxel/world.ts, terrain.ts):
    – keys;
    – 2×2 buildings stamped once;
    – removal restores lots;
    – neighbour updates (adding a road next to a road changes both masks);
    – reset()/flush() idempotence (a second flush stamps nothing);
    – emitter bookkeeping.
2. Visual gallery (most important).
  • Run `bash scripts/harness.sh <scratch>/hb src/build`.
  • Add <scratch>/hb/gallery.html (copy index.html, with script src /src/gallery.ts) and <scratch>/hb/src/gallery.ts. The gallery script:
    – imports './render/colorSetup' first;
    – creates createSceneContext(viewport), a VoxelWorld, Terrain(1) (flat) and createGameBus();
    – builds a FakeCity implementing CityReader with: a road grid covering all mask shapes; a few bridges (use a small ITerrain wrapper that reports water for some tiles and restores water there); zone lots of each zone; parks of each variant; and buildings for every zone × level × size × state (stages 0..2, Active, Abandoned) × facing;
    – then new StructureSync({...}), reset(), flush();
    – adds a ChunkMeshManager on view.worldRoot and runs a rAF loop (meshes.update(camera, focus); view.render());
    – exposes window.__gallery to move the camera and toggle night (set sharedUniforms.uNight.value = 1 in the gallery loop to preview lit windows).
  • Screenshot with node scripts/smoke.mjs --url http://127.0.0.1:5244/gallery.html from several angles and close-ups.
  • Iterate on the looks until every zone and level is distinct and attractive. The harness mesher has no AO or shadows, so judge silhouettes and colour.

FINAL REPORT (your last message): files changed/added; what is implemented and what is not; how you tested (commands, key numbers, gallery screenshot paths); performance vs. targets; known issues; contract problems you worked around (contracts unchanged). Confirm that none of your dev servers or other background processes is still running.

## Done means
`npx tsc --noEmit` passes for your files against the frozen contracts; report any contract problems instead of editing contract files.
