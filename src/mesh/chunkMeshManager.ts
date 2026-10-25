/**
 * MODULE: meshing — main-thread chunk mesh manager (worker pool + geometry swapping).
 * Owner: meshing agent. Implements IChunkMeshManager (src/types.ts).
 *
 * Design:
 *  - Worker pool: N = deps.workerCount ?? clamp((navigator.hardwareConcurrency || 4) - 1, 1, 4)
 *    workers via `new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })`.
 *    If the Worker API is missing, construction throws, workerCount is 0, or every worker has died
 *    (a worker 'error' event, a failed postMessage, or overdue jobs in two consecutive timeout
 *    checks mark it dead; its in-flight chunks are requeued), chunks are meshed synchronously on
 *    the main thread with greedyMesh() under a per-frame time budget (~4 ms; more while a bulk
 *    rebuild runs behind the loading overlay). Logged once. Long gaps between update() calls
 *    (hidden tab, sleep, blocked main thread) restart the job clocks, so they never cause timeouts.
 *  - update(camera, focus):
 *      1. world.takeDirtyChunks() → pending set (dense list + position index, no Set). Chunks that are
 *         empty (world.isChunkEmpty) lose their meshes immediately and never enter the queue.
 *      2. Priorities: squared distance from `focus` to the chunk centre, + a large penalty when the
 *         chunk box is outside the camera frustum (computed once per frame, reused objects).
 *      3. Dispatch while some live worker has < 2 jobs in flight: nearest pending chunk not already
 *         in flight → world.extractPadded() into a pooled 34³ buffer → MeshRequest{ jobId, key,
 *         version, voxels } with the buffer transferred. Never two jobs per chunk: a chunk re-dirtied
 *         while in flight stays pending and is sent again after its result lands. Results refill
 *         the workers directly from the 'message' handler (no waiting for the next frame), using the
 *         priorities of the last update(). Inside update(), a worker's second (prefetch) job is only
 *         sent while the frame budget below lasts; an idle worker always gets one.
 *      4. Results wait in a FIFO (one slot per chunk; a newer result replaces an unapplied older
 *         one) and are applied in update() under an upload budget: ≤ 24 results / ~2 ms / ~4 MB per
 *         frame normally, ≤ 64 / ~5 ms / 16 MB while a large backlog (> 96 chunks) is pending, and
 *         ≤ 256 / ~14 ms / 64 MB during a bulk rebuild (rebuildAll() until idle: the loading overlay).
 *         The time budget counts from the start of update() (intake + dispatch included); at least
 *         one result is applied per frame, so progress never stalls.
 *         Applying = buildChunkGeometry + swap into the chunk's Mesh (created on first use:
 *         name `chunk:${cx},${cy},${cz}`, position = chunk origin, matrixAutoUpdate = false,
 *         opaque casts + receives shadows, water only receives); old geometries are disposed, meshes
 *         whose pass became empty are removed.
 *      5. Ordering: every job / emptiness decision consumes a sequence number; a result is applied
 *         only if it is newer than what the chunk currently shows. Results older than the chunk's
 *         current world version are still applied (better than nothing — the chunk is pending again).
 *      6. MeshError: retry once per (chunk, version), then keep the previous mesh for that version.
 *  - rebuildAll(): world.markAllDirty() and the dirty keys are pulled into the queue immediately, so
 *    `idle` is false right after the call (unless the world is completely empty).
 *  - idle: nothing pending, nothing in flight, no unapplied results.
 *  - getStats(): `queued` counts chunks waiting for meshing or for upload (pending + unapplied).
 *  - dispose(): terminates workers (late messages are ignored), disposes geometries + materials,
 *    removes meshes. Every method is a no-op afterwards.
 * Per-frame cost when idle: a takeDirtyChunks() call and a few comparisons; no allocations here.
 */
import * as THREE from 'three';
import {
  BASE_GROUND_HEIGHT,
  CHUNK_COUNT,
  CHUNK_SIZE,
  PADDED_VOLUME,
  WORLD_SIZE_X,
  WORLD_SIZE_Z,
  type ChunkMeshManagerDeps,
  type IChunkMeshManager,
  type IVoxelWorld,
  type MeshStats,
} from '../types';
import { chunkCoordsFromKey, type ChunkCoord } from '../core/coords';
import { clamp, errorMessage } from '../core/util';
import { greedyMesh } from './greedy';
import { buildChunkGeometry, createChunkMaterials, meshBufferBytes, type ChunkMaterials } from './materials';
import type { ChunkMeshData, MeshBuffers, MeshRequest, WorkerResponse } from './protocol';

