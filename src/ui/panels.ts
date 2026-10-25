/**
 * MODULE: ui — inspect panel and modal dialogs: budget, save/load, new city, settings, help
 * (module-internal API; may change).
 * Owner: ui agent. STUB.
 */
import type { TileInfo } from '../types';

export type ModalId = 'budget' | 'saves' | 'newCity' | 'settings' | 'help';

export class InspectPanel {
  readonly el: HTMLDivElement = document.createElement('div');
  show(info: TileInfo | null): void {
    // TODO(ui)
  }
  dispose(): void {
    this.el.remove();
  }
}

export class ModalHost {
  readonly el: HTMLDivElement = document.createElement('div');
  /** Currently open modal or null. */
  current: ModalId | null = null;
  open(id: ModalId): void {
    // TODO(ui)
  }
  close(): void {
    // TODO(ui)
  }
  dispose(): void {
    this.el.remove();
  }
}
