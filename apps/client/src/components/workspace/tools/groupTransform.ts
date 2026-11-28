import { computeStrokeBounds, type LayerModel, type ScopedUndoOp, type SelectionSnapshot, type TileData, type VectorStroke } from '@atelier/shared';
import { compositeLayers, type LayerCanvasItem } from '../../../engine/layerComposite';
import type { LayerManager } from '../../../engine/LayerManager';
import type { ScopedUndoManager } from '../../../engine/ScopedUndoManager';
import { findContentBounds } from '../../../utils/pixelBounds';
import type { TransformBox } from '../../TransformOverlay';
import type { Bounds } from './toolContext';

export function collectGroupTransformLayers(
  layers: readonly LayerModel[], groupId: string, canEdit: (layer: LayerModel) => boolean,
): LayerModel[] {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const group = byId.get(groupId);
  if (group?.layerType !== 'group') return [];
  const visited = new Set<string>();
  for (let layer: LayerModel | undefined = group; layer; layer = byId.get(layer.parentId ?? '')) {
    if (layer.isLocked || visited.has(layer.id)) return [];
    visited.add(layer.id);
  }

  const children = new Map<string, LayerModel[]>();
  for (const layer of layers) {
    if (!layer.parentId) continue;
    const siblings = children.get(layer.parentId);
    if (siblings) siblings.push(layer);
    else children.set(layer.parentId, [layer]);
  }
  const targets: LayerModel[] = [];
  const remaining = [...(children.get(groupId) ?? [])];
  for (const layer of remaining) {
    if (visited.has(layer.id) || layer.isLocked) continue;
    visited.add(layer.id);
    for (const child of children.get(layer.id) ?? []) remaining.push(child);
    if ((layer.layerType === 'raster' || layer.layerType === 'vector' || layer.layerType === 'mask') && canEdit(layer)) {
      targets.push(layer);
    }
  }
  return targets.sort((a, b) => a.sortOrder - b.sortOrder);
}

export function unionTransformBounds(bounds: Iterable<Bounds | null>): Bounds | null {
  let union: Bounds | null = null;
  for (const box of bounds) {
    if (!box) continue;
    union = union ? {
      minX: Math.min(union.minX, box.minX), minY: Math.min(union.minY, box.minY),
      maxX: Math.max(union.maxX, box.maxX), maxY: Math.max(union.maxY, box.maxY),
    } : { ...box };
  }
  return union;
}

export type TransformRect = { x: number; y: number; w: number; h: number };

/** Bounds are exclusive for pixel content and inclusive for the selection engine. */
export function transformRect(bounds: Bounds, width: number, height: number, selected: boolean): TransformRect {
  const x = Math.max(0, Math.min(width - 1, Math.floor(bounds.minX)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(bounds.minY)));
  const w = Math.min(width - x, Math.max(1, Math.ceil(bounds.maxX) - x + Number(selected)));
  const h = Math.min(height - y, Math.max(1, Math.ceil(bounds.maxY) - y + Number(selected)));
  return { x, y, w, h };
}

export async function readTransformContentBounds(
  lm: LayerManager, id: string, width: number, height: number, tileSize: number, fits: (w: number, h: number) => boolean,
): Promise<Bounds | null> {
  const occupied = lm.occupiedTiles(id);
  const rect = occupied ? unionTransformBounds(occupied.map(({ col, row }) => ({
    minX: col * tileSize, minY: row * tileSize,
    maxX: Math.min(width, (col + 1) * tileSize), maxY: Math.min(height, (row + 1) * tileSize),
  }))) : { minX: 0, minY: 0, maxX: width, maxY: height };
  if (!rect) return null;
  const { x, y, w, h } = transformRect(rect, width, height, false);
  if (!fits(w, h)) throw new RangeError('Transform read exceeds the pixel budget');
  const [pixels] = await lm.readAsync(id, [{ x, y, w, h }]);
  const content = findContentBounds(pixels, w, h);
  return content && {
    minX: x + content.minX, minY: y + content.minY,
    maxX: x + content.maxX + 1, maxY: y + content.maxY + 1,
  };
}

