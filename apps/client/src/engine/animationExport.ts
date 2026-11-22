import type { Affine2D } from '@atelier/shared';
import { parseTimecode } from './AnimationEngine';

/**
 * Output crop region in canvas pixel coordinates (Phase D3).
 * When no camera frame is active (pre-E1 or camera disabled), null means full canvas.
 */
export interface ExportCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportDimensions {
  width: number;
  height: number;
}

export type SequenceFrameMode = 'every-frame' | 'distinct-frames';
export type ExportRangeMode = 'all' | 'playback' | 'custom';
export type CelExportFormat = 'png' | 'tga' | 'bmp';
export type CelNamingMode = 'folder-cel' | 'cel-only';

export interface SequenceNamingOptions {
  prefix: string;
  suffix: string;
  separator: string;
  startNumber: number;
  zeroPad: number;
  extension?: 'png';
}

export interface CelNamingOptions {
  mode: CelNamingMode;
  prefix: string;
  suffix: string;
  separator: string;
  extension: CelExportFormat;
}

export interface PlannedSequenceFrame {
  /** 0-based index in the exported image sequence */
  outputIndex: number;
  /** Timeline frame index to render (same sourceTime across held copies allows caching) */
  sourceTime: number;
  /** Actual timeline frame represented by this exported file */
  timelineFrame: number;
  /** Number of logical frames represented (always 1 in every-frame mode) */
  hold: number;
}

export interface ResolvedFrameRange {
  start: number;
  end: number;
  frameCount: number;
  valid: boolean;
}

export interface LineColorRule {
  id: string;
  hex: string;
  enabled: boolean;
  /** Sensitivity 0..255 (higher captures fainter anti-aliased strokes) */
  threshold: number;
}

export interface BinarizeLineArtOptions {
  enabled: boolean;
  rules: LineColorRule[];
  background: 'white' | 'transparent';
}

export const DEFAULT_LINE_COLOR_RULES: ReadonlyArray<LineColorRule> = [
  { id: 'black', hex: '#000000', enabled: true, threshold: 180 },
  { id: 'red', hex: '#FF0000', enabled: false, threshold: 160 },
  { id: 'green', hex: '#00FF00', enabled: false, threshold: 160 },
  { id: 'blue', hex: '#0000FF', enabled: false, threshold: 160 },
];

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_EXPORT_DIM = 8192;

/**
 * D3: Resolves the effective output region.
 * Without a camera frame, returns the full canvas bounds; with a camera frame, returns its rounded bounds.
 */
export function resolveExportRegion(
  canvasWidth: number,
  canvasHeight: number,
  cameraRect?: ExportCropRect | null
): ExportCropRect {
  const fullW = Math.max(1, Math.round(canvasWidth) || 1);
  const fullH = Math.max(1, Math.round(canvasHeight) || 1);
  if (!cameraRect) {
    return { x: 0, y: 0, width: fullW, height: fullH };
  }
  const width = Math.max(1, Math.min(MAX_EXPORT_DIM, Math.round(cameraRect.width) || fullW));
  const height = Math.max(1, Math.min(MAX_EXPORT_DIM, Math.round(cameraRect.height) || fullH));
  const x = Math.round(cameraRect.x) || 0;
  const y = Math.round(cameraRect.y) || 0;
  return { x, y, width, height };
}

/**
 * Computes scaled output dimensions while preserving aspect ratio when requested.
 */
