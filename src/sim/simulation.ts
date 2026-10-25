/**
 * MODULE: simulation — the city model and its tick loop.
 * Owner: simulation agent. Implements ISimulation (src/types.ts).
 *
 * Layout:
 *  - cityState.ts : CityState (persisted struct-of-arrays + derived fields + scratch)
 *  - roads.ts     : road masks, road distance, components / edge connection, connected distance
 *  - economy.ts   : aggregates, demand, happiness, land value, pollution, budget, stats
 *  - growth.ts    : construction, occupancy, upgrades, merges, abandonment, spawning
 *  - actions.ts   : tool action validation / application (preview is pure)
 *  - civics.ts    : civic service buildings (placement rules, coverage fields, upkeep)
 *
 * Notes for consumers:
 *  - getStats() returns a STABLE object that is updated in place (also the payload of
 *    'stats:changed'). Copy the fields you want to compare across updates.
 *  - getHistory() returns the live (read-only) history array.
 *  - getCoverage() returns a scratch object that is overwritten by the next call (allocation-free);
 *    getTileInfo().coverage is a fresh copy.
 *  - forEachBuilding iterates in a deterministic order (creation order, preserved by save/load).
 *  - Determinism: everything that influences the future is in the snapshot (incl. extra.sim:
 *    smoothed demand/happiness, decline counters, quantised land value / pollution, notify timers).
 */
import {
  BASE_GROUND_HEIGHT,
  CIVIC_SPECS,
  BuildingState,
  DAYS_PER_MONTH,
  MAP_TILES,
  MAX_TICKS_PER_FRAME,
  SAVE_VERSION,
  SIM_TICKS_PER_SECOND,
  START_MONEY,
  TAX_DEFAULT,
  TAX_MAX,
  TAX_MIN,
  TILE_COUNT,
  TILE_FLAG_DECOR,
  TileKind,
  ZoneType,
  type ActionPreview,
  type ActionResult,
  type Building,
  type BudgetReport,
  type CivicBuilding,
  type ServiceCoverage,
  type CitySnapshot,
  type CityStats,
  type HistorySample,
  type ISimulation,
  type NotifyKind,
  type RCI,
  type RCIZone,
  type SimSpeed,
  type SimulationDeps,
  type TaxRates,
  type TileInfo,
  type ToolAction,
} from '../types';
import { inMap } from '../core/coords';
import { Rng } from '../core/rng';
import { CityState, defaultPrivate, type BuildingCounters, type SimPrivate } from './cityState';
import { recomputeRoads } from './roads';
import {
  computeAggregates,
  computeDemand,
  computeStats,
  computeTileTotals,
  emptyAggregates,
  emptyTileTotals,
  monthlyBudget,
  recomputeFields,
  recomputeStaticLandValue,
  targetHappiness,
  type TileTotals,
} from './economy';
import { growthTick } from './growth';
import { applyAction as applyActionImpl, previewAction as previewActionImpl } from './actions';
import { emptyBudget, emptyStats } from './stats';
import { isCivicKind, recomputeCoverage } from './civics';

const DEMAND_EMA = 0.05;
const HAPPINESS_EMA = 0.05;
const HISTORY_MAX = 240;
const NOTIFY_COOLDOWN_DAYS = 180;
const MILESTONES = [100, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000];
const MAX_NAME = 32;

// ------------------------------------------------------------------ helpers

function bytesToB64(a: Uint8Array): string {
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}

