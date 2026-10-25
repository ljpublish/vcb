# Module: ui

Status: QUEUED, available to hand off
Suggested effort: high

## Files you own (edit only these)
- src/ui/gameUI.ts
- src/ui/hud.ts
- src/ui/toolbar.ts
- src/ui/panels.ts
- src/ui/notifications.ts
- src/ui/minimap.ts
- src/ui/icons.ts
- src/ui/sfx.ts
- src/ui/ui.css

## Brief

ROLE: You are the ui agent, one of 8 agents building a browser 3D voxel city builder IN PARALLEL in the shared tree /home/claude/vcb (TypeScript 7/tsgo strict, three r186, Vite 8). The architect wrote frozen contracts, the composition root (src/game.ts) and a runnable skeleton; you replace the stubs in src/ui with a complete, polished, game-like DOM interface over the 3D view.

The interface includes:
- a top HUD: city, date, money, population, jobs, RCI demand bars, speed controls, menu buttons;
- a tool palette with icons, hotkeys and costs;
- a cursor tooltip and toasts;
- an inspect panel and a minimap;
- modals: budget (tax sliders + history chart), save/load with export/import, new city, settings, help;
- debug and loading overlays;
- onboarding tips and tiny procedural sound effects.
No external assets: inline SVG icons, system fonts and a WebAudio synth only.

READ FIRST: ARCHITECTURE.md (whole file; most relevant: §1 URL params and debug handle, §10 events, §13 input key ownership, §14 UI, §15 saves, §17 startup), src/types.ts (GameUIDeps, IGameUI, IGameController, ISimulation / CityReader, CityStats, BudgetReport, HistorySample, TileInfo, ToolPreviewInfo, IToolController, ICameraRig, ISceneContext, IEffects, KEYMAP, TOOL_COSTS, TOOL_IDS, QUICKSAVE_SLOT, SETTINGS_KEY, TAX_MIN/MAX), src/game.ts, src/core/util.ts (formatDate, formatMoney, formatNumber, formatPercent, isEditableTarget, keyMatches, randomCityName), src/core/rng.ts (randomSeed), src/core/events.ts, src/voxel/blocks.ts (BLOCK_COLOR for the minimap), src/style.css (CSS variables), and the doc comments in YOUR files (gameUI.ts has the full feature list and is part of this spec). If docs and frozen code disagree, the code wins.

YOU OWN (edit only these; new files allowed inside src/ui/): src/ui/gameUI.ts, hud.ts, toolbar.ts, panels.ts, notifications.ts, minimap.ts, icons.ts, sfx.ts, ui.css.

