/**
 * Photoshop ABR (Adobe Brush) Format Parser
 * Supports ABR Version 1, 2 and Version 6+ (8BIM Sampled Brushes)
 */

import { MIN_BRUSH_SPACING } from './brush-spacing';
import type { PigmentBlendModel } from '../color/pigment-blend';
import type {
  BrushColorDynamicsConfig,
  BrushDynamicsConfig,
  BrushMixMode,
  BrushTextureBlendMode,
  BrushTipPlayMode,
  DualBrushBlendMode,
  DualTipShape,
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
  dualSpacing?: number;
  dualScatter?: number;
  dualTipDataUrl?: string | null;
  dualBlendMode?: DualBrushBlendMode;
  dualTipShape?: DualTipShape;
  tipUrls?: string[];
  tipPlayMode?: BrushTipPlayMode;
  hueJitter?: number;
  satJitter?: number;
  valJitter?: number;
  fgBgMix?: number;
  colorDynamics?: BrushColorDynamicsConfig;
  tiltSize?: number;
  wetEdges?: boolean;
  wetEdgeStrength?: number;
  wetEdgeWidth?: number;
  wetEdgeDarkness?: number;
  pigmentBlendMode?: PigmentBlendModel;
  pigmentStrength?: number;
  chargeDepletion?: number;
  dynamics?: BrushDynamicsConfig;
  sourceFormat?: 'abr' | 'sut' | 'procreate';
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

    interface SampleRecord {
      uuid: string;
      index: number;
      width: number;
      height: number;
      dataUrl: string;
    }

    const samplesByUuid = new Map<string, SampleRecord>();
    const sampleList: SampleRecord[] = [];
    const patternsById = new Map<string, string>();
    const descBlocks: Array<{ start: number; end: number }> = [];

    let sampleIndex = 0;
    for (let section = 4; section + 12 <= this.buffer.length;) {
      if (this.view.getUint32(section, false) !== 0x3842494d) break; // 8BIM
      const type = this.view.getUint32(section + 4, false);
      const length = this.view.getUint32(section + 8, false);
      const start = section + 12;
      const end = start + length;
      if (end > this.buffer.length) break;
      // Advance to next 8BIM block (handle both unpadded and 4-byte padded lengths)
      let nextSection = end;
      if (nextSection + 4 <= this.buffer.length && this.view.getUint32(nextSection, false) !== 0x3842494d) {
        const padded = start + Math.ceil(length / 4) * 4;
        if (padded + 4 <= this.buffer.length && this.view.getUint32(padded, false) === 0x3842494d) {
          nextSection = padded;
        }
      }
      section = nextSection;

      if (type === 0x73616d70) {
        // samp: Sampled brush bitmaps
        for (let offset = start; offset + 4 <= end;) {
          const size = this.view.getUint32(offset, false);
          const record = offset + 4;
          const sampleEnd = record + size;
          if (!size || sampleEnd > end) break;
          offset = record + Math.ceil(size / 4) * 4;
          sampleIndex++;

          // First 37 bytes hold a Pascal string UUID (length byte + ASCII chars)
          const uuid = this.readPascalUuid(record, Math.min(record + 37, sampleEnd));

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
          const rec: SampleRecord = {
            uuid,
            index: sampleIndex,
            width,
            height,
            dataUrl: this.grayscaleToDataUrl(pixels, width, height, false),
          };
          sampleList.push(rec);
          if (uuid) samplesByUuid.set(uuid, rec);
        }
      } else if (type === 0x70617474) {
        // patt: Embedded pattern bitmaps used by brush textures
        this.parsePatternSection(start, end, patternsById);
      } else if (type === 0x64657363) {
        // desc: Photoshop Action Descriptor presets
        descBlocks.push({ start, end });
      }
    }

    const usedSampleUuids = new Set<string>();
    let presetCount = 0;

    for (const block of descBlocks) {
      const root = this.parseDescriptorBlock(block.start, block.end);
      const brushList = root && Array.isArray(root['Brsh']) ? root['Brsh'] : [];
      for (const item of brushList) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        presetCount++;
        const mapped = this.mapDescriptorToPreset(
          item as AbrDescObject,
          presetCount,
          samplesByUuid,
          patternsById,
          usedSampleUuids
        );
        if (mapped) yield mapped;
      }
    }

    // Also emit any sampled tips that were not referenced by a descriptor preset
    for (const sample of sampleList) {
      if (sample.uuid && usedSampleUuids.has(sample.uuid)) continue;
      yield {
        id: `abr_sample_${sample.index}`,
        name: `筆刷尖形 #${sample.index} (${sample.width}x${sample.height})`,
        width: sample.width,
        height: sample.height,
        dataUrl: sample.dataUrl,
        spacing: MIN_BRUSH_SPACING,
        hardness: 0.85,
        sourceFormat: 'abr',
      };
    }
  }

  private readPascalUuid(start: number, limit: number): string {
    if (start >= limit) return '';
    const len = this.buffer[start];
    if (len < 4 || start + 1 + len > limit) return '';
    let out = '';
    for (let i = 0; i < len; i++) {
      const c = this.buffer[start + 1 + i];
      if (c === 0) break;
      if (c >= 32 && c <= 126) out += String.fromCharCode(c);
    }
    return out.trim();
  }

  private parsePatternSection(start: number, end: number, out: Map<string, string>): void {
    let pos = start;
    let safety = 0;
    while (pos + 4 <= end && safety++ < 256) {
      const patLen = this.view.getUint32(pos, false);
      const recStart = pos + 4;
      const recEnd = recStart + patLen;
      if (!patLen || recEnd > end) break;
      pos = recStart + Math.ceil(patLen / 4) * 4;

      // Pattern header: version(4), imageMode(4), height(2), width(2), unicodeName, pascalId
      if (recStart + 16 > recEnd) continue;
      const version = this.view.getUint32(recStart, false);
      if (version !== 1) continue;
      const height = this.view.getUint16(recStart + 8, false);
      const width = this.view.getUint16(recStart + 10, false);
      if (width < 1 || height < 1 || width > 2048 || height > 2048) continue;

      let cursor = recStart + 12;
      if (cursor + 4 > recEnd) continue;
      const nameChars = this.view.getUint32(cursor, false);
      cursor += 4 + nameChars * 2;
      if (cursor + 1 > recEnd) continue;
      const idLen = this.buffer[cursor++];
      if (cursor + idLen > recEnd) continue;
      let patId = '';
      for (let i = 0; i < idLen; i++) {
        const c = this.buffer[cursor + i];
        if (c >= 32 && c <= 126) patId += String.fromCharCode(c);
      }
      cursor += idLen;
      if (!patId) continue;

      // Virtual Memory Array List: version(4), length(4), rect(16), channels(4)
      if (cursor + 28 > recEnd) continue;
      const vmalVersion = this.view.getUint32(cursor, false);
      if (vmalVersion !== 3) continue;
      const top = this.view.getInt32(cursor + 8, false);
      const left = this.view.getInt32(cursor + 12, false);
      const bottom = this.view.getInt32(cursor + 16, false);
      const right = this.view.getInt32(cursor + 20, false);
      const bw = right - left;
      const bh = bottom - top;
      cursor += 28;
      if (bw < 1 || bh < 1 || bw > 2048 || bh > 2048) continue;

      // Read first written channel as grayscale texture mask
      if (cursor + 4 > recEnd) continue;
      const isWritten = this.view.getUint32(cursor, false);
      cursor += 4;
      if (!isWritten || cursor + 4 > recEnd) continue;
      const chanLen = this.view.getUint32(cursor, false);
      cursor += 4;
      const chanEnd = Math.min(recEnd, cursor + chanLen);
      // Channel header: pixelDepth(4), rect(16), pixelDepth2(2), compression(1)
      if (cursor + 23 > chanEnd) continue;
      const depth = this.view.getUint16(cursor + 20, false);
      const compression = this.buffer[cursor + 22];
      const pixels = this.decodeModernSample(cursor + 23, chanEnd, bw, bh, depth, compression);
      if (pixels) {
        out.set(patId, this.grayscaleToDataUrl(pixels, bw, bh, false));
      }
    }
  }

  private parseDescriptorBlock(start: number, end: number): AbrDescObject | null {
    if (start + 4 > end) return null;
    const reader = new AbrDescriptorReader(this.buffer, this.view, start, end);
    // ABR v6 desc block starts with uint32 descriptor version (16)
    const version = reader.readUint32();
    if (version !== 16) return null;
    try {
      return reader.readObject();
    } catch {
      return null;
    }
  }

  private mapDescriptorToPreset(
    preset: AbrDescObject,
    index: number,
    samplesByUuid: Map<string, { uuid: string; index: number; width: number; height: number; dataUrl: string }>,
    patternsById: Map<string, string>,
    usedSampleUuids: Set<string>
  ): ParsedBrushTip | null {
    const rawName = typeof preset['Nm  '] === 'string' ? preset['Nm  '].trim() : '';
    const brsh = asDescObj(preset['Brsh']);
    if (!brsh) return null;

    const sampledUuid = typeof brsh['sampledData'] === 'string' ? brsh['sampledData'].trim() : '';
    const sample = sampledUuid ? samplesByUuid.get(sampledUuid) : undefined;
    if (sample && sample.uuid) usedSampleUuids.add(sample.uuid);

    const diameter = readNumeric(brsh['Dmtr']);
    const hardnessPct = readNumeric(brsh['Hrdn']);
    const angleDeg = readNumeric(brsh['Angl']);
    const roundnessPct = readNumeric(brsh['Rndn']);
    const spacingPct = readNumeric(brsh['Spcn']);

    const size = diameter !== null ? Math.max(1, Math.min(500, Math.round(diameter))) : sample ? Math.min(Math.max(sample.width, 24), 128) : 32;
    const hardness = hardnessPct !== null ? clamp01(hardnessPct / 100) : sample ? 0.85 : 0.8;
    const spacing = spacingPct !== null ? Math.max(MIN_BRUSH_SPACING, Math.min(1.5, spacingPct / 100)) : MIN_BRUSH_SPACING;
    const roundness = roundnessPct !== null ? Math.max(0.1, Math.min(1, roundnessPct / 100)) : 1;

    const dynamics: BrushDynamicsConfig = {};
    let angleMode: 'direction' | 'pen' | 'fixed' = 'fixed';
    let tiltSize = 0;

    // Shape / Tip Dynamics
    const useTipDyn = preset['useTipDynamics'] === true;
    const szVr = asDescObj(preset['szVr']);
    if (useTipDyn && szVr) {
      const ctrl = parseAbrDynamicControl(szVr);
      const minPct = readNumeric(preset['minimumDiameter']) ?? readNumeric(szVr['Mnm ']) ?? 0;
      dynamics.size = {
        pressure: ctrl.pressure,
        tilt: ctrl.tilt,
        random: ctrl.jitter,
        min: clamp01(minPct / 100),
      };
      if (ctrl.tilt) tiltSize = Math.max(tiltSize, 0.5);
    }

    const angleDyn = asDescObj(preset['angleDynamics']);
    if (useTipDyn && angleDyn) {
      const bVTy = readNumeric(angleDyn['bVTy']) ?? 0;
      const jitter = clamp01((readNumeric(angleDyn['jitter']) ?? 0) / 100);
      if (bVTy === 6 || bVTy === 7) angleMode = 'direction';
      else if (bVTy === 3 || bVTy === 4 || bVTy === 5) angleMode = 'pen';
      if (jitter > 0 || bVTy === 2 || bVTy === 3) {
        dynamics.angle = {
          pressure: bVTy === 2,
          tilt: bVTy === 3,
          random: jitter,
        };
      }
    }

    // Transfer / Paint Dynamics (Opacity & Flow)
    const usePaintDyn = preset['usePaintDynamics'] === true;
    const opVr = asDescObj(preset['opVr']);
    const prVr = asDescObj(preset['prVr']);
    if (usePaintDyn && opVr) {
      const ctrl = parseAbrDynamicControl(opVr);
      const minPct = readNumeric(opVr['Mnm ']) ?? 0;
      dynamics.opacity = {
        pressure: ctrl.pressure,
        tilt: ctrl.tilt,
        random: ctrl.jitter,
        min: clamp01(minPct / 100),
      };
    } else {
      // Explicit off when ABR preset disables Transfer opacity dynamics
      dynamics.opacity = { pressure: false, min: 0 };
    }
    if (usePaintDyn && prVr) {
      const ctrl = parseAbrDynamicControl(prVr);
      const minPct = readNumeric(prVr['Mnm ']) ?? 0;
      dynamics.flow = {
        pressure: ctrl.pressure,
        tilt: ctrl.tilt,
        random: ctrl.jitter,
        min: clamp01(minPct / 100),
      };
    }

    // Scattering
    let scatter = 0;
    if (preset['useScatter'] === true) {
      const sctr = readNumeric(preset['Sctr']) ?? 0;
      scatter = clamp01(sctr / 100);
      const scatterDyn = asDescObj(preset['scatterDynamics']);
      if (scatterDyn) {
        const ctrl = parseAbrDynamicControl(scatterDyn);
        dynamics.scatter = {
          pressure: ctrl.pressure,
          tilt: ctrl.tilt,
          random: ctrl.jitter,
        };
      }
    }

    // Texture
    let textureDensity = 0;
    let textureScale = 1;
    let textureInvert = false;
    let textureBlendMode: BrushTextureBlendMode = 'subtract';
    let textureDataUrl: string | null = null;
    if (preset['useTexture'] === true) {
      const depth = readNumeric(preset['textureDepth']) ?? 100;
      const scale = readNumeric(preset['textureScale']) ?? 100;
      textureDensity = clamp01(depth / 100);
      textureScale = Math.max(0.5, Math.min(4, scale / 100));
      textureInvert = preset['InvT'] === true;
      const modeEnum = typeof preset['textureBlendMode'] === 'string' ? preset['textureBlendMode'] : '';
      if (/mltp/i.test(modeEnum)) textureBlendMode = 'multiply';
      else if (/ovrl|hrdl|sftl/i.test(modeEnum)) textureBlendMode = 'overlay';
      else textureBlendMode = 'subtract';
      const txtr = asDescObj(preset['Txtr']);
      const patId = txtr && typeof txtr['Idnt'] === 'string' ? txtr['Idnt'].trim() : '';
      if (patId && patternsById.has(patId)) {
        textureDataUrl = patternsById.get(patId) ?? null;
      }
    }

    // Dual Brush
    let dualBrush = false;
    let dualSize = 0.4;
    let dualScatter = 0.6;
    let dualTipDataUrl: string | null = null;
    let dualBlendMode: DualBrushBlendMode = 'multiply';
    const dualObj = asDescObj(preset['dualBrush']);
    if (dualObj && dualObj['useDualBrush'] === true) {
      dualBrush = true;
      const dBrsh = asDescObj(dualObj['Brsh']);
      const dDmtr = dBrsh ? readNumeric(dBrsh['Dmtr']) : null;
      if (dDmtr !== null && size > 0) {
        dualSize = Math.max(0.1, Math.min(1, dDmtr / size));
      }
      const dSctr = readNumeric(dualObj['Sctr']);
      if (dSctr !== null) dualScatter = Math.max(0, Math.min(2, dSctr / 100));
      const dUuid = dBrsh && typeof dBrsh['sampledData'] === 'string' ? dBrsh['sampledData'].trim() : '';
      const dSample = dUuid ? samplesByUuid.get(dUuid) : undefined;
      if (dSample) dualTipDataUrl = dSample.dataUrl;
      const blnM = typeof dualObj['BlnM'] === 'string' ? dualObj['BlnM'] : '';
      if (/sbtr/i.test(blnM)) dualBlendMode = 'subtract';
      else if (/drkn/i.test(blnM)) dualBlendMode = 'darken';
      else dualBlendMode = 'multiply';
    }

    // Color Dynamics
    let hueJitter = 0;
    let satJitter = 0;
    let valJitter = 0;
    let fgBgMix = 0;
    if (preset['useColorDynamics'] === true) {
      hueJitter = clamp01((readNumeric(preset['H']) ?? readNumeric(preset['hueJitter']) ?? 0) / 100);
      satJitter = clamp01((readNumeric(preset['Strt']) ?? readNumeric(preset['saturationJitter']) ?? 0) / 100);
      valJitter = clamp01((readNumeric(preset['Brgh']) ?? readNumeric(preset['brightnessJitter']) ?? 0) / 100);
      const fgBg = asDescObj(preset['foregroundBackgroundLength']) ?? asDescObj(preset['clVr']);
      if (fgBg) {
        const ctrl = parseAbrDynamicControl(fgBg);
        fgBgMix = ctrl.pressure || ctrl.tilt ? Math.max(0.5, ctrl.jitter) : ctrl.jitter;
        dynamics.colorMix = {
          pressure: ctrl.pressure,
          tilt: ctrl.tilt,
          random: ctrl.jitter,
        };
      }
    }

    const wetEdges = preset['wetEdges'] === true;

    return {
      id: `abr_preset_${index}`,
      name: rawName || (sample ? `ABR 筆刷 #${index} (${sample.width}x${sample.height})` : `ABR 筆刷 #${index}`),
      width: sample?.width ?? size,
      height: sample?.height ?? size,
      dataUrl: sample?.dataUrl ?? null,
      size,
      spacing,
      hardness,
      angle: angleDeg !== null ? Math.max(-90, Math.min(90, Math.round(angleDeg))) : 0,
      roundness,
      angleMode,
      scatter,
      textureDensity,
      textureScale,
      textureInvert,
      textureBlendMode,
      textureDataUrl,
      dualBrush,
      dualSize,
      dualScatter,
      dualTipDataUrl,
      dualBlendMode,
      hueJitter,
      satJitter,
      valJitter,
      fgBgMix,
      tiltSize,
      wetEdges,
      dynamics,
      sourceFormat: 'abr',
    };
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

type AbrDescValue =
  | null
  | boolean
  | number
  | string
  | AbrDescObject
  | AbrDescValue[];

interface AbrDescObject {
  [key: string]: AbrDescValue;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

function asDescObj(v: AbrDescValue | undefined): AbrDescObject | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AbrDescObject) : null;
}

