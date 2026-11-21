/**
 * The filter registry: every filter is one entry, and the menu, the parameter window and the worker
 * all read from here. The pixel maths lives in @atelier/shared (PIXEL_FILTER_RUNNERS, by the same
 * id); this file holds what the interface needs: group, name, parameters (all i18n keys).
 */
import type { FilterValues } from '@atelier/shared';
import type { Language, Translations } from '../locales';
import type { PluginFilterDeclaration, PluginFilterParam, PluginLocaleMap } from '../plugins/pluginApi';
import { getPlugins, subscribePlugins, type InstalledPlugin } from '../plugins/pluginStore';

export type FilterGroup = 'color' | 'library' | 'lineart' | 'render' | 'effect' | 'blur' | 'distort' | 'sharpen' | 'plugin';
/** Menu order. A group with no filters yet is left out of the menu. */
export const FILTER_GROUPS: readonly FilterGroup[] = ['color', 'library', 'lineart', 'render', 'effect', 'blur', 'distort', 'sharpen', 'plugin'];

type FilterTexts = Translations['filters'];
export type FilterItemKey = keyof FilterTexts['items'];
export type FilterParamKey = keyof FilterTexts['params'];
export type FilterSectionKey = keyof FilterTexts['sections'];
export type FilterHintKey = 'invertHint' | 'grayscaleHint' | 'softenHint' | 'sharpenHint';

interface ParamBase {
  /** Values are stored under this key, never by position */
  key: string;
  label?: FilterParamKey;
  /** Raw display label for plugin filters (falls back when no i18n key is used) */
  rawLabel?: string;
  /** Localized display labels for plugin filters */
  rawLabelI18n?: PluginLocaleMap;
  /** A small heading above this parameter (shown where it differs from the one before) */
  section?: FilterSectionKey;
  /** Raw section heading for plugin filters */
  rawSection?: string;
  /** Optional unit label displayed after range values (e.g. px, %) */
  unit?: string;
  /** Shown, and used, only while another parameter has one of these values */
  when?: { key: string; is: readonly (string | boolean)[] };
}
export type FilterParamOption = {
  value: string;
  label?: FilterParamKey;
  rawLabel?: string;
  rawLabelI18n?: PluginLocaleMap;
};
export type FilterParam =
  | ParamBase & { kind: 'range'; initial: number; min: number; max: number; step?: number }
  | ParamBase & { kind: 'select'; initial: string; options: readonly FilterParamOption[] }
  | ParamBase & { kind: 'toggle'; initial: boolean }
  | ParamBase & { kind: 'color'; initial: string }
  /** A spot on the canvas, dragged with a handle there. Never stored: it starts on the selection or the layer's content each time. */
  | ParamBase & { kind: 'point' };

export interface FilterDef {
  id: string;
  group: FilterGroup;
  label?: FilterItemKey;
  /** Plugin filters (plugin API v2) run in the dedicated plugin filter worker, never in the builtin filter worker */
  source: 'builtin' | 'plugin';
  /** Raw display label for plugin filters */
  rawLabel?: string;
  /** Localized display labels for plugin filters */
  rawLabelI18n?: PluginLocaleMap;
  /** Owning plugin id (for source === 'plugin') */
  pluginId?: string;
  /** Owning plugin display name (for source === 'plugin') */
  pluginName?: string;
  /** Filter id declared inside the plugin manifest (for source === 'plugin') */
  pluginFilterId?: string;
  /** Tile halo padding (0..32 px) for plugin filters */
  tilePadding?: number;
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
  /** On a big layer the preview shows a quick draft first (matches the runner's `draft` in @atelier/shared) */
  draft?: boolean;
}

/** What the worker is asked to run */
export type FilterJob = { id: string; values: FilterValues };

const range = (key: string, label: FilterParamKey, initial: number, min: number, max: number, step?: number): FilterParam =>
  ({ kind: 'range', key, label, initial, min, max, step });
const center = (when?: ParamBase['when']): FilterParam => ({ kind: 'point', key: 'center', label: 'center', when });
const inSection = (section: FilterSectionKey, params: FilterParam[]) => params.map((param) => ({ ...param, section }));
const toggle = (key: string, label: FilterParamKey, initial: boolean, when?: ParamBase['when']): FilterParam => ({ kind: 'toggle', key, label, initial, when });
/** A drop-down: [stored value, name] pairs, the first is the default */
const choice = (key: string, label: FilterParamKey, options: readonly (readonly [string, FilterParamKey])[], when?: ParamBase['when']): FilterParam =>
  ({ kind: 'select', key, label, initial: options[0][0], options: options.map(([value, name]) => ({ value, label: name })), when });