/** Max jobs queued in one worker at a time. */
const MAX_JOBS_PER_WORKER = 2;
/** Upper bound for an explicit deps.workerCount. */
const MAX_WORKERS = 8;
/**
 * A job without an answer for this long is considered lost: it is requeued and its worker becomes
 * suspect (gets no new jobs while a healthy worker is alive). Any answer clears the suspicion; a
 * worker that also lets the jobs of a second check time out is terminated.
 */
const JOB_TIMEOUT_MS = 20_000;
const TIMEOUT_CHECK_INTERVAL_MS = 1_000;
const MAX_TIMEOUT_CHECKS = 2;
/**
 * A gap this long between two update() calls means the page was hidden, the machine slept or the
 * main thread was blocked (e.g. city generation): the clocks of in-flight jobs restart instead of
 * letting every one of them time out at once.
 */
const RESUME_GAP_MS = 2_000;
const MAX_POOLED_BUFFERS = 16;
/** Added to the squared distance of chunks outside the view frustum (> any in-world distance²). */
const OUT_OF_VIEW_PENALTY = 1e7;
/** Samples in the rolling average of meshing times. */
const MS_WINDOW = 64;

const MB = 1024 * 1024;
/**
 * Per-frame upload budgets (results applied, ms spent applying, bytes handed to the GPU), by tier:
 * 0 = normal play (keeps update() ≤ ~2 ms), 1 = a large backlog during play, 2 = bulk rebuild
 * (rebuildAll(), which runs behind the loading overlay and should finish fast).
 */
const UPLOAD_MAX_RESULTS: readonly number[] = [24, 64, 256];
const UPLOAD_MAX_MS: readonly number[] = [2, 5, 14];
const UPLOAD_MAX_BYTES: readonly number[] = [4 * MB, 16 * MB, 64 * MB];
/** Backlog (pending + in flight + unapplied chunks) above which tier 1 applies during play. */
const LARGE_BACKLOG = 96;
/** Main-thread fallback meshing budget per frame, by the same tiers. */
const SYNC_MAX_MS: readonly number[] = [4, 6, 16];

interface WorkerSlot {
  readonly index: number;
  worker: Worker | null;
  alive: boolean;
  inFlight: number;
  /** Timeout checks in a row in which this worker had overdue jobs (reset by any answer). */
  timeouts: number;
  /** Scratch flag of checkTimeouts(). */
  overdue: boolean;
  readonly onMessage: (ev: MessageEvent<WorkerResponse>) => void;
  readonly onError: (ev: ErrorEvent) => void;
  readonly onMessageError: (ev: MessageEvent) => void;
}

/** A finished mesh waiting for upload (MeshResult minus the voxel buffer, which is pooled at once). */
interface ReadyMesh {
  jobId: number;
  version: number;
  mesh: ChunkMeshData;
}

function resolveWorkerCount(requested: number | undefined): number {
  if (typeof requested === 'number' && Number.isFinite(requested)) return clamp(Math.floor(requested), 0, MAX_WORKERS);
  const hc =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 0
      ? navigator.hardwareConcurrency
      : 4;
  return clamp(hc - 1, 1, 4);
}

function validBuffers(b: MeshBuffers): boolean {
  if (!b || typeof b !== 'object') return false;
  const vc = b.vertexCount;
  const ic = b.indexCount;
  return (
    Number.isInteger(vc) &&
    Number.isInteger(ic) &&
    vc > 0 &&
    ic > 0 &&
    ic % 3 === 0 &&
    b.positions instanceof Float32Array &&
    b.positions.length === vc * 3 &&
    b.normals instanceof Int8Array &&
    b.normals.length === vc * 3 &&
    b.colors instanceof Uint8Array &&
    b.colors.length === vc * 3 &&
    b.emissive instanceof Uint8Array &&
    b.emissive.length === vc * 3 &&
    (b.indices instanceof Uint16Array || b.indices instanceof Uint32Array) &&
    b.indices.length === ic
  );
}

