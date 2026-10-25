/**
 * MODULE: meshing — greedy voxel mesher (pure function, worker-safe).
 * Owner: meshing agent.
 *
 * Contract: greedyMesh(padded) takes a PADDED_VOLUME (34³) Uint8Array laid out as
 * px + PADDED_SIZE*(pz + PADDED_SIZE*py) (p = chunk-local + 1, border = neighbour voxels) and returns
 * ChunkMeshData (src/mesh/protocol.ts) with chunk-local positions in [0, CHUNK_SIZE].
 *
 * Rules:
 *  - Only voxels of the inner 32³ produce faces; the border is read for culling + AO only.
 *  - Face visibility: an OPAQUE block emits a face toward a neighbour that is AIR or TRANSPARENT
 *    (WATER). A TRANSPARENT block (WATER) emits a face only toward AIR (no water/water or
 *    water/solid faces). Use BLOCK_FLAGS from ../voxel/blocks (isOpaque/isTransparent).
 *  - Opaque faces → `opaque` buffers; water faces → `transparent` buffers. null when a pass is empty.
 *  - Water top faces may be lowered by ~0.1 voxel (y + 0.9) for a nicer shoreline (optional).
 *  - Ambient occlusion per vertex (classic 0..3 from side1/side2/corner in the layer in front of the
 *    face, occluders = blocks with FLAG_AO). Bake into vertex colour: rgb * AO_CURVE[ao], with
 *    AO_CURVE ≈ [0.50, 0.68, 0.84, 1.0]. Water faces: no AO.
 *  - Greedy merge per slice over faces with an identical key (block id + 4 AO values). Flip the quad
 *    diagonal when ao0 + ao2 < ao1 + ao3 (anisotropy fix) — consistently with your vertex order.
 *  - Winding: CCW when viewed from outside (normal side). Normals are axis unit vectors (Int8).
 *  - Emissive: per-vertex BLOCK_EMISSIVE_RGB of the block (0 for non-emissive). AO does not affect it.
 *  - Index buffer: Uint16Array when vertexCount ≤ 65535 else Uint32Array.
 *  - Allocation: reuse module-level scratch arrays (mask, growable vertex buffers) across calls and
 *    copy out exact-size typed arrays at the end (they are transferred to the main thread).
 * Performance: ≤ 3 ms for a typical terrain+buildings chunk, ≤ 8 ms worst case (checkerboard-ish).
 *
 * Implementation notes:
 *  - The padded volume is classified once (BLOCK_FLAGS lookup → `flags`, FLAG_AO → 0/1 `occ`).
 *  - Per axis d (x, y, z) the mesher walks the 33 face planes q = 0..32 between padded layers q and
 *    q+1 (plane q sits at chunk-local coordinate q). Every plane cell holds at most one visible face
 *    (+d face of the voxel behind the plane or -d face of the voxel in front), so one 32×32 Int32 mask
 *    per plane covers both directions. Plane 0 only takes -d faces (the voxel behind is border),
 *    plane 32 only +d faces.
 *  - Tangent axes are cyclic: u = (d+1)%3, v = (d+2)%3, so e_u × e_v = e_d. Positive faces emit the
 *    corners (u0,v0) (u1,v0) (u1,v1) (u0,v1) — CCW seen from +d; negative faces emit the same
 *    corners in reverse cyclic order (u0,v0) (u0,v1) (u1,v1) (u1,v0) — CCW seen from -d.
 *  - Mask key (non-zero = face): bits 0-7 block id, bits 8-15 the four corner AO values in canonical
 *    corner order c0=(u0,v0) c1=(u1,v0) c2=(u1,v1) c3=(u0,v1), bit 16 "water top edge lowered",
 *    bit 17 water pass, bit 18 negative direction. Merging only identical keys is exact: the AO of a
 *    shared vertex is the same for both coplanar visible faces, so equal keys on neighbouring faces
 *    imply AO that is constant along the merge direction.
 *  - Diagonal: (v0,v1,v2)+(v0,v2,v3) by default; (v0,v1,v3)+(v1,v2,v3) when ao0 + ao2 < ao1 + ao3.
 *    In both vertex orders v0/v2 are the canonical corners c0/c2, so the rule is order-independent.
 *  - Water: top faces at y + 1 - WATER_SURFACE_DROP; side faces of a water voxel with a non-solid
 *    voxel above get their upper edge lowered by the same amount (those faces carry the "lowered" key
 *    bit, so they never merge with the full-height faces below them).
 *  - Crack-free T-junctions: opaque quads are grown by QUAD_EPSILON (1/256 voxel) within their plane
 *    (so opaque positions span [-ε, 32 + ε]); see QUAD_EPSILON.
 *  - Output: the merge pass only records packed quads (geometry word + key) per pass; buildPass()
 *    then writes the vertices straight into exact-size, transferable arrays (no scratch copy).
 *    Normals and emissive (constant per quad) go out as three 32-bit words per quad.
 */
