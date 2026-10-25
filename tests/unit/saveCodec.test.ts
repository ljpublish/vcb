/**
 * Save codec contract tests (ARCHITECTURE.md §15, persistence brief).
 * Skipped while src/persist/saveCodec.ts is still the skeleton stub.
 */
import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, decodeSave, encodeSave, rleDecode, rleEncode } from '../../src/persist/saveCodec';
import { Simulation } from '../../src/sim/simulation';
import { createGameBus } from '../../src/core/events';
import { lPathTiles, rectTiles } from '../../src/core/coords';
import { Rng } from '../../src/core/rng';
import { TILE_COUNT, ZoneType } from '../../src/types';
import { flatTerrain } from '../support/fakeTerrain';
import { pendingReason } from '../support/pending';

const pending = pendingReason('codec');
const pendingWithSim = pendingReason('codec', 'simulation');

function randomBytes(n: number, seed: number, runs: boolean): Uint8Array {
  const rng = new Rng(seed);
  const out = new Uint8Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    if (!runs || rng.chance(0.05)) v = rng.int(0, 256);
    out[i] = v;
  }
  return out;
}

describe.skipIf(!!pending)(`save codec${pending ? ` (${pending})` : ''}`, () => {
  it('RLE round-trips noisy and run-heavy data', () => {
    for (const runs of [false, true]) {
      const bytes = randomBytes(TILE_COUNT, runs ? 1 : 2, runs);
      expect(rleDecode(rleEncode(bytes), TILE_COUNT)).toEqual(bytes);
    }
    const flat = new Uint8Array(TILE_COUNT);
    expect(rleEncode(flat).length).toBeLessThan(64);
  });

  it('base64 round-trips large buffers', () => {
    const bytes = randomBytes(200_000, 3, false);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('rejects garbage', () => {
    expect(() => decodeSave('not a save')).toThrow();
    expect(() => decodeSave('{"format":"something-else"}')).toThrow();
  });
});

describe.skipIf(!!pendingWithSim)(`save round-trip${pendingWithSim ? ` (${pendingWithSim})` : ''}`, () => {
  it('encode → decode reproduces sim.serialize()', () => {
    const sim = new Simulation({ bus: createGameBus(), terrain: flatTerrain(11) });
    sim.newCity({ seed: 11, name: 'Roundtrip' });
    sim.applyAction({ type: 'road', tiles: lPathTiles({ tx: 0, tz: 10 }, { tx: 20, tz: 10 }) });
    sim.applyAction({ type: 'zone', zone: ZoneType.Residential, tiles: rectTiles({ tx: 2, tz: 9 }, { tx: 18, tz: 9 }) });
    sim.tick(200);
    const city = sim.serialize();

    const { payload, envelope } = decodeSave(encodeSave({ city }, 1_700_000_000_000));
    expect(envelope.meta.population).toBe(sim.getStats().population);
    const norm = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (ArrayBuffer.isView(x) ? Array.from(x as Uint8Array) : x));
    expect(norm(payload.city)).toBe(norm(city));
  });
});
