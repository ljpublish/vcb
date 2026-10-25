/**
 * MODULE: ui — top bar HUD (module-internal API; the ui agent may change it).
 * Owner: ui agent.
 *
 * City name + date, money (red when negative, green/red flash on change, projected monthly net),
 * population, jobs, happiness, RCI demand bars (−1..1, centred), speed buttons and menu buttons.
 * setStats() is called by GameUI at ≤ 10 Hz; it compares copied numbers and writes only what changed.
 */
import type { CityStats, SimSpeed } from '../types';
import { formatDate, formatMoney, formatNumber, formatPercent } from '../core/util';
import { button, h, setClass, setText } from './dom';
import { UI_ICONS } from './icons';
import type { ModalId } from './panels';

export interface HudCallbacks {
  onSpeed(speed: SimSpeed): void;
  onMenu(id: ModalId): void;
}

const SPEED_DEFS: readonly { speed: SimSpeed; icon: string; title: string }[] = [
  { speed: 0, icon: UI_ICONS.pause, title: 'Pause (Space)' },
  { speed: 1, icon: UI_ICONS.play1, title: 'Normal speed' },
  { speed: 2, icon: UI_ICONS.play2, title: 'Fast' },
  { speed: 3, icon: UI_ICONS.play3, title: 'Ultra fast' },
];

const MENU_DEFS: readonly { id: ModalId; label: string; icon: string; title: string }[] = [
  { id: 'budget', label: 'Budget', icon: UI_ICONS.budget, title: 'Budget and taxes' },
  { id: 'save', label: 'Save', icon: UI_ICONS.save, title: 'Save city (F5 = quick save)' },
  { id: 'load', label: 'Load', icon: UI_ICONS.load, title: 'Load / import a city (F9 = quick load)' },
  { id: 'newCity', label: 'New', icon: UI_ICONS.newCity, title: 'New city' },
  { id: 'settings', label: '', icon: UI_ICONS.settings, title: 'Settings' },
  { id: 'help', label: '', icon: UI_ICONS.help, title: 'Help and controls (H)' },
];

interface DemandBar {
  fill: HTMLDivElement;
  value: number;
}

export class Hud {
  readonly el: HTMLDivElement = h('div', 'vcb-hud vcb-panel');
  private readonly nameEl: HTMLDivElement;
  private readonly dateEl: HTMLDivElement;
  private readonly moneyEl: HTMLSpanElement;
  private readonly netEl: HTMLSpanElement;
  private readonly popEl: HTMLSpanElement;
  private readonly jobsEl: HTMLSpanElement;
  private readonly happyEl: HTMLSpanElement;
  private readonly savedEl: HTMLSpanElement;
  private readonly bars: DemandBar[] = [];
  private readonly speedBtns: HTMLButtonElement[] = [];
  private readonly demandEl: HTMLDivElement;

  // Copies of the last written values (the sim may mutate its stats object in place).
  private lastName = '';
  private lastDay = -1;
  private lastMoney = Number.NaN;
  private lastNet = Number.NaN;
  private lastPop = -1;
  private lastJobs = -1;
  private lastEmployed = -1;
  private lastHappy = -1;
  private speed: SimSpeed | -1 = -1;
  private savedTimer = 0;

  constructor(cb: HudCallbacks) {
    this.nameEl = h('div', 'vcb-hud-name', { text: '—' });
    this.dateEl = h('div', 'vcb-hud-date', { text: '' });
    const city = h('div', 'vcb-hud-city', null, [this.nameEl, this.dateEl]);

    this.moneyEl = h('span', 'vcb-hud-value vcb-money', { text: '$0' });
    this.netEl = h('span', 'vcb-hud-sub', { text: '' });
    const money = this.stat('vcb-hud-money', UI_ICONS.coins, 'Treasury (projected monthly net below)', this.moneyEl, this.netEl);

    this.popEl = h('span', 'vcb-hud-value', { text: '0' });
    const pop = this.stat('', UI_ICONS.people, 'Population', this.popEl, h('span', 'vcb-hud-sub', { text: 'Population' }));

    this.jobsEl = h('span', 'vcb-hud-value', { text: '0' });
    const jobsSub = h('span', 'vcb-hud-sub', { text: 'Jobs' });
    const jobs = this.stat('', UI_ICONS.briefcase, 'Jobs (employed / total)', this.jobsEl, jobsSub);

    this.happyEl = h('span', 'vcb-hud-value', { text: '—' });
    const happy = this.stat('vcb-hud-happy', UI_ICONS.smile, 'Citizen approval', this.happyEl, h('span', 'vcb-hud-sub', { text: 'Approval' }));

    this.demandEl = h('div', 'vcb-rci', { title: 'RCI demand: up = wants to grow, down = oversupplied' });
    for (const [key, label] of [['r', 'R'], ['c', 'C'], ['i', 'I']] as const) {
      const fill = h('div', 'vcb-rci-fill');
      this.demandEl.appendChild(
        h('div', `vcb-rci-col vcb-rci-${key}`, null, [
          h('div', 'vcb-rci-track', null, [fill, h('div', 'vcb-rci-mid')]),
          h('div', 'vcb-rci-label', { text: label }),
        ]),
      );
      this.bars.push({ fill, value: Number.NaN });
    }

    const speeds = h('div', 'vcb-speed', { role: 'group', 'aria-label': 'Simulation speed' });
    for (const def of SPEED_DEFS) {
      const b = button('vcb-icon-btn', '', def.title, def.icon);
      b.addEventListener('click', () => cb.onSpeed(def.speed));
      speeds.appendChild(b);
      this.speedBtns.push(b);
    }

    this.savedEl = h('span', 'vcb-hud-saved', { text: 'Saved' });

    const menu = h('div', 'vcb-menu');
    for (const def of MENU_DEFS) {
      const b = button(def.label ? '' : 'vcb-icon-btn', def.label, def.title, def.icon);
      b.addEventListener('click', () => cb.onMenu(def.id));
      menu.appendChild(b);
    }

    this.el.append(
      city,
      h('div', 'vcb-hud-sep'),
      money,
      pop,
      jobs,
      happy,
      h('div', 'vcb-hud-sep'),
      this.demandEl,
      h('div', 'vcb-hud-sep'),
      speeds,
      h('div', 'vcb-hud-spacer'),
      this.savedEl,
      menu,
    );
  }

