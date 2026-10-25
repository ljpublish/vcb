/**
 * MODULE: simulation — the city model and its tick loop.
 * Owner: simulation agent. Implements ISimulation (src/types.ts).
 *
 * STUB: an inert, empty city. Every query returns neutral values; actions are rejected.
 * Replace entirely (you may split the logic across the other files in src/sim/).
 *
 * Intended implementation (details in ARCHITECTURE.md §11 and the simulation brief):
 *  - State (struct-of-arrays, TILE_COUNT each): kind (TileKind), zone (ZoneType), flags (TILE_FLAG_*),
 *    buildingAt (Int32, 0 = none) + Map<id, Building>. Derived (recomputed, never saved):
 *    roadMask, road distance / access, road component id + "edge connected" flag, land value,
 *    pollution.
 *  - newCity({seed,name}): fresh state on deps.terrain; decor flags from terrain.hasNaturalDecor();
 *    money START_MONEY, day 0, taxes TAX_DEFAULT, speed 1; lays a free starter road from the west
 *    map edge to the centre along tz = MAP_TILES/2 (bridges over water) = the region connection.
 *  - update(dt): accumulate dt * SIM_TICKS_PER_SECOND[speed]; run ≤ MAX_TICKS_PER_FRAME ticks
 *    (drop the excess); then emit ONE 'tiles:changed' (cause 'growth') with all tiles changed during
 *    those ticks (if any) and ONE 'stats:changed'.
 *  - tick(): day++; construction progress (stage changes and completion change tiles);
 *    growth/upgrade/merge-to-2×2/abandon/decay; occupancy; demand (smoothed); month end
 *    (day % DAYS_PER_MONTH === 0): budget → money, 'sim:month', history sample, land value +
 *    pollution refresh, milestone/warning 'notify's (rate limited).
 *  - Buildings only grow on Zoned tiles with road access (road within ROAD_ACCESS_DISTANCE) whose
 *    road network is connected to the map edge OR has jobs/residents; facing = direction of the
 *    nearest adjacent road (else towards the nearest road). Every visual-relevant change
 *    (add/remove, level, size, state, stage, facing, variant) must put ALL footprint tiles in the
 *    changed set.
 *  - previewAction is pure; applyAction validates with the same code, rejects unaffordable actions
 *    entirely, applies valid tiles, emits 'tiles:changed' (cause 'tool'), 'action:applied',
 *    'stats:changed'. Invalid tiles are skipped silently.
 *  - serialize()/load(): exact round trip of CitySnapshot (deep copies; typed arrays copied).
 *    Put any extra private state you need into snapshot.extra (JSON-safe).
 */
import {
  MAP_TILES,
  TAX_DEFAULT,
  TILE_COUNT,
  TileKind,
  ZoneType,
  BASE_GROUND_HEIGHT,
  SAVE_VERSION,
  type ActionPreview,
  type ActionResult,
  type Building,
  type CitySnapshot,
  type CityStats,
  type HistorySample,
  type ISimulation,
  type RCIZone,
  type SimSpeed,
  type SimulationDeps,
  type TaxRates,
  type TileInfo,
  type ToolAction,
  CIVIC_SPECS,
  type CivicBuilding,
  type ServiceCoverage,
} from '../types';
import { inMap, tileIndex } from '../core/coords';
import { emptyStats } from './stats';

export class Simulation implements ISimulation {
  readonly mapTiles = MAP_TILES;
  private readonly deps: SimulationDeps;
  private _name = 'New City';
  private _seed = 0;
  private speed: SimSpeed = 1;
  private taxes: TaxRates = { r: TAX_DEFAULT, c: TAX_DEFAULT, i: TAX_DEFAULT };
  private stats: CityStats = emptyStats();

  constructor(deps: SimulationDeps) {
    this.deps = deps;
  }

  get name(): string {
    return this._name;
  }

  get seed(): number {
    return this._seed;
  }

  // ------------------------------------------------------------------ lifecycle

  newCity(opts: { seed: number; name: string }): void {
    this._seed = opts.seed >>> 0;
    this._name = opts.name;
    this.stats = emptyStats();
    // TODO(simulation)
  }

  load(snapshot: CitySnapshot): void {
    if (snapshot.mapTiles !== MAP_TILES) throw new Error(`Save is for a ${snapshot.mapTiles}² map, expected ${MAP_TILES}²`);
    this._seed = snapshot.seed >>> 0;
    this._name = snapshot.name;
    // TODO(simulation)
  }

