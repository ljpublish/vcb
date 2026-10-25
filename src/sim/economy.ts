/**
 * MODULE: simulation — demand, land value, pollution, budget, stats (module-internal API; may change).
 * Owner: simulation agent.
 *
 * STUB. Intended:
 *  - computeDemand: RCI targets from population / jobs / workforce / taxes / region connection,
 *    returned unsmoothed in −1..1 (Simulation smooths with an EMA).
 *  - recomputeLandValue / recomputePollution: tile fields 0..1 (parks, water, commercial proximity,
 *    industry pollution with distance falloff).
 *  - monthlyBudget: taxes per zone, region trade income, road/bridge/park upkeep (UPKEEP).
 *  - computeStats: fills CityStats from state (+ last/projected budget).
 */
import type { BudgetReport, CityStats, RCI, TerrainReader } from '../types';
import type { CityState } from './cityState';
import { emptyBudget, emptyStats } from './stats';

export function computeDemand(state: CityState): RCI {
  // TODO(simulation)
  return { r: 0, c: 0, i: 0 };
}

export function recomputeLandValue(state: CityState, terrain: TerrainReader): void {
  // TODO(simulation)
}

export function recomputePollution(state: CityState): void {
  // TODO(simulation)
}

export function monthlyBudget(state: CityState, terrain: TerrainReader): BudgetReport {
  // TODO(simulation)
  return emptyBudget();
}

export function computeStats(state: CityState, demand: RCI, lastMonth: BudgetReport, projected: BudgetReport): CityStats {
  // TODO(simulation)
  return emptyStats(state.money);
}
