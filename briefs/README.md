# Module briefs (from the architect)

Contracts are frozen: src/types.ts, src/core/*, src/voxel/blocks.ts, src/main.ts, src/game.ts belong to the integrator. Each module edits ONLY its listed files. Read ARCHITECTURE.md first.

- [voxel-world](voxel-world.md): IN PROGRESS on the main build thread; files: src/voxel/world.ts, src/voxel/terrain.ts, src/voxel/noise.ts, src/voxel/decor.ts
- [meshing](meshing.md): IN PROGRESS on the main build thread; files: src/mesh/greedy.ts, src/mesh/mesher.worker.ts, src/mesh/chunkMeshManager.ts, src/mesh/materials.ts
- [simulation](simulation.md): QUEUED, available to hand off; files: src/sim/simulation.ts, src/sim/cityState.ts, src/sim/roads.ts, src/sim/growth.ts, src/sim/economy.ts, src/sim/actions.ts, src/sim/stats.ts
- [buildings](buildings.md): QUEUED, available to hand off; files: src/build/structureSync.ts, src/build/stamp.ts, src/build/buildingGen.ts, src/build/residential.ts, src/build/commercial.ts, src/build/industrial.ts, src/build/construction.ts, src/build/roadGen.ts, src/build/lotGen.ts
- [input](input.md): QUEUED, available to hand off; files: src/input/cameraRig.ts, src/input/picking.ts, src/input/toolController.ts, src/input/overlays.ts
- [atmosphere](atmosphere.md): QUEUED, available to hand off; files: src/render/scene.ts, src/render/sky.ts, src/fx/effects.ts, src/fx/traffic.ts, src/fx/particles.ts, src/fx/clouds.ts
- [ui](ui.md): QUEUED, available to hand off; files: src/ui/gameUI.ts, src/ui/hud.ts, src/ui/toolbar.ts, src/ui/panels.ts, src/ui/notifications.ts, src/ui/minimap.ts, src/ui/icons.ts, src/ui/sfx.ts, src/ui/ui.css
- [persistence](persistence.md): QUEUED, available to hand off; files: src/persist/saveCodec.ts, src/persist/saveManager.ts

## Workflow
- Branch from `main` as `module/<name>` (e.g. `module/simulation`), edit only your owned files, keep `npx tsc --noEmit` clean, open a PR into `main`.
- Do not edit frozen contracts (src/types.ts, src/core/*, src/voxel/blocks.ts, src/game.ts, src/main.ts). If a contract is wrong, say so in the PR description; the integrator changes it.
- voxel-world and meshing files on `main` are partial work in progress by the integrator thread; code against their contract signatures, not their current behavior.
