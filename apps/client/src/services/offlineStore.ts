import {
  CanvasDetailResponse,
  CanvasModel,
  CanvasUnit,
  CreateCanvasDto,
  CreateLayerDto,
  DEFAULT_TILE_SIZE,
  clampDpi,
  LayerModel,
  LayerTileSnapshot,
  TileData,
  UpdateCanvasDto,
  UpdateLayerDto,
  VectorAnchor,
  VectorStroke,
  compressTileBuffer,
  decompressTileBuffer,
  getTileBounds,
  parseTileKey,
  tileKey,
} from '@atelier/shared';
import { compositeLayers, type LayerCanvasItem } from '../engine/layerComposite';

export const LOCAL_ARTIST_ID = 'local-artist';
const SESSION_MODE_KEY = 'atelier_session_mode';
const FILE_PATHS_KEY = 'lumina_canvas_file_paths';
const IDB_NAME = 'LuminaDrift_OfflineStorage';
const IDB_VERSION = 2;
const IDB_STORE = 'offline_canvases';
const IDB_TILE_STORE = 'offline_tiles';
const DRAW_TIME_MAX_GAP_MS = 180_000;

export interface OfflineCanvasRecord {
  canvas: CanvasModel;
  layers: LayerModel[];
  /** layerId -> tileKey ("col_row") -> TileData */
  tilesByLayer: Record<string, Record<string, TileData>>;
  /** layerId -> VectorStroke[] */
  vectorsByLayer: Record<string, VectorStroke[]>;
  seq: number;
  filePath?: string;
  thumbnail?: string;
  updatedAt: number;
  strokeCount?: number;
  drawTimeMs?: number;
  storageV?: number;
}

interface OfflineTileRow {
  id: string;
  canvasId: string;
  layerId: string;
  tileKey: string;
  tile: TileData;
}

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

