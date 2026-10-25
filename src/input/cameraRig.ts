/**
 * MODULE: input — RTS camera rig (orbit / pan / zoom, keyboard + mouse).
 * Owner: input agent. Implements ICameraRig (src/types.ts).
 *
 * Behaviour (KEYMAP in src/types.ts; keys ignored when isEditableTarget(e.target) or ctrl/meta/alt
 * held; bubble-phase listeners on window for keys, on deps.dom for pointer/wheel):
 *  - State: focus (x,z) on the ground, yaw, pitch (clamp 0.35..1.45 rad), distance (clamp 18..520).
 *    A "target" state and a smoothed "current" state (damp(), λ = 10) so everything glides.
 *    focus.y follows terrain.getSurfaceHeight under the focus (smoothed).
 *  - Keyboard: W/S/A/D + arrows pan relative to yaw at speed ∝ distance (Shift = ×2.5);
 *    Q/E rotate (90°/s); R/F tilt; Z/X/PageUp/PageDown zoom; Home = reset().
 *  - Mouse: RIGHT-drag orbit (yaw + pitch); MIDDLE-drag or Shift+RIGHT-drag pans by dragging the
 *    ground point under the cursor; wheel zooms exponentially (×1.12 per notch, ctrl+wheel =
 *    trackpad pinch) TOWARD the point under the cursor. LEFT button belongs to tools, except that
 *    with the select tool a left drag beyond 5 px pans the camera (a click still inspects).
 *    The context menu is suppressed on the canvas; pointer capture is used during drags.
 *  - Focus clamped to the map rectangle (+ margin). Camera never goes below terrain + 2.
 *  - lookAtTile / reset / setState with `immediate` snap both target and current state.
 *  - enabled = false: ignore input (held keys and drags are dropped), keep smoothing.
 *  - dispose(): remove every listener.
 */
import * as THREE from 'three';
import { KEYMAP, MAP_TILES, TILE_SIZE, type CameraRigDeps, type CameraState, type ICameraRig } from '../types';
import { tileCenter } from '../core/coords';
import { angleDelta, clamp, damp, isEditableTarget, keyMatches } from '../core/util';
import { rayPlane, screenRay } from './picking';
import { buttonBit, getInputShared, type InputShared } from './shared';

export const DEFAULT_CAMERA: Readonly<CameraState> = {
  x: (MAP_TILES * TILE_SIZE) / 2,
  z: (MAP_TILES * TILE_SIZE) / 2,
  yaw: Math.PI / 4,
  pitch: 0.9,
  distance: 190,
};

const MAP_EXTENT = MAP_TILES * TILE_SIZE;
const FOCUS_MARGIN = 24;
const PITCH_MIN = 0.35;
const PITCH_MAX = 1.45;
const DIST_MIN = 18;
const DIST_MAX = 520;
const SMOOTH = 10;
const FOCUS_Y_SMOOTH = 6;
const KEY_PAN_SPEED = 0.9; // × distance per second
const KEY_ROTATE_SPEED = Math.PI / 2; // rad/s
const KEY_TILT_SPEED = 1.1; // rad/s
const KEY_ZOOM_SPEED = 1.6; // e-folds per second
const ORBIT_YAW_PER_PX = 0.0065;
const ORBIT_PITCH_PER_PX = 0.0045;
const WHEEL_STEP = 1.12;
const LEFT_PAN_THRESHOLD_PX = 5;
const CAMERA_GROUND_CLEARANCE = 2;

type DragMode = 'none' | 'orbit' | 'pan' | 'leftPending' | 'leftPan';

