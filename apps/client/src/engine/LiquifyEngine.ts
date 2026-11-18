import { Renderer, RenderTexture } from 'pixi.js';
import { DEFAULT_TILE_SIZE, getSelectionMaskFactor } from '@atelier/shared';
import { TileEngine } from './TileEngine';
import type { LayerManager } from './LayerManager';

const TS = DEFAULT_TILE_SIZE;

export type LiquifyMode =
  | 'push'
  | 'expand'
  | 'pinch'
  | 'push_left'
  | 'push_right'
  | 'twirl_left'
  | 'twirl_right'
  | 'twirl';

export interface LiquifyConfig {
  mode: LiquifyMode;
  radius: number; // 5 to 250px
  strength: number; // 0.05 to 1.0
  hardness?: number; // 0.0 to 1.0 (default 0.5, CSP style falloff plateau)
  referenceAreaOnly?: boolean; // CSP "僅參照操作範圍的圖像"
}

/**
 * Non-blurring inverse displacement field Liquify Engine (CSP style).
 *
 * Instead of resampling the rendered pixels iteratively every pointer move (which causes
 * severe compounding bilinear blur after a few moves), this engine maintains a sparse
 * backward displacement map D(p) = (dx, dy) over touched 256×256 tiles and always
 * reconstructs the deformed image ONCE per pixel directly from the untouched pre-stroke
 * source tiles using 16-tap Catmull-Rom bicubic interpolation.
 */
export class LiquifyEngine {
  private tileEngine: TileEngine;
  private canvasWidth: number;
  private canvasHeight: number;
  private cols: number;
  private rows: number;

  // Per-stroke sparse snapshot & displacement state
  private layerManager: LayerManager | null = null;
  private activeLayerId: string | null = null;
  private activeTargetRT: RenderTexture | null = null;
  private srcTiles = new Map<string, Uint8Array | null>();
  private dispTiles = new Map<string, Float32Array>();

  constructor(
    _renderer: Renderer,
    tileEngine: TileEngine,
    canvasWidth: number,
    canvasHeight: number
  ) {
    this.tileEngine = tileEngine;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.cols = Math.max(1, Math.ceil(canvasWidth / TS));
    this.rows = Math.max(1, Math.ceil(canvasHeight / TS));
  }

  public setDimensions(width: number, height: number) {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.cols = Math.max(1, Math.ceil(width / TS));
    this.rows = Math.max(1, Math.ceil(height / TS));
    this.endStroke();
  }

  /** Initializes a sparse displacement session for one drag stroke (never forces resident textures). */
  public beginStroke(layerManager: LayerManager, layerId: string) {
    this.endStroke();
    this.layerManager = layerManager;
    this.activeLayerId = layerId;
  }

  public endStroke() {
    this.layerManager = null;
    this.activeLayerId = null;
    this.activeTargetRT = null;
    this.srcTiles.clear();
    this.dispTiles.clear();
  }

  private tileDim(col: number, row: number): { tw: number; th: number } {
    return {
      tw: Math.min(TS, this.canvasWidth - col * TS),
      th: Math.min(TS, this.canvasHeight - row * TS),
    };
  }

  private ensureSourceTile(col: number, row: number): Uint8Array | null {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    const key = `${col}_${row}`;
    if (this.srcTiles.has(key)) return this.srcTiles.get(key) ?? null;

    let tile: Uint8Array | null = null;
    if (this.layerManager && this.activeLayerId) {
      tile = this.layerManager.readTileSync(this.activeLayerId, col, row, 'before');
    } else if (this.activeTargetRT) {
      const { tw, th } = this.tileDim(col, row);
      if (tw > 0 && th > 0) {
        tile = this.tileEngine.readRegion(this.activeTargetRT, col * TS, row * TS, tw, th);
      }
    }
    this.srcTiles.set(key, tile);
    return tile;
  }

