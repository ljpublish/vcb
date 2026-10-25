/**
 * MODULE: audio — ambient city soundscape.
 * Owner: audio agent.
 *
 * Layers (all procedural):
 *  - city hum: low-passed brown noise whose level and brightness grow with population,
 *  - traffic: occasional panned "car pass" whooshes, rate scales with population × road tiles,
 *  - nature: wind + bird chirps, loudest in an empty map and fading as the city grows,
 *    with a small boost from parks.
 * Driven by setCity() (from 'stats:changed') and tick() (from the AudioSystem scheduler timer).
 */
import { Rng } from '../core/rng';
import { noiseBuffer, tone } from './synth';

/** Population at which the city layers reach full level (log scale below it). */
const FULL_CITY_POP = 40_000;
/** Time constant (s) for level changes, so stats jumps don't sound abrupt. */
const SMOOTH = 2.5;

export class Ambience {
  private readonly ctx: BaseAudioContext;
  private readonly out: GainNode;
  private readonly humGain: GainNode;
  private readonly humFilter: BiquadFilterNode;
  private readonly droneGain: GainNode;
  private readonly windGain: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly rng = new Rng(0x5eed_a0d1);

  private city = 0;
  private nature = 1;
  private traffic = 0;
  private paused = false;
  private nextTrafficAt = 0;
  private nextBirdAt = 0;

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);

    // City hum.
    const hum = ctx.createBufferSource();
    hum.buffer = noiseBuffer(ctx, 'brown');
    hum.loop = true;
    this.humFilter = ctx.createBiquadFilter();
    this.humFilter.type = 'lowpass';
    this.humFilter.frequency.value = 180;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    hum.connect(this.humFilter).connect(this.humGain).connect(this.out);

    // Distant electrical / HVAC drone under the hum (very quiet).
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    const droneLp = ctx.createBiquadFilter();
    droneLp.type = 'lowpass';
    droneLp.frequency.value = 160;
    droneLp.connect(this.droneGain).connect(this.out);
    for (const [f, det] of [[55, -4], [82.5, 3], [110, 7]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(droneLp);
      this.sources.push(o);
    }

    // Wind: band-passed pink noise with a slow LFO sweeping the band.
    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuffer(ctx, 'pink');
    wind.loop = true;
    const windBp = ctx.createBiquadFilter();
    windBp.type = 'bandpass';
    windBp.frequency.value = 500;
    windBp.Q.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 260;
    lfo.connect(lfoAmt).connect(windBp.frequency);
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(windBp).connect(this.windGain).connect(this.out);

    this.sources.push(hum, wind, lfo);
    const t = ctx.currentTime;
    for (const s of this.sources) s.start(t);
  }

  /** Fade the whole ambience in/out (city load, dispose). */
  fadeTo(level: number, seconds = 1.5): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(level, t, seconds / 3);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyLevels();
  }

  /** Update from city stats. */
  setCity(population: number, roadTiles: number, parkTiles: number): void {
    const p = Math.max(0, population);
    this.city = Math.min(1, Math.log10(1 + p) / Math.log10(1 + FULL_CITY_POP));
    const roads = Math.min(1, roadTiles / 400);
    const parks = Math.min(1, parkTiles / 150);
    this.traffic = this.city * (0.3 + 0.7 * roads);
    this.nature = Math.max(0.15, 1 - this.city * 0.85) * (0.8 + 0.4 * parks);
    this.applyLevels();
  }

  private applyLevels(): void {
    const t = this.ctx.currentTime;
    const busy = this.paused ? 0.6 : 1;
    this.humGain.gain.setTargetAtTime(0.02 + 0.33 * this.city * busy, t, SMOOTH);
    this.humFilter.frequency.setTargetAtTime(160 + 520 * this.city, t, SMOOTH);
    this.droneGain.gain.setTargetAtTime(0.006 * this.city, t, SMOOTH);
    this.windGain.gain.setTargetAtTime(0.05 + 0.12 * this.nature, t, SMOOTH);
  }

  /** Called every ~25 ms by the AudioSystem timer. Schedules discrete events slightly ahead. */
  tick(): void {
    const now = this.ctx.currentTime;
    if (this.nextTrafficAt < now - 1) this.nextTrafficAt = now + 0.5;
    if (this.nextBirdAt < now - 1) this.nextBirdAt = now + 1;

    const trafficRate = this.traffic * (this.paused ? 0.4 : 1);
    if (now >= this.nextTrafficAt) {
      if (trafficRate > 0.02) this.carPass(now + 0.05, trafficRate);
      // Mean gap shrinks from ~6 s (village) to ~0.7 s (busy city).
      const mean = 0.7 + 5.5 * (1 - trafficRate);
      this.nextTrafficAt = now + mean * (0.4 + this.rng.next() * 1.2);
    }

    if (now >= this.nextBirdAt) {
      if (this.rng.next() < this.nature) this.birdCall(now + 0.05);
      this.nextBirdAt = now + 2 + this.rng.next() * 6 * (1.5 - this.nature);
    }
  }

  private carPass(t: number, intensity: number): void {
    const ctx = this.ctx;
    const dur = 1.2 + this.rng.next() * 1.6;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 'pink');
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    // Doppler-ish: band rises then falls as the car passes.
    const base = 350 + this.rng.next() * 400;
    bp.frequency.setValueAtTime(base, t);
    bp.frequency.linearRampToValueAtTime(base * 1.6, t + dur * 0.45);
    bp.frequency.linearRampToValueAtTime(base * 0.8, t + dur);
    const g = ctx.createGain();
    const peak = (0.03 + 0.05 * intensity) * (0.6 + this.rng.next() * 0.6);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const pan = ctx.createStereoPanner();
    const dir = this.rng.next() < 0.5 ? -1 : 1;
    pan.pan.setValueAtTime(-0.8 * dir, t);
    pan.pan.linearRampToValueAtTime(0.8 * dir, t + dur);
    src.connect(bp).connect(g).connect(pan).connect(this.out);
    src.start(t, this.rng.next() * 1.5);
    src.stop(t + dur + 0.05);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
      pan.disconnect();
    };
  }

  private birdCall(t: number): void {
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = this.rng.range(-0.7, 0.7);
    pan.connect(this.out);
    const base = 2200 + this.rng.next() * 1800;
    const chirps = 2 + this.rng.int(0, 4);
    const vol = 0.025 + 0.03 * this.nature;
    let end = t;
    for (let i = 0; i < chirps; i++) {
      const s = t + i * (0.09 + this.rng.next() * 0.05);
      const up = this.rng.next() < 0.6;
      tone(this.ctx, pan, s, {
        type: 'sine',
        freq: up ? base : base * 1.3,
        toFreq: up ? base * 1.35 : base * 0.95,
        glide: 0.05,
        peak: vol,
        attack: 0.008,
        decay: 0.06,
      });
      end = s + 0.1;
    }
    setTimeout(() => pan.disconnect(), (end - this.ctx.currentTime + 0.5) * 1000);
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
      s.disconnect();
    }
    this.out.disconnect();
  }
}
