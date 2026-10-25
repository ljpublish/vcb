# Module: meshing

Status: IN PROGRESS on the main build thread
Suggested effort: max

## Files you own (edit only these)
- src/mesh/greedy.ts
- src/mesh/mesher.worker.ts
- src/mesh/chunkMeshManager.ts
- src/mesh/materials.ts

## Brief

ROLE: You are the meshing agent, one of 8 agents building a browser 3D voxel city builder IN PARALLEL in the shared tree /home/claude/vcb (TypeScript 7/tsgo strict, three r186, Vite 8; no external assets, everything procedural). The architect wrote frozen contracts, the composition root (src/game.ts) and a runnable skeleton; you replace the naive/stub code in YOUR files with complete, production-quality implementations. Your goal: greedy-meshed chunks with baked ambient occlusion and night-glowing emissive blocks, meshed in a Web Worker pool and uploaded without hitches.

READ FIRST: ARCHITECTURE.md (whole file; most relevant: §5 palette, §6 storage, §7 meshing pipeline & worker protocol, §8 rendering & day/night, §19 budgets), src/types.ts (IVoxelWorld, ChunkMeshManagerDeps, IChunkMeshManager, MeshStats, CHUNK_* / PADDED_* constants), src/game.ts, src/mesh/protocol.ts (FROZEN — read it fully), src/voxel/blocks.ts (BLOCK_FLAGS, FLAG_SOLID / TRANSPARENT / EMISSIVE / OPAQUE / AO, BLOCK_RGB, BLOCK_EMISSIVE_RGB), src/core/coords.ts (chunkCoordsFromKey, paddedIndex), src/render/sharedUniforms.ts, src/render/colorSetup.ts, and the doc comments in YOUR files (they are part of this spec). If docs and frozen code disagree, the code wins.

YOU OWN (edit only these; new files allowed only inside src/mesh/, where protocol.ts is frozen): src/mesh/greedy.ts, src/mesh/mesher.worker.ts, src/mesh/chunkMeshManager.ts, src/mesh/materials.ts.