export const BUILTIN_FILTERS: readonly FilterDef[] = [
  { id: 'colorAdjust', group: 'color', label: 'colorAdjust', source: 'builtin', params: [
    ...inSection('tone', [range('brightness', 'brightness', 0, -100, 100), range('contrast', 'contrast', 0, -100, 100)]),
    ...inSection('color', [
      range('hue', 'hue', 0, -180, 180), range('saturation', 'saturation', 0, -100, 100),
      range('temperature', 'temperature', 0, -100, 100), range('tint', 'tint', 0, -100, 100),
    ]),
  ] },
  { id: 'levels', group: 'color', label: 'levels', source: 'builtin', histogram: true, params: [
    ...inSection('input', [range('inBlack', 'blackPoint', 0, 0, 254), range('midtones', 'midtones', 0, -100, 100), range('inWhite', 'whitePoint', 255, 1, 255)]),
    ...inSection('output', [range('outBlack', 'blackPoint', 0, 0, 255), range('outWhite', 'whitePoint', 255, 0, 255)]),
  ] },
  { id: 'curves', group: 'color', label: 'curves', source: 'builtin', params: [], dialog: 'curves' },
  { id: 'gradient', group: 'color', label: 'gradient', source: 'builtin', params: [], dialog: 'gradient' },
  { id: 'grayscale', group: 'color', label: 'grayscale', source: 'builtin', params: [], hint: 'grayscaleHint' },
  { id: 'monoTint', group: 'color', label: 'monoTint', source: 'builtin', params: [
    { kind: 'color', key: 'color', label: 'inkColor', initial: '#9a6b4c' },
    range('strength', 'amount', 100, 0, 100),
    toggle('preserveLuma', 'preserveLuma', true),
  ] },
  { id: 'threshold', group: 'color', label: 'threshold', source: 'builtin',
    params: [range('threshold', 'threshold', 128, 1, 255), choice('target', 'target', [['color', 'targetColor'], ['alpha', 'targetAlpha'], ['both', 'targetBoth']])] },
  { id: 'invert', group: 'color', label: 'invert', source: 'builtin', params: [], hint: 'invertHint' },
  { id: 'posterize', group: 'color', label: 'posterize', source: 'builtin', params: [range('levels', 'levels', 6, 2, 32)] },
  { id: 'lineWidth', group: 'lineart', label: 'lineWidth', source: 'builtin',
    params: [range('amount', 'lineAmount', 1, -10, 10), toggle('keepThin', 'keepThin', true)] },
  { id: 'despeckle', group: 'lineart', label: 'despeckle', source: 'builtin', params: [
    range('size', 'speckSize', 3, 1, 50),
    choice('mode', 'mode', [['opaque', 'modeOpaque'], ['onWhite', 'modeOnWhite'], ['fillAround', 'modeFillAround'], ['fillCurrent', 'modeFillCurrent']]),
  ] },
  { id: 'extractLines', group: 'lineart', label: 'extractLines', source: 'builtin',
    params: [range('whiteRange', 'whiteRange', 10, 0, 50), toggle('keepColor', 'keepColor', false)] },
  { id: 'lineColor', group: 'lineart', label: 'lineColor', source: 'builtin', params: [
    toggle('useCurrent', 'useCurrent', true),
    { kind: 'color', key: 'color', label: 'inkColor', initial: '#000000', when: { key: 'useCurrent', is: [false] } },
  ] },
  { id: 'smoothJaggies', group: 'lineart', label: 'smoothJaggies', source: 'builtin', params: [range('strength', 'amount', 50, 1, 100)] },
  { id: 'perlinNoise', group: 'render', label: 'perlinNoise', source: 'builtin', draft: true, params: [
    range('scale', 'scale', 48, 4, 256),
    range('amplitude', 'amount', 80, 0, 100),
    range('persistence', 'persistence', 0.5, 0.1, 0.9, 0.05),
    range('octaves', 'octaves', 4, 1, 6),
    range('offsetX', 'offsetX', 0, -500, 500),
    range('offsetY', 'offsetY', 0, -500, 500),
  ] },
  { id: 'gridPattern', group: 'render', label: 'gridPattern', source: 'builtin', params: [
    range('cell', 'cellSize', 32, 4, 256),
    range('lineWidth', 'outlineWidth', 1, 1, 16),
    { kind: 'color', key: 'color', label: 'inkColor', initial: '#6366f1' },
    range('opacity', 'opacity', 70, 5, 100),
    range('offsetX', 'offsetX', 0, 0, 256),
    range('offsetY', 'offsetY', 0, 0, 256),
  ] },
  { id: 'focusLines', group: 'render', label: 'focusLines', source: 'builtin', draft: true, params: [
    range('density', 'density', 60, 12, 180),
    range('lineWidth', 'outlineWidth', 3, 1, 12),
    range('innerRadius', 'innerRadius', 28, 0, 100),
    range('jitter', 'jitter', 40, 0, 100),
    { kind: 'color', key: 'color', label: 'inkColor', initial: '#111111' },
    center(),
  ] },
  { id: 'noise', group: 'effect', label: 'noise', source: 'builtin', params: [range('amount', 'amount', 25, 0, 100), range('grain', 'grain', 1, 1, 16)] },
  { id: 'halftone', group: 'effect', label: 'halftone', source: 'builtin',
    params: [range('density', 'density', 45, 4, 128), range('angle', 'angle', 45, 0, 180), range('dotSize', 'dotSize', 1, 0.1, 2, 0.1)] },
  { id: 'chromatic', group: 'effect', label: 'chromatic', source: 'builtin', params: [
    choice('mode', 'mode', [['shift', 'chromaShift'], ['radial', 'chromaRadial']]),
    { ...range('offsetX', 'offsetX', 6, -32, 32), when: { key: 'mode', is: ['shift'] } },
    { ...range('offsetY', 'offsetY', 0, -32, 32), when: { key: 'mode', is: ['shift'] } },
    { ...range('spread', 'spread', 8, 1, 64), when: { key: 'mode', is: ['radial'] } },
    center({ key: 'mode', is: ['radial'] }),
  ] },
  { id: 'mosaic', group: 'effect', label: 'mosaic', source: 'builtin', params: [range('cell', 'cellSize', 12, 2, 200)] },
  { id: 'glow', group: 'effect', label: 'glow', source: 'builtin', draft: true,
    params: [range('radius', 'radius', 16, 1, 64), range('strength', 'amount', 80, 0, 200), range('threshold', 'threshold', 160, 0, 254)] },
  { id: 'outline', group: 'effect', label: 'outline', source: 'builtin', draft: true, params: [
    range('size', 'outlineWidth', 3, 1, 50),
    { kind: 'color', key: 'color', label: 'inkColor', initial: '#ffffff' },
    choice('position', 'position', [['outside', 'positionOutside'], ['inside', 'positionInside'], ['center', 'positionCenter']]),
  ] },
  { id: 'emboss', group: 'effect', label: 'emboss', source: 'builtin', params: [
    range('angle', 'angle', 135, -180, 180),
    range('height', 'height', 2, 1, 16),
    range('amount', 'amount', 120, 10, 300),
    toggle('keepColor', 'keepOriginalColor', false),
  ] },
  { id: 'dropShadow', group: 'effect', label: 'dropShadow', source: 'builtin', draft: true, params: [
    range('offsetX', 'offsetX', 8, -200, 200),
    range('offsetY', 'offsetY', 8, -200, 200),
    range('radius', 'radius', 12, 0, 64),
    range('opacity', 'opacity', 55, 5, 100),
    { kind: 'color', key: 'color', label: 'inkColor', initial: '#0f172a' },
    toggle('shadowOnly', 'shadowOnly', false),
  ] },
  { id: 'edgeToLineart', group: 'effect', label: 'edgeToLineart', source: 'builtin', params: [
    range('sensitivity', 'sensitivity', 50, 1, 100),
    range('thickness', 'thickness', 1, 1, 5),
    toggle('keepColor', 'keepOriginalColor', false),
    toggle('whiteBg', 'whiteBg', false),
  ] },
  { id: 'box', group: 'blur', label: 'box', source: 'builtin', params: [range('radius', 'radius', 4, 1, 32)] },
  { id: 'gaussian', group: 'blur', label: 'gaussian', source: 'builtin', draft: true, params: [range('radius', 'radius', 8, 1, 32)] },
  { id: 'motionBlur', group: 'blur', label: 'motionBlur', source: 'builtin', draft: true, params: [
    range('distance', 'distance', 20, 1, 200), range('angle', 'angle', 0, -180, 180),
    choice('direction', 'direction', [['both', 'dirBoth'], ['forward', 'dirForward'], ['backward', 'dirBackward']]),
  ] },
  { id: 'radialBlur', group: 'blur', label: 'radialBlur', source: 'builtin', draft: true, params: [
    range('strength', 'amount', 30, 1, 100),
    choice('direction', 'direction', [['both', 'dirBoth'], ['in', 'dirIn'], ['out', 'dirOut']]),
    center(),
  ] },
  { id: 'spin', group: 'blur', label: 'spin', source: 'builtin', draft: true, params: [range('angle', 'angle', 15, 1, 90), center()] },
  { id: 'soften', group: 'blur', label: 'soften', source: 'builtin', params: [], hint: 'softenHint' },
  { id: 'twirl', group: 'distort', label: 'twirl', source: 'builtin', pointRadius: 'radius',
    params: [range('radius', 'radius', 300, 10, 2000), range('angle', 'angle', 135, -360, 360), center()] },
  { id: 'wave', group: 'distort', label: 'wave', source: 'builtin', draft: true, params: [
    choice('direction', 'direction', [['horizontal', 'waveHorizontal'], ['vertical', 'waveVertical'], ['both', 'waveBoth']]),
    range('amplitude', 'amplitude', 10, 1, 200), range('wavelength', 'wavelength', 120, 4, 2000),
  ] },
  { id: 'spherize', group: 'distort', label: 'spherize', source: 'builtin', pointRadius: 'radius', params: [
    range('strength', 'amount', 50, -100, 100), range('radius', 'radius', 300, 10, 4000), range('squash', 'squash', 0, -90, 90), center(),
  ] },
  { id: 'polarCoords', group: 'distort', label: 'polarCoords', source: 'builtin', draft: true, params: [
    choice('mode', 'mode', [['rectToPolar', 'polarRectToPolar'], ['polarToRect', 'polarToRect']]),
  ] },
  { id: 'zigzagRipple', group: 'distort', label: 'zigzagRipple', source: 'builtin', draft: true, params: [
    choice('style', 'rippleStyle', [['pond', 'ripplePond'], ['radial', 'rippleRadial']]),
    range('amount', 'amount', 30, -100, 100),
    range('ridges', 'ridges', 5, 1, 20),
    center(),
  ] },
  { id: 'pinch', group: 'distort', label: 'pinch', source: 'builtin', pointRadius: 'radius', params: [
    range('strength', 'amount', 50, -100, 100),
    range('radius', 'radius', 300, 10, 4000),
    center(),
  ] },
  { id: 'liquify', group: 'distort', label: 'liquify', source: 'builtin', params: [], tool: 'liquify' },
  { id: 'meshWarp', group: 'distort', label: 'meshWarp', source: 'builtin', params: [], tool: 'mesh' },
  { id: 'sharpen', group: 'sharpen', label: 'sharpen', source: 'builtin', params: [], hint: 'sharpenHint' },
  { id: 'unsharp', group: 'sharpen', label: 'unsharp', source: 'builtin',
    params: [range('radius', 'radius', 2, 1, 50), range('amount', 'amount', 100, 0, 500), range('threshold', 'threshold', 0, 0, 255)] },
  { id: 'highPass', group: 'sharpen', label: 'highPass', source: 'builtin',
    params: [range('radius', 'radius', 4, 0.5, 64, 0.5)] },
];

