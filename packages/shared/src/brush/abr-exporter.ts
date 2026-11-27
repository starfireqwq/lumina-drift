import { resolveDefaultBrushDynamics, type BrushDynamicChannel } from './brush-dynamics';
import type { AtelierBrushPreset } from './brush-package';
import { MIN_BRUSH_SPACING } from './brush-spacing';

/** An 8-bit, row-major mask with 0 for transparent and 255 for solid ink. */
export interface AbrGrayscaleImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface AbrExportOptions {
  /** Overrides the built-in decoder. Return null for an unreadable image. */
  decodeImage?: (dataUrl: string) => Promise<AbrGrayscaleImage | null>;
  /** Longest image side in pixels. Defaults to 2048. */
  maxTipDimension?: number;
}

type Descriptor = { classId: string; entries: Record<string, DescriptorValue> };
type DescriptorValue = boolean | number | string | Descriptor | Descriptor[]
  | { unit: '#Prc' | '#Pxl' | '#Ang'; value: number }
  | { enumType: string; enumValue: string };

// Write sections directly to the file buffer so a pack does not retain every decoded mask.
class AbrWriter {
  private buffer = new Uint8Array(1024);
  private view = new DataView(this.buffer.buffer);
  private offset = 0;

  private reserve(length: number): number {
    const start = this.offset;
    const end = start + length;
    if (end > this.buffer.length) {
      const grown = new Uint8Array(Math.max(end, this.buffer.length * 2));
      grown.set(this.buffer);
      this.buffer = grown;
      this.view = new DataView(grown.buffer);
    }
    this.offset = end;
    return start;
  }

  u8(value: number): void {
    const offset = this.reserve(1);
    this.view.setUint8(offset, value);
  }

  u16(value: number): void {
    const offset = this.reserve(2);
    this.view.setUint16(offset, value);
  }

  u32(value: number): void {
    const offset = this.reserve(4);
    this.view.setUint32(offset, value);
  }

  f64(value: number): void {
    const offset = this.reserve(8);
    this.view.setFloat64(offset, value);
  }

  zeroes(length: number): void {
    this.reserve(length);
  }

  bytes(bytes: Uint8Array): void {
    const offset = this.reserve(bytes.length);
    this.buffer.set(bytes, offset);
  }

  ascii(value: string): void {
    const start = this.reserve(value.length);
    for (let i = 0; i < value.length; i++) this.buffer[start + i] = value.charCodeAt(i);
  }

  unicode(value: string): void {
    this.u32(value ? value.length + 1 : 0);
    if (!value) return;
    for (let i = 0; i < value.length; i++) this.u16(value.charCodeAt(i));
    this.u16(0);
  }

  stringId(value: string): void {
    this.u32(value.length === 4 ? 0 : value.length);
    this.ascii(value);
  }

  pascal(value: string): void {
    this.u8(value.length);
    this.ascii(value);
  }

  startLength(): number { return this.reserve(4); }

  endLength(start: number, padded = false): void {
    const length = this.offset - start - 4;
    if (length > 0xffffffff) throw new Error('ABR block exceeds its 32-bit length field');
    this.view.setUint32(start, length);
    if (padded) this.zeroes((4 - length % 4) % 4);
  }

  startSection(type: string): number {
    this.ascii('8BIM');
    this.ascii(type);
    return this.startLength();
  }

  result(): Uint8Array { return this.buffer.slice(0, this.offset); }
}

function writeDescriptor(writer: AbrWriter, { classId, entries }: Descriptor): void {
  writer.unicode('');
  writer.stringId(classId);
  const items = Object.entries(entries);
  writer.u32(items.length);
  for (const [key, value] of items) {
    writer.stringId(key);
    if (typeof value === 'boolean') {
      writer.ascii('bool');
      writer.u8(Number(value));
    } else if (typeof value === 'number') {
      writer.ascii('long');
      writer.u32(value);
    } else if (typeof value === 'string') {
      writer.ascii('TEXT');
      writer.unicode(value);
    } else if (Array.isArray(value)) {
      writer.ascii('VlLs');
      writer.u32(value.length);
      for (const item of value) {
        writer.ascii('Objc');
        writeDescriptor(writer, item);
      }
    } else if ('unit' in value) {
      writer.ascii('UntF');
      writer.ascii(value.unit);
      writer.f64(value.value);
    } else if ('enumType' in value) {
      writer.ascii('enum');
      writer.stringId(value.enumType);
      writer.stringId(value.enumValue);
    } else {
      writer.ascii('Objc');
      writeDescriptor(writer, value);
    }
  }
}

