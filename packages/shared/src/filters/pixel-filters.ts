/**
 * High-Precision Pixel Implementations of Filters (Node.js & Web Worker Fallback)
 *
 * Implements the exact same algorithms as WebGL2 Shaders for:
 * - Dual-Pass Gaussian Blur
 * - Twirl / Vortex Distortion
 * - Digital Noise & Grain
 * - Manga Halftone Dot
 * - Chromatic Aberration / RGB Split
 * - HSV / HSL Adjustment & Invert
 * - Liquify Distortion
 *
 * Stricly respects Selection Masks: pixels outside active selection are unchanged.
 */

import { getSelectionMaskFactor } from '../selection/selection-mask';

export interface FilterContext {
  pixels: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  selectionMask?: Uint8Array | null;
}

/**
 * 1. Dual-Pass Gaussian Blur (Horizontal Pass then Vertical Pass)
 */
export function applyGaussianBlur(
  ctx: FilterContext,
  radius: number = 4
): Uint8Array {
  const { pixels, width, height, selectionMask } = ctx;
  const rad = Math.max(1, Math.min(32, Math.round(radius)));
  const sigma = Math.max(0.5, rad / 2.5);
  const twoSigmaSq = 2.0 * sigma * sigma;

  // Precompute 1D Gaussian kernel weights
  const kernelSize = rad * 2 + 1;
  const weights = new Float32Array(kernelSize);
  let weightSum = 0;
  for (let i = -rad; i <= rad; i++) {
    const w = Math.exp(-(i * i) / twoSigmaSq);
    weights[i + rad] = w;
    weightSum += w;
  }
  for (let i = 0; i < kernelSize; i++) {
    weights[i] /= weightSum;
  }

  // The kernel is symmetric: the two pixels k away on either side share one weight (half the
  // multiplications). Pass 1: Horizontal Blur (writes into intermediate buffer)
  const temp = new Uint8Array(width * height * 4);
  const lastX = width - 1;
  const w0 = weights[rad];

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const centre = (row + x) * 4;
      let r = pixels[centre] * w0, g = pixels[centre + 1] * w0, b = pixels[centre + 2] * w0, a = pixels[centre + 3] * w0;

      for (let k = 1; k <= rad; k++) {
        const lx = x - k, rx = x + k;
        const li = (row + (lx < 0 ? 0 : lx)) * 4;
        const ri = (row + (rx > lastX ? lastX : rx)) * 4;
        const w = weights[rad + k];
        r += (pixels[li] + pixels[ri]) * w;
        g += (pixels[li + 1] + pixels[ri + 1]) * w;
        b += (pixels[li + 2] + pixels[ri + 2]) * w;
        a += (pixels[li + 3] + pixels[ri + 3]) * w;
      }

      const outIdx = (row + x) * 4;
      temp[outIdx] = Math.round(r);
      temp[outIdx + 1] = Math.round(g);
      temp[outIdx + 2] = Math.round(b);
      temp[outIdx + 3] = Math.round(a);
    }
  }

  // Pass 2: Vertical Blur, a whole row at a time (read in memory order), into the final buffer with
  // selection mask support
  const output = new Uint8Array(width * height * 4);
  const len = width * 4;
  const lastY = height - 1;
  const sums = new Float64Array(len);

  for (let y = 0; y < height; y++) {
    const centre = y * len;
    for (let i = 0; i < len; i++) sums[i] = temp[centre + i] * w0;
    for (let k = 1; k <= rad; k++) {
      const up = (y - k < 0 ? 0 : y - k) * len;
      const down = (y + k > lastY ? lastY : y + k) * len;
      const w = weights[rad + k];
      for (let i = 0; i < len; i++) sums[i] += (temp[up + i] + temp[down + i]) * w;
    }
    const row = y * len;
    if (!selectionMask) {
      for (let i = 0; i < len; i++) output[row + i] = Math.round(sums[i]);
      continue;
    }
    for (let x = 0; x < width; x++) {
      const at = x * 4;
      const outIdx = row + at;
      const maskFactor = getSelectionMaskFactor(selectionMask, x, y, width, height);
      for (let c = 0; c < 4; c++) {
        // Masked out: the original pixel; else the filtered pixel blended in by maskFactor
        output[outIdx + c] = maskFactor <= 0.0 ? pixels[outIdx + c] : Math.round(pixels[outIdx + c] * (1.0 - maskFactor) + sums[at + c] * maskFactor);
      }
    }
  }

  return output;
}

