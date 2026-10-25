/**
 * MODULE: ui — toast notifications (module-internal API; may change).
 * Owner: ui agent. Stacking toasts (newest at the bottom), max MAX_TOASTS, auto-dismiss, click to dismiss.
 */
import type { NotifyKind } from '../types';
import { h } from './dom';
import { UI_ICONS } from './icons';

const MAX_TOASTS = 5;
const EXIT_MS = 220;

interface Toast {
  el: HTMLDivElement;
  timer: number;
  leaving: boolean;
}

export class Toasts {
  readonly el: HTMLDivElement = h('div', 'vcb-toasts', { 'aria-live': 'polite', role: 'status' });
  private readonly toasts: Toast[] = [];

  push(message: string, kind: NotifyKind, durationMs?: number): void {
    const text = typeof message === 'string' ? message : String(message);
    const k: NotifyKind = kind === 'success' || kind === 'warning' || kind === 'error' ? kind : 'info';
    const ms = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : k === 'error' ? 6000 : 3500;

    const el = h('div', `vcb-toast vcb-toast-${k}`, { title: 'Click to dismiss' }, [
      h('span', 'vcb-toast-ico', { html: UI_ICONS[k], 'aria-hidden': 'true' }),
      h('span', 'vcb-toast-msg', { text }),
    ]);
    const toast: Toast = { el, timer: 0, leaving: false };
    el.addEventListener('click', () => this.dismiss(toast));
    toast.timer = window.setTimeout(() => this.dismiss(toast), ms);
    this.toasts.push(toast);
    this.el.appendChild(el);

    // Drop the oldest beyond the limit (immediately, so the stack never grows past it).
    let alive = 0;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i]!;
      if (t.leaving) continue;
      alive++;
      if (alive > MAX_TOASTS) this.dismiss(t);
    }
  }

  private dismiss(t: Toast): void {
    if (t.leaving) return;
    t.leaving = true;
    clearTimeout(t.timer);
    t.el.classList.add('vcb-toast-out');
    window.setTimeout(() => {
      t.el.remove();
      const i = this.toasts.indexOf(t);
      if (i >= 0) this.toasts.splice(i, 1);
    }, EXIT_MS);
  }

  dispose(): void {
    for (const t of this.toasts) clearTimeout(t.timer);
    this.toasts.length = 0;
    this.el.remove();
  }
}
