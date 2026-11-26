/**
 * Clip Studio Paint (.sut) Sub-Tool Brush Parser
 * Reads SQLite 3 Node/Variant/MaterialFile tables (zero dependencies) to restore
 * brush parameters, dynamics effectors, color mixing, textures, and embedded tip bitmaps.
 * Falls back cleanly to raw PNG/JPEG scanning for non-SQLite or stripped files.
 */

import type { ParsedBrushTip } from './abr-parser';
import { MIN_BRUSH_SPACING } from './brush-spacing';
import type { PigmentBlendModel } from '../color/pigment-blend';
import { normalizeColorDynamics } from './brush-dynamics';
import type {
  BrushDynamicChannel,
  BrushDynamicsConfig,
  BrushTextureBlendMode,
  BrushTipPlayMode,
  DualBrushBlendMode,
  DualTipShape,
} from './brush-dynamics';
import { isSqlite3Buffer, SqliteReader, type SqliteRow, type SqliteValue } from './sqlite-reader';

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const percentOrRatio = (value: number): number => Math.abs(value) > 1 ? value / 100 : value;
const dualBlendModes: readonly DualBrushBlendMode[] = ['multiply', 'darken', 'subtract', 'screen', 'overlay'];
const dualTipShapes: readonly DualTipShape[] = ['same', 'round', 'soft', 'speckle', 'bristle', 'square', 'custom'];
const tipPlayModes: readonly BrushTipPlayMode[] = ['single', 'sequential', 'sequential', 'random', 'randomNoRepeat'];
const pigmentBlendModes: readonly PigmentBlendModel[] = ['rgb', 'oklab', 'subtractive'];

interface EmbeddedImage {
  width: number;
  height: number;
  dataUrl: string;
  isTextureHint: boolean;
}

/**
 * Decodes a big-endian CSP *Effector binary blob into a BrushDynamicChannel.
 * CSP effector blobs encode a 32-bit controller bitmask (pressure / tilt / velocity / random)
 * and optional minimum ratio in big-endian fields. Unknown layouts degrade safely without throwing.
 */
export function parseSutEffectorBlob(blob: Uint8Array | null | undefined): BrushDynamicChannel | undefined {
  if (!blob || blob.length < 8) return undefined;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

  // Common CSP Effector header layout:
  // [0..3]: version/magic (usually 4 or 0x0000002c / 0x00000038 or small int)
  // [4..7]: flags bitmask (0x01=pressure, 0x02=tilt, 0x04=velocity, 0x08=random)
  // [8..11] or [12..15]: optional min value (float32 or int32 percentage 0..100 / 0..1000)
  const w0 = view.getUint32(0, false);
  const w1 = view.getUint32(4, false);

  // Detect which word carries the bitmask flags (some versions put flags at offset 4, others at offset 8)
  let flags = w1;
  let minOffset = 8;
  if (flags === 0 && blob.length >= 12) {
    const w2 = view.getUint32(8, false);
    if ((w2 & 0x0f) !== 0 && w2 <= 0xff) {
      flags = w2;
      minOffset = 12;
    }
  }
  // If w0 itself is a small flag mask (compact 8-byte effector)
  if ((flags & 0x0f) === 0 && (w0 & 0x0f) !== 0 && w0 <= 0xff) {
    flags = w0;
    minOffset = 4;
  }

  const pressure = (flags & 0x01) !== 0;
  const tilt = (flags & 0x02) !== 0;
  const velocity = (flags & 0x04) !== 0;
  const hasRandom = (flags & 0x08) !== 0;

  if (!pressure && !tilt && !velocity && !hasRandom) {
    return { pressure: false, tilt: false, velocity: false, random: 0, min: 0 };
  }

  let min = 0;
  if (blob.length >= minOffset + 4) {
    const rawInt = view.getInt32(minOffset, false);
    const rawFloat = view.getFloat32(minOffset, false);
    if (rawInt > 0 && rawInt <= 100) {
      min = clamp01(rawInt / 100);
    } else if (rawInt > 100 && rawInt <= 1000) {
      min = clamp01(rawInt / 1000);
    } else if (Number.isFinite(rawFloat) && rawFloat >= 0.001 && rawFloat <= 1) {
      min = clamp01(rawFloat);
    }
  }

  return {
    pressure,
    tilt,
    velocity,
    random: hasRandom ? 0.35 : 0,
    min,
  };
}