function uuid(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function repeatLength(row: Uint8Array, start: number): number {
  let end = start + 1;
  while (end < row.length && end - start < 128 && row[end] === row[start]) end++;
  return end - start;
}

function writePackBits(writer: AbrWriter, { width, height, pixels }: AbrGrayscaleImage): void {
  const counts = new Uint8Array(height * 2);
  const countView = new DataView(counts.buffer);
  const encoded = new Uint8Array(height * (width + Math.ceil(width / 128)));
  let output = 0;
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * width, (y + 1) * width);
    const rowStart = output;
    for (let x = 0; x < width;) {
      const repeated = repeatLength(row, x);
      if (repeated >= 3) {
        encoded[output++] = 257 - repeated;
        encoded[output++] = row[x];
        x += repeated;
      } else {
        const start = x++;
        while (x < width && x - start < 128 && repeatLength(row, x) < 3) x++;
        encoded[output++] = x - start - 1;
        encoded.set(row.subarray(start, x), output);
        output += x - start;
      }
    }
    countView.setUint16(y * 2, output - rowStart);
  }
  writer.bytes(counts);
  writer.bytes(encoded.subarray(0, output));
}

function writeRect(writer: AbrWriter, { width, height }: AbrGrayscaleImage): void {
  writer.u32(0);
  writer.u32(0);
  writer.u32(height);
  writer.u32(width);
}

function writeImage(writer: AbrWriter, image: AbrGrayscaleImage): void {
  writeRect(writer, image);
  writer.u16(8);
  writer.u8(1);
  writePackBits(writer, image);
}

function writeSample(writer: AbrWriter, image: AbrGrayscaleImage, id: string): void {
  writer.pascal(id);
  writer.zeroes(264);
  writeImage(writer, image);
}

function writePattern(writer: AbrWriter, image: AbrGrayscaleImage, id: string, name: string): void {
  writer.u32(1);
  writer.u32(1); // Grayscale
  writer.u16(image.height);
  writer.u16(image.width);
  writer.unicode(name);
  writer.pascal(id);

  writer.u32(3);
  const vmal = writer.startLength();
  writeRect(writer, image);
  writer.u32(24);
  writer.u32(1); // First channel is written.
  const channel = writer.startLength();
  writer.u32(8);
  writeImage(writer, image);
  writer.endLength(channel);
  writer.zeroes(23 * 4);
  writer.endLength(vmal);
}

const bounded = (value: number | undefined, fallback: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value !== undefined && Number.isFinite(value) ? value : fallback));
const fraction = (value?: number): number => bounded(value, 0, 0, 1);
const percent = (value: number): DescriptorValue => ({ unit: '#Prc', value: value * 100 });
const blend = (enumValue: string): DescriptorValue => ({ enumType: 'BlnM', enumValue });
const blendModes = { subtract: 'Sbtr', multiply: 'Mltp', overlay: 'Ovrl', darken: 'Drkn', screen: 'Scrn' };

function variation(
  channel?: BrushDynamicChannel,
  control = channel?.pressure ? 2 : channel?.tilt ? 3 : 0,
): Descriptor {
  return {
    classId: 'brVr',
    entries: { bVTy: control, fStp: 25, jitter: percent(fraction(channel?.random)), 'Mnm ': percent(fraction(channel?.min)) },
  };
}

const active = (channel?: BrushDynamicChannel): boolean =>
  !!(channel?.pressure || channel?.tilt || fraction(channel?.random));

function brushShape(
  name: string, id: string | undefined, size: number, angle: number,
  roundness: number, spacing: number, hardness: number,
): Descriptor {
  const entries: Descriptor['entries'] = {
    Dmtr: { unit: '#Pxl', value: size },
    Angl: { unit: '#Ang', value: angle },
    Rndn: percent(roundness),
    Spcn: percent(spacing),
    Intr: true,
    flipX: false,
    flipY: false,
  };
  if (id) {
    entries['Nm  '] = name;
    entries.sampledData = id;
  } else {
    entries.Hrdn = percent(hardness);
  }
  return { classId: id ? 'sampledBrush' : 'computedBrush', entries };
}

