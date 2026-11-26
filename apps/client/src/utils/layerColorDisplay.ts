import {
  hexToRgb01,
  normalizeHexColor,
  normalizeLayerColorMeta,
  type LayerColorMeta,
  type PaletteColorDisplayMode,
} from '@atelier/shared';

export interface LayerColorPreferences {
  paletteColorMode: PaletteColorDisplayMode;
  localPaletteColors: Record<string, string | null>;
  localLayerColors: Record<string, LayerColorMeta | null>;
  paperVisible: boolean;
  localPaperColor: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readOverrides<T>(value: unknown, normalize: (entry: unknown) => T | null): Record<string, T | null> {
  const entries: [string, T | null][] = [];
  for (const [id, entry] of Object.entries(asRecord(value))) {
    const valid = normalize(entry);
    if (entry === null || valid !== null) entries.push([id, valid]);
  }
  return Object.fromEntries(entries);
}

export function readLayerColorPreferences(isOffline: boolean, json: string | null = null): LayerColorPreferences {
  let saved: Record<string, unknown> = {};
  try { saved = asRecord(json ? JSON.parse(json) : null); } catch { /* Ignore invalid stored JSON. */ }
  const mode = saved.paletteColorMode;
  return {
    paletteColorMode: mode === 'shared' || mode === 'personal' || mode === 'owner' ? mode : isOffline ? 'shared' : 'personal',
    localPaletteColors: readOverrides(saved.localPaletteColors, normalizeHexColor),
    localLayerColors: readOverrides(saved.localLayerColors, normalizeLayerColorMeta),
    paperVisible: typeof saved.paperVisible === 'boolean' ? saved.paperVisible : true,
    localPaperColor: normalizeHexColor(saved.localPaperColor),
  };
}

export function updateColorOverrides<T>(
  overrides: Record<string, T | null>, ids: readonly string[], value: T | null | undefined,
): Record<string, T | null> {
  if (value !== undefined) return { ...overrides, ...Object.fromEntries(ids.map((id) => [id, value])) };
  const next = { ...overrides };
  for (const id of ids) delete next[id];
  return next;
}

export function getEffectivePaperColor(canvasColor: string | undefined, localColor: string | null, isOffline: boolean): string {
  return (!isOffline && localColor) || canvasColor || '#FFFFFF';
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = hexToRgb01(hex).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

const DARK_FOREGROUND = '#171717';
const LIGHT_FOREGROUND = '#F5F5F5';
const CONTRAST_THRESHOLD = Math.sqrt((relativeLuminance(DARK_FOREGROUND) + 0.05) * (relativeLuminance(LIGHT_FOREGROUND) + 0.05));

export function getPaletteContrastColor(background: string): string {
  return relativeLuminance(background) + 0.05 >= CONTRAST_THRESHOLD ? DARK_FOREGROUND : LIGHT_FOREGROUND;
}
