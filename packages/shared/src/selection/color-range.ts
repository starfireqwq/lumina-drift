export interface ColorRangeSample {
  r: number;
  g: number;
  b: number;
}

export interface ColorRangeOptions {
  samples: readonly ColorRangeSample[];
  excludeSamples?: readonly ColorRangeSample[];
  /** Fuzziness / tolerance in 0..200 (perceptual distance scale). */
  fuzziness: number;
  /** Post-process Gaussian-like feather radius in pixels (0..64). */
  feather: number;
  /** Invert the resulting mask. */
  invert: boolean;
}

export const DEFAULT_COLOR_RANGE_OPTIONS: ColorRangeOptions = {
  samples: [],
  excludeSamples: [],
  fuzziness: 40,
  feather: 0,
  invert: false,
};

/**
 * Redmean-weighted perceptual RGB distance normalized to 0..255.
 * Significantly closer to human color perception than max-channel or raw Euclidean RGB.
 */
export function perceptualColorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const rMean = (r1 + r2) * 0.5;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const wr = 2 + rMean / 256;
  const wg = 4;
  const wb = 2 + (255 - rMean) / 256;
  // Max possible value is sqrt(9 * 255^2) = 3 * 255 = 765; divide by 3 to normalize to 0..255.
  return Math.sqrt(wr * dr * dr + wg * dg * dg + wb * db * db) / 3;
}

export function sampleRgbaAt(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  premultiplied = false,
): ColorRangeSample | null {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return null;
  const idx = (iy * width + ix) * 4;
  const a = rgba[idx + 3];
  if (a < 4) return null;
  if (premultiplied && a < 255) {
    const k = 255 / a;
    return {
      r: Math.min(255, Math.round(rgba[idx] * k)),
      g: Math.min(255, Math.round(rgba[idx + 1] * k)),
      b: Math.min(255, Math.round(rgba[idx + 2] * k)),
    };
  }
  return { r: rgba[idx], g: rgba[idx + 1], b: rgba[idx + 2] };
}

export function addColorRangeSample(
  samples: readonly ColorRangeSample[],
  sample: ColorRangeSample,
  minDistance = 4,
): ColorRangeSample[] {
  const exists = samples.some(
    (s) => perceptualColorDistance(s.r, s.g, s.b, sample.r, sample.g, sample.b) < minDistance,
  );
  if (exists) return [...samples];
  return [...samples, { r: Math.round(sample.r), g: Math.round(sample.g), b: Math.round(sample.b) }];
}

export function removeMatchingColorRangeSample(
  samples: readonly ColorRangeSample[],
  target: ColorRangeSample,
  threshold = 22,
): { next: ColorRangeSample[]; removed: boolean } {
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = perceptualColorDistance(samples[i].r, samples[i].g, samples[i].b, target.r, target.g, target.b);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0 && bestDist <= threshold) {
    return {
      next: samples.filter((_, i) => i !== bestIdx),
      removed: true,
    };
  }
  return { next: [...samples], removed: false };
}

function boxBlurMaskPass(src: Uint8Array, dst: Uint8Array, width: number, height: number, radius: number): void {
  const r = Math.max(1, Math.round(radius));
  const win = r * 2 + 1;
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.max(0, Math.min(width - 1, k))];
    tmp[row] = Math.round(sum / win);
    for (let x = 1; x < width; x++) {
      sum += src[row + Math.min(width - 1, x + r)] - src[row + Math.max(0, x - r - 1)];
      tmp[row + x] = Math.round(sum / win);
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.max(0, Math.min(height - 1, k)) * width + x];
    dst[x] = Math.round(sum / win);
    for (let y = 1; y < height; y++) {
      sum += tmp[Math.min(height - 1, y + r) * width + x] - tmp[Math.max(0, y - r - 1) * width + x];
      dst[y * width + x] = Math.round(sum / win);
    }
  }
}

export function featherColorRangeMask(data: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const r = Math.max(0, Math.min(64, Math.round(radius)));
  if (r <= 0 || width <= 0 || height <= 0) return data;
  const passR = Math.max(1, Math.round(r * 0.55));
  let cur = new Uint8Array(data);
  let nxt = new Uint8Array(data.length);
  for (let p = 0; p < 3; p++) {
    boxBlurMaskPass(cur, nxt, width, height, passR);
    const swap = cur;
    cur = nxt;
    nxt = swap;
  }
  return cur;
}

/**
 * Computes a soft 0..255 selection mask matching pixels within `fuzziness` of `samples`
 * (minus any `excludeSamples`), with optional inversion and feathering.
 */
export function computeColorRangeMask(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: ColorRangeOptions,
  premultiplied = false,
): Uint8Array {
  const count = width * height;
  const out = new Uint8Array(count);
  if (count <= 0) return out;

  const samples = options.samples;
  const excludes = options.excludeSamples ?? [];
  const fuzz = Math.max(0, Math.min(200, options.fuzziness));
  // Soft transition band: pixels within inner radius are 100% selected, fading smoothly to 0 at fuzz + falloff
  const inner = fuzz * 0.72;
  const outer = Math.max(inner + 1, fuzz * 1.15 + 1);
  const invSpan = 1 / (outer - inner);

  if (samples.length > 0) {
    for (let i = 0; i < count; i++) {
      const idx = i * 4;
      const a = rgba[idx + 3];
      if (a < 4) continue;
      let r = rgba[idx];
      let g = rgba[idx + 1];
      let b = rgba[idx + 2];
      if (premultiplied && a < 255) {
        const k = 255 / a;
        r = Math.min(255, r * k);
        g = Math.min(255, g * k);
        b = Math.min(255, b * k);
      }

      let minDist = Infinity;
      for (let s = 0; s < samples.length; s++) {
        const sc = samples[s];
        const d = perceptualColorDistance(r, g, b, sc.r, sc.g, sc.b);
        if (d < minDist) minDist = d;
      }

      let weight = 0;
      if (fuzz === 0) {
        weight = minDist <= 1 ? 1 : 0;
      } else if (minDist <= inner) {
        weight = 1;
      } else if (minDist < outer) {
        const t = 1 - (minDist - inner) * invSpan;
        weight = t * t * (3 - 2 * t); // smoothstep
      }

      if (weight > 0 && excludes.length > 0) {
        let minExDist = Infinity;
        for (let e = 0; e < excludes.length; e++) {
          const ec = excludes[e];
          const d = perceptualColorDistance(r, g, b, ec.r, ec.g, ec.b);
          if (d < minExDist) minExDist = d;
        }
        const exInner = Math.max(2, fuzz * 0.55);
        const exOuter = Math.max(exInner + 1, fuzz * 0.95 + 1);
        if (minExDist <= exInner) {
          weight = 0;
        } else if (minExDist < exOuter) {
          const t = (minExDist - exInner) / (exOuter - exInner);
          weight *= t * t * (3 - 2 * t);
        }
      }

      if (weight > 0) {
        out[i] = Math.min(255, Math.round(weight * a));
      }
    }
  }

  if (options.invert) {
    for (let i = 0; i < count; i++) out[i] = 255 - out[i];
  }

  const feather = Math.max(0, Math.min(64, Math.round(options.feather)));
  return feather > 0 ? featherColorRangeMask(out, width, height, feather) : out;
}
