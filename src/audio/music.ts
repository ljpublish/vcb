/**
 * MODULE: audio — generative background music.
 * Owner: audio agent.
 *
 * A lookahead step sequencer (eighth notes) plays diatonic chord progressions with up to five
 * layers. Each layer joins as `intensity` (from population) rises:
 *   pad (always) → bass (0.15) → arpeggio motif (0.3) → hats (0.55) → soft kick (0.7).
 * The key, tempo, progressions and motifs come from a seeded Rng (seeded per city), so every city
 * has its own tune. Low happiness switches the scale to natural minor. Every few phrases the
 * music modulates or takes a quiet "breath" phrase, so it doesn't loop audibly.
 */
import { Rng } from '../core/rng';
import { envAD, envAHR, midiToFreq, noiseBurst, tone } from './synth';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
/** Progressions as 0-based scale degrees (work in both major and minor). */
const PROGRESSIONS: readonly (readonly number[])[] = [
  [0, 5, 3, 4],
  [0, 4, 5, 3],
  [5, 3, 0, 4],
  [0, 3, 5, 4],
  [1, 4, 0, 5],
  [0, 3, 1, 4],
];
/** Key roots (midi, octave 3). */
const KEY_ROOTS = [48, 50, 53, 55, 57, 46];
const STEPS_PER_BAR = 8;
const BARS_PER_PHRASE = 8;
const LOOKAHEAD = 0.15;

export class Music {
  private readonly ctx: BaseAudioContext;
  private readonly out: GainNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private rng = new Rng(1);

  private enabled = true;
  private intensity = 0;
  private minor = false;
  private bpm = 76;
  private root = 48;
  private progression: readonly number[] = PROGRESSIONS[0];
  private motif: number[] = [];
  private breath = false;

