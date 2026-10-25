/**
 * MODULE: input — tool system (select / road / zone R,C,I / park / bulldoze), drag gestures,
 * ghost previews, overlays.
 * Owner: input agent. Implements IToolController (src/types.ts).
 *
 * Behaviour:
 *  - Pointer events on deps.dom (the canvas). LEFT button only; ignored when !enabled or while a
 *    camera drag (right/middle, or the select-mode left-drag pan) is in progress.
 *    Hover → pickTile() → 'tile:hover' (only on change; null when the pointer leaves the canvas).
 *    The hover is re-picked when the camera moves under a still pointer.
 *  - Tools:
 *      select   : click → 'inspect' { tile } (off-map → { tile: null }); hover outlines the tile or
 *                 the building footprint; a persistent selection outline follows 'inspect'.
 *      road     : press = start tile; drag = lPathTiles(start, cur) (Shift: straightPathTiles);
 *                 release = apply { type:'road', tiles }.
 *      zone_*   : drag rectangle rectTiles(start, cur) → { type:'zone', zone, tiles }.
 *      park     : drag rectangle → { type:'park', tiles }.
 *      bulldoze : drag rectangle → { type:'bulldoze', tiles }; every building touched is marked
 *                 with a translucent box of approximate height.
 *    Tile lists are clamped to MAX_ACTION_TILES (truncated + one 'notify' warning per drag).
 *    Drags that leave the map clamp to the map edge.
 *  - Preview while dragging (and single-tile hover preview when not dragging): sim.previewAction()
 *    → TileHighlighter colours (valid = tool colour, invalid = dark red at lower opacity,
 *    unaffordable → everything red). 'tool:preview' { preview } carries cost / counts and the
 *    pointer position (null when idle / select tool / pointer outside). The preview is recomputed
 *    only when the tile set changes or on 'tiles:changed' / 'stats:changed' — never every frame.
 *  - Release: result = sim.applyAction(action); !result.ok with a reason → 'notify' warning.
 *  - Escape (KEYMAP.cancel): cancel an active drag; if none, setTool('select'). A right-click
 *    during a left drag cancels it (and does not orbit).
 *  - overlay setter → DataOverlay + 'overlay:changed'; gridVisible → GridOverlay.
 *  - setTool(t): no-op when unchanged; cancels the drag, updates the cursor (crosshair for build
 *    tools, not-allowed over an invalid tile, grabbing while the camera drags), emits 'tool:changed'.
 *  - update(dt): highlight pulse, deferred preview refresh, grid + DataOverlay refresh, cursor.
 */
import type * as THREE from 'three';
import {
  BRIDGE_DECK_HEIGHT,
  KEYMAP,
  MAP_TILES,
  MAX_ACTION_TILES,
  TILE_SIZE,
  TOOL_IDS,
  TileKind,
  type ActionPreview,
  type IToolController,
  type OverlayMode,
  type ToolAction,
  type ToolControllerDeps,
  type ToolId,
  type ToolPreviewInfo,
  type TileCoord,
} from '../types';
import { lPathTiles, rectTiles, straightPathTiles } from '../core/coords';
import { errorMessage, isEditableTarget, keyMatches } from '../core/util';
import { DataOverlay, GridOverlay, TileHighlighter, approxBuildingHeight, type FootprintBox } from './overlays';
import { pickPlane, pickTile, type TileHeightFn } from './picking';
import { buttonBit, getInputShared, type InputShared } from './shared';

const TOOL_COLORS: Record<ToolId, number> = {
  select: 0xffffff,
  road: 0xc8c8c8,
  zone_r: 0x55d14a,
  zone_c: 0x3f9bff,
  zone_i: 0xffc21a,
  park: 0x2fbf71,
  bulldoze: 0xff4d4d,
};
const INVALID_COLOR = 0x8a1c1c;
const UNAFFORDABLE_COLOR = 0xff3b3b;
const OVERLAY_MODES: readonly OverlayMode[] = ['none', 'landValue', 'pollution', 'roadAccess'];
const CLICK_SLOP_PX = 5;

function isBuildTool(t: ToolId): boolean {
  return t !== 'select';
}

