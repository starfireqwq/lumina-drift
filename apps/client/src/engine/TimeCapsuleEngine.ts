/**
 * Canvas Time Capsule (.ateliersync-capsule) Engine
 *
 * Implements:
 * 1. Packaging multi-layer full raster snapshots + complete history stroke ops into a single file
 * 2. AES-256-GCM encryption with SHA-256 verification
 * 3. Local Timed Cold Backup (IndexedDB `ateliersync_cold_backups`)
 * 4. Disaster Recovery (災難復原) from file or local cold backup
 */

import {
  AtelierSyncCapsuleData,
  CAPSULE_MAGIC,
  CapsuleContent,
  decryptTimeCapsule,
  encryptTimeCapsule,
  CanvasModel,
  DEFAULT_TILE_SIZE,
  LayerModel,
  type TileData,
} from '@atelier/shared';
import { ApiService } from '../services/api';
import { compressTiles } from './commitWorkers';
import { compositeLayers, type LayerCanvasItem } from './layerComposite';

export interface ColdBackupEntry {
  id: string;
  canvasId: string;
  canvasTitle: string;
  timestamp: number;
  totalStrokes: number;
  totalLayers: number;
  dataSize: number;
  isEncrypted: boolean;
  capsuleData: AtelierSyncCapsuleData;
  thumbnailUrl?: string;
}

/** A layer PNG (straight alpha) as premultiplied 256 px tiles, empty tiles skipped, read a tile row at a time */
async function pngToTiles(url: string, width: number, height: number): Promise<TileData[]> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const ts = DEFAULT_TILE_SIZE;
  const strip = document.createElement('canvas');
  strip.width = width;
  strip.height = ts;
  const ctx = strip.getContext('2d', { willReadFrequently: true })!;
  const raw: TileData[] = [];
  for (let y = 0; y < height; y += ts) {
    const h = Math.min(ts, height - y);
    ctx.clearRect(0, 0, width, ts);
    ctx.drawImage(img, 0, -y);
    const row = ctx.getImageData(0, 0, width, h).data;
    for (let x = 0; x < width; x += ts) {
      const w = Math.min(ts, width - x);
      const px = new Uint8Array(w * h * 4);
      let any = false;
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const s = (yy * width + x + xx) * 4;
          const a = row[s + 3];
          if (!a) continue;
          any = true;
          const d = (yy * w + xx) * 4;
          px[d] = Math.round((row[s] * a) / 255);
          px[d + 1] = Math.round((row[s + 1] * a) / 255);
          px[d + 2] = Math.round((row[s + 2] * a) / 255);
          px[d + 3] = a;
        }
      }
      if (any) raw.push({ col: x / ts, row: y / ts, width: w, height: h, compression: 'raw', data: px });
    }
  }
  return compressTiles(raw);
}

const DB_NAME = 'AtelierSync_CapsuleStorage';
const DB_VERSION = 1;
const STORE_NAME = 'cold_backups';

export class TimeCapsuleEngine {
  private static dbPromise: Promise<IDBDatabase> | null = null;
  private static backupIntervalId: number | null = null;

