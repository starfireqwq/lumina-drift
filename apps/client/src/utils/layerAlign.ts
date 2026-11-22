/**
 * Aligning and distributing layers/groups (with their masks) to objects, the canvas, or the
 * selection's frame: the pure parts — target grouping, frame selection, whole-pixel moves,
 * distribution math, off-canvas checks, and batch blockers. Layers are never resampled: pixels
 * are copied dx / dy pixels away.
 */

import { sampleBezierSegment, type CanvasGuide, type VectorStroke } from '@atelier/shared';

export type AlignBasisChoice = 'auto' | 'objects' | 'guide' | 'canvas' | 'selection';
export type AlignBasis = 'objects' | 'guide' | 'canvas' | 'selection';
export type AlignX = 'left' | 'center' | 'right';
export type AlignY = 'top' | 'center' | 'bottom';
export type DistributeMode = 'left' | 'hcenter' | 'right' | 'hgap' | 'top' | 'vcenter' | 'bottom' | 'vgap';
export type AlignOutcome =
  | 'moved'
  | 'aligned'
  | 'empty'
  | 'confirm'
  | 'noSelection'
  | 'noGuides'
  | 'needGuides'
  | 'needMulti'
  | 'failed';

export type GuideAlignMode = 'range' | 'nearest';
export type VectorAlignScope = 'layer' | 'selected' | 'all';
export type VectorBoundsMode = 'stroke' | 'path';
export type TextBoundsMode = 'glyph' | 'box';

export interface AlignGuideSummary {
  /** Sorted unique vertical guide X coordinates (used for horizontal alignment/distribution) */
  xs: number[];
  /** Sorted unique horizontal guide Y coordinates (used for vertical alignment/distribution) */
  ys: number[];
  /** True when only an explicitly selected subset of guides is active */
  usingSelection: boolean;
  /** Total visible guide count on the canvas */
  totalCount: number;
}

export interface GuideAxisAvailability {
  canAlignX: boolean;
  canAlignY: boolean;
  canDistributeX: boolean;
  canDistributeY: boolean;
}

/** x / y = top-left pixel, w / h = size in pixels */
export interface AlignRect { x: number; y: number; w: number; h: number }

export const ALIGN_BASIS_CHOICES: readonly AlignBasisChoice[] = ['auto', 'objects', 'guide', 'canvas', 'selection'];

/** Why the selected targets cannot be aligned/distributed now (a key of t.align.blocked) */
export type AlignBlocker = 'noLayer' | 'busy' | 'mask' | 'notEditable' | 'keyframes' | 'animationFolder';

export type AlignLayerLike = {
  id: string;
  name?: string;
  layerType: string;
  parentId?: string | null;
  meta?: { animation?: unknown } | null;
};

export type AlignTargetUnit<T extends AlignLayerLike = AlignLayerLike> = {
  id: string;
  root: T;
  members: T[];
  masks: T[];
  isGroup: boolean;
  hasAnimationFolder: boolean;
};

/**
 * The frame / basis targets align or distribute against.
 * Auto: selection when active, else guide when visible guides exist, else objects when >= 2 targets, else canvas.
 */