/**
 * 2. Twirl / Vortex Distortion
 */
export function applyTwirlDistortion(
  ctx: FilterContext,
  centerX: number,
  centerY: number,
  radius: number,
  angleRad: number
): Uint8Array {
  const { pixels, width, height, selectionMask } = ctx;
  const output = new Uint8Array(pixels);

  const rad = Math.max(1, radius);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskFactor = getSelectionMaskFactor(selectionMask || null, x, y, width, height);
      if (maskFactor <= 0.0) continue;

      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.hypot(dx, dy);

      if (dist < rad) {
        const factor = (rad - dist) / rad;
        const theta = angleRad * factor * factor * maskFactor;
        const cosA = Math.cos(theta);
        const sinA = Math.sin(theta);

        const srcX = Math.round(centerX + (dx * cosA - dy * sinA));
        const srcY = Math.round(centerY + (dx * sinA + dy * cosA));

        if (srcX >= 0 && srcX < width && srcY >= 0 && srcY < height) {
          const srcIdx = (srcY * width + srcX) * 4;
          const dstIdx = (y * width + x) * 4;

          output[dstIdx] = pixels[srcIdx];
          output[dstIdx + 1] = pixels[srcIdx + 1];
          output[dstIdx + 2] = pixels[srcIdx + 2];
          output[dstIdx + 3] = pixels[srcIdx + 3];
        }
      }
    }
  }

  return output;
}

/**
 * 3. Digital Noise & Grain
 */
export function applyNoiseGrain(
  ctx: FilterContext,
  intensity: number = 0.25,
  grainSize: number = 1.0
): Uint8Array {
  const { pixels, width, height, selectionMask } = ctx;
  const output = new Uint8Array(pixels);

  const scale = Math.max(1, Math.round(grainSize));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (pixels[idx + 3] === 0) continue;

      const maskFactor = getSelectionMaskFactor(selectionMask || null, x, y, width, height);
      if (maskFactor <= 0.0) continue;

      // Pseudo-random deterministic noise hash based on grain coordinate
      const gx = Math.floor(x / scale);
      const gy = Math.floor(y / scale);
      const hash = ((Math.sin(gx * 12.9898 + gy * 78.233) * 43758.5453) % 1 + 1) % 1;
      const noise = (hash * 2.0 - 1.0) * intensity * 70 * maskFactor;

      output[idx] = Math.max(0, Math.min(255, Math.round(pixels[idx] + noise)));
      output[idx + 1] = Math.max(0, Math.min(255, Math.round(pixels[idx + 1] + noise)));
      output[idx + 2] = Math.max(0, Math.min(255, Math.round(pixels[idx + 2] + noise)));
    }
  }

  return output;
}

/**
 * 4. Manga Halftone Dot (漫畫風半色調網點)
 */