function b64ToBytes(s: unknown, len: number): Uint8Array | null {
  if (typeof s !== 'string') return null;
  try {
    const bin = atob(s);
    if (bin.length !== len) return null;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function cloneBuilding(b: Readonly<Building>): Building {
  return {
    id: b.id,
    zone: b.zone,
    level: b.level,
    tx: b.tx,
    tz: b.tz,
    size: b.size,
    facing: b.facing,
    variant: b.variant,
    state: b.state,
    stage: b.stage,
    stateDays: b.stateDays,
    occupants: b.occupants,
    capacity: b.capacity,
    builtDay: b.builtDay,
  };
}

function cloneCivic(c: Readonly<CivicBuilding>): CivicBuilding {
  return { id: c.id, kind: c.kind, tx: c.tx, tz: c.tz, facing: c.facing, variant: c.variant, builtDay: c.builtDay };
}

function cloneSample(h: Readonly<HistorySample>): HistorySample {
  return { day: h.day, population: h.population, money: h.money, jobs: h.jobs, demand: { r: h.demand.r, c: h.demand.c, i: h.demand.i } };
}

function parseBudget(v: unknown): BudgetReport | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const t = o.taxes as Record<string, unknown> | undefined;
  if (!t || !isNum(t.r) || !isNum(t.c) || !isNum(t.i)) return null;
  for (const k of ['other', 'roadUpkeep', 'parkUpkeep', 'income', 'expenses', 'net']) if (!isNum(o[k])) return null;
  return {
    taxes: { r: t.r, c: t.c, i: t.i },
    other: o.other as number,
    roadUpkeep: o.roadUpkeep as number,
    parkUpkeep: o.parkUpkeep as number,
    serviceUpkeep: isNum(o.serviceUpkeep) ? o.serviceUpkeep : 0,
    income: o.income as number,
    expenses: o.expenses as number,
    net: o.net as number,
  };
}

function parseRCI(v: unknown): RCI | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return isNum(o.r) && isNum(o.c) && isNum(o.i) ? { r: o.r, c: o.c, i: o.i } : null;
}

// ------------------------------------------------------------------ Simulation

export class Simulation implements ISimulation {
  readonly mapTiles = MAP_TILES;
  private readonly deps: SimulationDeps;
  private state = new CityState();
  private readonly agg = emptyAggregates();
  private readonly totals: TileTotals = emptyTileTotals();
  private readonly coverageScratch: ServiceCoverage = { police: 0, fire: 0, education: 0, health: 0 };
  private readonly stats: CityStats = emptyStats();
  private readonly projected: BudgetReport = emptyBudget();
  private readonly demandTarget: RCI = { r: 0, c: 0, i: 0 };
  private readonly changed = new Set<number>();
  private acc = 0;

  constructor(deps: SimulationDeps) {
    this.deps = deps;
  }

  get name(): string {
    return this.state.name;
  }

  get seed(): number {
    return this.state.seed;
  }

  // ------------------------------------------------------------------ lifecycle

  newCity(opts: { seed: number; name: string }): void {
    const terrain = this.deps.terrain;
    const s = new CityState();
    s.seed = opts.seed >>> 0;
    s.name = this.cleanName(opts.name) ?? 'New City';
    s.day = 0;
    s.money = START_MONEY;
    s.speed = 1;
    s.taxRates = { r: TAX_DEFAULT, c: TAX_DEFAULT, i: TAX_DEFAULT };
    s.rng = new Rng(s.seed ^ 0x5eed5);
    s.nextBuildingId = 1;
    for (let tz = 0; tz < MAP_TILES; tz++)
      for (let tx = 0; tx < MAP_TILES; tx++) if (terrain.hasNaturalDecor(tx, tz)) s.flags[tz * MAP_TILES + tx] = TILE_FLAG_DECOR;
    // free starter road: west edge → centre (region connection)
    const rz = MAP_TILES / 2;
    for (let tx = 0; tx <= MAP_TILES / 2; tx++) {
      const i = rz * MAP_TILES + tx;
      s.kind[i] = TileKind.Road;
      s.flags[i] &= ~TILE_FLAG_DECOR;
    }
    s.priv = defaultPrivate();
    this.state = s;
    this.acc = 0;
    this.rebuildDerived(true);
    // start with the demand the city actually has (no slow ramp from 0)
    computeAggregates(s, this.agg);
    computeDemand(s, this.agg, s.priv.happiness, s.priv.demand);
    this.refreshStats();
    this.deps.bus.emit('sim:speed', { speed: s.speed });
    this.deps.bus.emit('stats:changed', { stats: this.stats });
  }

  load(snapshot: CitySnapshot): void {
    const s = this.validateAndBuild(snapshot); // throws before touching anything
    this.state = s;
    this.acc = 0;
    const fieldsOk = this.restoreFields(snapshot.extra);
    this.rebuildDerived(!fieldsOk);
    this.refreshStats();
    this.deps.bus.emit('sim:speed', { speed: s.speed });
    this.deps.bus.emit('stats:changed', { stats: this.stats });
  }