import { CHUNK_SIZE, PADDED_SIZE, PADDED_VOLUME } from '../types';
import {
  BLOCK_EMISSIVE_RGB,
  BLOCK_FLAGS,
  BLOCK_RGB,
  FLAG_AO,
  FLAG_OPAQUE,
  FLAG_SOLID,
  FLAG_TRANSPARENT,
} from '../voxel/blocks';
import type { ChunkMeshData, MeshBuffers } from './protocol';

/** Vertex brightness per AO level: index 0 = fully occluded corner … 3 = unoccluded. */
export const AO_CURVE: readonly number[] = [0.5, 0.68, 0.84, 1.0];

/** Water surfaces sit this far below the top of their voxel (top face at y + 0.9). */
export const WATER_SURFACE_DROP = 0.1;

/**
 * Opaque quads are grown by this much (voxels) on all four sides within their plane, so coplanar
 * neighbours overlap a hair and the T-junctions that greedy merging creates (also across chunk
 * borders) cannot rasterize as pinhole cracks showing the sky. Water quads are not grown (an overlap
 * would double-blend). Consequence: opaque positions lie in [-QUAD_EPSILON, 32 + QUAD_EPSILON].
 */
export const QUAD_EPSILON = 1 / 256;

const N = CHUNK_SIZE; // 32
const P = PADDED_SIZE; // 34
const STRIDE_X = 1;
const STRIDE_Y = P * P;
const STRIDE_Z = P;
/** Padded-volume stride per axis (0 = x, 1 = y, 2 = z). */
const AXIS_STRIDE: readonly number[] = [STRIDE_X, STRIDE_Y, STRIDE_Z];

const KEY_AO_SHIFT = 8;
/** All four corners unoccluded (ao = 3 each). */
const KEY_AO_OPEN = 0xff << KEY_AO_SHIFT;
const KEY_LOWERED = 1 << 16;
const KEY_WATER = 1 << 17;
const KEY_NEG = 1 << 18;

/** Bit position of FLAG_AO (so `(flags & FLAG_AO) >>> AO_BIT` is 0 or 1). */
const AO_BIT = 31 - Math.clz32(FLAG_AO);

/** Vertex colour bytes per (block id, ao): index (id * 4 + ao) * 3. */
const COLOR_LUT = new Uint8Array(256 * 4 * 3);
for (let id = 0; id < 256; id++) {
  for (let ao = 0; ao < 4; ao++) {
    for (let c = 0; c < 3; c++) {
      COLOR_LUT[(id * 4 + ao) * 3 + c] = Math.min(255, Math.round(BLOCK_RGB[id * 3 + c] * AO_CURVE[ao]));
    }
  }
}

// ------------------------------------------------------------------ constant per-quad byte patterns

/**
 * Normals and emissive colours are identical for the 4 vertices of a quad, i.e. one 12-byte block
 * per quad. The blocks are prebuilt as bytes and written through Uint32 views (3 words per quad).
 * Pattern and output share the platform byte order, so this is endianness-independent.
 */