export function resolveAlignBasis(
  choice: AlignBasisChoice,
  hasSelection: boolean,
  targetCount = 1,
  hasGuides = false,
): AlignBasis | null {
  if (choice === 'canvas') return 'canvas';
  if (choice === 'selection') return hasSelection ? 'selection' : null;
  if (choice === 'guide') return hasGuides ? 'guide' : null;
  if (choice === 'objects') return targetCount >= 2 ? 'objects' : null;
  return hasSelection ? 'selection' : hasGuides ? 'guide' : targetCount >= 2 ? 'objects' : 'canvas';
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

const isFolderLayer = (layer: AlignLayerLike) =>
  layer.layerType === 'group' || layer.layerType === 'folder';

/**
 * Resolves the active or multi-selected layers into independent alignment units.
 * Any selected descendant whose ancestor is also selected is collapsed into the ancestor unit;
 * groups collect all nested content descendants and masks recursively.
 */
export function resolveAlignTargets<T extends AlignLayerLike>(
  layers: T[],
  activeLayerId: string | null,
  selectedLayerIds?: ReadonlySet<string>,
): AlignTargetUnit<T>[] {
  const byId = new Map<string, T>();
  const childrenByParent = new Map<string, T[]>();
  for (const layer of layers) {
    byId.set(layer.id, layer);
    if (layer.parentId) {
      let children = childrenByParent.get(layer.parentId);
      if (!children) {
        children = [];
        childrenByParent.set(layer.parentId, children);
      }
      children.push(layer);
    }
  }

  let candidates: T[] = [];
  if (selectedLayerIds && selectedLayerIds.size > 0) {
    candidates = layers.filter((l) => selectedLayerIds.has(l.id));
  }
  if (candidates.length === 0 && activeLayerId) {
    const active = byId.get(activeLayerId);
    if (active) candidates = [active];
  }
  if (candidates.length === 0) return [];

  const candidateIds = new Set(candidates.map((l) => l.id));
  const hasSelectedAncestor = (layer: T): boolean => {
    const visited = new Set<string>([layer.id]);
    let pid = layer.parentId ?? null;
    while (pid) {
      if (candidateIds.has(pid)) return true;
      if (visited.has(pid)) break;
      visited.add(pid);
      pid = byId.get(pid)?.parentId ?? null;
    }
    return false;
  };

  const roots = candidates.length > 1
    ? candidates.filter((l) => !hasSelectedAncestor(l))
    : candidates;

  return roots.map((root): AlignTargetUnit<T> => {
    if (root.layerType === 'mask') {
      return { id: root.id, root, members: [root], masks: [], isGroup: false, hasAnimationFolder: false };
    }
    if (isFolderLayer(root)) {
      const members: T[] = [];
      const masks: T[] = [];
      let hasAnimationFolder = Boolean(root.meta?.animation);
      const visited = new Set<string>([root.id]);
      const visit = (parentId: string) => {
        for (const child of childrenByParent.get(parentId) ?? []) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          if (child.layerType === 'mask') {
            masks.push(child);
          } else if (isFolderLayer(child)) {
            if (child.meta?.animation) hasAnimationFolder = true;
          } else {
            members.push(child);
          }
          visit(child.id);
        }
      };
      visit(root.id);
      return { id: root.id, root, members, masks, isGroup: true, hasAnimationFolder };
    }
    const masks = (childrenByParent.get(root.id) ?? []).filter((l) => l.layerType === 'mask');
    return { id: root.id, root, members: [root], masks, isGroup: false, hasAnimationFolder: false };
  });
}

/**
 * Why the target batch cannot be aligned or distributed now (null = all targets may move).
 * Checks whole-batch blockers in priority order without calling `canEdit` on group roots.
 */
export function alignTargetsBlocker<T extends AlignLayerLike>(
  targets: AlignTargetUnit<T>[],
  opts: {
    busy: boolean;
    canEdit: (layer: T) => boolean;
    movedByKeyframes: (layerId: string) => boolean;
  },
): AlignBlocker | null {
  if (targets.length === 0) return 'noLayer';
  if (opts.busy) return 'busy';
  if (targets.some((t) => t.root.layerType === 'mask')) return 'mask';
  if (targets.some((t) => t.hasAnimationFolder)) return 'animationFolder';
  for (const t of targets) {
    for (const m of t.members) {
      if (!opts.canEdit(m)) return 'notEditable';
    }
    for (const mk of t.masks) {
      if (!opts.canEdit(mk)) return 'notEditable';
    }
  }
  for (const t of targets) {
    if (opts.movedByKeyframes(t.root.id)) return 'keyframes';
    if (t.members.some((m) => opts.movedByKeyframes(m.id))) return 'keyframes';
    if (t.masks.some((mk) => opts.movedByKeyframes(mk.id))) return 'keyframes';
  }
  return null;
}

/** Bounding rectangle enclosing all `rects`, or `null` when empty */
export function unionRect(rects: AlignRect[]): AlignRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Whole-pixel move for each rect in `rects` to align with `frame` on the chosen axes */
export function alignManyOffsets(
  rects: AlignRect[],
  frame: AlignRect,
  x: AlignX | null,
  y: AlignY | null,
): Array<{ dx: number; dy: number }> {
  return rects.map((r) => alignOffset(r, frame, x, y));
}

