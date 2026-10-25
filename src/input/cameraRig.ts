/**
 * MODULE: input — RTS camera rig (orbit / pan / zoom, keyboard + mouse).
 * Owner: input agent. Implements ICameraRig (src/types.ts).
 *
 * STUB: places the camera at the state pose; no input handling. Replace with the full rig.
 *
 * Intended behaviour (KEYMAP in src/types.ts; ignore keys when isEditableTarget(e.target) or
 * ctrl/meta held; bubble-phase listeners on window for keys, on deps.dom for pointer/wheel):
 *  - State: focus (x,z) on the ground, yaw, pitch (clamp ~0.35..1.45 rad), distance (clamp 18..520).
 *    Keep a "target" state and a smoothed "current" state (damp() from src/core/util.ts, λ ≈ 10)
 *    so everything glides. focus.y follows terrain.getSurfaceHeight under the focus (smoothed).
 *  - Keyboard: W/S/A/D + arrows pan relative to yaw at speed ∝ distance (Shift = ×2.5);
 *    Q/E rotate (≈ 90°/s); R/F tilt; Z/X/PageUp/PageDown zoom; Home = reset().
 *  - Mouse: RIGHT-drag orbit (yaw + pitch); MIDDLE-drag or Shift+RIGHT-drag pans by dragging the
 *    ground point under the cursor (use src/input/picking.ts pickPlane at focus height);
 *    wheel zooms exponentially (×1.12 per notch, trackpad pinch = ctrl+wheel works too) TOWARD the
 *    point under the cursor. LEFT button is reserved for tools (never consumed here).
 *    Suppress the context menu on the canvas. Use pointer capture during drags.
 *  - Focus clamped to the map rectangle (+ small margin). Camera never goes below terrain + 2.
 *  - lookAtTile / reset / setState with `immediate` snap both target and current state.
 *  - enabled = false: ignore input, keep smoothing.
 *  - dispose(): remove every listener.
 */
import * as THREE from 'three';
import { BASE_GROUND_HEIGHT, MAP_TILES, TILE_SIZE, type CameraRigDeps, type CameraState, type ICameraRig } from '../types';
import { tileCenter } from '../core/coords';

export const DEFAULT_CAMERA: Readonly<CameraState> = {
  x: (MAP_TILES * TILE_SIZE) / 2,
  z: (MAP_TILES * TILE_SIZE) / 2,
  yaw: Math.PI / 4,
  pitch: 0.9,
  distance: 190,
};

export class CameraRig implements ICameraRig {
  enabled = true;
  private readonly deps: CameraRigDeps;
  private readonly focus = new THREE.Vector3();
  private state: CameraState = { ...DEFAULT_CAMERA };

  constructor(deps: CameraRigDeps) {
    this.deps = deps;
    this.reset(true);
  }

  update(dt: number): void {
    const s = this.state;
    this.focus.set(s.x, BASE_GROUND_HEIGHT, s.z);
    const cp = Math.cos(s.pitch);
    const cam = this.deps.camera;
    cam.position.set(
      s.x + Math.sin(s.yaw) * cp * s.distance,
      BASE_GROUND_HEIGHT + Math.sin(s.pitch) * s.distance,
      s.z + Math.cos(s.yaw) * cp * s.distance,
    );
    cam.lookAt(this.focus);
  }

  getFocus(): THREE.Vector3 {
    return this.focus;
  }

  lookAtTile(tx: number, tz: number, immediate = false): void {
    this.state.x = tileCenter(tx);
    this.state.z = tileCenter(tz);
    this.update(0);
  }

  reset(immediate = false): void {
    this.state = { ...DEFAULT_CAMERA };
    this.update(0);
  }

  getState(): CameraState {
    return { ...this.state };
  }

  setState(state: CameraState, immediate = false): void {
    this.state = { ...state };
    this.update(0);
  }

  dispose(): void {
    // TODO(input): remove listeners
  }
}
