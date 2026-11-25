import type { BlendMode } from '@atelier/shared';

export interface KraTileBlock {
  left: number;
  top: number;
  raw: Uint8Array;
}

export interface KraDecodedTileLayer {
  version: number;
  tileWidth: number;
  tileHeight: number;
  pixelSize: number;
  tiles: KraTileBlock[];
}

export interface ImportedCanvasSize {
  width: number;
  height: number;
  scale: number;
}

export const MIN_IMPORT_CANVAS_DIM = 64;
export const MAX_IMPORT_CANVAS_DIM = 16384;

export function parseKraInheritAlpha(layer: Pick<Element, 'getAttribute'>): boolean {
  return (layer.getAttribute('inheritsalpha') ??
    layer.getAttribute('inheritalpha') ??
    layer.getAttribute('inheritAlpha')) === '1';
}

/**
 * Fits imported PSD / KRA dimensions into AtelierSync's supported [64, 16384] integer bounds.
 * Oversized documents are uniformly scaled down; tiny documents are padded without blurry upscaling.
 */
export function clampImportedCanvasDimensions(srcW: number, srcH: number): ImportedCanvasSize {
  const safeW = Math.max(1, Math.round(Number.isFinite(srcW) ? srcW : 1024));
  const safeH = Math.max(1, Math.round(Number.isFinite(srcH) ? srcH : 1024));
  if (safeW > MAX_IMPORT_CANVAS_DIM || safeH > MAX_IMPORT_CANVAS_DIM) {
    const scale = Math.min(MAX_IMPORT_CANVAS_DIM / safeW, MAX_IMPORT_CANVAS_DIM / safeH);
    return {
      width: Math.max(MIN_IMPORT_CANVAS_DIM, Math.min(MAX_IMPORT_CANVAS_DIM, Math.round(safeW * scale))),
      height: Math.max(MIN_IMPORT_CANVAS_DIM, Math.min(MAX_IMPORT_CANVAS_DIM, Math.round(safeH * scale))),
      scale,
    };
  }
  return {
    width: Math.max(MIN_IMPORT_CANVAS_DIM, safeW),
    height: Math.max(MIN_IMPORT_CANVAS_DIM, safeH),
    scale: 1,
  };
}

/**
 * Standard liblzf decompressor matching Krita's KisLzfCompression.
 */
export function decompressLzf(input: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let ip = 0;
  let op = 0;
  const inLen = input.length;

  while (ip < inLen && op < expectedLength) {
    const ctrl = input[ip++];
    if (ctrl < 32) {
      let runLen = ctrl + 1;
      if (ip + runLen > inLen) {
        runLen = inLen - ip;
      }
      const copyLen = Math.min(runLen, expectedLength - op);
      out.set(input.subarray(ip, ip + copyLen), op);
      ip += runLen;
      op += copyLen;
    } else {
      let len = ctrl >> 5;
      let ref = op - ((ctrl & 0x1f) << 8) - 1;
      if (len === 7) {
        if (ip >= inLen) break;
        len += input[ip++];
      }
      if (ip >= inLen) break;
      ref -= input[ip++];
      len += 2;
      if (ref < 0) {
        throw new Error(`Invalid KRA LZF back-reference (${ref})`);
      }
      const end = Math.min(expectedLength, op + len);
      while (op < end) {
        out[op++] = out[ref++];
      }
    }
  }

  return out;
}

/**
 * Re-interleaves Krita KisAbstractCompression planar bytes back into pixel-interleaved layout.
 */
export function delinearizeBytes(
  linearized: Uint8Array,
  pixelCount: number,
  pixelSize: number
): Uint8Array {
  if (pixelSize <= 1) return linearized.slice(0, pixelCount * pixelSize);
  const out = new Uint8Array(pixelCount * pixelSize);
  for (let c = 0; c < pixelSize; c++) {
    const planeOffset = c * pixelCount;
    for (let p = 0; p < pixelCount; p++) {
      out[p * pixelSize + c] = linearized[planeOffset + p];
    }
  }
  return out;
}

/**
 * Linearizes pixel-interleaved bytes into planar byte order (inverse of delinearizeBytes).
 */
