# Module: voxel-world

Status: IN PROGRESS on the main build thread
Suggested effort: max

## Files you own (edit only these)
- src/voxel/world.ts
- src/voxel/terrain.ts
- src/voxel/noise.ts
- src/voxel/decor.ts

## Brief

ROLE: You are the voxel-world agent, one of 8 agents building a browser 3D voxel city builder IN PARALLEL in the shared tree /home/claude/vcb (TypeScript 7/tsgo strict, three r186, Vite 8; no external assets, everything procedural). The architect wrote frozen contracts, the composition root (src/game.ts) and a runnable skeleton; you replace the naive/stub code in YOUR files with complete, production-quality implementations. The final game must be genuinely playable and fun-looking, and the terrain is most of what the player sees first.

READ FIRST: ARCHITECTURE.md (whole file; most relevant: §3 coordinates, §4 terrain, §5 palette, §6 storage & dirty tracking, §19 budgets), src/types.ts (constants; IVoxelWorld, TerrainReader, ITerrain, VoxelStamp), src/game.ts (TerrainProxy; newCity / applyPayload order), the frozen helpers src/core/coords.ts (chunkKey, chunkCoordsFromKey, chunkInBounds, chunkVoxelIndex, paddedIndex, stampIndex, tileIndex, inMap), src/core/rng.ts (Rng, hash2, hash3, mixSeed, hashToUnit), src/voxel/blocks.ts (B ids, STAMP_KEEP), and the doc comments in YOUR files (they are part of this spec). If docs and frozen code disagree, the code wins.

YOU OWN (edit only these; new files allowed only inside src/voxel/, where blocks.ts is frozen): src/voxel/world.ts, src/voxel/terrain.ts, src/voxel/noise.ts, src/voxel/decor.ts.

