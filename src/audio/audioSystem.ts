/**
 * MODULE: audio — the game's single sound engine (one AudioContext for everything).
 * Owner: audio agent. Public API is re-exported from ./index.ts.
 *
 * Graph:  sfx bus ─┐
 *     ambient bus ─┼─▶ master gain ─▶ compressor ─▶ destination
 *       music bus ─┘
 *
 * Rules:
 *  - Every method is safe to call before unlock and in browsers without Web Audio (no throws).
 *    Before the first user gesture nothing is created; values are stored and applied on unlock.
 *  - The AudioContext is created on the first pointerdown / keydown (autoplay policy).
 *  - attach(bus) subscribes to gameplay events (action sounds, ambience, music). UI code calls
 *    playSfx() only for UI clicks, never for bus events (avoids double sounds).
 *  - Master volume + mute are persisted by the UI settings (SETTINGS_KEY). The music / ambient /
 *    sfx sub-volumes and musicEnabled are persisted here under AUDIO_PREFS_KEY.
 *  - The context is suspended while the tab is hidden.
 */
import type { GameBus } from '../core/events';
import { isEditableTarget } from '../core/util';
import type { ToolAction } from '../types';
import { Ambience } from './ambience';
import { Music } from './music';
import { SfxPlayer, type SfxName } from './sfx';

export const AUDIO_PREFS_KEY = 'vcb:audio';

/** Population at which the music reaches full intensity (log scale below it). */
const MUSIC_FULL_POP = 25_000;
const TIMER_MS = 25;

export interface AudioState {
  muted: boolean;
  masterVolume: number;
  musicVolume: number;
  ambientVolume: number;
  sfxVolume: number;
  musicEnabled: boolean;
  /** True once the AudioContext exists and is running. */
  unlocked: boolean;
}

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

