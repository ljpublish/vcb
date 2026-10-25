/**
 * MODULE: persistence — localStorage save slots + autosave.
 * Owner: persistence agent. Implements ISaveManager (src/types.ts).
 *
 *  - key(slot) = SAVE_KEY_PREFIX + slot. Slot names: [a-z0-9_-]{1,32}; others are rejected.
 *  - save(): encodeSave → storage.setItem in try/catch (QuotaExceededError → { ok:false, error });
 *    emits 'save:written' { slot, bytes, auto } (auto only for timer / page-hide autosaves).
 *    Never throws. storage === null → { ok:false, error:'Storage unavailable' }.
 *  - load(): getItem → decodeSave → SavePayload; any error → console.warn + null.
 *  - list(): scan storage keys with the prefix, readEnvelope() for meta (no full decode), newest first.
 *  - exportString(): 'VCB1:' + base64(utf8(envelope JSON)). importString() accepts that and raw
 *    envelope JSON.
 *  - startAutosave(provider, ms): setInterval; also autosave on 'visibilitychange' → hidden and
 *    'pagehide'. Skips when provider() returns null. stopAutosave()/dispose() clear everything.
 */
import { errorMessage } from '../core/util';
import {
  AUTOSAVE_SLOT,
  SAVE_KEY_PREFIX,
  type ISaveManager,
  type SavePayload,
  type SaveManagerDeps,
  type SaveResult,
  type SaveSlotInfo,
} from '../types';
import { base64ToBytes, bytesToBase64, decodeSave, encodeSave, readEnvelope } from './saveCodec';

const SLOT_RE = /^[a-z0-9_-]{1,32}$/;
const EXPORT_PREFIX = 'VCB1:';
/** Minimum gap between two "autosave failed" notifications. */
const AUTOSAVE_WARN_GAP_MS = 10 * 60_000;

function isQuotaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  );
}

export class SaveManager implements ISaveManager {
  private readonly deps: SaveManagerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private provider: (() => SavePayload | null) | null = null;
  private autosaving = false;
  private lastWarnAt = -Infinity;
  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.runAutosave();
  };
  private readonly onPageHide = (): void => {
    this.runAutosave();
  };

  constructor(deps: SaveManagerDeps) {
    this.deps = deps;
  }

  save(slot: string, payload: SavePayload): SaveResult {
    return this.write(slot, payload, false);
  }

  load(slot: string): SavePayload | null {
    const storage = this.deps.storage;
    if (!storage || !SLOT_RE.test(slot)) return null;
    try {
      const text = storage.getItem(SAVE_KEY_PREFIX + slot);
      if (text === null) return null;
      return decodeSave(text).payload;
    } catch (err) {
      console.warn(`[persist] could not load slot "${slot}": ${errorMessage(err)}`);
      return null;
    }
  }

  has(slot: string): boolean {
    const storage = this.deps.storage;
    if (!storage || !SLOT_RE.test(slot)) return false;
    try {
      return storage.getItem(SAVE_KEY_PREFIX + slot) !== null;
    } catch {
      return false;
    }
  }

  list(): SaveSlotInfo[] {
    const storage = this.deps.storage;
    if (!storage) return [];
    const out: SaveSlotInfo[] = [];
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k !== null && k.startsWith(SAVE_KEY_PREFIX)) keys.push(k);
      }
      for (const k of keys) {
        const text = storage.getItem(k);
        if (text === null) continue;
        const slot = k.slice(SAVE_KEY_PREFIX.length);
        const env = readEnvelope(text);
        if (env) {
          out.push({
            slot,
            name: env.meta.name,
            savedAt: env.savedAt,
            day: env.meta.day,
            money: env.meta.money,
            population: env.meta.population,
            bytes: text.length,
            version: env.version,
          });
        } else {
          out.push({ slot, name: '(corrupt)', savedAt: 0, day: 0, money: 0, population: 0, bytes: text.length, version: 0 });
        }
      }
    } catch (err) {
      console.warn(`[persist] could not list saves: ${errorMessage(err)}`);
    }
    out.sort((a, b) => b.savedAt - a.savedAt || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
    return out;
  }

  remove(slot: string): void {
    const storage = this.deps.storage;
    if (!storage || !SLOT_RE.test(slot)) return;
    try {
      storage.removeItem(SAVE_KEY_PREFIX + slot);
    } catch (err) {
      console.warn(`[persist] could not remove slot "${slot}": ${errorMessage(err)}`);
    }
  }

  exportString(payload: SavePayload): string {
    try {
      const json = encodeSave(payload);
      return EXPORT_PREFIX + bytesToBase64(new TextEncoder().encode(json));
    } catch (err) {
      console.warn(`[persist] export failed: ${errorMessage(err)}`);
      return '';
    }
  }

  importString(text: string): SavePayload | null {
    try {
      if (typeof text !== 'string') return null;
      const t = text.trim();
      let json: string;
      if (t.startsWith(EXPORT_PREFIX)) {
        const b64 = t.slice(EXPORT_PREFIX.length).replace(/\s+/g, '');
        json = new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(b64));
      } else if (t.startsWith('{')) {
        json = t;
      } else {
        return null;
      }
      return decodeSave(json).payload;
    } catch (err) {
      console.warn(`[persist] import failed: ${errorMessage(err)}`);
      return null;
    }
  }

  startAutosave(provider: () => SavePayload | null, intervalMs: number): void {
    this.stopAutosave();
    this.provider = provider;
    this.timer = setInterval(() => this.runAutosave(), Math.max(1, intervalMs));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
  }

  stopAutosave(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.provider = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
  }

  dispose(): void {
    this.stopAutosave();
  }

  private runAutosave(): void {
    const provider = this.provider;
    if (!provider || this.autosaving) return;
    this.autosaving = true;
    try {
      let payload: SavePayload | null;
      try {
        payload = provider();
      } catch (err) {
        console.warn(`[persist] autosave provider failed: ${errorMessage(err)}`);
        return;
      }
      if (!payload) return;
      const res = this.write(AUTOSAVE_SLOT, payload, true);
      if (!res.ok) {
        const now = Date.now();
        if (now - this.lastWarnAt >= AUTOSAVE_WARN_GAP_MS) {
          this.lastWarnAt = now;
          this.deps.bus.emit('notify', { message: `Autosave failed: ${res.error ?? 'unknown error'}`, kind: 'warning' });
        }
      }
    } finally {
      this.autosaving = false;
    }
  }

  private write(slot: string, payload: SavePayload, auto: boolean): SaveResult {
    if (!SLOT_RE.test(slot)) return { ok: false, bytes: 0, error: 'Invalid slot name' };
    const storage = this.deps.storage;
    if (!storage) return { ok: false, bytes: 0, error: 'Storage unavailable' };
    let text: string;
    try {
      text = encodeSave(payload);
    } catch (err) {
      console.warn(`[persist] encode failed: ${errorMessage(err)}`);
      return { ok: false, bytes: 0, error: `Could not encode save: ${errorMessage(err)}` };
    }
    try {
      storage.setItem(SAVE_KEY_PREFIX + slot, text);
    } catch (err) {
      if (isQuotaError(err)) return { ok: false, bytes: 0, error: 'Storage is full — delete old saves' };
      return { ok: false, bytes: 0, error: `Could not write save: ${errorMessage(err)}` };
    }
    try {
      this.deps.bus.emit('save:written', { slot, bytes: text.length, auto });
    } catch (err) {
      console.warn(`[persist] save:written handler failed: ${errorMessage(err)}`);
    }
    return { ok: true, bytes: text.length };
  }
}
