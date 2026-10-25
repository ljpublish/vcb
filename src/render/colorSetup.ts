/**
 * FROZEN CONTRACT — global color pipeline switch. Imported FIRST by src/main.ts.
 * Owner: integrator. Module agents MUST NOT edit this file.
 *
 * The game uses a "WYSIWYG" color pipeline: palette colors (sRGB hex) are used as-is for vertex
 * colors, materials, fog and clear color. Therefore:
 *   - THREE.ColorManagement is disabled here (before any THREE.Color is created by other modules),
 *   - src/render/scene.ts MUST set renderer.outputColorSpace = THREE.LinearSRGBColorSpace
 *     (i.e. no output conversion),
 *   - nobody converts colors between sRGB and linear.
 */
import * as THREE from 'three';

THREE.ColorManagement.enabled = false;

export const COLOR_PIPELINE = 'wysiwyg-srgb' as const;