NEVER EDIT: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, src/render/colorSetup.ts, src/game.ts, src/main.ts, index.html, src/style.css, tsconfig.json, vite.config.ts, package.json, ARCHITECTURE.md, scripts/*, /home/claude/vcb-skeleton/*, node_modules, or any other module's files. Allowed imports: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, 'three' (+ 'three/examples/jsm/...' addons) and your own files; never another module's implementation (src/game.ts wires the modules together through the interfaces). The integrator will run the full game with every real module: code against the interface contracts, not against the skeleton stubs' current behaviour.

EXPORTS THAT MUST STAY (src/game.ts uses them):
- `export class ChunkMeshManager implements IChunkMeshManager` with `constructor(deps: ChunkMeshManagerDeps)`. game.ts calls `new ChunkMeshManager({ world, parent: view.worldRoot })`. Each frame it calls `meshes.update(view.camera, rig.getFocus())`. On new city / load it calls `meshes.rebuildAll()`, then waits behind the loading overlay until `meshes.idle` (≤ 12 s). `getStats()` feeds the debug overlay.
- `export function greedyMesh(padded: Uint8Array): ChunkMeshData` in greedy.ts. It is bundled into the worker, so it must stay worker-safe: no DOM or three imports; import only ../types, ../voxel/blocks and ./protocol.
- The materials.ts API is module-internal.

A. greedy.ts: replace the NAIVE REFERENCE (one quad per visible face, no AO, JS arrays) with the real greedy mesher. The file's doc comment is the spec.
- Input: PADDED_VOLUME (34³) bytes, index px + 34*(pz + 34*py), p = chunk-local + 1. Only the inner 32³ voxels emit faces; the border is read for culling and AO.
- Face rules via BLOCK_FLAGS:
  • An OPAQUE block (FLAG_OPAQUE; note that undefined ids 1..254 are opaque magenta) emits a face toward any neighbour without FLAG_OPAQUE (AIR or WATER).
  • WATER (FLAG_TRANSPARENT) emits faces only toward non-solid neighbours (AIR): no water/water or water/solid faces.
  • Opaque faces go to the `opaque` buffers, water faces to the `transparent` buffers; a pass is null when empty.
- Vertex format:
  • positions: chunk-local in [0,32], Float32 ×3;
  • normals: Int8 ×3 axis unit vectors;
  • colours: Uint8 ×3 = BLOCK_RGB × AO_CURVE[ao], with AO_CURVE ≈ [0.50, 0.68, 0.84, 1.0], rounded;
  • emissive: Uint8 ×3 = BLOCK_EMISSIVE_RGB, unaffected by AO;
  • indices: Uint16Array when vertexCount ≤ 65535, else Uint32Array;
  • winding: CCW seen from the normal side (cross(v1-v0, v2-v0) · n > 0).
- AO: classic per-vertex 0..3 from the side1 / side2 / corner voxels in the layer in front of the face; occluders = FLAG_AO; ao = (side1 && side2) ? 0 : 3 - (side1 + side2 + corner). Water faces get no AO (3).
- Greedy merge per direction and slice over faces with an identical key (block id + the 4 AO values, e.g. packed id | ao0<<8 | …); water is merged by id. Flip the quad diagonal when ao0 + ao2 < ao1 + ao3 (anisotropy fix), consistently with your vertex order.
- Optional: lower water top faces to y + 0.9 for a nicer shoreline.
- Allocation: module-level scratch (Int32 32×32 mask; growable typed vertex/index buffers, doubled when full). Copy out exact-size typed arrays at the end, since they are transferred.
- Perf: ≤ 3 ms for a typical terrain+buildings chunk, ≤ 8 ms worst case (checkerboard-ish). Expect 10–30× fewer triangles than the naive mesher on terrain.

B. mesher.worker.ts: already functional. It receives a MeshRequest and posts a MeshResult, transferring all buffers, including the request's voxel buffer, which goes back for pooling. Failures are reported as MeshError; it never throws. Keep `declare const self: DedicatedWorkerGlobalScope;`. You may extend it (e.g. batching several requests) within the protocol types.

C. materials.ts (spec in its doc comment):
- Opaque material: MeshLambertMaterial({ vertexColors: true }) patched in onBeforeCompile:
  • vertex shader: add `attribute vec3 aEmissive; varying vec3 vEmissive;` and `vEmissive = aEmissive;`;
  • fragment shader: add `uniform float uNight; varying vec3 vEmissive;`, and after `#include <emissivemap_fragment>` add `totalEmissiveRadiance += vEmissive * uNight * NIGHT_GLOW;`. NIGHT_GLOW ≈ 1.0–1.6; tune it so lit windows, street lamps, signs and beacons read clearly at night.
  • Bind `shader.uniforms.uNight = sharedUniforms.uNight` BY REFERENCE (only src/render/scene.ts writes the values).
  • Set a stable customProgramCacheKey.
  • Fog (scene.fog) and shadows (cast + receive) must keep working.
- Water material: transparent, opacity ≈ 0.78, depthWrite false, vertex colours, receives shadows. An optional cheap, subtle shimmer may use sharedUniforms.uTime / uSun. The atmosphere module draws an ocean ring around the map in a similar colour (WATER = 0x3b8fd9).
- Colour pipeline (WYSIWYG): three's ColorManagement is disabled globally and the renderer outputs LinearSRGBColorSpace with no conversion, so vertex colour bytes are the final display colours. Never convert sRGB↔linear.
- buildChunkGeometry(buffers): attributes 'position' (Float32 ×3), 'normal' (Int8 ×3, normalized false), 'color' (Uint8 ×3, normalized) and 'aEmissive' (Uint8 ×3, normalized — NOT 'emissive', which clashes with three's uniform), plus the index. Set boundingBox / boundingSphere from the chunk bounds (no compute).

D. chunkMeshManager.ts: replace the NAIVE synchronous manager with the worker pool described in its doc comment.
- Pool: N = deps.workerCount ?? clamp((navigator.hardwareConcurrency || 4) - 1, 1, 4) workers, created EXACTLY as `new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })`. This literal form is what Vite 8 bundles; it is verified in this repo for dev and build.
- Fallback: if Worker is unavailable or construction throws, or every worker has died (on a worker 'error' event, mark it dead and requeue its in-flight chunks), mesh synchronously with greedyMesh on the main thread under ~4 ms/frame, and log once.
- update(camera, focus):
  1. pending ∪= world.takeDirtyChunks().
  2. While some worker has < 2 jobs in flight: pick the pending chunk nearest to the focus, preferring chunks inside the camera frustum (compute the frustum once per frame with reused objects). If the chunk is empty (world.isChunkEmpty), remove its meshes and send no job. Otherwise extract it into a pooled 34³ buffer (world.extractPadded) and post MeshRequest{ jobId, key, version: world.getChunkVersion(key), voxels }, transferring the buffer. Never have two jobs for the same chunk in flight: a chunk re-dirtied while in flight stays pending and is re-sent after its result lands.
  3. Apply finished results: buildChunkGeometry, then swap the geometry into the chunk's Mesh. On first use create Mesh(geometry, sharedMaterial) with name `chunk:${cx},${cy},${cz}`, position = chunk origin × 32, matrixAutoUpdate = false + updateMatrix(); opaque meshes castShadow + receiveShadow, water meshes receiveShadow only. Dispose old geometries and remove meshes whose pass became empty. Results older than the current version are still applied, since the chunk is pending again anyway. Limit GPU uploads to ≈ 24 results or ~4 ms per frame, but allow a bigger budget while the backlog is large (the initial load runs behind the loading overlay and should finish fast).
  4. Return voxel buffers to the pool. On MeshError: retry once, then keep the old mesh for that version.
- rebuildAll(): world.markAllDirty(), and pull the keys into pending immediately, so `idle` is false right after the call.
- idle: nothing pending, nothing in flight, no unapplied results.
- getStats(): meshes, triangles (incremental counter), queued, inFlight, workers (alive count; 0 in fallback), avgMeshMs (rolling worker ms), meshedTotal.
- dispose(): terminate workers, ignore late messages, dispose geometries and materials, remove meshes.
- Perf: the initial world (≈ 300–700 non-empty chunks after terrain + city) is fully meshed in < 2.5 s with 3–4 workers. update() costs < 0.1 ms when idle and ≤ 2 ms including uploads, with zero allocations per frame when idle.

RULES:
(1) No npm install, no git commit.
(2) `npx tsc --noEmit` (run in /home/claude/vcb) must report no errors in your files; ignore errors in files you don't own (others are mid-edit). verbatimModuleSyntax: type-only imports via `import type` / inline `type`. No TS enums. strict, noImplicitReturns, noFallthroughCasesInSwitch, noImplicitOverride.
(3) Keep the exported names, constructor signatures and file paths listed above.
(4) Never throw out of per-frame methods; validate inputs.
(5) No per-frame allocations in hot paths; typed arrays for bulk data.
(6) Remove every listener and terminate workers in dispose().
(7) Scratch / test files only in your session scratchpad, never in the repo (no dist/ in the repo; production builds only with --outDir <scratch>).
(8) If a contract seems wrong or missing, do NOT change it: work around it inside your files and report it at the end.
(9) Kill every background process you start before you finish.

TESTING TOOLS:
(a) Pure TS in Node: put an entry .ts in your scratchpad that imports your module by absolute path (src/...). From /home/claude/vcb run `npx rolldown <entry.ts> --format esm --platform node --file <out.mjs> && node <out.mjs>`. Rolldown compiles TS and resolves 'three' for files inside the repo; if the entry itself needs three, import node_modules/three/build/three.module.js.
(b) Browser:
  • Start a dev server in the background WITHOUT `cd … &&` in front (so $! is the server PID): `VCB_VITE_CACHE=<scratch>/vite-cache node node_modules/vite/bin/vite.js <root dir> --port 5222 --strictPort > <scratch>/vite.log 2>&1 &` then `echo $! > <scratch>/vite.pid`.
  • Run `node scripts/smoke.mjs --url 'http://127.0.0.1:5222/?fresh&seed=7' --wait 8000 --shot <scratch>/a.png --eval '<js>'`. --eval is repeatable and may return a Promise; other options: --after <ms>, --width/--height, --timeout. Exit code 1 on page errors. Look at the PNG with your image-reading tool.
  • window.__vcb is the Game (fields sim, world, view, meshes, structures, rig, tools, fx, saves, ui, bus, terrain).
  • Headless Chromium renders with SwiftShader, which is slow: judge correctness and looks, not FPS.
  • Afterwards `kill $(cat <scratch>/vite.pid)` and check that `pgrep -af vite` no longer lists it.
  • Your port: 5222 (try the next ports if busy). Always set VCB_VITE_CACHE to a private directory.
(c) Isolation: other agents rewrite their modules concurrently, so the shared tree may be temporarily broken.
  • `bash scripts/harness.sh <new empty dir in your scratchpad> <live paths…>` builds a runnable copy = pristine skeleton + the live versions of the listed paths (node_modules symlinked). Run vite with that dir as root.
  • Inside such a copy you may add private test pages and replace other modules' files with fakes — never in the repo.
  • Skeleton state: src/voxel/world.ts and src/voxel/terrain.ts (flat dry grass plain, ground height 12) are naive but working. The sim, structures, tool controller, fx, saves and UI (except its loading overlay) are inert stubs. The camera-rig stub only applies reset()/setState() poses, e.g. --eval 'window.__vcb.rig.setState({x:256,z:256,yaw:0.8,pitch:0.7,distance:60},true)'. The scene stub has fixed daylight, no shadows and uNight = 0.

TESTS FOR THIS MODULE:
1. Node differential test against the naive mesher /home/claude/vcb-skeleton/src/mesh/greedy.ts (read-only oracle: one quad per visible unit face).
  • Volumes: many padded volumes — terrain-like layers, 30% random noise, checkerboard, water pools with shores, emissive blocks, solid vs air borders, all-solid, all-air.
  • Rasterize your quads back into unit faces per direction/cell and assert:
    – the face set equals the naive one exactly (no holes, no overlaps or duplicates);
    – emissive values match;
    – normals and winding are correct;
    – each colour = BLOCK_RGB × an AO_CURVE value.
  • Check AO on hand-made configurations (a block in a corner, under an overhang) and index-type switching.
  • Benchmark typical and worst-case chunk times.
2. Browser: run `bash scripts/harness.sh <scratch>/hm src/mesh` and start vite on it.
  • Smoke with --eval 'window.__vcb.meshes.getStats()' (expect workers ≥ 1, meshes > 0).
  • Time a rebuild with --eval 'new Promise(r=>{window.__vcb.meshes.rebuildAll();const t0=performance.now();const f=()=>window.__vcb.meshes.idle?r(performance.now()-t0):requestAnimationFrame(f);requestAnimationFrame(f);})'.
  • Add geometry via evals, e.g. 'window.__vcb.world.fillBox(240,12,240,248,60,248,57)' plus random towers and holes, including across chunk borders. Wait, then screenshot close-ups to verify AO and seams: no cracks and no missing faces at x/z multiples of 32.
  • Night glow: the stub scene keeps uNight = 0. Edit the HARNESS COPY's src/render/scene.ts (copy only) to set sharedUniforms.uNight.value = 1, then screenshot WINDOW_LIT (58), STREET_LAMP (41) and SIGN_* (104–108) blocks.
  • Also test the main-thread fallback (e.g. pass workerCount or make Worker throw in the harness copy's game.ts) and dispose().

FINAL REPORT (your last message): files changed/added; what is implemented and what is not; how you tested (commands, key numbers, screenshot paths); performance vs. targets (ms per chunk, triangle reduction, initial meshing time); known issues; contract problems you worked around (contracts unchanged). Confirm that none of your dev servers or other background processes is still running.

## Done means
`npx tsc --noEmit` passes for your files against the frozen contracts; report any contract problems instead of editing contract files.
