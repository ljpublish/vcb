#!/usr/bin/env node
/**
 * Voxel-world module tests (src/voxel: VoxelWorld, Terrain, noise, decor). Plain Node, no tsx and
 * no browser: the TypeScript sources are bundled IN MEMORY with rolldown (a Vite 8 dependency) and
 * imported from a data: URL, so nothing is written to disk.
 *
 *   node scripts/test-voxel-world.mjs [--seeds 50] [--voxel-seeds 3] [--ops 4000]
 *                                     [--quick] [--no-bench] [--strict-perf]
 *
 *   --seeds N        terrain layout invariants over seeds 1..N (+ a few edge-case seeds)
 *   --voxel-seeds N  seeds whose full voxel world is generated and checked column by column,
 *                    plus the garbage + restoreTile exactness test
 *   --ops N          random setBlock / fillBox / applyStamp / clear operations checked against a
 *                    flat reference model of the whole world
 *   --quick          = --seeds 12 --voxel-seeds 1 --ops 1200
 *   --no-bench       skip the micro-benchmarks
 *   --strict-perf    a missed performance target is a failure (default: reported as a warning,
 *                    because timings depend on the machine and its load)
 *
 * Exit code 0 when every check passed, 1 otherwise.
 *
 * What is checked:
 *  World   get/set across chunk borders and out of bounds, id masking, STAMP_KEEP never stored,
 *          lazy allocation / release (isChunkEmpty), dirty tracking (own chunk + up to 7 padded-
 *          border neighbours, nothing missing, extras only adjacent to changed chunks, versions
 *          bumped once per bulk operation), revision semantics, fillBox / applyStamp clipping,
 *          extractPadded (including world-edge chunks: BEDROCK below y = 0, AIR elsewhere),
 *          getColumnTop, clear(); then thousands of random operations against the reference.
 *  Terrain determinism (same seed → identical tiles and voxels, different seeds differ), query
 *          clamping, flat tiles, |Δh| ≤ 2 between land neighbours, ≥ 70 % land, ≥ 55 % plain,
 *          dry central plain, starter-road row, beaches, water beds, no puddles / spikes / pits,
 *          decor rules, voxel layering per column, large grass patches, restoreTile exactness
 *          (garbage everywhere, then restore every tile → bit-identical to generateInto),
 *          restoreTile(…, false) clears the tile's decor and touches nothing outside the tile.
 *  Perf    setBlock ≥ 20 M/s, extractPadded ≤ 0.3 ms, fillBox 8×116×8 ≤ 0.2 ms, full-map terrain
 *          write ≤ 150 ms, Terrain constructor < 30 ms, generateInto < 400 ms, restoreTile < 0.1 ms.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

// ------------------------------------------------------------------------------------ options

const argv = process.argv.slice(2);
const opts = { seeds: 50, voxelSeeds: 3, ops: 4000, bench: true, strictPerf: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const num = () => {
    const v = Number(argv[++i]);
    if (!Number.isFinite(v) || v < 0) usage(`bad value for ${a}`);
    return Math.floor(v);
  };
  if (a === '--seeds') opts.seeds = num();
  else if (a === '--voxel-seeds') opts.voxelSeeds = num();
  else if (a === '--ops') opts.ops = num();
  else if (a === '--quick') Object.assign(opts, { seeds: 12, voxelSeeds: 1, ops: 1200 });
  else if (a === '--no-bench') opts.bench = false;
  else if (a === '--strict-perf') opts.strictPerf = true;
  else usage(`unknown argument ${a}`);
}

function usage(msg) {
  console.error(`${msg}\nusage: node scripts/test-voxel-world.mjs [--seeds N] [--voxel-seeds N] [--ops N] [--quick] [--no-bench] [--strict-perf]`);
  process.exit(2);
}

// ------------------------------------------------------------------------------------ bundle

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => JSON.stringify(path.join(ROOT, 'src', p));
const ENTRY = '\0vcb-voxel-world-test-entry';

async function loadModules() {
  const bundle = await rolldown({
    input: ENTRY,
    platform: 'node',
    logLevel: 'warn',
    plugins: [
      {
        name: 'vcb-test-entry',
        resolveId: (id) => (id === ENTRY ? ENTRY : null),
        load: (id) =>
          id !== ENTRY
            ? null
            : [
                `export { VoxelWorld } from ${src('voxel/world.ts')};`,
                `export { Terrain } from ${src('voxel/terrain.ts')};`,
                `export * as types from ${src('types.ts')};`,
                `export * as blocks from ${src('voxel/blocks.ts')};`,
                `export * as coords from ${src('core/coords.ts')};`,
                `export * as rng from ${src('core/rng.ts')};`,
                `export * as noise from ${src('voxel/noise.ts')};`,
              ].join('\n'),
      },
    ],
  });
  try {
    const { output } = await bundle.generate({ format: 'esm' });
    return await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`);
  } finally {
    await bundle.close();
  }
}

const M = await loadModules();
const { VoxelWorld, Terrain, types, blocks, coords, rng, noise } = M;
const { B, STAMP_KEEP } = blocks;
const {
  WORLD_SIZE_X: SX,
  WORLD_HEIGHT: SY,
  WORLD_SIZE_Z: SZ,
  CHUNKS_X,
  CHUNKS_Y,
  CHUNKS_Z,
  CHUNK_COUNT,
  PADDED_SIZE,
  PADDED_VOLUME,
  MAP_TILES,
  TILE_SIZE,
  WATER_LEVEL,
  BASE_GROUND_HEIGHT,
  MIN_GROUND_HEIGHT,
  MAX_GROUND_HEIGHT,
} = types;
const { chunkKey, chunkCoordsFromKey } = coords;
const { Rng } = rng;

// ------------------------------------------------------------------------------------ reporting

let failures = 0;
let warnings = 0;
const failCounts = new Map();

function fail(name, detail = '') {
  failures++;
  const n = (failCounts.get(name) ?? 0) + 1;
  failCounts.set(name, n);
  if (n <= 4) console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  else if (n === 5) console.log(`  FAIL ${name} — (further failures of this check suppressed)`);
}

function check(cond, name, detail = '') {
  if (!cond) fail(name, typeof detail === 'function' ? detail() : detail);
  return cond;
}

function section(title) {
  console.log(`\n== ${title}`);
}

function info(msg) {
  console.log(`  ${msg}`);
}

/** Reports a timing against a target ("≤" semantics); a miss is a warning unless --strict-perf. */
function perf(name, value, target, unit = 'ms', higherIsBetter = false) {
  const ok = higherIsBetter ? value >= target : value <= target;
  const line = `${name}: ${value.toFixed(value < 1 ? 4 : 2)} ${unit} (target ${higherIsBetter ? '≥' : '≤'} ${target} ${unit})`;
  if (ok) info(`perf ok   ${line}`);
  else if (opts.strictPerf) fail('perf', line);
  else {
    warnings++;
    info(`perf WARN ${line}`);
  }
}

function now() {
  return performance.now();
}

// ------------------------------------------------------------------------------------ world helpers

const BEDROCK = B.BEDROCK;
const chunkInBounds = (cx, cy, cz) => cx >= 0 && cy >= 0 && cz >= 0 && cx < CHUNKS_X && cy < CHUNKS_Y && cz < CHUNKS_Z;
const keyXYZ = (k) => {
  const c = chunkCoordsFromKey(k);
  return `(${c.cx},${c.cy},${c.cz})`;
};

