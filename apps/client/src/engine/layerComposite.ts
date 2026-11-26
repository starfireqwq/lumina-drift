import {
  IDENTITY_AFFINE,
  multiplyAffine,
  transformToAffineMatrix,
  evaluateTransformKeyframes,
  applyAdjustmentStep,
  compileAdjustment,
  normalizeAdjustment,
  resolveAdjustmentScope,
  type Affine2D,
  type BlendMode,
  type LayerModel,
  type VectorStroke,
} from '@atelier/shared';

/**
 * Layer pictures on 2D canvases, merged the way LayerManager draws them (groups, layer and group
 * masks, inverted masks, clipping, blend modes). Kept free of heavy imports: export, time-lapse
 * and the time capsule all use it.
 */
export interface LayerCanvasItem {
  layer: LayerModel;
  /** Groups carry an empty canvas: they only hold children */
  canvas: HTMLCanvasElement;
  vectorStrokes?: VectorStroke[];
  /** The layer's (or group's) mask (straight RGBA; coverage = red × alpha), whether it is on, and inverted (white hides) */
  mask?: { id?: string; canvas: HTMLCanvasElement; enabled: boolean; inverted?: boolean };
}

type MaskSource = { canvas: HTMLCanvasElement; inverted?: boolean };

/** Mask coverage (0–255) per pixel: white shows, black or empty hides (the other way round when inverted) */
export function maskCoverage(mask: HTMLCanvasElement, inverted = false): Uint8ClampedArray {
  const d = mask.getContext('2d')!.getImageData(0, 0, mask.width, mask.height).data;
  const out = new Uint8ClampedArray(mask.width * mask.height);
  for (let i = 0; i < out.length; i++) {
    const v = (d[i * 4] * d[i * 4 + 3]) / 255;
    out[i] = inverted ? 255 - v : v;
  }
  return out;
}

/** Adjustment layers own no pixels: they recolour what is below them (see compositeLayers) */
export const isAdjustmentItem = (item: LayerCanvasItem) => item.layer.layerType === 'adjustment';

/** Per-pixel product of several 0–255 coverages (null when there are none) */
export function combineMaskCoverages(coverages: readonly Uint8ClampedArray[], pixelCount: number): Uint8ClampedArray | null {
  if (coverages.length === 0) return null;
  const out = new Uint8ClampedArray(pixelCount).fill(255);
  for (const cov of coverages) {
    for (let i = 0; i < pixelCount; i++) out[i] = (out[i] * (cov[i] ?? 0)) / 255;
  }
  return out;
}

/** A mask drawn onto a width × height canvas first when its own canvas has another size */
function maskCoverageSized(mask: MaskSource, width: number, height: number): Uint8ClampedArray {
  if (mask.canvas.width === width && mask.canvas.height === height) return maskCoverage(mask.canvas, mask.inverted);
  const sized = document.createElement('canvas');
  sized.width = width;
  sized.height = height;
  sized.getContext('2d')!.drawImage(mask.canvas, 0, 0);
  const cov = maskCoverage(sized, mask.inverted);
  sized.width = 0;
  sized.height = 0;
  return cov;
}

/** An adjustment layer as a clip base: opaque white where its own mask shows (everywhere without one) */
function adjustmentBaseCanvas(item: LayerCanvasItem, width: number, height: number): HTMLCanvasElement {
  const white = document.createElement('canvas');
  white.width = width;
  white.height = height;
  const ctx = white.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  if (!item.mask?.enabled) return white;
  const img = ctx.getImageData(0, 0, width, height);
  const cov = maskCoverageSized(item.mask, width, height);
  for (let i = 0; i < cov.length; i++) img.data[i * 4 + 3] = cov[i];
  ctx.putImageData(img, 0, 0);
  return white;
}

