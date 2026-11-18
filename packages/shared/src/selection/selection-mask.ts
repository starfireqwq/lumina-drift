/**
 * Professional Selection Mask Engine (Lasso & Magic Wand)
 *
 * Implements:
 * 1. Freehand Lasso polygon rasterization to binary mask (Uint8Array, 0 or 255)
 * 2. High-performance Flood Fill Magic Wand with:
 *    - RGBA Euclidean Color Tolerance (0..255)
 *    - Contiguous (connected 4-way BFS) vs Non-contiguous (global image scan)
 *    - Morphological Selection Expansion (Dilation) & Contraction (Erosion)
 * 3. Selection Bounding Box & Active Pixel Mask Checking
 */

export interface SelectionMaskData {
  width: number;
  height: number;
  // 1 byte per pixel: 255 for selected, 0 for unselected
  data: Uint8Array;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  activePixelCount: number;
}

/**
 * Checks whether a 2D point (x, y) is inside a closed polygon using Jordan curve raycasting
 */
export function pointInPolygon(x: number, y: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  const n = polygon.length;
  if (n < 3) return false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 0.00001) + xi;
    if (intersect) inside = !inside;
  }

  return inside;
}

/**
 * Generates a binary selection mask from a closed Lasso polygon
 */
export function rasterizeLassoMask(
  points: Array<{ x: number; y: number }>,
  width: number,
  height: number
): SelectionMaskData {
  const mask = new Uint8Array(width * height);
  if (points.length < 3) {
    return {
      width,
      height,
      data: mask,
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      activePixelCount: 0,
    };
  }

  // Calculate polygon bounding box
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (const p of points) {
    if (p.x < minX) minX = Math.max(0, Math.floor(p.x));
    if (p.y < minY) minY = Math.max(0, Math.floor(p.y));
    if (p.x > maxX) maxX = Math.min(width - 1, Math.ceil(p.x));
    if (p.y > maxY) maxY = Math.min(height - 1, Math.ceil(p.y));
  }

  if (minX > maxX || minY > maxY) {
    return {
      width,
      height,
      data: mask,
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      activePixelCount: 0,
    };
  }

  let activeCount = 0;

  // Scanline rasterization inside bounding box
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, points)) {
        mask[y * width + x] = 255;
        activeCount++;
      }
    }
  }

  return {
    width,
    height,
    data: mask,
    bounds: { minX, minY, maxX, maxY },
    activePixelCount: activeCount,
  };
}

/**
 * Computes color distance between two RGBA pixels (0..255)
 */
export function colorDistanceRgba(
  r1: number,
  g1: number,
  b1: number,
  a1: number,
  r2: number,
  g2: number,
  b2: number,
  a2: number
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const da = a1 - a2;
  // Weighted perceptual color distance
  return Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db + 0.25 * da * da);
}

/**
 * Magic Wand Selection based on Flood Fill and Color Tolerance
 *
 * @param pixels Flat RGBA Uint8Array / Uint8ClampedArray (size = width * height * 4)
 * @param width Canvas width
 * @param height Canvas height
 * @param startX Clicked start X coordinate
 * @param startY Clicked start Y coordinate
 * @param tolerance Color tolerance threshold (0..255, default = 32)
 * @param contiguous If true, flood-fill only adjacent connected pixels; if false, match all pixels across canvas
 */
