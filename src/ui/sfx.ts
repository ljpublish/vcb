/**
 * MODULE: ui — tiny procedural WebAudio sound effects (module-internal API; may change).
 * Owner: ui agent. STUB. No audio files: oscillators + noise buffers + envelopes only.
 */
export type SfxName = 'click' | 'build' | 'zone' | 'bulldoze' | 'error' | 'coin' | 'milestone';

export class Sfx {
  volume = 0.5;
  muted = false;
  /** Call from a user gesture to unlock the AudioContext. */
  unlock(): void {
    // TODO(ui)
  }
  play(name: SfxName): void {
    // TODO(ui)
  }
  dispose(): void {
    // TODO(ui)
  }
}
