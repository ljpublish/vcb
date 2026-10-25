/**
 * MODULE: ui — tool palette (module-internal API; may change).
 * Owner: ui agent.
 *
 * Seven tool buttons (icon, label, hotkey badge, hover hint with costs from TOOL_COSTS), a data
 * overlay picker and a grid toggle. Active state is driven from outside ('tool:changed',
 * 'overlay:changed') via setActive / setOverlay / setGrid.
 */
import {
  CIVIC_KINDS,
  CIVIC_SPECS,
  KEYMAP,
  TOOL_COSTS,
  civicKindOfTool,
  type CivicKind,
  type CivicToolId,
  type IToolController,
  type OverlayMode,
  type ToolId,
} from '../types';
import { formatMoney } from '../core/util';
import { button, h, keyName, setClass, setText } from './dom';
import { TOOL_ICONS, UI_ICONS } from './icons';

export interface ToolButtonDef {
  id: ToolId;
  label: string;
  /** KEYMAP action whose first code is shown as the hotkey badge. */
  hotkey: keyof typeof KEYMAP;
  /** Short description incl. cost. */
  hint: string;
}

const C = TOOL_COSTS;

export const TOOL_DEFS: readonly ToolButtonDef[] = [
  { id: 'select', label: 'Inspect', hotkey: 'toolSelect', hint: 'Click a tile or building to inspect it' },
  {
    id: 'road',
    label: 'Road',
    hotkey: 'toolRoad',
    hint: `Drag to build roads · $${C.road}/tile, bridges $${C.bridge}/tile · Shift = straight · trees +$${C.treeClear}`,
  },
  {
    id: 'zone_r',
    label: 'Residential',
    hotkey: 'toolResidential',
    hint: `Drag to zone homes · $${C.zone}/tile · needs a road within reach`,
  },
  {
    id: 'zone_c',
    label: 'Commercial',
    hotkey: 'toolCommercial',
    hint: `Drag to zone shops and offices · $${C.zone}/tile`,
  },
  {
    id: 'zone_i',
    label: 'Industrial',
    hotkey: 'toolIndustrial',
    hint: `Drag to zone factories · $${C.zone}/tile · pollutes nearby`,
  },
  { id: 'park', label: 'Park', hotkey: 'toolPark', hint: `Drag to place parks · $${C.park}/tile · raises land value` },
  {
    id: 'bulldoze',
    label: 'Bulldoze',
    hotkey: 'toolBulldoze',
    hint: `Drag to demolish · $${C.bulldoze}/tile + $${C.bulldozeBuildingPerLevel}×level per building · trees +$${C.treeClear}`,
  },
];

export const OVERLAY_DEFS: readonly { mode: OverlayMode; title: string; icon: string }[] = [
  { mode: 'none', title: 'No data overlay', icon: UI_ICONS.ovNone },
  { mode: 'landValue', title: 'Land value overlay', icon: UI_ICONS.ovLand },
  { mode: 'pollution', title: 'Pollution overlay', icon: UI_ICONS.ovPollution },
  { mode: 'roadAccess', title: 'Road access overlay', icon: UI_ICONS.ovAccess },
];

/** Short description of a civic building for menus / hints. */
export function civicHint(kind: CivicKind): string {
  const d = CIVIC_SPECS[kind];
  const reach = d.radius > 0 ? `covers ${d.radius} tiles` : 'citywide';
  return `${formatMoney(d.cost)} · ${formatMoney(d.upkeep)}/mo · ${d.size}×${d.size} · ${reach}${d.maxCount ? ` · max ${d.maxCount}` : ''}`;
}

export interface ToolbarOptions {
  onGridToggle(): void;
  /** Number of civic buildings of a kind (for max-count limits). */
  civicCount(kind: CivicKind): number;
}

export class Toolbar {
  readonly el: HTMLDivElement = h('div', 'vcb-toolbar vcb-panel', { role: 'toolbar', 'aria-label': 'Tools' });
  private readonly toolBtns = new Map<ToolId, HTMLButtonElement>();
  private readonly overlayBtns = new Map<OverlayMode, HTMLButtonElement>();
  private readonly gridBtn: HTMLButtonElement;
  private active: ToolId | null = null;
  private overlay: OverlayMode | null = null;
  private readonly civicBtn: HTMLButtonElement;
  private readonly civicIcon: HTMLSpanElement;
  private readonly civicLabel: HTMLSpanElement;
  private readonly civicMenu: HTMLDivElement;
  private readonly civicItems = new Map<CivicKind, { btn: HTMLButtonElement; note: HTMLSpanElement }>();
  /** Last civic tool used (Digit8 re-selects it, then cycles). */
  lastCivic: CivicToolId = 'civic_police';

