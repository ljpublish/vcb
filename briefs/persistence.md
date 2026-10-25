# Module: persistence

Status: QUEUED, available to hand off
Suggested effort: high

## Files you own (edit only these)
- src/persist/saveCodec.ts
- src/persist/saveManager.ts

## Brief

ROLE: You are the persistence agent, one of 8 agents building a browser 3D voxel city builder IN PARALLEL in the shared tree /home/claude/vcb (TypeScript 7/tsgo strict, Vite 8). The architect wrote frozen contracts, the composition root (src/game.ts) and a runnable skeleton; you replace the stubs in src/persist with complete implementations.

Goal: robust localStorage save slots with a compact, versioned, validated format; autosave; quick save/load; export/import as text. A broken or foreign save must never crash the game.

READ FIRST: ARCHITECTURE.md (whole file; most relevant: §15 save format v1, §17 startup / load sequence, §9 state ownership), src/types.ts (SavePayload, CitySnapshot, Building, HistorySample, CameraState, SaveSlotInfo, SaveResult, ISaveManager, SaveManagerDeps, SAVE_VERSION, SAVE_KEY_PREFIX, AUTOSAVE_SLOT, QUICKSAVE_SLOT, AUTOSAVE_INTERVAL_MS, MAP_TILES, TILE_COUNT, TAX_MIN/MAX), src/game.ts, src/core/events.ts ('save:written', 'notify'), src/core/util.ts (errorMessage), and the doc comments in YOUR files (saveCodec.ts documents the stored format and is part of this spec). If docs and frozen code disagree, the code wins.

YOU OWN (edit only these; new files allowed inside src/persist/): src/persist/saveCodec.ts, src/persist/saveManager.ts.