export function linearizeBytes(
  interleaved: Uint8Array,
  pixelCount: number,
  pixelSize: number
): Uint8Array {
  if (pixelSize <= 1) return interleaved.slice(0, pixelCount * pixelSize);
  const out = new Uint8Array(pixelCount * pixelSize);
  for (let c = 0; c < pixelSize; c++) {
    const planeOffset = c * pixelCount;
    for (let p = 0; p < pixelCount; p++) {
      out[planeOffset + p] = interleaved[p * pixelSize + c];
    }
  }
  return out;
}

function readAsciiLine(bytes: Uint8Array, offset: number): { line: string; nextOffset: number } | null {
  if (offset >= bytes.length) return null;
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0x0a) end++;
  let strEnd = end;
  if (strEnd > offset && bytes[strEnd - 1] === 0x0d) strEnd--;
  let line = '';
  for (let i = offset; i < strEnd; i++) {
    line += String.fromCharCode(bytes[i]);
  }
  return { line, nextOffset: end < bytes.length ? end + 1 : end };
}

/**
 * Parses a Krita `.kra` binary tile data file (`<imageName>/layers/<filename>`).
 * Supports VERSION 2 (LZF + planar byte linearization, uncompressed flag 0, and NONE).
 */
export function parseKraTileStream(bytes: Uint8Array): KraDecodedTileLayer {
  let offset = 0;
  let version = 2;
  let tileWidth = 64;
  let tileHeight = 64;
  let pixelSize = 4;
  let declaredTileCount = -1;

  // Read ASCII header lines until `DATA <count>`
  for (let i = 0; i < 16; i++) {
    const res = readAsciiLine(bytes, offset);
    if (!res) break;
    offset = res.nextOffset;
    const trimmed = res.line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'VERSION') {
      version = Number.parseInt(parts[1] ?? '2', 10) || 2;
    } else if (key === 'TILEWIDTH') {
      tileWidth = Number.parseInt(parts[1] ?? '64', 10) || 64;
    } else if (key === 'TILEHEIGHT') {
      tileHeight = Number.parseInt(parts[1] ?? '64', 10) || 64;
    } else if (key === 'PIXELSIZE') {
      pixelSize = Number.parseInt(parts[1] ?? '4', 10) || 4;
    } else if (key === 'DATA' || key === 'TILESNUMBER') {
      declaredTileCount = Number.parseInt(parts[1] ?? '0', 10);
      if (key === 'DATA') break;
    }
  }

  const pixelCount = tileWidth * tileHeight;
  const expectedBytes = pixelCount * pixelSize;
  const tiles: KraTileBlock[] = [];
  const maxTiles = declaredTileCount >= 0 ? declaredTileCount : 1_000_000;

  for (let t = 0; t < maxTiles && offset < bytes.length; t++) {
    const headerRes = readAsciiLine(bytes, offset);
    if (!headerRes) break;
    offset = headerRes.nextOffset;
    const line = headerRes.line.trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 4) break;
    const left = Number.parseInt(parts[0], 10);
    const top = Number.parseInt(parts[1], 10);
    const compression = parts[2].trim().toUpperCase();
    const compressedSize = Number.parseInt(parts[3], 10);
    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(compressedSize) || compressedSize < 0) {
      break;
    }
    if (offset + compressedSize > bytes.length) {
      break;
    }

    const payload = bytes.subarray(offset, offset + compressedSize);
    offset += compressedSize;

    let raw: Uint8Array;
    if (compression === 'LZF') {
      if (payload.length === 0) continue;
      const flag = payload[0];
      const body = payload.subarray(1);
      if (flag === 0) {
        // Uncompressed raw interleaved tile bytes
        raw = body.length >= expectedBytes ? body.slice(0, expectedBytes) : padTo(body, expectedBytes);
      } else {
        // Compressed linearized planar tile bytes
        const decompressed = decompressLzf(body, expectedBytes);
        raw = version >= 2 ? delinearizeBytes(decompressed, pixelCount, pixelSize) : decompressed;
      }
    } else if (compression === 'NONE') {
      if (payload.length === expectedBytes + 1 && payload[0] === 0) {
        raw = payload.slice(1, 1 + expectedBytes);
      } else {
        raw = payload.length >= expectedBytes ? payload.slice(0, expectedBytes) : padTo(payload, expectedBytes);
      }
    } else {
      // Unknown compression: skip tile safely rather than crashing entire file
      continue;
    }

    tiles.push({ left, top, raw });
  }

  return { version, tileWidth, tileHeight, pixelSize, tiles };
}

function padTo(src: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(src.subarray(0, Math.min(src.length, length)));
  return out;
}

