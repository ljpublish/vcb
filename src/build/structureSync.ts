/**
 * MODULE: buildings — keeps the voxel world in sync with the city state.
 * Owner: buildings agent. Implements IStructureSync (src/types.ts).
 *
 * STUB: subscribes to 'tiles:changed' and counts pending tiles, but stamps nothing. Replace entirely.
 *
 * Intended implementation:
 *  - constructor: subscribe to bus 'tiles:changed' → enqueue each tile AND its 4 neighbours
 *    (road masks, lot borders and park paths depend on neighbours). Queue = Set<number> (dedupe).
 *  - Per tile, compute a "visual key" from the CityReader (e.g. `R:${mask}:${bridge}`,
 *    `Z:${zone}:${edgeMask}`, `B:${id}:${level}:${size}:${facing}:${variant}:${state}:${stage}`,
 *    `P:${parkMask}:${roadMask}`, `E:${decor}`). Skip the tile when the key equals the cached key.
 *  - Restamp a non-building tile: terrain.restoreTile(world, tx, tz, decor) (natural state, clears
 *    everything above), then — unless Empty — world.applyStamp(generated.stamp, tx*8, originY, tz*8)
 *    using roadGen / lotGen. Bridges: restore first (brings back water), then stamp the bridge.
 *  - Buildings: process per building id (a 2×2 building is stamped ONCE for its whole footprint):
 *    restore all footprint tiles without decor, then stamp generateBuilding(spec, h) at the min
 *    corner. Update the cached key of every footprint tile. Tiles of a removed building simply get
 *    their new key (lot / empty) and are restamped as such.
 *  - Emitters: keep Map<buildingId, Emitter[]> (world coords = local + stamp origin); rebuild the flat
 *    list lazily and bump emittersVersion whenever it changes; drop entries for removed buildings.
 *  - reset(): clear caches/emitters; set every tile's cached key to the "natural" key
 *    (`E:${terrain.hasNaturalDecor}`) — the world was just regenerated — then queue all tiles;
 *    tiles that are still natural are skipped cheaply.
 *  - update(budgetMs): process queued tiles until performance.now() exceeds the budget (always at
 *    least one). flush(): everything.
 *  - Guard against tiles whose terrain is water + non-road kinds (draw nothing, log once).
 * Performance: a typical restamp (8×8×≤40 voxels + restore) ≤ 0.3 ms; full 64×64 city flush ≤ 1.5 s.
 */
import {
  TILE_COUNT,
  type Emitter,
  type IStructureSync,
  type StructureSyncDeps,
} from '../types';

export class StructureSync implements IStructureSync {
  private readonly deps: StructureSyncDeps;
  private readonly queue = new Set<number>();
  private readonly offTiles: () => void;
  private _emittersVersion = 0;

  constructor(deps: StructureSyncDeps) {
    this.deps = deps;
    this.offTiles = deps.bus.on('tiles:changed', (e) => {
      for (const t of e.tiles) this.queue.add(t);
    });
  }

  get pending(): number {
    return this.queue.size;
  }

  get emittersVersion(): number {
    return this._emittersVersion;
  }

  reset(): void {
    this.queue.clear();
    for (let i = 0; i < TILE_COUNT; i++) this.queue.add(i);
    // TODO(buildings)
  }

  update(budgetMs: number): void {
    // TODO(buildings): stamp queued tiles within budget.
    this.queue.clear();
  }

  flush(): void {
    // TODO(buildings)
    this.queue.clear();
  }

  getEmitters(): readonly Emitter[] {
    return [];
  }

  dispose(): void {
    this.offTiles();
    this.queue.clear();
  }
}
