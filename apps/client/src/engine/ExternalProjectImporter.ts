import JSZip from 'jszip';
import { readPsd, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { psdToLuminaAdjustment } from './psdAdjustmentMapping';
import { clampDpi, tidyLayerModels, type BlendMode, type LayerModel } from '@atelier/shared';
import {
  LuminaProjectEngine,
  LUMINA_APP_VERSION,
  LUMINA_SCHEMA_VERSION,
  type UnpackedLuminaProject,
} from './LuminaProjectEngine';
import { compositeLayers, type LayerCanvasItem } from './layerComposite';
import {
  clampImportedCanvasDimensions,
  convertKraTileToRgba8,
  detectProjectFormatFromName,
  mapKraBlendMode,
  mapPsdBlendMode,
  parseKraInheritAlpha,
  parseKraTileStream,
  type SupportedProjectFormat,
} from './kraDecoder';

async function toUint8Array(data: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const buf = await data.arrayBuffer();
  return new Uint8Array(buf);
}

function stripTitleFromFileName(name?: string, fallback = '匯入的畫布'): string {
  if (!name) return fallback;
  const base = name.split(/[/\\]/).pop() || '';
  const stripped = base.replace(/\.(lumina|psd|kra)$/i, '').trim();
  return (stripped || fallback).slice(0, 64);
}

function makeLayerModel(params: {
  id: string;
  canvasId: string;
  parentId: string | null;
  name: string;
  layerType: LayerModel['layerType'];
  blendMode: BlendMode;
  opacity: number;
  isVisible: boolean;
  isLocked?: boolean;
  alphaLocked?: boolean;
  clipToBelow?: boolean;
  sortOrder: number;
  now: number;
}): LayerModel {
  return {
    id: params.id,
    canvasId: params.canvasId,
    parentId: params.parentId,
    ownerId: 'local-artist',
    ownerDisplayName: '本機畫師',
    name: params.name.trim() || '圖層',
    layerType: params.layerType,
    blendMode: params.blendMode,
    opacity: Math.max(0, Math.min(1, Number.isFinite(params.opacity) ? params.opacity : 1)),
    isVisible: params.isVisible,
    isLocked: Boolean(params.isLocked),
    alphaLocked: Boolean(params.alphaLocked),
    clipToBelow: Boolean(params.clipToBelow),
    sortOrder: params.sortOrder,
    aclMode: 'owner_only',
    isPublic: true,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

function createPreviewDataUrlFromSource(source: HTMLCanvasElement | HTMLImageElement, maxSide = 512): string | null {
  const sw = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const sh = 'naturalHeight' in source ? source.naturalHeight : source.height;
  if (!sw || !sh) return null;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const pw = Math.max(1, Math.round(sw * scale));
  const ph = Math.max(1, Math.round(sh * scale));
  const preview = document.createElement('canvas');
  preview.width = pw;
  preview.height = ph;
  const ctx = preview.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, pw, ph);
  ctx.drawImage(source, 0, 0, pw, ph);
  return preview.toDataURL('image/png');
}

function canvasHasNonZeroAlpha(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return true;
  }
  return false;
}

function renderPsdMaskCanvas(
  mask: NonNullable<PsdLayer['mask']>,
  targetWidth: number,
  targetHeight: number,
  scale: number
): HTMLCanvasElement | null {
  if (!mask.canvas && mask.defaultColor === undefined) return null;
  const c = document.createElement('canvas');
  c.width = targetWidth;
  c.height = targetHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const bg = mask.defaultColor === 255 ? 255 : 0;
  ctx.fillStyle = `rgb(${bg},${bg},${bg})`;
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  if (mask.canvas && mask.canvas.width > 0 && mask.canvas.height > 0) {
    const dx = Math.round((mask.left ?? 0) * scale);
    const dy = Math.round((mask.top ?? 0) * scale);
    const dw = Math.max(1, Math.round(mask.canvas.width * scale));
    const dh = Math.max(1, Math.round(mask.canvas.height * scale));
    ctx.drawImage(mask.canvas, dx, dy, dw, dh);
  }
  // Ensure opaque greyscale RGBA so maskCoverage reads red * alpha cleanly
  const img = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = Math.round((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * (d[i + 3] / 255));
    d[i] = lum;
    d[i + 1] = lum;
    d[i + 2] = lum;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function buildCompositePreview(
  layers: LayerModel[],
  canvasesById: Map<string, HTMLCanvasElement>,
  width: number,
  height: number
): string | null {
  try {
    const maskByOwner = new Map<string, LayerModel>();
    for (const l of layers) {
      if (l.layerType === 'mask' && l.parentId) {
        maskByOwner.set(l.parentId, l);
      }
    }
    const items: LayerCanvasItem[] = [];
    for (const l of layers) {
      if (l.layerType === 'mask') continue;
      const ownCanvas = canvasesById.get(l.id) ?? (() => {
        const empty = document.createElement('canvas');
        empty.width = width;
        empty.height = height;
        return empty;
      })();
      const maskLayer = maskByOwner.get(l.id);
      const maskCanvas = maskLayer ? canvasesById.get(maskLayer.id) : undefined;
      items.push({
        layer: l,
        canvas: ownCanvas,
        ...(maskLayer && maskCanvas
          ? {
              mask: {
                id: maskLayer.id,
                canvas: maskCanvas,
                enabled: maskLayer.isVisible,
                inverted: Boolean(maskLayer.meta?.maskInverted),
              },
            }
          : {}),
      });
    }
    const composite = compositeLayers(items, width, height, '#FFFFFF');
    return createPreviewDataUrlFromSource(composite, 512);
  } catch {
    return null;
  }
}

/**
 * Unpacks an Adobe Photoshop (`.psd`) file into an `UnpackedLuminaProject`.
 * Preserves nested groups, raster layers, blend modes, opacity, visibility, clipping,
 * transparency/composite locks, and layer/group masks.
 */
export async function unpackPsdProject(
  data: Blob | ArrayBuffer | Uint8Array,
  fileName?: string
): Promise<UnpackedLuminaProject> {
  const bytes = await toUint8Array(data);
  if (bytes.byteLength < 26) {
    throw new Error('PSD 檔案內容不完整或已損毀。');
  }

  let psd: Psd;
  try {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    psd = readPsd(copy.buffer, { skipThumbnail: true });
  } catch (err: any) {
    throw new Error(`無法解析 PSD 檔案：${err?.message || String(err)}`);
  }

  const { width, height, scale } = clampImportedCanvasDimensions(psd.width, psd.height);
  const dpiRaw = psd.imageResources?.resolutionInfo?.horizontalResolution;
  const dpi = clampDpi(typeof dpiRaw === 'number' && dpiRaw > 0 ? dpiRaw : 300);
  const now = Date.now();
  const canvasId = `psd_${now}`;
  const title = stripTitleFromFileName(fileName, '匯入的 PSD');

  const layers: LayerModel[] = [];
  const layerPngDataUrls: Record<string, string> = {};
  const canvasesById = new Map<string, HTMLCanvasElement>();
  let seq = 0;
  let sortCounter = 10;

  const nextId = (prefix: string) => `${prefix}_${++seq}`;
  /** Photoshop adjustment layers that were left out / only partly converted ("name（type）") */
  const importNotes: string[] = [];
  const partialNotes: string[] = [];

  const addMaskIfPresent = (ownerId: string, mask: PsdLayer['mask'] | undefined) => {
    if (!mask) return;
    const maskCanvas = renderPsdMaskCanvas(mask, width, height, scale);
    if (!maskCanvas) return;
    const maskId = nextId('psd_mask');
    layers.push(
      makeLayerModel({
        id: maskId,
        canvasId,
        parentId: ownerId,
        name: '圖層蒙版',
        layerType: 'mask',
        blendMode: 'normal',
        opacity: 1,
        isVisible: !mask.disabled,
        sortOrder: sortCounter,
        now,
      })
    );
    sortCounter += 10;
    canvasesById.set(maskId, maskCanvas);
    layerPngDataUrls[maskId] = maskCanvas.toDataURL('image/png');
  };

  // ag-psd stores `children` bottom-to-top (index 0 = bottommost)
  const walk = (nodes: PsdLayer[], parentId: string | null) => {
    for (const node of nodes) {
      const isGroup = Array.isArray(node.children);
      const id = nextId(isGroup ? 'psd_group' : 'psd_layer');
      const opacity = typeof node.opacity === 'number' ? node.opacity : 1;
      const blendMode = mapPsdBlendMode(node.blendMode);

      if (isGroup) {
        // Emit children before the group (Lumina ascending order: group sits right above its children)
        if (node.children && node.children.length > 0) {
          walk(node.children, id);
        }
        layers.push(
          makeLayerModel({
            id,
            canvasId,
            parentId,
            name: node.name || `圖層組 ${seq}`,
            layerType: 'group',
            blendMode,
            opacity,
            isVisible: !node.hidden,
            isLocked: Boolean(node.protected?.composite),
            alphaLocked: Boolean(node.protected?.transparency),
            clipToBelow: false,
            sortOrder: sortCounter,
            now,
          })
        );
        sortCounter += 10;
        addMaskIfPresent(id, node.mask);
      } else if (node.adjustment) {
        // Photoshop adjustment layers: six kinds become Lumina adjustment layers, the rest are left out
        const mapped = psdToLuminaAdjustment(node.adjustment);
        const label = node.name || mapped.kindLabel;
        if (!mapped.adjustment) {
          importNotes.push(`${label}（${mapped.kindLabel}）`);
          continue;
        }
        if (mapped.partial) partialNotes.push(`${label}（${mapped.kindLabel}）`);
        layers.push({
          ...makeLayerModel({
            id,
            canvasId,
            parentId,
            name: label,
            layerType: 'adjustment',
            blendMode,
            opacity,
            isVisible: !node.hidden,
            isLocked: Boolean(node.protected?.composite),
            clipToBelow: Boolean(node.clipping),
            sortOrder: sortCounter,
            now,
          }),
          meta: { adjustment: mapped.adjustment },
        });
        sortCounter += 10;
        addMaskIfPresent(id, node.mask);
      } else {
        layers.push(
          makeLayerModel({
            id,
            canvasId,
            parentId,
            name: node.name || `圖層 ${seq}`,
            layerType: 'raster',
            blendMode,
            opacity,
            isVisible: !node.hidden,
            isLocked: Boolean(node.protected?.composite),
            alphaLocked: Boolean(node.protected?.transparency),
            clipToBelow: Boolean(node.clipping),
            sortOrder: sortCounter,
            now,
          })
        );
        sortCounter += 10;

        if (node.canvas && node.canvas.width > 0 && node.canvas.height > 0) {
          const full = document.createElement('canvas');
          full.width = width;
          full.height = height;
          const ctx = full.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            const dx = Math.round((node.left ?? 0) * scale);
            const dy = Math.round((node.top ?? 0) * scale);
            const dw = Math.max(1, Math.round(node.canvas.width * scale));
            const dh = Math.max(1, Math.round(node.canvas.height * scale));
            ctx.drawImage(node.canvas, dx, dy, dw, dh);
            if (canvasHasNonZeroAlpha(full)) {
              canvasesById.set(id, full);
              layerPngDataUrls[id] = full.toDataURL('image/png');
            }
          }
        }

        addMaskIfPresent(id, node.mask);
      }
    }
  };

  if (psd.children && psd.children.length > 0) {
    walk(psd.children, null);
  } else if (psd.canvas && psd.canvas.width > 0 && psd.canvas.height > 0) {
    // Flattened PSD fallback
    const id = nextId('psd_bg');
    layers.push(
      makeLayerModel({
        id,
        canvasId,
        parentId: null,
        name: '背景',
        layerType: 'raster',
        blendMode: 'normal',
        opacity: 1,
        isVisible: true,
        sortOrder: sortCounter,
        now,
      })
    );
    const full = document.createElement('canvas');
    full.width = width;
    full.height = height;
    const ctx = full.getContext('2d');
    if (ctx) {
      ctx.drawImage(
        psd.canvas,
        0,
        0,
        Math.max(1, Math.round(psd.canvas.width * scale)),
        Math.max(1, Math.round(psd.canvas.height * scale))
      );
      canvasesById.set(id, full);
      layerPngDataUrls[id] = full.toDataURL('image/png');
    }
  }

  if (layers.length === 0) {
    layers.push(
      makeLayerModel({
        id: nextId('psd_empty'),
        canvasId,
        parentId: null,
        name: '圖層 1',
        layerType: 'raster',
        blendMode: 'normal',
        opacity: 1,
        isVisible: true,
        sortOrder: 10,
        now,
      })
    );
  }

  const tidied = tidyLayerModels(layers).layers;
  const previewDataUrl =
    (psd.canvas ? createPreviewDataUrlFromSource(psd.canvas, 512) : null) ||
    buildCompositePreview(tidied, canvasesById, width, height);

  return {
    meta: {
      schemaVersion: LUMINA_SCHEMA_VERSION,
      appVersion: LUMINA_APP_VERSION,
      format: 'lumina-drift-project',
      createdAt: now,
      updatedAt: now,
      canvas: {
        id: canvasId,
        title,
        width,
        height,
        bgColor: '#FFFFFF',
        dpi,
      },
      layerCount: tidied.length,
      checksum: '',
    },
    layers: tidied,
    layerPngDataUrls,
    vectorStrokes: {},
    previewDataUrl,
    ...(importNotes.length || partialNotes.length ? { adjustmentNotes: { skipped: importNotes, partial: partialNotes } } : {}),
    // Never bind .psd path as .lumina autosave target
    filePath: undefined,
  };
}

function findKraZipEntry(zip: JSZip, imageName: string, layerFileName: string): JSZip.JSZipObject | null {
  if (!layerFileName) return null;
  const direct = zip.file(`${imageName}/layers/${layerFileName}`);
  if (direct) return direct;
  const suffix = `/layers/${layerFileName}`.toLowerCase();
  for (const key of Object.keys(zip.files)) {
    if (key.toLowerCase().endsWith(suffix) && !zip.files[key].dir) {
      return zip.files[key];
    }
  }
  return null;
}

function directChildElementsByTag(parent: Element, tagName: string): Element[] {
  const lower = tagName.toLowerCase();
  const out: Element[] = [];
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.tagName.toLowerCase() === lower) out.push(child);
  }
  return out;
}