NEVER EDIT: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, src/render/colorSetup.ts, src/game.ts, src/main.ts, index.html, src/style.css, tsconfig.json, vite.config.ts, package.json, ARCHITECTURE.md, scripts/*, /home/claude/vcb-skeleton/*, node_modules, or any other module's files. Allowed imports: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, 'three' (+ 'three/examples/jsm/...' addons) and your own files; never another module's implementation (src/game.ts wires the modules together through the interfaces). The integrator will run the full game with every real module: code against the interface contracts, not against the skeleton stubs' current behaviour.

EXPORTS THAT MUST STAY (src/game.ts uses them): `export class VoxelWorld implements IVoxelWorld` with a no-argument constructor (`new VoxelWorld()`, one instance for the whole session; for every new city / load the game calls world.clear() and then terrain.generateInto(world)). `export class Terrain implements ITerrain` with `constructor(seed: number, mapTiles: number = MAP_TILES)`, `readonly seed` (= seed >>> 0) and `readonly mapTiles` (`new Terrain(seed, MAP_TILES)`, constructed synchronously and handed to every module through a TerrainProxy). The noise.ts / decor.ts APIs are module-internal (change freely). Who calls you: meshing (extractPadded / takeDirtyChunks / getChunkVersion / isChunkEmpty / markAllDirty, per chunk); structures (fillBox / applyStamp / restoreTile per tile; their road / lot / building stamps REPLACE the top ground voxel at y = h-1); simulation (getTileHeight / isWater / hasNaturalDecor at newCity and for building rules); camera and picking (getSurfaceHeight); traffic (via roadSurfaceY); the UI minimap (getGroundBlock, isWater, getTileHeight).

A. src/voxel/world.ts: replace the NAIVE REFERENCE (every bulk op goes through setBlock) with the optimized design from its doc comment, keeping all semantics.
- World 512×128×512 voxels = 16×4×16 chunks of 32³ (CHUNK_COUNT 1024). Storage: (Uint8Array(CHUNK_VOLUME) | null)[] indexed by chunkKey(cx,cy,cz) = (cy*16+cz)*16+cx; voxel index lx + 32*(lz + 32*ly). null means all AIR: allocate lazily, never allocate for AIR writes. Keep an Int32Array non-air count per chunk and release a chunk's array when its count drops to 0; isChunkEmpty is O(1) (out-of-range chunk coords → true).
- getBlock: out of bounds → B.AIR. setBlock: OOB writes ignored; id &= 255; STAMP_KEEP (255) is never stored; write only if the value changes; maintain counts; bump revision; dirty-mark.
- Dirty tracking: a changed voxel dirties its own chunk AND every neighbour chunk whose padded 34³ border contains it (local 0 or 31 on an axis → the neighbour across that face, plus edge/corner neighbours: up to 7). markChunkDirty(cx,cy,cz) (OOB ignored) bumps that chunk's version (Uint32Array) and adds its key to a Set; takeDirtyChunks() returns the keys as number[] and clears the set; markAllDirty() marks all 1024; getChunkVersion(key) returns 0 for invalid keys.
- fillBox(x0,y0,z0,x1,y1,z1,id) is half-open and clipped (empty or inverted boxes are no-ops). applyStamp(stamp, ox,oy,oz): data index x + sx*(z + sz*y), skip STAMP_KEEP, clip to bounds including negative origins. Implement both chunk by chunk with direct array writes (TypedArray.fill / subarray for runs where possible), with change detection and count maintenance. For each touched chunk, track the bounding box of the CHANGED voxels and dirty-mark that chunk plus the neighbours its changed box touches. Bump each dirty chunk's version once per operation; revision increases (≥ 1) only if something changed. No allocations per call except new chunk arrays.
- getColumnTop(x,z): highest non-AIR y, or -1 (OOB → -1); scan down from the highest allocated chunk in that column.
- extractPadded(cx,cy,cz,out): fill `out` (PADDED_VOLUME = 39304, index px + 34*(pz + 34*py), p = local + 1) with the chunk plus a 1-voxel border from its up to 26 neighbours. Outside the world: y < 0 → B.BEDROCK; outside in x/z or y ≥ 128 → AIR. Copy row-wise (no getBlock per voxel). Return true iff the chunk interior has any non-AIR voxel. Never allocate: this runs for every meshed chunk.
- clear(): marks every previously non-empty chunk dirty (version++), drops all chunk arrays, resets counts and bumps revision.
- Perf targets: setBlock ≥ 20 M/s; extractPadded ≤ 0.3 ms; fillBox 8×116×8 ≤ 0.2 ms; full-map terrain write (512×512×~14) ≤ 150 ms.

B. src/voxel/noise.ts: seeded 2D simplex (or gradient) noise with a permutation table shuffled by Rng, output ≈ [-1,1]; fbm2, ridged2 and a domain-warp helper for natural rivers and coastlines. Pure, fast, deterministic.

C. src/voxel/terrain.ts: the real generator. Its doc comment is the spec; key points and extra constraints:
- The constructor computes per-tile arrays (TILE_COUNT = 4096): height, water flag, decor kind/variant, ground block. It must finish in < 30 ms, because the sim, camera and minimap query the terrain before voxels exist. All queries are O(1); out-of-map tile queries clamp to the nearest edge tile; getSurfaceHeight = max(h, WATER_LEVEL).
- Every tile is FLAT: all 64 columns of a tile share ground height h (ground voxels y ∈ [0,h-1]; structures start at y = h).
- Layout:
  • A large central plain at exactly BASE_GROUND_HEIGHT = 12, covering ≥ ~55% of tiles; the central 16×16 tiles (tx,tz ∈ [24,40)) are always dry plain at 12.
  • Gentle terraced hills toward the map edges, up to MAX_GROUND_HEIGHT = 36, with |Δh| ≤ 2 between 4-neighbouring LAND tiles everywhere (enforce with relaxation passes after placing water and beaches).
  • One meandering river crossing the map (2–4 tiles wide, natural curves via domain warp) and/or 1–2 lakes; ≥ 70% of tiles stay land.
  • No 1-tile puddles, spikes or pits.
  • Water bed heights in [MIN_GROUND_HEIGHT 4, WATER_LEVEL-1 = 9], deeper away from the shore; water voxels fill y ∈ [h, 9] (water top face at y = 10).
  • Beaches: every land tile 4-adjacent to water has h = WATER_LEVEL+1 = 11 with SAND on top.
- Starter road (IMPORTANT): the simulation's newCity lays a free road along row tz = 32, from tx = 0 (the west map edge, i.e. the highway / region connection) to tx = 32, bridging water. Guarantee: tile (0,32) is land, a lake never swallows that row, and water on that row only appears as river crossings of ≤ 4 consecutive tiles (a river crossing there is welcome: the first road gets a bridge).
- Map edge: outside the world the mesher sees AIR, so the edge shows as a cross-section, and the atmosphere module draws an ocean ring around the map at y ≈ 9.9. Optionally let some edge stretches descend to beaches so the island meets the ocean naturally.
- Voxel layering per column: y = 0 BEDROCK; STONE y ∈ [1, h-5]; DIRT y ∈ [h-4, h-2]; the top voxel y = h-1 is the ground block (clamp these ranges for small h).
  • Grass tops vary per COLUMN in large low-frequency patches (GRASS / GRASS_DARK / GRASS_LIGHT; patches ≥ ~6–10 voxels so greedy meshing still merges). This must be a pure function of (x, z, seed) so restoreTile can reproduce it.
  • High terrain: ROCK tops above h ≈ 28, SNOW caps above ≈ 34.
  • Water tiles: SAND / GRAVEL / CLAY beds chosen by noise, then WATER.
  • getGroundBlock(tx,tz) = the tile's representative natural top block (the bed block for water); the minimap colours tiles with it.
- Decor (src/voxel/decor.ts; kinds oak | pine | birch | autumn | blossom | bush | flowers):
  • Placement: forest density from noise — dense clustered forests on hills, sparse trees and flower meadows on the plain; none in the central 12×12 tiles ([26,38)), none on beaches or water.
  • At most one tree per tile, and EVERY decor voxel stays inside its own tile's 8×8 footprint (trunk near local (3..4, 3..4), canopy radius ≤ 3, height ≤ 14 above h), so clearing a tile never leaves half a tree on a neighbour.
  • Blocks: WOOD trunks; LEAVES / LEAVES_DARK / LEAVES_LIGHT round canopies; PINE layered cones; rare LEAVES_AUTUMN / LEAVES_PINK; BUSH clumps; FLOWER_RED / YELLOW / WHITE / PURPLE single voxels at y = h (several per tile allowed).
  • Deterministic from hash2(tx,tz,seed). hasNaturalDecor(tx,tz) = the tile has any decor. The simulation copies it into TILE_FLAG_DECOR; building on such a tile costs extra and clears it.
- generateInto(world): writes the whole natural map (ground, water, decor) into an all-AIR world. Target < 400 ms total: fillBox per tile layer plus per-column top-voxel writes, no per-voxel getBlock.
- restoreTile(world, tx, tz, withDecor): OOB → no-op. Rewrites the tile's 8×8 footprint for ALL y ∈ [0,128) to exactly what generateInto produced there (ground layers, water on water tiles, AIR above), plus the tile's decor iff withDecor. It never touches a voxel outside the footprint. Budget ≤ 0.1 ms per call: the structures module calls it before every (re)stamp of a road / lot / building / park tile and when land is bulldozed back to nature (a full-city load restores up to 4096 tiles). Afterwards the natural top block MUST be back at y = h-1, because stamps replace it.

RULES:
(1) No npm install, no git commit.
(2) `npx tsc --noEmit` (run in /home/claude/vcb) must report no errors in your files; ignore errors in files you don't own (others are mid-edit). verbatimModuleSyntax: type-only imports via `import type` / inline `type`. No TS enums. strict, noImplicitReturns, noFallthroughCasesInSwitch, noImplicitOverride.
(3) Keep the exported names, constructor signatures and file paths listed above.
(4) Never throw out of per-frame methods; validate inputs; out-of-range queries return neutral values.
(5) No per-frame allocations in hot paths; typed arrays for bulk data.
(6) Determinism: everything here is regenerated on load, so all randomness comes from the seed via src/core/rng.ts and your seeded noise — never Math.random.
(7) Scratch / test files only in your session scratchpad, never in the repo (no dist/ in the repo; production builds only with --outDir <scratch>).
(8) If a contract seems wrong or missing, do NOT change it: work around it inside your files and report it at the end.
(9) Kill every background process you start before you finish.

TESTING TOOLS:
(a) Pure TS in Node: put an entry .ts in your scratchpad that imports your module by absolute path (src/...). From /home/claude/vcb run `npx rolldown <entry.ts> --format esm --platform node --file <out.mjs> && node <out.mjs>`. Rolldown compiles TS and resolves 'three' for files inside the repo; if the entry itself needs three, import node_modules/three/build/three.module.js.
(b) Browser:
  • Start a dev server in the background WITHOUT `cd … &&` in front (so $! is the server PID): `VCB_VITE_CACHE=<scratch>/vite-cache node node_modules/vite/bin/vite.js <root dir> --port 5211 --strictPort > <scratch>/vite.log 2>&1 &` then `echo $! > <scratch>/vite.pid`.
  • Run `node scripts/smoke.mjs --url 'http://127.0.0.1:5211/?fresh&seed=7' --wait 8000 --shot <scratch>/a.png --eval '<js>'`. --eval is repeatable and may return a Promise; other options: --after <ms>, --width/--height, --timeout. Exit code 1 on page errors. Look at the PNG with your image-reading tool.
  • window.__vcb is the Game (fields sim, world, view, meshes, structures, rig, tools, fx, saves, ui, bus, terrain).
  • Headless Chromium renders with SwiftShader, which is slow: judge correctness and looks, not FPS.
  • Afterwards `kill $(cat <scratch>/vite.pid)` and check that `pgrep -af vite` no longer lists it.
  • Your port: 5211 (try the next ports if busy). Always set VCB_VITE_CACHE to a private directory.
(c) Isolation: other agents rewrite their modules concurrently, so the shared tree may be temporarily broken.
  • `bash scripts/harness.sh <new empty dir in your scratchpad> <live paths…>` builds a runnable copy = pristine skeleton + the live versions of the listed paths (node_modules symlinked). Run vite with that dir as root.
  • Inside such a copy you may add private test pages (e.g. <dest>/test.html + <dest>/src/test.ts) and replace other modules' files with fakes — never in the repo.
  • Skeleton state: src/voxel/world.ts, src/voxel/terrain.ts (flat dry grass plain, ground height 12), src/mesh/greedy.ts (one quad per face, no AO) and src/mesh/chunkMeshManager.ts (synchronous main-thread meshing) are naive but working. The sim, structures, tool controller, fx, saves and UI (except its loading overlay) are inert stubs. The camera-rig stub only applies reset()/setState() poses; for screenshots use --eval 'window.__vcb.rig.setState({x:256,z:256,yaw:0.8,pitch:0.7,distance:200},true)'. The scene stub has fixed daylight, no shadows and uNight = 0.

TESTS FOR THIS MODULE:
1. World vs oracle. /home/claude/vcb-skeleton/src/voxel/world.ts is the naive reference (read-only). In Node, run thousands of random setBlock / fillBox / applyStamp (with KEEP voxels, partly out of bounds) / clear operations on both implementations and compare:
  • getBlock over the touched regions;
  • isChunkEmpty for all chunks;
  • getColumnTop;
  • extractPadded output for random chunks, including world-edge chunks;
  • revision changes only when something changed;
  • dirty sets: yours must contain every key the naive one marks (never miss one) and may only add chunks adjacent to the changed region.
  Benchmark the perf targets.
2. Terrain exactness. Run generateInto(W1). Run generateInto(W2), then for every tile overwrite its footprint with garbage (random fillBox, including high above the ground) and call restoreTile(W2, tx, tz, hasNaturalDecor(tx,tz)). W1 and W2 must be identical voxel by voxel over the whole world. Also, restoreTile(…, false) must remove every non-AIR voxel above h on that tile (water stays on water tiles) and change nothing outside the tile.
3. Invariants over ≥ 50 seeds: flat tiles; |Δh| ≤ 2 for land neighbours; ≥ 70% land; central plain and no-decor rules; starter-row rule; beaches at 11 with SAND; bed range; decor confined to its tile; determinism (same seed → identical arrays and voxels; different seeds → different maps).
4. Timings: Terrain constructor < 30 ms, generateInto < 400 ms, restoreTile average < 0.1 ms.
5. Visual: run `bash scripts/harness.sh <scratch>/hv src/voxel`, start vite on that dir, and take screenshots for several seeds (?fresh&seed=1 … 6) from varied poses via rig.setState evals: overview (distance ~450), mid (~200), close (~60), low pitch (~0.45). The skeleton mesher has no AO and the scene stub no shadows, so judge layout, colours, rivers, beaches, terraces, forests, flowers and the map edge. Iterate until it looks great.

FINAL REPORT (your last message): files changed/added; what is implemented and what is not; how you tested (commands, key numbers, screenshot paths); performance vs. targets; known issues; contract problems you worked around (contracts unchanged). Confirm that none of your dev servers or other background processes is still running.

## Done means
`npx tsc --noEmit` passes for your files against the frozen contracts; report any contract problems instead of editing contract files.