const NORMAL_BYTES = new Uint8Array(6 * 12);
for (let dir = 0; dir < 6; dir++) {
  const axis = dir >> 1;
  const s = (dir & 1) === 0 ? 1 : 255; // Int8 -1 as a byte
  for (let k = 0; k < 4; k++) NORMAL_BYTES[dir * 12 + k * 3 + axis] = s;
}
const NORMAL_WORDS = new Uint32Array(NORMAL_BYTES.buffer);

const EMISSIVE_BYTES = new Uint8Array(256 * 12);
for (let id = 0; id < 256; id++) {
  for (let k = 0; k < 4; k++) {
    for (let c = 0; c < 3; c++) EMISSIVE_BYTES[id * 12 + k * 3 + c] = BLOCK_EMISSIVE_RGB[id * 3 + c];
  }
}
const EMISSIVE_WORDS = new Uint32Array(EMISSIVE_BYTES.buffer);

/** True on little-endian platforms (all current browsers); enables the packed colour writes. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;
/** Colour per (id, ao) packed as r | g << 8 | b << 16, index id * 4 + ao. */
const COLOR_PACKED = new Uint32Array(256 * 4);
for (let i = 0; i < 256 * 4; i++) {
  COLOR_PACKED[i] = COLOR_LUT[i * 3] | (COLOR_LUT[i * 3 + 1] << 8) | (COLOR_LUT[i * 3 + 2] << 16);
}

// ------------------------------------------------------------------ scratch (module level, reused)

const flagsScratch = new Uint8Array(PADDED_VOLUME);
const occScratch = new Uint8Array(PADDED_VOLUME);
const maskScratch = new Int32Array(N * N);
let flipScratch = new Uint8Array(16384);

/**
 * Growable list of merged quads of one pass: packed geometry + mask key per quad.
 * geo bits: 0-1 axis d, 2-7 plane q, 8-13 u0, 14-19 v0, 20-25 u1, 26-31 v1.
 */
class QuadList {
  geo: Uint32Array;
  key: Int32Array;
  count = 0;

  constructor(initial: number) {
    this.geo = new Uint32Array(initial);
    this.key = new Int32Array(initial);
  }

  push(geo: number, key: number): void {
    if (this.count === this.geo.length) {
      const g = new Uint32Array(this.geo.length * 2);
      g.set(this.geo);
      const k = new Int32Array(this.key.length * 2);
      k.set(this.key);
      this.geo = g;
      this.key = k;
    }
    this.geo[this.count] = geo;
    this.key[this.count] = key;
    this.count++;
  }
}

const opaqueQuads = new QuadList(8192);
const waterQuads = new QuadList(1024);

/**
 * Writes the vertex data of a quad list straight into exact-size (transferable) arrays, or null
 * when the list is empty. Vertex order per quad: c0 then c1,c2,c3 (positive) / c3,c2,c1 (negative).
 */
