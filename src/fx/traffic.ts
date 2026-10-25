/**
 * MODULE: atmosphere — cosmetic traffic: small voxel-style cars driving on the road network.
 * Owner: atmosphere agent. Module-internal API (may change).
 *
 *  - Road graph from CityReader: nodes = road tiles, edges = DIR_BIT mask bits. Rebuilt lazily when
 *    marked dirty (≤ 2×/s). Cars on tiles that stopped being roads are removed; cars whose planned
 *    exit vanished re-plan, so nothing drives off the network.
 *  - Cars: three InstancedMeshes (car / bus / truck) of merged voxel boxes with per-instance colours,
 *    plus matching emissive head/tail-light meshes and one additive headlight-beam mesh (night).
 *  - Movement: per tile a car follows a precomputed local path from its entry edge to its exit edge:
 *    straight, right turn (quarter circle r = 2.5), left turn (r = 5.5) or U-turn (dead ends only).
 *    Drives on the RIGHT: lane centre = tile centre line + ROAD_LANE_OFFSET × right-hand vector
 *    (−dz, dx). y = roadSurfaceY() eased across tile boundaries (terraces, bridge ends).
 *  - Spacing: slows down behind the nearest car in the same lane (same tile & direction, or the
 *    next tile's entry).
 *  - Count target = min(400, roadTiles × 0.35, 3 + (population + jobsTotal) / 25); spawn/despawn
 *    gradually (scale in/out) on road tiles next to buildings / civic buildings or on map-edge road tiles.
 */
import * as THREE from 'three';
import { roadSurfaceY, tileCenter } from '../core/coords';
import { Rng } from '../core/rng';
import { clamp01, smoothstep } from '../core/util';
import { DIR_BIT, DIR_DX, DIR_DZ, ROAD_LANE_OFFSET, TileKind, ZoneType, type CityReader, type TerrainReader } from '../types';
import { box, mergeBoxes, writeInstanceMatrix, type ColoredBox } from './voxelGeom';

export const MAX_CARS = 400;
const HALF = 4; // half tile (TILE_SIZE / 2)
const LANE = ROAD_LANE_OFFSET;
const R_RIGHT = HALF - LANE; // 2.5
const R_LEFT = HALF + LANE; // 5.5
const REBUILD_INTERVAL = 0.5;
const STATS_INTERVAL = 0.5;
const SPAWN_TIME = 0.7;

const TYPE_CAR = 0;
const TYPE_BUS = 1;
const TYPE_TRUCK = 2;
const TYPE_COUNT = 3;
/** Half lengths per type (for spacing and headlight beam placement). */
const TYPE_HALF_LEN = [1.85, 3.6, 3.1];

const CAR_COLORS = [0xe04a3f, 0x3f7fe0, 0xf2c94c, 0x5cbf6a, 0xf2f2f2, 0x2b2b30, 0xff8a3d, 0x8e5bd6, 0x4fc3d9, 0xd94f8a, 0xb0b8c0, 0x7a2e2e];
const BUS_COLORS = [0xf2b632, 0xe85d3a, 0x3a8ee8, 0x4cae5a];
const TRUCK_COLORS = [0xf0f0f0, 0xd9d2c4, 0x5e86b8, 0xc94f3d, 0x6b8f5a];

// ------------------------------------------------------------------ per-tile paths

/** Path kind per (d,e) pair index d*4+e. 0 straight, 1 right, 2 left, 3 U-turn. */
function pathKind(d: number, e: number): number {
  if (e === d) return 0;
  if (e === ((d + 1) & 3)) return 1;
  if (e === ((d + 3) & 3)) return 2;
  return 3;
}

const PATH_LEN = new Float32Array(16);
for (let d = 0; d < 4; d++) {
  for (let e = 0; e < 4; e++) {
    const k = pathKind(d, e);
    PATH_LEN[d * 4 + e] = k === 0 ? 2 * HALF : k === 1 ? (Math.PI / 2) * R_RIGHT : k === 2 ? (Math.PI / 2) * R_LEFT : 2 * HALF + Math.PI * LANE;
  }
}

/** Scratch outputs of evalPath. */
const P = { x: 0, z: 0, hx: 0, hz: 1 };

