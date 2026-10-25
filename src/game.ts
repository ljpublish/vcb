/**
 * INTEGRATOR-OWNED — composition root + game controller (IGameController).
 * Module agents MUST NOT edit this file. It is the only place that instantiates concrete classes.
 *
 * Responsibilities:
 *  - construct every module with its deps (all wired through interfaces from src/types.ts),
 *  - own the frame loop (fixed order, see ARCHITECTURE.md §18) with per-module error guards,
 *  - orchestrate "new city" / "load" / "import" (terrain → sim → world → structures → meshes),
 *  - expose a debug handle on window.__vcb (see main.ts).
 */
import {
  AUTOSAVE_INTERVAL_MS,
  AUTOSAVE_SLOT,
  BASE_GROUND_HEIGHT,
  MAP_TILES,
  QUICKSAVE_SLOT,
  WATER_LEVEL,
  type BlockId,
  type DebugInfo,
  type GameBus,
  type IChunkMeshManager,
  type ICameraRig,
  type IEffects,
  type IGameController,
  type IGameUI,
  type ISaveManager,
  type ISceneContext,
  type ISimulation,
  type IStructureSync,
  type ITerrain,
  type IToolController,
  type IVoxelWorld,
  type SavePayload,
  type SaveResult,
  type SaveSlotInfo,
} from './types';
import { createGameBus } from './core/events';
import { randomSeed } from './core/rng';
import { errorMessage, nextFrame, randomCityName } from './core/util';
import { B } from './voxel/blocks';
import { VoxelWorld } from './voxel/world';
import { Terrain } from './voxel/terrain';
import { ChunkMeshManager } from './mesh/chunkMeshManager';
import { Simulation } from './sim/simulation';
import { StructureSync } from './build/structureSync';
import { createSceneContext } from './render/scene';
import { CameraRig } from './input/cameraRig';
import { ToolController } from './input/toolController';
import { Effects } from './fx/effects';
import { SaveManager } from './persist/saveManager';
import { GameUI } from './ui/gameUI';

/** Max ms per frame spent stamping structures into the voxel world. */
const STRUCTURE_BUDGET_MS = 4;
/** Clamp for frame delta time (s) — e.g. after the tab was hidden. */
const MAX_FRAME_DT = 0.1;
/** Max time to wait for the initial meshing pass behind the loading overlay. */
const MESH_WAIT_MS = 12_000;

/**
 * Stable ITerrain handed to every module at construction. Delegates to the current city's Terrain
 * (replaced on new city / load). Before the first city exists it reports a flat, dry plain.
 */
export class TerrainProxy implements ITerrain {
  private current: ITerrain | null = null;

  set(terrain: ITerrain): void {
    this.current = terrain;
  }

  get target(): ITerrain | null {
    return this.current;
  }

  get seed(): number {
    return this.current ? this.current.seed : 0;
  }

  get mapTiles(): number {
    return this.current ? this.current.mapTiles : MAP_TILES;
  }

  getTileHeight(tx: number, tz: number): number {
    return this.current ? this.current.getTileHeight(tx, tz) : BASE_GROUND_HEIGHT;
  }

  getSurfaceHeight(tx: number, tz: number): number {
    return this.current ? this.current.getSurfaceHeight(tx, tz) : Math.max(BASE_GROUND_HEIGHT, WATER_LEVEL);
  }

  isWater(tx: number, tz: number): boolean {
    return this.current ? this.current.isWater(tx, tz) : false;
  }

  hasNaturalDecor(tx: number, tz: number): boolean {
    return this.current ? this.current.hasNaturalDecor(tx, tz) : false;
  }

  getGroundBlock(tx: number, tz: number): BlockId {
    return this.current ? this.current.getGroundBlock(tx, tz) : B.GRASS;
  }

  generateInto(world: IVoxelWorld): void {
    this.current?.generateInto(world);
  }

  restoreTile(world: IVoxelWorld, tx: number, tz: number, withDecor: boolean): void {
    this.current?.restoreTile(world, tx, tz, withDecor);
  }
}

export interface GameOptions {
  /** Element that receives the WebGL canvas (#viewport). */
  viewport: HTMLElement;
  /** DOM UI overlay root (#ui). */
  uiRoot: HTMLElement;
}

