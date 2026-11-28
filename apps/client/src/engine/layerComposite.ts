import {
  IDENTITY_AFFINE,
  multiplyAffine,
  transformToAffineMatrix,
  evaluateTransformKeyframes,
  applyAdjustmentStep,
  applyLayerColorToImageData,
  applyLayerEffectsToRgba,
  compileAdjustment,
  hasActiveLayerEffects,
  normalizeAdjustment,
  resolveEffectiveLayerColor,
  type Affine2D,
  type BlendMode,
  type LayerColorMeta,
  type LayerEffectsMeta,
  type LayerModel,
  type VectorStroke,
} from '@atelier/shared';
import { LayerHierarchy } from './layerHierarchy';

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

/** Applies non-destructive Layer Effects onto a canvas copy; returns the original canvas when inactive. */
export function applyLayerEffectsToCanvas(
  source: HTMLCanvasElement,
  effects: LayerEffectsMeta | null | undefined,
): HTMLCanvasElement {
  const { width, height } = source;
  if (!hasActiveLayerEffects(effects) || !effects || width <= 0 || height <= 0) return source;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) return source;
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, width, height);
  const styled = applyLayerEffectsToRgba(img.data, width, height, effects);
  img.data.set(styled);
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Applies the display colour, then the layer's own mask and any extra (group) masks */
export function maskedLayerCanvas(item: LayerCanvasItem, extra: MaskSource[] = [], color?: LayerColorMeta | null): HTMLCanvasElement {
  const masks: MaskSource[] = [...(item.mask?.enabled ? [item.mask] : []), ...extra];
  const { width, height } = item.canvas;
  if ((!color?.enabled && masks.length === 0) || width === 0 || height === 0) return item.canvas;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(item.canvas, 0, 0);
  const img = ctx.getImageData(0, 0, width, height);
  if (color?.enabled) applyLayerColorToImageData(img.data, color.mainColor, color.subColor);
  for (const m of masks) {
    const cov = maskCoverageSized(m, width, height);
    for (let i = 0; i < cov.length; i++) img.data[i * 4 + 3] = (img.data[i * 4 + 3] * cov[i]) / 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** The layer tree as the editor shows it */
export class LayerTree {
  readonly byId: Map<string, LayerCanvasItem>;
  readonly hierarchy: LayerHierarchy;
  readonly isolatedGroups: ReadonlySet<string>;
  constructor(readonly items: LayerCanvasItem[]) {
    this.byId = new Map(items.map((i) => [i.layer.id, i]));
    this.hierarchy = new LayerHierarchy(items.map(({ layer }) => layer));
    this.isolatedGroups = this.hierarchy.isolatedGroups(new Set(items.filter((i) => i.mask?.enabled).map((i) => i.layer.id)));
  }
  isGroup = (i: LayerCanvasItem) => i.layer.layerType === 'group';
  /** Children bottom first; the roots when parentId is null */
  childrenOf(parentId: string | null): LayerCanvasItem[] {
    return this.hierarchy.childrenOf(parentId).map((layer) => this.byId.get(layer.id)!);
  }
  private ancestors(i: LayerCanvasItem, boundary?: string): LayerCanvasItem[] {
    const out: LayerCanvasItem[] = [];
    for (const parent of this.hierarchy.ancestors(i.layer)) {
      if (parent.id === boundary) break;
      out.push(this.byId.get(parent.id)!);
    }
    return out;
  }
  visible = (i: LayerCanvasItem) => this.hierarchy.visible(i.layer);
  opacity = (i: LayerCanvasItem, frame = 0, boundary?: string) => {
    const chain = [...this.ancestors(i, boundary), i];
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
  groupMasks = (i: LayerCanvasItem, boundary?: string): MaskSource[] =>
    this.ancestors(i, boundary).flatMap((a) => (a.mask?.enabled ? [a.mask] : []));
  /** Where an adjustment layer acts (0–255): its own mask × every enclosing group mask; null = everywhere */
  adjustmentCoverage(item: LayerCanvasItem, width: number, height: number, boundary?: string): Uint8ClampedArray | null {
    const masks: MaskSource[] = [...(item.mask?.enabled ? [item.mask] : []), ...this.groupMasks(item, boundary)];
    return combineMaskCoverages(masks.map((m) => maskCoverageSized(m, width, height)), width * height);
  }
  /** Drawable layers bottom to top, each with the base it clips to (if any) */
  drawables(): Array<{ item: LayerCanvasItem; clipBase: LayerCanvasItem | null }> {
    return [...this.hierarchy.descendants(null)].filter((layer) => layer.layerType !== 'group')
      .map((layer) => ({ item: this.byId.get(layer.id)!, clipBase: this.clipBase(this.byId.get(layer.id)!) }));
  }
  clipBase(item: LayerCanvasItem): LayerCanvasItem | null {
    const base = this.hierarchy.clipBase(item.layer);
    return base ? this.byId.get(base.id)! : null;
  }
  coloredCanvas(item: LayerCanvasItem): HTMLCanvasElement {
    const { config } = resolveEffectiveLayerColor(item.layer.id, this.hierarchy.byId);
    return maskedLayerCanvas(item, [], config);
  }
  /** Final pixels of one layer: display colour, own and group masks, clipping, then own layer effects */
  flattened(item: LayerCanvasItem, clipBase: LayerCanvasItem | null, opts?: { skipGroupMasks?: boolean; skipEffects?: boolean }): HTMLCanvasElement {
    if (isAdjustmentItem(item)) {
      // No pixels of its own (its effect is in the merged picture)
      const empty = document.createElement('canvas');
      empty.width = item.canvas.width;
      empty.height = item.canvas.height;
      return empty;
    }
    const { config } = resolveEffectiveLayerColor(item.layer.id, this.hierarchy.byId);
    const src = maskedLayerCanvas(item, opts?.skipGroupMasks ? [] : this.groupMasks(item), config);
    let result = src;
    if (clipBase && clipBase !== item) {
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext('2d')!;
      ctx.drawImage(src, 0, 0);
      ctx.globalCompositeOperation = 'destination-in';
      if (this.visible(clipBase)) {
        const base = clipBaseCanvas(this, clipBase, src.width, src.height);
        ctx.drawImage(base, 0, 0);
        base.width = base.height = 0;
      } else {
        ctx.clearRect(0, 0, out.width, out.height);
      }
      result = out;
    }
    if (!opts?.skipEffects && hasActiveLayerEffects(item.layer.meta?.effects)) {
      result = applyLayerEffectsToCanvas(result, item.layer.meta!.effects);
    }
    return result;
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
    case 'linear_dodge':
    case 'glow':
      return 'lighter';
    case 'erase':
      return 'destination-out';
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
  drawLayerList(ctx, tree, null, width, height);
  ctx.restore();
  return merged;
}

function scratchCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function drawTransformed(ctx: CanvasRenderingContext2D, tree: LayerTree, item: LayerCanvasItem, source: HTMLCanvasElement) {
  if (!source.width || !source.height) return;
  ctx.save();
  const m = tree.transformMatrix(item, ctx.canvas.width, ctx.canvas.height);
  if (!m.isIdentity) ctx.transform(m.a, m.b, m.c, m.d, m.tx, m.ty);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}

function applyMasks(ctx: CanvasRenderingContext2D, masks: MaskSource[]) {
  if (masks.length === 0) return;
  const { width, height } = ctx.canvas;
  const img = ctx.getImageData(0, 0, width, height);
  for (const mask of masks) {
    const coverage = maskCoverageSized(mask, width, height);
    for (let i = 0; i < coverage.length; i++) img.data[4 * i + 3] *= coverage[i] / 255;
  }
  ctx.putImageData(img, 0, 0);
}

function clipBaseCanvas(tree: LayerTree, base: LayerCanvasItem, width: number, height: number, boundary?: string): HTMLCanvasElement {
  if (isAdjustmentItem(base)) return adjustmentBaseCanvas(base, width, height);
  const canvas = scratchCanvas(width, height);
  if (!tree.visible(base)) return canvas;
  const ctx = canvas.getContext('2d')!;
  if (tree.isGroup(base)) {
    const body = isolatedGroupCanvas(tree, base, width, height, boundary, new Map());
    ctx.globalAlpha = tree.opacity(base, 0, boundary);
    ctx.drawImage(body, 0, 0);
    body.width = body.height = 0;
  } else {
    const source = maskedLayerCanvas(base);
    drawTransformed(ctx, tree, base, source);
    if (source !== base.canvas) source.width = source.height = 0;
  }
  return canvas;
}

function applyClip(
  ctx: CanvasRenderingContext2D, tree: LayerTree, item: LayerCanvasItem,
  samples: Map<string, HTMLCanvasElement>, boundary?: string,
) {
  const base = tree.clipBase(item);
  if (!base) return;
  let sample = samples.get(base.layer.id);
  if (!sample) {
    sample = clipBaseCanvas(tree, base, ctx.canvas.width, ctx.canvas.height, boundary);
    samples.set(base.layer.id, sample);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(sample, 0, 0);
  ctx.restore();
}

function applyEffects(source: HTMLCanvasElement, item: LayerCanvasItem): HTMLCanvasElement {
  const styled = applyLayerEffectsToCanvas(source, item.layer.meta?.effects);
  if (styled !== source) source.width = source.height = 0;
  return styled;
}

function isolatedGroupCanvas(
  tree: LayerTree, group: LayerCanvasItem, width: number, height: number, boundary: string | undefined,
  samples: Map<string, HTMLCanvasElement>, members?: ReadonlySet<string>,
): HTMLCanvasElement {
  const body = scratchCanvas(width, height);
  const ctx = body.getContext('2d')!;
  drawLayerList(ctx, tree, group.layer.id, width, height, group.layer.id, members);
  const masks = tree.groupMasks(group, boundary);
  if (group.mask?.enabled) masks.unshift(group.mask);
  applyMasks(ctx, masks);
  applyClip(ctx, tree, group, samples, boundary);
  return applyEffects(body, group);
}

/** Render pass-through folders in the current scope and isolate styled folders as one source. */
function drawLayerList(
  ctx: CanvasRenderingContext2D, tree: LayerTree, parentId: string | null, width: number, height: number,
  boundary?: string, members?: ReadonlySet<string>, samples = new Map<string, HTMLCanvasElement>(),
) {
  const ownsSamples = parentId === (boundary ?? null);
  try {
    for (const item of tree.childrenOf(parentId)) {
      const { id, blendMode } = item.layer;
      if (!tree.visible(item)) continue;
      if (tree.isGroup(item)) {
        if (members && ![...tree.hierarchy.descendants(id)].some((layer) => members.has(layer.id))) continue;
        if (!tree.isolatedGroups.has(id)) {
          drawLayerList(ctx, tree, id, width, height, boundary, members, samples);
          continue;
        }
        const source = isolatedGroupCanvas(tree, item, width, height, boundary, samples, members);
        ctx.save();
        ctx.globalAlpha = tree.opacity(item, 0, boundary);
        ctx.globalCompositeOperation = canvasCompositeOp(blendMode);
        ctx.drawImage(source, 0, 0);
        ctx.restore();
        if (tree.hierarchy.baseIds.has(id) && !members) {
          const sample = scratchCanvas(width, height);
          const sampleCtx = sample.getContext('2d')!;
          sampleCtx.globalAlpha = tree.opacity(item, 0, boundary);
          sampleCtx.drawImage(source, 0, 0);
          samples.set(id, sample);
        }
        source.width = source.height = 0;
        continue;
      }
      if (members && !members.has(id)) continue;
      if (isAdjustmentItem(item)) {
        applyAdjustmentItem(ctx, tree, item, width, height, boundary);
        continue;
      }
      const colored = tree.coloredCanvas(item);
      const outerMasks = tree.groupMasks(item, boundary);
      ctx.save();
      ctx.globalAlpha = tree.opacity(item, 0, boundary);
      ctx.globalCompositeOperation = canvasCompositeOp(blendMode);
      if (tree.clipBase(item) || outerMasks.length || hasActiveLayerEffects(item.layer.meta?.effects)) {
        const local = scratchCanvas(width, height);
        const localCtx = local.getContext('2d')!;
        drawTransformed(localCtx, tree, item, colored);
        applyMasks(localCtx, outerMasks);
        applyClip(localCtx, tree, item, samples, boundary);
        const styled = applyEffects(local, item);
        ctx.drawImage(styled, 0, 0);
        styled.width = styled.height = 0;
      } else {
        drawTransformed(ctx, tree, item, colored);
      }
      ctx.restore();
      if (colored !== item.canvas) colored.width = colored.height = 0;
    }
  } finally {
    if (ownsSamples) for (const sample of samples.values()) sample.width = sample.height = 0;
  }
}

function applyAdjustmentItem(
  ctx: CanvasRenderingContext2D, tree: LayerTree, item: LayerCanvasItem, width: number, height: number, boundary?: string,
) {
  const adjustment = normalizeAdjustment(item.layer.meta?.adjustment);
  if (!adjustment || width <= 0 || height <= 0) return;
  const compiled = compileAdjustment(adjustment);
  const opacity = tree.opacity(item, 0, boundary);
  if (compiled.identity || !(opacity > 0)) return;
  const scope = tree.hierarchy.adjustmentScope(item.layer);
  if (scope.kind === 'none') return;

  let scopePixels: Uint8ClampedArray | null = null;
  if (scope.kind !== 'root' && !(scope.kind === 'group' && scope.groupId === boundary)) {
    if (scope.memberIds.length === 0) return;
    const scratch = scratchCanvas(width, height);
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
    drawLayerList(sctx, tree, boundary ?? null, width, height, boundary, new Set(scope.memberIds));
    scopePixels = sctx.getImageData(0, 0, width, height).data;
    scratch.width = scratch.height = 0;
  }

  const image = ctx.getImageData(0, 0, width, height);
  applyAdjustmentStep({
    width, height, target: image.data, scope: scopePixels,
    coverage: tree.adjustmentCoverage(item, width, height, boundary),
    opacity, compiled, blendMode: item.layer.blendMode,
  });
  ctx.putImageData(image, 0, 0);
}
