/**
 * MODULE: ui — inline SVG icon strings (module-internal API; may change).
 * Owner: ui agent. 24×24 viewBox stroke icons drawn in currentColor, rendered at 20 px.
 */
import type { ToolId } from '../types';

function svg(body: string, extra = ''): string {
  return (
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" focusable="false" ${extra}>${body}</svg>`
  );
}

export const TOOL_ICONS: Record<ToolId, string> = {
  select: svg('<path d="M5 3l14 8-6 1.6L9.6 19z" fill="currentColor" fill-opacity=".18"/>'),
  road: svg(
    '<path d="M8 3L4 21M16 3l4 18"/><path d="M12 4v3M12 10.5v3M12 17v3" stroke-width="1.8"/>',
  ),
  zone_r: svg(
    '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5" fill="currentColor" fill-opacity=".25"/>',
  ),
  zone_c: svg(
    '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v0a2.7 2.7 0 01-5.3 0 2.7 2.7 0 01-5.4 0A2.7 2.7 0 014 9z"/>' +
      '<path d="M5.5 12v8h13v-8"/><path d="M10 20v-4h4v4"/>',
  ),
  zone_i: svg(
    '<path d="M3 20V11l5 3v-3l5 3V6h3v-2h3v16z" fill="currentColor" fill-opacity=".18"/><path d="M3 20h18"/>' +
      '<path d="M7 17h2M12 17h2"/>',
  ),
  park: svg(
    '<path d="M12 3c3.5 0 5.5 2.6 5.5 5.5 0 1-.3 2-.8 2.8A3.8 3.8 0 0115 18H9a3.8 3.8 0 01-1.7-6.7A5.4 5.4 0 016.5 8.5C6.5 5.6 8.5 3 12 3z" fill="currentColor" fill-opacity=".2"/>' +
      '<path d="M12 10v11M9.5 14l2.5 2 2.5-2.5"/>',
  ),
  bulldoze: svg(
    '<path d="M3 17h11v-5H9l-2-4H4v9"/><path d="M14 13h3l3-4"/><path d="M17 9l3 8"/>' +
      '<circle cx="6" cy="19" r="1.6"/><circle cx="11" cy="19" r="1.6"/>',
  ),
  civic_town_hall: svg(
    '<path d="M3 9l9-5 9 5z" fill="currentColor" fill-opacity=".2"/><path d="M3 9h18M5 9v9M9.5 9v9M14.5 9v9M19 9v9"/>' +
      '<path d="M3 20h18M4 18h16"/>',
  ),
  civic_police: svg(
    '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" fill="currentColor" fill-opacity=".18"/>' +
      '<path d="M12 8.2l1.2 2.5 2.7.3-2 1.9.5 2.7L12 14.3l-2.4 1.3.5-2.7-2-1.9 2.7-.3z" fill="currentColor" stroke-width="1"/>',
  ),
  civic_fire: svg(
    '<path d="M12 3c.6 3.2 4.8 5.2 4.8 10a4.8 4.8 0 01-9.6 0c0-2.3 1.2-3.7 2.3-4.8.2 1.6.9 2.6 1.9 3.1C11 9 11.2 5.6 12 3z" fill="currentColor" fill-opacity=".22"/>' +
      '<path d="M12 21a2.3 2.3 0 01-2.3-2.3c0-1.5 1.4-2.4 2.3-3.9.9 1.5 2.3 2.4 2.3 3.9A2.3 2.3 0 0112 21z"/>',
  ),
  civic_school: svg(
    '<path d="M2 9l10-5 10 5-10 5z" fill="currentColor" fill-opacity=".2"/><path d="M6 11v5c0 1.4 2.7 3 6 3s6-1.6 6-3v-5"/>' +
      '<path d="M22 9v6"/>',
  ),
  civic_hospital: svg(
    '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M12 7.5v9M7.5 12h9" stroke-width="3"/>',
  ),
};

export const UI_ICONS = {
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>', 'stroke-width="0"'),
  play1: svg('<path d="M8 5l11 7-11 7z" fill="currentColor"/>', 'stroke-width="0"'),
  play2: svg('<path d="M3 5l9 7-9 7zM12 5l9 7-9 7z" fill="currentColor"/>', 'stroke-width="0"'),
  play3: svg('<path d="M1 5l7.5 7L1 19zM8.5 5l7.5 7-7.5 7zM16 5l7 7-7 7z" fill="currentColor"/>', 'stroke-width="0"'),
  budget: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M16 15h2"/>'),
  save: svg('<path d="M5 3h11l4 4v12a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 011-2z"/><path d="M8 3v5h7V3"/><rect x="7.5" y="13" width="9" height="6" rx="1"/>'),
  load: svg('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M12 10v6M9 13l3 3 3-3"/>'),
  newCity: svg('<path d="M4 20V10l4-3 4 3v10"/><path d="M12 20V6l4-2 4 2v14"/><path d="M2 20h20"/><path d="M7 13h2M15 9h2M15 13h2"/>'),
  settings: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  ),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.7-2.5 2-2.5 3.5"/><path d="M12 17h.01" stroke-width="2.6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  people: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0112 0"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2A5 5 0 0121 19"/>'),
  briefcase: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"/><path d="M3 13h18"/>'),
  coins: svg('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>'),
  smile: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 007 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.6"/>'),
  grid: svg('<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  ovNone: svg('<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>'),
  ovLand: svg('<path d="M12 3v18"/><path d="M16.5 7H10a2.5 2.5 0 000 5h4a2.5 2.5 0 010 5H7"/>'),
  ovPollution: svg('<path d="M4 15a4 4 0 014-4 5 5 0 019.6-1.5A3.5 3.5 0 0117 16.5H7"/><path d="M6 20h4M13 20h5"/>'),
  ovAccess: svg('<path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/><path d="M2 21h20"/>'),
  target: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  dice: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01" stroke-width="2.8"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 20h16"/>'),
  upload: svg('<path d="M12 20V9M7 14l5-5 5 5"/><path d="M4 4h16"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5h.01" stroke-width="2.6"/>'),
  success: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>'),
  warning: svg('<path d="M12 3l10 18H2z"/><path d="M12 10v5"/><path d="M12 18h.01" stroke-width="2.6"/>'),
  error: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  lightbulb: svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>'),
} as const;

export type UIIconName = keyof typeof UI_ICONS;