export function applyHalftoneDot(
  ctx: FilterContext,
  density: number = 40,
  angleRad: number = Math.PI / 4, // 45 degrees
  dotScale: number = 1.0
): Uint8Array {
  const { pixels, width, height, selectionMask } = ctx;
  const output = new Uint8Array(pixels);

  const cellSize = Math.max(3, Math.round(width / Math.max(1, density)));
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskFactor = getSelectionMaskFactor(selectionMask || null, x, y, width, height);
      if (maskFactor <= 0.0) continue;

      const idx = (y * width + x) * 4;
      if (pixels[idx + 3] === 0) continue;

      // Rotated grid coordinate
      const rotX = x * cosA - y * sinA;
      const rotY = x * sinA + y * cosA;

      const cellX = Math.floor(rotX / cellSize);
      const cellY = Math.floor(rotY / cellSize);

      // Center of this halftone cell in unrotated canvas space
      const centerRotX = (cellX + 0.5) * cellSize;
      const centerRotY = (cellY + 0.5) * cellSize;
      const sampleX = Math.max(0, Math.min(width - 1, Math.round(centerRotX * cosA + centerRotY * sinA)));
      const sampleY = Math.max(0, Math.min(height - 1, Math.round(-centerRotX * sinA + centerRotY * cosA)));

      const sampleIdx = (sampleY * width + sampleX) * 4;
      const lum =
        0.299 * (pixels[sampleIdx] / 255) +
        0.587 * (pixels[sampleIdx + 1] / 255) +
        0.114 * (pixels[sampleIdx + 2] / 255);

      // Dot radius inversely proportional to lightness (darker = bigger black dot)
      const maxDotRadius = (cellSize * 0.5) * Math.min(1.5, Math.max(0.5, dotScale));
      const dotRadius = maxDotRadius * Math.sqrt(Math.max(0, 1.0 - lum));

      // Distance from pixel to cell center
      const localDx = rotX - centerRotX;
      const localDy = rotY - centerRotY;
      const dist = Math.hypot(localDx, localDy);

      // Binary / smooth halftone print dot
      const isInk = dist <= dotRadius;
      const inkVal = isInk ? 20 : 255;

      output[idx] = Math.round(pixels[idx] * (1.0 - maskFactor) + inkVal * maskFactor);
      output[idx + 1] = Math.round(pixels[idx + 1] * (1.0 - maskFactor) + inkVal * maskFactor);
      output[idx + 2] = Math.round(pixels[idx + 2] * (1.0 - maskFactor) + inkVal * maskFactor);
    }
  }

  return output;
}

/**
 * 5. Chromatic Aberration / RGB Split (色差分離)
 */
export function applyChromaticAberration(
  ctx: FilterContext,
  offsetX: number = 4,
  offsetY: number = 0
): Uint8Array {
  const { pixels, width, height, selectionMask } = ctx;
  const output = new Uint8Array(pixels);

  const ox = Math.round(offsetX);
  const oy = Math.round(offsetY);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskFactor = getSelectionMaskFactor(selectionMask || null, x, y, width, height);
      if (maskFactor <= 0.0) continue;

      const dstIdx = (y * width + x) * 4;

      // Sample Red shifted -offset
      const rx = Math.max(0, Math.min(width - 1, x - ox));
      const ry = Math.max(0, Math.min(height - 1, y - oy));
      const rIdx = (ry * width + rx) * 4;
      const red = pixels[rIdx];

      // Sample Green at center
      const green = pixels[dstIdx + 1];

      // Sample Blue shifted +offset
      const bx = Math.max(0, Math.min(width - 1, x + ox));
      const by = Math.max(0, Math.min(height - 1, y + oy));
      const bIdx = (by * width + bx) * 4;
      const blue = pixels[bIdx + 2];

      output[dstIdx] = Math.round(pixels[dstIdx] * (1.0 - maskFactor) + red * maskFactor);
      output[dstIdx + 1] = green;
      output[dstIdx + 2] = Math.round(pixels[dstIdx + 2] * (1.0 - maskFactor) + blue * maskFactor);
    }
  }

  return output;
}

/**
 * 6. HSV / HSL Adjustment & Invert
 */
