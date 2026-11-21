/**
 * Original Lumina Drift presets for the colour adjustment window.
 * Kept pure (no DOM) so unit checks can verify every preset against the colourAdjust parameters.
 */
import type { FilterValues } from '@atelier/shared';
import type { Translations } from '../locales';

export type ColorPresetKey = keyof Translations['filters']['colorPresets'];

export interface ColorAdjustPreset {
  id: ColorPresetKey;
  /** Three mood stops shown as a compact swatch bar on the preset card */
  swatch: readonly [string, string, string];
  values: {
    brightness: number;
    contrast: number;
    hue: number;
    saturation: number;
    temperature: number;
    tint: number;
  };
}

export const COLOR_ADJUST_PRESETS: readonly ColorAdjustPreset[] = [
  {
    id: 'original',
    swatch: ['#52525b', '#a1a1aa', '#e4e4e7'],
    values: { brightness: 0, contrast: 0, hue: 0, saturation: 0, temperature: 0, tint: 0 },
  },
  {
    id: 'morningGlow',
    swatch: ['#f59e0b', '#fbbf24', '#fef3c7'],
    values: { brightness: 10, contrast: 12, hue: 0, saturation: 14, temperature: 28, tint: 6 },
  },
  {
    id: 'twilightMist',
    swatch: ['#312e81', '#6366f1', '#f472b6'],
    values: { brightness: -6, contrast: 14, hue: -6, saturation: 10, temperature: -26, tint: 18 },
  },
  {
    id: 'softPastel',
    swatch: ['#fda4af', '#fde68a', '#bae6fd'],
    values: { brightness: 14, contrast: -18, hue: 0, saturation: -22, temperature: 8, tint: 10 },
  },
  {
    id: 'vividPop',
    swatch: ['#ec4899', '#f97316', '#38bdf8'],
    values: { brightness: 6, contrast: 24, hue: 0, saturation: 32, temperature: 6, tint: 0 },
  },
  {
    id: 'retroFilm',
    swatch: ['#78350f', '#d97706', '#a3e635'],
    values: { brightness: -4, contrast: 10, hue: 4, saturation: -14, temperature: 22, tint: -12 },
  },
  {
    id: 'coolAqua',
    swatch: ['#0284c7', '#22d3ee', '#cffafe'],
    values: { brightness: 8, contrast: 8, hue: -8, saturation: 12, temperature: -32, tint: -10 },
  },
  {
    id: 'dramaticNoir',
    swatch: ['#09090b', '#334155', '#cbd5e1'],
    values: { brightness: -10, contrast: 38, hue: 0, saturation: -55, temperature: -14, tint: -4 },
  },
];

const COLOR_KEYS = ['brightness', 'contrast', 'hue', 'saturation', 'temperature', 'tint'] as const;

/** Returns the preset id whose 6 values exactly match the current slider values, or null if customized */
export function matchColorPreset(values: FilterValues): ColorPresetKey | null {
  for (const preset of COLOR_ADJUST_PRESETS) {
    let same = true;
    for (const key of COLOR_KEYS) {
      const cur = typeof values[key] === 'number' ? values[key] : 0;
      if (cur !== preset.values[key]) {
        same = false;
        break;
      }
    }
    if (same) return preset.id;
  }
  return null;
}