async function decodeKraImageBlobToDataUrl(blob: Blob, targetW: number, targetH: number): Promise<string | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = targetW;
    c.height = targetH;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, targetW, targetH);
    return c.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeKraBlobToPreview(blob: Blob, maxSide = 512): Promise<string | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return createPreviewDataUrlFromSource(img, maxSide);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Unpacks a Krita (`.kra`) document archive into an `UnpackedLuminaProject`.
 * Decodes `maindoc.xml` layer hierarchy, VERSION 2 LZF/planar binary tiles, blend modes,
 * opacity, visibility, alpha-inheritance (clipping), locks, and transparency masks.
 */
export async function unpackKraProject(
  data: Blob | ArrayBuffer | Uint8Array,
  fileName?: string
): Promise<UnpackedLuminaProject> {
  const bytes = await toUint8Array(data);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err: any) {
    throw new Error(`無法解壓縮 .kra 檔案：${err?.message || String(err)}`);
  }

  const mainDocFile = zip.file('maindoc.xml');
  if (!mainDocFile) {
    throw new Error('此 .kra 檔案缺少 maindoc.xml，無法開啟。');
  }

  const xmlText = await mainDocFile.async('string');
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const imageEl = doc.querySelector('IMAGE') || doc.getElementsByTagName('IMAGE')[0];
  if (!imageEl) {
    throw new Error('此 .kra 檔案的 maindoc.xml 缺少 IMAGE 定義。');
  }

  const imageName = imageEl.getAttribute('name') || 'Image';
  const rawW = Number.parseInt(imageEl.getAttribute('width') || '1024', 10);
  const rawH = Number.parseInt(imageEl.getAttribute('height') || '1024', 10);
  const rawDpi = Number.parseFloat(imageEl.getAttribute('x-res') || imageEl.getAttribute('y-res') || '300');
  const docColorSpace = imageEl.getAttribute('colorspacename') || 'RGBA';

  const { width, height, scale } = clampImportedCanvasDimensions(rawW, rawH);
  const srcW = Math.max(1, Number.isFinite(rawW) ? rawW : width);
  const srcH = Math.max(1, Number.isFinite(rawH) ? rawH : height);
  const dpi = clampDpi(Number.isFinite(rawDpi) && rawDpi > 0 ? rawDpi : 300);
  const now = Date.now();
  const canvasId = `kra_${now}`;
  const title = stripTitleFromFileName(fileName, imageName || '匯入的 KRA');

  const layers: LayerModel[] = [];
  const layerPngDataUrls: Record<string, string> = {};
  const canvasesById = new Map<string, HTMLCanvasElement>();
  let seq = 0;
  let sortCounter = 10;
  let decodedAnyRaster = false;

  const nextId = (prefix: string) => `${prefix}_${++seq}`;

  const renderTileLayerCanvas = async (
    layerFileName: string,
    offsetX: number,
    offsetY: number,
    colorSpace: string,
    isMask: boolean
  ): Promise<HTMLCanvasElement | null> => {
    const entry = findKraZipEntry(zip, imageName, layerFileName);
    if (!entry) return null;
    const rawStream = await entry.async('uint8array');
    const decoded = parseKraTileStream(rawStream);

    let defaultMaskByte: number | null = null;
    if (isMask) {
      const defEntry = findKraZipEntry(zip, imageName, `${layerFileName}.defaultpixel`);
      if (defEntry) {
        const defBytes = await defEntry.async('uint8array');
        if (defBytes.length > 0) {
          defaultMaskByte = decoded.pixelSize === 2 && defBytes.length >= 2 ? defBytes[1] : defBytes[0];
        }
      }
      if (defaultMaskByte === null) defaultMaskByte = 255;
    }

    if (decoded.tiles.length === 0 && !isMask) return null;

    // Render onto source-resolution RGBA buffer first, then blit/scale onto final canvas
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcW;
    srcCanvas.height = srcH;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    if (!srcCtx) return null;

    const imgData = srcCtx.createImageData(srcW, srcH);
    const dst = imgData.data;

    if (isMask && defaultMaskByte !== null) {
      const v = defaultMaskByte;
      for (let i = 0; i < dst.length; i += 4) {
        dst[i] = v;
        dst[i + 1] = v;
        dst[i + 2] = v;
        dst[i + 3] = 255;
      }
    }

    const tw = decoded.tileWidth;
    const th = decoded.tileHeight;
    const tilePixels = tw * th;

    for (const tile of decoded.tiles) {
      const rgba = convertKraTileToRgba8(tile.raw, tilePixels, decoded.pixelSize, colorSpace, isMask);
      const baseX = tile.left + offsetX;
      const baseY = tile.top + offsetY;
      const startY = Math.max(0, -baseY);
      const endY = Math.min(th, srcH - baseY);
      const startX = Math.max(0, -baseX);
      const endX = Math.min(tw, srcW - baseX);
      if (startX >= endX || startY >= endY) continue;

      for (let ty = startY; ty < endY; ty++) {
        const dy = baseY + ty;
        let srcIdx = (ty * tw + startX) * 4;
        let dstIdx = (dy * srcW + (baseX + startX)) * 4;
        const rowBytes = (endX - startX) * 4;
        dst.set(rgba.subarray(srcIdx, srcIdx + rowBytes), dstIdx);
      }
    }

    srcCtx.putImageData(imgData, 0, 0);

    if (srcW === width && srcH === height && scale === 1) {
      if (!isMask && !canvasHasNonZeroAlpha(srcCanvas)) return null;
      return srcCanvas;
    }

    const targetCanvas = document.createElement('canvas');
    targetCanvas.width = width;
    targetCanvas.height = height;
    const targetCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
    if (!targetCtx) return null;
    if (isMask && defaultMaskByte !== null) {
      const v = defaultMaskByte;
      targetCtx.fillStyle = `rgb(${v},${v},${v})`;
      targetCtx.fillRect(0, 0, width, height);
    }
    targetCtx.drawImage(
      srcCanvas,
      0,
      0,
      Math.max(1, Math.round(srcW * scale)),
      Math.max(1, Math.round(srcH * scale))
    );
    if (!isMask && !canvasHasNonZeroAlpha(targetCanvas)) return null;
    return targetCanvas;
  };

  const attachMasks = async (layerEl: Element, ownerId: string) => {
    const masksContainer = directChildElementsByTag(layerEl, 'masks')[0];
    if (!masksContainer) return;
    const maskEls = directChildElementsByTag(masksContainer, 'mask');
    for (const maskEl of maskEls) {
      const nodeType = (maskEl.getAttribute('nodetype') || '').toLowerCase();
      if (nodeType !== 'transparencymask') continue;
      const maskFile = maskEl.getAttribute('filename') || '';
      const mx = Number.parseInt(maskEl.getAttribute('x') || '0', 10) || 0;
      const my = Number.parseInt(maskEl.getAttribute('y') || '0', 10) || 0;
      const maskCanvas = await renderTileLayerCanvas(maskFile, mx, my, 'ALPHA', true);
      if (!maskCanvas) continue;
      const maskId = nextId('kra_mask');
      layers.push(
        makeLayerModel({
          id: maskId,
          canvasId,
          parentId: ownerId,
          name: maskEl.getAttribute('name') || '透明度蒙版',
          layerType: 'mask',
          blendMode: 'normal',
          opacity: 1,
          isVisible: maskEl.getAttribute('visible') !== '0',
          sortOrder: sortCounter,
          now,
        })
      );
      sortCounter += 10;
      canvasesById.set(maskId, maskCanvas);
      layerPngDataUrls[maskId] = maskCanvas.toDataURL('image/png');
      break; // Lumina supports one mask per layer
    }
  };

  // Krita's <layers> lists top-to-bottom; reverse so Lumina's ascending order is bottom-to-top
  const walkLayersContainer = async (containerEl: Element, parentId: string | null) => {
    const childLayers = directChildElementsByTag(containerEl, 'layer').reverse();
    for (const layerEl of childLayers) {
      const nodeType = (layerEl.getAttribute('nodetype') || 'paintlayer').toLowerCase();
      const name = layerEl.getAttribute('name') || `圖層 ${seq + 1}`;
      const rawOpacity = Number.parseFloat(layerEl.getAttribute('opacity') ?? '255');
      const opacity = Number.isFinite(rawOpacity) ? Math.max(0, Math.min(1, rawOpacity / 255)) : 1;
      const isVisible = layerEl.getAttribute('visible') !== '0';
      const isLocked = layerEl.getAttribute('locked') === '1';
      const channelLock = layerEl.getAttribute('channellockflags') || '';
      const alphaLocked = channelLock.length >= 4 && channelLock[3] === '0';
      const blendMode = mapKraBlendMode(layerEl.getAttribute('compositeop'));

      if (nodeType === 'grouplayer') {
        const groupId = nextId('kra_group');
        const nestedContainer = directChildElementsByTag(layerEl, 'layers')[0];
        if (nestedContainer) {
          await walkLayersContainer(nestedContainer, groupId);
        }
        layers.push(
          makeLayerModel({
            id: groupId,
            canvasId,
            parentId,
            name,
            layerType: 'group',
            blendMode,
            opacity,
            isVisible,
            isLocked,
            alphaLocked,
            clipToBelow: false,
            sortOrder: sortCounter,
            now,
          })
        );
        sortCounter += 10;
        await attachMasks(layerEl, groupId);
        continue;
      }

      // Skip pure non-visual filter/adjustment layers with no pixel file
      const fileAttr = layerEl.getAttribute('filename') || '';
      const hasTileFile = Boolean(fileAttr && findKraZipEntry(zip, imageName, fileAttr));
      if (nodeType !== 'paintlayer' && !hasTileFile) {
        continue;
      }

      const layerId = nextId('kra_layer');
      layers.push(
        makeLayerModel({
          id: layerId,
          canvasId,
          parentId,
          name,
          layerType: 'raster',
          blendMode,
          opacity,
          isVisible,
          isLocked,
          alphaLocked,
          clipToBelow: parseKraInheritAlpha(layerEl),
          sortOrder: sortCounter,
          now,
        })
      );
      sortCounter += 10;

      if (hasTileFile) {
        const lx = Number.parseInt(layerEl.getAttribute('x') || '0', 10) || 0;
        const ly = Number.parseInt(layerEl.getAttribute('y') || '0', 10) || 0;
        const layerCs = layerEl.getAttribute('colorspacename') || docColorSpace;
        const layerCanvas = await renderTileLayerCanvas(fileAttr, lx, ly, layerCs, false);
        if (layerCanvas) {
          decodedAnyRaster = true;
          canvasesById.set(layerId, layerCanvas);
          layerPngDataUrls[layerId] = layerCanvas.toDataURL('image/png');
        }
      }

      await attachMasks(layerEl, layerId);
    }
  };

  const rootLayersEl = directChildElementsByTag(imageEl, 'layers')[0];
  if (rootLayersEl) {
    await walkLayersContainer(rootLayersEl, null);
  }

  // Fallback to mergedimage.png if no raster layers could be decoded (e.g. vector-only KRA)
  const mergedEntry = zip.file('mergedimage.png');
  if (!decodedAnyRaster && mergedEntry) {
    const mergedBlob = await mergedEntry.async('blob');
    const mergedUrl = await decodeKraImageBlobToDataUrl(mergedBlob, width, height);
    if (mergedUrl) {
      const id = nextId('kra_merged');
      layers.push(
        makeLayerModel({
          id,
          canvasId,
          parentId: null,
          name: '合併影像',
          layerType: 'raster',
          blendMode: 'normal',
          opacity: 1,
          isVisible: true,
          sortOrder: sortCounter,
          now,
        })
      );
      layerPngDataUrls[id] = mergedUrl;
    }
  }

  if (layers.length === 0) {
    layers.push(
      makeLayerModel({
        id: nextId('kra_empty'),
        canvasId,
        parentId: null,
        name: '圖層 1',
        layerType: 'raster',
        blendMode: 'normal',
        opacity: 1,
        isVisible: true,
        sortOrder: 10,
        now,
      })
    );
  }

  const tidied = tidyLayerModels(layers).layers;

  let previewDataUrl: string | null = null;
  const previewEntry = zip.file('preview.png') || mergedEntry;
  if (previewEntry) {
    previewDataUrl = await decodeKraBlobToPreview(await previewEntry.async('blob'), 512);
  }
  if (!previewDataUrl) {
    previewDataUrl = buildCompositePreview(tidied, canvasesById, width, height);
  }

  return {
    meta: {
      schemaVersion: LUMINA_SCHEMA_VERSION,
      appVersion: LUMINA_APP_VERSION,
      format: 'lumina-drift-project',
      createdAt: now,
      updatedAt: now,
      canvas: {
        id: canvasId,
        title,
        width,
        height,
        bgColor: '#FFFFFF',
        dpi,
      },
      layerCount: tidied.length,
      checksum: '',
    },
    layers: tidied,
    layerPngDataUrls,
    vectorStrokes: {},
    previewDataUrl,
    // Never bind .kra path as .lumina autosave target
    filePath: undefined,
  };
}

