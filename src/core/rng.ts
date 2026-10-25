/**
 * FROZEN CONTRACT — deterministic seeded randomness + integer hashing.
 * Owner: integrator. Module agents MUST NOT edit this file.
 * Worker-safe (no DOM / three imports).
 *
 * Determinism matters: terrain, buildings and roads are regenerated from seeds on load, so any
 * procedural generator must derive ALL randomness from these helpers (never Math.random()).
 */

/** mulberry32 PRNG. Small, fast, good enough for games. State is a uint32 (persistable). */
export class Rng {
  /** Current internal state (uint32). Save/restore it to resume a sequence. */
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform uint32. */
  nextU32(): number {
    return Math.floor(this.next() * 4294967296) >>> 0;
  }

  /** Integer in [min, maxExclusive). Returns min if the range is empty. */
  int(min: number, maxExclusive: number): number {
    if (maxExclusive <= min) return min;
    return min + Math.floor(this.next() * (maxExclusive - min));
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** true with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Random element (undefined for an empty array). */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Weighted pick: weights[i] ≥ 0. Returns an index. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return 0;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** A new independent generator derived from this one's seed space and a salt (does not advance this). */
  fork(salt: number): Rng {
    return new Rng(mixSeed(this.state, salt));
  }
}

/** Finalizer-quality 32-bit integer mix (murmur3 fmix32). */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combine two 32-bit values into a well-mixed uint32 seed. */
export function mixSeed(a: number, b: number): number {
  return fmix32((Math.imul(a >>> 0, 0x9e3779b1) ^ (b >>> 0)) + 0x7f4a7c15);
}

/** Deterministic uint32 hash of (x, z, seed). */
export function hash2(x: number, z: number, seed: number): number {
  let h = (seed >>> 0) ^ 0x27d4eb2d;
  h = fmix32(h ^ Math.imul(x | 0, 0x8da6b343));
  h = fmix32(h ^ Math.imul(z | 0, 0xd8163841));
  return h;
}

/** Deterministic uint32 hash of (x, y, z, seed). */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (seed >>> 0) ^ 0x165667b1;
  h = fmix32(h ^ Math.imul(x | 0, 0x8da6b343));
  h = fmix32(h ^ Math.imul(y | 0, 0xcb1ab31f));
  h = fmix32(h ^ Math.imul(z | 0, 0xd8163841));
  return h;
}

/** Map a uint32 hash to [0, 1). */
export function hashToUnit(h: number): number {
  return (h >>> 0) / 4294967296;
}

/** Non-deterministic uint32 seed for new games (crypto when available). */
export function randomSeed(): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] >>> 0;
  }
  return Math.floor(Math.random() * 4294967296) >>> 0;
}
