/**
 * MODULE: ui — DOM user interface root.
 * Owner: ui agent. Implements IGameUI (src/types.ts). See the ui brief + ARCHITECTURE.md §14.
 *
 *  - Builds everything inside deps.root (#ui, pointer-events: none; interactive panels opt in).
 *  - Top bar (hud.ts), toolbar + overlay picker (toolbar.ts), cursor tooltip ('tool:preview'),
 *    status line ('tile:hover'), toasts ('notify'), inspect panel ('inspect'), modals (panels.ts,
 *    'ui:modal'), minimap (minimap.ts), debug overlay, loading overlay, onboarding card.
 *  - Hotkeys: ONE capture-phase keydown listener on window. While a modal is open only Escape is
 *    handled and every non-editable keydown is stopped so the camera / tools never see it.
 *  - Sound: UI clicks go through sfx.ts into the shared audio engine (src/audio), which maps
 *    gameplay events itself. Master volume + mute are UI settings.
 *  - DOM writes are throttled: stats ≤ 10 Hz, inspect / debug ≤ 4 Hz, minimap tiles ≤ 2 Hz,
 *    and nothing is written when nothing changed.
 */
import './ui.css';
import {
  CIVIC_SPECS,
  KEYMAP,
  civicKindOfTool,
  QUICKSAVE_SLOT,
  type CityStats,
  type GameUIDeps,
  type IGameUI,
  type OverlayMode,
  type SimSpeed,
  type TileCoord,
  type ToolId,
  type ToolPreviewInfo,
} from '../types';
import { formatMoney, formatNumber, isEditableTarget, keyMatches } from '../core/util';
import { button, h, Listeners, setClass, setText } from './dom';
import { Hud } from './hud';
import { UI_ICONS } from './icons';
import { Minimap } from './minimap';
import { Toasts } from './notifications';
import { describeTileKind, groundNameOf, InspectPanel, ModalHost, type ModalId } from './panels';
import { loadSettings, saveSettings, type UISettings } from './settings';
import { Sfx } from './sfx';
import { civicHint, Toolbar } from './toolbar';

const STATS_INTERVAL = 0.1;
const DEBUG_INTERVAL = 0.25;
const MINIMAP_TILES_INTERVAL = 0.5;
const MARKER_INTERVAL = 0.1;
const STATUS_INTERVAL = 0.25;

const OVERLAY_CYCLE: readonly OverlayMode[] = ['none', 'landValue', 'pollution', 'roadAccess'];
const OVERLAY_NAMES: Record<OverlayMode, string> = {
  none: 'No overlay',
  landValue: 'Land value overlay',
  pollution: 'Pollution overlay',
  roadAccess: 'Road access overlay',
};
const TOOL_KEYS: readonly { action: keyof typeof KEYMAP; tool: ToolId }[] = [
  { action: 'toolSelect', tool: 'select' },
  { action: 'toolRoad', tool: 'road' },
  { action: 'toolResidential', tool: 'zone_r' },
  { action: 'toolCommercial', tool: 'zone_c' },
  { action: 'toolIndustrial', tool: 'zone_i' },
  { action: 'toolPark', tool: 'park' },
  { action: 'toolBulldoze', tool: 'bulldoze' },
];
/** Keys with browser defaults we always suppress (help, debug, reload, …). */
const PREVENT_CODES = new Set(['Space', 'F1', 'F3', 'F5', 'F9', 'Backquote']);

export class GameUI implements IGameUI {
  private readonly deps: GameUIDeps;
  private readonly listeners = new Listeners();
  private readonly settings: UISettings;
  private readonly sfx: Sfx;