function brushDescriptor(
  preset: AtelierBrushPreset, name: string, tip?: string, dual?: string, texture?: { id: string; name: string },
): Descriptor {
  const props = preset.properties;
  const size = bounded(props.size, 32, 1, 500);
  const hardness = bounded(props.hardness, 0.8, 0, 1);
  const spacing = bounded(props.spacing, MIN_BRUSH_SPACING, MIN_BRUSH_SPACING, 1.5);
  const dynamics = { ...resolveDefaultBrushDynamics(props), ...props.dynamics };
  const minimum = fraction(dynamics.size?.min ?? props.minSize / size);
  const wetEdges = !!props.wetEdges;
  const smoothing = props.stabilizerLevel > 0;
  const scatter = fraction(props.scatter);
  const tiltSize = fraction(props.tiltSize);
  const sizeControl = { ...dynamics.size, min: minimum, tilt: dynamics.size?.tilt || tiltSize > 0 };
  const angleControl = (props.angleMode ?? 'direction') === 'direction' ? 6
    : props.angleMode === 'pen' || dynamics.angle?.tilt ? 3 : dynamics.angle?.pressure ? 2 : 0;
  const color = props.colorDynamics;
  const hue = fraction(color?.hueJitter ?? props.hueJitter);
  const saturation = fraction(color?.saturationJitter ?? props.satJitter);
  const brightness = fraction(color?.lightnessJitter ?? props.valJitter);
  const colorMix = {
    ...dynamics.colorMix,
    random: props.dynamics?.colorMix?.random ?? color?.fgBgMix ?? props.fgBgMix,
  };
  const entries: Descriptor['entries'] = {
    'Nm  ': name,
    Brsh: brushShape(name, tip, size, bounded(props.tipAngle, 0, -90, 90),
      bounded(props.roundness, 1, 0.1, 1), spacing, hardness),
    Spcn: percent(spacing),
    useBrushSize: true,
    useTipDynamics: active(sizeControl) || angleControl !== 0 || active(dynamics.angle) || minimum > 0,
    minimumDiameter: percent(minimum),
    szVr: variation(sizeControl),
    angleDynamics: variation(dynamics.angle, angleControl),
    roundnessDynamics: variation(),
    minimumRoundness: percent(1),
    tiltScale: percent(tiltSize),
    usePaintDynamics: active(dynamics.opacity) || active(dynamics.flow)
      || fraction(dynamics.opacity?.min) > 0 || fraction(dynamics.flow?.min) > 0,
    opVr: variation(dynamics.opacity),
    prVr: variation(dynamics.flow),
    useScatter: scatter > 0,
    Sctr: percent(scatter),
    'Cnt ': 1,
    bothAxes: true,
    countDynamics: variation(),
    scatterDynamics: variation({ ...dynamics.scatter, random: props.dynamics?.scatter?.random ?? scatter }),
    useTexture: fraction(props.textureDensity) > 0,
    textureDepth: percent(fraction(props.textureDensity)),
    textureScale: percent(bounded(props.textureScale, 1, 0.5, 4)),
    InvT: !!props.textureInvert,
    textureBlendMode: blend(blendModes[props.textureBlendMode ?? 'subtract']),
    minimumDepth: percent(0),
    textureDepthDynamics: variation(),
    useColorDynamics: hue > 0 || saturation > 0 || brightness > 0 || active(colorMix),
    H: percent(hue),
    'H   ': percent(hue), // Photoshop's FourCC spelling.
    Strt: percent(saturation),
    Brgh: percent(brightness),
    clVr: variation(colorMix),
    purity: percent(0),
    colorDynamicsPerTip: color?.scope !== 'perStroke',
    Wtdg: wetEdges,
    wetEdges,
    Smth: smoothing,
    toolOptions: {
      classId: '_',
      entries: {
        brushPreset: true,
        Opct: Math.round(bounded(props.opacity, 1, 0, 1) * 100),
        flow: Math.round(bounded(props.flow, 1, 0, 1) * 100),
        'Md  ': blend('Nrml'),
        smoothing,
      },
    },
    dualBrush: { classId: 'dualBrush', entries: { useDualBrush: false } },
  };
  if (texture) entries.Txtr = { classId: 'Ptrn', entries: { 'Nm  ': texture.name, Idnt: texture.id } };
  if (props.dualBrush) {
    const dualSpacing = bounded(props.dualSpacing, spacing, MIN_BRUSH_SPACING, 1.5);
    const dualScatter = bounded(props.dualScatter, 0.6, 0, 2);
    entries.dualBrush = {
      classId: 'dualBrush',
      entries: {
        useDualBrush: true,
        Brsh: brushShape(name, dual, size * bounded(props.dualSize, 0.4, 0.1, 1), 0, 1, dualSpacing, hardness),
        Sctr: percent(dualScatter),
        BlnM: blend(blendModes[props.dualBlendMode ?? 'multiply']),
        Flip: false,
        Spcn: percent(dualSpacing),
        useScatter: dualScatter > 0,
        'Cnt ': 1,
        bothAxes: true,
        countDynamics: variation(),
        scatterDynamics: variation({ random: dualScatter }),
      },
    };
  }
  return { classId: 'brushPreset', entries };
}

