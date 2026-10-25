/**
 * MODULE: buildings — construction-site and abandoned-building transforms (module-internal API; may change).
 * Owner: buildings agent.
 *
 * STUB.
 */
import type { Rng } from '../core/rng';
import type { BuildingSpec } from './buildingGen';
import { StampBuilder } from './stamp';

/** Construction site for `spec` at spec.stage, given the finished building's height. */
export function generateConstruction(spec: BuildingSpec, finalHeight: number, rng: Rng): StampBuilder {
  // TODO(buildings)
  const s = spec.size * 8;
  return new StampBuilder(s, 2, s);
}

/** In-place: turn a finished building into its abandoned/derelict version. */
export function applyAbandoned(stamp: StampBuilder, rng: Rng): void {
  // TODO(buildings)
}