  serialize(): CitySnapshot {
    const s = this.state;
    const counters: number[] = [];
    for (const [id, c] of s.counters) {
      if (c.noAccess === 0 && c.badDemand === 0 && c.polluted === 0) continue;
      counters.push(id, c.noAccess, c.badDemand, c.polluted);
    }
    const extra: Record<string, unknown> = cloneJson(s.extraOther);
    extra.sim = {
      priv: cloneJson(s.priv),
      counters,
      lv: bytesToB64(s.landValue),
      pol: bytesToB64(s.pollution),
    };
    const buildings: Building[] = [];
    for (const b of s.buildings.values()) buildings.push(cloneBuilding(b));
    const civics: CivicBuilding[] = [];
    for (const c of s.civics.values()) civics.push(cloneCivic(c));
    return {
      version: SAVE_VERSION,
      mapTiles: MAP_TILES,
      seed: s.seed,
      name: s.name,
      day: s.day,
      money: s.money,
      speed: s.speed,
      taxRates: { r: s.taxRates.r, c: s.taxRates.c, i: s.taxRates.i },
      rngState: s.rng.state >>> 0,
      nextBuildingId: s.nextBuildingId,
      tileKind: s.kind.slice(),
      tileZone: s.zone.slice(),
      tileFlags: s.flags.slice(),
      buildings,
      civics,
      history: s.history.map(cloneSample),
      extra,
    };
  }

