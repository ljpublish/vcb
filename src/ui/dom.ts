/**
 * MODULE: ui — tiny DOM helpers shared by the ui files (module-internal).
 * Owner: ui agent.
 */

export type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Child = Node | string | null | undefined | false;

/** Creates an element with a class list, attributes and children. `text` sets textContent. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  attrs?: Attrs | null,
  children?: readonly Child[],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (attrs) {
    for (const key in attrs) {
      const v = attrs[key];
      if (v === null || v === undefined || v === false) continue;
      if (key === 'text') el.textContent = String(v);
      else if (key === 'html') el.innerHTML = String(v);
      else el.setAttribute(key, v === true ? '' : String(v));
    }
  }
  if (children) append(el, children);
  return el;
}

export function append(el: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/** Button with an optional inline-SVG icon, a label and an accessible title. */
export function button(cls: string, label: string, title: string, icon?: string): HTMLButtonElement {
  const b = h('button', `vcb-btn ${cls}`.trim(), { type: 'button', title, 'aria-label': title });
  if (icon) b.appendChild(h('span', 'vcb-ico', { html: icon, 'aria-hidden': 'true' }));
  if (label) b.appendChild(h('span', 'vcb-btn-label', { text: label }));
  return b;
}

/** Writes textContent only when it differs (no needless DOM mutations). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Toggles a class only when the state differs. */
export function setClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** Tracks event listeners so they can all be removed in dispose(). */
export class Listeners {
  private readonly offs: (() => void)[] = [];

  on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions | boolean,
  ): void;
  on<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions | boolean,
  ): void;
  on(target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions | boolean): void {
    const listener = fn as unknown as EventListener;
    target.addEventListener(type, listener, opts);
    this.offs.push(() => target.removeEventListener(type, listener, opts));
  }

  /** Registers an arbitrary cleanup (e.g. a bus unsubscribe). */
  add(off: () => void): void {
    this.offs.push(off);
  }

  dispose(): void {
    for (const off of this.offs) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    this.offs.length = 0;
  }
}

/** "GRASS_DARK" → "Grass dark". */
export function humanize(name: string): string {
  const s = name.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Bytes (UTF-16 code units of a stored string) → "12.3 KB". */
export function formatBytes(units: number): string {
  const bytes = units * 2;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** KeyboardEvent.code → readable key name. */
export function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    Escape: 'Esc',
    Delete: 'Del',
    Space: 'Space',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    NumpadSubtract: 'Num −',
    NumpadAdd: 'Num +',
    Backquote: '`',
    Home: 'Home',
  };
  return map[code] ?? code;
}
