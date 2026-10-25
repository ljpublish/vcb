Architecture and a runnable skeleton for a TypeScript + Three.js (r186) + Vite 8 voxel city builder, in /home/claude/vcb.

Final verification:
- `npx tsc --noEmit` exits 0.
- `npx vite build` succeeds (output written to the scratchpad).
- A headless Chromium smoke run of /?fresh&seed=99 renders 256 chunk meshes with 0 console errors.
- No dev server or browser process is left running.

Frozen contracts (integrator-owned; no agent edits them):
- /home/claude/vcb/ARCHITECTURE.md covers:
  - module map and file ownership
  - coordinate systems, chunk size (32³, 16×4×16 chunks; 8×8-voxel tiles; 64×64 tile map)
  - palette ids and colours
  - the worker protocol
  - the sim tick rate (1 tick = 1 day; 5/12/30 ticks/s)
  - the event table and state ownership
  - save format v1
  - the frame loop and performance budgets
  - agent rules and testing recipes
- /home/claude/vcb/src/types.ts: all constants and cross-module interfaces.
- /home/claude/vcb/src/core/events.ts, rng.ts, coords.ts, util.ts.
- /home/claude/vcb/src/voxel/blocks.ts: about 110 procedural block colours with flag, colour and emissive tables.
- /home/claude/vcb/src/mesh/protocol.ts.
- /home/claude/vcb/src/render/sharedUniforms.ts and colorSetup.ts. Colour handling: three's colour management is turned off, so palette hex colours are used as-is everywhere.

Integrator-owned wiring and tooling:
- /home/claude/vcb/src/game.ts: composition root, frame loop, and the new-city / load / import sequence (it owns the TerrainProxy).
- /home/claude/vcb/src/main.ts, index.html, src/style.css, tsconfig.json, and vite.config.ts (supports a per-agent VCB_VITE_CACHE).
- /home/claude/vcb/scripts/smoke.mjs: headless Playwright + SwiftShader screenshots and evals.
- /home/claude/vcb/scripts/harness.sh: builds an isolated runnable copy (skeleton plus the live module files).
- /home/claude/vcb-skeleton: a read-only pristine snapshot.

Every module file exists with its exact exported API and spec doc comments:
- world.ts, terrain.ts, greedy.ts and chunkMeshManager.ts contain simple, unoptimised working versions, so the game renders from day one.
- Everything else is an inert stub.

Module split: 8 parallel modules on disjoint files.
- Heavy: voxel-world, meshing, simulation, buildings, atmosphere.
- Not heavy: input, ui, persistence.
- Each module has its own dev-server port (5211–5288).

Once the agents finish, an integration pass should run tsc, the build, and smoke and play tests on the live tree.

Note: a scratch-cleanup `rm -rf` of test folders in the session scratchpad was blocked by the safety check and not retried. The leftover scratch folders are harmless.