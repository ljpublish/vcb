# Module: input

Status: QUEUED, available to hand off
Suggested effort: high

## Files you own (edit only these)
- src/input/cameraRig.ts
- src/input/picking.ts
- src/input/toolController.ts
- src/input/overlays.ts

## Brief

ROLE: You are the input agent, one of 8 agents building a browser 3D voxel city builder IN PARALLEL in the shared tree /home/claude/vcb (TypeScript 7/tsgo strict, three r186, Vite 8; no external assets). The architect wrote frozen contracts, the composition root (src/game.ts) and a runnable skeleton; you replace the stubs in src/input with complete implementations.

Scope:
- a smooth RTS camera: orbit / pan / zoom with WASD / QE / R/F / Z/X plus the mouse;
- the tool system: select/inspect, road drags, R/C/I zoning, parks, bulldoze;
- live ghost previews, cost tooltips, and grid and data overlays.
It must feel responsive and polished.

READ FIRST: ARCHITECTURE.md (whole file; most relevant: §3 coordinates, §10 events, §11.4 actions table, §13 input, §17 startup, §18 frame loop), src/types.ts (CameraRigDeps, ICameraRig, CameraState, ToolControllerDeps, IToolController, ToolId, OverlayMode, ToolAction, ActionPreview, ToolPreviewInfo, KEYMAP, MAX_ACTION_TILES, BRIDGE_DECK_HEIGHT …), src/game.ts, src/core/coords.ts (rectTiles, lPathTiles, straightPathTiles, voxelToTile, tileCenter, clampTile, inMap), src/core/util.ts (damp, angleDelta, clamp, isEditableTarget, keyMatches), src/core/events.ts, src/render/sharedUniforms.ts, and the doc comments in YOUR files (they are part of this spec). If docs and frozen code disagree, the code wins.

YOU OWN (edit only these; new files allowed inside src/input/): src/input/cameraRig.ts, src/input/picking.ts, src/input/toolController.ts, src/input/overlays.ts.

