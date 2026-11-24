import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  BrushPackageManager,
  parseBinaryPlist,
  parseProcreateArchive,
  parseXmlPlist,
  unarchiveNSKeyed,
} from '@atelier/shared';

// Minimal valid 2x2 PNG bytes (with real IHDR width=2, height=2)
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

// Minimal Apple Binary Plist (bplist00) serializer for test fixtures
type BplistNode =
  | null
  | boolean
  | number
  | string
  | { UID: number }
  | { real: number }
  | BplistNode[]
  | { [k: string]: BplistNode };

function buildBinaryPlist(root: BplistNode): Uint8Array {
  const objects: BplistNode[] = [];
  const encodeIdx = (node: BplistNode): number => {
    const idx = objects.length;
    objects.push(node);
    if (Array.isArray(node)) {
      node.forEach((child) => encodeIdx(child));
    } else if (node && typeof node === 'object' && !('UID' in node) && !('real' in node)) {
      const entries = Object.entries(node);
      for (const [k] of entries) encodeIdx(k);
      for (const [, v] of entries) encodeIdx(v);
    }
    return idx;
  };

  // Build flat object table with deduplicated references
  const flat: BplistNode[] = [];
  const refMap = new Map<BplistNode, number>();
  const register = (node: BplistNode): number => {
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' || node === null) {
      const existing = refMap.get(node);
      if (existing !== undefined) return existing;
      const id = flat.length;
      flat.push(node);
      refMap.set(node, id);
      return id;
    }
    const id = flat.length;
    flat.push(node);
    if (Array.isArray(node)) {
      for (const c of node) register(c);
    } else if (!('UID' in node) && !('real' in node)) {
      for (const [k, v] of Object.entries(node)) {
        register(k);
        register(v);
      }
    }
    return id;
  };

  // Use simple recursive serializer returning index directly
  const serialized: Uint8Array[] = [];
  const lookup = (node: BplistNode): number => {
    const id = serialized.length;
    serialized.push(new Uint8Array(0)); // placeholder
    if (node === null) {
      serialized[id] = Uint8Array.of(0x00);
    } else if (node === false) {
      serialized[id] = Uint8Array.of(0x08);
    } else if (node === true) {
      serialized[id] = Uint8Array.of(0x09);
    } else if (typeof node === 'number') {
      if (Number.isInteger(node) && node >= 0 && node < 256) {
        serialized[id] = Uint8Array.of(0x10, node);
      } else {
        const b = new Uint8Array(9);
        b[0] = 0x23;
        new DataView(b.buffer).setFloat64(1, node, false);
        serialized[id] = b;
      }
    } else if (typeof node === 'string') {
      const isAscii = /^[\x00-\x7f]*$/.test(node);
      if (isAscii) {
        const len = node.length;
        const header = len < 15 ? [0x50 | len] : [0x5f, 0x10, len];
        const b = new Uint8Array(header.length + len);
        b.set(header, 0);
        for (let i = 0; i < len; i++) b[header.length + i] = node.charCodeAt(i);
        serialized[id] = b;
      } else {
        const len = node.length;
        const header = len < 15 ? [0x60 | len] : [0x6f, 0x10, len];
        const b = new Uint8Array(header.length + len * 2);
        b.set(header, 0);
        const dv = new DataView(b.buffer);
        for (let i = 0; i < len; i++) dv.setUint16(header.length + i * 2, node.charCodeAt(i), false);
        serialized[id] = b;
      }
    } else if (Array.isArray(node)) {
      const childRefs = node.map((c) => lookup(c));
      const len = childRefs.length;
      const header = len < 15 ? [0xa0 | len] : [0xaf, 0x10, len];
      const b = new Uint8Array(header.length + len * 2);
      b.set(header, 0);
      const dv = new DataView(b.buffer);
      for (let i = 0; i < len; i++) dv.setUint16(header.length + i * 2, childRefs[i], false);
      serialized[id] = b;
    } else if ('UID' in node) {
      serialized[id] = Uint8Array.of(0x80, node.UID);
    } else if ('real' in node) {
      const b = new Uint8Array(5);
      b[0] = 0x22;
      new DataView(b.buffer).setFloat32(1, node.real, false);
      serialized[id] = b;
    } else {
      const entries = Object.entries(node);
      const keyRefs = entries.map(([k]) => lookup(k));
      const valRefs = entries.map(([, v]) => lookup(v));
      const len = entries.length;
      const header = len < 15 ? [0xd0 | len] : [0xdf, 0x10, len];
      const b = new Uint8Array(header.length + len * 4);
      b.set(header, 0);
      const dv = new DataView(b.buffer);
      for (let i = 0; i < len; i++) dv.setUint16(header.length + i * 2, keyRefs[i], false);
      for (let i = 0; i < len; i++) dv.setUint16(header.length + (len + i) * 2, valRefs[i], false);
      serialized[id] = b;
    }
    return id;
  };
  void objects;
  void encodeIdx;
  void flat;
  void register;

  const topIdx = lookup(root);
  const header = Buffer.from('bplist00', 'ascii');
  const offsets: number[] = [];
  let cursor = header.length;
  for (const part of serialized) {
    offsets.push(cursor);
    cursor += part.length;
  }
  const offsetTableOffset = cursor;
  const offsetTable = new Uint8Array(offsets.length * 4);
  const otView = new DataView(offsetTable.buffer);
  offsets.forEach((off, i) => otView.setUint32(i * 4, off, false));

  const trailer = new Uint8Array(32);
  const tView = new DataView(trailer.buffer);
  trailer[6] = 4; // offsetIntSize
  trailer[7] = 2; // objectRefSize
  tView.setUint32(12, serialized.length, false); // numObjects low
  tView.setUint32(20, topIdx, false); // topObject low
  tView.setUint32(28, offsetTableOffset, false); // offsetTableOffset low

  const totalLen = offsetTableOffset + offsetTable.length + trailer.length;
  const out = new Uint8Array(totalLen);
  out.set(header, 0);
  let p = header.length;
  for (const part of serialized) {
    out.set(part, p);
    p += part.length;
  }
  out.set(offsetTable, offsetTableOffset);
  out.set(trailer, offsetTableOffset + offsetTable.length);
  return out;
}