function buildPass(list: QuadList, water: boolean): MeshBuffers | null {
  const count = list.count;
  if (count === 0) return null;
  const vertexCount = count * 4;
  const indexCount = count * 6;
  const n = vertexCount * 3; // = 12 bytes per quad → multiple of 4
  const positions = new Float32Array(n);
  const normalBuf = new ArrayBuffer(n);
  const nrm32 = new Uint32Array(normalBuf);
  const colorBuf = new ArrayBuffer(n);
  const col8 = new Uint8Array(colorBuf);
  const col32 = new Uint32Array(colorBuf);
  const emissiveBuf = new ArrayBuffer(n);
  const emi32 = new Uint32Array(emissiveBuf);
  if (flipScratch.length < count) flipScratch = new Uint8Array(Math.max(count, flipScratch.length * 2));
  const flip = flipScratch;
  const geo = list.geo;
  const keys = list.key;

  for (let q = 0, o = 0, w = 0; q < count; q++, o += 12, w += 3) {
    const g = geo[q];
    const key = keys[q];
    const d = g & 3;
    let plane = (g >>> 2) & 63;
    let u0 = (g >>> 8) & 63;
    let v0 = (g >>> 14) & 63;
    let u1 = (g >>> 20) & 63;
    let v1 = g >>> 26;
    const neg = (key & KEY_NEG) !== 0;
    if (water) {
      if (d === 1 && !neg) plane -= WATER_SURFACE_DROP;
      if ((key & KEY_LOWERED) !== 0) {
        // y is the u axis for d = x and the v axis for d = z
        if (d === 0) u1 -= WATER_SURFACE_DROP;
        else v1 -= WATER_SURFACE_DROP;
      }
    } else {
      u0 -= QUAD_EPSILON;
      v0 -= QUAD_EPSILON;
      u1 += QUAD_EPSILON;
      v1 += QUAD_EPSILON;
    }
    const a0 = (key >>> 8) & 3;
    const a1 = (key >>> 10) & 3;
    const a2 = (key >>> 12) & 3;
    const a3 = (key >>> 14) & 3;

    // (u, v) of the emitted vertices: v0 = c0, v2 = c2, v1/v3 = c1/c3 or c3/c1
    const pu1 = neg ? u0 : u1;
    const pv1 = neg ? v1 : v0;
    const pu3 = neg ? u1 : u0;
    const pv3 = neg ? v0 : v1;
    const b1 = neg ? a3 : a1;
    const b3 = neg ? a1 : a3;
    // cyclic tangents: d = x → (u, v) = (y, z); d = y → (z, x); d = z → (x, y)
    if (d === 0) {
      positions[o] = plane;
      positions[o + 1] = u0;
      positions[o + 2] = v0;
      positions[o + 3] = plane;
      positions[o + 4] = pu1;
      positions[o + 5] = pv1;
      positions[o + 6] = plane;
      positions[o + 7] = u1;
      positions[o + 8] = v1;
      positions[o + 9] = plane;
      positions[o + 10] = pu3;
      positions[o + 11] = pv3;
    } else if (d === 1) {
      positions[o] = v0;
      positions[o + 1] = plane;
      positions[o + 2] = u0;
      positions[o + 3] = pv1;
      positions[o + 4] = plane;
      positions[o + 5] = pu1;
      positions[o + 6] = v1;
      positions[o + 7] = plane;
      positions[o + 8] = u1;
      positions[o + 9] = pv3;
      positions[o + 10] = plane;
      positions[o + 11] = pu3;
    } else {
      positions[o] = u0;
      positions[o + 1] = v0;
      positions[o + 2] = plane;
      positions[o + 3] = pu1;
      positions[o + 4] = pv1;
      positions[o + 5] = plane;
      positions[o + 6] = u1;
      positions[o + 7] = v1;
      positions[o + 8] = plane;
      positions[o + 9] = pu3;
      positions[o + 10] = pv3;
      positions[o + 11] = plane;
    }

    const nw = (d * 2 + (neg ? 1 : 0)) * 3;
    nrm32[w] = NORMAL_WORDS[nw];
    nrm32[w + 1] = NORMAL_WORDS[nw + 1];
    nrm32[w + 2] = NORMAL_WORDS[nw + 2];

    const id = key & 0xff;
    const ew = id * 3;
    emi32[w] = EMISSIVE_WORDS[ew];
    emi32[w + 1] = EMISSIVE_WORDS[ew + 1];
    emi32[w + 2] = EMISSIVE_WORDS[ew + 2];

    const cb = id * 4;
    if (LITTLE_ENDIAN) {
      const c0 = COLOR_PACKED[cb + a0];
      const c1 = COLOR_PACKED[cb + b1];
      const c2 = COLOR_PACKED[cb + a2];
      const c3 = COLOR_PACKED[cb + b3];
      col32[w] = c0 | (c1 << 24);
      col32[w + 1] = (c1 >>> 8) | (c2 << 16);
      col32[w + 2] = (c2 >>> 16) | (c3 << 8);
    } else {
      let l = (cb + a0) * 3;
      col8[o] = COLOR_LUT[l];
      col8[o + 1] = COLOR_LUT[l + 1];
      col8[o + 2] = COLOR_LUT[l + 2];
      l = (cb + b1) * 3;
      col8[o + 3] = COLOR_LUT[l];
      col8[o + 4] = COLOR_LUT[l + 1];
      col8[o + 5] = COLOR_LUT[l + 2];
      l = (cb + a2) * 3;
      col8[o + 6] = COLOR_LUT[l];
      col8[o + 7] = COLOR_LUT[l + 1];
      col8[o + 8] = COLOR_LUT[l + 2];
      l = (cb + b3) * 3;
      col8[o + 9] = COLOR_LUT[l];
      col8[o + 10] = COLOR_LUT[l + 1];
      col8[o + 11] = COLOR_LUT[l + 2];
    }

    // anisotropy fix: v0/v2 are the canonical corners c0/c2 in both vertex orders
    flip[q] = a0 + a2 < a1 + a3 ? 1 : 0;
  }

  let indices: Uint16Array | Uint32Array;
  if (vertexCount <= 65535) {
    const idx16 = new Uint16Array(indexCount);
    fillIndices16(idx16, flip, count);
    indices = idx16;
  } else {
    const idx32 = new Uint32Array(indexCount);
    fillIndices32(idx32, flip, count);
    indices = idx32;
  }
  return {
    positions,
    normals: new Int8Array(normalBuf),
    colors: col8,
    emissive: new Uint8Array(emissiveBuf),
    indices,
    vertexCount,
    indexCount,
  };
}

