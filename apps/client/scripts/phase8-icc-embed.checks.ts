import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPsd, writePsd } from 'ag-psd';
import {
  builtinSrgbEmbedChoice,
  canEmbedIccInRgbImage,
  crc32,
  embedIccInJpeg,
  embedIccInPng,
  extractIccFromJpeg,
  extractIccFromPng,
  sanitizeIccProfileName,
  zlibDeflate,
} from '../src/engine/color/iccEmbed';

const encoder = new TextEncoder();

function join(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(encoder.encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk, 4, 8 + data.length));
  return chunk;
}

function inspectPng(png: Uint8Array): { type: string; bytes: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; bytes: Uint8Array }[] = [];
  for (let start = 8; start < png.length;) {
    const crcOffset = start + 8 + view.getUint32(start);
    assert.equal(view.getUint32(crcOffset), crc32(png, start + 4, crcOffset));
    const type = String.fromCharCode(...png.subarray(start + 4, start + 8));
    chunks.push({ type, bytes: png.subarray(start, crcOffset + 4) });
    start = crcOffset + 4;
  }
  return chunks;
}

async function checkPng(): Promise<void> {
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const ihdr = pngChunk('IHDR', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0));
  const text = pngChunk('tEXt', encoder.encode('Title\0Pixel'));
  const idat = pngChunk('IDAT', await zlibDeflate(Uint8Array.of(0, 255, 32, 64, 255)));
  const iend = pngChunk('IEND', new Uint8Array(0));
  const png = join(signature, ihdr, pngChunk('sRGB', Uint8Array.of(0)), text, idat, iend);
  assert.equal(await extractIccFromPng(png), null);

  const { name, bytes } = builtinSrgbEmbedChoice();
  const embedded = await embedIccInPng(png, bytes, name);
  const chunks = inspectPng(embedded);
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'iCCP', 'tEXt', 'IDAT', 'IEND']);
  assert.deepEqual(chunks.filter((chunk) => chunk.type !== 'iCCP').map((chunk) => chunk.bytes),
    [ihdr, text, idat, iend]);
  assert.deepEqual(await extractIccFromPng(embedded), { name, icc: bytes });

  const replacement = await embedIccInPng(embedded, bytes, '   中文  Café\t  RGB   ');
  assert.equal(inspectPng(replacement).filter((chunk) => chunk.type === 'iCCP').length, 1);
  assert.deepEqual(await extractIccFromPng(replacement), { name: 'Café RGB', icc: bytes });
  await assert.rejects(embedIccInPng(Uint8Array.of(0), bytes, name), { message: 'invalid_png' });
  await assert.rejects(embedIccInPng(png.subarray(0, png.length - 5), bytes, name), { message: 'invalid_png' });
  assert.equal(sanitizeIccProfileName('   中文   '), 'ICC Profile');
  assert.equal(sanitizeIccProfileName('A'.repeat(90)), 'A'.repeat(79));
  assert.equal(sanitizeIccProfileName(`${'A'.repeat(78)}  B`), 'A'.repeat(78));
}

function jpegSegment(marker: number, data: Uint8Array): Uint8Array {
  const segment = new Uint8Array(4 + data.length);
  segment.set([0xFF, marker]);
  new DataView(segment.buffer).setUint16(2, data.length + 2);
  segment.set(data, 4);
  return segment;
}

