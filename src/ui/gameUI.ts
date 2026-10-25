/**
 * MODULE: ui — DOM user interface root.
 * Owner: ui agent. Implements IGameUI (src/types.ts).
 *
 * STUB: only the loading overlay works. Replace with the full UI (may use the other files in src/ui/).
 *
 * Intended (see the ui brief + ARCHITECTURE.md §14):
 *  - Imports './ui.css'. Builds everything inside deps.root (#ui, pointer-events: none; interactive
 *    panels set pointer-events: auto).
 *  - Top bar (hud.ts): city name, date (formatDate), money (red when < 0, flashes on change),
 *    population, jobs, RCI demand bars (−1..1, centred), speed buttons (pause/1/2/3) with active
 *    state synced from 'sim:speed', buttons: Budget, Save, Load, New, Settings, Help.
 *  - Toolbar (toolbar.ts): 7 tools with inline-SVG icons (icons.ts), hotkey badges, cost tooltip
 *    (TOOL_COSTS), active state from 'tool:changed'. Overlay picker (none/land value/pollution/access).
 *  - Cursor tooltip from 'tool:preview' (cost, "n tiles", red when unaffordable / reason).
 *  - Toasts (notifications.ts) from 'notify' (stacking, auto-dismiss, kind colours).
 *  - Inspect panel (panels.ts) on 'inspect': TileInfo (+ building details), live refresh ≤ 4 Hz,
 *    close button / Escape when open.
 *  - Modals (panels.ts): Budget (tax sliders per zone → sim.setTaxRate, last/projected month table,
 *    history sparkline), Save/Load (game.listSaves/saveGame/loadGame/deleteSave, export/import text),
 *    New City (name + seed, random), Settings (shadows, day/night auto + time slider, grid, sfx
 *    volume; persisted to localStorage[SETTINGS_KEY]), Help (controls from KEYMAP).
 *    Opening/closing a modal emits 'ui:modal'.
 *  - Minimap (minimap.ts): canvas 160–200 px, tile colours by kind/zone/water, camera focus marker,
 *    click → camera.lookAtTile. Redraw on 'tiles:changed' (throttled) + 'city:loaded'.
 *  - Hotkeys (capture-phase keydown on window; skip when isEditableTarget): tools, speed, quick
 *    save/load, grid, help, debug overlay (FPS, draw calls, triangles, mesh queue from
 *    game.getDebugInfo()), overlay cycle. When a modal is open, handle Escape (close) and
 *    stopPropagation() so camera/tools don't react.
 *  - SFX (sfx.ts): tiny WebAudio synth (click, build, bulldoze, error, coin), muted by default
 *    until the first user gesture; volume setting.
 *  - showLoading(msg): full-screen overlay with spinner + message; null hides it.
 *  - Throttle DOM writes (stats ≤ 10 Hz); never allocate per frame needlessly.
 */
import type { GameUIDeps, IGameUI } from '../types';

export class GameUI implements IGameUI {
  private readonly deps: GameUIDeps;
  private loadingEl: HTMLDivElement | null = null;
  private _modalOpen = false;

  constructor(deps: GameUIDeps) {
    this.deps = deps;
  }

  get modalOpen(): boolean {
    return this._modalOpen;
  }

  update(dt: number): void {
    // TODO(ui)
  }

  showLoading(message: string | null): void {
    if (message === null) {
      this.loadingEl?.remove();
      this.loadingEl = null;
      return;
    }
    if (!this.loadingEl) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(15,20,30,0.82);color:#fff;font-size:18px;pointer-events:auto;z-index:100';
      this.deps.root.appendChild(el);
      this.loadingEl = el;
    }
    this.loadingEl.textContent = message;
  }

  dispose(): void {
    this.loadingEl?.remove();
    this.loadingEl = null;
  }
}
