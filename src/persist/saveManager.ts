/**
 * MODULE: persistence — localStorage save slots + autosave.
 * Owner: persistence agent. Implements ISaveManager (src/types.ts).
 *
 * STUB: nothing is stored. Replace entirely.
 *
 * Intended:
 *  - key(slot) = SAVE_KEY_PREFIX + slot. Slot names: [a-z0-9_-]{1,32}; reject others.
 *  - save(): encodeSave → storage.setItem in try/catch (QuotaExceededError → { ok:false, error });
 *    emits 'save:written' { slot, bytes, auto: slot === AUTOSAVE_SLOT && called from the timer }.
 *    Never throws. storage === null → { ok:false, error:'Storage unavailable' }.
 *  - load(): getItem → decodeSave → SavePayload; any error → console.warn + null.
 *  - list(): scan storage keys with the prefix, readEnvelope() for meta (no full decode), newest first.
 *  - exportString(): self-contained text, e.g. 'VCB1:' + base64(utf8(envelope JSON)) or the raw
 *    envelope JSON — importString() must accept what exportString() produces (and raw envelope JSON).
 *  - startAutosave(provider, ms): setInterval; also autosave on 'visibilitychange' → hidden and
 *    'pagehide'. Skips when provider() returns null. stopAutosave()/dispose() clear everything.
 *  - Writes are synchronous and must take < 30 ms for a full 64×64 city.
 */
import type { ISaveManager, SavePayload, SaveManagerDeps, SaveResult, SaveSlotInfo } from '../types';

export class SaveManager implements ISaveManager {
  private readonly deps: SaveManagerDeps;

  constructor(deps: SaveManagerDeps) {
    this.deps = deps;
  }

  save(slot: string, payload: SavePayload): SaveResult {
    // TODO(persistence)
    return { ok: false, bytes: 0, error: 'Saving not implemented' };
  }

  load(slot: string): SavePayload | null {
    // TODO(persistence)
    return null;
  }

  has(slot: string): boolean {
    // TODO(persistence)
    return false;
  }

  list(): SaveSlotInfo[] {
    // TODO(persistence)
    return [];
  }

  remove(slot: string): void {
    // TODO(persistence)
  }

  exportString(payload: SavePayload): string {
    // TODO(persistence)
    return '';
  }

  importString(text: string): SavePayload | null {
    // TODO(persistence)
    return null;
  }

  startAutosave(provider: () => SavePayload | null, intervalMs: number): void {
    // TODO(persistence)
  }

  stopAutosave(): void {
    // TODO(persistence)
  }

  dispose(): void {
    this.stopAutosave();
  }
}
