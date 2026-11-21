import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import type { FilterValues } from '@atelier/shared';
import { PLUGIN_LIMITS } from './pluginApi';

export const PLUGIN_FILTER_TILE_SIZE = 256;

let cachedEnginePromise: Promise<QuickJSWASMModule> | null = null;

function getEngine(): Promise<QuickJSWASMModule> {
  if (!cachedEnginePromise) {
    cachedEnginePromise = newQuickJSWASMModuleFromVariant(variant);
  }
  return cachedEnginePromise;
}

export interface RunPluginFilterOptions {
  script: string;
  filterId: string;
  /** Premultiplied RGBA bytes (LayerManager format), length = width * height * 4 */
  pixels: Uint8Array;
  width: number;
  height: number;
  params: FilterValues;
  /** Optional selection mask (1 byte per pixel, 0..255) */
  mask?: Uint8Array | null;
  /** Tile halo padding in pixels (clamped to 0..32) */
  tilePadding?: number;
  /** Downscale factor (>= 2) for quick draft preview on large layers */
  draft?: number;
  /** True during interactive preview (3000ms budget), false when applying (15000ms budget) */
  previewOnly?: boolean;
  tileCpuLimitMs?: number;
  totalCpuLimitMs?: number;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  /** Optional cancellation probe polled between tiles and inside the interrupt handler */
  isCancelled?: () => boolean;
}

export interface RunPluginFilterResult {
  /** Premultiplied RGBA output, or null when cancelled */
  output: Uint8Array<ArrayBuffer> | null;
  cancelled: boolean;
  cpuUsedMs: number;
  tilesProcessed: number;
}

function clampInt(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function formatVmError(vm: { dump: (handle: QuickJSHandle) => unknown }, errHandle: QuickJSHandle): string {
  try {
    const dumped = vm.dump(errHandle);
    if (typeof dumped === 'string') return dumped;
    if (dumped && typeof dumped === 'object') {
      const obj = dumped as { message?: unknown; name?: unknown };
      if (typeof obj.message === 'string' && obj.message.length > 0) {
        return typeof obj.name === 'string' && obj.name.length > 0 ? `${obj.name}: ${obj.message}` : obj.message;
      }
    }
  } catch {
    // Fallback below
  }
  return 'Plugin filter execution failed.';
}

function downscalePremul(pixels: Uint8Array, width: number, height: number, factor: number) {
  const sw = Math.max(1, Math.floor(width / factor));
  const sh = Math.max(1, Math.floor(height / factor));
  const out = new Uint8Array(sw * sh * 4);
  for (let sy = 0; sy < sh; sy++) {
    const y0 = sy * factor;
    const y1 = Math.min(height, y0 + factor);
    for (let sx = 0; sx < sw; sx++) {
      const x0 = sx * factor;
      const x1 = Math.min(width, x0 + factor);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        let row = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, row += 4) {
          r += pixels[row];
          g += pixels[row + 1];
          b += pixels[row + 2];
          a += pixels[row + 3];
          count++;
        }
      }
      const dst = (sy * sw + sx) * 4;
      out[dst] = Math.round(r / count);
      out[dst + 1] = Math.round(g / count);
      out[dst + 2] = Math.round(b / count);
      out[dst + 3] = Math.round(a / count);
    }
  }
  return { pixels: out, width: sw, height: sh };
}

function upscalePremul(
  small: Uint8Array,
  sw: number,
  sh: number,
  width: number,
  height: number,
  factor: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(width * height * 4));
  for (let y = 0; y < height; y++) {
    const fy = (y + 0.5) / factor - 0.5;
    const y0 = clampInt(Math.floor(fy), 0, sh - 1);
    const y1 = clampInt(y0 + 1, 0, sh - 1);
    const wy = clampInt(Math.round((fy - y0) * 256), 0, 256);
    const iy = 256 - wy;
    for (let x = 0; x < width; x++) {
      const fx = (x + 0.5) / factor - 0.5;
      const x0 = clampInt(Math.floor(fx), 0, sw - 1);
      const x1 = clampInt(x0 + 1, 0, sw - 1);
      const wx = clampInt(Math.round((fx - x0) * 256), 0, 256);
      const ix = 256 - wx;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const dst = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = small[i00 + c] * ix + small[i10 + c] * wx;
        const bot = small[i01 + c] * ix + small[i11 + c] * wx;
        out[dst + c] = (top * iy + bot * wy + 32768) >> 16;
      }
    }
  }
  return out;
}

/**
 * Extracts a padded tile in straight RGBA (and optional clamped selection mask).
 * Out-of-bounds halo pixels are filled by clamping coordinates to [0, width-1] / [0, height-1].
 */
