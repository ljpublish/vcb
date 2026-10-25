# Module: simulation

Status: QUEUED, available to hand off
Suggested effort: max

## Files you own (edit only these)
- src/sim/simulation.ts
- src/sim/cityState.ts
- src/sim/roads.ts
- src/sim/growth.ts
- src/sim/economy.ts
- src/sim/actions.ts
- src/sim/stats.ts

## Brief

ROLE: You are the simulation agent, one of 8 agents building a browser 3D voxel city builder IN PARALLEL in the shared tree /home/claude/vcb (TypeScript 7/tsgo strict, three r186, Vite 8; no external assets). The architect wrote frozen contracts, the composition root (src/game.ts) and a runnable skeleton; you replace the inert stub city in src/sim with the complete simulation (ISimulation, which includes CityReader).

Scope: tiles, roads, zones, parks, growing buildings, population, jobs, RCI demand, land value, pollution, money / budget and notifications. It must make the game FUN: growth visible quickly after zoning, meaningful demand bars, and a budget that rewards sensible play.

READ FIRST: ARCHITECTURE.md (whole file; most relevant: §3 coordinates, §9 city model & state ownership, §10 events, §11 simulation (time, growth, economy, actions), §15 save format, §17 startup sequence, §19 budgets), src/types.ts (TileKind, ZoneType, BuildingState, Building, TileInfo, CityStats, BudgetReport, HistorySample, ToolAction, ActionPreview, ActionResult, CitySnapshot, CityReader, ISimulation, SimulationDeps, TOOL_COSTS, UPKEEP, SIM_TICKS_PER_SECOND …), src/game.ts, src/core/events.ts (GameEvents payloads), src/core/coords.ts (tileIndex, inMap, isEdgeTile, neighborTile, manhattan …), src/core/rng.ts, src/core/util.ts, and the doc comments in YOUR files (they are part of this spec). If docs and frozen code disagree, the code wins.

YOU OWN (edit only these; new files allowed inside src/sim/): src/sim/simulation.ts, src/sim/cityState.ts, src/sim/roads.ts, src/sim/growth.ts, src/sim/economy.ts, src/sim/actions.ts, src/sim/stats.ts.

