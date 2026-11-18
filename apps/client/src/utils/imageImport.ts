/**
 * 匯入圖片: what a drag carries (files from the desktop, or an image dragged out of a web page),
 * and turning one of them into a canvas that fits the painting. Used by the canvas, the layer
 * list and 檔案 → 匯入圖片.
 */

const IMAGE_EXT = /\.(png|jpe?g|jfif|gif|webp|bmp|avif|svg|ico)$/i;
/** More than this in one drop is almost always a mistake (a whole folder): the rest is left out */
export const MAX_IMPORT_IMAGES = 20;

export const isImageFile = (f: File) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name);

// A drag that started in this page (a layer row, its thumbnail) is never an import, whatever it carries
let internalDrag = false;
if (typeof window !== 'undefined') {
  window.addEventListener('dragstart', () => { internalDrag = true; }, true);
  window.addEventListener('dragend', () => { internalDrag = false; }, true);
  window.addEventListener('drop', () => setTimeout(() => { internalDrag = false; }, 0), true);
}

/** Files, or a link / image dragged in from outside this page */
export function isImageDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt || internalDrag) return false;
  const types = Array.from(dt.types || []);
  return types.includes('Files') || types.includes('text/uri-list');
}

export interface DroppedImages {
  files: File[];
  /** An image dragged out of a web page (no file): its address */
  url: string | null;
}

/** Must run inside the drop event: the browser empties the DataTransfer afterwards */
export function readDroppedImages(dt: DataTransfer): DroppedImages {
  const files = Array.from(dt.files || []);
  if (files.length) return { files, url: null };
  // A picture inside a link: its own src beats the link's address
  const html = dt.getData('text/html');
  const src = html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, '&');
  const uri = dt.getData('text/uri-list').split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
  return { files: [], url: src || uri?.trim() || null };
}

/** A drop on the layer list: above / below a row, inside a group, or (layerId null) under every row */
export interface ImageDropTarget {
  layerId: string | null;
  pos: 'above' | 'below' | 'inside';
}

export interface ImageEntry {
  name: string;
  file?: File;
  url?: string;
}

/** The images to import (in drop order) and how many dropped things were not images */
export function imageEntries(d: DroppedImages): { entries: ImageEntry[]; skipped: number; tooMany: number } {
  const baseName = (n: string) => n.replace(/[?#].*$/, '').split('/').pop()!.replace(/\.[^.]+$/, '').trim().slice(0, 40);
  if (d.files.length) {
    const images = d.files.filter(isImageFile);
    const kept = images.slice(0, MAX_IMPORT_IMAGES);
    return {
      entries: kept.map((file) => ({ name: baseName(file.name) || '匯入的圖片', file })),
      skipped: d.files.length - images.length,
      tooMany: images.length - kept.length,
    };
  }
  if (d.url && /^(https?:|data:image\/|blob:)/i.test(d.url)) {
    let name = '網頁圖片';
    if (!d.url.startsWith('data:')) {
      try { name = decodeURIComponent(baseName(new URL(d.url).pathname)) || name; } catch { /* keep the default */ }
    }
    return { entries: [{ name, url: d.url }], skipped: 0, tooMany: 0 };
  }
  return { entries: [], skipped: d.url ? 1 : 0, tooMany: 0 };
}

export class ImageImportError extends Error {
  constructor(message: string, readonly fromWeb = false) {
    super(message);
  }
}

async function decode(blob: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void }> {
  try {
    const bmp = await createImageBitmap(blob);
    return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
  } catch {
    // SVG (and anything createImageBitmap refuses) goes through an <img>
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new ImageImportError('沒有尺寸的圖片');
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decodes one image and scales it down (never up) to fit maxW × maxH; throws ImageImportError */
export async function loadImageEntry(entry: ImageEntry, maxW: number, maxH: number): Promise<HTMLCanvasElement> {
  let blob: Blob;
  if (entry.file) {
    blob = entry.file;
  } else {
    try {
      const res = await fetch(entry.url!);
      if (!res.ok) throw new Error(String(res.status));
      blob = await res.blob();
    } catch {
      throw new ImageImportError('讀不到這張網頁圖片', true);
    }
    if (!blob.type.startsWith('image/')) throw new ImageImportError('拖進來的不是圖片', true);
  }
  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(blob);
  } catch {
    throw new ImageImportError('無法解碼', Boolean(entry.url));
  }
  try {
    const scale = Math.min(1, maxW / decoded.w, maxH / decoded.h);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(decoded.w * scale));
    out.height = Math.max(1, Math.round(decoded.h * scale));
    const c2d = out.getContext('2d');
    if (!c2d) throw new ImageImportError('記憶體不足');
    c2d.imageSmoothingQuality = 'high';
    c2d.drawImage(decoded.src, 0, 0, out.width, out.height);
    return out;
  } finally {
    decoded.close();
  }
}
