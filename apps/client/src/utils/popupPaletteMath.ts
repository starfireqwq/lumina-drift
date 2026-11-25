export interface PopupPalettePosition {
  cx: number;
  cy: number;
  clampedX: boolean;
  clampedY: boolean;
  clamped: boolean;
}

export function computePopupPalettePosition(
  anchorX: number,
  anchorY: number,
  paletteRadius: number,
  viewportW: number,
  viewportH: number,
  margin = 16,
): PopupPalettePosition {
  const width = Number.isFinite(viewportW) ? Math.max(0, viewportW) : 0;
  const height = Number.isFinite(viewportH) ? Math.max(0, viewportH) : 0;
  const inset = Math.max(0, paletteRadius) + Math.max(0, margin);
  const useCenter = ![anchorX, anchorY, paletteRadius, viewportW, viewportH, margin].every(Number.isFinite);

  const cx = useCenter || width / 2 <= inset
    ? width / 2
    : Math.max(inset, Math.min(width - inset, anchorX));
  const cy = useCenter || height / 2 <= inset
    ? height / 2
    : Math.max(inset, Math.min(height - inset, anchorY));
  const clampedX = cx !== anchorX;
  const clampedY = cy !== anchorY;

  return { cx, cy, clampedX, clampedY, clamped: clampedX || clampedY };
}

export interface RadialSlotPoint {
  x: number;
  y: number;
  angleDeg: number;
}

export function computeRadialSlotPositions(
  cx: number,
  cy: number,
  ringRadius: number,
  count: number,
  startAngleDeg = -90,
): RadialSlotPoint[] {
  if (!Number.isSafeInteger(count) || count <= 0) return [];

  const slotAngle = 360 / count;
  return Array.from({ length: count }, (_, index) => {
    const angleDeg = startAngleDeg + index * slotAngle;
    const radians = (angleDeg % 360) * (Math.PI / 180);
    return {
      x: cx + ringRadius * Math.cos(radians),
      y: cy + ringRadius * Math.sin(radians),
      angleDeg,
    };
  });
}

export function hitTestPopupRing(
  dx: number,
  dy: number,
  innerRadius: number,
  outerRadius: number,
  slotCount: number,
  startAngleDeg = -90,
): number | null {
  if (!Number.isSafeInteger(slotCount) || slotCount <= 0 || !Number.isFinite(startAngleDeg)) return null;

  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || !(innerRadius <= distance && distance <= outerRadius)) return null;

  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const slotAngle = 360 / slotCount;
  const index = Math.round((angleDeg - (startAngleDeg % 360)) / slotAngle) % slotCount;
  if (index === 0) return 0;
  return index < 0 ? index + slotCount : index;
}
