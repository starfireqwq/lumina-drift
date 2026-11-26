import {
  buildGradientLUT, normalizeAdjustment,
  type AdjustmentCurvePoint, type GradientMapStop, type LayerAdjustment, type LayerModel, type ScopedUndoOp,
} from '@atelier/shared';

export function nextAdjustmentLayerName(name: string, layers: readonly Pick<LayerModel, 'name'>[]): string {
  const prefix = `${name} `;
  let last = 0;
  for (const layer of layers) {
    if (!layer.name.startsWith(prefix)) continue;
    const suffix = layer.name.slice(prefix.length);
    const number = Number(suffix);
    if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER) {
      last = Math.max(last, number);
    }
  }
  return prefix + (last + 1);
}

export function adjustmentParamsKey(raw: unknown): string {
  return JSON.stringify(normalizeAdjustment(raw));
}

export function buildAdjustmentEditUndo(
  layer: Pick<LayerModel, 'id' | 'meta'>, adjustment: LayerAdjustment, userId: string,
  desc: string, opId: string, timestamp: number,
): (ScopedUndoOp & { metaAfter: NonNullable<LayerModel['meta']> }) | null {
  const normalized = normalizeAdjustment(adjustment);
  if (!normalized || adjustmentParamsKey(layer.meta?.adjustment) === JSON.stringify(normalized)) return null;
  return {
    opId, timestamp, userId, layerId: layer.id, opType: 'ADJUSTMENT', desc,
    beforeTiles: [], afterTiles: [],
    metaBefore: layer.meta ?? null,
    metaAfter: { ...layer.meta, adjustment: normalized },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function editCurvePoint(
  points: AdjustmentCurvePoint[], index: number, point: AdjustmentCurvePoint | null,
): AdjustmentCurvePoint[] {
  const last = points.length - 1;
  if (point === null) return index > 0 && index < last ? points.filter((_, i) => i !== index) : points;

  const y = clamp(Math.round(point.y), 0, 255);
  const x = clamp(Math.round(point.x), 0, 255);
  if (index === -1) {
    if (points.length >= 16 || points.some((p) => p.x === x)) return points;
    return [...points, { x, y }].sort((a, b) => a.x - b.x);
  }
  if (index < 0 || index > last) return points;
  const movedX = index === 0 || index === last
    ? points[index].x
    : clamp(x, points[index - 1].x + 1, points[index + 1].x - 1);
  return points.map((p, i) => i === index ? { x: movedX, y } : p);
}

export function editGradientStop(
  stops: GradientMapStop[], index: number, offset: number | null,
): GradientMapStop[] {
  if (offset === null) {
    return stops.length > 2 && stops[index] ? stops.filter((_, i) => i !== index) : stops;
  }
  const tick = Math.round(clamp(offset, 0, 1) * 1000);
  if (index === -1) {
    if (stops.length >= 16 || stops.some((stop) => Math.round(stop.offset * 1000) === tick)) return stops;
    const lut = buildGradientLUT(stops);
    const start = Math.round(tick * 255 / 1000) * 4;
    const color = '#' + Array.from(lut.subarray(start, start + 3), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return [...stops, { offset: tick / 1000, color }].sort((a, b) => a.offset - b.offset);
  }
  if (!stops[index]) return stops;
  const min = index > 0 ? Math.round(stops[index - 1].offset * 1000) + 1 : 0;
  const max = index < stops.length - 1 ? Math.round(stops[index + 1].offset * 1000) - 1 : 1000;
  return stops.map((stop, i) => i === index ? { ...stop, offset: clamp(tick, min, max) / 1000 } : stop);
}
