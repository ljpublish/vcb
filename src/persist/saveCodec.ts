/**
 * MODULE: persistence — save file encoding, decoding, validation and version migration.
 * Owner: persistence agent. Module-internal API (only saveManager.ts uses it); may change, but the
 * stored FORMAT below is the documented contract (ARCHITECTURE.md §15) — keep it in sync.
 *
 * Stored at localStorage[SAVE_KEY_PREFIX + slot] as a JSON string of SaveEnvelope:
 *   {
 *     "format": "vcb-save",
 *     "version": 1,                       // SAVE_VERSION at write time
 *     "savedAt": 1761350000000,           // ms epoch
 *     "meta": { "name", "day", "money", "population" },   // cheap slot listing
 *     "payload": EncodedPayloadV1
 *   }
 * EncodedPayloadV1 = { city: EncodedCityV1, camera?: CameraState }
 * EncodedCityV1 = all CitySnapshot scalar fields as-is, plus
 *     tileKind / tileZone / tileFlags : string  — base64 of a byte-RLE ([count, value] pairs, count 1..255)
 *     buildings : number[][]  — tuples [id, zone, level, tx, tz, size, facing, variant, state, stage,
 *                               stateDays, occupants, capacity, builtDay]
 *     history   : number[][]  — tuples [day, population, money, jobs, demandR, demandC, demandI]
 *     extra     : object      — verbatim
 * Population for meta = Σ occupants of residential buildings.
 *
 * Decoding: JSON.parse → check format → migrate(version → SAVE_VERSION) step by step
 * (MIGRATIONS[v] upgrades v → v+1) → decode → validate EVERYTHING (array lengths = TILE_COUNT,
 * enum ranges, building footprints in map, finite numbers) → SavePayload. Any problem throws
 * SaveFormatError (caught by SaveManager → null). Versions newer than SAVE_VERSION are rejected.
 * Round-trip guarantee: decodeSave(encodeSave(p)).payload deep-equals p (typed arrays included).
 */
import {
  MAP_TILES,
  SAVE_VERSION,
  TAX_MAX,
  TAX_MIN,
  TILE_COUNT,
  type Building,
  type CameraState,
  type CitySnapshot,
  type HistorySample,
  type SavePayload,
} from '../types';

export class SaveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveFormatError';
  }
}

export interface SaveMeta {
  name: string;
  day: number;
  money: number;
  population: number;
}

export interface SaveEnvelope {
  format: 'vcb-save';
  version: number;
  savedAt: number;
  meta: SaveMeta;
  payload: unknown;
}

export const SAVE_FORMAT = 'vcb-save';

/** Building tuple: [id, zone, level, tx, tz, size, facing, variant, state, stage, stateDays, occupants, capacity, builtDay]. */
type BuildingTuple = [number, number, number, number, number, number, number, number, number, number, number, number, number, number];
/** History tuple: [day, population, money, jobs, demandR, demandC, demandI]. */
type HistoryTuple = [number, number, number, number, number, number, number];

interface EncodedCityV1 {
  version: number;
  mapTiles: number;
  seed: number;
  name: string;
  day: number;
  money: number;
  speed: number;
  taxRates: { r: number; c: number; i: number };
  rngState: number;
  nextBuildingId: number;
  tileKind: string;
  tileZone: string;
  tileFlags: string;
  buildings: BuildingTuple[];
  history: HistoryTuple[];
  extra: Record<string, unknown>;
}

/**
 * Step-by-step upgrades: MIGRATIONS[v] turns a version-v envelope into a version-(v+1) envelope.
 * Empty for v1. Exposed (mutable) so tests can register a fake migration.
 */
export const MIGRATIONS: Record<number, (env: SaveEnvelope) => SaveEnvelope> = {};

// ---------- encode ----------

/** Encode a payload into the stored string (envelope JSON). */
export function encodeSave(payload: SavePayload, savedAt: number = Date.now()): string {
  const c = payload.city;
  let population = 0;
  for (const b of c.buildings) if (b.zone === 1) population += b.occupants;

  const city: EncodedCityV1 = {
    version: c.version,
    mapTiles: c.mapTiles,
    seed: c.seed,
    name: c.name,
    day: c.day,
    money: c.money,
    speed: c.speed,
    taxRates: { r: c.taxRates.r, c: c.taxRates.c, i: c.taxRates.i },
    rngState: c.rngState,
    nextBuildingId: c.nextBuildingId,
    tileKind: bytesToBase64(rleEncode(c.tileKind)),
    tileZone: bytesToBase64(rleEncode(c.tileZone)),
    tileFlags: bytesToBase64(rleEncode(c.tileFlags)),
    buildings: c.buildings.map((b): BuildingTuple => [
      b.id, b.zone, b.level, b.tx, b.tz, b.size, b.facing, b.variant,
      b.state, b.stage, b.stateDays, b.occupants, b.capacity, b.builtDay,
    ]),
    history: c.history.map((h): HistoryTuple => [
      h.day, h.population, h.money, h.jobs, h.demand.r, h.demand.c, h.demand.i,
    ]),
    extra: c.extra,
  };
  const encoded: { city: EncodedCityV1; camera?: CameraState } = { city };
  if (payload.camera) encoded.camera = { ...payload.camera };

  const env: SaveEnvelope = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt,
    meta: { name: c.name, day: c.day, money: c.money, population },
    payload: encoded,
  };
  return JSON.stringify(env);
}