export function applyHsvAdjust(
  ctx: FilterContext,
  hueShift: number = 0, // -180..180
  saturationMult: number = 1.0,
  brightnessOffset: number = 0,
  invert: boolean = false
): Uint8Array {
  const { pixels, width, height, selectionMask } = ctx;
  const output = new Uint8Array(pixels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (pixels[idx + 3] === 0) continue;

      const maskFactor = getSelectionMaskFactor(selectionMask || null, x, y, width, height);
      if (maskFactor <= 0.0) continue;

      const r = pixels[idx] / 255;
      const g = pixels[idx + 1] / 255;
      const b = pixels[idx + 2] / 255;

      // RGB to HSV
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      let h = 0;
      const s = max === 0 ? 0 : d / max;
      let v = max;

      if (max !== min) {
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }

      // Adjust
      h = (h + hueShift / 360) % 1;
      if (h < 0) h += 1;
      const newS = Math.max(0, Math.min(1, s * saturationMult));
      v = Math.max(0, Math.min(1, v + brightnessOffset));

      // HSV to RGB
      const i = Math.floor(h * 6);
      const f = h * 6 - i;
      const p = v * (1 - newS);
      const q = v * (1 - f * newS);
      const t = v * (1 - (1 - f) * newS);

      let outR = 0, outG = 0, outB = 0;
      switch (i % 6) {
        case 0: outR = v; outG = t; outB = p; break;
        case 1: outR = q; outG = v; outB = p; break;
        case 2: outR = p; outG = v; outB = t; break;
        case 3: outR = p; outG = q; outB = v; break;
        case 4: outR = t; outG = p; outB = v; break;
        case 5: outR = v; outG = p; outB = q; break;
      }

      if (invert) {
        outR = 1.0 - outR;
        outG = 1.0 - outG;
        outB = 1.0 - outB;
      }

      output[idx] = Math.round(pixels[idx] * (1.0 - maskFactor) + outR * 255 * maskFactor);
      output[idx + 1] = Math.round(pixels[idx + 1] * (1.0 - maskFactor) + outG * 255 * maskFactor);
      output[idx + 2] = Math.round(pixels[idx + 2] * (1.0 - maskFactor) + outB * 255 * maskFactor);
    }
  }

  return output;
}

// ============================================================================
// Phase 10: Color Curves (Bézier LUT) & Gradient Map Filters
// ============================================================================

export interface CurvePoint {
  x: number; // 0..255 or 0..1
  y: number; // 0..255 or 0..1
}

export interface ColorCurvesOptions {
  masterCurve?: CurvePoint[];
  redCurve?: CurvePoint[];
  greenCurve?: CurvePoint[];
  blueCurve?: CurvePoint[];
  lutMaster?: Uint8Array;
  lutRed?: Uint8Array;
  lutGreen?: Uint8Array;
  lutBlue?: Uint8Array;
}

/**
 * Builds a smooth 256-entry Look-Up Table (LUT) from Bézier / cubic control points
 * Uses Monotone Cubic Spline (Fritsch-Carlson) to prevent overshooting
 */
export function buildCurveLUT(points?: CurvePoint[]): Uint8Array {
  const lut = new Uint8Array(256);

  // Default identity linear ramp: y = x
  if (!points || points.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }

  // Normalize points to 0..255 space and sort by x
  const normalized: Array<{ x: number; y: number }> = points.map((p) => ({
    x: p.x <= 1.0 && points.every((pt) => pt.x <= 1.0) ? p.x * 255 : p.x,
    y: p.y <= 1.0 && points.every((pt) => pt.y <= 1.0) ? p.y * 255 : p.y,
  })).sort((a, b) => a.x - b.x);

  // Ensure (0,0) and (255,255) bounds exist if not provided
  if (normalized[0].x > 0) {
    normalized.unshift({ x: 0, y: normalized[0].y });
  }
  if (normalized[normalized.length - 1].x < 255) {
    normalized.push({ x: 255, y: normalized[normalized.length - 1].y });
  }

  const n = normalized.length;
  if (n === 2) {
    // Simple linear interpolation
    const p0 = normalized[0];
    const p1 = normalized[1];
    const dx = p1.x - p0.x || 1;
    for (let x = 0; x < 256; x++) {
      const t = Math.max(0, Math.min(1, (x - p0.x) / dx));
      lut[x] = Math.round(Math.max(0, Math.min(255, p0.y + t * (p1.y - p0.y))));
    }
    return lut;
  }

  // Monotone Cubic Spline (Fritsch-Carlson)
  const x = normalized.map((p) => p.x);
  const y = normalized.map((p) => p.y);
  const delta: number[] = [];
  const m: number[] = new Array(n).fill(0);

  for (let i = 0; i < n - 1; i++) {
    const dx = x[i + 1] - x[i];
    delta.push(dx !== 0 ? (y[i + 1] - y[i]) / dx : 0);
  }

  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = (delta[i - 1] + delta[i]) / 2;
  }

  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / delta[i];
      const beta = m[i + 1] / delta[i];
      const dist = alpha * alpha + beta * beta;
      if (dist > 9) {
        const tau = 3 / Math.sqrt(dist);
        m[i] = tau * alpha * delta[i];
        m[i + 1] = tau * beta * delta[i];
      }
    }
  }

  for (let px = 0; px < 256; px++) {
    // Find interval [x[i], x[i+1]] containing px
    let i = 0;
    while (i < n - 2 && px > x[i + 1]) {
      i++;
    }

    const h = x[i + 1] - x[i];
    const t = h !== 0 ? (px - x[i]) / h : 0;
    const t2 = t * t;
    const t3 = t2 * t;

    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    const val = h00 * y[i] + h10 * h * m[i] + h01 * y[i + 1] + h11 * h * m[i + 1];
    lut[px] = Math.round(Math.max(0, Math.min(255, val)));
  }

  return lut;
}