export function floodFillMagicWand(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  tolerance: number = 32,
  contiguous: boolean = true
): SelectionMaskData {
  const mask = new Uint8Array(width * height);
  const cx = Math.max(0, Math.min(width - 1, Math.round(startX)));
  const cy = Math.max(0, Math.min(height - 1, Math.round(startY)));

  const startIndex = (cy * width + cx) * 4;
  const targetR = pixels[startIndex];
  const targetG = pixels[startIndex + 1];
  const targetB = pixels[startIndex + 2];
  const targetA = pixels[startIndex + 3];

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let activeCount = 0;

  if (!contiguous) {
    // Non-contiguous: Scan all pixels across entire canvas
    const totalPixels = width * height;
    for (let i = 0; i < totalPixels; i++) {
      const offset = i * 4;
      const dist = colorDistanceRgba(
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
        pixels[offset + 3],
        targetR,
        targetG,
        targetB,
        targetA
      );

      if (dist <= tolerance) {
        mask[i] = 255;
        activeCount++;
        const x = i % width;
        const y = Math.floor(i / width);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  } else {
    // Contiguous: 4-way BFS Queue Flood Fill
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height * 2);
    let head = 0;
    let tail = 0;

    queue[tail++] = cx;
    queue[tail++] = cy;
    visited[cy * width + cx] = 1;

    while (head < tail) {
      const x = queue[head++];
      const y = queue[head++];

      const offset = (y * width + x) * 4;
      const dist = colorDistanceRgba(
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
        pixels[offset + 3],
        targetR,
        targetG,
        targetB,
        targetA
      );

      if (dist <= tolerance) {
        mask[y * width + x] = 255;
        activeCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        // Check 4 neighbors: North, South, West, East
        if (y > 0 && visited[(y - 1) * width + x] === 0) {
          visited[(y - 1) * width + x] = 1;
          queue[tail++] = x;
          queue[tail++] = y - 1;
        }
        if (y < height - 1 && visited[(y + 1) * width + x] === 0) {
          visited[(y + 1) * width + x] = 1;
          queue[tail++] = x;
          queue[tail++] = y + 1;
        }
        if (x > 0 && visited[y * width + (x - 1)] === 0) {
          visited[y * width + (x - 1)] = 1;
          queue[tail++] = x - 1;
          queue[tail++] = y;
        }
        if (x < width - 1 && visited[y * width + (x + 1)] === 0) {
          visited[y * width + (x + 1)] = 1;
          queue[tail++] = x + 1;
          queue[tail++] = y;
        }
      }
    }
  }

  return {
    width,
    height,
    data: mask,
    bounds: activeCount > 0 ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    activePixelCount: activeCount,
  };
}

/**
 * Offsets a 2D closed polygon outward by distance (positive for expand, negative for contract)
 */
export function offsetPolygon(
  points: Array<{ x: number; y: number }>,
  distance: number
): Array<{ x: number; y: number }> {
  const n = points.length;
  if (n < 3 || distance === 0) return points.map((p) => ({ ...p }));

  // Signed area to determine winding (shoelace formula)
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  const isClockwise = area > 0;

  const result: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const len1 = Math.hypot(v1x, v1y) || 0.0001;

    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len2 = Math.hypot(v2x, v2y) || 0.0001;

    // Normal vectors in screen coordinates (Y down):
    const n1x = isClockwise ? v1y / len1 : -v1y / len1;
    const n1y = isClockwise ? -v1x / len1 : v1x / len1;

    const n2x = isClockwise ? v2y / len2 : -v2y / len2;
    const n2y = isClockwise ? -v2x / len2 : v2x / len2;

    let nx = (n1x + n2x) * 0.5;
    let ny = (n1y + n2y) * 0.5;
    const nLen = Math.hypot(nx, ny) || 0.0001;
    nx /= nLen;
    ny /= nLen;

    result.push({
      x: curr.x + nx * distance,
      y: curr.y + ny * distance,
    });
  }

  return result;
}

/**
 * High-performance Morphological Dilation:
 * Expands (dilates) the selection mask by radius pixels using boundary-edge disk stamping.
 * Runs in O(perimeter * rad) instead of O(W * H * rad^2), eliminating UI lag completely.
 */
