/**
 * MODULE: ui — minimap canvas (module-internal API; may change).
 * Owner: ui agent. STUB.
 */
import type { CityReader, ICameraRig, TerrainReader } from '../types';

export class Minimap {
  readonly el: HTMLCanvasElement = document.createElement('canvas');
  constructor(city: CityReader, terrain: TerrainReader, camera: ICameraRig) {
    // TODO(ui)
  }
  /** Full redraw (after 'city:loaded' / throttled 'tiles:changed'). */
  redraw(): void {
    // TODO(ui)
  }
  dispose(): void {
    this.el.remove();
  }
}
