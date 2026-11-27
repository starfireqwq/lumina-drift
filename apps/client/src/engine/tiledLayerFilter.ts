import { compressTileBuffer, PIXEL_FILTER_RUNNERS, type TileData } from '@atelier/shared';
import type { FilterJob } from '../utils/filterRegistry';
import type { Rect } from './LayerManager';

const localFilters = new Set([
  'box', 'motionBlur', 'soften', 'sharpen', 'unsharp', 'highPass', 'gaussian', 'posterize', 'invert',
  'colorAdjust', 'levels', 'grayscale', 'monoTint', 'threshold', 'lineWidth', 'extractLines', 'lineColor',
  'smoothJaggies', 'glow', 'outline', 'emboss', 'dropShadow', 'edgeToLineart', 'curves', 'gradient',
]);

export const filterUsesLocalPixels = (id: string) => localFilters.has(id);

export function scaleFilterJob(job: FilterJob, width: number, height: number, sx: number, sy: number): FilterJob {
  const values = { ...job.values };
  const lengths = new Set([
    ...PIXEL_FILTER_RUNNERS[job.id]?.draft?.lengths ?? [],
    'radius', 'cell', 'distance', 'spread', 'thickness', 'offsetX', 'offsetY', 'innerRadius', 'lineWidth', 'wavelength', 'amplitude',
  ]);
  for (const key of lengths) {
    if (typeof values[key] === 'number') values[key] *= key === 'offsetY' ? sy : sx;
  }
  if (values.center || PIXEL_FILTER_RUNNERS[job.id]?.draft?.points?.includes('center')) {
    const point = values.center as { x?: number; y?: number } | undefined;
    values.center = { x: (point?.x ?? width / 2) * sx, y: (point?.y ?? height / 2) * sy };
  }
  return { ...job, values };
}

export function readFilterMask(mask: Uint8Array | null | undefined, width: number, rect: Rect, sx = 1, sy = 1) {
  if (!mask) return null;
  const result = new Uint8Array(rect.w * rect.h);
  if (sx === 1 && sy === 1) {
    for (let row = 0; row < rect.h; row++) {
      const start = (rect.y + row) * width + rect.x;
      result.set(mask.subarray(start, start + rect.w), row * rect.w);
    }
    return result;
  }
  for (let row = 0; row < rect.h; row++) {
    for (let col = 0; col < rect.w; col++) {
      result[row * rect.w + col] = mask[Math.floor((rect.y + row) / sy) * width + Math.floor((rect.x + col) / sx)];
    }
  }
  return result;
}

interface FilterPatchOptions {
  filter: FilterJob;
  width: number;
  height: number;
  budget: number;
  newLayer: boolean;
  current: () => boolean;
  read: (rect: Rect) => Promise<Uint8Array>;
  compute: (pixels: Uint8Array, rect: Rect) => Promise<Uint8Array | null>;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Stage compressed changes before editing the layer so cancellation never commits a partial filter. */
export async function buildTiledFilterPatch(options: FilterPatchOptions) {
  const { filter, width, height, budget, newLayer, current, read, compute, bounds } = options;
  const beforeTiles: TileData[] = [];
  const afterTiles: TileData[] = [];
  const side = 256;
  const block = side * 2;
  const pad = filterUsesLocalPixels(filter.id) ? 128 : 0;
  const firstX = Math.floor((bounds?.minX ?? 0) / block) * block;
  const firstY = Math.floor((bounds?.minY ?? 0) / block) * block;
  let bytes = 0;
  const pack = (data: Uint8Array, col: number, row: number, w: number, h: number) => {
    const encoded = compressTileBuffer(data);
    bytes += encoded.data.byteLength;
    return { col, row, ...encoded, width: w, height: h, byteLength: encoded.data.byteLength };
  };
  for (let y = firstY; y <= (bounds?.maxY ?? height - 1); y += block) {
    for (let x = firstX; x <= (bounds?.maxX ?? width - 1); x += block) {
      if (!current()) return null;
      const left = Math.max(0, x - pad);
      const top = Math.max(0, y - pad);
      const rect = { x: left, y: top, w: Math.min(width, x + block + pad) - left, h: Math.min(height, y + block + pad) - top };
      const source = await read(rect);
      if (!current() || !source) return null;
      const filtered = await compute(source, rect);
      if (!current() || !filtered) return null;
      for (let ty = y; ty < Math.min(height, y + block); ty += side) {
        for (let tx = x; tx < Math.min(width, x + block); tx += side) {
          const w = Math.min(side, width - tx);
          const h = Math.min(side, height - ty);
          const before = new Uint8Array(w * h * 4);
          const after = new Uint8Array(before.length);
          for (let row = 0; row < h; row++) {
            const from = ((ty - top + row) * rect.w + tx - left) * 4;
            before.set(source.subarray(from, from + w * 4), row * w * 4);
            after.set(filtered.subarray(from, from + w * 4), row * w * 4);
          }
          if (newLayer ? !after.some(Boolean) : !after.some((value, index) => value !== before[index])) continue;
          if (!newLayer) beforeTiles.push(pack(before, tx / side, ty / side, w, h));
          afterTiles.push(pack(after, tx / side, ty / side, w, h));
          if (bytes > budget) return null;
        }
      }
    }
  }
  return { beforeTiles, afterTiles };
}
