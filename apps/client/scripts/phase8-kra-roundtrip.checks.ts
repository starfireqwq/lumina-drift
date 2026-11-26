import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  convertKraTileToRgba8,
  decompressLzf,
  mapKraBlendMode,
  parseKraTileStream,
} from '../src/engine/kraDecoder';
import {
  buildKraMainDoc,
  compressLzf,
  encodeKraDocument,
  encodeKraTileStream,
  KRA_MIMETYPE,
  mapLuminaBlendModeToKra,
  rgbaToKritaBgra,
  type KraDocumentInput,
  type KraNodeInput,
} from '../src/engine/kraEncoder';

const width = 150;
const height = 100;
const utf8 = new TextDecoder();

function randomBytes(length: number): Uint8Array {
  let state = 0x4992a7;
  return Uint8Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 24;
  });
}

function checkLzf(): void {
  const zeroes = new Uint8Array(16384);
  const random = randomBytes(16384);
  const typical = Uint8Array.from({ length: 16384 }, (_, i) => (i & 0x100) === 0 ? 0 : (i >>> 3) & 0xff);
  const distant = new Uint8Array(8201);
  const repeated = Uint8Array.of(121, 51, 129, 243, 155, 52, 90, 6, 78);
  distant.set(repeated);
  distant.set(repeated, 8192);
  for (const input of [
    new Uint8Array(0),
    Uint8Array.of(5),
    Uint8Array.of(5, 5),
    Uint8Array.of(5, 6, 5),
    zeroes,
    random,
    typical,
    distant,
  ]) {
    assert.deepEqual(decompressLzf(compressLzf(input), input.length), input);
  }
  assert.ok(compressLzf(zeroes).length < 400);
  assert.ok(compressLzf(random).length >= random.length);

  // A length-9 reference 8192 bytes back should use an extended length and both offset bytes.
  const compressed = compressLzf(distant);
  assert.deepEqual(compressed.slice(-3), Uint8Array.of(255, 0, 255));
}

function paintPixels(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.set([30, 60, 90, 0], 4);
  for (let y = 10; y < height; y++) {
    for (let x = y >= 64 ? 70 : 128; x < width; x++) {
      rgba.set([(x * 5) & 0xff, y, 109, (x + y) % 2 === 0 ? 111 : 255], (y * width + x) * 4);
    }
  }
  rgba.set([3, 29, 239, 120], 0);
  return rgba;
}

function readTileHeaders(bytes: Uint8Array, pixelSize: number, expectedCount: number) {
  let offset = 0;
  const readLine = () => {
    const end = bytes.indexOf(10, offset);
    assert.ok(end >= 0);
    const line = utf8.decode(bytes.subarray(offset, end));
    offset = end + 1;
    return line;
  };
  assert.deepEqual(Array.from({ length: 5 }, readLine), [
    'VERSION 2', 'TILEWIDTH 64', 'TILEHEIGHT 64', `PIXELSIZE ${pixelSize}`, `DATA ${expectedCount}`,
  ]);
  const records = [];
  while (offset < bytes.length) {
    const [left, top, compression, length] = readLine().split(',');
    assert.equal(compression, 'LZF');
    const flag = bytes[offset];
    assert.ok(flag === 0 || flag === 1);
    assert.ok(Number(length) > 1);
    offset += Number(length);
    records.push({ left: Number(left), top: Number(top), flag });
  }
  assert.equal(offset, bytes.length);
  assert.equal(records.length, expectedCount);
  return records;
}

function readPixels(stream: Uint8Array, pixelSize: 1 | 4, defaultByte = 0): Uint8Array {
  const decoded = parseKraTileStream(stream);
  assert.equal(decoded.pixelSize, pixelSize);
  const output = new Uint8Array(width * height * pixelSize).fill(defaultByte);
  for (const tile of decoded.tiles) {
    const rgba = convertKraTileToRgba8(tile.raw, 4096, pixelSize, pixelSize === 1 ? 'ALPHA' : 'RGBA', pixelSize === 1);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const dstX = tile.left + x;
        const dstY = tile.top + y;
        const src = (y * 64 + x) * 4;
        if (dstX >= width || dstY >= height) {
          assert.deepEqual(rgba.slice(src, src + 4), pixelSize === 1
            ? Uint8ClampedArray.of(defaultByte, defaultByte, defaultByte, 255)
            : new Uint8ClampedArray(4));
          continue;
        }
        const dst = (dstY * width + dstX) * pixelSize;
        if (pixelSize === 1) output[dst] = rgba[src];
        else output.set(rgba.subarray(src, src + 4), dst);
      }
    }
  }
  return output;
}

