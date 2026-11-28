import { DEFAULT_TILE_SIZE, compressTileBuffer, getTileBounds, type TileData } from '@atelier/shared';
import type { PixelData } from 'ag-psd';
import { compressTiles } from './commitWorkers';

type TileOptions = {
  canvasWidth: number;
  canvasHeight: number;
  scale: number;
  tileSize?: number;
};

type Bounds = { left: number; top: number; right: number; bottom: number };

const RAW_TILE_BATCH_SIZE = 32;

export function pixelDataToRgba8Byte(data: PixelData['data'], index: number, isAlpha: boolean): number {
  const value = data[index];
  if (data instanceof Uint16Array) return value >>> 8;
  if (data instanceof Float32Array) {
    const clamped = Math.max(0, Math.min(1, value)) || 0;
    return Math.round((isAlpha ? clamped : Math.pow(clamped, 1 / 2.2)) * 255);
  }
  return value;
}

function scaledBounds(pixelData: PixelData, left: number, top: number, scale: number): Bounds {
  const x = Math.round(left * scale);
  const y = Math.round(top * scale);
  return {
    left: x,
    top: y,
    right: x + Math.max(1, Math.round(pixelData.width * scale)),
    bottom: y + Math.max(1, Math.round(pixelData.height * scale)),
  };
}

function hasPixels(pixelData: PixelData | undefined): pixelData is PixelData {
  return !!pixelData && pixelData.width > 0 && pixelData.height > 0;
}

function intersection(a: Bounds, b: Bounds): Bounds | undefined {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (left < right && top < bottom) return { left, top, right, bottom };
}

// Sample destination pixel centers. Interpolating premultiplied colors keeps
// transparent source pixels from tinting their neighbors.
function createSampler({ data, width, height }: PixelData, targetWidth: number, targetHeight: number) {
  const ratioX = width / targetWidth;
  const ratioY = height / targetHeight;
  const rgba = new Float64Array(4);
  if (ratioX === 1 && ratioY === 1) {
    return (x: number, y: number) => {
      const index = (y * width + x) * 4;
      const alpha = pixelDataToRgba8Byte(data, index + 3, true);
      for (let channel = 0; channel < 3; channel++) {
        rgba[channel] = pixelDataToRgba8Byte(data, index + channel, false) * alpha / 255;
      }
      rgba[3] = alpha;
      return rgba;
    };
  }

  return (x: number, y: number) => {
    const sx = Math.max(0, Math.min(width - 1, (x + 0.5) * ratioX - 0.5));
    const sy = Math.max(0, Math.min(height - 1, (y + 0.5) * ratioY - 0.5));
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const fx = sx - x0;
    const fy = sy - y0;
    const tl = (y0 * width + x0) * 4;
    const tr = (y0 * width + x1) * 4;
    const bl = (y1 * width + x0) * 4;
    const br = (y1 * width + x1) * 4;
    const a = pixelDataToRgba8Byte(data, tl + 3, true) * (1 - fx) * (1 - fy);
    const b = pixelDataToRgba8Byte(data, tr + 3, true) * fx * (1 - fy);
    const c = pixelDataToRgba8Byte(data, bl + 3, true) * (1 - fx) * fy;
    const d = pixelDataToRgba8Byte(data, br + 3, true) * fx * fy;
    rgba[3] = a + b + c + d;
    for (let channel = 0; channel < 3; channel++) {
      rgba[channel] = (
        pixelDataToRgba8Byte(data, tl + channel, false) * a +
        pixelDataToRgba8Byte(data, tr + channel, false) * b +
        pixelDataToRgba8Byte(data, bl + channel, false) * c +
        pixelDataToRgba8Byte(data, br + channel, false) * d
      ) / 255;
    }
    return rgba;
  };
}

async function compressTileBatches(tiles: Iterable<TileData>): Promise<TileData[]> {
  const result: TileData[] = [];
  let batch: TileData[] = [];
  for (const tile of tiles) {
    batch.push(tile);
    if (batch.length === RAW_TILE_BATCH_SIZE) {
      result.push(...await compressTiles(batch));
      batch = [];
    }
  }
  if (batch.length) result.push(...await compressTiles(batch));
  return result;
}

export async function extractPsdLayerTiles(
  pixelData: PixelData,
  { left, top, canvasWidth, canvasHeight, scale, tileSize = DEFAULT_TILE_SIZE }: TileOptions & {
    left: number;
    top: number;
  },
): Promise<TileData[]> {
  if (!hasPixels(pixelData)) return [];
  const bounds = scaledBounds(pixelData, left, top, scale);
  const visible = intersection(bounds, { left: 0, top: 0, right: canvasWidth, bottom: canvasHeight });
  if (!visible) return [];

  const { data, width: sourceWidth } = pixelData;
  const sample = scale === 1 ? undefined : createSampler(pixelData, bounds.right - bounds.left, bounds.bottom - bounds.top);
  const { left: startX, top: startY, right: endX, bottom: endY } = visible;

  function* rawTiles(): Generator<TileData> {
    for (let row = Math.floor(startY / tileSize); row < Math.ceil(endY / tileSize); row++) {
      for (let col = Math.floor(startX / tileSize); col < Math.ceil(endX / tileSize); col++) {
        const { x, y, width, height } = getTileBounds(col, row, tileSize, canvasWidth, canvasHeight);
        const pixels = new Uint8Array(width * height * 4);
        let hasAlpha = false;
        const fromX = Math.max(startX, x);
        const toX = Math.min(endX, x + width);
        const toY = Math.min(endY, y + height);
        for (let yy = Math.max(startY, y); yy < toY; yy++) {
          let target = ((yy - y) * width + fromX - x) * 4;
          let source = ((yy - bounds.top) * sourceWidth + fromX - bounds.left) * 4;
          for (let xx = fromX; xx < toX; xx++, target += 4, source += 4) {
            if (sample) {
              const rgba = sample(xx - bounds.left, yy - bounds.top);
              const alpha = Math.round(rgba[3]);
              if (!alpha) continue;
              pixels[target] = Math.round(rgba[0]);
              pixels[target + 1] = Math.round(rgba[1]);
              pixels[target + 2] = Math.round(rgba[2]);
              pixels[target + 3] = alpha;
            } else {
              const alpha = pixelDataToRgba8Byte(data, source + 3, true);
              if (!alpha) continue;
              pixels[target] = Math.round(pixelDataToRgba8Byte(data, source, false) * alpha / 255);
              pixels[target + 1] = Math.round(pixelDataToRgba8Byte(data, source + 1, false) * alpha / 255);
              pixels[target + 2] = Math.round(pixelDataToRgba8Byte(data, source + 2, false) * alpha / 255);
              pixels[target + 3] = alpha;
            }
            hasAlpha = true;
          }
        }
        if (hasAlpha) yield { col, row, width, height, compression: 'raw', data: pixels };
      }
    }
  }

  return compressTileBatches(rawTiles());
}