/** Index pattern per quad: (0,1,2)(0,2,3), or (0,1,3)(1,2,3) when flipped. */
function fillIndices16(out: Uint16Array, flip: Uint8Array, quads: number): void {
  for (let q = 0, b = 0, i = 0; q < quads; q++, b += 4, i += 6) {
    if (flip[q] !== 0) {
      out[i] = b;
      out[i + 1] = b + 1;
      out[i + 2] = b + 3;
      out[i + 3] = b + 1;
      out[i + 4] = b + 2;
      out[i + 5] = b + 3;
    } else {
      out[i] = b;
      out[i + 1] = b + 1;
      out[i + 2] = b + 2;
      out[i + 3] = b;
      out[i + 4] = b + 2;
      out[i + 5] = b + 3;
    }
  }
}

function fillIndices32(out: Uint32Array, flip: Uint8Array, quads: number): void {
  for (let q = 0, b = 0, i = 0; q < quads; q++, b += 4, i += 6) {
    if (flip[q] !== 0) {
      out[i] = b;
      out[i + 1] = b + 1;
      out[i + 2] = b + 3;
      out[i + 3] = b + 1;
      out[i + 4] = b + 2;
      out[i + 5] = b + 3;
    } else {
      out[i] = b;
      out[i + 1] = b + 1;
      out[i + 2] = b + 2;
      out[i + 3] = b;
      out[i + 4] = b + 2;
      out[i + 5] = b + 3;
    }
  }
}

/**
 * AO bits (KEY_AO_SHIFT…) for a face whose front voxel (the non-opaque voxel the face looks into) is
 * at padded index f, with tangent strides sU/sV. Classic rule per corner:
 * ao = (side1 && side2) ? 0 : 3 - (side1 + side2 + corner).
 */
function aoKey(occ: Uint8Array, f: number, sU: number, sV: number): number {
  const uM = occ[f - sU];
  const uP = occ[f + sU];
  const vM = occ[f - sV];
  const vP = occ[f + sV];
  const a0 = (uM & vM) !== 0 ? 0 : 3 - uM - vM - occ[f - sU - sV];
  const a1 = (uP & vM) !== 0 ? 0 : 3 - uP - vM - occ[f + sU - sV];
  const a2 = (uP & vP) !== 0 ? 0 : 3 - uP - vP - occ[f + sU + sV];
  const a3 = (uM & vP) !== 0 ? 0 : 3 - uM - vP - occ[f - sU + sV];
  return (a0 << 8) | (a1 << 10) | (a2 << 12) | (a3 << 14);
}

/**
 * Greedy-meshes one padded chunk. Throws a RangeError if `padded` is not PADDED_VOLUME long
 * (the worker reports that as a MeshError).
 */
