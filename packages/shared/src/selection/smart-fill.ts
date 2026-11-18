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
  let opaqueWhite = 0;
  let edgeSamples = 0;
  for (let x = bMinX; x <= bMaxX; x++) {
    for (const y of [bMinY, bMaxY]) {
      const i = (y * width + x) * 4;
      edgeSamples++;
      if (refPixels[i + 3] > 240 && Math.min(refPixels[i], refPixels[i + 1], refPixels[i + 2]) > 245) opaqueWhite++;
    }
  }
  const whiteBackground = isWhiteBackgroundLineart ?? opaqueWhite > edgeSamples * 0.6;
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
