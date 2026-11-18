import JSZip from 'jszip';
import {
  CanvasModel,
  DEFAULT_TILE_SIZE,
  LayerModel,
  TileData,
  VectorStroke,
} from '@atelier/shared';
import { ApiService } from '../services/api';
import { OfflineSessionStore } from '../services/offlineStore';
import { getProjectSavePicker, pickProjectFile, writeProjectFile } from '../services/projectFileHandles';
import { compressTiles } from './commitWorkers';
import { compositeLayers, type LayerCanvasItem } from './layerComposite';

export const LUMINA_MIMETYPE = 'application/x-lumina-drift-project';
export const LUMINA_SCHEMA_VERSION = 1;
export const LUMINA_APP_VERSION = '1.0.0';

function projectFilename(canvas: CanvasModel): string {
  const title = (canvas.title || 'artwork').replace(/[\\/:*?"<>|]/g, '_');
  return /\.lumina$/i.test(title) ? title : `${title}.lumina`;
}

export interface LuminaProjectMeta {
  schemaVersion: number;
  appVersion: string;
  format: 'lumina-drift-project';
  createdAt: number;
  updatedAt: number;
  canvas: {
    id: string;
    title: string;
    width: number;
    height: number;
    bgColor: string;
    dpi: number;
  };
  layerCount: number;
  checksum: string;
}

export interface UnpackedLuminaProject {
  meta: LuminaProjectMeta;
  layers: LayerModel[];
  /** layerId -> PNG data URL */
  layerPngDataUrls: Record<string, string>;
  vectorStrokes: Record<string, VectorStroke[]>;
  previewDataUrl: string | null;
  filePath?: string;
}

async function computeSha256Hex(text: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fallback below
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to encode canvas to Blob'));
      },
      type,
      quality
    );
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Converts a straight-alpha layer PNG data URL into premultiplied 256×256 LZ4 tiles */
export async function pngDataUrlToTiles(url: string, width: number, height: number): Promise<TileData[]> {
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

/**
 * Schema migration pipeline for forward/backward compatibility of .lumina project metadata.
 */
export function migrateLuminaProject(raw: any): LuminaProjectMeta {
  if (!raw || typeof raw !== 'object') {
    throw new Error('無效的 .lumina 專案中繼資料 (project.json)');
  }
  const now = Date.now();
  const c = raw.canvas || {};
  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : LUMINA_SCHEMA_VERSION,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : LUMINA_APP_VERSION,
    format: 'lumina-drift-project',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    canvas: {
      id: typeof c.id === 'string' ? c.id : `local_${now}`,
      title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : '未命名畫布',
      width: Math.max(64, Math.min(16384, Number(c.width) || 2048)),
      height: Math.max(64, Math.min(16384, Number(c.height) || 2048)),
      bgColor: typeof c.bgColor === 'string' ? c.bgColor : '#FFFFFF',
      dpi: Number(c.dpi) || 300,
    },
    layerCount: typeof raw.layerCount === 'number' ? raw.layerCount : 0,
    checksum: typeof raw.checksum === 'string' ? raw.checksum : '',
  };
}

export class LuminaProjectEngine {
  /**
   * Packages the current canvas, layer hierarchy, layer pixels, masks, vectors, animation metadata,
   * and a 512px composite `preview.png` into an open-source `.lumina` ZIP container.
   */
  public static async packProject(
    canvas: CanvasModel,
    layers: LayerModel[],
    getLayerCanvases: () => Promise<LayerCanvasItem[]>
  ): Promise<{
    blob: Blob;
    uint8: Uint8Array;
    filename: string;
    previewDataUrl: string;
    meta: LuminaProjectMeta;
  }> {
    const zip = new JSZip();

    // 1. Standard mimetype header first (uncompressed STORE, like OpenRaster / EPUB)
    zip.file('mimetype', LUMINA_MIMETYPE, { compression: 'STORE' });

    const layerCanvases = await getLayerCanvases();
    const vectorStrokes: Record<string, VectorStroke[]> = {};
    const layersFolder = zip.folder('layers')!;

    // 2. Save each non-group layer's lossless PNG & mask PNG
    for (const item of layerCanvases) {
      if (item.layer.layerType !== 'group') {
        const pngBlob = await canvasToBlob(item.canvas, 'image/png');
        layersFolder.file(`layer_${item.layer.id}.png`, pngBlob, { compression: 'DEFLATE' });
      }
      if (item.layer.layerType === 'vector' && item.vectorStrokes?.length) {
        vectorStrokes[item.layer.id] = item.vectorStrokes;
      }
      if (item.mask?.id && item.mask.canvas) {
        const maskBlob = await canvasToBlob(item.mask.canvas, 'image/png');
        layersFolder.file(`layer_${item.mask.id}.png`, maskBlob, { compression: 'DEFLATE' });
      }
    }

    // 3. Generate composite 512x512 max preview.png for Windows Explorer IThumbnailProvider & in-app cards
    const maxThumbDim = 512;
    const scale = Math.min(1, maxThumbDim / Math.max(canvas.width, canvas.height));
    const thumbW = Math.max(1, Math.round(canvas.width * scale));
    const thumbH = Math.max(1, Math.round(canvas.height * scale));
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = thumbW;
    thumbCanvas.height = thumbH;
    const thumbCtx = thumbCanvas.getContext('2d')!;
    const fullComposite = compositeLayers(
      layerCanvases,
      canvas.width,
      canvas.height,
      canvas.bgColor || '#FFFFFF'
    );
    thumbCtx.drawImage(fullComposite, 0, 0, thumbW, thumbH);
    const previewBlob = await canvasToBlob(thumbCanvas, 'image/png');
    const previewDataUrl = thumbCanvas.toDataURL('image/png');
    zip.file('preview.png', previewBlob, { compression: 'STORE' });

    // 4. Hierarchy, vectors, and animation metadata
    const orderedLayers = [...layers].sort((a, b) => a.sortOrder - b.sortOrder);
    const hierarchyJson = JSON.stringify(orderedLayers, null, 2);
    layersFolder.file('hierarchy.json', hierarchyJson, { compression: 'DEFLATE' });

    zip.file('vectors.json', JSON.stringify(vectorStrokes, null, 2), { compression: 'DEFLATE' });

    const animFolders = orderedLayers
      .filter((l) => l.layerType === 'group' && l.meta?.animation)
      .map((l) => ({
        folderId: l.id,
        name: l.name,
        animation: l.meta?.animation,
        cels: orderedLayers
          .filter((c) => c.parentId === l.id)
          .map((c) => ({ id: c.id, name: c.name, cel: c.meta?.cel })),
      }));
    zip.file('animation.json', JSON.stringify({ tracks: animFolders }, null, 2), {
      compression: 'DEFLATE',
    });

    // 5. Project metadata & integrity checksum
    const now = Date.now();
    const checksum = await computeSha256Hex(
      `${canvas.width}x${canvas.height}:${orderedLayers.length}:${hierarchyJson}`
    );
    const meta: LuminaProjectMeta = {
      schemaVersion: LUMINA_SCHEMA_VERSION,
      appVersion: LUMINA_APP_VERSION,
      format: 'lumina-drift-project',
      createdAt: canvas.createdAt || now,
      updatedAt: now,
      canvas: {
        id: canvas.id,
        title: canvas.title || '未命名畫布',
        width: canvas.width,
        height: canvas.height,
        bgColor: canvas.bgColor || '#FFFFFF',
        dpi: canvas.dpi || 300,
      },
      layerCount: orderedLayers.length,
      checksum,
    };
    zip.file('project.json', JSON.stringify(meta, null, 2), { compression: 'DEFLATE' });

    const uint8 = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    const blob = new Blob([uint8 as unknown as BlobPart], { type: LUMINA_MIMETYPE });
    return { blob, uint8, filename: projectFilename(canvas), previewDataUrl, meta };
  }

  /**
   * Unpacks and validates a `.lumina` ZIP archive from disk or drag-and-drop.
   */
  public static async unpackProject(
    input: Blob | ArrayBuffer | Uint8Array,
    filePath?: string
  ): Promise<UnpackedLuminaProject> {
    const zip = await JSZip.loadAsync(input);

    const projectFile = zip.file('project.json');
    if (!projectFile) {
      throw new Error('此檔案不包含 project.json，不是有效的 .lumina 專案檔。');
    }
    const rawMeta = JSON.parse(await projectFile.async('string'));
    const meta = migrateLuminaProject(rawMeta);

    const hierarchyFile = zip.file('layers/hierarchy.json');
    if (!hierarchyFile) {
      throw new Error('此 .lumina 專案檔缺少 layers/hierarchy.json 圖層結構資料。');
    }
    const layers: LayerModel[] = JSON.parse(await hierarchyFile.async('string'));

    let vectorStrokes: Record<string, VectorStroke[]> = {};
    const vectorsFile = zip.file('vectors.json');
    if (vectorsFile) {
      try {
        vectorStrokes = JSON.parse(await vectorsFile.async('string')) || {};
      } catch {
        vectorStrokes = {};
      }
    }

    const layerPngDataUrls: Record<string, string> = {};
    for (const layer of layers) {
      const pngEntry = zip.file(`layers/layer_${layer.id}.png`);
      if (pngEntry) {
        const pngBlob = await pngEntry.async('blob');
        layerPngDataUrls[layer.id] = await blobToDataUrl(
          new Blob([pngBlob], { type: 'image/png' })
        );
      }
    }

    let previewDataUrl: string | null = null;
    const previewEntry = zip.file('preview.png');
    if (previewEntry) {
      try {
        const previewBlob = await previewEntry.async('blob');
        previewDataUrl = await blobToDataUrl(new Blob([previewBlob], { type: 'image/png' }));
      } catch {
        previewDataUrl = null;
      }
    }

    return {
      meta,
      layers,
      layerPngDataUrls,
      vectorStrokes,
      previewDataUrl,
      filePath,
    };
  }

  /**
   * Restores an unpacked `.lumina` project into a new canvas (offline or online depending on active mode).
   */
  public static async restoreToCanvas(
    unpacked: UnpackedLuminaProject,
    onProgress?: (done: number, total: number) => void,
    { shareEditableLayers = false, groupId }: { shareEditableLayers?: boolean; groupId?: string } = {},
  ): Promise<CanvasModel> {
    const { meta, layers, layerPngDataUrls, vectorStrokes, filePath } = unpacked;
    const src = meta.canvas;
    const offline = OfflineSessionStore.isOfflineMode();
    const serverUrl = ApiService.getServerUrl();
    const { canvas, layers: defaults } = await ApiService.createCanvas({
      title: src.title,
      width: src.width,
      height: src.height,
      dpi: src.dpi,
      bgColor: src.bgColor,
      groupId,
    });

    try {
      const byId = new Map(layers.map((l) => [l.id, l]));
      const depth = (l: LayerModel) => {
        let d = 0;
        for (let p = l.parentId; p && d < 32; p = byId.get(p)?.parentId ?? null) d++;
        return d;
      };

      const ordered = [...layers].sort((a, b) => depth(a) - depth(b) || a.sortOrder - b.sortOrder);
      const idMap = new Map<string, string>();
      const snapshots = Object.entries(layerPngDataUrls).filter(([id]) => byId.has(id));
      const vectors = ordered.filter(
        (layer) => layer.layerType === 'vector' && vectorStrokes?.[layer.id]?.length
      );
      const total = ordered.length + snapshots.length + vectors.length;
      let done = 0;

      for (const l of ordered) {
        const shared = shareEditableLayers && !l.isLocked && l.layerType !== 'group' && l.layerType !== 'mask';
        const created = await ApiService.createLayer(canvas.id, {
          name: l.name,
          layerType: l.layerType,
          blendMode: l.blendMode,
          opacity: l.opacity,
          parentId: l.parentId ? idMap.get(l.parentId) ?? null : null,
          sortOrder: l.sortOrder,
          meta: l.meta ?? null,
          isPublic: shared,
          aclMode: shared ? 'shared_all' : undefined,
          screentoneEnabled: l.screentoneEnabled,
          screentoneLpi: l.screentoneLpi,
          screentoneAngle: l.screentoneAngle,
          screentoneDotScale: l.screentoneDotScale,
        });
        idMap.set(l.id, created.id);
        onProgress?.(++done, total);
      }

      // Remap cel.ref if any animation cel references another layer ID
      for (const l of ordered) {
        if (l.meta?.cel?.ref && idMap.has(l.meta.cel.ref)) {
          const newLayerId = idMap.get(l.id)!;
          const newRefId = idMap.get(l.meta.cel.ref)!;
          await ApiService.updateLayer(canvas.id, newLayerId, {
            meta: {
              ...l.meta,
              cel: { ...l.meta.cel, ref: newRefId },
            },
          });
        }
      }

      for (const [oldId, url] of snapshots) {
        const tiles = await pngDataUrlToTiles(url, src.width, src.height);
        const targetLayerId = idMap.get(oldId)!;
        for (let i = 0; i < tiles.length; i += 48) {
          await ApiService.writeLayerTiles(
            canvas.id,
            targetLayerId,
            tiles.slice(i, i + 48),
            '載入 .lumina 專案'
          );
        }
        onProgress?.(++done, total);
      }

      for (const layer of vectors) {
        const layerId = idMap.get(layer.id)!;
        const strokes = vectorStrokes[layer.id];
        for (let i = 0; i < strokes.length; i += 48) {
          await ApiService.writeLayerVectors(
            canvas.id,
            layerId,
            strokes.slice(i, i + 48).map((stroke) => ({ ...stroke, layerId }))
          );
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
        if (id && Object.keys(patch).length) {
          await ApiService.updateLayer(canvas.id, id, patch);
        }
      }

      // Remove the default initial layer created with the canvas
      if (layers.length && defaults?.length) {
        for (const d of defaults) {
          await ApiService.updateLayer(canvas.id, d.id, { isLocked: false }).catch(() => undefined);
          await ApiService.deleteLayer(canvas.id, d.id).catch(() => undefined);
        }
      }

      if (filePath && !shareEditableLayers) OfflineSessionStore.setCanvasFilePath(canvas.id, filePath);
      return canvas;
    } catch (error) {
      if (serverUrl === ApiService.getServerUrl() && offline === OfflineSessionStore.isOfflineMode()) {
        await ApiService.deleteCanvas(canvas.id).catch((cleanupError) => {
          console.warn('Failed to remove the unfinished Lumina import:', canvas.id, cleanupError);
        });
      }
      throw error;
    }
  }

  /**
   * Saves the active canvas as a `.lumina` file (via Electron native atomic save dialog if available,
   * or browser file download otherwise).
   */
  public static async saveProject(
    canvas: CanvasModel,
    layers: LayerModel[],
    getLayerCanvases: () => Promise<LayerCanvasItem[]>,
    options?: { saveAs?: boolean; onlyExisting?: boolean }
  ): Promise<{ saved: boolean; filename?: string; filePath?: string; previewDataUrl?: string }> {
    const desktop = typeof window !== 'undefined' ? ((window as any).atelierDesktop ?? (window as any).atelierMobile) : undefined;
    const existingPath = options?.saveAs ? null : OfflineSessionStore.getCanvasFilePath(canvas.id);
    if (options?.onlyExisting && (!desktop?.saveLuminaFile || !existingPath)) return { saved: false };

    if (desktop?.saveLuminaFile) {
      const packed = await this.packProject(canvas, layers, getLayerCanvases);
      const res = await desktop.saveLuminaFile({
        defaultName: packed.filename,
        existingFilePath: existingPath || undefined,
        onlyExisting: options?.onlyExisting,
        data: packed.uint8,
      });
      if (!res?.saved) {
        return { saved: false };
      }
      if (res.filePath) {
        OfflineSessionStore.setCanvasFilePath(canvas.id, res.filePath);
      }
      return {
        saved: true,
        filename: packed.filename,
        filePath: res.filePath,
        previewDataUrl: packed.previewDataUrl,
      };
    }

    const picker = getProjectSavePicker();
    if (picker) {
      let handle;
      try {
        // The browser needs user activation to open a picker, so choose the file
        // before asynchronous canvas extraction and archive compression.
        handle = await pickProjectFile(picker, canvas.id, projectFilename(canvas), Boolean(existingPath));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return { saved: false };
        throw error;
      }
      const packed = await this.packProject(canvas, layers, getLayerCanvases);
      await writeProjectFile(canvas.id, handle, packed.blob);
      OfflineSessionStore.setCanvasFilePath(canvas.id, handle.name);
      return { saved: true, filename: handle.name, previewDataUrl: packed.previewDataUrl };
    }

    // Web browser download fallback
    const packed = await this.packProject(canvas, layers, getLayerCanvases);
    const url = URL.createObjectURL(packed.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = packed.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    return {
      saved: true,
      filename: packed.filename,
      previewDataUrl: packed.previewDataUrl,
    };
  }
}
