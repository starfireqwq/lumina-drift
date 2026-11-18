import { TileCoord } from '../types/tiles';

export const DEFAULT_TILE_SIZE = 256;

export function tileKey(col: number, row: number): string {
  return `${col}_${row}`;
}

export function parseTileKey(key: string): TileCoord {
  const [colStr, rowStr] = key.split('_');
  return {
    col: parseInt(colStr, 10),
    row: parseInt(rowStr, 10),
  };
}

export function getGridDimensions(
  canvasWidth: number,
  canvasHeight: number,
  tileSize: number = DEFAULT_TILE_SIZE
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.ceil(canvasWidth / tileSize)),
    rows: Math.max(1, Math.ceil(canvasHeight / tileSize)),
  };
}

export function getTileBounds(
  col: number,
  row: number,
  tileSize: number,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number; width: number; height: number } {
  const x = col * tileSize;
  const y = row * tileSize;
  const width = Math.max(0, Math.min(tileSize, canvasWidth - x));
  const height = Math.max(0, Math.min(tileSize, canvasHeight - y));
  return { x, y, width, height };
}

export function pointToTile(x: number, y: number, tileSize: number = DEFAULT_TILE_SIZE): TileCoord {
  return {
    col: Math.floor(x / tileSize),
    row: Math.floor(y / tileSize),
  };
}

export function getDirtyTilesForBoundingBox(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  tileSize: number,
  canvasWidth: number,
  canvasHeight: number
): TileCoord[] {
  const { cols, rows } = getGridDimensions(canvasWidth, canvasHeight, tileSize);

  const startCol = Math.max(0, Math.min(cols - 1, Math.floor(minX / tileSize)));
  const endCol = Math.max(0, Math.min(cols - 1, Math.floor(maxX / tileSize)));
  const startRow = Math.max(0, Math.min(rows - 1, Math.floor(minY / tileSize)));
  const endRow = Math.max(0, Math.min(rows - 1, Math.floor(maxY / tileSize)));

  const dirty: TileCoord[] = [];
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      dirty.push({ col: c, row: r });
    }
  }
  return dirty;
}

export function getDirtyTilesForRadius(
  x: number,
  y: number,
  radius: number,
  tileSize: number,
  canvasWidth: number,
  canvasHeight: number
): TileCoord[] {
  return getDirtyTilesForBoundingBox(
    x - radius,
    y - radius,
    x + radius,
    y + radius,
    tileSize,
    canvasWidth,
    canvasHeight
  );
}

export function getDirtyTilesForPoints(
  points: Array<{ x: number; y: number; radius?: number }>,
  defaultRadius: number,
  tileSize: number,
  canvasWidth: number,
  canvasHeight: number
): TileCoord[] {
  if (points.length === 0) return [];

  // The tiles along the stroke's path (each point and the segments between them, widened by the
  // radius), not its bounding box: a diagonal across a 10000×8000 canvas is ~100 tiles, not all 1250
  const seen = new Map<string, TileCoord>();
  const maxCol = Math.ceil(canvasWidth / tileSize) - 1;
  const maxRow = Math.ceil(canvasHeight / tileSize) - 1;
  const addBox = (x: number, y: number, r: number) => {
    const c0 = Math.max(0, Math.floor((x - r) / tileSize));
    const c1 = Math.min(maxCol, Math.floor((x + r) / tileSize));
    const r0 = Math.max(0, Math.floor((y - r) / tileSize));
    const r1 = Math.min(maxRow, Math.floor((y + r) / tileSize));
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) seen.set(`${col}_${row}`, { col, row });
  };
  const radiusOf = (pt: { radius?: number }) => (pt.radius !== undefined ? pt.radius : defaultRadius);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    addBox(p.x, p.y, radiusOf(p));
    if (i === 0) continue;
    // Samples between two points closer than half a tile, so no tile the segment crosses is missed
    const q = points[i - 1];
    const steps = Math.ceil(Math.hypot(p.x - q.x, p.y - q.y) / (tileSize / 2));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      addBox(q.x + (p.x - q.x) * t, q.y + (p.y - q.y) * t, radiusOf(q) + (radiusOf(p) - radiusOf(q)) * t);
    }
  }
  return Array.from(seen.values());
}