NEVER EDIT: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, src/render/colorSetup.ts, src/game.ts, src/main.ts, index.html, src/style.css, tsconfig.json, vite.config.ts, package.json, ARCHITECTURE.md, scripts/*, /home/claude/vcb-skeleton/*, node_modules, or any other module's files. Allowed imports: src/types.ts, src/core/* and your own files; never another module's implementation. The integrator will run the full game with every real module: code against the interface contracts. In particular, the real simulation's serialize() produces large, fully populated snapshots, and its load() re-validates game rules and throws on inconsistencies.

EXPORTS THAT MUST STAY:
- `export class SaveManager implements ISaveManager` with `constructor(deps: SaveManagerDeps)` ({ storage: Storage | null — null when localStorage is unavailable — and bus }).
- How game.ts uses it:
  • on start: saves.has(AUTOSAVE_SLOT) → saves.load(AUTOSAVE_SLOT); null → a new city;
  • saves.startAutosave(() => busy ? null : makePayload(), AUTOSAVE_INTERVAL_MS);
  • saveGame(slot) → saves.save(slot, payload); the game shows the toast;
  • loadGame(slot) → saves.load(slot);
  • listSaves → saves.list(); deleteSave → saves.remove;
  • exportSave → saves.exportString(payload); importSave(text) → saves.importString(text);
  • dispose → saves.dispose().
- saveCodec.ts is module-internal, but its STORED FORMAT is the documented contract (ARCHITECTURE.md §15 + the saveCodec.ts doc comment): keep them in sync.
- The payload is SavePayload { city: CitySnapshot, camera?: CameraState }. CitySnapshot holds Uint8Array(TILE_COUNT = 4096) tileKind / tileZone / tileFlags, Building records, HistorySample[] and extra (JSON-safe, sim-private).

FORMAT v1 (SAVE_VERSION = 1). The stored string is the JSON of:
- { format: 'vcb-save', version, savedAt (ms epoch), meta, payload: { city: EncodedCityV1, camera? } }
- meta = { name, day, money, population }, where population = Σ occupants of zone-1 (residential) buildings.
- EncodedCityV1 contains:
  • every CitySnapshot scalar as-is: version, mapTiles, seed, name, day, money, speed, taxRates {r,c,i}, rngState, nextBuildingId;
  • tileKind / tileZone / tileFlags as base64 of a byte-RLE ([count, value] pairs, count 1..255);
  • buildings as tuples [id, zone, level, tx, tz, size, facing, variant, state, stage, stateDays, occupants, capacity, builtDay];
  • history as tuples [day, population, money, jobs, demandR, demandC, demandI];
  • extra verbatim.

A. saveCodec.ts:
- encodeSave(payload, savedAt = Date.now()) → string.
- decodeSave(text) → { payload, envelope }, or throws SaveFormatError.
- readEnvelope(text) → the header / meta without decoding the payload; null if unreadable.
- rleEncode / rleDecode: decode throws on odd length, count 0, or output length ≠ expected.
- bytesToBase64 / base64ToBytes: chunked String.fromCharCode in 0x8000 slices + btoa / atob; invalid base64 → SaveFormatError.
- decodeSave steps:
  1. JSON.parse (errors → SaveFormatError).
  2. Format check.
  3. Version must be an integer; > SAVE_VERSION → SaveFormatError ('made by a newer version').
  4. Older versions migrate step by step via MIGRATIONS: Record<number, (env) => env> (v → v+1). The table is empty for v1, but implement the mechanism and unit-test it with a fake migration.
  5. Decode.
  6. VALIDATE EVERYTHING:
    – mapTiles === MAP_TILES;
    – the arrays decode to exactly TILE_COUNT bytes; tileKind ∈ 0..3, tileZone ∈ 0..3; flags may be any byte (bits 1–7 are sim-private: keep them verbatim);
    – scalars finite: seed and rngState uint32; day an integer ≥ 0; money finite; speed ∈ 0..3; taxRates ∈ [TAX_MIN, TAX_MAX]; nextBuildingId an integer ≥ 1 and > every building id;
    – name must be a string (do not alter it, so round trips stay exact);
    – buildings: tuple length 14; id an integer ≥ 1 and unique; zone 1..3; level 1..3; size 1|2; footprint inside the map (tx,tz ≥ 0, tx+size ≤ 64, tz+size ≤ 64); facing 0..3; variant uint32; state 0..2; stage an integer 0..2; stateDays / occupants / capacity / builtDay finite ≥ 0;
    – history: tuples of 7 finite numbers;
    – extra: a plain object (missing → {});
    – camera: optional, all five fields finite, otherwise dropped (not fatal).
- Game-rule consistency (zones vs. footprints etc.) is checked again by the simulation's load(), which throws — that is fine.
- Round-trip guarantee: decodeSave(encodeSave(p)).payload deep-equals p, typed arrays included and fractional numbers preserved.

B. saveManager.ts:
- key(slot) = SAVE_KEY_PREFIX + slot. Slots must match /^[a-z0-9_-]{1,32}$/; for an invalid slot, save returns { ok:false, error:'Invalid slot name' }, load returns null, has returns false, and remove is a no-op.
- save(slot, payload):
  • storage null → { ok:false, bytes:0, error:'Storage unavailable' };
  • otherwise encode, then setItem in a try/catch; a QuotaExceededError → { ok:false, error:'Storage is full — delete old saves' };
  • on success, emit 'save:written' { slot, bytes: text.length, auto }, with auto = true only for autosave-triggered saves;
  • never throws.
- load(slot): getItem → decodeSave → payload; any error → console.warn + null; never throws.
- has(slot).
- list():
  • all keys with the prefix (iterate storage.length / storage.key(i));
  • readEnvelope for meta, no full decode;
  • returns SaveSlotInfo { slot, name, savedAt, day, money, population, bytes, version };
  • corrupt entries are listed with name '(corrupt)' and savedAt 0;
  • sorted newest first.
- remove(slot).
- exportString(payload) = 'VCB1:' + base64(UTF-8 bytes of the envelope JSON), using TextEncoder / TextDecoder.
- importString(text): trim; accept the 'VCB1:' form (ignore whitespace / newlines inside the base64) and raw envelope JSON (starting with '{'); null on any error.
- startAutosave(provider, intervalMs):
  • stop any previous autosave;
  • setInterval → provider() (in a try/catch; null → skip) → save(AUTOSAVE_SLOT, …, auto);
  • also autosave immediately on document 'visibilitychange' when hidden and on window 'pagehide';
  • guard against re-entrancy, and guard with typeof document / window checks so the code also runs in Node tests;
  • if an autosave fails, emit at most one 'notify' warning per ~10 minutes.
- stopAutosave() clears the timer and the listeners; dispose() = stopAutosave().

PERF: encoding and decoding a full 64×64 city (~2500 buildings, 240 history samples) take ≤ 30 ms each; the typical stored size is well under 200 KB.

RULES:
(1) No npm install, no git commit.
(2) `npx tsc --noEmit` (run in /home/claude/vcb) must report no errors in your files; ignore errors in files you don't own (others are mid-edit). verbatimModuleSyntax: type-only imports via `import type` / inline `type`. No TS enums. strict, noImplicitReturns, noFallthroughCasesInSwitch, noImplicitOverride.
(3) Keep the exported names, constructor signatures and file paths listed above.
(4) SaveManager methods never throw; the codec throws only SaveFormatError.
(5) Remove all timers and listeners in dispose().
(6) Scratch / test files only in your session scratchpad, never in the repo (no dist/ in the repo).
(7) If a contract seems wrong or missing, do NOT change it: work around it inside your files and report it at the end.
(8) Kill every background process you start before you finish.

TESTING TOOLS:
(a) Pure TS in Node (Node has btoa / atob / TextEncoder): put an entry .ts in your scratchpad that imports your modules by absolute path (src/persist/...). From /home/claude/vcb run `npx rolldown <entry.ts> --format esm --platform node --file <out.mjs> && node <out.mjs>`.
(b) Browser:
  • Start a dev server in the background WITHOUT `cd … &&` in front (so $! is the server PID): `VCB_VITE_CACHE=<scratch>/vite-cache node node_modules/vite/bin/vite.js <root dir> --port 5288 --strictPort > <scratch>/vite.log 2>&1 &` then `echo $! > <scratch>/vite.pid`.
  • Run `node scripts/smoke.mjs --url 'http://127.0.0.1:5288/?fresh&seed=7' --wait 8000 --eval '<js>'`. --eval is repeatable and may return a Promise; exit code 1 on page errors.
  • window.__vcb is the Game. Use backtick strings inside the single-quoted --eval argument.
  • Afterwards `kill $(cat <scratch>/vite.pid)` and check that `pgrep -af vite` no longer lists it.
  • Your port: 5288 (try the next ports if busy). Always set VCB_VITE_CACHE to a private directory.
(c) Isolation: `bash scripts/harness.sh <new empty dir in your scratchpad> src/persist` builds a runnable copy = pristine skeleton + your live files. The skeleton sim serializes an empty but valid city.

TESTS FOR THIS MODULE:
- Round trips: synthetic payloads (typed arrays with long runs and noise, 2500 random valid buildings, history, nested extra, with and without camera, unicode city names) must deep-equal after encode → decode.
- Corrupt inputs must make decodeSave throw SaveFormatError, and SaveManager.load must return null without throwing:
  • truncated JSON, wrong format tag, newer version, wrong array lengths;
  • invalid base64, RLE overflow / underflow, NaN / Infinity;
  • a building out of the map, duplicate ids, bad tuple lengths.
- Storage behaviour with a Map-backed fake Storage (getItem / setItem / removeItem / key / length / clear) and a variant whose setItem throws a QuotaExceededError:
  • save / load / has / list (ordering, '(corrupt)' entries) / remove / export / import;
  • autosave with a short interval;
  • 'save:written' events, via createGameBus from src/core/events.ts.
- Timing numbers vs. the perf target.
- Browser, in the harness:
  • 'window.__vcb.saveGame(`t1`)', then 'window.__vcb.listSaves()', then 'window.__vcb.loadGame(`t1`)' → true;
  • 'window.__vcb.importSave(window.__vcb.exportSave())' → true;
  • the console stays clean;
  • after a reload without ?fresh, the autosave is picked up.

FINAL REPORT (your last message): files changed/added; what is implemented and what is not; how you tested (commands, key numbers); performance vs. targets; known issues; contract problems you worked around (contracts unchanged). Confirm that none of your dev servers or other background processes is still running.

## Done means
`npx tsc --noEmit` passes for your files against the frozen contracts; report any contract problems instead of editing contract files.
