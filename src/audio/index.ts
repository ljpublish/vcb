/**
 * MODULE: audio — public entry point. Procedural Web Audio: SFX, city ambience, generative music.
 * Owner: audio agent. See src/audio/README.md for the integration lines.
 *
 *   import { getAudio } from './audio';
 *   getAudio().attach(bus);          // game.ts, once, right after the bus is created
 *   getAudio().playSfx('click');     // UI buttons
 *
 * getAudio() and every method are safe before the first user gesture and without Web Audio.
 */
import { AudioSystem } from './audioSystem';

export { AudioSystem, AUDIO_PREFS_KEY, type AudioState } from './audioSystem';
export { SFX_NAMES, type SfxName } from './sfx';

let instance: AudioSystem | null = null;

/** The shared AudioSystem (created lazily; creating it does not create an AudioContext). */
export function getAudio(): AudioSystem {
  if (!instance) instance = new AudioSystem();
  return instance;
}

/** Dispose the shared instance (tests / HMR). The next getAudio() creates a fresh one. */
export function disposeAudio(): void {
  instance?.dispose();
  instance = null;
}