export function extractPaddedStraightTile(
  pixels: Uint8Array,
  mask: Uint8Array | null | undefined,
  width: number,
  height: number,
  x0: number,
  y0: number,
  coreW: number,
  coreH: number,
  padding: number,
): {
  rgba: Uint8Array<ArrayBuffer>;
  selection: Uint8Array<ArrayBuffer> | null;
  extW: number;
  extH: number;
  padLeft: number;
  padTop: number;
  padRight: number;
  padBottom: number;
} {
  const padLeft = padding;
  const padTop = padding;
  const padRight = padding;
  const padBottom = padding;
  const extW = coreW + padLeft + padRight;
  const extH = coreH + padTop + padBottom;
  const rgba = new Uint8Array(new ArrayBuffer(extW * extH * 4));
  const selection = mask ? new Uint8Array(new ArrayBuffer(extW * extH)) : null;

  for (let ly = 0; ly < extH; ly++) {
    const sy = clampInt(y0 - padTop + ly, 0, height - 1);
    const srcRow = sy * width;
    const dstRow = ly * extW;
    for (let lx = 0; lx < extW; lx++) {
      const sx = clampInt(x0 - padLeft + lx, 0, width - 1);
      const sp = srcRow + sx;
      const dp = dstRow + lx;
      const si = sp * 4;
      const di = dp * 4;
      const a = pixels[si + 3];
      if (a === 0) {
        rgba[di] = 0;
        rgba[di + 1] = 0;
        rgba[di + 2] = 0;
        rgba[di + 3] = 0;
      } else if (a === 255) {
        rgba[di] = pixels[si];
        rgba[di + 1] = pixels[si + 1];
        rgba[di + 2] = pixels[si + 2];
        rgba[di + 3] = 255;
      } else {
        rgba[di] = Math.min(255, Math.round((pixels[si] * 255) / a));
        rgba[di + 1] = Math.min(255, Math.round((pixels[si + 1] * 255) / a));
        rgba[di + 2] = Math.min(255, Math.round((pixels[si + 2] * 255) / a));
        rgba[di + 3] = a;
      }
      if (selection && mask) {
        selection[dp] = mask[sp];
      }
    }
  }

  return { rgba, selection, extW, extH, padLeft, padTop, padRight, padBottom };
}

function writeCoreStraightToPremul(
  outPixels: Uint8Array,
  canvasWidth: number,
  x0: number,
  y0: number,
  coreW: number,
  coreH: number,
  tileStraight: Uint8Array,
  extW: number,
  padLeft: number,
  padTop: number,
): void {
  for (let cy = 0; cy < coreH; cy++) {
    const srcRow = (cy + padTop) * extW + padLeft;
    const dstRow = (y0 + cy) * canvasWidth + x0;
    for (let cx = 0; cx < coreW; cx++) {
      const si = (srcRow + cx) * 4;
      const di = (dstRow + cx) * 4;
      const a = tileStraight[si + 3];
      if (a === 0) {
        outPixels[di] = 0;
        outPixels[di + 1] = 0;
        outPixels[di + 2] = 0;
        outPixels[di + 3] = 0;
      } else if (a === 255) {
        outPixels[di] = tileStraight[si];
        outPixels[di + 1] = tileStraight[si + 1];
        outPixels[di + 2] = tileStraight[si + 2];
        outPixels[di + 3] = 255;
      } else {
        outPixels[di] = ((tileStraight[si] * a + 127) / 255) | 0;
        outPixels[di + 1] = ((tileStraight[si + 1] * a + 127) / 255) | 0;
        outPixels[di + 2] = ((tileStraight[si + 2] * a + 127) / 255) | 0;
        outPixels[di + 3] = a;
      }
    }
  }
}

function blendPremulWithSelection(
  original: Uint8Array,
  output: Uint8Array,
  mask: Uint8Array | null | undefined,
): void {
  if (!mask) return;
  for (let i = 0, p = 0; i < output.length; i += 4, p++) {
    const m = mask[p];
    if (m === 0) {
      output[i] = original[i];
      output[i + 1] = original[i + 1];
      output[i + 2] = original[i + 2];
      output[i + 3] = original[i + 3];
    } else if (m !== 255) {
      const keep = 255 - m;
      output[i] = ((original[i] * keep + output[i] * m + 127) / 255) | 0;
      output[i + 1] = ((original[i + 1] * keep + output[i + 1] * m + 127) / 255) | 0;
      output[i + 2] = ((original[i + 2] * keep + output[i + 2] * m + 127) / 255) | 0;
      output[i + 3] = ((original[i + 3] * keep + output[i + 3] * m + 127) / 255) | 0;
    }
  }
}

