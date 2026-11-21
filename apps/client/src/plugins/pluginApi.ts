import type { BlendMode } from '@atelier/shared';

export const PLUGIN_API_VERSION_V1 = 1 as const;
export const PLUGIN_API_VERSION_V2 = 2 as const;
export const PLUGIN_API_VERSION = PLUGIN_API_VERSION_V1;

/**
 * Centralized capacity and sandbox limits for plugins.
 * Kept in one place so future iterations (e.g. UI extensions / IndexedDB backend)
 * can raise limits without hunting scattered constants.
 */
export const PLUGIN_LIMITS = {
  maxPackageBytesV1: 128 * 1024,
  maxPackageBytesV2: 256 * 1024,
  maxInstalledPlugins: 24,
  maxCommandsPerPluginV1: 12,
  maxCommandsPerPluginV2: 16,
  maxFiltersPerPlugin: 12,
  maxFilterParamsPerFilter: 16,
  maxFilterTilePadding: 32,
  maxPanelsPerPlugin: 4,
  maxPanelFieldsPerPanel: 24,
  maxPanelActionsPerPanel: 8,
  maxSelectOptions: 32,
  maxRpcCallsPerRun: 256,
  maxPixelBytesPerRun: 64 * 1024 * 1024,
  maxCreatedLayersPerRun: 20,
  maxTileRegionDim: 512,
  maxPolygonPoints: 4096,
  maxSelectionRadius: 128,
  commandCpuLimitMs: 3000,
  commandWallLimitMs: 15000,
  filterTileCpuLimitMs: 500,
  filterPreviewTotalCpuMs: 3000,
  filterApplyTotalCpuMs: 15000,
  memoryLimitDesktopBytes: 32 * 1024 * 1024,
  memoryLimitMobileBytes: 24 * 1024 * 1024,
  maxStackSizeBytes: 512 * 1024,
} as const;

export const MAX_PLUGIN_BYTES_V1 = PLUGIN_LIMITS.maxPackageBytesV1;
export const MAX_PLUGIN_BYTES_V2 = PLUGIN_LIMITS.maxPackageBytesV2;
export const MAX_PLUGIN_BYTES = PLUGIN_LIMITS.maxPackageBytesV2;
export const MAX_PLUGINS = PLUGIN_LIMITS.maxInstalledPlugins;

export const PLUGIN_LOCALES = ['zh-TW', 'zh-CN', 'en-US', 'ja-JP'] as const;
export type PluginLocaleCode = (typeof PLUGIN_LOCALES)[number];
export type PluginLocaleMap = Partial<Record<PluginLocaleCode, string>>;
export type PluginI18nMetadata = Partial<Record<PluginLocaleCode, { name?: string; description?: string }>>;

export const PLUGIN_PERMISSIONS_V1 = ['brush', 'layers', 'artwork'] as const;
export type PluginPermissionV1 = (typeof PLUGIN_PERMISSIONS_V1)[number];

export const PLUGIN_PERMISSIONS_V2_CORE = [
  'layers:read',
  'layers:write',
  'pixels:read',
  'pixels:write',
  'selection',
  'filters',
  'commands',
  'ui:panel',
] as const;

export const PLUGIN_PERMISSIONS_V2 = [...PLUGIN_PERMISSIONS_V2_CORE, 'brush'] as const;
export type PluginPermissionV2 = (typeof PLUGIN_PERMISSIONS_V2)[number];
export type PluginPermission = PluginPermissionV1 | PluginPermissionV2;

export const PLUGIN_FILTER_GROUPS = [
  'plugin',
  'color',
  'library',
  'lineart',
  'render',
  'effect',
  'blur',
  'distort',
  'sharpen',
] as const;
export type PluginFilterGroup = (typeof PLUGIN_FILTER_GROUPS)[number];

export interface PluginFieldCondition {
  key: string;
  is: (string | boolean)[];
}

export interface PluginSelectOption {
  value: string;
  label: string;
  i18nLabel?: PluginLocaleMap;
}

export interface PluginCommandV1 {
  id: string;
  label: string;
}