function validMesh(mesh: ChunkMeshData): boolean {
  if (!mesh || typeof mesh !== 'object') return false;
  return (mesh.opaque === null || validBuffers(mesh.opaque)) && (mesh.transparent === null || validBuffers(mesh.transparent));
}

export class ChunkMeshManager implements IChunkMeshManager {
  private readonly world: IVoxelWorld;
  private readonly parent: THREE.Object3D;
  private readonly materials: ChunkMaterials;
  private readonly slots: WorkerSlot[] = [];
  private fallback = false;
  private disposed = false;
  /** Set by rebuildAll(); cleared once idle. Enables the bulk budgets. */
  private bulk = false;

  // ---- pending set: dense list + position index (-1 = not pending)
  private readonly pendingList = new Int32Array(CHUNK_COUNT);
  private readonly pendingPos = new Int32Array(CHUNK_COUNT).fill(-1);
  private pendingCount = 0;
  private readonly score = new Float64Array(CHUNK_COUNT);

  // ---- in flight (per chunk): job id (0 = none), worker slot, send time
  private readonly jobOf = new Float64Array(CHUNK_COUNT);
  private readonly workerOf = new Int16Array(CHUNK_COUNT).fill(-1);
  private readonly sentAt = new Float64Array(CHUNK_COUNT);
  private inFlight = 0;

  // ---- finished meshes waiting for upload: one slot per chunk + FIFO ring of keys
  private readonly ready: (ReadyMesh | null)[] = new Array<ReadyMesh | null>(CHUNK_COUNT).fill(null);
  private readonly readyQueue = new Int32Array(CHUNK_COUNT);
  private readyHead = 0;
  private readyCount = 0;

  // ---- what each chunk shows
  /** Sequence number of the job / emptiness decision the chunk currently shows. */
  private readonly appliedSeq = new Float64Array(CHUNK_COUNT);
  /** Version already retried after a MeshError (-1 = none). */
  private readonly retriedVersion = new Float64Array(CHUNK_COUNT).fill(-1);
  private readonly opaqueMeshes: (THREE.Mesh | null)[] = new Array<THREE.Mesh | null>(CHUNK_COUNT).fill(null);
  private readonly waterMeshes: (THREE.Mesh | null)[] = new Array<THREE.Mesh | null>(CHUNK_COUNT).fill(null);
  private readonly chunkTris = new Float64Array(CHUNK_COUNT);
  private seq = 0;
  private meshCount = 0;
  private triangles = 0;

  // ---- stats
  private meshedTotal = 0;
  private readonly msRing = new Float64Array(MS_WINDOW);
  private msNext = 0;
  private msFilled = 0;
  private msSum = 0;

  // ---- view (priorities)
  private readonly focus = new THREE.Vector3(WORLD_SIZE_X / 2, BASE_GROUND_HEIGHT, WORLD_SIZE_Z / 2);
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private frustumValid = false;

  // ---- scratch
  private readonly coord: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
  private readonly scoreCoord: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
  private readonly pool: Uint8Array[] = [];
  private syncBuffer: Uint8Array | null = null;
  private lastTimeoutCheck = 0;
  private lastUpdateAt = -1;
  private readonly warned = new Set<string>();

  constructor(deps: ChunkMeshManagerDeps) {
    this.world = deps.world;
    this.parent = deps.parent;
    this.materials = createChunkMaterials();
    const n = resolveWorkerCount(deps.workerCount);
    if (n > 0) this.spawnWorkers(n);
    if (this.aliveWorkers() === 0) {
      this.enterFallback(n === 0 ? 'workerCount is 0' : 'Web Workers are unavailable');
    }
  }

  // ------------------------------------------------------------------ IChunkMeshManager

  update(camera: THREE.Camera, focus: THREE.Vector3): void {
    if (this.disposed) return;
    try {
      // The clock is only read while there is work: an idle update allocates nothing. The frame
      // budget counts from here, so intake + dispatch time is part of it.
      let start = -1;
      if (this.pendingCount > 0 || this.inFlight > 0 || this.readyCount > 0) {
        start = performance.now();
        if (this.inFlight > 0 && this.lastUpdateAt >= 0 && start - this.lastUpdateAt > RESUME_GAP_MS) {
          this.restartJobClocks(start);
        }
      }
      this.intakeDirty();
      if (this.pendingCount > 0) {
        if (start < 0) start = performance.now();
        this.updateView(camera, focus);
        this.rescorePending();
      }
      const tier = this.budgetTier();
      if (this.fallback) this.meshOnMainThread(SYNC_MAX_MS[tier]);
      else if (this.pendingCount > 0) this.dispatchJobs(start + UPLOAD_MAX_MS[tier]);
      if (this.readyCount > 0) this.applyReady(tier, start);
      if (this.inFlight > 0) {
        const now = performance.now();
        this.checkTimeouts(now);
        this.lastUpdateAt = now;
      } else {
        this.lastUpdateAt = -1;
      }
      if (this.bulk && this.idle) this.bulk = false;
    } catch (err) {
      this.warnOnce('update', 'update() failed', err);
    }
  }

