import {
  Assets,
  BufferImageSource,
  Container,
  Graphics,
  Rectangle,
  Renderer,
  RenderTexture,
  Sprite,
  Texture,
  TilingSprite,
} from 'pixi.js';
import 'pixi.js/advanced-blend-modes';
import type { BrushTarget, Rect } from './LayerManager';
import {
  blendPigmentColors,
  computeWetEdgeParams,
  evaluateColorDynamics,
  evaluateDynamicChannel,
  getSelectionMaskFactor,
  hasActiveColorDynamics,
  MIN_BRUSH_SPACING,
  hexToRgb,
  PressureCurveConfig,
  PressureCurveType,
  RgbColor,
  rgbToHex,
  selectBrushTipIndex,
  stepPigmentReservoir,
  type BrushColorDynamicsConfig,
  type BrushDynamicsConfig,
  type BrushMixMode,
  type BrushTextureBlendMode,
  type BrushTipPlayMode,
  type DualBrushBlendMode,
  type DualTipShape,
  type PigmentBlendModel,
} from '@atelier/shared';
import { RulerManager } from './RulerManager';
import { wrapCoord } from './wrapAround';
import { detectConstrainedDevice, queryMaxTextureSize } from './gpuProfile';

export type AntiAliasLevel = 'none' | 'weak' | 'medium' | 'strong';
export type EraserMode = 'hard' | 'soft';

export interface BrushProperties {
  size: number;
  minSize: number;
  color: string;
  secondaryColor?: string; // 背景色 (預設 #FFFFFF)
  opacity: number;
  flow: number;
  hardness: number; // 0.0 to 1.0
  antiAlias?: AntiAliasLevel; // 消除鋸齒：無 / 弱 / 中 / 強
  spacing: number; // 0.02 to 1.5
  isEraser: boolean;
  eraserMode?: EraserMode;
  stabilizerLevel: number;
  scatter: number;
  customBrushUrl?: string | null;
  brushType?: 'brush' | 'pencil' | 'pen' | 'airbrush';
  // Phase 4: Pressure curve & realistic paint blending
  pressureCurve?: PressureCurveType | PressureCurveConfig;
  colorMixing?: number; // 0.0 to 1.0 (混色度)
  paintAmount?: number; // 0.0 to 1.0 (水分 / 顏料量)
  snapToRuler?: boolean; // 吸附至尺規與輔助線
  // Brush engine (CSP / Krita style); all optional, off by default
  textureDensity?: number; // 紙紋強度 0–1: paper grain fixed to the canvas eats into the stroke
  textureScale?: number; // 紙紋大小 0.5–4
  textureInvert?: boolean; // 反轉紙紋明暗
  textureBlendMode?: BrushTextureBlendMode; // 紙紋混合模式：subtract / multiply / overlay
  customTextureUrl?: string | null; // 自訂或匯入的紙紋貼圖
  dualBrush?: boolean; // 雙重筆刷: the stroke only shows where a second, scattered tip also lands
  dualSize?: number; // second tip size as a share of the main tip, 0.1–1
  dualSpacing?: number;
  dualScatter?: number; // how far the second tips scatter, 0–2
  dualTipShape?: DualTipShape;
  dualTipUrl?: string | null; // 雙重筆刷自訂副筆尖貼圖
  dualBlendMode?: DualBrushBlendMode;
  tipUrls?: string[];
  tipPlayMode?: BrushTipPlayMode;
  colorDynamics?: BrushColorDynamicsConfig;
  hueJitter?: number; // 顏色抖動 0–1 per dab
  satJitter?: number;
  valJitter?: number;
  fgBgMix?: number; // 主色↔副色混色強度 0–1
  angleMode?: 'direction' | 'pen' | 'fixed'; // tip angle: follow the stroke, the pen (twist / tilt direction), or fixed
  tipAngle?: number; // degrees, added to the mode's angle
  roundness?: number; // 圓度 0.1–1 (1 = round): a flat tip shows the angle
  tiltSize?: number; // 0–1: tilting the pen widens the tip (pencil side)
  colorStretch?: number; // 延展 0–1: picked-up colour keeps smearing further along the stroke
  mixMode?: BrushMixMode; // 混色模式：blend / smudge / dilute
  wetEdges?: boolean; // 水彩濕邊緣效果
  wetEdgeStrength?: number;
  wetEdgeWidth?: number;
  wetEdgeDarkness?: number;
  pigmentBlendMode?: PigmentBlendModel;
  pigmentStrength?: number;
  chargeDepletion?: number;
  dynamics?: BrushDynamicsConfig; // 細項動態控制（大小／不透明度／流量／角度／散佈／主副色）
}

const TIP_BUCKETS = [4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256] as const;
const AIRBRUSH_SCRATCH_LIMIT = 2048;

interface CachedTipEntry {
  texture: Texture;
  scaleRatio: number;
}

type ProceduralDualTip = Exclude<DualTipShape, 'same' | 'custom'>;

function createStrokeState() {
  return {
    strokeDabIndex: 0,
    lastTipIndex: -1,
    strokeDistancePx: 0,
    lastDabPos: null as { x: number; y: number } | null,
    dualDistanceAcc: 0,
    dualStamped: false,
    strokeRandH: Math.random(),
    strokeRandS: Math.random(),
    strokeRandL: Math.random(),
    strokeRandMix: Math.random(),
    reservoirColor: null as RgbColor | null,
    smudgeSampled: false,
    mixerTileCache: new Map<string, Uint8Array | null>(),
  };
}

function pickTipBucket(diameter: number): number {
  const d = Math.max(4, diameter);
  for (let i = 0; i < TIP_BUCKETS.length; i++) {
    if (TIP_BUCKETS[i] >= d) return TIP_BUCKETS[i];
  }
  return 256;
}

function hash2D(ix: number, iy: number, seed: number): number {
  const h = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453123;
  return h - Math.floor(h);
}