export interface PluginCommandV2 {
  id: string;
  label: string;
  i18nLabel?: PluginLocaleMap;
  group?: string;
  suggestedShortcut?: string;
}

interface PluginFilterParamBase {
  key: string;
  label: string;
  i18nLabel?: PluginLocaleMap;
  section?: string;
  when?: PluginFieldCondition;
}

export type PluginFilterParam =
  | (PluginFilterParamBase & {
      kind: 'range';
      initial: number;
      min: number;
      max: number;
      step?: number;
      unit?: string;
    })
  | (PluginFilterParamBase & {
      kind: 'select';
      initial: string;
      options: PluginSelectOption[];
    })
  | (PluginFilterParamBase & {
      kind: 'toggle';
      initial: boolean;
    })
  | (PluginFilterParamBase & {
      kind: 'color';
      initial: string;
    });

export interface PluginFilterDeclaration {
  id: string;
  label: string;
  i18nLabel?: PluginLocaleMap;
  group: PluginFilterGroup;
  tilePadding: number;
  draft?: boolean;
  params: PluginFilterParam[];
}

interface PluginPanelFieldBase {
  key: string;
  label?: string;
  i18nLabel?: PluginLocaleMap;
  when?: PluginFieldCondition;
}

export type PluginPanelField =
  | (PluginPanelFieldBase & {
      kind: 'section';
      label: string;
    })
  | (PluginPanelFieldBase & {
      kind: 'text';
      text: string;
      i18nText?: PluginLocaleMap;
    })
  | (PluginPanelFieldBase & {
      kind: 'range';
      label: string;
      initial: number;
      min: number;
      max: number;
      step?: number;
      unit?: string;
      live?: boolean;
    })
  | (PluginPanelFieldBase & {
      kind: 'number';
      label: string;
      initial: number;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
      live?: boolean;
    })
  | (PluginPanelFieldBase & {
      kind: 'toggle';
      label: string;
      initial: boolean;
      live?: boolean;
    })
  | (PluginPanelFieldBase & {
      kind: 'select';
      label: string;
      initial: string;
      options: PluginSelectOption[];
      live?: boolean;
    })
  | (PluginPanelFieldBase & {
      kind: 'color';
      label: string;
      initial: string;
      live?: boolean;
    })
  | (PluginPanelFieldBase & {
      kind: 'layer';
      label: string;
      allowGroup?: boolean;
      live?: boolean;
    })
  | (PluginPanelFieldBase & {
      kind: 'input';
      label: string;
      initial?: string;
      placeholder?: string;
      maxLength?: number;
      live?: boolean;
    });

export interface PluginPanelAction {
  id: string;
  label: string;
  i18nLabel?: PluginLocaleMap;
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface PluginPanelDeclaration {
  id: string;
  title: string;
  i18nTitle?: PluginLocaleMap;
  icon?: string;
  defaultWidth?: number;
  fields: PluginPanelField[];
  actions: PluginPanelAction[];
}

export interface PluginManifestV1 {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  permissions: PluginPermissionV1[];
  commands: PluginCommandV1[];
  script: string;
}

export interface PluginManifestV2 {
  apiVersion: 2;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  i18n?: PluginI18nMetadata;
  permissions: PluginPermissionV2[];
  commands: PluginCommandV2[];
  filters: PluginFilterDeclaration[];
  panels: PluginPanelDeclaration[];
  script: string;
}

export type PluginManifest = PluginManifestV1 | PluginManifestV2;

export interface PluginContext {
  width: number;
  height: number;
  dpi: number;
  tileSize?: number;
}

export interface PluginRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PluginCombineMode = 'replace' | 'add' | 'subtract';

export interface PluginSelectionInfo {
  hasSelection: boolean;
  bounds: PluginRect | null;
}

export interface PluginLayerInfo {
  id: string;
  parentId: string | null;
  name: string;
  layerType: 'raster' | 'vector' | 'text' | 'group' | 'mask';
  blendMode: BlendMode;
  opacity: number;
  isVisible: boolean;
  isLocked: boolean;
  alphaLocked: boolean;
  clipToBelow: boolean;
  sortOrder: number;
  isOwnedByMe: boolean;
  canEditPixels: boolean;
  canManage: boolean;
  maskLayerId: string | null;
}

type Shape = { kind: 'rect' | 'ellipse'; x: number; y: number; width: number; height: number; color: string };
export type PluginAction =
  | { kind: 'message'; text: string }
  | { kind: 'brush'; color?: string; size?: number }
  | { kind: 'layer'; name: string }
  | { kind: 'artwork'; name: string; width: number; height: number; shapes: Shape[] };

const VALID_SHORTCUT_MODIFIERS = new Set(['Ctrl', 'Shift', 'Alt', 'Meta']);
const VALID_SHORTCUT_KEY = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|BracketLeft|BracketRight|Minus|Equal|Comma|Period|Slash|Backquote|Space|Enter|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/;
const VALID_PANEL_ICONS = new Set([
  'puzzle', 'sparkles', 'wand', 'sliders', 'layers', 'palette', 'brush', 'scissors', 'shapes', 'grid', 'wrench', 'eye',
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}

function label(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid text field.');
  }
  return value.trim();
}

function optionalLabel(value: unknown, max: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  return label(value, max);
}

function identifier(value: unknown): string {
  const id = label(value, 80);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) throw new Error('Invalid identifier.');
  return id;
}

