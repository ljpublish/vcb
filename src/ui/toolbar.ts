/**
 * MODULE: ui — tool palette (module-internal API; may change).
 * Owner: ui agent. STUB.
 */
import type { IToolController, ToolId } from '../types';

export interface ToolButtonDef {
  id: ToolId;
  label: string;
  /** KEYMAP action whose first code is shown as the hotkey badge. */
  hotkey: string;
  /** Short description incl. cost. */
  hint: string;
}

export class Toolbar {
  readonly el: HTMLDivElement = document.createElement('div');
  constructor(tools: IToolController) {
    // TODO(ui)
  }
  setActive(tool: ToolId): void {
    // TODO(ui)
  }
  dispose(): void {
    this.el.remove();
  }
}
