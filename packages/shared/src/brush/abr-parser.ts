/**
 * Photoshop ABR (Adobe Brush) Format Parser
 * Supports ABR Version 1, 2 and Version 6+ (8BIM Sampled Brushes)
 */

import { MIN_BRUSH_SPACING } from './brush-spacing';
import type {
  BrushDynamicsConfig,
  BrushMixMode,
  BrushTextureBlendMode,
  DualBrushBlendMode,
} from './brush-dynamics';

export interface ParsedBrushTip {
  id: string;
  name: string;
  width: number;
  height: number;
  dataUrl: string | null; // Base64 RGBA PNG DataURL, or null for procedural round tips
  spacing?: number;
  hardness?: number;
  // Extended Brush Engine v2 restored parameters (optional for backward compatibility)
  size?: number;
  minSize?: number;
  opacity?: number;
  flow?: number;
  angle?: number;
  roundness?: number;
  angleMode?: 'direction' | 'pen' | 'fixed';
  scatter?: number;
  colorMixing?: number;
  paintAmount?: number;
  colorStretch?: number;
  mixMode?: BrushMixMode;
  textureDensity?: number;
  textureScale?: number;
  textureInvert?: boolean;
  textureBlendMode?: BrushTextureBlendMode;
  textureDataUrl?: string | null;
  dualBrush?: boolean;
  dualSize?: number;
  dualScatter?: number;
  dualTipDataUrl?: string | null;
  dualBlendMode?: DualBrushBlendMode;
  hueJitter?: number;
  satJitter?: number;
  valJitter?: number;
  fgBgMix?: number;
  tiltSize?: number;
  wetEdges?: boolean;
  dynamics?: BrushDynamicsConfig;
  sourceFormat?: 'abr' | 'sut';
}

export class AbrParser {
  private buffer: Uint8Array;
  private view: DataView;
  private offset: number = 0;

  constructor(input: ArrayBuffer | ArrayBufferView) {
    this.buffer = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
  }

  public parse(): ParsedBrushTip[] {
    return Array.from(this.tips());
  }

  public *tips(): IterableIterator<ParsedBrushTip> {
    if (this.buffer.length < 4) {
      throw new Error('檔案過小，不是有效的 ABR 檔案');
    }

    const version = this.view.getInt16(0, false); // Big endian
    if (version === 1 || version === 2) {
      yield* this.parseVersion1Or2(version);
    } else if (version >= 6) {
      yield* this.parseVersion6Plus();
    }
  }

  private parseVersion1Or2(version: number): ParsedBrushTip[] {
    const tips: ParsedBrushTip[] = [];
    this.offset = 2; // after version
    const count = this.view.getInt16(this.offset, false);
    this.offset += 2;

    for (let i = 0; i < count && this.offset < this.buffer.length; i++) {
      if (this.offset + 6 > this.buffer.length) break;
      const brushType = this.view.getInt16(this.offset, false);
      const size = this.view.getInt32(this.offset + 2, false);
      this.offset += 6;

      const nextBrushOffset = this.offset + size;

      if (brushType === 2) {
        // Sampled brush
        this.offset += 4; // skip misc
        const top = this.view.getInt16(this.offset, false);
        const left = this.view.getInt16(this.offset + 2, false);
        const bottom = this.view.getInt16(this.offset + 4, false);
        const right = this.view.getInt16(this.offset + 6, false);
        this.offset += 8;

        const depth = this.view.getInt16(this.offset, false);
        this.offset += 2;

        const width = right - left;
        const height = bottom - top;

        if (width > 0 && height > 0 && width < 4096 && height < 4096 && depth === 8) {
          const pixelCount = width * height;
          if (this.offset + pixelCount <= this.buffer.length) {
            const rawPixels = this.buffer.subarray(this.offset, this.offset + pixelCount);
            const dataUrl = this.grayscaleToDataUrl(rawPixels, width, height);
            tips.push({
              id: `abr_v${version}_${i + 1}`,
              name: `PS Brush #${i + 1} (${width}x${height})`,
              width,
              height,
              dataUrl,
              spacing: MIN_BRUSH_SPACING,
              hardness: 0.8,
            });
          }
        }
      }

      this.offset = nextBrushOffset;
    }

    return tips;
  }

  private *parseVersion6Plus(): IterableIterator<ParsedBrushTip> {
    const subversion = this.view.getUint16(2, false);
    if (subversion !== 1 && subversion !== 2) return;
    const sampleHeaderSize = 37 + (subversion === 1 ? 10 : 264);
    let sampleIndex = 0;
    for (let section = 4; section + 12 <= this.buffer.length;) {
      if (this.view.getUint32(section, false) !== 0x3842494d) break; // 8BIM
      const type = this.view.getUint32(section + 4, false);
      const start = section + 12;
      const end = start + this.view.getUint32(section + 8, false);
      if (end > this.buffer.length) break;
      section = end;
      if (type !== 0x73616d70) continue; // samp

      for (let offset = start; offset + 4 <= end;) {
        const size = this.view.getUint32(offset, false);
        const record = offset + 4;
        const sampleEnd = record + size;
        if (!size || sampleEnd > end) break;
        offset = record + Math.ceil(size / 4) * 4;
        sampleIndex++;

        const header = record + sampleHeaderSize;
        const data = header + 19;
        if (data > sampleEnd) continue;
        const height = this.view.getInt32(header + 8, false) - this.view.getInt32(header, false);
        const width = this.view.getInt32(header + 12, false) - this.view.getInt32(header + 4, false);
        if (width < 1 || height < 1 || width > 4096 || height > 4096) continue;

        const depth = this.view.getUint16(header + 16, false);
        const compression = this.buffer[header + 18];
        const pixels = this.decodeModernSample(data, sampleEnd, width, height, depth, compression);
        if (!pixels) continue;
        yield {
          id: `abr_sample_${sampleIndex}`,
          name: `筆刷尖形 #${sampleIndex} (${width}x${height})`,
          width,
          height,
          dataUrl: this.grayscaleToDataUrl(pixels, width, height, false),
          spacing: MIN_BRUSH_SPACING,
          hardness: 0.85,
        };
      }
    }
  }

