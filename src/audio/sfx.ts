/**
 * MODULE: audio — procedural one-shot sound effects.
 * Owner: audio agent. Every sound is built from oscillators / noise at play time (no assets).
 */
import { noiseBurst, tone } from './synth';

export type SfxName =
  | 'click'
  | 'hover'
  | 'toggle'
  | 'build'
  | 'zone'
  | 'park'
  | 'bulldoze'
  | 'error'
  | 'coin'
  | 'milestone'
  | 'save';

export const SFX_NAMES: readonly SfxName[] = [
  'click', 'hover', 'toggle', 'build', 'zone', 'park', 'bulldoze', 'error', 'coin', 'milestone', 'save',
];

/** Minimum seconds between two plays of the same sound (drag-spam / event bursts guard). */
const MIN_GAP: Record<SfxName, number> = {
  click: 0.03,
  hover: 0.05,
  toggle: 0.05,
  build: 0.06,
  zone: 0.06,
  park: 0.06,
  bulldoze: 0.08,
  error: 0.25,
  coin: 0.3,
  milestone: 1.0,
  save: 0.5,
};

type Recipe = (ctx: BaseAudioContext, out: AudioNode, t: number, size: number) => void;

/** `size` is 0..1 (how big the action was, e.g. tiles applied) and lets sounds scale a little. */
const RECIPES: Record<SfxName, Recipe> = {
  click(ctx, out, t) {
    tone(ctx, out, t, { type: 'triangle', freq: 1800, toFreq: 900, glide: 0.04, peak: 0.25, decay: 0.05 });
  },
  hover(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', freq: 2400, peak: 0.05, decay: 0.03 });
  },
  toggle(ctx, out, t) {
    tone(ctx, out, t, { type: 'square', freq: 660, peak: 0.06, decay: 0.05 });
    tone(ctx, out, t + 0.05, { type: 'square', freq: 990, peak: 0.05, decay: 0.06 });
  },
  build(ctx, out, t, size) {
    // Asphalt laying: a low thump plus a gritty noise scrape.
    tone(ctx, out, t, { type: 'sine', freq: 140, toFreq: 60, glide: 0.12, peak: 0.5, decay: 0.16 });
    noiseBurst(ctx, out, t + 0.01, {
      color: 'pink', filter: 'bandpass', freq: 1200, toFreq: 500, q: 0.8, peak: 0.18 + 0.12 * size, decay: 0.12 + 0.12 * size,
    });
  },
  zone(ctx, out, t, size) {
    // Bright "paint" chime: two notes a fifth apart.
    tone(ctx, out, t, { type: 'triangle', freq: 784, peak: 0.16, decay: 0.18 });
    tone(ctx, out, t + 0.06, { type: 'triangle', freq: 1175, peak: 0.12 + 0.05 * size, decay: 0.26 });
    noiseBurst(ctx, out, t, { filter: 'highpass', freq: 5000, peak: 0.04, decay: 0.08 });
  },
  park(ctx, out, t) {
    // Soft rustle + a birdy blip.
    noiseBurst(ctx, out, t, { color: 'pink', filter: 'bandpass', freq: 3000, q: 0.6, peak: 0.12, attack: 0.03, decay: 0.25 });
    tone(ctx, out, t + 0.08, { type: 'sine', freq: 2600, toFreq: 3400, glide: 0.06, peak: 0.07, decay: 0.08 });
  },
  bulldoze(ctx, out, t, size) {
    // Crunch: low rumble + debris crackle.
    tone(ctx, out, t, { type: 'sawtooth', freq: 70, toFreq: 40, glide: 0.3, peak: 0.22, decay: 0.32 });
    noiseBurst(ctx, out, t, {
      color: 'brown', filter: 'lowpass', freq: 900, toFreq: 200, peak: 0.55, decay: 0.3 + 0.25 * size,
    });
    for (let i = 0; i < 4; i++) {
      noiseBurst(ctx, out, t + 0.04 + i * 0.05, {
        filter: 'bandpass', freq: 1800 + i * 600, q: 3, peak: 0.08, decay: 0.04,
      });
    }
  },
  error(ctx, out, t) {
    tone(ctx, out, t, { type: 'square', freq: 220, peak: 0.08, decay: 0.12 });
    tone(ctx, out, t + 0.12, { type: 'square', freq: 165, peak: 0.08, decay: 0.18 });
  },
  coin(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', freq: 1319, peak: 0.12, decay: 0.12 });
    tone(ctx, out, t + 0.08, { type: 'sine', freq: 1976, peak: 0.12, decay: 0.35 });
  },
  milestone(ctx, out, t) {
    // Rising major arpeggio with a shimmer tail.
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      tone(ctx, out, t + i * 0.09, { type: 'triangle', freq: f, peak: 0.13, decay: 0.5 });
      tone(ctx, out, t + i * 0.09, { type: 'sine', freq: f * 2, peak: 0.03, decay: 0.6, detune: 6 });
    });
  },
  save(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', freq: 880, peak: 0.08, decay: 0.1 });
    tone(ctx, out, t + 0.07, { type: 'sine', freq: 1320, peak: 0.07, decay: 0.2 });
  },
};

export class SfxPlayer {
  private readonly lastPlayed = new Map<SfxName, number>();

  play(ctx: BaseAudioContext, out: AudioNode, name: SfxName, size = 0): void {
    const recipe = RECIPES[name];
    if (!recipe) return;
    const now = ctx.currentTime;
    const last = this.lastPlayed.get(name);
    if (last !== undefined && now - last < MIN_GAP[name]) return;
    this.lastPlayed.set(name, now);
    recipe(ctx, out, now + 0.005, Math.max(0, Math.min(1, size)));
  }
}