  constructor(
    private readonly tools: IToolController,
    private readonly opts: ToolbarOptions,
  ) {
    const onGridToggle = (): void => opts.onGridToggle();
    const toolGroup = h('div', 'vcb-tool-group');
    for (const def of TOOL_DEFS) {
      const key = keyName(KEYMAP[def.hotkey][0]);
      const title = `${def.label} (${key}) — ${def.hint}`;
      const b = button(`vcb-tool vcb-tool-${def.id}`, def.label, title, TOOL_ICONS[def.id]);
      b.appendChild(h('span', 'vcb-key', { text: key, 'aria-hidden': 'true' }));
      b.appendChild(
        h('span', 'vcb-tip', { 'aria-hidden': 'true' }, [
          h('strong', '', { text: `${def.label} ` }),
          h('span', 'vcb-tip-key', { text: key }),
          h('br'),
          def.hint,
        ]),
      );
      b.removeAttribute('title'); // the styled tip replaces the native one
      b.addEventListener('click', () => {
        try {
          this.tools.setTool(def.id);
        } catch (err) {
          console.error('[ui] setTool failed', err);
        }
      });
      toolGroup.appendChild(b);
      this.toolBtns.set(def.id, b);
    }

    // --- civic services: one button that opens a menu of the five buildings.
    const civicKey = keyName(KEYMAP.toolCivic[0]);
    this.civicBtn = button('vcb-tool vcb-tool-civic', 'Services', `Civic services (${civicKey})`, TOOL_ICONS.civic_town_hall);
    this.civicBtn.removeAttribute('title');
    this.civicBtn.setAttribute('aria-haspopup', 'menu');
    this.civicIcon = this.civicBtn.querySelector('.vcb-ico') as HTMLSpanElement;
    this.civicLabel = this.civicBtn.querySelector('.vcb-btn-label') as HTMLSpanElement;
    this.civicBtn.appendChild(h('span', 'vcb-key', { text: civicKey, 'aria-hidden': 'true' }));
    this.civicMenu = h('div', 'vcb-civic-menu vcb-panel', { role: 'menu', 'aria-label': 'Civic services' });
    this.civicMenu.appendChild(
      h('div', 'vcb-civic-head', null, [h('span', '', { text: 'Civic services' }), h('span', 'vcb-civic-hint', null, [h('kbd', '', { text: civicKey }), ' cycles'])]),
    );
    for (const kind of CIVIC_KINDS) {
      const d = CIVIC_SPECS[kind];
      const tool = `civic_${kind}` as CivicToolId;
      const note = h('span', 'vcb-civic-note', { text: '' });
      const item = h('button', `vcb-btn vcb-civic-item vcb-civic-${kind}`, { type: 'button', role: 'menuitem', 'aria-label': `${d.label}: ${civicHint(kind)}` }, [
        h('span', 'vcb-ico', { html: TOOL_ICONS[tool], 'aria-hidden': 'true' }),
        h('span', 'vcb-civic-text', null, [h('span', 'vcb-civic-name', null, [d.label, note]), h('span', 'vcb-civic-meta', { text: civicHint(kind) })]),
      ]);
      item.addEventListener('click', () => {
        this.toggleCivicMenu(false);
        try {
          this.tools.setTool(tool);
        } catch (err) {
          console.error('[ui] setTool failed', err);
        }
      });
      this.civicMenu.appendChild(item);
      this.civicItems.set(kind, { btn: item, note });
    }
    this.civicBtn.addEventListener('click', () => this.toggleCivicMenu());
    const civicWrap = h('div', 'vcb-civic-wrap', null, [this.civicBtn, this.civicMenu]);
    toolGroup.appendChild(civicWrap);
    window.addEventListener('pointerdown', this.onWindowDown, true);

    const ovGroup = h('div', 'vcb-ov-group', { role: 'group', 'aria-label': 'Data overlay' });
    ovGroup.appendChild(h('span', 'vcb-ico vcb-ov-label', { html: UI_ICONS.layers, title: 'Data overlay (O)', 'aria-hidden': 'true' }));
    for (const def of OVERLAY_DEFS) {
      const b = button('vcb-icon-btn vcb-ov', '', `${def.title} (O cycles)`, def.icon);
      b.addEventListener('click', () => {
        try {
          this.tools.overlay = def.mode;
        } catch (err) {
          console.error('[ui] overlay failed', err);
        }
        // The tool controller emits 'overlay:changed'; reflect immediately as well.
        this.setOverlay(this.safeOverlay());
      });
      ovGroup.appendChild(b);
      this.overlayBtns.set(def.mode, b);
    }
    this.gridBtn = button('vcb-icon-btn vcb-grid-btn', '', 'Toggle grid (G)', UI_ICONS.grid);
    this.gridBtn.addEventListener('click', onGridToggle);
    ovGroup.appendChild(this.gridBtn);

    this.el.append(toolGroup, h('div', 'vcb-tb-sep'), ovGroup);
    this.setActive(this.safeTool());
    this.setOverlay(this.safeOverlay());
  }