type DistributeKind = 'start' | 'center' | 'end' | 'gap';

const DISTRIBUTE_AXIS: Record<DistributeMode, { horizontal: boolean; kind: DistributeKind }> = {
  left: { horizontal: true, kind: 'start' },
  hcenter: { horizontal: true, kind: 'center' },
  right: { horizontal: true, kind: 'end' },
  hgap: { horizontal: true, kind: 'gap' },
  top: { horizontal: false, kind: 'start' },
  vcenter: { horizontal: false, kind: 'center' },
  bottom: { horizontal: false, kind: 'end' },
  vgap: { horizontal: false, kind: 'gap' },
};

const anchorOf = (pos: number, size: number, kind: DistributeKind): number => {
  if (kind === 'center') return pos + size / 2;
  if (kind === 'end') return pos + size;
  return pos;
};

const posFromAnchor = (anchor: number, size: number, kind: DistributeKind): number => {
  if (kind === 'center') return Math.round(anchor - size / 2);
  if (kind === 'end') return Math.round(anchor - size);
  return Math.round(anchor);
};

/**
 * Whole-pixel offsets for distributing `rects` along one axis.
 * - `objects` keeps the outermost two items fixed (requires >= 3 rects).
 * - `canvas` / `selection` snaps the outermost items to `frame` edges (requires >= 2 rects).
 */
export function distributeOffsets(
  rects: AlignRect[],
  mode: DistributeMode,
  basis: AlignBasis,
  frame: AlignRect,
): Array<{ dx: number; dy: number }> {
  const n = rects.length;
  const out = rects.map(() => ({ dx: 0, dy: 0 }));
  const minCount = basis === 'objects' ? 3 : 2;
  if (n < minCount) return out;

  const { horizontal, kind } = DISTRIBUTE_AXIS[mode];
  const framePos = horizontal ? frame.x : frame.y;
  const frameSize = horizontal ? frame.w : frame.h;

  const sorted = rects
    .map((r, index) => {
      const pos = horizontal ? r.x : r.y;
      const size = horizontal ? r.w : r.h;
      return { index, pos, size, anchor: anchorOf(pos, size, kind) };
    })
    .sort((a, b) => (a.anchor - b.anchor) || (a.pos - b.pos) || (a.index - b.index));

  const first = sorted[0];
  const last = sorted[n - 1];
  const firstTargetPos = basis === 'objects' ? first.pos : framePos;
  const lastTargetPos = basis === 'objects' ? last.pos : framePos + frameSize - last.size;

  const setShift = (itemIndex: number, delta: number) => {
    const clean = delta || 0;
    if (horizontal) out[itemIndex].dx = clean;
    else out[itemIndex].dy = clean;
  };

  setShift(first.index, firstTargetPos - first.pos);
  setShift(last.index, lastTargetPos - last.pos);

  if (n <= 2) return out;

  if (kind === 'gap') {
    const firstEnd = firstTargetPos + first.size;
    let sumMiddleSizes = 0;
    for (let k = 1; k < n - 1; k++) sumMiddleSizes += sorted[k].size;
    const gap = ((lastTargetPos - firstEnd) - sumMiddleSizes) / (n - 1);
    let cursor = firstEnd;
    for (let k = 1; k < n - 1; k++) {
      const item = sorted[k];
      cursor += gap;
      const targetPos = Math.round(cursor);
      setShift(item.index, targetPos - item.pos);
      cursor += item.size;
    }
  } else {
    const firstAnchor = anchorOf(firstTargetPos, first.size, kind);
    const lastAnchor = anchorOf(lastTargetPos, last.size, kind);
    for (let k = 1; k < n - 1; k++) {
      const item = sorted[k];
      const targetAnchor = firstAnchor + ((lastAnchor - firstAnchor) * k) / (n - 1);
      const targetPos = posFromAnchor(targetAnchor, item.size, kind);
      setShift(item.index, targetPos - item.pos);
    }
  }

  return out;
}