export function expandSelectionMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number = 2,
  bounds?: { minX: number; minY: number; maxX: number; maxY: number }
): Uint8Array {
  if (radius <= 0) return new Uint8Array(mask);

  const rad = Math.min(32, Math.round(radius));
  const radSq = rad * rad;

  // Precompute disk neighborhood offsets
  const offsets: Array<[number, number]> = [];
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      if (dx * dx + dy * dy <= radSq) {
        offsets.push([dx, dy]);
      }
    }
  }

  const minX = bounds ? Math.max(0, bounds.minX) : 0;
  const maxX = bounds ? Math.min(width - 1, bounds.maxX) : width - 1;
  const minY = bounds ? Math.max(0, bounds.minY) : 0;
  const maxY = bounds ? Math.min(height - 1, bounds.maxY) : height - 1;

  const output = new Uint8Array(mask);

  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * width;
    for (let x = minX; x <= maxX; x++) {
      if (mask[rowOffset + x] === 255) {
        const isBoundary =
          x === 0 ||
          x === width - 1 ||
          y === 0 ||
          y === height - 1 ||
          mask[rowOffset + (x - 1)] === 0 ||
          mask[rowOffset + (x + 1)] === 0 ||
          mask[(y - 1) * width + x] === 0 ||
          mask[(y + 1) * width + x] === 0;

        if (isBoundary) {
          for (let i = 0; i < offsets.length; i++) {
            const nx = x + offsets[i][0];
            const ny = y + offsets[i][1];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              output[ny * width + nx] = 255;
            }
          }
        }
      }
    }
  }

  return output;
}

/**
 * High-performance Morphological Erosion:
 * Contracts (erodes) the selection mask by radius pixels using background boundary disk stamping.
 * Runs in O(perimeter * rad) instead of O(W * H * rad^2), eliminating UI lag completely.
 */
export function contractSelectionMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number = 2,
  bounds?: { minX: number; minY: number; maxX: number; maxY: number }
): Uint8Array {
  if (radius <= 0) return new Uint8Array(mask);

  const rad = Math.min(32, Math.round(radius));
  const radSq = rad * rad;

  // Precompute disk neighborhood offsets
  const offsets: Array<[number, number]> = [];
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      if (dx * dx + dy * dy <= radSq) {
        offsets.push([dx, dy]);
      }
    }
  }

  const minX = bounds ? Math.max(0, bounds.minX - 1) : 0;
  const maxX = bounds ? Math.min(width - 1, bounds.maxX + 1) : width - 1;
  const minY = bounds ? Math.max(0, bounds.minY - 1) : 0;
  const maxY = bounds ? Math.min(height - 1, bounds.maxY + 1) : height - 1;

  // Collect boundary background pixels (mask === 0) that touch selected foreground (mask === 255)
  const bgEdgePixels: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * width;
    for (let x = minX; x <= maxX; x++) {
      if (mask[rowOffset + x] === 0) {
        const touchesForeground =
          (x > 0 && mask[rowOffset + (x - 1)] === 255) ||
          (x < width - 1 && mask[rowOffset + (x + 1)] === 255) ||
          (y > 0 && mask[(y - 1) * width + x] === 255) ||
          (y < height - 1 && mask[(y + 1) * width + x] === 255);

        if (touchesForeground) {
          bgEdgePixels.push(x, y);
        }
      }
    }
  }

  const output = new Uint8Array(mask);
  for (let i = 0; i < bgEdgePixels.length; i += 2) {
    const bx = bgEdgePixels[i];
    const by = bgEdgePixels[i + 1];
    for (let j = 0; j < offsets.length; j++) {
      const nx = bx + offsets[j][0];
      const ny = by + offsets[j][1];
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        output[ny * width + nx] = 0;
      }
    }
  }

  return output;
}

/**
 * Strict Mask Guard:
 * Returns the effective alpha factor (0.0 to 1.0) at coordinate (x, y).
 * If selection mask is null, returns 1.0 (no restriction).
 * If pixel is outside mask, returns 0.0 (strictly restricted/blocked).
 */
export function getSelectionMaskFactor(
  mask: Uint8Array | null,
  x: number,
  y: number,
  width: number,
  height: number
): number {
  if (!mask) return 1.0;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= width || iy < 0 || iy >= height) return 0.0;
  return mask[iy * width + ix] / 255.0;
}