export class SutParser {
  private buffer: Uint8Array;

  constructor(arrayBuffer: ArrayBuffer) {
    this.buffer = new Uint8Array(arrayBuffer);
  }

  public parse(): ParsedBrushTip[] {
    if (isSqlite3Buffer(this.buffer)) {
      const sqliteTips = this.parseSqliteSut();
      if (sqliteTips.length > 0) return sqliteTips;
    }

    const toolTitle = this.extractToolName() || '匯入筆刷 (SubTool)';
    const images = this.scanEmbeddedImages(this.buffer, false);
    if (images.length > 0) {
      return images.map((img, idx) => ({
        id: `sut_tip_${idx + 1}`,
        name: images.length === 1 ? toolTitle : `${toolTitle} - 筆尖貼圖 #${idx + 1} (${img.width}x${img.height})`,
        width: img.width,
        height: img.height,
        dataUrl: img.dataUrl,
        spacing: MIN_BRUSH_SPACING,
        hardness: 0.8,
        sourceFormat: 'sut',
      }));
    }

    return [this.createParametricCspTip(toolTitle)];
  }

  private parseSqliteSut(): ParsedBrushTip[] {
    let reader: SqliteReader;
    try {
      reader = new SqliteReader(this.buffer);
    } catch {
      return [];
    }

    const nodes = reader.readTable('Node');
    const variants = reader.readTable('Variant');
    const materials = reader.readTable('MaterialFile');

    // Classify MaterialFile images before falling back to a scan of the whole database.
    const tipImages: EmbeddedImage[] = [];
    const dualTipImages: EmbeddedImage[] = [];
    const textureImages: EmbeddedImage[] = [];
    for (const mat of materials) {
      const pathStr = ['OriginalPath', 'CatalogPath', 'FilePath']
        .map((key) => this.pickString(mat, [key]) ?? '').join('/').toLowerCase();
      const isDual = /dual|second|2nd|subtip|[雙双][筆笔]|[雙双]重|第二[筆笔]尖|副[筆笔]尖|デュアル|サブブラシ/.test(pathStr);
      const isTexture = /texture|paper|grain|紙|テクスチャ/.test(pathStr);
      const fileData = this.pickColumn(mat, ['FileData', 'Data', 'ImageData']);
      if (fileData instanceof Uint8Array && fileData.length > 16) {
        const imgs = this.scanEmbeddedImages(fileData, isTexture);
        for (const img of imgs) {
          if (isDual) dualTipImages.push(img);
          else if (img.isTextureHint) textureImages.push(img);
          else tipImages.push(img);
        }
      }
    }
    // Fallback raw scan if MaterialFile stored images elsewhere in the SQLite file
    if (tipImages.length === 0) {
      const classifiedUrls = new Set([...dualTipImages, ...textureImages].map((img) => img.dataUrl));
      const rawImgs = this.scanEmbeddedImages(this.buffer, false).filter((img) => !classifiedUrls.has(img.dataUrl));
      tipImages.push(...rawImgs);
    }

    // Index variants by VariantID (or rowid)
    const variantById = new Map<number, SqliteRow>();
    for (const v of variants) {
      const vid = this.pickNumber(v, ['VariantID', '_PW_ID', 'id', '_rowid']);
      if (vid !== null) variantById.set(vid, v);
    }

    // Determine primary tool name and target variant row(s)
    const namedNodes = nodes.filter((n) => {
      const name = this.pickString(n, ['NodeName', 'Name']);
      return Boolean(name && name.trim().length > 0);
    });

    const primaryNode = namedNodes[0] ?? nodes[0];
    const toolName =
      this.pickString(primaryNode, ['NodeName', 'Name'])?.trim() ||
      this.extractToolName() ||
      '匯入筆刷 (SubTool)';

    const targetVariantId = primaryNode
      ? this.pickNumber(primaryNode, ['NodeVariantID', 'VariantID', 'NodeInitVariantID'])
      : null;
    const primaryVariant =
      (targetVariantId !== null ? variantById.get(targetVariantId) : undefined) ??
      variants[0] ??
      null;

    const restored = primaryVariant ? this.mapVariantToProps(primaryVariant) : {};
    const textureDataUrl = textureImages[0]?.dataUrl ?? null;
    const multiTipFlag = this.pickNumber(primaryVariant ?? undefined, ['BrushUseMultiTip', 'UseMultiTip', 'BrushMultiTip']);
    const hasMultiTip = tipImages.length >= 2
      && ((restored.tipPlayMode ?? 'single') !== 'single' || (multiTipFlag ?? 0) > 0);
    if (hasMultiTip) {
      restored.tipUrls = tipImages.map((img) => img.dataUrl);
      restored.tipPlayMode ??= 'sequential';
    }
    const dualTip = dualTipImages[0] ?? (restored.dualBrush ? tipImages[1] : undefined);
    if (dualTip) {
      restored.dualTipDataUrl = dualTip.dataUrl;
      if (restored.dualBrush !== false) {
        restored.dualBrush = true;
        restored.dualTipShape = 'custom';
      }
    }

    const results: ParsedBrushTip[] = [];
    if (tipImages.length > 0) {
      const presetCount = hasMultiTip || restored.dualBrush ? 1 : tipImages.length;
      for (let i = 0; i < presetCount; i++) {
        const img = tipImages[i];
        results.push({
          id: `sut_sqlite_tip_${i + 1}`,
          name: presetCount === 1 ? toolName : `${toolName} #${i + 1}`,
          width: img.width,
          height: img.height,
          dataUrl: img.dataUrl,
          textureDataUrl,
          ...restored,
          sourceFormat: 'sut',
        });
      }
    } else {
      // Procedural / round CSP sub-tool without custom tip bitmap
      results.push({
        id: 'sut_sqlite_procedural',
        name: toolName,
        width: Math.round(restored.size ?? 32),
        height: Math.round(restored.size ?? 32),
        dataUrl: null,
        textureDataUrl,
        ...restored,
        sourceFormat: 'sut',
      });
    }

    return results;
  }