function buildZip(entries: Array<{ name: string; data: Uint8Array; deflate?: boolean }>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const cdOffset = offset;
  const cdSize = centralParts.reduce((sum, p) => sum + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);

  const out = new Uint8Array(cdOffset + cdSize + eocd.length);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}

function makeKeyedBrushArchive(props: Record<string, BplistNode>): Uint8Array {
  const objects: BplistNode[] = ['$null'];
  const rootDict: Record<string, BplistNode> = {};
  objects.push(rootDict); // UID 1
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string') {
      const uid = objects.length;
      objects.push(v);
      rootDict[k] = { UID: uid };
    } else {
      rootDict[k] = v;
    }
  }
  return buildBinaryPlist({
    $archiver: 'NSKeyedArchiver',
    $version: 100000,
    $top: { root: { UID: 1 } },
    $objects: objects,
  });
}

test('parses single Procreate .brush archive with NSKeyedArchiver bplist00, Shape.png, and Grain.png', async () => {
  const archiveBytes = makeKeyedBrushArchive({
    name: '水彩暈染筆',
    paintSize: { real: 0.4 },
    maxSize: { real: 1.5 },
    minSize: { real: 0.1 },
    plotSpacing: { real: 0.12 },
    plotJitter: { real: 0.18 },
    paintOpacity: { real: 0.85 },
    shapeHardness: { real: 0.6 },
    shapeRoundness: { real: 0.8 },
    shapeAzimuth: true,
    shapeInverted: true,
    dynamicsPressureSize: { real: 0.9 },
    dynamicsPressureOpacity: { real: 0.5 },
    wetMix: { real: 0.45 },
    textureScale: { real: 1.25 },
    textureDepth: { real: 0.7 },
    streamline: { real: 0.5 },
  });

  // Verify raw binary plist + NSKeyedArchiver decoding directly
  const rawPlist = parseBinaryPlist(archiveBytes);
  const unarchived = unarchiveNSKeyed(rawPlist) as Record<string, unknown>;
  assert.equal(unarchived.name, '水彩暈染筆');
  assert.equal(unarchived.shapeAzimuth, true);

  const zipBytes = buildZip([
    { name: 'Brush.archive', data: archiveBytes, deflate: true },
    { name: 'Shape.png', data: TINY_PNG, deflate: true },
    { name: 'Grain.png', data: TINY_PNG, deflate: false },
    { name: '__MACOSX/._Brush.archive', data: Uint8Array.of(1, 2, 3), deflate: false },
  ]);

  const parsed = await parseProcreateArchive(zipBytes, 'Watercolor.brush');
  assert.equal(parsed.brushes.length, 1);
  const b = parsed.brushes[0];
  assert.equal(b.name, '水彩暈染筆');
  assert.equal(b.sourceFormat, 'procreate');
  assert.equal(b.width, 2);
  assert.equal(b.height, 2);
  assert.ok(b.dataUrl?.startsWith('data:image/png;base64,'));
  assert.ok(b.textureDataUrl?.startsWith('data:image/png;base64,'));
  assert.equal(b.size, 72);
  assert.ok(Math.abs((b.spacing ?? 0) - 0.12) < 0.001);
  assert.ok(Math.abs((b.scatter ?? 0) - 0.18) < 0.001);
  assert.ok(Math.abs((b.colorMixing ?? 0) - 0.45) < 0.001);
  assert.equal(b.angleMode, 'direction');
  assert.equal(b.shapeInverted, true);
  assert.equal(b.stabilizerLevel, 5);
  assert.equal(b.dynamics?.size?.pressure, true);
  assert.equal(b.dynamics?.opacity?.pressure, true);

  // Verify end-to-end BrushPackageManager.parseBrushFile integration
  const presets = await BrushPackageManager.parseBrushFile(zipBytes, 'Watercolor.brush');
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, '水彩暈染筆');
  assert.equal(presets[0].properties.size, 72);
  assert.ok(presets[0].tipDataUrl?.startsWith('data:image/png;base64,'));
  assert.ok(presets[0].textureDataUrl?.startsWith('data:image/png;base64,'));
});