export const makePluginFilterId = (pluginId: string, filterId: string) => `plugin:${pluginId}:${filterId}`;

function mapPluginParam(param: PluginFilterParam): FilterParam {
  const base: ParamBase = {
    key: param.key,
    rawLabel: param.label,
    rawLabelI18n: param.i18nLabel,
    rawSection: param.section,
    when: param.when,
  };
  switch (param.kind) {
    case 'range':
      return {
        ...base,
        kind: 'range',
        initial: param.initial,
        min: param.min,
        max: param.max,
        step: param.step,
        unit: param.unit,
      };
    case 'select':
      return {
        ...base,
        kind: 'select',
        initial: param.initial,
        options: param.options.map((opt) => ({
          value: opt.value,
          rawLabel: opt.label,
          rawLabelI18n: opt.i18nLabel,
        })),
      };
    case 'toggle':
      return { ...base, kind: 'toggle', initial: param.initial };
    case 'color':
      return { ...base, kind: 'color', initial: param.initial };
  }
}

function mapPluginFilter(plugin: InstalledPlugin, decl: PluginFilterDeclaration): FilterDef {
  // 'library' is a gallery tab rather than a plain filter list; route such declarations to 'plugin'
  const group: FilterGroup = decl.group === 'library' ? 'plugin' : decl.group;
  return {
    id: makePluginFilterId(plugin.manifest.id, decl.id),
    group,
    source: 'plugin',
    rawLabel: decl.label,
    rawLabelI18n: decl.i18nLabel,
    pluginId: plugin.manifest.id,
    pluginName: plugin.manifest.name,
    pluginFilterId: decl.id,
    tilePadding: decl.tilePadding,
    draft: decl.draft,
    params: decl.params.map(mapPluginParam),
  };
}

