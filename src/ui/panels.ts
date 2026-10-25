/**
 * MODULE: ui — inspect panel and modal dialogs: budget, save/load, new city, settings, help
 * (module-internal API; may change).
 * Owner: ui agent.
 *
 * ModalHost shows one modal at a time over a backdrop (Escape / backdrop click / × closes) and
 * reports open/close through onChange (GameUI turns that into 'ui:modal'). Modal bodies are built
 * fresh on open; the budget and settings modals refresh live from update().
 */
import {
  BuildingState,
  CIVIC_SPECS,
  CONSTRUCTION_STAGES,
  DIR_BIT,
  KEYMAP,
  QUICKSAVE_SLOT,
  TAX_MAX,
  TAX_MIN,
  TileKind,
  ZoneType,
  type BudgetReport,
  type ICameraRig,
  type IGameController,
  type ISimulation,
  type RCIZone,
  type SaveSlotInfo,
  type TileCoord,
  type TileInfo,
} from '../types';
import { formatDate, formatMoney, formatNumber, formatPercent, randomCityName } from '../core/util';
import { randomSeed } from '../core/rng';
import { blockName } from '../voxel/blocks';
import { button, formatBytes, h, humanize, keyName, setClass, setText, type Child } from './dom';
import { UI_ICONS } from './icons';
import type { UISettings } from './settings';

export type ModalId = 'budget' | 'save' | 'load' | 'newCity' | 'settings' | 'help';

const ZONE_NAMES = ['None', 'Residential', 'Commercial', 'Industrial'] as const;
const ZONE_KEYS = ['', 'r', 'c', 'i'] as const;
const LEVEL_NAMES = ['', 'Low density', 'Medium density', 'High density'] as const;
const DIR_NAMES = ['N', 'E', 'S', 'W'] as const;

/** Readable tile kind, shared by the inspect panel and the status line. */
export function describeTileKind(info: TileInfo, groundName?: string): string {
  switch (info.kind) {
    case TileKind.Road:
      return info.water ? 'Bridge' : 'Road';
    case TileKind.Park:
      return 'Park';
    case TileKind.Civic: {
      const c = info.civic;
      return c && CIVIC_SPECS[c.kind] ? CIVIC_SPECS[c.kind].label : 'Civic building';
    }
    case TileKind.Zoned: {
      const zone = ZONE_NAMES[info.zone] ?? 'Zoned';
      return info.building ? `${zone} L${info.building.level}` : `${zone} zone`;
    }
    default:
      if (info.water) return 'Water';
      return groundName ?? 'Empty land';
  }
}

function roadMaskText(mask: number): string {
  const parts: string[] = [];
  for (let d = 0; d < 4; d++) if (mask & DIR_BIT[d]!) parts.push(DIR_NAMES[d]!);
  return parts.length ? parts.join(' ') : 'none';
}

function meter(value: number, cls: string): HTMLDivElement {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const fill = h('div', `vcb-meter-fill ${cls}`);
  fill.style.width = `${(v * 100).toFixed(0)}%`;
  return h('div', 'vcb-meter', null, [fill]);
}

// ============================================================================================
// Inspect panel
// ============================================================================================

export interface InspectDeps {
  sim: ISimulation;
  camera: ICameraRig;
  groundName(tx: number, tz: number): string;
  /** User closed the panel (× button). */
  onClose(): void;
}

export class InspectPanel {
  readonly el: HTMLDivElement = h('div', 'vcb-inspect vcb-panel', { role: 'dialog', 'aria-label': 'Tile inspector' });
  private readonly title: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private tile: TileCoord | null = null;
  private refreshT = 0;
  private lastKey = '';

  constructor(private readonly deps: InspectDeps) {
    this.title = h('div', 'vcb-inspect-title', { text: '' });
    this.subtitle = h('div', 'vcb-inspect-sub', { text: '' });
    const close = button('vcb-icon-btn vcb-close', '', 'Close (Esc)', UI_ICONS.close);
    close.addEventListener('click', () => this.deps.onClose());
    const look = button('vcb-small', 'Look at', 'Move the camera to this tile', UI_ICONS.target);
    look.addEventListener('click', () => {
      if (!this.tile) return;
      try {
        this.deps.camera.lookAtTile(this.tile.tx, this.tile.tz);
      } catch (err) {
        console.error('[ui] lookAtTile failed', err);
      }
    });
    this.body = h('div', 'vcb-inspect-body');
    this.el.append(
      h('div', 'vcb-inspect-head', null, [h('div', 'vcb-inspect-titles', null, [this.title, this.subtitle]), close]),
      this.body,
      h('div', 'vcb-inspect-foot', null, [look]),
    );
  }

  get isOpen(): boolean {
    return this.tile !== null;
  }

  /** Shows the panel for a tile (null hides it). */
  show(tile: TileCoord | null): void {
    if (!tile || !Number.isFinite(tile.tx) || !Number.isFinite(tile.tz)) {
      this.tile = null;
      setClass(this.el, 'vcb-open', false);
      return;
    }
    this.tile = { tx: tile.tx | 0, tz: tile.tz | 0 };
    this.lastKey = '';
    this.refresh();
    setClass(this.el, 'vcb-open', true);
  }

  /** Live refresh at ≤ 4 Hz. */
  update(dt: number): void {
    if (!this.tile) return;
    this.refreshT += dt;
    if (this.refreshT < 0.25) return;
    this.refreshT = 0;
    this.refresh();
  }

