/**
 * Pixel filter runners, looked up by id. Pure functions (no DOM), so the filter worker, the
 * self-checks and later the plugin host all run the same code. The menu, labels and parameter
 * controls live in the client's filter registry; this file only knows how to compute a filter.
 */
import {
  applyChromaticAberration, applyColorCurves, applyGaussianBlur, applyGradientMap,
  applyHalftoneDot, applyNoiseGrain, applyTwirlDistortion,
  type ColorCurvesOptions, type FilterContext, type GradientStop,
} from './pixel-filters';

/** A filter's settings, by parameter key (never by position) */
export type FilterValues = Record<string, unknown>;

export interface PixelFilterRunner {
  /** Changes colour only: it sees straight (un-premultiplied) colour, re-premultiplied afterwards */
  colorOnly?: boolean;
  run: (ctx: FilterContext, values: FilterValues) => Uint8Array;
}

const radians = (degrees: number) => degrees * Math.PI / 180;

/** A number setting, or the fallback when it is missing or not finite */
export function filterNumber(values: FilterValues, key: string, fallback: number) {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function blurBox(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, radius: number) {
  const r = Math.max(1, Math.round(radius));
  const horizontal = new Uint8Array(pixels.length);
  const output = new Uint8Array(pixels.length);
  const span = r * 2 + 1;
  const pass = (source: ArrayLike<number>, target: Uint8Array, length: number, lines: number, stride: number, lineStride: number) => {
    for (let line = 0; line < lines; line++) {
      const base = line * lineStride;
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += source[base + Math.min(length - 1, Math.max(0, k)) * stride + channel];
        for (let at = 0; at < length; at++) {
          target[base + at * stride + channel] = Math.round(sum / span);
          sum -= source[base + Math.max(0, at - r) * stride + channel];
          sum += source[base + Math.min(length - 1, at + r + 1) * stride + channel];
        }
      }
    }
  };
  pass(pixels, horizontal, width, height, 4, width * 4);
  pass(horizontal, output, height, width, width * 4, 4);
  return output;
}

function spinBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, degrees: number) {
  const result = new Uint8Array(pixels.length);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const samples = Array.from({ length: 13 }, (_, index) => {
    const angle = radians(degrees) * (index / 12 - 0.5);
    return [Math.cos(angle), Math.sin(angle)];
  });
  const sums = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sums.fill(0);
      for (const [cos, sin] of samples) {
        const sx = Math.round(cx + (x - cx) * cos - (y - cy) * sin);
        const sy = Math.round(cy + (x - cx) * sin + (y - cy) * cos);
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
        const src = (sy * width + sx) * 4;
        for (let k = 0; k < 4; k++) sums[k] += pixels[src + k];
      }
      const dst = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) result[dst + k] = Math.round(sums[k] / samples.length);
    }
  }
  return result;
}

/** Built-in filters. Each id matches an entry of the client's filter registry. */
export const PIXEL_FILTER_RUNNERS: Readonly<Record<string, PixelFilterRunner>> = {
  box: { run: ({ pixels, width, height }, v) => blurBox(pixels, width, height, filterNumber(v, 'radius', 4)) },
  gaussian: { run: (ctx, v) => applyGaussianBlur(ctx, filterNumber(v, 'radius', 8)) },
  spin: { run: ({ pixels, width, height }, v) => spinBlur(pixels, width, height, filterNumber(v, 'angle', 15)) },
  posterize: {
    colorOnly: true,
    run: ({ pixels }, v) => {
      const result = new Uint8Array(pixels);
      const step = 255 / (Math.max(2, Math.round(filterNumber(v, 'levels', 6))) - 1);
      for (let i = 0; i < result.length; i += 4) {
        for (let k = 0; k < 3; k++) result[i + k] = Math.round(Math.round(result[i + k] / step) * step);
      }
      return result;
    },
  },
  invert: {
    colorOnly: true,
    run: ({ pixels }) => {
      const result = new Uint8Array(pixels);
      for (let i = 0; i < result.length; i += 4) {
        for (let k = 0; k < 3; k++) result[i + k] = 255 - result[i + k];
      }
      return result;
    },
  },
  noise: { colorOnly: true, run: (ctx, v) => applyNoiseGrain(ctx, filterNumber(v, 'amount', 25) / 100, filterNumber(v, 'grain', 1)) },
  chromatic: { colorOnly: true, run: (ctx, v) => applyChromaticAberration(ctx, filterNumber(v, 'offsetX', 6), filterNumber(v, 'offsetY', 0)) },
  halftone: {
    colorOnly: true,
    run: (ctx, v) => applyHalftoneDot(ctx, filterNumber(v, 'density', 45), radians(filterNumber(v, 'angle', 45)), filterNumber(v, 'dotSize', 1)),
  },
  twirl: {
    run: (ctx, v) => applyTwirlDistortion(ctx, ctx.width / 2, ctx.height / 2, filterNumber(v, 'radius', 300), radians(filterNumber(v, 'angle', 135))),
  },
  curves: { colorOnly: true, run: (ctx, v) => applyColorCurves(ctx, (v.options ?? {}) as ColorCurvesOptions) },
  gradient: {
    colorOnly: true,
    run: (ctx, v) => applyGradientMap(ctx, Array.isArray(v.stops) ? v.stops as GradientStop[] : 'sunset', filterNumber(v, 'opacity', 1)),
  },
};

/**
 * Runs a filter over premultiplied RGBA and blends it in through the selection mask (0–255 per
 * pixel; none = everywhere). Colour-only filters work on straight colour, re-premultiplied here.
 */
export function runPixelFilter(
  runner: PixelFilterRunner,
  pixels: Uint8Array,
  width: number,
  height: number,
  values: FilterValues,
  mask?: Uint8Array | null,
): Uint8Array {
  const context: FilterContext = { pixels, width, height };
  if (runner.colorOnly) {
    const straight = new Uint8Array(pixels);
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      if (!alpha || alpha === 255) continue;
      for (let c = 0; c < 3; c++) straight[i + c] = Math.min(255, Math.round(pixels[i + c] * 255 / alpha));
    }
    context.pixels = straight;
  }
  const result = runner.run(context, values);
  // A runner may hand back its input: never write over the caller's pixels
  const output = result === pixels ? new Uint8Array(result) : result;
  for (let i = 0; i < output.length; i += 4) {
    const factor = mask ? mask[i / 4] / 255 : 1;
    const alpha = output[i + 3];
    for (let k = 0; k < 4; k++) {
      const filtered = runner.colorOnly && k < 3 ? output[i + k] * alpha / 255 : output[i + k];
      output[i + k] = Math.round(pixels[i + k] * (1 - factor) + filtered * factor);
    }
  }
  return output;
}