  private getOrCreateDispTile(col: number, row: number): Float32Array | null {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    const key = `${col}_${row}`;
    let buf = this.dispTiles.get(key);
    if (!buf) {
      const { tw, th } = this.tileDim(col, row);
      if (tw <= 0 || th <= 0) return null;
      buf = new Float32Array(tw * th * 2);
      this.dispTiles.set(key, buf);
    }
    return buf;
  }

  private sampleDisplacement(x: number, y: number): [number, number] {
    const cx = Math.max(0, Math.min(this.canvasWidth - 1.001, x));
    const cy = Math.max(0, Math.min(this.canvasHeight - 1.001, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(this.canvasWidth - 1, x0 + 1);
    const y1 = Math.min(this.canvasHeight - 1, y0 + 1);
    const fx = cx - x0;
    const fy = cy - y0;

    const readOne = (px: number, py: number): [number, number] => {
      const col = px >> 8;
      const row = py >> 8;
      const buf = this.dispTiles.get(`${col}_${row}`);
      if (!buf) return [0, 0];
      const { tw } = this.tileDim(col, row);
      const idx = ((py & 255) * tw + (px & 255)) * 2;
      return [buf[idx], buf[idx + 1]];
    };

    const [d00x, d00y] = readOne(x0, y0);
    const [d10x, d10y] = readOne(x1, y0);
    const [d01x, d01y] = readOne(x0, y1);
    const [d11x, d11y] = readOne(x1, y1);

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    return [
      d00x * w00 + d10x * w10 + d01x * w01 + d11x * w11,
      d00y * w00 + d10y * w10 + d01y * w01 + d11y * w11,
    ];
  }

  private sampleSrcPx(ix: number, iy: number, refMask: { cx: number; cy: number; rSq: number } | null, out: [number, number, number, number]) {
    if (ix < 0 || iy < 0 || ix >= this.canvasWidth || iy >= this.canvasHeight) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return;
    }
    if (refMask) {
      const rx = ix - refMask.cx;
      const ry = iy - refMask.cy;
      if (rx * rx + ry * ry > refMask.rSq) {
        out[0] = out[1] = out[2] = out[3] = 0;
        return;
      }
    }
    const col = ix >> 8;
    const row = iy >> 8;
    const tile = this.ensureSourceTile(col, row);
    if (!tile) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return;
    }
    const tw = Math.min(TS, this.canvasWidth - col * TS);
    const idx = ((iy & 255) * tw + (ix & 255)) * 4;
    out[0] = tile[idx];
    out[1] = tile[idx + 1];
    out[2] = tile[idx + 2];
    out[3] = tile[idx + 3];
  }

