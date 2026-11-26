import { createSrgbIccProfile, parseIccProfile } from './iccProfile';

export interface IccEmbedChoice { name: string; bytes: Uint8Array }

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const encoder = new TextEncoder();
const PNG_ICCP = encoder.encode('iCCP');
const ICC_APP2 = encoder.encode('ICC_PROFILE\0');
const JPEG_ICC_DATA_LIMIT = 65519;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
  }
  return value;
});

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function transformZlib(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const input = new Blob([new Uint8Array(data)]);
  return new Uint8Array(await new Response(input.stream().pipeThrough(stream)).arrayBuffer());
}

export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  return transformZlib(data, new CompressionStream('deflate'));
}

export async function zlibInflate(data: Uint8Array): Promise<Uint8Array> {
  return transformZlib(data, new DecompressionStream('deflate'));
}

export function sanitizeIccProfileName(name: string): string {
  return name.replace(/\s/g, ' ').replace(/[^\x20-\x7E\xA1-\xFF]/g, '')
    .replace(/ +/g, ' ').trim().slice(0, 79).trimEnd() || 'ICC Profile';
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

interface PngChunk {
  type: string;
  start: number;
  end: number;
}

function parsePngChunks(png: Uint8Array): PngChunk[] {
  if (!PNG_SIGNATURE.every((byte, i) => png[i] === byte)) throw new Error('invalid_png');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: PngChunk[] = [];
  let start = PNG_SIGNATURE.length;
  while (start + 12 <= png.length) {
    const length = view.getUint32(start);
    const end = start + 12 + length;
    if (end > png.length) throw new Error('invalid_png');
    const type = String.fromCharCode(...png.subarray(start + 4, start + 8));
    if (chunks.length === 0 && (type !== 'IHDR' || length !== 13)) throw new Error('invalid_png');
    chunks.push({ type, start, end });
    if (type === 'IEND' && length === 0 && end === png.length) return chunks;
    if (type === 'IEND') break;
    start = end;
  }
  throw new Error('invalid_png');
}

export async function embedIccInPng(
  png: Uint8Array,
  icc: Uint8Array,
  profileName: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const [header, ...chunks] = parsePngChunks(png);
  const keyword = Uint8Array.from(sanitizeIccProfileName(profileName), (char) => char.charCodeAt(0));
  const compressed = await zlibDeflate(icc);
  const dataLength = keyword.length + 2 + compressed.length;
  const chunk = new Uint8Array(dataLength + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, dataLength);
  chunk.set(PNG_ICCP, 4);
  chunk.set(keyword, 8);
  chunk.set(compressed, 8 + keyword.length + 2);
  view.setUint32(chunk.length - 4, crc32(chunk, 4, chunk.length - 4));

  return concatBytes([
    png.subarray(0, header.end),
    chunk,
    ...chunks.filter(({ type }) => type !== 'iCCP' && type !== 'sRGB')
      .map(({ start, end }) => png.subarray(start, end)),
  ]);
}

export async function extractIccFromPng(png: Uint8Array): Promise<{ name: string; icc: Uint8Array } | null> {
  const chunk = parsePngChunks(png).find(({ type }) => type === 'iCCP');
  if (!chunk) return null;

  const data = png.subarray(chunk.start + 8, chunk.end - 4);
  const separator = data.indexOf(0);
  if (separator < 1 || separator > 79 || data[separator + 1] !== 0 || separator + 2 >= data.length) {
    return null;
  }
  const name = String.fromCharCode(...data.subarray(0, separator));
  try {
    return { name, icc: await zlibInflate(data.subarray(separator + 2)) };
  } catch {
    return null;
  }
}

interface JpegSegment {
  marker: number;
  start: number;
  dataStart: number;
  end: number;
}

function parseJpegHeader(jpeg: Uint8Array): { segments: JpegSegment[]; tailStart: number } {
  if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) throw new Error('invalid_jpeg');
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  const segments: JpegSegment[] = [];
  let start = 2;
  while (start < jpeg.length && jpeg[start] === 0xFF) {
    let offset = start + 1;
    while (jpeg[offset] === 0xFF) offset++;
    const marker = jpeg[offset++];
    if (marker === 0xD9) return { segments, tailStart: start };
    if (marker === undefined || marker === 0 || marker === 0xD8) break;
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      segments.push({ marker, start, dataStart: offset, end: offset });
      start = offset;
      continue;
    }

    if (offset + 2 > jpeg.length) break;
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > jpeg.length) break;
    if (marker === 0xDA) return { segments, tailStart: start };
    segments.push({ marker, start, dataStart: offset + 2, end });
    start = end;
  }
  throw new Error('invalid_jpeg');
}