  private mapVariantToProps(row: SqliteRow): Partial<ParsedBrushTip> {
    const out: Partial<ParsedBrushTip> = {};
    const dynamics: BrushDynamicsConfig = {};

    // Brush size (CSP may store raw px or 0.1px integer scale depending on version)
    const rawSize = this.pickNumber(row, ['BrushSize', 'Size']);
    if (rawSize !== null && rawSize > 0) {
      const px = rawSize > 500 ? rawSize / 10 : rawSize;
      out.size = Math.max(1, Math.min(500, Math.round(px * 10) / 10));
    }

    // Opacity (0..100 or 0..1)
    const rawOpacity = this.pickNumber(row, ['Opacity', 'BrushOpacity']);
    if (rawOpacity !== null) {
      out.opacity = clamp01(rawOpacity > 1 ? rawOpacity / 100 : rawOpacity);
    }

    // Paint Density / Flow (0..100 or 0..1)
    const rawDensity = this.pickNumber(row, ['BrushDensityOfPaint', 'BrushDensity', 'BrushFlow']);
    if (rawDensity !== null) {
      out.flow = clamp01(rawDensity > 1 ? rawDensity / 100 : rawDensity);
    }

    // Hardness (CSP uses 1..5 discrete steps or 0..100 percentage)
    const rawHardness = this.pickNumber(row, ['BrushHardness', 'Hardness']);
    if (rawHardness !== null) {
      if (rawHardness >= 1 && rawHardness <= 5 && Number.isInteger(rawHardness)) {
        out.hardness = clamp01((rawHardness - 1) / 4);
      } else {
        out.hardness = clamp01(rawHardness > 1 ? rawHardness / 100 : rawHardness);
      }
    }

    // Spacing / Interval (CSP percentage or 0..1)
    const rawInterval = this.pickNumber(row, ['BrushInterval', 'BrushGap', 'BrushSpacing']);
    if (rawInterval !== null && rawInterval > 0) {
      const ratio = rawInterval > 1.5 ? rawInterval / 100 : rawInterval;
      out.spacing = Math.max(MIN_BRUSH_SPACING, Math.min(1.5, ratio));
    }

    // Thickness / Roundness (0..100 or 1..2000)
    const rawThickness = this.pickNumber(row, ['BrushThickness', 'BrushRoundness']);
    if (rawThickness !== null && rawThickness > 0) {
      const ratio = rawThickness > 100 ? rawThickness / 1000 : rawThickness > 1 ? rawThickness / 100 : rawThickness;
      out.roundness = Math.max(0.1, Math.min(1, ratio));
    }

    // Angle & Direction
    const rawAngle = this.pickNumber(row, ['BrushAngle', 'BrushDirectionAngle']);
    if (rawAngle !== null) {
      let deg = rawAngle > 360 || rawAngle < -360 ? rawAngle / 10 : rawAngle;
      while (deg > 90) deg -= 180;
      while (deg < -90) deg += 180;
      out.angle = Math.round(deg);
    }
    const rawAngleMode = this.pickNumber(row, ['BrushDirection', 'BrushAngleMode']);
    if (rawAngleMode === 1) out.angleMode = 'direction';
    else if (rawAngleMode === 2 || rawAngleMode === 3) out.angleMode = 'pen';
    else if (rawAngleMode === 0) out.angleMode = 'fixed';

    const useDual = this.pickNumber(row, ['BrushUseDualBrush', 'UseDualBrush', 'DualBrushEnable', 'BrushUse2ndBrush']);
    if (useDual !== null) out.dualBrush = useDual > 0;
    const dualBlend = this.pickNumber(row, ['BrushDualBrushBlendMode', 'DualBrushBlendMode', 'Brush2ndBlendMode']);
    if (dualBlend !== null) out.dualBlendMode = dualBlendModes[dualBlend];
    const dualSize = this.pickNumber(row, ['BrushDualSize', 'DualBrushSize', 'Brush2ndSize']);
    if (dualSize !== null) {
      const ratio = dualSize > 1 ? dualSize / (out.size ?? 32) : dualSize;
      out.dualSize = Math.max(0.1, Math.min(1, ratio));
    }
    const dualSpacing = this.pickNumber(row, ['BrushDualInterval', 'BrushDualSpacing', 'Brush2ndInterval']);
    if (dualSpacing !== null) out.dualSpacing = Math.max(0.05, Math.min(2, dualSpacing > 2 ? dualSpacing / 100 : dualSpacing));
    const dualScatter = this.pickNumber(row, ['BrushDualScatter', 'BrushDualSprayDeviation', 'Brush2ndSprayDeviation']);
    if (dualScatter !== null) out.dualScatter = Math.max(0, Math.min(2, dualScatter > 2 ? dualScatter / 100 : dualScatter));
    const dualShape = this.pickColumn(row, ['BrushDualTipShape', 'DualBrushShape']);
    if (typeof dualShape === 'number') out.dualTipShape = dualTipShapes[dualShape];
    else if (typeof dualShape === 'string') out.dualTipShape = dualTipShapes.find((shape) => shape === dualShape.trim().toLowerCase());

    const tipOrder = this.pickNumber(row, ['BrushPatternOrderType', 'BrushTipRepeatMethod', 'BrushStrokeOrder']);
    if (tipOrder !== null) out.tipPlayMode = tipPlayModes[tipOrder];

    // Color Mixing / Amount of Paint / Color Stretch
    const mixFlag = this.pickNumber(row, ['BrushMixColor', 'BrushUseMixColor', 'BrushMixGroundColor']);
    const rawAmount = this.pickNumber(row, ['BrushAmountOfPaint']);
    const rawStretch = this.pickNumber(row, ['BrushColorStretch']);
    const rawMixMode = this.pickNumber(row, ['BrushMixColorMode']);

    if (rawAmount !== null) {
      out.paintAmount = clamp01(rawAmount > 1 ? rawAmount / 100 : rawAmount);
    }
    if (rawStretch !== null) {
      out.colorStretch = clamp01(rawStretch > 1 ? rawStretch / 100 : rawStretch);
    }
    if (mixFlag !== null && mixFlag > 0) {
      // If mixFlag is boolean 1, derive strength from paintAmount/colorStretch; if 2..100 treat as percentage
      out.colorMixing = mixFlag === 1
        ? clamp01(Math.max(0.35, 1 - (out.paintAmount ?? 0.5) * 0.5, out.colorStretch ?? 0))
        : clamp01(mixFlag / 100);
      if (rawMixMode === 2) {
        out.mixMode = 'dilute';
      } else if ((out.paintAmount ?? 0.7) <= 0.05 && (out.colorStretch ?? 0) > 0.1) {
        out.mixMode = 'smudge';
      } else {
        out.mixMode = 'blend';
      }
      const pigmentMode = this.pickColumn(row, ['BrushPigmentMode', 'BrushMixColorMode']);
      const pigmentModel = typeof pigmentMode === 'string' ? pigmentMode.trim().toLowerCase() : '';
      out.pigmentBlendMode = (typeof pigmentMode === 'number'
        ? pigmentBlendModes[pigmentMode]
        : pigmentBlendModes.find((mode) => mode === pigmentModel)) ?? 'subtractive';
      const pigmentStrength = this.pickNumber(row, ['BrushPigmentStrength', 'BrushPigmentMixStrength']);
      out.pigmentStrength = pigmentStrength === null ? 0.85 : clamp01(percentOrRatio(pigmentStrength));
    }

    const wetEdges = this.pickNumber(row, ['BrushWaterEdge', 'BrushUseWaterEdge', 'BrushWatercolorEdge']);
    if (wetEdges !== null) out.wetEdges = wetEdges > 0;
    const wetStrength = this.pickNumber(row, ['BrushWaterEdgeOpacity', 'BrushWaterEdgeStrength']);
    if (wetStrength !== null) out.wetEdgeStrength = clamp01(percentOrRatio(wetStrength));
    const wetWidth = this.pickNumber(row, ['BrushWaterEdgeRadius', 'BrushWaterEdgeWidth']);
    if (wetWidth !== null) out.wetEdgeWidth = Math.max(0.05, Math.min(0.5, percentOrRatio(wetWidth)));
    const wetDarkness = this.pickNumber(row, ['BrushWaterEdgeDarkness']);
    if (wetDarkness !== null) out.wetEdgeDarkness = clamp01(percentOrRatio(wetDarkness));

    // Paper Texture
    const useTexture = this.pickNumber(row, ['BrushUseTexture', 'UseTexture']);
    const rawTexDensity = this.pickNumber(row, ['BrushTextureDensity', 'TextureDensity']);
    const rawTexScale = this.pickNumber(row, ['BrushTextureScale', 'BrushTextureZoom', 'TextureScale']);
    const rawTexInvert = this.pickNumber(row, ['BrushTextureInvert', 'TextureInvert']);
    const rawTexMode = this.pickNumber(row, ['BrushTextureMode', 'TextureBlendMode']);
    const texBrightness = this.pickNumber(row, ['BrushTextureBrightness']);
    const texContrast = this.pickNumber(row, ['BrushTextureContrast']);

    if ((useTexture ?? 0) > 0 || (rawTexDensity ?? 0) > 0
      || (useTexture === null && (texBrightness !== null || texContrast !== null))) {
      const density = rawTexDensity === null ? 0.4 : clamp01(percentOrRatio(rawTexDensity));
      const brightness = percentOrRatio(texBrightness ?? 0);
      const contrast = percentOrRatio(texContrast ?? 0);
      out.textureDensity = clamp01(density + (density - 0.5) * contrast + brightness);
      if (rawTexScale !== null && rawTexScale > 0) {
        out.textureScale = Math.max(0.5, Math.min(4, rawTexScale > 4 ? rawTexScale / 100 : rawTexScale));
      }
      if (rawTexInvert !== null) out.textureInvert = rawTexInvert !== 0;
    }
    const textureModes: readonly BrushTextureBlendMode[] = ['multiply', 'subtract', 'overlay'];
    if (rawTexMode !== null) out.textureBlendMode = textureModes[rawTexMode];

    // Spray / Scatter
    const useSpray = this.pickNumber(row, ['BrushSpray', 'BrushUseSpray', 'BrushUseScatter']);
    const rawSprayDev = this.pickNumber(row, ['BrushSprayDeviation', 'BrushScatter']);
    if (useSpray === null || useSpray > 0) {
      if (rawSprayDev !== null && rawSprayDev > 0) {
        out.scatter = clamp01(rawSprayDev > 1 ? rawSprayDev / 100 : rawSprayDev);
      }
    }

    // Color Jitter
    const useColorJitter = this.pickNumber(row, ['BrushUseChangeColor', 'BrushChangeColor']);
    if (useColorJitter === null || useColorJitter > 0) {
      const h = this.pickNumber(row, ['BrushChangeColorHue', 'BrushHueJitter']);
      const s = this.pickNumber(row, ['BrushChangeColorSaturation', 'BrushSaturationJitter']);
      const v = this.pickNumber(row, ['BrushChangeColorLuminance', 'BrushChangeColorValue', 'BrushValueJitter']);
      const subMix = this.pickNumber(row, ['BrushChangeColorSubColor', 'BrushSubColorMix']);
      if (h !== null && h > 0) out.hueJitter = clamp01(h > 1 ? h / 100 : h);
      if (s !== null && s > 0) out.satJitter = clamp01(s > 1 ? s / 100 : s);
      if (v !== null && v > 0) out.valJitter = clamp01(v > 1 ? v / 100 : v);
      if (subMix !== null && subMix > 0) out.fgBgMix = clamp01(subMix > 1 ? subMix / 100 : subMix);

      const colorUnit = this.pickNumber(row, ['BrushChangeColorUnit', 'BrushColorJitterUnit', 'BrushChangeColorPerStroke']);
      const colorMod = (key: string) => {
        const value = this.pickNumber(row, [key]);
        return value === null ? undefined : percentOrRatio(value);
      };
      out.colorDynamics = normalizeColorDynamics({
        scope: colorUnit === null ? undefined : colorUnit === 1 ? 'perStroke' : 'perDab',
        hueJitter: out.hueJitter,
        saturationJitter: out.satJitter,
        lightnessJitter: out.valJitter,
        fgBgMix: out.fgBgMix,
        huePressure: colorMod('BrushHuePressure'),
        saturationPressure: colorMod('BrushSaturationPressure'),
        lightnessPressure: colorMod('BrushLuminancePressure'),
        hueGradient: colorMod('BrushHueGradient'),
        saturationGradient: colorMod('BrushSaturationGradient'),
        lightnessGradient: colorMod('BrushLuminanceGradient'),
        gradientLength: this.pickNumber(row, ['BrushColorGradientLength']) ?? undefined,
      });
      if (out.colorDynamics) out.colorDynamics.scope ??= 'perDab';
    }

    // Effector dynamic blobs
    const sizeEff = parseSutEffectorBlob(this.pickBlob(row, ['BrushSizeEffector', 'SizeEffector']));
    if (sizeEff) dynamics.size = sizeEff;

    const opEff = parseSutEffectorBlob(this.pickBlob(row, ['OpacityEffector', 'BrushOpacityEffector']));
    if (opEff) dynamics.opacity = opEff;

    const flowEff = parseSutEffectorBlob(this.pickBlob(row, ['BrushDensityOfPaintEffector', 'BrushDensityEffector']));
    if (flowEff) dynamics.flow = flowEff;

    const angleEff = parseSutEffectorBlob(this.pickBlob(row, ['BrushAngleEffector', 'BrushDirectionEffector']));
    if (angleEff) dynamics.angle = angleEff;

    const scatterEff = parseSutEffectorBlob(this.pickBlob(row, ['BrushSprayDeviationEffector', 'BrushScatterEffector']));
    if (scatterEff) dynamics.scatter = scatterEff;

    const colorEff = parseSutEffectorBlob(this.pickBlob(row, ['BrushChangeColorEffector', 'BrushSubColorEffector']));
    if (colorEff) dynamics.colorMix = colorEff;

    if (Object.keys(dynamics).length > 0) {
      out.dynamics = dynamics;
    }

    return out;
  }

