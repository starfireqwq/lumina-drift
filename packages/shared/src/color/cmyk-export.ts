/**
 * Phase 6.2: True 4-channel CMYK binary encoders for Baseline TIFF 6.0 and Adobe Photoshop PSD.
 *
 * Ink polarity conventions:
 * - TIFF (PhotometricInterpretation = 5, InkSet = 1): 0 = 0% ink (paper white), 255 = 100% ink.
 * - PSD (ColorMode = 4 CMYK): Adobe stores CMYK channels inverted (255 = 0% ink, 0 = 100% ink).
 */

export interface CmykTiffEncodeOptions {
  dpi?: number;
  compression?: 'packbits' | 'none';
  iccProfile?: Uint8Array | null;
}

export interface CmykTiffInspection {
  littleEndian: boolean;
  width: number;
  height: number;
  samplesPerPixel: number;
  photometric: number;
  inkSet: number;
  bitsPerSample: number[];
  compression: number;
  planarConfiguration: number;
  dpiX: number;
  dpiY: number;
  hasIccProfile: boolean;
  iccProfileBytes: number;
  stripCount: number;
  decodePixels: () => Uint8Array;
}

export interface CmykPsdLayerInput {
  name: string;
  /** Interleaved CMYK bytes (length = width * height * 4, 0 = 0% ink, 255 = 100% ink) */
  cmyk: Uint8Array;
  /** Optional 8-bit alpha channel (length = width * height, 255 = opaque) */
  alpha?: Uint8Array;
  width: number;
  height: number;
  opacity?: number;
  visible?: boolean;
  /** 4-char Photoshop blend mode key, e.g. 'norm', 'mul ', 'scrn' */
  blendModeKey?: string;
}

export interface CmykPsdEncodeOptions {
  dpi?: number;
  compression?: 'rle' | 'raw';
  iccProfile?: Uint8Array | null;
  layers?: CmykPsdLayerInput[];
}

export interface CmykPsdInspection {
  signature: string;
  version: number;
  channels: number;
  width: number;
  height: number;
  depth: number;
  colorMode: number;
  hasIccProfile: boolean;
  iccProfileBytes: number;
  layerCount: number;
  compression: number;
}

/** Standard Apple/Adobe/TIFF PackBits RLE encoder. */
export function packBitsEncode(src: Uint8Array): Uint8Array {
  const len = src.length;
  if (len === 0) return new Uint8Array(0);
  // Worst case is ~129/128 expansion + 2 bytes
  const out = new Uint8Array(len + Math.ceil(len / 128) + 8);
  let i = 0;
  let o = 0;

  while (i < len) {
    // Check for run of >= 3 identical bytes
    let runLen = 1;
    while (i + runLen < len && runLen < 128 && src[i + runLen] === src[i]) {
      runLen++;
    }
    if (runLen >= 3) {
      out[o++] = (257 - runLen) & 0xff; // -(runLen - 1) as int8
      out[o++] = src[i];
      i += runLen;
    } else {
      // Literal run until a 3-byte repeat or 128 bytes
      const litStart = i;
      let litLen = 0;
      while (i < len && litLen < 128) {
        if (i + 2 < len && src[i] === src[i + 1] && src[i] === src[i + 2]) {
          break;
        }
        i++;
        litLen++;
      }
      if (litLen === 0) {
        litLen = Math.min(2, len - i);
        i += litLen;
      }
      out[o++] = litLen - 1;
      out.set(src.subarray(litStart, litStart + litLen), o);
      o += litLen;
    }
  }
  return out.subarray(0, o);
}

/** Standard Apple/Adobe/TIFF PackBits RLE decoder. */
export function packBitsDecode(src: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let i = 0;
  let o = 0;
  while (i < src.length && o < expectedLength) {
    const header = src[i++];
    if (header <= 127) {
      const count = header + 1;
      const copyLen = Math.min(count, expectedLength - o, src.length - i);
      out.set(src.subarray(i, i + copyLen), o);
      i += count;
      o += copyLen;
    } else if (header !== 128) {
      const count = 257 - header;
      const val = src[i++] ?? 0;
      const fillLen = Math.min(count, expectedLength - o);
      out.fill(val, o, o + fillLen);
      o += fillLen;
    }
  }
  return out;
}

