/**
 * MODULE: meshing — shared chunk materials + geometry construction.
 * Owner: meshing agent. Module-internal API (may change), used by chunkMeshManager.ts.
 *
 * Spec:
 *  - Opaque material: MeshLambertMaterial({ vertexColors: true }) patched via onBeforeCompile to
 *    (a) read the per-vertex 'aEmissive' attribute (vec3, normalized bytes) and add
 *        `vEmissive * sharedUniforms.uNight.value * NIGHT_GLOW` to totalEmissiveRadiance,
 *    (b) keep fog and shadows working (receive + cast). Set a stable customProgramCacheKey.
 *  - Transparent (water) material: transparent, opacity ≈ 0.78, depthWrite false, vertex colours,
 *    optional gentle animated brightness/wave using sharedUniforms.uTime (keep it subtle and cheap).
 *  - Remember the color pipeline: colors are used as-is (no sRGB conversion), see colorSetup.ts.
 *  - buildChunkGeometry: BufferGeometry with attributes position (Float32 ×3), normal (Int8 ×3,
 *    not normalized), color (Uint8 ×3, normalized), aEmissive (Uint8 ×3, normalized), index; set
 *    boundingBox/boundingSphere from chunk bounds directly (cheaper than computing).
 *
 * Implementation notes:
 *  - Uniforms are bound BY REFERENCE (`shader.uniforms.uNight = sharedUniforms.uNight`); only
 *    src/render/scene.ts writes their values, so every compiled program sees updates for free.
 *  - Crack-free greedy meshes: the mesher grows opaque quads by 1/256 voxel within their plane; the
 *    opaque vertex shader adds depth-proportional growth along the same directions (constant
 *    ~0.1 px on screen) so T-junction pinholes never show the sky, near or far.
 *  - The shader patches are applied only when every anchor chunk is present (three.js upgrades that
 *    rename chunks then degrade to an unpatched — but valid — Lambert shader, with a warning).
 *  - Water: a cheap two-wave interference pattern in world XZ modulates the brightness by ±5 % and
 *    adds faint moving sun glints (scaled by uSun, so they vanish at night). Water geometry carries
 *    no aEmissive attribute (it never glows).
 *  - WYSIWYG colour pipeline: the vertex colour bytes are final display colours; nothing here
 *    converts between sRGB and linear (material colours stay white = identity).
 */
import * as THREE from 'three';
import { CHUNK_SIZE } from '../types';
import { sharedUniforms } from '../render/sharedUniforms';
import type { MeshBuffers } from './protocol';

/**
 * Night glow multiplier of emissive blocks (lit windows, street lamps, signs, beacons): at
 * uNight = 1 the block shows its lit colour plus emissive × NIGHT_GLOW. Tuned on a moonlit test
 * street: 1.15 reads clearly and keeps warm windows golden (≥ 1.3 washes them out to cream, and
 * large lit curtain walls turn flat white since there is no tone mapping).
 */
export const NIGHT_GLOW = 1.15;

/** Water opacity (the atmosphere module's ocean ring uses a similar colour, WATER = 0x3b8fd9). */
export const WATER_OPACITY = 0.78;

export interface ChunkMaterials {
  opaque: THREE.MeshLambertMaterial;
  transparent: THREE.MeshLambertMaterial;
  dispose(): void;
}

const OPAQUE_PROGRAM_KEY = 'vcb-chunk-opaque-v1';
const WATER_PROGRAM_KEY = 'vcb-chunk-water-v1';