interface DragState {
  pointerId: number;
  start: TileCoord;
  cur: TileCoord;
  /** Surface height at the start tile, for off-map clamping via a plane pick. */
  planeY: number;
  shift: boolean;
  warned: boolean;
}

export class ToolController implements IToolController {
  gridVisible = false;
  private readonly deps: ToolControllerDeps;
  private readonly shared: InputShared;
  private _enabled = true;
  private _tool: ToolId = 'select';
  private _overlay: OverlayMode = 'none';

  private readonly highlighter: TileHighlighter;
  private readonly grid: GridOverlay;
  private readonly data: DataOverlay;

  private drag: DragState | null = null;
  /** Select tool: a left press waiting for its release. */
  private selectPress: { pointerId: number; x: number; y: number } | null = null;
  private hoverTx = -1;
  private hoverTz = -1;
  private hoverValid = true;
  private pointerInside = false;
  private clientX = 0;
  private clientY = 0;
  private shiftKey = false;

  /** Tiles of the current action / single-tile hover preview. */
  private tiles: TileCoord[] = [];
  private tilesKey = '';
  private preview: ActionPreview | null = null;
  private previewDirty = false;
  private selected: TileCoord | null = null;

  private time = 0;
  private cursor = '';
  private readonly lastCamPos = new Float64Array(7);

  private readonly heightAt: TileHeightFn;
  private readonly unsubs: Array<() => void> = [];
  private readonly listeners: Array<[EventTarget, string, EventListener]> = [];
  private readonly boxes: FootprintBox[] = [];
  private readonly colors: number[] = [];
  private readonly dims: boolean[] = [];

  constructor(deps: ToolControllerDeps) {
    this.deps = deps;
    this.shared = getInputShared(deps.dom);
    this.shared.tool = this._tool;
    this.highlighter = new TileHighlighter(deps.overlayRoot);
    this.data = new DataOverlay(deps.overlayRoot);
    this.grid = new GridOverlay(deps.overlayRoot);

    const { sim, terrain } = deps;
    this.heightAt = (tx, tz) => {
      try {
        if (terrain.isWater(tx, tz)) return sim.getTileKind(tx, tz) === TileKind.Road ? BRIDGE_DECK_HEIGHT : terrain.getSurfaceHeight(tx, tz);
        return terrain.getSurfaceHeight(tx, tz);
      } catch {
        return 0;
      }
    };

    const dom = deps.dom;
    this.listen(dom, 'pointerdown', this.onPointerDown as EventListener);
    this.listen(dom, 'pointermove', this.onPointerMove as EventListener);
    this.listen(dom, 'pointerup', this.onPointerUp as EventListener);
    this.listen(dom, 'pointercancel', this.onPointerCancel as EventListener);
    this.listen(dom, 'pointerleave', this.onPointerLeave as EventListener);
    this.listen(dom, 'pointerenter', this.onPointerEnter as EventListener);
    this.listen(window, 'keydown', this.onKeyDown as EventListener);
    this.listen(window, 'keyup', this.onKeyUp as EventListener);
    this.listen(window, 'blur', this.onBlur);

    const bus = deps.bus;
    this.unsubs.push(
      bus.on('tiles:changed', () => {
        this.previewDirty = true;
        this.grid.invalidate();
        this.data.invalidate();
        this.updateSelectionOutline();
        this.updateHoverOutline();
      }),
      bus.on('stats:changed', () => {
        if (this.tiles.length > 0) this.previewDirty = true;
      }),
      bus.on('inspect', ({ tile }) => {
        this.selected = tile ? { tx: tile.tx, tz: tile.tz } : null;
        this.updateSelectionOutline();
      }),
      bus.on('city:loaded', () => {
        this.selected = null;
        this.grid.invalidate();
        this.data.invalidate();
        this.updateSelectionOutline();
        this.previewDirty = true;
      }),
    );
    this.applyCursor();
  }