  rebuildAll(): void {
    if (this.disposed) return;
    try {
      this.world.markAllDirty();
    } catch (err) {
      this.warnOnce('markAllDirty', 'world.markAllDirty() failed', err);
    }
    this.intakeDirty();
    this.bulk = true;
  }

  get idle(): boolean {
    return this.pendingCount === 0 && this.inFlight === 0 && this.readyCount === 0;
  }

  getStats(): MeshStats {
    return {
      meshes: this.meshCount,
      triangles: this.triangles,
      queued: this.pendingCount + this.readyCount,
      inFlight: this.inFlight,
      workers: this.fallback ? 0 : this.aliveWorkers(),
      avgMeshMs: this.msFilled > 0 ? this.msSum / this.msFilled : 0,
      meshedTotal: this.meshedTotal,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) this.releaseWorker(slot);
    for (let key = 0; key < CHUNK_COUNT; key++) this.removeChunkMeshes(key);
    this.materials.dispose();
    this.pendingPos.fill(-1);
    this.pendingCount = 0;
    this.jobOf.fill(0);
    this.workerOf.fill(-1);
    this.inFlight = 0;
    this.ready.fill(null);
    this.readyCount = 0;
    this.readyHead = 0;
    this.pool.length = 0;
    this.syncBuffer = null;
  }

  // ------------------------------------------------------------------ workers