function fieldKey(value: unknown): string {
  const key = label(value, 60);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) throw new Error('Invalid field key.');
  return key;
}

function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error('Number outside allowed range.');
  }
  return value;
}

function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Expected a #RRGGBB color.');
  return value;
}

function parseLocaleMap(value: unknown, maxLen: number): PluginLocaleMap | undefined {
  if (value === undefined) return undefined;
  const obj = record(value);
  const out: PluginLocaleMap = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!PLUGIN_LOCALES.includes(k as PluginLocaleCode)) throw new Error(`Unsupported locale key: ${k}`);
    out[k as PluginLocaleCode] = label(v, maxLen);
  }
  return Object.keys(out).length ? out : undefined;
}

function parseI18nMetadata(value: unknown): PluginI18nMetadata | undefined {
  if (value === undefined) return undefined;
  const obj = record(value);
  const out: PluginI18nMetadata = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!PLUGIN_LOCALES.includes(k as PluginLocaleCode)) throw new Error(`Unsupported locale key: ${k}`);
    const entry = record(v);
    const name = optionalLabel(entry.name, 60);
    const description = optionalLabel(entry.description, 240);
    if (name !== undefined || description !== undefined) {
      out[k as PluginLocaleCode] = { ...(name ? { name } : {}), ...(description ? { description } : {}) };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function parseCondition(value: unknown): PluginFieldCondition | undefined {
  if (value === undefined) return undefined;
  const cond = record(value);
  const key = fieldKey(cond.key);
  if (!Array.isArray(cond.is) || cond.is.length < 1 || cond.is.length > 16) {
    throw new Error('Invalid condition values.');
  }
  const is = cond.is.map((v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string' && v.length <= 60 && !/[\u0000-\u001f\u007f]/.test(v)) return v;
    throw new Error('Condition value must be a string or boolean.');
  });
  return { key, is };
}

function parseSelectOptions(value: unknown): PluginSelectOption[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PLUGIN_LIMITS.maxSelectOptions) {
    throw new Error(`Select must declare between 1 and ${PLUGIN_LIMITS.maxSelectOptions} options.`);
  }
  const options = value.map((entry): PluginSelectOption => {
    const opt = record(entry);
    const val = label(opt.value, 60);
    const lbl = label(opt.label, 60);
    const i18nLabel = parseLocaleMap(opt.i18nLabel, 60);
    return { value: val, label: lbl, ...(i18nLabel ? { i18nLabel } : {}) };
  });
  if (new Set(options.map((o) => o.value)).size !== options.length) {
    throw new Error('Duplicate select option value.');
  }
  return options;
}

function parseShortcut(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  const raw = label(value, 64);
  const parts = raw.split('+');
  if (parts.length < 1 || parts.length > 4) throw new Error('Invalid suggestedShortcut.');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!VALID_SHORTCUT_KEY.test(key)) throw new Error(`Invalid shortcut key: ${key}`);
  if (new Set(mods).size !== mods.length || !mods.every((m) => VALID_SHORTCUT_MODIFIERS.has(m))) {
    throw new Error('Invalid shortcut modifiers.');
  }
  return raw;
}

