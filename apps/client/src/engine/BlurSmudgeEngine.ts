import { Renderer, RenderTexture } from 'pixi.js';
import { TileEngine } from './TileEngine';
import { DEFAULT_TILE_SIZE, getSelectionMaskFactor } from '@atelier/shared';
import type { LayerManager } from './LayerManager';

const TS = DEFAULT_TILE_SIZE;

export type SmudgeMode = 'smudge' | 'blend';

export type SparseLayerTarget =
  | RenderTexture
  | { layerManager: LayerManager; layerId: string };

export interface BlurSmudgeConfig {
  radius: number; // 5 to 150px
  strength: number; // 0.1 to 1.0
  smudgeMode?: SmudgeMode;
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Paint a smudge tip carries: premultiplied RGBA per pixel of its (2r+1)² square */
interface SmudgeTip {
  r: number;
  side: number;
  paint: Float32Array;
  /** Last dab centre (canvas px) */
  x: number;
  y: number;
}

export class BlurSmudgeEngine {
  private renderer: Renderer;
  private tileEngine: TileEngine;
  private canvasWidth: number;
  private canvasHeight: number;
  /** One tip per mirrored copy of the stroke (symmetry ruler), for the drag in progress */
  private smudgeTips = new Map<number, SmudgeTip>();
  private blendLastPos = new Map<number, { x: number; y: number }>();
  private strokeTiles = new Map<string, Uint8Array | null>();

  constructor(
    renderer: Renderer,
    tileEngine: TileEngine,
    canvasWidth: number,
    canvasHeight: number
  ) {
    this.renderer = renderer;
    this.tileEngine = tileEngine;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
  }

  public setDimensions(width: number, height: number) {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.resetSmudge();
  }

