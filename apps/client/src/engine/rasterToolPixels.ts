import { expandSelectionMask, floodFillMagicWand, type Point2D, type TileData } from '@atelier/shared';

export function bucketMask(
  pixels: Uint8Array, width: number, height: number, seeds: Point2D[], tolerance: number, expand: number,
) {
  const validSeeds = seeds.filter(({ x, y }) => x >= 0 && x < width && y >= 0 && y < height);
  if (!validSeeds.length) return null;
  const fullBounds = { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  const colors = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
  const first = colors[0];
  let index = 1;
  while (index < colors.length && colors[index] === first) index++;
  if (index === colors.length) return { data: null, bounds: fullBounds };

  let combined: Uint8Array | null = null;
  const bounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  for (const { x, y } of validSeeds) {
    const mask = floodFillMagicWand(pixels, width, height, x, y, tolerance, true);
    if (mask.activePixelCount === width * height) return { data: null, bounds: fullBounds };
    if (!mask.activePixelCount) continue;
    const data = expand ? expandSelectionMask(mask.data, width, height, expand) : mask.data;
    const minX = Math.max(0, mask.bounds.minX - expand);
    const minY = Math.max(0, mask.bounds.minY - expand);
    const maxX = Math.min(width - 1, mask.bounds.maxX + expand);
    const maxY = Math.min(height - 1, mask.bounds.maxY + expand);
    if (!combined) combined = data;
    else for (let row = minY; row <= maxY; row++) {
      for (let i = row * width + minX; i <= row * width + maxX; i++) combined[i] = Math.max(combined[i], data[i]);
    }
    bounds.minX = Math.min(bounds.minX, minX);
    bounds.minY = Math.min(bounds.minY, minY);
    bounds.maxX = Math.max(bounds.maxX, maxX);
    bounds.maxY = Math.max(bounds.maxY, maxY);
  }
  if (!combined) return null;
  const coversCanvas = bounds.minX === 0 && bounds.minY === 0 &&
    bounds.maxX === fullBounds.maxX && bounds.maxY === fullBounds.maxY &&
    combined.every((coverage) => coverage === 255);
  return { data: coversCanvas ? null : combined, bounds };
}

export interface GradientPaint {
  rays: Array<{ start: Point2D; end: Point2D }>;
  type: 'linear' | 'radial';
  fg: string;
  bg: string;
  opacity: number;
  tileSize: number;
  canvasWidth: number;
  mask?: Uint8Array;
  replace?: boolean;
}

export function paintGradientTiles(
  tiles: TileData[], options: GradientPaint, canvas: HTMLCanvasElement | OffscreenCanvas,
): TileData[] {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not create a gradient canvas');
  return tiles.map((tile) => {
    const { width, height } = tile;
    if (!width || !height) return tile;
    const x = tile.col * options.tileSize;
    const y = tile.row * options.tileSize;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    for (const { start, end } of options.rays) {
      const sx = start.x - x;
      const sy = start.y - y;
      const gradient = options.type === 'radial'
        ? ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.hypot(end.x - start.x, end.y - start.y))
        : ctx.createLinearGradient(sx, sy, end.x - x, end.y - y);
      gradient.addColorStop(0, options.fg);
      gradient.addColorStop(1, options.bg);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
    const gradient = ctx.getImageData(0, 0, width, height).data;
    if (options.replace) {
      const data = new Uint8Array(gradient.buffer);
      return { ...tile, compression: 'raw', data, byteLength: data.byteLength };
    }
    const output = new Uint8Array(tile.data as Uint8Array);
    for (let row = 0; row < height; row++) {
      const maskStart = (y + row) * options.canvasWidth + x;
      for (let col = 0; col < width; col++) {
        const offset = (row * width + col) * 4;
        const coverage = gradient[offset + 3] / 255 * options.opacity *
          (options.mask ? options.mask[maskStart + col] / 255 : 1);
        if (coverage <= 0) continue;
        const remaining = 1 - coverage;
        for (let channel = 0; channel < 3; channel++) {
          output[offset + channel] = Math.round(gradient[offset + channel] * coverage + output[offset + channel] * remaining);
        }
        output[offset + 3] = Math.round(255 * coverage + output[offset + 3] * remaining);
      }
    }
    return { ...tile, compression: 'raw', data: output, byteLength: output.byteLength };
  });
}