export function greedyMesh(padded: Uint8Array): ChunkMeshData {
  if (!(padded instanceof Uint8Array) || padded.length !== PADDED_VOLUME) {
    throw new RangeError(`greedyMesh: expected a Uint8Array of ${PADDED_VOLUME} voxels`);
  }
  const flags = flagsScratch;
  const occ = occScratch;
  const mask = maskScratch;

  let anySolid = 0;
  for (let i = 0; i < PADDED_VOLUME; i++) {
    const f = BLOCK_FLAGS[padded[i]];
    flags[i] = f;
    occ[i] = (f & FLAG_AO) >>> AO_BIT;
    anySolid |= f;
  }
  opaqueQuads.count = 0;
  waterQuads.count = 0;
  if ((anySolid & FLAG_SOLID) === 0) return { opaque: null, transparent: null };

  for (let d = 0; d < 3; d++) {
    const uA = d === 2 ? 0 : d + 1;
    const vA = d === 0 ? 2 : d - 1;
    const sD = AXIS_STRIDE[d];
    const sU = AXIS_STRIDE[uA];
    const sV = AXIS_STRIDE[vA];

    for (let q = 0; q <= N; q++) {
      const canPos = q >= 1;
      const canNeg = q < N;
      let faces = 0;

      // ---- build the plane mask
      for (let iv = 0; iv < N; iv++) {
        let ia = q * sD + sU + (iv + 1) * sV;
        const row = iv * N;
        for (let iu = 0; iu < N; iu++, ia += sU) {
          const fa = flags[ia];
          const ib = ia + sD;
          const fb = flags[ib];
          let key = 0;
          if ((fa & FLAG_OPAQUE) !== 0) {
            // +d face of the voxel behind the plane, looking into ib
            if (canPos && (fb & FLAG_OPAQUE) === 0) key = padded[ia] | aoKey(occ, ib, sU, sV);
          } else if ((fb & FLAG_OPAQUE) !== 0) {
            // -d face of the voxel in front of the plane, looking into ia
            if (canNeg) key = padded[ib] | aoKey(occ, ia, sU, sV) | KEY_NEG;
          } else if ((fa & FLAG_TRANSPARENT) !== 0) {
            if (canPos && (fb & FLAG_SOLID) === 0) {
              key = padded[ia] | KEY_AO_OPEN | KEY_WATER;
              if (d !== 1 && (flags[ia + STRIDE_Y] & FLAG_SOLID) === 0) key |= KEY_LOWERED;
            }
          } else if ((fb & FLAG_TRANSPARENT) !== 0) {
            if (canNeg && (fa & FLAG_SOLID) === 0) {
              key = padded[ib] | KEY_AO_OPEN | KEY_WATER | KEY_NEG;
              if (d !== 1 && (flags[ib + STRIDE_Y] & FLAG_SOLID) === 0) key |= KEY_LOWERED;
            }
          }
          mask[row + iu] = key;
          if (key !== 0) faces++;
        }
      }
      if (faces === 0) continue;

      // ---- greedy merge: widest run along u, then extend along v while whole rows match
      for (let iv = 0; iv < N && faces > 0; iv++) {
        const row = iv * N;
        for (let iu = 0; iu < N; ) {
          const key = mask[row + iu];
          if (key === 0) {
            iu++;
            continue;
          }
          let w = 1;
          while (iu + w < N && mask[row + iu + w] === key) w++;
          let h = 1;
          grow: while (iv + h < N) {
            const r = row + h * N + iu;
            for (let t = 0; t < w; t++) if (mask[r + t] !== key) break grow;
            h++;
          }
          for (let k = 1; k < h; k++) {
            const r = row + k * N + iu;
            for (let t = 0; t < w; t++) mask[r + t] = 0;
          }
          const geo = (d | (q << 2) | (iu << 8) | (iv << 14) | ((iu + w) << 20) | ((iv + h) << 26)) >>> 0;
          if ((key & KEY_WATER) !== 0) waterQuads.push(geo, key);
          else opaqueQuads.push(geo, key);
          faces -= w * h;
          if (faces === 0) break;
          iu += w;
        }
      }
    }
  }

  return { opaque: buildPass(opaqueQuads, false), transparent: buildPass(waterQuads, true) };
}
