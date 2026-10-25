/**
 * MODULE: persistence — save file encoding, decoding, validation and version migration.
 * Owner: persistence agent. Module-internal API (only saveManager.ts uses it); may change, but the
 * stored FORMAT below is the documented contract (ARCHITECTURE.md §15) — keep it in sync.
 *
 * STUB: JSON-only placeholder without typed-array support. Replace entirely.
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
import { SAVE_VERSION, type SavePayload } from '../types';

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

/** Encode a payload into the stored string (envelope JSON). */
export function encodeSave(payload: SavePayload, savedAt: number = Date.now()): string {
  // TODO(persistence)
  const env: SaveEnvelope = {
    format: 'vcb-save',
    version: SAVE_VERSION,
    savedAt,
    meta: { name: payload.city.name, day: payload.city.day, money: payload.city.money, population: 0 },
    payload: null,
  };
  return JSON.stringify(env);
}

/** Decode a stored string. Throws SaveFormatError on any problem. */
export function decodeSave(text: string): { payload: SavePayload; envelope: SaveEnvelope } {
  // TODO(persistence)
  throw new SaveFormatError('Save decoding not implemented');
}

/** Read only the envelope header/meta (for slot listings). null if unreadable. */
export function readEnvelope(text: string): SaveEnvelope | null {
  // TODO(persistence)
  return null;
}

/** Byte run-length encoding: [count, value] pairs, count 1..255. */
export function rleEncode(bytes: Uint8Array): Uint8Array {
  // TODO(persistence)
  return new Uint8Array(0);
}

/** Inverse of rleEncode; throws SaveFormatError if the output length != expectedLength. */
export function rleDecode(data: Uint8Array, expectedLength: number): Uint8Array {
  // TODO(persistence)
  return new Uint8Array(expectedLength);
}

export function bytesToBase64(bytes: Uint8Array): string {
  // TODO(persistence)
  return '';
}

export function base64ToBytes(b64: string): Uint8Array {
  // TODO(persistence)
  return new Uint8Array(0);
}