  private step = 0;
  private nextTime = 0;
  private running = false;

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);

    // Dry + a simple filtered feedback delay for space (cheaper than a convolver, no IR asset).
    this.dry = ctx.createGain();
    this.dry.connect(this.out);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.28;
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    this.wet.connect(delay);
    delay.connect(lp).connect(fb).connect(delay);
    lp.connect(this.out);
    this.reseed(1);
  }

  /** New tune for a new city. */
  reseed(seed: number): void {
    this.rng = new Rng((seed ^ 0x6d75_7369) >>> 0);
    this.bpm = this.rng.int(70, 84);
    this.root = KEY_ROOTS[this.rng.int(0, KEY_ROOTS.length)];
    this.progression = PROGRESSIONS[this.rng.int(0, PROGRESSIONS.length)];
    this.motif = this.makeMotif();
    this.step = 0;
    this.breath = false;
  }

  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  /** happiness 0..1; below ~0.35 the music turns minor (with hysteresis). */
  setMood(happiness: number): void {
    if (!this.minor && happiness < 0.3) this.minor = true;
    else if (this.minor && happiness > 0.42) this.minor = false;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.fadeTo(on && this.running ? 1 : 0, on ? 3 : 0.8);
  }

  /** Start (or restart) playback with a fade-in. */
  start(): void {
    this.running = true;
    this.nextTime = this.ctx.currentTime + 0.1;
    if (this.enabled) this.fadeTo(1, 4);
  }

  stop(): void {
    this.running = false;
    this.fadeTo(0, 0.8);
  }

  private fadeTo(level: number, seconds: number): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(level, t, seconds / 3);
  }

  /** Called every ~25 ms by the AudioSystem timer. */
  tick(): void {
    const now = this.ctx.currentTime;
    if (!this.running || !this.enabled) {
      this.nextTime = now + 0.1;
      return;
    }
    // Tab was hidden / context suspended: don't try to catch up, just resume.
    if (this.nextTime < now - 0.2) this.nextTime = now + 0.05;
    const stepDur = 60 / this.bpm / 2;
    while (this.nextTime < now + LOOKAHEAD) {
      this.playStep(this.step, this.nextTime, stepDur);
      this.step++;
      this.nextTime += stepDur;
    }
  }

  // ------------------------------------------------------------------ composition

  private scaleNote(degree: number): number {
    const scale = this.minor ? MINOR : MAJOR;
    const oct = Math.floor(degree / 7);
    const idx = ((degree % 7) + 7) % 7;
    return this.root + scale[idx] + 12 * oct;
  }

  /** Chord tones (midi) for a scale degree: triad, plus the 7th as an optional 4th tone. */
  private chord(degree: number): number[] {
    return [0, 2, 4, 6].map((o) => this.scaleNote(degree + o));
  }

  /** 8-step motif of chord-tone indices (-1 = rest). Repeats for a phrase, then evolves. */
  private makeMotif(): number[] {
    const m: number[] = [];
    let last = -1;
    for (let i = 0; i < STEPS_PER_BAR; i++) {
      const restChance = i % 2 === 0 ? 0.25 : 0.5;
      if (this.rng.next() < restChance) {
        m.push(-1);
        continue;
      }
      let n = this.rng.int(0, 6); // 0..5 → chord tones over two octaves
      if (n === last) n = (n + 1) % 6;
      m.push(n);
      last = n;
    }
    if (m.every((x) => x < 0)) m[0] = 0;
    return m;
  }

  private onPhraseStart(phrase: number): void {
    if (phrase === 0) return;
    // Mutate the motif a little every phrase, replace it sometimes.
    if (this.rng.next() < 0.35) this.motif = this.makeMotif();
    else {
      const i = this.rng.int(0, this.motif.length);
      this.motif[i] = this.rng.next() < 0.3 ? -1 : this.rng.int(0, 6);
    }
    this.breath = this.rng.next() < 0.22;
    if (phrase % 3 === 0 && this.rng.next() < 0.5) {
      this.progression = PROGRESSIONS[this.rng.int(0, PROGRESSIONS.length)];
    }
    if (phrase % 4 === 0 && this.rng.next() < 0.5) {
      // Modulate up a fourth / down a fifth, staying in a comfortable register.
      this.root += 5;
      if (this.root > 57) this.root -= 12;
    }
  }

  private playStep(step: number, t: number, stepDur: number): void {
    const s = step % STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR);
    if (s === 0 && bar % BARS_PER_PHRASE === 0) this.onPhraseStart(bar / BARS_PER_PHRASE);

    const degree = this.progression[bar % this.progression.length];
    const chord = this.chord(degree);
    const lvl = this.breath ? Math.min(this.intensity, 0.2) : this.intensity;
    const barDur = stepDur * STEPS_PER_BAR;
    const d = this.dry;
    const w = this.wet;

    // Pad: one sustained chord per bar.
    if (s === 0) {
      const notes = lvl > 0.45 ? chord : chord.slice(0, 3);
      for (const n of notes) this.padNote(midiToFreq(n + 12), t, barDur, 0.028);
    }

    // Bass.
    if (lvl >= 0.15) {
      if (s === 0) this.bassNote(midiToFreq(chord[0] - 12), t, 0.16, stepDur * 3.5);
      if (s === 4 && lvl >= 0.35) this.bassNote(midiToFreq(chord[2] - 12), t, 0.11, stepDur * 2.5);
      if (s === 7 && lvl >= 0.6 && this.rng.next() < 0.4) this.bassNote(midiToFreq(chord[1] - 12), t, 0.07, stepDur * 0.9);
    }

    // Arpeggio motif (plucked), with a bit of the delay.
    if (lvl >= 0.3) {
      const idx = this.motif[s];
      const density = 0.55 + 0.45 * lvl;
      if (idx >= 0 && this.rng.next() < density) {
        const n = chord[idx % 3] + 24 + (idx >= 3 ? 12 : 0);
        const f = midiToFreq(n);
        const v = 0.035 + 0.025 * lvl;
        tone(this.ctx, d, t, { type: 'triangle', freq: f, peak: v, attack: 0.004, decay: 0.45 });
        tone(this.ctx, w, t, { type: 'sine', freq: f, peak: v * 0.8, attack: 0.004, decay: 0.35 });
      }
    }

    // Hats on the off-beats.
    if (lvl >= 0.55 && s % 2 === 1) {
      noiseBurst(this.ctx, d, t, { filter: 'highpass', freq: 7500, peak: 0.018 + (s === 3 || s === 7 ? 0.008 : 0), decay: 0.035 });
    }
    // Soft kick on 1 and 3.
    if (lvl >= 0.7 && (s === 0 || s === 4)) {
      tone(this.ctx, d, t, { type: 'sine', freq: 120, toFreq: 42, glide: 0.12, peak: 0.16, attack: 0.002, decay: 0.2 });
    }
  }

  private padNote(freq: number, t: number, dur: number, peak: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700 + 1100 * this.intensity;
    lp.Q.value = 0.5;
    const end = envAHR(g.gain, t, peak, Math.min(1.2, dur * 0.4), dur * 0.5, dur * 0.7);
    const oscs: OscillatorNode[] = [];
    for (const [type, det] of [['triangle', -7], ['sawtooth', 6]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(end + 0.05);
      oscs.push(o);
    }
    lp.connect(g);
    g.connect(this.dry);
    g.connect(this.wet);
    oscs[0].onended = () => {
      for (const o of oscs) o.disconnect();
      lp.disconnect();
      g.disconnect();
    };
  }

  private bassNote(freq: number, t: number, peak: number, dur: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const g = ctx.createGain();
    const end = envAD(g.gain, t, peak, 0.012, dur);
    o.connect(lp).connect(g).connect(this.dry);
    o.start(t);
    o.stop(end + 0.05);
    o.onended = () => {
      o.disconnect();
      lp.disconnect();
      g.disconnect();
    };
  }

  dispose(): void {
    this.running = false;
    this.out.disconnect();
  }
}