const CAMERA_CODES: readonly string[] = [
  ...KEYMAP.panForward, ...KEYMAP.panBack, ...KEYMAP.panLeft, ...KEYMAP.panRight,
  ...KEYMAP.rotateLeft, ...KEYMAP.rotateRight, ...KEYMAP.tiltUp, ...KEYMAP.tiltDown,
  ...KEYMAP.zoomIn, ...KEYMAP.zoomOut,
];

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export class CameraRig implements ICameraRig {
  private readonly deps: CameraRigDeps;
  private readonly shared: InputShared;
  private _enabled = true;

  /** Target pose (what input edits; what getState() returns). */
  private readonly target: CameraState = { ...DEFAULT_CAMERA };
  /** Smoothed pose the camera is placed at. */
  private readonly cur: CameraState = { ...DEFAULT_CAMERA };
  private focusY = 0;
  private readonly focus = new THREE.Vector3();

  private readonly held = new Set<string>();
  private shiftHeld = false;

  private drag: DragMode = 'none';
  private dragPointer = -1;
  private dragButton = -1;
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;
  private panPlaneY = 0;
  private readonly panAnchor = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _ray = new THREE.Ray();

  private readonly listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions | undefined]> = [];

  constructor(deps: CameraRigDeps) {
    this.deps = deps;
    this.shared = getInputShared(deps.dom);
    const dom = deps.dom;
    this.listen(dom, 'pointerdown', this.onPointerDown as EventListener);
    this.listen(dom, 'pointermove', this.onPointerMove as EventListener);
    this.listen(dom, 'pointerup', this.onPointerUp as EventListener);
    this.listen(dom, 'pointercancel', this.onPointerCancel as EventListener);
    this.listen(dom, 'lostpointercapture', this.onLostCapture as EventListener);
    this.listen(dom, 'wheel', this.onWheel as EventListener, { passive: false });
    this.listen(dom, 'contextmenu', this.onContextMenu);
    this.listen(window, 'keydown', this.onKeyDown as EventListener);
    this.listen(window, 'keyup', this.onKeyUp as EventListener);
    this.listen(window, 'blur', this.onBlur);
    this.listen(document, 'visibilitychange', this.onVisibility);
    this.reset(true);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    const b = !!v;
    if (b === this._enabled) return;
    this._enabled = b;
    if (!b) {
      this.held.clear();
      this.shiftHeld = false;
      this.endDrag();
    }
  }

  // ------------------------------------------------------------------ frame

  update(dt: number): void {
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    const t = this.target;
    if (this._enabled && this.held.size > 0) this.applyKeys(d);
    this.clampTarget();

    const c = this.cur;
    const k = 1 - Math.exp(-SMOOTH * d);
    c.x = damp(c.x, t.x, SMOOTH, d);
    c.z = damp(c.z, t.z, SMOOTH, d);
    c.yaw += angleDelta(c.yaw, t.yaw) * k;
    c.pitch = damp(c.pitch, t.pitch, SMOOTH, d);
    // Zoom in log space so it feels uniform at every distance.
    c.distance = Math.exp(damp(Math.log(c.distance), Math.log(t.distance), SMOOTH, d));
    this.focusY = damp(this.focusY, this.groundAt(c.x, c.z), FOCUS_Y_SMOOTH, d);
    this.applyPose();
  }

  getFocus(): THREE.Vector3 {
    return this.focus;
  }

  lookAtTile(tx: number, tz: number, immediate = false): void {
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
    this.target.x = tileCenter(clamp(Math.round(tx), 0, MAP_TILES - 1));
    this.target.z = tileCenter(clamp(Math.round(tz), 0, MAP_TILES - 1));
    this.clampTarget();
    if (immediate) this.snap();
  }

  reset(immediate = false): void {
    Object.assign(this.target, DEFAULT_CAMERA);
    if (immediate) this.snap();
  }

  getState(): CameraState {
    const t = this.target;
    return { x: t.x, z: t.z, yaw: t.yaw, pitch: t.pitch, distance: t.distance };
  }

  setState(state: CameraState, immediate = false): void {
    const s = (state ?? {}) as Partial<CameraState>;
    const t = this.target;
    t.x = finiteOr(s.x, DEFAULT_CAMERA.x);
    t.z = finiteOr(s.z, DEFAULT_CAMERA.z);
    t.yaw = finiteOr(s.yaw, DEFAULT_CAMERA.yaw);
    t.pitch = finiteOr(s.pitch, DEFAULT_CAMERA.pitch);
    t.distance = finiteOr(s.distance, DEFAULT_CAMERA.distance);
    this.clampTarget();
    if (immediate) this.snap();
  }

  dispose(): void {
    this.endDrag();
    for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    this.held.clear();
  }

  // ------------------------------------------------------------------ pose

  private snap(): void {
    this.clampTarget();
    Object.assign(this.cur, this.target);
    this.focusY = this.groundAt(this.cur.x, this.cur.z);
    this.applyPose();
  }

  private clampTarget(): void {
    const t = this.target;
    t.x = clamp(t.x, -FOCUS_MARGIN, MAP_EXTENT + FOCUS_MARGIN);
    t.z = clamp(t.z, -FOCUS_MARGIN, MAP_EXTENT + FOCUS_MARGIN);
    t.pitch = clamp(t.pitch, PITCH_MIN, PITCH_MAX);
    t.distance = clamp(t.distance, DIST_MIN, DIST_MAX);
    // Keep yaw bounded so it never loses precision after hours of spinning.
    if (Math.abs(t.yaw) > Math.PI * 64) {
      const wrapped = t.yaw % (Math.PI * 2);
      this.cur.yaw += wrapped - t.yaw;
      t.yaw = wrapped;
    }
  }

  /** Places the camera at the current (smoothed) pose. */
  private applyPose(): void {
    const c = this.cur;
    const cam = this.deps.camera;
    this.focus.set(c.x, this.focusY, c.z);
    const cp = Math.cos(c.pitch);
    let px = c.x + Math.sin(c.yaw) * cp * c.distance;
    let py = this.focusY + Math.sin(c.pitch) * c.distance;
    let pz = c.z + Math.cos(c.yaw) * cp * c.distance;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
      Object.assign(this.cur, DEFAULT_CAMERA);
      Object.assign(this.target, DEFAULT_CAMERA);
      px = DEFAULT_CAMERA.x;
      py = this.focusY + DEFAULT_CAMERA.distance;
      pz = DEFAULT_CAMERA.z;
    }
    const floor = this.groundAt(px, pz) + CAMERA_GROUND_CLEARANCE;
    if (py < floor) py = floor;
    cam.position.set(px, py, pz);
    cam.lookAt(this.focus);
    cam.updateMatrixWorld();
  }

  private groundAt(x: number, z: number): number {
    const tx = clamp(Math.floor(x / TILE_SIZE), 0, MAP_TILES - 1);
    const tz = clamp(Math.floor(z / TILE_SIZE), 0, MAP_TILES - 1);
    try {
      const h = this.deps.terrain.getSurfaceHeight(tx, tz);
      return Number.isFinite(h) ? h : 0;
    } catch {
      return 0;
    }
  }

  private applyKeys(dt: number): void {
    const t = this.target;
    let fwd = 0;
    let right = 0;
    if (this.anyHeld(KEYMAP.panForward)) fwd += 1;
    if (this.anyHeld(KEYMAP.panBack)) fwd -= 1;
    if (this.anyHeld(KEYMAP.panRight)) right += 1;
    if (this.anyHeld(KEYMAP.panLeft)) right -= 1;
    if (fwd !== 0 || right !== 0) {
      const len = Math.hypot(fwd, right);
      const speed = KEY_PAN_SPEED * t.distance * (this.shiftHeld ? 2.5 : 1) * dt / len;
      const s = Math.sin(t.yaw);
      const c = Math.cos(t.yaw);
      // forward = camera → focus on the ground = (-sin, -cos); right = (cos, -sin)
      t.x += (-s * fwd + c * right) * speed;
      t.z += (-c * fwd - s * right) * speed;
    }
    if (this.anyHeld(KEYMAP.rotateLeft)) t.yaw -= KEY_ROTATE_SPEED * dt;
    if (this.anyHeld(KEYMAP.rotateRight)) t.yaw += KEY_ROTATE_SPEED * dt;
    if (this.anyHeld(KEYMAP.tiltUp)) t.pitch += KEY_TILT_SPEED * dt;
    if (this.anyHeld(KEYMAP.tiltDown)) t.pitch -= KEY_TILT_SPEED * dt;
    if (this.anyHeld(KEYMAP.zoomIn)) t.distance *= Math.exp(-KEY_ZOOM_SPEED * dt);
    if (this.anyHeld(KEYMAP.zoomOut)) t.distance *= Math.exp(KEY_ZOOM_SPEED * dt);
  }

  private anyHeld(codes: readonly string[]): boolean {
    for (let i = 0; i < codes.length; i++) if (this.held.has(codes[i]!)) return true;
    return false;
  }

  // ------------------------------------------------------------------ keyboard

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.shiftHeld = e.shiftKey;
    if (!this._enabled || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
    if (keyMatches(KEYMAP.resetView, e.code)) {
      this.reset(false);
      e.preventDefault();
      return;
    }
    if (CAMERA_CODES.includes(e.code)) {
      this.held.add(e.code);
      e.preventDefault(); // arrows / PageUp / PageDown would scroll the page
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.shiftHeld = e.shiftKey;
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.shiftHeld = false;
    this.endDrag();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.onBlur();
  };

  // ------------------------------------------------------------------ pointer

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.handleButton(e, e.button, true);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    // Chorded presses/releases (a 2nd button while one is held) arrive as pointermove with button ≥ 0.
    if (e.button >= 0) this.handleButton(e, e.button, (e.buttons & buttonBit(e.button)) !== 0);
    if (this.drag === 'none' || e.pointerId !== this.dragPointer) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    switch (this.drag) {
      case 'orbit':
        this.target.yaw -= dx * ORBIT_YAW_PER_PX;
        this.target.pitch += dy * ORBIT_PITCH_PER_PX;
        this.clampTarget();
        break;
      case 'pan':
      case 'leftPan':
        this.panTo(e.clientX, e.clientY);
        break;
      case 'leftPending':
        if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > LEFT_PAN_THRESHOLD_PX) {
          if (this.shared.toolDragging || this.shared.tool !== 'select') {
            this.endDrag();
            return;
          }
          this.drag = 'leftPan';
          this.shared.cameraDragging = true;
          this.shared.suppressClick = true;
          this.shared.cursorOverride = 'grabbing';
          try {
            this.deps.dom.setPointerCapture(e.pointerId);
          } catch {
            /* pointer already gone */
          }
          this.beginPanAnchor(this.downX, this.downY);
          this.panTo(e.clientX, e.clientY);
        }
        break;
      default:
        break;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.handleButton(e, e.button, false);
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId === this.dragPointer) this.endDrag();
  };

  private readonly onLostCapture = (e: PointerEvent): void => {
    if (e.pointerId === this.dragPointer && this.drag !== 'leftPending' && this.drag !== 'none') this.endDrag();
  };

  private handleButton(e: PointerEvent, button: number, down: boolean): void {
    if (!down) {
      if (this.drag !== 'none' && e.pointerId === this.dragPointer && button === this.dragButton) this.endDrag();
      return;
    }
    if (!this._enabled) return;
    if (this.drag !== 'none') {
      // A second button while a select-mode left press is pending: drop the pending pan.
      if (this.drag === 'leftPending') this.endDrag();
      else return;
    }
    // A right-click during a tool drag cancels the tool drag (tool controller) and must not orbit.
    if (this.shared.toolDragging) return;

    if (button === 2 && !e.shiftKey) {
      this.beginDrag(e, button, 'orbit');
      this.shared.cursorOverride = 'grabbing';
    } else if (button === 1 || (button === 2 && e.shiftKey)) {
      this.beginDrag(e, button, 'pan');
      this.beginPanAnchor(e.clientX, e.clientY);
      this.shared.cursorOverride = 'grabbing';
      if (button === 1) e.preventDefault(); // no autoscroll
    } else if (button === 0 && this.shared.tool === 'select' && e.isPrimary) {
      this.shared.suppressClick = false;
      this.beginDrag(e, button, 'leftPending');
      this.shared.cameraDragging = false; // pending: not a camera drag yet
    }
  }

  private beginDrag(e: PointerEvent, button: number, mode: DragMode): void {
    this.drag = mode;
    this.dragPointer = e.pointerId;
    this.dragButton = button;
    this.lastX = this.downX = e.clientX;
    this.lastY = this.downY = e.clientY;
    this.shared.cameraDragging = mode !== 'leftPending';
    if (mode !== 'leftPending') {
      try {
        this.deps.dom.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
    }
  }

  private endDrag(): void {
    if (this.drag === 'none') return;
    const wasCapture = this.drag !== 'leftPending';
    const id = this.dragPointer;
    this.drag = 'none';
    this.dragPointer = -1;
    this.dragButton = -1;
    this.shared.cameraDragging = false;
    this.shared.cursorOverride = null;
    if (wasCapture && !this.shared.toolDragging) {
      try {
        if (this.deps.dom.hasPointerCapture(id)) this.deps.dom.releasePointerCapture(id);
      } catch {
        /* ignore */
      }
    }
  }

  /** Remember the ground point under (clientX, clientY) at the current focus height. */
  private beginPanAnchor(clientX: number, clientY: number): void {
    this.panPlaneY = this.focusY;
    // Pan the current pose directly (no smoothing lag) so the anchor stays glued to the cursor.
    this.cur.x = this.target.x;
    this.cur.z = this.target.z;
    this.applyPose();
    const ray = screenRay(this.deps.camera, this.deps.dom, clientX, clientY, this._ray);
    const p = rayPlane(ray, this.panPlaneY, this.panAnchor);
    if (!p) this.panAnchor.set(this.cur.x, this.panPlaneY, this.cur.z);
  }

  private panTo(clientX: number, clientY: number): void {
    const ray = screenRay(this.deps.camera, this.deps.dom, clientX, clientY, this._ray);
    const p = rayPlane(ray, this.panPlaneY, this._v);
    if (!p) return;
    let dx = this.panAnchor.x - p.x;
    let dz = this.panAnchor.z - p.z;
    // Huge jumps happen near the horizon; cap them to keep panning controllable.
    const max = this.target.distance * 1.5;
    const len = Math.hypot(dx, dz);
    if (len > max) {
      dx *= max / len;
      dz *= max / len;
    }
    this.target.x += dx;
    this.target.z += dz;
    this.clampTarget();
    this.cur.x = this.target.x;
    this.cur.z = this.target.z;
    this.applyPose();
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (!this._enabled) return;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    if (!Number.isFinite(dy) || dy === 0) return;
    // One mouse notch ≈ 100 px; trackpad pinch (ctrl+wheel) sends small deltas → amplify.
    const notches = clamp(e.ctrlKey ? dy / 12 : dy / 100, -6, 6);
    const t = this.target;
    const oldD = t.distance;
    const newD = clamp(oldD * Math.pow(WHEEL_STEP, notches), DIST_MIN, DIST_MAX);
    if (newD === oldD) return;
    // Zoom toward the ground point under the cursor: shift the focus by the same fraction.
    const ray = screenRay(this.deps.camera, this.deps.dom, e.clientX, e.clientY, this._ray);
    const p = rayPlane(ray, this.focusY, this._v);
    if (p) {
      const f = 1 - newD / oldD;
      const fx = p.x - t.x;
      const fz = p.z - t.z;
      // Ignore absurd far points (cursor near the horizon).
      if (Math.hypot(fx, fz) < oldD * 4) {
        t.x += fx * f;
        t.z += fz * f;
      }
    }
    t.distance = newD;
    this.clampTarget();
  };

  private listen(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }
}