/** GLSL float literal. */
function glslFloat(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

interface ShaderPatch {
  anchor: string;
  insert: string;
}

let warnedPatch = false;

/**
 * Inserts each patch right after its anchor. Returns null (and warns once) when an anchor is
 * missing, so callers can keep the original shader pair consistent.
 */
function applyPatches(source: string, patches: readonly ShaderPatch[]): string | null {
  let out = source;
  for (const p of patches) {
    const at = out.indexOf(p.anchor);
    if (at < 0) {
      if (!warnedPatch) {
        warnedPatch = true;
        console.warn(`[meshes] chunk shader anchor "${p.anchor}" not found; using the unpatched material`);
      }
      return null;
    }
    const end = at + p.anchor.length;
    out = `${out.slice(0, end)}\n${p.insert}\n${out.slice(end)}`;
  }
  return out;
}

/**
 * Extra in-plane growth of opaque quad edges per unit of view depth (see QUAD_EPSILON in greedy.ts):
 * keeps the T-junction overlap at a constant ~0.1 px on screen, at every distance.
 */
export const CRACK_GROW_PER_DEPTH = 1e-4;

const OPAQUE_VERTEX_PATCHES: readonly ShaderPatch[] = [
  {
    anchor: '#include <common>',
    insert: `attribute vec3 aEmissive;\nvarying vec3 vEmissive;\nconst float VCB_CRACK_GROW = ${glslFloat(CRACK_GROW_PER_DEPTH)};`,
  },
  { anchor: '#include <color_vertex>', insert: '\tvEmissive = aEmissive;' },
  {
    // The mesher grows every opaque quad by 1/256 voxel within its plane, so the sign of
    // (position - round(position)) is each vertex's outward edge direction (0 on the plane axis).
    anchor: '#include <begin_vertex>',
    insert: [
      '\tvec3 vcbEdge = sign( position - floor( position + 0.5 ) );',
      '\tfloat vcbDepth = max( 0.0, -( modelViewMatrix * vec4( position, 1.0 ) ).z );',
      '\ttransformed += vcbEdge * ( vcbDepth * VCB_CRACK_GROW );',
    ].join('\n'),
  },
];

const OPAQUE_FRAGMENT_PATCHES: readonly ShaderPatch[] = [
  {
    anchor: '#include <common>',
    insert: `uniform float uNight;\nvarying vec3 vEmissive;\nconst float NIGHT_GLOW = ${glslFloat(NIGHT_GLOW)};`,
  },
  { anchor: '#include <emissivemap_fragment>', insert: '\ttotalEmissiveRadiance += vEmissive * ( uNight * NIGHT_GLOW );' },
];

const WATER_VERTEX_PATCHES: readonly ShaderPatch[] = [
  { anchor: '#include <common>', insert: 'varying vec2 vWaterXZ;' },
  { anchor: '#include <begin_vertex>', insert: '\tvWaterXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;' },
];

const WATER_FRAGMENT_PATCHES: readonly ShaderPatch[] = [
  { anchor: '#include <common>', insert: 'uniform float uTime;\nuniform float uSun;\nvarying vec2 vWaterXZ;' },
  {
    anchor: '#include <color_fragment>',
    insert: [
      '\tfloat vcbWave = sin( dot( vWaterXZ, vec2( 0.19, 0.11 ) ) + uTime * 1.3 )',
      '\t\t* sin( dot( vWaterXZ, vec2( -0.12, 0.23 ) ) - uTime * 0.9 );',
      '\tdiffuseColor.rgb *= 1.0 + 0.05 * vcbWave;',
    ].join('\n'),
  },
  {
    anchor: '#include <emissivemap_fragment>',
    insert: '\ttotalEmissiveRadiance += vec3( 0.85, 0.92, 1.0 ) * ( 0.07 * uSun * smoothstep( 0.55, 1.0, vcbWave ) );',
  },
];

function patchShader(
  shader: THREE.WebGLProgramParametersWithUniforms,
  vertex: readonly ShaderPatch[],
  fragment: readonly ShaderPatch[],
): boolean {
  const vs = applyPatches(shader.vertexShader, vertex);
  const fs = vs === null ? null : applyPatches(shader.fragmentShader, fragment);
  if (vs === null || fs === null) return false;
  shader.vertexShader = vs;
  shader.fragmentShader = fs;
  return true;
}

export function createChunkMaterials(): ChunkMaterials {
  const opaque = new THREE.MeshLambertMaterial({ vertexColors: true });
  opaque.name = 'vcb-chunk-opaque';
  opaque.onBeforeCompile = (shader): void => {
    shader.uniforms.uNight = sharedUniforms.uNight;
    patchShader(shader, OPAQUE_VERTEX_PATCHES, OPAQUE_FRAGMENT_PATCHES);
  };
  opaque.customProgramCacheKey = (): string => OPAQUE_PROGRAM_KEY;

  const transparent = new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    opacity: WATER_OPACITY,
    depthWrite: false,
  });
  transparent.name = 'vcb-chunk-water';
  transparent.onBeforeCompile = (shader): void => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uSun = sharedUniforms.uSun;
    patchShader(shader, WATER_VERTEX_PATCHES, WATER_FRAGMENT_PATCHES);
  };
  transparent.customProgramCacheKey = (): string => WATER_PROGRAM_KEY;

  return {
    opaque,
    transparent,
    dispose(): void {
      opaque.dispose();
      transparent.dispose();
    },
  };
}

/**
 * Chunk-local bounds shared by every chunk geometry: the chunk cube, padded for the in-plane growth
 * of opaque quads (QUAD_EPSILON in the mesher + CRACK_GROW_PER_DEPTH × view depth in the shader,
 * < 0.3 voxels at the far plane), so frustum culling never clips a grown edge.
 */
const BOUNDS_MARGIN = 0.5;
const CHUNK_BOX = new THREE.Box3(
  new THREE.Vector3(-BOUNDS_MARGIN, -BOUNDS_MARGIN, -BOUNDS_MARGIN),
  new THREE.Vector3(CHUNK_SIZE + BOUNDS_MARGIN, CHUNK_SIZE + BOUNDS_MARGIN, CHUNK_SIZE + BOUNDS_MARGIN),
);
const CHUNK_SPHERE = CHUNK_BOX.getBoundingSphere(new THREE.Sphere());

/**
 * Build a chunk BufferGeometry from mesher output (chunk-local coordinates). `withEmissive` adds the
 * 'aEmissive' attribute (opaque pass); the water pass never glows and skips it.
 */
export function buildChunkGeometry(buffers: MeshBuffers, withEmissive = true): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3, false));
  g.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3, true));
  if (withEmissive) g.setAttribute('aEmissive', new THREE.BufferAttribute(buffers.emissive, 3, true));
  g.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
  // Per-geometry copies: three mutates bounds in place if anyone calls computeBounding*().
  g.boundingBox = CHUNK_BOX.clone();
  g.boundingSphere = CHUNK_SPHERE.clone();
  return g;
}

/** Bytes of vertex + index data in a pass (for upload budgeting). */
export function meshBufferBytes(buffers: MeshBuffers | null): number {
  if (!buffers) return 0;
  return (
    buffers.positions.byteLength +
    buffers.normals.byteLength +
    buffers.colors.byteLength +
    buffers.emissive.byteLength +
    buffers.indices.byteLength
  );
}
