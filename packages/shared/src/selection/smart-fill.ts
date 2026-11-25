/**
 * AI Smart Enclose & Fill (智能閉合線稿填色 / Auto-Flatting Engine)
 *
 * Implements:
 * 1. Lasso-style boundary encirclement
 * 2. Reference layer lineart sampling (transparent or white-canvas lineart)
 * 3. Morphological gap-closing algorithm (bridges small line breaks)
 * 4. Dual-phase exterior flood isolation to capture fully or nearly closed regions
 * 5. Under-lineart expansion (dilation) to tuck fill under lineart borders seamlessly
 */

import { pointInPolygon, SelectionMaskData } from './selection-mask';

export interface SmartFillOptions {
  gapClosingRadius?: number; // 0..10 px (gap bridging)
  expandRadius?: number; // 0..6 px (tuck under lineart)
  lineThreshold?: number; // 0..255 (line detection sensitivity)
  isWhiteBackgroundLineart?: boolean;
}

type StrokePoint = { x: number; y: number };
type PixelBuffer = Uint8Array | Uint8ClampedArray;

export interface PaintUnfilledAreaOptions {
  brushRadius: number;
  gapClosingRadius?: number;
  expandRadius?: number;
  lineThreshold?: number;
  alphaThreshold?: number;
  isWhiteBackgroundLineart?: boolean;
  editPixels?: PixelBuffer;
}

function detectWhiteBackground(
  pixels: PixelBuffer, width: number, minX: number, minY: number, maxX: number, maxY: number,
): boolean {
  let opaqueWhite = 0;
  for (let x = minX; x <= maxX; x++) {
    for (const y of [minY, maxY]) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] > 240 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 245) opaqueWhite++;
    }
  }
  return opaqueWhite > (maxX - minX + 1) * 2 * 0.6;
}

/**
 * Executes AI Smart Enclose & Fill on a reference lineart layer.
 *
 * @param lassoPoints Polygonal path drawn by the artist encircling the target region
 * @param refPixels RGBA flat pixel buffer of the reference lineart layer
 * @param width Canvas width
 * @param height Canvas height
 * @param options Smart fill tuning options (gap closing, under-line expansion)
 */