/**
 * Local position (relative to the tile centre) and heading on the path entering with travel dir d and
 * leaving with dir e, at arc length s.
 */
function evalPath(d: number, e: number, s: number): void {
  const dx = DIR_DX[d];
  const dz = DIR_DZ[d];
  const rx = -dz; // right-hand vector
  const rz = dx;
  const k = pathKind(d, e);
  if (k === 0) {
    const t = s - HALF;
    P.x = dx * t + rx * LANE;
    P.z = dz * t + rz * LANE;
    P.hx = dx;
    P.hz = dz;
  } else if (k === 1) {
    const phi = s / R_RIGHT;
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    // pivot = -HALF*d + HALF*r; v = -R r cos + R d sin
    P.x = -HALF * dx + HALF * rx - R_RIGHT * rx * c + R_RIGHT * dx * sn;
    P.z = -HALF * dz + HALF * rz - R_RIGHT * rz * c + R_RIGHT * dz * sn;
    P.hx = rx * sn + dx * c;
    P.hz = rz * sn + dz * c;
  } else if (k === 2) {
    const phi = s / R_LEFT;
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    // pivot = -HALF*d - HALF*r; v = R r cos + R d sin
    P.x = -HALF * dx - HALF * rx + R_LEFT * rx * c + R_LEFT * dx * sn;
    P.z = -HALF * dz - HALF * rz + R_LEFT * rz * c + R_LEFT * dz * sn;
    P.hx = -rx * sn + dx * c;
    P.hz = -rz * sn + dz * c;
  } else {
    const arc = Math.PI * LANE;
    if (s < HALF) {
      const t = s - HALF;
      P.x = dx * t + rx * LANE;
      P.z = dz * t + rz * LANE;
      P.hx = dx;
      P.hz = dz;
    } else if (s < HALF + arc) {
      const phi = (s - HALF) / LANE;
      const c = Math.cos(phi);
      const sn = Math.sin(phi);
      P.x = LANE * (rx * c + dx * sn);
      P.z = LANE * (rz * c + dz * sn);
      P.hx = -rx * sn + dx * c;
      P.hz = -rz * sn + dz * c;
    } else {
      const t = s - HALF - arc;
      P.x = -rx * LANE - dx * t;
      P.z = -rz * LANE - dz * t;
      P.hx = -dx;
      P.hz = -dz;
    }
  }
}

// ------------------------------------------------------------------ geometry

function carBoxes(): ColoredBox[] {
  const W = 0xffffff;
  const G = 0x26303c;
  const K = 0x1c1c20;
  return [
    box(-1, 0.32, -1.8, 1, 1.05, 1.8, W),
    box(-0.9, 1.05, -1.1, 0.9, 1.58, 0.75, G),
    box(-0.93, 1.58, -1.05, 0.93, 1.72, 0.65, W),
    box(-1.06, 0, 0.75, -0.8, 0.6, 1.4, K),
    box(0.8, 0, 0.75, 1.06, 0.6, 1.4, K),
    box(-1.06, 0, -1.4, -0.8, 0.6, -0.75, K),
    box(0.8, 0, -1.4, 1.06, 0.6, -0.75, K),
  ];
}

function busBoxes(): ColoredBox[] {
  const W = 0xffffff;
  const G = 0x26303c;
  const K = 0x1c1c20;
  return [
    box(-1.1, 0.35, -3.6, 1.1, 1.35, 3.6, W),
    box(-1.08, 1.35, -3.5, 1.08, 2.05, 3.6, G),
    box(-1.1, 2.05, -3.6, 1.1, 2.5, 3.6, W),
    box(-1.16, 0, 2.0, -0.9, 0.65, 2.8, K),
    box(0.9, 0, 2.0, 1.16, 0.65, 2.8, K),
    box(-1.16, 0, -2.8, -0.9, 0.65, -2.0, K),
    box(0.9, 0, -2.8, 1.16, 0.65, -2.0, K),
  ];
}

