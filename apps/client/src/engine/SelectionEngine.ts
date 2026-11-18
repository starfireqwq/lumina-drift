import { BufferImageSource, Container, Graphics, Sprite, Texture } from 'pixi.js';
import {
  compressTileBuffer,
  contractSelectionMask,
  decompressTileBuffer,
  expandSelectionMask,
  floodFillMagicWand,
  offsetPolygon,
  rasterizeLassoMask,
  type SelectionMaskData,
  type SelectionSnapshot,
} from '@atelier/shared';

export type SelectionCombineMode = 'replace' | 'add' | 'subtract';

export interface SelectionArea {
  type: 'lasso' | 'wand' | 'rect';
  points: Array<{ x: number; y: number }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  tolerance?: number;
  contiguous?: boolean;
}

export class SelectionEngine {
  public rootContainer: Container;
  private selectionGraphic: Graphics;
  private selectionOverlaySprite: Sprite;
  private marchingAntsGraphic: Graphics;
  private maskGraphic: Graphics;

  private activeSelection: SelectionArea | null = null;
  private activeMaskData: SelectionMaskData | null = null;

  private isSelecting: boolean = false;
  private currentPoints: Array<{ x: number; y: number }> = [];

  // Animated marching ants state
  private animFrameId: number | null = null;
  private antOffset: number = 0;
  private maskEdges: Array<[number, number, number, number]> = [];
  private lastAntFrame = 0;
  private onStageChange: (() => void) | null = null;

  private canvasWidth: number = 2048;
  private canvasHeight: number = 2048;

  constructor(width: number = 2048, height: number = 2048) {
    this.canvasWidth = width;
    this.canvasHeight = height;

    this.rootContainer = new Container();
    this.selectionGraphic = new Graphics();
    this.selectionOverlaySprite = new Sprite(Texture.EMPTY);
    this.selectionOverlaySprite.visible = false;
    this.marchingAntsGraphic = new Graphics();
    this.maskGraphic = new Graphics();
    this.maskGraphic.containsPoint = (point: { x: number; y: number }) => this.isPointSelected(point.x, point.y);

    this.rootContainer.addChild(this.selectionOverlaySprite);
    this.rootContainer.addChild(this.selectionGraphic);
    this.rootContainer.addChild(this.marchingAntsGraphic);
  }

  public setOnStageChange(cb: (() => void) | null) {
    this.onStageChange = cb;
  }