export function computeSmartEncloseFillMask(
  lassoPoints: Array<{ x: number; y: number }>,
  refPixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: SmartFillOptions = {}
): SelectionMaskData {
  const {
    gapClosingRadius = 4,
    expandRadius = 2,
    lineThreshold = 180,
    isWhiteBackgroundLineart,
  } = options;

  const emptyMask = new Uint8Array(width * height);
  if (lassoPoints.length < 3) {
    return {
      width,
      height,
      data: emptyMask,
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      activePixelCount: 0,
    };
  }

  // 1. Calculate lasso bounding box with safety padding for gap closing & expansion
  const padding = Math.max(8, (gapClosingRadius + expandRadius) * 2);
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (const pt of lassoPoints) {
    if (pt.x < minX) minX = Math.floor(pt.x);
    if (pt.y < minY) minY = Math.floor(pt.y);
    if (pt.x > maxX) maxX = Math.ceil(pt.x);
    if (pt.y > maxY) maxY = Math.ceil(pt.y);
  }

  const bMinX = Math.max(0, minX - padding);
  const bMinY = Math.max(0, minY - padding);
  const bMaxX = Math.min(width - 1, maxX + padding);
  const bMaxY = Math.min(height - 1, maxY + padding);

  const bW = bMaxX - bMinX + 1;
  const bH = bMaxY - bMinY + 1;
  const bSize = bW * bH;

  if (bW <= 0 || bH <= 0 || bSize <= 0) {
    return {
      width,
      height,
      data: emptyMask,
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      activePixelCount: 0,
    };
  }

  // 2. Extract lineart mask L within bounding box (1 = line, 0 = non-line)
  // Opaque white reference layers need contrast detection, not alpha detection.
  const whiteBackground = isWhiteBackgroundLineart ?? detectWhiteBackground(refPixels, width, bMinX, bMinY, bMaxX, bMaxY);
  const lineMask = new Uint8Array(bSize);
  for (let by = 0; by < bH; by++) {
    const gy = bMinY + by;
    const rowOffset = gy * width;
    for (let bx = 0; bx < bW; bx++) {
      const gx = bMinX + bx;
      const pixelIdx = (rowOffset + gx) * 4;

      const r = refPixels[pixelIdx];
      const g = refPixels[pixelIdx + 1];
      const b = refPixels[pixelIdx + 2];
      const a = refPixels[pixelIdx + 3];

      let isLine = false;
      if (whiteBackground) {
        // Pale coloured and antialiased strokes still form a boundary on white.
        const contrast = (255 - Math.min(r, g, b)) * a / 255;
        isLine = contrast >= Math.max(8, (255 - lineThreshold) * 0.2);
      } else {
        // Standard digital painting transparent lineart: any visible ink stroke
        if (a > 30) {
          const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
          isLine = a > 80 || luminance < lineThreshold;
        }
      }

      if (isLine) {
        lineMask[by * bW + bx] = 1;
      }
    }
  }

  // 3. Morphological gap-closing on lineart (Dilation then Erosion)
  // This seals small line breaks up to gapClosingRadius so color doesn't leak
  let closedLineMask = lineMask;
  if (gapClosingRadius > 0) {
    const r = Math.min(8, Math.round(gapClosingRadius));
    // Dilation
    const dilated = new Uint8Array(bSize);
    for (let by = 0; by < bH; by++) {
      for (let bx = 0; bx < bW; bx++) {
        if (lineMask[by * bW + bx] === 1) {
          dilated[by * bW + bx] = 1;
          continue;
        }
        let hit = false;
        const sMinY = Math.max(0, by - r);
        const sMaxY = Math.min(bH - 1, by + r);
        const sMinX = Math.max(0, bx - r);
        const sMaxX = Math.min(bW - 1, bx + r);

        for (let ny = sMinY; ny <= sMaxY && !hit; ny++) {
          for (let nx = sMinX; nx <= sMaxX && !hit; nx++) {
            if (lineMask[ny * bW + nx] === 1) {
              hit = true;
            }
          }
        }
        if (hit) dilated[by * bW + bx] = 1;
      }
    }

    // Erosion back to original line boundaries while preserving bridged gaps
    closedLineMask = new Uint8Array(bSize);
    for (let by = 0; by < bH; by++) {
      for (let bx = 0; bx < bW; bx++) {
        if (dilated[by * bW + bx] === 0) continue;
        let touchesVoid = false;
        const sMinY = Math.max(0, by - r);
        const sMaxY = Math.min(bH - 1, by + r);
        const sMinX = Math.max(0, bx - r);
        const sMaxX = Math.min(bW - 1, bx + r);

        for (let ny = sMinY; ny <= sMaxY && !touchesVoid; ny++) {
          for (let nx = sMinX; nx <= sMaxX && !touchesVoid; nx++) {
            if (dilated[ny * bW + nx] === 0) {
              touchesVoid = true;
            }
          }
        }
        if (!touchesVoid || lineMask[by * bW + bx]) {
          closedLineMask[by * bW + bx] = 1;
        }
      }
    }
  }

  // 4. Rasterize lasso polygon inside bounding box
  const inLasso = new Uint8Array(bSize);
  for (let by = 0; by < bH; by++) {
    const gy = bMinY + by;
    for (let bx = 0; bx < bW; bx++) {
      const gx = bMinX + bx;
      if (pointInPolygon(gx + 0.5, gy + 0.5, lassoPoints)) {
        inLasso[by * bW + bx] = 1;
      }
    }
  }

  // 5. Dual-Phase Exterior Flood Isolation:
  // Non-line pixels connected to the boundary of the bounding box or outside the lasso
  // are marked as EXTERIOR (cannot be an enclosed cell).
  const exterior = new Uint8Array(bSize);
  const queue = new Int32Array(bSize * 2);
  let head = 0;
  let tail = 0;

  // Initialize BFS from all bounding box edges and non-lasso areas
  for (let by = 0; by < bH; by++) {
    for (let bx = 0; bx < bW; bx++) {
      const idx = by * bW + bx;
      const isEdge = by === 0 || by === bH - 1 || bx === 0 || bx === bW - 1;
      const isOutsideLasso = inLasso[idx] === 0;

      if ((isEdge || isOutsideLasso) && closedLineMask[idx] === 0 && exterior[idx] === 0) {
        exterior[idx] = 1;
        queue[tail++] = bx;
        queue[tail++] = by;
      }
    }
  }

  // Flood fill outwards through non-line pixels
  while (head < tail) {
    const cx = queue[head++];
    const cy = queue[head++];

    const neighbors = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ];

    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < bW && ny >= 0 && ny < bH) {
        const nIdx = ny * bW + nx;
        if (exterior[nIdx] === 0 && closedLineMask[nIdx] === 0) {
          exterior[nIdx] = 1;
          queue[tail++] = nx;
          queue[tail++] = ny;
        }
      }
    }
  }

  // 6. Identify enclosed target regions:
  // Pixels strictly inside lasso, not reached by exterior flood, and not part of the original line
  const enclosed = new Uint8Array(bSize);
  for (let by = 0; by < bH; by++) {
    for (let bx = 0; bx < bW; bx++) {
      const idx = by * bW + bx;
      if (inLasso[idx] === 1 && exterior[idx] === 0 && closedLineMask[idx] === 0) {
        enclosed[idx] = 1;
      }
    }
  }

  // 7. Under-Lineart Expansion (Dilation):
  // Expands the fill mask under the lineart borders to eliminate uncolored white fringes
  const finalMask = new Uint8Array(width * height);
  let resMinX = width;
  let resMinY = height;
  let resMaxX = 0;
  let resMaxY = 0;
  let activeCount = 0;

  const expRad = Math.max(0, Math.min(6, Math.round(expandRadius)));

  for (let by = 0; by < bH; by++) {
    const gy = bMinY + by;
    for (let bx = 0; bx < bW; bx++) {
      const idx = by * bW + bx;

      let isFilled = enclosed[idx] === 1;

      // Expand into nearby line pixels or enclosed edges
      if (!isFilled && expRad > 0 && inLasso[idx] === 1 && closedLineMask[idx] === 1) {
        const sMinY = Math.max(0, by - expRad);
        const sMaxY = Math.min(bH - 1, by + expRad);
        const sMinX = Math.max(0, bx - expRad);
        const sMaxX = Math.min(bW - 1, bx + expRad);

        for (let ny = sMinY; ny <= sMaxY && !isFilled; ny++) {
          for (let nx = sMinX; nx <= sMaxX && !isFilled; nx++) {
            if (enclosed[ny * bW + nx] === 1) {
              if (Math.hypot(nx - bx, ny - by) <= expRad) {
                isFilled = true;
              }
            }
          }
        }
      }

      if (isFilled) {
        const gx = bMinX + bx;
        const gIdx = gy * width + gx;
        finalMask[gIdx] = 255;
        activeCount++;

        if (gx < resMinX) resMinX = gx;
        if (gx > resMaxX) resMaxX = gx;
        if (gy < resMinY) resMinY = gy;
        if (gy > resMaxY) resMaxY = gy;
      }
    }
  }

  return {
    width,
    height,
    data: finalMask,
    bounds:
      activeCount > 0
        ? { minX: resMinX, minY: resMinY, maxX: resMaxX, maxY: resMaxY }
        : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    activePixelCount: activeCount,
  };
}

