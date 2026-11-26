import assert from 'node:assert/strict';
import {
  BrushPackageManager,
  DEFAULT_COMMUNITY_PRESETS,
  ProcreateParser,
  SutParser,
  blendPigmentColors,
  computeWetEdgeParams,
  evaluateColorDynamics,
  hasActiveColorDynamics,
  hslToRgb,
  normalizeColorDynamics,
  rgbToHsl,
  selectBrushTipIndex,
  stepPigmentReservoir,
} from '@atelier/shared';
import { BRUSH_TOOL_DEFAULTS, eraserStrokeProperties } from '../src/engine/brushToolSettings';
import { translations } from '../src/locales';

const PNG_1X1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff,
  0x89, 0x99, 0x3d, 0x1d,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  bytes.push(v & 0x7f);
  v >>>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return bytes;
}

function buildSyntheticSqlite(
  tables: Array<{ name: string; sql: string; rows: Array<{ rowId: number; values: Array<string | number | Uint8Array | null> }> }>,
): Uint8Array {
  const pageSize = 4096;
  const pageCount = 1 + tables.length;
  const db = new Uint8Array(pageSize * pageCount);
  const view = new DataView(db.buffer);
  const header = new TextEncoder().encode('SQLite format 3\0');
  db.set(header, 0);
  view.setUint16(16, pageSize, false);
  db[18] = 1;
  db[19] = 1;
  db[21] = 64;
  db[22] = 32;
  db[23] = 32;

  const encodeRecord = (values: Array<string | number | Uint8Array | null>): Uint8Array => {
    const types: number[] = [];
    const bodies: Uint8Array[] = [];
    const enc = new TextEncoder();
    for (const val of values) {
      if (val === null) {
        types.push(0);
      } else if (typeof val === 'number') {
        if (Number.isInteger(val) && val >= -128 && val <= 127) {
          types.push(1);
          const b = new Uint8Array(1);
          new DataView(b.buffer).setInt8(0, val);
          bodies.push(b);
        } else if (Number.isInteger(val) && val >= -32768 && val <= 32767) {
          types.push(2);
          const b = new Uint8Array(2);
          new DataView(b.buffer).setInt16(0, val, false);
          bodies.push(b);
        } else {
          types.push(7);
          const b = new Uint8Array(8);
          new DataView(b.buffer).setFloat64(0, val, false);
          bodies.push(b);
        }
      } else if (typeof val === 'string') {
        const bytes = enc.encode(val);
        types.push(...encodeVarint(bytes.length * 2 + 13));
        bodies.push(bytes);
      } else {
        types.push(...encodeVarint(val.length * 2 + 12));
        bodies.push(val);
      }
    }
    const headerLenBytes = encodeVarint(types.length + 1);
    const totalHeader = headerLenBytes.length + types.length;
    const finalHeaderLen = encodeVarint(totalHeader);
    const bodyLen = bodies.reduce((sum, b) => sum + b.length, 0);
    const out = new Uint8Array(finalHeaderLen.length + types.length + bodyLen);
    let pos = 0;
    out.set(finalHeaderLen, pos); pos += finalHeaderLen.length;
    out.set(types, pos); pos += types.length;
    for (const b of bodies) {
      out.set(b, pos);
      pos += b.length;
    }
    return out;
  };

  const writeLeafPage = (pageNum: number, rows: Array<{ rowId: number; values: Array<string | number | Uint8Array | null> }>) => {
    const pageOff = (pageNum - 1) * pageSize;
    const hdrOff = pageNum === 1 ? 100 : 0;
    db[pageOff + hdrOff] = 0x0d; // leaf table b-tree
    view.setUint16(pageOff + hdrOff + 3, rows.length, false);
    let contentPtr = pageSize;
    const ptrs: number[] = [];
    for (const row of rows) {
      const rec = encodeRecord(row.values);
      const cellParts = [...encodeVarint(rec.length), ...encodeVarint(row.rowId)];
      const cellLen = cellParts.length + rec.length;
      contentPtr -= cellLen;
      db.set(cellParts, pageOff + contentPtr);
      db.set(rec, pageOff + contentPtr + cellParts.length);
      ptrs.push(contentPtr);
    }
    view.setUint16(pageOff + hdrOff + 5, contentPtr, false);
    for (let i = 0; i < ptrs.length; i++) {
      view.setUint16(pageOff + hdrOff + 8 + i * 2, ptrs[i], false);
    }
  };

  writeLeafPage(
    1,
    tables.map((t, idx) => ({
      rowId: idx + 1,
      values: ['table', t.name, t.name, idx + 2, t.sql],
    })),
  );
  tables.forEach((t, idx) => writeLeafPage(idx + 2, t.rows));
  return db;
}

function buildStoredZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  const crc32 = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + nameBytes.length + file.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.data.length, true);
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(file.data, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.data.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of localParts) { out.set(p, pos); pos += p.length; }
  for (const p of centralParts) { out.set(p, pos); pos += p.length; }
  out.set(eocd, pos);
  return out;
}

export async function runV15Phase3BrushV3Checks(): Promise<void> {
  // 1. Multi-tip playback modes (3.1)
  assert.equal(selectBrushTipIndex(4, 'single', 3, 2, 0.9), 0);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((i) => selectBrushTipIndex(3, 'sequential', i, i - 1, 0.2)),
    [0, 1, 2, 0, 1, 2],
  );
  assert.equal(selectBrushTipIndex(4, 'random', 0, 0, 0.76), 3);
  for (let prev = 0; prev < 4; prev++) {
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const next = selectBrushTipIndex(4, 'randomNoRepeat', 5, prev, r);
      assert.notEqual(next, prev, `randomNoRepeat must never repeat index ${prev}`);
      assert.ok(next >= 0 && next < 4);
    }
  }

  // 2. Color Dynamics HSL math, per-dab vs per-stroke scope, pressure & stroke gradient (3.2)
  const hsl = rgbToHsl(230, 80, 40);
  const roundTripped = hslToRgb(hsl.h, hsl.s, hsl.l);
  assert.ok(Math.abs(roundTripped.r - 230) <= 2 && Math.abs(roundTripped.g - 80) <= 2 && Math.abs(roundTripped.b - 40) <= 2);

  const normalizedCd = normalizeColorDynamics({
    scope: 'perStroke',
    hueJitter: 2.5,
    huePressure: -2,
    lightnessGradient: 1.5,
    gradientLength: 10,
  });
  assert.equal(normalizedCd?.scope, 'perStroke');
  assert.equal(normalizedCd?.hueJitter, 1);
  assert.equal(normalizedCd?.huePressure, -1);
  assert.equal(normalizedCd?.lightnessGradient, 1);
  assert.equal(normalizedCd?.gradientLength, 50);
  assert.equal(hasActiveColorDynamics(normalizedCd), true);
  assert.equal(hasActiveColorDynamics(undefined, {}), false);

  const baseRed = { r: 220, g: 40, b: 40 };
  const secBlue = { r: 40, g: 80, b: 220 };
  const perStrokeA = evaluateColorDynamics(baseRed, secBlue, { scope: 'perStroke', hueJitter: 0.6 }, {
    pressure: 0.5, strokeProgress: 0,
    randH: 0.1, randS: 0.1, randL: 0.1, randMix: 0.1,
    strokeRandH: 0.85, strokeRandS: 0.5, strokeRandL: 0.5, strokeRandMix: 0.5,
  });
  const perStrokeB = evaluateColorDynamics(baseRed, secBlue, { scope: 'perStroke', hueJitter: 0.6 }, {
    pressure: 0.5, strokeProgress: 0,
    randH: 0.95, randS: 0.9, randL: 0.9, randMix: 0.9,
    strokeRandH: 0.85, strokeRandS: 0.5, strokeRandL: 0.5, strokeRandMix: 0.5,
  });
  assert.deepEqual(perStrokeA, perStrokeB, 'perStroke scope must stay identical across dabs in the same stroke');

  const perDabA = evaluateColorDynamics(baseRed, secBlue, { scope: 'perDab', hueJitter: 0.6 }, {
    pressure: 0.5, strokeProgress: 0,
    randH: 0.1, randS: 0.5, randL: 0.5, randMix: 0.5,
    strokeRandH: 0.5, strokeRandS: 0.5, strokeRandL: 0.5, strokeRandMix: 0.5,
  });
  const perDabB = evaluateColorDynamics(baseRed, secBlue, { scope: 'perDab', hueJitter: 0.6 }, {
    pressure: 0.5, strokeProgress: 0,
    randH: 0.9, randS: 0.5, randL: 0.5, randMix: 0.5,
    strokeRandH: 0.5, strokeRandS: 0.5, strokeRandL: 0.5, strokeRandMix: 0.5,
  });
  assert.notDeepEqual(perDabA, perDabB, 'perDab scope must vary across dabs');

  const lowPress = evaluateColorDynamics(baseRed, null, { lightnessPressure: 0.8 }, {
    pressure: 0.1, strokeProgress: 0,
    randH: 0.5, randS: 0.5, randL: 0.5, randMix: 0.5,
    strokeRandH: 0.5, strokeRandS: 0.5, strokeRandL: 0.5, strokeRandMix: 0.5,
  });
  const highPress = evaluateColorDynamics(baseRed, null, { lightnessPressure: 0.8 }, {
    pressure: 0.95, strokeProgress: 0,
    randH: 0.5, randS: 0.5, randL: 0.5, randMix: 0.5,
    strokeRandH: 0.5, strokeRandS: 0.5, strokeRandL: 0.5, strokeRandMix: 0.5,
  });
  assert.ok(highPress.r + highPress.g + highPress.b > lowPress.r + lowPress.g + lowPress.b, 'Positive lightnessPressure must brighten at higher pressure');

  const gradStart = evaluateColorDynamics(baseRed, secBlue, { fgBgGradient: true, fgBgMix: 1 }, {
    pressure: 0.5, strokeProgress: 0,
    randH: 0.5, randS: 0.5, randL: 0.5, randMix: 0.5,
    strokeRandH: 0.5, strokeRandS: 0.5, strokeRandL: 0.5, strokeRandMix: 0.5,
  });
  const gradEnd = evaluateColorDynamics(baseRed, secBlue, { fgBgGradient: true, fgBgMix: 1 }, {
    pressure: 0.5, strokeProgress: 1,
    randH: 0.5, randS: 0.5, randL: 0.5, randMix: 0.5,
    strokeRandH: 0.5, strokeRandS: 0.5, strokeRandL: 0.5, strokeRandMix: 0.5,
  });
  assert.ok(gradStart.r > gradStart.b && gradEnd.b > gradEnd.r, 'fgBgGradient must transition from foreground to secondary along stroke');

  // 3. Wet Edge params & Advanced Subtractive Pigment Blending (3.3)
  const wet = computeWetEdgeParams(0.8, 0.3, 0.6, { r: 60, g: 140, b: 220 });
  assert.ok(wet.innerScale > 0.4 && wet.innerScale < 0.85);
  assert.ok(wet.innerEraseAlpha > 0.25 && wet.rimAlpha > 0.2);
  assert.ok(wet.rimRgb.b < 220, 'Wet edge rim pigment should darken relative to base color');

  const yellow = { r: 255, g: 212, b: 0 };
  const blue = { r: 0, g: 87, b: 255 };
  const subMix = blendPigmentColors(yellow, blue, 0.5, 'subtractive', 1.0);
  const rgbMix = blendPigmentColors(yellow, blue, 0.5, 'rgb', 1.0);
  assert.ok(subMix.g > subMix.r && subMix.g > subMix.b, `Subtractive yellow+blue must yield green, got rgb(${subMix.r},${subMix.g},${subMix.b})`);
  assert.ok(subMix.g - Math.max(subMix.r, subMix.b) > rgbMix.g - Math.max(rgbMix.r, rgbMix.b), 'Subtractive pigment blend must be greener than naive RGB blend');

  const resStep1 = stepPigmentReservoir(null, yellow, blue, {
    mixMode: 'blend',
    pigmentBlendMode: 'subtractive',
    pigmentStrength: 1.0,
    colorMixing: 0.85,
    paintAmount: 0.4,
    colorStretch: 0.2,
    pressure: 0.5,
    sampledAlpha: 1,
    strokeDistancePx: 0,
    chargeDepletion: 0.8,
  });
  const resStepFar = stepPigmentReservoir(resStep1.nextReservoir, yellow, blue, {
    mixMode: 'blend',
    pigmentBlendMode: 'subtractive',
    pigmentStrength: 1.0,
    colorMixing: 0.85,
    paintAmount: 0.4,
    colorStretch: 0.2,
    pressure: 0.5,
    sampledAlpha: 1,
    strokeDistancePx: 1500,
    chargeDepletion: 0.8,
  });
  assert.equal(resStep1.skipDab, false);
  assert.ok(resStep1.dabColor.g > resStep1.dabColor.b, 'Reservoir pickup should mix toward greenish pigment');
  assert.ok(resStepFar.alphaMultiplier < resStep1.alphaMultiplier, 'chargeDepletion must attenuate alpha over distance');

  const emptySmudge = stepPigmentReservoir(null, yellow, null, {
    mixMode: 'smudge',
    colorMixing: 0.8,
    paintAmount: 0.5,
    colorStretch: 0.5,
    pressure: 0.5,
    sampledAlpha: 0,
    hasSampledSmudge: false,
  });
  assert.equal(emptySmudge.skipDab, true);

  // 4. Deep .sut SQLite v3 parsing (3.4)
  const sutDb = buildSyntheticSqlite([
    {
      name: 'Node',
      sql: 'CREATE TABLE Node (_PW_ID INTEGER PRIMARY KEY, NodeName TEXT, NodeVariantID INTEGER)',
      rows: [{ rowId: 1, values: [null, 'CSP Dual Watercolor v3', 20] }],
    },
    {
      name: 'Variant',
      sql: 'CREATE TABLE Variant (VariantID INTEGER PRIMARY KEY, BrushSize REAL, Opacity INTEGER, BrushUseDualBrush INTEGER, BrushDualBrushBlendMode INTEGER, BrushDualSize REAL, BrushDualInterval INTEGER, BrushDualScatter INTEGER, BrushPatternOrderType INTEGER, BrushUseChangeColor INTEGER, BrushChangeColorUnit INTEGER, BrushChangeColorHue INTEGER, BrushHuePressure INTEGER, BrushWaterEdge INTEGER, BrushWaterEdgeOpacity INTEGER, BrushWaterEdgeRadius INTEGER, BrushWaterEdgeDarkness INTEGER, BrushMixColor INTEGER, BrushUseTexture INTEGER, BrushTextureDensity INTEGER, BrushTextureMode INTEGER, BrushTextureContrast INTEGER)',
      rows: [{
        rowId: 20,
        values: [20, 44, 92, 1, 3, 26.4, 45, 80, 4, 1, 1, 30, 50, 1, 70, 28, 55, 1, 1, 65, 2, 20],
      }],
    },
    {
      name: 'MaterialFile',
      sql: 'CREATE TABLE MaterialFile (_PW_ID INTEGER PRIMARY KEY, OriginalPath TEXT, FileData BLOB)',
      rows: [
        { rowId: 1, values: [null, 'tips/bristle_a.png', PNG_1X1] },
        { rowId: 2, values: [null, 'tips/bristle_b.png', PNG_1X1] },
        { rowId: 3, values: [null, 'tips/dual_speckle.png', PNG_1X1] },
        { rowId: 4, values: [null, 'paper/watercolor_texture.png', PNG_1X1] },
      ],
    },
  ]);

  const sutTips = new SutParser(sutDb.buffer).parse();
  assert.equal(sutTips.length, 1, 'Multi-tip SUT subtool should collapse into 1 multi-tip brush');
  const sutTip = sutTips[0];
  assert.equal(sutTip.dualBrush, true);
  assert.equal(sutTip.dualBlendMode, 'screen');
  assert.ok(Math.abs((sutTip.dualSize ?? 0) - 0.6) < 0.02);
  assert.ok(Math.abs((sutTip.dualSpacing ?? 0) - 0.45) < 0.02);
  assert.ok(Math.abs((sutTip.dualScatter ?? 0) - 0.8) < 0.02);
  assert.ok(sutTip.dualTipDataUrl?.startsWith('data:image/png;base64,'));
  assert.equal(sutTip.tipPlayMode, 'randomNoRepeat');
  assert.equal(sutTip.tipUrls?.length, 2);
  assert.equal(sutTip.colorDynamics?.scope, 'perStroke');
  assert.ok(Math.abs((sutTip.colorDynamics?.hueJitter ?? 0) - 0.3) < 0.02);
  assert.ok(Math.abs((sutTip.colorDynamics?.huePressure ?? 0) - 0.5) < 0.02);
  assert.equal(sutTip.wetEdges, true);
  assert.ok(Math.abs((sutTip.wetEdgeStrength ?? 0) - 0.7) < 0.02);
  assert.ok(Math.abs((sutTip.wetEdgeWidth ?? 0) - 0.28) < 0.02);
  assert.ok(Math.abs((sutTip.wetEdgeDarkness ?? 0) - 0.55) < 0.02);
  assert.equal(sutTip.pigmentBlendMode, 'subtractive');
  assert.equal(sutTip.textureBlendMode, 'overlay');
  assert.ok(sutTip.textureDataUrl?.startsWith('data:image/png;base64,'));

  // 5. Deep .brushset / Procreate v3 parsing & BrushPackageManager round-trip (3.4)
  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>name</key><string>Procreate Dual Pigment v3</string>
  <key>paintSize</key><real>0.35</real>
  <key>bundledBrush</key><true/>
  <key>bundledBrushCombineMode</key><integer>4</integer>
  <key>bundledBrushSize</key><real>0.55</real>
  <key>bundledBrushSpacing</key><real>0.4</real>
  <key>bundledBrushScatter</key><real>0.75</real>
  <key>shapeOrder</key><string>sequential</string>
  <key>dynamicsStrokeJitterHue</key><real>0.35</real>
  <key>colorDynamicsPressureHue</key><real>0.45</real>
  <key>wetEdges</key><true/>
  <key>wetEdgesStrength</key><real>0.68</real>
  <key>wetEdgesWidth</key><real>0.24</real>
  <key>wetEdgesDarkness</key><real>0.5</real>
  <key>wetMix</key><real>0.72</real>
  <key>dynamicsPull</key><real>0.4</real>
  <key>dynamicsDepletion</key><real>0.3</real>
  <key>textureDepth</key><real>0.6</real>
  <key>grainBlendMode</key><string>multiply</string>
