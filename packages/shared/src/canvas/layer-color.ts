import type { LayerModel } from '../types/models';

export interface LayerColorMeta {
  enabled: boolean;
  mainColor: string;
  subColor?: string;
}

export type PaletteColorDisplayMode = 'shared' | 'personal' | 'owner';

export interface EffectivePaletteColorResult {
  color: string | null;
  inherited: boolean;
  source: 'shared' | 'personal' | 'owner' | 'none';
}

export interface EffectiveLayerColorResult {
  config: LayerColorMeta | null;
  inherited: boolean;
  source: 'local' | 'shared' | 'none';
}

export const CSP_PALETTE_COLOR_PRESETS = [
  '#F472B6', '#FB923C', '#FACC15', '#BEF264', '#4ADE80', '#38BDF8', '#818CF8', '#C084FC',
] as const;
export const CSP_PAPER_COLOR_PRESETS = ['#FFFFFF', '#FAF6EE', '#E5E7EB', '#9CA3AF', '#262626', '#000000'] as const;
export const DEFAULT_LAYER_MAIN_COLOR = '#4A8DFF';
export const DEFAULT_LAYER_SUB_COLOR = '#FFFFFF';

const MAX_COLOR_DEPTH = 16;

export function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const hex = input.trim();
  if (/^#[0-9A-F]{6}$/i.test(hex)) return hex.toUpperCase();
  if (/^#[0-9A-F]{3}$/i.test(hex)) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toUpperCase();
  return null;
}

export function hexToRgb01(hex: string): [number, number, number] {
  const color = normalizeHexColor(hex);
  if (!color) return [0, 0, 0];
  return [
    parseInt(color.slice(1, 3), 16) / 255,
    parseInt(color.slice(3, 5), 16) / 255,
    parseInt(color.slice(5, 7), 16) / 255,
  ];
}

export function normalizeLayerColorMeta(input: unknown): LayerColorMeta | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { enabled, mainColor, subColor } = input as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return null;
  const main = normalizeHexColor(mainColor);
  if (!main) return null;
  if (subColor == null) return { enabled, mainColor: main };
  const sub = normalizeHexColor(subColor);
  return sub ? { enabled, mainColor: main, subColor: sub } : null;
}

type PaletteLayer = Pick<LayerModel, 'id' | 'parentId' | 'ownerId' | 'meta'>;
type ColorLayer = Pick<LayerModel, 'id' | 'parentId' | 'layerType' | 'meta'>;

export function resolveEffectivePaletteColor(
  layerId: string,
  layersById: ReadonlyMap<string, PaletteLayer>,
  opts: {
    displayMode: PaletteColorDisplayMode;
    localOverrides?: Readonly<Record<string, string | null | undefined>>;
    ownerColorOf?: (layer: PaletteLayer) => string | null;
  },
): EffectivePaletteColorResult {
  const none = { color: null, inherited: false, source: 'none' } as const;
  const layer = layersById.get(layerId);
  if (!layer) return none;
  if (opts.displayMode === 'owner') {
    const color = opts.ownerColorOf?.(layer) ?? null;
    return { color, inherited: false, source: color ? 'owner' : 'none' };
  }

  let shared: EffectivePaletteColorResult | undefined;
  let hasLocalOverride = false;
  let curr: PaletteLayer | undefined = layer;
  for (let depth = 0; curr && depth < MAX_COLOR_DEPTH; depth++) {
    if (opts.displayMode === 'personal') {
      const value = opts.localOverrides?.[curr.id];
      if (value === null) return none;
      if (typeof value === 'string') {
        hasLocalOverride = true;
        const color = normalizeHexColor(value);
        if (color) return { color, inherited: depth > 0, source: 'personal' };
      }
    }
    if (!shared && !hasLocalOverride) {
      const color = normalizeHexColor(curr.meta?.paletteColor);
      if (color) {
        shared = { color, inherited: depth > 0, source: 'shared' };
        if (opts.displayMode === 'shared') return shared;
      }
    }
    curr = curr.parentId ? layersById.get(curr.parentId) : undefined;
  }
  return hasLocalOverride ? none : shared ?? none;
}

export function resolveEffectiveLayerColor(
  layerId: string,
  layersById: ReadonlyMap<string, ColorLayer>,
  localOverrides?: Readonly<Record<string, LayerColorMeta | null | undefined>>,
): EffectiveLayerColorResult {
  const none = { config: null, inherited: false, source: 'none' } as const;
  let curr = layersById.get(layerId);
  if (!curr || curr.layerType === 'mask' || curr.layerType === 'adjustment') return none;

  for (let depth = 0; curr && depth < MAX_COLOR_DEPTH; depth++) {
    const local = localOverrides && Object.hasOwn(localOverrides, curr.id) ? localOverrides[curr.id] : undefined;
    if (local && typeof local === 'object') {
      if (local.enabled === false && depth === 0) return none;
      const config = normalizeLayerColorMeta(local);
      if (config?.enabled) return { config, inherited: depth > 0, source: 'local' };
    } else {
      const config = normalizeLayerColorMeta(curr.meta?.layerColor);
      if (config?.enabled) return { config, inherited: depth > 0, source: 'shared' };
    }
    const parent: ColorLayer | undefined = curr.parentId ? layersById.get(curr.parentId) : undefined;
    curr = parent?.layerType === 'group' ? parent : undefined;
  }
  return none;
}

export function applyLayerColorToImageData(data: Uint8ClampedArray, mainHex: string, subHex = DEFAULT_LAYER_SUB_COLOR): void {
  const [mainR, mainG, mainB] = hexToRgb01(mainHex).map((channel) => channel * 255);
  const [subR, subG, subB] = hexToRgb01(subHex).map((channel) => channel * 255);
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const luma = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    data[i] = Math.round(mainR + (subR - mainR) * luma);
    data[i + 1] = Math.round(mainG + (subG - mainG) * luma);
    data[i + 2] = Math.round(mainB + (subB - mainB) * luma);
  }
}