function checkJpeg(): void {
  const soi = Uint8Array.of(0xFF, 0xD8);
  const jfif = jpegSegment(0xE0, Uint8Array.of(74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0));
  const exif = jpegSegment(0xE1, encoder.encode('Exif\0\0'));
  const otherApp2 = jpegSegment(0xE2, encoder.encode('Other data'));
  const dqt = jpegSegment(0xDB, new Uint8Array(65).fill(1, 1));
  const sof = jpegSegment(0xC0, Uint8Array.of(8, 0, 1, 0, 1, 1, 1, 0x11, 0));
  const dht = jpegSegment(0xC4, Uint8Array.of(0, 1, ...new Uint8Array(16)));
  const sos = jpegSegment(0xDA, Uint8Array.of(1, 1, 0, 0, 63, 0));
  const header = join(soi, jfif, exif);
  const tail = join(otherApp2, dqt, sof, dht, sos, Uint8Array.of(1, 0xFF, 0x00, 2, 0xFF, 0xD9));
  const jpeg = join(header, tail);
  assert.equal(extractIccFromJpeg(jpeg), null);

  const icc = Uint8Array.from({ length: 150 * 1024 }, (_, i) => i % 251);
  const embedded = embedIccInJpeg(jpeg, icc);
  assert.deepEqual(embedded.subarray(0, header.length), header);
  const view = new DataView(embedded.buffer, embedded.byteOffset, embedded.byteLength);
  const segments: Uint8Array[] = [];
  let offset = header.length;
  for (const [i, size] of [65519, 65519, icc.length - 2 * 65519].entries()) {
    assert.equal(view.getUint16(offset), 0xFFE2);
    const length = view.getUint16(offset + 2);
    assert.equal(length, size + 16);
    assert.deepEqual(embedded.subarray(offset + 4, offset + 16), encoder.encode('ICC_PROFILE\0'));
    assert.equal(embedded[offset + 16], i + 1);
    assert.equal(embedded[offset + 17], 3);
    segments.push(embedded.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }
  assert.deepEqual(embedded.subarray(offset), tail);
  assert.deepEqual(extractIccFromJpeg(embedded), icc);
  assert.deepEqual(extractIccFromJpeg(join(header, segments[2], segments[0], segments[1], tail)), icc);
  assert.equal(extractIccFromJpeg(join(header, segments[0], segments[2], tail)), null);
  assert.equal(extractIccFromJpeg(join(header, segments[0], segments[0], segments[2], tail)), null);

  const replacement = builtinSrgbEmbedChoice().bytes;
  const replaced = embedIccInJpeg(embedded, replacement);
  assert.deepEqual(replaced, embedIccInJpeg(jpeg, replacement));
  assert.deepEqual(extractIccFromJpeg(replaced), replacement);
  assert.throws(() => embedIccInJpeg(Uint8Array.of(0), icc), { message: 'invalid_jpeg' });
  assert.throws(() => embedIccInJpeg(join(header, sos.subarray(0, sos.length - 1)), icc),
    { message: 'invalid_jpeg' });
  assert.throws(() => embedIccInJpeg(jpeg, new Uint8Array(65519 * 255 + 1)), { message: 'icc_too_large' });
}

export async function runPhase8IccEmbedChecks(): Promise<void> {
  assert.equal(crc32(encoder.encode('123456789')), 0xCBF43926);
  assert.equal(crc32(encoder.encode('[123456789]'), 1, 10), 0xCBF43926);
  await checkPng();
  checkJpeg();

  const srgb = builtinSrgbEmbedChoice();
  assert.equal(srgb.name, 'sRGB IEC61966-2.1');
  assert.equal(builtinSrgbEmbedChoice(), srgb);
  assert.equal(canEmbedIccInRgbImage(srgb.bytes), true);
  const cmyk = srgb.bytes.slice();
  cmyk.set(encoder.encode('CMYK'), 16);
  assert.equal(canEmbedIccInRgbImage(cmyk), false);
  assert.equal(canEmbedIccInRgbImage(Uint8Array.of(1, 2, 3)), false);

  const psd = writePsd({
    width: 4,
    height: 4,
    imageData: { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) },
    children: [],
    imageResources: { iccProfile: srgb.bytes },
  });
  const decoded = readPsd(psd, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  assert.deepEqual(decoded.imageResources?.iccProfile, srgb.bytes);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase8IccEmbedChecks().then(() => console.log('ok'), (e) => { console.error(e); process.exit(1); });
}