  private pickColumn(row: SqliteRow | undefined, candidates: string[]): SqliteValue | undefined {
    if (!row) return undefined;
    for (const c of candidates) {
      if (c in row && row[c] !== null && row[c] !== undefined) return row[c];
    }
    const lowerMap = new Map<string, SqliteValue>();
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && v !== undefined) lowerMap.set(k.toLowerCase(), v);
    }
    for (const c of candidates) {
      const hit = lowerMap.get(c.toLowerCase());
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  private pickNumber(row: SqliteRow | undefined, candidates: string[]): number | null {
    const val = this.pickColumn(row, candidates);
    return typeof val === 'number' && Number.isFinite(val) ? val : null;
  }

  private pickString(row: SqliteRow | undefined, candidates: string[]): string | null {
    const val = this.pickColumn(row, candidates);
    return typeof val === 'string' ? val : null;
  }

  private pickBlob(row: SqliteRow | undefined, candidates: string[]): Uint8Array | null {
    const val = this.pickColumn(row, candidates);
    return val instanceof Uint8Array ? val : null;
  }

  private scanEmbeddedImages(buf: Uint8Array, isTextureHint: boolean): EmbeddedImage[] {
    const images: EmbeddedImage[] = [];
    const len = buf.length;
    let pos = 0;

    while (pos < len - 8 && images.length < 32) {
      // PNG: 89 50 4E 47 0D 0A 1A 0A ... IEND
      if (
        buf[pos] === 0x89 &&
        buf[pos + 1] === 0x50 &&
        buf[pos + 2] === 0x4e &&
        buf[pos + 3] === 0x47 &&
        buf[pos + 4] === 0x0d &&
        buf[pos + 5] === 0x0a &&
        buf[pos + 6] === 0x1a &&
        buf[pos + 7] === 0x0a
      ) {
        const pngStart = pos;
        let pngEnd = -1;
        for (let i = pngStart + 8; i <= len - 8; i++) {
          if (
            buf[i] === 0x49 &&
            buf[i + 1] === 0x45 &&
            buf[i + 2] === 0x4e &&
            buf[i + 3] === 0x44
          ) {
            pngEnd = i + 8;
            break;
          }
        }
        if (pngEnd !== -1 && pngEnd > pngStart) {
          const pngBytes = buf.subarray(pngStart, pngEnd);
          let width = 128;
          let height = 128;
          if (pngBytes.length >= 24) {
            const ihdrView = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
            width = ihdrView.getUint32(16, false);
            height = ihdrView.getUint32(20, false);
          }
          if (width > 0 && height > 0 && width <= 4096 && height <= 4096) {
            images.push({
              width,
              height,
              dataUrl: this.uint8ArrayToDataUrl(pngBytes, 'image/png'),
              isTextureHint,
            });
          }
          pos = pngEnd;
          continue;
        }
      }

      // JPEG: FF D8 FF ... FF D9
      if (buf[pos] === 0xff && buf[pos + 1] === 0xd8 && buf[pos + 2] === 0xff) {
        const jpgStart = pos;
        let jpgEnd = -1;
        for (let j = jpgStart + 4; j <= len - 2; j++) {
          if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
            jpgEnd = j + 2;
            break;
          }
        }
        if (jpgEnd !== -1 && jpgEnd - jpgStart > 100) {
          const jpgBytes = buf.subarray(jpgStart, jpgEnd);
          images.push({
            width: 256,
            height: 256,
            dataUrl: this.uint8ArrayToDataUrl(jpgBytes, 'image/jpeg'),
            isTextureHint,
          });
          pos = jpgEnd;
          continue;
        }
      }

      pos++;
    }

    return images;
  }

  /**
   * Scans the SUT binary for tool name strings when SQLite metadata is unavailable
   */
  private extractToolName(): string | null {
    const buf = this.buffer;
    let bestName = '';
    let currentChars: number[] = [];

    for (let i = 0; i < Math.min(buf.length, 4096); i++) {
      const b = buf[i];
      if ((b >= 32 && b <= 126) || b > 127) {
        currentChars.push(b);
      } else {
        if (currentChars.length >= 3 && currentChars.length <= 40) {
          try {
            const str = new TextDecoder('utf-8', { fatal: false }).decode(
              new Uint8Array(currentChars)
            ).trim();
            if (
              str.includes('Brush') ||
              str.includes('Pen') ||
              str.includes('Pencil') ||
              str.includes('Water') ||
              str.includes('水彩') ||
              str.includes('筆') ||
              str.includes('G') ||
              str.includes('丸')
            ) {
              bestName = str;
              break;
            }
          } catch {
            // ignore decoding error
          }
        }
        currentChars = [];
      }
    }

    return bestName || null;
  }

  private createParametricCspTip(name: string): ParsedBrushTip {
    const size = 128;
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (canvas) {
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
        grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.8)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        return {
          id: 'sut_parametric_default',
          name: `${name} (柔和擬真尖形)`,
          width: size,
          height: size,
          dataUrl: canvas.toDataURL('image/png'),
          spacing: MIN_BRUSH_SPACING,
          hardness: 0.7,
          sourceFormat: 'sut',
        };
      }
    }

    return {
      id: 'sut_parametric_default',
      name: `${name} (擬真尖形)`,
      width: size,
      height: size,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      spacing: MIN_BRUSH_SPACING,
      hardness: 0.8,
      sourceFormat: 'sut',
    };
  }

  private uint8ArrayToDataUrl(bytes: Uint8Array, mime: string): string {
    let base64 = '';
    if (typeof (globalThis as any).Buffer !== 'undefined') {
      base64 = (globalThis as any).Buffer.from(bytes).toString('base64');
    } else {
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      base64 = (globalThis as any).btoa(binary);
    }
    return `data:${mime};base64,${base64}`;
  }
}