export function computeScaledExportDimensions(
  srcWidth: number,
  srcHeight: number,
  opts?: {
    scalePercent?: number;
    targetWidth?: number;
    targetHeight?: number;
    lockAspect?: boolean;
  }
): ExportDimensions {
  const baseW = Math.max(1, Math.round(srcWidth) || 1);
  const baseH = Math.max(1, Math.round(srcHeight) || 1);
  if (!opts) return { width: baseW, height: baseH };

  const clampDim = (v: number) => Math.max(1, Math.min(MAX_EXPORT_DIM, Math.round(v) || 1));
  const lockAspect = opts.lockAspect !== false;

  if (typeof opts.scalePercent === 'number' && Number.isFinite(opts.scalePercent)) {
    const scale = Math.max(1, Math.min(400, opts.scalePercent)) / 100;
    return {
      width: clampDim(baseW * scale),
      height: clampDim(baseH * scale),
    };
  }

  const hasW = typeof opts.targetWidth === 'number' && Number.isFinite(opts.targetWidth) && opts.targetWidth > 0;
  const hasH = typeof opts.targetHeight === 'number' && Number.isFinite(opts.targetHeight) && opts.targetHeight > 0;

  if (hasW && !hasH) {
    const w = clampDim(opts.targetWidth!);
    return { width: w, height: lockAspect ? clampDim((w * baseH) / baseW) : baseH };
  }
  if (!hasW && hasH) {
    const h = clampDim(opts.targetHeight!);
    return { width: lockAspect ? clampDim((h * baseW) / baseH) : baseW, height: h };
  }
  if (hasW && hasH) {
    const w = clampDim(opts.targetWidth!);
    if (lockAspect) {
      return { width: w, height: clampDim((w * baseH) / baseW) };
    }
    return { width: w, height: clampDim(opts.targetHeight!) };
  }

  return { width: baseW, height: baseH };
}

/**
 * Crops `region` from `source` and scales into a new canvas of `(targetWidth, targetHeight)`.
 * When `bgColor` is non-null, fills the output background before drawing (preserving transparency when null).
 */
export function cropAndScaleCanvas(
  source: HTMLCanvasElement,
  region: ExportCropRect,
  targetWidth: number,
  targetHeight: number,
  bgColor: string | null = null
): HTMLCanvasElement {
  const w = Math.max(1, Math.round(targetWidth) || 1);
  const h = Math.max(1, Math.round(targetHeight) || 1);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Support camera regions that may extend partially beyond source bounds
  const sx = region.x;
  const sy = region.y;
  const sw = region.width;
  const sh = region.height;
  const scaleX = w / sw;
  const scaleY = h / sh;
  const clipLeft = Math.max(0, sx);
  const clipTop = Math.max(0, sy);
  const clipRight = Math.min(source.width, sx + sw);
  const clipBottom = Math.min(source.height, sy + sh);
  const clipW = clipRight - clipLeft;
  const clipH = clipBottom - clipTop;
  if (clipW > 0 && clipH > 0) {
    ctx.drawImage(
      source,
      clipLeft,
      clipTop,
      clipW,
      clipH,
      (clipLeft - sx) * scaleX,
      (clipTop - sy) * scaleY,
      clipW * scaleX,
      clipH * scaleY
    );
  }
  return out;
}

/**
 * Phase E1: Renders a full canvas frame through a 2D camera affine matrix (position, scale, rotation)
 * into a new output canvas of `(targetWidth, targetHeight)`.
 * `cameraMatrix` is produced by `computeCameraCanvasToOutputMatrix(...)`.
 */
export function renderCameraFrameCanvas(
  source: HTMLCanvasElement,
  cameraMatrix: Affine2D,
  targetWidth: number,
  targetHeight: number,
  bgColor: string | null = null
): HTMLCanvasElement {
  const w = Math.max(1, Math.min(MAX_EXPORT_DIM, Math.round(targetWidth) || 1));
  const h = Math.max(1, Math.min(MAX_EXPORT_DIM, Math.round(targetHeight) || 1));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(
    cameraMatrix.a,
    cameraMatrix.b,
    cameraMatrix.c,
    cameraMatrix.d,
    cameraMatrix.tx,
    cameraMatrix.ty
  );
  ctx.drawImage(source, 0, 0);
  ctx.restore();
  return out;
}

/**
 * Sanitizes a single filename component so it is safe across Windows, macOS, Linux, and ZIP entries.
 */
export function sanitizeFileNameSegment(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\.+$/g, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  if (WINDOWS_RESERVED_NAMES.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}

function sanitizeSeparator(raw: string): string {
  return raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 4);
}

/**
 * D1: Formats an image sequence file name with prefix, suffix, separator, start number, and zero padding.
 */