/**
 * Encodes interleaved 8-bit CMYK pixels (`0 = 0% ink, 255 = 100% ink`) as a Baseline TIFF 6.0 file.
 */
export function encodeCmykTiff(
  cmyk: Uint8Array,
  width: number,
  height: number,
  options: CmykTiffEncodeOptions = {}
): Uint8Array {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const expectedBytes = w * h * 4;
  if (cmyk.length < expectedBytes) {
    throw new Error(`CMYK buffer too small: expected ${expectedBytes}, got ${cmyk.length}`);
  }

  const dpi = Math.max(1, Math.round(options.dpi || 300));
  const usePackBits = options.compression !== 'none';
  const icc = options.iccProfile && options.iccProfile.byteLength > 0 ? options.iccProfile : null;

  const rowsPerStrip = Math.min(h, Math.max(1, Math.floor(65536 / Math.max(1, w * 4)) || 16));
  const strips: Uint8Array[] = [];
  for (let row = 0; row < h; row += rowsPerStrip) {
    const stripRows = Math.min(rowsPerStrip, h - row);
    const slice = cmyk.subarray(row * w * 4, (row + stripRows) * w * 4);
    strips.push(usePackBits ? packBitsEncode(slice) : slice);
  }

  interface TiffTagEntry {
    tag: number;
    type: number; // 1=BYTE, 3=SHORT, 4=LONG, 5=RATIONAL, 7=UNDEFINED
    count: number;
    inlineValue?: number;
    externalData?: Uint8Array;
  }

  const bitsPerSampleBytes = new Uint8Array(8);
  const bpsView = new DataView(bitsPerSampleBytes.buffer);
  for (let i = 0; i < 4; i++) bpsView.setUint16(i * 2, 8, true);

  const dpiRational = new Uint8Array(8);
  const dpiView = new DataView(dpiRational.buffer);
  dpiView.setUint32(0, dpi, true);
  dpiView.setUint32(4, 1, true);

  const stripCount = strips.length;
  const stripCountsBytes = new Uint8Array(stripCount * 4);
  const stripCountsView = new DataView(stripCountsBytes.buffer);
  for (let i = 0; i < stripCount; i++) {
    stripCountsView.setUint32(i * 4, strips[i].byteLength, true);
  }

  const stripOffsetsPlaceholder = new Uint8Array(stripCount * 4);

  const entries: TiffTagEntry[] = [
    { tag: 256, type: 4, count: 1, inlineValue: w }, // ImageWidth
    { tag: 257, type: 4, count: 1, inlineValue: h }, // ImageLength
    { tag: 258, type: 3, count: 4, externalData: bitsPerSampleBytes }, // BitsPerSample = [8,8,8,8]
    { tag: 259, type: 3, count: 1, inlineValue: usePackBits ? 32773 : 1 }, // Compression
    { tag: 262, type: 3, count: 1, inlineValue: 5 }, // PhotometricInterpretation = Separated (CMYK)
    {
      tag: 273, // StripOffsets
      type: 4,
      count: stripCount,
      ...(stripCount === 1 ? { inlineValue: 0 } : { externalData: stripOffsetsPlaceholder }),
    },
    { tag: 277, type: 3, count: 1, inlineValue: 4 }, // SamplesPerPixel = 4
    { tag: 278, type: 4, count: 1, inlineValue: rowsPerStrip }, // RowsPerStrip
    {
      tag: 279, // StripByteCounts
      type: 4,
      count: stripCount,
      ...(stripCount === 1 ? { inlineValue: strips[0].byteLength } : { externalData: stripCountsBytes }),
    },
    { tag: 282, type: 5, count: 1, externalData: dpiRational }, // XResolution
    { tag: 283, type: 5, count: 1, externalData: dpiRational }, // YResolution
    { tag: 284, type: 3, count: 1, inlineValue: 1 }, // PlanarConfiguration = Chunky
    { tag: 296, type: 3, count: 1, inlineValue: 2 }, // ResolutionUnit = Inch
    { tag: 332, type: 3, count: 1, inlineValue: 1 }, // InkSet = CMYK
  ];

  if (icc) {
    entries.push({ tag: 34675, type: 7, count: icc.byteLength, externalData: icc });
  }

  // TIFF spec requires IFD entries sorted in ascending tag order
  entries.sort((a, b) => a.tag - b.tag);

  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let dataCursor = ifdOffset + ifdSize;
  const aligned = (n: number) => (n + 1) & ~1;

  // Assign offsets for external tag values
  const entryOffsets = new Map<number, number>();
  for (const e of entries) {
    if (e.externalData) {
      dataCursor = aligned(dataCursor);
      entryOffsets.set(e.tag, dataCursor);
      dataCursor += e.externalData.byteLength;
    }
  }

  // Assign offsets for image strips
  const stripOffsets: number[] = [];
  for (const s of strips) {
    dataCursor = aligned(dataCursor);
    stripOffsets.push(dataCursor);
    dataCursor += s.byteLength;
  }

  const totalSize = aligned(dataCursor);
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  // Header: Little-endian ("II"), magic 42, first IFD offset = 8
  out[0] = 0x49;
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);

  // Fill StripOffsets
  if (stripCount === 1) {
    const stripTag = entries.find((e) => e.tag === 273)!;
    stripTag.inlineValue = stripOffsets[0];
  } else {
    const soView = new DataView(stripOffsetsPlaceholder.buffer);
    for (let i = 0; i < stripCount; i++) {
      soView.setUint32(i * 4, stripOffsets[i], true);
    }
  }

  // Write IFD
  view.setUint16(ifdOffset, entries.length, true);
  let pos = ifdOffset + 2;
  for (const e of entries) {
    view.setUint16(pos, e.tag, true);
    view.setUint16(pos + 2, e.type, true);
    view.setUint32(pos + 4, e.count, true);
    if (e.externalData) {
      const extOff = entryOffsets.get(e.tag)!;
      view.setUint32(pos + 8, extOff, true);
      out.set(e.externalData, extOff);
    } else if (e.type === 3 && e.count === 1) {
      view.setUint16(pos + 8, e.inlineValue ?? 0, true);
      view.setUint16(pos + 10, 0, true);
    } else {
      view.setUint32(pos + 8, e.inlineValue ?? 0, true);
    }
    pos += 12;
  }
  view.setUint32(pos, 0, true); // Next IFD = 0

  // Write strips
  for (let i = 0; i < strips.length; i++) {
    out.set(strips[i], stripOffsets[i]);
  }

  return out;
}