  private spawnWorkers(n: number): void {
    if (typeof Worker === 'undefined') return;
    for (let i = 0; i < n; i++) {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
      } catch (err) {
        this.warnOnce('spawn', 'could not start a mesher worker', err);
        return;
      }
      const index = this.slots.length;
      const slot: WorkerSlot = {
        index,
        worker,
        alive: true,
        inFlight: 0,
        timeouts: 0,
        overdue: false,
        onMessage: (ev) => this.onWorkerMessage(slot, ev),
        onError: (ev) => this.onWorkerError(slot, ev),
        onMessageError: () => this.warnOnce('messageerror', 'a mesher worker reply could not be deserialized'),
      };
      worker.addEventListener('message', slot.onMessage);
      worker.addEventListener('error', slot.onError);
      worker.addEventListener('messageerror', slot.onMessageError);
      this.slots.push(slot);
    }
  }

  private aliveWorkers(): number {
    let n = 0;
    for (const slot of this.slots) if (slot.alive) n++;
    return n;
  }

  private enterFallback(reason: string): void {
    if (this.fallback) return;
    this.fallback = true;
    console.warn(`[meshes] ${reason}: meshing chunks on the main thread`);
  }

  /** Detaches listeners and terminates the worker (no requeue). */
  private releaseWorker(slot: WorkerSlot): void {
    slot.alive = false;
    const w = slot.worker;
    slot.worker = null;
    if (!w) return;
    w.removeEventListener('message', slot.onMessage);
    w.removeEventListener('error', slot.onError);
    w.removeEventListener('messageerror', slot.onMessageError);
    try {
      w.terminate();
    } catch {
      // already gone
    }
  }

  /** Marks a worker dead, requeues its in-flight chunks, falls back when none is left. */
  private killWorker(slot: WorkerSlot, reason: string): void {
    if (!slot.alive) return;
    this.releaseWorker(slot);
    for (let key = 0; key < CHUNK_COUNT; key++) {
      if (this.workerOf[key] !== slot.index) continue;
      this.workerOf[key] = -1;
      this.jobOf[key] = 0;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.addPending(key);
    }
    slot.inFlight = 0;
    const left = this.aliveWorkers();
    console.warn(`[meshes] mesher worker ${slot.index} ${reason}; ${left} worker(s) left`);
    if (left === 0) this.enterFallback('all mesher workers failed');
  }

  private onWorkerError(slot: WorkerSlot, ev: ErrorEvent): void {
    if (this.disposed || !slot.alive) return;
    try {
      ev.preventDefault();
    } catch {
      // not cancelable
    }
    const detail = ev && typeof ev.message === 'string' && ev.message !== '' ? `: ${ev.message}` : '';
    this.killWorker(slot, `failed${detail}`);
  }

  private onWorkerMessage(slot: WorkerSlot, ev: MessageEvent<WorkerResponse>): void {
    if (this.disposed || !slot.alive) return;
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    slot.timeouts = 0; // any answer (even a stale one) proves the worker is alive
    this.releaseBuffer(msg.voxels);
    const key = msg.key;
    const current =
      typeof key === 'number' &&
      key >= 0 &&
      key < CHUNK_COUNT &&
      this.jobOf[key] !== 0 &&
      this.jobOf[key] === msg.jobId &&
      this.workerOf[key] === slot.index;
    if (current) {
      this.jobOf[key] = 0;
      this.workerOf[key] = -1;
      slot.inFlight = Math.max(0, slot.inFlight - 1);
      this.inFlight = Math.max(0, this.inFlight - 1);
      if (msg.type === 'result') {
        this.meshedTotal++;
        this.recordMs(msg.ms);
        if (validMesh(msg.mesh)) this.pushReady(key, msg.jobId, msg.version, msg.mesh);
        else this.onJobError(key, msg.version, 'invalid mesh buffers');
      } else if (msg.type === 'error') {
        this.onJobError(key, msg.version, typeof msg.message === 'string' ? msg.message : 'unknown error');
      }
    }
    // stale replies (timed-out jobs) are ignored; either way the worker may have room now
    if (this.pendingCount > 0) this.dispatchJobs();
  }

  /**
   * The live worker with the fewest jobs, if it has room. Suspect workers (overdue jobs, no answer
   * since) only get jobs when no healthy worker is alive.
   */
  private freeSlot(): WorkerSlot | null {
    const slots = this.slots;
    let healthy = false;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].alive && slots[i].timeouts === 0) {
        healthy = true;
        break;
      }
    }
    let best: WorkerSlot | null = null;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot.alive || slot.inFlight >= MAX_JOBS_PER_WORKER) continue;
      if (healthy && slot.timeouts > 0) continue;
      if (!best || slot.inFlight < best.inFlight) best = slot;
    }
    return best;
  }

  /**
   * Fills free worker slots with the best pending chunks. Past `deadline` (a performance.now()
   * time) only workers with nothing in flight still get a job; the prefetched second jobs then
   * wait for the next result or frame.
   */
  private dispatchJobs(deadline = Infinity): void {
    while (this.pendingCount > 0 && !this.fallback && !this.disposed) {
      const slot = this.freeSlot();
      if (!slot) return;
      if (slot.inFlight > 0 && deadline !== Infinity && performance.now() >= deadline) return;
      const key = this.bestPending();
      if (key < 0) return;
      this.removePending(key);
      this.sendJob(slot, key);
    }
  }

  private sendJob(slot: WorkerSlot, key: number): void {
    const c = chunkCoordsFromKey(key, this.coord);
    const buf = this.takeBuffer();
    let nonEmpty: boolean;
    try {
      nonEmpty = this.world.extractPadded(c.cx, c.cy, c.cz, buf) !== false;
    } catch (err) {
      this.releaseBuffer(buf);
      this.warnOnce('extract', 'world.extractPadded() failed', err);
      return;
    }
    if (!nonEmpty) {
      this.releaseBuffer(buf);
      this.clearChunk(key);
      return;
    }
    const jobId = ++this.seq;
    const req: MeshRequest = { type: 'mesh', jobId, key, version: this.chunkVersion(key), voxels: buf };
    this.jobOf[key] = jobId;
    this.workerOf[key] = slot.index;
    this.sentAt[key] = performance.now();
    slot.inFlight++;
    this.inFlight++;
    try {
      slot.worker!.postMessage(req, [buf.buffer]);
    } catch (err) {
      this.jobOf[key] = 0;
      this.workerOf[key] = -1;
      slot.inFlight--;
      this.inFlight--;
      this.releaseBuffer(buf);
      this.addPending(key);
      this.killWorker(slot, `rejected a job (${errorMessage(err)})`);
    }
  }

  /**
   * Requeues jobs without an answer for JOB_TIMEOUT_MS. Each worker with overdue jobs counts one
   * timeout per check; MAX_TIMEOUT_CHECKS in a row (no answer in between) terminate it.
   */
  private checkTimeouts(now: number): void {
    if (now - this.lastTimeoutCheck < TIMEOUT_CHECK_INTERVAL_MS) return;
    this.lastTimeoutCheck = now;
    let any = false;
    for (let key = 0; key < CHUNK_COUNT; key++) {
      if (this.jobOf[key] === 0 || now - this.sentAt[key] < JOB_TIMEOUT_MS) continue;
      const slot = this.slots[this.workerOf[key]];
      this.jobOf[key] = 0;
      this.workerOf[key] = -1;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.addPending(key);
      if (slot) {
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        slot.overdue = true;
        any = true;
      }
    }
    if (!any) return;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.overdue) continue;
      slot.overdue = false;
      slot.timeouts++;
      if (slot.timeouts >= MAX_TIMEOUT_CHECKS) this.killWorker(slot, 'stopped responding');
      else if (slot.alive) this.warnOnce(`slow:${slot.index}`, `mesher worker ${slot.index} is not answering; its jobs were requeued`);
    }
    if (this.pendingCount > 0 && !this.fallback) this.dispatchJobs();
  }

  /** After a long gap between frames (hidden page, sleep, blocked main thread): restart job clocks. */
  private restartJobClocks(now: number): void {
    for (let key = 0; key < CHUNK_COUNT; key++) if (this.jobOf[key] !== 0 && this.sentAt[key] < now) this.sentAt[key] = now;
  }

  private onJobError(key: number, version: number, message: string): void {
    if (this.retriedVersion[key] !== version) {
      this.retriedVersion[key] = version;
      this.addPending(key);
    } else {
      this.warnOnce(`job:${key}`, `chunk ${key} (version ${version}) failed twice, keeping its previous mesh: ${message}`);
    }
  }

  // ------------------------------------------------------------------ main-thread fallback

  /** Meshes pending chunks synchronously (nearest first) until the time budget is spent. */
  private meshOnMainThread(budgetMs: number): void {
    const t0 = performance.now();
    let first = true;
    while (this.pendingCount > 0) {
      if (!first && performance.now() - t0 >= budgetMs) return;
      first = false;
      const key = this.bestPending();
      if (key < 0) return;
      this.removePending(key);
      const c = chunkCoordsFromKey(key, this.coord);
      const buf = this.syncBuffer ?? (this.syncBuffer = new Uint8Array(PADDED_VOLUME));
      let nonEmpty: boolean;
      try {
        nonEmpty = this.world.extractPadded(c.cx, c.cy, c.cz, buf) !== false;
      } catch (err) {
        this.warnOnce('extract', 'world.extractPadded() failed', err);
        continue;
      }
      if (!nonEmpty) {
        this.clearChunk(key);
        continue;
      }
      const version = this.chunkVersion(key);
      const tm = performance.now();
      let mesh: ChunkMeshData;
      try {
        mesh = greedyMesh(buf);
      } catch (err) {
        this.onJobError(key, version, errorMessage(err));
        continue;
      }
      this.recordMs(performance.now() - tm);
      this.meshedTotal++;
      this.appliedSeq[key] = ++this.seq;
      this.applyMesh(key, mesh);
    }
  }

  // ------------------------------------------------------------------ pending set + priorities

  private intakeDirty(): void {
    let keys: number[];
    try {
      keys = this.world.takeDirtyChunks();
    } catch (err) {
      this.warnOnce('takeDirty', 'world.takeDirtyChunks() failed', err);
      return;
    }
    if (!keys) return;
    for (let i = 0; i < keys.length; i++) this.intake(keys[i]);
  }

  private intake(key: number): void {
    if (!Number.isInteger(key) || key < 0 || key >= CHUNK_COUNT) return;
    const c = chunkCoordsFromKey(key, this.coord);
    let empty = false;
    try {
      empty = this.world.isChunkEmpty(c.cx, c.cy, c.cz);
    } catch {
      empty = false;
    }
    if (empty) {
      this.removePending(key);
      this.clearChunk(key);
    } else {
      this.addPending(key);
    }
  }

  private addPending(key: number): void {
    if (this.pendingPos[key] >= 0) return;
    this.pendingPos[key] = this.pendingCount;
    this.pendingList[this.pendingCount++] = key;
    this.score[key] = this.scoreOf(key);
  }

  private removePending(key: number): void {
    const pos = this.pendingPos[key];
    if (pos < 0) return;
    const last = this.pendingList[--this.pendingCount];
    this.pendingList[pos] = last;
    this.pendingPos[last] = pos;
    this.pendingPos[key] = -1;
  }

  /** Lowest-score pending chunk that has no job in flight, or -1. */
  private bestPending(): number {
    let best = -1;
    let bestScore = Infinity;
    const list = this.pendingList;
    for (let i = 0; i < this.pendingCount; i++) {
      const k = list[i];
      if (this.jobOf[k] !== 0) continue;
      const s = this.score[k];
      if (s < bestScore) {
        bestScore = s;
        best = k;
      }
    }
    return best;
  }

  private updateView(camera: THREE.Camera, focus: THREE.Vector3): void {
    if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.y) && Number.isFinite(focus.z)) this.focus.copy(focus);
    this.frustumValid = false;
    if (!camera || !camera.projectionMatrix || !camera.matrixWorldInverse) return;
    try {
      camera.updateMatrixWorld();
      this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreen, THREE.WebGLCoordinateSystem, camera.reversedDepth === true);
      this.frustumValid = true;
    } catch {
      this.frustumValid = false;
    }
  }

  private rescorePending(): void {
    const list = this.pendingList;
    for (let i = 0; i < this.pendingCount; i++) {
      const k = list[i];
      this.score[k] = this.scoreOf(k);
    }
  }

  private scoreOf(key: number): number {
    const c = chunkCoordsFromKey(key, this.scoreCoord);
    const x0 = c.cx * CHUNK_SIZE;
    const y0 = c.cy * CHUNK_SIZE;
    const z0 = c.cz * CHUNK_SIZE;
    const h = CHUNK_SIZE / 2;
    const dx = x0 + h - this.focus.x;
    const dy = y0 + h - this.focus.y;
    const dz = z0 + h - this.focus.z;
    let s = dx * dx + dy * dy + dz * dz;
    if (this.frustumValid) {
      this.box.min.set(x0, y0, z0);
      this.box.max.set(x0 + CHUNK_SIZE, y0 + CHUNK_SIZE, z0 + CHUNK_SIZE);
      if (!this.frustum.intersectsBox(this.box)) s += OUT_OF_VIEW_PENALTY;
    }
    return s;
  }

  /** Budget tier for this frame: 2 = bulk rebuild, 1 = large backlog, 0 = normal play. */
  private budgetTier(): number {
    if (this.bulk) return 2;
    return this.pendingCount + this.inFlight + this.readyCount > LARGE_BACKLOG ? 1 : 0;
  }

  // ------------------------------------------------------------------ results → scene

  private pushReady(key: number, jobId: number, version: number, mesh: ChunkMeshData): void {
    const prev = this.ready[key];
    if (prev) {
      if (jobId > prev.jobId) {
        prev.jobId = jobId;
        prev.version = version;
        prev.mesh = mesh;
      }
      return;
    }
    this.ready[key] = { jobId, version, mesh };
    this.readyQueue[(this.readyHead + this.readyCount) % CHUNK_COUNT] = key;
    this.readyCount++;
  }

  /**
   * Applies finished results under the tier's budget. The time budget runs from `startedAt` (the
   * start of this update(), or now when unknown); at least one result is applied per call.
   */
  private applyReady(tier: number, startedAt: number): void {
    const maxResults = UPLOAD_MAX_RESULTS[tier];
    const maxMs = UPLOAD_MAX_MS[tier];
    const maxBytes = UPLOAD_MAX_BYTES[tier];
    const t0 = startedAt >= 0 ? startedAt : performance.now();
    let applied = 0;
    let bytes = 0;
    while (this.readyCount > 0 && applied < maxResults) {
      if (applied > 0 && (bytes >= maxBytes || performance.now() - t0 >= maxMs)) return;
      const key = this.readyQueue[this.readyHead];
      this.readyHead = (this.readyHead + 1) % CHUNK_COUNT;
      this.readyCount--;
      const res = this.ready[key];
      this.ready[key] = null;
      if (!res || res.jobId <= this.appliedSeq[key]) continue; // superseded (e.g. chunk emptied since)
      this.appliedSeq[key] = res.jobId;
      bytes += this.applyMesh(key, res.mesh);
      applied++;
    }
  }

  /** Swaps a chunk's meshes to the given data. Returns the uploaded byte count. */
  private applyMesh(key: number, mesh: ChunkMeshData): number {
    const c = chunkCoordsFromKey(key, this.coord);
    const opaque = mesh.opaque && mesh.opaque.indexCount > 0 ? mesh.opaque : null;
    const water = mesh.transparent && mesh.transparent.indexCount > 0 ? mesh.transparent : null;
    this.opaqueMeshes[key] = this.swapPass(this.opaqueMeshes[key], opaque, this.materials.opaque, true, c);
    this.waterMeshes[key] = this.swapPass(this.waterMeshes[key], water, this.materials.transparent, false, c);
    const tris = ((opaque ? opaque.indexCount : 0) + (water ? water.indexCount : 0)) / 3;
    this.triangles += tris - this.chunkTris[key];
    this.chunkTris[key] = tris;
    return meshBufferBytes(opaque) + meshBufferBytes(water);
  }

  private swapPass(
    mesh: THREE.Mesh | null,
    buffers: MeshBuffers | null,
    material: THREE.Material,
    opaque: boolean,
    c: ChunkCoord,
  ): THREE.Mesh | null {
    if (!buffers) {
      if (mesh) this.destroyMesh(mesh);
      return null;
    }
    const geometry = buildChunkGeometry(buffers, opaque);
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geometry;
      return mesh;
    }
    const m = new THREE.Mesh(geometry, material);
    m.name = `chunk:${c.cx},${c.cy},${c.cz}`;
    m.position.set(c.cx * CHUNK_SIZE, c.cy * CHUNK_SIZE, c.cz * CHUNK_SIZE);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.castShadow = opaque;
    m.receiveShadow = true;
    this.parent.add(m);
    this.meshCount++;
    return m;
  }

  private destroyMesh(mesh: THREE.Mesh): void {
    mesh.geometry.dispose();
    mesh.removeFromParent();
    this.meshCount = Math.max(0, this.meshCount - 1);
  }

  private removeChunkMeshes(key: number): void {
    const o = this.opaqueMeshes[key];
    if (o) {
      this.destroyMesh(o);
      this.opaqueMeshes[key] = null;
    }
    const w = this.waterMeshes[key];
    if (w) {
      this.destroyMesh(w);
      this.waterMeshes[key] = null;
    }
    this.triangles -= this.chunkTris[key];
    this.chunkTris[key] = 0;
  }

  /** The chunk is empty: drop its meshes and supersede every older job / unapplied result. */
  private clearChunk(key: number): void {
    this.removeChunkMeshes(key);
    this.appliedSeq[key] = ++this.seq;
  }

  // ------------------------------------------------------------------ misc

  private chunkVersion(key: number): number {
    try {
      const v = this.world.getChunkVersion(key);
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  private takeBuffer(): Uint8Array {
    return this.pool.pop() ?? new Uint8Array(PADDED_VOLUME);
  }

  /** Returns a voxel buffer to the pool (ignores detached / foreign buffers). */
  private releaseBuffer(buf: unknown): void {
    if (
      buf instanceof Uint8Array &&
      buf.length === PADDED_VOLUME &&
      buf.byteOffset === 0 &&
      buf.buffer.byteLength === PADDED_VOLUME &&
      this.pool.length < MAX_POOLED_BUFFERS &&
      !this.disposed
    ) {
      this.pool.push(buf);
    }
  }

  private recordMs(ms: number): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    if (this.msFilled === MS_WINDOW) this.msSum -= this.msRing[this.msNext];
    else this.msFilled++;
    this.msRing[this.msNext] = ms;
    this.msSum += ms;
    this.msNext = (this.msNext + 1) % MS_WINDOW;
  }

  private warnOnce(tag: string, message: string, err?: unknown): void {
    if (this.warned.has(tag)) return;
    this.warned.add(tag);
    if (err === undefined) console.warn(`[meshes] ${message}`);
    else console.warn(`[meshes] ${message}: ${errorMessage(err)}`);
  }
}