function getStorage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__vcb_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export class Game implements IGameController {
  readonly bus: GameBus = createGameBus();
  readonly terrain = new TerrainProxy();
  readonly view: ISceneContext;
  readonly world: IVoxelWorld;
  readonly meshes: IChunkMeshManager;
  readonly sim: ISimulation;
  readonly structures: IStructureSync;
  readonly rig: ICameraRig;
  readonly tools: IToolController;
  readonly fx: IEffects;
  readonly saves: ISaveManager;
  readonly ui: IGameUI;

  private _busy = false;
  private modalOpen = false;
  private running = false;
  private lastFrame = -1;
  private fps = 0;
  private frameMs = 0;
  private simMs = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private readonly errorCounts = new Map<string, number>();

  constructor(opts: GameOptions) {
    this.view = createSceneContext(opts.viewport);
    this.world = new VoxelWorld();
    this.meshes = new ChunkMeshManager({ world: this.world, parent: this.view.worldRoot });
    this.sim = new Simulation({ bus: this.bus, terrain: this.terrain });
    this.structures = new StructureSync({ world: this.world, terrain: this.terrain, city: this.sim, bus: this.bus });
    this.rig = new CameraRig({ camera: this.view.camera, dom: this.view.canvas, terrain: this.terrain });
    this.tools = new ToolController({
      camera: this.view.camera,
      dom: this.view.canvas,
      overlayRoot: this.view.overlayRoot,
      sim: this.sim,
      terrain: this.terrain,
      bus: this.bus,
    });
    this.fx = new Effects({
      root: this.view.fxRoot,
      city: this.sim,
      terrain: this.terrain,
      structures: this.structures,
      view: this.view,
      bus: this.bus,
    });
    this.saves = new SaveManager({ storage: getStorage(), bus: this.bus });
    this.ui = new GameUI({
      root: opts.uiRoot,
      bus: this.bus,
      sim: this.sim,
      terrain: this.terrain,
      tools: this.tools,
      camera: this.rig,
      view: this.view,
      fx: this.fx,
      game: this,
    });

    this.bus.on('ui:modal', ({ open }) => {
      this.modalOpen = open;
      this.syncInputEnabled();
    });
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Starts the frame loop, then resumes the autosave (unless ?fresh or ?seed=N is in the URL) or
   * generates a new city, then starts autosaving.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.frame);

    const params = new URLSearchParams(window.location.search);
    const seedParam = params.get('seed');
    const fresh = params.has('fresh') || seedParam !== null;

    let loaded = false;
    if (!fresh && this.saves.has(AUTOSAVE_SLOT)) {
      const payload = this.saves.load(AUTOSAVE_SLOT);
      if (payload) loaded = await this.applyPayload(payload, true);
    }
    if (!loaded) {
      const seed = seedParam !== null && seedParam.trim() !== '' && Number.isFinite(Number(seedParam)) ? Number(seedParam) >>> 0 : undefined;
      await this.newCity({ seed });
    }
    this.saves.startAutosave(() => (this._busy ? null : this.makePayload()), AUTOSAVE_INTERVAL_MS);
  }

  /** Stops the loop and disposes every module (used by tests / hot reload). */
  dispose(): void {
    this.running = false;
    this.saves.dispose();
    this.ui.dispose();
    this.fx.dispose();
    this.tools.dispose();
    this.rig.dispose();
    this.structures.dispose();
    this.meshes.dispose();
    this.view.dispose();
    this.bus.clear();
  }

  get busy(): boolean {
    return this._busy;
  }

  // ------------------------------------------------------------------ IGameController

  async newCity(opts: { seed?: number; name?: string } = {}): Promise<void> {
    if (this._busy) return;
    this.setBusy(true);
    try {
      this.ui.showLoading('Generating terrain…');
      await nextFrame();
      await nextFrame();
      const seed = (opts.seed ?? randomSeed()) >>> 0;
      const name = opts.name && opts.name.trim() !== '' ? opts.name.trim() : randomCityName(seed);

      const terrain = new Terrain(seed, MAP_TILES);
      this.terrain.set(terrain);
      this.sim.newCity({ seed, name });
      this.world.clear();
      terrain.generateInto(this.world);

      this.ui.showLoading('Laying out the city…');
      await nextFrame();
      this.structures.reset();
      this.structures.flush();
      this.meshes.rebuildAll();
      this.fx.reset();
      this.rig.reset(true);
      this.tools.setTool('select');

      this.ui.showLoading('Building voxels…');
      await this.waitForMeshes(MESH_WAIT_MS);
      this.bus.emit('city:loaded', { seed, name, source: 'new' });
    } catch (err) {
      console.error('[game] newCity failed', err);
      this.bus.emit('notify', { kind: 'error', message: `Could not create a city: ${errorMessage(err)}` });
    } finally {
      this.ui.showLoading(null);
      this.setBusy(false);
    }
  }

  saveGame(slot: string = QUICKSAVE_SLOT): SaveResult {
    if (this._busy) return { ok: false, bytes: 0, error: 'Busy' };
    let res: SaveResult;
    try {
      res = this.saves.save(slot, this.makePayload());
    } catch (err) {
      res = { ok: false, bytes: 0, error: errorMessage(err) };
    }
    this.bus.emit(
      'notify',
      res.ok
        ? { kind: 'success', message: `Saved "${this.sim.name}"` }
        : { kind: 'error', message: `Save failed: ${res.error ?? 'unknown error'}` },
    );
    return res;
  }

  async loadGame(slot: string): Promise<boolean> {
    if (this._busy) return false;
    const payload = this.saves.load(slot);
    if (!payload) {
      this.bus.emit('notify', { kind: 'error', message: `Save "${slot}" is missing or corrupt` });
      return false;
    }
    return this.applyPayload(payload, false);
  }

  listSaves(): SaveSlotInfo[] {
    return this.saves.list();
  }

  deleteSave(slot: string): void {
    this.saves.remove(slot);
  }

  exportSave(): string | null {
    if (this._busy) return null;
    try {
      return this.saves.exportString(this.makePayload());
    } catch (err) {
      console.error('[game] export failed', err);
      return null;
    }
  }

  async importSave(text: string): Promise<boolean> {
    if (this._busy) return false;
    const payload = this.saves.importString(text);
    if (!payload) {
      this.bus.emit('notify', { kind: 'error', message: 'That does not look like a valid city save' });
      return false;
    }
    return this.applyPayload(payload, false);
  }

  getDebugInfo(): DebugInfo {
    const info = this.view.renderer.info;
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      simMs: this.simMs,
      structuresPending: this.structures.pending,
      mesh: this.meshes.getStats(),
    };
  }

  // ------------------------------------------------------------------ internals

  /** Current state as a save payload. */
  makePayload(): SavePayload {
    return { city: this.sim.serialize(), camera: this.rig.getState() };
  }

  /**
   * Replace the running city with `payload`. On failure the previous city is restored (or a new
   * city generated if there was none). Returns true on success.
   */
  private async applyPayload(payload: SavePayload, silent: boolean, isRestore = false): Promise<boolean> {
    if (this._busy) return false;
    const previous = this.terrain.target ? this.safeMakePayload() : null;
    this.setBusy(true);
    let ok = false;
    try {
      const snap = payload.city;
      if (snap.mapTiles !== MAP_TILES) throw new Error(`save uses a ${snap.mapTiles}×${snap.mapTiles} map (expected ${MAP_TILES})`);
      this.ui.showLoading(`Loading ${snap.name}…`);
      await nextFrame();
      await nextFrame();

      const terrain = new Terrain(snap.seed >>> 0, MAP_TILES);
      this.terrain.set(terrain);
      this.sim.load(snap); // throws on incompatible data, before the world is touched
      this.world.clear();
      terrain.generateInto(this.world);

      this.ui.showLoading('Rebuilding the city…');
      await nextFrame();
      this.structures.reset();
      this.structures.flush();
      this.meshes.rebuildAll();
      this.fx.reset();
      if (payload.camera) this.rig.setState(payload.camera, true);
      else this.rig.reset(true);
      this.tools.setTool('select');

      this.ui.showLoading('Building voxels…');
      await this.waitForMeshes(MESH_WAIT_MS);
      this.bus.emit('city:loaded', { seed: snap.seed, name: snap.name, source: 'load' });
      if (!silent) this.bus.emit('notify', { kind: 'success', message: `Loaded "${snap.name}"` });
      ok = true;
    } catch (err) {
      console.error('[game] load failed', err);
      this.bus.emit('notify', { kind: 'error', message: `Could not load the city: ${errorMessage(err)}` });
    } finally {
      this.ui.showLoading(null);
      this.setBusy(false);
    }
    if (!ok && !isRestore) {
      if (previous) await this.applyPayload(previous, true, true);
      else if (!silent) await this.newCity();
    }
    return ok;
  }

  private safeMakePayload(): SavePayload | null {
    try {
      return this.makePayload();
    } catch {
      return null;
    }
  }

  private async waitForMeshes(timeoutMs: number): Promise<void> {
    const t0 = performance.now();
    // Give the mesh manager a couple of frames to pick up the dirty chunks first.
    await nextFrame();
    await nextFrame();
    while (!this.meshes.idle && performance.now() - t0 < timeoutMs) await nextFrame();
  }

  private setBusy(busy: boolean): void {
    this._busy = busy;
    this.syncInputEnabled();
  }

  private syncInputEnabled(): void {
    const enabled = !this._busy && !this.modalOpen;
    this.rig.enabled = enabled;
    this.tools.enabled = enabled;
    if (!enabled) this.tools.cancel();
  }

  /** Runs fn, logging (rate-limited) instead of letting one module kill the frame. */
  private guard(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const n = (this.errorCounts.get(name) ?? 0) + 1;
      this.errorCounts.set(name, n);
      if (n <= 3) console.error(`[game] ${name} threw (occurrence ${n}):`, err);
      else if (n === 4) console.error(`[game] ${name} keeps throwing; further errors suppressed`);
    }
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    const dt = this.lastFrame < 0 ? 0 : Math.min(MAX_FRAME_DT, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const t0 = performance.now();

    this.guard('camera', () => this.rig.update(dt));
    if (!this._busy) {
      const s0 = performance.now();
      this.guard('sim', () => this.sim.update(dt));
      this.simMs = performance.now() - s0;
      this.guard('structures', () => this.structures.update(STRUCTURE_BUDGET_MS));
    }
    const focus = this.rig.getFocus();
    this.guard('meshes', () => this.meshes.update(this.view.camera, focus));
    this.guard('tools', () => this.tools.update(dt));
    this.guard('fx', () => this.fx.update(dt, this.view.camera));
    this.guard('view', () => this.view.update(dt, focus));
    this.guard('ui', () => this.ui.update(dt));
    this.guard('render', () => this.view.render());

    this.frameMs = performance.now() - t0;
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  };
}
