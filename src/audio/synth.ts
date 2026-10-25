/**
 * MODULE: audio — tiny synthesis helpers shared by sfx / ambience / music.
 * Owner: audio agent. No asset files: oscillators, noise buffers, filters and envelopes only.
 */

export type NoiseColor = 'white' | 'pink' | 'brown';

const noiseCache = new WeakMap<BaseAudioContext, Map<NoiseColor, AudioBuffer>>();

/** A looping-friendly 2 s mono noise buffer, cached per context. */
export function noiseBuffer(ctx: BaseAudioContext, color: NoiseColor): AudioBuffer {
  let byColor = noiseCache.get(ctx);
  if (!byColor) {
    byColor = new Map();
    noiseCache.set(ctx, byColor);
  }
  const cached = byColor.get(color);
  if (cached) return cached;

  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Cheap LCG: noise only needs to sound random, not be reproducible.
  let s = 0x2545f491;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
  if (color === 'white') {
    for (let i = 0; i < len; i++) d[i] = rnd();
  } else if (color === 'pink') {
    // Paul Kellet's economy pink filter.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd();
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  } else {
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * rnd()) / 1.02;
      d[i] = last * 3.5;
    }
  }
  // Crossfade the ends so the loop point doesn't click.
  const fade = Math.min(2048, len >> 4);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i] * t + d[len - fade + i] * (1 - t);
  }
  byColor.set(color, buf);
  return buf;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Attack / decay envelope on a gain param starting at t. Returns the end time. */
export function envAD(p: AudioParam, t: number, peak: number, attack: number, decay: number): number {
  p.cancelScheduledValues(t);
  p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return t + attack + decay;
}

/** Attack / hold / release envelope (pads). Returns the end time. */
export function envAHR(p: AudioParam, t: number, peak: number, attack: number, hold: number, release: number): number {
  p.cancelScheduledValues(t);
  p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setValueAtTime(peak, t + attack + hold);
  p.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  return t + attack + hold + release;
}

/** Disconnect a set of nodes once the source ends (keeps the graph from growing). */
export function cleanupOnEnd(src: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
  src.onended = () => {
    src.disconnect();
    for (const n of nodes) n.disconnect();
  };
}

/** One-shot oscillator voice: osc → gain(env) → dest. Optional pitch glide to `toFreq`. */
export function tone(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  opts: {
    type?: OscillatorType;
    freq: number;
    toFreq?: number;
    glide?: number;
    peak: number;
    attack?: number;
    decay: number;
    detune?: number;
  },
): void {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = opts.type ?? 'sine';
  o.frequency.setValueAtTime(opts.freq, t);
  if (opts.toFreq !== undefined) {
    o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.toFreq), t + (opts.glide ?? opts.decay));
  }
  if (opts.detune) o.detune.value = opts.detune;
  const end = envAD(g.gain, t, opts.peak, opts.attack ?? 0.005, opts.decay);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(end + 0.02);
  cleanupOnEnd(o, g);
}

/** One-shot filtered noise burst: noise → biquad → gain(env) → dest. */
export function noiseBurst(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  opts: {
    color?: NoiseColor;
    filter: BiquadFilterType;
    freq: number;
    toFreq?: number;
    q?: number;
    peak: number;
    attack?: number;
    decay: number;
  },
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.color ?? 'white');
  src.loop = true;
  // Random start offset so repeated bursts don't sound identical.
  const offset = (t * 7.31) % 1.5;
  const f = ctx.createBiquadFilter();
  f.type = opts.filter;
  f.frequency.setValueAtTime(opts.freq, t);
  if (opts.toFreq !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, opts.toFreq), t + opts.decay);
  f.Q.value = opts.q ?? 1;
  const g = ctx.createGain();
  const end = envAD(g.gain, t, opts.peak, opts.attack ?? 0.003, opts.decay);
  src.connect(f).connect(g).connect(dest);
  src.start(t, offset);
  src.stop(end + 0.02);
  cleanupOnEnd(src, f, g);
}