function normalizedRgba(pixels: Uint8Array | Uint8ClampedArray): Uint8Array {
  const expected = Uint8Array.from(pixels);
  for (let i = 0; i < expected.length; i += 4) {
    if (expected[i + 3] === 0) expected.fill(0, i, i + 3);
  }
  return expected;
}

function checkTiles(): void {
  const rgba = paintPixels();
  const stream = encodeKraTileStream({
    width, height, pixelSize: 4, data: rgbaToKritaBgra(rgba), defaultPixel: new Uint8Array(4),
  });
  const tileHeaders = readTileHeaders(stream, 4, 4);
  assert.deepEqual(tileHeaders.map(({ left, top }) => [left, top]), [[0, 0], [128, 0], [64, 64], [128, 64]]);
  assert.deepEqual(readPixels(stream, 4), normalizedRgba(rgba));

  const random = randomBytes(64 * 64 * 4);
  const raw = encodeKraTileStream({ width: 64, height: 64, pixelSize: 4, data: random, defaultPixel: new Uint8Array(4) });
  assert.deepEqual(readTileHeaders(raw, 4, 1), [{ left: 0, top: 0, flag: 0 }]);
  assert.deepEqual(parseKraTileStream(raw).tiles[0].raw, random);

  for (const defaultByte of [0, 255]) {
    const coverage = new Uint8Array(width * height).fill(defaultByte);
    coverage[3] = 60;
    coverage[coverage.length - 1] = 148;
    const mask = encodeKraTileStream({
      width, height, pixelSize: 1, data: coverage, defaultPixel: Uint8Array.of(defaultByte),
    });
    assert.deepEqual(readTileHeaders(mask, 1, 2), [
      { left: 0, top: 0, flag: 1 }, { left: 128, top: 64, flag: 1 },
    ]);
    assert.deepEqual(readPixels(mask, 1, defaultByte), coverage);
  }
}

function checkBlendModes(): void {
  const modes = [
    'normal', 'darken', 'multiply', 'color_burn', 'linear_burn', 'darker_color', 'lighten', 'screen',
    'color_dodge', 'add', 'glow', 'lighter_color', 'overlay', 'soft_light', 'hard_light', 'vivid_light',
    'linear_light', 'pin_light', 'hard_mix', 'difference', 'exclusion', 'subtract', 'divide',
    'hue', 'saturation', 'color', 'luminosity',
  ];
  assert.equal(new Set(modes.map(mapLuminaBlendModeToKra)).size, 27);
  for (const mode of modes) assert.equal(mapKraBlendMode(mapLuminaBlendModeToKra(mode)), mode);
  assert.equal(mapKraBlendMode('hard mix'), 'hard_mix');
  assert.equal(mapKraBlendMode('unknown'), 'normal');
  assert.equal(mapLuminaBlendModeToKra('unknown'), 'normal');
}

interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

function parseXml(xml: string): XmlElement {
  const root: XmlElement = { tag: '', attrs: {}, children: [], text: '' };
  const stack = [root];
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unescape = (value: string) => value.replace(/&(#\d+|\w+);/g, (_, key: string) => (
    key.startsWith('#') ? String.fromCodePoint(Number(key.slice(1))) : entities[key]
  ));
  for (const token of xml.matchAll(/<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:-]+)([^<>]*?)(\/?)>|([^<]+)/g)) {
    const [, closing, tag, attributes, selfClosing, content] = token;
    const parent = stack[stack.length - 1];
    if (content) parent.text += unescape(content);
    if (!tag) continue;
    if (closing) {
      assert.equal(stack.pop()?.tag, tag);
      continue;
    }
    const attrs = Object.fromEntries([...attributes.matchAll(/([\w:-]+)="([^"]*)"/g)]
      .map(([, name, value]) => [name, unescape(value)]));
    const element: XmlElement = { tag, attrs, children: [], text: '' };
    parent.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  assert.deepEqual(stack, [root]);
  assert.equal(root.children.length, 1);
  return root.children[0];
}