function parseFilterParam(entry: unknown): PluginFilterParam {
  const raw = record(entry);
  const key = fieldKey(raw.key);
  const lbl = label(raw.label, 60);
  const i18nLabel = parseLocaleMap(raw.i18nLabel, 60);
  const section = optionalLabel(raw.section, 60);
  const when = parseCondition(raw.when);
  const base: PluginFilterParamBase = {
    key,
    label: lbl,
    ...(i18nLabel ? { i18nLabel } : {}),
    ...(section ? { section } : {}),
    ...(when ? { when } : {}),
  };

  switch (raw.kind) {
    case 'range': {
      const min = number(raw.min, -100_000, 100_000);
      const max = number(raw.max, -100_000, 100_000);
      if (min >= max) throw new Error('Range min must be less than max.');
      const initial = number(raw.initial, min, max);
      const step = raw.step === undefined ? undefined : number(raw.step, 0.0001, max - min);
      const unit = optionalLabel(raw.unit, 16);
      return {
        ...base,
        kind: 'range',
        initial,
        min,
        max,
        ...(step !== undefined ? { step } : {}),
        ...(unit ? { unit } : {}),
      };
    }
    case 'select': {
      const options = parseSelectOptions(raw.options);
      const initial = label(raw.initial, 60);
      if (!options.some((o) => o.value === initial)) {
        throw new Error('Select initial value must match one of its options.');
      }
      return { ...base, kind: 'select', initial, options };
    }
    case 'toggle': {
      if (typeof raw.initial !== 'boolean') throw new Error('Toggle initial must be boolean.');
      return { ...base, kind: 'toggle', initial: raw.initial };
    }
    case 'color': {
      return { ...base, kind: 'color', initial: hex(raw.initial) };
    }
    default:
      throw new Error('Unknown filter parameter kind.');
  }
}

function parseFilters(value: unknown): PluginFilterDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PLUGIN_LIMITS.maxFiltersPerPlugin) {
    throw new Error(`Declare at most ${PLUGIN_LIMITS.maxFiltersPerPlugin} filters.`);
  }
  const filters = value.map((entry): PluginFilterDeclaration => {
    const raw = record(entry);
    const id = identifier(raw.id);
    const lbl = label(raw.label, 60);
    const i18nLabel = parseLocaleMap(raw.i18nLabel, 60);
    const groupRaw = raw.group === undefined ? 'plugin' : raw.group;
    if (typeof groupRaw !== 'string' || !PLUGIN_FILTER_GROUPS.includes(groupRaw as PluginFilterGroup)) {
      throw new Error('Invalid filter group.');
    }
    const tilePadding = raw.tilePadding === undefined ? 0 : number(raw.tilePadding, 0, PLUGIN_LIMITS.maxFilterTilePadding);
    if (!Number.isInteger(tilePadding)) throw new Error('tilePadding must be an integer.');
    if (raw.draft !== undefined && typeof raw.draft !== 'boolean') throw new Error('Filter draft flag must be boolean.');
    const rawParams = raw.params === undefined ? [] : raw.params;
    if (!Array.isArray(rawParams) || rawParams.length > PLUGIN_LIMITS.maxFilterParamsPerFilter) {
      throw new Error(`A filter can declare at most ${PLUGIN_LIMITS.maxFilterParamsPerFilter} parameters.`);
    }
    const params = rawParams.map(parseFilterParam);
    const keySet = new Set(params.map((p) => p.key));
    if (keySet.size !== params.length) throw new Error('Duplicate filter parameter key.');
    for (const p of params) {
      if (p.when && !keySet.has(p.when.key)) throw new Error(`Filter condition references unknown key: ${p.when.key}`);
    }
    return {
      id,
      label: lbl,
      ...(i18nLabel ? { i18nLabel } : {}),
      group: groupRaw as PluginFilterGroup,
      tilePadding,
      ...(raw.draft !== undefined ? { draft: raw.draft } : {}),
      params,
    };
  });
  if (new Set(filters.map((f) => f.id)).size !== filters.length) throw new Error('Duplicate filter ID.');
  return filters;
}

