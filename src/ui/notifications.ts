/**
 * MODULE: ui — toast notifications (module-internal API; may change).
 * Owner: ui agent. STUB.
 */
import type { NotifyKind } from '../types';

export class Toasts {
  readonly el: HTMLDivElement = document.createElement('div');
  push(message: string, kind: NotifyKind, durationMs = 3500): void {
    // TODO(ui)
  }
  dispose(): void {
    this.el.remove();
  }
}