export function liftTransformPixels(
  pixels: Uint8Array, w: number, h: number, coverage?: Uint8ClampedArray,
): HTMLCanvasElement {
  const source = document.createElement('canvas');
  source.width = w;
  source.height = h;
  const ctx = source.getContext('2d')!;
  const image = ctx.createImageData(w, h);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (!a) continue;
    const m = coverage ? coverage[i + 3] / 255 : 1;
    for (let c = 0; c < 3; c++) image.data[i + c] = pixels[i + c] * 255 / a;
    image.data[i + 3] = a * m;
    if (coverage) for (let c = 0; c < 4; c++) pixels[i + c] *= 1 - m;
  }
  ctx.putImageData(image, 0, 0);
  return source;
}

export function groupTransformPreview(
  layers: readonly LayerModel[], originals: ReadonlyMap<string, HTMLCanvasElement>, w: number, h: number,
): HTMLCanvasElement {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const masks = new Map<string, LayerCanvasItem['mask']>();
  const items = new Map<string, LayerCanvasItem>();
  const empty = document.createElement('canvas');
  empty.width = empty.height = 0;
  for (const [id, source] of originals) {
    const layer = byId.get(id);
    if (!layer) continue;
    if (layer.layerType === 'mask' && layer.parentId) {
      masks.set(layer.parentId, { canvas: source, enabled: layer.isVisible, inverted: layer.meta?.maskInverted });
    }
    for (let node: LayerModel | undefined = layer; node && !items.has(node.id); node = byId.get(node.parentId ?? '')) {
      if (node.layerType === 'mask') continue;
      items.set(node.id, { layer: node, canvas: originals.get(node.id) ?? empty });
    }
  }
  for (const item of items.values()) item.mask = masks.get(item.layer.id);
  return compositeLayers([...items.values()], w, h, null);
}

/** Keeps whole-layer affine edits aligned with the vector engine's editable paths. */
export function transformGroupVectorStroke(stroke: VectorStroke, from: TransformBox, to: TransformBox): VectorStroke {
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  const widthScale = Math.sqrt(Math.abs(scaleX * scaleY));
  const cos = Math.cos(to.rotation);
  const sin = Math.sin(to.rotation);
  const transform = (x: number, y: number) => {
    const dx = (x - from.x - from.width / 2) * scaleX;
    const dy = (y - from.y - from.height / 2) * scaleY;
    return {
      x: to.x + to.width / 2 + dx * cos - dy * sin,
      y: to.y + to.height / 2 + dx * sin + dy * cos,
    };
  };
  const anchors = stroke.anchors.map((anchor) => {
    const point = { ...anchor, ...transform(anchor.x, anchor.y), width: anchor.width * widthScale };
    if (anchor.cp1x !== undefined && anchor.cp1y !== undefined) {
      const control = transform(anchor.cp1x, anchor.cp1y);
      point.cp1x = control.x;
      point.cp1y = control.y;
    }
    if (anchor.cp2x !== undefined && anchor.cp2y !== undefined) {
      const control = transform(anchor.cp2x, anchor.cp2y);
      point.cp2x = control.x;
      point.cp2y = control.y;
    }
    return point;
  });
  return { ...stroke, anchors, baseWidth: stroke.baseWidth * widthScale, bounds: computeStrokeBounds(anchors) };
}

export type GroupTransformEdit = {
  layerId: string;
  beforeTiles: TileData[];
  afterTiles: TileData[];
  vectorRemovedStrokes?: VectorStroke[];
  vectorAddedStrokes?: VectorStroke[];
};

export function pushGroupTransformUndo(
  undo: ScopedUndoManager, groupId: string, edits: readonly GroupTransformEdit[], userId: string, desc: string,
  selectionBefore: SelectionSnapshot | null, selectionAfter: SelectionSnapshot | null,
): void {
  const timestamp = Date.now();
  undo.beginGroup(groupId);
  try {
    for (const [index, edit] of edits.entries()) {
      const op: ScopedUndoOp = {
        ...edit, opId: `${groupId}_${index}`, userId, opType: 'STROKE', timestamp, desc,
      };
      if (index === 0) {
        op.selectionBefore = selectionBefore;
        op.selectionAfter = selectionAfter;
      }
      undo.push(op);
    }
  } finally {
    undo.endGroup();
  }
}