/** Parses and verifies a Baseline CMYK TIFF header and exposes pixel decoding for round-trip tests. */
export function inspectCmykTiff(bytes: Uint8Array): CmykTiffInspection {
  if (bytes.byteLength < 16) throw new Error('Invalid TIFF: truncated header');
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!le && !be) throw new Error('Invalid TIFF byte order marker');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint16(2, le);
  if (magic !== 42) throw new Error(`Invalid TIFF magic: ${magic}`);
  const ifdOff = view.getUint32(4, le);
  const numEntries = view.getUint16(ifdOff, le);

  let width = 0;
  let height = 0;
  let samplesPerPixel = 0;
  let photometric = 0;
  let inkSet = 0;
  let compression = 1;
  let planarConfiguration = 1;
  let dpiX = 72;
  let dpiY = 72;
  let bitsPerSample: number[] = [];
  let stripOffsets: number[] = [];
  let stripByteCounts: number[] = [];
  let iccProfileBytes = 0;

  const readScalar = (type: number, offset: number): number => {
    if (type === 3) return view.getUint16(offset, le);
    if (type === 4) return view.getUint32(offset, le);
    return view.getUint8(offset);
  };

  for (let i = 0; i < numEntries; i++) {
    const base = ifdOff + 2 + i * 12;
    const tag = view.getUint16(base, le);
    const type = view.getUint16(base + 2, le);
    const count = view.getUint32(base + 4, le);
    const valOff = base + 8;
    const ptr = view.getUint32(valOff, le);

    if (tag === 256) width = readScalar(type, valOff);
    else if (tag === 257) height = readScalar(type, valOff);
    else if (tag === 258) {
      bitsPerSample = [];
      const src = count * 2 <= 4 ? valOff : ptr;
      for (let k = 0; k < count; k++) bitsPerSample.push(view.getUint16(src + k * 2, le));
    } else if (tag === 259) compression = readScalar(type, valOff);
    else if (tag === 262) photometric = readScalar(type, valOff);
    else if (tag === 273) {
      stripOffsets = [];
      if (count === 1) stripOffsets.push(readScalar(type, valOff));
      else {
        const step = type === 3 ? 2 : 4;
        for (let k = 0; k < count; k++) stripOffsets.push(readScalar(type, ptr + k * step));
      }
    } else if (tag === 277) samplesPerPixel = readScalar(type, valOff);
    else if (tag === 279) {
      stripByteCounts = [];
      if (count === 1) stripByteCounts.push(readScalar(type, valOff));
      else {
        const step = type === 3 ? 2 : 4;
        for (let k = 0; k < count; k++) stripByteCounts.push(readScalar(type, ptr + k * step));
      }
    } else if (tag === 282) {
      const num = view.getUint32(ptr, le);
      const den = view.getUint32(ptr + 4, le) || 1;
      dpiX = num / den;
    } else if (tag === 283) {
      const num = view.getUint32(ptr, le);
      const den = view.getUint32(ptr + 4, le) || 1;
      dpiY = num / den;
    } else if (tag === 284) planarConfiguration = readScalar(type, valOff);
    else if (tag === 332) inkSet = readScalar(type, valOff);
    else if (tag === 34675) iccProfileBytes = count;
  }

  return {
    littleEndian: le,
    width,
    height,
    samplesPerPixel,
    photometric,
    inkSet,
    bitsPerSample,
    compression,
    planarConfiguration,
    dpiX,
    dpiY,
    hasIccProfile: iccProfileBytes > 0,
    iccProfileBytes,
    stripCount: stripOffsets.length,
    decodePixels: () => {
      const total = width * height * samplesPerPixel;
      const out = new Uint8Array(total);
      let cursor = 0;
      for (let i = 0; i < stripOffsets.length; i++) {
        const rawSlice = bytes.subarray(stripOffsets[i], stripOffsets[i] + stripByteCounts[i]);
        const remaining = total - cursor;
        const decoded = compression === 32773 ? packBitsDecode(rawSlice, remaining) : rawSlice;
        const copyLen = Math.min(decoded.length, remaining);
        out.set(decoded.subarray(0, copyLen), cursor);
        cursor += copyLen;
      }
      return out;
    },
  };
}

