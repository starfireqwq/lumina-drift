export function computeProportionalThumbSize(
  canvasWidth: number,
  canvasHeight: number,
  maxSide = 64,
): { width: number; height: number } {
  const side = Number.isFinite(maxSide) ? Math.max(1, Math.round(maxSide)) : 64;
  if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) {
    return { width: side, height: side };
  }
  const scale = side / Math.max(canvasWidth, canvasHeight);
  const minSide = Math.min(12, side);
  return {
    width: Math.max(minSide, Math.round(canvasWidth * scale)),
    height: Math.max(minSide, Math.round(canvasHeight * scale)),
  };
}
