/** Block palette sanity (frozen contract src/voxel/blocks.ts). */
import { describe, expect, it } from 'vitest';
import { B, BLOCK_DEFS, MAX_BLOCK_ID } from '../../src/voxel/blocks';

describe('block palette', () => {
  it('has unique ids within 1..MAX_BLOCK_ID', () => {
    const ids = BLOCK_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(MAX_BLOCK_ID);
    }
  });

  it('every def name maps back to its id in B', () => {
    for (const d of BLOCK_DEFS) expect(B[d.name]).toBe(d.id);
  });

  it('colors are 24-bit', () => {
    for (const d of BLOCK_DEFS) {
      expect(d.color).toBeGreaterThanOrEqual(0);
      expect(d.color).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('only WATER is transparent', () => {
    expect(BLOCK_DEFS.filter((d) => d.transparent).map((d) => d.name)).toEqual(['WATER']);
  });
});