</dict>
</plist>`;
  const brushsetPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>name</key><string>V3 Test Set</string><key>brushes</key><array><string>b1</string></array></dict></plist>`;

  const enc = new TextEncoder();
  const procreateZip = buildStoredZip([
    { name: 'brushset.plist', data: enc.encode(brushsetPlist) },
    { name: 'b1/Brush.archive', data: enc.encode(plistXml) },
    { name: 'b1/Shape.png', data: PNG_1X1 },
    { name: 'b1/Shape_2.png', data: PNG_1X1 },
    { name: 'b1/DualShape.png', data: PNG_1X1 },
    { name: 'b1/Grain.png', data: PNG_1X1 },
  ]);

  const parsedPro = await new ProcreateParser(procreateZip, 'V3Test.brushset').parse();
  assert.equal(parsedPro.setName, 'V3 Test Set');
  assert.equal(parsedPro.brushes.length, 1);
  const pb = parsedPro.brushes[0];
  assert.equal(pb.dualBrush, true);
  assert.equal(pb.dualBlendMode, 'overlay');
  assert.ok(Math.abs((pb.dualSize ?? 0) - 0.55) < 0.02);
  assert.ok(Math.abs((pb.dualSpacing ?? 0) - 0.4) < 0.02);
  assert.ok(Math.abs((pb.dualScatter ?? 0) - 0.75) < 0.02);
  assert.ok(pb.dualTipDataUrl?.startsWith('data:image/png;base64,'));
  assert.equal(pb.tipPlayMode, 'sequential');
  assert.equal(pb.tipUrls?.length, 2);
  assert.equal(pb.colorDynamics?.scope, 'perStroke');
  assert.ok(Math.abs((pb.colorDynamics?.hueJitter ?? 0) - 0.35) < 0.02);
  assert.ok(Math.abs((pb.colorDynamics?.huePressure ?? 0) - 0.45) < 0.02);
  assert.equal(pb.wetEdges, true);
  assert.ok(Math.abs((pb.wetEdgeStrength ?? 0) - 0.68) < 0.02);
  assert.ok(Math.abs((pb.wetEdgeWidth ?? 0) - 0.24) < 0.02);
  assert.ok(Math.abs((pb.wetEdgeDarkness ?? 0) - 0.5) < 0.02);
  assert.equal(pb.pigmentBlendMode, 'subtractive');
  assert.equal(pb.textureBlendMode, 'multiply');

  const pkgPresets = await BrushPackageManager.parseBrushFile(procreateZip.buffer, 'V3Test.brushset');
  assert.equal(pkgPresets.length, 1);
  assert.equal(pkgPresets[0].properties.dualBlendMode, 'overlay');
  assert.equal(pkgPresets[0].properties.tipPlayMode, 'sequential');
  assert.equal(pkgPresets[0].properties.tipUrls?.length, 2);
  assert.equal(pkgPresets[0].properties.colorDynamics?.scope, 'perStroke');
  assert.equal(pkgPresets[0].properties.pigmentBlendMode, 'subtractive');

  // 6. Built-in presets, tool defaults, eraser reset, and 4 locales
  const wcPreset = DEFAULT_COMMUNITY_PRESETS.find((p) => p.id === 'preset_csp_watercolor')!;
  const oilPreset = DEFAULT_COMMUNITY_PRESETS.find((p) => p.id === 'preset_thick_oil_impasto')!;
  assert.equal(wcPreset.properties.pigmentBlendMode, 'subtractive');
  assert.equal(oilPreset.properties.pigmentBlendMode, 'subtractive');
  assert.equal(BRUSH_TOOL_DEFAULTS.brush.pigmentBlendMode, 'subtractive');
  assert.equal(BRUSH_TOOL_DEFAULTS.brush.dualSpacing, 0.35);
  const eraserReset = eraserStrokeProperties({
    ...(BRUSH_TOOL_DEFAULTS.brush as any),
    color: '#000000',
    dualBrush: true,
    wetEdges: true,
    tipUrls: ['data:image/png;base64,AA=='],
    tipPlayMode: 'random',
    colorDynamics: { scope: 'perStroke', hueJitter: 0.5 },
  });
  assert.equal(eraserReset.dualBrush, false);
  assert.equal(eraserReset.wetEdges, false);
  assert.equal(eraserReset.tipPlayMode, 'single');
  assert.equal(eraserReset.colorDynamics, undefined);

  for (const [loc, tr] of Object.entries(translations)) {
    assert.ok(tr.studio.dualModeScreen.length > 0, `${loc} missing dualModeScreen`);
    assert.ok(tr.studio.dualModeOverlay.length > 0, `${loc} missing dualModeOverlay`);
    assert.ok(tr.studio.multiTipSequential.length > 0, `${loc} missing multiTipSequential`);
    assert.ok(tr.studio.colorScopePerStroke.length > 0, `${loc} missing colorScopePerStroke`);
    assert.ok(tr.studio.wetEdgeDarkness.length > 0, `${loc} missing wetEdgeDarkness`);
    assert.ok(tr.studio.pigmentModelSubtractive.length > 0, `${loc} missing pigmentModelSubtractive`);
  }
}
