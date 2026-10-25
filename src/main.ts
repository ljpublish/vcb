/**
 * INTEGRATOR-OWNED — browser entry point. Module agents MUST NOT edit this file.
 *
 * Import order matters: colorSetup must run before any module creates a THREE.Color.
 */
import './render/colorSetup';
import './style.css';
import { Game } from './game';
import { errorMessage } from './core/util';

declare global {
  interface Window {
    /** Debug handle: the running Game (sim, world, view, … are public fields). */
    __vcb?: Game;
  }
}

function showFatal(message: string): void {
  const el = document.createElement('div');
  el.className = 'vcb-fatal';
  el.textContent = message;
  document.body.appendChild(el);
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function boot(): void {
  const viewport = document.getElementById('viewport');
  const uiRoot = document.getElementById('ui');
  if (!viewport || !uiRoot) {
    showFatal('Page is missing #viewport / #ui.');
    return;
  }
  if (!webglAvailable()) {
    showFatal('Voxel City Builder needs WebGL, which is not available in this browser.');
    return;
  }
  let game: Game;
  try {
    game = new Game({ viewport, uiRoot });
  } catch (err) {
    console.error(err);
    showFatal(`Failed to start: ${errorMessage(err)}`);
    return;
  }
  window.__vcb = game;
  game.start().catch((err: unknown) => {
    console.error(err);
    showFatal(`Failed to start: ${errorMessage(err)}`);
  });
}

boot();