async function runTiledFilterPass(
  script: string,
  filterId: string,
  pixels: Uint8Array,
  width: number,
  height: number,
  params: FilterValues,
  mask: Uint8Array | null | undefined,
  padding: number,
  tileCpuLimitMs: number,
  totalCpuLimitMs: number,
  memoryLimitBytes: number,
  maxStackSizeBytes: number,
  isCancelled?: () => boolean,
): Promise<RunPluginFilterResult> {
  if (width <= 0 || height <= 0 || pixels.byteLength !== width * height * 4) {
    throw new Error('Invalid pixel buffer dimensions for plugin filter.');
  }

  const engine = await getEngine();
  const runtime = engine.newRuntime();
  let totalCpuMs = 0;
  let tilesProcessed = 0;
  let sliceStart = 0;
  let inSlice = false;
  let abortKind: null | 'cancelled' | 'tile-timeout' | 'total-timeout' = null;

  try {
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(maxStackSizeBytes);
    runtime.setInterruptHandler(() => {
      if (isCancelled?.()) {
        abortKind = 'cancelled';
        return true;
      }
      if (!inSlice) return false;
      const sliceElapsed = performance.now() - sliceStart;
      if (sliceElapsed > tileCpuLimitMs) {
        abortKind = 'tile-timeout';
        return true;
      }
      if (totalCpuMs + sliceElapsed > totalCpuLimitMs) {
        abortKind = 'total-timeout';
        return true;
      }
      return false;
    });

    const vm = runtime.newContext();
    try {
      const bootstrap = `"use strict";
${script}
if (typeof onFilter !== 'function') {
  throw new Error('Plugin script must define onFilter(filterId, tile, params).');
}
globalThis.__luminaRunTile = function(filterId, metaJson, rgbaAb, selAb, paramsJson) {
  const meta = JSON.parse(metaJson);
  const params = JSON.parse(paramsJson);
  const rgba = new Uint8Array(rgbaAb);
  const tile = {
    x: meta.x,
    y: meta.y,
    width: meta.width,
    height: meta.height,
    padLeft: meta.padLeft,
    padTop: meta.padTop,
    padRight: meta.padRight,
    padBottom: meta.padBottom,
    canvasWidth: meta.canvasWidth,
    canvasHeight: meta.canvasHeight,
    rgba: rgba,
  };
  if (selAb instanceof ArrayBuffer) {
    tile.selection = new Uint8Array(selAb);
  }
  const result = onFilter(filterId, tile, params);
  const out = result === undefined || result === null ? rgba : result;
  if (!(out instanceof Uint8Array) || out.byteLength !== rgba.byteLength) {
    throw new Error('onFilter must mutate tile.rgba or return a Uint8Array with matching byteLength.');
  }
  if (out.byteOffset === 0 && out.byteLength === out.buffer.byteLength) {
    return out.buffer;
  }
  const copy = new Uint8Array(out.byteLength);
  copy.set(out);
  return copy.buffer;
};`;

      sliceStart = performance.now();
      inSlice = true;
      const evalRes = vm.evalCode(bootstrap, 'plugin-filter.js', { type: 'global' });
      totalCpuMs += Math.max(0, performance.now() - sliceStart);
      inSlice = false;

      if (evalRes.error) {
        const msg = formatVmError(vm, evalRes.error);
        evalRes.error.dispose();
        if (abortKind === 'cancelled') {
          return { output: null, cancelled: true, cpuUsedMs: totalCpuMs, tilesProcessed };
        }
        if (abortKind === 'tile-timeout' || abortKind === 'total-timeout') {
          throw new Error(`Plugin filter exceeded CPU time limit during initialization (${Math.round(totalCpuMs)}ms).`);
        }
        throw new Error(msg);
      }
      evalRes.value.dispose();

      const runnerH = vm.getProp(vm.global, '__luminaRunTile');
      const filterIdH = vm.newString(filterId);
      const paramsJsonH = vm.newString(JSON.stringify(params ?? {}));
      const outPixels = new Uint8Array(new ArrayBuffer(width * height * 4));

      try {
        for (let y0 = 0; y0 < height; y0 += PLUGIN_FILTER_TILE_SIZE) {
          const coreH = Math.min(PLUGIN_FILTER_TILE_SIZE, height - y0);
          for (let x0 = 0; x0 < width; x0 += PLUGIN_FILTER_TILE_SIZE) {
            if (isCancelled?.()) {
              return { output: null, cancelled: true, cpuUsedMs: totalCpuMs, tilesProcessed };
            }
            if (totalCpuMs >= totalCpuLimitMs) {
              throw new Error(`Plugin filter exceeded total CPU limit (${totalCpuLimitMs}ms).`);
            }
            const coreW = Math.min(PLUGIN_FILTER_TILE_SIZE, width - x0);
            const tile = extractPaddedStraightTile(pixels, mask, width, height, x0, y0, coreW, coreH, padding);
            const metaJson = JSON.stringify({
              x: x0,
              y: y0,
              width: tile.extW,
              height: tile.extH,
              padLeft: tile.padLeft,
              padTop: tile.padTop,
              padRight: tile.padRight,
              padBottom: tile.padBottom,
              canvasWidth: width,
              canvasHeight: height,
            });
            const metaH = vm.newString(metaJson);
            const rgbaH = vm.newArrayBuffer(tile.rgba.buffer);
            const selH = tile.selection ? vm.newArrayBuffer(tile.selection.buffer) : vm.undefined;

            sliceStart = performance.now();
            inSlice = true;
            const callRes = vm.callFunction(runnerH, vm.undefined, filterIdH, metaH, rgbaH, selH, paramsJsonH);
            totalCpuMs += Math.max(0, performance.now() - sliceStart);
            inSlice = false;

            metaH.dispose();
            rgbaH.dispose();
            if (tile.selection) selH.dispose();

            if (callRes.error) {
              const msg = formatVmError(vm, callRes.error);
              callRes.error.dispose();
              if (abortKind === 'cancelled' || isCancelled?.()) {
                return { output: null, cancelled: true, cpuUsedMs: totalCpuMs, tilesProcessed };
              }
              if (abortKind === 'tile-timeout') {
                throw new Error(`Plugin filter tile (${x0},${y0}) exceeded ${tileCpuLimitMs}ms CPU limit.`);
              }
              if (abortKind === 'total-timeout') {
                throw new Error(`Plugin filter exceeded total ${totalCpuLimitMs}ms CPU limit.`);
              }
              throw new Error(msg);
            }

            try {
              const abLifetime = vm.getArrayBuffer(callRes.value);
              try {
                const view = abLifetime.value;
                if (view.byteLength !== tile.rgba.byteLength) {
                  throw new Error('Plugin filter returned pixel data with mismatched byte length.');
                }
                writeCoreStraightToPremul(
                  outPixels,
                  width,
                  x0,
                  y0,
                  coreW,
                  coreH,
                  view,
                  tile.extW,
                  tile.padLeft,
                  tile.padTop,
                );
              } finally {
                abLifetime.dispose();
              }
            } finally {
              callRes.value.dispose();
            }

            tilesProcessed++;
          }
        }
      } finally {
        paramsJsonH.dispose();
        filterIdH.dispose();
        runnerH.dispose();
      }

      blendPremulWithSelection(pixels, outPixels, mask);
      return { output: outPixels, cancelled: false, cpuUsedMs: totalCpuMs, tilesProcessed };
    } finally {
      vm.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

export async function runPluginFilterTiled(options: RunPluginFilterOptions): Promise<RunPluginFilterResult> {
  const {
    script,
    filterId,
    pixels,
    width,
    height,
    params,
    mask,
    previewOnly = false,
    isCancelled,
  } = options;
  const padding = clampInt(Math.round(options.tilePadding ?? 0), 0, PLUGIN_LIMITS.maxFilterTilePadding);
  const tileCpuLimitMs = options.tileCpuLimitMs ?? PLUGIN_LIMITS.filterTileCpuLimitMs;
  const totalCpuLimitMs =
    options.totalCpuLimitMs ?? (previewOnly ? PLUGIN_LIMITS.filterPreviewTotalCpuMs : PLUGIN_LIMITS.filterApplyTotalCpuMs);
  const memoryLimitBytes = options.memoryLimitBytes ?? PLUGIN_LIMITS.memoryLimitDesktopBytes;
  const maxStackSizeBytes = options.maxStackSizeBytes ?? PLUGIN_LIMITS.maxStackSizeBytes;

  const draftFactor = Math.floor(options.draft ?? 0);
  if (draftFactor >= 2 && width >= draftFactor * 2 && height >= draftFactor * 2) {
    const small = downscalePremul(pixels, width, height, draftFactor);
    const scaledPadding = clampInt(Math.ceil(padding / draftFactor), 0, PLUGIN_LIMITS.maxFilterTilePadding);
    const pass = await runTiledFilterPass(
      script,
      filterId,
      small.pixels,
      small.width,
      small.height,
      params,
      null,
      scaledPadding,
      tileCpuLimitMs,
      totalCpuLimitMs,
      memoryLimitBytes,
      maxStackSizeBytes,
      isCancelled,
    );
    if (pass.cancelled || !pass.output) return pass;
    const output = upscalePremul(pass.output, small.width, small.height, width, height, draftFactor);
    blendPremulWithSelection(pixels, output, mask);
    return {
      output,
      cancelled: false,
      cpuUsedMs: pass.cpuUsedMs,
      tilesProcessed: pass.tilesProcessed,
    };
  }

  return runTiledFilterPass(
    script,
    filterId,
    pixels,
    width,
    height,
    params,
    mask,
    padding,
    tileCpuLimitMs,
    totalCpuLimitMs,
    memoryLimitBytes,
    maxStackSizeBytes,
    isCancelled,
  );
}