function opaqueGrayPixels(width: number, height: number, gray: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  if (gray === 255) pixels.fill(255);
  else for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return pixels;
}

export async function extractPsdMaskTiles(
  mask: { left?: number; top?: number; defaultColor?: number },
  maskPixelData: PixelData | undefined,
  { canvasWidth, canvasHeight, scale, tileSize = DEFAULT_TILE_SIZE }: TileOptions,
): Promise<TileData[]> {
  const pixels = hasPixels(maskPixelData) ? maskPixelData : undefined;
  if (!pixels && mask.defaultColor === undefined) return [];
  const bg = mask.defaultColor === 255 ? 255 : 0;
  const bounds = pixels && scaledBounds(pixels, mask.left ?? 0, mask.top ?? 0, scale);
  const sample = pixels && bounds && scale !== 1
    ? createSampler(pixels, bounds.right - bounds.left, bounds.bottom - bounds.top)
    : undefined;
  const solidTiles: TileData[] = [];
  const solidBuffers = new Map<string, ReturnType<typeof compressTileBuffer>>();

  function* rawTiles(): Generator<TileData> {
    for (let row = 0; row < Math.ceil(canvasHeight / tileSize); row++) {
      for (let col = 0; col < Math.ceil(canvasWidth / tileSize); col++) {
        const { x, y, width, height } = getTileBounds(col, row, tileSize, canvasWidth, canvasHeight);
        const overlap = bounds && intersection(bounds, { left: x, top: y, right: x + width, bottom: y + height });
        if (!overlap || !pixels || !bounds) {
          const key = `${width}x${height}`;
          let buffer = solidBuffers.get(key);
          if (!buffer) {
            buffer = compressTileBuffer(opaqueGrayPixels(width, height, bg));
            solidBuffers.set(key, buffer);
          }
          solidTiles.push({ col, row, width, height, ...buffer, byteLength: buffer.data.byteLength });
          continue;
        }

        const data = opaqueGrayPixels(width, height, bg);
        for (let yy = overlap.top; yy < overlap.bottom; yy++) {
          for (let xx = overlap.left; xx < overlap.right; xx++) {
            const sx = xx - bounds.left;
            const sy = yy - bounds.top;
            let lum: number;
            if (sample) {
              const rgba = sample(sx, sy);
              lum = Math.round(rgba[0] * 0.299 + rgba[1] * 0.587 + rgba[2] * 0.114);
            } else {
              const index = (sy * pixels.width + sx) * 4;
              const r = pixelDataToRgba8Byte(pixels.data, index, false);
              const g = pixelDataToRgba8Byte(pixels.data, index + 1, false);
              const b = pixelDataToRgba8Byte(pixels.data, index + 2, false);
              const a = pixelDataToRgba8Byte(pixels.data, index + 3, true);
              lum = Math.round((r * 0.299 + g * 0.587 + b * 0.114) * (a / 255));
            }
            const dest = ((yy - y) * width + xx - x) * 4;
            data[dest] = lum;
            data[dest + 1] = lum;
            data[dest + 2] = lum;
          }
        }
        yield { col, row, width, height, compression: 'raw', data };
      }
    }
  }

  const tiles = await compressTileBatches(rawTiles());
  return tiles.concat(solidTiles).sort((a, b) => a.row - b.row || a.col - b.col);
}

export function renderPsdPreviewDataUrl(pixelData: PixelData, maxSide = 512): string | null {
  if (typeof document === 'undefined' || !hasPixels(pixelData) || !(maxSide >= 1)) return null;
  const scale = Math.min(1, Math.floor(maxSide) / Math.max(pixelData.width, pixelData.height));
  const width = Math.max(1, Math.round(pixelData.width * scale));
  const height = Math.max(1, Math.round(pixelData.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const preview = ctx.createImageData(width, height);
  const sample = createSampler(pixelData, width, height);
  for (let y = 0, index = 0; y < height; y++) {
    for (let x = 0; x < width; x++, index += 4) {
      const rgba = sample(x, y);
      const white = 255 - rgba[3];
      preview.data[index] = Math.round(rgba[0] + white);
      preview.data[index + 1] = Math.round(rgba[1] + white);
      preview.data[index + 2] = Math.round(rgba[2] + white);
      preview.data[index + 3] = 255;
    }
  }
  ctx.putImageData(preview, 0, 0);
  return canvas.toDataURL('image/png');
}