NEVER EDIT: src/types.ts, src/core/*, src/voxel/blocks.ts, src/mesh/protocol.ts, src/render/sharedUniforms.ts, src/render/colorSetup.ts, src/game.ts, src/main.ts, index.html, src/style.css, tsconfig.json, vite.config.ts, package.json, ARCHITECTURE.md, scripts/*, /home/claude/vcb-skeleton/*, node_modules, or any other module's files. Allowed imports: src/types.ts, src/core/*, src/voxel/blocks.ts and your own files (three only if really needed); never another module's implementation. All game actions go through the interfaces in your deps. The integrator will run the full game with every real module: code against the interface contracts, not against the skeleton stubs' current behaviour.

EXPORTS THAT MUST STAY:
- `export class GameUI implements IGameUI` with `constructor(deps: GameUIDeps)` ({ root: the #ui element, bus, sim: ISimulation, terrain: TerrainReader, tools: IToolController, camera: ICameraRig, view: ISceneContext, fx: IEffects, game: IGameController }).
- It is constructed last in game.ts. showLoading(msg|null) must work immediately after construction: the game calls it during newCity / load, before the first update.
- ui.update(dt) is called every frame.
- modalOpen must reflect open modals; the game listens to 'ui:modal' to disable the camera and tools.
- All other src/ui files are module-internal.
- Import './ui.css' from gameUI.ts and use the CSS variables in src/style.css (--vcb-panel, --vcb-accent, --vcb-res / com / ind, …).
- #ui has pointer-events: none, so interactive panels must set pointer-events: auto.

FEATURES (the gameUI.ts doc comment is the spec):
1. HUD (hud.ts):
  • city name (sim.name) and date formatDate(stats.day, 'long');
  • money via formatMoney: red when < 0, with a brief green/red flash on change. Copy the numbers you compare, because the sim may update its stats object in place;
  • population, jobs, and RCI demand bars (−1..1, centred, in zone colours);
  • speed buttons pause / 1 / 2 / 3, synced from 'sim:speed';
  • buttons: Budget, Save, Load, New, Settings, Help.
  • Update from 'stats:changed', but write the DOM ≤ 10 Hz.
2. Toolbar (toolbar.ts + icons.ts):
  • the 7 tools (select, road, zone_r, zone_c, zone_i, park, bulldoze) with crisp inline-SVG icons (20–24 px), labels and hotkey badges ('1'..'7');
  • hints with costs from TOOL_COSTS: road $10 / bridge $60 per tile, zone $5, park $40, bulldoze $2 + $15×level per building, trees +$3;
  • active state from 'tool:changed'; a click calls tools.setTool;
  • an overlay picker (none / land value / pollution / road access → tools.overlay, synced from 'overlay:changed') and a grid toggle (tools.gridVisible).
3. Cursor tooltip and status line:
  • the tooltip comes from 'tool:preview': cost and 'n tiles', red with the reason when unaffordable or invalid; positioned near screenX / screenY and kept on screen; hidden on null;
  • the status line comes from 'tile:hover', e.g. 'Tile 33, 30 · Grass · height 12', using sim.getTileInfo.
4. Toasts (notifications.ts) from 'notify': stacking, max ~5, auto-dismiss after durationMs (default 3500, errors ~6000), kind colours, click to dismiss.
5. Inspect panel on 'inspect' {tile}:
  • TileInfo: coords, kind / zone, water / height, road mask, road access, land value, pollution, decor;
  • building details: zone, level, size, state (incl. 'Under construction (stage n/3)' and 'Abandoned'), residents or jobs as occupants/capacity, built date;
  • buttons 'Look at' (camera.lookAtTile) and close;
  • live refresh ≤ 4 Hz.
  • Closing it (× or Escape) emits 'inspect' {tile: null}, but do not re-emit when you are reacting to an incoming 'inspect' event (avoid loops). An 'inspect' null from the tools closes it.
6. Modals (panels.ts). Opening or closing emits 'ui:modal' {open}; one modal at a time; Escape or a backdrop click closes.
  • Budget:
    – tax sliders 0..20 per zone → sim.setTaxRate (current values from sim.getTaxRates());
    – last-month and projected-month tables from stats.lastMonth / projected: taxes R/C/I, other income, road upkeep, park upkeep, income, expenses, net;
    – current money;
    – a history sparkline canvas of population + money from sim.getHistory().
  • Save / Load:
    – list from game.listSaves(), newest first, with name, slot, savedAt (toLocaleString), formatDate(day), population and size;
    – Load: close the modal, then game.loadGame(slot); Delete with a confirm; quick save; overwrite; save as a new slot (name → slug matching [a-z0-9_-]{1,32});
    – Export: game.exportSave() into a read-only textarea, with Copy (navigator.clipboard, with a select/execCommand fallback) and Download .txt (Blob + object URL);
    – Import: from a pasted textarea or a file input (FileReader) → game.importSave(text).
  • New City: the name is prefilled with randomCityName(seed); a seed number field with a dice button (randomSeed()); Create closes the modal and calls game.newCity({seed, name}).
  • Settings:
    – shadows → view.shadowsEnabled; automatic day/night → view.autoTime;
    – time-of-day slider → view.timeOfDay (turn auto off while dragging);
    – traffic & particles → fx.enabled; grid → tools.gridVisible;
    – sound volume + mute; reset camera → camera.reset();
    – persisted as JSON in localStorage[SETTINGS_KEY] (try/catch) and applied at construction. Missing or corrupt settings fall back to the defaults: shadows true, autoTime true, grid false, fx true, volume 0.5.
  • Help: controls generated from KEYMAP with readable key names; mouse controls (left = tools, right-drag = orbit, middle / Shift+right-drag = pan, wheel = zoom); short gameplay tips.
7. Minimap (minimap.ts):
  • a ~192 px canvas (3 px per tile) in a bottom corner;
  • shows water, terrain height shading (terrain.getTileHeight / getGroundBlock → BLOCK_COLOR), roads, zones (R/C/I colours, darker when built) and parks;
  • a camera focus marker plus a view-direction wedge (camera.getState());
  • click / drag → camera.lookAtTile;
  • full redraw on 'city:loaded' and throttled redraws (≤ 2 Hz) on 'tiles:changed'; the marker goes on a separate, cheap layer.
8. Hotkeys: ONE capture-phase keydown listener on window.
  • Skip events when isEditableTarget(e.target) (except Escape in modals) and when ctrl / meta is held. Ignore auto-repeat for toggles.
  • Bindings:
    – KEYMAP.toolSelect..toolBulldoze → tools.setTool;
    – togglePause (Space): remember the last non-zero speed (default 1);
    – faster: paused → 1, else min(3, speed+1); slower: max(1, speed−1) (stays paused if paused);
    – quickSave F5 → game.saveGame(QUICKSAVE_SLOT); quickLoad F9 → game.loadGame(QUICKSAVE_SLOT);
    – toggleGrid G; cycleOverlay O (none → landValue → pollution → roadAccess);
    – toggleHelp H / F1; toggleDebug Backquote / F3.
  • preventDefault for handled keys that have browser defaults (Space, F1, F3, F5, F9, Backquote).
  • While a modal is open: handle only Escape (close), and call stopPropagation() on every keydown whose target is not editable, so the camera and tools don't react. Never stop keyup events, and don't stop events in text fields: stopping them in the window capture phase would break the field's own handlers.
  • While only the inspect panel is open: Escape closes it WITHOUT stopPropagation, so the tools still get Escape.
  • Camera keys (WASD, arrows, Q/E, R/F, Z/X, PageUp/Down, Home) belong to the camera rig, and Escape otherwise belongs to the tool controller — don't consume them.
  • Ignore mutating hotkeys while game.busy.
  • Blur buttons after clicks, so Space doesn't re-trigger them.
9. Debug overlay (Backquote / F3; initially on with ?debug in the URL): game.getDebugInfo() at ≤ 4 Hz — FPS, frame ms, sim ms, draw calls, triangles, structures pending, and mesh queued / inFlight / workers / avgMeshMs / meshes.
10. Loading overlay (showLoading): full-screen, blocks pointer input, spinner + message; null hides it (fade).
11. Onboarding: on 'city:loaded' with source 'new', show a dismissible 'Getting started' card, until it has been dismissed once (remember that in the settings). Content: build roads (2) off the highway coming from the west edge; zone Residential (3) / Commercial (4) / Industrial (5) next to roads; watch the RCI bars; keep the budget positive; Space pauses.
12. SFX (sfx.ts): a tiny WebAudio synth (oscillators + noise buffers + envelopes).
  • Sounds: click, build (road), zone, bulldoze, error, coin, milestone.
  • Create / unlock the AudioContext on the first pointerdown / keydown; volume and mute come from the settings.
  • Event mapping: 'action:applied' ok → build / zone / bulldoze by action type, !ok → error; 'sim:month' with net > 0 → a soft coin; 'notify' success → milestone; UI clicks → click.
  • Keep it subtle.

DESIGN:
- A modern city-builder look: dark translucent glass panels (--vcb-panel), rounded corners, soft shadows, accent orange, zone colours.
- Layout: a compact top bar; the toolbar bottom-centre; the minimap in a bottom corner; toasts top-right; the inspect panel on the right; modals centred with a backdrop.
- Works at 1280×720 and 1920×1080 and degrades gracefully down to ~900 px wide (collapse labels).
- Accessible titles / aria-labels on buttons.
- No layout thrash: cache elements and update textContent only when values change.

PERF: ui.update(dt) ≤ 0.3 ms typical; no per-frame DOM writes when nothing changed.

RULES:
(1) No npm install, no git commit.
(2) `npx tsc --noEmit` (run in /home/claude/vcb) must report no errors in your files; ignore errors in files you don't own (others are mid-edit). verbatimModuleSyntax: type-only imports via `import type` / inline `type`. No TS enums. strict, noImplicitReturns, noFallthroughCasesInSwitch, noImplicitOverride.
(3) Keep the exported names, constructor signatures and file paths listed above.
(4) Never throw out of update() or event handlers; validate inputs.
(5) No needless per-frame allocations.
(6) Subscribe to the bus in the constructor; unsubscribe and remove every DOM / window listener in dispose() (and remove your DOM).
(7) Scratch / test files only in your session scratchpad, never in the repo (no dist/ in the repo).
(8) If a contract seems wrong or missing, do NOT change it: work around it inside your files and report it at the end.
(9) Kill every background process you start before you finish.

TESTING TOOLS:
(a) Pure TS in Node: put an entry .ts in your scratchpad that imports your module by absolute path (src/...). From /home/claude/vcb run `npx rolldown <entry.ts> --format esm --platform node --file <out.mjs> && node <out.mjs>`. DOM code is better tested in the browser.
(b) Browser:
  • Start a dev server in the background WITHOUT `cd … &&` in front (so $! is the server PID): `VCB_VITE_CACHE=<scratch>/vite-cache node node_modules/vite/bin/vite.js <root dir> --port 5277 --strictPort > <scratch>/vite.log 2>&1 &` then `echo $! > <scratch>/vite.pid`.
  • Run `node scripts/smoke.mjs --url 'http://127.0.0.1:5277/?fresh&seed=7' --wait 8000 --shot <scratch>/a.png --eval '<js>'`. --eval is repeatable and may return a Promise; other options: --after, --width/--height, --timeout. Exit code 1 on page errors. Look at the PNG with your image-reading tool.
  • window.__vcb is the Game (fields sim, world, view, meshes, structures, rig, tools, fx, saves, ui, bus, terrain). Use backtick strings inside single-quoted --eval arguments.
  • Afterwards `kill $(cat <scratch>/vite.pid)` and check that `pgrep -af vite` no longer lists it.
  • Your port: 5277 (try the next ports if busy). Always set VCB_VITE_CACHE to a private directory.
(c) Isolation: other agents rewrite their modules concurrently.
  • `bash scripts/harness.sh <new empty dir in your scratchpad> src/ui` builds a runnable copy = pristine skeleton + your live files (node_modules symlinked). You may add the live src/persist and src/sim paths when they exist, to see real data. Run vite with that dir as root.
  • Inside the copy you may add test pages and fakes — never in the repo.
  • Skeleton state: the sim stub returns neutral stats (zeros, $25,000); the saves stub stores nothing; the tool controller stub tracks the tool and emits tool:changed; the camera-rig stub applies reset()/setState() poses.

TESTS FOR THIS MODULE:
- Screenshots at 1280×800 and 1920×1080 of:
  • the HUD;
  • each modal (add a public test helper such as openModal(id) on GameUI and call it via --eval);
  • the inspect panel, toasts and tooltip (emit 'inspect', 'notify' and 'tool:preview' events through window.__vcb.bus.emit in --eval);
  • the debug overlay and the loading overlay.
- Copy smoke.mjs and script keyboard tests (page.keyboard.press with Digit3, Space, KeyH, Escape, F3, BracketRight), asserting window.__vcb.tools.tool, window.__vcb.sim.getSpeed() and window.__vcb.ui.modalOpen.
- Check that no key reaches the camera while a modal is open, that typing in modal text fields works, and that clicks on panels don't reach the canvas.

FINAL REPORT (your last message): files changed/added; what is implemented and what is not; how you tested (commands, key numbers, screenshot paths); performance; known issues; contract problems you worked around (contracts unchanged). Confirm that none of your dev servers or other background processes is still running.

## Done means
`npx tsc --noEmit` passes for your files against the frozen contracts; report any contract problems instead of editing contract files.
