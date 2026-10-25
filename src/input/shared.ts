/**
 * MODULE: input — state shared between the camera rig and the tool controller (module-internal).
 * Owner: input agent.
 *
 * game.ts constructs CameraRig and ToolController independently, so they coordinate through this
 * per-canvas record: who owns the current drag, the active tool (for the select-mode left-drag pan)
 * and a cursor override while the camera is being dragged.
 */
import type { ToolId } from '../types';

export interface InputShared {
  /** Active tool (written by the tool controller). */
  tool: ToolId;
  /** A left-button tool drag is in progress (written by the tool controller). */
  toolDragging: boolean;
  /** An orbit / pan drag is in progress (written by the camera rig). */
  cameraDragging: boolean;
  /** The current left press turned into a camera pan: the tool controller must not treat it as a click. */
  suppressClick: boolean;
  /** Cursor forced by the camera rig while dragging (null = tool controller decides). */
  cursorOverride: string | null;
}

const registry = new WeakMap<HTMLElement, InputShared>();

export function getInputShared(dom: HTMLElement): InputShared {
  let s = registry.get(dom);
  if (!s) {
    s = { tool: 'select', toolDragging: false, cameraDragging: false, suppressClick: false, cursorOverride: null };
    registry.set(dom, s);
  }
  return s;
}

/** PointerEvent.buttons bit for a PointerEvent.button value. */
export function buttonBit(button: number): number {
  return button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : button === 3 ? 8 : button === 4 ? 16 : 0;
}