/** The layer as it looks with its own mask and any extra (group) masks applied */
export function maskedLayerCanvas(item: LayerCanvasItem, extra: MaskSource[] = []): HTMLCanvasElement {
  const masks: MaskSource[] = [...(item.mask?.enabled ? [item.mask] : []), ...extra];
  if (masks.length === 0) return item.canvas;
  const { width, height } = item.canvas;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(item.canvas, 0, 0);
  const img = ctx.getImageData(0, 0, width, height);
  for (const m of masks) {
    const cov = maskCoverage(m.canvas, m.inverted);
    for (let i = 0; i < cov.length; i++) img.data[i * 4 + 3] = (img.data[i * 4 + 3] * cov[i]) / 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** The layer tree as the editor shows it */
export class LayerTree {
  readonly byId: Map<string, LayerCanvasItem>;
  constructor(readonly items: LayerCanvasItem[]) {
    this.byId = new Map(items.map((i) => [i.layer.id, i]));
  }
  isGroup = (i: LayerCanvasItem) => i.layer.layerType === 'group';
  /** Children bottom first; the roots when parentId is null */
  childrenOf(parentId: string | null): LayerCanvasItem[] {
    return this.items
      .filter((i) => (i.layer.parentId && this.byId.has(i.layer.parentId) ? i.layer.parentId : null) === parentId)
      .sort((a, b) => a.layer.sortOrder - b.layer.sortOrder);
  }
  private ancestors(i: LayerCanvasItem): LayerCanvasItem[] {
    const out: LayerCanvasItem[] = [];
    let p = i.layer.parentId ? this.byId.get(i.layer.parentId) : undefined;
    for (let depth = 0; p && depth < 16; depth++) {
      out.push(p);
      p = p.layer.parentId ? this.byId.get(p.layer.parentId) : undefined;
    }
    return out;
  }
  visible = (i: LayerCanvasItem) => i.layer.isVisible && this.ancestors(i).every((a) => a.layer.isVisible);
  opacity = (i: LayerCanvasItem, frame = 0) => {
    const chain = [...this.ancestors(i), i];
    let acc = 1;
    for (const node of chain) {
      acc *= node.layer.opacity;
      const applied = (node.layer as LayerModel & { renderOpacityApplied?: boolean }).renderOpacityApplied;
      if (!applied && node.layer.meta?.keyframes?.length) {
        acc *= evaluateTransformKeyframes(node.layer.meta.keyframes, frame).opacity;
      }
    }
    return Math.max(0, Math.min(1, acc));
  };
  transformMatrix = (i: LayerCanvasItem, width: number, height: number, frame = 0): Affine2D => {
    const chain = [...this.ancestors(i).reverse(), i];
    let acc = IDENTITY_AFFINE;
    for (const node of chain) {
      const pre = (node.layer as LayerModel & { renderTransform?: Affine2D }).renderTransform;
      if (pre) {
        acc = multiplyAffine(acc, pre);
      } else if (node.layer.meta?.keyframes?.length) {
        const ev = evaluateTransformKeyframes(node.layer.meta.keyframes, frame, width / 2, height / 2);
        acc = multiplyAffine(acc, transformToAffineMatrix(ev));
      }
    }
    return acc;
  };
  groupMasks = (i: LayerCanvasItem): MaskSource[] => this.ancestors(i).flatMap((a) => (a.mask?.enabled ? [a.mask] : []));
  /** Where an adjustment layer acts (0–255): its own mask × every enclosing group mask; null = everywhere */
  adjustmentCoverage(item: LayerCanvasItem, width: number, height: number): Uint8ClampedArray | null {
    const masks: MaskSource[] = [...(item.mask?.enabled ? [item.mask] : []), ...this.groupMasks(item)];
    return combineMaskCoverages(masks.map((m) => maskCoverageSized(m, width, height)), width * height);
  }
  /** Drawable layers bottom to top, each with the base it clips to (if any) */
  drawables(): Array<{ item: LayerCanvasItem; clipBase: LayerCanvasItem | null }> {
    const flat = this.items.filter((i) => !this.isGroup(i)).sort((a, b) => a.layer.sortOrder - b.layer.sortOrder);
    let base: LayerCanvasItem | null = null;
    return flat.map((item) => {
      if (!item.layer.clipToBelow) base = item;
      return { item, clipBase: item.layer.clipToBelow ? base : null };
    });
  }
  /** Final pixels of one layer: own and group masks, then clipping (for formats without masks / clipping) */
  flattened(item: LayerCanvasItem, clipBase: LayerCanvasItem | null): HTMLCanvasElement {
    if (isAdjustmentItem(item)) {
      // No pixels of its own (its effect is in the merged picture)
      const empty = document.createElement('canvas');
      empty.width = item.canvas.width;
      empty.height = item.canvas.height;
      return empty;
    }
    const src = maskedLayerCanvas(item, this.groupMasks(item));
    if (!clipBase || clipBase === item) return src;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(isAdjustmentItem(clipBase) ? adjustmentBaseCanvas(clipBase, src.width, src.height) : maskedLayerCanvas(clipBase), 0, 0);
    if (!this.visible(clipBase)) ctx.clearRect(0, 0, out.width, out.height);
    return out;
  }
}

export function canvasCompositeOp(mode: BlendMode): GlobalCompositeOperation {
  switch (mode) {
    case 'multiply':
    case 'linear_burn':
    case 'darker_color':
      return 'multiply';
    case 'screen':
    case 'divide':
      return 'screen';
    case 'overlay':
    case 'hard_mix':
      return 'overlay';
    case 'darken':
      return 'darken';
    case 'lighten':
    case 'lighter_color':
      return 'lighten';
    case 'color_dodge':
      return 'color-dodge';
    case 'color_burn':
      return 'color-burn';
    case 'hard_light':
    case 'vivid_light':
    case 'linear_light':
      return 'hard-light';
    case 'soft_light':
    case 'pin_light':
      return 'soft-light';
    case 'difference':
    case 'subtract':
      return 'difference';
    case 'exclusion':
      return 'exclusion';
    case 'add':
    case 'glow':
      return 'lighter';
    case 'hue':
      return 'hue';
    case 'saturation':
      return 'saturation';
    case 'color':
      return 'color';
    case 'luminosity':
      return 'luminosity';
    default:
      return 'source-over';
  }
}

/**
 * Merges the layers into one picture (screentone is a display filter: bake it to keep it).
 * Draws onto `target` when given (it is resized to fit), else onto a new canvas.
 */
export function compositeLayers(
  layerItems: LayerCanvasItem[],
  width: number,
  height: number,
  bgColor: string | null = '#FFFFFF',
  target?: HTMLCanvasElement
): HTMLCanvasElement {
  const merged = target ?? document.createElement('canvas');
  if (merged.width !== width) merged.width = width;
  if (merged.height !== height) merged.height = height;
  const ctx = merged.getContext('2d');
  if (!ctx) throw new Error('Failed to create composite 2D context');
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }
  const tree = new LayerTree(layerItems);
  const drawables = tree.drawables();
  drawLayerList(ctx, tree, drawables, drawables, width, height);
  ctx.restore();
  return merged;
}

type DrawableEntry = { item: LayerCanvasItem; clipBase: LayerCanvasItem | null };

/** Draws `list` (bottom to top) onto ctx; `all` is the whole stack, which adjustment scopes resolve against */
function drawLayerList(
  ctx: CanvasRenderingContext2D,
  tree: LayerTree,
  list: readonly DrawableEntry[],
  all: readonly DrawableEntry[],
  width: number,
  height: number
) {
  for (const { item, clipBase } of list) {
    if (!tree.visible(item)) continue;
    if (isAdjustmentItem(item)) {
      applyAdjustmentItem(ctx, tree, item, all, width, height);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, tree.opacity(item)));
    ctx.globalCompositeOperation = canvasCompositeOp(item.layer.blendMode);
    const m = tree.transformMatrix(item, width, height);
    if (!m.isIdentity) ctx.transform(m.a, m.b, m.c, m.d, m.tx, m.ty);
    ctx.drawImage(tree.flattened(item, clipBase), 0, 0);
    ctx.restore();
  }
}