class BinaryWriter {
  private buf: Uint8Array;
  private view: DataView;
  public offset = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number) {
    const needed = this.offset + extra;
    if (needed <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < needed) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.offset));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeUint8(v: number) {
    this.ensure(1);
    this.buf[this.offset++] = v & 0xff;
  }

  writeInt16BE(v: number) {
    this.ensure(2);
    this.view.setInt16(this.offset, v, false);
    this.offset += 2;
  }

  writeUint16BE(v: number) {
    this.ensure(2);
    this.view.setUint16(this.offset, v, false);
    this.offset += 2;
  }

  writeUint32BE(v: number) {
    this.ensure(4);
    this.view.setUint32(this.offset, v >>> 0, false);
    this.offset += 4;
  }

  writeAscii(str: string) {
    this.ensure(str.length);
    for (let i = 0; i < str.length; i++) {
      this.buf[this.offset++] = str.charCodeAt(i) & 0xff;
    }
  }

  writeBytes(data: Uint8Array) {
    this.ensure(data.byteLength);
    this.buf.set(data, this.offset);
    this.offset += data.byteLength;
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.offset);
  }
}

function writePsdImageResource(w: BinaryWriter, resourceId: number, payload: Uint8Array) {
  w.writeAscii('8BIM');
  w.writeUint16BE(resourceId);
  w.writeUint16BE(0); // empty Pascal string name (padded to 2 bytes)
  w.writeUint32BE(payload.byteLength);
  w.writeBytes(payload);
  if (payload.byteLength % 2 === 1) w.writeUint8(0);
}

