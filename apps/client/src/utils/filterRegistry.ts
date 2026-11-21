/**
 * The filter registry: every filter is one entry, and the menu, the parameter window and the worker
 * all read from here. The pixel maths lives in @atelier/shared (PIXEL_FILTER_RUNNERS, by the same
 * id); this file holds what the interface needs: group, name, parameters (all i18n keys).
 */
import type { FilterValues } from '@atelier/shared';
import type { Translations } from '../locales';

export type FilterGroup = 'color' | 'library' | 'lineart' | 'render' | 'effect' | 'blur' | 'distort' | 'sharpen';
/** Menu order. A group with no filters yet is left out of the menu. */
export const FILTER_GROUPS: readonly FilterGroup[] = ['color', 'library', 'lineart', 'render', 'effect', 'blur', 'distort', 'sharpen'];

type FilterTexts = Translations['filters'];
export type FilterItemKey = keyof FilterTexts['items'];
export type FilterParamKey = keyof FilterTexts['params'];
export type FilterSectionKey = keyof FilterTexts['sections'];
export type FilterHintKey = 'invertHint';

interface ParamBase {
  /** Values are stored under this key, never by position */
  key: string;
  label: FilterParamKey;
  /** A small heading above this parameter (shown where it differs from the one before) */
  section?: FilterSectionKey;
  /** Shown, and used, only while another parameter has one of these values */
  when?: { key: string; is: readonly (string | boolean)[] };
}
export type FilterParam =
  | ParamBase & { kind: 'range'; initial: number; min: number; max: number; step?: number }
  | ParamBase & { kind: 'select'; initial: string; options: readonly { value: string; label: FilterParamKey }[] }
  | ParamBase & { kind: 'toggle'; initial: boolean }
  | ParamBase & { kind: 'color'; initial: string }
  /** A spot on the canvas, dragged with a handle there. Never stored: it starts on the selection or the layer's content each time. */
  | ParamBase & { kind: 'point' };

export interface FilterDef {
  id: string;
  group: FilterGroup;
  label: FilterItemKey;
  /** Plugin filters (plugin API v2) will run in the plugin sandbox, never in the filter worker */
  source: 'builtin' | 'plugin';
  params: readonly FilterParam[];
  /** Opens a window of its own instead of the parameter window */
  dialog?: 'curves' | 'gradient';
  /** Only opens an existing tool */
  tool?: 'liquify' | 'mesh';
  /** One line shown when the filter has no parameters */
  hint?: FilterHintKey;
  /** The range parameter drawn as the circle around the centre handle on the canvas */
  pointRadius?: string;
  /** Shows the layer's tone histogram above the parameters */
  histogram?: boolean;
}

/** What the worker is asked to run */
export type FilterJob = { id: string; values: FilterValues };

const range = (key: string, label: FilterParamKey, initial: number, min: number, max: number, step?: number): FilterParam =>
  ({ kind: 'range', key, label, initial, min, max, step });
const center = (when?: ParamBase['when']): FilterParam => ({ kind: 'point', key: 'center', label: 'center', when });

export const BUILTIN_FILTERS: readonly FilterDef[] = [
  { id: 'curves', group: 'color', label: 'curves', source: 'builtin', params: [], dialog: 'curves' },
  { id: 'gradient', group: 'color', label: 'gradient', source: 'builtin', params: [], dialog: 'gradient' },
  { id: 'invert', group: 'color', label: 'invert', source: 'builtin', params: [], hint: 'invertHint' },
  { id: 'posterize', group: 'color', label: 'posterize', source: 'builtin', params: [range('levels', 'levels', 6, 2, 32)] },
  { id: 'noise', group: 'effect', label: 'noise', source: 'builtin', params: [range('amount', 'amount', 25, 0, 100), range('grain', 'grain', 1, 1, 16)] },
  { id: 'halftone', group: 'effect', label: 'halftone', source: 'builtin',
    params: [range('density', 'density', 45, 4, 128), range('angle', 'angle', 45, 0, 180), range('dotSize', 'dotSize', 1, 0.1, 2, 0.1)] },
  { id: 'chromatic', group: 'effect', label: 'chromatic', source: 'builtin', params: [range('offsetX', 'offsetX', 6, -32, 32), range('offsetY', 'offsetY', 0, -32, 32)] },
  { id: 'box', group: 'blur', label: 'box', source: 'builtin', params: [range('radius', 'radius', 4, 1, 32)] },
  { id: 'gaussian', group: 'blur', label: 'gaussian', source: 'builtin', params: [range('radius', 'radius', 8, 1, 32)] },
  { id: 'spin', group: 'blur', label: 'spin', source: 'builtin', params: [range('angle', 'angle', 15, 1, 90), center()] },
  { id: 'twirl', group: 'distort', label: 'twirl', source: 'builtin', pointRadius: 'radius',
    params: [range('radius', 'radius', 300, 10, 2000), range('angle', 'angle', 135, -360, 360), center()] },
  { id: 'liquify', group: 'distort', label: 'liquify', source: 'builtin', params: [], tool: 'liquify' },
  { id: 'meshWarp', group: 'distort', label: 'meshWarp', source: 'builtin', params: [], tool: 'mesh' },
];

