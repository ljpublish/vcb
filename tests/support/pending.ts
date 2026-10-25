/**
 * "Pending module" detection for tests.
 *
 * Every module file on main starts life as a skeleton stub whose header comment contains the word
 * STUB. A module counts as merged once its entry file no longer says STUB in its header. Tests that
 * depend on a module call `pendingReason(...)` and skip themselves while it returns a string, so
 * CI stays green during parallel development and the tests switch on automatically on merge.
 *
 * Set VCB_TEST_ALL=1 to run pending tests anyway (e.g. while finishing a module, before its STUB
 * header is removed).
 *
 * Node only (reads source files). Never import from src/ or from page code.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The file whose header decides whether a module is merged. */
export const MODULE_ENTRY = {
  simulation: 'src/sim/simulation.ts',
  buildings: 'src/build/structureSync.ts',
  input: 'src/input/toolController.ts',
  camera: 'src/input/cameraRig.ts',
  ui: 'src/ui/gameUI.ts',
  persistence: 'src/persist/saveManager.ts',
  codec: 'src/persist/saveCodec.ts',
  atmosphere: 'src/fx/effects.ts',
} as const;

export type ModuleName = keyof typeof MODULE_ENTRY;

const HEADER_LINES = 15;

export function isPending(mod: ModuleName): boolean {
  if (process.env.VCB_TEST_ALL === '1') return false;
  const src = readFileSync(ROOT + MODULE_ENTRY[mod], 'utf8');
  const header = src.split('\n', HEADER_LINES).join('\n');
  return /\bSTUB\b/.test(header);
}

/** Skip reason if any of the modules is still a stub, else undefined. */
export function pendingReason(...mods: ModuleName[]): string | undefined {
  const missing = mods.filter(isPending);
  if (missing.length === 0) return undefined;
  return `pending: waiting for module(s) ${missing.join(', ')} to be merged`;
}
