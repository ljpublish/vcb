/** Frozen contracts in src/core: these must pass on main at all times. */
import { describe, expect, it, vi } from 'vitest';
import { MAP_TILES, TILE_COUNT } from '../../src/types';
import {
  inMap,
  isEdgeTile,
  lPathTiles,
  manhattan,
  rectTiles,
  straightPathTiles,
  tileFromIndex,
  tileIndex,
} from '../../src/core/coords';
import { Rng } from '../../src/core/rng';
import { EventBus } from '../../src/core/events';

describe('coords', () => {
  it('tileIndex and tileFromIndex round-trip over the whole map', () => {
    for (let i = 0; i < TILE_COUNT; i++) {
      const { tx, tz } = tileFromIndex(i);
      expect(inMap(tx, tz)).toBe(true);
      expect(tileIndex(tx, tz)).toBe(i);
    }
  });

  it('edge tiles are exactly the outer ring', () => {
    let edges = 0;
    for (let tz = 0; tz < MAP_TILES; tz++) for (let tx = 0; tx < MAP_TILES; tx++) if (isEdgeTile(tx, tz)) edges++;
    expect(edges).toBe(4 * MAP_TILES - 4);
  });

  it('rectTiles is inclusive and clipped to the map', () => {
    expect(rectTiles({ tx: 2, tz: 3 }, { tx: 4, tz: 5 })).toHaveLength(9);
    expect(rectTiles({ tx: -5, tz: -5 }, { tx: 1, tz: 1 })).toHaveLength(4);
  });

  it('lPathTiles is 4-connected, duplicate-free and ends at both endpoints', () => {
    const rng = new Rng(42);
    for (let n = 0; n < 200; n++) {
      const a = { tx: rng.int(0, MAP_TILES), tz: rng.int(0, MAP_TILES) };
      const b = { tx: rng.int(0, MAP_TILES), tz: rng.int(0, MAP_TILES) };
      const path = lPathTiles(a, b);
      expect(path[0]).toEqual(a);
      expect(path[path.length - 1]).toEqual(b);
      expect(path).toHaveLength(manhattan(a, b) + 1);
      expect(new Set(path.map((t) => tileIndex(t.tx, t.tz))).size).toBe(path.length);
      for (let i = 1; i < path.length; i++) expect(manhattan(path[i - 1], path[i])).toBe(1);
    }
  });

  it('straightPathTiles stays on one axis', () => {
    const path = straightPathTiles({ tx: 10, tz: 10 }, { tx: 20, tz: 13 });
    expect(path.every((t) => t.tz === 10)).toBe(true);
    expect(path).toHaveLength(11);
  });
});

describe('rng', () => {
  it('is deterministic per seed and resumable from its state', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const seqA = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(seqA);

    const c = new Rng(99);
    for (let i = 0; i < 10; i++) c.next();
    const resumed = new Rng(0);
    resumed.state = c.state;
    expect(resumed.next()).toBe(c.next());
  });

  it('stays in range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const f = r.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = r.int(3, 9);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThan(9);
    }
  });
});

describe('event bus', () => {
  type E = { ping: { n: number } };

  it('delivers, unsubscribes, and supports once()', () => {
    const bus = new EventBus<E>();
    const seen: number[] = [];
    const off = bus.on('ping', (p) => seen.push(p.n));
    bus.once('ping', (p) => seen.push(p.n * 10));
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    off();
    bus.emit('ping', { n: 3 });
    expect(seen).toEqual([1, 10, 2]);
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('isolates a throwing handler from the others', () => {
    const bus = new EventBus<E>();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reached = false;
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.on('ping', () => {
      reached = true;
    });
    bus.emit('ping', { n: 1 });
    expect(reached).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