  private refresh(): void {
    const t = this.tile;
    if (!t) return;
    let info: TileInfo;
    try {
      info = this.deps.sim.getTileInfo(t.tx, t.tz);
    } catch (err) {
      console.error('[ui] getTileInfo failed', err);
      return;
    }
    const b = info.building;
    // Rebuild the body only when something visible changed.
    const key = [
      info.kind, info.zone, info.height, info.water, info.decor, info.roadMask, info.roadAccess,
      Math.round(info.landValue * 100), Math.round(info.pollution * 100),
      b ? `${b.id},${b.level},${b.state},${b.stage},${b.occupants},${b.capacity},${b.size}` : '-',
      info.civic ? `${info.civic.id},${info.civic.kind}` : '-',
      info.coverage ? `${Math.round(info.coverage.police * 100)},${Math.round(info.coverage.fire * 100)},${Math.round(info.coverage.education * 100)},${Math.round(info.coverage.health * 100)}` : '-',
    ].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    let ground = '';
    try {
      ground = this.deps.groundName(t.tx, t.tz);
    } catch {
      ground = 'Land';
    }
    setText(this.title, describeTileKind(info, ground));
    setText(this.subtitle, `Tile ${info.tx}, ${info.tz}`);
    this.el.dataset.zone = ZONE_KEYS[info.zone] ?? '';

    const rows: Child[] = [];
    const row = (label: string, value: Child | string): void => {
      rows.push(h('div', 'vcb-row', null, [h('span', 'vcb-row-k', { text: label }), h('span', 'vcb-row-v', null, [value])]));
    };
    if (info.kind === TileKind.Zoned) row('Zone', ZONE_NAMES[info.zone] ?? '—');
    row('Terrain', info.water ? `Water (bed ${info.height})` : `${ground} · height ${info.height}`);
    if (info.kind === TileKind.Road) row('Connections', roadMaskText(info.roadMask));
    if (info.kind === TileKind.Zoned || info.kind === TileKind.Empty) {
      const acc = h('span', info.roadAccess ? 'vcb-pos' : 'vcb-neg', { text: info.roadAccess ? 'Yes' : 'No road nearby' });
      row('Road access', acc);
    }
    row('Land value', h('span', 'vcb-meter-row', null, [meter(info.landValue, 'vcb-meter-good'), formatPercent(info.landValue)]));
    row('Pollution', h('span', 'vcb-meter-row', null, [meter(info.pollution, 'vcb-meter-bad'), formatPercent(info.pollution)]));
    if (info.decor) row('Nature', 'Trees / flowers');

    const cov = info.coverage;
    if (cov && info.kind !== TileKind.Road && !info.water) {
      rows.push(h('div', 'vcb-inspect-section', { text: 'Services' }));
      const covRow = (label: string, v: number): void =>
        row(label, h('span', 'vcb-meter-row', null, [meter(v, v >= 0.5 ? 'vcb-meter-good' : 'vcb-meter-low'), formatPercent(Number.isFinite(v) ? v : 0)]));
      covRow('Police', cov.police);
      covRow('Fire', cov.fire);
      covRow('Education', cov.education);
      covRow('Health', cov.health);
    }

    const civic = info.civic ?? null;
    if (civic && CIVIC_SPECS[civic.kind]) {
      const d = CIVIC_SPECS[civic.kind];
      rows.push(h('div', 'vcb-inspect-section', { text: 'Civic building' }));
      row('Service', d.label);
      row('Size', `${d.size}×${d.size} tile${d.size > 1 ? 's' : ''}`);
      row('Coverage', d.radius > 0 ? `${d.radius} tiles around` : 'Citywide');
      row('Upkeep', `${formatMoney(d.upkeep)}/month`);
      row('Facing', DIR_NAMES[civic.facing] ?? '—');
      row('Built', formatDate(civic.builtDay, 'long'));
    }

    if (b) {
      rows.push(h('div', 'vcb-inspect-section', { text: 'Building' }));
      row('Type', `${ZONE_NAMES[b.zone] ?? ''} · ${LEVEL_NAMES[b.level] ?? `L${b.level}`}`);
      row('Size', `${b.size}×${b.size} tile${b.size > 1 ? 's' : ''}`);
      let state: string;
      let stateCls = '';
      if (b.state === BuildingState.Constructing) {
        state = `Under construction (stage ${Math.min(CONSTRUCTION_STAGES, b.stage + 1)}/${CONSTRUCTION_STAGES})`;
        stateCls = 'vcb-warn';
      } else if (b.state === BuildingState.Abandoned) {
        state = 'Abandoned';
        stateCls = 'vcb-neg';
      } else {
        state = 'Active';
        stateCls = 'vcb-pos';
      }
      row('State', h('span', stateCls, { text: state }));
      const cap = Math.max(0, b.capacity);
      const occ = Math.max(0, b.occupants);
      const occLabel = b.zone === ZoneType.Residential ? 'Residents' : 'Jobs filled';
      row(occLabel, h('span', 'vcb-meter-row', null, [meter(cap > 0 ? occ / cap : 0, 'vcb-meter-good'), `${formatNumber(occ)} / ${formatNumber(cap)}`]));
      row('Built', formatDate(b.builtDay, 'long'));
    }
    this.body.replaceChildren(...(rows.filter(Boolean) as Node[]));
  }

  dispose(): void {
    this.el.remove();
  }
}

// ============================================================================================
// Modals
// ============================================================================================

export interface ModalDeps {
  sim: ISimulation;
  game: IGameController;
  camera: ICameraRig;
  settings: UISettings;
  /** Apply + persist settings after a change made in the settings modal. */
  applySettings(): void;
  /** Current time of day (0..1) from the view, for the live slider. */
  getTimeOfDay(): number;
  setTimeOfDay(t: number): void;
  /** Open / close transitions. */
  onChange(open: boolean): void;
  notify(message: string, kind: 'info' | 'success' | 'warning' | 'error'): void;
}