  readonly container: HTMLDivElement;
  private readonly hud: Hud;
  private readonly toolbar: Toolbar;
  private readonly toasts: Toasts;
  private readonly inspect: InspectPanel;
  private readonly modals: ModalHost;
  private readonly minimap: Minimap;
  private readonly tooltip: HTMLDivElement;
  private readonly tooltipMain: HTMLSpanElement;
  private readonly tooltipSub: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly debugEl: HTMLPreElement;
  private readonly loadingEl: HTMLDivElement;
  private readonly loadingMsg: HTMLDivElement;
  private readonly onboarding: HTMLDivElement;

  private _modalOpen = false;
  private statsDirty = true;
  private statsT = 0;
  private debugT = 0;
  private debugVisible = false;
  private minimapT = 0;
  private markerT = 0;
  private statusT = 0;
  private statusDirty = false;
  private hoverTile: TileCoord | null = null;
  private lastSpeed: SimSpeed = 1;
  private tooltipW = 0;
  private tooltipH = 0;
  private tooltipKey = '';
  private loadingTimer = 0;
  private disposed = false;

  constructor(deps: GameUIDeps) {
    this.deps = deps;
    this.settings = loadSettings();
    this.sfx = new Sfx((volume, muted) => {
      this.settings.volume = volume;
      this.settings.muted = muted;
      saveSettings(this.settings);
    });

    this.container = h('div', 'vcb-ui');

    // --- loading overlay first: showLoading() must work right after construction.
    this.loadingMsg = h('div', 'vcb-loading-msg', { text: '' });
    this.loadingEl = h('div', 'vcb-loading', { role: 'alert', 'aria-busy': 'true' }, [
      h('div', 'vcb-loading-card', null, [h('div', 'vcb-spinner', { 'aria-hidden': 'true' }), this.loadingMsg]),
    ]);

    this.hud = new Hud({
      onSpeed: (s) => this.setSpeed(s),
      onMenu: (id) => this.openModal(id),
    });
    this.toolbar = new Toolbar(deps.tools, {
      onGridToggle: () => this.toggleGrid(),
      civicCount: (kind) => {
        const c = deps.sim.getStats().civics;
        return c && typeof c[kind] === 'number' ? c[kind] : 0;
      },
    });
    this.toasts = new Toasts();
    this.inspect = new InspectPanel({
      sim: deps.sim,
      camera: deps.camera,
      groundName: (tx, tz) => groundNameOf(deps.terrain.getGroundBlock(tx, tz)),
      onClose: () => this.closeInspect(),
    });
    this.modals = new ModalHost({
      sim: deps.sim,
      game: deps.game,
      camera: deps.camera,
      settings: this.settings,
      applySettings: () => this.applySettings(),
      getTimeOfDay: () => deps.view.timeOfDay,
      setTimeOfDay: (t) => {
        deps.view.autoTime = false;
        deps.view.timeOfDay = t;
      },
      onChange: (open) => this.onModalChange(open),
      notify: (message, kind) => this.toasts.push(message, kind),
    });
    this.minimap = new Minimap(deps.sim, deps.terrain, deps.camera, deps.view.camera);

    this.tooltipMain = h('span', 'vcb-tt-main', { text: '' });
    this.tooltipSub = h('span', 'vcb-tt-sub', { text: '' });
    this.tooltip = h('div', 'vcb-tooltip', { 'aria-hidden': 'true' }, [this.tooltipMain, this.tooltipSub]);
    this.status = h('div', 'vcb-status', { text: '' });
    this.debugEl = h('pre', 'vcb-debug vcb-panel', { 'aria-hidden': 'true' });
    this.onboarding = this.buildOnboarding();

    const bottomLeft = h('div', 'vcb-bottom-left', null, [this.status, this.minimap.el]);
    this.container.append(
      this.hud.el,
      this.debugEl,
      this.onboarding,
      this.inspect.el,
      this.toasts.el,
      bottomLeft,
      this.toolbar.el,
      this.tooltip,
      this.modals.el,
      this.loadingEl,
    );
    deps.root.appendChild(this.container);

    // --- initial state
    this.applySettings(false);
    this.debugVisible = hasUrlParam('debug');
    setClass(this.debugEl, 'vcb-show', this.debugVisible);
    try {
      this.lastSpeed = deps.sim.getSpeed() || 1;
      this.hud.setSpeed(deps.sim.getSpeed());
    } catch {
      this.hud.setSpeed(1);
    }
    this.toolbar.setGrid(this.settings.grid);
    this.minimap.redraw();

    // --- bus
    const bus = deps.bus;
    const L = this.listeners;
    L.add(bus.on('stats:changed', () => (this.statsDirty = true)));
    L.add(
      bus.on('sim:speed', ({ speed }) => {
        if (speed > 0) this.lastSpeed = speed;
        this.hud.setSpeed(speed);
      }),
    );
    L.add(bus.on('notify', ({ message, kind, durationMs }) => this.toasts.push(message, kind, durationMs)));
    L.add(bus.on('tool:changed', ({ tool }) => this.toolbar.setActive(tool)));
    L.add(bus.on('overlay:changed', ({ mode }) => this.toolbar.setOverlay(mode)));
    L.add(bus.on('tool:preview', ({ preview }) => this.showPreview(preview)));
    L.add(
      bus.on('tile:hover', ({ tile }) => {
        this.hoverTile = tile ? { tx: tile.tx, tz: tile.tz } : null;
        this.updateStatus();
      }),
    );
    L.add(bus.on('inspect', ({ tile }) => this.showInspect(tile)));
    L.add(
      bus.on('tiles:changed', ({ tiles }) => {
        this.minimap.markTiles(tiles);
        if (this.hoverTile) this.statusDirty = true;
      }),
    );
    L.add(
      bus.on('city:loaded', ({ source }) => {
        this.minimap.redraw();
        this.statsDirty = true;
        if (this.inspect.isOpen) this.closeInspect();
        this.showPreview(null);
        if (source === 'new' && !this.settings.onboardingDone) setClass(this.onboarding, 'vcb-show', true);
        else setClass(this.onboarding, 'vcb-show', false);
      }),
    );
    L.add(bus.on('save:written', ({ auto }) => this.hud.flashSaved(auto)));

    // --- DOM / window
    L.on(window, 'keydown', this.onKeyDown, true);
    L.on(window, 'pointerdown', this.unlockAudio, true);
    L.on(window, 'keydown', this.unlockAudio, true);
    L.on(this.container, 'click', this.onClick);
    // Keep wheel/context menu over panels from reaching anything else.
    L.on(this.container, 'contextmenu', (e) => {
      if (!isEditableTarget(e.target)) e.preventDefault();
    });
  }

