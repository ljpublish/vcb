/**
 * MODULE: ui — minimap canvas (module-internal API; may change).
 * Owner: ui agent.
 *
 * Two stacked canvases: a base layer (terrain height shading from BLOCK_COLOR, water, roads,
 * zones — darker when built — and parks) and a cheap marker layer (camera focus + view wedge).
 * redraw() repaints everything; markTiles() queues changed tiles which flushTiles() repaints
 * incrementally. Click / drag → camera.lookAtTile.
 */
import {
  BuildingState,
  MAX_GROUND_HEIGHT,
  MIN_GROUND_HEIGHT,
  TILE_SIZE,
  TileKind,
  WATER_LEVEL,
  ZoneType,
  type CityReader,
  type ICameraRig,
  type TerrainReader,
} from '../types';
import { BLOCK_COLOR } from '../voxel/blocks';
import { h } from './dom';

const TARGET_PX = 192;

// Packed 0xRRGGBB colours.
const ROAD = 0x5a606b;
const BRIDGE = 0x8b8f98;
const PARK = 0x4fbf5a;
const ZONE_LOT = [0, 0x7fc272, 0x6ea4dd, 0xdcb75a] as const;
const ZONE_BUILT = [0, 0x3f8a36, 0x2f69b0, 0xa97e1c] as const;
const ABANDONED = 0x6b5f55;
const CIVIC = 0xd8d2c4;

interface CameraLike {
  position: { x: number; z: number };
}

export class Minimap {
  readonly el: HTMLDivElement = h('div', 'vcb-minimap vcb-panel', { title: 'Minimap — click or drag to move the camera' });
  private readonly base: HTMLCanvasElement;
  private readonly marker: HTMLCanvasElement;
  private readonly bctx: CanvasRenderingContext2D | null;
  private readonly mctx: CanvasRenderingContext2D | null;
  private image: ImageData | null = null;
  private tiles = 0;
  private scale = 3;
  private readonly pending = new Set<number>();
  private dragging = false;
  private lastMx = Number.NaN;
  private lastMz = Number.NaN;
  private lastDx = Number.NaN;
  private lastDz = Number.NaN;

  constructor(
    private readonly city: CityReader,
    private readonly terrain: TerrainReader,
    private readonly camera: ICameraRig,
    private readonly viewCamera: CameraLike,
  ) {
    this.base = h('canvas', 'vcb-minimap-base');
    this.marker = h('canvas', 'vcb-minimap-marker');
    this.el.append(this.base, this.marker);
    this.bctx = this.base.getContext('2d');
    this.mctx = this.marker.getContext('2d');
    this.resize();

    this.marker.addEventListener('pointerdown', this.onDown);
    this.marker.addEventListener('pointermove', this.onMove);
    this.marker.addEventListener('pointerup', this.onUp);
    this.marker.addEventListener('pointercancel', this.onUp);
    this.marker.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private resize(): void {
    const n = Math.max(1, this.city.mapTiles | 0);
    if (n === this.tiles && this.image) return;
    this.tiles = n;
    this.scale = Math.max(1, Math.floor(TARGET_PX / n));
    const px = n * this.scale;
    this.base.width = this.marker.width = px;
    this.base.height = this.marker.height = px;
    this.el.style.setProperty('--vcb-mm-size', `${px}px`);
    this.image = this.bctx ? this.bctx.createImageData(px, px) : null;
    this.lastMx = Number.NaN;
  }

  /** Full redraw (after 'city:loaded'). */
  redraw(): void {
    this.resize();
    this.pending.clear();
    if (!this.image || !this.bctx) return;
    const n = this.tiles;
    for (let tz = 0; tz < n; tz++) for (let tx = 0; tx < n; tx++) this.paintTile(tx, tz);
    this.bctx.putImageData(this.image, 0, 0);
    this.lastMx = Number.NaN;
  }

  /** Queue changed tile indices (tz * mapTiles + tx). */
  markTiles(tiles: readonly number[]): void {
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i]!;
      if (t >= 0 && t < this.tiles * this.tiles) this.pending.add(t);
    }
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Repaint queued tiles (throttled by the caller, ≤ 2 Hz). */
  flushTiles(): void {
    if (this.pending.size === 0 || !this.image || !this.bctx) return;
    const n = this.tiles;
    let minX = n, minZ = n, maxX = -1, maxZ = -1;
    for (const t of this.pending) {
      const tx = t % n;
      const tz = (t / n) | 0;
      this.paintTile(tx, tz);
      if (tx < minX) minX = tx;
      if (tz < minZ) minZ = tz;
      if (tx > maxX) maxX = tx;
      if (tz > maxZ) maxZ = tz;
    }
    this.pending.clear();
    const s = this.scale;
    this.bctx.putImageData(this.image, 0, 0, minX * s, minZ * s, (maxX - minX + 1) * s, (maxZ - minZ + 1) * s);
  }