function valueNoise2D(px: number, py: number, seed: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2D(ix, iy, seed);
  const b = hash2D(ix + 1, iy, seed);
  const c = hash2D(ix, iy + 1, seed);
  const d = hash2D(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export interface GeneratedPencilTipPixels {
  bucket: number;
  texSize: number;
  scaleRatio: number;
  data: Uint8ClampedArray;
}

/**
 * Pure procedural graphite pencil tip generator (zero DOM dependency for deterministic testing).
 * Uses 3-octave coherent 2D Value Noise paper grain and full-saturation peaks so light strokes show tooth
 * while heavy strokes stack to solid darks.
 */
export function generatePencilTipPixels(
  hardness: number,
  antiAlias: AntiAliasLevel = 'medium',
  targetDiameter = 64,
): GeneratedPencilTipPixels {
  const isBinary = antiAlias === 'none';
  const quantizedHardness = Math.round(hardness * 20) / 20;
  const bucket = isBinary
    ? Math.max(1, Math.min(256, Math.round(targetDiameter)))
    : Math.max(16, pickTipBucket(targetDiameter));
  const texSize = isBinary ? bucket : bucket + 4;
  const center = texSize / 2;
  const rPix = bucket * 0.5;
  const aaPx =
    antiAlias === 'none'
      ? 0
      : antiAlias === 'weak'
        ? 0.6
        : antiAlias === 'medium'
          ? 1.0
          : 1.4;
  const softBand = rPix * (1 - quantizedHardness) * 0.85;
  const innerR = Math.max(0, rPix - Math.max(aaPx * 0.5, softBand));
  const outerR = rPix + aaPx * 0.5;
  const span = Math.max(1e-4, outerR - innerR);

  const data = new Uint8ClampedArray(texSize * texSize * 4);
  const s = Math.max(1, bucket / 24);

  for (let y = 0; y < texSize; y++) {
    for (let x = 0; x < texSize; x++) {
      const dist = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      let alpha = 0;
      if (dist <= outerR) {
        if (antiAlias === 'none') {
          alpha = dist <= rPix ? 1.0 : 0;
        } else if (dist <= innerR) {
          alpha = 1.0;
        } else {
          const t = (dist - innerR) / span;
          alpha = 1.0 - t * t * (3 - 2 * t);
        }

        const gx = x / s;
        const gy = y / s;
        const gCoarse = valueNoise2D(gx * 0.55, gy * 0.55, 1.3);
        const gMed = valueNoise2D(gx * 1.35, gy * 1.35, 4.7);
        const gFine = valueNoise2D(x * 1.85, y * 1.85, 9.1);
        const grain = gCoarse * 0.42 + gMed * 0.36 + gFine * 0.22;
        const norm = Math.max(0, Math.min(1, (grain - 0.32) / 0.34));
        const toothMask = 0.04 + 0.96 * (norm * norm * (3 - 2 * norm));
        alpha *= toothMask;
        if (antiAlias === 'none') alpha = alpha >= 0.42 ? 1.0 : 0.0;
      }

      const idx = (y * texSize + x) * 4;
      const aVal = Math.max(0, Math.min(255, Math.round(alpha * 255)));
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = aVal;
    }
  }

  return { bucket, texSize, scaleRatio: texSize / bucket, data };
}

export class BrushRenderer {
  private renderer: Renderer;
  private currentProperties: BrushProperties = {
    size: 24,
    minSize: 0.8,
    color: '#3B82F6',
    secondaryColor: '#FFFFFF',
    opacity: 1.0,
    flow: 1.0,
    hardness: 0.8,
    antiAlias: 'medium',
    spacing: MIN_BRUSH_SPACING,
    isEraser: false,
    stabilizerLevel: 3,
    scatter: 0,
    customBrushUrl: null,
    pressureCurve: 'linear',
    colorMixing: 0, // a plain pen by default; mixer presets / the 混色 slider turn pickup on
    paintAmount: 0.7,
    snapToRuler: true,
  };

  // Cached procedural brush tip textures by bucket size + hardness + anti-alias level
  private defaultTipTextures = new Map<string, CachedTipEntry>();
  private pencilTipTextures = new Map<string, CachedTipEntry>();
  private customTipTexture: Texture | null = null;
  private customTipUrlLoaded: string | null = null;
  private tipRequest = 0;
  private multiTipTextures: Array<{ url: string; texture: Texture }> = [];
  private multiTipKey = '[]';
  private multiTipRequest = 0;
  private multiTipLoad: Promise<void> | null = null;
  private customPaperTexture: Texture | null = null;
  private customPaperTextureInverted: Texture | null = null;
  private customPaperUrlLoaded: string | null = null;
  private paperRequest = 0;
  private paperTextureInverted: Texture | null = null;
  private dualTipTexture: Texture | null = null;
  private dualTipUrlLoaded: string | null = null;
  private dualTipRequest = 0;
  private proceduralDualTips = new Map<ProceduralDualTip, Texture>();

  // Stamping batch container and sprite pool for zero-GC ultra-fast stamping
  private stampBatch = new Container();
  private spritePool: Sprite[] = [];
  private maskGraphic: Graphics | null = null;

  // Active selection mask for clamping brush rendering
  private activeSelectionMask: Uint8Array | null = null;
  private canvasWidth: number = 2048;
  private canvasHeight: number = 2048;

  // Wet paint state & lazy sparse tile CPU cache for non-blocking color mixing
  private strokeState = createStrokeState();
  private mixerTileReader: ((col: number, row: number) => Uint8Array | null) | null = null;
  private maskUploadBytes: Uint8Array | null = null;

  // Brush-engine scratch buffers: the batch is drawn here first when texture / dual brush / selection mask shape it
  private scratchRT: RenderTexture | null = null;
  private airbrushRT: RenderTexture | null = null;
  private readonly supportsFloatColorBuffer: boolean;
  private readonly scratchLimit: number;
  private dualRT: RenderTexture | null = null;
  private dualBatch = new Container();
  private dualSpritePool: Sprite[] = [];
  private wetRimRT: RenderTexture | null = null;
  private wetBatch = new Container();
  private wetSpritePool: Sprite[] = [];
  private effectBatch = new Container();
  private effectSprite = this.effectBatch.addChild(new Sprite());
  private paperTexture: Texture | null = null;
  private composite = new Container();
  private previewMode = false;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.scratchLimit = Math.min(queryMaxTextureSize(renderer), detectConstrainedDevice().isConstrained ? 1024 : AIRBRUSH_SCRATCH_LIMIT);
    const gl = (renderer as { gl?: WebGLRenderingContext | WebGL2RenderingContext }).gl;
    this.supportsFloatColorBuffer = !!gl?.getExtension('EXT_color_buffer_float');
    this.getOrCreateProceduralTipTexture(0.8);
    // dst-in: keep the destination only where the source has alpha (dual brush intersection)
    try {
      const glState = (renderer as any).stateSystem || (renderer as any).state;
      if (gl && glState?.blendModesMap) glState.blendModesMap['dst-in'] = [gl.ZERO, gl.SRC_ALPHA, gl.ZERO, gl.SRC_ALPHA];
    } catch {
      // without it the dual brush draws like a plain brush
    }
  }

  /** Tileable paper grain (alpha = how much a dab loses there), made once */
  private getPaperTexture(inverted = false): Texture {
    if (inverted && this.customPaperTextureInverted) return this.customPaperTextureInverted;
    if (!inverted && this.customPaperTexture) return this.customPaperTexture;
    if (inverted && this.paperTextureInverted) return this.paperTextureInverted;
    if (!inverted && this.paperTexture) return this.paperTexture;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const invCanvas = document.createElement('canvas');
    invCanvas.width = size;
    invCanvas.height = size;
    const invCtx = invCanvas.getContext('2d')!;
    const invImg = invCtx.createImageData(size, size);
    // Value noise on a torus so the tile repeats without seams
    const grid = 32;
    const rnd = new Float32Array(grid * grid).map(() => Math.random());
    const at = (gx: number, gy: number) => rnd[((gy + grid) % grid) * grid + ((gx + grid) % grid)];
    const smooth = (t: number) => t * t * (3 - 2 * t);
    const noise = (x: number, y: number, freq: number) => {
      const fx = (x / size) * freq;
      const fy = (y / size) * freq;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      const wrap = (v: number) => ((v % freq) + freq) % freq;
      const a = at(wrap(x0), wrap(y0));
      const b = at(wrap(x0 + 1), wrap(y0));
      const c = at(wrap(x0), wrap(y0 + 1));
      const d = at(wrap(x0 + 1), wrap(y0 + 1));
      return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const grain = noise(x, y, 32) * 0.55 + noise(x, y, 16) * 0.3 + noise(x, y, 8) * 0.15;
        const i = (y * size + x) * 4;
        const tooth = Math.round(Math.max(0, Math.min(1, (0.62 - grain) * 2.6)) * 255);
        const lum = Math.round(Math.max(0, Math.min(1, grain)) * 255);
        img.data[i] = img.data[i + 1] = img.data[i + 2] = lum;
        img.data[i + 3] = tooth;
        invImg.data[i] = invImg.data[i + 1] = invImg.data[i + 2] = 255 - lum;
        invImg.data[i + 3] = 255 - tooth;
      }
    }
    ctx.putImageData(img, 0, 0);
    invCtx.putImageData(invImg, 0, 0);
    this.paperTexture = Texture.from(canvas);
    this.paperTexture.source.style.addressMode = 'repeat';
    this.paperTextureInverted = Texture.from(invCanvas);
    this.paperTextureInverted.source.style.addressMode = 'repeat';
    return inverted ? this.paperTextureInverted : this.paperTexture;
  }

  /** A render texture at least w×h, reused between batches */
  private ensureRT(rt: RenderTexture | null, w: number, h: number, format: 'rgba8unorm' | 'rgba16float' = 'rgba8unorm'): RenderTexture {
    const W = Math.min(this.scratchLimit, Math.ceil(w / 128) * 128);
    const H = Math.min(this.scratchLimit, Math.ceil(h / 128) * 128);
    if (!rt) return RenderTexture.create({ width: W, height: H, resolution: 1, format });
    if (rt.width < w || rt.height < h) rt.resize(Math.max(rt.width, W), Math.max(rt.height, H));
    return rt;
  }

  /** Straight RGB of the target under a box (premultiplied readback), for the mixer brush */
  private readBox(target: RenderTexture, x: number, y: number, w: number, h: number): Uint8Array | null {
    try {
      const view = new Texture({ source: target.source, frame: new Rectangle(x, y, w, h) });
      const { pixels } = this.renderer.extract.pixels({ target: view });
      view.destroy(false);
      return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    } catch {
      return null;
    }
  }

  public setProperties(props: Partial<BrushProperties>) {
    this.currentProperties = { ...this.currentProperties, ...props };
    if ('customTextureUrl' in props) {
      const nextTexUrl = props.customTextureUrl ?? null;
      if (nextTexUrl !== this.customPaperUrlLoaded) {
        if (nextTexUrl) void this.setCustomTextureImage(nextTexUrl).catch(() => {});
        else this.clearCustomTexture();
      }
    }
    if ('dualTipUrl' in props) {
      const nextDualUrl = props.dualTipUrl ?? null;
      if (nextDualUrl !== this.dualTipUrlLoaded) {
        if (nextDualUrl) void this.setDualTipImage(nextDualUrl).catch(() => {});
        else this.clearDualTip();
      }
    }
    if ('tipUrls' in props) void this.setMultiTipImages(props.tipUrls);
  }

  public getProperties(): BrushProperties {
    return { ...this.currentProperties };
  }

  public setCanvasDimensions(width: number, height: number) {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  public setSelectionMask(mask: Uint8Array | null, maskGraphic?: Graphics | null) {
    this.activeSelectionMask = mask;
    if (maskGraphic !== undefined) {
      this.setMaskGraphic(maskGraphic);
    }
  }

  public setMaskGraphic(maskGraphic: Graphics | null) {
    this.maskGraphic = maskGraphic;
    // Never attach canvas-wide stencil masks to stampBatch: selection masking runs in batch tile-space via dst-in
    this.stampBatch.mask = null;
  }

  public setMixerTileReader(reader: ((col: number, row: number) => Uint8Array | null) | null) {
    this.mixerTileReader = reader;
  }

  /**
   * Both selection masking and color-mixing run cleanly in sparse tile-space without forcing
   * full-canvas double RenderTextures (`makeResident`).
   */
  public needsWholeLayer(): boolean {
    return false;
  }

  public canBatchStrokeDabs(): boolean {
    const props = this.currentProperties;
    return !this.activeSelectionMask && !props.isEraser && !props.colorMixing && !props.textureDensity && !props.dualBrush && !props.wetEdges;
  }

  public resetStrokeState() {
    this.strokeState = createStrokeState();
  }

  public async setMultiTipImages(urls: string[] | null | undefined) {
    const nextUrls = urls?.filter((url) => url.length > 0) ?? [];
    this.currentProperties.tipUrls = urls == null ? undefined : nextUrls;
    const key = JSON.stringify(nextUrls);
    if (key === this.multiTipKey) return this.multiTipLoad ?? undefined;
    const request = ++this.multiTipRequest;
    this.multiTipKey = key;
    this.multiTipTextures = [];
    this.multiTipLoad = Promise.allSettled(nextUrls.map(async (url) => {
      const texture = await Assets.load<Texture>(url);
      if (!(texture instanceof Texture)) throw new Error('Invalid brush tip texture');
      return { url, texture };
    })).then((loaded) => {
      if (request !== this.multiTipRequest) return;
      for (const result of loaded) {
        if (result.status !== 'fulfilled') continue;
        result.value.texture.source.autoGenerateMipmaps = true;
        this.multiTipTextures.push(result.value);
      }
      this.multiTipLoad = null;
    });
    return this.multiTipLoad;
  }

  /**
   * Load a custom paper grain texture image (converted to tileable luminance+tooth RGBA + inverted variant)
   */
  public async setCustomTextureImage(url: string | null) {
    if (!url) {
      this.clearCustomTexture();
      return;
    }
    const req = ++this.paperRequest;
    this.customPaperUrlLoaded = url;
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.crossOrigin = 'anonymous';
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Failed to load custom paper texture'));
        el.src = url;
      });
      if (req !== this.paperRequest) return;
      const w = Math.max(16, Math.min(512, img.naturalWidth || 256));
      const h = Math.max(16, Math.min(512, img.naturalHeight || 256));
      const c1 = document.createElement('canvas');
      c1.width = w; c1.height = h;
      const ctx1 = c1.getContext('2d')!;
      ctx1.drawImage(img, 0, 0, w, h);
      const data1 = ctx1.getImageData(0, 0, w, h);
      const c2 = document.createElement('canvas');
      c2.width = w; c2.height = h;
      const ctx2 = c2.getContext('2d')!;
      const data2 = ctx2.createImageData(w, h);
      for (let i = 0; i < data1.data.length; i += 4) {
        const a = data1.data[i + 3] / 255;
        const lum = Math.round((0.299 * data1.data[i] + 0.587 * data1.data[i + 1] + 0.114 * data1.data[i + 2]) * a + 255 * (1 - a));
        const tooth = 255 - lum;
        data1.data[i] = data1.data[i + 1] = data1.data[i + 2] = lum;
        data1.data[i + 3] = tooth;
        data2.data[i] = data2.data[i + 1] = data2.data[i + 2] = 255 - lum;
        data2.data[i + 3] = 255 - tooth;
      }
      ctx1.putImageData(data1, 0, 0);
      ctx2.putImageData(data2, 0, 0);
      this.customPaperTexture?.destroy(true);
      this.customPaperTextureInverted?.destroy(true);
      this.customPaperTexture = Texture.from(c1);
      this.customPaperTexture.source.style.addressMode = 'repeat';
      this.customPaperTextureInverted = Texture.from(c2);
      this.customPaperTextureInverted.source.style.addressMode = 'repeat';
      this.currentProperties.customTextureUrl = url;
    } catch (err) {
      if (req === this.paperRequest) this.clearCustomTexture();
      throw err;
    }
  }

  public clearCustomTexture() {
    this.paperRequest++;
    this.customPaperUrlLoaded = null;
    this.customPaperTexture?.destroy(true);
    this.customPaperTexture = null;
    this.customPaperTextureInverted?.destroy(true);
    this.customPaperTextureInverted = null;
    this.currentProperties.customTextureUrl = null;
  }

  /**
   * Load a custom secondary tip image for Dual Brush mode
   */
  public async setDualTipImage(url: string | null) {
    if (!url) {
      this.clearDualTip();
      return;
    }
    const req = ++this.dualTipRequest;
    this.dualTipUrlLoaded = url;
    this.dualTipTexture = null;
    try {
      const tex = await Assets.load<Texture>(url);
      if (req !== this.dualTipRequest) return;
      tex.source.autoGenerateMipmaps = true;
      this.dualTipTexture = tex;
      this.currentProperties.dualTipUrl = url;
    } catch (err) {
      if (req === this.dualTipRequest) this.clearDualTip();
      throw err;
    }
  }

  public clearDualTip() {
    this.dualTipRequest++;
    this.dualTipUrlLoaded = null;
    this.dualTipTexture = null;
    this.currentProperties.dualTipUrl = null;
  }

  private getDualTipShapeTexture(shape: DualTipShape, fallbackTip: Texture): Texture {
    if (shape === 'same') return fallbackTip;
    if (shape === 'custom') return this.dualTipTexture ?? fallbackTip;
    const cached = this.proceduralDualTips.get(shape);
    if (cached) return cached;

    const size = 64;
    const radius = size / 2 - 1;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return fallbackTip;
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - size / 2) / radius;
        const dy = (y + 0.5 - size / 2) / radius;
        const r = shape === 'square' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
        let alpha = Math.max(0, Math.min(1, (1 - r) * radius));
        if (shape === 'soft') alpha *= Math.max(0, (Math.exp(-4 * r * r) - Math.exp(-4)) / (1 - Math.exp(-4)));
        if (shape === 'speckle') alpha *= Math.max(0, (hash2D(x, y, 38) - 0.55) / 0.45);
        if (shape === 'bristle') alpha *= Math.max(0, (valueNoise2D(x * 0.62, y * 0.045, 57) - 0.32) / 0.68);
        const offset = (y * size + x) * 4;
        image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 255;
        image.data[offset + 3] = Math.round(alpha * 255);
      }
    }
    ctx.putImageData(image, 0, 0);
    const texture = Texture.from(canvas);
    this.proceduralDualTips.set(shape, texture);
    return texture;
  }

  /**
   * Upload or set a custom brush image texture (PNG/WebP/SVG)
   */
  public async setCustomBrushImage(imageSource: string | HTMLImageElement | File | null) {
    if (!imageSource) {
      this.clearCustomBrush();
      return;
    }

    const request = ++this.tipRequest;
    const url = imageSource instanceof File ? URL.createObjectURL(imageSource) : typeof imageSource === 'string' ? imageSource : null;
    this.customTipTexture = null;
    this.customTipUrlLoaded = null;
    try {
      const texture = url ? await Assets.load<Texture>(url) : Texture.from(imageSource as HTMLImageElement);
      if (request !== this.tipRequest) return;
      texture.source.autoGenerateMipmaps = true;
      this.customTipTexture = texture;
      this.customTipUrlLoaded = url;
      this.currentProperties.customBrushUrl = url;
    } catch (error) {
      if (request === this.tipRequest) this.clearCustomBrush();
      throw error;
    }
  }

  public clearCustomBrush() {
    this.tipRequest++;
    this.customTipTexture = null;
    this.customTipUrlLoaded = null;
    this.currentProperties.customBrushUrl = null;
  }

  /**
   * Generates a size-bucketed procedural circular brush tip with pixel-space analytical AA and 2x2 subpixel supersampling
   */
  private getOrCreateProceduralTipEntry(
    hardness: number,
    antiAlias: AntiAliasLevel = 'medium',
    targetDiameter = 64,
    airbrush = false,
  ): CachedTipEntry {
    const isBinary = antiAlias === 'none';
    const quantizedHardness = isBinary ? 1.0 : Math.round(hardness * 20) / 20; // 21 steps for caching
    const bucket = isBinary
      ? Math.max(1, Math.min(256, Math.round(targetDiameter)))
      : pickTipBucket(targetDiameter);
    const cacheKey = `${bucket}:${quantizedHardness}:${antiAlias}:${airbrush}`;
    const cached = this.defaultTipTextures.get(cacheKey);
    if (cached) return cached;

    const texSize = isBinary ? bucket : bucket + 4; // 2px gutter for linear AA; exact 1:1 size for binary pixel tips
    const canvas = document.createElement('canvas');
    canvas.width = texSize;
    canvas.height = texSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { texture: Texture.WHITE, scaleRatio: 1 };

    const center = texSize / 2;
    const rPix = bucket * 0.5;
    const aaPx =
      antiAlias === 'none'
        ? 0
        : antiAlias === 'weak'
          ? 0.42
          : antiAlias === 'medium'
            ? 0.72
            : 1.15;
    const softBand = rPix * (1 - quantizedHardness) * 0.95;
    const innerR = quantizedHardness <= 0.1
      ? 0
      : Math.max(0, rPix - Math.max(aaPx * 0.5, softBand));
    const outerR = rPix + aaPx * 0.5;
    const span = Math.max(1e-4, outerR - innerR);
    const falloffExp = 1.0 + (1.0 - quantizedHardness) * 1.8;

    const imgData = ctx.createImageData(texSize, texSize);
    const data = imgData.data;

    const evalCoverage = (px: number, py: number) => {
      const dist = Math.hypot(px - center, py - center);
      if (isBinary) return bucket <= 1 || dist <= rPix ? 1.0 : 0.0;
      if (airbrush) return Math.max(0, 1 - (dist / outerR) ** 2) ** (2.5 - quantizedHardness);
      if (dist <= innerR) return 1.0;
      if (dist >= outerR) return 0.0;
      const t = (dist - innerR) / span;
      const smooth = 1.0 - t * t * (3 - 2 * t);
      return falloffExp === 1.0 ? smooth : Math.pow(Math.max(0, smooth), falloffExp);
    };

    for (let y = 0; y < texSize; y++) {
      for (let x = 0; x < texSize; x++) {
        let alpha = 0;
        if (isBinary) {
          alpha = evalCoverage(x + 0.5, y + 0.5);
        } else {
          // 2x2 subpixel supersampling removes jagged edge blocks on small 4–16px tips
          alpha =
            (evalCoverage(x + 0.25, y + 0.25) +
              evalCoverage(x + 0.75, y + 0.25) +
              evalCoverage(x + 0.25, y + 0.75) +
              evalCoverage(x + 0.75, y + 0.75)) *
            0.25;
        }

        const idx = (y * texSize + x) * 4;
        const aVal = isBinary ? (alpha >= 0.5 ? 255 : 0) : Math.round(alpha * 255);
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = aVal;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const texture = Texture.from(canvas);
    const filterMode = isBinary ? 'nearest' : 'linear';
    texture.source.scaleMode = filterMode;
    texture.source.magFilter = filterMode;
    texture.source.minFilter = filterMode;
    // Procedural round tips are already size-bucketed close to targetDiameter; enabling mipmaps
    // causes WebGL to blend blurry level-1/2 mips whenever size < bucket (especially on fine tails).
    texture.source.autoGenerateMipmaps = false;
    texture.source.style.update();
    const entry: CachedTipEntry = { texture, scaleRatio: texSize / bucket };
    this.defaultTipTextures.set(cacheKey, entry);
    return entry;
  }

  private getOrCreateProceduralTipTexture(hardness: number, antiAlias: AntiAliasLevel = 'medium'): Texture {
    return this.getOrCreateProceduralTipEntry(hardness, antiAlias, 64).texture;
  }

  /** Cached circular tip texture shared across live remote preview sprites */
  public getPreviewTipTexture(hardness = 0.8, antiAlias: AntiAliasLevel = 'medium'): Texture {
    return this.getOrCreateProceduralTipEntry(hardness, antiAlias, 32).texture;
  }

  /**
   * Generates a size-bucketed procedural graphite pencil tip texture with paper grain & pixel-space AA
   */
  private getOrCreatePencilTipEntry(
    hardness: number,
    antiAlias: AntiAliasLevel = 'medium',
    targetDiameter = 64
  ): CachedTipEntry {
    const isBinary = antiAlias === 'none';
    const quantizedHardness = Math.round(hardness * 20) / 20;
    const bucket = isBinary
      ? Math.max(1, Math.min(256, Math.round(targetDiameter)))
      : Math.max(16, pickTipBucket(targetDiameter));
    const cacheKey = `${bucket}:${quantizedHardness}:${antiAlias}`;
    const cached = this.pencilTipTextures.get(cacheKey);
    if (cached) return cached;

    const tip = generatePencilTipPixels(hardness, antiAlias, targetDiameter);
    const canvas = document.createElement('canvas');
    canvas.width = tip.texSize;
    canvas.height = tip.texSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { texture: Texture.WHITE, scaleRatio: 1 };

    const imgData = ctx.createImageData(tip.texSize, tip.texSize);
    imgData.data.set(tip.data);
    ctx.putImageData(imgData, 0, 0);
    const texture = Texture.from(canvas);
    const filterMode = isBinary ? 'nearest' : 'linear';
    texture.source.scaleMode = filterMode;
    texture.source.magFilter = filterMode;
    texture.source.minFilter = filterMode;
    // Procedural round tips are already size-bucketed close to targetDiameter; enabling mipmaps
    // causes WebGL to blend blurry level-1/2 mips whenever size < bucket (especially on fine tails).
    texture.source.autoGenerateMipmaps = false;
    texture.source.style.update();
    const entry: CachedTipEntry = { texture, scaleRatio: tip.scaleRatio };
    this.pencilTipTextures.set(cacheKey, entry);
    return entry;
  }

  /**
   * Stamps a batch of dab instances onto the target RenderTexture
   * Respects selection mask and realistic wet paint pigment blending
   *
   * @param targetRT Destination RenderTexture (Layer RT or Preview RT)
   * @param dabsArray Flat Float32Array: [x, y, size, pressure, alpha, rotation, scatterOffset, ...]
   * @param count Number of dabs in buffer
   * @param overrideColor Optional color override (e.g. for remote user's cursor color)
   * @param isEraserOverride Optional eraser mode override
   */
  public stampDabs(
    targetRT: BrushTarget,
    dabsArray: Float32Array,
    count: number,
    overrideColor?: string,
    isEraserOverride?: boolean,
    isAlphaLocked?: boolean,
    eraserProps?: BrushProperties,
    wrappedPoints?: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>,
  ) {
    if (count <= 0 || dabsArray.length < count * 7) return;

    const props = eraserProps ?? this.currentProperties;
    const isEraser = isEraserOverride !== undefined ? isEraserOverride : props.isEraser;
    const baseColorHex = overrideColor || props.color;
    // Remote previews and legacy replays (overrideColor) draw plainly: the engine options are this painter's
    const engine = overrideColor === undefined;
    const dedicatedEraser = Boolean(eraserProps);
    const localPaint = engine && !isEraser && !dedicatedEraser;
    const stroke = this.strokeState;
    const customTip = dedicatedEraser ? null : this.customTipTexture;
    const hardness = props.hardness;
    const colorMixing = localPaint ? props.colorMixing ?? 0 : 0;
    const paintAmount = props.paintAmount ?? 0.7;
    const colorStretch = props.colorStretch ?? 0;
    const mixMode = props.mixMode ?? 'blend';
    const pigmentBlendMode = props.pigmentBlendMode ?? 'subtractive';
    const pigmentStrength = props.pigmentStrength ?? 0.85;
    const chargeDepletion = localPaint ? Math.max(0, Math.min(1, props.chargeDepletion ?? 0)) : 0;
    const colorDynamics = props.colorDynamics;
    const hasColorDynamics = localPaint && hasActiveColorDynamics(colorDynamics, props);
    const gradientLength = Math.max(50, Math.min(4000, colorDynamics?.gradientLength ?? 400));
    const wetEdges = localPaint && Boolean(props.wetEdges);
    const roundness = engine ? Math.max(0.1, Math.min(1, props.roundness ?? 1)) : 1;
    const angleMode = props.angleMode ?? 'direction';
    const tipAngle = ((props.tipAngle ?? 0) * Math.PI) / 180;
    const tiltSize = engine ? props.tiltSize ?? 0 : 0;
    const textureDensity = engine ? props.textureDensity ?? 0 : 0;
    const dual = localPaint && Boolean(props.dualBrush);
    const shaped = textureDensity > 0 || dual || wetEdges;
    const dualRatio = Math.max(0.1, Math.min(1, props.dualSize ?? 0.4));
    const dualSpacing = Math.max(0.05, Math.min(2, props.dualSpacing ?? 0.35));
    const dualSpread = Math.max(0, Math.min(2, props.dualScatter ?? 0.6));
    const dualShape = props.dualTipShape ?? (this.dualTipTexture ? 'custom' : 'same');
    this.dualBatch.removeChildren();

    const explicitAirbrush = !isEraser && props.brushType === 'airbrush';
    const antiAlias: AntiAliasLevel = engine && !(explicitAirbrush && props.antiAlias === 'none')
      ? (props.antiAlias ?? 'medium') : 'medium';
    const isPencil = props.brushType === 'pencil';
    const airbrush = !isEraser && !isPencil && (props.brushType === 'airbrush' || hardness <= 0.25);
    const tipPlayMode = props.tipPlayMode ?? 'single';
    const multiTipTextures = localPaint && tipPlayMode !== 'single' ? this.multiTipTextures : [];
    const prependCustomTip = Boolean(multiTipTextures.length && customTip &&
      !multiTipTextures.some(({ url }) => url === this.customTipUrlLoaded));
    const multiTipCount = multiTipTextures.length + Number(prependCustomTip);
    const usesMixer = colorMixing > 0 && antiAlias !== 'none';
    const antialiasFineInk = engine && !isEraser && !isPencil && !airbrush && hardness >= 0.85 &&
      antiAlias !== 'none' && !customTip && multiTipCount === 0 && !shaped && roundness === 1 && colorMixing === 0;

    // Recycle previous batch sprites into pool
    for (const child of this.stampBatch.children) {
      if (child instanceof Sprite && this.spritePool.length < 500) {
        this.spritePool.push(child);
      }
    }
    this.stampBatch.removeChildren();

    // The batch's box on the canvas: scratch buffers and mixer sampling cover only this
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const r = dabsArray[i * 7 + 2] * (0.75 + tiltSize * 1.5) + 2;
      if (wrappedPoints) {
        for (const { x, y } of wrappedPoints[i]) {
          minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
          minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
        }
      } else {
        minX = Math.min(minX, dabsArray[i * 7] - r);
        maxX = Math.max(maxX, dabsArray[i * 7] + r);
        minY = Math.min(minY, dabsArray[i * 7 + 1] - r);
        maxY = Math.max(maxY, dabsArray[i * 7 + 1] + r);
      }
    }
    const bx = Math.max(0, Math.floor(minX));
    const by = Math.max(0, Math.floor(minY));
    const bw = Math.max(1, Math.min(this.canvasWidth, Math.ceil(maxX)) - bx);
    const bh = Math.max(1, Math.min(this.canvasHeight, Math.ceil(maxY)) - by);

    const needsSelectionClip = Boolean(this.activeSelectionMask && !this.previewMode);
    const useScratch = shaped || needsSelectionClip;

    // Mixer brush: prefer sparse per-tile lazy cache (reads at most once per entered 256x256 tile, 0 GPU sync stall per batch)
    const mixerTileReader = this.previewMode ? null : this.mixerTileReader;
    const useTileMixer = usesMixer && minX < this.canvasWidth && minY < this.canvasHeight;
    const under = useTileMixer && !mixerTileReader && targetRT instanceof RenderTexture
      ? this.readBox(targetRT, bx, by, bw, bh) : null;
    const brushRgb = hexToRgb(baseColorHex);
    const secondaryRgb = hasColorDynamics && ((colorDynamics?.fgBgMix ?? props.fgBgMix ?? 0) > 0 || colorDynamics?.fgBgGradient)
      ? hexToRgb(props.secondaryColor || '#FFFFFF') : null;
    const mixColor = (a: RgbColor, b: RgbColor, t: number) =>
      blendPigmentColors(a, b, t, pigmentBlendMode, pigmentStrength);

    const sampleMixerUnder = (gx: number, gy: number): [number, number, number, number] => {
      const ix = wrappedPoints ? wrapCoord(Math.round(gx), this.canvasWidth) : Math.max(0, Math.min(this.canvasWidth - 1, Math.round(gx)));
      const iy = wrappedPoints ? wrapCoord(Math.round(gy), this.canvasHeight) : Math.max(0, Math.min(this.canvasHeight - 1, Math.round(gy)));
      if (mixerTileReader) {
        const col = ix >> 8;
        const row = iy >> 8;
        const key = `${col}_${row}`;
        let tile = stroke.mixerTileCache.get(key);
        if (tile === undefined) {
          const loaded = mixerTileReader(col, row);
          tile = loaded ? new Uint8Array(loaded) : null;
          stroke.mixerTileCache.set(key, tile);
        }
        if (!tile) return [0, 0, 0, 0];
        const tw = Math.min(256, this.canvasWidth - col * 256);
        const k = ((iy & 255) * tw + (ix & 255)) * 4;
        return [tile[k], tile[k + 1], tile[k + 2], tile[k + 3]];
      }
      if (under) {
        const sx = Math.min(bw - 1, Math.max(0, ix - bx));
        const sy = Math.min(bh - 1, Math.max(0, iy - by));
        const k = (sy * bw + sx) * 4;
        return [under[k], under[k + 1], under[k + 2], under[k + 3]];
      }
      return [0, 0, 0, 0];
    };

    const rulerMgr = RulerManager.getInstance();
    const isSymmetry = !this.previewMode && rulerMgr.state.mode === 'symmetry';
    for (let i = 0; i < count; i++) {
      const offset = i * 7;
      const x = dabsArray[offset];
      const y = dabsArray[offset + 1];
      let size = dabsArray[offset + 2];
      let alpha = dabsArray[offset + 4];
      const strokeAngle = dabsArray[offset + 5];
      const tilt = dabsArray[offset + 6]; // 0 upright … 1 flat (worker), 0 when the device has no tilt
      if (size <= 0 || alpha <= 0) continue;

      let selectedTip = customTip;
      if (localPaint) {
        const dabIndex = stroke.strokeDabIndex++;
        if (stroke.lastDabPos) {
          let dx = x - stroke.lastDabPos.x;
          let dy = y - stroke.lastDabPos.y;
          if (wrappedPoints) {
            dx -= Math.round(dx / this.canvasWidth) * this.canvasWidth;
            dy -= Math.round(dy / this.canvasHeight) * this.canvasHeight;
          }
          const distance = Math.hypot(dx, dy);
          stroke.strokeDistancePx += distance;
          if (dual) stroke.dualDistanceAcc += distance;
          stroke.lastDabPos.x = x;
          stroke.lastDabPos.y = y;
        } else {
          stroke.lastDabPos = { x, y };
        }
        if (multiTipCount > 0) {
          const previous = stroke.lastTipIndex;
          const index = selectBrushTipIndex(multiTipCount, tipPlayMode, dabIndex, previous, Math.random());
          stroke.lastTipIndex = index;
          selectedTip = multiTipTextures[index - Number(prependCustomTip)]?.texture ?? customTip;
        }
      }

      // 1. Strict Selection Mask Restriction (quick bounding skip; exact per-pixel clipping uses dst-in below)
      if (!wrappedPoints && needsSelectionClip && this.activeSelectionMask) {
        const maskFactor = getSelectionMaskFactor(
          this.activeSelectionMask,
          x,
          y,
          this.canvasWidth,
          this.canvasHeight
        );
        if (maskFactor <= 0.001) {
          const checkRadius = Math.min(size * 0.55 + 1, 64);
          const diag = checkRadius * 0.707;
          const touches =
            getSelectionMaskFactor(this.activeSelectionMask, x - checkRadius, y, this.canvasWidth, this.canvasHeight) > 0 ||
            getSelectionMaskFactor(this.activeSelectionMask, x + checkRadius, y, this.canvasWidth, this.canvasHeight) > 0 ||
            getSelectionMaskFactor(this.activeSelectionMask, x, y - checkRadius, this.canvasWidth, this.canvasHeight) > 0 ||
            getSelectionMaskFactor(this.activeSelectionMask, x, y + checkRadius, this.canvasWidth, this.canvasHeight) > 0 ||
            getSelectionMaskFactor(this.activeSelectionMask, x - diag, y - diag, this.canvasWidth, this.canvasHeight) > 0 ||
            getSelectionMaskFactor(this.activeSelectionMask, x + diag, y - diag, this.canvasWidth, this.canvasHeight) > 0 ||
            getSelectionMaskFactor(this.activeSelectionMask, x - diag, y + diag, this.canvasWidth, this.canvasHeight) > 0 ||
            getSelectionMaskFactor(this.activeSelectionMask, x + diag, y + diag, this.canvasWidth, this.canvasHeight) > 0;
          if (!touches) {
            continue;
          }
        }
      }

      const pressure = dabsArray[offset + 3];
      const targetRgb = hasColorDynamics ? evaluateColorDynamics(brushRgb, secondaryRgb, colorDynamics, {
        pressure,
        tilt,
        strokeProgress: Math.min(1, stroke.strokeDistancePx / gradientLength),
        randH: Math.random(),
        randS: Math.random(),
        randL: Math.random(),
        randMix: Math.random(),
        strokeRandH: stroke.strokeRandH,
        strokeRandS: stroke.strokeRandS,
        strokeRandL: stroke.strokeRandL,
        strokeRandMix: stroke.strokeRandMix,
        fgBgChannel: props.dynamics?.colorMix,
        mixColor,
      }, props) : brushRgb;

      let dabRgb = targetRgb;
      let alphaMultiplier = 1;
      if (usesMixer) {
        const sampleR = Math.max(1, size * 0.34);
        const acrossX = -Math.sin(strokeAngle) * sampleR;
        const acrossY = Math.cos(strokeAngle) * sampleR;
        const aheadX = acrossY * 0.65;
        const aheadY = -acrossX * 0.65;
        const offsets: Array<[number, number]> = [
          [0, 0],
          [acrossX, acrossY],
          [-acrossX, -acrossY],
          [aheadX + acrossX * 0.5, aheadY + acrossY * 0.5],
          [aheadX - acrossX * 0.5, aheadY - acrossY * 0.5],
        ];
        let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
        for (const [ox, oy] of offsets) {
          const [ur, ug, ub, ua] = sampleMixerUnder(x + ox, y + oy);
          if (ua >= 24) {
            const w = ua / 255;
            sumR += Math.min(255, Math.max(0, (ur * 255) / ua)) * w;
            sumG += Math.min(255, Math.max(0, (ug * 255) / ua)) * w;
            sumB += Math.min(255, Math.max(0, (ub * 255) / ua)) * w;
            sumW += w;
          }
        }
        const sampledRgb = sumW > 0 ? { r: sumR / sumW, g: sumG / sumW, b: sumB / sumW } : null;
        const result = stepPigmentReservoir(stroke.reservoirColor, targetRgb, sampledRgb, {
          mixMode,
          pigmentBlendMode,
          pigmentStrength,
          colorMixing,
          paintAmount,
          colorStretch,
          pressure,
          sampledAlpha: sumW / offsets.length,
          strokeDistancePx: stroke.strokeDistancePx,
          chargeDepletion,
          hasSampledSmudge: stroke.smudgeSampled,
        });
        stroke.reservoirColor = result.nextReservoir;
        stroke.smudgeSampled = result.smudgeSampled;
        if (result.skipDab) continue;
        dabRgb = result.dabColor;
        alphaMultiplier = result.alphaMultiplier;
      } else if (chargeDepletion > 0) {
        const chargeLength = 200 + Math.max(0, Math.min(1, paintAmount)) * 1800;
        alphaMultiplier = Math.max(0.12, Math.exp(-stroke.strokeDistancePx * chargeDepletion / chargeLength));
      }
      const dabColor = dabRgb === brushRgb ? baseColorHex : rgbToHex(Math.round(dabRgb.r), Math.round(dabRgb.g), Math.round(dabRgb.b));

      // 3. Tip angle and tilt
      const rotation =
        angleMode === 'fixed' ? tipAngle
          : angleMode === 'pen' ? strokeAngle + tipAngle // the worker put the pen's angle in this slot
            : strokeAngle + tipAngle;
      if (tiltSize > 0 && tilt > 0) size *= 1 + tiltSize * tilt * 1.5;
      if (antialiasFineInk && size < 1.6) {
        // Small dabs can miss every pixel center. Keep their coverage proportional to
        // area until 8-bit alpha would quantize away the lightest contacts.
        const coverage = size / 1.6;
        alpha *= coverage * Math.max(coverage, 0.27);
        size = 1.6;
      }

      const pointsToStamp = wrappedPoints?.[i] ?? (isSymmetry ? rulerMgr.getSymmetryPoints({ x, y }) : [{ x, y }]);

      if (selectedTip) {
        const scaleMode = antiAlias === 'none' ? 'nearest' : 'linear';
        if (selectedTip.source.scaleMode !== scaleMode) selectedTip.source.scaleMode = scaleMode;
      }
      const dabEntry = selectedTip
        ? { texture: selectedTip, scaleRatio: 1 }
        : isPencil
          ? this.getOrCreatePencilTipEntry(hardness, antiAlias, size)
          : this.getOrCreateProceduralTipEntry(hardness, antiAlias, size, airbrush);

      const isPixelEdge = antiAlias === 'none';
      const mainWidth = (isPixelEdge ? Math.max(1, Math.round(size)) : size) * dabEntry.scaleRatio;
      const dualStep = Math.max(1.5, mainWidth * dualRatio * dualSpacing);
      const emitSecondary = dual && pointsToStamp.length > 0 && (!stroke.dualStamped || stroke.dualDistanceAcc >= dualStep);
      const secondaryTip = emitSecondary ? this.getDualTipShapeTexture(dualShape, dabEntry.texture) : null;
      const scatterSeed = emitSecondary ? Math.random() * 1000 : 0;
      if (emitSecondary) {
        stroke.dualStamped = true;
        stroke.dualDistanceAcc %= dualStep;
      }
      for (const pt of pointsToStamp) {
        const sprite = this.spritePool.pop() || new Sprite(dabEntry.texture);
        sprite.texture = dabEntry.texture;
        sprite.roundPixels = isPixelEdge;
        if (isPixelEdge) {
          const pxW = Math.max(1, Math.round(size));
          const pxH = Math.max(1, Math.round(pxW * roundness));
          sprite.anchor.set(0, 0);
          sprite.position.set(Math.round(pt.x - pxW * 0.5), Math.round(pt.y - pxH * 0.5));
          sprite.width = pxW * dabEntry.scaleRatio;
          sprite.height = pxH * dabEntry.scaleRatio;
          sprite.rotation = 0;
        } else {
          sprite.anchor.set(0.5);
          sprite.position.set(pt.x, pt.y);
          sprite.width = size * dabEntry.scaleRatio;
          sprite.height = size * roundness * dabEntry.scaleRatio;
          const grainX = wrappedPoints ? x : pt.x;
          const grainY = wrappedPoints ? y : pt.y;
          sprite.rotation = isPencil ? rotation + (Math.sin(grainX * 12.9898 + grainY * 78.233) * Math.PI) : rotation;
        }

        const effectiveAlpha = isPixelEdge ? alphaMultiplier : Math.max(0, Math.min(1, alpha * alphaMultiplier));
        if (isEraser) {
          // Selection clipping uses coverage in a scratch texture before erasing the layer.
          sprite.blendMode = useScratch ? 'normal' : 'erase';
          sprite.tint = 0xffffff;
          sprite.alpha = dedicatedEraser ? alpha : effectiveAlpha;
        } else if (isAlphaLocked && !useScratch) {
          sprite.tint = dabColor;
          sprite.alpha = effectiveAlpha;
          sprite.blendMode = 'source-atop' as any;
        } else {
          sprite.tint = dabColor;
          sprite.alpha = effectiveAlpha;
          sprite.blendMode = 'normal';
        }

        this.stampBatch.addChild(sprite);
        if (secondaryTip) {
          this.appendDualStamps(sprite, secondaryTip, dualRatio, dualSpread, scatterSeed);
        }
      }
    }

    if (this.stampBatch.children.length > 0) {
      // The box of what was really stamped (symmetry adds mirrored dabs outside the input's box)
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const regions: Rect[] = [];
      for (const c of this.stampBatch.children as Sprite[]) {
        const r = Math.max(c.width, c.height) * 0.75 + 2; // covers any rotation
        const x = c.roundPixels ? c.x + c.width / 2 : c.x;
        const y = c.roundPixels ? c.y + c.height / 2 : c.y;
        regions.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r });
        x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r);
        y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r);
      }
      const sbx = Math.max(0, Math.floor(x0));
      const sby = Math.max(0, Math.floor(y0));
      const sbw = Math.max(1, Math.min(this.canvasWidth, Math.ceil(x1)) - sbx);
      const sbh = Math.max(1, Math.min(this.canvasHeight, Math.ceil(y1)) - sby);
      // Accumulate faint dabs before rounding to the layer's 8-bit channels. Repeatedly rounding
      // each dab cuts off its tail and creates visible bands where overlapping dabs cross a byte boundary.
      const scratchFits = sbw <= this.scratchLimit && sbh <= this.scratchLimit;
      const precise = explicitAirbrush && this.supportsFloatColorBuffer && (!isAlphaLocked || useScratch);
      if (useScratch || precise) {
        const renderRegion = ({ x, y, w, h }: Rect) =>
          this.renderShaped(targetRT, x, y, w, h, textureDensity, dual, isEraser,
            Boolean(isAlphaLocked), needsSelectionClip, precise, wetEdges, regions);
        if (!scratchFits) {
          // Opposite-edge copies can make the combined bounds cover the entire canvas.
          const size = this.scratchLimit;
          const chunks = new Map<string, Rect>();
          for (const region of regions) {
            const right = Math.min(sbx + sbw, Math.ceil(region.x + region.w));
            const bottom = Math.min(sby + sbh, Math.ceil(region.y + region.h));
            for (let y = Math.floor(Math.max(sby, region.y) / size) * size; y < bottom; y += size) {
              for (let x = Math.floor(Math.max(sbx, region.x) / size) * size; x < right; x += size) {
                const left = Math.max(x, sbx);
                const top = Math.max(y, sby);
                chunks.set(`${x}_${y}`, {
                  x: left, y: top, w: Math.min(x + size, sbx + sbw) - left, h: Math.min(y + size, sby + sbh) - top,
                });
              }
            }
          }
          for (const chunk of chunks.values()) renderRegion(chunk);
        } else {
          renderRegion({ x: sbx, y: sby, w: sbw, h: sbh });
        }
      } else {
        this.drawInto(targetRT, this.stampBatch, x0, y0, x1 - x0, y1 - y0, regions);
      }
    }

    // Recycle previous batch sprites into pool
    for (const child of this.stampBatch.children) {
      if (child instanceof Sprite && this.spritePool.length < 500) {
        this.spritePool.push(child);
      }
    }
    this.stampBatch.removeChildren();
    this.dualBatch.removeChildren();
    this.wetBatch.removeChildren();
  }

  /**
   * Texture / dual brush: the batch is drawn into a scratch buffer, shaped there (paper grain
   * erased out, second tip intersected), then composited onto the layer like one dab.
   */
  /** A whole texture is rendered into directly; a sparse layer draws the box into the tiles it covers */
  private drawInto(target: BrushTarget, container: Container, x: number, y: number, w: number, h: number, regions?: readonly Rect[]) {
    if (target instanceof RenderTexture) this.renderer.render({ container, target, clear: false });
    else target.draw(container, x, y, w, h, regions);
  }

  private appendDualStamps(main: Sprite, texture: Texture, ratio: number, spread: number, seed: number) {
    const centerX = main.x + (0.5 - main.anchor.x) * main.width;
    const centerY = main.y + (0.5 - main.anchor.y) * main.height;
    const size = Math.max(1, main.width * ratio);
    const count = 2 + Math.round(spread * 2);
    for (let i = 0; i < count; i++) {
      const index = this.dualBatch.children.length;
      const sprite = this.dualSpritePool[index] ?? new Sprite(texture);
      if (index < 500) this.dualSpritePool[index] = sprite;
      sprite.texture = texture;
      sprite.anchor.set(0.5);
      const radius = main.width * 0.5 * spread * Math.sqrt(hash2D(i, 0, seed));
      const angle = hash2D(i, 1, seed) * Math.PI * 2;
      sprite.position.set(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius);
      sprite.width = sprite.height = size;
      sprite.rotation = hash2D(i, 2, seed) * Math.PI * 2;
      this.dualBatch.addChild(sprite);
    }
  }

  private renderEffectTexture(
    source: RenderTexture, target: RenderTexture, width: number, height: number,
    mode: Sprite['blendMode'] | 'dst-in', alpha = 1,
  ) {
    // Each pass binds its own target and samples the other render texture.
    const view = new Texture({ source: source.source, frame: new Rectangle(0, 0, width, height) });
    this.effectSprite.texture = view;
    this.effectSprite.blendMode = mode as Sprite['blendMode'];
    this.effectSprite.alpha = alpha;
    try {
      this.renderer.render({ container: this.effectBatch, target, clear: false });
    } finally {
      this.effectSprite.texture = Texture.EMPTY;
      view.destroy(false);
    }
  }

  private renderWetEdges(scratch: RenderTexture, bx: number, by: number, bw: number, bh: number) {
    const props = this.currentProperties;
    const edge = computeWetEdgeParams(props.wetEdgeStrength, props.wetEdgeWidth, props.wetEdgeDarkness, hexToRgb(props.color));
    if (edge.innerEraseAlpha <= 0 && edge.rimAlpha <= 0.01) return;

    const batch = this.wetBatch;
    const mainSprites = this.stampBatch.children as Sprite[];
    batch.removeChildren();
    batch.position.set(-bx, -by);
    for (let i = 0; i < mainSprites.length; i++) {
      const main = mainSprites[i];
      const sprite = this.wetSpritePool[i] ?? new Sprite(main.texture);
      if (i < 500) this.wetSpritePool[i] = sprite;
      sprite.texture = main.texture;
      sprite.anchor.set(0.5);
      sprite.position.set(main.x + (0.5 - main.anchor.x) * main.width, main.y + (0.5 - main.anchor.y) * main.height);
      sprite.rotation = main.rotation;
      sprite.width = main.width * edge.innerScale;
      sprite.height = main.height * edge.innerScale;
      sprite.alpha = main.alpha * edge.innerEraseAlpha;
      sprite.tint = 0xffffff;
      sprite.blendMode = 'erase';
      batch.addChild(sprite);
    }
    this.renderer.render({ container: batch, target: scratch, clear: false });

    if (edge.rimAlpha > 0.01) {
      const rim = (this.wetRimRT = this.ensureRT(this.wetRimRT, bw, bh));
      const tint = rgbToHex(edge.rimRgb.r, edge.rimRgb.g, edge.rimRgb.b);
      const rimSprites = batch.children as Sprite[];
      for (let i = 0; i < rimSprites.length; i++) {
        const sprite = rimSprites[i];
        sprite.width = mainSprites[i].width;
        sprite.height = mainSprites[i].height;
        sprite.alpha = mainSprites[i].alpha;
        sprite.tint = tint;
        sprite.blendMode = 'normal';
      }
      this.renderer.render({ container: batch, target: rim, clear: true, clearColor: [0, 0, 0, 0] });
      for (const sprite of rimSprites) {
        sprite.width *= edge.innerScale;
        sprite.height *= edge.innerScale;
        sprite.alpha = 1;
        sprite.blendMode = 'erase';
      }
      this.renderer.render({ container: batch, target: rim, clear: false });
      this.renderEffectTexture(rim, scratch, bw, bh, 'normal', edge.rimAlpha);
    }
  }

  private renderShaped(
    targetRT: BrushTarget, bx: number, by: number, bw: number, bh: number,
    textureDensity: number, dual: boolean, isEraser: boolean, isAlphaLocked: boolean,
    clipWithSelectionMask = false, precise = false, wetEdges = false, regions?: readonly Rect[],
  ) {
    const props = this.currentProperties;
    const scratch = precise
      ? (this.airbrushRT = this.ensureRT(this.airbrushRT, bw, bh, 'rgba16float'))
      : (this.scratchRT = this.ensureRT(this.scratchRT, bw, bh));
    this.stampBatch.mask = null;
    this.stampBatch.position.set(-bx, -by);
    this.renderer.render({ container: this.stampBatch, target: scratch, clear: true, clearColor: [0, 0, 0, 0] });
    this.stampBatch.position.set(0, 0);

    if (wetEdges) this.renderWetEdges(scratch, bx, by, bw, bh);

    if (dual) {
      const dualRT = (this.dualRT = this.ensureRT(this.dualRT, bw, bh));
      const dualMode = props.dualBlendMode ?? 'multiply';
      this.dualBatch.position.set(-bx, -by);
      this.renderer.render({ container: this.dualBatch, target: dualRT, clear: true, clearColor: [0, 0, 0, 0] });
      switch (dualMode) {
        case 'screen':
        case 'overlay':
          if (this.dualBatch.children.length > 0) {
            this.renderEffectTexture(scratch, dualRT, bw, bh, 'dst-in');
            this.renderEffectTexture(dualRT, scratch, bw, bh, dualMode, dualMode === 'screen' ? 0.55 : 0.75);
          }
          break;
        case 'subtract':
          this.renderEffectTexture(dualRT, scratch, bw, bh, 'erase', 0.85);
          break;
        default:
          this.renderEffectTexture(dualRT, scratch, bw, bh, 'dst-in', dualMode === 'darken' ? 0.78 : 1);
      }
    }

    if (textureDensity > 0) {
      const holder = new Container();
      const paperTex = this.getPaperTexture(Boolean(props.textureInvert));
      const paper = new TilingSprite({ texture: paperTex, width: bw, height: bh });
      const scale = Math.max(0.25, props.textureScale ?? 1);
      paper.tileScale.set(scale);
      paper.tilePosition.set(-bx, -by); // fixed to the canvas, like paper, not to the stroke
      paper.alpha = Math.min(1, textureDensity);
      const texMode = props.textureBlendMode ?? 'subtract';
      if (texMode === 'multiply') {
        paper.blendMode = 'multiply';
      } else if (texMode === 'overlay') {
        paper.blendMode = 'overlay';
      } else {
        paper.blendMode = 'erase';
      }
      holder.addChild(paper);
      this.renderer.render({ container: holder, target: scratch, clear: false });
      holder.destroy({ children: true });
    }

    if (clipWithSelectionMask && this.activeSelectionMask) {
      const needed = bw * bh * 4;
      if (!this.maskUploadBytes || this.maskUploadBytes.length < needed) {
        this.maskUploadBytes = new Uint8Array(needed);
      }
      const maskBytes = this.maskUploadBytes.subarray(0, needed);
      const sel = this.activeSelectionMask;
      const cw = this.canvasWidth;
      for (let ry = 0; ry < bh; ry++) {
        const srcRow = (by + ry) * cw + bx;
        const dstRow = ry * bw * 4;
        for (let rx = 0; rx < bw; rx++) {
          const m = sel[srcRow + rx];
          const k = dstRow + rx * 4;
          maskBytes[k] = m;
          maskBytes[k + 1] = m;
          maskBytes[k + 2] = m;
          maskBytes[k + 3] = m;
        }
      }
      const maskTex = new Texture({
        source: new BufferImageSource({
          resource: maskBytes,
          width: bw,
          height: bh,
          format: 'rgba8unorm',
          alphaMode: 'premultiplied-alpha',
        }),
      });
      const holder = new Container();
      const clipSprite = new Sprite(maskTex);
      clipSprite.blendMode = 'dst-in' as any;
      holder.addChild(clipSprite);
      this.renderer.render({ container: holder, target: scratch, clear: false });
      maskTex.destroy(true);
      holder.destroy({ children: true });
    }

    const stroke = new Sprite(new Texture({ source: scratch.source, frame: new Rectangle(0, 0, bw, bh) }));
    stroke.position.set(bx, by);
    stroke.blendMode = isEraser ? 'erase' : isAlphaLocked ? ('source-atop' as any) : 'normal';
    this.composite.removeChildren();
    this.composite.addChild(stroke);
    this.composite.mask = null;
    this.drawInto(targetRT, this.composite, bx, by, bw, bh, regions);
    this.composite.removeChildren();
    stroke.texture.destroy(false);
    stroke.destroy();
  }

  /**
   * The brush settings panel's sample: an S stroke with a pressure swell, drawn with every engine
   * option through the same stampDabs (no selection, no rulers).
   */
  public renderPreview(width = 260, height = 72, background = 0xffffff): HTMLCanvasElement | null {
    const savedStroke = this.strokeState;
    const savedW = this.canvasWidth;
    const savedH = this.canvasHeight;
    const savedMode = this.previewMode;
    const savedMask = this.stampBatch.mask;
    let rt: RenderTexture | null = null;
    try {
      rt = RenderTexture.create({ width, height, resolution: 1 });
      const bg = new Graphics().rect(0, 0, width, height).fill({ color: background });
      this.renderer.render({ container: bg, target: rt, clear: true });
      bg.destroy();
      const props = this.currentProperties;
      const maxSize = Math.min(props.size, height * 0.55);
      const minSize = Math.min(props.minSize, maxSize);
      const dabs: number[] = [];
      const steps = 220;
      let prev = { x: 10, y: height / 2 };
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = 12 + t * (width - 24);
        const y = height / 2 + Math.sin(t * Math.PI * 2) * height * 0.22;
        const pressure = Math.sin(t * Math.PI) * 0.85 + 0.15;
        const dynInput = { pressure, tilt: 0.5 * t, velocity: Math.sin(t * Math.PI), rand: (i * 0.6180339) % 1 };
        const dyn = props.dynamics;
        const size = dyn?.size
          ? Math.max(1, maxSize * evaluateDynamicChannel({ ...dyn.size, min: dyn.size.min ?? (maxSize > 0 ? minSize / maxSize : 0) }, dynInput, 1))
          : minSize + (maxSize - minSize) * pressure;
        const isPencilPreview = props.brushType === 'pencil';
        const minStep = isPencilPreview ? (size < 4 ? Math.max(0.25, size * 0.2) : 0.8) : (size < 4 ? 0.35 : 0.8);
        const effectiveSpacing = isPencilPreview
          ? Math.max(minStep, size * Math.max(0.10, props.spacing))
          : Math.max(minStep, size * Math.max(MIN_BRUSH_SPACING, props.spacing));
        const dist = Math.hypot(x - prev.x, y - prev.y);
        if (i > 0 && dist < effectiveSpacing) continue;
        const angle = Math.atan2(y - prev.y, x - prev.x);
        const flowMult = dyn?.flow ? evaluateDynamicChannel(dyn.flow, dynInput, 1) : 1;
        let dabAlpha: number;
        if (isPencilPreview) {
          const opMult = dyn?.opacity ? evaluateDynamicChannel(dyn.opacity, dynInput, 1) : Math.pow(pressure, 0.75);
          const toothComp = pressure > 0.7 ? 1 + ((pressure - 0.7) / 0.3) * 0.75 : 1;
          const rawLoad = Math.min(0.999, Math.max(0, props.flow * flowMult * opMult));
          const inkLoad = Math.min(0.9995, 1 - Math.pow(1 - rawLoad, toothComp));
          const passAlpha = Math.min(0.9995, props.opacity * inkLoad);
          const sampleStep = i > 0 ? Math.max(effectiveSpacing, dist) : effectiveSpacing;
          const overlap = Math.max(1.0, (0.72 * size) / sampleStep);
          dabAlpha = 1 - Math.pow(1 - passAlpha, 1 / overlap);
        } else {
          const opMult = dyn?.opacity ? evaluateDynamicChannel(dyn.opacity, dynInput, 1) : (0.2 + 0.8 * pressure);
          dabAlpha = props.flow * flowMult * props.opacity * opMult;
        }
        dabs.push(x, y, size, pressure, dabAlpha, angle, 0.5 * t);
        prev = { x, y };
      }
      this.canvasWidth = width;
      this.canvasHeight = height;
      this.previewMode = true;
      this.stampBatch.mask = null;
      this.resetStrokeState();
      this.stampDabs(rt, new Float32Array(dabs), dabs.length / 7, undefined, props.isEraser ? false : undefined);
      return this.renderer.extract.canvas({ target: rt }) as HTMLCanvasElement;
    } catch (err) {
      console.warn('[BrushRenderer] preview failed:', err);
      return null;
    } finally {
      this.strokeState = savedStroke;
      this.canvasWidth = savedW;
      this.canvasHeight = savedH;
      this.previewMode = savedMode;
      this.stampBatch.mask = savedMask;
      this.stampBatch.position.set(0, 0);
      rt?.destroy(true);
    }
  }

  /**
   * Continuous Ping-Pong double buffering stamp:
   * Stamps dabs onto readRT, rendering composite into writeRT, then returns swapped RTs
   */
  public stampPingPong(
    readRT: RenderTexture,
    writeRT: RenderTexture,
    dabsArray: Float32Array,
    count: number,
    isEraser?: boolean,
    isAlphaLocked?: boolean
  ): RenderTexture {
    // 1. Copy previous content from readRT into writeRT
    const blitSprite = new Sprite(readRT);
    this.renderer.render({
      container: blitSprite,
      target: writeRT,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });

    // 2. Stamp new dabs directly onto writeRT
    this.stampDabs(writeRT, dabsArray, count, undefined, isEraser, isAlphaLocked);

    return writeRT;
  }
}