  /**
   * 16-tap Catmull-Rom bicubic interpolation against untouched source tiles,
   * preserving crisp ink edges & premultiplied alpha invariants without dark halos.
   */
  private sampleSrcBicubic(
    sx: number,
    sy: number,
    refMask: { cx: number; cy: number; rSq: number } | null,
    dst: Uint8Array,
    dstIdx: number
  ) {
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    const tx = sx - ix;
    const ty = sy - iy;

    // Fast path when all 16 taps lie inside a single cached tile (true ~95%+ of the time)
    const minCol = (ix - 1) >> 8;
    const maxCol = (ix + 2) >> 8;
    const minRow = (iy - 1) >> 8;
    const maxRow = (iy + 2) >> 8;
    if (
      !refMask &&
      minCol === maxCol &&
      minRow === maxRow &&
      ix >= 1 &&
      iy >= 1 &&
      ix + 2 < this.canvasWidth &&
      iy + 2 < this.canvasHeight
    ) {
      const tile = this.ensureSourceTile(minCol, minRow);
      if (!tile) {
        dst[dstIdx] = dst[dstIdx + 1] = dst[dstIdx + 2] = dst[dstIdx + 3] = 0;
        return;
      }
      const tw = Math.min(TS, this.canvasWidth - minCol * TS);
      const lx = (ix & 255) - 1;
      const ly = (iy & 255) - 1;

      const wx0 = ((-0.5 * tx + 1.0) * tx - 0.5) * tx;
      const wx1 = ((1.5 * tx - 2.5) * tx) * tx + 1.0;
      const wx2 = ((-1.5 * tx + 2.0) * tx + 0.5) * tx;
      const wx3 = ((0.5 * tx - 0.5) * tx) * tx;

      const wy0 = ((-0.5 * ty + 1.0) * ty - 0.5) * ty;
      const wy1 = ((1.5 * ty - 2.5) * ty) * ty + 1.0;
      const wy2 = ((-1.5 * ty + 2.0) * ty + 0.5) * ty;
      const wy3 = ((0.5 * ty - 0.5) * ty) * ty;

      const wy = [wy0, wy1, wy2, wy3];
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < 4; j++) {
        const wRow = wy[j];
        const rowBase = ((ly + j) * tw + lx) * 4;
        const rr = tile[rowBase] * wx0 + tile[rowBase + 4] * wx1 + tile[rowBase + 8] * wx2 + tile[rowBase + 12] * wx3;
        const gg = tile[rowBase + 1] * wx0 + tile[rowBase + 5] * wx1 + tile[rowBase + 9] * wx2 + tile[rowBase + 13] * wx3;
        const bb = tile[rowBase + 2] * wx0 + tile[rowBase + 6] * wx1 + tile[rowBase + 10] * wx2 + tile[rowBase + 14] * wx3;
        const aa = tile[rowBase + 3] * wx0 + tile[rowBase + 7] * wx1 + tile[rowBase + 11] * wx2 + tile[rowBase + 15] * wx3;
        r += rr * wRow;
        g += gg * wRow;
        b += bb * wRow;
        a += aa * wRow;
      }
      const finalA = Math.max(0, Math.min(255, Math.round(a)));
      dst[dstIdx] = Math.max(0, Math.min(finalA, Math.round(r)));
      dst[dstIdx + 1] = Math.max(0, Math.min(finalA, Math.round(g)));
      dst[dstIdx + 2] = Math.max(0, Math.min(finalA, Math.round(b)));
      dst[dstIdx + 3] = finalA;
      return;
    }