function parsePanelField(entry: unknown): PluginPanelField {
  const raw = record(entry);
  const key = fieldKey(raw.key);
  const when = parseCondition(raw.when);
  const i18nLabel = parseLocaleMap(raw.i18nLabel, 60);
  const live = raw.live === undefined ? undefined : Boolean(raw.live);
  if (raw.live !== undefined && typeof raw.live !== 'boolean') throw new Error('Field live flag must be boolean.');

  switch (raw.kind) {
    case 'section':
      return {
        kind: 'section',
        key,
        label: label(raw.label, 60),
        ...(i18nLabel ? { i18nLabel } : {}),
        ...(when ? { when } : {}),
      };
    case 'text': {
      const lbl = optionalLabel(raw.label, 60);
      const text = label(raw.text, 240);
      const i18nText = parseLocaleMap(raw.i18nText, 240);
      return {
        kind: 'text',
        key,
        ...(lbl ? { label: lbl } : {}),
        ...(i18nLabel ? { i18nLabel } : {}),
        text,
        ...(i18nText ? { i18nText } : {}),
        ...(when ? { when } : {}),
      };
    }
    case 'range': {
      const min = number(raw.min, -100_000, 100_000);
      const max = number(raw.max, -100_000, 100_000);
      if (min >= max) throw new Error('Range min must be less than max.');
      const initial = number(raw.initial, min, max);
      const step = raw.step === undefined ? undefined : number(raw.step, 0.0001, max - min);
      const unit = optionalLabel(raw.unit, 16);
      return {
        kind: 'range',
        key,
        label: label(raw.label, 60),
        ...(i18nLabel ? { i18nLabel } : {}),
        initial,
        min,
        max,
        ...(step !== undefined ? { step } : {}),
        ...(unit ? { unit } : {}),
        ...(live !== undefined ? { live } : {}),
        ...(when ? { when } : {}),
      };
    }
    case 'number': {
      const min = raw.min === undefined ? undefined : number(raw.min, -1_000_000, 1_000_000);
      const max = raw.max === undefined ? undefined : number(raw.max, -1_000_000, 1_000_000);
      if (min !== undefined && max !== undefined && min >= max) throw new Error('Number min must be less than max.');
      const initial = number(raw.initial, min ?? -1_000_000, max ?? 1_000_000);
      const step = raw.step === undefined ? undefined : number(raw.step, 0.0001, 1_000_000);
      const unit = optionalLabel(raw.unit, 16);
      return {
        kind: 'number',
        key,
        label: label(raw.label, 60),
        ...(i18nLabel ? { i18nLabel } : {}),
        initial,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(unit ? { unit } : {}),
        ...(live !== undefined ? { live } : {}),
        ...(when ? { when } : {}),
      };
    }
    case 'toggle': {
      if (typeof raw.initial !== 'boolean') throw new Error('Toggle initial must be boolean.');
      return {
        kind: 'toggle',
        key,
        label: label(raw.label, 60),
        ...(i18nLabel ? { i18nLabel } : {}),
        initial: raw.initial,
        ...(live !== undefined ? { live } : {}),
        ...(when ? { when } : {}),
      };
    }
    case 'select': {
      const options = parseSelectOptions(raw.options);
      const initial = label(raw.initial, 60);
      if (!options.some((o) => o.value === initial)) {
        throw new Error('Select initial value must match one of its options.');
      }
      return {
        kind: 'select',
        key,
        label: label(raw.label, 60),
        ...(i18nLabel ? { i18nLabel } : {}),
        initial,
        options,
        ...(live !== undefined ? { live } : {}),
        ...(when ? { when } : {}),
      };
    }
    case 'color': {
      return {
        kind: 'color',
        key,
        label: label(raw.label, 60),
        ...(i18nLabel ? { i18nLabel } : {}),
        initial: hex(raw.initial),
        ...(live !== undefined ? { live } : {}),
        ...(when ? { when } : {}),
      };
    }
    case 'layer': {
      if (raw.allowGroup !== undefined && typeof raw.allowGroup !== 'boolean') {
        throw new Error('Layer allowGroup must be boolean.');
      }
      return {
        kind: 'layer',
        key,
        label: label(raw.label, 60),
        ...(i18nLabel ? { i18nLabel } : {}),
        ...(raw.allowGroup !== undefined ? { allowGroup: raw.allowGroup } : {}),
        ...(live !== undefined ? { live } : {}),
        ...(when ? { when } : {}),
      };
    }
    case 'input': {
      const maxLength = raw.maxLength === undefined ? 200 : number(raw.maxLength, 1, 200);
      if (!Number.isInteger(maxLength)) throw new Error('Input maxLength must be an integer.');
      const initial = raw.initial === undefined || raw.initial === '' ? '' : label(raw.initial, maxLength);
      const placeholder = optionalLabel(raw.placeholder, 80);
      return {
        kind: 'input',
        key,
        label: label(raw.label, 60),
        ...(i18nLabel ? { i18nLabel } : {}),
        initial,
        ...(placeholder ? { placeholder } : {}),
        maxLength,
        ...(live !== undefined ? { live } : {}),
        ...(when ? { when } : {}),
      };
    }
    default:
      throw new Error('Unknown panel field kind.');
  }
}

