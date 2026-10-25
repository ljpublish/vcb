/**
 * FROZEN CONTRACT — typed, synchronous event bus + the game's event map.
 * Owner: integrator. Module agents MUST NOT edit this file.
 *
 * Semantics:
 *  - emit() is synchronous: handlers run immediately, in subscription order.
 *  - A handler that throws is logged (console.error) and does not stop other handlers.
 *  - Subscribing/unsubscribing during an emit is safe (dispatch iterates a snapshot).
 *  - on() returns an unsubscribe function; call it in your dispose().
 *  - Payloads must be treated as read-only by handlers.
 */
import type {
  ActionResult,
  BudgetReport,
  ChangeCause,
  CityStats,
  NotifyKind,
  OverlayMode,
  SimSpeed,
  TileCoord,
  ToolAction,
  ToolId,
  ToolPreviewInfo,
} from '../types';

/** Every event in the game: name → payload. */
export interface GameEvents {
  /**
   * Tile state changed (kind, zone, building added/removed/changed level/state/stage, road, decor).
   * Emitter: simulation (once per applyAction and at most once per update() for growth).
   * Main listener: StructureSync (restamps those tiles + neighbours). Tile indices = tz*MAP_TILES+tx.
   */
  'tiles:changed': { tiles: readonly number[]; cause: ChangeCause };
  /** A city finished loading/generating (world, structures, sim all consistent). Emitter: game controller. */
  'city:loaded': { seed: number; name: string; source: 'new' | 'load' };
  /** Stats were recomputed. Emitter: simulation (≤ once per tick and after every applied action). */
  'stats:changed': { stats: Readonly<CityStats> };
  /** Speed changed. Emitter: simulation. */
  'sim:speed': { speed: SimSpeed };
  /** A month just ended and its budget was applied. Emitter: simulation. */
  'sim:month': { day: number; report: Readonly<BudgetReport>; money: number };
  /** A player action was applied (ok or not). Emitter: simulation (inside applyAction). */
  'action:applied': { action: ToolAction; result: ActionResult };
  /** Toast notification request. Emitter: anyone. Listener: UI. */
  'notify': { message: string; kind: NotifyKind; durationMs?: number };
  /** Active tool changed. Emitter: tool controller. */
  'tool:changed': { tool: ToolId };
  /** Cursor tooltip data for the active build tool (null = hide). Emitter: tool controller. */
  'tool:preview': { preview: ToolPreviewInfo | null };
  /** Tile under the cursor (null = none). Emitter: tool controller (only when it changes). */
  'tile:hover': { tile: TileCoord | null };
  /**
   * Inspect a tile (null = nothing inspected). Emitters: tool controller (select-tool click; null on
   * click off-map) and UI (null when the user closes the inspect panel). Listeners: UI (panel),
   * tool controller (selection highlight).
   */
  'inspect': { tile: TileCoord | null };
  /** Data overlay changed. Emitter: tool controller. */
  'overlay:changed': { mode: OverlayMode };
  /** A save was written. Emitter: save manager. */
  'save:written': { slot: string; bytes: number; auto: boolean };
  /** A modal dialog opened/closed (camera + tools are disabled while open). Emitter: UI. */
  'ui:modal': { open: boolean };
}

export type Handler<T> = (payload: T) => void;

export class EventBus<E extends object> {
  private readonly handlers = new Map<keyof E, Set<Handler<never>>>();

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => this.off(type, fn);
  }

  /** Subscribe for a single emission. Returns an unsubscribe function. */
  once<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends keyof E>(type: K, fn: Handler<E[K]>): void {
    const set = this.handlers.get(type);
    if (!set) return;
    set.delete(fn as Handler<never>);
    if (set.size === 0) this.handlers.delete(type);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) {
      try {
        (fn as Handler<E[K]>)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(type)}" threw:`, err);
      }
    }
  }

  /** Number of handlers for an event (debug). */
  listenerCount<K extends keyof E>(type: K): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  /** Remove every handler. */
  clear(): void {
    this.handlers.clear();
  }
}

/** The game's bus type. */
export type GameBus = EventBus<GameEvents>;

export function createGameBus(): GameBus {
  return new EventBus<GameEvents>();
}