type ImageDecoder = NonNullable<AbrExportOptions['decodeImage']>;

async function writeImageSection(
  writer: AbrWriter, type: 'samp' | 'patt', urls: Map<string, string>, limit: number, decodeImage?: ImageDecoder,
): Promise<Map<string, { id: string; name: string }>> {
  const assets = new Map<string, { id: string; name: string }>();
  let section: number | undefined;
  for (const [url, name] of urls) {
    const decoded = await (decodeImage ? decodeImage(url) : decodeDataUrl(url, limit));
    if (!decoded || !validImage(decoded)) continue;
    const image = resizeMask(decoded, limit);
    const id = uuid();
    assets.set(url, { id, name });
    section ??= writer.startSection(type);
    const record = writer.startLength();
    if (type === 'samp') writeSample(writer, image, id);
    else writePattern(writer, image, id, name);
    writer.endLength(record, true);
  }
  if (section !== undefined) writer.endLength(section, true);
  return assets;
}

/** Encode one or more presets in a Photoshop ABR 6.2 file, in input order. */
export async function exportPresetsToAbr(
  presets: readonly AtelierBrushPreset[], options: AbrExportOptions = {},
): Promise<Uint8Array> {
  if (presets.length === 0) throw new Error('ABR export requires at least one brush preset');
  if (presets.length > 4096) throw new Error('ABR export supports up to 4096 brush presets per file');
  const limit = options.maxTipDimension ?? 2048;
  if (!Number.isFinite(limit) || limit < 1) throw new Error('maxTipDimension must be at least 1');

  const brushes = presets.map((preset, index) => ({
    preset,
    name: preset.name.trim() || `Brush #${index + 1}`,
    tip: preset.tipDataUrl ?? preset.tipUrls?.[0],
    dual: preset.properties.dualBrush ? preset.dualTipDataUrl ?? preset.properties.dualTipUrl : undefined,
    texture: fraction(preset.properties.textureDensity) > 0
      ? preset.textureDataUrl ?? preset.properties.customTextureUrl : undefined,
  }));
  const tips = new Map<string, string>();
  const textures = new Map<string, string>();
  for (const { name, tip, dual, texture } of brushes) {
    if (tip) tips.set(tip, name);
    if (dual) tips.set(dual, name);
    if (texture && !textures.has(texture)) textures.set(texture, `${name} Texture`);
  }

  const writer = new AbrWriter();
  writer.u16(6);
  writer.u16(2);
  const samples = await writeImageSection(writer, 'samp', tips, Math.min(4096, Math.floor(limit)), options.decodeImage);
  const patterns = await writeImageSection(writer, 'patt', textures, Math.min(2048, Math.floor(limit)), options.decodeImage);
  const section = writer.startSection('desc');
  writer.u32(16);
  writeDescriptor(writer, {
    classId: 'null',
    entries: {
      Brsh: brushes.map(({ preset, name, tip, dual, texture }) => brushDescriptor(
        preset, name, samples.get(tip ?? '')?.id, samples.get(dual ?? '')?.id, patterns.get(texture ?? ''),
      )),
    },
  });
  writer.endLength(section, true);
  return writer.result();
}

function validImage({ width, height, pixels }: AbrGrayscaleImage): boolean {
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
    && pixels instanceof Uint8Array && pixels.length === width * height;
}