function encodePlanarChannelRle(
  plane: Uint8Array,
  width: number,
  height: number
): { rowLengths: Uint16Array; encodedRows: Uint8Array[] } {
  const rowLengths = new Uint16Array(height);
  const encodedRows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = plane.subarray(y * width, (y + 1) * width);
    const rle = packBitsEncode(row);
    rowLengths[y] = rle.byteLength;
    encodedRows.push(rle);
  }
  return { rowLengths, encodedRows };
}

function extractInvertedCmykPlanes(cmyk: Uint8Array, width: number, height: number): Uint8Array[] {
  const pxCount = width * height;
  const planes = [
    new Uint8Array(pxCount),
    new Uint8Array(pxCount),
    new Uint8Array(pxCount),
    new Uint8Array(pxCount),
  ];
  for (let i = 0; i < pxCount; i++) {
    const p = i * 4;
    // Adobe PSD CMYK convention: 255 = 0% ink, 0 = 100% ink
    planes[0][i] = 255 - cmyk[p];
    planes[1][i] = 255 - cmyk[p + 1];
    planes[2][i] = 255 - cmyk[p + 2];
    planes[3][i] = 255 - cmyk[p + 3];
  }
  return planes;
}

/**
 * Encodes a true 4-channel CMYK Adobe Photoshop PSD (`8BPS`, ColorMode = 4, 8-bit/channel).
 * Preserves exact GCR/UCR + TAC separation values without re-converting through RGB.
 */
