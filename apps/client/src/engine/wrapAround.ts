import { colorDistanceRgba, DEFAULT_TILE_SIZE } from '@atelier/shared';

type Point = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Tile = { col: number; row: number };

export function wrapCoord(value: number, size: number): number {
  if (!(size > 0) || !Number.isFinite(size) || !Number.isFinite(value)) return 0;
  const remainder = value % size;
  const wrapped = remainder < 0 ? remainder + size : remainder;
  return wrapped === size ? 0 : wrapped || 0;
}

export function wrapPoint(x: number, y: number, width: number, height: number): Point {
  return { x: wrapCoord(x, width), y: wrapCoord(y, height) };
}

function periodRange(min: number, max: number, size: number): [number, number] {
  if (!(size > 0) || !Number.isFinite(size) || !Number.isFinite(min) || !Number.isFinite(max) || max < min) return [0, -1];
  const first = min === max ? Math.ceil(-max / size) : Math.floor(-max / size) + 1;
  return [first, -Math.floor(min / size)];
}

export function getWrapAroundBoundsOffsets(
  minX: number, minY: number, maxX: number, maxY: number, width: number, height: number,
): Array<{ dx: number; dy: number }> {
  const [left, right] = periodRange(minX, maxX, width);
  const [top, bottom] = periodRange(minY, maxY, height);
  if (![left, right, top, bottom].every(Number.isFinite) || left > right || top > bottom) return [];
  const offsets = [];
  for (let row = 0; row <= bottom - top; row++) {
    for (let col = 0; col <= right - left; col++) {
      offsets.push({ dx: (left + col) * width || 0, dy: (top + row) * height || 0 });
    }
  }
  return offsets;
}

export function getWrappedStampPoints(x: number, y: number, radius: number, width: number, height: number): Point[] {
  if (!(width > 0 && height > 0 && radius >= 0) || ![width, height, radius].every(Number.isFinite)) return [];
  const { x: wx, y: wy } = wrapPoint(x, y, width, height);
  const xs = [wx];
  const ys = [wy];
  if (wx - radius < 0) xs.push(wx + width);
  if (wx + radius > width) xs.push(wx - width);
  if (wy - radius < 0) ys.push(wy + height);
  if (wy + radius > height) ys.push(wy - height);
  return ys.flatMap((y) => xs.map((x) => ({ x, y })));
}

function addDirtyTiles(
  out: Map<number, Tile>, minX: number, minY: number, maxX: number, maxY: number,
  width: number, height: number, tileSize: number,
) {
  if (!Number.isFinite(tileSize) || !(tileSize > 0)) return;
  // A box that already spans an axis touches every tile on that axis.
  if (maxX - minX >= width) { minX = 0; maxX = width; }
  if (maxY - minY >= height) { minY = 0; maxY = height; }
  const cols = Math.ceil(width / tileSize);
  for (const { dx, dy } of getWrapAroundBoundsOffsets(minX, minY, maxX, maxY, width, height)) {
    const left = Math.floor(Math.max(0, minX + dx) / tileSize);
    const top = Math.floor(Math.max(0, minY + dy) / tileSize);
    const right = minX === maxX ? left : Math.ceil(Math.min(width, maxX + dx) / tileSize) - 1;
    const bottom = minY === maxY ? top : Math.ceil(Math.min(height, maxY + dy) / tileSize) - 1;
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const key = row * cols + col;
        if (!out.has(key)) out.set(key, { col, row });
      }
    }
  }
}

export function getWrappedDirtyTilesForBounds(
  minX: number, minY: number, maxX: number, maxY: number, width: number, height: number, tileSize = DEFAULT_TILE_SIZE,
): Tile[] {
  const tiles = new Map<number, Tile>();
  addDirtyTiles(tiles, minX, minY, maxX, maxY, width, height, tileSize);
  return [...tiles.values()];
}

export function getWrappedDirtyTilesForPoints(
  points: ReadonlyArray<Point & { radius?: number }>, defaultRadius: number,
  width: number, height: number, tileSize = DEFAULT_TILE_SIZE,
): Tile[] {
  const tiles = new Map<number, Tile>();
  for (const { x, y, radius = defaultRadius } of points) {
    const point = wrapPoint(x, y, width, height);
    addDirtyTiles(tiles, point.x - radius, point.y - radius, point.x + radius, point.y + radius, width, height, tileSize);
  }
  return [...tiles.values()];
}

export function computeWrappedFloodFillMask(
  pixels: Uint8Array | Uint8ClampedArray, width: number, height: number,
  seeds: ReadonlyArray<Point>, tolerance: number, expandRadius = 0,
): { data: Uint8Array; bounds: Bounds } | null {
  const count = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || pixels.length < count * 4) return null;
  const starts = new Set<number>();
  for (const { x, y } of seeds) {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      starts.add(wrapCoord(Math.round(y), height) * width + wrapCoord(Math.round(x), width));
    }
  }
  if (!starts.size) return null;

  const data = new Uint8Array(count);
  const visited = new Uint8Array(count);
  const queue = new Uint32Array(count);
  const bounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  let covered = 0;
  const mark = (index: number, x: number, y: number) => {
    if (data[index]) return;
    data[index] = 255;
    covered++;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  };

  for (const start of starts) {
    visited.fill(0);
    const offset = start * 4;
    const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2], alpha = pixels[offset + 3];
    let length = 0;
    const visit = (index: number) => {
      if (visited[index]) return;
      visited[index] = 1;
      const i = index * 4;
      if (colorDistanceRgba(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3], red, green, blue, alpha) <= tolerance) {
        queue[length++] = index;
      }
    };
    visit(start);
    for (let head = 0; head < length; head++) {
      const index = queue[head];
      const x = index % width;
      const y = Math.floor(index / width);
      mark(index, x, y);
      visit(x === 0 ? index + width - 1 : index - 1);
      visit(x === width - 1 ? index - width + 1 : index + 1);
      visit(y === 0 ? index + count - width : index - width);
      visit(y === height - 1 ? index - count + width : index + width);
    }
    if (covered === count) break;
  }

  const radius = Math.min(32, Math.round(expandRadius));
  if (radius > 0 && covered > 0 && covered < count) {
    const source = data.slice();
    const spans = Array.from({ length: 2 * radius + 1 }, (_, i) =>
      Math.floor(Math.sqrt(radius * radius - (i - radius) ** 2)));
    const { minX, minY, maxX, maxY } = bounds;
    for (let y = minY; y <= maxY; y++) {
      const above = wrapCoord(y - 1, height) * width;
      const below = wrapCoord(y + 1, height) * width;
      const row = y * width;
      for (let x = minX; x <= maxX; x++) {
        if (!source[row + x] || (source[above + x] && source[below + x] &&
          source[row + wrapCoord(x - 1, width)] && source[row + wrapCoord(x + 1, width)])) continue;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = wrapCoord(y + dy, height);
          const span = spans[dy + radius];
          for (let dx = -span; dx <= span; dx++) {
            const nx = wrapCoord(x + dx, width);
            mark(ny * width + nx, nx, ny);
          }
        }
      }
    }
  }
  return covered ? { data, bounds } : null;
}