/** Inclusive canvas coordinates for the fill solver and its reference readback. */
export function getPaintUnfilledAreaBounds(
  strokePoints: StrokePoint[],
  width: number,
  height: number,
  { brushRadius, gapClosingRadius = 0, expandRadius = 0 }: PaintUnfilledAreaOptions,
): SelectionMaskData['bounds'] | null {
  const padding = Math.max(1, brushRadius) + Math.max(64,
    Math.min(6, Math.abs(expandRadius)) + Math.max(0, Math.min(10, gapClosingRadius)) * 2 + 8);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const { x, y } of strokePoints) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  const minX = Math.max(0, Math.floor(left - padding));
  const minY = Math.max(0, Math.floor(top - padding));
  const maxX = Math.min(width - 1, Math.ceil(right + padding));
  const maxY = Math.min(height - 1, Math.ceil(bottom + padding));
  return minX <= maxX && minY <= maxY ? { minX, minY, maxX, maxY } : null;
}

function closeBarriers(barriers: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (!radius) return barriers;
  const scratch = new Uint8Array(barriers.length);
  const closed = new Uint8Array(barriers.length);

  function sweep(
    source: Uint8Array, target: Uint8Array, lines: number, length: number, lineStep: number, step: number, erode: boolean,
  ) {
    for (let line = 0; line < lines; line++) {
      const start = line * lineStep;
      let count = 0;
      let windowSize = 0;
      for (let i = 0; i < Math.min(radius, length); i++) {
        count += source[start + i * step];
        windowSize++;
      }
      for (let i = 0; i < length; i++) {
        if (i + radius < length) {
          count += source[start + (i + radius) * step];
          windowSize++;
        }
        target[start + i * step] = Number(erode ? count === windowSize : count > 0);
        if (i >= radius) {
          count -= source[start + (i - radius) * step];
          windowSize--;
        }
      }
    }
  }

  sweep(barriers, scratch, height, width, width, 1, false);
  sweep(scratch, closed, width, height, 1, width, false);
  sweep(closed, scratch, height, width, width, 1, true);
  sweep(scratch, closed, width, height, 1, width, true);
  for (let i = 0; i < closed.length; i++) closed[i] |= barriers[i];
  return closed;
}