interface ModalView {
  el: HTMLElement;
  /** Called while open at ~4 Hz. */
  refresh?(): void;
  /** Element to focus on open. */
  focus?: HTMLElement;
  cleanup?(): void;
}

export class ModalHost {
  readonly el: HTMLDivElement = h('div', 'vcb-modal-backdrop');
  /** Currently open modal or null. */
  current: ModalId | null = null;
  private readonly dialog: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private view: ModalView | null = null;
  private refreshT = 0;

  constructor(private readonly deps: ModalDeps) {
    this.titleEl = h('div', 'vcb-modal-title', { text: '' });
    const close = button('vcb-icon-btn vcb-close', '', 'Close (Esc)', UI_ICONS.close);
    close.addEventListener('click', () => this.close());
    this.content = h('div', 'vcb-modal-content');
    this.dialog = h('div', 'vcb-modal vcb-panel', { role: 'dialog', 'aria-modal': 'true' }, [
      h('div', 'vcb-modal-head', null, [this.titleEl, close]),
      this.content,
    ]);
    this.el.appendChild(this.dialog);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
    });
    // Keep wheel / context menu inside the dialog from doing anything odd.
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  open(id: ModalId): void {
    const wasOpen = this.current !== null;
    this.teardown();
    let view: ModalView;
    let title: string;
    try {
      switch (id) {
        case 'budget':
          title = 'Budget';
          view = this.buildBudget();
          break;
        case 'save':
        case 'load':
          title = id === 'save' ? 'Save city' : 'Load city';
          view = this.buildSaves(id);
          break;
        case 'newCity':
          title = 'New city';
          view = this.buildNewCity();
          break;
        case 'settings':
          title = 'Settings';
          view = this.buildSettings();
          break;
        case 'help':
          title = 'Help & controls';
          view = this.buildHelp();
          break;
        default:
          return;
      }
    } catch (err) {
      console.error('[ui] failed to open modal', id, err);
      if (wasOpen) this.close();
      return;
    }
    this.current = id;
    this.view = view;
    this.dialog.dataset.modal = id;
    setText(this.titleEl, title);
    this.content.replaceChildren(view.el);
    this.el.classList.add('vcb-open');
    this.refreshT = 0;
    if (!wasOpen) this.deps.onChange(true);
    const f = view.focus;
    if (f) setTimeout(() => f.focus({ preventScroll: true }), 0);
  }

  close(): void {
    if (this.current === null) return;
    this.teardown();
    this.current = null;
    this.el.classList.remove('vcb-open');
    this.content.replaceChildren();
    this.deps.onChange(false);
  }

  private teardown(): void {
    try {
      this.view?.cleanup?.();
    } catch {
      // ignore
    }
    this.view = null;
  }

  update(dt: number): void {
    if (!this.view?.refresh) return;
    this.refreshT += dt;
    if (this.refreshT < 0.25) return;
    this.refreshT = 0;
    try {
      this.view.refresh();
    } catch (err) {
      console.error('[ui] modal refresh failed', err);
    }
  }

  // ------------------------------------------------------------------ budget

  private buildBudget(): ModalView {
    const sim = this.deps.sim;
    const rates = sim.getTaxRates();
    const zones: readonly { zone: RCIZone; key: 'r' | 'c' | 'i' }[] = [
      { zone: 1, key: 'r' },
      { zone: 2, key: 'c' },
      { zone: 3, key: 'i' },
    ];
    const sliders = h('div', 'vcb-tax');
    const sliderEls: { input: HTMLInputElement; out: HTMLSpanElement; key: 'r' | 'c' | 'i' }[] = [];
    for (const z of zones) {
      const input = h('input', 'vcb-range', {
        type: 'range', min: TAX_MIN, max: TAX_MAX, step: 1, value: Math.round(rates[z.key]),
        'aria-label': `${ZONE_NAMES[z.zone]} tax rate`,
      });
      const out = h('span', 'vcb-tax-val', { text: `${Math.round(rates[z.key])}%` });
      input.addEventListener('input', () => {
        const v = Math.max(TAX_MIN, Math.min(TAX_MAX, Math.round(Number(input.value))));
        try {
          sim.setTaxRate(z.zone, v);
        } catch (err) {
          console.error('[ui] setTaxRate failed', err);
        }
        setText(out, `${v}%`);
      });
      sliderEls.push({ input, out, key: z.key });
      sliders.appendChild(
        h('label', `vcb-tax-row vcb-zone-${z.key}`, null, [
          h('span', 'vcb-tax-name', null, [h('span', 'vcb-dot'), `${ZONE_NAMES[z.zone]} tax`]),
          input,
          out,
        ]),
      );
    }

    const moneyEl = h('div', 'vcb-budget-money', { text: '' });
    const table = h('table', 'vcb-table');
    const chart = h('canvas', 'vcb-chart', { width: 560, height: 150, 'aria-label': 'Population and money history' });
    const legend = h('div', 'vcb-chart-legend', null, [
      h('span', 'vcb-leg-pop', { text: 'Population' }),
      h('span', 'vcb-leg-money', { text: 'Money' }),
    ]);

    let lastKey = '';
    let lastHist = -1;
    const refresh = (): void => {
      const st = sim.getStats();
      setText(moneyEl, `Treasury ${formatMoney(st.money)}`);
      setClass(moneyEl, 'vcb-neg', st.money < 0);
      const lm = st.lastMonth;
      const pj = st.projected;
      const key = JSON.stringify([lm, pj]);
      if (key !== lastKey) {
        lastKey = key;
        this.fillBudgetTable(table, lm, pj);
      }
      const hist = sim.getHistory();
      const hk = hist.length ? hist[hist.length - 1]!.day * 1000 + hist.length : 0;
      if (hk !== lastHist) {
        lastHist = hk;
        drawHistory(chart, hist);
      }
      // Reflect rates changed elsewhere (not while the user drags).
      const r = sim.getTaxRates();
      for (const s of sliderEls) {
        if (document.activeElement === s.input) continue;
        const v = String(Math.round(r[s.key]));
        if (s.input.value !== v) {
          s.input.value = v;
          setText(s.out, `${v}%`);
        }
      }
    };
    refresh();

    const el = h('div', 'vcb-budget', null, [
      h('div', 'vcb-budget-top', null, [moneyEl]),
      h('div', 'vcb-section-title', { text: 'Tax rates' }),
      sliders,
      h('div', 'vcb-section-title', { text: 'Monthly budget' }),
      table,
      h('div', 'vcb-section-title', { text: 'History' }),
      h('div', 'vcb-chart-wrap', null, [chart, legend]),
    ]);
    return { el, refresh, focus: sliderEls[0]?.input };
  }

  private fillBudgetTable(table: HTMLTableElement, lm: Readonly<BudgetReport> | undefined, pj: Readonly<BudgetReport> | undefined): void {
    const val = (r: Readonly<BudgetReport> | undefined, f: (r: Readonly<BudgetReport>) => number): string => {
      if (!r) return '—';
      const v = f(r);
      return Number.isFinite(v) ? formatMoney(v) : '—';
    };
    const rows: [string, (r: Readonly<BudgetReport>) => number, string][] = [
      ['Residential taxes', (r) => r.taxes.r, 'vcb-inc'],
      ['Commercial taxes', (r) => r.taxes.c, 'vcb-inc'],
      ['Industrial taxes', (r) => r.taxes.i, 'vcb-inc'],
      ['Other income', (r) => r.other, 'vcb-inc'],
      ['Total income', (r) => r.income, 'vcb-inc vcb-total'],
      ['Road upkeep', (r) => r.roadUpkeep, 'vcb-exp'],
      ['Park upkeep', (r) => r.parkUpkeep, 'vcb-exp'],
      ['Service upkeep', (r) => r.serviceUpkeep ?? 0, 'vcb-exp'],
      ['Total expenses', (r) => r.expenses, 'vcb-exp vcb-total'],
    ];
    const head = h('tr', '', null, [h('th', '', { text: '' }), h('th', '', { text: 'Last month' }), h('th', '', { text: 'Projected' })]);
    const body: HTMLTableRowElement[] = rows.map(([label, f, cls]) =>
      h('tr', cls, null, [h('td', '', { text: label }), h('td', '', { text: val(lm, f) }), h('td', '', { text: val(pj, f) })]),
    );
    const netCell = (r: Readonly<BudgetReport> | undefined): HTMLTableCellElement => {
      const n = r && Number.isFinite(r.net) ? r.net : 0;
      return h('td', n < 0 ? 'vcb-neg' : n > 0 ? 'vcb-pos' : '', { text: r ? `${n > 0 ? '+' : ''}${formatMoney(n)}` : '—' });
    };
    body.push(h('tr', 'vcb-net', null, [h('td', '', { text: 'Net' }), netCell(lm), netCell(pj)]));
    table.replaceChildren(h('thead', '', null, [head]), h('tbody', '', null, body));
  }

  // ------------------------------------------------------------------ save / load

  private buildSaves(mode: 'save' | 'load'): ModalView {
    const game = this.deps.game;
    const tabs = h('div', 'vcb-tabs', { role: 'tablist' });
    const tabSave = button('vcb-tab', 'Save', 'Save the current city');
    const tabLoad = button('vcb-tab', 'Load', 'Load a saved city');
    const tabIo = button('vcb-tab', 'Export / Import', 'Export or import a city as text');
    tabs.append(tabSave, tabLoad, tabIo);
    const pane = h('div', 'vcb-tab-pane');
    const el = h('div', 'vcb-saves', null, [tabs, pane]);
    let focus: HTMLElement | undefined;
    let cleanups: (() => void)[] = [];

    const select = (which: 'save' | 'load' | 'io'): void => {
      for (const f of cleanups) f();
      cleanups = [];
      setClass(tabSave, 'vcb-active', which === 'save');
      setClass(tabLoad, 'vcb-active', which === 'load');
      setClass(tabIo, 'vcb-active', which === 'io');
      const built = which === 'save' ? this.buildSavePane() : which === 'load' ? this.buildLoadPane() : this.buildIoPane();
      pane.replaceChildren(built.el);
      if (built.cleanup) cleanups.push(built.cleanup);
      focus = built.focus;
      return;
    };
    tabSave.addEventListener('click', () => select('save'));
    tabLoad.addEventListener('click', () => select('load'));
    tabIo.addEventListener('click', () => select('io'));
    select(mode);
    void game;
    return { el, focus, cleanup: () => cleanups.forEach((f) => f()) };
  }

  private safeList(): SaveSlotInfo[] {
    try {
      const list = this.deps.game.listSaves().slice();
      list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      return list;
    } catch (err) {
      console.error('[ui] listSaves failed', err);
      return [];
    }
  }

  private slotRow(info: SaveSlotInfo, actions: HTMLElement[]): HTMLDivElement {
    const saved = Number.isFinite(info.savedAt) && info.savedAt > 0 ? new Date(info.savedAt).toLocaleString() : '—';
    const badge = info.slot === 'autosave' ? 'Auto' : info.slot === QUICKSAVE_SLOT ? 'Quick' : info.slot;
    return h('div', 'vcb-slot', null, [
      h('div', 'vcb-slot-main', null, [
        h('div', 'vcb-slot-name', null, [h('span', '', { text: info.name || '(unnamed)' }), h('span', 'vcb-badge', { text: badge })]),
        h('div', 'vcb-slot-meta', {
          text: `${saved} · ${formatDate(info.day)} · pop ${formatNumber(info.population, true)} · ${formatMoney(info.money, true)} · ${formatBytes(info.bytes)}`,
        }),
      ]),
      h('div', 'vcb-slot-actions', null, actions),
    ]);
  }

  private buildSavePane(): ModalView {
    const game = this.deps.game;
    const nameInput = h('input', 'vcb-input', {
      type: 'text', maxlength: 32, placeholder: 'Slot name', value: slugify(this.deps.sim.name) || 'my-city',
      'aria-label': 'Save slot name', spellcheck: 'false',
    });
    const hint = h('div', 'vcb-hint', { text: '' });
    const updateHint = (): void => setText(hint, `Slot: ${slugify(nameInput.value) || '—'} (letters, digits, - and _)`);
    nameInput.addEventListener('input', updateHint);
    updateHint();
    const list = h('div', 'vcb-slot-list');

    const doSave = (slot: string): void => {
      if (game.busy) return;
      try {
        game.saveGame(slot);
      } catch (err) {
        this.deps.notify(`Save failed: ${String(err)}`, 'error');
      }
      renderList();
    };

    const saveAs = button('vcb-primary', 'Save', 'Save to this slot', UI_ICONS.save);
    saveAs.addEventListener('click', () => {
      const slot = slugify(nameInput.value);
      if (!slot) {
        this.deps.notify('Enter a slot name (letters, digits, - or _)', 'warning');
        nameInput.focus();
        return;
      }
      doSave(slot);
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveAs.click();
    });
    const quick = button('', 'Quick save', 'Save to the quick slot (F5)', UI_ICONS.save);
    quick.addEventListener('click', () => doSave(QUICKSAVE_SLOT));

    const renderList = (): void => {
      const saves = this.safeList();
      if (saves.length === 0) {
        list.replaceChildren(h('div', 'vcb-empty', { text: 'No saved cities yet.' }));
        return;
      }
      list.replaceChildren(
        ...saves.map((info) => {
          const ow = button('vcb-small', 'Overwrite', `Overwrite "${info.slot}" with the current city`, UI_ICONS.save);
          ow.addEventListener('click', () => confirmClick(ow, 'Overwrite?', () => doSave(info.slot)));
          return this.slotRow(info, [ow]);
        }),
      );
    };
    renderList();

    const el = h('div', 'vcb-pane', null, [
      h('div', 'vcb-section-title', { text: `Save "${this.deps.sim.name}"` }),
      h('div', 'vcb-form-row', null, [nameInput, saveAs, quick]),
      hint,
      h('div', 'vcb-section-title', { text: 'Existing saves' }),
      list,
    ]);
    return { el, focus: nameInput };
  }

  private buildLoadPane(): ModalView {
    const game = this.deps.game;
    const list = h('div', 'vcb-slot-list');
    const renderList = (): void => {
      const saves = this.safeList();
      if (saves.length === 0) {
        list.replaceChildren(h('div', 'vcb-empty', { text: 'No saved cities yet. Use the Save tab or F5.' }));
        return;
      }
      list.replaceChildren(
        ...saves.map((info) => {
          const load = button('vcb-small vcb-primary', 'Load', `Load "${info.name}"`, UI_ICONS.load);
          load.addEventListener('click', () => {
            if (game.busy) return;
            this.close();
            void game.loadGame(info.slot).catch((err: unknown) => console.error('[ui] load failed', err));
          });
          const del = button('vcb-small vcb-danger', '', `Delete "${info.slot}"`, UI_ICONS.trash);
          del.addEventListener('click', () =>
            confirmClick(del, 'Delete?', () => {
              try {
                game.deleteSave(info.slot);
              } catch (err) {
                console.error('[ui] delete failed', err);
              }
              renderList();
            }),
          );
          return this.slotRow(info, [load, del]);
        }),
      );
    };
    renderList();
    const el = h('div', 'vcb-pane', null, [h('div', 'vcb-section-title', { text: 'Saved cities (newest first)' }), list]);
    return { el, focus: list.querySelector<HTMLElement>('button') ?? undefined };
  }

  private buildIoPane(): ModalView {
    const game = this.deps.game;
    let objectUrl: string | null = null;

    // --- export
    const out = h('textarea', 'vcb-textarea', { readonly: true, rows: 4, spellcheck: 'false', 'aria-label': 'Exported save text', placeholder: 'Click Export to generate the save text…' });
    const exportBtn = button('vcb-primary', 'Export', 'Export the current city as text', UI_ICONS.upload);
    const copyBtn = button('', 'Copy', 'Copy to clipboard', UI_ICONS.copy);
    const dlBtn = button('', 'Download .txt', 'Download as a text file', UI_ICONS.download);
    copyBtn.disabled = dlBtn.disabled = true;
    exportBtn.addEventListener('click', () => {
      let text: string | null = null;
      try {
        text = game.exportSave();
      } catch (err) {
        console.error('[ui] export failed', err);
      }
      if (!text) {
        this.deps.notify('Export failed', 'error');
        return;
      }
      out.value = text;
      copyBtn.disabled = dlBtn.disabled = false;
    });
    copyBtn.addEventListener('click', () => {
      const text = out.value;
      if (!text) return;
      const fallback = (): void => {
        out.focus();
        out.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
        this.deps.notify(ok ? 'Copied to clipboard' : 'Select the text and copy it manually', ok ? 'success' : 'warning');
      };
      const clip = navigator.clipboard;
      if (clip && typeof clip.writeText === 'function') {
        clip.writeText(text).then(() => this.deps.notify('Copied to clipboard', 'success'), fallback);
      } else fallback();
    });
    dlBtn.addEventListener('click', () => {
      const text = out.value;
      if (!text) return;
      try {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
        const a = h('a', '', { href: objectUrl, download: `${slugify(this.deps.sim.name) || 'city'}.vcb.txt` });
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {
        this.deps.notify(`Download failed: ${String(err)}`, 'error');
      }
    });

    // --- import
    const inp = h('textarea', 'vcb-textarea', { rows: 4, spellcheck: 'false', placeholder: 'Paste exported save text here…', 'aria-label': 'Save text to import' });
    const file = h('input', 'vcb-file', { type: 'file', accept: '.txt,.json,text/plain,application/json', 'aria-label': 'Import from file' });
    const fileBtn = button('', 'From file…', 'Read a save file', UI_ICONS.load);
    fileBtn.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        inp.value = typeof reader.result === 'string' ? reader.result : '';
        importBtn.disabled = inp.value.trim() === '';
      };
      reader.onerror = () => this.deps.notify('Could not read that file', 'error');
      reader.readAsText(f);
      file.value = '';
    });
    const importBtn = button('vcb-primary', 'Import', 'Replace the current city with the imported one', UI_ICONS.download);
    importBtn.disabled = true;
    inp.addEventListener('input', () => {
      importBtn.disabled = inp.value.trim() === '';
    });
    importBtn.addEventListener('click', () => {
      const text = inp.value.trim();
      if (!text || game.busy) return;
      this.close();
      void game.importSave(text).catch((err: unknown) => console.error('[ui] import failed', err));
    });

    const el = h('div', 'vcb-pane', null, [
      h('div', 'vcb-section-title', { text: 'Export current city' }),
      out,
      h('div', 'vcb-form-row', null, [exportBtn, copyBtn, dlBtn]),
      h('div', 'vcb-section-title', { text: 'Import a city' }),
      inp,
      h('div', 'vcb-form-row', null, [fileBtn, file, h('div', 'vcb-grow'), importBtn]),
      h('div', 'vcb-hint', { text: 'Importing replaces the current city. Save it first if you want to keep it.' }),
    ]);
    return {
      el,
      focus: exportBtn,
      cleanup: () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      },
    };
  }

  // ------------------------------------------------------------------ new city

  private buildNewCity(): ModalView {
    const game = this.deps.game;
    let seed = randomSeed() >>> 0;
    let nameEdited = false;
    const nameInput = h('input', 'vcb-input', { type: 'text', maxlength: 40, value: randomCityName(seed), 'aria-label': 'City name', spellcheck: 'false' });
    const seedInput = h('input', 'vcb-input vcb-mono', { type: 'number', min: 0, max: 4294967295, step: 1, value: seed, 'aria-label': 'Terrain seed' });
    const dice = button('vcb-icon-btn', '', 'Random seed', UI_ICONS.dice);
    nameInput.addEventListener('input', () => {
      nameEdited = nameInput.value.trim() !== '';
    });
    const applySeed = (s: number): void => {
      seed = s >>> 0;
      if (!nameEdited) nameInput.value = randomCityName(seed);
    };
    dice.addEventListener('click', () => {
      applySeed(randomSeed());
      seedInput.value = String(seed);
    });
    seedInput.addEventListener('input', () => {
      const v = Number(seedInput.value);
      if (Number.isFinite(v) && v >= 0) applySeed(Math.floor(v));
    });
    const create = button('vcb-primary', 'Create city', 'Generate a new city (the current one is replaced)', UI_ICONS.newCity);
    const go = (): void => {
      if (game.busy) return;
      const name = nameInput.value.trim() || randomCityName(seed);
      this.close();
      void game.newCity({ seed, name }).catch((err: unknown) => console.error('[ui] newCity failed', err));
    };
    create.addEventListener('click', go);
    for (const i of [nameInput, seedInput]) i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    const el = h('div', 'vcb-newcity', null, [
      h('label', 'vcb-field', null, [h('span', 'vcb-field-label', { text: 'City name' }), nameInput]),
      h('label', 'vcb-field', null, [h('span', 'vcb-field-label', { text: 'Terrain seed' }), h('div', 'vcb-form-row', null, [seedInput, dice])]),
      h('div', 'vcb-hint', { text: 'The same seed always generates the same terrain. Unsaved progress in the current city is lost (the autosave keeps the last minute).' }),
      h('div', 'vcb-form-row vcb-end', null, [create]),
    ]);
    return { el, focus: nameInput };
  }

  // ------------------------------------------------------------------ settings

  private buildSettings(): ModalView {
    const s = this.deps.settings;
    const apply = (): void => this.deps.applySettings();
    const toggle = (label: string, hint: string, get: () => boolean, set: (v: boolean) => void): { row: HTMLElement; input: HTMLInputElement } => {
      const input = h('input', 'vcb-switch', { type: 'checkbox', role: 'switch', 'aria-label': label });
      input.checked = get();
      input.addEventListener('change', () => {
        set(input.checked);
        apply();
      });
      const row = h('label', 'vcb-setting', null, [
        h('span', 'vcb-setting-text', null, [h('span', 'vcb-setting-name', { text: label }), h('span', 'vcb-setting-hint', { text: hint })]),
        input,
      ]);
      return { row, input };
    };

    const shadows = toggle('Shadows', 'Sun shadows (turn off for speed)', () => s.shadows, (v) => (s.shadows = v));
    const auto = toggle('Day / night cycle', 'Time of day advances automatically', () => s.autoTime, (v) => (s.autoTime = v));
    const timeOut = h('span', 'vcb-mono vcb-time', { text: '' });
    const time = h('input', 'vcb-range', { type: 'range', min: 0, max: 1, step: 0.001, value: this.deps.getTimeOfDay(), 'aria-label': 'Time of day' });
    const showTime = (t: number): void => setText(timeOut, clock(t));
    showTime(Number(time.value));
    time.addEventListener('input', () => {
      const t = Number(time.value);
      if (s.autoTime) {
        s.autoTime = false;
        auto.input.checked = false;
      }
      s.timeOfDay = t;
      this.deps.setTimeOfDay(t);
      showTime(t);
    });
    time.addEventListener('change', apply);
    const grid = toggle('Grid', 'Tile grid near the cursor (G)', () => s.grid, (v) => (s.grid = v));
    const fx = toggle('Traffic & particles', 'Cars, smoke and fountains', () => s.fx, (v) => (s.fx = v));
    const mute = toggle('Mute sound', 'Silence all sound effects', () => s.muted, (v) => (s.muted = v));
    const volOut = h('span', 'vcb-mono vcb-time', { text: formatPercent(s.volume) });
    const vol = h('input', 'vcb-range', { type: 'range', min: 0, max: 1, step: 0.01, value: s.volume, 'aria-label': 'Sound volume' });
    vol.addEventListener('input', () => {
      s.volume = Number(vol.value);
      setText(volOut, formatPercent(s.volume));
      apply();
    });
    const resetCam = button('', 'Reset camera', 'Move the camera back to the map centre (Home)', UI_ICONS.target);
    resetCam.addEventListener('click', () => {
      try {
        this.deps.camera.reset();
      } catch (err) {
        console.error('[ui] camera reset failed', err);
      }
    });
    const tips = button('', 'Show tips again', 'Show the "Getting started" card for the next new city');
    tips.addEventListener('click', () => {
      s.onboardingDone = false;
      apply();
      this.deps.notify('Tips will show again for your next new city', 'info');
    });

    const el = h('div', 'vcb-settings', null, [
      h('div', 'vcb-section-title', { text: 'Graphics' }),
      shadows.row,
      fx.row,
      grid.row,
      h('div', 'vcb-section-title', { text: 'Time of day' }),
      auto.row,
      h('label', 'vcb-setting', null, [h('span', 'vcb-setting-name', { text: 'Time' }), time, timeOut]),
      h('div', 'vcb-section-title', { text: 'Sound' }),
      h('label', 'vcb-setting', null, [h('span', 'vcb-setting-name', { text: 'Volume' }), vol, volOut]),
      mute.row,
      h('div', 'vcb-form-row vcb-end', null, [tips, resetCam]),
    ]);
    const refresh = (): void => {
      // Follow external changes (G hotkey, M mute, automatic time).
      if (grid.input.checked !== s.grid) grid.input.checked = s.grid;
      if (mute.input.checked !== s.muted) mute.input.checked = s.muted;
      if (auto.input.checked !== s.autoTime) auto.input.checked = s.autoTime;
      if (document.activeElement !== vol && Math.abs(Number(vol.value) - s.volume) > 0.005) {
        vol.value = String(s.volume);
        setText(volOut, formatPercent(s.volume));
      }
      if (s.autoTime && document.activeElement !== time) {
        const t = this.deps.getTimeOfDay();
        time.value = String(t);
        showTime(t);
      }
    };
    return { el, refresh, focus: shadows.input };
  }

  // ------------------------------------------------------------------ help

  private buildHelp(): ModalView {
    const keys = (action: keyof typeof KEYMAP): HTMLElement =>
      h('span', 'vcb-keys', null, KEYMAP[action].map((c) => h('kbd', '', { text: keyName(c) })));
    const group = (title: string, rows: [string, HTMLElement | string][]): HTMLElement =>
      h('div', 'vcb-help-group', null, [
        h('div', 'vcb-section-title', { text: title }),
        ...rows.map(([label, k]) => h('div', 'vcb-help-row', null, [h('span', '', { text: label }), typeof k === 'string' ? h('span', 'vcb-keys', { text: k }) : k])),
      ]);
    const mouse = (s: string): HTMLElement => h('span', 'vcb-keys', null, [h('kbd', '', { text: s })]);

    const el = h('div', 'vcb-help', null, [
      h('div', 'vcb-help-cols', null, [
        group('Camera', [
          ['Pan', h('span', 'vcb-keys', null, [...KEYMAP.panForward, ...KEYMAP.panLeft, ...KEYMAP.panBack, ...KEYMAP.panRight].filter((c) => c.startsWith('Key')).map((c) => h('kbd', '', { text: keyName(c) })))],
          ['Pan (arrows)', h('span', 'vcb-keys', null, ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].map((c) => h('kbd', '', { text: keyName(c) })))],
          ['Rotate', h('span', 'vcb-keys', null, [...KEYMAP.rotateLeft, ...KEYMAP.rotateRight].map((c) => h('kbd', '', { text: keyName(c) })))],
          ['Tilt', h('span', 'vcb-keys', null, [...KEYMAP.tiltUp, ...KEYMAP.tiltDown].map((c) => h('kbd', '', { text: keyName(c) })))],
          ['Zoom in', keys('zoomIn')],
          ['Zoom out', keys('zoomOut')],
          ['Reset view', keys('resetView')],
          ['Orbit', mouse('Right-drag')],
          ['Pan', h('span', 'vcb-keys', null, [h('kbd', '', { text: 'Middle-drag' }), h('kbd', '', { text: 'Shift+Right-drag' })])],
          ['Zoom', mouse('Wheel')],
        ]),
        group('Tools', [
          ['Inspect', keys('toolSelect')],
          ['Road', keys('toolRoad')],
          ['Residential', keys('toolResidential')],
          ['Commercial', keys('toolCommercial')],
          ['Industrial', keys('toolIndustrial')],
          ['Park', keys('toolPark')],
          ['Bulldoze', keys('toolBulldoze')],
          ['Civic services (cycle)', keys('toolCivic')],
          ['Use tool', mouse('Left-click / drag')],
          ['Straight road', mouse('Shift')],
          ['Cancel / back to Inspect', keys('cancel')],
        ]),
        group('Game', [
          ['Pause / resume', keys('togglePause')],
          ['Slower', keys('slower')],
          ['Faster', keys('faster')],
          ['Quick save', keys('quickSave')],
          ['Quick load', keys('quickLoad')],
          ['Toggle grid', keys('toggleGrid')],
          ['Cycle data overlay', keys('cycleOverlay')],
          ['Help', keys('toggleHelp')],
          ['Debug overlay', keys('toggleDebug')],
        ]),
      ]),
      h('div', 'vcb-section-title', { text: 'Tips' }),
      h('ul', 'vcb-tips', null, [
        h('li', '', { text: 'Start from the highway at the west edge: drag roads (2) into the land.' }),
        h('li', '', { text: `Zone Residential (3), Commercial (4) and Industrial (5) within ${3} tiles of a road; buildings grow by themselves.` }),
        h('li', '', { text: 'Watch the RCI bars in the top bar: zone what is in demand (bars pointing up).' }),
        h('li', '', { text: 'Keep industry away from homes: pollution lowers land value. Parks raise it.' }),
        h('li', '', { text: 'Place civic services (8) next to roads: police, fire, schools and hospitals cover the tiles around them; growing districts need them.' }),
        h('li', '', { text: 'Keep the monthly net positive. Taxes above ~12% slow growth; check the Budget.' }),
      ]),
    ]);
    return { el };
  }

  dispose(): void {
    this.teardown();
    this.el.remove();
  }
}

