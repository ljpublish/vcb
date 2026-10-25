/**
 * MODULE: input — tool system (select / road / zone R,C,I / park / bulldoze), drag gestures,
 * ghost previews, overlays.
 * Owner: input agent. Implements IToolController (src/types.ts).
 *
 * STUB: only tracks the current tool and emits 'tool:changed'. Replace with the full controller.
 *
 * Intended behaviour:
 *  - Pointer events on deps.dom (the canvas). LEFT button only; ignore when !enabled or when a
 *    camera drag (right/middle) is in progress. Hover → pickTile() → 'tile:hover' (only on change).
 *  - Tools:
 *      select   : click → 'inspect' { tile } (click on empty sky/off-map → { tile: null }).
 *      road     : press = start tile; drag = L-shaped path lPathTiles(start, cur) (Shift: straight
 *                 line straightPathTiles); release = apply { type:'road', tiles }.
 *      zone_*   : drag rectangle rectTiles(start, cur) → { type:'zone', zone, tiles }.
 *      park     : drag rectangle → { type:'park', tiles }.
 *      bulldoze : drag rectangle → { type:'bulldoze', tiles }.
 *    Clamp tile lists to MAX_ACTION_TILES (truncate + 'notify' warning once per drag).
 *  - Preview while dragging (and single-tile hover preview when not dragging): sim.previewAction()
 *    → TileHighlighter colours: valid = tool colour (road 0xc8c8c8, R 0x55d14a, C 0x3f9bff,
 *    I 0xffc21a, park 0x2fbf71, bulldoze 0xff4d4d), invalid = dark red 0x8a1c1c @ lower opacity;
 *    unaffordable → everything red. Emit 'tool:preview' { preview } with cost/counts and pointer
 *    position (null when idle / select tool). Re-run preview only when the tile set changes or the
 *    sim emits 'tiles:changed' / 'stats:changed' (money) — never every frame.
 *  - Apply on release: result = sim.applyAction(action); if !result.ok and a reason exists →
 *    'notify' { kind: 'warning', message: reason }.
 *  - Escape (KEYMAP.cancel): cancel an active drag; if none, setTool('select'). Right-click during
 *    a left drag cancels it.
 *  - overlay setter → DataOverlay + 'overlay:changed'; gridVisible → GridOverlay.
 *  - setTool(t): cancel drag, update cursor style on the canvas (crosshair for build tools,
 *    not-allowed when hovering invalid), emit 'tool:changed'. No-op when unchanged.
 *  - update(dt): animate highlight pulse; refresh DataOverlay.
 */
import type { IToolController, OverlayMode, ToolControllerDeps, ToolId } from '../types';

export class ToolController implements IToolController {
  enabled = true;
  gridVisible = false;
  private readonly deps: ToolControllerDeps;
  private _tool: ToolId = 'select';
  private _overlay: OverlayMode = 'none';

  constructor(deps: ToolControllerDeps) {
    this.deps = deps;
  }

  get tool(): ToolId {
    return this._tool;
  }

  setTool(tool: ToolId): void {
    if (tool === this._tool) return;
    this._tool = tool;
    this.deps.bus.emit('tool:changed', { tool });
  }

  cancel(): void {
    // TODO(input)
  }

  get overlay(): OverlayMode {
    return this._overlay;
  }

  set overlay(mode: OverlayMode) {
    if (mode === this._overlay) return;
    this._overlay = mode;
    this.deps.bus.emit('overlay:changed', { mode });
  }

  update(dt: number): void {
    // TODO(input)
  }

  dispose(): void {
    // TODO(input)
  }
}