/** Rasterize the union of segment capsules as horizontal spans, including the round ends. */
function rasterizeBrush(
  points: StrokePoint[], bounds: SelectionMaskData['bounds'], width: number, height: number,
  radius: number, spans: Int32Array,
): Uint8Array {
  const radiusSq = radius * radius;
  const brush = new Uint8Array(spans.length);
  const { minX, minY } = bounds;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (i > 0 && !lengthSq) continue;
    const length = Math.sqrt(lengthSq);
    const nx = length ? (-dy / length) * radius : 0;
    const ny = length ? (dx / length) * radius : 0;
    const first = Math.max(minY, Math.ceil(Math.min(a.y, b.y) - radius));
    const last = Math.min(minY + height - 1, Math.floor(Math.max(a.y, b.y) + radius));
    for (let y = first; y <= last; y++) {
      let left = Infinity, right = -Infinity;
      const da = y - a.y;
      const db = y - b.y;
      if (da * da <= radiusSq) {
        const half = Math.sqrt(radiusSq - da * da);
        left = a.x - half;
        right = a.x + half;
      }
      if (db * db <= radiusSq) {
        const half = Math.sqrt(radiusSq - db * db);
        left = Math.min(left, b.x - half);
        right = Math.max(right, b.x + half);
      }
      if (dy !== 0) {
        for (let side = -1; side <= 1; side += 2) {
          const t = (da - side * ny) / dy;
          if (t < 0 || t > 1) continue;
          const x = a.x + t * dx + side * nx;
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
      // The capsule is convex. Only the two endpoints of each span need a distance check.
      if (left > right) continue;
      const inside = (x: number) => {
        const ax = x - a.x;
        const t = lengthSq ? Math.max(0, Math.min(1, (ax * dx + da * dy) / lengthSq)) : 0;
        return (ax - t * dx) ** 2 + (da - t * dy) ** 2 <= radiusSq;
      };
      let start = Math.max(minX, Math.floor(left));
      let end = Math.min(minX + width - 1, Math.ceil(right));
      while (start <= end && !inside(start)) start++;
      while (end >= start && !inside(end)) end--;
      if (start > end) continue;
      const row = (y - minY) * width;
      spans[row + start - minX]++;
      if (end - minX + 1 < width) spans[row + end - minX + 1]--;
    }
  }
  for (let y = 0; y < height; y++) {
    let coverage = 0;
    for (let i = y * width; i < (y + 1) * width; i++) {
      coverage += spans[i];
      brush[i] = Number(coverage > 0);
    }
  }
  return brush;
}

export function computePaintUnfilledAreaMask(
  strokePoints: StrokePoint[],
  refPixels: PixelBuffer,
  width: number,
  height: number,
  options: PaintUnfilledAreaOptions,
): SelectionMaskData {
  const result: SelectionMaskData = {
    width, height, data: new Uint8Array(width * height),
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, activePixelCount: 0,
  };
  const roi = getPaintUnfilledAreaBounds(strokePoints, width, height, options);
  if (!roi) return result;

  const { minX, minY, maxX, maxY } = roi;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const size = w * h;
  const {
    gapClosingRadius = 0, expandRadius = 0, alphaThreshold = 30, lineThreshold = 180, editPixels,
  } = options;
  const white = options.isWhiteBackgroundLineart ?? detectWhiteBackground(refPixels, width, minX, minY, maxX, maxY);
  const contrast = Math.max(8, (255 - lineThreshold) * 0.2);
  const barriers = new Uint8Array(size);
  const editFilled = editPixels ? new Uint8Array(size) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((minY + y) * width + minX + x) * 4;
      const alpha = refPixels[i + 3];
      const editAlpha = editPixels?.[i + 3] ?? 0;
      const isEditFilled = white ? editAlpha > 0 : editAlpha > alphaThreshold;
      if (editFilled && isEditFilled) editFilled[y * w + x] = 1;
      barriers[y * w + x] = Number(white
        ? (255 - Math.min(refPixels[i], refPixels[i + 1], refPixels[i + 2])) * alpha / 255 >= contrast || isEditFilled
        : alpha > alphaThreshold || isEditFilled);
    }
  }
  const closed = closeBarriers(barriers, w, h, Math.max(0, Math.min(10, Math.round(gapClosingRadius))));
  const queue = new Int32Array(size);
  const brush = rasterizeBrush(strokePoints, roi, w, h, Math.max(1, options.brushRadius), queue);
  const exterior = new Uint8Array(size);
  let filled: Uint8Array = new Uint8Array(size);
  let tail = 0;

  function enqueue(i: number, visited: Uint8Array, blocked?: Uint8Array) {
    if (closed[i] || visited[i] || blocked?.[i]) return;
    visited[i] = 1;
    queue[tail++] = i;
  }

  function flood(visited: Uint8Array, blocked?: Uint8Array) {
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const x = i % w;
      if (x > 0) enqueue(i - 1, visited, blocked);
      if (x < w - 1) enqueue(i + 1, visited, blocked);
      if (i >= w) enqueue(i - w, visited, blocked);
      if (i < size - w) enqueue(i + w, visited, blocked);
    }
  }

  for (let x = 0; x < w; x++) {
    enqueue(x, exterior);
    enqueue(size - w + x, exterior);
  }
  for (let row = w; row < size - w; row += w) {
    enqueue(row, exterior);
    enqueue(row + w - 1, exterior);
  }
  flood(exterior);

  tail = 0;
  for (let i = 0; i < size; i++) {
    if (brush[i]) enqueue(i, filled, exterior);
  }
  if (!tail) return result;
  flood(filled, exterior);

  const steps = Math.min(6, Math.round(Math.abs(expandRadius)));
  if (steps) {
    let next = brush;
    const expand = expandRadius > 0;
    for (let step = 0; step < steps; step++) {
      for (let i = 0; i < size; i++) {
        const x = i % w;
        const left = x > 0 && filled[i - 1];
        const right = x < w - 1 && filled[i + 1];
        const up = i >= w && filled[i - w];
        const down = i < size - w && filled[i + w];
        // Tuck under lineart barriers without entering open exterior, another pocket, or already-filled edit pixels.
        next[i] = Number(expand
          ? filled[i] || (closed[i] && !exterior[i] && !editFilled?.[i] && (left || right || up || down))
          : filled[i] && left && right && up && down);
      }
      [filled, next] = [next, filled];
    }
  }

  const bounds = { minX: width, minY: height, maxX: 0, maxY: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled[y * w + x]) continue;
      const gx = minX + x;
      const gy = minY + y;
      result.data[gy * width + gx] = 255;
      result.activePixelCount++;
      bounds.minX = Math.min(bounds.minX, gx);
      bounds.minY = Math.min(bounds.minY, gy);
      bounds.maxX = Math.max(bounds.maxX, gx);
      bounds.maxY = Math.max(bounds.maxY, gy);
    }
  }
  if (result.activePixelCount) result.bounds = bounds;
  return result;
}