function truckBoxes(): ColoredBox[] {
  const W = 0xffffff;
  const C = 0xd8d8d8;
  const G = 0x26303c;
  const K = 0x1c1c20;
  return [
    box(-1.05, 0.35, 1.7, 1.05, 1.3, 3.1, W),
    box(-1.0, 1.3, 1.7, 1.0, 1.95, 2.7, G),
    box(-1.05, 1.95, 1.7, 1.05, 2.1, 2.75, W),
    box(-1.15, 0.5, -3.1, 1.15, 2.7, 1.5, C),
    box(-1.0, 0.35, 1.5, 1.0, 0.6, 1.7, K),
    box(-1.16, 0, 2.0, -0.9, 0.65, 2.7, K),
    box(0.9, 0, 2.0, 1.16, 0.65, 2.7, K),
    box(-1.16, 0, -2.6, -0.9, 0.65, -1.8, K),
    box(0.9, 0, -2.6, 1.16, 0.65, -1.8, K),
  ];
}

const HEAD = 0xfff2c4;
const TAIL = 0xff2a1a;

function lightBoxes(type: number): ColoredBox[] {
  if (type === TYPE_CAR) {
    return [
      box(-0.88, 0.6, 1.8, -0.5, 0.85, 1.88, HEAD),
      box(0.5, 0.6, 1.8, 0.88, 0.85, 1.88, HEAD),
      box(-0.9, 0.62, -1.88, -0.55, 0.85, -1.8, TAIL),
      box(0.55, 0.62, -1.88, 0.9, 0.85, -1.8, TAIL),
    ];
  }
  if (type === TYPE_BUS) {
    return [
      box(-0.95, 0.55, 3.6, -0.55, 0.85, 3.68, HEAD),
      box(0.55, 0.55, 3.6, 0.95, 0.85, 3.68, HEAD),
      box(-1.0, 0.6, -3.68, -0.6, 1.0, -3.6, TAIL),
      box(0.6, 0.6, -3.68, 1.0, 1.0, -3.6, TAIL),
      box(-0.6, 2.2, 3.6, 0.6, 2.42, 3.66, 0xffd34a),
    ];
  }
  return [
    box(-0.92, 0.55, 3.1, -0.55, 0.85, 3.18, HEAD),
    box(0.55, 0.55, 3.1, 0.92, 0.85, 3.18, HEAD),
    box(-1.05, 0.6, -3.18, -0.7, 0.95, -3.1, TAIL),
    box(0.7, 0.6, -3.18, 1.05, 0.95, -3.1, TAIL),
  ];
}