function parsePanels(value: unknown): PluginPanelDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PLUGIN_LIMITS.maxPanelsPerPlugin) {
    throw new Error(`Declare at most ${PLUGIN_LIMITS.maxPanelsPerPlugin} panels.`);
  }
  const panels = value.map((entry): PluginPanelDeclaration => {
    const raw = record(entry);
    const id = identifier(raw.id);
    const title = label(raw.title, 60);
    const i18nTitle = parseLocaleMap(raw.i18nTitle, 60);
    const icon = raw.icon === undefined ? undefined : label(raw.icon, 32);
    if (icon && !VALID_PANEL_ICONS.has(icon)) throw new Error(`Unsupported panel icon: ${icon}`);
    const defaultWidth = raw.defaultWidth === undefined ? undefined : number(raw.defaultWidth, 220, 480);
    if (defaultWidth !== undefined && !Number.isInteger(defaultWidth)) {
      throw new Error('Panel defaultWidth must be an integer.');
    }

    if (!Array.isArray(raw.fields) || raw.fields.length < 1 || raw.fields.length > PLUGIN_LIMITS.maxPanelFieldsPerPanel) {
      throw new Error(`Panel must declare between 1 and ${PLUGIN_LIMITS.maxPanelFieldsPerPanel} fields.`);
    }
    const fields = raw.fields.map(parsePanelField);
    const fieldKeys = new Set(fields.map((f) => f.key));
    if (fieldKeys.size !== fields.length) throw new Error('Duplicate panel field key.');
    for (const f of fields) {
      if (f.when && !fieldKeys.has(f.when.key)) throw new Error(`Panel condition references unknown key: ${f.when.key}`);
    }

    const rawActions = raw.actions === undefined ? [] : raw.actions;
    if (!Array.isArray(rawActions) || rawActions.length > PLUGIN_LIMITS.maxPanelActionsPerPanel) {
      throw new Error(`Panel can declare at most ${PLUGIN_LIMITS.maxPanelActionsPerPanel} actions.`);
    }
    const actions = rawActions.map((actEntry): PluginPanelAction => {
      const act = record(actEntry);
      const variant = act.variant === undefined ? undefined : act.variant;
      if (variant !== undefined && variant !== 'primary' && variant !== 'secondary' && variant !== 'danger') {
        throw new Error('Invalid panel action variant.');
      }
      const i18nLabel = parseLocaleMap(act.i18nLabel, 60);
      return {
        id: identifier(act.id),
        label: label(act.label, 60),
        ...(i18nLabel ? { i18nLabel } : {}),
        ...(variant ? { variant } : {}),
      };
    });
    if (new Set(actions.map((a) => a.id)).size !== actions.length) throw new Error('Duplicate panel action ID.');

    return {
      id,
      title,
      ...(i18nTitle ? { i18nTitle } : {}),
      ...(icon ? { icon } : {}),
      ...(defaultWidth !== undefined ? { defaultWidth } : {}),
      fields,
      actions,
    };
  });
  if (new Set(panels.map((p) => p.id)).size !== panels.length) throw new Error('Duplicate panel ID.');
  return panels;
}