function scaledDimensions(width: number, height: number, limit: number): [number, number] {
  const scale = Math.min(1, limit / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

function resizeMask(image: AbrGrayscaleImage, limit: number): AbrGrayscaleImage {
  const [width, height] = scaledDimensions(image.width, image.height, limit);
  if (width === image.width && height === image.height) return image;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y + 0.5) * image.height / height) * image.width;
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = image.pixels[row + Math.floor((x + 0.5) * image.width / width)];
    }
  }
  return { width, height, pixels };
}

const inkFromRgb = (red: number, green: number, blue: number): number =>
  255 - Math.round(0.299 * red + 0.587 * green + 0.114 * blue);

function maskFromRgba(rgba: Uint8ClampedArray, width: number, height: number): AbrGrayscaleImage {
  const pixels = new Uint8Array(width * height);
  let hasTransparency = false;
  for (let i = 3; i < rgba.length && !hasTransparency; i += 4) hasTransparency = rgba[i] !== 255;
  for (let i = 0, pos = 0; i < pixels.length; i++, pos += 4) {
    pixels[i] = hasTransparency ? rgba[pos + 3] : inkFromRgb(rgba[pos], rgba[pos + 1], rgba[pos + 2]);
  }
  return { width, height, pixels };
}

async function decodeWithCanvas(url: string, limit: number): Promise<AbrGrayscaleImage | null> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Unable to decode brush image'));
    image.src = url;
  });
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const [width, height] = scaledDimensions(image.naturalWidth, image.naturalHeight, limit);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    return maskFromRgba(context.getImageData(0, 0, width, height).data, width, height);
  } finally {
    canvas.width = canvas.height = 0;
  }
}

function decodeBase64(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function decodeBmp(bytes: Uint8Array): AbrGrayscaleImage | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const height = Math.abs(signedHeight);
  const bytesPerPixel = view.getUint16(28, true) / 8;
  const stride = Math.ceil(width * bytesPerPixel / 4) * 4;
  if (headerSize < 40 || offset < 14 + headerSize || width < 1 || height < 1
    || view.getUint16(26, true) !== 1 || view.getUint32(30, true) !== 0
    || (bytesPerPixel !== 3 && bytesPerPixel !== 4) || height > (bytes.length - offset) / stride) return null;

  let hasTransparency = false;
  if (bytesPerPixel === 4) {
    for (let pos = offset + 3; pos < offset + stride * height && !hasTransparency; pos += 4) {
      hasTransparency = bytes[pos] !== 255;
    }
  }
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = offset + (signedHeight < 0 ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const pos = row + x * bytesPerPixel;
      pixels[y * width + x] = hasTransparency ? bytes[pos + 3] : inkFromRgb(bytes[pos + 2], bytes[pos + 1], bytes[pos]);
    }
  }
  return { width, height, pixels };
}

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const pngChannels: Record<number, number | undefined> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const adam7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

async function inflatePng(chunks: Uint8Array[], size: number): Promise<Uint8Array | null> {
  const compressed = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const output = new Uint8Array(size);
  offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return offset === size ? output : null;
    if (offset + value.length > size) {
      await reader.cancel();
      return null;
    }
    output.set(value, offset);
    offset += value.length;
  }
}

function unfilterPng(row: Uint8Array, previous: Uint8Array, stride: number, filter: number): boolean {
  if (filter === 0) return true;
  if (filter > 4) return false;
  for (let i = 0; i < row.length; i++) {
    const left = i >= stride ? row[i - stride] : 0;
    const up = previous[i];
    const upperLeft = i >= stride ? previous[i - stride] : 0;
    let prediction = left;
    if (filter === 2) prediction = up;
    if (filter === 3) prediction = (left + up) >>> 1;
    if (filter === 4) {
      const a = Math.abs(up - upperLeft);
      const b = Math.abs(left - upperLeft);
      const c = Math.abs(left + up - 2 * upperLeft);
      prediction = a <= b && a <= c ? left : b <= c ? up : upperLeft;
    }
    row[i] += prediction;
  }
  return true;
}

