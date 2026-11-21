/**
 * Filter Library (濾鏡庫): original Lumina Drift filter+parameter showcase cards, thumbnail
 * parameter scaling, and personal favorite cards stored in localStorage.
 * Kept pure (no DOM) so ui-logic.check.ts can verify every card, scaling rule, and storage flow.
 */
import type { FilterValues } from '@atelier/shared';
import type { Translations } from '../locales';
import { getFilter, normalizeFilterValues, type FilterDef } from './filterRegistry';

export type LibraryCardKey = keyof Translations['filters']['libraryCards'];

export interface BuiltinLibraryCard {
  id: LibraryCardKey;
  filterId: string;
  values: FilterValues;
}

export interface FavoriteFilterCard {
  id: string;
  name: string;
  filterId: string;
  values: FilterValues;
  createdAt: number;
}

/** 12 original Lumina Drift curated filter+parameter cards (no third-party preset lists copied) */
export const BUILTIN_LIBRARY_CARDS: readonly BuiltinLibraryCard[] = [
  { id: 'softGlow', filterId: 'glow', values: { radius: 18, strength: 110, threshold: 145 } },
  { id: 'retroMono', filterId: 'monoTint', values: { color: '#8c6244', strength: 90, preserveLuma: true } },
  { id: 'mangaTone', filterId: 'halftone', values: { density: 56, angle: 45, dotSize: 0.9 } },
  { id: 'prismSplit', filterId: 'chromatic', values: { mode: 'radial', spread: 14 } },
  { id: 'inkSketch', filterId: 'edgeToLineart', values: { sensitivity: 58, thickness: 1, keepColor: false, whiteBg: true } },
  { id: 'pixelBlock', filterId: 'mosaic', values: { cell: 16 } },
  { id: 'stoneRelief', filterId: 'emboss', values: { angle: 135, height: 2, amount: 150, keepColor: false } },
  { id: 'dreamBlur', filterId: 'gaussian', values: { radius: 6 } },
  { id: 'posterPop', filterId: 'posterize', values: { levels: 5 } },
  { id: 'speedFocus', filterId: 'focusLines', values: { density: 64, lineWidth: 3, innerRadius: 32, jitter: 45, color: '#111111' } },
  { id: 'filmGrain', filterId: 'noise', values: { amount: 30, grain: 2 } },
  { id: 'crispDetail', filterId: 'unsharp', values: { radius: 2, amount: 140, threshold: 4 } },
];

const FAVORITES_KEY = 'atelier_filter_favorites_v1';
const MAX_FAVORITES = 32;

/** Parameter keys measured in canvas pixels that should shrink proportionally for small thumbnails */
const THUMB_PIXEL_KEYS = new Set([
  'radius', 'cell', 'spread', 'size', 'offsetX', 'offsetY', 'distance',
  'amplitude', 'wavelength', 'scale', 'height', 'lineWidth', 'grain', 'amount',
]);

/**
 * Scales pixel-unit parameters from full canvas size down to thumbnail size so a 96px preview
 * accurately conveys the look of the filter instead of blowing out at full canvas pixel radii.
 */
export function scaleFilterValuesForThumbnail(
  def: FilterDef,
  values: FilterValues,
  origWidth: number,
  origHeight: number,
  thumbWidth: number,
  thumbHeight: number,
): FilterValues {
  const ratio = Math.min(1, Math.max(thumbWidth / Math.max(1, origWidth), thumbHeight / Math.max(1, origHeight)));
  const scaled: FilterValues = { ...values };
  // Never scale percentage `amount` (only pixel-unit `lineWidth.amount` is pixel-based)
  const isPixelAmount = def.id === 'lineWidth';
  for (const param of def.params) {
    if (param.kind === 'point') {
      const pt = values[param.key] as { x?: number; y?: number } | undefined;
      if (pt && typeof pt.x === 'number' && typeof pt.y === 'number') {
        scaled[param.key] = { x: pt.x * (thumbWidth / Math.max(1, origWidth)), y: pt.y * (thumbHeight / Math.max(1, origHeight)) };
      } else {
        scaled[param.key] = { x: thumbWidth / 2, y: thumbHeight / 2 };
      }
      continue;
    }
    if (param.kind !== 'range') continue;
    if (!THUMB_PIXEL_KEYS.has(param.key)) continue;
    if (param.key === 'amount' && !isPixelAmount) continue;
    const raw = typeof values[param.key] === 'number' ? (values[param.key] as number) : param.initial;
    const next = raw * ratio;
    // Keep visible effect on tiny thumbnails without collapsing non-zero radii to 0
    const floor = param.min > 0 ? param.min : raw > 0 ? 1 : raw < 0 ? -1 : 0;
    scaled[param.key] = raw === 0 ? 0 : (raw > 0 ? Math.max(floor, Math.round(next)) : Math.min(floor, Math.round(next)));
  }
  return scaled;
}

export function parseFavoriteCards(raw: unknown): FavoriteFilterCard[] {
  if (!Array.isArray(raw)) return [];
  const out: FavoriteFilterCard[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Partial<FavoriteFilterCard>;
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.filterId !== 'string') continue;
    const def = getFilter(item.filterId);
    if (!def || def.tool || def.dialog) continue;
    const name = item.name.trim().slice(0, 40);
    if (!name) continue;
    out.push({
      id: item.id,
      name,
      filterId: def.id,
      values: normalizeFilterValues(def, item.values),
      createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
    });
    if (out.length >= MAX_FAVORITES) break;
  }
  return out;
}

export function loadFavoriteFilters(): FavoriteFilterCard[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    return parseFavoriteCards(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveFavoriteFilters(cards: readonly FavoriteFilterCard[]): boolean {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(cards.slice(0, MAX_FAVORITES)));
    return true;
  } catch {
    return false;
  }
}

export function createFavoriteCard(name: string, filterId: string, values: FilterValues): FavoriteFilterCard | null {
  const def = getFilter(filterId);
  const clean = name.trim().slice(0, 40);
  if (!def || def.tool || def.dialog || !clean) return null;
  return {
    id: `fav_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: clean,
    filterId: def.id,
    values: normalizeFilterValues(def, values),
    createdAt: Date.now(),
  };
}