function parsePluginV1(item: Record<string, unknown>): PluginManifestV1 {
  if (
    !Array.isArray(item.permissions) ||
    item.permissions.length > PLUGIN_PERMISSIONS_V1.length ||
    !item.permissions.every((permission) => (PLUGIN_PERMISSIONS_V1 as readonly unknown[]).includes(permission)) ||
    new Set(item.permissions).size !== item.permissions.length
  ) {
    throw new Error('Invalid permissions.');
  }
  if (!Array.isArray(item.commands) || item.commands.length < 1 || item.commands.length > PLUGIN_LIMITS.maxCommandsPerPluginV1) {
    throw new Error(`Declare between 1 and ${PLUGIN_LIMITS.maxCommandsPerPluginV1} commands.`);
  }
  const commands: PluginCommandV1[] = item.commands.map((entry) => {
    const command = record(entry);
    return { id: identifier(command.id), label: label(command.label, 60) };
  });
  if (new Set(commands.map((command) => command.id)).size !== commands.length) throw new Error('Duplicate command ID.');
  if (
    typeof item.script !== 'string' ||
    !item.script.trim() ||
    new TextEncoder().encode(item.script).length > PLUGIN_LIMITS.maxPackageBytesV1
  ) {
    throw new Error('Invalid or oversized script.');
  }
  return {
    apiVersion: PLUGIN_API_VERSION_V1,
    id: identifier(item.id),
    name: label(item.name, 60),
    version: label(item.version, 30),
    author: label(item.author, 60),
    description: item.description === '' || item.description === undefined ? '' : label(item.description, 240),
    permissions: [...(item.permissions as PluginPermissionV1[])],
    commands,
    script: item.script,
  };
}

function parsePluginV2(item: Record<string, unknown>): PluginManifestV2 {
  if (
    !Array.isArray(item.permissions) ||
    item.permissions.length > PLUGIN_PERMISSIONS_V2.length ||
    !item.permissions.every((permission) => (PLUGIN_PERMISSIONS_V2 as readonly unknown[]).includes(permission)) ||
    new Set(item.permissions).size !== item.permissions.length
  ) {
    throw new Error('Invalid permissions.');
  }
  const perms = [...(item.permissions as PluginPermissionV2[])];
  const permSet = new Set<PluginPermissionV2>(perms);

  const rawCommands = item.commands === undefined ? [] : item.commands;
  if (!Array.isArray(rawCommands) || rawCommands.length > PLUGIN_LIMITS.maxCommandsPerPluginV2) {
    throw new Error(`Declare at most ${PLUGIN_LIMITS.maxCommandsPerPluginV2} commands.`);
  }
  const commands: PluginCommandV2[] = rawCommands.map((entry) => {
    const command = record(entry);
    const i18nLabel = parseLocaleMap(command.i18nLabel, 60);
    const group = optionalLabel(command.group, 40);
    const suggestedShortcut = parseShortcut(command.suggestedShortcut);
    return {
      id: identifier(command.id),
      label: label(command.label, 60),
      ...(i18nLabel ? { i18nLabel } : {}),
      ...(group ? { group } : {}),
      ...(suggestedShortcut ? { suggestedShortcut } : {}),
    };
  });
  if (new Set(commands.map((c) => c.id)).size !== commands.length) throw new Error('Duplicate command ID.');

  const filters = parseFilters(item.filters);
  const panels = parsePanels(item.panels);

  if (commands.length === 0 && filters.length === 0 && panels.length === 0) {
    throw new Error('Plugin v2 must declare at least one command, filter, or panel.');
  }
  if (commands.length > 0 && !permSet.has('commands')) {
    throw new Error('Declaring commands requires the "commands" permission.');
  }
  if (filters.length > 0 && !permSet.has('filters')) {
    throw new Error('Declaring filters requires the "filters" permission.');
  }
  if (panels.length > 0 && !permSet.has('ui:panel')) {
    throw new Error('Declaring panels requires the "ui:panel" permission.');
  }
  if (panels.some((p) => p.fields.some((f) => f.kind === 'layer')) && !permSet.has('layers:read')) {
    throw new Error('Panel "layer" field requires the "layers:read" permission.');
  }

  if (
    typeof item.script !== 'string' ||
    !item.script.trim() ||
    new TextEncoder().encode(item.script).length > PLUGIN_LIMITS.maxPackageBytesV2
  ) {
    throw new Error('Invalid or oversized script.');
  }

  const i18n = parseI18nMetadata(item.i18n);

  return {
    apiVersion: PLUGIN_API_VERSION_V2,
    id: identifier(item.id),
    name: label(item.name, 60),
    version: label(item.version, 30),
    author: label(item.author, 60),
    description: item.description === '' || item.description === undefined ? '' : label(item.description, 240),
    ...(i18n ? { i18n } : {}),
    permissions: perms,
    commands,
    filters,
    panels,
    script: item.script,
  };
}