    const wx = [
      ((-0.5 * tx + 1.0) * tx - 0.5) * tx,
      ((1.5 * tx - 2.5) * tx) * tx + 1.0,
      ((-1.5 * tx + 2.0) * tx + 0.5) * tx,
      ((0.5 * tx - 0.5) * tx) * tx,
    ];
    const wy = [
      ((-0.5 * ty + 1.0) * ty - 0.5) * ty,
      ((1.5 * ty - 2.5) * ty) * ty + 1.0,
      ((-1.5 * ty + 2.0) * ty + 0.5) * ty,
      ((0.5 * ty - 0.5) * ty) * ty,
    ];
    const tap: [number, number, number, number] = [0, 0, 0, 0];
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < 4; j++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      const py = iy - 1 + j;
      for (let i = 0; i < 4; i++) {
        this.sampleSrcPx(ix - 1 + i, py, refMask, tap);
        const w = wx[i];
        rr += tap[0] * w;
        gg += tap[1] * w;
        bb += tap[2] * w;
        aa += tap[3] * w;
      }
      const wRow = wy[j];
      r += rr * wRow;
      g += gg * wRow;
      b += bb * wRow;
      a += aa * wRow;
    }
    const finalA = Math.max(0, Math.min(255, Math.round(a)));
    dst[dstIdx] = Math.max(0, Math.min(finalA, Math.round(r)));
    dst[dstIdx + 1] = Math.max(0, Math.min(finalA, Math.round(g)));
    dst[dstIdx + 2] = Math.max(0, Math.min(finalA, Math.round(b)));
    dst[dstIdx + 3] = finalA;
  }

  private computeFalloff(norm: number, hardness: number): number {
    const plateau = Math.max(0, Math.min(0.88, hardness * 0.84));
    if (norm <= plateau) return 1.0;
    const t = (norm - plateau) / (1.0 - plateau);
    const s = 1 - t * t;
    return s * s;
  }

  /**
   * Applies an incremental liquify step along (cx - dx, cy - dy) -> (cx, cy).
   * Sub-steps large fast drags cleanly across the float displacement field while writing pixels ONCE.
   */
  public applyStep(
    targetRT: RenderTexture | null,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    config: LiquifyConfig,
    selectionMask?: Uint8Array | null
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const { mode, radius, strength, hardness = 0.5, referenceAreaOnly = false } = config;
    if (radius <= 2) return null;

    const moveDist = Math.hypot(dx, dy);
    const isDirectional = mode === 'push' || mode === 'push_left' || mode === 'push_right';
    if (isDirectional && moveDist < 0.05) return null;

    if (!this.layerManager && targetRT) {
      this.activeTargetRT = targetRT;
    }

    const s = Math.max(0.05, Math.min(1.0, strength));
    const steps = isDirectional ? Math.max(1, Math.min(8, Math.ceil(moveDist / Math.max(4, radius * 0.25)))) : 1;
    const stepDx = dx / steps;
    const stepDy = dy / steps;
    const startCx = cx - dx;
    const startCy = cy - dy;

    let touchedMinX = this.canvasWidth;
    let touchedMinY = this.canvasHeight;
    let touchedMaxX = 0;
    let touchedMaxY = 0;

    try {
      for (let st = 1; st <= steps; st++) {
        const scx = isDirectional ? startCx + stepDx * st : cx;
        const scy = isDirectional ? startCy + stepDy * st : cy;
        const minX = Math.max(0, Math.floor(scx - radius));
        const minY = Math.max(0, Math.floor(scy - radius));
        const maxX = Math.min(this.canvasWidth, Math.ceil(scx + radius));
        const maxY = Math.min(this.canvasHeight, Math.ceil(scy + radius));
        const w = maxX - minX;
        const h = maxY - minY;
        if (w <= 0 || h <= 0) continue;

        touchedMinX = Math.min(touchedMinX, minX);
        touchedMinY = Math.min(touchedMinY, minY);
        touchedMaxX = Math.max(touchedMaxX, maxX);
        touchedMaxY = Math.max(touchedMaxY, maxY);

        const nextDisp = new Float32Array(w * h * 2);
        const touchedFlag = new Uint8Array(w * h);
        const rSq = radius * radius;
        const unitLen = Math.hypot(stepDx, stepDy) || 1;
        // Left/Right perpendicular relative to stroke travel vector in Y-down canvas coords
        const leftX = stepDy / unitLen;
        const leftY = -stepDx / unitLen;
        const stepSpeed = Math.min(radius * 0.5, unitLen);

        for (let py = 0; py < h; py++) {
          const gy = minY + py;
          const distY = gy - scy;
          for (let px = 0; px < w; px++) {
            const gx = minX + px;
            const distX = gx - scx;
            const dSq = distX * distX + distY * distY;
            if (dSq >= rSq) continue;

            let maskFactor = 1.0;
            if (selectionMask) {
              maskFactor = getSelectionMaskFactor(selectionMask, gx, gy, this.canvasWidth, this.canvasHeight);
              if (maskFactor <= 0.001) continue;
            }

            const norm = Math.sqrt(dSq) / radius;
            const factor = this.computeFalloff(norm, hardness) * s * maskFactor;

            let vx = 0;
            let vy = 0;
            switch (mode) {
              case 'push': {
                vx = stepDx * factor * 0.9;
                vy = stepDy * factor * 0.9;
                break;
              }
              case 'push_left': {
                vx = leftX * stepSpeed * factor * 0.9;
                vy = leftY * stepSpeed * factor * 0.9;
                break;
              }
              case 'push_right': {
                vx = -leftX * stepSpeed * factor * 0.9;
                vy = -leftY * stepSpeed * factor * 0.9;
                break;
              }
              case 'expand': {
                vx = distX * factor * 0.16;
                vy = distY * factor * 0.16;
                break;
              }
              case 'pinch': {
                vx = -distX * factor * 0.16;
                vy = -distY * factor * 0.16;
                break;
              }
              case 'twirl_left':
              case 'twirl': {
                const theta = -factor * 0.24;
                const cosA = Math.cos(theta);
                const sinA = Math.sin(theta);
                vx = distX * cosA - distY * sinA - distX;
                vy = distX * sinA + distY * cosA - distY;
                break;
              }
              case 'twirl_right': {
                const theta = factor * 0.24;
                const cosA = Math.cos(theta);
                const sinA = Math.sin(theta);
                vx = distX * cosA - distY * sinA - distX;
                vy = distX * sinA + distY * cosA - distY;
                break;
              }
            }

            const [prevDx, prevDy] = this.sampleDisplacement(gx - vx, gy - vy);
            const i = py * w + px;
            nextDisp[i * 2] = prevDx - vx;
            nextDisp[i * 2 + 1] = prevDy - vy;
            touchedFlag[i] = 1;
          }
        }

        // Write updated displacement floats back into sparse displacement tiles
        for (let py = 0; py < h; py++) {
          const gy = minY + py;
          const row = gy >> 8;
          const ly = gy & 255;
          for (let px = 0; px < w; px++) {
            const idx = py * w + px;
            if (!touchedFlag[idx]) continue;
            const gx = minX + px;
            const col = gx >> 8;
            const dTile = this.getOrCreateDispTile(col, row);
            if (!dTile) continue;
            const { tw } = this.tileDim(col, row);
            const di = (ly * tw + (gx & 255)) * 2;
            dTile[di] = nextDisp[idx * 2];
            dTile[di + 1] = nextDisp[idx * 2 + 1];
          }
        }
      }

      if (touchedMaxX <= touchedMinX || touchedMaxY <= touchedMinY) return null;

      // Render deformed box ONCE per frame from untouched original source tiles via Bicubic Catmull-Rom
      const outW = touchedMaxX - touchedMinX;
      const outH = touchedMaxY - touchedMinY;
      const dstPixels = new Uint8Array(outW * outH * 4);
      const refMask = referenceAreaOnly ? { cx, cy, rSq: radius * radius } : null;

      for (let py = 0; py < outH; py++) {
        const gy = touchedMinY + py;
        const row = gy >> 8;
        const ly = gy & 255;
        for (let px = 0; px < outW; px++) {
          const gx = touchedMinX + px;
          const col = gx >> 8;
          const dTile = this.dispTiles.get(`${col}_${row}`);
          let ux = 0;
          let uy = 0;
          if (dTile) {
            const { tw } = this.tileDim(col, row);
            const di = (ly * tw + (gx & 255)) * 2;
            ux = dTile[di];
            uy = dTile[di + 1];
          }
          const outIdx = (py * outW + px) * 4;
          if (ux === 0 && uy === 0) {
            const tap: [number, number, number, number] = [0, 0, 0, 0];
            this.sampleSrcPx(gx, gy, null, tap);
            dstPixels[outIdx] = tap[0];
            dstPixels[outIdx + 1] = tap[1];
            dstPixels[outIdx + 2] = tap[2];
            dstPixels[outIdx + 3] = tap[3];
          } else {
            this.sampleSrcBicubic(gx + ux, gy + uy, refMask, dstPixels, outIdx);
          }
        }
      }

      if (this.layerManager && this.activeLayerId) {
        this.layerManager.writeRegion(this.activeLayerId, touchedMinX, touchedMinY, outW, outH, dstPixels);
      } else if (targetRT) {
        this.tileEngine.writeRegion(targetRT, touchedMinX, touchedMinY, outW, outH, dstPixels);
      }

      return { minX: touchedMinX, minY: touchedMinY, maxX: touchedMaxX, maxY: touchedMaxY };
    } catch (err) {
      console.error('Liquify step error:', err);
      return null;
    }
  }
}