  private tileColor(tx: number, tz: number): number {
    const city = this.city;
    const terrain = this.terrain;
    const kind = city.getTileKind(tx, tz);
    const water = terrain.isWater(tx, tz);
    if (kind === TileKind.Road) return water ? BRIDGE : ROAD;
    if (kind === TileKind.Park) return PARK;
    if (kind === TileKind.Civic) return CIVIC;
    if (kind === TileKind.Zoned) {
      const zone = city.getZone(tx, tz);
      if (zone === ZoneType.None) return ROAD;
      const b = city.getBuildingIdAt(tx, tz) ? city.getBuildingAt(tx, tz) : undefined;
      if (b) return b.state === BuildingState.Abandoned ? ABANDONED : ZONE_BUILT[zone];
      return ZONE_LOT[zone];
    }
    const hgt = terrain.getTileHeight(tx, tz);
    if (water) {
      // Deeper water is darker.
      const depth = Math.max(0, Math.min(1, (WATER_LEVEL - hgt) / Math.max(1, WATER_LEVEL - MIN_GROUND_HEIGHT)));
      return mix(0x4aa3d8, 0x1d4f86, depth);
    }
    let c = BLOCK_COLOR[terrain.getGroundBlock(tx, tz)] ?? 0x5fa04a;
    if (city.hasDecor(tx, tz)) c = mix(c, 0x2d6a2a, 0.45);
    // Height tint + simple hill shading from the north-west neighbour.
    const hn = terrain.getTileHeight(tx - 1, tz - 1);
    const t = (hgt - MIN_GROUND_HEIGHT) / Math.max(1, MAX_GROUND_HEIGHT - MIN_GROUND_HEIGHT);
    const shade = 0.82 + t * 0.35 + Math.max(-0.25, Math.min(0.25, (hgt - hn) * 0.05));
    return scale(c, shade);
  }

  private paintTile(tx: number, tz: number): void {
    const img = this.image;
    if (!img) return;
    let c: number;
    try {
      c = this.tileColor(tx, tz);
    } catch {
      c = 0x222222;
    }
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    const s = this.scale;
    const w = img.width;
    const data = img.data;
    for (let y = 0; y < s; y++) {
      let o = ((tz * s + y) * w + tx * s) * 4;
      for (let x = 0; x < s; x++) {
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
        o += 4;
      }
    }
  }

  /** Redraws the camera marker if the camera moved (cheap; call at ~10 Hz). */
  updateMarker(): void {
    const ctx = this.mctx;
    if (!ctx) return;
    const st = this.camera.getState();
    const k = this.scale / TILE_SIZE;
    const mx = st.x * k;
    const mz = st.z * k;
    let dx = st.x - this.viewCamera.position.x;
    let dz = st.z - this.viewCamera.position.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) {
      dx /= len;
      dz /= len;
    } else {
      dx = 0;
      dz = -1;
    }
    if (
      Math.abs(mx - this.lastMx) < 0.25 &&
      Math.abs(mz - this.lastMz) < 0.25 &&
      Math.abs(dx - this.lastDx) < 0.01 &&
      Math.abs(dz - this.lastDz) < 0.01
    ) return;
    this.lastMx = mx;
    this.lastMz = mz;
    this.lastDx = dx;
    this.lastDz = dz;

    const size = this.marker.width;
    ctx.clearRect(0, 0, size, size);
    // View wedge: wider + longer when zoomed out.
    const reach = Math.max(14, Math.min(70, st.distance * k * 1.1));
    const ang = Math.atan2(dz, dx);
    const half = 0.55;
    ctx.beginPath();
    ctx.moveTo(mx, mz);
    ctx.arc(mx, mz, reach, ang - half, ang + half);
    ctx.closePath();
    const grad = ctx.createRadialGradient(mx, mz, 0, mx, mz, reach);
    grad.addColorStop(0, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fill();
    // Focus marker.
    ctx.beginPath();
    ctx.arc(mx, mz, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb547';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.stroke();
  }

  private lookAtEvent(e: PointerEvent): void {
    const rect = this.marker.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const fx = (e.clientX - rect.left) / rect.width;
    const fz = (e.clientY - rect.top) / rect.height;
    const n = this.tiles;
    const tx = Math.max(0, Math.min(n - 1, Math.floor(fx * n)));
    const tz = Math.max(0, Math.min(n - 1, Math.floor(fz * n)));
    try {
      this.camera.lookAtTile(tx, tz, this.dragging && e.type === 'pointermove');
    } catch (err) {
      console.error('[ui] lookAtTile failed', err);
    }
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    this.dragging = true;
    try {
      this.marker.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.lookAtEvent(e);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (this.dragging) this.lookAtEvent(e);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    try {
      this.marker.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  dispose(): void {
    this.marker.removeEventListener('pointerdown', this.onDown);
    this.marker.removeEventListener('pointermove', this.onMove);
    this.marker.removeEventListener('pointerup', this.onUp);
    this.marker.removeEventListener('pointercancel', this.onUp);
    this.pending.clear();
    this.el.remove();
  }
}

function mix(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
  const g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
  const bl = (a & 255) * (1 - t) + (b & 255) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

function scale(c: number, f: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * f));
  const b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
}