function pngSample(row: Uint8Array, index: number, depth: number): number {
  if (depth === 8) return row[index];
  if (depth === 16) return row[index * 2] * 256 + row[index * 2 + 1];
  const bit = index * depth;
  return (row[bit >>> 3] >>> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

async function decodePng(bytes: Uint8Array): Promise<AbrGrayscaleImage | null> {
  if (bytes.length < 33 || !pngSignature.every((value, index) => value === bytes[index])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = bytes[24];
  const color = bytes[25];
  const channels = pngChannels[color];
  const interlace = bytes[28];
  if (!width || !height || width * height > 64 * 1024 * 1024 || !channels || interlace > 1 || bytes[26] || bytes[27]
    || !(depth === 8 || depth === 16 || (color === 0 && [1, 2, 4].includes(depth)))) return null;

  const chunks: Uint8Array[] = [];
  let transparent: number[] | undefined;
  let ended = false;
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return null;
    if (type === 0x49444154) chunks.push(bytes.subarray(start, end)); // IDAT
    if (type === 0x74524e53) { // tRNS
      if (color === 0 && length === 2) transparent = [view.getUint16(start)];
      if (color === 2 && length === 6) {
        transparent = [view.getUint16(start), view.getUint16(start + 2), view.getUint16(start + 4)];
      }
    }
    if (type === 0x49454e44) { // IEND
      ended = length === 0;
      break;
    }
    offset = end + 4;
  }
  if (!ended || !chunks.length) return null;

  const bitsPerPixel = channels * depth;
  const passes = (interlace ? adam7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const columns = Math.ceil((width - x) / dx);
    const rows = Math.ceil((height - y) / dy);
    return { x, y, dx, dy, columns, rows, rowBytes: Math.ceil(columns * bitsPerPixel / 8) };
  }).filter(({ columns, rows }) => columns > 0 && rows > 0);
  const inflatedSize = passes.reduce((total, { rows, rowBytes }) => total + rows * (rowBytes + 1), 0);
  if (inflatedSize > 256 * 1024 * 1024) return null;
  const data = await inflatePng(chunks, inflatedSize);
  if (!data) return null;

  const ink = new Uint8Array(width * height);
  const alpha = (color === 4 || color === 6 || transparent) ? new Uint8Array(ink.length) : undefined;
  const stride = Math.ceil(bitsPerPixel / 8);
  const maximum = (1 << depth) - 1;
  const toByte = (value: number): number => Math.round(value * 255 / maximum);
  const grayscale = color === 0 || color === 4;
  let offset = 0;
  let hasTransparency = false;
  for (const pass of passes) {
    let previous: Uint8Array = new Uint8Array(pass.rowBytes);
    for (let y = 0; y < pass.rows; y++) {
      const filter = data[offset++];
      const row = data.subarray(offset, offset + pass.rowBytes);
      offset += pass.rowBytes;
      if (!unfilterPng(row, previous, stride, filter)) return null;
      previous = row;
      const targetRow = (pass.y + y * pass.dy) * width;
      for (let x = 0; x < pass.columns; x++) {
        const target = targetRow + pass.x + x * pass.dx;
        const first = x * channels;
        const red = pngSample(row, first, depth);
        const green = grayscale ? red : pngSample(row, first + 1, depth);
        const blue = grayscale ? red : pngSample(row, first + 2, depth);
        ink[target] = grayscale ? 255 - toByte(red) : inkFromRgb(toByte(red), toByte(green), toByte(blue));
        if (alpha) {
          const value = transparent
            ? (red === transparent[0] && (grayscale || (green === transparent[1] && blue === transparent[2])) ? 0 : 255)
            : toByte(pngSample(row, first + channels - 1, depth));
          alpha[target] = value;
          hasTransparency ||= value !== 255;
        }
      }
    }
  }
  return { width, height, pixels: hasTransparency && alpha ? alpha : ink };
}

async function decodeDataUrl(url: string, limit: number): Promise<AbrGrayscaleImage | null> {
  if (!/^data:image\//i.test(url)) return null;
  const encoded = /^data:image\/(bmp|png);base64,/i.exec(url);
  try {
    // Native BMP decoders can discard the fourth channel of uncompressed BGRA masks.
    if (encoded && encoded[1].toLowerCase() === 'bmp') {
      const image = decodeBmp(decodeBase64(url.slice(encoded[0].length)));
      if (image) return image;
    }
    if (typeof document !== 'undefined' && typeof Image !== 'undefined') return await decodeWithCanvas(url, limit);
    if (encoded && encoded[1].toLowerCase() === 'png') {
      return await decodePng(decodeBase64(url.slice(encoded[0].length)));
    }
  } catch {
    return null;
  }
  return null;
}
