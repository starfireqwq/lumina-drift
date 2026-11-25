import type { SelectionMaskData } from '@atelier/shared';

export type SelectionCombineOpMode = 'replace' | 'add' | 'subtract';

export function computeMarqueeRect(
  start: { x: number; y: number },
  current: { x: number; y: number },
  options?: { square?: boolean; fromCenter?: boolean },
): { x: number; y: number; width: number; height: number } {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (options?.square) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx) * size;
    dy = Math.sign(dy) * size;
  }
  const width = Math.abs(dx);
  const height = Math.abs(dy);
  if (options?.fromCenter) {
    return { x: start.x - width, y: start.y - height, width: width * 2, height: height * 2 };
  }
  return { x: start.x + Math.min(0, dx), y: start.y + Math.min(0, dy), width, height };
}

export function computeMaskBoundsAndCount(
  data: Uint8Array,
  width: number,
  height: number,
): SelectionMaskData {
  let activePixelCount = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      if (data[rowOff + x] > 0) {
        activePixelCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    width,
    height,
    data,
    activePixelCount,
    bounds: activePixelCount > 0 ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
}

export function combineSelectionMasks(
  prev: SelectionMaskData | null,
  next: SelectionMaskData,
  mode: SelectionCombineOpMode,
): SelectionMaskData {
  const w = next.width;
  const h = next.height;
  if (mode === 'replace' || !prev || prev.activePixelCount === 0) {
    if (mode === 'subtract') {
      return {
        width: w,
        height: h,
        data: new Uint8Array(w * h),
        activePixelCount: 0,
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      };
    }
    return next;
  }
  const data = new Uint8Array(prev.data);
  const scan =
    mode === 'add'
      ? {
          minX: Math.min(prev.bounds.minX, next.bounds.minX),
          minY: Math.min(prev.bounds.minY, next.bounds.minY),
          maxX: Math.max(prev.bounds.maxX, next.bounds.maxX),
          maxY: Math.max(prev.bounds.maxY, next.bounds.maxY),
        }
      : prev.bounds;

  let count = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = Math.max(0, scan.minY); y <= Math.min(h - 1, scan.maxY); y++) {
    for (let x = Math.max(0, scan.minX); x <= Math.min(w - 1, scan.maxX); x++) {
      const i = y * w + x;
      const v =
        mode === 'add'
          ? Math.max(data[i], next.data[i])
          : Math.round(data[i] * (1 - next.data[i] / 255));
      data[i] = v;
      if (v > 0) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    width: w,
    height: h,
    data,
    activePixelCount: count,
    bounds: count > 0 ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
}

export function rasterizeRectMask(
  x: number,
  y: number,
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
): SelectionMaskData {
  const data = new Uint8Array(canvasWidth * canvasHeight);
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(canvasWidth, Math.floor(x + width));
  const y1 = Math.min(canvasHeight, Math.floor(y + height));
  if (x1 <= x0 || y1 <= y0) {
    return {
      width: canvasWidth,
      height: canvasHeight,
      data,
      activePixelCount: 0,
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    };
  }
  for (let py = y0; py < y1; py++) {
    data.fill(255, py * canvasWidth + x0, py * canvasWidth + x1);
  }
  return {
    width: canvasWidth,
    height: canvasHeight,
    data,
    activePixelCount: (x1 - x0) * (y1 - y0),
    bounds: { minX: x0, minY: y0, maxX: x1 - 1, maxY: y1 - 1 },
  };
}

export function rasterizeEllipseMask(
  x: number,
  y: number,
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
  antialias = false,
): SelectionMaskData {
  const data = new Uint8Array(canvasWidth * canvasHeight);
  const rx = width / 2;
  const ry = height / 2;
  if (rx <= 0 || ry <= 0) {
    return {
      width: canvasWidth,
      height: canvasHeight,
      data,
      activePixelCount: 0,
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    };
  }
  const cx = x + rx;
  const cy = y + ry;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(canvasWidth, Math.ceil(x + width));
  const y1 = Math.min(canvasHeight, Math.ceil(y + height));

  let count = 0;
  let minX = canvasWidth;
  let minY = canvasHeight;
  let maxX = -1;
  let maxY = -1;

  for (let py = y0; py < y1; py++) {
    const dy = (py + 0.5 - cy) / ry;
    const dy2 = dy * dy;
    if (!antialias && dy2 > 1) continue;
    const rowOff = py * canvasWidth;
    for (let px = x0; px < x1; px++) {
      const dx = (px + 0.5 - cx) / rx;
      const coverage = antialias ? ellipsePixelCoverage(px + 0.5 - cx, py + 0.5 - cy, rx, ry) : (dx * dx + dy2 <= 1 ? 255 : 0);
      if (coverage > 0) {
        data[rowOff + px] = coverage;
        count++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }
  return {
    width: canvasWidth,
    height: canvasHeight,
    data,
    activePixelCount: count,
    bounds: count > 0 ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
}

function ellipsePixelCoverage(x: number, y: number, rx: number, ry: number): number {
  const farX = (Math.abs(x) + 0.375) / rx;
  const farY = (Math.abs(y) + 0.375) / ry;
  if (farX * farX + farY * farY <= 1) return 255;
  const nearX = Math.max(0, Math.abs(x) - 0.375) / rx;
  const nearY = Math.max(0, Math.abs(y) - 0.375) / ry;
  if (nearX * nearX + nearY * nearY > 1) return 0;

  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    const dy = (y + (sy - 1.5) / 4) / ry;
    for (let sx = 0; sx < 4; sx++) {
      const dx = (x + (sx - 1.5) / 4) / rx;
      if (dx * dx + dy * dy <= 1) hits++;
    }
  }
  return Math.round(hits * 255 / 16);
}

export function applySelectionPostProcess(mask: SelectionMaskData, featherRadius: number): SelectionMaskData {
  if (!(featherRadius >= 1) || !Number.isFinite(featherRadius)) return mask;
  const { data, width, height } = mask;
  return computeMaskBoundsAndCount(featherMaskBuffer(data, width, height, featherRadius), width, height);
}

export function readMaskSubRect(
  mask: SelectionMaskData | null,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8Array | null {
  if (!mask || mask.activePixelCount <= 0) return null;
  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= mask.height) continue;
    const srcStart = sy * mask.width + x;
    const dstStart = row * width;
    const copyLen = Math.min(width, Math.max(0, mask.width - x));
    if (copyLen > 0 && x >= 0) {
      out.set(mask.data.subarray(srcStart, srcStart + copyLen), dstStart);
    }
  }
  return out;
}

/**
 * Applies a sub-rectangle mask patch onto an existing canvas selection mask.
 * - 'replace': overwrites only the target rect (allowing tiled writes across large canvases).
 * - 'add': takes max(existing, patch) within rect.
 * - 'subtract': attenuates existing coverage by (1 - patch / 255) within rect.
 */
export function applyMaskRectPatch(
  prev: SelectionMaskData | null,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
  patch: Uint8Array,
  mode: SelectionCombineOpMode = 'replace',
): SelectionMaskData {
  const full = prev && prev.activePixelCount > 0 ? new Uint8Array(prev.data) : new Uint8Array(canvasWidth * canvasHeight);
  for (let row = 0; row < height; row++) {
    const gy = y + row;
    if (gy < 0 || gy >= canvasHeight) continue;
    const dstRow = gy * canvasWidth;
    const srcRow = row * width;
    for (let col = 0; col < width; col++) {
      const gx = x + col;
      if (gx < 0 || gx >= canvasWidth) continue;
      const dstIdx = dstRow + gx;
      const val = patch[srcRow + col];
      if (mode === 'replace') {
        full[dstIdx] = val;
      } else if (mode === 'add') {
        if (val > full[dstIdx]) full[dstIdx] = val;
      } else {
        full[dstIdx] = Math.round(full[dstIdx] * (1 - val / 255));
      }
    }
  }
  return computeMaskBoundsAndCount(full, canvasWidth, canvasHeight);
}

/** 3-pass separable box blur approximating Gaussian feathering (matches SelectionEngine.featherSelection) */
export function featherMaskBuffer(data: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const r = Math.round(radius);
  if (r < 1) return data.slice();
  let src = new Float32Array(data);
  let dst = new Float32Array(src.length);
  const pass = (horizontal: boolean) => {
    const lines = horizontal ? height : width;
    const len = horizontal ? width : height;
    const at = (line: number, k: number) => (horizontal ? line * width + k : k * width + line);
    for (let line = 0; line < lines; line++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[at(line, Math.min(len - 1, Math.max(0, k)))];
      for (let k = 0; k < len; k++) {
        dst[at(line, k)] = sum / (2 * r + 1);
        sum += src[at(line, Math.min(len - 1, k + r + 1))] - src[at(line, Math.max(0, k - r))];
      }
    }
    [src, dst] = [dst, src];
  };
  for (let i = 0; i < 3; i++) {
    pass(true);
    pass(false);
  }
  return Uint8Array.from(src, (v) => Math.max(0, Math.min(255, Math.round(v))));
}
