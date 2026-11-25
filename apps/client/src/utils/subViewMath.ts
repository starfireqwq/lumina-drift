export interface SubViewTransform {
  zoom: number;
  panX: number;
  panY: number;
  rotationDeg: number;
  flipH: boolean;
}

export const DEFAULT_SUB_VIEW_TRANSFORM: SubViewTransform = {
  zoom: 1,
  panX: 0,
  panY: 0,
  rotationDeg: 0,
  flipH: false,
};

export const SUB_VIEW_MIN_ZOOM = 0.1;
export const SUB_VIEW_MAX_ZOOM = 16;

export function clampSubViewZoom(zoom: number): number {
  if (Number.isNaN(zoom)) return DEFAULT_SUB_VIEW_TRANSFORM.zoom;
  return Math.min(SUB_VIEW_MAX_ZOOM, Math.max(SUB_VIEW_MIN_ZOOM, zoom));
}

/** Returns a rotation in [0, 360). Non-finite angles become 0. */
export function normalizeSubViewRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const remainder = deg % 360;
  const positive = remainder < 0 ? remainder + 360 : remainder;
  return positive === 360 ? 0 : positive || 0;
}

export function computeSubViewFitScale(
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
  padding = 12,
): number {
  if (padding < 0) return 1;
  const availableW = viewW - 2 * padding;
  const availableH = viewH - 2 * padding;
  if (![availableW, availableH, imgW, imgH].every(value => Number.isFinite(value) && value > 0)) return 1;
  const scale = Math.min(availableW / imgW, availableH / imgH);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function subViewImageToScreen(
  imgX: number,
  imgY: number,
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
  transform: SubViewTransform,
  padding = 12,
): { x: number; y: number } {
  const scale = computeSubViewFitScale(viewW, viewH, imgW, imgH, padding) * clampSubViewZoom(transform.zoom);
  const dx = (imgX - imgW / 2) * scale * (transform.flipH ? -1 : 1);
  const dy = (imgY - imgH / 2) * scale;
  const rad = transform.rotationDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: viewW / 2 + transform.panX + dx * cos - dy * sin,
    y: viewH / 2 + transform.panY + dx * sin + dy * cos,
  };
}

export function subViewScreenToImage(
  screenX: number,
  screenY: number,
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
  transform: SubViewTransform,
  padding = 12,
): { x: number; y: number; inside: boolean } {
  const scale = computeSubViewFitScale(viewW, viewH, imgW, imgH, padding) * clampSubViewZoom(transform.zoom);
  const dx = screenX - (viewW / 2 + transform.panX);
  const dy = screenY - (viewH / 2 + transform.panY);
  const rad = transform.rotationDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x = imgW / 2 + (dx * cos + dy * sin) / scale * (transform.flipH ? -1 : 1);
  const y = imgH / 2 + (-dx * sin + dy * cos) / scale;
  return { x, y, inside: imgW > 0 && imgH > 0 && x >= 0 && x < imgW && y >= 0 && y < imgH };
}

export function zoomSubViewAroundPoint(
  transform: SubViewTransform,
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
  cursorX: number,
  cursorY: number,
  nextZoom: number,
  padding = 12,
): SubViewTransform {
  const next = { ...transform, zoom: clampSubViewZoom(nextZoom) };
  if (next.zoom === clampSubViewZoom(transform.zoom)) return next;

  const anchor = subViewScreenToImage(cursorX, cursorY, viewW, viewH, imgW, imgH, transform, padding);
  const projected = subViewImageToScreen(anchor.x, anchor.y, viewW, viewH, imgW, imgH, next, padding);
  next.panX += cursorX - projected.x;
  next.panY += cursorY - projected.y;
  return next;
}

export interface SubViewSampledColor {
  hex: string;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Fully transparent pixels retain their stored RGB channels and return an alpha of 0. */
export function sampleSubViewPixel(
  rgba: Uint8ClampedArray | Uint8Array,
  imgW: number,
  imgH: number,
  imgX: number,
  imgY: number,
): SubViewSampledColor | null {
  if (!Number.isSafeInteger(imgW) || !Number.isSafeInteger(imgH) || imgW <= 0 || imgH <= 0) return null;
  if (!(imgX >= 0 && imgX < imgW && imgY >= 0 && imgY < imgH)) return null;
  if (rgba.length < imgW * imgH * 4) return null;

  const offset = (Math.floor(imgY) * imgW + Math.floor(imgX)) * 4;
  const r = rgba[offset];
  const g = rgba[offset + 1];
  const b = rgba[offset + 2];
  const a = rgba[offset + 3];
  const hex = `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return { hex, r, g, b, a };
}
