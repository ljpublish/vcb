/**
 * MODULE: meshing — Web Worker entry. Created by ChunkMeshManager via
 *   new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })
 * Owner: meshing agent.
 *
 * Receives MeshRequest, runs greedyMesh, posts MeshResult (all buffers transferred, including the
 * request's voxel buffer so the main thread can pool it). Never throws out of onmessage: failures
 * (bad input, mesher exceptions, a failed postMessage) are reported as MeshError, with the voxel
 * buffer returned whenever possible. Stateless apart from the mesher's scratch buffers.
 *
 * Worker-safe imports only: ../types (type-only three import), ./greedy (→ ../voxel/blocks),
 * ./protocol. No DOM, no three.
 */
import { PADDED_VOLUME } from '../types';
import { greedyMesh } from './greedy';
import { collectTransferables, type ChunkMeshData, type MeshError, type MeshResult, type WorkerRequest } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : -1;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function postError(req: Partial<WorkerRequest>, message: string, voxels: Uint8Array | null): void {
  const res: MeshError = {
    type: 'error',
    jobId: num(req.jobId),
    key: num(req.key),
    version: num(req.version),
    message,
    voxels,
  };
  try {
    self.postMessage(res, collectTransferables(null, voxels));
  } catch {
    try {
      self.postMessage({ ...res, voxels: null });
    } catch {
      // nothing left to report through; the main thread's job timeout recovers
    }
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>): void => {
  const req = ev.data;
  if (!req || typeof req !== 'object' || req.type !== 'mesh') return;
  const voxels = req.voxels instanceof Uint8Array ? req.voxels : null;
  if (!voxels || voxels.length !== PADDED_VOLUME) {
    postError(req, `expected ${PADDED_VOLUME} voxels, got ${voxels ? voxels.length : 'none'}`, voxels);
    return;
  }
  const t0 = performance.now();
  let mesh: ChunkMeshData;
  try {
    mesh = greedyMesh(voxels);
  } catch (err) {
    postError(req, errorText(err), voxels);
    return;
  }
  const res: MeshResult = {
    type: 'result',
    jobId: req.jobId,
    key: req.key,
    version: req.version,
    mesh,
    voxels,
    ms: performance.now() - t0,
  };
  try {
    self.postMessage(res, collectTransferables(mesh, voxels));
  } catch (err) {
    postError(req, `could not post the mesh: ${errorText(err)}`, voxels);
  }
};