  get modalOpen(): boolean {
    return this._modalOpen;
  }

  // ------------------------------------------------------------------ public test helpers

  /** Opens a modal (also used by tests via window.__vcb.ui.openModal('budget')). */
  openModal(id: ModalId): void {
    if (this.disposed) return;
    this.modals.open(id);
  }

  closeModal(): void {
    this.modals.close();
  }

  get currentModal(): ModalId | null {
    return this.modals.current;
  }

  // ------------------------------------------------------------------ frame

  update(dt: number): void {
    if (this.disposed) return;
    const d = Number.isFinite(dt) && dt > 0 ? dt : 0;

    this.statsT += d;
    if (this.statsDirty && this.statsT >= STATS_INTERVAL) {
      this.statsT = 0;
      this.statsDirty = false;
      let stats: Readonly<CityStats> | null = null;
      try {
        stats = this.deps.sim.getStats();
      } catch (err) {
        console.error('[ui] getStats failed', err);
      }
      if (stats) this.hud.setStats(stats, this.deps.sim.name);
    }

    this.inspect.update(d);
    this.modals.update(d);

    this.minimapT += d;
    if (this.minimapT >= MINIMAP_TILES_INTERVAL && this.minimap.hasPending) {
      this.minimapT = 0;
      this.minimap.flushTiles();
    }
    this.markerT += d;
    if (this.markerT >= MARKER_INTERVAL) {
      this.markerT = 0;
      this.minimap.updateMarker();
    }

    this.statusT += d;
    if (this.statusDirty && this.statusT >= STATUS_INTERVAL) {
      this.statusT = 0;
      this.statusDirty = false;
      this.updateStatus();
    }

    if (this.debugVisible) {
      this.debugT += d;
      if (this.debugT >= DEBUG_INTERVAL) {
        this.debugT = 0;
        this.updateDebug();
      }
    }
  }