/**
 * Auto-detects and unpacks `.lumina`, `.psd`, or `.kra` project files into `UnpackedLuminaProject`.
 */
export async function unpackSupportedProject(
  data: Blob | ArrayBuffer | Uint8Array,
  fileName?: string,
  filePath?: string
): Promise<{ format: SupportedProjectFormat; project: UnpackedLuminaProject }> {
  const effectiveName = fileName || (data instanceof File ? data.name : undefined) || filePath;
  let format = detectProjectFormatFromName(effectiveName);
  const bytes = await toUint8Array(data);

  // Magic-byte fallback if extension was missing or generic
  if (!format && bytes.byteLength >= 4) {
    // '8BPS' = Adobe Photoshop
    if (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53) {
      format = 'psd';
    } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const zip = await JSZip.loadAsync(bytes);
      if (zip.file('maindoc.xml')) format = 'kra';
      else if (zip.file('project.json')) format = 'lumina';
    }
  }

  if (format === 'psd') {
    return { format: 'psd', project: await unpackPsdProject(bytes, effectiveName) };
  }
  if (format === 'kra') {
    return { format: 'kra', project: await unpackKraProject(bytes, effectiveName) };
  }
  return {
    format: 'lumina',
    project: await LuminaProjectEngine.unpackProject(bytes, filePath),
  };
}