  private static getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('canvasId', 'canvasId', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  /**
   * Bundles the active canvas, multi-layer raster snapshots, and complete operational history
   * into a single .ateliersync-capsule payload
   */
  public static async createCapsule(
    canvas: CanvasModel,
    layers: LayerModel[],
    getLayerCanvases: () => Promise<LayerCanvasItem[]>,
    totalStrokes: number = 0,
    passphrase?: string
  ): Promise<{ capsule: AtelierSyncCapsuleData; filename: string }> {
    // 1. Fetch raster snapshots for each layer as PNG Data URLs
    const layerCanvases = await getLayerCanvases();
    const layerSnapshots: Record<string, string> = {};
    const vectorStrokes: NonNullable<CapsuleContent['manifest']['vectorStrokes']> = {};
    for (const item of layerCanvases) {
      if (item.layer.layerType !== 'group' && item.layer.layerType !== 'adjustment') {
        layerSnapshots[item.layer.id] = item.canvas.toDataURL('image/png');
      }
      if (item.layer.layerType === 'vector') vectorStrokes[item.layer.id] = item.vectorStrokes ?? [];
      // Masks are not items of their own: their pixels are saved under the mask layer's id
      if (item.mask?.id) layerSnapshots[item.mask.id] = item.mask.canvas.toDataURL('image/png');
    }

    // 2. Composite thumbnail
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 400;
    thumbCanvas.height = Math.round((400 / canvas.width) * canvas.height);
    const thumbCtx = thumbCanvas.getContext('2d');
    // As the editor shows it: groups, masks, clipping, the animation frame on screen
    thumbCtx?.drawImage(compositeLayers(layerCanvases, canvas.width, canvas.height, canvas.bgColor || '#FFFFFF'), 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumbnailUrl = thumbCanvas.toDataURL('image/jpeg', 0.85);

    // 3. Fetch entire canvas operational history log (all ops for time-lapse & stroke reconstruction)
    let historyOps: any[] = [];
    try {
      const opsRes = await ApiService.getCanvasOps(canvas.id);
      historyOps = opsRes.ops || [];
    } catch (err) {
      console.warn('[Capsule] Failed to fetch canvas ops, saving snapshot only:', err);
    }

    const now = Date.now();
    const manifest = {
      magic: CAPSULE_MAGIC as typeof CAPSULE_MAGIC,
      version: '1.0' as const,
      createdAt: now,
      canvas,
      layers,
      vectorStrokes,
      totalOps: historyOps.length,
      totalStrokes: totalStrokes || historyOps.length,
      hasReplayLog: historyOps.length > 0,
      isEncrypted: Boolean(passphrase),
      checksum: '',
    };

    const content: CapsuleContent = {
      manifest,
      layerSnapshots,
      historyOps,
      thumbnailUrl,
    };

    // 4. Encrypt with AES-GCM 256 if password provided
    const capsule = await encryptTimeCapsule(content, passphrase);

    const safeTitle = canvas.title.replace(/[\/\\?%*:|"<>]/g, '_');
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${safeTitle}_${dateStr}.ateliersync-capsule`;

    return { capsule, filename };
  }

  /**
   * Downloads the generated capsule file to user disk
   */
  public static downloadCapsuleFile(capsuleData: AtelierSyncCapsuleData, filename: string) {
    const jsonStr = JSON.stringify(capsuleData);
    const blob = new Blob([jsonStr], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Saves a cold backup to local browser IndexedDB
   */
  public static async saveColdBackup(
    canvas: CanvasModel,
    layers: LayerModel[],
    getLayerCanvases: () => Promise<LayerCanvasItem[]>,
    totalStrokes: number,
    passphrase?: string
  ): Promise<ColdBackupEntry> {
    const { capsule } = await this.createCapsule(
      canvas,
      layers,
      getLayerCanvases,
      totalStrokes,
      passphrase
    );

    const jsonStr = JSON.stringify(capsule);
    const dataSize = new Blob([jsonStr]).size;
    const now = Date.now();

    const entry: ColdBackupEntry = {
      id: `backup_${canvas.id}_${now}`,
      canvasId: canvas.id,
      canvasTitle: canvas.title,
      timestamp: now,
      totalStrokes,
      totalLayers: layers.length,
      dataSize,
      isEncrypted: Boolean(passphrase),
      capsuleData: capsule,
      thumbnailUrl: 'thumbnailUrl' in capsule ? (capsule as CapsuleContent).thumbnailUrl : undefined,
    };

    const db = await this.getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return entry;
  }

  /**
   * Lists cold backups for a specific canvas
   */
  public static async listColdBackups(canvasId?: string): Promise<ColdBackupEntry[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        let results: ColdBackupEntry[] = req.result || [];
        if (canvasId) {
          results = results.filter((b) => b.canvasId === canvasId);
        }
        results.sort((a, b) => b.timestamp - a.timestamp);
        resolve(results);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Deletes a cold backup from IndexedDB
   */
  public static async deleteColdBackup(id: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Configures automatic local cold backup timer
   * @param intervalMinutes 0 to disable, or minutes (e.g. 5, 15, 30)
   */
  public static configureAutoBackup(
    intervalMinutes: number,
    performBackup: () => Promise<void>
  ) {
    if (this.backupIntervalId) {
      window.clearInterval(this.backupIntervalId);
      this.backupIntervalId = null;
    }

    if (intervalMinutes > 0) {
      const ms = intervalMinutes * 60 * 1000;
      this.backupIntervalId = window.setInterval(async () => {
        try {
          await performBackup();
        } catch (err) {
          console.warn('[AutoBackup] Timed backup failed:', err);
        }
      }, ms);
    }
  }

  /**
   * Performs Disaster Recovery (災難復原)
   * Decrypts, verifies, and unpacks the capsule content
   */
  /**
   * Rebuilds a capsule as a new canvas (yours): the manifest's layers with their names, types,
   * blend modes, opacity, meta (adjustments, animation, cels, text, inverted masks), masks, groups
   * and order, then raster snapshots. Eyes, locks, α-lock and clipping come last (a locked
   * layer takes no pixels). The new canvas's default background layer is removed.
   */
  public static async restoreToNewCanvas(
    content: CapsuleContent,
    onProgress?: (done: number, total: number) => void,
    preserveAuthors = false,
  ): Promise<CanvasModel> {
    const { canvas: src, layers, vectorStrokes } = content.manifest;
    const { canvas, layers: defaults } = await ApiService.createCanvas({ title: `${src.title}（膠囊還原）`, width: src.width, height: src.height, bgColor: src.bgColor });
    const byId = new Map(layers.map((l) => [l.id, l]));
    const depth = (l: LayerModel) => {
      let d = 0;
      for (let p = l.parentId; p && d < 32; p = byId.get(p)?.parentId ?? null) d++;
      return d;
    };
    // Parents before children (a mask's parent is the layer it masks), each level bottom to top
    const ordered = [...layers].sort((a, b) => depth(a) - depth(b) || a.sortOrder - b.sortOrder);
    const idMap = new Map<string, string>();
    const snapshots = Object.entries(content.layerSnapshots ?? {}).filter(([id]) => {
      const layer = byId.get(id);
      return layer && layer.layerType !== 'adjustment';
    });
    const vectors = ordered.filter((layer) => layer.layerType === 'vector' && vectorStrokes?.[layer.id]?.length);
    const total = ordered.length + snapshots.length + vectors.length;
    let done = 0;
    for (const l of ordered) {
      const { originalAuthor, ...savedMeta } = l.meta ?? {};
      const author = preserveAuthors ? (originalAuthor || l.ownerDisplayName)?.trim() : undefined;
      const meta = author ? { ...savedMeta, originalAuthor: author } : Object.keys(savedMeta).length ? savedMeta : null;
      const created = await ApiService.createLayer(canvas.id, {
        name: l.name,
        layerType: l.layerType,
        blendMode: l.blendMode,
        opacity: l.opacity,
        parentId: l.parentId ? idMap.get(l.parentId) ?? null : null,
        sortOrder: l.sortOrder,
        meta,
        isPublic: false,
        screentoneEnabled: l.screentoneEnabled,
        screentoneLpi: l.screentoneLpi,
        screentoneAngle: l.screentoneAngle,
        screentoneDotScale: l.screentoneDotScale,
      });
      idMap.set(l.id, created.id);
      onProgress?.(++done, total);
    }
    for (const [oldId, url] of snapshots) {
      const tiles = await pngToTiles(url, src.width, src.height);
      for (let i = 0; i < tiles.length; i += 48) await ApiService.writeLayerTiles(canvas.id, idMap.get(oldId)!, tiles.slice(i, i + 48), '時光膠囊還原');
      onProgress?.(++done, total);
    }
    for (const layer of vectors) {
      const layerId = idMap.get(layer.id)!;
      const strokes = vectorStrokes![layer.id];
      for (let i = 0; i < strokes.length; i += 48) {
        await ApiService.writeLayerVectors(canvas.id, layerId, strokes.slice(i, i + 48).map((stroke) => ({ ...stroke, layerId })));
      }
      onProgress?.(++done, total);
    }
    for (const l of layers) {
      const id = idMap.get(l.id);
      const patch: Partial<Record<'isVisible' | 'clipToBelow' | 'alphaLocked' | 'isLocked', boolean>> = {};
      if (!l.isVisible) patch.isVisible = false;
      if (l.clipToBelow) patch.clipToBelow = true;
      if (l.alphaLocked) patch.alphaLocked = true;
      if (l.isLocked) patch.isLocked = true;
      if (id && Object.keys(patch).length) await ApiService.updateLayer(canvas.id, id, patch);
    }
    // The default background layer is locked, and a locked layer cannot be deleted
    if (layers.length) {
      for (const d of defaults ?? []) {
        await ApiService.updateLayer(canvas.id, d.id, { isLocked: false }).catch(() => undefined);
        await ApiService.deleteLayer(canvas.id, d.id).catch(() => undefined);
      }
    }
    return canvas;
  }

  public static async restoreFromCapsule(
    capsuleData: AtelierSyncCapsuleData,
    passphrase?: string
  ): Promise<CapsuleContent> {
    const content = await decryptTimeCapsule(capsuleData, passphrase);
    if (content.manifest.magic !== CAPSULE_MAGIC) {
      throw new Error('未知的膠囊格式，無法進行災難復原。');
    }
    return content;
  }
}
