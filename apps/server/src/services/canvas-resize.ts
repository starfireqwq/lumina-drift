import { and, desc, eq, gt } from 'drizzle-orm';
import {
  CanvasSnapshotBundle,
  DEFAULT_TILE_SIZE,
  LayerTileSnapshot,
  TileData,
  VectorAnchor,
  VectorStroke,
  compressTileBuffer,
  decodePacket,
  decompressTileBuffer,
  encodePacket,
  getTileBounds,
  parseTileKey,
  tileKey,
} from '@atelier/shared';
import { db } from '../db';
import { canvasOps, canvasSnapshots, layers } from '../db/schema';

function toUint8Array(data: unknown): Uint8Array {
  if (!data) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)) {
    return new Uint8Array((data as { data: number[] }).data);
  }
  if (Array.isArray(data)) return new Uint8Array(data);
  return new Uint8Array(0);
}

function decodeRawTile(tile: TileData): Uint8Array | null {
  if (!tile || tile.width <= 0 || tile.height <= 0) return null;
  const bytes = toUint8Array(tile.data);
  const expectedLen = tile.width * tile.height * 4;
  if (bytes.length === 0 || expectedLen <= 0) return null;
  try {
    const raw =
      tile.compression === 'lz4'
        ? decompressTileBuffer(bytes, 'lz4', expectedLen)
        : bytes.subarray(0, expectedLen);
    return raw.length >= expectedLen ? raw : null;
  } catch {
    return null;
  }
}

function hasAnyPixel(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return true;
  }
  return false;
}

/** Shifts all coordinates and bounding boxes of a vector stroke by `(offsetX, offsetY)`. */
export function shiftVectorStroke(stroke: VectorStroke, offsetX: number, offsetY: number): VectorStroke {
  const shiftAnchor = (a: VectorAnchor): VectorAnchor => ({
    ...a,
    x: a.x + offsetX,
    y: a.y + offsetY,
    ...(a.cp1x !== undefined ? { cp1x: a.cp1x + offsetX } : {}),
    ...(a.cp1y !== undefined ? { cp1y: a.cp1y + offsetY } : {}),
    ...(a.cp2x !== undefined ? { cp2x: a.cp2x + offsetX } : {}),
    ...(a.cp2y !== undefined ? { cp2y: a.cp2y + offsetY } : {}),
  });
  return {
    ...stroke,
    anchors: stroke.anchors.map(shiftAnchor),
    bounds: stroke.bounds
      ? {
          minX: stroke.bounds.minX + offsetX,
          minY: stroke.bounds.minY + offsetY,
          maxX: stroke.bounds.maxX + offsetX,
          maxY: stroke.bounds.maxY + offsetY,
        }
      : stroke.bounds,
  };
}

function strokeOverlapsCanvas(stroke: VectorStroke, width: number, height: number): boolean {
  const b = stroke.bounds;
  if (!b) return true;
  return b.maxX >= 0 && b.minX <= width && b.maxY >= 0 && b.minY <= height;
}

/**
 * Re-slices sparse raster tiles and translates vector strokes of a folded layer
 * by `(offsetX, offsetY)` within `[0..newWidth, 0..newHeight]`.
 */
export function shiftLayerSnapshot(
  layer: LayerTileSnapshot,
  offsetX: number,
  offsetY: number,
  newWidth: number,
  newHeight: number,
  tileSize: number = DEFAULT_TILE_SIZE
): LayerTileSnapshot {
  const passThrough = new Map<string, TileData>();
  const touched = new Map<string, Uint8Array>();

  const ensureDestTile = (col: number, row: number): { buf: Uint8Array; tw: number; th: number; tx0: number; ty0: number } | null => {
    const tb = getTileBounds(col, row, tileSize, newWidth, newHeight);
    if (tb.width <= 0 || tb.height <= 0) return null;
    const key = tileKey(col, row);
    let buf = touched.get(key);
    if (!buf) {
      buf = new Uint8Array(tb.width * tb.height * 4);
      const existing = passThrough.get(key);
      if (existing) {
        const rawExisting = decodeRawTile(existing);
        if (rawExisting && rawExisting.length >= tb.width * tb.height * 4) {
          buf.set(rawExisting.subarray(0, tb.width * tb.height * 4));
        }
        passThrough.delete(key);
      }
      touched.set(key, buf);
    }
    return { buf, tw: tb.width, th: tb.height, tx0: tb.x, ty0: tb.y };
  };

  for (const srcTile of layer.tiles || []) {
    if (!srcTile || srcTile.width <= 0 || srcTile.height <= 0) continue;
    const dx0 = srcTile.col * tileSize + offsetX;
    const dy0 = srcTile.row * tileSize + offsetY;
    const ix0 = Math.max(0, dx0);
    const iy0 = Math.max(0, dy0);
    const ix1 = Math.min(newWidth, dx0 + srcTile.width);
    const iy1 = Math.min(newHeight, dy0 + srcTile.height);
    if (ix0 >= ix1 || iy0 >= iy1) continue;

    if (offsetX === 0 && offsetY === 0) {
      const tb = getTileBounds(srcTile.col, srcTile.row, tileSize, newWidth, newHeight);
      if (
        tb.width === srcTile.width &&
        tb.height === srcTile.height &&
        dx0 + srcTile.width <= newWidth &&
        dy0 + srcTile.height <= newHeight
      ) {
        const key = tileKey(srcTile.col, srcTile.row);
        if (!touched.has(key)) {
          passThrough.set(key, srcTile);
          continue;
        }
      }
    }

    const srcRaw = decodeRawTile(srcTile);
    if (!srcRaw) continue;

    const minCol = Math.floor(ix0 / tileSize);
    const maxCol = Math.floor((ix1 - 1) / tileSize);
    const minRow = Math.floor(iy0 / tileSize);
    const maxRow = Math.floor((iy1 - 1) / tileSize);

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const dst = ensureDestTile(col, row);
        if (!dst) continue;
        const cx0 = Math.max(ix0, dst.tx0);
        const cy0 = Math.max(iy0, dst.ty0);
        const cx1 = Math.min(ix1, dst.tx0 + dst.tw);
        const cy1 = Math.min(iy1, dst.ty0 + dst.th);
        const copyW = cx1 - cx0;
        const copyH = cy1 - cy0;
        if (copyW <= 0 || copyH <= 0) continue;

        const srcX = cx0 - dx0;
        const dstX = cx0 - dst.tx0;
        const rowBytes = copyW * 4;
        for (let r = 0; r < copyH; r++) {
          const srcOff = ((cy0 + r - dy0) * srcTile.width + srcX) * 4;
          const dstOff = ((cy0 + r - dst.ty0) * dst.tw + dstX) * 4;
          dst.buf.set(srcRaw.subarray(srcOff, srcOff + rowBytes), dstOff);
        }
      }
    }
  }

  const shiftedTiles: TileData[] = Array.from(passThrough.values());
  for (const [key, buf] of touched.entries()) {
    if (!hasAnyPixel(buf)) continue;
    const { col, row } = parseTileKey(key);
    const tb = getTileBounds(col, row, tileSize, newWidth, newHeight);
    const { compression, data } = compressTileBuffer(buf, 'lz4');
    shiftedTiles.push({
      col,
      row,
      width: tb.width,
      height: tb.height,
      compression,
      data,
      byteLength: data.byteLength,
    });
  }

  const shiftedVectors = (layer.vectorStrokes || [])
    .map((s) => shiftVectorStroke(s, offsetX, offsetY))
    .filter((s) => strokeOverlapsCanvas(s, newWidth, newHeight));

  return {
    layerId: layer.layerId,
    name: layer.name,
    tiles: shiftedTiles,
    ...(shiftedVectors.length > 0 ? { vectorStrokes: shiftedVectors } : {}),
  };
}

