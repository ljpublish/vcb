/**
 * MODULE: input — tile highlight / ghost preview / grid / data overlays (module-internal API).
 * Owner: input agent.
 *
 *  - TileHighlighter: InstancedMeshes of thin, slightly inset boxes (TILE_SIZE × 0.25 × TILE_SIZE)
 *    floating ~0.06 above each tile's surface with per-instance colour (one mesh for valid tiles,
 *    one dimmer mesh for invalid ones). MeshBasicMaterial, transparent, depthWrite false,
 *    polygonOffset, renderOrder above the world. Capacity grows on demand (≥ MAX_ACTION_TILES).
 *    Also translucent "footprint boxes" (buildings a bulldoze would hit — ground highlights under a
 *    building are hidden) and crisp always-on-top box outlines for hovered / selected tiles and
 *    building footprints.
 *  - GridOverlay: subtle tile grid lines around the cursor (fade with distance, radius 12 tiles).
 *  - DataOverlay: per-tile heat colours for landValue / pollution / roadAccess, refreshed ≤ 2×/s
 *    while active, one InstancedMesh over all land tiles.
 * Nothing here casts or receives shadows. Colours are used as-is (ColorManagement is disabled).
 */
import * as THREE from 'three';
import { MAP_TILES, MAX_ACTION_TILES, TILE_COUNT, TILE_SIZE, TileKind, type CityReader, type OverlayMode, type TerrainReader, type TileCoord } from '../types';
import type { TileHeightFn } from './picking';

const RENDER_ORDER = 20;
const HIGHLIGHT_LIFT = 0.06;
const HIGHLIGHT_THICK = 0.25;
const HIGHLIGHT_INSET = 0.3;

function setTranslation(arr: Float32Array, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
  const o = i * 16;
  arr[o] = sx; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = sz; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

function setColor(arr: Float32Array, i: number, hex: number): void {
  const o = i * 3;
  arr[o] = ((hex >> 16) & 255) / 255;
  arr[o + 1] = ((hex >> 8) & 255) / 255;
  arr[o + 2] = (hex & 255) / 255;
}

function overlayMaterial(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    toneMapped: false,
    fog: false,
  });
}