export function formatSequenceFileName(index: number, opts: SequenceNamingOptions): string {
  const safeIdx = Math.max(0, Math.floor(index) || 0);
  const startNum = Math.max(0, Math.floor(opts.startNumber) || 0);
  const zeroPad = Math.max(1, Math.min(8, Math.floor(opts.zeroPad) || 1));
  const sep = sanitizeSeparator(opts.separator ?? '_');
  const prefix = sanitizeFileNameSegment(opts.prefix ?? '');
  const suffix = sanitizeFileNameSegment(opts.suffix ?? '');
  const numStr = String(startNum + safeIdx).padStart(zeroPad, '0');
  const parts = [prefix, numStr, suffix].filter((p) => p.length > 0);
  const stem = sanitizeFileNameSegment(parts.join(sep)) || numStr;
  const ext = opts.extension ?? 'png';
  return `${stem}.${ext}`;
}

/**
 * D1 / D2: Resolves an inclusive 0-based frame range using full timeline, playback range, or custom timecode strings.
 */
export function resolveExportFrameRange(
  totalLength: number,
  opts: {
    mode: ExportRangeMode;
    playbackRange?: { start: number; end: number } | null;
    customStartText?: string;
    customEndText?: string;
    fps: number;
  }
): ResolvedFrameRange {
  const lastFrame = Math.max(0, Math.floor(totalLength) - 1);
  if (opts.mode === 'playback' && opts.playbackRange) {
    const start = Math.max(0, Math.min(lastFrame, Math.floor(opts.playbackRange.start)));
    const end = Math.max(start, Math.min(lastFrame, Math.floor(opts.playbackRange.end)));
    return { start, end, frameCount: end - start + 1, valid: true };
  }
  if (opts.mode === 'custom') {
    const parsedStart = parseTimecode(opts.customStartText ?? '', opts.fps);
    const parsedEnd = parseTimecode(opts.customEndText ?? '', opts.fps);
    if (parsedStart === null || parsedEnd === null || parsedStart > parsedEnd) {
      return { start: 0, end: lastFrame, frameCount: 0, valid: false };
    }
    const start = Math.max(0, Math.min(lastFrame, parsedStart));
    const end = Math.max(start, Math.min(lastFrame, parsedEnd));
    if (parsedStart > lastFrame) {
      return { start: lastFrame, end: lastFrame, frameCount: 0, valid: false };
    }
    return { start, end, frameCount: end - start + 1, valid: true };
  }
  return { start: 0, end: lastFrame, frameCount: lastFrame + 1, valid: true };
}

/**
 * D1: Expands or preserves segment holds into an ordered sequence export plan.
 */
export function planSequenceFrames(
  segments: ReadonlyArray<{ time: number; hold: number }>,
  mode: SequenceFrameMode
): PlannedSequenceFrame[] {
  const out: PlannedSequenceFrame[] = [];
  if (mode === 'distinct-frames') {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      out.push({
        outputIndex: i,
        sourceTime: seg.time,
        timelineFrame: seg.time,
        hold: Math.max(1, Math.floor(seg.hold) || 1),
      });
    }
    return out;
  }
  let outputIndex = 0;
  for (const seg of segments) {
    const hold = Math.max(1, Math.floor(seg.hold) || 1);
    for (let k = 0; k < hold; k++) {
      out.push({
        outputIndex: outputIndex++,
        sourceTime: seg.time,
        timelineFrame: seg.time + k,
        hold: 1,
      });
    }
  }
  return out;
}

/**
 * D4: Formats a per-cel export filename with collision deduplication (case-insensitive).
 */
export function formatCelFileName(
  folderName: string,
  celName: string,
  opts: CelNamingOptions,
  usedLowerNames?: Set<string>
): string {
  const sep = sanitizeSeparator(opts.separator ?? '_');
  const prefix = sanitizeFileNameSegment(opts.prefix ?? '');
  const suffix = sanitizeFileNameSegment(opts.suffix ?? '');
  const safeFolder = sanitizeFileNameSegment(folderName);
  const safeCel = sanitizeFileNameSegment(celName) || 'cel';
  const baseParts = opts.mode === 'folder-cel'
    ? [prefix, safeFolder, safeCel, suffix]
    : [prefix, safeCel, suffix];
  const stem = sanitizeFileNameSegment(baseParts.filter((p) => p.length > 0).join(sep)) || 'cel';
  const ext = opts.extension;
  let candidate = `${stem}.${ext}`;
  if (usedLowerNames) {
    let counter = 2;
    while (usedLowerNames.has(candidate.toLowerCase())) {
      candidate = `${stem}${sep || '_'}${counter}.${ext}`;
      counter++;
    }
    usedLowerNames.add(candidate.toLowerCase());
  }
  return candidate;
}