let pluginFilters: readonly FilterDef[] = [];
let registryVersion = 0;
const registryListeners = new Set<() => void>();

export function syncPluginFilters(installedPlugins: readonly InstalledPlugin[]): readonly FilterDef[] {
  const next: FilterDef[] = [];
  for (const item of installedPlugins) {
    if (!item.enabled || item.manifest.apiVersion !== 2) continue;
    if (!item.manifest.permissions.includes('filters')) continue;
    for (const decl of item.manifest.filters) {
      next.push(mapPluginFilter(item, decl));
    }
  }
  pluginFilters = next;
  registryVersion++;
  for (const listener of registryListeners) listener();
  return pluginFilters;
}

export const getPluginFilters = (): readonly FilterDef[] => pluginFilters;
export const getAllFilters = (): readonly FilterDef[] => (pluginFilters.length ? [...BUILTIN_FILTERS, ...pluginFilters] : BUILTIN_FILTERS);
export const getFilterRegistryVersion = () => registryVersion;
export const subscribeFilterRegistry = (listener: () => void) => {
  registryListeners.add(listener);
  return () => { registryListeners.delete(listener); };
};

// Keep registry synchronized with pluginStore enable/disable/install/remove changes
syncPluginFilters(getPlugins());
subscribePlugins(() => {
  syncPluginFilters(getPlugins());
});

