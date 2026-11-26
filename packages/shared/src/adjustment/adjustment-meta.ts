import type { LayerMeta, LayerType } from '../types/models';
import { DRAW_OP_TYPES } from '../types/protocol';
import { normalizeAdjustment } from './adjustment-layer';

export function sanitizeLayerMetaForType(
  layerType: LayerType | undefined,
  meta: LayerMeta | null | undefined,
  _opts?: { requireAdjustment?: boolean },
): { ok: true; meta: LayerMeta | null | undefined } | { ok: false; error: string } {
  if (layerType === 'adjustment') {
    // The adjustment is required on both creation and metadata replacement.
    const adjustment = normalizeAdjustment(meta?.adjustment);
    if (!adjustment) return { ok: false, error: '調整圖層參數無效' };
    return { ok: true, meta: { ...meta, adjustment } };
  }
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'adjustment')) {
    const { adjustment: _, ...rest } = meta;
    return { ok: true, meta: rest };
  }
  return { ok: true, meta };
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