export function parsePlugin(value: unknown): PluginManifest {
  const item = record(value);
  if (item.apiVersion === PLUGIN_API_VERSION_V1) return parsePluginV1(item);
  if (item.apiVersion === PLUGIN_API_VERSION_V2) return parsePluginV2(item);
  throw new Error('Plugin API version 1 or 2 is required.');
}

export function resolvePluginText(
  fallback: string,
  localized: PluginLocaleMap | undefined,
  language: PluginLocaleCode,
): string {
  return localized?.[language] ?? localized?.['en-US'] ?? fallback;
}

export function resolvePluginName(manifest: PluginManifest, language: PluginLocaleCode): string {
  if (manifest.apiVersion === 2) {
    return manifest.i18n?.[language]?.name ?? manifest.i18n?.['en-US']?.name ?? manifest.name;
  }
  return manifest.name;
}

export function resolvePluginDescription(manifest: PluginManifest, language: PluginLocaleCode): string {
  if (manifest.apiVersion === 2) {
    return manifest.i18n?.[language]?.description ?? manifest.i18n?.['en-US']?.description ?? manifest.description;
  }
  return manifest.description;
}

export function parsePluginAction(value: unknown, plugin: PluginManifest): PluginAction {
  const action = record(value);
  const allowed = (permission: PluginPermission) => {
    if (!(plugin.permissions as readonly PluginPermission[]).includes(permission)) {
      throw new Error(`Missing permission: ${permission}`);
    }
  };
  switch (action.kind) {
    case 'message':
      return { kind: 'message', text: label(action.text, 240) };
    case 'brush': {
      allowed('brush');
      const color = action.color === undefined ? undefined : hex(action.color);
      const size = action.size === undefined ? undefined : number(action.size, 1, 1000);
      if (color === undefined && size === undefined) throw new Error('No brush setting was provided.');
      return { kind: 'brush', color, size };
    }
    case 'layer':
      allowed('layers');
      return { kind: 'layer', name: label(action.name, 80) };
    case 'artwork': {
      allowed('artwork');
      const width = number(action.width, 1, 4096);
      const height = number(action.height, 1, 4096);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 4_194_304) {
        throw new Error('Artwork must fit within 4,194,304 pixels.');
      }
      if (!Array.isArray(action.shapes) || !action.shapes.length || action.shapes.length > 1000) {
        throw new Error('Provide between 1 and 1,000 shapes.');
      }
      const shapes = action.shapes.map((entry): Shape => {
        const shape = record(entry);
        if (shape.kind !== 'rect' && shape.kind !== 'ellipse') throw new Error('Unknown shape.');
        return {
          kind: shape.kind,
          x: number(shape.x, -4096, 4096),
          y: number(shape.y, -4096, 4096),
          width: number(shape.width, 0.01, 4096),
          height: number(shape.height, 0.01, 4096),
          color: hex(shape.color),
        };
      });
      return { kind: 'artwork', name: label(action.name, 80), width, height, shapes };
    }
    default:
      throw new Error('Unknown plugin action.');
  }
}