  // ------------------------------------------------------------------ loading

  showLoading(message: string | null): void {
    if (this.disposed) return;
    clearTimeout(this.loadingTimer);
    if (message === null) {
      this.loadingEl.classList.remove('vcb-show');
      this.loadingEl.setAttribute('aria-busy', 'false');
      // After the fade, stop it from taking any space in the accessibility tree.
      this.loadingTimer = window.setTimeout(() => setText(this.loadingMsg, ''), 350);
      return;
    }
    setText(this.loadingMsg, String(message));
    this.loadingEl.setAttribute('aria-busy', 'true');
    this.loadingEl.classList.add('vcb-show');
    this.showPreview(null);
  }

  // ------------------------------------------------------------------ settings

  private applySettings(persist = true): void {
    const s = this.settings;
    const { view, fx, tools } = this.deps;
    try {
      view.shadowsEnabled = s.shadows;
      view.autoTime = s.autoTime;
      if (!s.autoTime) view.timeOfDay = s.timeOfDay;
    } catch (err) {
      console.error('[ui] view settings failed', err);
    }
    try {
      fx.enabled = s.fx;
    } catch (err) {
      console.error('[ui] fx setting failed', err);
    }
    try {
      tools.gridVisible = s.grid;
    } catch (err) {
      console.error('[ui] grid setting failed', err);
    }
    this.toolbar?.setGrid(s.grid);
    this.sfx.volume = s.volume;
    this.sfx.muted = s.muted;
    if (persist) saveSettings(s);
  }

  private toggleGrid(): void {
    this.settings.grid = !this.settings.grid;
    this.applySettings();
  }

  // ------------------------------------------------------------------ speed

  private setSpeed(speed: SimSpeed): void {
    if (this.deps.game.busy) return;
    try {
      this.deps.sim.setSpeed(speed);
    } catch (err) {
      console.error('[ui] setSpeed failed', err);
    }
    // The sim emits 'sim:speed'; sync immediately in case it does not.
    let s: SimSpeed = speed;
    try {
      s = this.deps.sim.getSpeed();
    } catch {
      // ignore
    }
    if (s > 0) this.lastSpeed = s;
    this.hud.setSpeed(s);
  }

  private currentSpeed(): SimSpeed {
    try {
      return this.deps.sim.getSpeed();
    } catch {
      return 1;
    }
  }

  // ------------------------------------------------------------------ modals / inspect

  private onModalChange(open: boolean): void {
    if (open === this._modalOpen) return;
    this._modalOpen = open;
    setClass(this.container, 'vcb-modal-open', open);
    if (open) this.showPreview(null);
    this.deps.bus.emit('ui:modal', { open });
  }

  /** Reacting to an incoming 'inspect' event: never re-emit. */
  private showInspect(tile: TileCoord | null): void {
    this.inspect.show(tile);
    setClass(this.container, 'vcb-inspect-open', this.inspect.isOpen);
  }

  /** The user closed the panel: hide it and tell the tools (selection outline). */
  private closeInspect(): void {
    this.inspect.show(null);
    setClass(this.container, 'vcb-inspect-open', false);
    this.deps.bus.emit('inspect', { tile: null });
  }

  // ------------------------------------------------------------------ tooltip / status

