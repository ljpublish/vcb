/**
 * MODULE: buildings — keeps the voxel world in sync with the city state.
 * Owner: buildings framework. Implements IStructureSync (src/types.ts); ARCHITECTURE.md §12.
 *
 *  - 'tiles:changed' → queue each tile AND its 4 neighbours (road masks, lot borders and park paths
 *    depend on neighbours). Queue = Set<number> (dedupe).
 *  - Per tile a visual key is computed from the CityReader and cached; unchanged keys are skipped.
 *  - Non-building tile: terrain.restoreTile(), then (unless Empty) stamp the road / bridge / lot / park.
 *  - Buildings are processed per id: restore every footprint tile (no decor), stamp once at the
 *    min-corner tile, update the keys of all footprint tiles and drop them from the queue.
 *  - Emitters: Map<buildingId, Emitter[]> + park fountains per tile (buildingId 0), world coords.
 *  - Never throws from update()/flush(): per-tile try/catch with rate-limited logging.
 */
import {
  DIR_BIT,
  DIR_DX,
  DIR_DZ,
  TILE_SIZE,
  TileKind,
  type Building,
  type CityReader,
  type CivicBuilding,
  type Emitter,
  type IStructureSync,
  type ITerrain,
  type IVoxelWorld,
  type RCIZone,
  type StructureSyncDeps,
} from '../types';
import { generateBuilding, type GeneratedStructure } from './buildingGen';
import { CIVIC_SIZE, generateCivic } from './civic';
import { generatePark, generateZoneLot } from './lotGen';
import { generateRoad } from './roadGen';

const MAX_CACHED_STAMPS = 512;

export class StructureSync implements IStructureSync {
  private readonly world: IVoxelWorld;
  private readonly terrain: ITerrain;
  private readonly city: CityReader;
  private readonly queue = new Set<number>();
  private readonly offTiles: () => void;
  private n: number;
  private keys: string[];
  /** Building id whose stamp currently covers the tile (0 = none). */
  private tileBuilding: Int32Array;
  private readonly buildingEmitters = new Map<number, Emitter[]>();
  private readonly parkEmitters = new Map<number, Emitter[]>();
  private flat: Emitter[] = [];
  private flatDirty = false;
  private _emittersVersion = 0;
  private readonly stampCache = new Map<string, GeneratedStructure>();
  private errors = 0;
  private waterWarned = false;
  private disposed = false;