/** Shifts stored coordinates of editable text layers so double-clicking stays aligned after resize. */
export function shiftTextLayersMeta(canvasId: string, offsetX: number, offsetY: number): boolean {
  if (offsetX === 0 && offsetY === 0) return false;
  const rows = db.select().from(layers).where(eq(layers.canvasId, canvasId)).all();
  const now = Date.now();
  let changed = false;

  for (const row of rows) {
    if (row.layerType !== 'text' || !row.meta) continue;
    try {
      const parsed = JSON.parse(row.meta) as { text?: { x: number; y: number } };
      if (!parsed?.text) continue;
      parsed.text.x = Math.round(parsed.text.x + offsetX);
      parsed.text.y = Math.round(parsed.text.y + offsetY);
      db.update(layers)
        .set({ meta: JSON.stringify(parsed), updatedAt: now })
        .where(eq(layers.id, row.id))
        .run();
      changed = true;
    } catch {
      // Ignore malformed layer metadata
    }
  }
  return changed;
}

/**
 * Fallback only for legacy canvases whose op log has samplePoints-only strokes without tiles:
 * translates samplePoints and vector/tile payloads in ops after `sinceSeq`.
 */
export function shiftLegacyOpsSince(
  canvasId: string,
  sinceSeq: number,
  offsetX: number,
  offsetY: number,
  newWidth: number,
  newHeight: number
): void {
  if (offsetX === 0 && offsetY === 0) return;
  const rows = db
    .select()
    .from(canvasOps)
    .where(and(eq(canvasOps.canvasId, canvasId), gt(canvasOps.seq, sinceSeq)))
    .orderBy(canvasOps.seq)
    .all();

  for (const row of rows) {
    try {
      const packet = decodePacket(row.payloadBlob) as any;
      const p = packet?.payload !== undefined ? packet.payload : packet;
      if (!p || typeof p !== 'object') continue;

      if (Array.isArray(p.samplePoints)) {
        p.samplePoints = p.samplePoints.map((pt: any) => ({ ...pt, x: pt.x + offsetX, y: pt.y + offsetY }));
      }
      if (Array.isArray(p.tiles)) {
        const fakeLayer: LayerTileSnapshot = { layerId: row.layerId || '', name: '', tiles: p.tiles };
        p.tiles = shiftLayerSnapshot(fakeLayer, offsetX, offsetY, newWidth, newHeight).tiles;
      }
      if (p.vectorStroke) p.vectorStroke = shiftVectorStroke(p.vectorStroke, offsetX, offsetY);
      if (Array.isArray(p.vectorAdded)) {
        p.vectorAdded = p.vectorAdded.map((s: VectorStroke) => shiftVectorStroke(s, offsetX, offsetY));
      }

      const encoded = Buffer.from(encodePacket(packet));
      db.update(canvasOps)
        .set({ payloadBlob: encoded })
        .where(and(eq(canvasOps.canvasId, canvasId), eq(canvasOps.seq, row.seq)))
        .run();
    } catch {
      // Skip malformed legacy op
    }
  }
}

export function listSnapshotRowsDesc(canvasId: string): Array<{ seq: number; storagePath: string }> {
  return db
    .select({ seq: canvasSnapshots.seq, storagePath: canvasSnapshots.storagePath })
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.canvasId, canvasId))
    .orderBy(desc(canvasSnapshots.seq))
    .all();
}
