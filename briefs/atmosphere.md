# Module: atmosphere

Status: QUEUED, available to hand off
Suggested effort: max

## Files you own (edit only these)
- src/render/scene.ts
- src/render/sky.ts
- src/fx/effects.ts
- src/fx/traffic.ts
- src/fx/particles.ts
- src/fx/clouds.ts

## Brief

ROLE: You are the atmosphere agent, one of 8 agents building a browser 3D voxel city builder IN PARALLEL in the shared tree /home/claude/vcb (TypeScript 7/tsgo strict, three r186, Vite 8; no external assets, everything procedural). The architect wrote frozen contracts, the composition root (src/game.ts) and a runnable skeleton; you replace the stubs with complete implementations.

Scope:
- Renderer and mood:
  • lights and PCF soft shadows that follow the camera;
  • a gradient sky with sun and stars, and fog;
  • an ocean around the island;
  • a gorgeous day/night cycle with glowing windows at night.
- Ambient life:
  • voxel cars driving on the right on the road network;
  • smoke / steam / fountain particles;
  • drifting voxel clouds.

READ FIRST: ARCHITECTURE.md (whole file; most relevant: §8 rendering & day/night, §12 road tile layout, §16 fx, §18 frame loop, §19 budgets), src/types.ts (ISceneContext, EffectsDeps, IEffects, CityReader, IStructureSync, Emitter, ROAD_LANE_OFFSET, ROAD_SIDEWALK_WIDTH, BRIDGE_DECK_HEIGHT, WATER_LEVEL, SimSpeed), src/game.ts, src/render/sharedUniforms.ts and src/render/colorSetup.ts (both frozen), src/core/coords.ts (roadSurfaceY, tileCenter, tileIndex), src/core/util.ts (smoothstep, lerp, damp, clamp), src/core/rng.ts, src/core/events.ts, src/voxel/blocks.ts (colours, e.g. WATER 0x3b8fd9), and the doc comments in YOUR files (they are part of this spec). If docs and frozen code disagree, the code wins.

YOU OWN (edit only these; new files allowed inside src/fx/ and inside src/render/, except the frozen src/render/sharedUniforms.ts and src/render/colorSetup.ts): src/render/scene.ts, src/render/sky.ts, src/fx/effects.ts, src/fx/traffic.ts, src/fx/particles.ts, src/fx/clouds.ts.