function float16ToFloat32(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x03ff;
  if (exp === 0) {
    return sign * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 31) {
    return frac === 0 ? sign * Infinity : NaN;
  }
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

function clampByte(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 255) return 255;
  return Math.round(v);
}

/**
 * Converts a decoded Krita tile buffer into straight-alpha 8-bit RGBA pixels.
 * Krita stores 8-bit / 16-bit integer RGBA in BGRA channel order; float formats use RGBA.
 */
export function convertKraTileToRgba8(
  raw: Uint8Array,
  pixelCount: number,
  pixelSize: number,
  colorSpace: string,
  isMask = false
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixelCount * 4);
  const cs = (colorSpace || 'RGBA').toUpperCase();

  if (isMask || cs === 'ALPHA' || pixelSize === 1) {
    if (pixelSize === 2) {
      for (let p = 0; p < pixelCount; p++) {
        const v = raw[p * 2 + 1]; // little-endian uint16 high byte
        const o = p * 4;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    } else {
      for (let p = 0; p < pixelCount; p++) {
        const v = raw[p * pixelSize];
        const o = p * 4;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  if ((cs === 'RGBA' || cs === 'RGBAU8') && pixelSize === 4) {
    // Krita 8-bit RGBA is BGRA in memory
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 4;
      out[i] = raw[i + 2];     // R
      out[i + 1] = raw[i + 1]; // G
      out[i + 2] = raw[i];     // B
      out[i + 3] = raw[i + 3]; // A
    }
    return out;
  }

  if ((cs === 'RGBA16' || cs === 'RGBAU16') && pixelSize === 8) {
    // Krita 16-bit integer RGBA is little-endian BGRA
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 8;
      const o = p * 4;
      out[o] = raw[i + 5];     // R high byte
      out[o + 1] = raw[i + 3]; // G high byte
      out[o + 2] = raw[i + 1]; // B high byte
      out[o + 3] = raw[i + 7]; // A high byte
    }
    return out;
  }

  if (cs === 'RGBAF32' && pixelSize === 16) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 16;
      const o = p * 4;
      out[o] = clampByte(view.getFloat32(i, true) * 255);
      out[o + 1] = clampByte(view.getFloat32(i + 4, true) * 255);
      out[o + 2] = clampByte(view.getFloat32(i + 8, true) * 255);
      out[o + 3] = clampByte(view.getFloat32(i + 12, true) * 255);
    }
    return out;
  }

  if (cs === 'RGBAF16' && pixelSize === 8) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 8;
      const o = p * 4;
      out[o] = clampByte(float16ToFloat32(view.getUint16(i, true)) * 255);
      out[o + 1] = clampByte(float16ToFloat32(view.getUint16(i + 2, true)) * 255);
      out[o + 2] = clampByte(float16ToFloat32(view.getUint16(i + 4, true)) * 255);
      out[o + 3] = clampByte(float16ToFloat32(view.getUint16(i + 6, true)) * 255);
    }
    return out;
  }

  if ((cs === 'GRAYA' || cs === 'GRAYAU8') && pixelSize === 2) {
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 2;
      const o = p * 4;
      const g = raw[i];
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
      out[o + 3] = raw[i + 1];
    }
    return out;
  }

  if ((cs === 'GRAYA16' || cs === 'GRAYAU16') && pixelSize === 4) {
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 4;
      const o = p * 4;
      const g = raw[i + 1];
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
      out[o + 3] = raw[i + 3];
    }
    return out;
  }

  if ((cs === 'CMYKA' || cs === 'CMYKAU8') && pixelSize === 5) {
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 5;
      const o = p * 4;
      const invK = 255 - raw[i + 3];
      out[o] = Math.round(((255 - raw[i]) * invK) / 255);
      out[o + 1] = Math.round(((255 - raw[i + 1]) * invK) / 255);
      out[o + 2] = Math.round(((255 - raw[i + 2]) * invK) / 255);
      out[o + 3] = raw[i + 4];
    }
    return out;
  }

  // Fallback for 4-byte unknown colorspaces: treat as BGRA
  if (pixelSize >= 4) {
    for (let p = 0; p < pixelCount; p++) {
      const i = p * pixelSize;
      const o = p * 4;
      out[o] = raw[i + 2];
      out[o + 1] = raw[i + 1];
      out[o + 2] = raw[i];
      out[o + 3] = raw[i + 3];
    }
  }
  return out;
}

