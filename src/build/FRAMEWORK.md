# Buildings framework (src/build)

Base every buildings sub-branch on `module/buildings` and open your PR **into `module/buildings`** (not main).
The framework owner merges them and opens the single PR into main. `src/types.ts`, `src/voxel/blocks.ts`
and everything outside `src/build` are frozen — ask the framework thread if you need a contract change.

## Ownership
| File | Owner |
|---|---|
| stamp.ts, parts.ts, buildingGen.ts, construction.ts, lotGen.ts, structureSync.ts, FRAMEWORK.md | framework (buildings thread) |
| residential.ts (+ optional `residential/*`) | residential thread |
| commercial.ts (+ optional `commercial/*`) | commercial thread |
| industrial.ts (+ optional `industrial/*`) | industrial thread |
| park.ts (+ optional `civic/*`) | civic/parks thread |
| roadGen.ts, props.ts | props/roads thread |

Need a shared helper in parts.ts? Write it locally first, then message the framework thread.

## Zone generator signature (residential / commercial / industrial)
```ts
export function generateResidential(spec: BuildingSpec, rng: Rng, emitters: LocalEmitter[]): StampBuilder
```
- `spec` = { zone, level 1|2|3, size 1|2, facing, variant (uint32), state, stage }.
- Only author the **finished Active look**. Construction stages and the Abandoned look are applied
  afterwards by construction.ts — ignore `spec.state` / `spec.stage`.
- Ignore `spec.facing`: author with the front (entrance, street) at **+Z, z = S-1**. buildingGen rotates.
- Return `newLot(spec)` from parts.ts (S × 81 × S, all STAMP_KEEP) after drawing. S = 8 (1×1) or 16 (2×2).
  Size 2 only happens at level 3.
- Layer y = 0 is the lot's ground surface (repaint it: lawn, paths, parking). Structure starts at y = 1.
  Max total height 81 layers (MAX_STRUCTURE_HEIGHT + 1). Never write outside S × S (StampBuilder clips anyway).
- Randomness: `rng` (already seeded from variant) for big choices; `parts.rand3(x,y,z,seed)` /
  `windowBlock` / `glassBlock` for per-voxel choices. Never Math.random. Same spec → same bytes.
- Emitters: `parts.emit(emitters, x, y, z, 'smoke' | 'steam' | 'fountain', strength)` in stamp-local
  continuous coords (x,z ∈ [0,S], y = layer above the chimney top). Chimney smoke ≈ 0.25, factory stacks 0.6–1.0,
  rooftop vents 'steam' ≈ 0.3.
- Perf: ≤ ~0.2 ms per building on average. Use fill() boxes, no per-voxel allocations.

## Blocks
`import { B } from '../voxel/blocks'`. Use B.* names only (see blocks.ts for colours). Emissive at night:
WINDOW_LIT, GLASS_LIT, SIGN_*, STREET_LAMP, BEACON_RED. Aim for ≈ 40–60% lit windows (C more, I less).

## Helpers (parts.ts)
newLot, ground, facadeBox (wall box + windows every 2nd column on 3-voxel storeys), bandedBox (office glass bands),
curtainBox (glass curtain wall + mullions), gableRoof, hipRoof, flatRoof (+parapet), cylinder, tree, pine,
flowerBed, fenceLine, roofClutter (AC units), antenna (+BEACON_RED), emit, windowBlock, glassBlock, rand2/rand3.
StampBuilder: set/get/fill/walls/replace/blit/rotateY/usedHeight/toStamp.

## Roads / parks
- `generateRoad(spec: RoadSpec): GeneratedStructure` (roadGen.ts) — keep the RoadSpec interface and the ROAD_* layout.
- `generateParkTile(spec: ParkSpec): GeneratedStructure` (park.ts) — 8×8, layer 0 = ground surface.
- The contract has NO civic building types (TileKind = Empty/Road/Zoned/Park; zones R/C/I). Civic buildings
  (town hall etc.) can be authored in `civic/*` for later, but nothing will place them until the contract adds them.

## Testing
Gallery page renders every zone × level × size × state. Run your own Node tests through rolldown (see briefs/buildings.md).
`npx tsc --noEmit` must be clean for src/build.