  private readBox(target: SparseLayerTarget, x: number, y: number, w: number, h: number): Uint8Array {
    if (target instanceof RenderTexture) {
      return this.tileEngine.readRegion(target, x, y, w, h);
    }
    const { layerManager, layerId } = target;
    const out = new Uint8Array(w * h * 4);
    const cols = Math.ceil(this.canvasWidth / TS);
    const rows = Math.ceil(this.canvasHeight / TS);
    const c0 = Math.max(0, Math.floor(x / TS));
    const c1 = Math.min(cols - 1, Math.floor((x + w - 1) / TS));
    const r0 = Math.max(0, Math.floor(y / TS));
    const r1 = Math.min(rows - 1, Math.floor((y + h - 1) / TS));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const tw = Math.min(TS, this.canvasWidth - col * TS);
        const th = Math.min(TS, this.canvasHeight - row * TS);
        const key = `${col}_${row}`;
        let tile = this.strokeTiles.get(key);
        if (tile === undefined) {
          tile = layerManager.readTileSync(layerId, col, row, 'after') ?? null;
          this.strokeTiles.set(key, tile);
        }
        if (!tile) continue;
        const tx = col * TS;
        const ty = row * TS;
        const ix0 = Math.max(x, tx);
        const iy0 = Math.max(y, ty);
        const sw = Math.min(x + w, tx + tw) - ix0;
        const sh = Math.min(y + h, ty + th) - iy0;
        if (sw <= 0 || sh <= 0) continue;
        for (let r = 0; r < sh; r++) {
          const srcOff = ((iy0 - ty + r) * tw + (ix0 - tx)) * 4;
          const dstOff = ((iy0 - y + r) * w + (ix0 - x)) * 4;
          out.set(tile.subarray(srcOff, srcOff + sw * 4), dstOff);
        }
      }
    }
    return out;
  }

  private writeBox(target: SparseLayerTarget, x: number, y: number, w: number, h: number, px: Uint8Array) {
    if (target instanceof RenderTexture) {
      this.tileEngine.writeRegion(target, x, y, w, h, px);
      return;
    }
    const { layerManager, layerId } = target;
    const cols = Math.ceil(this.canvasWidth / TS);
    const rows = Math.ceil(this.canvasHeight / TS);
    const c0 = Math.max(0, Math.floor(x / TS));
    const c1 = Math.min(cols - 1, Math.floor((x + w - 1) / TS));
    const r0 = Math.max(0, Math.floor(y / TS));
    const r1 = Math.min(rows - 1, Math.floor((y + h - 1) / TS));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const tw = Math.min(TS, this.canvasWidth - col * TS);
        const th = Math.min(TS, this.canvasHeight - row * TS);
        const key = `${col}_${row}`;
        let tile = this.strokeTiles.get(key);
        if (tile === undefined) {
          tile = layerManager.readTileSync(layerId, col, row, 'after') ?? null;
        }
        if (!tile) tile = new Uint8Array(tw * th * 4);
        this.strokeTiles.set(key, tile);
        const tx = col * TS;
        const ty = row * TS;
        const ix0 = Math.max(x, tx);
        const iy0 = Math.max(y, ty);
        const sw = Math.min(x + w, tx + tw) - ix0;
        const sh = Math.min(y + h, ty + th) - iy0;
        if (sw <= 0 || sh <= 0) continue;
        for (let r = 0; r < sh; r++) {
          const srcOff = ((iy0 - y + r) * w + (ix0 - x)) * 4;
          const dstOff = ((iy0 - ty + r) * tw + (ix0 - tx)) * 4;
          tile.set(px.subarray(srcOff, srcOff + sw * 4), dstOff);
        }
      }
    }
    layerManager.writeRegion(layerId, x, y, w, h, px);
  }

  /**
   * Applies localized blur over a brush step region
   */
  public applyBlurStep(
    target: SparseLayerTarget,
    cx: number,
    cy: number,
    config: BlurSmudgeConfig,
    selectionMask?: Uint8Array | null
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const { radius, strength } = config;
    if (radius <= 2) return null;

    const minX = Math.max(0, Math.floor(cx - radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxX = Math.min(this.canvasWidth, Math.ceil(cx + radius));
    const maxY = Math.min(this.canvasHeight, Math.ceil(cy + radius));
    const w = maxX - minX;
    const h = maxY - minY;

    if (w <= 1 || h <= 1) return null;

    try {
      const srcPixels = this.readBox(target, minX, minY, w, h);
      const dstPixels = new Uint8Array(srcPixels);

      const rSq = radius * radius;
      const s = Math.max(0.1, Math.min(1.0, strength));
      const blurRadius = Math.max(1, Math.min(8, Math.round(radius * 0.15 * s)));

      // Fast box blur kernel
      for (let py = 0; py < h; py++) {
        const globalY = minY + py;
        const distY = globalY - cy;

        for (let px = 0; px < w; px++) {
          const globalX = minX + px;
          const distX = globalX - cx;
          const dSq = distX * distX + distY * distY;
          if (dSq >= rSq) continue;

          let maskFactor = 1.0;
          if (selectionMask) {
            maskFactor = getSelectionMaskFactor(selectionMask, globalX, globalY, this.canvasWidth, this.canvasHeight);
            if (maskFactor <= 0.001) continue;
          }

          const dist = Math.sqrt(dSq);
          const norm = dist / radius;
          const falloff = (1 - norm * norm) * (1 - norm * norm) * s * maskFactor;
          if (falloff <= 0.01) continue;

          // Box sample
          let sumR = 0, sumG = 0, sumB = 0, sumA = 0, count = 0;
          const bMinY = Math.max(0, py - blurRadius);
          const bMaxY = Math.min(h - 1, py + blurRadius);
          const bMinX = Math.max(0, px - blurRadius);
          const bMaxX = Math.min(w - 1, px + blurRadius);

          for (let by = bMinY; by <= bMaxY; by++) {
            const rowOffset = by * w;
            for (let bx = bMinX; bx <= bMaxX; bx++) {
              const idx = (rowOffset + bx) * 4;
              sumR += srcPixels[idx];
              sumG += srcPixels[idx + 1];
              sumB += srcPixels[idx + 2];
              sumA += srcPixels[idx + 3];
              count++;
            }
          }

          if (count > 0) {
            const avgR = sumR / count;
            const avgG = sumG / count;
            const avgB = sumB / count;
            const avgA = sumA / count;

            const dstIdx = (py * w + px) * 4;
            dstPixels[dstIdx] = Math.round(srcPixels[dstIdx] * (1 - falloff) + avgR * falloff);
            dstPixels[dstIdx + 1] = Math.round(srcPixels[dstIdx + 1] * (1 - falloff) + avgG * falloff);
            dstPixels[dstIdx + 2] = Math.round(srcPixels[dstIdx + 2] * (1 - falloff) + avgB * falloff);
            dstPixels[dstIdx + 3] = Math.round(srcPixels[dstIdx + 3] * (1 - falloff) + avgA * falloff);
          }
        }
      }

      this.writeBox(target, minX, minY, w, h, dstPixels);

      return { minX, minY, maxX, maxY };
    } catch (err) {
      console.warn('Blur step error:', err);
      return null;
    }
  }

  /** Drops the paint tips and cached stroke tiles: call when a drag starts, ends or is cancelled */
  public resetSmudge() {
    this.smudgeTips.clear();
    this.blendLastPos.clear();
    this.strokeTiles.clear();
  }

  /** Executes smudge/blend runs grouped into <=256px chunks to keep read/write regions compact */
  private dispatchDabRuns(
    dabs: Array<[number, number]>,
    r: number,
    runFn: (sub: Array<[number, number]>, rx0: number, ry0: number, rx1: number, ry1: number) => Bounds | null
  ): Bounds | null {
    let bounds: Bounds | null = null;
    for (let i = 0; i < dabs.length; ) {
      let [minCx, minCy] = dabs[i];
      let maxCx = minCx;
      let maxCy = minCy;
      let j = i + 1;
      for (; j < dabs.length; j++) {
        const [x, y] = dabs[j];
        if (Math.max(maxCx, x) - Math.min(minCx, x) > 256 || Math.max(maxCy, y) - Math.min(minCy, y) > 256) break;
        minCx = Math.min(minCx, x);
        maxCx = Math.max(maxCx, x);
        minCy = Math.min(minCy, y);
        maxCy = Math.max(maxCy, y);
      }
      const b = runFn(dabs.slice(i, j), minCx - r, minCy - r, maxCx + r + 1, maxCy + r + 1);
      if (b) {
        bounds = bounds
          ? { minX: Math.min(bounds.minX, b.minX), minY: Math.min(bounds.minY, b.minY), maxX: Math.max(bounds.maxX, b.maxX), maxY: Math.max(bounds.maxY, b.maxY) }
          : b;
      }
      i = j;
    }
    return bounds;
  }

  /**
   * Two-mode smudge brush:
   * - `'smudge'`: Finger-tip smear carrying pigment along the drag vector
   * - `'blend'`: In-place painterly color mixing using a symmetric centered kernel (zero spatial drag)
   */
  public applySmudgeSegment(
    target: SparseLayerTarget,
    tipId: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    config: BlurSmudgeConfig,
    selectionMask?: Uint8Array | null
  ): Bounds | null {
    const r = Math.round(config.radius);
    if (r <= 2 || this.canvasWidth <= 0 || this.canvasHeight <= 0) return null;
    const s = Math.max(0.05, Math.min(1, config.strength));
    const mode: SmudgeMode = config.smudgeMode === 'blend' ? 'blend' : 'smudge';

    try {
      if (mode === 'blend') {
        const last = this.blendLastPos.get(tipId) ?? { x: fromX, y: fromY };
        const spacing = Math.max(2, r * 0.25);
        const dabs: Array<[number, number]> = [];
        let dist = Math.hypot(toX - last.x, toY - last.y);
        if (!this.blendLastPos.has(tipId)) {
          dabs.push([Math.round(toX), Math.round(toY)]);
          this.blendLastPos.set(tipId, { x: toX, y: toY });
        } else {
          let curX = last.x;
          let curY = last.y;
          while (dist >= spacing) {
            const t = spacing / dist;
            curX += (toX - curX) * t;
            curY += (toY - curY) * t;
            dabs.push([Math.round(curX), Math.round(curY)]);
            dist -= spacing;
          }
          if (!dabs.length && dist >= 1) {
            curX = toX;
            curY = toY;
            dabs.push([Math.round(toX), Math.round(toY)]);
          }
          this.blendLastPos.set(tipId, { x: curX, y: curY });
        }
        return this.dispatchDabRuns(dabs, r, (sub, rx0, ry0, rx1, ry1) =>
          this.blendRun(target, r, sub, rx0, ry0, rx1, ry1, s, selectionMask)
        );
      }

      let tip = this.smudgeTips.get(tipId);
      if (!tip || tip.r !== r) {
        tip = this.createTip(target, r, fromX, fromY);
        this.smudgeTips.set(tipId, tip);
      }

      const spacing = Math.max(1, r * 0.12);
      const dabs: Array<[number, number]> = [];
      let dist = Math.hypot(toX - tip.x, toY - tip.y);
      while (dist >= spacing) {
        const t = spacing / dist;
        tip.x += (toX - tip.x) * t;
        tip.y += (toY - tip.y) * t;
        dabs.push([Math.round(tip.x), Math.round(tip.y)]);
        dist -= spacing;
      }

      return this.dispatchDabRuns(dabs, r, (sub, rx0, ry0, rx1, ry1) =>
        this.smudgeRun(target, tip!, sub, rx0, ry0, rx1, ry1, s, selectionMask)
      );
    } catch (err) {
      console.warn('Smudge step error:', err);
      return null;
    }
  }

  /** Loads a new tip with the pixels under it. Past the canvas edge it takes the nearest edge pixel, so smudging inwards from the edge does not erase. */
  private createTip(target: SparseLayerTarget, r: number, x: number, y: number): SmudgeTip {
    const side = 2 * r + 1;
    const paint = new Float32Array(side * side * 4);
    const cx = Math.round(x);
    const cy = Math.round(y);
    const W = this.canvasWidth;
    const H = this.canvasHeight;
    const x0 = Math.min(W - 1, Math.max(0, cx - r));
    const y0 = Math.min(H - 1, Math.max(0, cy - r));
    const x1 = Math.min(W, Math.max(x0 + 1, cx + r + 1));
    const y1 = Math.min(H, Math.max(y0 + 1, cy + r + 1));
    const w = x1 - x0;
    const h = y1 - y0;
    const px = this.readBox(target, x0, y0, w, h);
    for (let oy = 0; oy < side; oy++) {
      const ry = Math.min(h - 1, Math.max(0, cy - r + oy - y0));
      for (let ox = 0; ox < side; ox++) {
        const rx = Math.min(w - 1, Math.max(0, cx - r + ox - x0));
        const si = (ry * w + rx) * 4;
        const di = (oy * side + ox) * 4;
        paint[di] = px[si];
        paint[di + 1] = px[si + 1];
        paint[di + 2] = px[si + 2];
        paint[di + 3] = px[si + 3];
      }
    }
    return { r, side, paint, x, y };
  }

  /** Symmetric in-place color mixing (two separable box passes = tent kernel, zero spatial drift). */
  private blendRun(
    target: SparseLayerTarget,
    r: number,
    dabs: Array<[number, number]>,
    rx0: number,
    ry0: number,
    rx1: number,
    ry1: number,
    s: number,
    selectionMask?: Uint8Array | null
  ): Bounds | null {
    const W = this.canvasWidth;
    const H = this.canvasHeight;
    const minX = Math.max(0, rx0);
    const minY = Math.max(0, ry0);
    const maxX = Math.min(W, rx1);
    const maxY = Math.min(H, ry1);
    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) return null;

    const k = Math.max(2, Math.min(18, Math.round(2 + r * 0.28 * (0.35 + 0.65 * s))));
    const k1 = Math.max(1, Math.round(k * 0.65));
    const pad = k1 * 2;
    const px0 = Math.max(0, minX - pad);
    const py0 = Math.max(0, minY - pad);
    const px1 = Math.min(W, maxX + pad);
    const py1 = Math.min(H, maxY + pad);
    const pw = px1 - px0;
    const ph = py1 - py0;

    const src = this.readBox(target, px0, py0, pw, ph);
    const tmpA = new Float32Array(pw * ph * 4);
    const tmpB = new Float32Array(pw * ph * 4);
    for (let i = 0; i < src.length; i++) tmpA[i] = src[i];

    const boxPass = (inBuf: Float32Array, outBuf: Float32Array, radius: number) => {
      const horiz = new Float32Array(pw * ph * 4);
      const win = radius * 2 + 1;
      for (let y = 0; y < ph; y++) {
        const rowOff = y * pw * 4;
        let rS = 0, gS = 0, bS = 0, aS = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = Math.min(pw - 1, Math.max(0, dx)) * 4 + rowOff;
          rS += inBuf[sx]; gS += inBuf[sx + 1]; bS += inBuf[sx + 2]; aS += inBuf[sx + 3];
        }
        for (let x = 0; x < pw; x++) {
          const di = rowOff + x * 4;
          horiz[di] = rS / win; horiz[di + 1] = gS / win; horiz[di + 2] = bS / win; horiz[di + 3] = aS / win;
          const remX = Math.max(0, x - radius) * 4 + rowOff;
          const addX = Math.min(pw - 1, x + radius + 1) * 4 + rowOff;
          rS += inBuf[addX] - inBuf[remX];
          gS += inBuf[addX + 1] - inBuf[remX + 1];
          bS += inBuf[addX + 2] - inBuf[remX + 2];
          aS += inBuf[addX + 3] - inBuf[remX + 3];
        }
      }
      for (let x = 0; x < pw; x++) {
        let rS = 0, gS = 0, bS = 0, aS = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const sy = (Math.min(ph - 1, Math.max(0, dy)) * pw + x) * 4;
          rS += horiz[sy]; gS += horiz[sy + 1]; bS += horiz[sy + 2]; aS += horiz[sy + 3];
        }
        for (let y = 0; y < ph; y++) {
          const di = (y * pw + x) * 4;
          outBuf[di] = rS / win; outBuf[di + 1] = gS / win; outBuf[di + 2] = bS / win; outBuf[di + 3] = aS / win;
          const remY = (Math.max(0, y - radius) * pw + x) * 4;
          const addY = (Math.min(ph - 1, y + radius + 1) * pw + x) * 4;
          rS += horiz[addY] - horiz[remY];
          gS += horiz[addY + 1] - horiz[remY + 1];
          bS += horiz[addY + 2] - horiz[remY + 2];
          aS += horiz[addY + 3] - horiz[remY + 3];
        }
      }
    };

    boxPass(tmpA, tmpB, k1);
    boxPass(tmpB, tmpA, k1);

    const keep = new Float32Array(w * h);
    keep.fill(1);
    const rSq = r * r;
    const baseStrength = 0.14 + 0.44 * s;
    for (const [cx, cy] of dabs) {
      for (let oy = -r; oy <= r; oy++) {
        const gy = cy + oy;
        if (gy < minY || gy >= maxY) continue;
        for (let ox = -r; ox <= r; ox++) {
          const gx = cx + ox;
          if (gx < minX || gx >= maxX) continue;
          const dSq = ox * ox + oy * oy;
          if (dSq >= rSq) continue;
          const n = 1 - dSq / rSq;
          const dabFactor = n * n * baseStrength;
          const idx = (gy - minY) * w + (gx - minX);
          keep[idx] *= 1 - dabFactor;
        }
      }
    }

    const out = new Uint8Array(w * h * 4);
    for (let gy = minY; gy < maxY; gy++) {
      for (let gx = minX; gx < maxX; gx++) {
        const idx = (gy - minY) * w + (gx - minX);
        const si = ((gy - py0) * pw + (gx - px0)) * 4;
        const oi = idx * 4;
        let alphaMix = 1 - keep[idx];
        if (alphaMix > 0 && selectionMask) {
          alphaMix *= getSelectionMaskFactor(selectionMask, gx, gy, W, H);
        }
        if (alphaMix <= 0.001) {
          out[oi] = src[si];
          out[oi + 1] = src[si + 1];
          out[oi + 2] = src[si + 2];
          out[oi + 3] = src[si + 3];
        } else {
          out[oi] = Math.round(src[si] + (tmpA[si] - src[si]) * alphaMix);
          out[oi + 1] = Math.round(src[si + 1] + (tmpA[si + 1] - src[si + 1]) * alphaMix);
          out[oi + 2] = Math.round(src[si + 2] + (tmpA[si + 2] - src[si + 2]) * alphaMix);
          out[oi + 3] = Math.round(src[si + 3] + (tmpA[si + 3] - src[si + 3]) * alphaMix);
        }
      }
    }

    this.writeBox(target, minX, minY, w, h, out);
    return { minX, minY, maxX, maxY };
  }

  /** Lays down `dabs` (integer centres) inside one region read: deposit the carried paint, then pick up a little of what was underneath */
  private smudgeRun(
    target: SparseLayerTarget,
    tip: SmudgeTip,
    dabs: Array<[number, number]>,
    rx0: number,
    ry0: number,
    rx1: number,
    ry1: number,
    s: number,
    selectionMask?: Uint8Array | null
  ): Bounds | null {
    const W = this.canvasWidth;
    const H = this.canvasHeight;
    const minX = Math.max(0, rx0);
    const minY = Math.max(0, ry0);
    const maxX = Math.min(W, rx1);
    const maxY = Math.min(H, ry1);
    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) return null; // the whole run is past the canvas edge

    const px = this.readBox(target, minX, minY, w, h);
    const { r, side, paint } = tip;
    const rSq = r * r;
    // Per dab, at the tip's centre. Dabs overlap ~8 times per radius, so a full deposit would
    // re-lay the carried paint ahead of itself and never fade; these leave a smear that fades
    // over ~6 radii at full strength and ~2 at half (dab spacing is a fixed share of the radius,
    // so the smear scales with the brush)
    const deposit = 0.1 + 0.3 * s;
    // How fast the carried paint turns into what is underneath
    const pickup = 0.1 + 0.2 * (1 - s);

    for (const [cx, cy] of dabs) {
      for (let oy = -r; oy <= r; oy++) {
        const gy = cy + oy;
        if (gy < minY || gy >= maxY) continue;
        for (let ox = -r; ox <= r; ox++) {
          const gx = cx + ox;
          if (gx < minX || gx >= maxX) continue;
          const dSq = ox * ox + oy * oy;
          if (dSq >= rSq) continue;
          const n = 1 - dSq / rSq;
          let f = n * n * deposit;
          if (selectionMask) f *= getSelectionMaskFactor(selectionMask, gx, gy, W, H);
          const pi = ((gy - minY) * w + (gx - minX)) * 4;
          const bi = ((oy + r) * side + (ox + r)) * 4;
          for (let c = 0; c < 4; c++) {
            const under = px[pi + c];
            const carried = paint[bi + c];
            px[pi + c] = Math.round(under + (carried - under) * f);
            paint[bi + c] = carried + (under - carried) * pickup;
          }
        }
      }
    }

    this.writeBox(target, minX, minY, w, h, px);
    return { minX, minY, maxX, maxY };
  }
}