  update(dtSeconds: number): void {
    try {
      if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds)) return;
      const rate = SIM_TICKS_PER_SECOND[this.state.speed] ?? 0;
      if (rate <= 0) return;
      this.acc += dtSeconds * rate;
      let n = Math.floor(this.acc);
      if (n <= 0) return;
      this.acc -= n;
      if (n > MAX_TICKS_PER_FRAME) {
        n = MAX_TICKS_PER_FRAME;
        this.acc = 0;
      }
      this.runTicks(n);
    } catch (err) {
      console.error('[sim] update failed', err);
    }
  }

  tick(count = 1): void {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n === 0) return;
    this.runTicks(n);
  }

  // ------------------------------------------------------------------ controls

  getSpeed(): SimSpeed {
    return this.state.speed;
  }

  setSpeed(speed: SimSpeed): void {
    if (speed !== 0 && speed !== 1 && speed !== 2 && speed !== 3) return;
    if (speed === this.state.speed) return;
    this.state.speed = speed;
    this.deps.bus.emit('sim:speed', { speed });
  }

  getTaxRates(): Readonly<TaxRates> {
    return this.state.taxRates;
  }

  setTaxRate(zone: RCIZone, percent: number): void {
    if (!Number.isFinite(percent)) return;
    const v = Math.round(Math.min(TAX_MAX, Math.max(TAX_MIN, percent)));
    const t = this.state.taxRates;
    if (zone === ZoneType.Residential) t.r = v;
    else if (zone === ZoneType.Commercial) t.c = v;
    else if (zone === ZoneType.Industrial) t.i = v;
    else return;
    this.refreshStats();
    this.deps.bus.emit('stats:changed', { stats: this.stats });
  }

  setName(name: string): void {
    const n = this.cleanName(name);
    if (n === null) return;
    this.state.name = n;
    this.deps.bus.emit('stats:changed', { stats: this.stats });
  }

  addMoney(amount: number): void {
    if (!Number.isFinite(amount)) return;
    this.state.money += amount;
    this.refreshStats();
    this.deps.bus.emit('stats:changed', { stats: this.stats });
  }

  // ------------------------------------------------------------------ actions

  previewAction(action: ToolAction): ActionPreview {
    try {
      return previewActionImpl(this.state, this.deps.terrain, action);
    } catch (err) {
      console.error('[sim] previewAction failed', err);
      const tiles = (action as { tiles?: unknown } | undefined)?.tiles;
      const n = Array.isArray(tiles) ? tiles.length : 0;
      return { cost: 0, valid: new Array<boolean>(n).fill(false), validCount: 0, affordable: false, reason: 'Invalid action' };
    }
  }

  applyAction(action: ToolAction): ActionResult {
    const bus = this.deps.bus;
    const changed = this.changed;
    changed.clear();
    let result: ActionResult;
    try {
      result = applyActionImpl(this.state, this.deps.terrain, action, changed);
    } catch (err) {
      console.error('[sim] applyAction failed', err);
      result = { ok: false, cost: 0, applied: 0, reason: 'Invalid action', changedTiles: [] };
    }
    if (result.ok) {
      this.rebuildDerived(true);
      this.refreshStats();
      bus.emit('tiles:changed', { tiles: result.changedTiles, cause: 'tool' });
    }
    bus.emit('action:applied', { action, result });
    bus.emit('stats:changed', { stats: this.stats });
    return result;
  }

  // ------------------------------------------------------------------ CityReader

  inBounds(tx: number, tz: number): boolean {
    return inMap(tx, tz);
  }

  private idx(tx: number, tz: number): number {
    return tx >= 0 && tz >= 0 && tx < MAP_TILES && tz < MAP_TILES && (tx | 0) === tx && (tz | 0) === tz ? tz * MAP_TILES + tx : -1;
  }

  getTileKind(tx: number, tz: number): TileKind {
    const i = this.idx(tx, tz);
    return i < 0 ? TileKind.Empty : (this.state.kind[i] as TileKind);
  }

  getZone(tx: number, tz: number): ZoneType {
    const i = this.idx(tx, tz);
    return i < 0 ? ZoneType.None : (this.state.zone[i] as ZoneType);
  }

  getBuildingIdAt(tx: number, tz: number): number {
    const i = this.idx(tx, tz);
    return i < 0 ? 0 : this.state.buildingAt[i];
  }

  getBuilding(id: number): Readonly<Building> | undefined {
    return this.state.buildings.get(id);
  }

  getBuildingAt(tx: number, tz: number): Readonly<Building> | undefined {
    const id = this.getBuildingIdAt(tx, tz);
    return id === 0 ? undefined : this.state.buildings.get(id);
  }

  forEachBuilding(cb: (b: Readonly<Building>) => void): void {
    for (const b of this.state.buildings.values()) cb(b);
  }

  getCivicAt(tx: number, tz: number): Readonly<CivicBuilding> | undefined {
    const i = this.idx(tx, tz);
    const id = i < 0 ? 0 : this.state.civicAt[i];
    return id === 0 ? undefined : this.state.civics.get(id);
  }

  forEachCivic(cb: (c: Readonly<CivicBuilding>) => void): void {
    for (const c of this.state.civics.values()) cb(c);
  }

  getCoverage(tx: number, tz: number): ServiceCoverage {
    const o = this.coverageScratch;
    const i = this.idx(tx, tz);
    const s = this.state;
    o.police = i < 0 ? 0 : s.covPolice[i] / 255;
    o.fire = i < 0 ? 0 : s.covFire[i] / 255;
    o.education = i < 0 ? 0 : s.covEducation[i] / 255;
    o.health = i < 0 ? 0 : s.covHealth[i] / 255;
    return o;
  }

  getRoadMask(tx: number, tz: number): number {
    const i = this.idx(tx, tz);
    return i < 0 ? 0 : this.state.roadMask[i];
  }

  hasDecor(tx: number, tz: number): boolean {
    const i = this.idx(tx, tz);
    return i >= 0 && (this.state.flags[i] & TILE_FLAG_DECOR) !== 0;
  }

  hasRoadAccess(tx: number, tz: number): boolean {
    const i = this.idx(tx, tz);
    return i >= 0 && this.state.roadDist[i] <= 3;
  }

  getLandValue(tx: number, tz: number): number {
    const i = this.idx(tx, tz);
    return i < 0 ? 0 : this.state.landValue[i] / 255;
  }

  getPollution(tx: number, tz: number): number {
    const i = this.idx(tx, tz);
    return i < 0 ? 0 : this.state.pollution[i] / 255;
  }

  getTileInfo(tx: number, tz: number): TileInfo {
    const terrain = this.deps.terrain;
    const i = this.idx(tx, tz);
    const inside = i >= 0;
    return {
      tx,
      tz,
      index: i,
      kind: this.getTileKind(tx, tz),
      zone: this.getZone(tx, tz),
      height: inside ? terrain.getTileHeight(tx, tz) : BASE_GROUND_HEIGHT,
      water: inside ? terrain.isWater(tx, tz) : false,
      decor: this.hasDecor(tx, tz),
      roadMask: this.getRoadMask(tx, tz),
      roadAccess: this.hasRoadAccess(tx, tz),
      landValue: this.getLandValue(tx, tz),
      pollution: this.getPollution(tx, tz),
      building: this.getBuildingAt(tx, tz) ?? null,
      civic: this.getCivicAt(tx, tz) ?? null,
      coverage: { ...this.getCoverage(tx, tz) },
    };
  }

  getStats(): Readonly<CityStats> {
    return this.stats;
  }

  getHistory(): ReadonlyArray<HistorySample> {
    return this.state.history;
  }

  // ------------------------------------------------------------------ internals

  private cleanName(name: unknown): string | null {
    if (typeof name !== 'string') return null;
    const n = name.trim().slice(0, MAX_NAME).trim();
    return n === '' ? null : n;
  }

  /** Recomputes buildingAt, roads and (optionally) land value + pollution. */
  private rebuildDerived(fields: boolean): void {
    const s = this.state;
    s.rebuildBuildingAt();
    s.rebuildCivicAt();
    recomputeCoverage(s);
    recomputeRoads(s, this.deps.terrain);
    if (!s.staticReady) {
      recomputeStaticLandValue(s, this.deps.terrain);
      s.staticReady = true;
    }
    if (fields) recomputeFields(s);
  }

  private refreshStats(): void {
    const s = this.state;
    computeAggregates(s, this.agg);
    computeTileTotals(s, this.totals);
    monthlyBudget(s, this.agg, this.projected);
    computeStats(s, this.agg, this.totals, this.projected, this.stats);
  }

  private runTicks(n: number): void {
    const changed = this.changed;
    changed.clear();
    for (let k = 0; k < n; k++) this.oneTick(changed);
    this.refreshStats();
    if (changed.size > 0) this.deps.bus.emit('tiles:changed', { tiles: Array.from(changed), cause: 'growth' });
    this.deps.bus.emit('stats:changed', { stats: this.stats });
  }

  private oneTick(changed: Set<number>): void {
    const s = this.state;
    const p = s.priv;
    s.day++;
    const agg = computeAggregates(s, this.agg);
    const tt = computeTileTotals(s, this.totals);
    p.happiness += (targetHappiness(s, agg, tt.lvAvg, tt.polAvg, tt.zonedR, tt.covHealth) - p.happiness) * HAPPINESS_EMA;
    const t = computeDemand(s, agg, p.happiness, this.demandTarget);
    p.demand.r += (t.r - p.demand.r) * DEMAND_EMA;
    p.demand.c += (t.c - p.demand.c) * DEMAND_EMA;
    p.demand.i += (t.i - p.demand.i) * DEMAND_EMA;
    growthTick(s, { terrain: this.deps.terrain, demand: p.demand, happiness: p.happiness, agg }, changed);
    if (s.day % DAYS_PER_MONTH === 0) this.monthEnd();
  }

  private monthEnd(): void {
    const s = this.state;
    const p = s.priv;
    const agg = computeAggregates(s, this.agg);
    const report = monthlyBudget(s, agg, emptyBudget());
    s.money += report.net;
    p.lastMonth = report;
    s.history.push({
      day: s.day,
      population: agg.population,
      money: s.money,
      jobs: agg.jobsTotal,
      demand: { r: p.demand.r, c: p.demand.c, i: p.demand.i },
    });
    if (s.history.length > HISTORY_MAX) s.history.splice(0, s.history.length - HISTORY_MAX);
    recomputeFields(s);
    this.monthlyNotifications();
    p.abandonedThisMonth = 0;
    this.deps.bus.emit('sim:month', { day: s.day, report: { ...report, taxes: { ...report.taxes } }, money: s.money });
  }

  private notify(key: string, message: string, kind: NotifyKind): void {
    const p = this.state.priv;
    const last = p.notifyDay[key];
    if (last !== undefined && this.state.day - last < NOTIFY_COOLDOWN_DAYS) return;
    p.notifyDay[key] = this.state.day;
    this.deps.bus.emit('notify', { message, kind });
  }

  private monthlyNotifications(): void {
    const s = this.state;
    const p = s.priv;
    const a = this.agg;
    let reached = -1;
    while (p.milestone < MILESTONES.length && a.population >= MILESTONES[p.milestone]) reached = p.milestone++;
    if (reached >= 0) this.deps.bus.emit('notify', { message: `${s.name} reached ${MILESTONES[reached].toLocaleString('en-US')} residents!`, kind: 'success' });
    if (s.money < 0) this.notify('money', 'The city is in debt! Raise taxes or cut road and park upkeep.', 'warning');
    let unconnected = false;
    for (let i = 0; i < TILE_COUNT && !unconnected; i++)
      if (s.kind[i] === TileKind.Zoned && s.roadDist[i] <= 3 && s.connDist[i] > 3) unconnected = true;
    if (unconnected) this.notify('noconnect', 'Some zones have roads that are not connected to the highway. Connect roads to the map edge.', 'info');
    if (a.workforce > 50 && a.unemployment > 0.2) this.notify('unemployment', 'High unemployment: zone more industry or commerce.', 'info');
    else if (a.jobsTotal > 50 && a.jobsTotal > 1.5 * a.workforce + 20) this.notify('workers', 'Businesses lack workers: zone more residential.', 'info');
    if (a.countC >= 4 && p.demand.c < -0.3) this.notify('customers', 'Shops are short of customers: grow the population before zoning more commerce.', 'info');
    if (p.abandonedThisMonth >= 5) this.notify('abandon', `${p.abandonedThisMonth} buildings were abandoned this month. Check road access, demand and pollution.`, 'warning');
  }

  private restoreFields(extra: unknown): boolean {
    const sim = extra && typeof extra === 'object' ? (extra as Record<string, unknown>).sim : undefined;
    if (!sim || typeof sim !== 'object') return false;
    const o = sim as Record<string, unknown>;
    const lv = b64ToBytes(o.lv, TILE_COUNT);
    const pol = b64ToBytes(o.pol, TILE_COUNT);
    if (!lv || !pol) return false;
    this.state.landValue.set(lv);
    this.state.pollution.set(pol);
    return true;
  }

  /** Validates a snapshot and builds a fresh CityState from copies. Throws on invalid data. */
  private validateAndBuild(snap: CitySnapshot): CityState {
    const fail = (msg: string): never => {
      throw new Error(`Invalid city save: ${msg}`);
    };
    if (!snap || typeof snap !== 'object') fail('not an object');
    if (snap.mapTiles !== MAP_TILES) fail(`save is for a ${snap.mapTiles}² map, expected ${MAP_TILES}²`);
    if (!isInt(snap.version) || snap.version < 1 || snap.version > SAVE_VERSION) fail(`unsupported version ${String(snap.version)}`);
    if (!isNum(snap.seed)) fail('bad seed');
    if (!isInt(snap.day) || snap.day < 0) fail('bad day');
    if (!isNum(snap.money)) fail('bad money');
    if (snap.speed !== 0 && snap.speed !== 1 && snap.speed !== 2 && snap.speed !== 3) fail('bad speed');
    const tr = parseRCI(snap.taxRates);
    if (!tr) fail('bad tax rates');
    if (!isNum(snap.rngState)) fail('bad rng state');
    if (!isInt(snap.nextBuildingId) || snap.nextBuildingId < 1) fail('bad nextBuildingId');
    const arr = (a: unknown, name: string): ArrayLike<number> => {
      const v = a as ArrayLike<number> | null;
      if (!v || typeof v !== 'object' || v.length !== TILE_COUNT) fail(`${name} must have ${TILE_COUNT} entries`);
      return v as ArrayLike<number>;
    };
    const kind = arr(snap.tileKind, 'tileKind');
    const zone = arr(snap.tileZone, 'tileZone');
    const flags = arr(snap.tileFlags, 'tileFlags');
    const terrain = this.deps.terrain;

    const s = new CityState();
    for (let i = 0; i < TILE_COUNT; i++) {
      const k = kind[i];
      const z = zone[i];
      const f = flags[i];
      if (!isInt(k) || k < 0 || k > 4) fail(`tile ${i}: bad kind`);
      if (!isInt(z) || z < 0 || z > 3) fail(`tile ${i}: bad zone`);
      if (!isInt(f) || f < 0 || f > 255) fail(`tile ${i}: bad flags`);
      if ((k === TileKind.Zoned) !== (z !== ZoneType.None)) fail(`tile ${i}: zone/kind mismatch`);
      s.kind[i] = k;
      s.zone[i] = z;
      s.flags[i] = f;
    }

    if (!Array.isArray(snap.buildings)) fail('buildings must be an array');
    const ids = new Set<number>();
    for (const raw of snap.buildings) {
      const b = raw as Building;
      if (!b || typeof b !== 'object') fail('bad building');
      const tag = `building ${String(b.id)}`;
      if (!isInt(b.id) || b.id < 1 || b.id >= snap.nextBuildingId) fail(`${tag}: bad id`);
      if (ids.has(b.id)) fail(`${tag}: duplicate id`);
      ids.add(b.id);
      if (b.zone !== 1 && b.zone !== 2 && b.zone !== 3) fail(`${tag}: bad zone`);
      if (b.level !== 1 && b.level !== 2 && b.level !== 3) fail(`${tag}: bad level`);
      if (b.size !== 1 && b.size !== 2) fail(`${tag}: bad size`);
      if (b.size === 2 && b.level !== 3) fail(`${tag}: 2×2 buildings must be level 3`);
      if (b.facing !== 0 && b.facing !== 1 && b.facing !== 2 && b.facing !== 3) fail(`${tag}: bad facing`);
      if (b.state !== BuildingState.Constructing && b.state !== BuildingState.Active && b.state !== BuildingState.Abandoned)
        fail(`${tag}: bad state`);
      if (!isInt(b.stage) || b.stage < 0 || b.stage > 2) fail(`${tag}: bad stage`);
      for (const k of ['variant', 'stateDays', 'occupants', 'capacity', 'builtDay', 'tx', 'tz'] as const)
        if (!isInt(b[k]) || b[k] < 0) fail(`${tag}: bad ${k}`);
      if (b.tx + b.size > MAP_TILES || b.tz + b.size > MAP_TILES) fail(`${tag}: footprint outside the map`);
      const h = terrain.getTileHeight(b.tx, b.tz);
      for (let dz = 0; dz < b.size; dz++)
        for (let dx = 0; dx < b.size; dx++) {
          const x = b.tx + dx;
          const z = b.tz + dz;
          const i = z * MAP_TILES + x;
          if (s.kind[i] !== TileKind.Zoned || s.zone[i] !== b.zone) fail(`${tag}: footprint tile not zoned for it`);
          if (terrain.isWater(x, z)) fail(`${tag}: footprint on water`);
          if (terrain.getTileHeight(x, z) !== h) fail(`${tag}: uneven footprint`);
          if (s.buildingAt[i] !== 0) fail(`${tag}: overlaps building ${s.buildingAt[i]}`);
          s.buildingAt[i] = b.id;
        }
      s.buildings.set(b.id, cloneBuilding(b));
    }

    // civics (saves from before civics existed have none)
    const civRaw = (snap as { civics?: unknown }).civics;
    if (civRaw !== undefined && !Array.isArray(civRaw)) fail('civics must be an array');
    for (const raw of (civRaw as CivicBuilding[] | undefined) ?? []) {
      const c = raw;
      if (!c || typeof c !== 'object') fail('bad civic building');
      const tag = `civic ${String(c.id)}`;
      if (!isInt(c.id) || c.id < 1 || c.id >= snap.nextBuildingId) fail(`${tag}: bad id`);
      if (ids.has(c.id)) fail(`${tag}: duplicate id`);
      ids.add(c.id);
      if (!isCivicKind(c.kind)) fail(`${tag}: bad kind`);
      if (c.facing !== 0 && c.facing !== 1 && c.facing !== 2 && c.facing !== 3) fail(`${tag}: bad facing`);
      for (const k of ['variant', 'builtDay', 'tx', 'tz'] as const) if (!isInt(c[k]) || c[k] < 0) fail(`${tag}: bad ${k}`);
      const size = CIVIC_SPECS[c.kind].size;
      if (c.tx + size > MAP_TILES || c.tz + size > MAP_TILES) fail(`${tag}: footprint outside the map`);
      const h = terrain.getTileHeight(c.tx, c.tz);
      for (let dz = 0; dz < size; dz++)
        for (let dx = 0; dx < size; dx++) {
          const x = c.tx + dx;
          const z = c.tz + dz;
          const i = z * MAP_TILES + x;
          if (s.kind[i] !== TileKind.Civic) fail(`${tag}: footprint tile is not a civic tile`);
          if (terrain.isWater(x, z) || terrain.getTileHeight(x, z) !== h) fail(`${tag}: footprint not on flat dry land`);
          if (s.civicAt[i] !== 0) fail(`${tag}: overlaps civic ${s.civicAt[i]}`);
          s.civicAt[i] = c.id;
        }
      s.civics.set(c.id, cloneCivic(c));
    }
    for (let i = 0; i < TILE_COUNT; i++) if (s.kind[i] === TileKind.Civic && s.civicAt[i] === 0) fail(`tile ${i}: civic tile without a building`);

    if (!Array.isArray(snap.history)) fail('history must be an array');
    const hist: HistorySample[] = [];
    for (const h of snap.history) {
      const d = h ? parseRCI(h.demand) : null;
      if (!h || !d || !isNum(h.day) || !isNum(h.population) || !isNum(h.money) || !isNum(h.jobs)) fail('bad history sample');
      hist.push(cloneSample(h));
    }

    s.name = this.cleanName(snap.name) ?? 'City';
    s.seed = snap.seed >>> 0;
    s.day = snap.day;
    s.money = snap.money;
    s.speed = snap.speed;
    s.taxRates = tr as TaxRates;
    s.rng = new Rng(snap.rngState >>> 0);
    s.nextBuildingId = snap.nextBuildingId;
    s.history = hist.slice(-HISTORY_MAX);

    // extra (lenient: unknown / malformed private data falls back to defaults)
    const extra = snap.extra && typeof snap.extra === 'object' ? snap.extra : {};
    const other: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra)) if (k !== 'sim') other[k] = v;
    s.extraOther = cloneJson(other);
    s.priv = this.parsePrivate((extra as Record<string, unknown>).sim);
    const sim = (extra as Record<string, unknown>).sim as Record<string, unknown> | undefined;
    const cs = sim && Array.isArray(sim.counters) ? (sim.counters as unknown[]) : [];
    for (let k = 0; k + 3 < cs.length; k += 4) {
      const id = cs[k];
      if (!isInt(id) || !s.buildings.has(id)) continue;
      const c: BuildingCounters = {
        noAccess: isInt(cs[k + 1]) ? (cs[k + 1] as number) : 0,
        badDemand: isInt(cs[k + 2]) ? (cs[k + 2] as number) : 0,
        polluted: isInt(cs[k + 3]) ? (cs[k + 3] as number) : 0,
      };
      s.counters.set(id, c);
    }
    for (const id of s.buildings.keys()) if (!s.counters.has(id)) s.counters.set(id, { noAccess: 0, badDemand: 0, polluted: 0 });
    // keep counters in building order (deterministic Map order doesn't matter for counters, but be tidy)
    return s;
  }

  private parsePrivate(v: unknown): SimPrivate {
    const d = defaultPrivate();
    if (!v || typeof v !== 'object') return d;
    const p = (v as Record<string, unknown>).priv as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return d;
    const dem = parseRCI(p.demand);
    if (dem) d.demand = dem;
    if (isNum(p.happiness)) d.happiness = p.happiness;
    const lm = parseBudget(p.lastMonth);
    if (lm) d.lastMonth = lm;
    if (isInt(p.milestone) && p.milestone >= 0) d.milestone = p.milestone;
    if (isInt(p.abandonedThisMonth) && p.abandonedThisMonth >= 0) d.abandonedThisMonth = p.abandonedThisMonth;
    if (p.notifyDay && typeof p.notifyDay === 'object')
      for (const [k, val] of Object.entries(p.notifyDay as Record<string, unknown>)) if (isNum(val)) d.notifyDay[k] = val;
    return d;
  }
}