export function encodeCmykPsd(
  compositeCmyk: Uint8Array,
  width: number,
  height: number,
  options: CmykPsdEncodeOptions = {}
): Uint8Array {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (compositeCmyk.length < w * h * 4) {
    throw new Error(`Composite CMYK buffer too small: expected ${w * h * 4}, got ${compositeCmyk.length}`);
  }

  const dpi = Math.max(1, Math.round(options.dpi || 300));
  const useRle = options.compression !== 'raw';
  const icc = options.iccProfile && options.iccProfile.byteLength > 0 ? options.iccProfile : null;
  const layers = options.layers && options.layers.length > 0 ? options.layers : [];

  const writer = new BinaryWriter(w * h * 2 + 4096);

  // 1. File Header (26 bytes)
  writer.writeAscii('8BPS');
  writer.writeUint16BE(1); // PSD version 1
  writer.writeUint32BE(0);
  writer.writeUint16BE(0); // 6 reserved zero bytes
  writer.writeUint16BE(4); // 4 channels: C, M, Y, K
  writer.writeUint32BE(h); // Height
  writer.writeUint32BE(w); // Width
  writer.writeUint16BE(8); // 8 bits per channel
  writer.writeUint16BE(4); // ColorMode = 4 (CMYK)

  // 2. Color Mode Data Section (empty for CMYK)
  writer.writeUint32BE(0);

  // 3. Image Resources Section (DPI 0x03ED + optional ICC 0x040F)
  const resources = new BinaryWriter(256 + (icc ? icc.byteLength : 0));
  const resInfo = new Uint8Array(16);
  const resView = new DataView(resInfo.buffer);
  resView.setUint32(0, (dpi << 16) >>> 0, false); // Fixed 16.16 hRes
  resView.setUint16(4, 1, false); // hResUnit = pixels/inch
  resView.setUint16(6, 1, false); // widthUnit = inches
  resView.setUint32(8, (dpi << 16) >>> 0, false); // Fixed 16.16 vRes
  resView.setUint16(12, 1, false); // vResUnit = pixels/inch
  resView.setUint16(14, 1, false); // heightUnit = inches
  writePsdImageResource(resources, 0x03ed, resInfo);
  if (icc) {
    writePsdImageResource(resources, 0x040f, icc);
  }
  const resourcesBytes = resources.toUint8Array();
  writer.writeUint32BE(resourcesBytes.byteLength);
  writer.writeBytes(resourcesBytes);

  // 4. Layer and Mask Information Section
  if (layers.length === 0) {
    writer.writeUint32BE(0);
  } else {
    const layerInfo = new BinaryWriter(4096);
    layerInfo.writeInt16BE(layers.length);

    interface EncodedLayerChannels {
      channels: Array<{ id: number; payload: Uint8Array }>;
    }
    const encodedAllLayers: EncodedLayerChannels[] = [];

    for (const layer of layers) {
      const lw = Math.max(1, Math.round(layer.width));
      const lh = Math.max(1, Math.round(layer.height));
      const planes = extractInvertedCmykPlanes(layer.cmyk, lw, lh);
      const chDefs: Array<{ id: number; data: Uint8Array }> = [
        { id: 0, data: planes[0] },
        { id: 1, data: planes[1] },
        { id: 2, data: planes[2] },
        { id: 3, data: planes[3] },
      ];
      if (layer.alpha && layer.alpha.length >= lw * lh) {
        chDefs.unshift({ id: -1, data: layer.alpha.subarray(0, lw * lh) });
      }

      const encodedChannels: Array<{ id: number; payload: Uint8Array }> = [];
      for (const ch of chDefs) {
        const chW = new BinaryWriter(lw * lh + 16);
        if (useRle) {
          chW.writeUint16BE(1); // RLE
          const { rowLengths, encodedRows } = encodePlanarChannelRle(ch.data, lw, lh);
          for (let y = 0; y < lh; y++) chW.writeUint16BE(rowLengths[y]);
          for (const row of encodedRows) chW.writeBytes(row);
        } else {
          chW.writeUint16BE(0); // Raw
          chW.writeBytes(ch.data);
        }
        encodedChannels.push({ id: ch.id, payload: chW.toUint8Array() });
      }
      encodedAllLayers.push({ channels: encodedChannels });

      // Layer record
      layerInfo.writeUint32BE(0); // top
      layerInfo.writeUint32BE(0); // left
      layerInfo.writeUint32BE(lh); // bottom
      layerInfo.writeUint32BE(lw); // right
      layerInfo.writeUint16BE(encodedChannels.length);
      for (const ec of encodedChannels) {
        layerInfo.writeInt16BE(ec.id);
        layerInfo.writeUint32BE(ec.payload.byteLength);
      }
      layerInfo.writeAscii('8BIM');
      const blendKey = (layer.blendModeKey || 'norm').padEnd(4, ' ').slice(0, 4);
      layerInfo.writeAscii(blendKey);
      const opacityByte = Math.max(0, Math.min(255, Math.round((layer.opacity ?? 1) * 255)));
      layerInfo.writeUint8(opacityByte);
      layerInfo.writeUint8(0); // clipping
      const flags = layer.visible === false ? 0x02 : 0x00;
      layerInfo.writeUint8(flags);
      layerInfo.writeUint8(0); // filler

      // Extra data: mask (0) + blending ranges (0) + Pascal layer name (padded to 4 bytes)
      const asciiName = (layer.name || 'Layer').replace(/[^\x20-\x7e]/g, '_').slice(0, 255);
      const nameTotal = Math.ceil((1 + asciiName.length) / 4) * 4;
      const extraLen = 4 + 4 + nameTotal;
      layerInfo.writeUint32BE(extraLen);
      layerInfo.writeUint32BE(0); // layer mask data length
      layerInfo.writeUint32BE(0); // blending ranges length
      layerInfo.writeUint8(asciiName.length);
      layerInfo.writeAscii(asciiName);
      for (let p = 1 + asciiName.length; p < nameTotal; p++) {
        layerInfo.writeUint8(0);
      }
    }

    // Channel image data for each layer in order
    for (const enc of encodedAllLayers) {
      for (const ch of enc.channels) {
        layerInfo.writeBytes(ch.payload);
      }
    }

    const layerInfoBytes = layerInfo.toUint8Array();
    const paddedLayerInfoLen = layerInfoBytes.byteLength + (layerInfoBytes.byteLength % 2);
    // Layer and Mask section = [4B layerInfoLen + layerInfoBytes + pad] + [4B globalMaskLen=0]
    writer.writeUint32BE(4 + paddedLayerInfoLen + 4);
    writer.writeUint32BE(paddedLayerInfoLen);
    writer.writeBytes(layerInfoBytes);
    if (layerInfoBytes.byteLength % 2 === 1) writer.writeUint8(0);
    writer.writeUint32BE(0); // Global layer mask info = 0
  }

  // 5. Merged Image Data Section (4 planar channels: C, M, Y, K, Adobe inverted)
  const compositePlanes = extractInvertedCmykPlanes(compositeCmyk, w, h);
  if (useRle) {
    writer.writeUint16BE(1); // Compression = RLE
    const encodedPlanes = compositePlanes.map((plane) => encodePlanarChannelRle(plane, w, h));
    for (const ep of encodedPlanes) {
      for (let y = 0; y < h; y++) writer.writeUint16BE(ep.rowLengths[y]);
    }
    for (const ep of encodedPlanes) {
      for (const row of ep.encodedRows) writer.writeBytes(row);
    }
  } else {
    writer.writeUint16BE(0); // Compression = Raw
    for (const plane of compositePlanes) {
      writer.writeBytes(plane);
    }
  }

  return writer.toUint8Array();
}