function child(element: XmlElement, tag: string): XmlElement {
  const match = element.children.find((node) => node.tag === tag);
  assert.ok(match, `missing <${tag}> in <${element.tag}>`);
  return match;
}

async function checkDocument(): Promise<void> {
  const special = `圖層<&"'> 😺`;
  const paint: KraNodeInput = {
    kind: 'paint', name: special + '\x01', opacity: 0.567891, visible: false, locked: true,
    alphaLocked: true, clipToBelow: true, blendMode: 'linear_light', rgba: paintPixels(),
    mask: { coverage: new Uint8Array(width * height), inverted: true, enabled: false, name: special },
  };
  paint.mask!.coverage[2] = 100;
  const empty: KraNodeInput = {
    kind: 'paint', name: 'Empty', opacity: 0.5 - 1e-8, visible: true, locked: false,
    alphaLocked: false, clipToBelow: false, blendMode: 'normal', rgba: new Uint8Array(width * height * 4),
  };
  const inner: KraNodeInput = {
    kind: 'group', name: 'Inner', opacity: 0.8, visible: true, locked: false, blendMode: 'normal',
    children: [empty, paint],
  };
  const outer: KraNodeInput = {
    kind: 'group', name: 'Outer', opacity: 1, visible: true, locked: false, blendMode: 'multiply',
    children: [inner], mask: { coverage: new Uint8Array(width * height), inverted: false, enabled: true },
  };
  outer.mask!.coverage[width * height - 1] = 77;
  const bottom: KraNodeInput = { ...empty, name: 'Bottom', rgba: Uint8Array.from(paint.rgba).reverse() };
  let uuid = 0;
  const doc: KraDocumentInput = {
    width, height, dpi: 144, title: special, bgColor: '#A4C',
    roots: [bottom, outer], mergedPng: Uint8Array.of(5, 6, 7), previewPng: Uint8Array.of(8, 9),
    uuid: () => `12345678-1234-4abc-a234-${String(++uuid).padStart(12, '0')}`,
  };

  const plan = new Map<KraNodeInput, string>([
    [bottom, 'test1'], [outer, 'test2'], [inner, 'test3'], [empty, 'test4'], [paint, 'test5'],
  ]);
  const xml = buildKraMainDoc(doc, plan);
  assert.match(xml, /圖層&lt;&amp;&quot;&apos;&gt; 😺/);
  assert.ok(!xml.includes('\x01'));
  assert.equal(child(child(child(parseXml(xml), 'IMAGE'), 'layers'), 'layer').attrs.filename, 'test2');
  for (const bgColor of [null, 'transparent', 'invalid']) {
    const image = child(parseXml(buildKraMainDoc({ ...doc, bgColor }, plan)), 'IMAGE');
    assert.deepEqual(Buffer.from(child(image, 'ProjectionBackgroundColor').attrs.ColorData, 'base64'), Buffer.alloc(4));
  }

  const bytes = await encodeKraDocument(doc);
  const header = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(header.getUint32(0, true), 0x04034b50);
  assert.equal(header.getUint16(8, true), 0);
  assert.equal(header.getUint16(26, true), 8);
  assert.equal(header.getUint16(28, true), 0);
  assert.equal(utf8.decode(bytes.subarray(30, 38)), 'mimetype');
  assert.equal(utf8.decode(bytes.subarray(38, 38 + KRA_MIMETYPE.length)), KRA_MIMETYPE);

  const zip = await JSZip.loadAsync(bytes);
  const fileBytes = async (path: string) => {
    const file = zip.file(path);
    assert.ok(file, `missing ${path}`);
    return file.async('uint8array');
  };
  assert.deepEqual(Object.keys(zip.files).slice(0, 5), ['mimetype', 'maindoc.xml', 'documentinfo.xml', 'mergedimage.png', 'preview.png']);
  assert.deepEqual(await fileBytes('mergedimage.png'), doc.mergedPng);
  assert.deepEqual(await fileBytes('preview.png'), doc.previewPng);
  const info = parseXml(utf8.decode(await fileBytes('documentinfo.xml')));
  assert.equal(child(child(info, 'about'), 'title').text, special);
  const image = child(parseXml(utf8.decode(await fileBytes('maindoc.xml'))), 'IMAGE');
  assert.equal(image.attrs.name, 'Lumina');
  assert.equal(image.attrs['x-res'], '144');
  assert.equal(image.attrs['y-res'], '144');
  assert.deepEqual(Buffer.from(child(image, 'ProjectionBackgroundColor').attrs.ColorData, 'base64'), Buffer.from([0xcc, 0x44, 0xaa, 0xff]));

  const filenames = new Set<string>();
  const checkNodes = async (container: XmlElement, nodes: KraNodeInput[]) => {
    const elements = container.children.filter((element) => element.tag === 'layer');
    assert.equal(elements.length, nodes.length);
    for (const [index, node] of [...nodes].reverse().entries()) {
      const element = elements[index];
      const attrs = element.attrs;
      assert.equal(attrs.name, node.name.replace('\x01', ''));
      assert.equal(attrs.opacity, String(Math.round(node.opacity * 255)));
      const precise = Number(attrs['lumina-opacity']);
      assert.ok(Math.abs(precise - node.opacity) <= 1e-6);
      assert.ok(Math.abs(precise * 255 - Number(attrs.opacity)) <= 0.5 + 1e-6);
      assert.equal(attrs.visible, String(Number(node.visible)));
      assert.equal(attrs.locked, String(Number(node.locked)));
      assert.equal(attrs.compositeop, mapLuminaBlendModeToKra(node.blendMode));
      assert.match(attrs.uuid, /^\{12345678-1234-4abc-a234-\d{12}\}$/);
      assert.ok(!filenames.has(attrs.filename));
      filenames.add(attrs.filename);
      const path = `Lumina/layers/${attrs.filename}`;

      if (node.kind === 'group') {
        assert.equal(attrs.nodetype, 'grouplayer');
        assert.equal(attrs.passthrough, node.blendMode === 'normal' ? '1' : '0');
        assert.equal(zip.file(path), null);
        await checkNodes(child(element, 'layers'), node.children);
      } else {
        assert.equal(attrs.nodetype, 'paintlayer');
        assert.equal(attrs.channellockflags, node.alphaLocked ? '1110' : '');
        assert.equal(attrs.inheritalpha, node.clipToBelow ? '1' : '0');
        assert.equal(attrs.channelflags, node.clipToBelow ? '1110' : '');
        assert.deepEqual(await fileBytes(`${path}.defaultpixel`), new Uint8Array(4));
        assert.deepEqual(readPixels(await fileBytes(path), 4), normalizedRgba(node.rgba));
      }
      if (node.mask) {
        const mask = child(child(element, node.kind === 'group' ? 'layers' : 'masks'), 'mask');
        assert.equal(mask.attrs.nodetype, 'transparencymask');
        assert.ok(mask.attrs.filename && !filenames.has(mask.attrs.filename));
        filenames.add(mask.attrs.filename);
        assert.equal(mask.attrs.visible, node.mask.enabled ? '1' : '0');
        assert.equal(mask.attrs['lumina-maskinverted'], node.mask.inverted ? '1' : '0');
        if (node.mask.name) assert.equal(mask.attrs.name, node.mask.name);
        if (node.kind === 'group') assert.ok(!element.children.some((c) => c.tag === 'masks'));
        const selection = `Lumina/layers/${mask.attrs.filename}.pixelselection`;
        const defaultByte = node.mask.inverted ? 255 : 0;
        assert.deepEqual(await fileBytes(`${selection}.defaultpixel`), Uint8Array.of(defaultByte));
        const expected = node.mask.inverted ? node.mask.coverage.map((value) => 255 - value) : node.mask.coverage;
        assert.deepEqual(readPixels(await fileBytes(selection), 1, defaultByte), expected);
      }
    }
  };
  await checkNodes(child(image, 'layers'), doc.roots);
}

export async function runPhase8KraRoundTripChecks(): Promise<void> {
  checkLzf();
  checkTiles();
  checkBlendModes();
  await checkDocument();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase8KraRoundTripChecks().then(() => console.log('ok'), (e) => { console.error(e); process.exit(1); });
}