export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

interface PreparedColorRule {
  r: number;
  g: number;
  b: number;
  /** Vector from white (255,255,255) to target color */
  vr: number;
  vg: number;
  vb: number;
  vLenSq: number;
  vLen: number;
  minCoverage: number;
  chromatic: boolean;
}

/**
 * D4: Binarizes anti-aliased line art for cel painting workflows.
 * Every output pixel is guaranteed to be either one of the enabled target line colors (opaque)
 * or the exact background color (solid white or fully transparent), with zero intermediate tones.
 */
export function binarizeLineArt(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: BinarizeLineArtOptions
): Uint8ClampedArray {
  const pixelCount = Math.max(0, Math.floor(width) * Math.floor(height));
  const out = new Uint8ClampedArray(pixelCount * 4);
  if (!options.enabled) {
    out.set(rgba.subarray(0, pixelCount * 4));
    return out;
  }

  const prepared: PreparedColorRule[] = [];
  for (const rule of options.rules) {
    if (!rule.enabled) continue;
    const rgb = parseHexColor(rule.hex);
    if (!rgb) continue;
    const vr = rgb.r - 255;
    const vg = rgb.g - 255;
    const vb = rgb.b - 255;
    const vLenSq = vr * vr + vg * vg + vb * vb;
    if (vLenSq < 1) continue; // Ignore pure white as a line color
    const threshold = Math.max(0, Math.min(255, Math.round(rule.threshold)));
    const minCoverage = threshold <= 0 ? 1.01 : Math.max(1 / 255, (256 - threshold) / 255);
    const maxC = Math.max(rgb.r, rgb.g, rgb.b);
    const minC = Math.min(rgb.r, rgb.g, rgb.b);
    const chromatic = (maxC - minC) > 24;
    prepared.push({
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      vr,
      vg,
      vb,
      vLenSq,
      vLen: Math.sqrt(vLenSq),
      minCoverage,
      chromatic,
    });
  }

  const bgWhite = options.background === 'white';
  const CHROMATIC_MIN_COS = 0.86; // ~30.6 deg cone around the white-to-color ray

  for (let p = 0; p < pixelCount; p++) {
    const off = p * 4;
    const a = rgba[off + 3];
    if (a === 0 || prepared.length === 0) {
      if (bgWhite) {
        out[off] = 255;
        out[off + 1] = 255;
        out[off + 2] = 255;
        out[off + 3] = 255;
      }
      continue;
    }

    // Composite over white so anti-aliased transparent edges behave identically to white-paper edges
    const alpha = a / 255;
    const cr = rgba[off] * alpha + 255 * (1 - alpha);
    const cg = rgba[off + 1] * alpha + 255 * (1 - alpha);
    const cb = rgba[off + 2] * alpha + 255 * (1 - alpha);

    const dr = cr - 255;
    const dg = cg - 255;
    const db = cb - 255;
    const dLenSq = dr * dr + dg * dg + db * db;
    if (dLenSq < 1e-4) {
      if (bgWhite) {
        out[off] = 255;
        out[off + 1] = 255;
        out[off + 2] = 255;
        out[off + 3] = 255;
      }
      continue;
    }
    const dLen = Math.sqrt(dLenSq);

    let bestRule: PreparedColorRule | null = null;
    let bestPerpSq = Infinity;
    let bestCoverage = -1;

    for (let i = 0; i < prepared.length; i++) {
      const rule = prepared[i];
      const dot = dr * rule.vr + dg * rule.vg + db * rule.vb;
      if (dot <= 0) continue;
      const cos = dot / (dLen * rule.vLen);
      if (rule.chromatic && cos < CHROMATIC_MIN_COS) continue;
      const t = Math.min(1, dot / rule.vLenSq);
      if (t < rule.minCoverage) continue;
      const pr = dr - t * rule.vr;
      const pg = dg - t * rule.vg;
      const pb = db - t * rule.vb;
      const perpSq = pr * pr + pg * pg + pb * pb;
      if (perpSq < bestPerpSq - 1e-3 || (Math.abs(perpSq - bestPerpSq) <= 1e-3 && t > bestCoverage)) {
        bestPerpSq = perpSq;
        bestCoverage = t;
        bestRule = rule;
      }
    }

    if (bestRule) {
      out[off] = bestRule.r;
      out[off + 1] = bestRule.g;
      out[off + 2] = bestRule.b;
      out[off + 3] = 255;
    } else if (bgWhite) {
      out[off] = 255;
      out[off + 1] = 255;
      out[off + 2] = 255;
      out[off + 3] = 255;
    }
  }

  return out;
}