  public setCanvasDimensions(width: number, height: number) {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  public getSelection(): SelectionArea | null {
    return this.activeSelection;
  }

  public getMaskData(): SelectionMaskData | null {
    return this.activeMaskData;
  }

  public getMaskArray(): Uint8Array | null {
    return this.activeMaskData ? this.activeMaskData.data : null;
  }

  public hasSelection(): boolean {
    return this.activeMaskData !== null && this.activeMaskData.activePixelCount > 0;
  }

  public isPointSelected(x: number, y: number): boolean {
    const mask = this.activeMaskData;
    if (!mask || !mask.activePixelCount) return false;
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return false;
    return mask.data[py * mask.width + px] > 0;
  }

  public getMaskGraphic(): Graphics | null {
    return this.hasSelection() ? this.maskGraphic : null;
  }

  public startLasso(x: number, y: number) {
    this.isSelecting = true;
    this.currentPoints = [{ x, y }];
    this.renderDraftLasso();
  }

  public addLassoPoint(x: number, y: number) {
    if (!this.isSelecting) return;
    const last = this.currentPoints[this.currentPoints.length - 1];
    if (Math.hypot(x - last.x, y - last.y) > 2) {
      this.currentPoints.push({ x, y });
      this.renderDraftLasso();
    }
  }

  public finishLasso(mode: SelectionCombineMode = 'replace'): SelectionArea | null {
    if (!this.isSelecting || this.currentPoints.length < 3) {
      this.isSelecting = false;
      this.currentPoints = [];
      if (mode === 'replace') {
        // Left-clicking blank space with Lasso cancels any existing selection
        this.clearSelection();
        return null;
      }
      this.renderActiveSelection();
      return this.activeSelection;
    }
    this.isSelecting = false;

    // Rasterize Lasso path to binary mask
    const mask = this.combine(rasterizeLassoMask(this.currentPoints, this.canvasWidth, this.canvasHeight), mode);
    if (mask.activePixelCount === 0) {
      this.currentPoints = [];
      if (mode === 'replace' || !this.activeMaskData?.activePixelCount) {
        this.clearSelection();
        return null;
      }
    }
    this.activeMaskData = mask;

    this.activeSelection = {
      type: 'lasso',
      // A combined selection is no longer this one polygon
      points: mode === 'replace' ? [...this.currentPoints] : [],
      bounds: mask.bounds,
    };

    this.renderActiveSelection();
    return this.activeSelection;
  }

  /**
   * Merges a new mask into the active one: 'add' keeps the larger coverage per pixel,
   * 'subtract' removes the new mask's coverage. Bounds and the pixel count are recomputed.
   */
  private combine(next: SelectionMaskData, mode: SelectionCombineMode): SelectionMaskData {
    const prev = this.activeMaskData;
    if (mode === 'replace' || !prev || prev.activePixelCount === 0) {
      if (mode === 'subtract') return { ...next, data: new Uint8Array(next.data.length), activePixelCount: 0, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
      return next;
    }
    const w = this.canvasWidth;
    const data = new Uint8Array(prev.data);
    const scan = mode === 'add'
      ? { minX: Math.min(prev.bounds.minX, next.bounds.minX), minY: Math.min(prev.bounds.minY, next.bounds.minY), maxX: Math.max(prev.bounds.maxX, next.bounds.maxX), maxY: Math.max(prev.bounds.maxY, next.bounds.maxY) }
      : prev.bounds;
    let count = 0;
    let minX = w, minY = this.canvasHeight, maxX = -1, maxY = -1;
    for (let y = Math.max(0, scan.minY); y <= Math.min(this.canvasHeight - 1, scan.maxY); y++) {
      for (let x = Math.max(0, scan.minX); x <= Math.min(w - 1, scan.maxX); x++) {
        const i = y * w + x;
        const v = mode === 'add' ? Math.max(data[i], next.data[i]) : Math.round(data[i] * (1 - next.data[i] / 255));
        data[i] = v;
        if (v > 0) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      width: w,
      height: this.canvasHeight,
      data,
      activePixelCount: count,
      bounds: count > 0 ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    };
  }

  /**
   * Magic Wand Selection based on layer pixels, tolerance, and contiguous setting
   */
  public selectWand(
    layerPixels: Uint8Array | Uint8ClampedArray,
    x: number,
    y: number,
    tolerance: number = 32,
    contiguous: boolean = true,
    mode: SelectionCombineMode = 'replace'
  ): SelectionArea | null {
    const cx = Math.max(0, Math.min(this.canvasWidth - 1, Math.floor(x)));
    const cy = Math.max(0, Math.min(this.canvasHeight - 1, Math.floor(y)));
    const targetAlpha = layerPixels[(cy * this.canvasWidth + cx) * 4 + 3] ?? 0;
    const rawMask = floodFillMagicWand(
      layerPixels,
      this.canvasWidth,
      this.canvasHeight,
      x,
      y,
      tolerance,
      contiguous
    );
    // Left-clicking open blank space (transparent exterior touching >=2 canvas edges) cancels selection
    if (targetAlpha <= 4 && rawMask.activePixelCount > 0) {
      const b = rawMask.bounds;
      const touchesEdges =
        (b.minX === 0 ? 1 : 0) +
        (b.maxX === this.canvasWidth - 1 ? 1 : 0) +
        (b.minY === 0 ? 1 : 0) +
        (b.maxY === this.canvasHeight - 1 ? 1 : 0);
      if (touchesEdges >= 2 || rawMask.activePixelCount >= this.canvasWidth * this.canvasHeight) {
        if (mode === 'replace') {
          this.clearSelection();
          return null;
        }
        return this.activeSelection;
      }
    }

    const mask = this.combine(rawMask, mode);
    if (mask.activePixelCount === 0) {
      if (mode === 'replace') {
        this.clearSelection();
        return null;
      }
    }

    this.activeMaskData = mask;

    this.activeSelection = {
      type: 'wand',
      points: [],
      bounds: mask.bounds,
      tolerance,
      contiguous,
    };

    this.renderActiveSelection();
    return this.activeSelection;
  }

  /** Exports a compact LZ4-compressed bounding-box snapshot of the selection for Undo/Redo */
  public exportSnapshot(): SelectionSnapshot | null {
    const mask = this.activeMaskData;
    if (!mask || mask.activePixelCount <= 0) return null;
    const { minX, minY, maxX, maxY } = mask.bounds;
    const bw = Math.max(1, maxX - minX + 1);
    const bh = Math.max(1, maxY - minY + 1);
    const crop = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const srcOff = (minY + y) * mask.width + minX;
      crop.set(mask.data.subarray(srcOff, srcOff + bw), y * bw);
    }
    const { compression, data } = compressTileBuffer(crop, 'lz4');
    return {
      width: this.canvasWidth,
      height: this.canvasHeight,
      bounds: { ...mask.bounds },
      activePixelCount: mask.activePixelCount,
      compression: compression === 'raw' ? 'raw' : 'lz4',
      data,
    };
  }

  /** Restores a selection state saved by exportSnapshot (null clears the selection) */
  public restoreSnapshot(snap: SelectionSnapshot | null | undefined) {
    if (!snap || snap.activePixelCount <= 0) {
      this.clearSelection();
      return;
    }
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    const full = new Uint8Array(w * h);
    const { minX, minY, maxX, maxY } = snap.bounds;
    const bw = Math.max(1, maxX - minX + 1);
    const bh = Math.max(1, maxY - minY + 1);
    const raw = snap.compression === 'lz4' ? decompressTileBuffer(snap.data, 'lz4', bw * bh) : snap.data;
    const copyW = Math.min(bw, Math.max(0, w - minX));
    const copyH = Math.min(bh, Math.max(0, h - minY));
    for (let y = 0; y < copyH; y++) {
      full.set(raw.subarray(y * bw, y * bw + copyW), (minY + y) * w + minX);
    }
    const clampedBounds = {
      minX: Math.max(0, minX),
      minY: Math.max(0, minY),
      maxX: Math.min(w - 1, maxX),
      maxY: Math.min(h - 1, maxY),
    };
    this.activeMaskData = {
      width: w,
      height: h,
      data: full,
      bounds: clampedBounds,
      activePixelCount: snap.activePixelCount,
    };
    this.activeSelection = { type: 'lasso', points: [], bounds: clampedBounds };
    this.renderActiveSelection();
  }

  /**
   * Expands the active selection mask outward by radius pixels
   */
  public expandSelection(radius: number = 3) {
    if (!this.activeMaskData || this.activeMaskData.activePixelCount === 0) return;

    const b = this.activeMaskData.bounds;
    const expandedData = expandSelectionMask(
      this.activeMaskData.data,
      this.canvasWidth,
      this.canvasHeight,
      radius,
      b
    );

    const newBounds = {
      minX: Math.max(0, b.minX - radius),
      minY: Math.max(0, b.minY - radius),
      maxX: Math.min(this.canvasWidth - 1, b.maxX + radius),
      maxY: Math.min(this.canvasHeight - 1, b.maxY + radius),
    };

    // Fast count within bounded region
    let activeCount = 0;
    for (let y = newBounds.minY; y <= newBounds.maxY; y++) {
      const row = y * this.canvasWidth;
      for (let x = newBounds.minX; x <= newBounds.maxX; x++) {
        if (expandedData[row + x] > 0) activeCount++;
      }
    }

    this.activeMaskData = {
      width: this.canvasWidth,
      height: this.canvasHeight,
      data: expandedData,
      bounds: newBounds,
      activePixelCount: activeCount,
    };

    if (this.activeSelection) {
      if (this.activeSelection.points && this.activeSelection.points.length >= 3) {
        this.activeSelection.points = offsetPolygon(this.activeSelection.points, radius);
      }
      this.activeSelection.bounds = newBounds;
    }

    this.renderActiveSelection();
    this.renderMarchingAnts();
  }

  /**
   * Contracts the active selection mask inward by radius pixels
   */
  public contractSelection(radius: number = 3) {
    if (!this.activeMaskData || this.activeMaskData.activePixelCount === 0) return;

    const b = this.activeMaskData.bounds;
    const contractedData = contractSelectionMask(
      this.activeMaskData.data,
      this.canvasWidth,
      this.canvasHeight,
      radius,
      b
    );

    // Fast count within bounded region
    let activeCount = 0;
    let minX = this.canvasWidth;
    let minY = this.canvasHeight;
    let maxX = 0;
    let maxY = 0;

    for (let y = b.minY; y <= b.maxY; y++) {
      const row = y * this.canvasWidth;
      for (let x = b.minX; x <= b.maxX; x++) {
        if (contractedData[row + x] > 0) {
          activeCount++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const newBounds =
      activeCount > 0 ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    this.activeMaskData = {
      width: this.canvasWidth,
      height: this.canvasHeight,
      data: contractedData,
      bounds: newBounds,
      activePixelCount: activeCount,
    };

    if (this.activeSelection) {
      if (this.activeSelection.points && this.activeSelection.points.length >= 3) {
        this.activeSelection.points = offsetPolygon(this.activeSelection.points, -radius);
      }
      this.activeSelection.bounds = newBounds;
    }

    this.renderActiveSelection();
    this.renderMarchingAnts();
  }

  /**
   * Selects what was not selected (feathered edges invert too); with nothing selected, selects the
   * whole canvas. An empty result (everything was selected) clears the selection.
   */
  public invertSelection() {
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    const prev = this.activeMaskData?.data;
    const data = new Uint8Array(w * h);
    let count = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = 255 - (prev ? prev[i] : 0);
        data[i] = v;
        if (v > 0) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (count === 0) {
      this.clearSelection();
      return;
    }
    const bounds = { minX, minY, maxX, maxY };
    this.activeMaskData = { width: w, height: h, data, bounds, activePixelCount: count };
    this.activeSelection = { type: 'lasso', points: [], bounds };
    this.renderActiveSelection();
  }

  /** Replaces / adds to / subtracts from the selection a whole-canvas coverage map (0–255 per pixel) */
  public applyMask(data: Uint8Array, mode: SelectionCombineMode = 'replace') {
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    let count = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!data[y * w + x]) continue;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const next: SelectionMaskData = {
      width: w, height: h, data, activePixelCount: count,
      bounds: count ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    };
    const mask = this.combine(next, mode);
    if (!mask.activePixelCount) {
      this.clearSelection();
      return;
    }
    this.activeMaskData = mask;
    this.activeSelection = { type: 'lasso', points: [], bounds: mask.bounds };
    this.renderActiveSelection();
  }

  /** 羽化: softens the edge over `radius` px (three box blurs ≈ a gaussian) */
  public featherSelection(radius: number) {
    const mask = this.activeMaskData;
    const r = Math.round(radius);
    if (!mask || r < 1) return;
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    let src = new Float32Array(mask.data);
    let dst = new Float32Array(src.length);
    const pass = (horizontal: boolean) => {
      const lines = horizontal ? h : w;
      const len = horizontal ? w : h;
      const at = (line: number, k: number) => (horizontal ? line * w + k : k * w + line);
      for (let line = 0; line < lines; line++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[at(line, Math.min(len - 1, Math.max(0, k)))];
        for (let k = 0; k < len; k++) {
          dst[at(line, k)] = sum / (2 * r + 1);
          sum += src[at(line, Math.min(len - 1, k + r + 1))] - src[at(line, Math.max(0, k - r))];
        }
      }
      [src, dst] = [dst, src];
    };
    for (let i = 0; i < 3; i++) {
      pass(true);
      pass(false);
    }
    this.applyMask(Uint8Array.from(src, (v) => Math.round(v)));
  }

  // 選取筆 / 選取橡皮擦: paint the selection with a round tip, merged in on release
  private brushMask: Uint8Array | null = null;
  private brushLast: { x: number; y: number } | null = null;
  private brushRadius = 10;
  private brushAdds = true;

  public startBrush(x: number, y: number, radius: number, adds: boolean) {
    this.brushMask = new Uint8Array(this.canvasWidth * this.canvasHeight);
    this.brushRadius = Math.max(1, radius);
    this.brushAdds = adds;
    this.brushLast = null;
    this.addBrushPoint(x, y);
  }

  public addBrushPoint(x: number, y: number) {
    const mask = this.brushMask;
    if (!mask) return;
    const r = this.brushRadius;
    const from = this.brushLast ?? { x, y };
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / Math.max(1, r / 3)));
    for (let s = 1; s <= steps; s++) {
      const cx = from.x + ((x - from.x) * s) / steps;
      const cy = from.y + ((y - from.y) * s) / steps;
      for (let py = Math.max(0, Math.floor(cy - r)); py <= Math.min(this.canvasHeight - 1, Math.ceil(cy + r)); py++) {
        for (let px = Math.max(0, Math.floor(cx - r)); px <= Math.min(this.canvasWidth - 1, Math.ceil(cx + r)); px++) {
          if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) mask[py * this.canvasWidth + px] = 255;
        }
      }
      this.selectionGraphic.circle(cx, cy, r).fill({ color: this.brushAdds ? 0x3b82f6 : 0xef4444, alpha: 0.18 });
    }
    this.brushLast = { x, y };
    this.onStageChange?.();
  }

  public isBrushing() {
    return this.brushMask !== null;
  }

  public finishBrush() {
    const mask = this.brushMask;
    this.brushMask = null;
    this.brushLast = null;
    if (!mask) return;
    this.selectionGraphic.clear();
    this.applyMask(mask, this.brushAdds ? 'add' : 'subtract');
    if (!this.hasSelection()) this.renderActiveSelection();
  }

  public clearSelection() {
    this.activeSelection = null;
    this.maskEdges = [];
    this.activeMaskData = null;
    this.isSelecting = false;
    this.currentPoints = [];
    this.selectionGraphic.clear();
    this.marchingAntsGraphic.clear();
    this.maskGraphic.clear();
    if (this.selectionOverlaySprite.texture !== Texture.EMPTY) {
      this.selectionOverlaySprite.texture.destroy(true);
      this.selectionOverlaySprite.texture = Texture.EMPTY;
    }
    this.selectionOverlaySprite.visible = false;
    this.syncAntsAnimation();
    this.onStageChange?.();
  }

  public getCurrentPoints(): Array<{ x: number; y: number }> {
    return [...this.currentPoints];
  }

  public clearDraft() {
    if (!this.isSelecting) return;
    this.isSelecting = false;
    this.currentPoints = [];
    this.renderActiveSelection();
  }

  public cancelSelection() {
    this.clearSelection();
  }

  /** Canvas zoom: outlines are drawn in canvas units, so their widths are divided by it (same on-screen width at any zoom) */
  private viewScale = 1;

  public setViewScale(zoom: number) {
    const s = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    if (Math.abs(s - this.viewScale) < 1e-6) return;
    this.viewScale = s;
    if (this.isSelecting) this.renderDraftLasso();
    this.renderMarchingAnts();
  }

  private renderDraftLasso() {
    this.selectionGraphic.clear();
    if (this.currentPoints.length < 2) {
      this.onStageChange?.();
      return;
    }

    // A dark halo under a light line: readable on light and dark paint alike, 1.5 screen px wide
    const w = 1.5 / this.viewScale;
    for (const [width, color, alpha] of [[w + 2 / this.viewScale, 0x0b1020, 0.55], [w, 0x93c5fd, 1]] as const) {
      this.selectionGraphic.beginPath();
      this.selectionGraphic.moveTo(this.currentPoints[0].x, this.currentPoints[0].y);
      for (let i = 1; i < this.currentPoints.length; i++) {
        this.selectionGraphic.lineTo(this.currentPoints[i].x, this.currentPoints[i].y);
      }
      this.selectionGraphic.stroke({ width, color, alpha, join: 'round', cap: 'round' });
    }
    this.onStageChange?.();
  }

  public updateMaskGraphic() {
    this.maskGraphic.clear();
    this.maskEdges = [];
    if (this.selectionOverlaySprite.texture !== Texture.EMPTY) {
      this.selectionOverlaySprite.texture.destroy(true);
      this.selectionOverlaySprite.texture = Texture.EMPTY;
    }
    this.selectionOverlaySprite.visible = false;

    const mask = this.activeMaskData;
    if (!mask || !mask.activePixelCount) return;

    const { width, height, data, bounds } = mask;
    const minX = Math.max(0, bounds.minX);
    const minY = Math.max(0, bounds.minY);
    const maxX = Math.min(width - 1, bounds.maxX);
    const maxY = Math.min(height - 1, bounds.maxY);
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw <= 0 || bh <= 0) return;

    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && data[y * width + x] > 0;

    // 1. Visual highlight overlay using a single Sprite (avoids thousands of Pixi Graphics.rect polygons)
    const stride = Math.max(1, Math.ceil(Math.max(bw, bh) / 2048));
    const ovW = Math.max(1, Math.ceil(bw / stride));
    const ovH = Math.max(1, Math.ceil(bh / stride));
    const rgba = new Uint8Array(ovW * ovH * 4);
    for (let oy = 0; oy < ovH; oy++) {
      const sy = Math.min(maxY, minY + oy * stride);
      const srcRow = sy * width;
      const dstRow = oy * ovW * 4;
      for (let ox = 0; ox < ovW; ox++) {
        const sx = Math.min(maxX, minX + ox * stride);
        if (data[srcRow + sx] > 0) {
          const k = dstRow + ox * 4;
          // Premultiplied tint (0x3b82f6 @ alpha 0.12 => ~31/255)
          rgba[k] = 7;
          rgba[k + 1] = 16;
          rgba[k + 2] = 30;
          rgba[k + 3] = 31;
        }
      }
    }
    this.selectionOverlaySprite.texture = new Texture({
      source: new BufferImageSource({
        resource: rgba,
        width: ovW,
        height: ovH,
        format: 'rgba8unorm',
        alphaMode: 'premultiplied-alpha',
      }),
    });
    this.selectionOverlaySprite.position.set(minX, minY);
    this.selectionOverlaySprite.scale.set(stride);
    this.selectionOverlaySprite.visible = true;

    // 2. Run-length merge horizontal and vertical boundary segments for fast marching ants
    for (let y = minY; y <= maxY; y++) {
      let topStart = -1;
      let botStart = -1;
      for (let x = minX; x <= maxX + 1; x++) {
        const cur = x <= maxX && inside(x, y);
        const needTop = cur && !inside(x, y - 1);
        const needBot = cur && !inside(x, y + 1);
        if (needTop) {
          if (topStart < 0) topStart = x;
        } else if (topStart >= 0) {
          this.maskEdges.push([topStart, y, x, y]);
          topStart = -1;
        }
        if (needBot) {
          if (botStart < 0) botStart = x;
        } else if (botStart >= 0) {
          this.maskEdges.push([botStart, y + 1, x, y + 1]);
          botStart = -1;
        }
      }
    }
    for (let x = minX; x <= maxX; x++) {
      let leftStart = -1;
      let rightStart = -1;
      for (let y = minY; y <= maxY + 1; y++) {
        const cur = y <= maxY && inside(x, y);
        const needLeft = cur && !inside(x - 1, y);
        const needRight = cur && !inside(x + 1, y);
        if (needLeft) {
          if (leftStart < 0) leftStart = y;
        } else if (leftStart >= 0) {
          this.maskEdges.push([x, leftStart, x, y]);
          leftStart = -1;
        }
        if (needRight) {
          if (rightStart < 0) rightStart = y;
        } else if (rightStart >= 0) {
          this.maskEdges.push([x + 1, rightStart, x + 1, y]);
          rightStart = -1;
        }
      }
    }
  }

