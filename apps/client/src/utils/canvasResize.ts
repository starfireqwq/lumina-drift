export const RESIZE_MIN = 64;
export const RESIZE_MAX = 16384;

export type AnchorKey = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface ResizeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnchorDef {
  key: AnchorKey;
  ax: 0 | 0.5 | 1;
  ay: 0 | 0.5 | 1;
  label: string;
}

export const ANCHORS: AnchorDef[] = [
  { key: 'tl', ax: 0, ay: 0, label: '左上角' },
  { key: 't', ax: 0.5, ay: 0, label: '上方' },
  { key: 'tr', ax: 1, ay: 0, label: '右上角' },
  { key: 'l', ax: 0, ay: 0.5, label: '左邊' },
  { key: 'c', ax: 0.5, ay: 0.5, label: '中心' },
  { key: 'r', ax: 1, ay: 0.5, label: '右邊' },
  { key: 'bl', ax: 0, ay: 1, label: '左下角' },
  { key: 'b', ax: 0.5, ay: 1, label: '下方' },
  { key: 'br', ax: 1, ay: 1, label: '右下角' },
];

export const clampResizeSize = (n: number): number =>
  Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, Math.round(n)));

export function getAnchorDef(key: AnchorKey): AnchorDef {
  return ANCHORS.find((a) => a.key === key) || ANCHORS[4];
}

/**
 * Given target canvas dimensions and a 9-point anchor, returns the crop/expand box
 * in old-canvas coordinates. `offsetX = -box.x`, `offsetY = -box.y`.
 */
export function boxFromAnchor(
  targetWidth: number,
  targetHeight: number,
  oldWidth: number,
  oldHeight: number,
  anchor: AnchorKey
): ResizeBox {
  const { ax, ay } = getAnchorDef(anchor);
  const w = clampResizeSize(targetWidth);
  const h = clampResizeSize(targetHeight);
  const offsetX = Math.round((w - oldWidth) * ax);
  const offsetY = Math.round((h - oldHeight) * ay);
  return { x: -offsetX, y: -offsetY, width: w, height: h };
}

/** Converts a crop/expand box back to pixel shift `(offsetX, offsetY)` applied to existing layers. */
export function boxToOffset(box: ResizeBox): { offsetX: number; offsetY: number } {
  return {
    offsetX: Math.round(-box.x) || 0,
    offsetY: Math.round(-box.y) || 0,
  };
}

/**
 * Infers which of the 9 anchors matches `box` relative to `oldWidth x oldHeight`,
 * or returns `null` if an asymmetric custom drag moved edges independently.
 */
export function inferAnchorFromBox(
  box: ResizeBox,
  oldWidth: number,
  oldHeight: number
): AnchorKey | null {
  const ox = Math.round(-box.x);
  const oy = Math.round(-box.y);
  for (const a of ANCHORS) {
    const expectedX = Math.round((box.width - oldWidth) * a.ax);
    const expectedY = Math.round((box.height - oldHeight) * a.ay);
    if (Math.abs(ox - expectedX) <= 1 && Math.abs(oy - expectedY) <= 1) {
      return a.key;
    }
  }
  return null;
}

const clampRange = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Computes a new resize box when dragging one of the 8 canvas handles.
 * - Default: opposite edge/corner stays fixed.
 * - `lockAspect` (Shift): maintains `aspect` across corners and edges.
 * - `symmetric` (Alt): grows/shrinks symmetrically around `startBox`'s center.
 */
export function resizeBoxWithHandle(
  startBox: ResizeBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  lockAspect: boolean,
  symmetric: boolean,
  aspect?: number
): ResizeBox {
  const hSign = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const vSign = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  const mul = symmetric ? 2 : 1;

  let w = hSign !== 0 ? startBox.width + mul * hSign * dx : startBox.width;
  let h = vSign !== 0 ? startBox.height + mul * vSign * dy : startBox.height;

  w = clampRange(w, RESIZE_MIN, RESIZE_MAX);
  h = clampRange(h, RESIZE_MIN, RESIZE_MAX);

  if (lockAspect) {
    const ratio = aspect && aspect > 0 ? aspect : startBox.width / Math.max(1, startBox.height);
    const minW = Math.max(RESIZE_MIN, Math.ceil(RESIZE_MIN * ratio));
    const maxW = Math.min(RESIZE_MAX, Math.floor(RESIZE_MAX * ratio));

    if (hSign !== 0 && vSign !== 0) {
      const rw = Math.abs(w - startBox.width) / Math.max(1, startBox.width);
      const rh = Math.abs(h - startBox.height) / Math.max(1, startBox.height);
      if (rw >= rh) {
        w = clampRange(w, minW, maxW);
        h = w / ratio;
      } else {
        const hClamped = clampRange(h, minW / ratio, maxW / ratio);
        w = hClamped * ratio;
        h = hClamped;
      }
    } else if (hSign !== 0) {
      w = clampRange(w, minW, maxW);
      h = w / ratio;
    } else if (vSign !== 0) {
      const hClamped = clampRange(h, minW / ratio, maxW / ratio);
      w = hClamped * ratio;
      h = hClamped;
    }
  }

  const outW = clampResizeSize(w);
  const outH = clampResizeSize(h);

  let outX: number;
  let outY: number;

  if (symmetric) {
    const cx = startBox.x + startBox.width / 2;
    const cy = startBox.y + startBox.height / 2;
    outX = Math.round(cx - outW / 2);
    outY = Math.round(cy - outH / 2);
  } else {
    if (hSign === 1) outX = Math.round(startBox.x);
    else if (hSign === -1) outX = Math.round(startBox.x + startBox.width - outW);
    else outX = Math.round(startBox.x + (startBox.width - outW) / 2);

    if (vSign === 1) outY = Math.round(startBox.y);
    else if (vSign === -1) outY = Math.round(startBox.y + startBox.height - outH);
    else outY = Math.round(startBox.y + (startBox.height - outH) / 2);
  }

  return { x: outX, y: outY, width: outW, height: outH };
}