function readNumeric(v: AbrDescValue | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Decodes Photoshop brVr (Brush Variation) control block:
 * bVTy: 0=Off, 1=Fade, 2=Pen Pressure, 3=Pen Tilt, 4=Stylus Wheel, 5=Rotation, 6=Direction
 */
function parseAbrDynamicControl(vr: AbrDescObject): { pressure: boolean; tilt: boolean; jitter: number } {
  const bVTy = readNumeric(vr['bVTy']) ?? 0;
  const jitter = clamp01((readNumeric(vr['jitter']) ?? 0) / 100);
  return {
    pressure: bVTy === 2,
    tilt: bVTy === 3 || bVTy === 4,
    jitter,
  };
}

/**
 * Pure-TS Adobe Action Descriptor (Objc) binary reader for ABR v6+ `desc` blocks.
 */
class AbrDescriptorReader {
  private pos: number;

  constructor(
    private buf: Uint8Array,
    private view: DataView,
    start: number,
    private end: number
  ) {
    this.pos = start;
  }

  public readUint32(): number {
    if (this.pos + 4 > this.end) throw new Error('ABR descriptor EOF');
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  private readInt32(): number {
    if (this.pos + 4 > this.end) throw new Error('ABR descriptor EOF');
    const v = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return v;
  }

  private readFloat64(): number {
    if (this.pos + 8 > this.end) throw new Error('ABR descriptor EOF');
    const v = this.view.getFloat64(this.pos, false);
    this.pos += 8;
    return v;
  }

  private readFourCC(): string {
    if (this.pos + 4 > this.end) throw new Error('ABR descriptor EOF');
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.buf[this.pos + i]);
    this.pos += 4;
    return s;
  }

  private readStringId(): string {
    const len = this.readUint32();
    const byteLen = len === 0 ? 4 : len;
    if (byteLen > 4096 || this.pos + byteLen > this.end) throw new Error('ABR descriptor invalid ID');
    let s = '';
    for (let i = 0; i < byteLen; i++) s += String.fromCharCode(this.buf[this.pos + i]);
    this.pos += byteLen;
    return s;
  }

  private readUnicodeString(): string {
    const chars = this.readUint32();
    const byteLen = chars * 2;
    if (chars > 65536 || this.pos + byteLen > this.end) throw new Error('ABR descriptor invalid Unicode');
    let s = '';
    for (let i = 0; i < chars; i++) {
      const code = this.view.getUint16(this.pos + i * 2, false);
      if (code === 0) continue;
      s += String.fromCharCode(code);
    }
    this.pos += byteLen;
    return s;
  }

  public readObject(depth = 0): AbrDescObject {
    if (depth > 16) throw new Error('ABR descriptor max depth exceeded');
    this.readUnicodeString(); // descriptor display name
    this.readStringId(); // classID
    const count = this.readUint32();
    if (count > 2048) throw new Error('ABR descriptor item count too large');
    const obj: AbrDescObject = {};
    for (let i = 0; i < count && this.pos < this.end; i++) {
      const key = this.readStringId();
      const type = this.readFourCC();
      obj[key] = this.readTypedValue(type, depth + 1);
    }
    return obj;
  }

  private readTypedValue(type: string, depth: number): AbrDescValue {
    switch (type) {
      case 'Objc':
      case 'GlbO':
        return this.readObject(depth);
      case 'VlLs': {
        const count = this.readUint32();
        if (count > 4096) throw new Error('ABR descriptor list too large');
        const list: AbrDescValue[] = [];
        for (let i = 0; i < count && this.pos < this.end; i++) {
          const itemType = this.readFourCC();
          list.push(this.readTypedValue(itemType, depth + 1));
        }
        return list;
      }
      case 'doub':
        return this.readFloat64();
      case 'UntF':
        this.readFourCC(); // unit (#Pxl, #Prc, #Ang, #Nne)
        return this.readFloat64();
      case 'TEXT':
        return this.readUnicodeString();
      case 'enum': {
        this.readStringId(); // typeID
        return this.readStringId(); // valueID
      }
      case 'long':
        return this.readInt32();
      case 'comp': {
        const hi = this.readInt32();
        const lo = this.readUint32();
        return hi * 0x100000000 + lo;
      }
      case 'bool': {
        if (this.pos + 1 > this.end) throw new Error('ABR descriptor EOF');
        return this.buf[this.pos++] !== 0;
      }
      case 'type':
      case 'GlbC': {
        this.readUnicodeString();
        return this.readStringId();
      }
      case 'alis':
      case 'tdta':
      case 'Pth ': {
        const len = this.readUint32();
        if (this.pos + len > this.end) throw new Error('ABR descriptor EOF');
        this.pos += len;
        return null;
      }
      case 'obj ': {
        const count = this.readUint32();
        for (let i = 0; i < count && this.pos < this.end; i++) {
          const refType = this.readFourCC();
          if (refType === 'prop') {
            this.readUnicodeString();
            this.readStringId();
            this.readStringId();
          } else if (refType === 'Clss') {
            this.readUnicodeString();
            this.readStringId();
          } else if (refType === 'Enmr') {
            this.readUnicodeString();
            this.readStringId();
            this.readStringId();
            this.readStringId();
          } else if (refType === 'rele') {
            this.readUnicodeString();
            this.readStringId();
            this.readInt32();
          } else if (refType === 'Idnt' || refType === 'indx') {
            this.readInt32();
          } else if (refType === 'name') {
            this.readUnicodeString();
          } else {
            throw new Error(`Unsupported ABR reference type: ${refType}`);
          }
        }
        return null;
      }
      default:
        throw new Error(`Unsupported ABR descriptor type: ${type}`);
    }
  }
}