function beamGeometry(): THREE.BufferGeometry {
  // A soft trapezoid on the road in front of the car (local +Z), vertex alpha via colour.
  const pos = new Float32Array([
    -0.9, 0.06, 0, 0.9, 0.06, 0, 2.0, 0.06, 7.5,
    -0.9, 0.06, 0, 2.0, 0.06, 7.5, -2.0, 0.06, 7.5,
  ]);
  const col = new Float32Array([
    1, 0.93, 0.7, 1, 0.93, 0.7, 0, 0, 0,
    1, 0.93, 0.7, 0, 0, 0, 0, 0, 0,
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// ------------------------------------------------------------------ system

export class TrafficSystem {
  readonly object = new THREE.Group();
  private readonly city: CityReader;
  private readonly terrain: TerrainReader;
  private readonly rng = new Rng(0x7a11c);

  // Road graph (per tile).
  private mapTiles = 0;
  private mask = new Uint8Array(0);
  private isRoad = new Uint8Array(0);
  private heights = new Float32Array(0);
  /** 0 none, 1 residential, 2 commercial, 3 industrial: dominant neighbouring zone (for vehicle mix). */
  private zoneHint = new Uint8Array(0);
  private spawnTiles: number[] = [];
  private roadTileCount = 0;
  private dirty = true;
  private sinceRebuild = REBUILD_INTERVAL;

  // Cars (SoA, dense 0..count-1).
  private count = 0;
  private readonly tile = new Int32Array(MAX_CARS);
  private readonly dIn = new Uint8Array(MAX_CARS);
  private readonly dOut = new Uint8Array(MAX_CARS);
  private readonly s = new Float32Array(MAX_CARS);
  private readonly speed = new Float32Array(MAX_CARS);
  private readonly cruise = new Float32Array(MAX_CARS);
  private readonly type = new Uint8Array(MAX_CARS);
  private readonly colR = new Float32Array(MAX_CARS);
  private readonly colG = new Float32Array(MAX_CARS);
  private readonly colB = new Float32Array(MAX_CARS);
  private readonly scale = new Float32Array(MAX_CARS);
  /** 0 alive, 1 despawning. */
  private readonly leaving = new Uint8Array(MAX_CARS);
  private readonly yEntry = new Float32Array(MAX_CARS);
  private readonly yExit = new Float32Array(MAX_CARS);
  private readonly yCur = new Float32Array(MAX_CARS);
  /** Spacing scratch: per car next index in its lane bucket. */
  private readonly bucketNext = new Int32Array(MAX_CARS);
  private bucketHead = new Int32Array(0);

  private target = 0;
  private sinceStats = STATS_INTERVAL;
  private spawnAcc = 0;

  // Rendering.
  private readonly bodyMeshes: THREE.InstancedMesh[] = [];
  private readonly lightMeshes: THREE.InstancedMesh[] = [];
  private readonly beams: THREE.InstancedMesh;
  private readonly bodyMaterial: THREE.MeshLambertMaterial;
  private readonly lightMaterial: THREE.MeshBasicMaterial;
  private readonly beamMaterial: THREE.MeshBasicMaterial;
  private readonly tmpColor = new THREE.Color();

  constructor(parent: THREE.Object3D, city: CityReader, terrain: TerrainReader) {
    this.city = city;
    this.terrain = terrain;
    this.object.name = 'traffic';
    parent.add(this.object);

    this.bodyMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.lightMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0x777777 });
    this.beamMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    });

    const bodies = [carBoxes(), busBoxes(), truckBoxes()];
    for (let t = 0; t < TYPE_COUNT; t++) {
      const body = new THREE.InstancedMesh(mergeBoxes(bodies[t]), this.bodyMaterial, MAX_CARS);
      body.name = `traffic-body-${t}`;
      body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CARS * 3), 3);
      body.instanceColor.setUsage(THREE.DynamicDrawUsage);
      body.count = 0;
      body.frustumCulled = false;
      body.castShadow = true;
      body.receiveShadow = true;
      this.bodyMeshes.push(body);
      const lights = new THREE.InstancedMesh(mergeBoxes(lightBoxes(t), false), this.lightMaterial, MAX_CARS);
      lights.name = `traffic-lights-${t}`;
      lights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      lights.count = 0;
      lights.frustumCulled = false;
      this.lightMeshes.push(lights);
      this.object.add(body, lights);
    }
    this.beams = new THREE.InstancedMesh(beamGeometry(), this.beamMaterial, MAX_CARS);
    this.beams.name = 'traffic-beams';
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 2;
    this.beams.visible = false;
    this.object.add(this.beams);
  }

  get carCount(): number {
    return this.count;
  }

  markNetworkDirty(): void {
    this.dirty = true;
  }

  /** speedFactor: 0 = frozen; nightFactor: 0..1 for lights. */
  update(dt: number, speedFactor: number, nightFactor: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
    const sf = Number.isFinite(speedFactor) ? Math.max(0, Math.min(2, speedFactor)) : 0;
    const night = clamp01(Number.isFinite(nightFactor) ? nightFactor : 0);

    this.sinceRebuild += dt;
    if (this.dirty && this.sinceRebuild >= REBUILD_INTERVAL) this.rebuildGraph();

    this.sinceStats += dt;
    if (this.sinceStats >= STATS_INTERVAL) {
      this.sinceStats = 0;
      this.target = this.computeTarget();
    }

    const simDt = dt * sf;
    if (simDt > 0) {
      this.manageCount(simDt);
      this.step(simDt);
    }
    this.writeInstances(night);
  }

  reset(): void {
    this.count = 0;
    this.spawnAcc = 0;
    this.dirty = true;
    this.sinceRebuild = REBUILD_INTERVAL;
    this.sinceStats = STATS_INTERVAL;
    for (const m of this.bodyMeshes) m.count = 0;
    for (const m of this.lightMeshes) m.count = 0;
    this.beams.count = 0;
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const m of this.bodyMeshes) {
      m.geometry.dispose();
      m.dispose();
    }
    for (const m of this.lightMeshes) {
      m.geometry.dispose();
      m.dispose();
    }
    this.beams.geometry.dispose();
    this.beams.dispose();
    this.bodyMaterial.dispose();
    this.lightMaterial.dispose();
    this.beamMaterial.dispose();
  }

  // ------------------------------------------------------------------ graph

  private rebuildGraph(): void {
    this.dirty = false;
    this.sinceRebuild = 0;
    const n = Math.max(0, Math.floor(this.city.mapTiles) || 0);
    if (n !== this.mapTiles) {
      this.mapTiles = n;
      this.mask = new Uint8Array(n * n);
      this.isRoad = new Uint8Array(n * n);
      this.heights = new Float32Array(n * n);
      this.zoneHint = new Uint8Array(n * n);
      this.bucketHead = new Int32Array(n * n * 4).fill(-1);
    }
    const spawn: number[] = [];
    let roads = 0;
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        const i = tz * n + tx;
        const road = this.city.getTileKind(tx, tz) === TileKind.Road;
        this.isRoad[i] = road ? 1 : 0;
        if (!road) {
          this.mask[i] = 0;
          continue;
        }
        roads++;
        this.mask[i] = this.city.getRoadMask(tx, tz) & 15;
        this.heights[i] = roadSurfaceY(this.terrain, tx, tz);
        let hint = 0;
        let nearBuilding = tx === 0 || tz === 0 || tx === n - 1 || tz === n - 1;
        for (let d = 0; d < 4; d++) {
          const nx = tx + DIR_DX[d];
          const nz = tz + DIR_DZ[d];
          if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
          if (this.city.getTileKind(nx, nz) === TileKind.Civic) nearBuilding = true;
          if (this.city.getBuildingIdAt(nx, nz) !== 0) {
            nearBuilding = true;
            const z = this.city.getZone(nx, nz);
            if (z > hint) hint = z;
          }
        }
        this.zoneHint[i] = hint;
        if (nearBuilding && this.mask[i] !== 0) spawn.push(i);
      }
    }
    this.spawnTiles = spawn;
    this.roadTileCount = roads;

    // Validate existing cars against the new network.
    for (let c = this.count - 1; c >= 0; c--) {
      const t = this.tile[c];
      if (t < 0 || t >= this.isRoad.length || this.isRoad[t] === 0) {
        this.removeCar(c);
        continue;
      }
      const m = this.mask[t];
      if ((m & DIR_BIT[this.dOut[c]]) === 0) {
        // Planned exit vanished: re-plan from the same entry.
        const e = this.chooseExit(this.dIn[c], m);
        if (pathKind(this.dIn[c], e) !== pathKind(this.dIn[c], this.dOut[c]) && this.s[c] > 2.2) {
          // Too far along to switch smoothly: snap back to a consistent point on the new path.
          this.s[c] = Math.min(this.s[c], 2.2);
        }
        this.dOut[c] = e;
        this.refreshHeights(c);
      } else {
        this.refreshHeights(c);
      }
    }
    if (this.target > this.maxCarsForNetwork()) this.target = this.maxCarsForNetwork();
  }

  private maxCarsForNetwork(): number {
    return Math.min(MAX_CARS, Math.floor(this.roadTileCount * 0.35));
  }

  private computeTarget(): number {
    let pop = 0;
    let jobs = 0;
    try {
      const st = this.city.getStats();
      pop = Number.isFinite(st.population) ? st.population : 0;
      jobs = Number.isFinite(st.jobsTotal) ? st.jobsTotal : 0;
    } catch {
      // Stats unavailable — keep a tiny baseline.
    }
    if (this.roadTileCount === 0) return 0;
    return Math.max(0, Math.floor(Math.min(this.maxCarsForNetwork(), 3 + (pop + jobs) / 25)));
  }

  private chooseExit(d: number, m: number): number {
    const back = (d + 2) & 3;
    let options = 0;
    let n = 0;
    for (let e = 0; e < 4; e++) {
      if (e !== back && (m & DIR_BIT[e]) !== 0) {
        options |= 1 << e;
        n++;
      }
    }
    if (n === 0) return back;
    // Prefer going straight a bit more often.
    if ((options & (1 << d)) !== 0 && this.rng.chance(0.35)) return d;
    let k = this.rng.int(0, n);
    for (let e = 0; e < 4; e++) {
      if ((options & (1 << e)) !== 0) {
        if (k === 0) return e;
        k--;
      }
    }
    return back;
  }

  private heightOrSelf(t: number, tx: number, tz: number, self: number): number {
    if (tx < 0 || tz < 0 || tx >= this.mapTiles || tz >= this.mapTiles) return self;
    return this.isRoad[t] !== 0 ? this.heights[t] : self;
  }

  private refreshHeights(c: number): void {
    const n = this.mapTiles;
    const t = this.tile[c];
    const tx = t % n;
    const tz = (t - tx) / n;
    const h = this.heights[t];
    const d = this.dIn[c];
    const e = this.dOut[c];
    const px = tx - DIR_DX[d];
    const pz = tz - DIR_DZ[d];
    const nx = tx + DIR_DX[e];
    const nz = tz + DIR_DZ[e];
    this.yCur[c] = h;
    this.yEntry[c] = (h + this.heightOrSelf(pz * n + px, px, pz, h)) * 0.5;
    this.yExit[c] = e === ((d + 2) & 3) ? this.yEntry[c] : (h + this.heightOrSelf(nz * n + nx, nx, nz, h)) * 0.5;
  }

  // ------------------------------------------------------------------ population

  private manageCount(simDt: number): void {
    const alive = this.count - this.countLeaving();
    if (alive < this.target && this.spawnTiles.length > 0) {
      const deficit = this.target - alive;
      this.spawnAcc += simDt * Math.min(12, 1.5 + deficit * 0.25);
      while (this.spawnAcc >= 1 && this.count < MAX_CARS) {
        this.spawnAcc -= 1;
        this.spawnCar();
      }
      if (this.spawnAcc > 1) this.spawnAcc = 1;
    } else {
      this.spawnAcc = 0;
      if (alive > this.target) {
        // Despawn a few at random per second.
        let toRemove = Math.min(alive - this.target, Math.max(1, Math.round(simDt * 4)));
        for (let tries = 0; tries < 8 && toRemove > 0 && this.count > 0; tries++) {
          const c = this.rng.int(0, this.count);
          if (this.leaving[c] === 0) {
            this.leaving[c] = 1;
            toRemove--;
          }
        }
      }
    }
  }

  private countLeaving(): number {
    let k = 0;
    for (let c = 0; c < this.count; c++) k += this.leaving[c];
    return k;
  }

  private spawnCar(): void {
    const tiles = this.spawnTiles;
    const t = tiles[this.rng.int(0, tiles.length)];
    const m = this.mask[t];
    if (m === 0) return;
    // Travel direction: one of the connected directions.
    let k = this.rng.int(0, 4);
    let d = 0;
    for (let i = 0; i < 4; i++) {
      const cand = (k + i) & 3;
      if ((m & DIR_BIT[cand]) !== 0) {
        d = cand;
        break;
      }
    }
    const c = this.count++;
    this.tile[c] = t;
    this.dIn[c] = d;
    this.dOut[c] = this.chooseExit(d, m);
    this.s[c] = Math.min(PATH_LEN[d * 4 + this.dOut[c]] * 0.5, 2 + this.rng.next() * 2);
    const hint = this.zoneHint[t];
    let type = TYPE_CAR;
    const r = this.rng.next();
    if (hint === ZoneType.Industrial && r < 0.35) type = TYPE_TRUCK;
    else if (hint === ZoneType.Commercial && r < 0.12) type = TYPE_BUS;
    else if (hint === ZoneType.Commercial && r < 0.2) type = TYPE_TRUCK;
    else if (r < 0.03) type = TYPE_BUS;
    this.type[c] = type;
    const palette = type === TYPE_CAR ? CAR_COLORS : type === TYPE_BUS ? BUS_COLORS : TRUCK_COLORS;
    this.tmpColor.setHex(palette[this.rng.int(0, palette.length)]);
    this.colR[c] = this.tmpColor.r;
    this.colG[c] = this.tmpColor.g;
    this.colB[c] = this.tmpColor.b;
    const base = type === TYPE_CAR ? this.rng.range(6.5, 9) : this.rng.range(5.5, 7);
    this.cruise[c] = base;
    this.speed[c] = base * 0.5;
    this.scale[c] = 0;
    this.leaving[c] = 0;
    this.refreshHeights(c);
  }

  private removeCar(c: number): void {
    const last = --this.count;
    if (c === last || last < 0) return;
    this.tile[c] = this.tile[last];
    this.dIn[c] = this.dIn[last];
    this.dOut[c] = this.dOut[last];
    this.s[c] = this.s[last];
    this.speed[c] = this.speed[last];
    this.cruise[c] = this.cruise[last];
    this.type[c] = this.type[last];
    this.colR[c] = this.colR[last];
    this.colG[c] = this.colG[last];
    this.colB[c] = this.colB[last];
    this.scale[c] = this.scale[last];
    this.leaving[c] = this.leaving[last];
    this.yEntry[c] = this.yEntry[last];
    this.yExit[c] = this.yExit[last];
    this.yCur[c] = this.yCur[last];
  }

  // ------------------------------------------------------------------ simulation step

  private step(dt: number): void {
    const n = this.mapTiles;
    if (n === 0) {
      this.count = 0;
      return;
    }
    const head = this.bucketHead;
    // Build lane buckets (tile*4 + entry dir).
    for (let c = 0; c < this.count; c++) {
      const key = this.tile[c] * 4 + this.dIn[c];
      this.bucketNext[c] = head[key];
      head[key] = c;
    }

    for (let c = 0; c < this.count; c++) {
      // Gap to the car ahead in the same lane.
      const t = this.tile[c];
      const d = this.dIn[c];
      const e = this.dOut[c];
      const myS = this.s[c];
      const myLen = PATH_LEN[d * 4 + e];
      const half = TYPE_HALF_LEN[this.type[c]];
      let gap = 1e9;
      for (let o = head[t * 4 + d]; o >= 0; o = this.bucketNext[o]) {
        if (o === c) continue;
        const ds = this.s[o] - myS;
        if (ds > 0 && ds < gap && this.dOut[o] === e) gap = ds - TYPE_HALF_LEN[this.type[o]] - half;
        else if (ds > 0 && ds < 3.5 && ds - half < gap) gap = ds - half - 1; // turning car still in front
      }
      if (myLen - myS < 8) {
        const tx = t % n;
        const tz = (t - tx) / n;
        const nx = tx + DIR_DX[e];
        const nz = tz + DIR_DZ[e];
        if (nx >= 0 && nz >= 0 && nx < n && nz < n) {
          for (let o = head[(nz * n + nx) * 4 + e]; o >= 0; o = this.bucketNext[o]) {
            const ds = myLen - myS + this.s[o];
            const g = ds - TYPE_HALF_LEN[this.type[o]] - half;
            if (g < gap) gap = g;
          }
        }
      }
      let targetV = this.cruise[c];
      if (gap < 6) targetV *= smoothstep(0.6, 6, gap);
      if (this.leaving[c] !== 0) targetV *= 0.6;
      // Slow down slightly in turns.
      if (pathKind(d, e) !== 0) targetV *= 0.7;
      const v = this.speed[c];
      this.speed[c] = targetV < v ? Math.max(targetV, v - 14 * dt) : Math.min(targetV, v + 4 * dt);

      // Spawn / despawn scaling.
      if (this.leaving[c] !== 0) this.scale[c] = Math.max(0, this.scale[c] - dt / SPAWN_TIME);
      else if (this.scale[c] < 1) this.scale[c] = Math.min(1, this.scale[c] + dt / SPAWN_TIME);
    }

    // Clear buckets (only keys we touched).
    for (let c = 0; c < this.count; c++) head[this.tile[c] * 4 + this.dIn[c]] = -1;

    // Advance; handle tile transitions and removals.
    for (let c = this.count - 1; c >= 0; c--) {
      if (this.leaving[c] !== 0 && this.scale[c] <= 0) {
        this.removeCar(c);
        continue;
      }
      let s = this.s[c] + this.speed[c] * dt;
      let guard = 0;
      while (s >= PATH_LEN[this.dIn[c] * 4 + this.dOut[c]] && guard++ < 3) {
        s -= PATH_LEN[this.dIn[c] * 4 + this.dOut[c]];
        const t = this.tile[c];
        const tx = t % n;
        const tz = (t - tx) / n;
        const e = this.dOut[c];
        const nx = tx + DIR_DX[e];
        const nz = tz + DIR_DZ[e];
        const nt = nz * n + nx;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n || this.isRoad[nt] === 0) {
          // Leaving the map or the network (graph not rebuilt yet): vanish rather than drive off-road.
          s = -1;
          break;
        }
        this.tile[c] = nt;
        this.dIn[c] = e;
        this.dOut[c] = this.chooseExit(e, this.mask[nt]);
        this.refreshHeights(c);
      }
      if (s < 0) {
        this.removeCar(c);
        continue;
      }
      this.s[c] = s;
    }
  }

  // ------------------------------------------------------------------ rendering

  private writeInstances(night: number): void {
    const n = this.mapTiles;
    const counts = [0, 0, 0];
    const beamArr = this.beams.instanceMatrix.array as Float32Array;
    const showBeams = night > 0.05;
    let beamCount = 0;
    for (let c = 0; c < this.count; c++) {
      const t = this.tile[c];
      const tx = t % n;
      const tz = (t - tx) / n;
      const d = this.dIn[c];
      const e = this.dOut[c];
      const s = this.s[c];
      const len = PATH_LEN[d * 4 + e];
      evalPath(d, e, s);
      const x = tileCenter(tx) + P.x;
      const z = tileCenter(tz) + P.z;
      let y = this.yCur[c];
      if (s < 2) y = this.yEntry[c] + (y - this.yEntry[c]) * smoothstep(-2, 2, s);
      else if (s > len - 2) y = y + (this.yExit[c] - y) * smoothstep(len - 2, len + 2, s);
      const yaw = Math.atan2(P.hx, P.hz);
      const sc = this.scale[c];
      const type = this.type[c];
      const i = counts[type]++;
      const body = this.bodyMeshes[type];
      writeInstanceMatrix(body.instanceMatrix.array as Float32Array, i, x, y, z, yaw, sc, sc, sc);
      writeInstanceMatrix(this.lightMeshes[type].instanceMatrix.array as Float32Array, i, x, y, z, yaw, sc, sc, sc);
      const ca = body.instanceColor!.array as Float32Array;
      ca[i * 3] = this.colR[c];
      ca[i * 3 + 1] = this.colG[c];
      ca[i * 3 + 2] = this.colB[c];
      if (showBeams) {
        const f = TYPE_HALF_LEN[type];
        writeInstanceMatrix(beamArr, beamCount++, x + P.hx * f, y, z + P.hz * f, yaw, sc, 1, sc);
      }
    }
    for (let t = 0; t < TYPE_COUNT; t++) {
      const body = this.bodyMeshes[t];
      const lights = this.lightMeshes[t];
      body.count = counts[t];
      lights.count = counts[t];
      if (counts[t] > 0) {
        body.instanceMatrix.needsUpdate = true;
        body.instanceColor!.needsUpdate = true;
        lights.instanceMatrix.needsUpdate = true;
        body.instanceMatrix.clearUpdateRanges();
        body.instanceMatrix.addUpdateRange(0, counts[t] * 16);
        body.instanceColor!.clearUpdateRanges();
        body.instanceColor!.addUpdateRange(0, counts[t] * 3);
        lights.instanceMatrix.clearUpdateRanges();
        lights.instanceMatrix.addUpdateRange(0, counts[t] * 16);
      }
      body.visible = counts[t] > 0;
      lights.visible = counts[t] > 0;
    }
    this.beams.count = beamCount;
    this.beams.visible = showBeams && beamCount > 0;
    if (beamCount > 0) {
      this.beams.instanceMatrix.needsUpdate = true;
      this.beams.instanceMatrix.clearUpdateRanges();
      this.beams.instanceMatrix.addUpdateRange(0, beamCount * 16);
    }
    // Lights: dull by day, glowing at night.
    const k = 0.42 + 0.58 * night;
    this.lightMaterial.color.setRGB(k, k, k);
    this.beamMaterial.opacity = 0.45 * smoothstep(0.05, 0.7, night);
  }
}
