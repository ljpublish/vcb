/**
 * MODULE: ui — UI sound effects (module-internal API; may change).
 * Owner: ui agent.
 *
 * Thin forwarder into the shared sound engine in src/audio (one AudioContext for the whole game).
 * The audio module maps gameplay events ('action:applied', 'sim:month', 'notify') to sounds itself;
 * the UI only plays UI feedback (clicks, toggles) and owns master volume + mute (persisted in the UI
 * settings). Every call is guarded so a missing / failing audio engine never breaks the UI.
 */
import { getAudio } from '../audio';

export type SfxName = 'click' | 'build' | 'zone' | 'bulldoze' | 'error' | 'coin' | 'milestone' | 'toggle';

export class Sfx {
  private _volume = 0.5;
  private _muted = false;
  private offChange: (() => void) | null = null;

  /** Called when the engine reports a mute / volume change made elsewhere (e.g. its M hotkey). */
  constructor(onExternalChange?: (volume: number, muted: boolean) => void) {
    if (onExternalChange) {
      try {
        this.offChange = getAudio().onChange(() => {
          const a = getAudio();
          if (a.muted === this._muted && a.masterVolume === this._volume) return;
          this._muted = a.muted;
          this._volume = a.masterVolume;
          onExternalChange(this._volume, this._muted);
        });
      } catch (err) {
        console.warn('[ui] audio engine unavailable', err);
      }
    }
  }

  get volume(): number {
    return this._volume;
  }

  set volume(v: number) {
    this._volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
    try {
      getAudio().setMasterVolume(this._volume);
    } catch {
      // ignore
    }
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(m: boolean) {
    this._muted = m;
    try {
      getAudio().setMuted(m);
    } catch {
      // ignore
    }
  }

  /** Call from a user gesture to unlock the AudioContext (the engine also auto-unlocks). */
  unlock(): void {
    try {
      getAudio().unlock();
    } catch {
      // ignore
    }
  }

  play(name: SfxName): void {
    try {
      getAudio().playSfx(name);
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this.offChange?.();
    this.offChange = null;
  }
}
