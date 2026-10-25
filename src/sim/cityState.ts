/**
 * MODULE: simulation — raw city state container (module-internal API; the simulation agent may change it).
 * Owner: simulation agent.
 *
 * STUB. Intended: the single mutable state object behind Simulation, struct-of-arrays for tiles.
 * Persisted fields map 1:1 to CitySnapshot; derived fields are recomputed after load/changes.
 */
import { TILE_COUNT, type Building, type HistorySample, type SimSpeed, type TaxRates } from '../types';
import { Rng } from '../core/rng';

export class CityState {
  // ---- persisted ----
  name = 'New City';
  seed = 0;
  day = 0;
  money = 0;
  speed: SimSpeed = 1;
  taxRates: TaxRates = { r: 9, c: 9, i: 9 };
  rng = new Rng(1);
  nextBuildingId = 1;
  readonly kind = new Uint8Array(TILE_COUNT);
  readonly zone = new Uint8Array(TILE_COUNT);
  readonly flags = new Uint8Array(TILE_COUNT);
  readonly buildings = new Map<number, Building>();
  history: HistorySample[] = [];
  extra: Record<string, unknown> = {};

  // ---- derived (never persisted) ----
  /** Building id per tile (0 = none), rebuilt from `buildings`. */
  readonly buildingAt = new Int32Array(TILE_COUNT);
  /** DIR_BIT mask of road neighbours for road tiles. */
  readonly roadMask = new Uint8Array(TILE_COUNT);
  /** Manhattan distance to the nearest road tile (255 = far). */
  readonly roadDist = new Uint8Array(TILE_COUNT);
  /** Road network component id per road tile (-1 = not a road). */
  readonly roadComponent = new Int32Array(TILE_COUNT);
  /** 0..1 */
  readonly landValue = new Float32Array(TILE_COUNT);
  /** 0..1 */
  readonly pollution = new Float32Array(TILE_COUNT);
}