  private showPreview(p: ToolPreviewInfo | null): void {
    if (!p || this._modalOpen) {
      setClass(this.tooltip, 'vcb-show', false);
      this.tooltipKey = '';
      return;
    }
    const total = Math.max(0, p.totalCount | 0);
    const valid = Math.max(0, p.validCount | 0);
    const bad = valid === 0 || !p.affordable;
    const tilesText = total > 0 && valid !== total ? `${valid}/${total} tiles` : `${valid} tile${valid === 1 ? '' : 's'}`;
    const civic = civicKindOfTool(p.tool);
    const main =
      p.tool === 'select' ? '' : civic && CIVIC_SPECS[civic] ? `${CIVIC_SPECS[civic].label} · ${formatMoney(p.cost)}` : `${formatMoney(p.cost)} · ${tilesText}`;
    const sub = bad ? p.reason || (!p.affordable ? 'Not enough money' : 'Nothing to change here') : '';
    const key = `${main}|${sub}|${bad}`;
    if (key !== this.tooltipKey) {
      this.tooltipKey = key;
      setText(this.tooltipMain, main);
      setText(this.tooltipSub, sub);
      setClass(this.tooltip, 'vcb-bad', bad);
      setClass(this.tooltip, 'vcb-show', main !== '' || sub !== '');
      // Measure only when the content changed.
      this.tooltipW = this.tooltip.offsetWidth;
      this.tooltipH = this.tooltip.offsetHeight;
    }
    const vw = this.container.clientWidth || window.innerWidth;
    const vh = this.container.clientHeight || window.innerHeight;
    let x = (Number.isFinite(p.screenX) ? p.screenX : 0) + 18;
    let y = (Number.isFinite(p.screenY) ? p.screenY : 0) + 20;
    if (x + this.tooltipW > vw - 8) x = Math.max(8, p.screenX - this.tooltipW - 14);
    if (y + this.tooltipH > vh - 8) y = Math.max(8, p.screenY - this.tooltipH - 14);
    this.tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private updateStatus(): void {
    const t = this.hoverTile;
    if (!t) {
      setText(this.status, '');
      setClass(this.status, 'vcb-show', false);
      return;
    }
    let text: string;
    try {
      const info = this.deps.sim.getTileInfo(t.tx, t.tz);
      const ground = groundNameOf(this.deps.terrain.getGroundBlock(t.tx, t.tz));
      text = `Tile ${info.tx}, ${info.tz} · ${describeTileKind(info, ground)} · height ${info.height}`;
      if (info.building) text += ` · ${formatNumber(info.building.occupants)}/${formatNumber(info.building.capacity)}`;
    } catch {
      text = `Tile ${t.tx}, ${t.tz}`;
    }
    setText(this.status, text);
    setClass(this.status, 'vcb-show', true);
  }

  // ------------------------------------------------------------------ debug

  private updateDebug(): void {
    let text: string;
    try {
      const d = this.deps.game.getDebugInfo();
      const m = d.mesh;
      text =
        `FPS ${d.fps.toFixed(0).padStart(4)}   frame ${d.frameMs.toFixed(2)} ms\n` +
        `sim ${d.simMs.toFixed(2)} ms   pending ${d.structuresPending}\n` +
        `draws ${d.drawCalls}   tris ${formatNumber(d.triangles, true)}\n` +
        `mesh q ${m.queued}  fly ${m.inFlight}  w ${m.workers}\n` +
        `mesh ${m.avgMeshMs.toFixed(2)} ms  n ${m.meshes}  tot ${m.meshedTotal}`;
    } catch (err) {
      text = `debug info unavailable\n${String(err)}`;
    }
    setText(this.debugEl, text);
  }

  private toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    setClass(this.debugEl, 'vcb-show', this.debugVisible);
    if (this.debugVisible) {
      this.debugT = 0;
      this.updateDebug();
    }
  }

  // ------------------------------------------------------------------ onboarding