/**
 * 7. Applies RGB & Master Tone Curves via Look-Up Tables
 */
export function applyColorCurves(
  ctx: FilterContext,
  options: ColorCurvesOptions
): Uint8Array {
  const { pixels, width, height, selectionMask } = ctx;
  const output = new Uint8Array(width * height * 4);

  const lutMaster = options.lutMaster || buildCurveLUT(options.masterCurve);
  const lutRed = options.lutRed || buildCurveLUT(options.redCurve);
  const lutGreen = options.lutGreen || buildCurveLUT(options.greenCurve);
  const lutBlue = options.lutBlue || buildCurveLUT(options.blueCurve);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const maskFactor = getSelectionMaskFactor(selectionMask || null, x, y, width, height);

      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const a = pixels[idx + 3];

      output[idx + 3] = a;

      if (maskFactor <= 0.0 || a === 0) {
        output[idx] = r;
        output[idx + 1] = g;
        output[idx + 2] = b;
        continue;
      }

      // 1. Channel Curve -> 2. Master Tone Curve
      const curvedR = lutMaster[lutRed[r]];
      const curvedG = lutMaster[lutGreen[g]];
      const curvedB = lutMaster[lutBlue[b]];

      output[idx] = Math.round(r * (1.0 - maskFactor) + curvedR * maskFactor);
      output[idx + 1] = Math.round(g * (1.0 - maskFactor) + curvedG * maskFactor);
      output[idx + 2] = Math.round(b * (1.0 - maskFactor) + curvedB * maskFactor);
    }
  }

  return output;
}

export interface GradientStop {
  offset: number; // 0.0 to 1.0
  color: string;  // Hex '#RRGGBB'
}

export type GradientPresetName = 'sunset' | 'cyberpunk' | 'ink';

export const GRADIENT_PRESETS: Record<GradientPresetName, GradientStop[]> = {
  // 夕陽 (Sunset / Golden Hour): Deep Violet -> Crimson -> Golden Amber -> Warm Sun White
  sunset: [
    { offset: 0.0, color: '#180B26' },
    { offset: 0.35, color: '#881F4C' },
    { offset: 0.65, color: '#E85D26' },
    { offset: 0.85, color: '#F6B738' },
    { offset: 1.0, color: '#FFF6D6' },
  ],
  // 賽博朋克 (Cyberpunk / Neon Synthwave): Void Dark Navy -> Electric Magenta -> Cyan Neon -> Acid Yellow
  cyberpunk: [
    { offset: 0.0, color: '#070B19' },
    { offset: 0.3, color: '#680088' },
    { offset: 0.55, color: '#FF007F' },
    { offset: 0.8, color: '#00F0FF' },
    { offset: 1.0, color: '#FFFF80' },
  ],
  // 黑白水墨 (Monochrome Ink / Sumi-e): Carbon Ink -> Charcoal -> Washed Ink -> Rice Paper White
  ink: [
    { offset: 0.0, color: '#0D0F12' },
    { offset: 0.3, color: '#373F47' },
    { offset: 0.65, color: '#949CA4' },
    { offset: 0.85, color: '#D8DBDB' },
    { offset: 1.0, color: '#FBFBF8' },
  ],
};