/** Lightweight binary PSD header/section inspector for CMYK PSD verification. */
export function inspectCmykPsd(bytes: Uint8Array): CmykPsdInspection {
  if (bytes.byteLength < 34) throw new Error('Invalid PSD: truncated header');
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, false);
  const channels = view.getUint16(12, false);
  const height = view.getUint32(14, false);
  const width = view.getUint32(18, false);
  const depth = view.getUint16(22, false);
  const colorMode = view.getUint16(24, false);

  let offset = 26;
  const colorModeDataLen = view.getUint32(offset, false);
  offset += 4 + colorModeDataLen;

  const imgResLen = view.getUint32(offset, false);
  offset += 4;
  const imgResEnd = offset + imgResLen;
  let iccProfileBytes = 0;
  let resCursor = offset;
  while (resCursor + 12 <= imgResEnd) {
    const resSig = String.fromCharCode(
      bytes[resCursor],
      bytes[resCursor + 1],
      bytes[resCursor + 2],
      bytes[resCursor + 3]
    );
    if (resSig !== '8BIM') break;
    const resId = view.getUint16(resCursor + 4, false);
    const nameLen = bytes[resCursor + 6];
    const paddedNameLen = nameLen + 1 + ((nameLen + 1) % 2);
    const sizePos = resCursor + 6 + paddedNameLen;
    const dataLen = view.getUint32(sizePos, false);
    if (resId === 0x040f) iccProfileBytes = dataLen;
    resCursor = sizePos + 4 + dataLen + (dataLen % 2);
  }
  offset = imgResEnd;

  const layerMaskLen = view.getUint32(offset, false);
  offset += 4;
  let layerCount = 0;
  if (layerMaskLen > 6) {
    const layerInfoLen = view.getUint32(offset, false);
    if (layerInfoLen >= 2) {
      layerCount = Math.abs(view.getInt16(offset + 4, false));
    }
  }
  offset += layerMaskLen;

  const compression = offset + 2 <= bytes.byteLength ? view.getUint16(offset, false) : -1;

  return {
    signature: sig,
    version,
    channels,
    width,
    height,
    depth,
    colorMode,
    hasIccProfile: iccProfileBytes > 0,
    iccProfileBytes,
    layerCount,
    compression,
  };
}