/** A growable InstancedMesh with per-instance colour; matrices/colours written straight into the buffers. */
class InstancePool {
  mesh: THREE.InstancedMesh;
  private capacity: number;
  count = 0;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly geometry: THREE.BufferGeometry,
    readonly material: THREE.Material,
    capacity: number,
    private readonly renderOrder: number,
  ) {
    this.capacity = Math.max(16, capacity);
    this.mesh = this.create(this.capacity);
  }

  private create(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geometry, this.material, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = this.renderOrder;
    m.matrixAutoUpdate = false;
    m.visible = false;
    this.parent.add(m);
    return m;
  }

  ensure(n: number): void {
    if (n <= this.capacity) return;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.capacity = cap;
    this.mesh = this.create(cap);
  }

  get matrices(): Float32Array {
    return this.mesh.instanceMatrix.array as Float32Array;
  }

  get colors(): Float32Array {
    return this.mesh.instanceColor!.array as Float32Array;
  }

  commit(n: number): void {
    this.count = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    const ic = this.mesh.instanceColor!;
    ic.clearUpdateRanges();
    ic.addUpdateRange(0, n * 3);
    ic.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

/** Unit-box edge geometry (0..1 on every axis), shared by all outlines. */
function unitBoxEdges(): THREE.BufferGeometry {
  const p = [
    0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0,
    0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0,
    0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return g;
}

/** A crisp, always-on-top box outline that can be placed around a tile or a building footprint. */
export class BoxOutline {
  readonly lines: THREE.LineSegments;
  private readonly material: THREE.LineBasicMaterial;

  constructor(parent: THREE.Object3D, geometry: THREE.BufferGeometry, color: number, opacity: number) {
    this.material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
    this.lines = new THREE.LineSegments(geometry, this.material);
    this.lines.renderOrder = RENDER_ORDER + 5;
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.matrixAutoUpdate = false;
    parent.add(this.lines);
  }

  /** Outline the box [x0,x1]×[y0,y1]×[z0,z1] (world units). */
  set(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color?: number): void {
    const l = this.lines;
    l.position.set(x0, y0, z0);
    l.scale.set(Math.max(0.01, x1 - x0), Math.max(0.01, y1 - y0), Math.max(0.01, z1 - z0));
    l.updateMatrix();
    l.updateMatrixWorld(true);
    if (color !== undefined) this.material.color.setHex(color);
    l.visible = true;
  }

  setOpacity(o: number): void {
    this.material.opacity = o;
  }

  hide(): void {
    this.lines.visible = false;
  }

  dispose(): void {
    this.lines.removeFromParent();
    this.material.dispose();
  }
}

/** Approximate building heights by level (voxels above ground), for footprint boxes / outlines. */
export function approxBuildingHeight(level: number, size: number): number {
  if (size >= 2) return 64;
  return level >= 3 ? 44 : level === 2 ? 26 : 12;
}

/** Approximate civic building height (voxels above ground). */
export function approxCivicHeight(size: number): number {
  return size >= 2 ? 30 : 20;
}

export interface FootprintBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  y1: number;
}

export class TileHighlighter {
  readonly object = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
  private readonly validMat = overlayMaterial(0.45);
  private readonly invalidMat = overlayMaterial(0.28);
  private readonly boxMat = overlayMaterial(0.22);
  private readonly valid: InstancePool;
  private readonly invalid: InstancePool;
  private readonly boxes: InstancePool;
  private readonly edges = unitBoxEdges();
  readonly hoverOutline: BoxOutline;
  readonly selectOutline: BoxOutline;

  constructor(parent: THREE.Object3D) {
    this.object.name = 'input:highlighter';
    parent.add(this.object);
    this.valid = new InstancePool(this.object, this.geometry, this.validMat, MAX_ACTION_TILES, RENDER_ORDER);
    this.invalid = new InstancePool(this.object, this.geometry, this.invalidMat, 64, RENDER_ORDER);
    this.boxes = new InstancePool(this.object, this.geometry, this.boxMat, 32, RENDER_ORDER + 1);
    this.hoverOutline = new BoxOutline(this.object, this.edges, 0xffffff, 0.85);
    this.selectOutline = new BoxOutline(this.object, this.edges, 0xffe14d, 1);
  }

  /**
   * Show the given tiles with per-tile colours (0xRRGGBB). Tiles with dim[i] === true go into the
   * lower-opacity "invalid" layer. Tile surfaces come from heightAt.
   */
  show(tiles: readonly TileCoord[], colors: readonly number[], dim: readonly boolean[] | null, heightAt: TileHeightFn): void {
    const n = tiles.length;
    this.valid.ensure(n);
    this.invalid.ensure(n);
    const vm = this.valid.matrices, vc = this.valid.colors;
    const im = this.invalid.matrices, ic = this.invalid.colors;
    let nv = 0;
    let ni = 0;
    const w = TILE_SIZE - HIGHLIGHT_INSET * 2;
    for (let i = 0; i < n; i++) {
      const t = tiles[i]!;
      const y = heightAt(t.tx, t.tz) + HIGHLIGHT_LIFT;
      const x = t.tx * TILE_SIZE + HIGHLIGHT_INSET;
      const z = t.tz * TILE_SIZE + HIGHLIGHT_INSET;
      const color = colors[i] ?? 0xffffff;
      if (dim && dim[i]) {
        setTranslation(im, ni, x, y, z, w, HIGHLIGHT_THICK, w);
        setColor(ic, ni++, color);
      } else {
        setTranslation(vm, nv, x, y, z, w, HIGHLIGHT_THICK, w);
        setColor(vc, nv++, color);
      }
    }
    this.valid.commit(nv);
    this.invalid.commit(ni);
  }

  /** Translucent boxes (e.g. buildings a bulldoze drag would remove). */
  showBoxes(list: readonly FootprintBox[], color: number): void {
    const n = list.length;
    this.boxes.ensure(n);
    const m = this.boxes.matrices, c = this.boxes.colors;
    for (let i = 0; i < n; i++) {
      const b = list[i]!;
      setTranslation(m, i, b.x0 - 0.15, b.y0, b.z0 - 0.15, b.x1 - b.x0 + 0.3, b.y1 - b.y0 + 0.3, b.z1 - b.z0 + 0.3);
      setColor(c, i, color);
    }
    this.boxes.commit(n);
  }

  /** Pulse factor (≈ 0.8..1). */
  setPulse(k: number): void {
    this.validMat.opacity = 0.45 * k;
    this.invalidMat.opacity = 0.28 * k;
    this.boxMat.opacity = 0.22 * k;
  }

  clear(): void {
    this.valid.commit(0);
    this.invalid.commit(0);
    this.boxes.commit(0);
  }

  dispose(): void {
    this.clear();
    this.valid.dispose();
    this.invalid.dispose();
    this.boxes.dispose();
    this.hoverOutline.dispose();
    this.selectOutline.dispose();
    this.geometry.dispose();
    this.edges.dispose();
    this.validMat.dispose();
    this.invalidMat.dispose();
    this.boxMat.dispose();
    this.object.removeFromParent();
  }
}

const GRID_RADIUS = 12;
const GRID_SIDE = GRID_RADIUS * 2 + 1;
const GRID_MAX_SEGMENTS = GRID_SIDE * GRID_SIDE * 2 + GRID_SIDE * 2;

export class GridOverlay {
  readonly object = new THREE.Group();
  private readonly positions = new Float32Array(GRID_MAX_SEGMENTS * 2 * 3);
  private readonly colors = new Float32Array(GRID_MAX_SEGMENTS * 2 * 4);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.LineBasicMaterial;
  private readonly lines: THREE.LineSegments;
  private lastTx = -9999;
  private lastTz = -9999;
  private lastVisible = false;

  constructor(parent: THREE.Object3D) {
    this.object.name = 'input:grid';
    parent.add(this.object);
    const pos = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', pos);
    this.geometry.setAttribute('color', col);
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, fog: false });
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = RENDER_ORDER - 1;
    this.lines.visible = false;
    this.object.add(this.lines);
  }

  /** Force a rebuild on the next update (terrain / roads changed). */
  invalidate(): void {
    this.lastTx = -9999;
  }

  update(center: TileCoord | null, visible: boolean, terrain: TerrainReader, heightAt?: TileHeightFn): void {
    const show = visible && center !== null;
    if (!show) {
      if (this.lastVisible) {
        this.lines.visible = false;
        this.lastVisible = false;
      }
      return;
    }
    this.lines.visible = true;
    this.lastVisible = true;
    if (center.tx === this.lastTx && center.tz === this.lastTz) return;
    this.lastTx = center.tx;
    this.lastTz = center.tz;
    const P = this.positions;
    const C = this.colors;
    let v = 0;
    const h = (tx: number, tz: number): number => (heightAt ? heightAt(tx, tz) : terrain.getSurfaceHeight(tx, tz)) + 0.08;
    const seg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, a: number): void => {
      if (v + 2 > GRID_MAX_SEGMENTS * 2) return;
      P[v * 3] = x0; P[v * 3 + 1] = y0; P[v * 3 + 2] = z0;
      C[v * 4] = 1; C[v * 4 + 1] = 1; C[v * 4 + 2] = 1; C[v * 4 + 3] = a;
      v++;
      P[v * 3] = x1; P[v * 3 + 1] = y1; P[v * 3 + 2] = z1;
      C[v * 4] = 1; C[v * 4 + 1] = 1; C[v * 4 + 2] = 1; C[v * 4 + 3] = a;
      v++;
    };
    const alpha = (dtx: number, dtz: number): number => {
      const d = Math.hypot(dtx, dtz) / (GRID_RADIUS + 0.5);
      return d >= 1 ? 0 : 0.32 * (1 - d) * (1 - d);
    };
    for (let dz = -GRID_RADIUS; dz <= GRID_RADIUS; dz++) {
      for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        const tx = center.tx + dx;
        const tz = center.tz + dz;
        if (tx < 0 || tz < 0 || tx >= MAP_TILES || tz >= MAP_TILES) continue;
        const a = alpha(dx, dz);
        if (a <= 0.004) continue;
        const y = h(tx, tz);
        const x0 = tx * TILE_SIZE, x1 = x0 + TILE_SIZE;
        const z0 = tz * TILE_SIZE, z1 = z0 + TILE_SIZE;
        // North and west edges of every tile, plus south/east on the outer ring of the patch.
        seg(x0, y, z0, x1, y, z0, a);
        seg(x0, y, z0, x0, y, z1, a);
        if (dz === GRID_RADIUS || tz === MAP_TILES - 1 || alpha(dx, dz + 1) <= 0.004) seg(x0, y, z1, x1, y, z1, a);
        if (dx === GRID_RADIUS || tx === MAP_TILES - 1 || alpha(dx + 1, dz) <= 0.004) seg(x1, y, z0, x1, y, z1, a);
      }
    }
    this.geometry.setDrawRange(0, v);
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    pos.clearUpdateRanges();
    pos.addUpdateRange(0, v * 3);
    pos.needsUpdate = true;
    col.clearUpdateRanges();
    col.addUpdateRange(0, v * 4);
    col.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}