/** Flat reference model of the whole world + the dirty marks a change REQUIRES. */
class RefWorld {
  constructor() {
    this.v = new Uint8Array(SX * SY * SZ); // index x + SX*(z + SZ*y)
    this.required = new Uint8Array(CHUNK_COUNT); // chunks that must be dirty
    this.changed = new Uint8Array(CHUNK_COUNT); // chunks containing a changed voxel
    this.changes = 0;
  }
  inb(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ;
  }
  get(x, y, z) {
    return this.inb(x, y, z) ? this.v[x + SX * (z + SZ * y)] : B.AIR;
  }
  resetTracking() {
    this.required.fill(0);
    this.changed.fill(0);
    this.changes = 0;
  }
  note(x, y, z) {
    this.changes++;
    const cx = x >> 5;
    const cy = y >> 5;
    const cz = z >> 5;
    const lx = x & 31;
    const ly = y & 31;
    const lz = z & 31;
    this.changed[chunkKey(cx, cy, cz)] = 1;
    for (let dy = ly === 0 ? -1 : 0; dy <= (ly === 31 ? 1 : 0); dy++)
      for (let dz = lz === 0 ? -1 : 0; dz <= (lz === 31 ? 1 : 0); dz++)
        for (let dx = lx === 0 ? -1 : 0; dx <= (lx === 31 ? 1 : 0); dx++)
          if (chunkInBounds(cx + dx, cy + dy, cz + dz)) this.required[chunkKey(cx + dx, cy + dy, cz + dz)] = 1;
  }
  set(x, y, z, id) {
    if (!this.inb(x, y, z)) return;
    id &= 255;
    if (id === STAMP_KEEP) return;
    const i = x + SX * (z + SZ * y);
    if (this.v[i] === id) return;
    this.v[i] = id;
    this.note(x, y, z);
  }
  fillBox(x0, y0, z0, x1, y1, z1, id) {
    const bx = Math.min(SX, x1);
    const by = Math.min(SY, y1);
    const bz = Math.min(SZ, z1);
    for (let y = Math.max(0, y0); y < by; y++)
      for (let z = Math.max(0, z0); z < bz; z++) for (let x = Math.max(0, x0); x < bx; x++) this.set(x, y, z, id);
  }
  applyStamp(st, ox, oy, oz) {
    for (let y = 0; y < st.sy; y++)
      for (let z = 0; z < st.sz; z++)
        for (let x = 0; x < st.sx; x++) {
          const v = st.data[x + st.sx * (z + st.sz * y)];
          if (v !== STAMP_KEEP) this.set(ox + x, oy + y, oz + z, v);
        }
  }
  chunkNonAir() {
    const n = new Int32Array(CHUNK_COUNT);
    for (let y = 0; y < SY; y++)
      for (let z = 0; z < SZ; z++) {
        const row = SX * (z + SZ * y);
        const base = ((y >> 5) * CHUNKS_Z + (z >> 5)) * CHUNKS_X;
        for (let x = 0; x < SX; x++) if (this.v[row + x] !== 0) n[base + (x >> 5)]++;
      }
    return n;
  }
  clear() {
    const n = this.chunkNonAir();
    for (let k = 0; k < CHUNK_COUNT; k++) if (n[k] > 0) this.required[k] = this.changed[k] = 1;
    this.v.fill(0);
  }
  padded(cx, cy, cz, out) {
    let i = 0;
    for (let py = 0; py < PADDED_SIZE; py++) {
      const y = cy * 32 - 1 + py;
      for (let pz = 0; pz < PADDED_SIZE; pz++) {
        const z = cz * 32 - 1 + pz;
        for (let px = 0; px < PADDED_SIZE; px++) out[i++] = y < 0 ? BEDROCK : this.get(cx * 32 - 1 + px, y, z);
      }
    }
  }
}

/** Snapshot of all chunk versions. */
function versions(w) {
  const v = new Float64Array(CHUNK_COUNT);
  for (let k = 0; k < CHUNK_COUNT; k++) v[k] = w.getChunkVersion(k);
  return v;
}

/**
 * Verifies one operation's effect on dirty tracking against the reference's notes.
 * mode: 'single' (each dirty chunk bumped exactly once), 'multi' (≥ 1, several calls batched).
 */
function verifyDirty(tag, w, ref, v0, revBefore, mode, extraAllowed = null) {
  const dirty = w.takeDirtyChunks();
  const set = new Set(dirty);
  check(Array.isArray(dirty), `${tag}: takeDirtyChunks returns an array`);
  check(set.size === dirty.length, `${tag}: no duplicate dirty keys`);
  check(w.takeDirtyChunks().length === 0, `${tag}: takeDirtyChunks clears the set`);
  for (let k = 0; k < CHUNK_COUNT; k++) {
    if (ref.required[k] && !set.has(k)) fail('dirty: required chunk missing', `${tag} ${keyXYZ(k)}`);
  }
  for (const k of dirty) {
    if (!(Number.isInteger(k) && k >= 0 && k < CHUNK_COUNT)) {
      fail('dirty: invalid key', `${tag} ${k}`);
      continue;
    }
    if (ref.required[k] || (extraAllowed && extraAllowed.has(k))) continue;
    // Extra chunk: must neighbour (Chebyshev ≤ 1) a chunk that really changed.
    const c = chunkCoordsFromKey(k);
    let adjacent = false;
    for (let dy = -1; dy <= 1 && !adjacent; dy++)
      for (let dz = -1; dz <= 1 && !adjacent; dz++)
        for (let dx = -1; dx <= 1 && !adjacent; dx++) {
          const x = c.cx + dx;
          const y = c.cy + dy;
          const z = c.cz + dz;
          if (chunkInBounds(x, y, z) && ref.changed[chunkKey(x, y, z)]) adjacent = true;
        }
    check(adjacent, 'dirty: extra chunk not adjacent to a change', `${tag} ${keyXYZ(k)}`);
  }
  for (let k = 0; k < CHUNK_COUNT; k++) {
    const d = w.getChunkVersion(k) - v0[k];
    if (set.has(k)) {
      if (mode === 'single') check(d === 1, 'version bumped exactly once per operation', `${tag} ${keyXYZ(k)} Δ${d}`);
      else check(d >= 1, 'version bumped for dirty chunk', `${tag} ${keyXYZ(k)} Δ${d}`);
    } else check(d === 0, 'version unchanged for clean chunk', `${tag} ${keyXYZ(k)} Δ${d}`);
  }
  const revChanged = w.revision !== revBefore;
  check(w.revision >= revBefore, 'revision never decreases', tag);
  check(revChanged === ref.changes > 0, 'revision changes iff a voxel changed', () => `${tag} changes=${ref.changes} rev ${revBefore}→${w.revision}`);
  ref.resetTracking();
}

