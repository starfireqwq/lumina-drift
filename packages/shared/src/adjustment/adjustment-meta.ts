import { normalizeHexColor, normalizeLayerColorMeta } from '../canvas/layer-color';
import type { LayerMeta, LayerType } from '../types/models';
import { DRAW_OP_TYPES } from '../types/protocol';
import { normalizeAdjustment } from './adjustment-layer';

export function sanitizeLayerMetaForType(
  layerType: LayerType | undefined,
  meta: LayerMeta | null | undefined,
  _opts?: { requireAdjustment?: boolean },
): { ok: true; meta: LayerMeta | null | undefined } | { ok: false; error: string } {
  let sanitized = meta;
  if (layerType === 'adjustment') {
    // The adjustment is required on both creation and metadata replacement.
    const adjustment = normalizeAdjustment(meta?.adjustment);
    if (!adjustment) return { ok: false, error: '調整圖層參數無效' };
    sanitized = { ...meta, adjustment };
  } else if (meta && Object.prototype.hasOwnProperty.call(meta, 'adjustment')) {
    const { adjustment: _, ...rest } = meta;
    sanitized = rest;
  }

  if (!sanitized || (!Object.hasOwn(sanitized, 'paletteColor') && !Object.hasOwn(sanitized, 'layerColor'))) {
    return { ok: true, meta: sanitized };
  }
  const { paletteColor, layerColor, ...rest } = sanitized;
  const normalized: LayerMeta = rest;
  if (paletteColor != null && paletteColor !== '') {
    const color = normalizeHexColor(paletteColor);
    if (!color) return { ok: false, error: '圖層標籤色格式無效' };
    normalized.paletteColor = color;
  }
  if (layerType !== 'mask' && layerType !== 'adjustment' && layerColor != null) {
    const config = normalizeLayerColorMeta(layerColor);
    if (!config) return { ok: false, error: '圖層顯示顏色格式無效' };
    normalized.layerColor = config;
  }
  return { ok: true, meta: normalized };
}

export const ADJUSTMENT_PIXEL_WRITE_ERROR = '調整圖層沒有像素，無法直接繪製';

const PIXEL_OP_TYPES = new Set([...DRAW_OP_TYPES, 'FILL', 'LIQUIFY', 'TRANSFORM', 'VECTOR_EDIT', 'PLUGIN_PIXEL_EDIT']);
const PIXEL_PAYLOAD_KEYS = [
  'tiles', 'inkTiles', 'historyTiles', 'vectorStroke', 'vectorAdded', 'vectorRemoved', 'vectorRemovedIds', 'vectorReplaced',
];

export function isPixelOrVectorOp(opType: string, payload: unknown): boolean {
  return PIXEL_OP_TYPES.has(opType.toUpperCase()) ||
    (payload !== null && typeof payload === 'object' && PIXEL_PAYLOAD_KEYS.some((key) => key in payload));
}
