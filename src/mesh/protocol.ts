/**
 * FROZEN CONTRACT — meshing worker message protocol + mesh buffer layout.
 * Owner: integrator. Module agents MUST NOT edit this file.
 * Worker-safe (no DOM / three imports).
 *
 * Flow:
 *   main (ChunkMeshManager) ──MeshRequest{voxels: padded chunk}──▶ worker (mesher.worker.ts)
 *   worker: greedyMesh(voxels) ──MeshResult{mesh, voxels}──▶ main
 * All typed-array buffers are TRANSFERRED (zero-copy) in both directions; the padded voxel buffer
 * is sent back so the main thread can reuse it (buffer pool).
 *
 * Vertex layout of MeshBuffers (one entry per vertex, 4 vertices per quad, 6 indices per quad):
 *   positions: Float32Array, 3 per vertex — CHUNK-LOCAL voxel units in [0, CHUNK_SIZE]
 *              (the mesh object is positioned at (cx, cy, cz) * CHUNK_SIZE).
 *   normals:   Int8Array, 3 per vertex — axis-aligned unit normal (-1/0/1). Use as a
 *              non-normalized THREE.BufferAttribute (WebGL converts BYTE → float exactly).
 *   colors:    Uint8Array, 3 per vertex — sRGB block color × ambient-occlusion factor, as bytes.
 *              Use as THREE.BufferAttribute(colors, 3, true) named 'color'.
 *   emissive:  Uint8Array, 3 per vertex — block emissive color bytes (0 if none).
 *              Use as THREE.BufferAttribute(emissive, 3, true) named 'aEmissive' (NOT 'emissive':
 *              that name is already a uniform in three's Lambert/Phong/Standard shaders).
 *   indices:   Uint16Array when vertexCount ≤ 65535, else Uint32Array. CCW front faces.
 */

/** Geometry for one render pass of one chunk. */
export interface MeshBuffers {
  positions: Float32Array;
  normals: Int8Array;
  colors: Uint8Array;
  emissive: Uint8Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
}

/** Output of the mesher for one chunk: opaque pass + transparent (water) pass, null when empty. */
export interface ChunkMeshData {
  opaque: MeshBuffers | null;
  transparent: MeshBuffers | null;
}

/** main → worker */
export interface MeshRequest {
  type: 'mesh';
  /** Unique, increasing per manager. */
  jobId: number;
  /** chunkKey(cx, cy, cz). */
  key: number;
  /** world.getChunkVersion(key) at extraction time. */
  version: number;
  /** PADDED_VOLUME voxels, index px + PADDED_SIZE*(pz + PADDED_SIZE*py). Transferred. */
  voxels: Uint8Array;
}

/** worker → main, success. */
export interface MeshResult {
  type: 'result';
  jobId: number;
  key: number;
  version: number;
  mesh: ChunkMeshData;
  /** The request's voxel buffer, transferred back for reuse. */
  voxels: Uint8Array;
  /** Worker-side meshing time in ms. */
  ms: number;
}

/** worker → main, failure (the manager should retry once, then give up on that version). */
export interface MeshError {
  type: 'error';
  jobId: number;
  key: number;
  version: number;
  message: string;
  voxels: Uint8Array | null;
}

export type WorkerRequest = MeshRequest;
export type WorkerResponse = MeshResult | MeshError;

/** Distinct ArrayBuffers backing the given mesh data (+ optional extra arrays), for postMessage transfer. */
export function collectTransferables(mesh: ChunkMeshData | null, ...extra: (ArrayBufferView | null | undefined)[]): Transferable[] {
  const set = new Set<ArrayBuffer>();
  const add = (v: ArrayBufferView | null | undefined): void => {
    if (v && v.buffer instanceof ArrayBuffer && v.buffer.byteLength > 0) set.add(v.buffer);
  };
  const addMesh = (m: MeshBuffers | null): void => {
    if (!m) return;
    add(m.positions);
    add(m.normals);
    add(m.colors);
    add(m.emissive);
    add(m.indices);
  };
  if (mesh) {
    addMesh(mesh.opaque);
    addMesh(mesh.transparent);
  }
  for (const e of extra) add(e);
  return Array.from(set);
}

/** Triangle count of a ChunkMeshData. */
export function meshTriangles(mesh: ChunkMeshData): number {
  return ((mesh.opaque?.indexCount ?? 0) + (mesh.transparent?.indexCount ?? 0)) / 3;
}