  // ------------------------------------------------------------------ public API

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    const b = !!v;
    if (b === this._enabled) return;
    this._enabled = b;
    if (!b) {
      this.cancel();
      this.selectPress = null;
      this.setHover(-1, -1);
    } else {
      this.repick();
    }
  }

  get tool(): ToolId {
    return this._tool;
  }

  setTool(tool: ToolId): void {
    if (!TOOL_IDS.includes(tool) || tool === this._tool) return;
    this.endDrag();
    this.selectPress = null;
    this._tool = tool;
    this.shared.tool = tool;
    this.highlighter.hoverOutline.hide();
    this.rebuildTiles(true);
    this.updateHoverOutline();
    this.applyCursor();
    this.deps.bus.emit('tool:changed', { tool });
  }

  cancel(): void {
    this.endDrag();
    this.selectPress = null;
    this.tiles = [];
    this.tilesKey = '';
    this.preview = null;
    this.previewDirty = false;
    this.highlighter.clear();
    this.emitPreview(null);
  }

  get overlay(): OverlayMode {
    return this._overlay;
  }

  set overlay(mode: OverlayMode) {
    if (!OVERLAY_MODES.includes(mode) || mode === this._overlay) return;
    this._overlay = mode;
    this.data.invalidate();
    this.deps.bus.emit('overlay:changed', { mode });
  }

  update(dt: number): void {
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.time += d;
    this.highlighter.setPulse(0.82 + 0.18 * Math.sin(this.time * 5));

    if (this.pointerInside && this._enabled && this.cameraMoved()) this.repick();
    if (this.previewDirty) {
      this.previewDirty = false;
      this.refreshPreview();
    }

    const hover = this.hoverTx >= 0 ? this._hoverScratch : null;
    if (hover) {
      hover.tx = this.hoverTx;
      hover.tz = this.hoverTz;
    }
    this.grid.update(hover, this.gridVisible || isBuildTool(this._tool), this.deps.terrain, this.heightAt);
    this.data.update(this._overlay, this.deps.sim, this.deps.terrain, d);
    this.applyCursor();
  }

  private readonly _hoverScratch: TileCoord = { tx: 0, tz: 0 };

  dispose(): void {
    this.endDrag();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.listeners.length = 0;
    this.highlighter.dispose();
    this.grid.dispose();
    this.data.dispose();
    this.deps.dom.style.cursor = '';
  }

  // ------------------------------------------------------------------ pointer

  private readonly onPointerEnter = (e: PointerEvent): void => {
    this.pointerInside = true;
    this.clientX = e.clientX;
    this.clientY = e.clientY;
  };

  private readonly onPointerLeave = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointerId) return; // captured drag keeps going
    this.pointerInside = false;
    this.setHover(-1, -1);
    if (!this.drag) {
      this.tiles = [];
      this.tilesKey = '';
      this.preview = null;
      this.highlighter.clear();
      this.emitPreview(null);
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.handleButton(e, e.button, true);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.handleButton(e, e.button, false);
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointerId) this.cancelDragOnly();
    if (this.selectPress && e.pointerId === this.selectPress.pointerId) this.selectPress = null;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.button >= 0) this.handleButton(e, e.button, (e.buttons & buttonBit(e.button)) !== 0);
    if (!e.isPrimary && !this.drag) return;
    this.pointerInside = true;
    this.clientX = e.clientX;
    this.clientY = e.clientY;
    this.shiftKey = e.shiftKey;
    this.repick();
    if (this.preview && isBuildTool(this._tool)) this.emitPreviewInfo();
  };

  private handleButton(e: PointerEvent, button: number, down: boolean): void {
    this.shiftKey = e.shiftKey;
    if (down) {
      if (button === 2 && this.drag) {
        // Right-click during a left drag cancels it (the camera rig refuses to orbit meanwhile).
        this.cancelDragOnly();
        e.preventDefault();
        return;
      }
      if (button !== 0 || !this._enabled || this.shared.cameraDragging || this.drag) return;
      this.clientX = e.clientX;
      this.clientY = e.clientY;
      if (this._tool === 'select') {
        this.selectPress = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        return;
      }
      const pick = pickTile(this.deps.camera, this.deps.dom, e.clientX, e.clientY, this.deps.terrain, this.heightAt);
      if (!pick) return;
      this.drag = {
        pointerId: e.pointerId,
        start: { tx: pick.tx, tz: pick.tz },
        cur: { tx: pick.tx, tz: pick.tz },
        planeY: pick.surfaceY,
        shift: e.shiftKey,
        warned: false,
      };
      this.shared.toolDragging = true;
      try {
        this.deps.dom.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      try {
        this.deps.dom.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
      this.setHover(pick.tx, pick.tz);
      this.rebuildTiles(false);
      return;
    }
    if (button !== 0) return;
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.commitDrag();
      return;
    }
    const press = this.selectPress;
    if (press && e.pointerId === press.pointerId) {
      this.selectPress = null;
      const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX;
      if (this.shared.suppressClick || moved || !this._enabled || this._tool !== 'select') {
        this.shared.suppressClick = false;
        return;
      }
      const pick = pickTile(this.deps.camera, this.deps.dom, e.clientX, e.clientY, this.deps.terrain, this.heightAt);
      this.deps.bus.emit('inspect', { tile: pick ? { tx: pick.tx, tz: pick.tz } : null });
    }
  }

  // ------------------------------------------------------------------ keyboard

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.trackShift(e);
    if (!this._enabled || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
    if (!keyMatches(KEYMAP.cancel, e.code)) return;
    if (this.drag) this.cancelDragOnly();
    else if (this._tool !== 'select') this.setTool('select');
    else return;
    e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.trackShift(e);
  };

  private trackShift(e: KeyboardEvent): void {
    if (e.shiftKey === this.shiftKey) return;
    this.shiftKey = e.shiftKey;
    // Shift toggles the straight road shape mid-drag.
    if (this.drag && this._tool === 'road') this.rebuildTiles(false);
  }

  private readonly onBlur = (): void => {
    this.shiftKey = false;
    this.cancelDragOnly();
    this.selectPress = null;
  };

  // ------------------------------------------------------------------ drag / hover

  /** Re-pick the tile under the last pointer position (pointer move or camera move). */
  private repick(): void {
    if (!this.pointerInside || !this._enabled) return;
    const pick = pickTile(this.deps.camera, this.deps.dom, this.clientX, this.clientY, this.deps.terrain, this.heightAt);
    const drag = this.drag;
    if (drag) {
      let tx: number, tz: number;
      if (pick) {
        tx = pick.tx;
        tz = pick.tz;
      } else {
        // Off the map: clamp the plane hit at the start height to the map edge.
        const p = pickPlane(this.deps.camera, this.deps.dom, this.clientX, this.clientY, drag.planeY);
        if (!p) return;
        tx = Math.min(MAP_TILES - 1, Math.max(0, Math.floor(p.x / TILE_SIZE)));
        tz = Math.min(MAP_TILES - 1, Math.max(0, Math.floor(p.z / TILE_SIZE)));
      }
      this.setHover(pick ? pick.tx : -1, pick ? pick.tz : -1);
      if (tx !== drag.cur.tx || tz !== drag.cur.tz || drag.shift !== this.shiftKey) {
        drag.cur.tx = tx;
        drag.cur.tz = tz;
        this.rebuildTiles(false);
      }
      return;
    }
    if (this.shared.cameraDragging) return;
    const changed = this.setHover(pick ? pick.tx : -1, pick ? pick.tz : -1);
    if (changed) this.rebuildTiles(false);
  }

  /** Returns true if the hovered tile changed. */
  private setHover(tx: number, tz: number): boolean {
    if (tx === this.hoverTx && tz === this.hoverTz) return false;
    this.hoverTx = tx;
    this.hoverTz = tz;
    this.deps.bus.emit('tile:hover', { tile: tx >= 0 ? { tx, tz } : null });
    this.updateHoverOutline();
    return true;
  }

  private cameraMoved(): boolean {
    const cam = this.deps.camera as THREE.PerspectiveCamera;
    const p = cam.position;
    const q = cam.quaternion;
    const l = this.lastCamPos;
    const eps = 1e-4;
    if (
      Math.abs(l[0]! - p.x) < eps && Math.abs(l[1]! - p.y) < eps && Math.abs(l[2]! - p.z) < eps &&
      Math.abs(l[3]! - q.x) < 1e-6 && Math.abs(l[4]! - q.y) < 1e-6 && Math.abs(l[5]! - q.z) < 1e-6 && Math.abs(l[6]! - q.w) < 1e-6
    ) return false;
    l[0] = p.x; l[1] = p.y; l[2] = p.z; l[3] = q.x; l[4] = q.y; l[5] = q.z; l[6] = q.w;
    return true;
  }

  /** Recompute the action's tile list; refresh the preview only if the set changed. */
  private rebuildTiles(force: boolean): void {
    let tiles: TileCoord[];
    const drag = this.drag;
    if (!isBuildTool(this._tool)) tiles = [];
    else if (drag) {
      drag.shift = this.shiftKey;
      if (this._tool === 'road') tiles = drag.shift ? straightPathTiles(drag.start, drag.cur) : lPathTiles(drag.start, drag.cur);
      else tiles = rectTiles(drag.start, drag.cur);
      if (tiles.length > MAX_ACTION_TILES) {
        tiles.length = MAX_ACTION_TILES;
        if (!drag.warned) {
          drag.warned = true;
          this.deps.bus.emit('notify', { kind: 'warning', message: `Area too large: limited to ${MAX_ACTION_TILES} tiles` });
        }
      }
    } else if (this.hoverTx >= 0 && this.pointerInside) tiles = [{ tx: this.hoverTx, tz: this.hoverTz }];
    else tiles = [];

    const key = drag
      ? `${this._tool}|${drag.start.tx},${drag.start.tz}|${drag.cur.tx},${drag.cur.tz}|${drag.shift ? 1 : 0}`
      : `${this._tool}|h${tiles.length ? `${tiles[0]!.tx},${tiles[0]!.tz}` : ''}`;
    if (!force && key === this.tilesKey) return;
    this.tilesKey = key;
    this.tiles = tiles;
    this.refreshPreview();
  }

  private makeAction(tiles: TileCoord[]): ToolAction | null {
    switch (this._tool) {
      case 'road': return { type: 'road', tiles };
      case 'zone_r': return { type: 'zone', zone: 1, tiles };
      case 'zone_c': return { type: 'zone', zone: 2, tiles };
      case 'zone_i': return { type: 'zone', zone: 3, tiles };
      case 'park': return { type: 'park', tiles };
      case 'bulldoze': return { type: 'bulldoze', tiles };
      default: return null;
    }
  }

  private refreshPreview(): void {
    const tiles = this.tiles;
    const action = tiles.length > 0 ? this.makeAction(tiles) : null;
    if (!action) {
      this.preview = null;
      this.hoverValid = true;
      this.highlighter.clear();
      this.emitPreview(null);
      return;
    }
    let preview: ActionPreview;
    try {
      preview = this.deps.sim.previewAction(action);
    } catch (err) {
      preview = { cost: 0, valid: [], validCount: 0, affordable: false, reason: errorMessage(err) };
    }
    if (!preview || !Array.isArray(preview.valid)) {
      preview = { cost: 0, valid: [], validCount: 0, affordable: false };
    }
    this.preview = preview;
    this.hoverValid = preview.validCount > 0 && preview.affordable;

    const n = tiles.length;
    const colors = this.colors;
    const dims = this.dims;
    colors.length = n;
    dims.length = n;
    const toolColor = TOOL_COLORS[this._tool];
    for (let i = 0; i < n; i++) {
      const ok = preview.valid[i] === true;
      if (!preview.affordable) {
        colors[i] = ok ? UNAFFORDABLE_COLOR : INVALID_COLOR;
        dims[i] = !ok;
      } else {
        colors[i] = ok ? toolColor : INVALID_COLOR;
        dims[i] = !ok;
      }
    }
    this.highlighter.show(tiles, colors, dims, this.heightAt);

    // Buildings a bulldoze would hit: their ground highlight is hidden, so box them.
    const boxes = this.boxes;
    boxes.length = 0;
    if (this._tool === 'bulldoze') {
      const seen = new Set<number>();
      const city = this.deps.sim;
      for (let i = 0; i < n; i++) {
        const t = tiles[i]!;
        const id = city.getBuildingIdAt(t.tx, t.tz);
        if (id <= 0 || seen.has(id)) continue;
        seen.add(id);
        const b = city.getBuilding(id);
        if (!b) continue;
        const y0 = this.deps.terrain.getTileHeight(b.tx, b.tz);
        boxes.push({
          x0: b.tx * TILE_SIZE, z0: b.tz * TILE_SIZE,
          x1: (b.tx + b.size) * TILE_SIZE, z1: (b.tz + b.size) * TILE_SIZE,
          y0, y1: y0 + approxBuildingHeight(b.level, b.size),
        });
      }
    }
    this.highlighter.showBoxes(boxes, preview.affordable ? TOOL_COLORS.bulldoze : UNAFFORDABLE_COLOR);
    this.emitPreviewInfo();
  }

  private emitPreviewInfo(): void {
    const p = this.preview;
    if (!p || !isBuildTool(this._tool) || (!this.pointerInside && !this.drag)) {
      this.emitPreview(null);
      return;
    }
    this.emitPreview({
      tool: this._tool,
      cost: p.cost,
      validCount: p.validCount,
      totalCount: this.tiles.length,
      affordable: p.affordable,
      reason: p.reason,
      screenX: this.clientX,
      screenY: this.clientY,
    });
  }

  private previewShown = false;

  private emitPreview(preview: ToolPreviewInfo | null): void {
    if (preview === null && !this.previewShown) return;
    this.previewShown = preview !== null;
    this.deps.bus.emit('tool:preview', { preview });
  }

  private commitDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    // Make sure the tile list reflects the release position.
    this.rebuildTiles(false);
    const action = this.tiles.length > 0 ? this.makeAction(this.tiles.slice()) : null;
    this.endDrag();
    if (action) {
      try {
        const result = this.deps.sim.applyAction(action);
        if (result && !result.ok && result.reason) this.deps.bus.emit('notify', { kind: 'warning', message: result.reason });
      } catch (err) {
        this.deps.bus.emit('notify', { kind: 'error', message: `Action failed: ${errorMessage(err)}` });
      }
    }
    this.rebuildTiles(true);
  }

  /** Cancel the drag and fall back to the single-tile hover preview. */
  private cancelDragOnly(): void {
    if (!this.drag) return;
    this.endDrag();
    this.rebuildTiles(true);
  }

  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.shared.toolDragging = false;
    try {
      if (this.deps.dom.hasPointerCapture(drag.pointerId)) this.deps.dom.releasePointerCapture(drag.pointerId);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ outlines / cursor

  private outlineTile(which: 'hover' | 'select', tx: number, tz: number, color?: number): void {
    const o = which === 'hover' ? this.highlighter.hoverOutline : this.highlighter.selectOutline;
    const city = this.deps.sim;
    const b = city.getBuildingAt(tx, tz);
    if (b) {
      const y0 = this.deps.terrain.getTileHeight(b.tx, b.tz);
      o.set(b.tx * TILE_SIZE, y0, b.tz * TILE_SIZE, (b.tx + b.size) * TILE_SIZE, y0 + approxBuildingHeight(b.level, b.size), (b.tz + b.size) * TILE_SIZE, color);
    } else {
      const y = this.heightAt(tx, tz);
      o.set(tx * TILE_SIZE, y + 0.05, tz * TILE_SIZE, (tx + 1) * TILE_SIZE, y + 0.35, (tz + 1) * TILE_SIZE, color);
    }
  }

  private updateHoverOutline(): void {
    if (this._tool !== 'select' || this.hoverTx < 0 || !this._enabled) {
      this.highlighter.hoverOutline.hide();
      return;
    }
    try {
      this.outlineTile('hover', this.hoverTx, this.hoverTz, 0xffffff);
    } catch {
      this.highlighter.hoverOutline.hide();
    }
  }

  private updateSelectionOutline(): void {
    const s = this.selected;
    if (!s || s.tx < 0 || s.tz < 0 || s.tx >= MAP_TILES || s.tz >= MAP_TILES) {
      this.highlighter.selectOutline.hide();
      return;
    }
    try {
      this.outlineTile('select', s.tx, s.tz, 0xffe14d);
    } catch {
      this.highlighter.selectOutline.hide();
    }
  }

  private applyCursor(): void {
    let c: string;
    if (this.shared.cursorOverride) c = this.shared.cursorOverride;
    else if (!isBuildTool(this._tool)) c = 'default';
    else if (!this.drag && this.hoverTx >= 0 && !this.hoverValid) c = 'not-allowed';
    else c = 'crosshair';
    if (c === this.cursor) return;
    this.cursor = c;
    this.deps.dom.style.cursor = c;
  }

  private listen(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }
}