  private safeTool(): ToolId {
    try {
      return this.tools.tool;
    } catch {
      return 'select';
    }
  }

  private safeOverlay(): OverlayMode {
    try {
      return this.tools.overlay;
    } catch {
      return 'none';
    }
  }

  setActive(tool: ToolId): void {
    if (tool === this.active) return;
    this.active = tool;
    for (const [id, b] of this.toolBtns) {
      setClass(b, 'vcb-active', id === tool);
      b.setAttribute('aria-pressed', id === tool ? 'true' : 'false');
    }
    const kind = civicKindOfTool(tool);
    if (kind && CIVIC_SPECS[kind]) {
      this.lastCivic = tool as CivicToolId;
      this.civicIcon.innerHTML = TOOL_ICONS[tool];
      setText(this.civicLabel, CIVIC_SPECS[kind].label.split(' ')[0]!);
    } else {
      setText(this.civicLabel, 'Services');
    }
    setClass(this.civicBtn, 'vcb-active', kind !== null);
    for (const [k, it] of this.civicItems) setClass(it.btn, 'vcb-active', k === kind);
  }

  /** Next civic tool for the Digit8 hotkey: the last used one first, then cycling. */
  nextCivicTool(current: ToolId): CivicToolId {
    const kind = civicKindOfTool(current);
    if (!kind) return this.lastCivic;
    const i = CIVIC_KINDS.indexOf(kind);
    return `civic_${CIVIC_KINDS[(i + 1) % CIVIC_KINDS.length]!}` as CivicToolId;
  }

  get civicMenuOpen(): boolean {
    return this.civicMenu.classList.contains('vcb-open');
  }

  toggleCivicMenu(open = !this.civicMenuOpen): void {
    if (open) this.refreshCivicLimits();
    setClass(this.civicMenu, 'vcb-open', open);
    this.civicBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  private refreshCivicLimits(): void {
    for (const [kind, it] of this.civicItems) {
      const max = CIVIC_SPECS[kind].maxCount;
      let n = 0;
      try {
        n = this.opts.civicCount(kind);
      } catch {
        n = 0;
      }
      const full = max > 0 && n >= max;
      it.btn.disabled = full;
      setText(it.note, full ? ' · built' : n > 0 ? ` · ${n}` : '');
    }
  }

  private readonly onWindowDown = (e: PointerEvent): void => {
    if (!this.civicMenuOpen) return;
    const t = e.target as Node | null;
    if (t && (this.civicMenu.contains(t) || this.civicBtn.contains(t))) return;
    this.toggleCivicMenu(false);
  };

  setOverlay(mode: OverlayMode): void {
    if (mode === this.overlay) return;
    this.overlay = mode;
    for (const [m, b] of this.overlayBtns) {
      setClass(b, 'vcb-active', m === mode);
      b.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    }
  }

  setGrid(on: boolean): void {
    setClass(this.gridBtn, 'vcb-active', on);
    this.gridBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.onWindowDown, true);
    this.el.remove();
  }
}