// ---------- decode ----------

/** Decode a stored string. Throws SaveFormatError on any problem. */
export function decodeSave(text: string): { payload: SavePayload; envelope: SaveEnvelope } {
  let env = parseEnvelope(text);
  env = migrate(env);
  const payload = decodePayload(env.payload);
  return { payload, envelope: env };
}

/** Read only the envelope header/meta (for slot listings). null if unreadable. */
export function readEnvelope(text: string): SaveEnvelope | null {
  try {
    const env = parseEnvelope(text);
    const m = env.meta as unknown;
    if (!isObject(m)) return null;
    const meta: SaveMeta = {
      name: typeof m.name === 'string' ? m.name : '',
      day: finiteOr(m.day, 0),
      money: finiteOr(m.money, 0),
      population: finiteOr(m.population, 0),
    };
    return { ...env, meta };
  } catch {
    return null;
  }
}

function parseEnvelope(text: string): SaveEnvelope {
  if (typeof text !== 'string') throw new SaveFormatError('Save data is not text');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SaveFormatError(`Save data is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(raw) || raw.format !== SAVE_FORMAT) throw new SaveFormatError('Not a VCB save');
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new SaveFormatError('Invalid save version');
  }
  if (version > SAVE_VERSION) throw new SaveFormatError(`Save was made by a newer version (v${version})`);
  const savedAt = typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0;
  return {
    format: SAVE_FORMAT,
    version,
    savedAt,
    meta: raw.meta as SaveMeta,
    payload: raw.payload,
  };
}

function migrate(env: SaveEnvelope): SaveEnvelope {
  let cur = env;
  while (cur.version < SAVE_VERSION) {
    const step = MIGRATIONS[cur.version];
    if (!step) throw new SaveFormatError(`No migration from save version ${cur.version}`);
    const from = cur.version;
    try {
      cur = step(cur);
    } catch (err) {
      if (err instanceof SaveFormatError) throw err;
      throw new SaveFormatError(`Migration from v${from} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isObject(cur) || cur.version !== from + 1) {
      throw new SaveFormatError(`Migration from v${from} produced an invalid envelope`);
    }
  }
  return cur;
}

function decodePayload(raw: unknown): SavePayload {
  if (!isObject(raw)) throw new SaveFormatError('Missing payload');
  const city = decodeCity(raw.city);
  const payload: SavePayload = { city };
  const camera = decodeCamera(raw.camera);
  if (camera) payload.camera = camera;
  return payload;
}

function decodeCity(raw: unknown): CitySnapshot {
  if (!isObject(raw)) throw new SaveFormatError('Missing city');

  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) fail('city.version');
  if (raw.mapTiles !== MAP_TILES) throw new SaveFormatError(`Unsupported map size ${String(raw.mapTiles)}`);
  const seed = uint32(raw.seed, 'seed');
  if (typeof raw.name !== 'string') fail('name');
  const name = raw.name;
  const day = intMin(raw.day, 0, 'day');
  const money = finite(raw.money, 'money');
  const speed = intRange(raw.speed, 0, 3, 'speed') as CitySnapshot['speed'];
  const tr = raw.taxRates;
  if (!isObject(tr)) fail('taxRates');
  const taxRates = {
    r: range(tr.r, TAX_MIN, TAX_MAX, 'taxRates.r'),
    c: range(tr.c, TAX_MIN, TAX_MAX, 'taxRates.c'),
    i: range(tr.i, TAX_MIN, TAX_MAX, 'taxRates.i'),
  };
  const rngState = uint32(raw.rngState, 'rngState');
  const nextBuildingId = intMin(raw.nextBuildingId, 1, 'nextBuildingId');

  const tileKind = decodeTiles(raw.tileKind, 'tileKind', 3);
  const tileZone = decodeTiles(raw.tileZone, 'tileZone', 3);
  const tileFlags = decodeTiles(raw.tileFlags, 'tileFlags', 255);

  if (!Array.isArray(raw.buildings)) fail('buildings');
  const ids = new Set<number>();
  const buildings: Building[] = raw.buildings.map((t: unknown, idx: number) => {
    const b = decodeBuilding(t, idx);
    if (ids.has(b.id)) throw new SaveFormatError(`Duplicate building id ${b.id}`);
    ids.add(b.id);
    if (b.id >= nextBuildingId) throw new SaveFormatError(`Building id ${b.id} ≥ nextBuildingId`);
    return b;
  });

  if (!Array.isArray(raw.history)) fail('history');
  const history: HistorySample[] = raw.history.map((t: unknown, idx: number) => {
    if (!Array.isArray(t) || t.length !== 7) fail(`history[${idx}]`);
    for (let k = 0; k < 7; k++) finite(t[k], `history[${idx}][${k}]`);
    const h = t as HistoryTuple;
    return { day: h[0], population: h[1], money: h[2], jobs: h[3], demand: { r: h[4], c: h[5], i: h[6] } };
  });

  let extra: Record<string, unknown> = {};
  if (raw.extra !== undefined) {
    if (!isObject(raw.extra)) fail('extra');
    extra = raw.extra;
  }

  return {
    version, mapTiles: MAP_TILES, seed, name, day, money, speed, taxRates, rngState, nextBuildingId,
    tileKind, tileZone, tileFlags, buildings, history, extra,
  };
}