NEVER EDIT: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, src/render/colorSetup.ts, src/game.ts, src/main.ts, index.html, src/style.css, tsconfig.json, vite.config.ts, package.json, ARCHITECTURE.md, scripts/*, /home/claude/vcb-skeleton/*, node_modules, or any other module's files. Allowed imports: src/types.ts, src/core/*, src/voxel/blocks.ts and your own files (no three needed); never another module's implementation. The integrator will run the full game with every real module: code against the interface contracts.

EXPORTS THAT MUST STAY:
- `export class Simulation implements ISimulation` with `constructor(deps: SimulationDeps)` ({ bus, terrain }). The terrain is a stable proxy that already points at the new city's terrain when newCity() / load() are called.
- game.ts calls:
  • newCity({seed,name}) on new city;
  • load(snapshot) on load — it must THROW an Error for incompatible snapshots before changing anything;
  • serialize() for saves and the 60 s autosave;
  • update(dt) every frame unless busy.
- Other modules use the CityReader queries, often every frame (structures, traffic, overlays, minimap), so keep them O(1) and allocation-free, except getTileInfo.
- The other src/sim files are module-internal; change them freely.

STATE (CityState, struct-of-arrays, TILE_COUNT = 4096):
- kind (TileKind) and zone (ZoneType).
- flags: TILE_FLAG_DECOR = bit 0; bits 1–7 are yours and are persisted verbatim.
- buildings Map<id, Building>, with a derived buildingAt Int32Array.
- name, seed, day, money, speed, taxRates.
- rng: Rng from src/core/rng.ts; its uint32 state is persisted as rngState.
- nextBuildingId.
- history: ≤ 240 HistorySample, one per month.
- extra: JSON-safe private data (smoothed demand, month accumulators, milestones reached, timers …).

Derived state (recomputed after load and whenever its inputs change; never saved):
- roadMask: DIR_BIT mask of 4-neighbour roads, for road tiles.
- roadDist: multi-source BFS from all road tiles, Manhattan, capped at 255.
- Road component ids plus an edge-connected flag per component (the component touches the map edge: isEdgeTile).
- Connected-access distance: BFS from edge-connected road tiles only.
- landValue and pollution (Float32 0..1).
- Running sums for stats.

MECHANICS:
1. newCity({seed,name}): fresh state on deps.terrain.
  • All tiles Empty; decor flags from terrain.hasNaturalDecor().
  • Money START_MONEY (25000), day 0, TAX_DEFAULT (9) for r/c/i, speed 1, rng seeded from the seed, nextBuildingId 1.
  • Lay a FREE starter road along tz = MAP_TILES/2 (= 32) from tx = 0 (the west edge: the highway / region connection) to tx = 32. Water tiles become bridges; decor on the row is cleared.
  • Emit 'sim:speed' and 'stats:changed'. No 'tiles:changed' is needed: the game resets the structures module afterwards, which stamps every tile.
2. load(snapshot):
  • Validate, and throw an Error with a clear message if invalid (state unchanged):
    – mapTiles === MAP_TILES, typed array lengths, enum ranges;
    – building footprints inside the map;
    – every footprint tile Zoned with the building's zone, all at the same terrain height and not water;
    – no overlaps; ids unique and < nextBuildingId.
  • Otherwise COPY everything (never keep references into the snapshot), recompute derived state, and emit 'sim:speed' + 'stats:changed'.
  • It must accept anything serialize() produced.
3. serialize(): a deep copy of the full state (typed arrays copied, buildings, history and extra cloned).
  • Determinism requirement: run newCity + actions + N ticks and serialize; continuing M more ticks must give exactly the same state as load(snapshot) into a fresh Simulation followed by M ticks.
  • So store everything that influences the future in the snapshot or in extra.
4. Time (1 tick = 1 day):
  • update(dt): ignore dt ≤ 0 or NaN. Accumulate dt × SIM_TICKS_PER_SECOND[speed] ([0,5,12,30]) and run ≤ MAX_TICKS_PER_FRAME (8) ticks, dropping the excess. Then emit ONE 'tiles:changed' (cause 'growth') with all tiles changed during those ticks (if any), and ONE 'stats:changed' (if any tick ran).
  • tick(count = 1): runs count ticks immediately regardless of speed (used by tests and window.__vcb.sim.tick(500)), with the same batched emits at the end.
5. Month end (day % 30 === 0):
  • Apply the monthly budget to money and emit 'sim:month' {day, report, money}.
  • Push a history sample and refresh land value and pollution.
  • Send milestone / warning 'notify's (rate-limited).
6. Growth (growth.ts).
  • Spawning: a Zoned tile without a building may spawn a level-1 building (Constructing, stage 0) if it has CONNECTED road access and positive demand for its zone. Connected access = a road tile of an edge-connected network within ROAD_ACCESS_DISTANCE = 3 (Manhattan).
    – Probability per candidate per day ≈ k × demand × land-value factor.
    – Cap new construction sites per tick, so growth looks organic.
  • variant = rng.nextU32(). The structures module renders the look from it: the same record always gives the same voxels.
  • facing: the direction of an adjacent road (rng choice among adjacent roads); otherwise toward the nearest road (decreasing roadDist).
  • Construction lasts ~6 / 10 / 16 days for L1 / L2 / L3, with stage = min(2, floor(progress × 3)). Completion → Active, stateDays 0.
  • Occupancy drifts toward capacity × a fill factor: R depends on demand and happiness; C/I are limited by the available workforce.
  • Capacities (rng within range): R L1 8–14, L2 40–70, L3 150–300 residents; C L1 6–10, L2 30–50, L3 120–220 jobs; I L1 10–16, L2 40–70, L3 120–200 jobs. A 2×2 L3 has ≈ 3.5× the capacity of a 1×1 L3.
  • Upgrades L1→L2→L3 require: Active, occupancy ≥ ~90%, positive zone demand, age (e.g. ≥ 60 / 120 days), and for R/C land value ≥ ≈ 0.35 / 0.5. An upgrade passes through Constructing again with a new variant.
  • Merge: four adjacent level-2+ Active buildings of the same zone on a 2×2 block of equal ground height may merge into one 2×2 level-3 building (tx,tz = min-corner tile, size 2). 2×2 buildings are only ever level 3.
  • Decline: ~30 days without road access, ~60 days of strongly negative demand for its zone, or (R only) ~60 days of pollution > ~0.7 → Abandoned (occupants 0).
    – After ~120 days abandoned the building is removed; its tiles stay Zoned as empty lots.
    – If conditions improve, an abandoned building can revive (Active again).
    – Buildings whose network loses its edge connection slowly lose occupants.
  • EVERY visual change (add/remove, level, size, state, stage, facing, variant) adds ALL footprint tiles to the changed set.
7. Economy (economy.ts).
  • Population and jobs:
    – P = Σ residential occupants; workforce W ≈ 0.55·P.
    – jobs = Σ C/I capacity of Active buildings (jobsCommercial / jobsIndustrial / jobsTotal).
    – employed = min(W, Σ C/I occupants); unemployment = 1 - employed/W (0 when W = 0).
  • Demand is in −1..1, smoothed with an EMA of ~0.03–0.08 per day. Starting model to tune:
    – rTarget = 0.4 + 0.9·(jobsTotal − W)/max(40, W + 40) + 0.3·(happiness − 0.5) − 0.04·(taxR − 9)
    – cTarget = 1.5·(0.18·P − jobsC)/max(30, 0.18·P + 30) − 0.04·(taxC − 9)
    – iTarget = 0.35·[region connected] + 1.2·(0.45·W − jobsI)/max(40, 0.45·W + 40) − 0.04·(taxI − 9)
    – Clamp each to [−1,1].
    – A fresh city must show positive R and I demand and ~0 C demand, which turns positive once people live there.
  • Land value 0..1: base ≈ 0.25, plus parks (≈ +0.25 within ~3 tiles, with falloff), water proximity (+0.15 within 2 tiles), commerce proximity and a slight hill bonus, minus 0.6 × pollution.
  • Pollution 0..1: from industrial buildings by level (falloff radius ~6 tiles) plus a little from roads; parks reduce it.
  • Recompute land value and pollution monthly and right after actions that change roads, parks or zones (cheap separable or radius-limited loops, ≤ 2 ms).
  • Happiness 0..1 from employment, land value, pollution, taxes and parks.
  • Monthly budget:
    – Taxes per zone, e.g. R ≈ residents × rate% × 3, C/I ≈ employees × rate% × 4 (tune).
    – other = region trade: industrial employees × a small $ amount when region-connected.
    – Upkeep: UPKEEP.roadPerTile (1) per land road tile, bridgePerTile (4) per water road tile, parkPerTile (3).
    – All report fields ≥ 0, net = income − expenses.
    – stats.lastMonth = the last completed month; stats.projected = a running full-month estimate.
  • Money may go negative through upkeep, never through actions.
8. Stats (CityStats): recompute at least once per tick and after every action. getStats() may return a stable object updated in place (document this; consumers copy what they compare). Fields: zonedTiles and buildings (constructing + active) per zone, abandoned, roadTiles, parkTiles, landValueAvg / pollutionAvg over zoned tiles, happiness, demand, budgets.
9. Actions (actions.ts; its doc comment is authoritative, see also ARCHITECTURE.md §11.4):
  • road (ordered path):
    – valid on Empty land; on Empty water (= bridge, TOOL_COSTS.bridge 60); on Zoned without a building (de-zones it);
    – existing road tiles are valid, free, and not changed;
    – invalid: Park and building tiles.
  • zone R/C/I:
    – valid on Empty land, or Zoned of another zone without a building; the same zone is skipped;
    – invalid: water, Road, Park and building tiles.
  • park: valid on Empty land or Zoned without a building.
  • bulldoze:
    – Road / Zoned / Park / Empty-with-decor tiles become Empty;
    – any building touched by a dragged tile is removed WHOLE, costing bulldozeBuildingPerLevel × level once per building; its non-dragged footprint tiles stay Zoned as empty lots;
    – plain Empty tiles are invalid.
  • Costs: road 10, bridge 60, zone 5, park 40, bulldoze 2 per non-empty tile.
  • DECOR RULE (cross-module contract): decor can only exist on Empty tiles. Any action that converts a tile with TILE_FLAG_DECOR (road, zone, park, bulldoze) clears the flag and adds TOOL_COSTS.treeClear (3).
  • Limits: at most MAX_ACTION_TILES (1024) tiles (extra tiles are invalid); duplicate tiles count once; invalid tiles are skipped silently; unaffordable actions (cost > money) are rejected entirely with reason 'Not enough money'.
  • previewAction is PURE and uses the same validation code. It returns valid[] per input tile in order, validCount, cost, affordable, and a reason when validCount === 0 or unaffordable (e.g. 'Nothing to build here', 'Cannot build on water').
  • applyAction:
    – applies the action and recomputes derived state immediately (road masks / access / components, land value, pollution);
    – emits 'tiles:changed' (cause 'tool', all changed tiles including every footprint tile of removed buildings);
    – emits 'action:applied' {action, result} ALWAYS, even when rejected;
    – emits 'stats:changed'.
10. Controls:
  • setSpeed: emit 'sim:speed' only on change.
  • setTaxRate(zone, %): clamp to [TAX_MIN, TAX_MAX], round, then 'stats:changed'.
  • setName: trim, ≤ 32 chars, ignore empty names, then 'stats:changed'.
  • addMoney: 'stats:changed'.
11. CityReader:
  • Out-of-map queries return neutral values (Empty, None, 0, false).
  • getTileInfo is complete: height and water from the terrain, decor flag, roadMask, roadAccess (= a road of ANY network within 3), landValue, pollution, building.
  • forEachBuilding iterates in a deterministic order; plus getHistory, getSpeed, getTaxRates.
12. Notifications ('notify', rate-limited to ≤ 1 per kind per ~6 months):
  • population milestones 100, 500, 1k, 2k, 5k, 10k, 25k, 50k, 100k ('success');
  • money < 0 ('warning');
  • zones with road access but no connection to the highway ('info': connect roads to the map edge);
  • hints for high unemployment, not enough workers, or commercial wanting customers;
  • abandonment waves.

TUNING TARGETS (verify with a scripted bot; speed 1 = 5 days/s):
- The first construction sites appear within ~5 s (≈ 25 days) of zoning next to the starter road.
- 2 minutes (600 days) after zoning ~30 R + 15 I + 10 C tiles along a road, population is > 300.
- L2 buildings appear within a few minutes, and L3 by ~10 minutes (3000 days) in good spots.
- The budget is positive at default taxes for a sensible layout after the first months.
- A sensible player reaches 10k+ population without going broke.
- A full-map city (all land zoned) stays stable, without runaway oscillations.

PERF:
- Average tick ≤ 0.3 ms for a full 64×64 city (~2000 buildings).
- update ≤ 1 ms average at speed 3.
- previewAction of 1024 tiles ≤ 1 ms.
- Road analysis recompute ≤ 1 ms.

RULES:
(1) No npm install, no git commit.
(2) `npx tsc --noEmit` (run in /home/claude/vcb) must report no errors in your files; ignore errors in files you don't own (others are mid-edit). verbatimModuleSyntax: type-only imports via `import type` / inline `type`. No TS enums. strict, noImplicitReturns, noFallthroughCasesInSwitch, noImplicitOverride.
(3) Keep the exported names, constructor signatures and file paths listed above.
(4) Never throw out of per-frame methods (update, queries); only load() throws, by contract. Validate inputs; out-of-range queries return neutral values.
(5) No per-frame allocations in hot paths; typed arrays for bulk data.
(6) Determinism: all randomness comes from the persisted Rng — never Math.random.
(7) Scratch / test files only in your session scratchpad, never in the repo.
(8) If a contract seems wrong or missing, do NOT change it: work around it inside your files and report it at the end.
(9) Kill every background process you start before you finish.

TESTING TOOLS:
(a) Pure TS in Node: put an entry .ts in your scratchpad that imports your module by absolute path (src/...). From /home/claude/vcb run `npx rolldown <entry.ts> --format esm --platform node --file <out.mjs> && node <out.mjs>`. Use createGameBus() from src/core/events.ts and a fake TerrainReader: flat land at h 12 with a 3-tile river column and a hill block, or the skeleton's flat terrain /home/claude/vcb-skeleton/src/voxel/terrain.ts.
(b) Browser (optional for this module):
  • Start a dev server in the background WITHOUT `cd … &&` in front (so $! is the server PID): `VCB_VITE_CACHE=<scratch>/vite-cache node node_modules/vite/bin/vite.js <root dir> --port 5233 --strictPort > <scratch>/vite.log 2>&1 &` then `echo $! > <scratch>/vite.pid`.
  • Run `node scripts/smoke.mjs --url 'http://127.0.0.1:5233/?fresh&seed=7' --wait 8000 --eval 'window.__vcb.sim.getStats()'`. --eval is repeatable and may return a Promise. Exit code 1 on page errors.
  • Kill the server afterwards and check `pgrep -af vite`. Always set VCB_VITE_CACHE to a private directory.
  • For isolation, `bash scripts/harness.sh <new empty scratch dir> src/sim` builds a runnable copy (skeleton + your live files). In the skeleton the structures module is a stub that draws nothing, so judge via evals such as window.__vcb.sim.applyAction({type:'zone',zone:1,tiles:[{tx:33,tz:31}]}), window.__vcb.sim.tick(300) and window.__vcb.sim.getStats().

TESTS FOR THIS MODULE:
1. Action rules: every row of the actions table, including costs, decor clearing, duplicates, > 1024 tiles, unaffordable rejection, bridge vs land, bulldozing a 2×2 building via one tile, rezoning, preview purity (serialize() equal before and after), and event emission counts and order.
2. Bot playtest:
  • newCity, build a small road grid off the starter road, zone ~30 R / 15 I / 10 C;
  • run 600 / 3000 / 10000 ticks while logging population, jobs, money, demand and building counts per level;
  • assert the tuning targets;
  • add a larger 'sensible city' script that reaches 10k+.
3. Invariant checker after every tick and action:
  • buildingAt is consistent with buildings;
  • footprints are Zoned, of the same zone, at equal heights and not water; no overlaps;
  • size 2 ⇒ level 3; stage within range;
  • money only drops via upkeep;
  • tiles:changed contains all footprint tiles of changed buildings.
4. Determinism, the serialize/load round trip (mechanic 3), and load() rejecting corrupted snapshots without changing state.
5. Perf numbers vs. targets.

FINAL REPORT (your last message): files changed/added; what is implemented and what is not; how you tested (commands, key numbers incl. the bot's population/money curves); performance vs. targets; known issues; contract problems you worked around (contracts unchanged). Confirm that none of your dev servers or other background processes is still running.

## Done means
`npx tsc --noEmit` passes for your files against the frozen contracts; report any contract problems instead of editing contract files.