const uniqueSortedCoords = (coords: number[]): number[] => {
  const uniq = new Set<number>();
  for (const v of coords) {
    if (Number.isFinite(v)) uniq.add(Math.round(v));
  }
  return [...uniq].sort((a, b) => a - b);
};

/** Summarises visible guides (or only explicitly selected guides when any selected ID is active). */
export function summarizeGuides(
  guides: readonly CanvasGuide[],
  selectedIds: readonly string[] = [],
): AlignGuideSummary {
  if (guides.length === 0) {
    return { xs: [], ys: [], usingSelection: false, totalCount: 0 };
  }
  const selectedSet = selectedIds.length > 0 ? new Set(selectedIds) : null;
  const picked = selectedSet ? guides.filter((g) => selectedSet.has(g.id)) : [];
  const active = picked.length > 0 ? picked : guides;
  const xs = uniqueSortedCoords(active.filter((g) => g.axis === 'x').map((g) => g.position));
  const ys = uniqueSortedCoords(active.filter((g) => g.axis === 'y').map((g) => g.position));
  return {
    xs,
    ys,
    usingSelection: picked.length > 0,
    totalCount: guides.length,
  };
}

/** Which axes can align or distribute when using guides as the basis. */
export function guideAxisAvailability(summary: AlignGuideSummary): GuideAxisAvailability {
  const canAlignX = summary.xs.length > 0;
  const canAlignY = summary.ys.length > 0;
  const canDistributeX = summary.xs.length >= 2 && summary.xs[summary.xs.length - 1] > summary.xs[0];
  const canDistributeY = summary.ys.length >= 2 && summary.ys[summary.ys.length - 1] > summary.ys[0];
  return { canAlignX, canAlignY, canDistributeX, canDistributeY };
}

const pickNearestCoord = (coords: readonly number[], refValue: number): number => {
  let best = coords[0];
  let bestDist = Math.abs(coords[0] - refValue);
  for (let i = 1; i < coords.length; i++) {
    const d = Math.abs(coords[i] - refValue);
    if (d < bestDist) {
      bestDist = d;
      best = coords[i];
    }
  }
  return best;
};

/**
 * Whole-pixel move aligning `content` against vertical/horizontal guides.
 * - `range`: 1 guide aligns to that line; 2+ guides form a span `[min, max]`.
 * - `nearest`: picks the guide closest to the aligned edge/centre of `content`.
 * Axes without guides stay untouched (dx = 0 or dy = 0).
 */
export function guideAlignOffset(
  content: AlignRect,
  summary: AlignGuideSummary,
  x: AlignX | null,
  y: AlignY | null,
  mode: GuideAlignMode = 'range',
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;

  if (x !== null && summary.xs.length > 0) {
    const where = x === 'left' ? 'start' : x === 'right' ? 'end' : 'center';
    if (mode === 'nearest' && summary.xs.length > 1) {
      const refX = where === 'start' ? content.x : where === 'end' ? content.x + content.w : content.x + content.w / 2;
      const gx = pickNearestCoord(summary.xs, refX);
      dx = along(content.x, content.w, gx, 0, where);
    } else {
      const minX = summary.xs[0];
      const maxX = summary.xs[summary.xs.length - 1];
      dx = along(content.x, content.w, minX, maxX - minX, where);
    }
  }

  if (y !== null && summary.ys.length > 0) {
    const where = y === 'top' ? 'start' : y === 'bottom' ? 'end' : 'center';
    if (mode === 'nearest' && summary.ys.length > 1) {
      const refY = where === 'start' ? content.y : where === 'end' ? content.y + content.h : content.y + content.h / 2;
      const gy = pickNearestCoord(summary.ys, refY);
      dy = along(content.y, content.h, gy, 0, where);
    } else {
      const minY = summary.ys[0];
      const maxY = summary.ys[summary.ys.length - 1];
      dy = along(content.y, content.h, minY, maxY - minY, where);
    }
  }

  return { dx: dx || 0, dy: dy || 0 };
}