/**
 * An adjustment layer recolours what is already drawn: everything below it (root), only its
 * clip stack (clip to below) or only its group's layers below it (group) — those scopes are
 * composited alone first, and their change is added to the picture (shared applyAdjustmentStep).
 */
function applyAdjustmentItem(
  ctx: CanvasRenderingContext2D,
  tree: LayerTree,
  item: LayerCanvasItem,
  all: readonly DrawableEntry[],
  width: number,
  height: number
) {
  const adjustment = normalizeAdjustment(item.layer.meta?.adjustment);
  if (!adjustment) return;
  const compiled = compileAdjustment(adjustment);
  const opacity = tree.opacity(item);
  if (compiled.identity || !(opacity > 0) || width <= 0 || height <= 0) return;
  // Groups are needed too: they decide the group scope
  const scope = resolveAdjustmentScope(tree.items.map((i) => i.layer), item.layer.id);
  if (scope.kind === 'none') return;

  let scopePixels: Uint8ClampedArray | null = null;
  if (scope.kind !== 'root') {
    const members = new Set(scope.memberIds);
    const subset = all.filter((entry) => members.has(entry.item.layer.id));
    if (subset.length === 0) return;
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const sctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!sctx) return;
    drawLayerList(sctx, tree, subset, all, width, height);
    scopePixels = sctx.getImageData(0, 0, width, height).data;
    scratch.width = 0;
    scratch.height = 0;
  }

  const image = ctx.getImageData(0, 0, width, height);
  applyAdjustmentStep({
    width,
    height,
    target: image.data,
    scope: scopePixels,
    coverage: tree.adjustmentCoverage(item, width, height),
    opacity,
    compiled,
    blendMode: item.layer.blendMode,
  });
  ctx.putImageData(image, 0, 0);
}