  private decodeModernSample(start: number, end: number, width: number, height: number, depth: number, compression: number) {
    const count = width * height;
    if (compression === 0) {
      if (depth === 8 && start + count <= end) return this.buffer.subarray(start, start + count);
      if (depth === 16 && start + count * 2 <= end) {
        const pixels = new Uint8Array(count);
        for (let i = 0; i < count; i++) pixels[i] = this.buffer[start + i * 2];
        return pixels;
      }
      return null;
    }
    if (compression !== 1 || depth !== 8 || start + height * 2 > end) return null;

    const pixels = new Uint8Array(count);
    let input = start + height * 2;
    for (let y = 0; y < height; y++) {
      const rowEnd = input + this.view.getUint16(start + y * 2, false);
      const outEnd = (y + 1) * width;
      let out = y * width;
      if (rowEnd > end) return null;
      while (input < rowEnd) {
        const code = this.buffer[input++];
        if (code === 128) continue;
        const run = code < 128 ? code + 1 : 257 - code;
        const bytes = code < 128 ? run : 1;
        if (input + bytes > rowEnd || out + run > outEnd) return null;
        if (code < 128) pixels.set(this.buffer.subarray(input, input + bytes), out);
        else pixels.fill(this.buffer[input], out, out + run);
        input += bytes;
        out += run;
      }
      if (out !== outEnd) return null;
    }
    return pixels;
  }

  /**
   * Converts 8-bit grayscale pixel mask to an RGBA PNG DataURL.
   * Brush tip logic: Photoshop stores opaque ink as black (0) or white (255).
   * We detect the edge pixels: if edges are white (255), then ink is 0 (inverted).
   */
  private grayscaleToDataUrl(pixels: Uint8Array, width: number, height: number, invert?: boolean): string {
    // Detect whether black is ink or white is ink by checking edge pixels
    let cornerSum = 0;
    let cornerCount = 0;
    const checkCoords = [
      0,
      width - 1,
      (height - 1) * width,
      height * width - 1,
      Math.floor(width / 2),
      Math.floor(height / 2) * width,
    ];
    for (const c of checkCoords) {
      if (c < pixels.length) {
        cornerSum += pixels[c];
        cornerCount++;
      }
    }
    const avgCorner = cornerCount > 0 ? cornerSum / cornerCount : 255;
    const isInverted = invert ?? avgCorner > 127;

    // Build RGBA buffer
    // For universal compatibility across Node.js tests and browser runtime:
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const imgData = ctx.createImageData(width, height);
        const rgba = imgData.data;

        for (let i = 0; i < width * height; i++) {
          const raw = pixels[i];
          const alpha = isInverted ? 255 - raw : raw;
          const idx = i * 4;
          // Brush tip color is pure white, with alpha defined by the mask
          rgba[idx] = 255;
          rgba[idx + 1] = 255;
          rgba[idx + 2] = 255;
          rgba[idx + 3] = alpha;
        }

        ctx.putImageData(imgData, 0, 0);
        const result = canvas.toDataURL('image/png');
        canvas.width = canvas.height = 0;
        return result;
      }
    }

    // Node.js fallback or minimal raw PNG generator
    return this.createMinimalPngDataUrl(pixels, width, height, isInverted);
  }

  /**
   * Fallback pure-JS uncompressed BMP / PNG DataURL generator when DOM Canvas is unavailable
   */
  private createMinimalPngDataUrl(
    pixels: Uint8Array,
    width: number,
    height: number,
    isInverted: boolean
  ): string {
    // 32-bit BMP header format (universal, works without node-canvas or DOM)
    const fileHeaderSize = 14;
    const infoHeaderSize = 40;
    const pixelArraySize = width * height * 4;
    const fileSize = fileHeaderSize + infoHeaderSize + pixelArraySize;

    const bmp = new Uint8Array(fileSize);
    const v = new DataView(bmp.buffer);

    // Bitmap File Header
    bmp[0] = 0x42; // 'B'
    bmp[1] = 0x4d; // 'M'
    v.setUint32(2, fileSize, true);
    v.setUint32(10, fileHeaderSize + infoHeaderSize, true);

    // DIB Header (BITMAPINFOHEADER)
    v.setUint32(14, infoHeaderSize, true);
    v.setInt32(18, width, true);
    v.setInt32(22, -height, true); // negative height for top-down row order
    v.setUint16(26, 1, true); // color planes
    v.setUint16(28, 32, true); // 32 bpp (BGRA)
    v.setUint32(30, 0, true); // BI_RGB (uncompressed)
    v.setUint32(34, pixelArraySize, true);

    let offset = 54;
    for (let i = 0; i < width * height; i++) {
      const raw = pixels[i];
      const alpha = isInverted ? 255 - raw : raw;
      bmp[offset++] = 255; // B
      bmp[offset++] = 255; // G
      bmp[offset++] = 255; // R
      bmp[offset++] = alpha; // A
    }

    // Encode to base64 DataURL
    let base64 = '';
    if (typeof (globalThis as any).Buffer !== 'undefined') {
      base64 = (globalThis as any).Buffer.from(bmp).toString('base64');
    } else {
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bmp.length; i += chunk) {
        binary += String.fromCharCode(...bmp.subarray(i, i + chunk));
      }
      base64 = (globalThis as any).btoa(binary);
    }
    return `data:image/bmp;base64,${base64}`;
  }
}