function decodeBuilding(t: unknown, idx: number): Building {
  const f = `buildings[${idx}]`;
  if (!Array.isArray(t) || t.length !== 14) fail(`${f} (tuple length)`);
  const id = intMin(t[0], 1, `${f}.id`);
  const zone = intRange(t[1], 1, 3, `${f}.zone`) as Building['zone'];
  const level = intRange(t[2], 1, 3, `${f}.level`) as Building['level'];
  const tx = intMin(t[3], 0, `${f}.tx`);
  const tz = intMin(t[4], 0, `${f}.tz`);
  const size = intRange(t[5], 1, 2, `${f}.size`) as Building['size'];
  if (tx + size > MAP_TILES || tz + size > MAP_TILES) throw new SaveFormatError(`${f} footprint outside the map`);
  const facing = intRange(t[6], 0, 3, `${f}.facing`) as Building['facing'];
  const variant = uint32(t[7], `${f}.variant`);
  const state = intRange(t[8], 0, 2, `${f}.state`) as Building['state'];
  const stage = intRange(t[9], 0, 2, `${f}.stage`);
  const stateDays = finiteMin0(t[10], `${f}.stateDays`);
  const occupants = finiteMin0(t[11], `${f}.occupants`);
  const capacity = finiteMin0(t[12], `${f}.capacity`);
  const builtDay = finiteMin0(t[13], `${f}.builtDay`);
  return { id, zone, level, tx, tz, size, facing, variant, state, stage, stateDays, occupants, capacity, builtDay };
}

function decodeTiles(raw: unknown, field: string, maxValue: number): Uint8Array {
  if (typeof raw !== 'string') fail(field);
  const bytes = rleDecode(base64ToBytes(raw), TILE_COUNT);
  if (maxValue < 255) {
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i]! > maxValue) throw new SaveFormatError(`${field}[${i}] out of range (${bytes[i]})`);
    }
  }
  return bytes;
}

function decodeCamera(raw: unknown): CameraState | undefined {
  if (!isObject(raw)) return undefined;
  const { x, z, yaw, pitch, distance } = raw;
  for (const v of [x, z, yaw, pitch, distance]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  }
  return { x: x as number, z: z as number, yaw: yaw as number, pitch: pitch as number, distance: distance as number };
}

// ---------- RLE / base64 ----------

/** Byte run-length encoding: [count, value] pairs, count 1..255. */
export function rleEncode(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  if (n === 0) return new Uint8Array(0);
  // Worst case (no runs): 2 bytes per input byte.
  const out = new Uint8Array(n * 2);
  let o = 0;
  let i = 0;
  while (i < n) {
    const v = bytes[i]!;
    let run = 1;
    while (i + run < n && run < 255 && bytes[i + run] === v) run++;
    out[o++] = run;
    out[o++] = v;
    i += run;
  }
  return out.slice(0, o);
}

/** Inverse of rleEncode; throws SaveFormatError if the output length != expectedLength. */
export function rleDecode(data: Uint8Array, expectedLength: number): Uint8Array {
  if (data.length % 2 !== 0) throw new SaveFormatError('RLE data has odd length');
  const out = new Uint8Array(expectedLength);
  let o = 0;
  for (let i = 0; i < data.length; i += 2) {
    const count = data[i]!;
    if (count === 0) throw new SaveFormatError('RLE run with count 0');
    if (o + count > expectedLength) throw new SaveFormatError('RLE data overflows the expected length');
    out.fill(data[i + 1]!, o, o + count);
    o += count;
  }
  if (o !== expectedLength) throw new SaveFormatError(`RLE data too short (${o} of ${expectedLength})`);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new SaveFormatError('Invalid base64');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- validation helpers ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(field: string): never {
  throw new SaveFormatError(`Invalid save field: ${field}`);
}

function finite(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(field);
  return v;
}

function finiteOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function finiteMin0(v: unknown, field: string): number {
  const n = finite(v, field);
  if (n < 0) fail(field);
  return n;
}

function range(v: unknown, min: number, max: number, field: string): number {
  const n = finite(v, field);
  if (n < min || n > max) fail(field);
  return n;
}

function intMin(v: unknown, min: number, field: string): number {
  const n = finite(v, field);
  if (!Number.isInteger(n) || n < min) fail(field);
  return n;
}

function intRange(v: unknown, min: number, max: number, field: string): number {
  const n = intMin(v, min, field);
  if (n > max) fail(field);
  return n;
}

function uint32(v: unknown, field: string): number {
  return intRange(v, 0, 0xffffffff, field);
}