  private stat(cls: string, icon: string, title: string, value: HTMLElement, sub: HTMLElement): HTMLDivElement {
    return h('div', `vcb-hud-stat ${cls}`.trim(), { title }, [
      h('span', 'vcb-ico', { html: icon, 'aria-hidden': 'true' }),
      h('div', 'vcb-hud-stack', null, [value, sub]),
    ]);
  }

  setStats(stats: Readonly<CityStats>, cityName: string): void {
    if (cityName !== this.lastName) {
      this.lastName = cityName;
      setText(this.nameEl, cityName || '—');
    }
    const day = stats.day | 0;
    if (day !== this.lastDay) {
      this.lastDay = day;
      setText(this.dateEl, formatDate(day, 'long'));
    }

    const money = Math.round(stats.money);
    if (money !== this.lastMoney) {
      const prev = this.lastMoney;
      this.lastMoney = money;
      setText(this.moneyEl, formatMoney(money));
      setClass(this.moneyEl, 'vcb-neg', money < 0);
      if (Number.isFinite(prev)) this.flash(money > prev);
    }
    const net = Math.round(stats.projected ? stats.projected.net : 0);
    if (net !== this.lastNet) {
      this.lastNet = net;
      setText(this.netEl, `${net >= 0 ? '+' : ''}${formatMoney(net, true)}/mo`);
      setClass(this.netEl, 'vcb-neg', net < 0);
      setClass(this.netEl, 'vcb-pos', net > 0);
    }

    const pop = Math.round(stats.population);
    if (pop !== this.lastPop) {
      this.lastPop = pop;
      setText(this.popEl, formatNumber(pop, true));
    }
    const jobs = Math.round(stats.jobsTotal);
    const employed = Math.round(stats.employed);
    if (jobs !== this.lastJobs || employed !== this.lastEmployed) {
      this.lastJobs = jobs;
      this.lastEmployed = employed;
      setText(this.jobsEl, `${formatNumber(employed, true)} / ${formatNumber(jobs, true)}`);
    }
    const happy = Math.round((stats.happiness || 0) * 100);
    if (happy !== this.lastHappy) {
      this.lastHappy = happy;
      setText(this.happyEl, pop > 0 ? formatPercent(happy / 100) : '—');
      setClass(this.happyEl, 'vcb-neg', pop > 0 && happy < 40);
      setClass(this.happyEl, 'vcb-pos', pop > 0 && happy >= 70);
    }

    const d = stats.demand;
    if (d) {
      this.setBar(0, d.r);
      this.setBar(1, d.c);
      this.setBar(2, d.i);
    }
  }

  private setBar(i: number, raw: number): void {
    const bar = this.bars[i]!;
    const v = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    const q = Math.round(v * 50) / 50;
    if (q === bar.value) return;
    bar.value = q;
    // Fill is anchored at the centre line; negative scale flips it downwards.
    bar.fill.style.transform = `scaleY(${q === 0 ? 0.02 : q})`;
    setClass(bar.fill, 'vcb-rci-neg', q < 0);
  }

  private flash(up: boolean): void {
    if (typeof this.moneyEl.animate !== 'function') return;
    this.moneyEl.animate(
      [{ color: up ? 'var(--vcb-good)' : 'var(--vcb-bad)', textShadow: '0 0 8px currentColor' }, {}],
      { duration: 700, easing: 'ease-out' },
    );
  }

  setSpeed(speed: SimSpeed): void {
    if (speed === this.speed) return;
    this.speed = speed;
    for (let i = 0; i < this.speedBtns.length; i++) {
      const on = SPEED_DEFS[i]!.speed === speed;
      setClass(this.speedBtns[i]!, 'vcb-active', on);
      this.speedBtns[i]!.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    setClass(this.el, 'vcb-paused', speed === 0);
  }

  /** Brief "Saved" / "Autosaved" indicator. */
  flashSaved(auto: boolean): void {
    setText(this.savedEl, auto ? 'Autosaved' : 'Saved');
    this.savedEl.classList.add('vcb-show');
    clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => this.savedEl.classList.remove('vcb-show'), 1800);
  }

  dispose(): void {
    clearTimeout(this.savedTimer);
    this.el.remove();
  }
}
