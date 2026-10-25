/**
 * FROZEN CONTRACT — small shared helpers (math, formatting, calendar, DOM guards).
 * Owner: integrator. Module agents MUST NOT edit this file.
 * Safe to import anywhere (DOM is only touched inside function bodies).
 */
import { DAYS_PER_MONTH, DAYS_PER_YEAR, MONTHS_PER_YEAR, START_YEAR } from '../types';
import { Rng } from './rng';

// ------------------------------------------------------------------ math

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing towards target.
 * lambda ≈ 1/time-constant (e.g. 10 = snappy, 3 = floaty).
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Shortest signed angular difference b - a in radians, in (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

// ------------------------------------------------------------------ calendar

export const MONTH_NAMES: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export interface GameDate {
  year: number;
  /** 0..11 */
  month: number;
  /** 1..DAYS_PER_MONTH */
  day: number;
}

/** Day index (0-based, since founding) → calendar date. 30-day months, 12 months a year. */
export function dayToDate(dayIndex: number): GameDate {
  const d = Math.max(0, Math.floor(dayIndex));
  return {
    year: START_YEAR + Math.floor(d / DAYS_PER_YEAR),
    month: Math.floor(d / DAYS_PER_MONTH) % MONTHS_PER_YEAR,
    day: (d % DAYS_PER_MONTH) + 1,
  };
}

/** 'short' → "Mar 2001", 'long' → "12 Mar 2001". */
export function formatDate(dayIndex: number, style: 'short' | 'long' = 'short'): string {
  const g = dayToDate(dayIndex);
  return style === 'long' ? `${g.day} ${MONTH_NAMES[g.month]} ${g.year}` : `${MONTH_NAMES[g.month]} ${g.year}`;
}

/** True on the first day of a month. */
export function isMonthStart(dayIndex: number): boolean {
  return dayIndex % DAYS_PER_MONTH === 0;
}

// ------------------------------------------------------------------ formatting

/** 12345 → "12,345"; 1234567 → "1.23M" when compact. */
export function formatNumber(n: number, compact = false): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  }
  return Math.round(n).toLocaleString('en-US');
}

/** 12345 → "$12,345", -500 → "-$500". */
export function formatMoney(n: number, compact = false): string {
  const s = formatNumber(Math.abs(n), compact);
  return n < 0 ? `-$${s}` : `$${s}`;
}

/** 0.123 → "12%". */
export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

// ------------------------------------------------------------------ names

const NAME_A = ['New', 'Port', 'East', 'West', 'North', 'South', 'Little', 'Great', 'Old', 'Fort', 'Lake', 'Mount'];
const NAME_B = [
  'Oak', 'Maple', 'Cedar', 'River', 'Stone', 'Brook', 'Ash', 'Elm', 'Pine', 'Willow', 'Iron', 'Silver',
  'Fair', 'Green', 'Red', 'Gold', 'Clear', 'High', 'Wolf', 'Fox', 'Bay', 'Sun', 'Wind', 'Copper',
];
const NAME_C = ['ville', 'ton', 'field', 'ford', 'burg', 'wood', 'haven', 'port', 'dale', 'ridge', 'view', 'side', 'mouth', 'crest'];

/** Deterministic fun city name from a seed. */
export function randomCityName(seed: number): string {
  const r = new Rng(seed ^ 0x51ed270b);
  const core = r.pick(NAME_B) + r.pick(NAME_C);
  return r.chance(0.35) ? `${r.pick(NAME_A)} ${core}` : core;
}

// ------------------------------------------------------------------ DOM / async

/** True when a keyboard event target is a text field (modules must ignore hotkeys then). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** True if `code` is one of the codes bound to an action. */
export function keyMatches(codes: readonly string[], code: string): boolean {
  return codes.includes(code);
}

/** Resolves on the next animation frame (falls back to a timeout). */
export function nextFrame(): Promise<number> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame((t) => resolve(t));
    else setTimeout(() => resolve(performance.now()), 16);
  });
}

/** Resolves after ms milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Message string from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