function compareEverything(tag, w, ref, r, full) {
  const counts = ref.chunkNonAir();
  for (let cy = -1; cy <= CHUNKS_Y; cy++)
    for (let cz = -1; cz <= CHUNKS_Z; cz++)
      for (let cx = -1; cx <= CHUNKS_X; cx++) {
        const expect = !chunkInBounds(cx, cy, cz) || counts[chunkKey(cx, cy, cz)] === 0;
        check(w.isChunkEmpty(cx, cy, cz) === expect, 'isChunkEmpty matches reference', `${tag} (${cx},${cy},${cz})`);
      }
  for (let i = 0; i < 400; i++) {
    const x = r.int(-2, SX + 2);
    const z = r.int(-2, SZ + 2);
    let top = -1;
    if (x >= 0 && z >= 0 && x < SX && z < SZ) for (let y = SY - 1; y >= 0 && top < 0; y--) if (ref.get(x, y, z) !== 0) top = y;
    check(w.getColumnTop(x, z) === top, 'getColumnTop matches reference', () => `${tag} (${x},${z}) got ${w.getColumnTop(x, z)} want ${top}`);
  }
  const a = new Uint8Array(PADDED_VOLUME);
  const b = new Uint8Array(PADDED_VOLUME);
  const list = [];
  if (full) for (let k = 0; k < CHUNK_COUNT; k++) list.push(chunkCoordsFromKey(k, { cx: 0, cy: 0, cz: 0 }));
  for (let i = 0; i < 10; i++) list.push({ cx: r.int(-1, CHUNKS_X + 1), cy: r.int(-1, CHUNKS_Y + 1), cz: r.int(-1, CHUNKS_Z + 1) });
  for (const { cx, cy, cz } of list) {
    a.fill(0xaa);
    const ret = w.extractPadded(cx, cy, cz, a);
    ref.padded(cx, cy, cz, b);
    let interior = false;
    if (chunkInBounds(cx, cy, cz)) interior = counts[chunkKey(cx, cy, cz)] > 0;
    check(ret === interior, 'extractPadded return value', `${tag} (${cx},${cy},${cz}) got ${ret}`);
    for (let j = 0; j < PADDED_VOLUME; j++) {
      if (a[j] !== b[j]) {
        fail('extractPadded matches reference', `${tag} chunk (${cx},${cy},${cz}) index ${j}: ${a[j]} vs ${b[j]}`);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------------------------ world: targeted

function worldTargeted() {
  section('VoxelWorld — targeted checks');
  const w = new VoxelWorld();
  check(w.sizeX === SX && w.sizeY === SY && w.sizeZ === SZ, 'world size fields');
  check(w.chunksX === CHUNKS_X && w.chunksY === CHUNKS_Y && w.chunksZ === CHUNKS_Z, 'chunk count fields');
  check(w.revision === 0, 'fresh world revision 0');
  check(w.takeDirtyChunks().length === 0, 'fresh world has no dirty chunks');
  let empty = true;
  for (let k = 0; k < CHUNK_COUNT; k++) {
    const c = chunkCoordsFromKey(k);
    if (!w.isChunkEmpty(c.cx, c.cy, c.cz)) empty = false;
  }
  check(empty, 'fresh world: every chunk empty');
  check(w.getBlock(10, 10, 10) === B.AIR && w.getColumnTop(10, 10) === -1, 'fresh world reads AIR');

  // Out-of-bounds writes are ignored, reads are AIR.
  for (const [x, y, z] of [[-1, 0, 0], [SX, 0, 0], [0, -1, 0], [0, SY, 0], [0, 0, -1], [0, 0, SZ], [NaN, 1, 1], [1, Infinity, 1]]) {
    w.setBlock(x, y, z, B.STONE);
    check(w.getBlock(x, y, z) === B.AIR, 'out-of-bounds read is AIR', `(${x},${y},${z})`);
  }
  check(w.revision === 0 && w.takeDirtyChunks().length === 0, 'out-of-bounds writes ignored');
  check(w.isChunkEmpty(-1, 0, 0) && w.isChunkEmpty(0, CHUNKS_Y, 0) && w.isChunkEmpty(NaN, 0, 0), 'out-of-range chunks are empty');
  check(w.getColumnTop(-1, 5) === -1 && w.getColumnTop(5, SZ) === -1, 'getColumnTop out of bounds is -1');

  // AIR / KEEP writes never allocate or store.
  w.setBlock(5, 5, 5, B.AIR);
  w.setBlock(5, 5, 5, STAMP_KEEP);
  w.fillBox(0, 0, 0, 64, 64, 64, B.AIR);
  w.fillBox(0, 0, 0, 64, 64, 64, STAMP_KEEP);
  check(w.revision === 0 && w.isChunkEmpty(0, 0, 0) && w.takeDirtyChunks().length === 0, 'AIR / STAMP_KEEP writes into an empty world are no-ops');
  w.setBlock(5, 5, 5, 256 + B.DIRT);
  check(w.getBlock(5, 5, 5) === B.DIRT, 'setBlock masks the id with & 255');
  w.setBlock(5, 5, 5, STAMP_KEEP);
  check(w.getBlock(5, 5, 5) === B.DIRT, 'STAMP_KEEP is never stored');
  w.setBlock(5, 5, 5, B.AIR);
  check(w.isChunkEmpty(0, 0, 0), 'chunk released when its last voxel is cleared');
  w.takeDirtyChunks();

  // Dirty neighbourhood of single voxels (own chunk + padded-border neighbours).
  const cases = [
    { p: [48, 48, 48], n: 1, what: 'interior voxel → own chunk only' },
    { p: [63, 48, 48], n: 2, what: 'face voxel (+x) → 2 chunks' },
    { p: [64, 48, 48], n: 2, what: 'face voxel (-x) → 2 chunks' },
    { p: [63, 63, 48], n: 4, what: 'edge voxel → 4 chunks' },
    { p: [63, 63, 63], n: 8, what: 'corner voxel → 8 chunks' },
    { p: [64, 64, 64], n: 8, what: 'corner voxel (min side) → 8 chunks' },
    { p: [0, 0, 0], n: 1, what: 'world corner → own chunk only' },
    { p: [SX - 1, SY - 1, SZ - 1], n: 1, what: 'far world corner → own chunk only' },
    { p: [31, 0, 300], n: 2, what: 'bottom-layer face voxel → 2 chunks' },
  ];
  for (const c of cases) {
    const v0 = versions(w);
    const rev = w.revision;
    w.setBlock(c.p[0], c.p[1], c.p[2], B.ROCK);
    const d = w.takeDirtyChunks();
    check(d.length === c.n, `dirty: ${c.what}`, `got ${d.length}: ${d.map(keyXYZ).join(' ')}`);
    check(w.revision === rev + 1, 'setBlock bumps revision once', c.what);
    for (const k of d) check(w.getChunkVersion(k) === v0[k] + 1, 'setBlock bumps each dirty version once', c.what);
    w.setBlock(c.p[0], c.p[1], c.p[2], B.ROCK);
    check(w.revision === rev + 1 && w.takeDirtyChunks().length === 0, 'rewriting the same value is a no-op', c.what);
  }

  // Get/set across chunk borders: a line of distinct values crossing several chunks on every axis.
  const w2 = new VoxelWorld();
  const vals = [];
  for (let i = 0; i < 96; i++) vals.push(1 + ((i * 37) % 200));
  for (let i = 0; i < 96; i++) {
    w2.setBlock(16 + i, 70, 40, vals[i]);
    w2.setBlock(200, 10 + i, 31, vals[i]);
    w2.setBlock(95, 33, 20 + i, vals[i]);
  }
  let okLine = true;
  for (let i = 0; i < 96; i++) {
    if (w2.getBlock(16 + i, 70, 40) !== vals[i] || w2.getBlock(200, 10 + i, 31) !== vals[i] || w2.getBlock(95, 33, 20 + i) !== vals[i]) okLine = false;
  }
  check(okLine, 'get/set lines crossing chunk borders on x, y and z');
  check(w2.getColumnTop(200, 31) === 105 && w2.getColumnTop(16 + 50, 40) === 70, 'getColumnTop across vertical chunks');
  w2.setBlock(200, 105, 31, B.AIR);
  check(w2.getColumnTop(200, 31) === 104, 'getColumnTop after clearing the top voxel');

  // getChunkVersion: invalid keys → 0; markChunkDirty / markAllDirty.
  for (const k of [-1, CHUNK_COUNT, 1.5, NaN, 1e12]) check(w.getChunkVersion(k) === 0, 'getChunkVersion(invalid) === 0', String(k));
  const v0 = versions(w);
  w.markChunkDirty(-1, 0, 0);
  w.markChunkDirty(0, CHUNKS_Y, 0);
  check(w.takeDirtyChunks().length === 0, 'markChunkDirty ignores out-of-range chunks');
  w.markChunkDirty(3, 2, 5);
  const d1 = w.takeDirtyChunks();
  check(d1.length === 1 && d1[0] === chunkKey(3, 2, 5) && w.getChunkVersion(d1[0]) === v0[d1[0]] + 1, 'markChunkDirty marks one chunk and bumps its version');
  w.markAllDirty();
  const all = w.takeDirtyChunks();
  check(all.length === CHUNK_COUNT && new Set(all).size === CHUNK_COUNT, 'markAllDirty marks all chunks');

  // fillBox: inverted / empty boxes, clipping, once-per-operation versions, release.
  const w3 = new VoxelWorld();
  w3.fillBox(10, 10, 10, 5, 20, 20, B.STONE);
  w3.fillBox(10, 10, 10, 20, 10, 20, B.STONE);
  w3.fillBox(SX, 0, 0, SX + 10, 10, 10, B.STONE);
  check(w3.revision === 0 && w3.takeDirtyChunks().length === 0, 'empty / inverted / fully outside boxes are no-ops');
  w3.fillBox(-5, -5, -5, 40, 40, 40, B.STONE);
  check(w3.getBlock(0, 0, 0) === B.STONE && w3.getBlock(39, 39, 39) === B.STONE && w3.getBlock(40, 39, 39) === B.AIR, 'fillBox is half-open and clipped');
  w3.takeDirtyChunks();
  const vb = versions(w3);
  const rev3 = w3.revision;
  w3.fillBox(20, 20, 20, 90, 90, 90, B.DIRT);
  const d3 = w3.takeDirtyChunks();
  check(d3.length >= 27, 'multi-chunk fillBox dirties every touched chunk', `${d3.length}`);
  check(d3.every((k) => w3.getChunkVersion(k) === vb[k] + 1), 'multi-chunk fillBox bumps each version exactly once');
  check(w3.revision > rev3, 'fillBox that changed voxels bumps revision');
  const rev3b = w3.revision;
  w3.fillBox(20, 20, 20, 90, 90, 90, B.DIRT);
  check(w3.revision === rev3b && w3.takeDirtyChunks().length === 0, 'repeating the same fillBox is a no-op');
  w3.fillBox(0, 0, 0, SX, SY, SZ, B.AIR);
  let released = true;
  for (let k = 0; k < CHUNK_COUNT; k++) {
    const c = chunkCoordsFromKey(k);
    if (!w3.isChunkEmpty(c.cx, c.cy, c.cz)) released = false;
  }
  check(released, 'clearing everything with fillBox(AIR) releases every chunk');

  // applyStamp: KEEP voxels skipped, negative origins clipped.
  const w4 = new VoxelWorld();
  w4.fillBox(0, 0, 0, 8, 8, 8, B.STONE);
  const data = new Uint8Array(4 * 4 * 4).fill(STAMP_KEEP);
  data[0] = B.SAND; // (0,0,0)
  data[1 + 4 * (1 + 4 * 1)] = B.AIR; // (1,1,1)
  data[3 + 4 * (3 + 4 * 3)] = B.CLAY; // (3,3,3)
  w4.applyStamp({ sx: 4, sy: 4, sz: 4, data }, -2, -2, -2);
  check(w4.getBlock(0, 0, 0) === B.STONE, 'applyStamp: clipped voxel outside the world ignored');
  check(w4.getBlock(1, 1, 1) === B.CLAY, 'applyStamp: negative origin maps stamp (3,3,3) to world (1,1,1)');
  w4.applyStamp({ sx: 4, sy: 4, sz: 4, data }, 2, 2, 2);
  check(w4.getBlock(2, 2, 2) === B.SAND && w4.getBlock(3, 3, 3) === B.AIR && w4.getBlock(5, 5, 5) === B.CLAY, 'applyStamp writes non-KEEP voxels');
  check(w4.getBlock(4, 4, 4) === B.STONE && w4.getBlock(2, 3, 2) === B.STONE, 'applyStamp leaves KEEP voxels unchanged');
  w4.takeDirtyChunks();
  const rev4 = w4.revision;
  w4.applyStamp({ sx: 4, sy: 4, sz: 4, data: new Uint8Array(64).fill(STAMP_KEEP) }, 30, 30, 30);
  check(w4.revision === rev4 && w4.takeDirtyChunks().length === 0, 'all-KEEP stamp is a no-op');

  // extractPadded on an empty world and at the world edge.
  const pad = new Uint8Array(PADDED_VOLUME);
  const e = new VoxelWorld();
  check(e.extractPadded(0, 0, 0, pad) === false, 'extractPadded(empty) returns false');
  let bottomOk = true;
  let restAir = true;
  for (let i = 0; i < PADDED_VOLUME; i++) {
    const py = Math.floor(i / (PADDED_SIZE * PADDED_SIZE));
    if (py === 0 && pad[i] !== BEDROCK) bottomOk = false;
    if (py > 0 && pad[i] !== B.AIR) restAir = false;
  }
  check(bottomOk && restAir, 'extractPadded: below y = 0 is BEDROCK, other outside voxels AIR');
  // Border-only content: the 26 neighbours around chunk (5,1,5) → appear in the border, return false.
  const nbw = new VoxelWorld();
  const base = [5 * 32, 32, 5 * 32];
  let id = 1;
  const expectAt = [];
  for (const ox of [-1, 0, 32])
    for (const oy of [-1, 0, 32])
      for (const oz of [-1, 0, 32]) {
        if (ox === 0 && oy === 0 && oz === 0) continue;
        const x = base[0] + (ox === 0 ? 7 : ox);
        const y = base[1] + (oy === 0 ? 9 : oy);
        const z = base[2] + (oz === 0 ? 11 : oz);
        nbw.setBlock(x, y, z, id);
        expectAt.push([x - base[0] + 1, y - base[1] + 1, z - base[2] + 1, id]);
        id++;
      }
  check(nbw.extractPadded(5, 1, 5, pad) === false, 'extractPadded returns false for border-only content');
  check(
    expectAt.every(([px, py, pz, v]) => pad[px + PADDED_SIZE * (pz + PADDED_SIZE * py)] === v),
    'extractPadded copies all 26 neighbour borders (faces, edges, corners)',
  );
  nbw.setBlock(base[0] + 3, base[1] + 3, base[2] + 3, B.STONE);
  check(nbw.extractPadded(5, 1, 5, pad) === true, 'extractPadded returns true for interior content');

  // clear(): dirties previously non-empty chunks, bumps revision, empties everything.
  const c = new VoxelWorld();
  c.setBlock(10, 10, 10, B.STONE);
  c.setBlock(300, 100, 400, B.STONE);
  c.takeDirtyChunks();
  const vc = versions(c);
  const rc = c.revision;
  c.clear();
  const dc = c.takeDirtyChunks().sort((a, b) => a - b);
  const expect = [chunkKey(0, 0, 0), chunkKey(9, 3, 12)].sort((a, b) => a - b);
  check(dc.length === 2 && dc[0] === expect[0] && dc[1] === expect[1], 'clear() dirties exactly the previously non-empty chunks', dc.map(keyXYZ).join(' '));
  check(dc.every((k) => c.getChunkVersion(k) === vc[k] + 1), 'clear() bumps their versions');
  check(c.revision > rc, 'clear() bumps revision');
  check(c.getBlock(10, 10, 10) === B.AIR && c.isChunkEmpty(0, 0, 0) && c.getColumnTop(300, 400) === -1, 'clear() empties the world');
  c.setBlock(10, 10, 10, B.DIRT);
  check(c.getBlock(10, 10, 10) === B.DIRT && c.getBlock(11, 10, 10) === B.AIR, 'chunks re-allocated after clear() start all-AIR');
}

// ------------------------------------------------------------------------------------ world: random vs reference

function worldRandom() {
  section(`VoxelWorld — ${opts.ops} random operations vs. a flat reference model`);
  const w = new VoxelWorld();
  const ref = new RefWorld();
  const r = new Rng(0xc0ffee);
  const randId = () => {
    const q = r.next();
    if (q < 0.22) return B.AIR;
    if (q < 0.27) return STAMP_KEEP;
    if (q < 0.3) return 256 + r.int(1, 10); // masked
    if (q < 0.6) return 1 + r.int(0, 5);
    return r.int(1, 255);
  };
  const randCoord = (size) => {
    const q = r.next();
    if (q < 0.06) return r.int(-24, 0);
    if (q < 0.12) return r.int(size, size + 24);
    if (q < 0.45) return r.int(0, size / 32 + 1) * 32 + r.int(-2, 3); // near chunk borders
    return r.int(0, size);
  };
  const tally = { setBlock: 0, fillBox: 0, applyStamp: 0, markChunkDirty: 0, clear: 0 };
  for (let op = 0; op < opts.ops; op++) {
    const q = r.next();
    const v0 = versions(w);
    const rev = w.revision;
    let tag = `op ${op}`;
    let mode = 'single';
    let extra = null;
    if (q < 0.4) {
      tally.setBlock++;
      mode = 'multi';
      const bx = randCoord(SX);
      const by = randCoord(SY);
      const bz = randCoord(SZ);
      const n = r.int(1, 30);
      for (let i = 0; i < n; i++) {
        const x = bx + r.int(-3, 4);
        const y = by + r.int(-3, 4);
        const z = bz + r.int(-3, 4);
        const id = randId();
        w.setBlock(x, y, z, id);
        ref.set(x, y, z, id);
      }
      tag += ` setBlock×${n} near (${bx},${by},${bz})`;
    } else if (q < 0.68) {
      tally.fillBox++;
      const x0 = randCoord(SX);
      const y0 = randCoord(SY);
      const z0 = randCoord(SZ);
      const ext = (big) => (r.chance(0.08) ? r.int(-4, 1) : r.int(1, r.chance(0.2) ? big : 20));
      const x1 = x0 + ext(72);
      const y1 = y0 + ext(64);
      const z1 = z0 + ext(72);
      const id = randId();
      w.fillBox(x0, y0, z0, x1, y1, z1, id);
      ref.fillBox(x0, y0, z0, x1, y1, z1, id);
      tag += ` fillBox(${x0},${y0},${z0} → ${x1},${y1},${z1}, ${id})`;
    } else if (q < 0.97) {
      tally.applyStamp++;
      const sx = r.int(1, 26);
      const sy = r.int(1, 40);
      const sz = r.int(1, 26);
      const data = new Uint8Array(sx * sy * sz);
      const keepP = r.next() * 0.6;
      const airP = r.next() * 0.4;
      const main = r.int(1, 40);
      for (let i = 0; i < data.length; i++) {
        const t = r.next();
        data[i] = t < keepP ? STAMP_KEEP : t < keepP + airP ? B.AIR : r.chance(0.7) ? main : r.int(1, 255);
      }
      const st = { sx, sy, sz, data };
      const ox = randCoord(SX) - r.int(0, sx);
      const oy = randCoord(SY) - r.int(0, sy);
      const oz = randCoord(SZ) - r.int(0, sz);
      w.applyStamp(st, ox, oy, oz);
      ref.applyStamp(st, ox, oy, oz);
      tag += ` applyStamp(${sx}×${sy}×${sz} @ ${ox},${oy},${oz})`;
    } else if (q < 0.99) {
      tally.markChunkDirty++;
      const cx = r.int(-1, CHUNKS_X + 1);
      const cy = r.int(-1, CHUNKS_Y + 1);
      const cz = r.int(-1, CHUNKS_Z + 1);
      w.markChunkDirty(cx, cy, cz);
      if (chunkInBounds(cx, cy, cz)) {
        extra = new Set([chunkKey(cx, cy, cz)]);
        ref.required[chunkKey(cx, cy, cz)] = 1;
      }
      tag += ` markChunkDirty(${cx},${cy},${cz})`;
    } else {
      tally.clear++;
      w.clear();
      ref.clear();
      ref.changes = Math.max(ref.changes, 1); // clear() always bumps revision
      tag += ' clear()';
    }
    verifyDirty(tag, w, ref, v0, rev, mode, extra);
    if (op % 400 === 399) compareEverything(tag, w, ref, r, false);
  }
  compareEverything('final', w, ref, r, true);
  info(`operations: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

// ------------------------------------------------------------------------------------ world: benchmarks

function bestOf(reps, fn) {
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = now();
    fn();
    best = Math.min(best, now() - t0);
  }
  return best;
}

function worldBench() {
  section('VoxelWorld — performance');
  const w = new VoxelWorld();
  let v = 1;
  const n = 64 * 256 * 256;
  const tSet = bestOf(4, () => {
    v = (v % 200) + 1;
    for (let y = 0; y < 64; y++) for (let z = 0; z < 256; z++) for (let x = 0; x < 256; x++) w.setBlock(x, y, z, v);
    w.takeDirtyChunks();
  });
  perf('setBlock (every write changes a voxel)', n / tSet / 1000, 20, 'M/s', true);
  let id = 1;
  const tFill = bestOf(4, () => {
    for (let i = 0; i < 1000; i++) {
      id = id === 1 ? 2 : 1;
      const tx = i & 63;
      const tz = (i >> 6) & 63;
      w.fillBox(tx * 8, 4, tz * 8, tx * 8 + 8, 120, tz * 8 + 8, id);
    }
    w.takeDirtyChunks();
  });
  perf('fillBox 8×116×8 (avg per call)', tFill / 1000, 0.2);
  const t = new Terrain(1);
  const tw = new VoxelWorld();
  t.generateInto(tw);
  const out = new Uint8Array(PADDED_VOLUME);
  const tPad = bestOf(4, () => {
    for (let k = 0; k < CHUNK_COUNT; k++) {
      const c = chunkCoordsFromKey(k);
      tw.extractPadded(c.cx, c.cy, c.cz, out);
    }
  });
  perf('extractPadded (avg over all 1024 chunks of a terrain world)', tPad / CHUNK_COUNT, 0.3);
  const layer = new Uint8Array(8 * 8 * 14);
  layer.fill(B.BEDROCK, 0, 64);
  layer.fill(B.STONE, 64, 640);
  layer.fill(B.DIRT, 640, 832);
  layer.fill(B.GRASS, 832, 896);
  const st = { sx: 8, sy: 14, sz: 8, data: layer };
  const tTerr = bestOf(3, () => {
    w.clear();
    w.takeDirtyChunks();
    for (let tz = 0; tz < MAP_TILES; tz++) for (let tx = 0; tx < MAP_TILES; tx++) w.applyStamp(st, tx * 8, 0, tz * 8);
  });
  perf('full-map terrain write 512×512×14 (per-tile stamps)', tTerr, 150);
}

// ------------------------------------------------------------------------------------ terrain: layout invariants

const GRASSES = new Set([B.GRASS, B.GRASS_DARK, B.GRASS_LIGHT]);
const LAND_TOPS = new Set([B.GRASS, B.GRASS_DARK, B.GRASS_LIGHT, B.ROCK, B.SNOW, B.GRAVEL]);
const BED_TOPS = new Set([B.SAND, B.GRAVEL, B.CLAY]);
const DECOR_BLOCKS = new Set([
  B.WOOD, B.LEAVES, B.LEAVES_DARK, B.LEAVES_LIGHT, B.LEAVES_AUTUMN, B.LEAVES_PINK, B.PINE, B.BUSH,
  B.FLOWER_RED, B.FLOWER_YELLOW, B.FLOWER_WHITE, B.FLOWER_PURPLE, B.SNOW, B.FENCE_WHITE, B.WOOD_DARK, B.ROOF_RED,
]);
const N = MAP_TILES;
const MID = N >> 1;
const DECOR_MAX = 14;

/** Tile-level snapshot of a terrain through the public TerrainReader API. */
function snapshot(t) {
  const s = { h: new Uint8Array(N * N), water: new Uint8Array(N * N), decor: new Uint8Array(N * N), ground: new Uint8Array(N * N) };
  for (let tz = 0; tz < N; tz++)
    for (let tx = 0; tx < N; tx++) {
      const i = tz * N + tx;
      s.h[i] = t.getTileHeight(tx, tz);
      s.water[i] = t.isWater(tx, tz) ? 1 : 0;
      s.decor[i] = t.hasNaturalDecor(tx, tz) ? 1 : 0;
      s.ground[i] = t.getGroundBlock(tx, tz);
    }
  return s;
}

function sameSnapshot(a, b) {
  for (const k of ['h', 'water', 'decor', 'ground']) for (let i = 0; i < N * N; i++) if (a[k][i] !== b[k][i]) return false;
  return true;
}

/** 4-connected components of tiles where pred(i) holds: [{size, edge}]. */
function components(pred) {
  const seen = new Uint8Array(N * N);
  const out = [];
  const stack = [];
  for (let s = 0; s < N * N; s++) {
    if (seen[s] || !pred(s)) continue;
    let size = 0;
    let edge = false;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      size++;
      const tx = i % N;
      const tz = (i - tx) / N;
      if (tx === 0 || tz === 0 || tx === N - 1 || tz === N - 1) edge = true;
      for (const j of [tx > 0 ? i - 1 : -1, tx < N - 1 ? i + 1 : -1, tz > 0 ? i - N : -1, tz < N - 1 ? i + N : -1]) {
        if (j >= 0 && !seen[j] && pred(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    out.push({ size, edge });
  }
  return out;
}

const NB = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function layoutInvariants(seed, t, stats) {
  const tag = `seed ${seed}`;
  const s = snapshot(t);
  let land = 0;
  let plain = 0;
  let treesHill = 0;
  let hillTiles = 0;
  let treesPlain = 0;
  let plainTiles = 0;
  let maxH = 0;
  for (let tz = 0; tz < N; tz++) {
    for (let tx = 0; tx < N; tx++) {
      const i = tz * N + tx;
      const h = s.h[i];
      const water = s.water[i] === 1;
      check(t.getSurfaceHeight(tx, tz) === Math.max(h, WATER_LEVEL), 'getSurfaceHeight = max(h, WATER_LEVEL)', `${tag} (${tx},${tz})`);
      if (water) {
        check(h >= MIN_GROUND_HEIGHT && h <= WATER_LEVEL - 1, 'water bed height in [MIN_GROUND_HEIGHT, WATER_LEVEL-1]', `${tag} (${tx},${tz}) h ${h}`);
        check(BED_TOPS.has(s.ground[i]), 'water ground block is SAND / GRAVEL / CLAY', `${tag} (${tx},${tz}) ${s.ground[i]}`);
        check(s.decor[i] === 0, 'no decor on water', `${tag} (${tx},${tz})`);
        continue;
      }
      land++;
      maxH = Math.max(maxH, h);
      check(h >= WATER_LEVEL + 1 && h <= MAX_GROUND_HEIGHT, 'land height in [WATER_LEVEL+1, MAX_GROUND_HEIGHT]', `${tag} (${tx},${tz}) h ${h}`);
      if (h === BASE_GROUND_HEIGHT) plain++;
      const beach = h === WATER_LEVEL + 1;
      if (beach) {
        check(s.ground[i] === B.SAND, 'beach tiles (h = 11) are SAND', `${tag} (${tx},${tz})`);
        check(s.decor[i] === 0, 'no decor on beaches', `${tag} (${tx},${tz})`);
      } else check(LAND_TOPS.has(s.ground[i]), 'land ground block is grass / rock / snow / gravel', `${tag} (${tx},${tz}) ${s.ground[i]}`);
      if (h > BASE_GROUND_HEIGHT) {
        hillTiles++;
        if (s.decor[i]) treesHill++;
      } else if (h === BASE_GROUND_HEIGHT) {
        plainTiles++;
        if (s.decor[i]) treesPlain++;
      }
      let landNb = 0;
      let higher = 0;
      let lower = 0;
      let waterNb = 0;
      for (const [dx, dz] of NB) {
        const x = tx + dx;
        const z = tz + dz;
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const j = z * N + x;
        if (s.water[j]) {
          waterNb++;
          continue;
        }
        landNb++;
        const d = s.h[j] - h;
        check(Math.abs(d) <= 2, '|Δh| ≤ 2 between 4-neighbouring land tiles', `${tag} (${tx},${tz})→(${x},${z}) ${h}→${s.h[j]}`);
        if (d > 0) higher++;
        if (d < 0) lower++;
      }
      if (waterNb > 0) check(beach && s.ground[i] === B.SAND, 'land next to water is a SAND beach at h = 11', `${tag} (${tx},${tz}) h ${h}`);
      if (landNb >= 2) {
        // A tile strictly above all of its land neighbours is a spike; strictly below all of them
        // (and not a shore, which legitimately slopes down to the water) is a pit / sand notch.
        check(lower < landNb, 'no 1-tile spikes', `${tag} (${tx},${tz}) h ${h}`);
        if (waterNb === 0) check(higher < landNb, 'no 1-tile pits', `${tag} (${tx},${tz}) h ${h}`);
      }
    }
  }
  const total = N * N;
  check(land >= 0.7 * total, '≥ 70 % of tiles are land', `${tag} ${((100 * land) / total).toFixed(1)} %`);
  check(plain >= 0.55 * total, '≥ 55 % of tiles are central-plain height', `${tag} ${((100 * plain) / total).toFixed(1)} %`);
  // Central 16×16 dry plain at BASE_GROUND_HEIGHT; no decor in the central 12×12.
  for (let tz = MID - 8; tz < MID + 8; tz++)
    for (let tx = MID - 8; tx < MID + 8; tx++) {
      const i = tz * N + tx;
      check(!s.water[i] && s.h[i] === BASE_GROUND_HEIGHT, 'central 16×16 tiles are dry plain at BASE_GROUND_HEIGHT', `${tag} (${tx},${tz})`);
      if (tx >= MID - 6 && tx < MID + 6 && tz >= MID - 6 && tz < MID + 6) check(!s.decor[i], 'no decor in the central 12×12 tiles', `${tag} (${tx},${tz})`);
    }
  // Starter road row: (0, MID) is land; water on tx ∈ [0, MID] only as crossings of ≤ 4 tiles.
  check(!s.water[MID * N], 'starter road tile (0, 32) is land', tag);
  let run = 0;
  let longest = 0;
  let crossings = 0;
  for (let tx = 0; tx <= MID; tx++) {
    if (s.water[MID * N + tx]) {
      if (run === 0) crossings++;
      run++;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  check(longest <= 4, 'starter row water crossings are ≤ 4 tiles', `${tag} longest ${longest}`);
  // No puddles / tiny islands.
  const wc = components((i) => s.water[i] === 1);
  const minWater = wc.length ? Math.min(...wc.map((c) => c.size)) : 0;
  check(wc.length === 0 || minWater >= 4, 'no tiny water puddles (components ≥ 4 tiles)', `${tag} min ${minWater}`);
  const islands = components((i) => s.water[i] === 0).filter((c) => !c.edge && c.size < 4);
  check(islands.length === 0, 'no tiny land islands', `${tag} ${islands.length}`);
  // Decor: present, denser on hills than on the plain.
  if (hillTiles > 80 && plainTiles > 400) {
    check(treesHill / hillTiles > treesPlain / plainTiles, 'decor denser on hills than on the plain', `${tag} hills ${(treesHill / hillTiles).toFixed(2)} plain ${(treesPlain / plainTiles).toFixed(2)}`);
  }
  stats.water.push(1 - land / total);
  stats.plain.push(plain / total);
  stats.maxH.push(maxH);
  stats.crossings += crossings > 0 ? 1 : 0;
  stats.decor.push(s.decor.reduce((a, b) => a + b, 0) / total);
}

function terrainLayout() {
  section(`Terrain — layout invariants over ${opts.seeds} seeds (+ edge-case seeds)`);
  const seeds = [];
  for (let s = 1; s <= opts.seeds; s++) seeds.push(s);
  seeds.push(0, 0x7fffffff, 0x80000000, 0xffffffff, 123456789);
  const stats = { water: [], plain: [], maxH: [], crossings: 0, decor: [] };
  // Constructor timing: the first construction in a fresh process includes JIT warm-up.
  const tc0 = now();
  const first = new Terrain(98765);
  const coldMs = now() - tc0;
  const ctorTimes = [];
  for (const seed of seeds) {
    const t0 = now();
    const t = new Terrain(seed);
    ctorTimes.push(now() - t0);
    check(t.seed === seed >>> 0 && t.mapTiles === MAP_TILES, 'Terrain.seed = seed >>> 0 and mapTiles', `seed ${seed}`);
    layoutInvariants(seed, t, stats);
  }
  // Determinism: same seed → identical; different seeds → different.
  const a = snapshot(new Terrain(4242));
  const b = snapshot(new Terrain(4242));
  check(sameSnapshot(a, b), 'same seed → identical tile layout');
  let differ = 0;
  for (let s = 0; s < 8; s++) if (!sameSnapshot(snapshot(new Terrain(1000 + s)), snapshot(new Terrain(2000 + s)))) differ++;
  check(differ === 8, 'different seeds → different layouts');
  check(new Terrain(-1).seed === 0xffffffff, 'negative seeds are taken >>> 0');
  // Clamped queries.
  const t = first;
  check(t.getTileHeight(-5, 7) === t.getTileHeight(0, 7) && t.getTileHeight(N + 3, 7) === t.getTileHeight(N - 1, 7), 'getTileHeight clamps x');
  check(t.getTileHeight(9, -1) === t.getTileHeight(9, 0) && t.getTileHeight(9, 1e9) === t.getTileHeight(9, N - 1), 'getTileHeight clamps z');
  check(t.isWater(-1, -1) === t.isWater(0, 0) && t.getGroundBlock(N, N) === t.getGroundBlock(N - 1, N - 1), 'isWater / getGroundBlock clamp');
  check(t.hasNaturalDecor(-3, N + 4) === t.hasNaturalDecor(0, N - 1), 'hasNaturalDecor clamps');
  let finite = true;
  for (const v of [t.getTileHeight(NaN, 3), t.getSurfaceHeight(Infinity, -Infinity), t.getGroundBlock(NaN, NaN)]) if (!Number.isFinite(v)) finite = false;
  check(finite, 'NaN / ±Infinity queries return finite values');
  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
  const sorted = [...ctorTimes].sort((x, y) => x - y);
  info(`water ${(100 * mean(stats.water)).toFixed(1)} % (max ${(100 * Math.max(...stats.water)).toFixed(1)} %), plain ${(100 * mean(stats.plain)).toFixed(1)} % (min ${(100 * Math.min(...stats.plain)).toFixed(1)} %), decor ${(100 * mean(stats.decor)).toFixed(1)} % of tiles`);
  const hist = new Map();
  for (const m of stats.maxH) hist.set(m, (hist.get(m) ?? 0) + 1);
  info(`highest tile per map: ${[...hist].sort((x, y) => x[0] - y[0]).map(([h, c]) => `${h}:${c}`).join(' ')}; starter row crossed by water in ${stats.crossings}/${seeds.length} maps`);
  perf('Terrain constructor, first in process (cold JIT)', coldMs, 30);
  perf('Terrain constructor, median', sorted[sorted.length >> 1], 30);
  perf('Terrain constructor, worst', sorted[sorted.length - 1], 30);
}

// ------------------------------------------------------------------------------------ terrain: voxels

/** Compares two worlds voxel by voxel; returns the number of differing voxels (stops early at 'limit'). */
function diffWorlds(a, b, limit = 1) {
  const pa = new Uint8Array(PADDED_VOLUME);
  const pb = new Uint8Array(PADDED_VOLUME);
  let diffs = 0;
  for (let k = 0; k < CHUNK_COUNT && diffs < limit; k++) {
    const c = chunkCoordsFromKey(k);
    const ea = a.isChunkEmpty(c.cx, c.cy, c.cz);
    const eb = b.isChunkEmpty(c.cx, c.cy, c.cz);
    if (ea && eb) continue;
    a.extractPadded(c.cx, c.cy, c.cz, pa);
    b.extractPadded(c.cx, c.cy, c.cz, pb);
    for (let i = 0; i < PADDED_VOLUME; i++) if (pa[i] !== pb[i]) diffs++;
  }
  return diffs;
}

function terrainVoxels(seed) {
  const tag = `seed ${seed}`;
  const t = new Terrain(seed);
  const w1 = new VoxelWorld();
  const g0 = now();
  t.generateInto(w1);
  const genMs = now() - g0;

  // Column structure of every voxel column.
  let grassPairs = 0;
  let grassBreaks = 0;
  for (let tz = 0; tz < N; tz++) {
    for (let tx = 0; tx < N; tx++) {
      const h = t.getTileHeight(tx, tz);
      const water = t.isWater(tx, tz);
      const decor = t.hasNaturalDecor(tx, tz);
      const beach = !water && h === WATER_LEVEL + 1;
      let decorVoxels = 0;
      for (let lz = 0; lz < TILE_SIZE; lz++) {
        for (let lx = 0; lx < TILE_SIZE; lx++) {
          const x = tx * TILE_SIZE + lx;
          const z = tz * TILE_SIZE + lz;
          let ok = w1.getBlock(x, 0, z) === BEDROCK;
          for (let y = 1; y <= h - 5; y++) if (w1.getBlock(x, y, z) !== B.STONE) ok = false;
          for (let y = Math.max(1, h - 4); y <= h - 2; y++) if (w1.getBlock(x, y, z) !== B.DIRT) ok = false;
          check(ok, 'column layering: BEDROCK / STONE / DIRT', `${tag} (${x},${z}) h ${h}`);
          const top = w1.getBlock(x, h - 1, z);
          if (water) check(BED_TOPS.has(top), 'water bed voxel is SAND / GRAVEL / CLAY', `${tag} (${x},${z}) ${top}`);
          else if (beach) check(top === B.SAND, 'beach top voxel is SAND', `${tag} (${x},${z})`);
          else check(LAND_TOPS.has(top), 'land top voxel is grass / rock / snow / gravel', `${tag} (${x},${z}) ${top}`);
          if (lx === TILE_SIZE >> 1 && lz === TILE_SIZE >> 1) {
            check(top === t.getGroundBlock(tx, tz), 'getGroundBlock = top voxel of the tile centre column', `${tag} (${tx},${tz}) ${top} vs ${t.getGroundBlock(tx, tz)}`);
          }
          if (water) {
            let wok = true;
            for (let y = h; y < WATER_LEVEL; y++) if (w1.getBlock(x, y, z) !== B.WATER) wok = false;
            for (let y = WATER_LEVEL; y < SY; y++) if (w1.getBlock(x, y, z) !== B.AIR) wok = false;
            check(wok, 'water fills y ∈ [h, WATER_LEVEL-1], AIR above', `${tag} (${x},${z})`);
          } else {
            let aok = true;
            for (let y = h; y < SY; y++) {
              const v = w1.getBlock(x, y, z);
              if (v === B.AIR) continue;
              if (!decor || y >= h + DECOR_MAX || !DECOR_BLOCKS.has(v)) aok = false;
              else decorVoxels++;
            }
            check(aok, 'above ground: AIR, or decor blocks within 14 voxels on decor tiles', `${tag} (${x},${z})`);
            if (GRASSES.has(top) && lx > 0) {
              const left = w1.getBlock(x - 1, h - 1, z);
              if (GRASSES.has(left)) {
                grassPairs++;
                if (left !== top) grassBreaks++;
              }
            }
          }
        }
      }
      if (decor && !water) check(decorVoxels > 0, 'decor tiles have decor voxels', `${tag} (${tx},${tz})`);
    }
  }
  const run = grassBreaks ? grassPairs / grassBreaks : Infinity;
  check(run >= 6, 'grass shade patches are large (mean run ≥ 6 voxels)', `${tag} ${run.toFixed(1)}`);

  // Determinism at voxel level: a second Terrain instance writes identical voxels.
  const w2 = new VoxelWorld();
  new Terrain(seed).generateInto(w2);
  check(diffWorlds(w1, w2) === 0, 'same seed → identical voxels', tag);

  // Exactness: garbage over every tile (also high above the ground), then restoreTile → identical.
  const r = new Rng(seed ^ 0x9e3779b9);
  let restoreMs = 0;
  for (let tz = 0; tz < N; tz++) {
    for (let tx = 0; tx < N; tx++) {
      const x0 = tx * TILE_SIZE;
      const z0 = tz * TILE_SIZE;
      const boxes = r.int(1, 4);
      for (let i = 0; i < boxes; i++) {
        const a = r.int(0, 8);
        const c = r.int(0, 8);
        const y0 = r.int(0, SY - 1);
        w2.fillBox(x0 + a, y0, z0 + c, x0 + a + r.int(1, 9 - a), y0 + r.int(1, 60), z0 + c + r.int(1, 9 - c), r.chance(0.2) ? B.AIR : r.int(1, 255));
      }
      if (r.chance(0.3)) w2.setBlock(x0 + r.int(0, 8), SY - 1, z0 + r.int(0, 8), B.CONCRETE);
      const t0 = now();
      t.restoreTile(w2, tx, tz, t.hasNaturalDecor(tx, tz));
      restoreMs += now() - t0;
    }
  }
  const d = diffWorlds(w1, w2, 1e9);
  check(d === 0, 'garbage + restoreTile(every tile) is bit-identical to generateInto', `${tag} ${d} voxels differ`);
  // Restoring an untouched tile changes nothing (no spurious remesh).
  w2.takeDirtyChunks();
  const rev = w2.revision;
  for (let tz = 0; tz < N; tz += 3) for (let tx = 0; tx < N; tx += 3) t.restoreTile(w2, tx, tz, t.hasNaturalDecor(tx, tz));
  check(w2.revision === rev && w2.takeDirtyChunks().length === 0, 'restoreTile on an untouched tile is a no-op', tag);
  // Out-of-map restore is a no-op.
  t.restoreTile(w2, -1, 5, true);
  t.restoreTile(w2, 5, N, true);
  t.restoreTile(w2, NaN, 5, true);
  check(w2.revision === rev, 'restoreTile outside the map is a no-op', tag);

  // restoreTile(…, false): removes the tile's decor, keeps ground / water, touches nothing outside.
  let checked = 0;
  for (let tz = 0; tz < N && checked < 160; tz++) {
    for (let tx = (tz * 7) % 5; tx < N && checked < 160; tx += 5) {
      if (!t.hasNaturalDecor(tx, tz)) continue;
      checked++;
      const h = t.getTileHeight(tx, tz);
      const x0 = tx * TILE_SIZE;
      const z0 = tz * TILE_SIZE;
      t.restoreTile(w2, tx, tz, false);
      let clean = true;
      let ground = true;
      for (let z = z0; z < z0 + TILE_SIZE; z++)
        for (let x = x0; x < x0 + TILE_SIZE; x++) {
          for (let y = h; y < SY; y++) if (w2.getBlock(x, y, z) !== B.AIR) clean = false;
          for (let y = 0; y < h; y++) if (w2.getBlock(x, y, z) !== w1.getBlock(x, y, z)) ground = false;
        }
      check(clean, 'restoreTile(…, false) leaves only AIR above h', `${tag} (${tx},${tz})`);
      check(ground, 'restoreTile(…, false) restores the ground below h', `${tag} (${tx},${tz})`);
      let outside = true;
      for (let z = z0 - 1; z <= z0 + TILE_SIZE; z++)
        for (let x = x0 - 1; x <= x0 + TILE_SIZE; x++) {
          if (x >= x0 && x < x0 + TILE_SIZE && z >= z0 && z < z0 + TILE_SIZE) continue;
          for (let y = 0; y < SY; y++) if (w2.getBlock(x, y, z) !== w1.getBlock(x, y, z)) outside = false;
        }
      check(outside, 'restoreTile touches nothing outside the tile footprint', `${tag} (${tx},${tz})`);
      t.restoreTile(w2, tx, tz, true);
    }
  }
  check(diffWorlds(w1, w2) === 0, 'restoreTile(…, true) brings the decor back exactly', tag);
  // Water tiles restored without decor keep their water.
  let waterTile = -1;
  for (let i = 0; i < N * N && waterTile < 0; i++) if (t.isWater(i % N, (i / N) | 0)) waterTile = i;
  if (waterTile >= 0) {
    const tx = waterTile % N;
    const tz = (waterTile / N) | 0;
    w2.fillBox(tx * 8, 0, tz * 8, tx * 8 + 8, 40, tz * 8 + 8, B.CONCRETE);
    t.restoreTile(w2, tx, tz, false);
    check(diffWorlds(w1, w2) === 0, 'restoreTile on a water tile brings the water back', tag);
  }
  return { genMs, restoreAvg: restoreMs / (N * N) };
}

function terrainVoxelSuite() {
  if (opts.voxelSeeds <= 0) return;
  section(`Terrain — voxel checks + restoreTile exactness for ${opts.voxelSeeds} seed(s)`);
  const gen = [];
  const rest = [];
  for (let i = 0; i < opts.voxelSeeds; i++) {
    const seed = [7, 1, 31337, 5, 99, 2024, 3, 11][i] ?? 1000 + i;
    const { genMs, restoreAvg } = terrainVoxels(seed);
    gen.push(genMs);
    rest.push(restoreAvg);
    info(`seed ${seed}: generateInto ${genMs.toFixed(1)} ms, restoreTile avg ${(restoreAvg * 1000).toFixed(1)} µs`);
  }
  perf('generateInto (best seed)', Math.min(...gen), 400);
  perf('generateInto (worst seed, includes first-run JIT)', Math.max(...gen), 400);
  perf('restoreTile average over garbage tiles', Math.max(...rest), 0.1);
}

// ------------------------------------------------------------------------------------ noise

function noiseChecks() {
  section('Noise — range and determinism');
  const { Simplex2, fbm2, ridged2, createNoise2D } = noise;
  const a = new Simplex2(1234);
  const b = new Simplex2(1234);
  const c = new Simplex2(4321);
  let same = true;
  let differs = false;
  let lo = Infinity;
  let hi = -Infinity;
  let fLo = Infinity;
  let fHi = -Infinity;
  let rLo = Infinity;
  let rHi = -Infinity;
  const r = new Rng(77);
  for (let i = 0; i < 100000; i++) {
    const x = r.range(-500, 500);
    const y = r.range(-500, 500);
    const v = a.noise(x, y);
    if (v !== b.noise(x, y)) same = false;
    if (v !== c.noise(x, y)) differs = true;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    const f = fbm2(a, x / 7, y / 7, 4);
    fLo = Math.min(fLo, f);
    fHi = Math.max(fHi, f);
    const g = ridged2(a, x / 7, y / 7, 3);
    rLo = Math.min(rLo, g);
    rHi = Math.max(rHi, g);
  }
  check(same, 'Simplex2: same seed → same values');
  check(differs, 'Simplex2: different seeds → different values');
  check(lo >= -1 && hi <= 1 && hi - lo > 1.2, 'Simplex2 output within [-1, 1] and well spread', `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
  check(fLo >= -1 && fHi <= 1, 'fbm2 within [-1, 1]', `[${fLo.toFixed(3)}, ${fHi.toFixed(3)}]`);
  check(rLo >= 0 && rHi <= 1, 'ridged2 within [0, 1]', `[${rLo.toFixed(3)}, ${rHi.toFixed(3)}]`);
  const f = createNoise2D(1234);
  check(f(3.3, -7.1) === a.noise(3.3, -7.1), 'createNoise2D wraps the same seeded noise');

  // LatticeField: exact at lattice points, bilinear in between, toCells() === at(cell centre).
  const { LatticeField } = noise;
  for (const [n, step] of [[64, 1], [64, 2], [64, 4], [17, 4], [16, 2], [5, 4]]) {
    const field = new LatticeField(n, step, (x, z) => a.fbm(x / 9, z / 9, 2));
    const cells = field.toCells();
    let exact = cells.length === n * n;
    for (let z = 0; z < n && exact; z++) {
      for (let x = 0; x < n; x++) {
        if (cells[x + n * z] !== field.at(x + 0.5, z + 0.5)) {
          exact = false;
          break;
        }
      }
    }
    check(exact, 'LatticeField.toCells() equals at() at every cell centre', `n ${n} step ${step}`);
    let onPoints = true;
    for (let j = 0; j * step < n; j++) {
      for (let i = 0; i * step < n; i++) {
        const want = Math.fround(a.fbm((i * step + 0.5) / 9, (j * step + 0.5) / 9, 2));
        if (field.at(i * step + 0.5, j * step + 0.5) !== want) onPoints = false;
      }
    }
    check(onPoints, 'LatticeField is exact at lattice points', `n ${n} step ${step}`);
    // Between two lattice points: the linear blend.
    if (step > 1 && n > step) {
      const mid = field.at(0.5 + step / 2, 0.5);
      const want = Math.fround(0.5 * (field.at(0.5, 0.5) + field.at(0.5 + step, 0.5)));
      check(Math.abs(mid - want) < 1e-6, 'LatticeField interpolates linearly between lattice points', `${mid} vs ${want}`);
    }
    const clamped = field.at(-50, NaN) === field.at(0.5, 0.5) && field.at(1e9, 1e9) === field.at(n - 0.5 + step, n - 0.5 + step);
    check(clamped, 'LatticeField.at clamps out-of-range / NaN coordinates', `n ${n} step ${step}`);
  }
}

// ------------------------------------------------------------------------------------ main

const t0 = now();
worldTargeted();
worldRandom();
if (opts.bench) worldBench();
noiseChecks();
terrainLayout();
terrainVoxelSuite();

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s)${failCounts.size ? ` in ${failCounts.size} check(s)` : ''}, ${warnings} perf warning(s), ${((now() - t0) / 1000).toFixed(1)} s`);
if (failCounts.size) for (const [k, v] of failCounts) console.log(`  ${v}× ${k}`);
process.exit(failures === 0 ? 0 : 1);