NEVER EDIT: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, src/render/colorSetup.ts, src/game.ts, src/main.ts, index.html, src/style.css, tsconfig.json, vite.config.ts, package.json, ARCHITECTURE.md, scripts/*, /home/claude/vcb-skeleton/*, node_modules, or any other module's files. Allowed imports: src/types.ts, src/core/*, src/voxel/blocks.ts, src/render/sharedUniforms.ts, 'three' (+ 'three/examples/jsm/...' addons) and your own files; never another module's implementation. The integrator will run the full game with every real module: code against the interface contracts (ISimulation.previewAction / applyAction, CityReader queries), not against the skeleton stubs' current behaviour.

EXPORTS THAT MUST STAY:
- `export class CameraRig implements ICameraRig` with `constructor(deps: CameraRigDeps)` ({ camera, dom: the canvas, terrain }). Keep `export const DEFAULT_CAMERA` ({x:256, z:256, yaw:π/4, pitch:0.9, distance:190}).
- `export class ToolController implements IToolController` with `constructor(deps: ToolControllerDeps)` ({ camera, dom, overlayRoot, sim: ISimulation, terrain, bus }).
- picking.ts and overlays.ts are module-internal.
- How game.ts uses you:
  • every frame, rig.update(dt) runs first. The camera matrices must be final afterwards, so call camera.updateMatrixWorld() at its end;
  • tools.update(dt) runs later in the frame;
  • rig.getFocus() is used by meshing (chunk priorities) and by the scene (the shadow camera follows it);
  • while busy or while a modal is open, the game sets rig.enabled = tools.enabled = false and calls tools.cancel();
  • on new city: rig.reset(true) and tools.setTool('select'); on load: rig.setState(saved, true);
  • saves store rig.getState().

KEY OWNERSHIP (KEYMAP in src/types.ts):
- The rig handles the camera keys: panForward / Back / Left / Right, rotateLeft / Right, tiltUp / Down, zoomIn / Out, resetView.
- The tool controller handles only `cancel` (Escape).
- The UI module handles tool hotkeys (it calls tools.setTool), the grid toggle (sets tools.gridVisible), overlay cycling (sets tools.overlay), speed, saves, help and debug.
- Listen for keys on window in the BUBBLE phase. The UI listens in the capture phase and may stopPropagation keydown events it consumes, e.g. while a modal is open — so clear the held-key state whenever `enabled` becomes false, as well as on window blur / visibilitychange.
- Ignore events when isEditableTarget(e.target) or when ctrl / meta / alt are held. Never preventDefault keys you don't handle.
- Pointer and wheel listeners go on deps.dom (the canvas; tabIndex 0). The #ui overlay has pointer-events: none except on panels, so pointer events over the 3D view reach the canvas.

A. CameraRig (its doc comment is the spec):
- State: a target state plus a smoothed current state, using damp() from src/core/util.ts with λ ≈ 10 (angles via angleDelta).
  • Camera position = focus + (sin(yaw)·cos(pitch), sin(pitch), cos(yaw)·cos(pitch)) × distance, then lookAt(focus).
  • focus.y follows terrain.getSurfaceHeight under the focus, smoothed.
- Keyboard:
  • pan relative to yaw (forward = from the camera toward the focus, on the ground plane) at a speed ∝ distance (Shift ×2.5);
  • Q/E rotate ≈ 90°/s; R/F tilt;
  • Z/X/PageUp/PageDown zoom exponentially;
  • Home = reset.
- Mouse:
  • RIGHT-drag orbits (yaw + pitch).
  • MIDDLE-drag or Shift+RIGHT-drag pans by dragging the ground point under the cursor (pickPlane at the focus height).
  • The wheel zooms exponentially (×1.12 per notch; normalise deltaMode; trackpad pinch = ctrl+wheel; preventDefault on wheel) TOWARD the point under the cursor.
  • The LEFT button belongs to tools and is never consumed here, except for the optional select-mode drag-pan below.
  • Suppress the context menu on the canvas, and use pointer capture during drags.
- Clamps: pitch 0.35..1.45 rad; distance 18..520; focus inside the map rectangle (0..512) ± a small margin; the camera never goes below terrain + 2 (check the surface under the camera).
- lookAtTile / reset / setState with immediate snap both the target and the current state. getState() returns the target pose.
- enabled = false: ignore input but keep smoothing.
- getFocus() returns one reused Vector3. dispose() removes every listener.
- Optional but recommended for laptops: in the select tool, a LEFT-drag beyond ~5 px pans the camera (a click without movement still inspects). game.ts constructs the two classes separately, so share that state through a module-internal file in src/input/ (e.g. a WeakMap keyed by the dom element).
- Optional touch support: one finger = tool / pan; two-finger pinch = zoom + rotate.

B. picking.ts:
- pickTile marches the camera ray through the TILE grid: a 2D DDA over tiles, starting at the ray's entry into the map AABB. It returns the first tile whose flat top the ray crosses, also hitting terrace side walls.
  • The top height is terrain.getSurfaceHeight. Road-on-water tiles are at BRIDGE_DECK_HEIGHT; the tool controller knows roads via sim.getTileKind, so accept an optional height override.
  • Structures are ignored on purpose (picking the ground under a tower is normal city-builder behaviour).
- pickPlane is used for stable drags and panning.
- Both return null off-map or at the sky, with no allocations per call (reuse vectors).

C. ToolController (its doc comment is the spec):
- General: LEFT button only; ignore input when !enabled or while a camera drag is active.
- Hover: pickTile → 'tile:hover' {tile}, only when the tile changes; null when the pointer leaves the canvas.
- Tools:
  • select:
    – a click emits 'inspect' {tile}; off-map clicks emit {tile:null};
    – hovering outlines the tile or the building footprint;
    – a persistent selection outline follows 'inspect' events.
  • road: press = start tile; drag = lPathTiles(start, cur), or straightPathTiles with Shift; release = sim.applyAction({type:'road', tiles}).
  • zone_r / zone_c / zone_i: rectTiles → {type:'zone', zone: 1|2|3, tiles}.
  • park: rectangle drag.
  • bulldoze: rectangle drag; also mark the whole footprint of every building touched. Ground-level highlights under buildings are hidden, so use a translucent box of approximate height by level (e.g. L1 12, L2 26, L3 44, 2×2 64) or an always-on-top outline.
- Clamp tile lists to MAX_ACTION_TILES: truncate and send one 'notify' warning per drag.
- Previews: shown while dragging, plus a single-tile hover preview with build tools when not dragging.
  • sim.previewAction(action) drives the TileHighlighter colours:
    – valid tiles use the tool colour: road 0xc8c8c8, R 0x55d14a, C 0x3f9bff, I 0xffc21a, park 0x2fbf71, bulldoze 0xff4d4d;
    – invalid tiles are 0x8a1c1c at lower opacity;
    – unaffordable → everything red.
  • Emit 'tool:preview' {preview: {tool, cost, validCount, totalCount, affordable, reason, screenX: clientX, screenY: clientY}}; emit null when idle, with the select tool, or when the pointer is outside the canvas.
  • Recompute the preview only when the tile set changes or on 'tiles:changed' / 'stats:changed' — never every frame.
- Release: result = sim.applyAction(action); if !result.ok and result.reason is set, emit 'notify' {kind:'warning', message: reason}.
- Escape: cancel an active drag; with no drag, setTool('select').
- A right-click during a left drag cancels the drag and must not start an orbit.
- Drags that leave the map clamp to the map edge.
- setTool(t):
  • no-op if unchanged; otherwise cancel the drag;
  • set the cursor style: crosshair for build tools, not-allowed when hovering an invalid tile, grab while panning, default for select;
  • emit 'tool:changed'.
- overlay setter → DataOverlay + 'overlay:changed'; gridVisible → GridOverlay.
- update(dt): highlight pulse animation (sharedUniforms.uTime or your own time) and DataOverlay refresh.
- cancel(): end the drag, clear the ghosts, emit 'tool:preview' null.

D. overlays.ts (its doc comment is the spec):
- TileHighlighter:
  • one InstancedMesh of thin, slightly inset boxes (8 × 0.25 × 8) ~0.06 above each tile surface, with per-instance colour;
  • MeshBasicMaterial, transparent (opacity ~0.45), depthWrite false, polygonOffset, renderOrder above the world;
  • capacity grows on demand (≥ MAX_ACTION_TILES);
  • crisp outlines (LineSegments) for hovered / selected tiles and building footprints.
- GridOverlay: subtle grid lines around the cursor (radius ~12 tiles, fading with distance), shown while a build tool is active or when gridVisible is set.
- DataOverlay:
  • per-tile heat colours (green → yellow → red) for landValue and pollution;
  • roadAccess: green = access, red = zoned without access;
  • refreshed ≤ 2×/s while active, as one InstancedMesh over all land tiles.
- No overlay object casts or receives shadows. Colours are used as-is: no colour-space conversion, since THREE.ColorManagement is disabled globally.

PERF: rig.update + tools.update ≤ 0.3 ms per frame; zero allocations per frame in steady state (reuse Vector3 / Ray / Matrix objects; typed arrays for instance data).

RULES:
(1) No npm install, no git commit.
(2) `npx tsc --noEmit` (run in /home/claude/vcb) must report no errors in your files; ignore errors in files you don't own (others are mid-edit). verbatimModuleSyntax: type-only imports via `import type` / inline `type`. No TS enums. strict, noImplicitReturns, noFallthroughCasesInSwitch, noImplicitOverride.
(3) Keep the exported names, constructor signatures and file paths listed above.
(4) Never throw out of per-frame methods or event handlers; validate inputs.
(5) No per-frame allocations in hot paths.
(6) Subscribe to the bus in the constructor; unsubscribe and remove every DOM / window listener in dispose().
(7) Scratch / test files only in your session scratchpad, never in the repo (no dist/ in the repo).
(8) If a contract seems wrong or missing, do NOT change it: work around it inside your files and report it at the end.
(9) Kill every background process you start before you finish.

TESTING TOOLS:
(a) Pure TS in Node: put an entry .ts in your scratchpad that imports your module by absolute path (src/...). From /home/claude/vcb run `npx rolldown <entry.ts> --format esm --platform node --file <out.mjs> && node <out.mjs>`. Useful for picking math with a fake TerrainReader and a THREE.PerspectiveCamera.
(b) Browser:
  • Start a dev server in the background WITHOUT `cd … &&` in front (so $! is the server PID): `VCB_VITE_CACHE=<scratch>/vite-cache node node_modules/vite/bin/vite.js <root dir> --port 5255 --strictPort > <scratch>/vite.log 2>&1 &` then `echo $! > <scratch>/vite.pid`.
  • Run `node scripts/smoke.mjs --url 'http://127.0.0.1:5255/?fresh&seed=7' --wait 8000 --shot <scratch>/a.png --eval '<js>'`. --eval is repeatable and may return a Promise; other options: --after, --width/--height, --timeout. Exit code 1 on page errors. Look at the PNG with your image-reading tool.
  • window.__vcb is the Game (fields sim, world, view, meshes, structures, rig, tools, fx, saves, ui, bus, terrain).
  • Headless Chromium renders with SwiftShader, which is slow: judge correctness and looks, not FPS.
  • Afterwards `kill $(cat <scratch>/vite.pid)` and check that `pgrep -af vite` no longer lists it.
  • Your port: 5255 (try the next ports if busy). Always set VCB_VITE_CACHE to a private directory.
(c) Isolation: other agents rewrite their modules concurrently.
  • `bash scripts/harness.sh <new empty dir in your scratchpad> src/input` builds a runnable copy = pristine skeleton + your live files (node_modules symlinked). Run vite with that dir as root.
  • Inside the copy you may add test pages and replace other modules' files with fakes — never in the repo.
  • Skeleton state: flat dry terrain at h 12, naive mesher, scene stub. The sim is an inert stub: previewAction marks everything invalid and applyAction rejects. For realistic previews, replace src/sim/simulation.ts IN THE HARNESS COPY with a tiny fake — e.g. every Empty land tile valid at 10/tile, and applyAction marks tiles as roads/zones in arrays and emits 'tiles:changed' — or use the live sim later.

TESTS FOR THIS MODULE:
- Copy smoke.mjs to your scratchpad and script real input:
  • page.mouse.move/down/up for left drags with each tool, after page.evaluate of window.__vcb.tools.setTool(`road`) etc.;
  • right-drag orbit, middle-drag pan, page.mouse.wheel zoom;
  • page.keyboard.down/up for WASD / QE / R/F / Z/X / Home / Escape.
- Verify:
  • window.__vcb.rig.getState() changes as expected;
  • events, by subscribing via window.__vcb.bus.on inside page.evaluate (tile:hover, tool:preview, inspect, tool:changed);
  • screenshots mid-drag show the ghosts;
  • picking is accurate on terraces when the live terrain exists;
  • nothing breaks when enabled=false is set mid-drag, when the pointer leaves the canvas, or when the window blurs while keys are held.

FINAL REPORT (your last message): files changed/added; what is implemented and what is not; how you tested (commands, key numbers, screenshot paths); performance vs. targets; known issues; contract problems you worked around (contracts unchanged). Confirm that none of your dev servers or other background processes is still running.

## Done means
`npx tsc --noEmit` passes for your files against the frozen contracts; report any contract problems instead of editing contract files.
