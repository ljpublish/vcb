/**
 * MODULE: ui — persisted UI / view preferences (module-internal). Stored as JSON in
 * localStorage[SETTINGS_KEY]; missing or corrupt values fall back to the defaults.
 * Owner: ui agent.
 */
import { SETTINGS_KEY } from '../types';

export interface UISettings {
  shadows: boolean;
  autoTime: boolean;
  /** 0..1, used when autoTime is off. */
  timeOfDay: number;
  grid: boolean;
  fx: boolean;
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** The "Getting started" card was dismissed once. */
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: Readonly<UISettings> = {
  shadows: true,
  autoTime: true,
  timeOfDay: 0.4,
  grid: false,
  fx: true,
  volume: 0.5,
  muted: false,
  onboardingDone: false,
};

function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

function unit(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d;
}

export function loadSettings(): UISettings {
  const s: UISettings = { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return s;
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object') return s;
    const r = o as Record<string, unknown>;
    s.shadows = bool(r.shadows, s.shadows);
    s.autoTime = bool(r.autoTime, s.autoTime);
    s.timeOfDay = unit(r.timeOfDay, s.timeOfDay);
    s.grid = bool(r.grid, s.grid);
    s.fx = bool(r.fx, s.fx);
    s.volume = unit(r.volume, s.volume);
    s.muted = bool(r.muted, s.muted);
    s.onboardingDone = bool(r.onboardingDone, s.onboardingDone);
  } catch {
    // corrupt or unavailable storage → defaults
  }
  return s;
}

export function saveSettings(s: Readonly<UISettings>): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable (private mode / quota) → settings are session-only
  }
}
