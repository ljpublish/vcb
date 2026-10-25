/**
 * MODULE: simulation — building growth, upgrades, abandonment (module-internal API; may change).
 * Owner: simulation agent.
 *
 * STUB. Intended per-tick logic (see ARCHITECTURE.md §11):
 *  - spawn L1 (Constructing, stage 0) on empty zoned tiles with access when demand > 0
 *  - advance construction (stage = floor(progress * CONSTRUCTION_STAGES)), complete → Active
 *  - occupancy drifts toward capacity × fill factor
 *  - upgrade L1→L2→L3 (land value / demand / occupancy / age gates), L3 may merge 2×2
 *  - abandon (no access, negative demand, pollution for R) and decay (long abandoned → removed)
 * Every visual change adds all footprint tile indices to `changed`.
 */
import type { TerrainReader } from '../types';
import type { CityState } from './cityState';

export interface GrowthContext {
  terrain: TerrainReader;
  /** Smoothed RCI demand −1..1. */
  demand: { r: number; c: number; i: number };
}

export function growthTick(state: CityState, ctx: GrowthContext, changed: Set<number>): void {
  // TODO(simulation)
}