function shiftVectorStroke(stroke: VectorStroke, offsetX: number, offsetY: number): VectorStroke {
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

function shiftOfflineLayerSnapshot(
  layer: LayerTileSnapshot,
  offsetX: number,
  offsetY: number,
  newWidth: number,
  newHeight: number,
  tileSize: number = DEFAULT_TILE_SIZE
): LayerTileSnapshot {
  const passThrough = new Map<string, TileData>();
  const touched = new Map<string, Uint8Array>();

  const ensureDestTile = (col: number, row: number) => {
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

class OfflineSessionStoreImpl {
  private records = new Map<string, OfflineCanvasRecord>();
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private initPromise: Promise<void> | null = null;
  private saveTimers = new Map<string, number>();
  private writesInProgress = new Map<string, Promise<void>>();
  private modeListeners = new Set<(mode: 'offline' | 'collaborative') => void>();
  private filePaths = new Map<string, string>();
  private dirtyTileOps = new Map<string, Map<string, { layerId: string; key: string; tile: TileData }>>();
  private dirtyFullRewrite = new Set<string>();
  private deletedLayersByCanvas = new Map<string, Set<string>>();
  private drawClocks = new Map<string, { lastOpAt: number; drawTimeMs: number }>();

  constructor() {
    this.loadFilePaths();
  }

  private loadFilePaths() {
    if (typeof window === 'undefined') return;
    try {
      const raw = JSON.parse(localStorage.getItem(FILE_PATHS_KEY) || '{}');
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') this.filePaths.set(k, v);
      }
    } catch {
      // Ignore invalid JSON
    }
  }

  public setCanvasFilePath(canvasId: string, filePath: string | null) {
    if (filePath) this.filePaths.set(canvasId, filePath);
    else this.filePaths.delete(canvasId);
    const rec = this.records.get(canvasId);
    if (rec) rec.filePath = filePath || undefined;
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(FILE_PATHS_KEY, JSON.stringify(Object.fromEntries(this.filePaths.entries())));
      } catch {
        // Ignore storage error
      }
    }
  }

  public getCanvasFilePath(canvasId: string): string | null {
    return this.filePaths.get(canvasId) || this.records.get(canvasId)?.filePath || null;
  }

  public getSessionMode(): 'offline' | 'collaborative' {
    if (typeof window === 'undefined') return 'collaborative';
    return localStorage.getItem(SESSION_MODE_KEY) === 'offline' ? 'offline' : 'collaborative';
  }

  public isOfflineMode(): boolean {
    return this.getSessionMode() === 'offline';
  }

  public isOfflineCanvas(canvasId: string | null | undefined): boolean {
    if (!canvasId) return this.isOfflineMode();
    return canvasId.startsWith('local_') || this.records.has(canvasId) || this.isOfflineMode();
  }

  public setSessionMode(mode: 'offline' | 'collaborative') {
    if (typeof window !== 'undefined') {
      localStorage.setItem(SESSION_MODE_KEY, mode);
    }
    this.modeListeners.forEach((cb) => cb(mode));
  }

  public subscribeSessionMode(cb: (mode: 'offline' | 'collaborative') => void): () => void {
    this.modeListeners.add(cb);
    return () => this.modeListeners.delete(cb);
  }

  private getDB(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(IDB_NAME, IDB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
              db.createObjectStore(IDB_STORE, { keyPath: 'canvas.id' });
            }
            if (!db.objectStoreNames.contains(IDB_TILE_STORE)) {
              const tiles = db.createObjectStore(IDB_TILE_STORE, { keyPath: 'id' });
              tiles.createIndex('by_canvas', 'canvasId', { unique: false });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return this.dbPromise;
  }

  public async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const db = await this.getDB();
        if (!db) return;
        const hasTileStore = db.objectStoreNames.contains(IDB_TILE_STORE);
        await new Promise<void>((resolve) => {
          try {
            const storeNames = hasTileStore ? [IDB_STORE, IDB_TILE_STORE] : [IDB_STORE];
            const tx = db.transaction(storeNames, 'readonly');
            const metaReq = tx.objectStore(IDB_STORE).getAll();
            const tileReq = hasTileStore ? tx.objectStore(IDB_TILE_STORE).getAll() : null;
            let metaList: OfflineCanvasRecord[] = [];
            let tileList: OfflineTileRow[] = [];

            metaReq.onsuccess = () => {
              metaList = (metaReq.result || []) as OfflineCanvasRecord[];
            };
            if (tileReq) {
              tileReq.onsuccess = () => {
                tileList = (tileReq.result || []) as OfflineTileRow[];
              };
            }
            tx.oncomplete = () => {
              for (const item of metaList) {
                if (item?.canvas?.id && !this.records.has(item.canvas.id)) {
                  const hasLegacyInlineTiles = item.tilesByLayer && Object.keys(item.tilesByLayer).length > 0;
                  this.records.set(item.canvas.id, {
                    ...item,
                    tilesByLayer: item.tilesByLayer || {},
                    vectorsByLayer: item.vectorsByLayer || {},
                  });
                  if (item.filePath) this.filePaths.set(item.canvas.id, item.filePath);
                  if (hasLegacyInlineTiles && item.storageV !== 2) {
                    this.dirtyFullRewrite.add(item.canvas.id);
                    this.schedulePersist(item.canvas.id);
                  }
                }
              }
              for (const row of tileList) {
                const rec = this.records.get(row.canvasId);
                if (!rec) continue;
                const layerMap = rec.tilesByLayer[row.layerId] || (rec.tilesByLayer[row.layerId] = {});
                if (!layerMap[row.tileKey]) {
                  layerMap[row.tileKey] = row.tile;
                }
              }
              resolve();
            };
            tx.onerror = () => resolve();
          } catch {
            resolve();
          }
        });
      })();
    }
    return this.initPromise;
  }

  private markDirtyTiles(canvasId: string, layerId: string, tiles: TileData[]) {
    if (this.dirtyFullRewrite.has(canvasId)) return;
    let map = this.dirtyTileOps.get(canvasId);
    if (!map) {
      map = new Map();
      this.dirtyTileOps.set(canvasId, map);
    }
    for (const t of tiles) {
      if (!t) continue;
      const key = `${t.col}_${t.row}`;
      map.set(`${layerId}\0${key}`, {
        layerId,
        key,
        tile: { ...t, data: toUint8Array(t.data) },
      });
    }
  }

  private schedulePersist(canvasId: string) {
    if (typeof window === 'undefined') return;
    if (this.saveTimers.has(canvasId)) return;
    const timer = window.setTimeout(() => {
      void this.persistRecordNow(canvasId).catch((error) => console.error('Offline canvas autosave failed:', error));
    }, 250);
    this.saveTimers.set(canvasId, timer);
  }

  public async flushPendingWrites(): Promise<void> {
    const queued = new Set([...this.saveTimers.keys(), ...this.dirtyFullRewrite]);
    for (const id of queued) void this.persistRecordNow(id);
    await Promise.all(this.writesInProgress.values());
  }

  public persistRecordNow(canvasId: string): Promise<void> {
    clearTimeout(this.saveTimers.get(canvasId));
    this.saveTimers.delete(canvasId);
    const prior = this.writesInProgress.get(canvasId);
    const write = (prior ?? Promise.resolve()).catch(() => {}).then(() => this.writeRecord(canvasId)).finally(() => {
      if (this.writesInProgress.get(canvasId) === write) this.writesInProgress.delete(canvasId);
    });
    this.writesInProgress.set(canvasId, write);
    return write;
  }

  private async writeRecord(canvasId: string): Promise<void> {
    const db = await this.getDB();
    const rec = this.records.get(canvasId);
    if (!rec) return;
    if (!db) {
      this.dirtyFullRewrite.add(canvasId);
      throw new Error('Offline canvas storage is unavailable.');
    }

    const fullRewrite = this.dirtyFullRewrite.has(canvasId);
    const dirtyMap = this.dirtyTileOps.get(canvasId);
    const deletedLayers = this.deletedLayersByCanvas.get(canvasId);
    const hasTileStore = db.objectStoreNames.contains(IDB_TILE_STORE);

    this.dirtyFullRewrite.delete(canvasId);
    this.dirtyTileOps.delete(canvasId);
    this.deletedLayersByCanvas.delete(canvasId);

    // Metadata-only payload inside offline_canvases (zero whole-canvas tile blob clone on autosave)
    const metaRecord: OfflineCanvasRecord = hasTileStore
      ? {
          canvas: rec.canvas,
          layers: rec.layers,
          tilesByLayer: {},
          vectorsByLayer: rec.vectorsByLayer,
          seq: rec.seq,
          filePath: rec.filePath,
          thumbnail: rec.thumbnail,
          updatedAt: rec.updatedAt,
          strokeCount: rec.strokeCount,
          drawTimeMs: rec.drawTimeMs,
          storageV: 2,
        }
      : rec;

    await new Promise<void>((resolve, reject) => {
      const stores = hasTileStore ? [IDB_STORE, IDB_TILE_STORE] : [IDB_STORE];
      const tx = db.transaction(stores, 'readwrite');
      tx.objectStore(IDB_STORE).put(metaRecord);

      if (hasTileStore) {
        const tileStore = tx.objectStore(IDB_TILE_STORE);
        const putAllCurrentTiles = () => {
          for (const [layerId, tileMap] of Object.entries(rec.tilesByLayer)) {
            if (!tileMap) continue;
            for (const [tk, tile] of Object.entries(tileMap)) {
              tileStore.put({
                id: `${canvasId}\0${layerId}\0${tk}`,
                canvasId,
                layerId,
                tileKey: tk,
                tile,
              } satisfies OfflineTileRow);
            }
          }
        };

        if (fullRewrite) {
          const idx = tileStore.index('by_canvas');
          const cursorReq = idx.openKeyCursor(IDBKeyRange.only(canvasId));
          cursorReq.onsuccess = () => {
            const cur = cursorReq.result;
            if (cur) {
              tileStore.delete(cur.primaryKey);
              cur.continue();
            } else {
              putAllCurrentTiles();
            }
          };
        } else {
          if (deletedLayers && deletedLayers.size > 0) {
            const idx = tileStore.index('by_canvas');
            const cursorReq = idx.openCursor(IDBKeyRange.only(canvasId));
            cursorReq.onsuccess = () => {
              const cur = cursorReq.result;
              if (!cur) return;
              const val = cur.value as OfflineTileRow;
              if (deletedLayers.has(val.layerId)) cur.delete();
              cur.continue();
            };
          }
          if (dirtyMap && dirtyMap.size > 0) {
            for (const [compositeId, entry] of dirtyMap.entries()) {
              tileStore.put({
                id: `${canvasId}\0${compositeId}`,
                canvasId,
                layerId: entry.layerId,
                tileKey: entry.key,
                tile: entry.tile,
              } satisfies OfflineTileRow);
            }
          }
        }
      }

      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Offline canvas storage was interrupted.'));
    }).catch((error: unknown) => {
      if (this.records.has(canvasId)) this.dirtyFullRewrite.add(canvasId);
      throw error;
    });
  }

  private async deleteRecordFromDB(canvasId: string): Promise<void> {
    this.dirtyTileOps.delete(canvasId);
    this.dirtyFullRewrite.delete(canvasId);
    this.deletedLayersByCanvas.delete(canvasId);
    const db = await this.getDB();
    if (!db) return;
    const hasTileStore = db.objectStoreNames.contains(IDB_TILE_STORE);
    await new Promise<void>((resolve) => {
      try {
        const stores = hasTileStore ? [IDB_STORE, IDB_TILE_STORE] : [IDB_STORE];
        const tx = db.transaction(stores, 'readwrite');
        tx.objectStore(IDB_STORE).delete(canvasId);
        if (hasTileStore) {
          const tileStore = tx.objectStore(IDB_TILE_STORE);
          const idx = tileStore.index('by_canvas');
          const curReq = idx.openKeyCursor(IDBKeyRange.only(canvasId));
          curReq.onsuccess = () => {
            const cur = curReq.result;
            if (cur) {
              tileStore.delete(cur.primaryKey);
              cur.continue();
            }
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async listRecentCanvases(): Promise<CanvasModel[]> {
    await this.ensureInitialized();
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((record) => record.canvas);
  }

  public saveThumbnail(canvasId: string, thumbnail: string): void {
    const record = this.records.get(canvasId);
    if (!record || record.thumbnail === thumbnail) return;
    record.thumbnail = thumbnail;
    this.schedulePersist(canvasId);
  }

  public async getThumbnail(canvasId: string): Promise<string | undefined> {
    await this.ensureInitialized();
    const record = this.records.get(canvasId);
    if (!record || record.thumbnail) return record?.thumbnail;

    const { canvas, layers, tilesByLayer } = record;
    const scale = Math.min(1, 220 / Math.max(canvas.width, canvas.height));
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    const tileSize = DEFAULT_TILE_SIZE;
    const stamp = document.createElement('canvas');
    const stampCtx = stamp.getContext('2d')!;
    const items: LayerCanvasItem[] = [];

    for (const layer of layers) {
      if (!layer.isVisible && layer.layerType !== 'group') continue;
      const image = document.createElement('canvas');
      image.width = width;
      image.height = height;
      const ctx = image.getContext('2d')!;
      const tiles = Object.values(tilesByLayer[layer.id] ?? {});
      for (let index = 0; index < tiles.length; index++) {
        if (index > 0 && index % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        const tile = tiles[index];
        const raw = decodeRawTile(tile);
        if (!raw) continue;
        stamp.width = tile.width;
        stamp.height = tile.height;
        const pixels = stampCtx.createImageData(tile.width, tile.height);
        for (let offset = 0; offset < raw.length; offset += 4) {
          const alpha = raw[offset + 3];
          if (!alpha) continue;
          for (let channel = 0; channel < 3; channel++) pixels.data[offset + channel] = raw[offset + channel] * 255 / alpha;
          pixels.data[offset + 3] = alpha;
        }
        stampCtx.putImageData(pixels, 0, 0);
        const x = Math.round(tile.col * tileSize * scale);
        const y = Math.round(tile.row * tileSize * scale);
        const right = Math.round((tile.col * tileSize + tile.width) * scale);
        const bottom = Math.round((tile.row * tileSize + tile.height) * scale);
        ctx.drawImage(stamp, x, y, right - x, bottom - y);
      }
      items.push({ layer, canvas: image });
    }

    const masks = new Map(items.filter((item) => item.layer.layerType === 'mask').map((item) => [item.layer.parentId, item]));
    const drawable = items.filter((item) => item.layer.layerType !== 'mask');
    for (const item of drawable) {
      const mask = masks.get(item.layer.id);
      if (mask) item.mask = { canvas: mask.canvas, enabled: true, inverted: mask.layer.meta?.maskInverted };
    }
    if (this.records.get(canvasId) !== record) return;
    if (record.thumbnail) return record.thumbnail;
    const thumbnail = compositeLayers(drawable, width, height, canvas.bgColor).toDataURL('image/jpeg', 0.82);
    this.saveThumbnail(canvasId, thumbnail);
    return thumbnail;
  }

  public async listCanvases(): Promise<CanvasModel[]> {
    await this.ensureInitialized();
    const list = Array.from(this.records.values()).map((r) => r.canvas);
    list.sort((a, b) => a.createdAt - b.createdAt);
    if (list.length === 0) {
      const created = await this.createCanvas({
        title: '🎨 單機畫布 1',
        width: 2048,
        height: 2048,
        bgColor: '#FFFFFF',
      });
      return [created.canvas];
    }
    return list;
  }

  public async createCanvas(
    dto: CreateCanvasDto & { skipDefaultLayers?: boolean }
  ): Promise<{ canvas: CanvasModel; layers: LayerModel[] }> {
    await this.ensureInitialized();
    const now = Date.now();
    const canvasId = `local_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const canvas: CanvasModel = {
      id: canvasId,
      ownerId: LOCAL_ARTIST_ID,
      title: dto.title?.trim() || '未命名畫布',
      width: dto.width || 2048,
      height: dto.height || 2048,
      dpi: clampDpi(dto.dpi ?? 300),
      unit: dto.unit || 'px',
      bgColor: dto.bgColor || '#FFFFFF',
      accessMode: 'invite',
      inviteCode: null,
      roomPassHash: null,
      hasPassword: false,
      latestSeq: 1,
      createdAt: now,
      updatedAt: now,
    };

    const layers: LayerModel[] = dto.skipDefaultLayers
      ? []
      : [
          {
            id: `layer_${now}_1`,
            canvasId,
            parentId: null,
            ownerId: LOCAL_ARTIST_ID,
            ownerDisplayName: '本機畫師',
            name: '圖層 1',
            layerType: 'raster',
            blendMode: 'normal',
            opacity: 1,
            isVisible: true,
            isLocked: false,
            alphaLocked: false,
            clipToBelow: false,
            sortOrder: 10,
            aclMode: 'owner_only',
            isPublic: true,
            createdAt: now,
            updatedAt: now,
          },
        ];

    const record: OfflineCanvasRecord = {
      canvas,
      layers,
      tilesByLayer: {},
      vectorsByLayer: {},
      seq: 1,
      updatedAt: now,
    };

    this.records.set(canvasId, record);
    await this.persistRecordNow(canvasId);
    return { canvas, layers };
  }

  private ensureRecord(canvasId: string): OfflineCanvasRecord {
    let rec = this.records.get(canvasId);
    if (!rec) {
      const now = Date.now();
      const canvas: CanvasModel = {
        id: canvasId,
        ownerId: LOCAL_ARTIST_ID,
        title: '單機畫布',
        width: 2048,
        height: 2048,
        dpi: 300,
        bgColor: '#FFFFFF',
        accessMode: 'invite',
        inviteCode: null,
        roomPassHash: null,
        hasPassword: false,
        latestSeq: 1,
        createdAt: now,
        updatedAt: now,
      };
      const layer1: LayerModel = {
        id: `layer_${now}_1`,
        canvasId,
        parentId: null,
        ownerId: LOCAL_ARTIST_ID,
        ownerDisplayName: '本機畫師',
        name: '圖層 1',
        layerType: 'raster',
        blendMode: 'normal',
        opacity: 1,
        isVisible: true,
        isLocked: false,
        alphaLocked: false,
        clipToBelow: false,
        sortOrder: 10,
        aclMode: 'owner_only',
        isPublic: true,
        createdAt: now,
        updatedAt: now,
      };
      rec = {
        canvas,
        layers: [layer1],
        tilesByLayer: {},
        vectorsByLayer: {},
        seq: 1,
        updatedAt: now,
      };
      this.records.set(canvasId, rec);
    }
    return rec;
  }

  public async getCanvas(canvasId: string): Promise<CanvasDetailResponse> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    return {
      canvas: rec.canvas,
      myMembership: {
        canvasId,
        userId: LOCAL_ARTIST_ID,
        role: 'owner',
        canCreateLayer: true,
        canDeleteOtherLayer: true,
        canExport: true,
        canManageMembers: true,
        joinedAt: rec.canvas.createdAt,
      },
      layers: [...rec.layers].sort((a, b) => a.sortOrder - b.sortOrder),
    };
  }

  public async updateCanvas(canvasId: string, dto: UpdateCanvasDto): Promise<CanvasModel> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    if (dto.title !== undefined) rec.canvas.title = dto.title;
    if (dto.bgColor !== undefined) rec.canvas.bgColor = dto.bgColor;
    rec.canvas.updatedAt = Date.now();
    rec.updatedAt = rec.canvas.updatedAt;
    this.schedulePersist(canvasId);
    return { ...rec.canvas };
  }

  public async deleteCanvas(canvasId: string): Promise<void> {
    await this.ensureInitialized();
    this.records.delete(canvasId);
    this.filePaths.delete(canvasId);
    await this.deleteRecordFromDB(canvasId);
  }

  public async resizeCanvas(
    canvasId: string,
    width: number,
    height: number,
    offsetX: number = 0,
    offsetY: number = 0,
    dpi?: number,
    unit?: CanvasUnit
  ): Promise<CanvasModel> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    const sameDimensions = width === rec.canvas.width && height === rec.canvas.height && offsetX === 0 && offsetY === 0;
    if (!sameDimensions) {
      for (const layer of rec.layers) {
        const tileMap = rec.tilesByLayer[layer.id] || {};
        const existingTiles = Object.values(tileMap);
        const existingVectors = rec.vectorsByLayer[layer.id] || [];
        if (existingTiles.length > 0 || existingVectors.length > 0) {
          const shifted = shiftOfflineLayerSnapshot(
            {
            layerId: layer.id,
            name: layer.name,
            tiles: existingTiles,
            vectorStrokes: existingVectors,
          },
          offsetX,
          offsetY,
          width,
          height
        );
        const nextMap: Record<string, TileData> = {};
        for (const t of shifted.tiles) {
          nextMap[`${t.col}_${t.row}`] = t;
        }
        rec.tilesByLayer[layer.id] = nextMap;
        rec.vectorsByLayer[layer.id] = shifted.vectorStrokes || [];
      }
      if (layer.layerType === 'text' && layer.meta?.text && (offsetX !== 0 || offsetY !== 0)) {
        layer.meta = {
          ...layer.meta,
          text: {
            ...layer.meta.text,
            x: Math.round(layer.meta.text.x + offsetX),
            y: Math.round(layer.meta.text.y + offsetY),
          },
        };
      }
    }
    }
    rec.canvas = {
      ...rec.canvas,
      width,
      height,
      ...(dpi !== undefined ? { dpi: clampDpi(dpi) } : {}),
      ...(unit !== undefined ? { unit } : {}),
      updatedAt: Date.now(),
    };
    rec.updatedAt = Date.now();
    this.dirtyFullRewrite.add(canvasId);
    await this.persistRecordNow(canvasId);
    return { ...rec.canvas };
  }

  public async listLayers(canvasId: string): Promise<LayerModel[]> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    return [...rec.layers].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  public async createLayer(canvasId: string, dto: CreateLayerDto): Promise<LayerModel> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    const now = Date.now();
    const sorted = [...rec.layers].sort((a, b) => a.sortOrder - b.sortOrder);

    let sortOrder = dto.sortOrder ?? (sorted.length > 0 ? sorted[sorted.length - 1].sortOrder + 10 : 10);

    if (dto.layerType === 'mask' && dto.parentId) {
      const parent = sorted.find((l) => l.id === dto.parentId);
      if (parent) sortOrder = parent.sortOrder + 5;
    } else if (dto.aboveLayerId) {
      const idx = sorted.findIndex((l) => l.id === dto.aboveLayerId);
      if (idx !== -1) {
        sorted.splice(idx + 1, 0, null as unknown as LayerModel);
        sorted.forEach((item, i) => {
          if (item) item.sortOrder = (i + 1) * 10;
          else sortOrder = (i + 1) * 10;
        });
      }
    } else if (dto.belowLayerId) {
      const idx = sorted.findIndex((l) => l.id === dto.belowLayerId);
      if (idx !== -1) {
        sorted.splice(idx, 0, null as unknown as LayerModel);
        sorted.forEach((item, i) => {
          if (item) item.sortOrder = (i + 1) * 10;
          else sortOrder = (i + 1) * 10;
        });
      }
    }

    // Keep masks positioned at parent.sortOrder + 5
    for (const l of rec.layers) {
      if (l.layerType === 'mask' && l.parentId) {
        const p = rec.layers.find((x) => x.id === l.parentId);
        if (p) l.sortOrder = p.sortOrder + 5;
      }
    }

    const newLayer: LayerModel = {
      id: `layer_${now}_${Math.random().toString(36).slice(2, 7)}`,
      canvasId,
      parentId: dto.parentId ?? null,
      ownerId: LOCAL_ARTIST_ID,
      ownerDisplayName: '本機畫師',
      name: dto.name || '新圖層',
      layerType: dto.layerType || 'raster',
      blendMode: dto.blendMode || 'normal',
      opacity: dto.opacity ?? 1,
      isVisible: true,
      isLocked: false,
      alphaLocked: false,
      clipToBelow: false,
      sortOrder,
      aclMode: dto.aclMode || 'owner_only',
      isPublic: dto.isPublic ?? true,
      screentoneEnabled: dto.screentoneEnabled ?? false,
      screentoneLpi: dto.screentoneLpi ?? 45,
      screentoneAngle: dto.screentoneAngle ?? 45,
      screentoneDotScale: dto.screentoneDotScale ?? 1,
      meta: dto.meta ?? null,
      createdAt: now,
      updatedAt: now,
    };

    rec.layers.push(newLayer);
    rec.layers.sort((a, b) => a.sortOrder - b.sortOrder);
    rec.updatedAt = now;
    this.schedulePersist(canvasId);
    return { ...newLayer };
  }

  public async updateLayer(canvasId: string, layerId: string, dto: UpdateLayerDto): Promise<LayerModel> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    const target = rec.layers.find((l) => l.id === layerId);
    if (!target) throw new Error('找不到該圖層');
    Object.assign(target, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.blendMode !== undefined ? { blendMode: dto.blendMode } : {}),
      ...(dto.opacity !== undefined ? { opacity: dto.opacity } : {}),
      ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
      ...(dto.isLocked !== undefined ? { isLocked: dto.isLocked } : {}),
      ...(dto.alphaLocked !== undefined ? { alphaLocked: dto.alphaLocked } : {}),
      ...(dto.clipToBelow !== undefined ? { clipToBelow: dto.clipToBelow } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
      ...(dto.aclMode !== undefined ? { aclMode: dto.aclMode } : {}),
      ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
      ...(dto.screentoneEnabled !== undefined ? { screentoneEnabled: dto.screentoneEnabled } : {}),
      ...(dto.screentoneLpi !== undefined ? { screentoneLpi: dto.screentoneLpi } : {}),
      ...(dto.screentoneAngle !== undefined ? { screentoneAngle: dto.screentoneAngle } : {}),
      ...(dto.screentoneDotScale !== undefined ? { screentoneDotScale: dto.screentoneDotScale } : {}),
      ...(dto.meta !== undefined ? { meta: dto.meta } : {}),
      ...(dto.layerType !== undefined ? { layerType: dto.layerType } : {}),
      updatedAt: Date.now(),
    });
    rec.updatedAt = Date.now();
    this.schedulePersist(canvasId);
    return { ...target };
  }

  public async deleteLayer(
    canvasId: string,
    layerId: string,
    withContents = false
  ): Promise<{ deletedIds?: string[]; liftedIds?: string[] }> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    const target = rec.layers.find((l) => l.id === layerId);
    if (!target) return { deletedIds: [], liftedIds: [] };

    const deletedIds: string[] = [layerId];
    const liftedIds: string[] = [];

    if (target.layerType === 'group') {
      if (withContents) {
        const collectChildren = (parentId: string) => {
          for (const l of rec.layers) {
            if (l.parentId === parentId && !deletedIds.includes(l.id)) {
              deletedIds.push(l.id);
              collectChildren(l.id);
            }
          }
        };
        collectChildren(layerId);
      } else {
        for (const l of rec.layers) {
          if (l.parentId === layerId && l.layerType !== 'mask') {
            l.parentId = target.parentId ?? null;
            liftedIds.push(l.id);
          }
        }
      }
    }

    // Also remove masks attached to any deleted layer
    for (const l of rec.layers) {
      if (l.layerType === 'mask' && l.parentId && deletedIds.includes(l.parentId) && !deletedIds.includes(l.id)) {
        deletedIds.push(l.id);
      }
    }

    const gone = new Set(deletedIds);
    rec.layers = rec.layers.filter((l) => !gone.has(l.id));
    let delSet = this.deletedLayersByCanvas.get(canvasId);
    if (!delSet) {
      delSet = new Set();
      this.deletedLayersByCanvas.set(canvasId, delSet);
    }
    for (const id of deletedIds) {
      delete rec.tilesByLayer[id];
      delete rec.vectorsByLayer[id];
      delSet.add(id);
    }
    const dirtyMap = this.dirtyTileOps.get(canvasId);
    if (dirtyMap) {
      for (const [k, v] of dirtyMap.entries()) {
        if (gone.has(v.layerId)) dirtyMap.delete(k);
      }
    }
    rec.updatedAt = Date.now();
    this.schedulePersist(canvasId);
    return { deletedIds, liftedIds };
  }

  public async reorderLayers(canvasId: string, layerIds: string[]): Promise<LayerModel[]> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    const orderMap = new Map(layerIds.map((id, idx) => [id, (idx + 1) * 10]));
    for (const l of rec.layers) {
      const order = orderMap.get(l.id);
      if (order !== undefined) {
        l.sortOrder = order;
      } else if (l.layerType === 'mask' && l.parentId) {
        const pOrder = orderMap.get(l.parentId);
        if (pOrder !== undefined) l.sortOrder = pOrder + 5;
      }
    }
    rec.layers.sort((a, b) => a.sortOrder - b.sortOrder);
    rec.updatedAt = Date.now();
    this.schedulePersist(canvasId);
    return [...rec.layers];
  }

  public async writeLayerTiles(canvasId: string, layerId: string, tiles: TileData[]): Promise<number> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    const map = rec.tilesByLayer[layerId] || (rec.tilesByLayer[layerId] = {});
    for (const t of tiles) {
      if (!t) continue;
      map[`${t.col}_${t.row}`] = {
        ...t,
        data: toUint8Array(t.data),
      };
    }
    this.markDirtyTiles(canvasId, layerId, tiles);
    rec.seq += 1;
    rec.canvas.latestSeq = rec.seq;
    rec.updatedAt = Date.now();
    this.schedulePersist(canvasId);
    return rec.seq;
  }

  public async writeLayerVectors(canvasId: string, layerId: string, vectorAdded: VectorStroke[]): Promise<void> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    const list = rec.vectorsByLayer[layerId] || (rec.vectorsByLayer[layerId] = []);
    for (const s of vectorAdded) {
      const idx = list.findIndex((x) => x.id === s.id);
      if (idx >= 0) list[idx] = s;
      else list.push(s);
    }
    rec.seq += 1;
    rec.canvas.latestSeq = rec.seq;
    rec.updatedAt = Date.now();
    this.schedulePersist(canvasId);
  }

  public recordLocalStroke(canvasId: string, countStroke: boolean = true): { strokeCount: number; drawTimeMs: number } {
    const rec = this.ensureRecord(canvasId);
    const now = Date.now();
    let clock = this.drawClocks.get(canvasId);
    if (!clock) {
      clock = { lastOpAt: 0, drawTimeMs: rec.drawTimeMs ?? 0 };
      this.drawClocks.set(canvasId, clock);
    }
    const gap = now - clock.lastOpAt;
    if (clock.lastOpAt > 0 && gap > 0 && gap <= DRAW_TIME_MAX_GAP_MS) {
      clock.drawTimeMs += gap;
    }
    clock.lastOpAt = now;
    rec.drawTimeMs = clock.drawTimeMs;
    if (countStroke) {
      rec.strokeCount = (rec.strokeCount ?? 0) + 1;
    }
    this.schedulePersist(canvasId);
    return {
      strokeCount: rec.strokeCount ?? 0,
      drawTimeMs: rec.drawTimeMs ?? 0,
    };
  }

  public getCanvasTelemetry(canvasId: string): { strokeCount: number; drawTimeMs: number } {
    const rec = this.records.get(canvasId);
    const clock = this.drawClocks.get(canvasId);
    return {
      strokeCount: rec?.strokeCount ?? 0,
      drawTimeMs: clock?.drawTimeMs ?? rec?.drawTimeMs ?? 0,
    };
  }

  public commitLocalOp(canvasId: string, layerId: string, _opType: string, payload: any): number {
    const rec = this.ensureRecord(canvasId);
    if (payload && typeof payload === 'object') {
      if (Array.isArray(payload.tiles)) {
        const map = rec.tilesByLayer[layerId] || (rec.tilesByLayer[layerId] = {});
        for (const t of payload.tiles as TileData[]) {
          if (!t) continue;
          map[`${t.col}_${t.row}`] = {
            ...t,
            data: toUint8Array(t.data),
          };
        }
        this.markDirtyTiles(canvasId, layerId, payload.tiles as TileData[]);
      }
      if (Array.isArray(payload.vectorReplaced)) {
        rec.vectorsByLayer[layerId] = [...payload.vectorReplaced];
      } else {
        let list = rec.vectorsByLayer[layerId] || (rec.vectorsByLayer[layerId] = []);
        const removed = payload.vectorRemovedIds ?? payload.vectorRemoved;
        if (Array.isArray(removed) && removed.length > 0) {
          const rm = new Set(removed as string[]);
          list = list.filter((s) => !rm.has(s.id));
          rec.vectorsByLayer[layerId] = list;
        }
        if (Array.isArray(payload.vectorAdded) && payload.vectorAdded.length > 0) {
          for (const s of payload.vectorAdded as VectorStroke[]) {
            const idx = list.findIndex((x) => x.id === s.id);
            if (idx >= 0) list[idx] = s;
            else list.push(s);
          }
        }
      }
    }
    rec.seq += 1;
    rec.canvas.latestSeq = rec.seq;
    rec.updatedAt = Date.now();
    this.schedulePersist(canvasId);
    return rec.seq;
  }

  public commitLocalTilePatch(canvasId: string, layerId: string, tiles: TileData[]): number {
    const rec = this.ensureRecord(canvasId);
    const map = rec.tilesByLayer[layerId] || (rec.tilesByLayer[layerId] = {});
    for (const t of tiles) {
      if (!t) continue;
      map[`${t.col}_${t.row}`] = {
        ...t,
        data: toUint8Array(t.data),
      };
    }
    this.markDirtyTiles(canvasId, layerId, tiles);
    rec.seq += 1;
    rec.canvas.latestSeq = rec.seq;
    rec.updatedAt = Date.now();
    this.schedulePersist(canvasId);
    return rec.seq;
  }

  public async getSnapshot(canvasId: string): Promise<{ bundle: { seq: number; layers: LayerTileSnapshot[] } }> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    const layers: LayerTileSnapshot[] = rec.layers.map((l) => ({
      layerId: l.id,
      name: l.name,
      tiles: Object.values(rec.tilesByLayer[l.id] || {}),
      vectorStrokes: rec.vectorsByLayer[l.id] || [],
    }));
    return {
      bundle: {
        seq: rec.seq,
        layers,
      },
    };
  }

  public async getOpsSince(canvasId: string, _sinceSeq: number = 0): Promise<{ ops: any[]; latestSeq: number }> {
    await this.ensureInitialized();
    const rec = this.ensureRecord(canvasId);
    return { ops: [], latestSeq: rec.seq };
  }
}

export const OfflineSessionStore = new OfflineSessionStoreImpl();
