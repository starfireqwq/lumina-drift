import { RenderTexture } from 'pixi.js';
import {
  adjustVectorStrokeWidth,
  computeStrokeBounds,
  eraseStrokeToIntersection,
  fitPointsToBezier,
  hitTestVectorStroke,
  pinchVectorStroke,
  renderVectorStrokeToCanvas,
  TileCoord,
  TileData,
  VectorBoundingBox,
  VectorStroke,
} from '@atelier/shared';
import { TileEngine } from './TileEngine';

/** What a vector edit changed: strokes taken out, strokes put in, and the layer tiles before/after. */
export interface VectorEditResult {
  removed: VectorStroke[];
  added: VectorStroke[];
  beforeTiles: TileData[];
  dirtyTiles: TileData[];
  bounds: VectorBoundingBox;
}

const EMPTY_EDIT: VectorEditResult = {
  removed: [],
  added: [],
  beforeTiles: [],
  dirtyTiles: [],
  bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
};

// Extra width (px) of the "where the old line was" mask, so its anti-aliased fringe goes too
const FOOTPRINT_PAD = 3;

/**
 * Fills every masked pixel from its already-known neighbours, growing inward pass by pass
 * (a cheap inpaint). Known = outside the mask and not covered by a remaining vector, so other
 * lines never bleed into the gap. Returns premultiplied RGBA for the masked pixels.
 */
export const healUnderMask = (
  px: Uint8Array,
  mask: Uint8ClampedArray,
  redraw: Uint8ClampedArray,
  w: number,
  h: number,
): Float32Array => {
  const out = new Float32Array(px.length);
  const known = new Uint8Array(w * h);
  let pending: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (mask[p * 4 + 3] > 0) pending.push(p);
    else if (redraw[p * 4 + 3] === 0) {
      known[p] = 1;
      for (let c = 0; c < 4; c++) out[p * 4 + c] = px[p * 4 + c];
    }
  }
  for (let pass = 0; pass < 96 && pending.length > 0; pass++) {
    const next: number[] = [];
    const done: Array<[number, number, number, number, number]> = [];
    for (const p of pending) {
      const px0 = p % w;
      const py0 = (p - px0) / w;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py0 + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px0 + dx;
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!known[q]) continue;
          r += out[q * 4]; g += out[q * 4 + 1]; b += out[q * 4 + 2]; a += out[q * 4 + 3]; n++;
        }
      }
      if (n > 0) done.push([p, r / n, g / n, b / n, a / n]);
      else next.push(p);
    }
    if (done.length === 0) break;
    for (const [p, r, g, b, a] of done) {
      out[p * 4] = r; out[p * 4 + 1] = g; out[p * 4 + 2] = b; out[p * 4 + 3] = a;
      known[p] = 1;
    }
    pending = next;
  }
  return out; // unreachable pixels stay transparent
};

export class VectorEngine {
  private tileEngine: TileEngine;
  private canvasWidth: number;
  private canvasHeight: number;

  // layerId -> list of vector strokes
  private layerStrokes = new Map<string, VectorStroke[]>();

  constructor(tileEngine: TileEngine, canvasWidth: number = 2048, canvasHeight: number = 2048) {
    this.tileEngine = tileEngine;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
  }

