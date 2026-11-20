/**
 * Aligning one layer to the canvas or to the selection's frame (對齊 L1): the pure parts — which
 * frame applies, the whole-pixel move, what falls off the canvas, and why a layer cannot move.
 * The layer is never resampled: its pixels are copied dx / dy pixels away.
 */

export type AlignBasisChoice = 'auto' | 'canvas' | 'selection';
export type AlignBasis = 'canvas' | 'selection';
export type AlignX = 'left' | 'center' | 'right';
export type AlignY = 'top' | 'center' | 'bottom';

/** x / y = top-left pixel, w / h = size in pixels */
export interface AlignRect { x: number; y: number; w: number; h: number }

export const ALIGN_BASIS_CHOICES: readonly AlignBasisChoice[] = ['auto', 'canvas', 'selection'];

/** Why the active layer cannot be aligned now (a key of t.align.blocked) */
export type AlignBlocker = 'noLayer' | 'busy' | 'group' | 'mask' | 'notEditable' | 'hasMask' | 'keyframes';

/**
 * The frame the layer is aligned to. Auto: the selection when there is one, else the canvas
 * (guides come in later). null: the selection was chosen but there is none.
 */
export function resolveAlignBasis(choice: AlignBasisChoice, hasSelection: boolean): AlignBasis | null {
  if (choice === 'canvas') return 'canvas';
  if (choice === 'selection') return hasSelection ? 'selection' : null;
  return hasSelection ? 'selection' : 'canvas';
}

/** Inclusive selection bounds as a frame (a lasso's bounds may be fractional: the pixels they touch) */
export function selectionFrame(b: { minX: number; minY: number; maxX: number; maxY: number }): AlignRect {
  const x = Math.floor(b.minX);
  const y = Math.floor(b.minY);
  return { x, y, w: Math.max(1, Math.ceil(b.maxX) - x + 1), h: Math.max(1, Math.ceil(b.maxY) - y + 1) };
}

const along = (pos: number, size: number, framePos: number, frameSize: number, where: 'start' | 'center' | 'end') => {
  if (where === 'start') return framePos - pos;
  if (where === 'end') return framePos + frameSize - (pos + size);
  // Whole pixels: when the leftover is odd, the extra pixel goes to the right / bottom
  return framePos + Math.floor((frameSize - size) / 2) - pos;
};

/** The whole-pixel move that puts `content` at the chosen edge or centre of `frame` (null = that axis stays) */
export function alignOffset(content: AlignRect, frame: AlignRect, x: AlignX | null, y: AlignY | null): { dx: number; dy: number } {
  const dx = x === null ? 0 : along(content.x, content.w, frame.x, frame.w, x === 'left' ? 'start' : x === 'right' ? 'end' : 'center');
  const dy = y === null ? 0 : along(content.y, content.h, frame.y, frame.h, y === 'top' ? 'start' : y === 'bottom' ? 'end' : 'center');
  return { dx, dy };
}

/** True when some of the content would end up off the canvas (and be cut off) */
export function alignCrops(content: AlignRect, dx: number, dy: number, canvasW: number, canvasH: number): boolean {
  return content.x + dx < 0 || content.y + dy < 0 || content.x + dx + content.w > canvasW || content.y + dy + content.h > canvasH;
}

/**
 * Where the moved content lands, clipped to the canvas: the canvas rect it covers and the matching
 * top-left inside the content (sx, sy). null when none of it stays on the canvas.
 */
export function alignDestination(content: AlignRect, dx: number, dy: number, canvasW: number, canvasH: number): (AlignRect & { sx: number; sy: number }) | null {
  const nx = content.x + dx;
  const ny = content.y + dy;
  const x0 = Math.max(0, nx);
  const y0 = Math.max(0, ny);
  const x1 = Math.min(canvasW, nx + content.w);
  const y1 = Math.min(canvasH, ny + content.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, sx: x0 - nx, sy: y0 - ny };
}

/**
 * The parts of `a` that `b` does not cover (up to four strips). Only these are cleared before the
 * moved pixels are written, so a big layer moved a little never needs a canvas-sized empty buffer.
 */
export function rectMinus(a: AlignRect, b: AlignRect | null): AlignRect[] {
  const x0 = b ? Math.max(a.x, b.x) : 0;
  const y0 = b ? Math.max(a.y, b.y) : 0;
  const x1 = b ? Math.min(a.x + a.w, b.x + b.w) : 0;
  const y1 = b ? Math.min(a.y + a.h, b.y + b.h) : 0;
  if (!b || x1 <= x0 || y1 <= y0) return [{ ...a }];
  const out: AlignRect[] = [];
  if (y0 > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: y0 - a.y });
  if (y1 < a.y + a.h) out.push({ x: a.x, y: y1, w: a.w, h: a.y + a.h - y1 });
  if (x0 > a.x) out.push({ x: a.x, y: y0, w: x0 - a.x, h: y1 - y0 });
  if (x1 < a.x + a.w) out.push({ x: x1, y: y0, w: a.x + a.w - x1, h: y1 - y0 });
  return out;
}

/** Copies a rect out of an RGBA buffer `srcW` pixels wide (rect in that buffer's own coordinates) */
export function copyRgbaRect(src: Uint8Array, srcW: number, rect: AlignRect): Uint8Array {
  const out = new Uint8Array(rect.w * rect.h * 4);
  for (let row = 0; row < rect.h; row++) {
    const from = ((rect.y + row) * srcW + rect.x) * 4;
    out.set(src.subarray(from, from + rect.w * 4), row * rect.w * 4);
  }
  return out;
}

/**
 * Why a layer cannot be aligned (null = it can). Groups and two-layer moves (a layer with its
 * mask) wait for multi-layer alignment; a layer moved by keyframes is shown somewhere else than
 * its pixels are, so aligning those pixels would not line up what is on screen.
 */
export function alignBlocker(
  layer: { id: string; layerType: string } | null,
  opts: { canEdit: boolean; busy: boolean; hasMask: boolean; movedByKeyframes: boolean },
): AlignBlocker | null {
  if (!layer) return 'noLayer';
  if (opts.busy) return 'busy';
  if (layer.layerType === 'group' || layer.layerType === 'folder') return 'group';
  if (layer.layerType === 'mask') return 'mask';
  if (!opts.canEdit) return 'notEditable';
  if (opts.hasMask) return 'hasMask';
  if (opts.movedByKeyframes) return 'keyframes';
  return null;
}