const clampVol = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private ambience: Ambience | null = null;
  private music: Music | null = null;
  private readonly sfx = new SfxPlayer();

  private state: Omit<AudioState, 'unlocked'> = {
    muted: false,
    masterVolume: 0.5,
    musicVolume: 0.5,
    ambientVolume: 0.6,
    sfxVolume: 0.8,
    musicEnabled: true,
  };

  private readonly listeners = new Set<(s: AudioState) => void>();
  private readonly unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private failed = false;
  private disposed = false;
  private modalOpen = false;
  private paused = false;
  private cityLoaded = false;
  private citySeed = 1;
  private lastStats = { population: 0, roadTiles: 0, parkTiles: 0, happiness: 0.6 };
  private readonly muteKey: string | null;

  constructor(opts: { muteKey?: string | null } = {}) {
    this.muteKey = opts.muteKey === undefined ? 'KeyM' : opts.muteKey;
    this.loadPrefs();
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.onGesture, { capture: true, passive: true });
      window.addEventListener('keydown', this.onGesture, { capture: true });
      window.addEventListener('keydown', this.onKeyDown);
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  // ------------------------------------------------------------------ public API

  get muted(): boolean {
    return this.state.muted;
  }
  get masterVolume(): number {
    return this.state.masterVolume;
  }
  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  getState(): AudioState {
    return { ...this.state, unlocked: this.unlocked };
  }

  /** Create / resume the AudioContext. Call from a user gesture (also done automatically). */
  unlock(): void {
    if (this.disposed || this.failed) return;
    if (!this.ctx) this.createGraph();
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running' && !document.hidden) {
      ctx.resume().then(() => this.emitChange(), () => undefined);
    }
  }

  playSfx(name: SfxName, size = 0): void {
    if (!this.ctx || !this.sfxBus || this.state.muted || this.ctx.state !== 'running') return;
    try {
      this.sfx.play(this.ctx, this.sfxBus, name, size);
    } catch (err) {
      console.warn('[audio] sfx failed:', err);
    }
  }

  setMuted(muted: boolean): void {
    if (this.state.muted === muted) return;
    this.state.muted = muted;
    this.applyGains();
    this.emitChange();
  }

  toggleMute(): void {
    this.setMuted(!this.state.muted);
  }

  setMasterVolume(v: number): void {
    this.setVol('masterVolume', v, false);
  }
  setMusicVolume(v: number): void {
    this.setVol('musicVolume', v, true);
  }
  setAmbientVolume(v: number): void {
    this.setVol('ambientVolume', v, true);
  }
  setSfxVolume(v: number): void {
    this.setVol('sfxVolume', v, true);
  }

  setMusicEnabled(on: boolean): void {
    if (this.state.musicEnabled === on) return;
    this.state.musicEnabled = on;
    this.music?.setEnabled(on);
    this.savePrefs();
    this.emitChange();
  }

  /** Subscribe to mute / volume changes (e.g. the M hotkey). Returns an unsubscribe function. */
  onChange(fn: (s: AudioState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe to gameplay events. Call once with the game bus; returns a detach function. */
  attach(bus: GameBus): () => void {
    const offs = [
      bus.on('action:applied', ({ action, result }) => {
        if (!result.ok) {
          this.playSfx('error');
          return;
        }
        this.playSfx(actionSfx(action), Math.min(1, result.applied / 40));
      }),
      bus.on('sim:month', ({ report }) => {
        if (report.net > 0) this.playSfx('coin');
      }),
      bus.on('notify', ({ kind }) => {
        if (kind === 'success') this.playSfx('milestone');
      }),
      bus.on('save:written', ({ auto }) => {
        if (!auto) this.playSfx('save');
      }),
      bus.on('tool:changed', () => this.playSfx('toggle')),
      bus.on('sim:speed', ({ speed }) => {
        this.paused = speed === 0;
        this.ambience?.setPaused(this.paused);
      }),
      bus.on('ui:modal', ({ open }) => {
        this.modalOpen = open;
        this.applyGains();
      }),
      bus.on('city:loaded', ({ seed }) => {
        this.cityLoaded = true;
        this.citySeed = seed;
        this.music?.reseed(seed);
        this.music?.start();
        this.ambience?.fadeTo(1, 2);
      }),
      bus.on('stats:changed', ({ stats }) => {
        this.lastStats = {
          population: stats.population,
          roadTiles: stats.roadTiles,
          parkTiles: stats.parkTiles,
          happiness: stats.happiness,
        };
        this.applyStats();
      }),
    ];
    const detach = (): void => {
      for (const off of offs) off();
    };
    this.unsubs.push(detach);
    return detach;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.listeners.clear();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.onGesture, { capture: true });
      window.removeEventListener('keydown', this.onGesture, { capture: true });
      window.removeEventListener('keydown', this.onKeyDown);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.ambience?.dispose();
    this.music?.dispose();
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  // ------------------------------------------------------------------ internals

  private createGraph(): void {
    const Ctor = audioCtor();
    if (!Ctor) {
      this.failed = true;
      return;
    }
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 3;
      comp.attack.value = 0.005;
      comp.release.value = 0.2;
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.connect(comp);
      this.sfxBus = ctx.createGain();
      this.ambientBus = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.ambientBus.connect(this.master);
      this.musicBus.connect(this.master);
      this.ctx = ctx;

      this.ambience = new Ambience(ctx, this.ambientBus);
      this.music = new Music(ctx, this.musicBus);
      this.music.setEnabled(this.state.musicEnabled);
      this.music.reseed(this.citySeed);
      this.applyStats();
      this.applyGains(true);
      // The game usually loaded its city before the first gesture: start right away.
      if (this.cityLoaded) {
        this.music.start();
        this.ambience.fadeTo(1, 2);
        this.ambience.setPaused(this.paused);
      }
      ctx.onstatechange = () => this.emitChange();
      this.timer = setInterval(this.onTimer, TIMER_MS);
    } catch (err) {
      console.warn('[audio] Web Audio unavailable:', err);
      this.failed = true;
      this.ctx = null;
    }
  }

  private readonly onTimer = (): void => {
    if (!this.ctx || this.ctx.state !== 'running') return;
    try {
      this.ambience?.tick();
      if (!this.state.muted) this.music?.tick();
    } catch (err) {
      console.warn('[audio] scheduler error:', err);
    }
  };

  private applyStats(): void {
    const s = this.lastStats;
    this.ambience?.setCity(s.population, s.roadTiles, s.parkTiles);
    if (this.music) {
      const pop = Math.max(0, s.population);
      // Small floor so an empty map still has a gentle pad.
      const intensity = 0.08 + 0.92 * Math.min(1, Math.log10(1 + pop) / Math.log10(1 + MUSIC_FULL_POP));
      this.music.setIntensity(intensity);
      this.music.setMood(s.population > 50 ? s.happiness : 0.6);
    }
  }

  private applyGains(immediate = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.sfxBus || !this.ambientBus || !this.musicBus) return;
    const t = ctx.currentTime;
    const set = (p: AudioParam, v: number): void => {
      p.cancelScheduledValues(t);
      if (immediate) p.setValueAtTime(v, t);
      else p.setTargetAtTime(v, t, 0.05);
    };
    const st = this.state;
    // Perceptual-ish curve: slider 0.5 ≈ -12 dB.
    const curve = (v: number): number => v * v;
    set(this.master.gain, st.muted ? 0 : curve(st.masterVolume) * 1.6);
    set(this.sfxBus.gain, curve(st.sfxVolume));
    set(this.ambientBus.gain, curve(st.ambientVolume) * (this.modalOpen ? 0.6 : 1));
    set(this.musicBus.gain, curve(st.musicVolume) * 0.9 * (this.modalOpen ? 0.6 : 1));
  }

  private setVol(key: 'masterVolume' | 'musicVolume' | 'ambientVolume' | 'sfxVolume', v: number, persist: boolean): void {
    const nv = clampVol(v);
    if (this.state[key] === nv) return;
    this.state[key] = nv;
    this.applyGains();
    if (persist) this.savePrefs();
    this.emitChange();
  }

  private emitChange(): void {
    const s = this.getState();
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(s);
      } catch (err) {
        console.error('[audio] onChange handler threw:', err);
      }
    }
  }

  private readonly onGesture = (): void => {
    if (!this.unlocked) this.unlock();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.muteKey || e.code !== this.muteKey || e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey || this.modalOpen || isEditableTarget(e.target)) return;
    this.toggleMute();
  };

  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (document.hidden) {
      if (ctx.state === 'running') ctx.suspend().catch(() => undefined);
    } else if (ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }
  };

  private loadPrefs(): void {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(AUDIO_PREFS_KEY) : null;
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<AudioState>;
      if (typeof p.musicVolume === 'number') this.state.musicVolume = clampVol(p.musicVolume);
      if (typeof p.ambientVolume === 'number') this.state.ambientVolume = clampVol(p.ambientVolume);
      if (typeof p.sfxVolume === 'number') this.state.sfxVolume = clampVol(p.sfxVolume);
      if (typeof p.musicEnabled === 'boolean') this.state.musicEnabled = p.musicEnabled;
    } catch {
      // corrupt or unavailable: keep defaults
    }
  }

  private savePrefs(): void {
    try {
      const { musicVolume, ambientVolume, sfxVolume, musicEnabled } = this.state;
      localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify({ musicVolume, ambientVolume, sfxVolume, musicEnabled }));
    } catch {
      // private mode etc.
    }
  }
}

function actionSfx(action: ToolAction): SfxName {
  switch (action.type) {
    case 'road':
      return 'build';
    case 'zone':
      return 'zone';
    case 'park':
      return 'park';
    case 'civic':
      return 'civic';
    case 'bulldoze':
      return 'bulldoze';
  }
}