  public setDimensions(width: number, height: number) {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  public getStrokes(layerId: string): VectorStroke[] {
    return this.layerStrokes.get(layerId) || [];
  }

  public setStrokes(layerId: string, strokes: VectorStroke[]) {
    this.layerStrokes.set(layerId, [...strokes]);
  }

  /** Adds (or replaces, by id) a stroke definition without touching pixels. */
  public addStroke(layerId: string, stroke: VectorStroke) {
    const list = (this.layerStrokes.get(layerId) || []).filter((s) => s.id !== stroke.id);
    list.push(stroke);
    this.layerStrokes.set(layerId, list);
  }

  public removeStroke(layerId: string, strokeId: string) {
    const list = this.layerStrokes.get(layerId);
    if (!list) return;
    this.layerStrokes.set(layerId, list.filter((s) => s.id !== strokeId));
  }

  /** Applies a synced / replayed list change (removals first, then additions). Pixels come from the op's tiles. */
  public applyDelta(layerId: string, removedIds: string[] | undefined, added: VectorStroke[] | undefined) {
    for (const id of removedIds || []) this.removeStroke(layerId, id);
    for (const s of added || []) this.addStroke(layerId, s);
  }

  /**
   * Creates a VectorStroke from raw stroke points, fits Bézier control anchors,
   * adds to layer, rasterizes to target RenderTexture and extracts LZ4 dirty tiles
   */
  public commitVectorStroke(
    targetRT: RenderTexture,
    layerId: string,
    points: Array<{ x: number; y: number; pressure?: number }>,
    props: {
      color: string;
      baseWidth: number;
      opacity: number;
    }
  ): { stroke: VectorStroke; beforeTiles: TileData[]; dirtyTiles: TileData[]; bounds: VectorBoundingBox } | null {
    if (points.length === 0) return null;

    const anchors = fitPointsToBezier(points, props.baseWidth);
    if (anchors.length === 0) return null;

    const stroke: VectorStroke = {
      id: `vec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      layerId,
      color: props.color,
      opacity: props.opacity,
      baseWidth: props.baseWidth,
      anchors,
      bounds: computeStrokeBounds(anchors, props.baseWidth),
      createdAt: Date.now(),
    };
    return this.addPreparedStroke(targetRT, layerId, stroke);
  }

  /**
   * Draws a finished stroke on top of the layer's existing pixels. Only the new stroke is
   * composited: rebuilding tiles from the vector list alone wiped raster paint in them.
   */
  public addPreparedStroke(
    targetRT: RenderTexture,
    layerId: string,
    stroke: VectorStroke
  ): { stroke: VectorStroke; beforeTiles: TileData[]; dirtyTiles: TileData[]; bounds: VectorBoundingBox } {
    const { bounds } = stroke;
    const coords = this.tileEngine.getDirtyTilesForBounds(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    const beforeTiles = this.tileEngine.extractTilesBatch(targetRT, coords, 'lz4');
    this.addStroke(layerId, stroke);
    const dirtyTiles = this.stampStrokeAndExtractTiles(targetRT, stroke, coords);
    return { stroke, beforeTiles, dirtyTiles, bounds };
  }

  /** Vector Eraser 'entire' (整條線段消除): removes every stroke the eraser circle touches. */
  public eraseEntireStrokes(
    targetRT: RenderTexture,
    layerId: string,
    eraserX: number,
    eraserY: number,
    eraserRadius: number
  ): VectorEditResult {
    const list = this.getStrokes(layerId);
    const removed = list.filter((s) => hitTestVectorStroke(s, eraserX, eraserY, eraserRadius));
    if (removed.length === 0) return EMPTY_EDIT;
    return this.applyEdit(targetRT, layerId, list.filter((s) => !removed.includes(s)), removed, []);
  }

  /** Vector Eraser 'intersect' (交點消除): erases the touched segment up to its intersections. */
  public eraseToIntersections(
    targetRT: RenderTexture,
    layerId: string,
    eraserX: number,
    eraserY: number,
    eraserRadius: number
  ): VectorEditResult {
    const list = this.getStrokes(layerId);
    const removed: VectorStroke[] = [];
    const added: VectorStroke[] = [];
    const next: VectorStroke[] = [];
    for (const stroke of list) {
      if (hitTestVectorStroke(stroke, eraserX, eraserY, eraserRadius)) {
        removed.push(stroke);
        const pieces = eraseStrokeToIntersection(stroke, list, eraserX, eraserY, eraserRadius);
        added.push(...pieces);
        next.push(...pieces);
      } else {
        next.push(stroke);
      }
    }
    if (removed.length === 0) return EMPTY_EDIT;
    return this.applyEdit(targetRT, layerId, next, removed, added);
  }

  /** 修線工具: 捏線 (Pinch & Reshape) */
  public pinchStrokes(
    targetRT: RenderTexture,
    layerId: string,
    center: { x: number; y: number },
    dragDelta: { x: number; y: number },
    brushRadius: number = 40
  ): VectorEditResult {
    return this.mapStrokes(targetRT, layerId, center, brushRadius, (s) => pinchVectorStroke(s, center, dragDelta, brushRadius));
  }

  /** 修線工具: 線寬調整 (加粗 / 變細) */
  public adjustStrokesWidth(
    targetRT: RenderTexture,
    layerId: string,
    center: { x: number; y: number },
    brushRadius: number = 32,
    deltaWidth: number = 2.0
  ): VectorEditResult {
    return this.mapStrokes(targetRT, layerId, center, brushRadius, (s) => adjustVectorStrokeWidth(s, center, brushRadius, deltaWidth));
  }

  /** Node editing / pen tool: swaps whole strokes (by id) for new versions. */
  public replaceStrokes(targetRT: RenderTexture, layerId: string, removedIds: string[], added: VectorStroke[]): VectorEditResult {
    const list = this.getStrokes(layerId);
    const removed = list.filter((s) => removedIds.includes(s.id));
    if (removed.length === 0 && added.length === 0) return EMPTY_EDIT;
    const kept = list.filter((s) => !removedIds.includes(s.id));
    return this.applyEdit(targetRT, layerId, [...kept, ...added], removed, added);
  }

  private mapStrokes(
    targetRT: RenderTexture,
    layerId: string,
    center: { x: number; y: number },
    radius: number,
    fn: (s: VectorStroke) => VectorStroke
  ): VectorEditResult {
    const list = this.getStrokes(layerId);
    const removed: VectorStroke[] = [];
    const added: VectorStroke[] = [];
    const next = list.map((stroke) => {
      const b = stroke.bounds;
      if (center.x + radius < b.minX || center.x - radius > b.maxX || center.y + radius < b.minY || center.y - radius > b.maxY) {
        return stroke;
      }
      const changed = fn(stroke);
      if (changed === stroke) return stroke;
      removed.push(stroke);
      added.push(changed);
      return changed;
    });
    if (removed.length === 0) return EMPTY_EDIT;
    return this.applyEdit(targetRT, layerId, next, removed, added);
  }

  /**
   * Replaces `removed` with `added` on the layer. Only pixels under the old and new lines
   * (their footprint) are cleared; the vectors still there are redrawn inside that footprint.
   * Everything else in the touched tiles (fills, raster paint) is left alone — clearing whole
   * tiles here used to erase the colour next to the line along with it.
   */
  private applyEdit(
    targetRT: RenderTexture,
    layerId: string,
    nextList: VectorStroke[],
    removed: VectorStroke[],
    added: VectorStroke[]
  ): VectorEditResult {
    const footprint = [...removed, ...added];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of footprint) {
      minX = Math.min(minX, s.bounds.minX);
      minY = Math.min(minY, s.bounds.minY);
      maxX = Math.max(maxX, s.bounds.maxX);
      maxY = Math.max(maxY, s.bounds.maxY);
    }
    const x = Math.max(0, Math.floor(minX - FOOTPRINT_PAD));
    const y = Math.max(0, Math.floor(minY - FOOTPRINT_PAD));
    const w = Math.min(this.canvasWidth, Math.ceil(maxX + FOOTPRINT_PAD)) - x;
    const h = Math.min(this.canvasHeight, Math.ceil(maxY + FOOTPRINT_PAD)) - y;
    this.layerStrokes.set(layerId, nextList);
    if (!(w > 0 && h > 0)) return { ...EMPTY_EDIT, removed, added };

    const coords = this.tileEngine.getDirtyTilesForBounds(x, y, x + w, y + h);
    const beforeTiles = this.tileEngine.extractTilesBatch(targetRT, coords, 'lz4');

    // 1. Where the edited lines were / will be (opaque, slightly wider for the AA fringe)
    const mask = this.paint(w, h, x, y, footprint.map((s) => ({
      ...s,
      color: '#ffffff',
      opacity: 1,
      anchors: s.anchors.map((a) => ({ ...a, width: a.width + FOOTPRINT_PAD * 2 })),
    })));
    // 2. Every vector that is still on the layer, drawn over that area
    const redraw = this.paint(w, h, x, y, nextList.filter((s) =>
      s.bounds.maxX >= x && s.bounds.minX <= x + w && s.bounds.maxY >= y && s.bounds.minY <= y + h));

    // 3. Layer pixels (premultiplied). What was under the old line is unknown, so it is healed
    // from the surrounding base pixels: a fill under an erased line closes up, empty stays empty.
    const px = this.tileEngine.readRegion(targetRT, x, y, w, h);
    const healed = healUnderMask(px, mask, redraw, w, h);
    for (let i = 0; i < px.length; i += 4) {
      const m = mask[i + 3] / 255;
      if (m === 0) continue;
      const sa = (redraw[i + 3] / 255) * m;
      for (let c = 0; c < 4; c++) {
        const base = healed[i + c] * m + px[i + c] * (1 - m);
        const top = c === 3 ? 255 : redraw[i + c];
        px[i + c] = Math.round(top * sa + base * (1 - sa));
      }
    }
    this.tileEngine.writeRegion(targetRT, x, y, w, h, px);

    const dirtyTiles = this.tileEngine.extractTilesBatch(targetRT, coords, 'lz4');
    return { removed, added, beforeTiles, dirtyTiles, bounds: { minX: x, minY: y, maxX: x + w, maxY: y + h } };
  }

  /** Rasterizes strokes into a w×h patch at (x, y); returns straight-alpha RGBA. */
  private paint(w: number, h: number, x: number, y: number, strokes: VectorStroke[]): Uint8ClampedArray {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.translate(-x, -y);
    for (const s of strokes) renderVectorStrokeToCanvas(ctx, s);
    return ctx.getImageData(0, 0, w, h).data;
  }

  /**
   * Draws one stroke on top of the layer's existing pixels and returns the resulting tiles
   */
  private stampStrokeAndExtractTiles(
    targetRT: RenderTexture,
    stroke: VectorStroke,
    coords: TileCoord[]
  ): TileData[] {
    const x = Math.max(0, Math.floor(stroke.bounds.minX));
    const y = Math.max(0, Math.floor(stroke.bounds.minY));
    const w = Math.min(this.canvasWidth, Math.ceil(stroke.bounds.maxX)) - x;
    const h = Math.min(this.canvasHeight, Math.ceil(stroke.bounds.maxY)) - y;
    if (w <= 0 || h <= 0) return [];

    const patch = document.createElement('canvas');
    patch.width = w;
    patch.height = h;
    const ctx = patch.getContext('2d')!;
    ctx.translate(-x, -y);
    renderVectorStrokeToCanvas(ctx, stroke);

    this.tileEngine.stampCanvas(targetRT, patch, x, y);
    return this.tileEngine.extractTilesBatch(targetRT, coords, 'lz4');
  }
}