test('parses Procreate .brushset preserving brushset.plist order and set name', async () => {
  const brushsetPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>name</key>
  <string>Inking &amp; Sketch Set</string>
  <key>brushes</key>
  <array>
    <string>UUID-SECOND</string>
    <string>UUID-FIRST</string>
  </array>
</dict>
</plist>`;

  const xmlObj = parseXmlPlist(brushsetPlist) as Record<string, unknown>;
  assert.equal(xmlObj.name, 'Inking & Sketch Set');
  assert.deepEqual(xmlObj.brushes, ['UUID-SECOND', 'UUID-FIRST']);

  const firstArchive = makeKeyedBrushArchive({
    name: 'Rough Pencil',
    paintSize: { real: 0.2 },
    plotSpacing: { real: 0.08 },
    dynamicsPressureSize: { real: 0.7 },
  });
  const secondArchive = makeKeyedBrushArchive({
    name: 'G-Pen Crisp',
    paintSize: { real: 0.3 },
    plotSpacing: { real: 0.04 },
    streamline: { real: 0.6 },
  });

  const zipBytes = buildZip([
    { name: 'brushset.plist', data: Buffer.from(brushsetPlist, 'utf8'), deflate: true },
    { name: 'UUID-FIRST/Brush.archive', data: firstArchive, deflate: true },
    { name: 'UUID-FIRST/Shape.png', data: TINY_PNG, deflate: false },
    { name: 'UUID-SECOND/Brush.archive', data: secondArchive, deflate: true },
    { name: 'UUID-SECOND/Shape.png', data: TINY_PNG, deflate: true },
    { name: 'UUID-SECOND/Grain.png', data: TINY_PNG, deflate: true },
  ]);

  const presets = await BrushPackageManager.parseBrushFile(zipBytes, 'MyInks.brushset');
  assert.equal(presets.length, 2);
  assert.equal(presets[0].category, 'Inking & Sketch Set');
  assert.equal(presets[0].name, 'G-Pen Crisp');
  assert.equal(presets[1].name, 'Rough Pencil');
  assert.ok(presets[0].textureDataUrl?.startsWith('data:image/png;base64,'));
  assert.equal(presets[1].textureDataUrl, null);
});