export const getFilter = (id: string | null | undefined) => BUILTIN_FILTERS.find((def) => def.id === id) ?? null;
export const filtersInGroup = (group: FilterGroup) => BUILTIN_FILTERS.filter((def) => def.group === group);
export const filterGroupsInUse = () => FILTER_GROUPS.filter((group) => filtersInGroup(group).length > 0);

export const filterLabel = (def: FilterDef, t: Translations) => t.filters.items[def.label];
export const filterParamLabel = (param: Pick<FilterParam, 'label'>, t: Translations) => t.filters.params[param.label];
export const filterGroupLabel = (group: FilterGroup, t: Translations) => t.filters.groups[group];

/** The filter's centre parameter, if it has one */
export const filterPointParam = (def: FilterDef | null | undefined) =>
  def?.params.find((param): param is Extract<FilterParam, { kind: 'point' }> => param.kind === 'point') ?? null;

/** Whether a parameter applies with these settings (see `when`) */
export const paramShown = (param: FilterParam, values: FilterValues) =>
  !param.when || param.when.is.includes(values[param.when.key] as string | boolean);

/** Line-art fixes read alpha as ink, so they stay off masks (whose grey is the mask itself) */
export const filterFitsLayer = (def: FilterDef, layerType: string | undefined) => !(def.group === 'lineart' && layerType === 'mask');

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length;

/** A range value moved onto the slider: inside min–max and on a step */
export function snapRange(param: Extract<FilterParam, { kind: 'range' }>, value: number) {
  const step = param.step ?? 1;
  const clamped = Math.min(param.max, Math.max(param.min, value));
  const snapped = param.min + Math.round((clamped - param.min) / step) * step;
  return Number(Math.min(param.max, snapped).toFixed(decimals(step)));
}

export const defaultFilterValues = (def: FilterDef): FilterValues =>
  Object.fromEntries(def.params.flatMap((param) => param.kind === 'point' ? [] : [[param.key, param.initial]]));

/** Keeps the settings that still fit the filter's parameters; anything else falls back to its default */
export function normalizeFilterValues(def: FilterDef, raw: unknown): FilterValues {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const values: FilterValues = {};
  for (const param of def.params) {
    const value = source[param.key];
    switch (param.kind) {
      case 'range':
        values[param.key] = typeof value === 'number' && Number.isFinite(value) ? snapRange(param, value) : param.initial;
        break;
      case 'select':
        values[param.key] = param.options.some((option) => option.value === value) ? value : param.initial;
        break;
      case 'toggle':
        values[param.key] = typeof value === 'boolean' ? value : param.initial;
        break;
      case 'color':
        values[param.key] = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : param.initial;
        break;
      case 'point':
        break;
    }
  }
  return values;
}

/** Each filter's last-used settings: a personal setting, kept in this browser only */
const STORE_KEY = 'atelier_filter_params';

const readStore = (): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const loadFilterValues = (def: FilterDef) => normalizeFilterValues(def, readStore()[def.id]);

export function saveFilterValues(def: FilterDef, values: FilterValues) {
  if (!def.params.length) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), [def.id]: normalizeFilterValues(def, values) }));
  } catch {
    // private mode or full storage: the defaults come back next time
  }
}