  constructor(deps: StructureSyncDeps) {
    this.world = deps.world;
    this.terrain = deps.terrain;
    this.city = deps.city;
    this.n = this.mapTiles();
    this.keys = new Array<string>(this.n * this.n).fill('');
    this.tileBuilding = new Int32Array(this.n * this.n);
    this.offTiles = deps.bus.on('tiles:changed', (e) => {
      if (this.disposed || !e || !e.tiles) return;
      const n = this.n;
      for (const t of e.tiles) {
        if (!(t >= 0 && t < n * n)) continue;
        this.queue.add(t);
        const tx = t % n, tz = (t / n) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = tx + DIR_DX[d], nz = tz + DIR_DZ[d];
          if (nx >= 0 && nz >= 0 && nx < n && nz < n) this.queue.add(nx + nz * n);
        }
      }
    });
  }

  get pending(): number {
    return this.queue.size;
  }

  get emittersVersion(): number {
    return this._emittersVersion;
  }

  reset(): void {
    const n = this.mapTiles();
    if (n !== this.n) {
      this.n = n;
      this.keys = new Array<string>(n * n);
      this.tileBuilding = new Int32Array(n * n);
    } else {
      this.tileBuilding.fill(0);
    }
    this.queue.clear();
    this.stampCache.clear();
    if (this.buildingEmitters.size || this.parkEmitters.size || this.flat.length) {
      this.buildingEmitters.clear();
      this.parkEmitters.clear();
      this.markEmitters();
    }
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        const i = tx + tz * n;
        this.keys[i] = `E:${this.terrain.hasNaturalDecor(tx, tz)}`;
        this.queue.add(i);
      }
    }
  }

  update(budgetMs: number): void {
    if (this.disposed || this.queue.size === 0) return;
    const end = performance.now() + (Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 0);
    for (const t of this.queue) {
      this.queue.delete(t);
      this.safeProcess(t);
      if (performance.now() >= end) break;
    }
  }

  flush(): void {
    if (this.disposed) return;
    for (const t of this.queue) {
      this.queue.delete(t);
      this.safeProcess(t);
    }
  }

  getEmitters(): readonly Emitter[] {
    if (this.flatDirty) {
      const out: Emitter[] = [];
      for (const list of this.buildingEmitters.values()) for (const e of list) out.push(e);
      for (const list of this.parkEmitters.values()) for (const e of list) out.push(e);
      this.flat = out;
      this.flatDirty = false;
    }
    return this.flat;
  }

  dispose(): void {
    this.disposed = true;
    this.offTiles();
    this.queue.clear();
    this.stampCache.clear();
    this.buildingEmitters.clear();
    this.parkEmitters.clear();
    this.flat = [];
  }

  // ------------------------------------------------------------------ internals

  private mapTiles(): number {
    const n = this.city.mapTiles | 0;
    return n > 0 ? n : this.terrain.mapTiles;
  }

  private markEmitters(): void {
    this.flatDirty = true;
    this._emittersVersion++;
  }

  private safeProcess(t: number): void {
    try {
      this.process(t);
    } catch (err) {
      if (this.errors++ < 10) console.warn('[structures] tile', t, 'failed:', err);
    }
  }

  private process(t: number): void {
    const n = this.n;
    const tx = t % n, tz = (t / n) | 0;
    const city = this.city;
    const kind = city.getTileKind(tx, tz);
    if (kind === TileKind.Zoned) {
      const b = city.getBuildingAt(tx, tz);
      if (b) {
        this.processBuilding(b);
        return;
      }
    } else if (kind === TileKind.Civic) {
      const c = city.getCivicAt(tx, tz);
      if (c) {
        this.processCivic(c);
        return;
      }
    }
    const water = this.terrain.isWater(tx, tz);
    let key: string;
    if (kind === TileKind.Road) key = `R:${city.getRoadMask(tx, tz)}:${water}`;
    else if (kind === TileKind.Zoned) key = `Z:${city.getZone(tx, tz)}:${this.zoneEdgeMask(tx, tz)}`;
    else if (kind === TileKind.Park) key = `P:${this.parkMask(tx, tz)}:${this.roadMask(tx, tz)}`;
    else key = `E:${city.hasDecor(tx, tz)}`;
    if (water && kind !== TileKind.Road && kind !== TileKind.Empty) key = 'X';
    if (this.keys[t] === key) return;

    this.releaseTile(t);
    this.keys[t] = key;
    if (key === 'X') {
      if (!this.waterWarned) {
        this.waterWarned = true;
        console.warn(`[structures] tile ${tx},${tz} is water but kind ${kind}; drawing nothing`);
      }
      this.terrain.restoreTile(this.world, tx, tz, false);
      return;
    }
    this.terrain.restoreTile(this.world, tx, tz, kind === TileKind.Empty && city.hasDecor(tx, tz));
    if (kind === TileKind.Empty) return;

    const h = this.terrain.getTileHeight(tx, tz);
    let gen: GeneratedStructure;
    if (kind === TileKind.Road) {
      const mask = city.getRoadMask(tx, tz);
      const seed = this.terrain.seed;
      gen = generateRoad({ mask, bridge: water, groundHeight: h, tx, tz, seed });
    } else if (kind === TileKind.Zoned) {
      const zone = city.getZone(tx, tz);
      if (zone !== 1 && zone !== 2 && zone !== 3) return;
      const edge = this.zoneEdgeMask(tx, tz);
      const ck = `Z:${zone}:${edge}:${h}:${(tx * 7 + tz * 13) & 3}`;
      gen = this.cached(ck, () => generateZoneLot(zone as RCIZone, edge, h, (tx * 7 + tz * 13) & 3));
    } else {
      gen = generatePark({ tx, tz, groundHeight: h, seed: this.terrain.seed, parkMask: this.parkMask(tx, tz), roadMask: this.roadMask(tx, tz) });
    }
    const ox = tx * TILE_SIZE, oz = tz * TILE_SIZE;
    this.world.applyStamp(gen.stamp, ox, gen.originY, oz);
    if (gen.emitters.length) {
      this.parkEmitters.set(t, gen.emitters.map((e) => ({ x: ox + e.x, y: gen.originY + e.y, z: oz + e.z, kind: e.kind, strength: e.strength, buildingId: 0 })));
      this.markEmitters();
    }
  }

  private processBuilding(b: Readonly<Building>): void {
    const key = `B:${b.id}:${b.level}:${b.size}:${b.facing}:${b.variant}:${b.state}:${b.stage}`;
    const size = b.size === 2 ? 2 : 1;
    this.stampFootprint(b.id, b.tx, b.tz, size, key, (h) => generateBuilding(
      { zone: b.zone, level: b.level, size, facing: b.facing, variant: b.variant, state: b.state, stage: b.stage },
      h,
    ));
  }

  private processCivic(c: Readonly<CivicBuilding>): void {
    const size = CIVIC_SIZE[c.kind] === 2 ? 2 : 1;
    const key = `C:${c.id}:${c.kind}:${c.facing}:${c.variant}`;
    this.stampFootprint(c.id, c.tx, c.tz, size, key, (h) => generateCivic({ kind: c.kind, facing: c.facing, variant: c.variant }, h));
  }

  /** Restore + stamp a multi-tile footprint once, keyed on all its tiles. */
  private stampFootprint(id: number, btx: number, btz: number, size: number, key: string, make: (h: number) => GeneratedStructure): void {
    const n = this.n;
    const b = { id, tx: btx, tz: btz };
    let same = true;
    for (let dz = 0; dz < size; dz++) {
      for (let dx = 0; dx < size; dx++) {
        const i = b.tx + dx + (b.tz + dz) * n;
        this.queue.delete(i);
        if (this.keys[i] !== key) same = false;
      }
    }
    if (same) return;
    for (let dz = 0; dz < size; dz++) {
      for (let dx = 0; dx < size; dx++) {
        const tx = b.tx + dx, tz = b.tz + dz;
        if (tx >= n || tz >= n) continue;
        const i = tx + tz * n;
        this.releaseTile(i);
        this.terrain.restoreTile(this.world, tx, tz, false);
        this.keys[i] = key;
        this.tileBuilding[i] = b.id;
      }
    }
    const gen = make(this.terrain.getTileHeight(b.tx, b.tz));
    const ox = b.tx * TILE_SIZE, oz = b.tz * TILE_SIZE;
    this.world.applyStamp(gen.stamp, ox, gen.originY, oz);
    const had = this.buildingEmitters.delete(b.id);
    if (gen.emitters.length) {
      this.buildingEmitters.set(b.id, gen.emitters.map((e) => ({ x: ox + e.x, y: gen.originY + e.y, z: oz + e.z, kind: e.kind, strength: e.strength, buildingId: b.id })));
    }
    if (had || gen.emitters.length) this.markEmitters();
  }

  /** The tile is about to be restamped: drop emitters of whatever covered it before. */
  private releaseTile(i: number): void {
    const prev = this.tileBuilding[i];
    if (prev) {
      this.tileBuilding[i] = 0;
      const tx = i % this.n, tz = (i / this.n) | 0;
      const now = this.city.getBuildingIdAt(tx, tz) || (this.city.getCivicAt(tx, tz)?.id ?? 0);
      if (now !== prev && this.buildingEmitters.delete(prev)) this.markEmitters();
    }
    if (this.parkEmitters.delete(i)) this.markEmitters();
  }

  private zoneEdgeMask(tx: number, tz: number): number {
    const city = this.city;
    const zone = city.getZone(tx, tz);
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const nx = tx + DIR_DX[d], nz = tz + DIR_DZ[d];
      if (!city.inBounds(nx, nz) || city.getTileKind(nx, nz) !== TileKind.Zoned || city.getZone(nx, nz) !== zone) m |= DIR_BIT[d];
    }
    return m;
  }

  private parkMask(tx: number, tz: number): number {
    return this.kindMask(tx, tz, TileKind.Park);
  }

  private roadMask(tx: number, tz: number): number {
    return this.kindMask(tx, tz, TileKind.Road);
  }

  private kindMask(tx: number, tz: number, kind: number): number {
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const nx = tx + DIR_DX[d], nz = tz + DIR_DZ[d];
      if (this.city.inBounds(nx, nz) && this.city.getTileKind(nx, nz) === kind) m |= DIR_BIT[d];
    }
    return m;
  }

  private cached(key: string, make: () => GeneratedStructure): GeneratedStructure {
    let g = this.stampCache.get(key);
    if (!g) {
      if (this.stampCache.size >= MAX_CACHED_STAMPS) this.stampCache.clear();
      g = make();
      this.stampCache.set(key, g);
    }
    return g;
  }
}