const DATA_REFRESH_S = 0.5;

function heat(t: number): number {
  // 0 → green, 0.5 → yellow, 1 → red
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const g0 = [0x2e, 0xcc, 0x40], y = [0xff, 0xdc, 0x00], r = [0xff, 0x41, 0x36];
  const a = k < 0.5 ? g0 : y;
  const b = k < 0.5 ? y : r;
  const f = k < 0.5 ? k * 2 : (k - 0.5) * 2;
  const R = Math.round(a[0]! + (b[0]! - a[0]!) * f);
  const G = Math.round(a[1]! + (b[1]! - a[1]!) * f);
  const B = Math.round(a[2]! + (b[2]! - a[2]!) * f);
  return (R << 16) | (G << 8) | B;
}

/** Precomputed heat ramp (256 steps) so refreshes do no colour math per tile. */
const HEAT_LUT: Float32Array = (() => {
  const lut = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = heat(i / 255);
    lut[i * 3] = ((c >> 16) & 255) / 255;
    lut[i * 3 + 1] = ((c >> 8) & 255) / 255;
    lut[i * 3 + 2] = (c & 255) / 255;
  }
  return lut;
})();

export class DataOverlay {
  readonly object = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
  private readonly material = overlayMaterial(0.55);
  private readonly pool: InstancePool;
  private mode: OverlayMode = 'none';
  private timer = 0;
  private dirty = true;

