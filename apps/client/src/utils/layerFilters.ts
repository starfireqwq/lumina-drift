import {
  applyChromaticAberration, applyColorCurves, applyGaussianBlur, applyGradientMap,
  applyHalftoneDot, applyNoiseGrain, applyTwirlDistortion,
  type ColorCurvesOptions, type FilterContext, type GradientStop,
} from '@atelier/shared';

type FilterControl = { label: string; initial: number; min: number; max: number; step?: number };
type FilterDefinition = { label: string; controls: readonly FilterControl[] };

export const LAYER_FILTERS = {
  box: { label: '模糊', controls: [{ label: '半徑（px）', initial: 4, min: 1, max: 32 }] },
  gaussian: { label: '高斯模糊', controls: [{ label: '半徑（px）', initial: 8, min: 1, max: 32 }] },
  spin: { label: '旋轉模糊', controls: [{ label: '角度（°）', initial: 15, min: 1, max: 90 }] },
  posterize: { label: '色調分離', controls: [{ label: '每色版階數', initial: 6, min: 2, max: 32 }] },
  noise: { label: '雜訊', controls: [{ label: '強度（%）', initial: 25, min: 0, max: 100 }, { label: '顆粒大小（px）', initial: 1, min: 1, max: 16 }] },
  invert: { label: '負片', controls: [] },
  chromatic: { label: '色差分離', controls: [{ label: '水平位移（px）', initial: 6, min: -32, max: 32 }, { label: '垂直位移（px）', initial: 0, min: -32, max: 32 }] },
  halftone: { label: '半色調網點', controls: [{ label: '密度', initial: 45, min: 4, max: 128 }, { label: '角度（°）', initial: 45, min: 0, max: 180 }, { label: '網點大小', initial: 1, min: 0.1, max: 2, step: 0.1 }] },
  twirl: { label: '漩渦扭曲', controls: [{ label: '半徑（px）', initial: 300, min: 10, max: 2000 }, { label: '角度（°）', initial: 135, min: -360, max: 360 }] },
} satisfies Record<string, FilterDefinition>;

export type LayerFilterId = keyof typeof LAYER_FILTERS;
export type LayerFilter = { id: LayerFilterId; values: number[] }
  | { id: 'curves'; options: ColorCurvesOptions }
  | { id: 'gradient'; stops: GradientStop[]; opacity: number };

const radians = (degrees: number) => degrees * Math.PI / 180;

function blurBox(pixels: Uint8Array, width: number, height: number, radius: number) {
  const horizontal = new Uint8Array(pixels.length);
  const output = new Uint8Array(pixels.length);
  const span = radius * 2 + 1;
  const pass = (source: Uint8Array, target: Uint8Array, length: number, lines: number, stride: number, lineStride: number) => {
    for (let line = 0; line < lines; line++) {
      const base = line * lineStride;
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += source[base + Math.min(length - 1, Math.max(0, k)) * stride + channel];
        for (let at = 0; at < length; at++) {
          target[base + at * stride + channel] = Math.round(sum / span);
          sum -= source[base + Math.max(0, at - radius) * stride + channel];
          sum += source[base + Math.min(length - 1, at + radius + 1) * stride + channel];
        }
      }
    }
  };
  pass(pixels, horizontal, width, height, 4, width * 4);
  pass(horizontal, output, height, width, width * 4, 4);
  return output;
}

export function renderLayerFilter(pixels: Uint8Array, width: number, height: number, filter: LayerFilter, mask?: Uint8Array | null) {
  const context: FilterContext = { pixels, width, height };
  const colorOnly = ['invert', 'posterize', 'noise', 'halftone', 'chromatic', 'curves', 'gradient'].includes(filter.id);
  if (colorOnly) {
    const straight = new Uint8Array(pixels);
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      if (!alpha || alpha === 255) continue;
      for (let c = 0; c < 3; c++) straight[i + c] = Math.min(255, Math.round(pixels[i + c] * 255 / alpha));
    }
    context.pixels = straight;
  }

  const [a, b, c] = 'values' in filter ? filter.values : [];
  let result: Uint8Array;
  switch (filter.id) {
    case 'curves': result = applyColorCurves(context, filter.options); break;
    case 'gradient': result = applyGradientMap(context, filter.stops, filter.opacity); break;
    case 'box': result = blurBox(pixels, width, height, a); break;
    case 'gaussian': result = applyGaussianBlur(context, a); break;
    case 'noise': result = applyNoiseGrain(context, a / 100, b); break;
    case 'halftone': result = applyHalftoneDot(context, a, radians(b), c); break;
    case 'chromatic': result = applyChromaticAberration(context, a, b); break;
    case 'twirl': result = applyTwirlDistortion(context, width / 2, height / 2, a, radians(b)); break;
    case 'spin': {
      result = new Uint8Array(pixels.length);
      const cx = (width - 1) / 2;
      const cy = (height - 1) / 2;
      const samples = Array.from({ length: 13 }, (_, index) => {
        const angle = radians(a) * (index / 12 - 0.5);
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
      break;
    }
    default: {
      result = new Uint8Array(context.pixels);
      const step = 255 / (a - 1);
      for (let i = 0; i < result.length; i += 4) {
        for (let k = 0; k < 3; k++) result[i + k] = filter.id === 'invert' ? 255 - result[i + k] : Math.round(Math.round(result[i + k] / step) * step);
      }
    }
  }
  for (let i = 0; i < result.length; i += 4) {
    const factor = mask ? mask[i / 4] / 255 : 1;
    const alpha = result[i + 3];
    for (let k = 0; k < 4; k++) {
      const filtered = colorOnly && k < 3 ? result[i + k] * alpha / 255 : result[i + k];
      result[i + k] = Math.round(pixels[i + k] * (1 - factor) + filtered * factor);
    }
  }
  return result;
}