  serialize(): CitySnapshot {
    // TODO(simulation)
    return {
      version: SAVE_VERSION,
      mapTiles: MAP_TILES,
      seed: this._seed,
      name: this._name,
      day: 0,
      money: this.stats.money,
      speed: this.speed,
      taxRates: { ...this.taxes },
      rngState: 0,
      nextBuildingId: 1,
      tileKind: new Uint8Array(TILE_COUNT),
      tileZone: new Uint8Array(TILE_COUNT),
      tileFlags: new Uint8Array(TILE_COUNT),
      buildings: [],
      civics: [],
      history: [],
      extra: {},
    };
  }

  update(dtSeconds: number): void {
    // TODO(simulation)
  }

  tick(count = 1): void {
    // TODO(simulation)
  }

  // ------------------------------------------------------------------ controls

  getSpeed(): SimSpeed {
    return this.speed;
  }

  setSpeed(speed: SimSpeed): void {
    if (speed === this.speed) return;
    this.speed = speed;
    this.deps.bus.emit('sim:speed', { speed });
  }

  getTaxRates(): Readonly<TaxRates> {
    return this.taxes;
  }

  setTaxRate(zone: RCIZone, percent: number): void {
    // TODO(simulation): clamp to TAX_MIN..TAX_MAX, store, emit 'stats:changed'
  }

  setName(name: string): void {
    this._name = name;
  }

  addMoney(amount: number): void {
    this.stats.money += amount;
    this.deps.bus.emit('stats:changed', { stats: this.stats });
  }

  // ------------------------------------------------------------------ actions

  previewAction(action: ToolAction): ActionPreview {
    return {
      cost: 0,
      valid: new Array<boolean>(action.type === 'civic' ? CIVIC_SPECS[action.kind].size ** 2 : action.tiles.length).fill(false),
      validCount: 0,
      affordable: true,
      reason: 'Simulation not implemented',
    };
  }

  applyAction(action: ToolAction): ActionResult {
    const result: ActionResult = { ok: false, cost: 0, applied: 0, reason: 'Simulation not implemented', changedTiles: [] };
    this.deps.bus.emit('action:applied', { action, result });
    return result;
  }

  // ------------------------------------------------------------------ CityReader

  inBounds(tx: number, tz: number): boolean {
    return inMap(tx, tz);
  }

  getTileKind(tx: number, tz: number): TileKind {
    return TileKind.Empty;
  }

  getZone(tx: number, tz: number): ZoneType {
    return ZoneType.None;
  }

  getBuildingIdAt(tx: number, tz: number): number {
    return 0;
  }

  getBuilding(id: number): Readonly<Building> | undefined {
    return undefined;
  }

  getBuildingAt(tx: number, tz: number): Readonly<Building> | undefined {
    return undefined;
  }

  forEachBuilding(cb: (b: Readonly<Building>) => void): void {
    // TODO(simulation)
  }

  getCivicAt(tx: number, tz: number): Readonly<CivicBuilding> | undefined {
    return undefined;
  }

  forEachCivic(cb: (c: Readonly<CivicBuilding>) => void): void {
    // TODO(simulation)
  }

  getCoverage(tx: number, tz: number): ServiceCoverage {
    return { police: 0, fire: 0, education: 0, health: 0 };
  }

  getRoadMask(tx: number, tz: number): number {
    return 0;
  }

  hasDecor(tx: number, tz: number): boolean {
    return false;
  }

  hasRoadAccess(tx: number, tz: number): boolean {
    return false;
  }

  getLandValue(tx: number, tz: number): number {
    return 0;
  }

  getPollution(tx: number, tz: number): number {
    return 0;
  }

  getTileInfo(tx: number, tz: number): TileInfo {
    const terrain = this.deps.terrain;
    return {
      tx,
      tz,
      index: inMap(tx, tz) ? tileIndex(tx, tz) : -1,
      kind: TileKind.Empty,
      zone: ZoneType.None,
      height: inMap(tx, tz) ? terrain.getTileHeight(tx, tz) : BASE_GROUND_HEIGHT,
      water: inMap(tx, tz) ? terrain.isWater(tx, tz) : false,
      decor: false,
      roadMask: 0,
      roadAccess: false,
      landValue: 0,
      pollution: 0,
      building: null,
      civic: null,
      coverage: this.getCoverage(tx, tz),
    };
  }

  getStats(): Readonly<CityStats> {
    return this.stats;
  }

  getHistory(): ReadonlyArray<HistorySample> {
    return [];
  }
}