export const getFilter = (id: string | null | undefined) => {
  if (!id) return null;
  return BUILTIN_FILTERS.find((def) => def.id === id) ?? pluginFilters.find((def) => def.id === id) ?? null;
};
export const filtersInGroup = (group: FilterGroup) => getAllFilters().filter((def) => def.group === group);
export const filterGroupsInUse = () => FILTER_GROUPS.filter((group) => group === 'library' || filtersInGroup(group).length > 0);

const pickLocalizedText = (rawLabel: string | undefined, i18nMap: PluginLocaleMap | undefined, language?: Language): string => {
  if (language && i18nMap?.[language]) return i18nMap[language]!;
  if (i18nMap?.['en-US']) return i18nMap['en-US']!;
  return rawLabel ?? '';
};

export const filterLabel = (def: FilterDef, t: Translations, language?: Language) => {
  if (def.source === 'plugin' || !def.label) {
    return pickLocalizedText(def.rawLabel, def.rawLabelI18n, language) || def.id;
  }
  return t.filters.items[def.label];
};

export const filterParamLabel = (
  param: Pick<ParamBase, 'label' | 'rawLabel' | 'rawLabelI18n'>,
  t: Translations,
  language?: Language,
) => {
  if (param.rawLabel !== undefined || param.rawLabelI18n !== undefined) {
    return pickLocalizedText(param.rawLabel, param.rawLabelI18n, language);
  }
  return param.label ? t.filters.params[param.label] : '';
};

export const filterSectionLabel = (param: Pick<ParamBase, 'section' | 'rawSection'>, t: Translations): string => {
  if (param.rawSection) return param.rawSection;
  return param.section ? t.filters.sections[param.section] : '';
};

export const filterGroupLabel = (group: FilterGroup, t: Translations) => t.filters.groups[group];

/** The filter's centre parameter, if it has one */
export const filterPointParam = (def: FilterDef | null | undefined) =>
  def?.params.find((param): param is Extract<FilterParam, { kind: 'point' }> => param.kind === 'point') ?? null;

/** Whether a parameter applies with these settings (see `when`) */
export const paramShown = (param: FilterParam, values: FilterValues) =>
  !param.when || param.when.is.includes(values[param.when.key] as string | boolean);

/**
 * Draft previews: a layer above `above` pixels previews a draft filter on a copy shrunk to about
 * `target` pixels first, then in full. Touch devices (slower) start sooner.
 */
export const FILTER_DRAFT = {
  desktop: { above: 4_000_000, target: 1_500_000 },
  touch: { above: 1_500_000, target: 600_000 },
} as const;

/** How many times smaller the draft preview is worked out: 0 for none (the filter or the layer is too small to need one) */
export function filterDraftFactor(def: FilterDef | null | undefined, width: number, height: number, touch: boolean) {
  if (!def?.draft) return 0;
  const { above, target } = touch ? FILTER_DRAFT.touch : FILTER_DRAFT.desktop;
  const area = width * height;
  return area > above ? Math.max(2, Math.ceil(Math.sqrt(area / target))) : 0;
}

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