export function guideAlignManyOffsets(
  rects: AlignRect[],
  summary: AlignGuideSummary,
  x: AlignX | null,
  y: AlignY | null,
  mode: GuideAlignMode = 'range',
): Array<{ dx: number; dy: number }> {
  return rects.map((r) => guideAlignOffset(r, summary, x, y, mode));
}

/**
 * Distribution frame derived from guides for the given distribution mode.
 * Returns null if the axis lacks at least 2 distinct guide coordinates.
 */
export function guideDistributeFrame(
  summary: AlignGuideSummary,
  mode: DistributeMode,
): AlignRect | null {
  const { horizontal } = DISTRIBUTE_AXIS[mode];
  if (horizontal) {
    if (summary.xs.length < 2) return null;
    const x0 = summary.xs[0];
    const x1 = summary.xs[summary.xs.length - 1];
    if (x1 <= x0) return null;
    return { x: x0, y: 0, w: x1 - x0, h: 1 };
  }
  if (summary.ys.length < 2) return null;
  const y0 = summary.ys[0];
  const y1 = summary.ys[summary.ys.length - 1];
  if (y1 <= y0) return null;
  return { x: 0, y: y0, w: 1, h: y1 - y0 };
}

export function isHorizontalDistribute(mode: DistributeMode): boolean {
  return DISTRIBUTE_AXIS[mode].horizontal;
}

/**
 * Computes the whole-pixel alignment bounding box of a vector stroke:
 * - `'path'`: centerline Bézier path bounds (excludes stroke thickness).
 * - `'stroke'`: outer ink bounds including interpolated anchor stroke width along each segment.
 */
export function computeVectorStrokeAlignRect(
  stroke: VectorStroke,
  mode: VectorBoundsMode = 'stroke',
  stepsPerSegment = 16,
): AlignRect | null {
  const { anchors } = stroke;
  if (!anchors || anchors.length === 0) return null;

  const fallbackW = Math.max(1, stroke.baseWidth || 1);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (px: number, py: number, halfWidth: number) => {
    const r = mode === 'stroke' ? halfWidth : 0;
    if (px - r < minX) minX = px - r;
    if (py - r < minY) minY = py - r;
    if (px + r > maxX) maxX = px + r;
    if (py + r > maxY) maxY = py + r;
  };

  if (anchors.length === 1) {
    const a = anchors[0];
    const hw = Math.max(0.5, (a.width || fallbackW) / 2);
    include(a.x, a.y, hw);
  } else {
    const segCount = stroke.closed && anchors.length >= 3 ? anchors.length : anchors.length - 1;
    for (let i = 0; i < segCount; i++) {
      const a0 = anchors[i];
      const a1 = anchors[(i + 1) % anchors.length];
      const p0 = { x: a0.x, y: a0.y };
      const cp1 = { x: a0.cp2x ?? a0.x, y: a0.cp2y ?? a0.y };
      const cp2 = { x: a1.cp1x ?? a1.x, y: a1.cp1y ?? a1.y };
      const p1 = { x: a1.x, y: a1.y };
      const w0 = Math.max(1, a0.width || fallbackW);
      const w1 = Math.max(1, a1.width || fallbackW);
      const pts = sampleBezierSegment(p0, cp1, cp2, p1, stepsPerSegment);
      for (let k = 0; k < pts.length; k++) {
        const t = k / stepsPerSegment;
        const hw = (w0 + (w1 - w0) * t) / 2;
        include(pts[k].x, pts[k].y, hw);
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const x = Math.floor(minX);
  const y = Math.floor(minY);
  const w = Math.max(1, Math.ceil(maxX) - x);
  const h = Math.max(1, Math.ceil(maxY) - y);
  return { x, y, w, h };
}

/** Union of alignment bounds for all strokes on a vector layer. */
export function computeVectorLayerAlignRect(
  strokes: readonly VectorStroke[],
  mode: VectorBoundsMode = 'stroke',
): AlignRect | null {
  const rects: AlignRect[] = [];
  for (const s of strokes) {
    const r = computeVectorStrokeAlignRect(s, mode);
    if (r) rects.push(r);
  }
  return unionRect(rects);
}
