/**
 * MODULE: ui — top bar HUD (module-internal API; the ui agent may change it).
 * Owner: ui agent. STUB.
 */
import type { CityStats, GameBus, ISimulation, SimSpeed } from '../types';

export class Hud {
  readonly el: HTMLDivElement = document.createElement('div');
  constructor(bus: GameBus, sim: ISimulation) {
    // TODO(ui)
  }
  setStats(stats: Readonly<CityStats>, cityName: string): void {
    // TODO(ui)
  }
  setSpeed(speed: SimSpeed): void {
    // TODO(ui)
  }
  dispose(): void {
    this.el.remove();
  }
}