function hexToRgbComponents(hex: string): [number, number, number] {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  const val = parseInt(clean, 16);
  return [(val >> 16) & 255, (val >> 8) & 255, val & 255];
}

/**
 * Builds a 256-entry RGBA Look-Up Table (Uint8Array of size 1024) from gradient stops
 */
export function buildGradientLUT(stops: GradientStop[]): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);

  if (sorted.length === 0) {
    // Default grayscale
    for (let i = 0; i < 256; i++) {
      lut[i * 4] = i;
      lut[i * 4 + 1] = i;
      lut[i * 4 + 2] = i;
      lut[i * 4 + 3] = 255;
    }
    return lut;
  }

  if (sorted[0].offset > 0) {
    sorted.unshift({ offset: 0, color: sorted[0].color });
  }
  if (sorted[sorted.length - 1].offset < 1) {
    sorted.push({ offset: 1, color: sorted[sorted.length - 1].color });
  }

  for (let i = 0; i < 256; i++) {
    const t = i / 255;

    // Find bounding stops
    let sIdx = 0;
    while (sIdx < sorted.length - 2 && t > sorted[sIdx + 1].offset) {
      sIdx++;
    }

    const s0 = sorted[sIdx];
    const s1 = sorted[sIdx + 1];
    const range = s1.offset - s0.offset || 1;
    const factor = Math.max(0, Math.min(1, (t - s0.offset) / range));

    const [r0, g0, b0] = hexToRgbComponents(s0.color);
    const [r1, g1, b1] = hexToRgbComponents(s1.color);

    lut[i * 4] = Math.round(r0 + factor * (r1 - r0));
    lut[i * 4 + 1] = Math.round(g0 + factor * (g1 - g0));
    lut[i * 4 + 2] = Math.round(b0 + factor * (b1 - b0));
    lut[i * 4 + 3] = 255;
  }

  return lut;
}

/**
 * 8. Applies Gradient Map Filter (漸層對應)
 * Maps pixel perceptual grayscale luminance onto a color gradient ramp
 */
export function applyGradientMap(
  ctx: FilterContext,
  stopsOrPreset: GradientStop[] | GradientPresetName = 'sunset',
  opacity: number = 1.0
): Uint8Array {
  const { pixels, width, height, selectionMask } = ctx;
  const output = new Uint8Array(width * height * 4);

  const stops = typeof stopsOrPreset === 'string'
    ? GRADIENT_PRESETS[stopsOrPreset] || GRADIENT_PRESETS.sunset
    : stopsOrPreset;

  const gradientLut = buildGradientLUT(stops);
  const blendAmount = Math.max(0, Math.min(1, opacity));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const maskFactor = getSelectionMaskFactor(selectionMask || null, x, y, width, height);

      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const a = pixels[idx + 3];

      output[idx + 3] = a;

      if (maskFactor <= 0.0 || a === 0) {
        output[idx] = r;
        output[idx + 1] = g;
        output[idx + 2] = b;
        continue;
      }

      // ITU-R BT.601 perceptual luminance
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      const gradR = gradientLut[lum * 4];
      const gradG = gradientLut[lum * 4 + 1];
      const gradB = gradientLut[lum * 4 + 2];

      const effBlend = blendAmount * maskFactor;
      output[idx] = Math.round(r * (1.0 - effBlend) + gradR * effBlend);
      output[idx + 1] = Math.round(g * (1.0 - effBlend) + gradG * effBlend);
      output[idx + 2] = Math.round(b * (1.0 - effBlend) + gradB * effBlend);
    }
  }

  return output;
}