  private buildOnboarding(): HTMLDivElement {
    const close = button('vcb-icon-btn vcb-close', '', 'Dismiss tips', UI_ICONS.close);
    const ok = button('vcb-primary vcb-small', 'Got it', 'Dismiss tips');
    const dismiss = (): void => {
      setClass(this.onboarding, 'vcb-show', false);
      if (!this.settings.onboardingDone) {
        this.settings.onboardingDone = true;
        saveSettings(this.settings);
      }
    };
    close.addEventListener('click', dismiss);
    ok.addEventListener('click', dismiss);
    const k = (s: string): HTMLElement => h('kbd', '', { text: s });
    return h('div', 'vcb-onboarding vcb-panel', { role: 'note' }, [
      h('div', 'vcb-onb-head', null, [h('span', 'vcb-ico', { html: UI_ICONS.lightbulb, 'aria-hidden': 'true' }), h('strong', '', { text: 'Getting started' }), close]),
      h('ol', 'vcb-onb-list', null, [
        h('li', '', null, ['Build roads ', k('2'), ' off the highway coming in from the west edge.']),
        h('li', '', null, ['Zone ', h('span', 'vcb-zr', { text: 'Residential' }), ' ', k('3'), ', ', h('span', 'vcb-zc', { text: 'Commercial' }), ' ', k('4'), ' and ', h('span', 'vcb-zi', { text: 'Industrial' }), ' ', k('5'), ' next to roads.']),
        h('li', '', null, ['Watch the RCI bars in the top bar and zone what is in demand.']),
        h('li', '', null, ['Keep the budget positive. ', k('Space'), ' pauses, ', k('H'), ' shows all controls.']),
      ]),
      h('div', 'vcb-form-row vcb-end', null, [ok]),
    ]);
  }

  // ------------------------------------------------------------------ input

  private readonly unlockAudio = (): void => {
    this.sfx.unlock();
  };