// ============================================================================================
// helpers
// ============================================================================================

/** City / slot name → slot id matching [a-z0-9_-]{1,32}. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

/** 0..1 time of day → "HH:MM". */
function clock(t: number): string {
  const mins = Math.round((((t % 1) + 1) % 1) * 24 * 60) % (24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** Two-step inline confirm: first click arms the button for 3 s, second click runs. */
function confirmClick(btn: HTMLButtonElement, armedLabel: string, run: () => void): void {
  if (btn.dataset.armed === '1') {
    btn.dataset.armed = '';
    run();
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('vcb-armed');
  const label = btn.querySelector('.vcb-btn-label');
  const prev = label ? label.textContent : null;
  if (label) label.textContent = armedLabel;
  else btn.appendChild(h('span', 'vcb-btn-label vcb-armed-label', { text: armedLabel }));
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.dataset.armed = '';
    btn.classList.remove('vcb-armed');
    if (label) label.textContent = prev;
    else btn.querySelector('.vcb-armed-label')?.remove();
  }, 3000);
}

/** Population + money history sparkline (two independent scales). */
function drawHistory(canvas: HTMLCanvasElement, hist: ReadonlyArray<{ day: number; population: number; money: number }>): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = 560;
  const cssH = 150;
  if (canvas.width !== cssW * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const padL = 8, padR = 8, padT = 18, padB = 18;
  const w = cssW - padL - padR;
  const hh = cssH - padT - padB;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(padT + (hh * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + w, y);
    ctx.stroke();
  }
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(238,242,247,0.55)';
  if (hist.length < 2) {
    ctx.textAlign = 'center';
    ctx.fillText('History appears after a couple of months', cssW / 2, cssH / 2 + 4);
    return;
  }
  const series = (get: (s: { population: number; money: number }) => number, color: string, label: (v: number) => string, labelRight: boolean): void => {
    let lo = Infinity, hi = -Infinity;
    for (const s of hist) {
      const v = get(s);
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) return;
    if (hi - lo < 1e-6) {
      hi += 1;
      lo -= 1;
    }
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const v = get(hist[i]!);
      const x = padL + (w * i) / (hist.length - 1);
      const y = padT + hh - ((v - lo) / (hi - lo)) * hh;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = labelRight ? 'right' : 'left';
    ctx.fillText(`${label(hi)}`, labelRight ? cssW - padR : padL, 12);
    ctx.fillText(`${label(lo)}`, labelRight ? cssW - padR : padL, cssH - 4);
  };
  series((s) => s.population, '#5fd17a', (v) => formatNumber(v, true), false);
  series((s) => s.money, '#ffb547', (v) => formatMoney(v, true), true);
  ctx.fillStyle = 'rgba(238,242,247,0.45)';
  ctx.textAlign = 'center';
  ctx.fillText(`${formatDate(hist[0]!.day)} – ${formatDate(hist[hist.length - 1]!.day)}`, cssW / 2, 12);
}

/** Readable ground name for a block id (e.g. GRASS_DARK → "Grass dark"). */
export function groundNameOf(id: number): string {
  return humanize(blockName(id));
}