function isIccApp2(jpeg: Uint8Array, segment: JpegSegment): boolean {
  return segment.marker === 0xE2 && segment.end - segment.dataStart >= ICC_APP2.length
    && ICC_APP2.every((byte, i) => jpeg[segment.dataStart + i] === byte);
}

export function embedIccInJpeg(jpeg: Uint8Array, icc: Uint8Array): Uint8Array<ArrayBuffer> {
  const { segments, tailStart } = parseJpegHeader(jpeg);
  const count = Math.max(1, Math.ceil(icc.length / JPEG_ICC_DATA_LIMIT));
  if (count > 255) throw new Error('icc_too_large');

  const profileSegments: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const data = icc.subarray(i * JPEG_ICC_DATA_LIMIT, (i + 1) * JPEG_ICC_DATA_LIMIT);
    const segment = new Uint8Array(4 + ICC_APP2.length + 2 + data.length);
    segment.set([0xFF, 0xE2]);
    new DataView(segment.buffer).setUint16(2, segment.length - 2);
    segment.set(ICC_APP2, 4);
    segment[4 + ICC_APP2.length] = i + 1;
    segment[5 + ICC_APP2.length] = count;
    segment.set(data, 6 + ICC_APP2.length);
    profileSegments.push(segment);
  }

  const retained = segments.filter((segment) => !isIccApp2(jpeg, segment));
  let insertion = 0;
  while (retained[insertion]?.marker === 0xE0 || retained[insertion]?.marker === 0xE1) insertion++;
  const parts = retained.map(({ start, end }) => jpeg.subarray(start, end));
  parts.splice(insertion, 0, ...profileSegments);
  return concatBytes([jpeg.subarray(0, 2), ...parts, jpeg.subarray(tailStart)]);
}

export function extractIccFromJpeg(jpeg: Uint8Array): Uint8Array | null {
  const { segments } = parseJpegHeader(jpeg);
  const parts = new Map<number, Uint8Array>();
  let expectedCount = 0;
  for (const segment of segments) {
    if (!isIccApp2(jpeg, segment)) continue;
    const sequenceOffset = segment.dataStart + ICC_APP2.length;
    if (sequenceOffset + 2 > segment.end) return null;
    const sequence = jpeg[sequenceOffset];
    const count = jpeg[sequenceOffset + 1];
    if (sequence < 1 || sequence > count || (expectedCount && expectedCount !== count) || parts.has(sequence)) {
      return null;
    }
    expectedCount = count;
    parts.set(sequence, jpeg.subarray(sequenceOffset + 2, segment.end));
  }
  if (expectedCount === 0 || parts.size !== expectedCount) return null;
  return concatBytes(Array.from({ length: expectedCount }, (_, i) => parts.get(i + 1)!));
}

export function canEmbedIccInRgbImage(bytes: Uint8Array): boolean {
  try {
    return parseIccProfile(bytes).header.colorSpace === 'RGB';
  } catch {
    return false;
  }
}

let srgbEmbedChoice: IccEmbedChoice | undefined;

export function builtinSrgbEmbedChoice(): IccEmbedChoice {
  return srgbEmbedChoice ??= { name: 'sRGB IEC61966-2.1', bytes: createSrgbIccProfile() };
}
