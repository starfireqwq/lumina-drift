import { colorDistanceRgba, expandSelectionMask, type Point2D } from '@atelier/shared';
import type { Rect } from './LayerManager';

const SIDE = 256;
const TILE_PIXELS = SIDE * SIDE;
const bit = (data: Uint8Array, index: number) => data[index >> 3] & (1 << (index & 7));
const mark = (data: Uint8Array, index: number) => { data[index >> 3] |= 1 << (index & 7); };

/** Flood a tile at a time. The canvas-sized state is two bitsets, with a bounded cache of RGBA tiles. */
export async function tiledBucketFill(
  width: number, height: number, seeds: Point2D[], tolerance: number, expand: number, wrap: boolean,
  read: (rect: Rect) => Promise<Uint8Array>, current: () => boolean,
) {
  const cols = Math.ceil(width / SIDE);
  const keyAt = (x: number, y: number) => Math.floor(y / SIDE) * cols + Math.floor(x / SIDE);
  const localAt = (x: number, y: number) => (y % SIDE) * SIDE + x % SIDE;
  const wrapX = (x: number) => ((x % width) + width) % width;
  const wrapY = (y: number) => ((y % height) + height) % height;
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  const tiles = new Map<number, Uint8Array>();
  const cache = new Map<number, Uint8Array>();
  const blockCache = new Map<number, { rect: Rect; pixels: Uint8Array }>();
  const bounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  const queue = new Uint16Array(TILE_PIXELS);
  let count = 0;
  let yieldAt = performance.now() + 12;
  const getRect = (key: number) => {
    const x = key % cols * SIDE;
    const y = Math.floor(key / cols) * SIDE;
    return { x, y, w: Math.min(SIDE, width - x), h: Math.min(SIDE, height - y) };
  };
  const pixelsAt = async (key: number) => {
    let pixels = cache.get(key);
    if (!pixels) {
      const rect = getRect(key);
      const side = SIDE * 4;
      const x = Math.floor(rect.x / side) * side;
      const y = Math.floor(rect.y / side) * side;
      const blockKey = keyAt(x, y);
      let block = blockCache.get(blockKey);
      if (!block) {
        const region = { x, y, w: Math.min(side, width - x), h: Math.min(side, height - y) };
        block = { rect: region, pixels: await read(region) };
      }
      blockCache.delete(blockKey);
      blockCache.set(blockKey, block);
      if (blockCache.size > 4) blockCache.delete(blockCache.keys().next().value!);
      pixels = new Uint8Array(rect.w * rect.h * 4);
      for (let row = 0; row < rect.h; row++) {
        const from = ((rect.y - y + row) * block.rect.w + rect.x - x) * 4;
        pixels.set(block.pixels.subarray(from, from + rect.w * 4), row * rect.w * 4);
      }
    }
    cache.delete(key);
    cache.set(key, pixels);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
    return pixels;
  };
  for (const seed of seeds) {
    const sx = wrap ? wrapX(seed.x) : seed.x;
    const sy = wrap ? wrapY(seed.y) : seed.y;
    if (!inBounds(sx, sy)) continue;
    const seedKey = keyAt(sx, sy);
    const seedRect = getRect(seedKey);
    const sample = await pixelsAt(seedKey);
    const offset = ((sy - seedRect.y) * seedRect.w + sx - seedRect.x) * 4;
    const [r, g, b, a] = sample.subarray(offset, offset + 4);
    const pending = new Map<number, number[]>();
    const seen = new Map<number, Uint8Array>();
    pending.set(seedKey, [localAt(sx, sy)]);
    while (pending.size) {
      if (!current()) return null;
      const [key, entries] = pending.entries().next().value!;
      pending.delete(key);
      const rect = getRect(key);
      const pixels = await pixelsAt(key);
      const visited = seen.get(key) ?? new Uint8Array(TILE_PIXELS / 8);
      seen.set(key, visited);
      let tail = 0;
      const enqueue = (index: number) => {
        if (bit(visited, index)) return;
        mark(visited, index);
        queue[tail++] = index;
      };
      for (const entry of entries) enqueue(entry);
      let filled = tiles.get(key);
      const visit = (x: number, y: number) => {
        if (wrap) { x = wrapX(x); y = wrapY(y); }
        else if (!inBounds(x, y)) return;
        const next = keyAt(x, y);
        const index = localAt(x, y);
        if (next === key) { enqueue(index); return; }
        const neighbor = seen.get(next);
        if (neighbor && bit(neighbor, index)) return;
        const entries = pending.get(next);
        if (entries) entries.push(index);
        else pending.set(next, [index]);
      };
      for (let head = 0; head < tail; head++) {
        const index = queue[head];
        const lx = index % SIDE;
        const ly = Math.floor(index / SIDE);
        const i = (ly * rect.w + lx) * 4;
        if (colorDistanceRgba(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3], r, g, b, a) > tolerance) continue;
        if (!filled) { filled = new Uint8Array(TILE_PIXELS / 8); tiles.set(key, filled); }
        const x = rect.x + lx;
        const y = rect.y + ly;
        if (!bit(filled, index)) {
          mark(filled, index);
          count++;
          bounds.minX = Math.min(bounds.minX, x);
          bounds.minY = Math.min(bounds.minY, y);
          bounds.maxX = Math.max(bounds.maxX, x);
          bounds.maxY = Math.max(bounds.maxY, y);
        }
        if (lx > 0) enqueue(index - 1); else visit(x - 1, y);
        if (lx + 1 < rect.w) enqueue(index + 1); else visit(x + 1, y);
        if (ly > 0) enqueue(index - SIDE); else visit(x, y - 1);
        if (ly + 1 < rect.h) enqueue(index + SIDE); else visit(x, y + 1);
      }
      if (count === width * height) break;
      if (performance.now() >= yieldAt) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yieldAt = performance.now() + 12;
      }
    }
    if (count === width * height) break;
  }
  if (!count || !current()) return null;
  const radius = Math.min(32, Math.max(0, Math.round(expand)));
  const coversCanvas = count === width * height;
  const maskFor = (rect: Rect) => {
    const w = rect.w + 2 * radius;
    const h = rect.h + 2 * radius;
    const mask = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        let x = rect.x + col - radius;
        let y = rect.y + row - radius;
        if (wrap) { x = wrapX(x); y = wrapY(y); }
        else if (!inBounds(x, y)) continue;
        const tile = tiles.get(keyAt(x, y));
        if (tile && bit(tile, localAt(x, y))) mask[row * w + col] = 255;
      }
    }
    if (!radius) return mask;
    const expanded = expandSelectionMask(mask, w, h, radius);
    const result = new Uint8Array(rect.w * rect.h);
    for (let row = 0; row < rect.h; row++) {
      const start = (row + radius) * w + radius;
      result.set(expanded.subarray(start, start + rect.w), row * rect.w);
    }
    return result;
  };
  return {
    coversCanvas,
    bounds: {
      minX: wrap && radius ? 0 : Math.max(0, bounds.minX - radius),
      minY: wrap && radius ? 0 : Math.max(0, bounds.minY - radius),
      maxX: wrap && radius ? width - 1 : Math.min(width - 1, bounds.maxX + radius),
      maxY: wrap && radius ? height - 1 : Math.min(height - 1, bounds.maxY + radius),
    },
    maskFor,
  };
}
