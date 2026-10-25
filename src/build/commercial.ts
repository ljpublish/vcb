/**
 * MODULE: buildings — commercial building generators (module-internal API; may change).
 * Owner: buildings agent. See buildingGen.ts for the rules every generator follows.
 *
 * STUB.
 */
import type { Rng } from '../core/rng';
import type { BuildingSpec, LocalEmitter } from './buildingGen';
import { StampBuilder } from './stamp';

/** Builds an Active commercial building authored with its front facing +Z (caller rotates). */
export function generateCommercial(spec: BuildingSpec, rng: Rng, emitters: LocalEmitter[]): StampBuilder {
  // TODO(buildings)
  const s = spec.size * 8;
  return new StampBuilder(s, 2, s);
}