  private readonly onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    const btn = target && typeof target.closest === 'function' ? target.closest('button') : null;
    if (!btn || btn.disabled) return;
    // Tool buttons get their sound from 'tool:changed' in the audio engine.
    if (!btn.classList.contains('vcb-tool')) this.sfx.play('click');
    // Mouse clicks (detail > 0) blur so Space / Enter don't re-trigger the button.
    if (e.detail > 0) btn.blur();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    try {
      this.handleKey(e);
    } catch (err) {
      console.error('[ui] key handler failed', err);
    }
  };

  private handleKey(e: KeyboardEvent): void {
    if (this.disposed) return;
    const code = e.code;
    const editable = isEditableTarget(e.target);

    if (this._modalOpen) {
      if (code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.modals.close();
        return;
      }
      if (editable) return; // never stop events in text fields
      e.stopPropagation();
      if (PREVENT_CODES.has(code) && code !== 'Space') e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.repeat) return;
      // Help toggles closed with its own key; the debug overlay works everywhere.
      if (keyMatches(KEYMAP.toggleHelp, code) && this.modals.current === 'help') {
        e.preventDefault();
        this.modals.close();
      } else if (keyMatches(KEYMAP.toggleDebug, code)) {
        e.preventDefault();
        this.toggleDebug();
      }
      return;
    }

    if (editable || e.ctrlKey || e.metaKey) return;

    if (code === 'Escape') {
      // Close the civic menu / inspect panel but let the tool controller still get Escape.
      if (this.toolbar.civicMenuOpen) this.toolbar.toggleCivicMenu(false);
      if (this.inspect.isOpen) this.closeInspect();
      return;
    }

    if (PREVENT_CODES.has(code)) e.preventDefault();
    const busy = this.deps.game.busy;

    // Non-mutating toggles first.
    if (keyMatches(KEYMAP.toggleDebug, code)) {
      if (!e.repeat) this.toggleDebug();
      return;
    }
    if (keyMatches(KEYMAP.toggleHelp, code)) {
      e.preventDefault();
      if (!e.repeat && !busy) this.openModal('help');
      return;
    }

    for (const tk of TOOL_KEYS) {
      if (!keyMatches(KEYMAP[tk.action], code)) continue;
      if (busy || e.repeat) return;
      try {
        this.deps.tools.setTool(tk.tool);
      } catch (err) {
        console.error('[ui] setTool failed', err);
      }
      return;
    }

    if (keyMatches(KEYMAP.toolCivic, code)) {
      if (busy || e.repeat) return;
      let cur: ToolId = 'select';
      try {
        cur = this.deps.tools.tool;
      } catch {
        // ignore
      }
      const next = this.toolbar.nextCivicTool(cur);
      try {
        this.deps.tools.setTool(next);
      } catch (err) {
        console.error('[ui] setTool failed', err);
      }
      const kind = civicKindOfTool(next);
      if (kind) this.toasts.push(`${CIVIC_SPECS[kind].label} · ${civicHint(kind)}`, 'info', 1800);
      return;
    }

    if (keyMatches(KEYMAP.togglePause, code)) {
      if (busy || e.repeat) return;
      const s = this.currentSpeed();
      this.setSpeed(s === 0 ? this.lastSpeed || 1 : 0);
      return;
    }
    if (keyMatches(KEYMAP.faster, code)) {
      if (busy || e.repeat) return;
      const s = this.currentSpeed();
      this.setSpeed((s === 0 ? 1 : Math.min(3, s + 1)) as SimSpeed);
      return;
    }
    if (keyMatches(KEYMAP.slower, code)) {
      if (busy || e.repeat) return;
      const s = this.currentSpeed();
      if (s !== 0) this.setSpeed(Math.max(1, s - 1) as SimSpeed);
      return;
    }
    if (keyMatches(KEYMAP.quickSave, code)) {
      if (busy || e.repeat) return;
      try {
        this.deps.game.saveGame(QUICKSAVE_SLOT);
      } catch (err) {
        console.error('[ui] quick save failed', err);
      }
      return;
    }
    if (keyMatches(KEYMAP.quickLoad, code)) {
      if (busy || e.repeat) return;
      void this.deps.game.loadGame(QUICKSAVE_SLOT).catch((err: unknown) => console.error('[ui] quick load failed', err));
      return;
    }
    if (keyMatches(KEYMAP.toggleGrid, code)) {
      if (busy || e.repeat) return;
      this.toggleGrid();
      this.toasts.push(this.settings.grid ? 'Grid on' : 'Grid off', 'info', 1200);
      return;
    }
    if (keyMatches(KEYMAP.cycleOverlay, code)) {
      if (busy || e.repeat) return;
      let cur: OverlayMode = 'none';
      try {
        cur = this.deps.tools.overlay;
      } catch {
        // ignore
      }
      const next = OVERLAY_CYCLE[(OVERLAY_CYCLE.indexOf(cur) + 1) % OVERLAY_CYCLE.length]!;
      try {
        this.deps.tools.overlay = next;
      } catch (err) {
        console.error('[ui] overlay failed', err);
      }
      this.toolbar.setOverlay(next);
      this.toasts.push(OVERLAY_NAMES[next], 'info', 1200);
      return;
    }
  }

  // ------------------------------------------------------------------ dispose

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.loadingTimer);
    this.listeners.dispose();
    if (this._modalOpen) {
      this._modalOpen = false;
      try {
        this.deps.bus.emit('ui:modal', { open: false });
      } catch {
        // ignore
      }
    }
    this.modals.dispose();
    this.inspect.dispose();
    this.toolbar.dispose();
    this.hud.dispose();
    this.toasts.dispose();
    this.minimap.dispose();
    this.sfx.dispose();
    this.container.remove();
  }
}

function hasUrlParam(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).has(name);
  } catch {
    return false;
  }
}
