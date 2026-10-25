/**
 * MODULE: ui — inline SVG icon strings (module-internal API; may change).
 * Owner: ui agent. STUB. Intended: 20–24 px stroke icons for tools, speed, menu buttons.
 */
import type { ToolId } from '../types';

export const TOOL_ICONS: Record<ToolId, string> = {
  select: '',
  road: '',
  zone_r: '',
  zone_c: '',
  zone_i: '',
  park: '',
  bulldoze: '',
  civic_town_hall: '',
  civic_police: '',
  civic_fire: '',
  civic_school: '',
  civic_hospital: '',
};

export const UI_ICONS: Record<string, string> = {};