  constructor(parent: THREE.Object3D) {
    this.object.name = 'input:data';
    parent.add(this.object);
    this.pool = new InstancePool(this.object, this.geometry, this.material, TILE_COUNT, RENDER_ORDER - 2);
  }

  /** Refresh on the next update regardless of the timer. */
  invalidate(): void {
    this.dirty = true;
  }

  update(mode: OverlayMode, city: CityReader, terrain: TerrainReader, dt: number): void {
    if (mode !== this.mode) {
      this.mode = mode;
      this.dirty = true;
    }
    if (mode === 'none') {
      if (this.pool.count > 0) this.pool.commit(0);
      return;
    }
    this.timer += Number.isFinite(dt) ? dt : 0;
    if (!this.dirty && this.timer < DATA_REFRESH_S) return;
    this.timer = 0;
    this.dirty = false;
    this.rebuild(mode, city, terrain);
  }

  private rebuild(mode: OverlayMode, city: CityReader, terrain: TerrainReader): void {
    const m = this.pool.matrices;
    const c = this.pool.colors;
    const w = TILE_SIZE - 0.1;
    let n = 0;
    for (let tz = 0; tz < MAP_TILES; tz++) {
      for (let tx = 0; tx < MAP_TILES; tx++) {
        const water = terrain.isWater(tx, tz);
        const kind = city.getTileKind(tx, tz);
        if (water && kind !== TileKind.Road) continue;
        let r: number, g: number, b: number;
        if (mode === 'roadAccess') {
          if (kind === TileKind.Zoned) {
            const ok = city.hasRoadAccess(tx, tz);
            r = ok ? 0.2 : 1; g = ok ? 0.85 : 0.22; b = ok ? 0.3 : 0.2;
          } else if (kind === TileKind.Road) {
            r = 0.75; g = 0.75; b = 0.78;
          } else continue;
        } else {
          let v = mode === 'landValue' ? 1 - city.getLandValue(tx, tz) : city.getPollution(tx, tz);
          if (!Number.isFinite(v)) v = 0;
          const li = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255) * 3;
          r = HEAT_LUT[li]!; g = HEAT_LUT[li + 1]!; b = HEAT_LUT[li + 2]!;
        }
        const y = (water ? terrain.getSurfaceHeight(tx, tz) + 2 : terrain.getSurfaceHeight(tx, tz)) + 0.04;
        setTranslation(m, n, tx * TILE_SIZE + 0.05, y, tz * TILE_SIZE + 0.05, w, 0.2, w);
        c[n * 3] = r; c[n * 3 + 1] = g; c[n * 3 + 2] = b;
        n++;
      }
    }
    this.pool.commit(n);
  }

  dispose(): void {
    this.pool.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}