NEVER EDIT: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, src/render/colorSetup.ts, src/game.ts, src/main.ts, index.html, src/style.css, tsconfig.json, vite.config.ts, package.json, ARCHITECTURE.md, scripts/*, /home/claude/vcb-skeleton/*, node_modules, or any other module's files. Allowed imports: src/types.ts, src/core/*, src/voxel/blocks.ts, src/render/sharedUniforms.ts, 'three' (+ 'three/examples/jsm/...' addons) and your own files; never another module's implementation. The integrator will run the full game with every real module: code against the interface contracts, not against the skeleton stubs' current behaviour.

EXPORTS THAT MUST STAY:
- `export function createSceneContext(container: HTMLElement): ISceneContext` in src/render/scene.ts. game.ts calls createSceneContext(#viewport) as the very first construction. Afterwards:
  • view.camera is driven by the camera rig, and view.canvas receives input;
  • view.worldRoot holds the chunk meshes (meshing), view.overlayRoot the tool ghosts (input), view.fxRoot your fx;
  • each frame: view.update(dt, rig.getFocus()), then view.render();
  • the UI settings toggle view.shadowsEnabled and view.autoTime, and set view.timeOfDay;
  • getDebugInfo reads view.renderer.info.
- `export class Effects implements IEffects` in src/fx/effects.ts with `constructor(deps: EffectsDeps)` ({ root: view.fxRoot, city: CityReader, terrain, structures: IStructureSync, view, bus }). game.ts calls fx.update(dt, view.camera) each frame and fx.reset() after a new city / load; the UI toggles fx.enabled.

FROZEN BITS YOU MUST HONOUR:
- src/render/colorSetup.ts disables THREE.ColorManagement. You MUST keep renderer.outputColorSpace = THREE.LinearSRGBColorSpace and NoToneMapping. Palette hex colours are used as-is everywhere; never convert sRGB↔linear.
- src/render/sharedUniforms.ts: scene.update() is its ONLY writer. Every frame (also when paused): uTime += dt, uNight = nightFactor, uSun = sun elevation factor 0..1.
- The chunk materials (meshing module) add aEmissive × uNight × glow, so emissive blocks (WINDOW_LIT, GLASS_LIT, DOOR_GLASS, STREET_LAMP, BEACON_RED, SIGN_*) glow at night.

A. scene.ts (its doc comment is the spec):
- Renderer: WebGLRenderer({antialias:true, powerPreference:'high-performance'}), pixel ratio ≤ 2, shadowMap PCFSoftShadowMap.
- Canvas: appended to the container, tabIndex 0, context menu suppressed. Resize via a ResizeObserver on the container plus window resize.
- Camera: PerspectiveCamera with fov ~45–50, near 0.5, far ~2500.
- Lights: a HemisphereLight plus a DirectionalLight sun with a 2048² shadow map.
  • Its orthographic shadow camera FOLLOWS the focus each frame, snapped to shadow-texel increments (no shimmering).
  • The extent scales with zoom (camera distance to the focus), e.g. half-size clamp(distance × 0.8, 60, 280).
  • near/far must cover structures up to y ≈ 120.
  • Tune bias / normalBias for voxel faces: no acne, no peter-panning.
  • At night a dim bluish moonlight takes over the light direction; it is never pitch black.
- Sky (sky.ts): a gradient dome — an inverted sphere or a screen-space gradient — with zenith/horizon colours, a sun disc + glow, and stars at night. fog false, depthWrite false, renderOrder −1, follows the camera, frustumCulled false.
- Fog: coloured like the horizon. Distances scale with camera distance, so the whole map stays visible when zoomed out while the far ocean fades.
- Ocean: a large water ring AROUND the map at y ≈ WATER_LEVEL − 0.12 (in-map water tops are at y = 10).
  • It must NOT overlap the map rectangle x,z ∈ [0,512]: the river water inside the map is transparent, so a plane there would show through. Use e.g. four quads, a ring geometry, or a shader discard inside the map.
  • Colour close to the WATER block (0x3b8fd9), slightly darker / deeper; fog applies; an optional subtle animated shimmer.
  • The map edge then reads as an island with cliffs (the voxel world's edge is a cross-section).
- Day/night:
  • timeOfDay 0..1 (0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset) advances when autoTime is on (default TRUE), with a full cycle of ~8 real minutes. Start at ~0.30 (morning). Night is ≈ 25% of the cycle.
  • sky.ts samplePalette is a keyframed palette (zenith, horizon, fog, sun colour / intensity, hemisphere sky / ground / intensity) with warm sunrise and sunset.
  • nightFactor is smooth 0..1.
- shadowsEnabled toggles renderer.shadowMap.enabled + sun.castShadow and marks materials for recompilation (traverse the scene and set material.needsUpdate = true).
- dispose() releases everything, including listeners.

B. Effects (effects.ts doc comment):
- Composes TrafficSystem, ParticleSystem and CloudLayer under deps.root.
- Bus: 'tiles:changed' → traffic.markNetworkDirty() (rebuild the road graph lazily, ≤ 2×/s); 'city:loaded' → reset().
- Each frame, poll deps.structures.emittersVersion; when it changes, call particles.setEmitters(getEmitters()).
- Time scale from city.getSpeed(): 0 → cars frozen, smoke drifts at 0.3×; 1 → 1×; 2 → 1.5×; 3 → 2×.
- Night from deps.view.nightFactor: headlights on, darker smoke, tinted clouds.
- enabled = false hides deps.root and skips updates.
- dispose() unsubscribes and frees GPU resources.
- Budget ≤ 1.5 ms/frame with 400 cars + 600 particles.

C. traffic.ts (doc comment):
- Road graph from CityReader.getRoadMask (nodes = road tiles, edges = mask bits), rebuilt when dirty.
- Cars: InstancedMesh(es) of a tiny merged-box voxel car (body ≈ 2 wide × 1.4 tall × 3.6 long, a cabin, optional wheels), with cheerful per-instance colours and some buses / trucks near C/I zones. Headlights and taillights live on a second instanced mesh that glows with nightFactor.
- Movement: follow tile-to-tile paths, choosing a random allowed exit at intersections; no U-turns except at dead ends.
- Drive on the RIGHT: lane centre = the tile centre line offset by ROAD_LANE_OFFSET (1.5 voxels) to the right of travel. For travel direction (dx,dz) the right-hand vector is (−dz, dx); e.g. eastbound cars use z = tz·8 + 4 + 1.5.
- Height: y = roadSurfaceY(terrain, tx, tz) (src/core/coords.ts; BRIDGE_DECK_HEIGHT on bridges) + a body offset. Ease y across terrace steps and bridge ends; make smooth quarter-circle turns.
- Speed ~6–9 voxels/s × the time scale; slow down behind another car in the same lane and tile.
- Car count target = min(400, roadTiles × 0.35, 3 + (population + jobsTotal)/25), from city.getStats(). Spawn / despawn gradually (scale in / out) on road tiles near developed zones or edge tiles.
- Cars must never drive off roads after the network changes: re-path them, or despawn them on removed tiles.

D. particles.ts (doc comment):
- Pool ≤ 800. Use an InstancedMesh of small cubes (voxel puffs, fits the style) or Points with a procedurally drawn texture (no asset files).
- Spawn rate ∝ emitter.strength. Puffs rise, grow, drift with a slowly rotating wind and fade over 4–8 s.
- smoke: grey (darker for industry); steam: white and short-lived; fountain: small blue droplets arcing up and falling back.
- Use frustum / distance culling where it is cheap.

E. clouds.ts (doc comment):
- 12–24 chunky voxel clouds (merged boxes) at y ≈ 95–115, drifting slowly and wrapping around a region larger than the map.
- Optional castShadow for moving cloud shadows.
- Tinted by time of day: orange at sunset, blue-grey at night.
- Deterministic from the seed parameter.

PERF: view.update ≤ 0.5 ms; fx ≤ 1.5 ms; ≤ ~600 draw calls in total with shadows on a full city (your share: a handful of instanced meshes).

RULES:
(1) No npm install, no git commit.
(2) `npx tsc --noEmit` (run in /home/claude/vcb) must report no errors in your files; ignore errors in files you don't own (others are mid-edit). verbatimModuleSyntax: type-only imports via `import type` / inline `type`. No TS enums. strict, noImplicitReturns, noFallthroughCasesInSwitch, noImplicitOverride.
(3) Keep the exported names, constructor signatures and file paths listed above.
(4) Never throw out of per-frame methods; validate inputs.
(5) No per-frame allocations in hot paths; typed arrays for instance data.
(6) Subscribe to the bus in the constructor; unsubscribe and remove every DOM / window listener in dispose().
(7) Determinism is not required for cosmetic fx, but clouds should derive their layout from the seed.
(8) Scratch / test files only in your session scratchpad, never in the repo (no dist/ in the repo).
(9) If a contract seems wrong or missing, do NOT change it: work around it inside your files and report it at the end.
(10) Kill every background process you start before you finish.

TESTING TOOLS:
(a) Pure TS in Node: put an entry .ts in your scratchpad that imports your module by absolute path (src/...). From /home/claude/vcb run `npx rolldown <entry.ts> --format esm --platform node --file <out.mjs> && node <out.mjs>`. Useful for palette sampling, traffic lane math and graph logic.
(b) Browser:
  • Start a dev server in the background WITHOUT `cd … &&` in front (so $! is the server PID): `VCB_VITE_CACHE=<scratch>/vite-cache node node_modules/vite/bin/vite.js <root dir> --port 5266 --strictPort > <scratch>/vite.log 2>&1 &` then `echo $! > <scratch>/vite.pid`.
  • Run `node scripts/smoke.mjs --url 'http://127.0.0.1:5266/?fresh&seed=7' --wait 8000 --shot <scratch>/a.png --eval '<js>'`. --eval is repeatable and may return a Promise; other options: --after, --width/--height, --timeout. Exit code 1 on page errors. Look at the PNG with your image-reading tool.
  • window.__vcb is the Game (fields sim, world, view, meshes, structures, rig, tools, fx, saves, ui, bus, terrain).
  • Headless Chromium renders with SwiftShader, which is slow: judge correctness and looks, not FPS.
  • Afterwards `kill $(cat <scratch>/vite.pid)` and check that `pgrep -af vite` no longer lists it.
  • Your port: 5266 (try the next ports if busy). Always set VCB_VITE_CACHE to a private directory.
(c) Isolation: other agents rewrite their modules concurrently.
  • `bash scripts/harness.sh <new empty dir in your scratchpad> src/render src/fx` builds a runnable copy = pristine skeleton + your live files (node_modules symlinked). Run vite with that dir as root.
  • Inside the copy you may add test pages and replace other modules' files with fakes — never in the repo.
  • Skeleton state: flat dry terrain at h 12, naive mesher without AO, a stub sim with no roads, and a camera-rig stub that only applies reset()/setState() poses.

TESTS FOR THIS MODULE:
- Times of day: screenshot with --eval 'window.__vcb.view.autoTime=false; window.__vcb.view.timeOfDay=0.8' (try dawn 0.27, noon 0.5, sunset 0.74, night 0.95).
- Shadows: check at close and far zoom via --eval 'window.__vcb.rig.setState({x:256,z:256,yaw:0.8,pitch:0.7,distance:60},true)'. Add test geometry for shadows and glow via 'window.__vcb.world.fillBox(250,12,250,256,50,256,58)' (58 = WINDOW_LIT).
- Also check: the ocean ring; the horizon / fog; the sky at night (stars, moonlight, lit blocks); window.__vcb.getDebugInfo() (draw calls, frame ms).
- Traffic and particles: write a private test page, or replace the harness copy's src/sim/simulation.ts with a fake CityReader exposing a road grid + stats and src/build/structureSync.ts with a fake publishing a few emitters (never in the repo). Screenshot cars on straight roads, at intersections, on bridges (fake water tiles) and at night with headlights, plus smoke / steam / fountains.

FINAL REPORT (your last message): files changed/added; what is implemented and what is not; how you tested (commands, key numbers, screenshot paths); performance vs. targets; known issues; contract problems you worked around (contracts unchanged). Confirm that none of your dev servers or other background processes is still running.

## Done means
`npx tsc --noEmit` passes for your files against the frozen contracts; report any contract problems instead of editing contract files.