/**
 * Zero-dependency uncompressed Truevision TGA encoder (24-bit BGR or 32-bit BGRA, top-left origin).
 */
export function encodeTga(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bitsPerPixel: 24 | 32 = 24
): Uint8Array {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const bytesPerPixel = bitsPerPixel === 32 ? 4 : 3;
  const out = new Uint8Array(18 + w * h * bytesPerPixel);
  // Header (18 bytes)
  out[2] = 2; // Uncompressed true-color image
  out[12] = w & 0xff;
  out[13] = (w >> 8) & 0xff;
  out[14] = h & 0xff;
  out[15] = (h >> 8) & 0xff;
  out[16] = bitsPerPixel;
  out[17] = bitsPerPixel === 32 ? 0x28 : 0x20; // Top-left origin (bit 5) + alpha depth (8 or 0)

  let dst = 18;
  const total = w * h;
  if (bitsPerPixel === 32) {
    for (let i = 0; i < total; i++) {
      const src = i * 4;
      out[dst++] = rgba[src + 2];
      out[dst++] = rgba[src + 1];
      out[dst++] = rgba[src];
      out[dst++] = rgba[src + 3];
    }
  } else {
    for (let i = 0; i < total; i++) {
      const src = i * 4;
      const a = rgba[src + 3];
      if (a === 255) {
        out[dst++] = rgba[src + 2];
        out[dst++] = rgba[src + 1];
        out[dst++] = rgba[src];
      } else if (a === 0) {
        out[dst++] = 255;
        out[dst++] = 255;
        out[dst++] = 255;
      } else {
        const alpha = a / 255;
        out[dst++] = Math.round(rgba[src + 2] * alpha + 255 * (1 - alpha));
        out[dst++] = Math.round(rgba[src + 1] * alpha + 255 * (1 - alpha));
        out[dst++] = Math.round(rgba[src] * alpha + 255 * (1 - alpha));
      }
    }
  }
  return out;
}

/**
 * Zero-dependency uncompressed 24-bit Windows BMP (BI_RGB) encoder.
 * Semi-transparent pixels are composited over pure white.
 */
export function encodeBmp24(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Uint8Array {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const rowStride = Math.ceil((w * 3) / 4) * 4;
  const pixelBytes = rowStride * h;
  const fileSize = 54 + pixelBytes;
  const out = new Uint8Array(fileSize);
  const view = new DataView(out.buffer);

  // BITMAPFILEHEADER (14 bytes)
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true); // Pixel data offset

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, h, true); // Positive = bottom-up rows
  view.setUint16(26, 1, true); // Planes
  view.setUint16(28, 24, true); // Bits per pixel
  view.setUint32(30, 0, true); // BI_RGB (no compression)
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true); // 72 DPI
  view.setInt32(42, 2835, true);

  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    let dst = 54 + y * rowStride;
    for (let x = 0; x < w; x++) {
      const src = srcRow + x * 4;
      const a = rgba[src + 3];
      if (a === 255) {
        out[dst++] = rgba[src + 2];
        out[dst++] = rgba[src + 1];
        out[dst++] = rgba[src];
      } else if (a === 0) {
        out[dst++] = 255;
        out[dst++] = 255;
        out[dst++] = 255;
      } else {
        const alpha = a / 255;
        out[dst++] = Math.round(rgba[src + 2] * alpha + 255 * (1 - alpha));
        out[dst++] = Math.round(rgba[src + 1] * alpha + 255 * (1 - alpha));
        out[dst++] = Math.round(rgba[src] * alpha + 255 * (1 - alpha));
      }
    }
  }
  return out;
}