/**
 * Maps Adobe Photoshop / ag-psd blendMode strings to Lumina Drift BlendMode.
 */
export function mapPsdBlendMode(mode: string | null | undefined): BlendMode {
  switch ((mode || '').toLowerCase().trim()) {
    case 'multiply':
      return 'multiply';
    case 'linear burn':
      return 'linear_burn';
    case 'screen':
      return 'screen';
    case 'overlay':
      return 'overlay';
    case 'darken':
      return 'darken';
    case 'darker color':
      return 'darker_color';
    case 'lighten':
      return 'lighten';
    case 'lighter color':
      return 'lighter_color';
    case 'color dodge':
      return 'color_dodge';
    case 'color burn':
      return 'color_burn';
    case 'hard light':
      return 'hard_light';
    case 'soft light':
      return 'soft_light';
    case 'vivid light':
      return 'vivid_light';
    case 'linear light':
      return 'linear_light';
    case 'pin light':
      return 'pin_light';
    case 'hard mix':
      return 'hard_mix';
    case 'difference':
      return 'difference';
    case 'exclusion':
      return 'exclusion';
    case 'subtract':
      return 'subtract';
    case 'divide':
      return 'divide';
    case 'linear dodge':
      return 'add';
    case 'hue':
      return 'hue';
    case 'saturation':
      return 'saturation';
    case 'color':
      return 'color';
    case 'luminosity':
      return 'luminosity';
    case 'pass through':
    case 'normal':
    default:
      return 'normal';
  }
}

/**
 * Maps Krita `.kra` compositeop attribute values to Lumina Drift BlendMode.
 */
export function mapKraBlendMode(compositeOp: string | null | undefined): BlendMode {
  switch ((compositeOp || '').toLowerCase().trim()) {
    case 'multiply':
      return 'multiply';
    case 'linear_burn':
      return 'linear_burn';
    case 'screen':
      return 'screen';
    case 'overlay':
      return 'overlay';
    case 'darken':
      return 'darken';
    case 'darker color':
    case 'darker_color':
      return 'darker_color';
    case 'lighten':
      return 'lighten';
    case 'lighter color':
    case 'lighter_color':
      return 'lighter_color';
    case 'dodge':
    case 'color_dodge':
      return 'color_dodge';
    case 'burn':
    case 'color_burn':
      return 'color_burn';
    case 'hard_light':
    case 'hard_overlay':
      return 'hard_light';
    case 'soft_light':
    case 'soft_light_svg':
    case 'soft_light_ifs_illusions':
    case 'soft_light_pegtop_delphi':
      return 'soft_light';
    case 'vivid_light':
      return 'vivid_light';
    case 'linear_light':
      return 'linear_light';
    case 'pin_light':
      return 'pin_light';
    case 'hard_mix':
    case 'hard_mix_photoshop':
    case 'hard_mix_softer_photoshop':
      return 'hard_mix';
    case 'diff':
    case 'difference':
      return 'difference';
    case 'exclusion':
      return 'exclusion';
    case 'subtract':
      return 'subtract';
    case 'divide':
      return 'divide';
    case 'add':
    case 'addition':
    case 'linear_dodge':
    case 'luminize':
      return 'add';
    case 'hue':
    case 'hue_hsv':
    case 'hue_hsl':
      return 'hue';
    case 'saturation':
    case 'saturation_hsv':
    case 'saturation_hsl':
      return 'saturation';
    case 'color':
    case 'color_hsv':
    case 'color_hsl':
      return 'color';
    case 'luminosity':
    case 'luminosity_sai':
      return 'luminosity';
    case 'normal':
    case 'alphadarken':
    case 'copy':
    default:
      return 'normal';
  }
}

export type SupportedProjectFormat = 'lumina' | 'psd' | 'kra';

export const PROJECT_FILE_EXT_RE = /\.(lumina|psd|kra)$/i;

export function isSupportedProjectFileName(name: string | null | undefined): boolean {
  return Boolean(name && PROJECT_FILE_EXT_RE.test(name.trim()));
}

export function detectProjectFormatFromName(name: string | null | undefined): SupportedProjectFormat | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  if (lower.endsWith('.lumina')) return 'lumina';
  if (lower.endsWith('.psd')) return 'psd';
  if (lower.endsWith('.kra')) return 'kra';
  return null;
}