  private renderActiveSelection() {
    this.selectionGraphic.clear();
    this.updateMaskGraphic();
    this.renderMarchingAnts();
    this.syncAntsAnimation();
    this.onStageChange?.();
  }

  private syncAntsAnimation() {
    if (!this.maskEdges.length) {
      if (this.animFrameId !== null) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }
      return;
    }
    if (this.animFrameId !== null) return;
    const animate = (time: number) => {
      if (!this.maskEdges.length) {
        this.animFrameId = null;
        return;
      }
      if (time - this.lastAntFrame >= 95) {
        this.antOffset = (this.antOffset + 1) % 12;
        this.lastAntFrame = time;
        this.renderMarchingAnts();
      }
      this.animFrameId = requestAnimationFrame(animate);
    };
    this.animFrameId = requestAnimationFrame(animate);
  }

  private renderMarchingAnts() {
    this.marchingAntsGraphic.clear();
    if (!this.maskEdges.length) {
      this.onStageChange?.();
      return;
    }
    // 1 screen px wide, dashes 6 screen px long, whatever the zoom
    const s = this.viewScale;
    const dashCanvas = 6 / s;
    const phaseCanvas = this.antOffset / s;
    for (let color = 0; color < 2; color++) {
      this.marchingAntsGraphic.beginPath();
      for (const [x1, y1, x2, y2] of this.maskEdges) {
        const isHoriz = y1 === y2;
        const len = isHoriz ? x2 - x1 : y2 - y1;
        if (len <= 0) continue;
        // Phase along x+y matches original pixel marching parity cleanly
        let pos = 0;
        const baseCoord = x1 + y1 + phaseCanvas;
        while (pos < len) {
          const phase = (baseCoord + pos) / dashCanvas;
          const bucket = Math.floor(phase);
          const stepToBoundary = (bucket + 1) * dashCanvas - (baseCoord + pos);
          const segLen = Math.min(len - pos, Math.max(0.25 / s, stepToBoundary));
          if (((bucket % 2) + 2) % 2 === color) {
            if (isHoriz) {
              this.marchingAntsGraphic.moveTo(x1 + pos, y1).lineTo(x1 + pos + segLen, y1);
            } else {
              this.marchingAntsGraphic.moveTo(x1, y1 + pos).lineTo(x1, y1 + pos + segLen);
            }
          }
          pos += segLen;
        }
      }
      this.marchingAntsGraphic.stroke({ width: 1 / s, color: color ? 0xffffff : 0x111111 });
    }
    this.onStageChange?.();
  }

  public destroy() {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.selectionOverlaySprite.texture !== Texture.EMPTY) {
      this.selectionOverlaySprite.texture.destroy(true);
    }
    this.selectionOverlaySprite.destroy();
    this.selectionGraphic.destroy();
    this.marchingAntsGraphic.destroy();
    this.maskGraphic.destroy();
    this.rootContainer.destroy({ children: true });
  }
}
