import {
  AlphaFilter,
  BufferImageSource,
  CanvasSource,
  Container,
  defaultFilterVert,
  Filter,
  Graphics,
  MaskFilter,
  Matrix,
  Particle,
  ParticleContainer,
  Rectangle,
  type Renderer,
  RenderTexture,
  Sprite,
  Texture,
  TilingSprite,
  type TextureSource,
} from 'pixi.js';
// Overlay, soft light, colour dodge… are filter-based in Pixi 8 and fall back to normal without this
import 'pixi.js/advanced-blend-modes';
import {
  ColorBurnBlend,
  ColorDodgeBlend,
  DarkenBlend,
  DifferenceBlend,
  ExclusionBlend,
  HardLightBlend,
  LightenBlend,
  OverlayBlend,
  SoftLightBlend,
  SubtractBlend,
} from 'pixi.js';
import {
  compressTileBuffer,
  computeRecommendedGpuTileBudget,
  decompressTileBuffer,
  DEFAULT_TILE_SIZE,
  type Affine2D,
  type BlendMode,
  type LayerModel,
  type TileCoord,
  type TileData,
} from '@atelier/shared';
import { compileAdjustment, normalizeAdjustment, resolveAdjustmentScope, type LayerAdjustment } from '@atelier/shared';
import { DEFAULT_LAYER_SUB_COLOR, resolveEffectiveLayerColor, type LayerColorMeta } from '@atelier/shared';
import { hasActiveLayerEffects, layerEffectsKey, type LayerEffectsMeta } from '@atelier/shared';
import { AdjustmentFilter } from './adjustmentFilter';
import { LayerColorFilter } from './layerColorFilter';
import { LayerEffectsFilter } from './layerEffectsFilter';
import {
  adjustmentScopeIsFresh,
  adjustmentScopeKey,
  adjustmentScopeRenderResolution,
  type AdjustmentView,
  type ScopeDependencyState,
} from './adjustmentView';
import { normalizeTileBytes } from './TileEngine';
import { applyMagFilter, ATLAS_MIP_LEVELS, GUTTER, PITCH, TileAtlas, type MagFilter, type Slot } from './TileAtlas';
import { fullMipLevels, MipmapView } from './MipmapView';
import { compressTiles, decodeTiles } from './commitWorkers';

/** mapPixiBlendMode's filter-based modes: on a filtered layer this filter is appended to do the blend */
const ADVANCED_BLEND_FILTERS: Record<string, new () => Filter> = {
  overlay: OverlayBlend,
  darken: DarkenBlend,
  lighten: LightenBlend,
  'color-dodge': ColorDodgeBlend,
  'color-burn': ColorBurnBlend,
  'hard-light': HardLightBlend,
  'soft-light': SoftLightBlend,
  difference: DifferenceBlend,
  exclusion: ExclusionBlend,
  subtract: SubtractBlend,
};

export interface PixiLayerItem {
  model: LayerModel;
  readonly version: number;
  /** The whole layer as one texture. Reading it makes a sparse layer resident again (see LayerItem) */
  renderTexture: RenderTexture;
  /** FBO ping-pong buffer: the layer as of the last sync. Created on first use (most layers are never drawn on here) */
  pingPongTexture: RenderTexture;
  sprite: Sprite;
  /** What is drawn for the layer (its sprite or its tile sprites, previews above them); blend, opacity and filters are set here */
  display: Container;
  screentoneFilter?: Filter | null;
  onionFilter?: Filter | null;
  /** Layer masks / clipping as MaskFilters, keyed by the sprite they sample */
  maskFilters?: Map<string, MaskFilter>;
}

/** Something a brush draws into: given the batch's box, it renders the batch where it lands */
export interface DrawTarget {
  draw(container: Container, x: number, y: number, w: number, h: number, regions?: readonly Rect[]): void;
}
/** A whole layer texture (resident layer), or a sparse layer drawn tile by tile */
export type BrushTarget = RenderTexture | DrawTarget;
export type StrokeInk = Map<string, { col: number; row: number; slot: Slot }>;
export type Rect = { x: number; y: number; w: number; h: number };
/** GPU read-back (TileEngine.readRegionsAsync): the copies are queued in order with the drawing */
export type RegionReader = (texture: RenderTexture, rects: Rect[]) => Promise<Uint8Array[]>;
/** Context passed when applying remote tiles concurrently with recent/active local edits on the same layer */
export interface TileConcurrencyContext {
  /** Pre-edit state of tiles touched locally after the remote op's baseSeq (`col_row` -> tile) */
  baseTiles?: Map<string, TileData>;
  /** Returns true when the incoming remote op is newer than the latest local commit on `(col, row)` */
  remoteIsNewer?: (col: number, row: number) => boolean;
}

const TS = DEFAULT_TILE_SIZE;
/** An unpinned layer nobody touched for this long goes back to sparse tiles */
const PARK_AFTER_MS = 3000;
/** Big canvases drop an idle layer's before-state copy (it is rebuilt before the layer is used again) */
const PINGPONG_IDLE_MS = 8000;
const BIG_CANVAS_PX = 4096 * 4096;
/** The composite texture (canvas-sized, for fills and exports) is freed after this long unused */
const SCRATCH_IDLE_MS = 10000;
/** Zoomed back to 100 % or more for this long: the zoomed-out mip levels' memory is freed */
const MIP_IDLE_MS = 5000;
/** Main-thread time one background step (parking / freezing a layer) may take */
const STEP_BUDGET_MS = 6;
const HYDRATE_BATCH_SIZE = 48;
const HYDRATE_DRAW_DELAY_MS = 250;
const FULL_COMPOSITE_COLD_LIMIT = 2400;
const TILE_LABEL = 'layer-tile';

/** GPU memory for tiles of layers that are not on screen (animation frames, hidden layers): over it, the least recently shown go to the CPU */
const HIDDEN_TILE_BUDGET = (() => {
  if (typeof navigator === 'undefined') return 384 * 1048576;
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  // Phones and tablets share RAM with the GPU: keep less there
  return Math.min(gb ? Math.max(96, gb * 48) : 384, coarse ? 192 : 512) * 1048576;
})();

/** Soft budget of active GPU tiles across visible warm layers before offscreen tiles spill to CPU LRU */
const SOFT_GPU_TILE_LIMIT = (() => {
  if (typeof navigator === 'undefined') return 1536;
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarse || (gb !== undefined && gb <= 4) ? 768 : 1536;
})();

/** Large cold layer tile count threshold above which thaw only uploads tiles intersecting the viewport */
const VIEW_THAW_TILE_THRESHOLD = 192;

/** A warm tile: its pixels in an atlas slot, shown by a sprite at its canvas position */
interface GpuTile { col: number; row: number; slot: Slot; sprite: Sprite; w: number; h: number; lastSeenMs?: number }
interface CpuTile { data: Uint8Array; compression: 'lz4' | 'raw'; w: number; h: number }

const emptyLz4Tiles = new Map<string, { data: Uint8Array; compression: 'lz4' | 'raw' }>();

function getEmptyLz4Tile(w: number, h: number): { data: Uint8Array; compression: 'lz4' | 'raw' } {
  const key = keyOf(w, h);
  let empty = emptyLz4Tiles.get(key);
  if (!empty) {
    const { data, compression } = compressTileBuffer(new Uint8Array(w * h * 4), 'lz4');
    empty = { data, compression: compression === 'lz4' ? 'lz4' : 'raw' };
    emptyLz4Tiles.set(key, empty);
  }
  return empty;
}

/** True if every byte is 0 (premultiplied: fully transparent) */
function isEmpty(px: Uint8Array, stride = 0, x = 0, w = 0, rows = 0): boolean {
  if (!stride) {
    if (px.byteOffset % 4 === 0) {
      const u = new Uint32Array(px.buffer, px.byteOffset, px.length >> 2);
      for (let i = 0; i < u.length; i++) if (u[i]) return false;
      return true;
    }
    for (let i = 0; i < px.length; i++) if (px[i]) return false;
    return true;
  }
  // A w × rows block at column x of an image `stride` pixels wide
  const u = new Uint32Array(px.buffer, px.byteOffset, px.length >> 2);
  for (let y = 0; y < rows; y++) {
    const base = y * stride + x;
    for (let i = 0; i < w; i++) if (u[base + i]) return false;
  }
  return true;
}

/** One tile's worth of bytes, reused where a decoded tile is uploaded before the next is decoded */
const SCRATCH = new Uint8Array(TS * TS * 4);

function decodeTile(t: { data: unknown; compression?: string; width?: number; height?: number; w?: number; h?: number }, out?: Uint8Array): Uint8Array | null {
  const w = t.w ?? t.width ?? 0;
  const h = t.h ?? t.height ?? 0;
  const len = w * h * 4;
  if (len <= 0) return null;
  const bytes = normalizeTileBytes(t.data);
  const raw = t.compression === 'lz4' ? decompressTileBuffer(bytes, 'lz4', len, out) : bytes;
  return raw && raw.length >= len ? raw : null;
}

const keyOf = (col: number, row: number) => `${col}_${row}`;

/** Three-way per-pixel merge between `common` baseline, local `curr`, and `remote` incoming tile RGBA */
function mergePixels3Way(
  common: Uint8Array,
  curr: Uint8Array,
  remote: Uint8Array,
  remoteWinsTie: boolean
): Uint8Array {
  const out = new Uint8Array(curr);
  const n = Math.min(common.length, curr.length, remote.length);
  for (let i = 0; i < n; i += 4) {
    const bChanged =
      remote[i] !== common[i] ||
      remote[i + 1] !== common[i + 1] ||
      remote[i + 2] !== common[i + 2] ||
      remote[i + 3] !== common[i + 3];
    if (!bChanged) continue;
    const aChanged =
      curr[i] !== common[i] ||
      curr[i + 1] !== common[i + 1] ||
      curr[i + 2] !== common[i + 2] ||
      curr[i + 3] !== common[i + 3];
    if (!aChanged || remoteWinsTie) {
      out[i] = remote[i];
      out[i + 1] = remote[i + 1];
      out[i + 2] = remote[i + 2];
      out[i + 3] = remote[i + 3];
    }
  }
  return out;
}

/** Keeps pixels modified during an active local stroke (`curr !== before`) and fills untouched pixels from `bak` */
function overlayActivePixels(beforeStroke: Uint8Array, curr: Uint8Array, mergedBak: Uint8Array): Uint8Array {
  const out = new Uint8Array(curr);
  const n = Math.min(beforeStroke.length, curr.length, mergedBak.length);
  for (let i = 0; i < n; i += 4) {
    const activeChanged =
      curr[i] !== beforeStroke[i] ||
      curr[i + 1] !== beforeStroke[i + 1] ||
      curr[i + 2] !== beforeStroke[i + 2] ||
      curr[i + 3] !== beforeStroke[i + 3];
    if (!activeChanged) {
      out[i] = mergedBak[i];
      out[i + 1] = mergedBak[i + 1];
      out[i + 2] = mergedBak[i + 2];
      out[i + 3] = mergedBak[i + 3];
    }
  }
  return out;
}

/**
 * A layer in one of three forms, so GPU memory goes to what is on screen and being drawn:
 * - resident: one canvas-sized RenderTexture (+ the ping-pong copy). Tools that read or write the
 *   whole layer (fill, liquify, transform…) work on this.
 * - warm (sparse): only the 256 px tiles that have pixels, in atlas slots. The active layer stays
 *   like this: the brush draws into the tiles it touches (drawTarget), and the before-state is a
 *   copy of each tile taken the first time a stroke writes to it (`bak`).
 * - cold: those tiles LZ4-compressed on the CPU, nothing on the GPU (hidden layers, animation
 *   frames not on screen).
 * Reading `renderTexture` / `pingPongTexture` makes it resident; layers nobody pinned or touched
 * for PARK_AFTER_MS go back to warm in the background.
 */
class LayerItem implements PixiLayerItem {
  readonly display = new Container();
  readonly sprite = new Sprite();
  rt: RenderTexture | null = null;
  pp: RenderTexture | null = null;
  /** pp equals rt as of the last sync, and nothing read rt since */
  ppClean = true;
  /** pp was freed while idle: it is copied back before rt is handed out again */
  ppReleased = false;
  gpu: Map<string, GpuTile> | null = null;
  cpu: Map<string, CpuTile> | null = new Map(); // a new layer is empty and cold
  /** Offscreen tiles evicted from an active warm layer under viewport/VRAM budget */
  coldTiles: Map<string, CpuTile> = new Map();
  /** Clean compressed payload for warm GPU tiles untouched since thaw/upload (zero-readPixels eviction) */
  cleanCache: Map<string, CpuTile> = new Map();
  /** Warm layer being edited: each tile's pixels before its first write since the last sync (null = it did not exist) */
  bak: Map<string, Slot | null> | null = null;
  bakClean: Map<string, CpuTile | null> | null = null;
  /** The atlas page this layer last got a slot from: its next tiles go there first (fewer textures per layer) */
  lastPage = -1;
  /** Its cold tiles are being decoded in a worker (prefetch) */
  decoding = false;
  lastUsed = performance.now();
  lastShown = 0;
  /** Bumps on anything that may change the pixels (thumbnail cache, background jobs) */
  version = 0;
  stackRevision = 0;
  shown = false;
  hasAnimatedTransform = false;
  destroyed = false;
  thumb: { version: number; url: string } | null = null;
  screentoneFilter?: Filter | null;
  layerColorFilter?: LayerColorFilter | null;
  layerColorKey?: string;
  layerEffectsFilter?: LayerEffectsFilter | null;
  layerEffectsKey?: string;
  onionFilter?: Filter | null;
  maskFilters?: Map<string, MaskFilter>;
  /** On a layer with filters, the filter that does its blend mode (see syncLayers) */
  blendFilter: { mode: string; filter: Filter } | null = null;
  /** On an adjustment layer (no pixels): the quad its filter recolours through, and its scope texture */
  adjust: AdjustmentView | null = null;

  constructor(public model: LayerModel, private host: LayerManager) {}

  get renderTexture(): RenderTexture {
    return this.host.use(this);
  }
  set renderTexture(rt: RenderTexture) {
    this.rt = rt;
  }
  /** Unallocated means "same as renderTexture", so creating it copies the layer */
  get pingPongTexture(): RenderTexture {
    const rt = this.host.use(this);
    if (!this.pp) this.pp = this.host.copyTexture(rt);
    return this.pp;
  }
  set pingPongTexture(rt: RenderTexture) {
    this.pp = rt;
  }
  get hasPingPong() {
    return this.pp !== null;
  }
}

type Job =
  | { kind: 'park'; item: LayerItem; version: number; next: number; tiles: Map<string, GpuTile>; reading?: boolean }
  | { kind: 'freeze'; item: LayerItem; version: number; next: number; keys: string[]; tiles: Map<string, CpuTile>; reading?: boolean };

type HydrateTile = TileCoord & { item: LayerItem; key: string; cpu: CpuTile };

interface StackCache {
  activeId: string | null;
  belowIds: string[];
  aboveIds: string[];
  belowSig: string;
  aboveSig: string;
  viewKey: string;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  lastUsedMs: number;
  hits: number;
  rebuilds: number;
}

export class LayerManager {
  public rootContainer: Container;
  public layersContainer: Container;
  public previewContainer: Container;
  public backgroundGraphic: Graphics;
  /** A thumbnail that had to wait (a cold layer's tiles are decoded when the page is idle) */
  public onThumbnail: ((layerId: string, url: string) => void) | null = null;
  /** Called when visible stage contents or layer textures change so an on-demand renderer can present a frame */
  public onStageChange: (() => void) | null = null;

  private renderer: Renderer;
  private canvasWidth: number;
  private canvasHeight: number;
  private cols: number;
  private rows: number;
  private lastBgColor: string = '#FFFFFF';
  private paperVisible = true;
  private paperCheckerGraphic: TilingSprite | null = null;
  private localLayerColors: Record<string, LayerColorMeta | null> = {};
  private layersMap = new Map<string, LayerItem>();
  private emptyContainer = new Container();
  private atlas: TileAtlas;
  private mips: MipmapView;
  private reader: RegionReader | null = null;
  private onFlushReads?: () => void;
  private pendingReadCount = 0;
  private pendingBakReads = new Map<string, number>();
  private heldBakSlots = new Map<string, Set<Slot>>();
  private pendingAfterSlots = new Map<string, Map<Slot, number>>();
  private heldAfterSlots = new Map<string, Set<Slot>>();
  /** The layer being edited: kept warm (never frozen to the CPU), drawn into tile by tile */
  private activeId: string | null = null;
  /** Layers that must stay resident: a transform in progress, … (reason → id) */
  private pins = new Map<string, string | null>();
  /** Masks, clipping bases and screentone layers: sampled by filters as one whole texture */
  private structuralPins = new Set<string>();
  private job: Job | null = null;
  private jobTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval>;
  private thumbQueue = new Map<string, { w: number; h: number; local: boolean }>();
  private thumbTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRemoteThumbExtractAt = 0;
  private lastLocalDrawAt = 0;
  private lastInteractionAt = 0;

  public markInteractive() {
    this.lastInteractionAt = performance.now();
  }

  /** Live previews (other painters' strokes in progress, text being typed): sparse like a layer */
  private preview: LayerItem;
  private previewPainters = new Map<string, { container: ParticleContainer<Particle>; lastAt: number }>();
  private previewParticlePool: Particle[] = [];
  private thumbBlobUrls = new Set<string>();
  private wrapAroundEnabled = false;
  private wrapAroundContainer: Container | null = null;
  private wrapRT: RenderTexture | null = null;
  private wrapShapeOverlay: Container | null = null;
  private wrapShapeGraphic: Graphics | null = null;
  private viewportBounds: LayerManager['viewBounds'] = null;
  private viewBounds: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private cullSuspended = 0;
  private tileStructureVersion = 0;
  private lastViewGridKey = '';
  private hydrateEpoch = 0;
  private hydrateInFlight = false;
  private hydrateRaf = 0;
  private hydrateTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanWritebackInFlight = false;
  private sharpMipTimer: ReturnType<typeof setTimeout> | null = null;
  private belowCacheRT: RenderTexture | null = null;
  private belowCacheSprite: Sprite | null = null;
  private aboveCacheRT: RenderTexture | null = null;
  private aboveCacheSprite: Sprite | null = null;
  private stackCacheSuspended = 0;
  private stackHidden: Container[] = [];
  private stackFilterRevision = 0;
  private stackFailedViewKey = '';
  private stackBelowSharp = false;
  private stackAboveSharp = false;
  private stackCache: StackCache = {
    activeId: null, belowIds: [], aboveIds: [], belowSig: '', aboveSig: '',
    viewKey: '', width: 0, height: 0, scaleX: 1, scaleY: 1, lastUsedMs: 0, hits: 0, rebuilds: 0,
  };
  private evictingOffscreen = false;
  private thumbsPaused = false;
  private destroyed = false;
  private readonly hiddenTileBudget: number;
  private softGpuTileLimit: number;
  private softGpuByteLimit: number;
  private lruCleanEvictions = 0;
  private lruDirtyEvictions = 0;
  private lruReheatHits = 0;
  private readonly viewThawThreshold: number;
  private readonly prefetchLayers: number;
  private readonly scratchIdleMs: number;
  private readonly visiblePages = new Set<number>();

  constructor(renderer: Renderer, width: number, height: number, bgColor: string = '#FFFFFF', solo = false) {
    this.renderer = renderer;
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.cols = Math.ceil(width / TS);
    this.rows = Math.ceil(height / TS);
    this.lastBgColor = bgColor || '#FFFFFF';
    const memory = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory ?? 8;
    const screen = globalThis.screen;
    const phone = screen && Math.min(screen.width, screen.height) < 600;
    const is8K = width * height >= 64 * 1024 * 1024;
    const constrained = solo && (phone || memory <= 4);
    const hiddenMiB = constrained ? Math.max(12, Math.min(memory * 8, 32)) : 48;
    const recBudget = computeRecommendedGpuTileBudget(width, height, memory, Boolean(phone));
    this.hiddenTileBudget = solo ? Math.min(HIDDEN_TILE_BUDGET, hiddenMiB * 1048576) : HIDDEN_TILE_BUDGET;
    this.softGpuTileLimit = constrained
      ? Math.max(128, Math.min(512, memory * 96))
      : Math.min(SOFT_GPU_TILE_LIMIT, recBudget.maxTiles);
    this.softGpuByteLimit = constrained ? Math.min(160 * 1048576, recBudget.maxBytes) : recBudget.maxBytes;
    this.viewThawThreshold = constrained ? 16 : solo ? 64 : is8K ? 96 : VIEW_THAW_TILE_THRESHOLD;
    this.prefetchLayers = constrained ? 1 : solo ? 2 : is8K ? 3 : Infinity;
    this.mips = new MipmapView(renderer);
    this.atlas = new TileAtlas(
      renderer,
      this.mips,
      constrained ? 4 : undefined,
      constrained ? 1 : recBudget.maxPooledAtlasPages
    );
    this.scratchIdleMs = constrained ? 3000 : SCRATCH_IDLE_MS;

    this.rootContainer = new Container();

    // 1. Paper (the checkerboard is inserted below it when paper is hidden)
    this.backgroundGraphic = new Graphics();
    this.rootContainer.addChild(this.backgroundGraphic);
    this.updateBackground(this.lastBgColor);

    // 2. Layers Container
    this.layersContainer = new Container();
    this.layersContainer.sortableChildren = true;
    this.rootContainer.addChild(this.layersContainer);

    // 3. Transient preview (tiles allocated where something is drawn)
    this.preview = new LayerItem({ id: '__preview__' } as LayerModel, this);
    this.preview.cpu = null;
    this.preview.gpu = new Map();
    this.previewContainer = new Container();
    this.previewContainer.alpha = 0.85;
    this.previewContainer.addChild(this.preview.display);
    this.rootContainer.addChild(this.previewContainer);

    // Register custom WebGL blend mode for Alpha-Lock (source-atop)
    try {
      const gl = (this.renderer as any).gl;
      const glState = (this.renderer as any).stateSystem || (this.renderer as any).state;
      if (gl && glState?.blendModesMap) {
        glState.blendModesMap['source-atop'] = [
          gl.DST_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ZERO,
          gl.ONE,
        ];
      }
    } catch (e) {
      console.warn('Register source-atop blend mode failed:', e);
    }

    this.tickTimer = setInterval(this.tick, 500);
  }

  /** How readAsync / readTilesAsync read the GPU (set once by the workspace, TileEngine.readRegionsAsync) */
  public setReader(reader: RegionReader, flushReads?: () => void) {
    this.reader = reader;
    this.onFlushReads = flushReads;
  }

  private flushPendingReads() {
    if (this.pendingReadCount > 0) this.onFlushReads?.();
  }

  public setPaperVisible(visible: boolean): void {
    if (visible !== this.paperVisible) this.updateBackground(undefined, visible);
  }

  public isPaperVisible(): boolean {
    return this.paperVisible;
  }

  public updateBackground(bgColor?: string, visible = this.paperVisible) {
    const color = bgColor && bgColor.trim() !== '' ? bgColor : this.lastBgColor;
    this.lastBgColor = color;
    this.paperVisible = visible;
    this.backgroundGraphic.visible = visible;
    this.backgroundGraphic.clear();

    // Crisp edge-free paper rectangle (no dark border rim or stroke around canvas perimeter)
    this.backgroundGraphic
      .rect(0, 0, this.canvasWidth, this.canvasHeight)
      .fill({ color });

    if (!visible && !this.paperCheckerGraphic) {
      const size = 16;
      const pixels = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const shade = (x < size / 2) === (y < size / 2) ? 224 : 192;
          pixels.set([shade, shade, shade, 255], (y * size + x) * 4);
        }
      }
      const source = new BufferImageSource({
        resource: pixels, width: size, height: size, format: 'rgba8unorm', addressMode: 'repeat', scaleMode: 'nearest',
      });
      const checker = new TilingSprite({ texture: new Texture({ source }), width: this.canvasWidth, height: this.canvasHeight });
      checker.eventMode = 'none';
      this.paperCheckerGraphic = this.rootContainer.addChildAt(checker, this.rootContainer.getChildIndex(this.backgroundGraphic));
    }
    if (this.paperCheckerGraphic) {
      this.paperCheckerGraphic.width = this.canvasWidth;
      this.paperCheckerGraphic.height = this.canvasHeight;
      this.paperCheckerGraphic.visible = !visible;
    }
    this.onStageChange?.();
  }

  public setLocalLayerColors(overrides: Record<string, LayerColorMeta | null>): void {
    const entries = Object.entries(overrides);
    if (entries.length === Object.keys(this.localLayerColors).length && entries.every(([id, config]) => {
      if (!Object.hasOwn(this.localLayerColors, id)) return false;
      const prev = this.localLayerColors[id];
      return prev?.enabled === config?.enabled && prev?.mainColor === config?.mainColor && prev?.subColor === config?.subColor;
    })) return;
    this.localLayerColors = Object.fromEntries(entries.map(([id, config]) => [id, config && { ...config }]));
    if (this.lastSyncedLayers) this.syncLayers(this.lastSyncedLayers);
  }

  /** Live Layer Effects preview map (shown on this screen only while dragging sliders in the fx popover) */
  private layerEffectsPreviews = new Map<string, LayerEffectsMeta>();
  /** Isolated containers for folder/group layers that have active Layer Effects */
  private groupEffectContainers = new Map<string, {
    container: Container;
    filter: LayerEffectsFilter;
    blendFilter: { mode: string; filter: Filter } | null;
    effectsKey: string;
    minSortOrder: number;
  }>();

  public setLayerEffectsPreview(layerId: string, effects: LayerEffectsMeta | null): void {
    if (effects) this.layerEffectsPreviews.set(layerId, effects);
    else this.layerEffectsPreviews.delete(layerId);
    if (this.lastSyncedLayers) this.syncLayers(this.lastSyncedLayers);
  }

  public syncLayers(layers: LayerModel[]) {
    this.deactivateStackCache();
    this.stackFilterRevision++;
    this.lastSyncedLayers = layers;
    const existingIds = new Set(this.layersMap.keys());
    const sorted = Array.from(new Map(layers.map((layer) => [layer.id, layer])).values())
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const byId = new Map(sorted.map((l) => [l.id, l]));
    const drawable = sorted.filter((layer) => layer.layerType !== 'group');
    const incomingIds = new Set(drawable.map((l) => l.id));

    // Remove deleted layers
    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        const item = this.layersMap.get(id);
        if (item) this.destroyItem(item);
        this.layersMap.delete(id);
      }
    }

    const now = performance.now();
    // Create or update layers (bottom to top)
    for (const model of drawable) {
      let item = this.layersMap.get(model.id);

      if (!item) {
        item = new LayerItem(model, this);
        this.layersMap.set(model.id, item);
        this.layersContainer.addChild(item.display);
      } else {
        item.model = model;
      }

      const { config } = resolveEffectiveLayerColor(model.id, byId, this.localLayerColors);
      if (config) {
        const { mainColor, subColor = DEFAULT_LAYER_SUB_COLOR } = config;
        const key = `${mainColor}|${subColor}`;
        if (!item.layerColorFilter) item.layerColorFilter = new LayerColorFilter(mainColor, subColor);
        else if (item.layerColorKey !== key) item.layerColorFilter.setColors(mainColor, subColor);
        item.layerColorKey = key;
      } else if (item.layerColorFilter) {
        item.layerColorFilter.destroy();
        item.layerColorFilter = null;
        item.layerColorKey = undefined;
      }

      // Non-destructive Layer Effects on drawable layers
      const ownEffects = model.layerType !== 'mask' && model.layerType !== 'adjustment'
        ? (this.layerEffectsPreviews.get(model.id) ?? model.meta?.effects ?? null)
        : null;
      if (hasActiveLayerEffects(ownEffects) && ownEffects) {
        const fxKey = layerEffectsKey(ownEffects);
        if (!item.layerEffectsFilter) {
          item.layerEffectsFilter = new LayerEffectsFilter(ownEffects, this.layersContainer);
        } else if (item.layerEffectsKey !== fxKey) {
          item.layerEffectsFilter.setEffects(ownEffects);
        }
        item.layerEffectsKey = fxKey;
      } else if (item.layerEffectsFilter) {
        item.layerEffectsFilter.destroy();
        item.layerEffectsFilter = null;
        item.layerEffectsKey = undefined;
      }

      // Find nearest enclosing folder/group with active Layer Effects (so the folder composites as one silhouette)
      let styledGroupModel: LayerModel | null = null;
      let effectiveVisible = model.isVisible;
      let effectiveAlpha = Math.max(0, Math.min(1, model.opacity));
      let parentId = model.layerType === 'mask' ? null : model.parentId;
      for (let depth = 0; parentId && depth < 16; depth++) {
        const parentModel = byId.get(parentId);
        if (!parentModel) break;
        if (!parentModel.isVisible) effectiveVisible = false;
        const gFx = parentModel.layerType === 'group'
          ? (this.layerEffectsPreviews.get(parentModel.id) ?? parentModel.meta?.effects ?? null)
          : null;
        if (!styledGroupModel && hasActiveLayerEffects(gFx)) {
          styledGroupModel = parentModel;
        } else {
          effectiveAlpha *= Math.max(0, Math.min(1, parentModel.opacity));
        }
        parentId = parentModel.parentId;
      }

      if (styledGroupModel && model.layerType !== 'mask') {
        const gFx = (this.layerEffectsPreviews.get(styledGroupModel.id) ?? styledGroupModel.meta?.effects)!;
        const gFxKey = layerEffectsKey(gFx);
        let entry = this.groupEffectContainers.get(styledGroupModel.id);
        if (!entry) {
          const container = new Container();
          container.sortableChildren = true;
          container.label = `group-effects:${styledGroupModel.id}`;
          const filter = new LayerEffectsFilter(gFx, this.layersContainer);
          this.layersContainer.addChild(container);
          entry = { container, filter, blendFilter: null, effectsKey: gFxKey, minSortOrder: model.sortOrder };
          this.groupEffectContainers.set(styledGroupModel.id, entry);
        } else if (entry.effectsKey !== gFxKey) {
          entry.filter.setEffects(gFx);
          entry.effectsKey = gFxKey;
        }
        entry.minSortOrder = Math.min(entry.minSortOrder, model.sortOrder);
        if (item.display.parent !== entry.container) {
          entry.container.addChild(item.display);
        }
      } else if (item.display.parent !== this.layersContainer) {
        this.layersContainer.addChild(item.display);
      }

      // Onion skin (display only): the neighbouring frame in one flat colour, or shaded by its own lights and darks
      const { onionTint, onionMode } = model as LayerModel & { onionTint?: number; onionMode?: 'shade' };
      item.onionFilter = onionTint === undefined ? null : this.getOnionFilter(onionTint, onionMode === 'shade');

      item.shown = effectiveVisible && model.layerType !== 'mask';
      if (item.shown) item.lastShown = now;
      item.display.visible = effectiveVisible;
      item.display.alpha = effectiveAlpha;
      item.display.zIndex = model.sortOrder;
      item.sprite.visible = true;
      if (model.layerType === 'adjustment' && !item.adjust) this.createAdjustmentView(item);
      // An adjustment layer acts on the canvas as it is: it never moves
      const rt = model.layerType === 'adjustment' ? undefined : (model as LayerModel & { renderTransform?: Affine2D }).renderTransform;
      if (rt && !rt.isIdentity) {
        item.display.setFromMatrix(new Matrix(rt.a, rt.b, rt.c, rt.d, rt.tx, rt.ty));
        item.hasAnimatedTransform = true;
      } else if (item.hasAnimatedTransform) {
        item.display.position.set(0, 0);
        item.display.scale.set(1, 1);
        item.display.rotation = 0;
        item.display.skew.set(0, 0);
        item.hasAnimatedTransform = false;
      }
    }

    // Reconcile folder/group effect containers (update filters/opacity/zIndex and remove unused ones)
    const activeGroupIds = new Set<string>();
    for (const [gid, entry] of this.groupEffectContainers) {
      const gModel = byId.get(gid);
      const gFx = gModel ? (this.layerEffectsPreviews.get(gid) ?? gModel.meta?.effects ?? null) : null;
      if (!gModel || !hasActiveLayerEffects(gFx) || entry.container.children.length === 0) {
        while (entry.container.children.length > 0) {
          this.layersContainer.addChild(entry.container.children[0]);
        }
        this.layersContainer.removeChild(entry.container);
        entry.container.filters = null;
        entry.filter.destroy();
        entry.blendFilter?.filter.destroy();
        entry.container.destroy();
        this.groupEffectContainers.delete(gid);
        continue;
      }
      activeGroupIds.add(gid);
      let gVisible = gModel.isVisible;
      let gp = gModel.parentId ? byId.get(gModel.parentId) : undefined;
      for (let d = 0; gp && d < 16; d++) {
        if (!gp.isVisible) gVisible = false;
        gp = gp.parentId ? byId.get(gp.parentId) : undefined;
      }
      entry.container.visible = gVisible;
      entry.container.alpha = Math.max(0, Math.min(1, gModel.opacity));
      entry.container.zIndex = entry.minSortOrder;
      entry.minSortOrder = Number.POSITIVE_INFINITY;
      const gMode = this.mapPixiBlendMode(gModel.blendMode);
      const gFilters: Filter[] = [entry.filter];
      if (gMode !== 'normal') {
        let bf = entry.blendFilter;
        if (!bf || bf.mode !== gMode) {
          bf?.filter.destroy();
          bf = { mode: gMode, filter: this.createBlendFilter(gMode) };
          entry.blendFilter = bf;
        }
        gFilters.push(bf.filter);
      } else if (entry.blendFilter) {
        entry.blendFilter.filter.destroy();
        entry.blendFilter = null;
      }
      const prevG = entry.container.filters;
      const sameG = prevG && prevG.length === gFilters.length && gFilters.every((f, idx) => prevG[idx] === f);
      if (!sameG) entry.container.filters = gFilters;
      entry.container.sortChildren();
    }

    // Re-index children only when display stacking order actually changed (avoids dirtying Pixi every anim frame)
    if (activeGroupIds.size > 0) {
      this.layersContainer.sortChildren();
    } else {
      let inOrder = this.layersContainer.children.length === drawable.length;
      if (inOrder) {
        for (let i = 0; i < drawable.length; i++) {
          const item = this.layersMap.get(drawable[i].id);
          if (!item || this.layersContainer.children[i] !== item.display) {
            inOrder = false;
            break;
          }
        }
      }
      if (!inOrder) {
        for (let i = 0; i < drawable.length; i++) {
          const item = this.layersMap.get(drawable[i].id);
          if (item && item.display.parent === this.layersContainer) {
            this.layersContainer.setChildIndex(item.display, i);
          }
        }
        this.layersContainer.sortChildren();
      }
    }

    // Layer masks (on layers and on groups) are never drawn: they mask through MaskFilters,
    // which sample the mask sprite in its own space (white shows, black or empty hides; inverted
    // masks the other way round). A mask's eye switches it on and off.
    const maskOf = new Map<string, LayerModel>();
    for (const m of drawable) if (m.layerType === 'mask' && m.parentId && m.isVisible) maskOf.set(m.parentId, m);
    /** The masks that apply to a layer: its own, then every enclosing group's */
    const masksFor = (model: LayerModel): LayerModel[] => {
      const out: LayerModel[] = [];
      const own = maskOf.get(model.id);
      if (own) out.push(own);
      let parentId = model.parentId;
      for (let depth = 0; parentId && depth < 16; depth++) {
        const g = maskOf.get(parentId);
        if (g) out.push(g);
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      return out;
    };
    const clipBaseOf = (i: number) => {
      let baseIndex = i - 1;
      while (baseIndex > 0 && (drawable[baseIndex].clipToBelow || drawable[baseIndex].layerType === 'mask')) baseIndex--;
      return drawable[baseIndex];
    };
    const drawableIndex = new Map(drawable.map((m, i) => [m.id, i]));
    /** A scope composite is drawn from its members, their masks, and the clip bases (with masks) they use */
    const adjustmentDependencies = (memberIds: readonly string[]): string[] => {
      const ids = new Set<string>();
      for (const id of memberIds) {
        const member = byId.get(id);
        const i = drawableIndex.get(id);
        if (!member || i === undefined) continue;
        ids.add(id);
        for (const m of masksFor(member)) ids.add(m.id);
        if (member.clipToBelow && i > 0) {
          const base = clipBaseOf(i);
          ids.add(base.id);
          const own = maskOf.get(base.id);
          if (own) ids.add(own.id);
        }
      }
      return [...ids];
    };
    this.adjustmentOrder = drawable.filter((m) => m.layerType === 'adjustment').map((m) => m.id);
    for (const id of [...this.adjustmentPreviews.keys()]) if (!byId.has(id)) this.adjustmentPreviews.delete(id);

    // Filters sample masks and clipping bases as whole textures, and screentone works in canvas
    // pixels: those stay resident. On-screen layers (and the one being edited) get their tiles on the GPU.
    // shortcut: every mask is resident (fine for a few masks), park masks of hidden cels if animations use many
    this.structuralPins.clear();
    for (let i = 0; i < drawable.length; i++) {
      const model = drawable[i];
      const item = this.layersMap.get(model.id)!;
      if (model.layerType === 'mask') this.structuralPins.add(model.id);
      if (item.shown && model.screentoneEnabled && !item.adjust) this.structuralPins.add(model.id);
      // An adjustment base is clipped to through its mask only (it has no pixels to keep resident)
      if (item.shown && model.clipToBelow && i > 0 && clipBaseOf(i).layerType !== 'adjustment') this.structuralPins.add(clipBaseOf(i).id);
    }
    let pendingThaw = 0;
    for (const item of this.layersMap.values()) {
      if (!item.rt && !item.gpu && !this.isPinned(item) && (item.shown || this.keepWarm(item))) {
        pendingThaw += item.cpu?.size ?? 0;
      }
    }
    for (const item of this.layersMap.values()) {
      if (this.isPinned(item)) this.makeResident(item);
      else if ((item.shown || this.keepWarm(item)) && !item.rt && !item.gpu) {
        if (pendingThaw > 256 || (item.cpu?.size ?? 0) > this.viewThawThreshold) this.stageColdLayer(item);
        else this.thaw(item);
      }
    }
    this.startProgressiveHydrate();

    for (const m of drawable) {
      const maskItem = m.layerType === 'mask' ? this.layersMap.get(m.id) : undefined;
      if (!maskItem) continue;
      maskItem.display.visible = true; // keeps the sprite's transform current for the filters that sample it
      maskItem.sprite.renderable = false;
      maskItem.display.filters = null;
    }

    for (let i = 0; i < drawable.length; i++) {
      const model = drawable[i];
      const item = this.layersMap.get(model.id);
      if (!item || model.layerType === 'mask') continue;
      item.sprite.renderable = true;
      item.sprite.mask = null;
      const masks = masksFor(model);
      const hasClip = Boolean(model.clipToBelow && i > 0);
      const used: Map<string, MaskFilter> | undefined = masks.length || hasClip ? new Map() : undefined;
      const maskFilter = (key: string, sprite: Sprite, opts: { inverse?: boolean; alpha?: boolean }) => {
        let f = item.maskFilters?.get(key);
        if (!f) f = new MaskFilter({ sprite, inverse: opts.inverse, channel: opts.alpha ? 'alpha' : 'red' });
        else if (f.sprite !== sprite) f.setSprite(sprite);
        f.inverse = Boolean(opts.inverse);
        used!.set(key, f);
        return f;
      };
      const maskFiltersOf = () =>
        masks.flatMap((m) => {
          const s = this.layersMap.get(m.id)?.sprite;
          return s ? [maskFilter(`mask:${m.id}`, s, { inverse: Boolean(m.meta?.maskInverted) })] : [];
        });

      // Adjustment layer: its quad through its own / group masks (the coverage), then the adjustment
      if (item.adjust) {
        const view = item.adjust;
        const adjustment = normalizeAdjustment(this.adjustmentPreviews.get(model.id) ?? model.meta?.adjustment);
        const compiled = adjustment ? compileAdjustment(adjustment) : null;
        const scope = resolveAdjustmentScope(sorted, model.id);
        const active = Boolean(compiled && !compiled.identity && scope.kind !== 'none');
        view.scope = scope;
        view.dependencyIds = active && (scope.kind === 'clip' || scope.kind === 'group') ? adjustmentDependencies(scope.memberIds) : [];
        if (active) {
          const key = `${JSON.stringify(adjustment)}|${model.blendMode}|${scope.kind}`;
          if (key !== view.paramsKey) {
            view.filter.setAdjustment(compiled!, model.blendMode, scope.kind !== 'root');
            view.paramsKey = key;
          }
          view.filter.scopeSprite = scope.kind === 'root' ? null : view.scopeSprite;
        } else {
          view.paramsKey = '';
        }
        if (!active || scope.kind === 'root') this.releaseAdjustmentScope(view);
        const maskList = active ? maskFiltersOf() : [];
        // Everything below is redrawn through this layer: masks at screen resolution, cut to the view
        for (const f of maskList) {
          f.resolution = 'inherit';
          f.clipToViewport = true;
        }
        if (item.maskFilters?.size) {
          for (const [key, f] of item.maskFilters) if (!used?.has(key)) f.destroy();
        }
        item.maskFilters = used;
        item.screentoneFilter = null;
        if (item.blendFilter) {
          item.blendFilter.filter.destroy();
          item.blendFilter = null;
        }
        if (item.display.blendMode !== 'normal') item.display.blendMode = 'normal';
        // Never draw the white quad without its filter
        item.display.renderable = active;
        const filters: Filter[] = active ? [...maskList, view.filter] : [];
        const prev = item.display.filters;
        if (!filters.length) {
          if (prev !== null) item.display.filters = null;
        } else if (!(prev && prev.length === filters.length && filters.every((f, idx) => prev[idx] === f))) {
          item.display.filters = filters;
        }
        continue;
      }

      // Clipping (不會塗出去): only where the base below shows, after the base's own mask
      const clip: Filter[] = [];
      if (hasClip) {
        const base = clipBaseOf(i);
        const baseItem = this.layersMap.get(base.id);
        if (baseItem?.adjust) {
          // Clipped onto an adjustment layer: it is opaque white where its own mask shows
          const own = maskOf.get(base.id);
          const ownSprite = own && this.layersMap.get(own.id)?.sprite;
          if (own && ownSprite) clip.push(maskFilter(`clipmask:${own.id}`, ownSprite, { inverse: Boolean(own.meta?.maskInverted) }));
        } else if (baseItem?.rt && base.layerType !== 'mask') {
          clip.push(maskFilter(`clip:${base.id}`, baseItem.sprite, { alpha: true }));
          const own = maskOf.get(base.id);
          const ownSprite = own && this.layersMap.get(own.id)?.sprite;
          if (own && ownSprite) clip.push(maskFilter(`clipmask:${own.id}`, ownSprite, { inverse: Boolean(own.meta?.maskInverted) }));
        }
      }

      // Comic screentone
      if (model.screentoneEnabled) {
        try {
          if (!item.screentoneFilter) {
            item.screentoneFilter = this.createScreentoneFilter(
              model.screentoneLpi ?? 40,
              ((model.screentoneAngle ?? 45) * Math.PI) / 180,
              model.screentoneDotScale ?? 1.0
            );
          }
        } catch (err) {
          console.warn('Screentone filter creation:', err);
          item.screentoneFilter = null;
        }
      } else {
        item.screentoneFilter = null;
      }

      // Colour follows screentone and precedes clip/masks; Layer Effects wrap around masked/clipped pixels before onion skin & blend.
      const hasAnyFilter = Boolean(item.screentoneFilter || item.layerColorFilter || clip.length || masks.length || item.layerEffectsFilter || item.onionFilter);
      const activeFilters: Filter[] = hasAnyFilter
        ? [
            ...(item.screentoneFilter ? [item.screentoneFilter] : []),
            ...(item.layerColorFilter ? [item.layerColorFilter] : []),
            ...clip,
            ...(masks.length ? maskFiltersOf() : []),
            ...(item.layerEffectsFilter ? [item.layerEffectsFilter] : []),
            ...(item.onionFilter ? [item.onionFilter] : []),
          ]
        : [];
      if (item.maskFilters?.size) {
        for (const [key, f] of item.maskFilters) if (!used?.has(key)) f.destroy();
      }
      item.maskFilters = used;

      // A container's blend mode is applied to its children, and with filters those are drawn into
      // the filters' own empty buffer first: multiply over transparent = black (蒙版＋色彩增值變黑).
      // So with filters the blend goes on the filters' output, as one more filter at the end.
      const mode = this.mapPixiBlendMode(model.blendMode);
      if (activeFilters.length > 0 && mode !== 'normal') {
        activeFilters.push(this.blendFilterFor(item, mode));
        if (item.display.blendMode !== 'normal') item.display.blendMode = 'normal';
      } else {
        if (item.blendFilter) {
          item.blendFilter.filter.destroy();
          item.blendFilter = null;
        }
        if (item.display.blendMode !== mode) item.display.blendMode = mode;
      }
      if (activeFilters.length > 0) {
        const prev = item.display.filters;
        const same = prev && prev.length === activeFilters.length && activeFilters.every((f, idx) => prev[idx] === f);
        if (!same) item.display.filters = activeFilters;
      } else if (item.display.filters !== null) {
        item.display.filters = null;
      }
    }
    this.onStageChange?.();
  }

  /** The last filter of a filtered layer: composites the filtered pixels with the layer's blend mode */
  private blendFilterFor(item: LayerItem, mode: string): Filter {
    if (item.blendFilter?.mode === mode) return item.blendFilter.filter;
    item.blendFilter?.filter.destroy();
    const filter = this.createBlendFilter(mode);
    item.blendFilter = { mode, filter };
    return filter;
  }

  /**
   * A filter that draws its input with blend mode `mode` (a mapPixiBlendMode result). Put it last in
   * a filter list instead of setting blendMode on something that has filters (merge-down does too).
   */
  public createBlendFilter(mode: string): Filter {
    const Advanced = ADVANCED_BLEND_FILTERS[mode];
    if (Advanced) return new Advanced(); // samples what is underneath, like Pixi's own advanced blend modes
    const filter = new AlphaFilter({ alpha: 1 }); // pass-through drawn with a GL blend (multiply, screen, add, erase)
    filter.blendMode = mode as Filter['blendMode'];
    return filter;
  }

  /* ---------- Adjustment layers (調整圖層) ---------- */

  /** Edit-dialog previews: parameters shown instead of the layer's own, on this screen only */
  private adjustmentPreviews = new Map<string, LayerAdjustment>();
  /** Adjustment layers bottom to top (their scope composites are refreshed in this order) */
  private adjustmentOrder: string[] = [];
  private lastSyncedLayers: LayerModel[] | null = null;

  private createAdjustmentView(item: LayerItem) {
    const quad = new Sprite(Texture.WHITE);
    quad.label = 'adjustment-quad';
    quad.width = this.canvasWidth;
    quad.height = this.canvasHeight;
    item.display.addChild(quad);
    item.adjust = {
      quad,
      filter: new AdjustmentFilter(),
      paramsKey: '',
      scope: { kind: 'root' },
      dependencyIds: [],
      scopeRT: null,
      scopeSprite: null,
      scopeKey: '',
      scopeMode: '',
    };
  }

  private releaseAdjustmentScope(view: AdjustmentView) {
    // Unbound first: a texture destroyed while bound to the shader warns (and may be sampled once more)
    view.filter.clearScope();
    if (view.scopeSprite) {
      view.scopeSprite.parent?.removeChild(view.scopeSprite);
      view.scopeSprite.destroy();
    }
    view.scopeRT?.destroy(true);
    view.scopeRT = null;
    view.scopeSprite = null;
    view.scopeKey = '';
    view.scopeMode = '';
  }

  /**
   * Shows `adjustment` instead of the layer's own parameters (the edit dialog's live preview, on
   * this screen only — nothing is saved or sent); null goes back to the layer's parameters.
   */
  public setAdjustmentPreview(layerId: string, adjustment: LayerAdjustment | null) {
    const normalized = adjustment ? normalizeAdjustment(adjustment) : null;
    if (normalized) this.adjustmentPreviews.set(layerId, normalized);
    else if (!this.adjustmentPreviews.delete(layerId)) return;
    const item = this.layersMap.get(layerId);
    if (!item?.adjust || !this.lastSyncedLayers) return;
    // Same scope, new parameters: only the filter changes (a slider drag stays cheap)
    const view = item.adjust;
    const shown = normalizeAdjustment(normalized ?? item.model.meta?.adjustment);
    const compiled = shown ? compileAdjustment(shown) : null;
    const active = Boolean(compiled && !compiled.identity && view.scope.kind !== 'none');
    if (active && view.paramsKey) {
      const key = `${JSON.stringify(shown)}|${item.model.blendMode}|${view.scope.kind}`;
      if (key !== view.paramsKey) {
        view.filter.setAdjustment(compiled!, item.model.blendMode, view.scope.kind !== 'root');
        view.paramsKey = key;
      }
      this.onStageChange?.();
      return;
    }
    this.syncLayers(this.lastSyncedLayers);
  }

  /** What a scope composite is drawn from, as one string (see adjustmentScopeIsFresh) */
  private adjustmentScopeFingerprint(view: AdjustmentView, drawing: boolean): string {
    const deps: ScopeDependencyState[] = [];
    for (const id of view.dependencyIds) {
      const dep = this.layersMap.get(id);
      if (!dep) continue;
      const d = dep.display;
      const extra = [
        dep.adjust ? `${dep.adjust.paramsKey}#${dep.adjust.scopeKey}` : '',
        dep.model.meta?.maskInverted ? 'inv' : '',
        (dep.model as LayerModel & { onionTint?: number }).onionTint ?? '',
        dep.model.screentoneEnabled ? `st${dep.model.screentoneLpi},${dep.model.screentoneAngle},${dep.model.screentoneDotScale}` : '',
        dep.layerColorKey ?? '',
        dep.layerEffectsKey ?? '',
        // A resident layer drawn on as a whole texture does not bump its version per dab
        drawing && id === this.activeId ? performance.now() : '',
      ].join(';');
      deps.push({
        id,
        version: dep.version,
        visible: d.visible,
        renderable: d.renderable,
        alpha: d.alpha,
        blendMode: dep.model.blendMode,
        clipToBelow: dep.model.clipToBelow,
        sortOrder: dep.model.sortOrder,
        updatedAt: dep.model.updatedAt,
        transform: [d.x, d.y, d.scale.x, d.scale.y, d.rotation, d.skew.x, d.skew.y],
        extra,
      });
    }
    return adjustmentScopeKey(view.scope.kind, deps);
  }

  /**
   * Renders the clip / group scope composites that are out of date, bottom to top (a nested
   * adjustment's own scope first). `full` = for a whole-canvas composite (readbacks, exports):
   * every tile, cold ones too; otherwise what the current view needs.
   */
  public updateAdjustmentScopes(full = false): boolean {
    if (full || this.adjustmentOrder.length > 0) this.deactivateStackCache();
    if (this.adjustmentOrder.length === 0) return false;
    const mode = full ? 'full' : `view:${this.lastViewGridKey}`;
    const drawing = this.isActivelyDrawing();
    let rendered = false;
    for (const id of this.adjustmentOrder) {
      const item = this.layersMap.get(id);
      const view = item?.adjust;
      if (!item || !view || !view.paramsKey || (view.scope.kind !== 'clip' && view.scope.kind !== 'group')) continue;
      if (!item.display.visible || !item.display.renderable) continue;
      const key = this.adjustmentScopeFingerprint(view, drawing);
      if (adjustmentScopeIsFresh(view.scopeKey, view.scopeMode, key, mode)) continue;
      this.renderAdjustmentScope(item, view, view.scope.memberIds, full);
      view.scopeKey = key;
      view.scopeMode = mode;
      rendered = true;
    }
    return rendered;
  }

  /** The scope's layers alone, on transparent, in canvas space (everything else is left out) */
  private renderAdjustmentScope(item: LayerItem, view: AdjustmentView, memberIds: readonly string[], full: boolean) {
    const resolution = adjustmentScopeRenderResolution(this.canvasWidth, this.canvasHeight);
    if (!view.scopeRT || view.scopeRT.source.resolution !== resolution) {
      this.releaseAdjustmentScope(view);
      view.scopeRT = RenderTexture.create({ width: this.canvasWidth, height: this.canvasHeight, resolution });
      const sprite = new Sprite(view.scopeRT);
      sprite.label = 'adjustment-scope';
      sprite.renderable = false; // only sampled by the filter
      item.display.addChild(sprite);
      view.scopeSprite = sprite;
    }
    view.filter.scopeSprite = view.scopeSprite;
    const members = new Set(memberIds);
    const left: Container[] = [];
    for (const other of this.layersMap.values()) {
      // Masks stay: their (unrendered) sprites are sampled by the members' mask filters
      if (other.model.layerType === 'mask' || members.has(other.model.id) || !other.display.renderable) continue;
      other.display.renderable = false;
      left.push(other.display);
    }
    const overlay = this.filterOverlaySprite;
    const overlayRenderable = overlay?.renderable ?? false;
    if (overlay) overlay.renderable = false;
    try {
      const draw = () => this.renderer.render({ container: this.layersContainer, target: view.scopeRT!, clear: true, clearColor: [0, 0, 0, 0] });
      if (full) this.withAllTilesVisible(draw, true);
      else draw();
    } finally {
      for (const d of left) d.renderable = true;
      if (overlay) overlay.renderable = overlayRenderable;
    }
  }

  /* ---------- Residency ---------- */

  /**
   * The layer being edited. It is not made resident (a 10000×8000 layer is 305 MB, twice with its
   * before-state): it stays sparse, the brush draws into its tiles, and it is never frozen to the CPU.
   */
  private magFilter: MagFilter = 'linear';
  /** Whether the canvas is zoomed in far enough to show sharp pixels (see setPixelated) */
  public get pixelated() {
    return this.magFilter === 'nearest';
  }
  /**
   * Zoomed in far (CSP / Krita): canvas pixels shown as sharp squares instead of bilinear blur.
   * Applies to the atlas pages (warm tiles, previews, masks) and resident layer textures.
   */
  public setPixelated(on: boolean) {
    const mode: MagFilter = on ? 'nearest' : 'linear';
    if (this.magFilter === mode) return;
    this.magFilter = mode;
    this.atlas.setMagFilter(mode);
    if (this.wrapRT) applyMagFilter(this.wrapRT, mode);
    for (const item of this.layersMap.values()) if (item.rt) applyMagFilter(item.rt, mode);
    this.onStageChange?.();
  }

  /**
   * Before a frame. Shown smaller than 1:1 (`scale`: screen pixels per canvas pixel), layer
   * textures are sampled from mip levels that average every canvas pixel under a screen pixel
   * (bilinear alone skips some, so thin lines turn jagged zoomed out). Only textures on screen get
   * levels; they are rebuilt after writes and freed a while after zooming back in.
   */
  public prepareView(scale: number) {
    this.updateAdjustmentScopes(false);
    // Bilinear already covers all texels cleanly near 100%; enabling trilinear mip level 1 between
    // 85% and 99% needlessly blurs crisp lineart, so only activate mipmaps below 85%.
    const useMips = this.mips.supported && scale < 0.85 && this.magFilter !== 'nearest';
    const fastMip = this.isActivelyDrawing(0) || performance.now() - this.lastLocalDrawAt < 160;
    if (this.sharpMipTimer) {
      clearTimeout(this.sharpMipTimer);
      this.sharpMipTimer = null;
    }
    if (useMips && fastMip) {
      this.sharpMipTimer = setTimeout(() => {
        this.sharpMipTimer = null;
        if (!this.destroyed) this.onStageChange?.();
      }, 180);
    } else if (!useMips) {
      this.mips.suspend();
      this.mips.releaseIdle(MIP_IDLE_MS);
    }
    this.syncStackCache(useMips, fastMip);
    if (useMips) {
      const live = [...this.layersMap.values()].filter((item) => item.shown && item.display.renderable);
      if (this.previewContainer.visible) live.push(this.preview);
      this.ensureViewMips(live, fastMip);
    }
  }

  private ensureViewMips(items: readonly LayerItem[], fastMip: boolean) {
    const pages = this.visiblePages;
    pages.clear();
    for (const item of items) {
      for (const tile of item.gpu?.values() ?? []) {
        if (tile.sprite.visible && this.isTileInView(tile.col, tile.row)) pages.add(tile.slot.page);
      }
      if (item.rt && item.sprite.parent === item.display && item.sprite.visible && item.display.visible) {
        const source = item.sprite.texture.source;
        this.mips.ensure(source, fullMipLevels(source.pixelWidth, source.pixelHeight), 0, fastMip);
      }
    }
    for (const rt of this.atlas.pageTextures(pages)) this.mips.ensure(rt.source, ATLAS_MIP_LEVELS, PITCH, fastMip);
  }

  private deactivateStackCache() {
    for (const display of this.stackHidden) display.renderable = true;
    this.stackHidden.length = 0;
    if (this.belowCacheSprite) this.belowCacheSprite.visible = false;
    if (this.aboveCacheSprite) this.aboveCacheSprite.visible = false;
    this.stackCache.activeId = null;
  }

  private releaseStackCache() {
    this.deactivateStackCache();
    this.belowCacheSprite?.destroy();
    this.aboveCacheSprite?.destroy();
    this.belowCacheRT?.destroy(true);
    this.aboveCacheRT?.destroy(true);
    this.belowCacheSprite = this.aboveCacheSprite = null;
    this.belowCacheRT = this.aboveCacheRT = null;
    this.stackCache.belowSig = this.stackCache.aboveSig = '';
  }

  public getStackCacheStats() {
    const cachedBelowCount = this.belowCacheSprite?.visible ? this.stackCache.belowIds.length : 0;
    const cachedAboveCount = this.aboveCacheSprite?.visible ? this.stackCache.aboveIds.length : 0;
    return {
      active: cachedBelowCount + cachedAboveCount > 0,
      cachedBelowCount, cachedAboveCount,
      hits: this.stackCache.hits, rebuilds: this.stackCache.rebuilds,
    };
  }

  private stackSegmentSignature(items: readonly LayerItem[]): string {
    return JSON.stringify(items.map((item) => {
      const d = item.display;
      const masks = Array.from(item.maskFilters?.keys() ?? [], (key) => {
        const dependency = this.layersMap.get(key.slice(key.indexOf(':') + 1));
        return [key, dependency?.version, dependency?.stackRevision, dependency?.sprite.texture.uid];
      });
      return [
        item.model.id, item.version, item.stackRevision, d.alpha, item.model.blendMode, d.visible,
        item.rt ? item.sprite.texture.uid : 0, item.gpu?.size ?? 0,
        d.x, d.y, d.scale.x, d.scale.y, d.rotation, d.skew.x, d.skew.y,
        d.filters?.length ? this.stackFilterRevision : 0, masks,
      ];
    }));
  }

  private syncStackCache(useMips: boolean, fastMip: boolean) {
    const active = this.activeId ? this.layersMap.get(this.activeId) : undefined;
    if (
      this.destroyed || this.wrapAroundEnabled || this.stackCacheSuspended || this.adjustmentOrder.length ||
      this.filterOverlaySprite || this.groupEffectContainers.size ||
      !active?.shown || active.adjust || active.display.parent !== this.layersContainer || active.model.clipToBelow ||
      this.rootContainer.getGlobalAlpha() !== 1 || this.rootContainer.getGlobalTint() !== 0xffffff
    ) return this.deactivateStackCache();

    const layers = [...this.layersMap.values()].filter((item) =>
      item.shown && item.display.visible && !item.adjust && item.display.parent === this.layersContainer);
    if (layers.length < 5) return this.deactivateStackCache();
    layers.sort((a, b) => a.display.zIndex - b.display.zIndex);
    const index = layers.indexOf(active);
    if (index < 0 || layers[index + 1]?.model.clipToBelow) return this.deactivateStackCache();
    const below = layers.slice(0, index);
    const above = layers.slice(index + 1);
    const canBake = (item: LayerItem) => !item.rt || item.ppClean;
    const hasBelow = below.length >= 2 && below.every(canBake);
    const hasAbove = above.length >= 2 && above.every((item) =>
      canBake(item) && item.model.blendMode === 'normal' && !item.maskFilters?.size);
    if (!hasBelow && !hasAbove) return this.deactivateStackCache();

    const { width: screenW, height: screenH } = this.renderer.screen;
    const resolution = this.renderer.resolution;
    // prepareView runs before Pixi has updated the render groups for this frame.
    const world = this.rootContainer.getGlobalTransform();
    const { a, b, c, d, tx, ty } = world;
    if (!screenW || !screenH || !Number.isFinite(a * d - b * c) || a * d === b * c) {
      return this.deactivateStackCache();
    }
    const viewKey = `${a},${b},${c},${d},${tx},${ty}:${screenW},${screenH},${resolution}`;
    const cache = this.stackCache;
    if (viewKey === this.stackFailedViewKey) return this.deactivateStackCache();
    if (viewKey !== cache.viewKey) {
      cache.viewKey = viewKey;
      this.deactivateStackCache();
      this.onStageChange?.();
      return;
    }

    const width = Math.max(1, Math.min(2560, Math.round(screenW * resolution)));
    const height = Math.max(1, Math.min(1600, Math.round(screenH * resolution)));
    if (width !== cache.width || height !== cache.height) this.releaseStackCache();
    cache.width = width;
    cache.height = height;
    cache.scaleX = width / screenW;
    cache.scaleY = height / screenH;

    const sampling = `${viewKey}:${useMips}:${this.magFilter}`;
    const belowSig = hasBelow
      ? `${sampling}:${this.lastBgColor}:${this.paperVisible}:${this.stackSegmentSignature(below)}` : '';
    const aboveSig = hasAbove ? `${sampling}:${this.stackSegmentSignature(above)}` : '';
    const rebuildBelow = hasBelow && (cache.belowSig !== belowSig || (useMips && !fastMip && !this.stackBelowSharp));
    const rebuildAbove = hasAbove && (cache.aboveSig !== aboveSig || (useMips && !fastMip && !this.stackAboveSharp));
    if (rebuildBelow || rebuildAbove || cache.activeId !== this.activeId ||
        hasBelow !== !!this.belowCacheSprite?.visible || hasAbove !== !!this.aboveCacheSprite?.visible) {
      this.deactivateStackCache();
      const transform = world.clone().scale(cache.scaleX, cache.scaleY);
      try {
        if (rebuildBelow) {
          if (useMips) this.ensureViewMips(below, fastMip);
          this.bakeStackSegment(below, true, transform);
          this.stackBelowSharp = !fastMip;
        }
        if (rebuildAbove) {
          if (useMips) this.ensureViewMips(above, fastMip);
          this.bakeStackSegment(above, false, transform);
          this.stackAboveSharp = !fastMip;
        }
      } catch (error) {
        this.stackFailedViewKey = viewKey;
        this.releaseStackCache();
        console.warn('[LayerManager] Viewport stack cache failed:', error);
        return;
      }

      const hide = (display: Container) => {
        if (!display.renderable) return;
        display.renderable = false;
        this.stackHidden.push(display);
      };
      if (hasBelow) {
        hide(this.backgroundGraphic);
        if (this.paperCheckerGraphic) hide(this.paperCheckerGraphic);
        for (const item of below) hide(item.display);
        this.belowCacheSprite!.visible = true;
      }
      if (hasAbove) {
        for (const item of above) hide(item.display);
        this.aboveCacheSprite!.visible = true;
      }
      cache.activeId = this.activeId;
      cache.belowIds = hasBelow ? below.map((item) => item.model.id) : [];
      cache.aboveIds = hasAbove ? above.map((item) => item.model.id) : [];
      cache.belowSig = belowSig;
      cache.aboveSig = aboveSig;
    }
    if (!rebuildBelow && !rebuildAbove) cache.hits++;
    cache.lastUsedMs = performance.now();
  }

  private bakeStackSegment(items: readonly LayerItem[], below: boolean, transform: Matrix) {
    let rt = below ? this.belowCacheRT : this.aboveCacheRT;
    let sprite = below ? this.belowCacheSprite : this.aboveCacheSprite;
    if (!rt || !sprite) {
      rt = RenderTexture.create({ width: this.stackCache.width, height: this.stackCache.height, resolution: 1 });
      sprite = new Sprite(rt);
      sprite.eventMode = 'none';
      sprite.visible = false;
      this.rootContainer.addChildAt(sprite, this.rootContainer.getChildIndex(this.layersContainer) + (below ? 0 : 1));
      if (below) {
        this.belowCacheRT = rt;
        this.belowCacheSprite = sprite;
      } else {
        this.aboveCacheRT = rt;
        this.aboveCacheSprite = sprite;
      }
    }
    const members = new Set(items.map((item) => item.display));
    const excluded = this.layersContainer.children.filter((display) => !members.has(display) && display.renderable);
    if (this.previewContainer.renderable) excluded.push(this.previewContainer);
    if (!below) {
      if (this.backgroundGraphic.renderable) excluded.push(this.backgroundGraphic);
      if (this.paperCheckerGraphic?.renderable) excluded.push(this.paperCheckerGraphic);
    }
    for (const display of excluded) display.renderable = false;
    try {
      this.renderer.render({ container: this.rootContainer, target: rt, clear: true, clearColor: [0, 0, 0, 0], transform });
      sprite.setFromMatrix(transform.clone().invert());
      this.stackCache.rebuilds++;
    } finally {
      for (const display of excluded) display.renderable = true;
    }
  }

  public setActiveLayer(layerId: string | null) {
    if (this.activeId !== layerId) this.deactivateStackCache();
    this.activeId = layerId;
    const item = layerId ? this.layersMap.get(layerId) : undefined;
    if (item && !item.rt && !item.gpu) this.stageColdLayer(item);
    if (item?.coldTiles.size) this.scheduleHydrate();
  }

  /** Keeps a layer resident for a reason ('transform', …) until pinned to null */
  public pin(reason: string, layerId: string | null) {
    this.pins.set(reason, layerId);
    const item = layerId ? this.layersMap.get(layerId) : undefined;
    if (item && !item.adjust) this.makeResident(item);
  }

  private isPinned(item: LayerItem) {
    if (this.structuralPins.has(item.model.id)) return true;
    for (const id of this.pins.values()) if (id === item.model.id) return true;
    return false;
  }

  private keepWarm(item: LayerItem) {
    // An adjustment layer is an empty warm layer for good: nothing to freeze, never resident
    return item.model.id === this.activeId || item.adjust !== null;
  }

  /** @internal Every outside read of a layer's texture: resident from now, possibly written */
  use(item: LayerItem): RenderTexture {
    this.flushPendingReads();
    item.lastUsed = performance.now();
    item.version++;
    if (!item.rt) {
      this.makeResident(item);
      // A tool is about to edit the whole texture: its before-state is the layer as of now (or the
      // backed-up tiles of an edit in progress, which makeResident turned into pp). Taken lazily
      // later, it would copy the tool's own edit and undo / cancel would change nothing.
      if (!item.pp && item.rt) item.pp = this.copyTexture(item.rt);
    }
    item.ppClean = false;
    if (item.ppReleased) {
      item.pp = this.copyTexture(item.rt!);
      item.ppReleased = false;
    }
    return item.rt!;
  }

  /* ---------- Sparse tiles ---------- */

  private tileSize(col: number, row: number) {
    return { w: Math.min(TS, this.canvasWidth - col * TS), h: Math.min(TS, this.canvasHeight - row * TS) };
  }

  /** A tile with the slot's pixels shown at its canvas position (pixels are written by the caller) */
  private isTileInView(col: number, row: number): boolean {
    if (!this.viewBounds) return true;
    const x0 = this.viewBounds.x0 - TS;
    const y0 = this.viewBounds.y0 - TS;
    const x1 = this.viewBounds.x1 + TS;
    const y1 = this.viewBounds.y1 + TS;
    return (col + 1) * TS >= x0 && col * TS <= x1 && (row + 1) * TS >= y0 && row * TS <= y1;
  }

  /**
   * Updates the active canvas viewport rectangle so offscreen layer tiles are culled from Pixi's
   * scene traversal and cold offscreen tiles reheat smoothly within a per-frame time budget.
   */
  public setViewportBounds(viewportBounds: LayerManager['viewBounds']) {
    this.viewportBounds = viewportBounds;
    const bounds = this.wrapAroundEnabled
      ? { x0: 0, y0: 0, x1: this.canvasWidth, y1: this.canvasHeight }
      : viewportBounds;
    this.viewBounds = bounds;
    const now = performance.now();
    this.lastInteractionAt = now;
    const c0 = bounds ? Math.max(0, Math.floor((bounds.x0 - TS) / TS)) : 0;
    const c1 = bounds ? Math.min(this.cols - 1, Math.floor((bounds.x1 + TS) / TS)) : this.cols - 1;
    const r0 = bounds ? Math.max(0, Math.floor((bounds.y0 - TS) / TS)) : 0;
    const r1 = bounds ? Math.min(this.rows - 1, Math.floor((bounds.y1 + TS) / TS)) : this.rows - 1;
    const gridKey = bounds ? `${c0},${r0},${c1},${r1}:${this.cullSuspended}:${this.tileStructureVersion}` : `all:${this.cullSuspended}:${this.tileStructureVersion}`;
    if (this.lastViewGridKey === gridKey) return;
    this.lastViewGridKey = gridKey;
    let anyColdInView = false;
    for (const item of this.layersMap.values()) {
      if (item.gpu) {
        for (const t of item.gpu.values()) {
          const inView = this.cullSuspended > 0 || !bounds || (t.col >= c0 && t.col <= c1 && t.row >= r0 && t.row <= r1);
          if (t.sprite.visible !== inView) t.sprite.visible = inView;
          if (inView) t.lastSeenMs = now;
        }
      }
      if (item.coldTiles.size > 0 && (item.shown || this.keepWarm(item))) {
        anyColdInView = true;
      }
    }
    if (anyColdInView) this.scheduleHydrate();
  }

  public getCanvasDimensions(): { width: number; height: number } {
    return { width: this.canvasWidth, height: this.canvasHeight };
  }

  public isWrapAroundEnabled(): boolean {
    return this.wrapAroundEnabled;
  }

  public setWrapAround(enabled: boolean): void {
    if (this.wrapAroundEnabled === enabled) return;
    this.deactivateStackCache();
    this.wrapAroundEnabled = enabled;
    if (!enabled) this.releaseWrapAroundView();
    this.lastViewGridKey = '';
    this.setViewportBounds(this.viewportBounds);
    this.onStageChange?.();
  }

  public getWrapAroundShapePreview(): Graphics | null {
    if (!this.wrapAroundEnabled) return null;
    if (!this.wrapShapeGraphic) {
      const overlay = new Container();
      const mask = new Graphics().rect(0, 0, this.canvasWidth, this.canvasHeight).fill(0xffffff);
      this.wrapShapeGraphic = overlay.addChild(new Graphics());
      overlay.addChild(mask);
      overlay.mask = mask;
      const index = this.wrapAroundContainer ? this.rootContainer.getChildIndex(this.wrapAroundContainer) : this.rootContainer.children.length;
      this.rootContainer.addChildAt(overlay, index);
      this.wrapShapeOverlay = overlay;
    }
    return this.wrapShapeGraphic;
  }

  public clearWrapAroundShapePreview(): void {
    this.wrapShapeGraphic?.clear();
  }

  public refreshWrapAroundView(): void {
    if (!this.wrapAroundEnabled) return;
    this.deactivateStackCache();
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    if (!this.wrapAroundContainer || !this.wrapRT) {
      const container = new Container();
      container.eventMode = 'none';
      const texture = RenderTexture.create({ width, height, resolution: 1 });
      applyMagFilter(texture, this.magFilter);
      for (let row = -1; row <= 1; row++) {
        for (let col = -1; col <= 1; col++) {
          if (row === 0 && col === 0) continue;
          const sprite = new Sprite(texture);
          sprite.position.set(col * width, row * height);
          container.addChild(sprite);
        }
      }

      const frame = new Graphics();
      const dash = Math.max(4, Math.max(width, height) / 600);
      for (let x = 0; x < width; x += dash * 2) {
        const end = Math.min(width, x + dash);
        frame.moveTo(x, 0).lineTo(end, 0).moveTo(x, height).lineTo(end, height);
      }
      for (let y = 0; y < height; y += dash * 2) {
        const end = Math.min(height, y + dash);
        frame.moveTo(0, y).lineTo(0, end).moveTo(width, y).lineTo(width, end);
      }
      frame.stroke({ color: 0x808080, alpha: 0.65, pixelLine: true });
      container.addChild(frame);
      this.wrapAroundContainer = this.rootContainer.addChild(container);
      this.wrapRT = texture;
    }

    // Exclude the repeats from the capture to avoid reading and writing the same texture.
    this.wrapAroundContainer.visible = false;
    try {
      this.renderer.render({ container: this.rootContainer, target: this.wrapRT, clear: true, clearColor: [0, 0, 0, 0] });
    } finally {
      this.wrapAroundContainer.visible = true;
    }
  }

  private releaseWrapAroundView(): void {
    this.wrapAroundContainer?.destroy({ children: true });
    this.wrapAroundContainer = null;
    this.wrapRT?.destroy(true);
    this.wrapRT = null;
    this.wrapShapeOverlay?.destroy({ children: true });
    this.wrapShapeOverlay = null;
    this.wrapShapeGraphic = null;
  }

  public startProgressiveHydrate() {
    if (this.destroyed) return;
    for (const item of this.layersMap.values()) {
      if (!item.rt && !item.gpu && (item.shown || this.keepWarm(item))) this.stageColdLayer(item);
    }
    this.scheduleHydrate();
  }

  private stageColdLayer(item: LayerItem) {
    // Transfer ownership of the compressed map without walking its entries.
    item.coldTiles = item.cpu ?? new Map();
    item.cpu = null;
    item.gpu = new Map();
    item.cleanCache.clear();
    this.rebuildDisplay(item);
  }

  private scheduleHydrate() {
    if (
      this.destroyed || this.hydrateInFlight || this.hydrateRaf || this.hydrateTimer !== null ||
      typeof requestAnimationFrame !== 'function'
    ) return;
    if (!this.deferHydrateWhileDrawing(this.pumpHydrate)) {
      this.hydrateRaf = requestAnimationFrame(this.pumpHydrate);
    }
  }

  private deferHydrateWhileDrawing(resume: FrameRequestCallback): boolean {
    if (!this.isActivelyDrawing(HYDRATE_DRAW_DELAY_MS)) return false;
    this.hydrateTimer = setTimeout(() => {
      this.hydrateTimer = null;
      this.hydrateRaf = requestAnimationFrame(resume);
    }, HYDRATE_DRAW_DELAY_MS);
    return true;
  }

  private collectHydrateBatch(): HydrateTile[] {
    const batch: HydrateTile[] = [];
    const items = [...this.layersMap.values()].filter((item) =>
      item.gpu && item.coldTiles.size && (item.shown || this.keepWarm(item)));
    const active = items.findIndex((item) => item.model.id === this.activeId);
    if (active > 0) items.unshift(...items.splice(active, 1));
    const bounds = this.viewBounds;
    for (const margin of bounds ? [0, TS] : [0]) {
      const c0 = bounds ? Math.max(0, Math.ceil((bounds.x0 - margin) / TS) - 1) : 0;
      const c1 = bounds ? Math.min(this.cols - 1, Math.floor((bounds.x1 + margin) / TS)) : this.cols - 1;
      const r0 = bounds ? Math.max(0, Math.ceil((bounds.y0 - margin) / TS) - 1) : 0;
      const r1 = bounds ? Math.min(this.rows - 1, Math.floor((bounds.y1 + margin) / TS)) : this.rows - 1;
      const area = Math.max(0, c1 - c0 + 1) * Math.max(0, r1 - r0 + 1);
      for (const item of items) {
        if (item.coldTiles.size <= area) {
          for (const [key, cpu] of item.coldTiles) {
            const [col, row] = key.split('_').map(Number);
            if (col < c0 || col > c1 || row < r0 || row > r1) continue;
            batch.push({ item, key, cpu, col, row });
            if (batch.length === HYDRATE_BATCH_SIZE) return batch;
          }
        } else {
          for (let row = r0; row <= r1; row++) {
            for (let col = c0; col <= c1; col++) {
              const key = keyOf(col, row);
              const cpu = item.coldTiles.get(key);
              if (!cpu) continue;
              batch.push({ item, key, cpu, col, row });
              if (batch.length === HYDRATE_BATCH_SIZE) return batch;
            }
          }
        }
      }
      if (batch.length) break;
    }
    return batch;
  }

  private pumpHydrate = () => {
    this.hydrateRaf = 0;
    if (this.destroyed || this.deferHydrateWhileDrawing(this.pumpHydrate)) return;
    const batch = this.collectHydrateBatch();
    if (!batch.length) return;
    const epoch = ++this.hydrateEpoch;
    const current = () => !this.destroyed && epoch === this.hydrateEpoch;
    this.hydrateInFlight = true;
    void decodeTiles(batch.map(({ cpu }) => cpu)).then((raws) => {
      let index = 0;
      const upload = () => {
        this.hydrateRaf = 0;
        if (!current() || this.deferHydrateWhileDrawing(upload)) return;
        const deadline = performance.now() + STEP_BUDGET_MS;
        let changed = false;
        do {
          const { item, key, cpu, col, row } = batch[index];
          const raw = raws[index++];
          if (
            item.destroyed || this.layersMap.get(item.model.id) !== item || !item.gpu ||
            (!item.shown && !this.keepWarm(item)) || !this.isTileInView(col, row) ||
            item.coldTiles.get(key) !== cpu
          ) continue;
          if (raw) {
            this.uploadColdTile(item, key, col, row, cpu, raw);
            changed = true;
          }
          item.coldTiles.delete(key);
        } while (index < batch.length && performance.now() < deadline);
        if (index < batch.length) {
          this.hydrateRaf = requestAnimationFrame(upload);
        } else {
          this.hydrateInFlight = false;
          this.scheduleHydrate();
        }
        if (changed || index === batch.length) this.onStageChange?.();
      };
      if (current()) this.hydrateRaf = requestAnimationFrame(upload);
    }).catch((error) => {
      if (current()) {
        this.hydrateInFlight = false;
        console.warn('[LayerManager] Cold tile decode failed:', error);
      }
    });
  };

  /** Restores an offscreen-evicted CPU tile back into its warm GPU atlas slot */
  private reheatTile(item: LayerItem, col: number, row: number): GpuTile | undefined {
    const key = keyOf(col, row);
    const existing = item.gpu?.get(key);
    if (existing) {
      existing.lastSeenMs = performance.now();
      return existing;
    }
    const cpu = item.coldTiles.get(key);
    if (!cpu) return undefined;
    const raw = decodeTile(cpu, SCRATCH);
    const tile = raw && !isEmpty(raw) ? this.uploadColdTile(item, key, col, row, cpu, raw) : undefined;
    item.coldTiles.delete(key);
    return tile;
  }

  private uploadColdTile(item: LayerItem, key: string, col: number, row: number, cpu: CpuTile, raw: Uint8Array) {
    const { w, h } = this.tileSize(col, row);
    const tile = this.addTile(item, col, row, cpu.w < w || cpu.h < h);
    this.atlas.writePixels(tile.slot, raw, 0, 0, cpu.w, cpu.h, w, h);
    if (cpu.w === w && cpu.h === h) item.cleanCache.set(key, cpu);
    item.stackRevision++;
    this.lruReheatHits++;
    return tile;
  }

  /**
   * Temporarily unhides all tile sprites (and optionally rehears visible layers' coldTiles within
   * safety limits) for full-canvas composites, flood-fills, or exports.
   */
  private withAllTilesVisible<T>(fn: () => T, includeColdTiles = false): T {
    this.deactivateStackCache();
    this.stackCacheSuspended++;
    try {
      return this.renderWithAllTilesVisible(fn, includeColdTiles);
    } finally {
      this.stackCacheSuspended--;
    }
  }

  private renderWithAllTilesVisible<T>(fn: () => T, includeColdTiles: boolean): T {
    this.cullSuspended++;
    const tempCold: Array<{ item: LayerItem; key: string; cpu: CpuTile; tile: GpuTile }> = [];
    for (const item of this.layersMap.values()) {
      if (item.gpu) {
        for (const t of item.gpu.values()) {
          if (!t.sprite.visible) t.sprite.visible = true;
        }
      }
    }
    if (includeColdTiles) {
      let totalCold = 0;
      for (const item of this.layersMap.values()) {
        if (item.shown || item.model.layerType === 'mask') totalCold += item.coldTiles.size;
      }
      // Cap synchronous GPU cold reheat during composite/export so atlas stays under WebGL memory limits
      if (totalCold > 0 && totalCold <= FULL_COMPOSITE_COLD_LIMIT) {
        for (const item of this.layersMap.values()) {
          if (!item.shown && item.model.layerType !== 'mask') continue;
          for (const [key, cpu] of [...item.coldTiles]) {
            const [col, row] = key.split('_').map(Number);
            const tile = this.reheatTile(item, col, row);
            if (tile) tempCold.push({ item, key, cpu, tile });
          }
        }
      }
    }
    const repeats = this.wrapAroundContainer;
    const shapeOverlay = this.wrapShapeOverlay;
    const checker = this.paperCheckerGraphic;
    const repeatsVisible = repeats?.visible ?? false;
    const shapeVisible = shapeOverlay?.visible ?? false;
    const checkerVisible = checker?.visible ?? false;
    if (repeats) repeats.visible = false;
    if (shapeOverlay) shapeOverlay.visible = false;
    if (checker) checker.visible = false;
    try {
      return fn();
    } finally {
      if (repeats) repeats.visible = repeatsVisible;
      if (shapeOverlay) shapeOverlay.visible = shapeVisible;
      if (checker) checker.visible = checkerVisible;
      for (let i = tempCold.length - 1; i >= 0; i--) {
        const { item, key, cpu, tile } = tempCold[i];
        if (item.gpu?.get(key) === tile) {
          item.cleanCache.delete(key);
          item.coldTiles.set(key, cpu);
          this.freeTile(tile);
          item.gpu.delete(key);
        }
      }
      this.cullSuspended = Math.max(0, this.cullSuspended - 1);
      if (this.cullSuspended === 0 && this.viewBounds) {
        for (const item of this.layersMap.values()) {
          if (!item.gpu) continue;
          for (const t of item.gpu.values()) {
            t.sprite.visible = this.isTileInView(t.col, t.row);
          }
        }
      }
    }
  }

  private makeTile(item: LayerItem, col: number, row: number, slot?: Slot): GpuTile {
    this.tileStructureVersion++;
    const { w, h } = this.tileSize(col, row);
    const s = slot ?? this.atlas.alloc(item.lastPage >= 0 ? [item.lastPage] : undefined);
    item.lastPage = s.page;
    const sprite = new Sprite(this.atlas.view(s, w, h));
    sprite.position.set(col * TS, row * TS);
    sprite.label = TILE_LABEL;
    sprite.cullable = true;
    sprite.visible = this.cullSuspended > 0 || !this.viewBounds || this.isTileInView(col, row);
    return { col, row, slot: s, sprite, w, h, lastSeenMs: performance.now() };
  }

  private freeTile(t: GpuTile) {
    this.tileStructureVersion++;
    this.flushPendingReads();
    t.sprite.texture.destroy(false);
    t.sprite.destroy();
    this.atlas.free(t.slot);
  }

  /** A new, transparent tile in a warm layer, shown below any previews in its display */
  private addTile(item: LayerItem, col: number, row: number, clear = true): GpuTile {
    const t = this.makeTile(item, col, row);
    if (clear) this.atlas.writePixels(t.slot, null, 0, 0, t.w, t.h, t.w, t.h);
    item.gpu!.set(keyOf(col, row), t);
    item.display.addChildAt(t.sprite, 0);
    return t;
  }

  /** Something is about to change a warm layer's pixels */
  private touch(item: LayerItem) {
    item.version++;
    item.lastUsed = performance.now();
    item.cpu = null; // the compressed copy (if any) is no longer the layer
  }

  /** Copy-on-first-write: the tile's pixels before this edit, kept until the next sync */
  private backup(item: LayerItem, key: string, tile: GpuTile | undefined) {
    if (item === this.preview) return;
    const bak = item.bak ?? (item.bak = new Map());
    if (bak.has(key)) return;
    const bakClean = item.bakClean ?? (item.bakClean = new Map());
    if (!tile) {
      bak.set(key, null);
      bakClean.set(key, null);
      return;
    }
    const s = this.atlas.alloc([tile.slot.page]);
    this.atlas.copy(tile.slot, s);
    bak.set(key, s);
    const clean = item.cleanCache.get(key);
    if (clean) bakClean.set(key, clean);
  }

  private dropBackups(item: LayerItem) {
    const bak = item.bak;
    item.bak = null;
    item.bakClean = null;
    if (!bak?.size) return;
    const id = item.model.id;
    const hold = !this.destroyed && (this.pendingBakReads.get(id) ?? 0) > 0;
    let held = hold ? this.heldBakSlots.get(id) : undefined;
    if (hold && !held) {
      held = new Set();
      this.heldBakSlots.set(id, held);
    }
    for (const s of bak.values()) {
      if (!s) continue;
      if (held) held.add(s);
      else this.atlas.free(s);
    }
  }

  /** Back to the before-state: the backed-up slots become the tiles again, tiles new since then go */
  private restoreBackups(item: LayerItem) {
    const bak = item.bak;
    const bakClean = item.bakClean;
    item.bak = null;
    item.bakClean = null;
    if (!bak?.size) return;
    this.flushPendingReads();
    item.version++;
    const gpu = item.gpu ?? (item.gpu = new Map());
    for (const [key, s] of bak) {
      item.cleanCache.delete(key);
      const t = gpu.get(key);
      if (!s) {
        if (t) {
          this.freeTile(t);
          gpu.delete(key);
        }
        continue;
      }
      if (t) {
        this.atlas.free(t.slot);
        t.slot = s;
        t.sprite.texture.destroy(false);
        t.sprite.texture = this.atlas.view(s, t.w, t.h);
      } else {
        const [col, row] = key.split('_').map(Number);
        const nt = this.makeTile(item, col, row, s);
        gpu.set(key, nt);
        item.display.addChildAt(nt.sprite, 0);
      }
      const clean = bakClean?.get(key);
      if (clean) item.cleanCache.set(key, clean);
    }
  }

  private acquireAfterSlots(layerId: string, slots: Iterable<Slot>) {
    let map = this.pendingAfterSlots.get(layerId);
    if (!map) {
      map = new Map();
      this.pendingAfterSlots.set(layerId, map);
    }
    for (const s of slots) map.set(s, (map.get(s) ?? 0) + 1);
  }

  private releaseAfterSlots(layerId: string, slots: Iterable<Slot>) {
    const map = this.pendingAfterSlots.get(layerId);
    const held = this.heldAfterSlots.get(layerId);
    for (const s of slots) {
      if (map) {
        const next = (map.get(s) ?? 1) - 1;
        if (next <= 0) {
          map.delete(s);
          if (held?.delete(s) && !this.destroyed) this.atlas.free(s);
        } else {
          map.set(s, next);
        }
      } else if (held?.delete(s) && !this.destroyed) {
        this.atlas.free(s);
      }
    }
    if (map && map.size === 0) this.pendingAfterSlots.delete(layerId);
    if (held && held.size === 0) this.heldAfterSlots.delete(layerId);
  }

  /** Detach a live tile slot before mutating it when a pending GPU read still references it */
  private detachIfPendingAfter(item: LayerItem, t: GpuTile) {
    const id = item.model.id;
    const pending = this.pendingAfterSlots.get(id);
    if (!pending?.has(t.slot)) return;
    const oldSlot = t.slot;
    const fresh = this.atlas.alloc([oldSlot.page]);
    this.atlas.copy(oldSlot, fresh);
    let held = this.heldAfterSlots.get(id);
    if (!held) {
      held = new Set();
      this.heldAfterSlots.set(id, held);
    }
    held.add(oldSlot);
    t.slot = fresh;
    t.sprite.texture.destroy(false);
    t.sprite.texture = this.atlas.view(fresh, t.w, t.h);
  }

  /**
   * Draws `container` (canvas coordinates) onto a sparse layer: into every tile its box (x, y, w, h)
   * covers, making tiles where there were none. Each tile is backed up the first time.
   */
  private drawSparse(item: LayerItem, container: Container, x: number, y: number, w: number, h: number,
    ink?: StrokeInk, regions?: readonly Rect[],
  ) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.canvasWidth, Math.ceil(x + w));
    const y1 = Math.min(this.canvasHeight, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const gpu = item.gpu ?? (item.gpu = new Map());
    this.touch(item);
    // A gutter's width more on each side: a tile's gutter mirrors its neighbour's edge
    const c0 = Math.max(0, Math.floor((x0 - GUTTER) / TS));
    const c1 = Math.min(this.cols - 1, Math.floor((x1 + GUTTER - 1) / TS));
    const r0 = Math.max(0, Math.floor((y0 - GUTTER) / TS));
    const r1 = Math.min(this.rows - 1, Math.floor((y1 + GUTTER - 1) / TS));
    const covered = regions && new Map<number, boolean>();
    if (covered) {
      for (const rect of regions!) {
        const left = Math.max(0, Math.floor(rect.x));
        const top = Math.max(0, Math.floor(rect.y));
        const right = Math.min(this.canvasWidth, Math.ceil(rect.x + rect.w));
        const bottom = Math.min(this.canvasHeight, Math.ceil(rect.y + rect.h));
        if (left >= right || top >= bottom) continue;
        for (let r = Math.max(r0, Math.floor((top - GUTTER) / TS)); r <= Math.min(r1, Math.floor((bottom + GUTTER - 1) / TS)); r++) {
          for (let c = Math.max(c0, Math.floor((left - GUTTER) / TS)); c <= Math.min(c1, Math.floor((right + GUTTER - 1) / TS)); c++) {
            const tile = r * this.cols + c;
            const overlaps = left < (c + 1) * TS && right > c * TS && top < (r + 1) * TS && bottom > r * TS;
            covered.set(tile, covered.get(tile) || overlaps);
          }
        }
      }
    }
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const coveredTile = covered?.get(row * this.cols + col);
        if (covered && coveredTile === undefined) continue;
        const tx = col * TS;
        const ty = row * TS;
        const overlaps = coveredTile ?? (x0 < tx + TS && x1 > tx && y0 < ty + TS && y1 > ty);
        const key = keyOf(col, row);
        let t = gpu.get(key);
        if (!t && item.coldTiles.has(key) && overlaps) {
          t = this.reheatTile(item, col, row);
        }
        if (!t) {
          if (!overlaps) continue; // only its gutter: no tile for that
          this.backup(item, key, undefined);
          t = this.addTile(item, col, row);
        } else {
          if (item !== this.preview) this.detachIfPendingAfter(item, t);
          this.backup(item, key, t);
        }
        t.lastSeenMs = performance.now();
        item.cleanCache.delete(key);
        this.atlas.draw(t.slot, container, tx, ty);
        if (ink) this.drawStrokeInk(ink, container, col, row);
      }
    }
    if (item.shown || item === this.preview) this.onStageChange?.();
  }

  /**
   * Where a brush draws on this layer: its whole texture if it is resident (or `whole` is asked:
   * a mixer brush reading under the dabs, a selection mask), otherwise tile by tile.
   */
  public drawTarget(layerId: string, opts?: { whole?: boolean; ink?: StrokeInk }): BrushTarget | null {
    const item = this.layersMap.get(layerId);
    // Adjustment layers have no pixels to draw on (their mask layer does)
    if (!item || item.adjust) return null;
    this.lastLocalDrawAt = performance.now();
    const ink = opts?.ink;
    if (item.rt || opts?.whole) {
      const target = this.use(item);
      if (!ink) return target;
      return {
        draw: (container, x, y, w, h) => {
          this.renderer.render({ container, target, clear: false });
          for (let row = Math.max(0, Math.floor(y / TS)); row <= Math.min(this.rows - 1, Math.ceil((y + h) / TS) - 1); row++) {
            for (let col = Math.max(0, Math.floor(x / TS)); col <= Math.min(this.cols - 1, Math.ceil((x + w) / TS) - 1); col++) {
              this.drawStrokeInk(ink, container, col, row);
            }
          }
        },
      };
    }
    if (!item.gpu) this.thaw(item);
    return {
      draw: (c, x, y, w, h, regions) => {
        this.lastLocalDrawAt = performance.now();
        this.drawSparse(item, c, x, y, w, h, ink, regions);
      },
    };
  }

  /** Rasterize the same batch over transparency, including coverage that a tile diff cannot see. */
  private drawStrokeInk(ink: StrokeInk, container: Container, col: number, row: number) {
    const key = keyOf(col, row);
    let tile = ink.get(key);
    if (!tile) {
      const slot = this.atlas.alloc();
      this.atlas.writePixels(slot, null, 0, 0, TS, TS);
      tile = { col, row, slot };
      ink.set(key, tile);
    }
    this.atlas.draw(tile.slot, container, col * TS, row * TS);
  }

  public releaseStrokeInk(ink: StrokeInk) {
    for (const { slot } of ink.values()) this.atlas.free(slot);
    ink.clear();
  }

  public async readStrokeInk(ink: StrokeInk): Promise<TileData[]> {
    const reader = this.reader;
    try {
      if (!reader) return [];
      const pages = new Map<RenderTexture, Array<{ col: number; row: number; rect: Rect }>>();
      for (const { col, row, slot } of ink.values()) {
        const rt = this.atlas.texture(slot);
        const { w, h } = this.tileSize(col, row);
        const group = pages.get(rt) ?? [];
        group.push({ col, row, rect: { x: slot.x, y: slot.y, w, h } });
        pages.set(rt, group);
      }
      const tiles = await Promise.all([...pages].map(async ([rt, group]) => {
        const pixels = await reader(rt, group.map(tile => tile.rect));
        return group.flatMap(({ col, row, rect }, index): TileData[] => {
          const data = pixels[index];
          return data.some(Boolean)
            ? [{ col, row, width: rect.w, height: rect.h, data, compression: 'raw', byteLength: data.byteLength }]
            : [];
        });
      }));
      return tiles.flat();
    } finally {
      this.releaseStrokeInk(ink);
    }
  }

  /**
   * Reads rectangles of a layer without making it resident or stalling (the copies are queued
   * with the drawing: they hold the pixels as of this call). `before` reads the pre-edit state.
   */
  public readAsync(layerId: string, rects: Rect[], which: 'after' | 'before' = 'after'): Promise<Uint8Array[]> {
    const item = this.layersMap.get(layerId);
    const reader = this.reader;
    if (!item || !reader) return Promise.resolve(rects.map((r) => new Uint8Array(Math.max(0, r.w * r.h * 4))));
    if (item.rt) {
      const tex = which === 'before' ? item.pingPongTexture : item.rt;
      this.pendingReadCount++;
      return reader(tex, rects).finally(() => {
        this.pendingReadCount = Math.max(0, this.pendingReadCount - 1);
      });
    }
    return this.readTiles(item, rects, which, reader);
  }

  private readTiles(item: LayerItem, rects: Rect[], which: 'after' | 'before', reader: RegionReader): Promise<Uint8Array[]> {
    const out: Uint8Array[] = rects.map((r) => new Uint8Array(Math.max(0, r.w * r.h * 4)));
    const groups = new Map<RenderTexture, Array<{ ri: number; dx: number; dy: number; rect: Rect }>>();
    const liveSlots = new Set<Slot>();
    let readsBackup = false;
    rects.forEach((r, ri) => {
      if (r.w <= 0 || r.h <= 0) return;
      for (let row = Math.max(0, Math.floor(r.y / TS)); row <= Math.min(this.rows - 1, Math.floor((r.y + r.h - 1) / TS)); row++) {
        for (let col = Math.max(0, Math.floor(r.x / TS)); col <= Math.min(this.cols - 1, Math.floor((r.x + r.w - 1) / TS)); col++) {
          const key = keyOf(col, row);
          const hasBak = which === 'before' && item.bak?.has(key);
           const clean = which === 'before' ? (hasBak ? item.bakClean?.get(key) : item.cleanCache.get(key)) : undefined;
           const slot = clean ? null : hasBak ? item.bak!.get(key) : item.gpu?.get(key)?.slot;
          const tx = col * TS;
          const ty = row * TS;
          const ix0 = Math.max(r.x, tx);
          const iy0 = Math.max(r.y, ty);
          const ix1 = Math.min(r.x + r.w, tx + TS);
          const iy1 = Math.min(r.y + r.h, ty + TS);
          if (!slot) {
             const cold = hasBak ? clean : clean ?? item.coldTiles.get(key) ?? (!item.gpu ? item.cpu?.get(key) : undefined);
            if (!cold) continue;
            const src = decodeTile(cold);
            if (!src) continue;
             const sw = Math.min(ix1, tx + cold.w) - ix0;
             const sh = Math.min(iy1, ty + cold.h) - iy0;
             if (sw <= 0 || sh <= 0) continue;
            const dst = out[ri];
             if (ix0 === tx && iy0 === ty && ix0 === r.x && iy0 === r.y &&
                 sw === r.w && sh === r.h && r.w === cold.w && r.h === cold.h) {
               dst.set(src.subarray(0, dst.length));
            } else {
              for (let y = 0; y < sh; y++) {
                const srcOff = ((iy0 - ty + y) * cold.w + (ix0 - tx)) * 4;
                dst.set(src.subarray(srcOff, srcOff + sw * 4), ((iy0 - r.y + y) * r.w + (ix0 - r.x)) * 4);
              }
            }
            continue;
          }
          if (hasBak) readsBackup = true;
          else liveSlots.add(slot);
          const tex = this.atlas.texture(slot);
          const list = groups.get(tex) ?? [];
          list.push({ ri, dx: ix0 - r.x, dy: iy0 - r.y, rect: { x: slot.x + ix0 - tx, y: slot.y + iy0 - ty, w: ix1 - ix0, h: iy1 - iy0 } });
          groups.set(tex, list);
        }
      }
    });
    if (groups.size === 0) return Promise.resolve(out);
    const id = item.model.id;
    this.pendingReadCount++;
    if (readsBackup) {
      this.pendingBakReads.set(id, (this.pendingBakReads.get(id) ?? 0) + 1);
    }
    if (liveSlots.size > 0) this.acquireAfterSlots(id, liveSlots);
    // Every read is queued now (before anything frees or reuses these slots), then awaited
    const reads = [...groups].map(([tex, parts]) => reader(tex, parts.map((p) => p.rect)).then((pxs) => ({ parts, pxs })));
    return Promise.all(reads).then((results) => {
      for (const { parts, pxs } of results) {
        parts.forEach((p, i) => {
          const rw = rects[p.ri].w;
          const src = pxs[i];
          // A whole tile read for a whole-tile rect (commits): the read buffer is the answer, no copy
          if (p.dx === 0 && p.dy === 0 && p.rect.w === rw && p.rect.h === rects[p.ri].h) {
            out[p.ri] = src;
            return;
          }
          const dst = out[p.ri];
          for (let y = 0; y < p.rect.h; y++) {
            dst.set(src.subarray(y * p.rect.w * 4, (y + 1) * p.rect.w * 4), ((p.dy + y) * rw + p.dx) * 4);
          }
        });
      }
      return out;
    }).finally(() => {
      this.pendingReadCount = Math.max(0, this.pendingReadCount - 1);
      if (readsBackup) {
        const left = (this.pendingBakReads.get(id) ?? 1) - 1;
        if (left <= 0) {
          this.pendingBakReads.delete(id);
          const held = this.heldBakSlots.get(id);
          if (held) {
            this.heldBakSlots.delete(id);
            if (!this.destroyed) {
              for (const s of held) this.atlas.free(s);
            }
          }
        } else {
          this.pendingBakReads.set(id, left);
        }
      }
      if (liveSlots.size > 0) this.releaseAfterSlots(id, liveSlots);
    });
  }

  /**
   * Actual writes since the last sync, including mirrored and expanded brush tips.
   * A resident layer requires the caller's geometric bounds.
   */
  public editedSparseTiles(layerId: string): TileCoord[] | null {
    const item = this.layersMap.get(layerId);
    if (!item || item.rt) return null;
    return Array.from(item.bak?.keys() ?? [], (key) => {
      const [col, row] = key.split('_').map(Number);
      return { col, row };
    });
  }

  /**
   * The tiles a layer may have pixels in: a sparse layer knows them (warm slots / cold tiles); a
   * resident one does not (null: use every tile). Whole-layer copies read only these.
   */
  public occupiedTiles(layerId: string): TileCoord[] | null {
    const item = this.layersMap.get(layerId);
    if (!item || item.rt) return null;
    const keySet = new Set<string>();
    if (item.gpu) {
      for (const k of item.gpu.keys()) keySet.add(k);
    } else if (item.cpu) {
      for (const k of item.cpu.keys()) keySet.add(k);
    }
    for (const k of item.coldTiles.keys()) keySet.add(k);
    return [...keySet].map((k) => {
      const [col, row] = k.split('_').map(Number);
      return { col, row };
    });
  }

  /** True only when an unchanged CPU snapshot proves the current tile still matches. */
  public matchesCachedTile(layerId: string, tile: TileData): boolean {
    const item = this.layersMap.get(layerId);
    if (!item || item.rt) return false;
    const key = keyOf(tile.col, tile.row);
    if (item.bak?.has(key)) return false;
    const cached = item.gpu
      ? item.cleanCache.get(key) ?? item.coldTiles.get(key)
      : item.cpu?.get(key);
    if (!cached || cached.w !== tile.width || cached.h !== tile.height || cached.compression !== tile.compression) return false;
    const bytes = normalizeTileBytes(tile.data);
    return cached.data.length === bytes.length && cached.data.every((value, index) => value === bytes[index]);
  }

  public takeBackupCleanTiles(layerId: string, coords: TileCoord[]): { cached: Map<string, TileData>; missing: TileCoord[] } {
    const cached = new Map<string, TileData>();
    const item = this.layersMap.get(layerId);
    if (!item || item.rt) return { cached, missing: coords };
    const missing: TileCoord[] = [];
    for (const { col, row } of coords) {
      if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= this.cols || row >= this.rows) continue;
      const key = keyOf(col, row);
      let clean = item.bakClean?.get(key);
      if (clean === undefined && !item.bak?.has(key)) {
        clean = item.cleanCache.get(key) ?? item.coldTiles.get(key);
        if (clean === undefined && !item.gpu?.has(key) && !item.cpu?.has(key)) clean = null;
      }
      if (clean === undefined) {
        missing.push({ col, row });
      } else if (clean === null) {
        const { w, h } = this.tileSize(col, row);
        const { data, compression } = getEmptyLz4Tile(w, h);
        cached.set(key, { col, row, width: w, height: h, data, compression, byteLength: data.byteLength });
      } else {
        const { data, compression, w, h } = clean;
        cached.set(key, { col, row, width: w, height: h, data, compression, byteLength: data.byteLength });
      }
    }
    return { cached, missing };
  }

  public getLayerVersion(layerId: string): number {
    return this.layersMap.get(layerId)?.version ?? 0;
  }

  public recordCleanTiles(layerId: string, tiles: TileData[], expectedVersion?: number): void {
    const item = this.layersMap.get(layerId);
    if (!item || item.destroyed || item.rt || !item.gpu) return;
    if (expectedVersion !== undefined && item.version !== expectedVersion) return;
    for (const t of tiles) {
      if (t.compression !== 'lz4' || t.width <= 0 || t.height <= 0) continue;
      const key = keyOf(t.col, t.row);
      const live = item.gpu.get(key);
      if (!live || live.w !== t.width || live.h !== t.height || item.bak?.has(key)) continue;
      item.cleanCache.set(key, { data: normalizeTileBytes(t.data), compression: 'lz4', w: t.width, h: t.height });
    }
  }

  /** Raw tiles (premultiplied) of a layer, read without stalling; `before` = as of the last sync */
  public readTilesAsync(layerId: string, coords: TileCoord[], which: 'after' | 'before' = 'after'): Promise<TileData[]> {
    const sizes = coords.map((c) => (c.col >= 0 && c.row >= 0 && c.col < this.cols && c.row < this.rows ? this.tileSize(c.col, c.row) : { w: 0, h: 0 }));
    const rects = coords.map((c, i) => ({ x: c.col * TS, y: c.row * TS, w: sizes[i].w, h: sizes[i].h }));
    const item = this.layersMap.get(layerId);
    const version = item?.version;
    const writingBack = which === 'after' && this.reader && item?.gpu && item.bak?.size && coords.length <= HYDRATE_BATCH_SIZE;
    return this.readAsync(layerId, rects, which).then((pxs) => {
      const tiles = coords.map((c, i) => ({
        col: c.col, row: c.row, width: sizes[i].w, height: sizes[i].h,
        compression: 'raw' as const, data: pxs[i], byteLength: pxs[i].byteLength,
      }));
      if (writingBack && !this.cleanWritebackInFlight && item.version === version && !item.bak && !item.destroyed) {
        // The caller owns the returned buffers and may transfer them to its commit worker.
        const copy = tiles.filter((t) => item.gpu?.has(keyOf(t.col, t.row)) && !item.cleanCache.has(keyOf(t.col, t.row)))
          .map((t) => ({ ...t, data: t.data.slice() }));
        if (copy.length) {
          this.cleanWritebackInFlight = true;
          void compressTiles(copy).then((compressed) => {
            if (this.layersMap.get(layerId) === item) this.recordCleanTiles(layerId, compressed, version);
          }).catch((error) => {
            console.warn('[LayerManager] Clean tile writeback failed:', error);
          }).finally(() => { this.cleanWritebackInFlight = false; });
        }
      }
      return tiles;
    });
  }

  /**
   * Synchronously reads a single untouched or live tile (used once per tile to cache clean
   * snapshots without making huge sparse layers resident). Returns null when tile is empty.
   */
  public readTileSync(layerId: string, col: number, row: number, which: 'after' | 'before' = 'before'): Uint8Array | null {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    const item = this.layersMap.get(layerId);
    if (!item) return null;
    const { w, h } = this.tileSize(col, row);
    if (item.rt) {
      const tex = which === 'before' && item.pingPongTexture ? item.pingPongTexture : item.rt;
      return this.read(tex, col * TS, row * TS, w, h);
    }
    const key = keyOf(col, row);
    const hasBak = which === 'before' && item.bak?.has(key);
    const clean = which === 'before' ? (hasBak ? item.bakClean?.get(key) : item.cleanCache.get(key)) : undefined;
    if (clean) return decodeTile(clean)?.slice() ?? null;
    const slot = hasBak ? item.bak!.get(key) : item.gpu?.get(key)?.slot;
    if (!slot) {
      if (hasBak) return null;
      const cold = item.coldTiles.get(key) ?? (!item.gpu ? item.cpu?.get(key) : undefined);
      if (!cold) return null;
      const raw = decodeTile(cold);
      if (!raw) return null;
      if (cold.w === w && cold.h === h) return raw.slice(0, w * h * 4);
      const out = new Uint8Array(w * h * 4);
      const copyBytes = Math.min(cold.w, w) * 4;
      for (let y = 0; y < Math.min(cold.h, h); y++) {
        const src = y * cold.w * 4;
        out.set(raw.subarray(src, src + copyBytes), y * w * 4);
      }
      return out;
    }
    return this.read(this.atlas.texture(slot), slot.x, slot.y, w, h);
  }

  /** Replaces a rectangle of a layer with premultiplied RGBA (no blending), whichever form it is in */
  public writeRegion(layerId: string, x: number, y: number, w: number, h: number, px: Uint8Array) {
    const item = this.layersMap.get(layerId);
    if (item && !item.adjust) this.writeInto(item, x, y, w, h, px);
  }

  private writeInto(item: LayerItem, x: number, y: number, w: number, h: number, px: Uint8Array | null) {
    if (w <= 0 || h <= 0) return;
    if (item.rt && item !== this.preview) {
      this.upload(this.use(item), [{ x, y, w, h, raw: px ?? new Uint8Array(w * h * 4) }]);
      if (item.shown) this.onStageChange?.();
      return;
    }
    if (!item.gpu) this.thaw(item);
    const gpu = item.gpu!;
    this.touch(item);
    for (let row = Math.max(0, Math.floor(y / TS)); row <= Math.min(this.rows - 1, Math.floor((y + h - 1) / TS)); row++) {
      for (let col = Math.max(0, Math.floor(x / TS)); col <= Math.min(this.cols - 1, Math.floor((x + w - 1) / TS)); col++) {
        const tx = col * TS;
        const ty = row * TS;
        const ix0 = Math.max(x, tx);
        const iy0 = Math.max(y, ty);
        const sw = Math.min(x + w, tx + TS) - ix0;
        const sh = Math.min(y + h, ty + TS) - iy0;
        let sub: Uint8Array | null = null;
        if (px) {
          sub = new Uint8Array(sw * sh * 4);
          for (let r = 0; r < sh; r++) sub.set(px.subarray(((iy0 - y + r) * w + (ix0 - x)) * 4, ((iy0 - y + r) * w + (ix0 - x) + sw) * 4), r * sw * 4);
          if (isEmpty(sub)) sub = null;
        }
        const key = keyOf(col, row);
        let t = gpu.get(key) ?? this.reheatTile(item, col, row);
        if (!t) {
          if (!sub) continue; // transparent onto nothing
          this.backup(item, key, undefined);
          t = this.addTile(item, col, row);
        } else {
          if (item !== this.preview) this.detachIfPendingAfter(item, t);
          this.backup(item, key, t);
        }
        item.cleanCache.delete(key);
        t.lastSeenMs = performance.now();
        this.atlas.writePixels(t.slot, sub, ix0 - tx, iy0 - ty, sw, sh, t.w, t.h);
      }
    }
    if (item.shown || item === this.preview) this.onStageChange?.();
  }

  /* ---------- Forms ---------- */

  /** Replaces rectangles of a texture with premultiplied RGBA (no blending) */
  private upload(target: RenderTexture, parts: Array<{ x: number; y: number; w: number; h: number; raw: Uint8Array }>, clear = false) {
    if (!parts.length && !clear) return;
    if (clear) this.clearTexture(target);
    if (!parts.length) return;
    const r = this.renderer as unknown as {
      gl?: WebGLRenderingContext;
      texture?: {
        bindSource?: (s: TextureSource, loc?: number) => void;
        _activateLocation?: (loc: number) => void;
        _activeTextureLocation?: number;
        _premultiplyAlpha?: boolean;
      };
    };
    const texSys = r.texture;
    const bindSource = texSys?.bindSource;
    // Direct texSubImage2D keeps 1:1 uploads bit-exact (a linear-sampled quad drifts ±1 across >2048px canvases).
    if (r.gl && texSys && bindSource) {
      const gl = r.gl;
      bindSource.call(texSys, target.source, 0);
      if (texSys._activateLocation) texSys._activateLocation(0);
      else {
        gl.activeTexture(gl.TEXTURE0);
        if (texSys._activeTextureLocation !== undefined) texSys._activeTextureLocation = 0;
      }
      if (texSys._premultiplyAlpha) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        texSys._premultiplyAlpha = false;
      }
      for (const p of parts) {
        if (p.w <= 0 || p.h <= 0) continue;
        const expected = p.w * p.h * 4;
        if (p.raw.byteLength < expected) continue;
        const bytes = p.raw.byteLength === expected ? p.raw : p.raw.subarray(0, expected);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, p.x, p.y, p.w, p.h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      }
      this.mips.markDirty(target.source);
      return;
    }
    const holder = new Container();
    const textures: Texture[] = [];
    for (const p of parts) {
      const tex = new Texture({
        source: new BufferImageSource({ resource: p.raw, width: p.w, height: p.h, format: 'rgba8unorm', alphaMode: 'premultiplied-alpha', scaleMode: 'nearest' }),
      });
      textures.push(tex);
      const s = new Sprite(tex);
      s.position.set(p.x, p.y);
      s.blendMode = 'none'; // only honoured below a root container
      holder.addChild(s);
    }
    this.renderer.render({ container: holder, target, clear: false });
    textures.forEach((t) => t.destroy(true));
    holder.destroy({ children: true });
  }

  private read(texture: RenderTexture, x: number, y: number, w: number, h: number): Uint8Array {
    const view = new Texture({ source: texture.source, frame: new Rectangle(x, y, w, h) });
    const { pixels } = this.renderer.extract.pixels({ target: view });
    view.destroy(false);
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  }

  private dropGpuTiles(item: LayerItem) {
    for (const t of item.gpu?.values() ?? []) this.freeTile(t);
    item.gpu = null;
    item.cleanCache.clear();
    this.dropBackups(item);
  }

  /** The display holds the full sprite (resident) or the tile sprites (warm); other children (previews) stay */
  private rebuildDisplay(item: LayerItem) {
    item.stackRevision++;
    const d = item.display;
    for (const c of [...d.children]) if (c === item.sprite || c.label === TILE_LABEL) d.removeChild(c);
    if (item.rt) d.addChildAt(item.sprite, 0);
    else if (item.gpu) {
      let i = 0;
      for (const t of item.gpu.values()) d.addChildAt(t.sprite, i++);
    }
    if (item.shown || item === this.preview) this.onStageChange?.();
  }

  /** Sparse → one canvas-sized texture (GPU copy of the tiles, or decoded from the CPU) */
  private makeResident(item: LayerItem) {
    if (item.rt || item.destroyed) return;
    this.flushPendingReads();
    const rt = RenderTexture.create({ width: this.canvasWidth, height: this.canvasHeight, resolution: 1 });
    if (item.gpu?.size || item.coldTiles.size) {
      const holder = new Container();
      for (const t of item.gpu?.values() ?? []) {
        const s = new Sprite(t.sprite.texture);
        s.position.copyFrom(t.sprite.position);
        s.blendMode = 'none';
        holder.addChild(s);
      }
      this.renderer.render({ container: holder, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
      holder.destroy({ children: true });
      if (item.coldTiles.size > 0) {
        const parts: Array<{ x: number; y: number; w: number; h: number; raw: Uint8Array }> = [];
        for (const [key, t] of item.coldTiles) {
          const raw = decodeTile(t);
          if (!raw) continue;
          const [col, row] = key.split('_').map(Number);
          parts.push({ x: col * TS, y: row * TS, w: t.w, h: t.h, raw });
          if (parts.length >= 64) this.upload(rt, parts.splice(0));
        }
        this.upload(rt, parts);
      }
    } else {
      this.clearTexture(rt);
      const parts: Array<{ x: number; y: number; w: number; h: number; raw: Uint8Array }> = [];
      for (const [key, t] of item.cpu ?? []) {
        const raw = decodeTile(t);
        if (!raw) continue;
        const [col, row] = key.split('_').map(Number);
        parts.push({ x: col * TS, y: row * TS, w: t.w, h: t.h, raw });
        if (parts.length >= 64) this.upload(rt, parts.splice(0));
      }
      this.upload(rt, parts);
    }
    // An edit in progress on the tiles: its before-state becomes the ping-pong copy
    let pp: RenderTexture | null = null;
    if (item.bak?.size) {
      pp = this.copyTexture(rt);
      const holder = new Container();
      const zeros: Array<{ x: number; y: number; w: number; h: number; raw: Uint8Array }> = [];
      for (const [key, s] of item.bak) {
        const [col, row] = key.split('_').map(Number);
        const { w, h } = this.tileSize(col, row);
        if (!s) {
          zeros.push({ x: col * TS, y: row * TS, w, h, raw: new Uint8Array(w * h * 4) });
          continue;
        }
        const sp = new Sprite(this.atlas.view(s, w, h));
        sp.position.set(col * TS, row * TS);
        sp.blendMode = 'none';
        holder.addChild(sp);
      }
      this.renderer.render({ container: holder, target: pp, clear: false });
      holder.children.forEach((c) => (c as Sprite).texture.destroy(false));
      holder.destroy({ children: true });
      this.upload(pp, zeros);
    }
    if (this.job?.item === item) this.abortJob();
    this.dropGpuTiles(item);
    item.coldTiles.clear();
    item.cpu = null;
    if (this.magFilter !== 'linear') applyMagFilter(rt, this.magFilter);
    item.rt = rt;
    item.pp = pp;
    item.ppClean = !pp;
    item.ppReleased = false;
    item.sprite.texture = rt;
    this.rebuildDisplay(item);
  }

  /** Puts decoded tiles of a cold layer on the GPU (warm); raws[i] belongs to entries[i], null = empty */
  private warmFrom(item: LayerItem, entries: Array<[string, CpuTile]>, raws: Array<Uint8Array | null>) {
    item.coldTiles.clear();
    item.cleanCache.clear();
    const gpu = new Map<string, GpuTile>();
    const now = performance.now();
    const viewCullWarm = this.shouldThawByViewport(item, entries.length);
    entries.forEach(([key, t], i) => {
      const [col, row] = key.split('_').map(Number);
      if (viewCullWarm && !this.isTileInView(col, row)) {
        item.coldTiles.set(key, t);
        return;
      }
      const raw = raws[i] ?? (viewCullWarm ? decodeTile(t, SCRATCH) : null);
      if (!raw || isEmpty(raw)) return;
      const tile = this.makeTile(item, col, row);
      tile.lastSeenMs = now;
      this.atlas.writePixels(tile.slot, raw, 0, 0, t.w, t.h, tile.w, tile.h);
      gpu.set(key, tile);
      item.cleanCache.set(key, t);
    });
    if (this.job?.item === item) this.abortJob();
    item.gpu = gpu;
    this.tileStructureVersion++;
    // item.cpu stays: an exact copy while the tiles are not edited, so going cold again costs nothing
    this.rebuildDisplay(item);
  }

  private shouldThawByViewport(item: LayerItem, tileCount: number) {
    const transform = (item.model as LayerModel & { renderTransform?: Affine2D }).renderTransform;
    return this.viewBounds !== null && tileCount > this.viewThawThreshold && (!transform || transform.isIdentity);
  }

  /** Cold → warm now (a layer that comes on screen; prefetch() does this ahead, off the main thread) */
  private thaw(item: LayerItem) {
    item.coldTiles.clear();
    item.cleanCache.clear();
    const gpu = new Map<string, GpuTile>();
    const now = performance.now();
    const viewCullThaw = this.shouldThawByViewport(item, item.cpu?.size ?? 0);
    for (const [key, t] of item.cpu ?? []) {
      const [col, row] = key.split('_').map(Number);
      if (viewCullThaw && !this.isTileInView(col, row)) {
        item.coldTiles.set(key, t);
        continue;
      }
      const raw = decodeTile(t, SCRATCH); // uploaded right away (writePixels renders before the next decode)
      if (!raw || isEmpty(raw)) continue;
      const tile = this.makeTile(item, col, row);
      tile.lastSeenMs = now;
      this.atlas.writePixels(tile.slot, raw, 0, 0, t.w, t.h, tile.w, tile.h);
      gpu.set(key, tile);
      item.cleanCache.set(key, t);
    }
    if (this.job?.item === item) this.abortJob();
    item.gpu = gpu;
    this.tileStructureVersion++;
    this.rebuildDisplay(item);
  }

  /**
   * Decodes cold layers in the worker pool and puts them on the GPU before they are needed (the
   * next animation frames). A layer shown before its decode lands is thawed on the spot instead.
   */
  public prefetch(layerIds: string[]) {
    let available = this.prefetchLayers;
    for (const item of this.layersMap.values()) if (item.decoding) available--;
    for (const id of layerIds) {
      if (available <= 0) break;
      const item = this.layersMap.get(id);
      if (!item || item.rt || item.gpu || item.decoding || !item.cpu?.size) continue;
      available--;
      item.decoding = true;
      const version = item.version;
      const entries = [...item.cpu];
      const byViewport = this.shouldThawByViewport(item, entries.length);
      const selected = byViewport ? entries.filter(([key]) => {
        const [col, row] = key.split('_').map(Number);
        return this.isTileInView(col, row);
      }) : entries;
      void decodeTiles(selected.map(([, t]) => ({ data: t.data, compression: t.compression, w: t.w, h: t.h })))
        .then((raws) => {
          item.decoding = false;
          if (item.destroyed || item.rt || item.gpu || item.version !== version) return;
          if (byViewport) {
            const decoded = new Map(selected.map(([key], index) => [key, raws[index]]));
            this.warmFrom(item, entries, entries.map(([key]) => decoded.get(key) ?? null));
          } else {
            this.warmFrom(item, entries, raws);
          }
          item.lastShown = performance.now(); // just fetched: not the first to go back to the CPU
        })
        .catch(() => {
          item.decoding = false;
        });
    }
  }

  public ingestSnapshotTiles(layerId: string, tiles: TileData[]) {
    const item = this.layersMap.get(layerId);
    if (!item || item.adjust || !tiles?.length) return;
    if (item.rt || item.gpu?.size || item.bak?.size) {
      this.applyTiles(layerId, tiles);
      return;
    }
    item.version++;
    const cold = item.gpu ? item.coldTiles : (item.cpu ??= new Map());
    if (item.gpu) item.cpu = null;
    for (const t of tiles) {
      if (!t || t.width <= 0 || t.height <= 0 || t.col < 0 || t.row < 0 || t.col >= this.cols || t.row >= this.rows) continue;
      const key = keyOf(t.col, t.row);
      const { w, h } = this.tileSize(t.col, t.row);
      if (!Number.isInteger(t.col) || !Number.isInteger(t.row) || t.width > w || t.height > h) continue;
      cold.set(key, { data: normalizeTileBytes(t.data), compression: t.compression === 'lz4' ? 'lz4' : 'raw', w: t.width, h: t.height });
      item.cleanCache.delete(key);
    }
    if (item.gpu && (item.shown || this.keepWarm(item))) this.scheduleHydrate();
  }

  /**
   * Pixels that arrived from the server or another painter. Sparse layers merge concurrently against
   * any local un-seen commits (`concurrency`) and any in-progress stroke (`item.bak`) so overlapping
   * 256×256 tiles never punch blank cutouts or erase local strokes.
   */
  public applyTiles(
    layerId: string,
    tiles: TileData[],
    concurrency?: TileConcurrencyContext,
    predecoded?: WeakMap<TileData, Uint8Array | null>
  ) {
    const item = this.layersMap.get(layerId);
    if (!item || item.adjust || !tiles?.length) return;
    // Checkpoint and replay callers use applyTiles too. A full tile can replace the cold
    // payload directly until there are live pixels or a local edit to merge against.
    if (tiles.length > this.viewThawThreshold && !item.rt && !item.gpu?.size && !item.bak?.size && !concurrency && !predecoded &&
        tiles.every((t) => {
          if (!t || (t.compression !== 'raw' && t.compression !== 'lz4')) return false;
          const { w, h } = this.tileSize(t.col, t.row);
          return t.width === w && t.height === h;
        })) {
      this.ingestSnapshotTiles(layerId, tiles);
      return;
    }
    item.version++;
    const valid = tiles.filter((t) => t && t.width > 0 && t.height > 0);
    const baseTiles = concurrency?.baseTiles;
    const resolveRaw = (t: TileData, scratch?: Uint8Array): Uint8Array | null => {
      if (predecoded?.has(t)) {
        const pre = predecoded.get(t);
        if (pre) return pre;
        const len = Math.max(0, t.width * t.height * 4);
        if (!scratch) return new Uint8Array(len);
        scratch.fill(0, 0, len);
        return len === scratch.length ? scratch : scratch.subarray(0, len);
      }
      return decodeTile(t, scratch);
    };
    const decodeBase = (key: string, len: number): Uint8Array | null => {
      const bt = baseTiles?.get(key);
      if (!bt) return null;
      return decodeTile(bt) ?? new Uint8Array(len);
    };

    if (item.rt || item.gpu) this.flushPendingReads();
    if (item.rt) {
      const editingResident = Boolean(item.pp && !item.ppClean);
      for (let i = 0; i < valid.length; i += 64) {
        const chunk = valid.slice(i, i + 64);
        const rtParts: Array<{ x: number; y: number; w: number; h: number; raw: Uint8Array }> = [];
        const ppParts: Array<{ x: number; y: number; w: number; h: number; raw: Uint8Array }> = [];
        for (const t of chunk) {
          const raw = resolveRaw(t);
          if (!raw) continue;
          const x = t.col * TS;
          const y = t.row * TS;
          const key = keyOf(t.col, t.row);
          const common = decodeBase(key, raw.length);
          const remoteWins = concurrency?.remoteIsNewer ? concurrency.remoteIsNewer(t.col, t.row) : true;
          if (editingResident && item.pp) {
            const beforeStroke = this.read(item.pp, x, y, t.width, t.height);
            const currRaw = this.read(item.rt, x, y, t.width, t.height);
            const mergedBak = common ? mergePixels3Way(common, beforeStroke, raw, remoteWins) : raw;
            const mergedCurr = overlayActivePixels(beforeStroke, currRaw, mergedBak);
            ppParts.push({ x, y, w: t.width, h: t.height, raw: mergedBak });
            rtParts.push({ x, y, w: t.width, h: t.height, raw: mergedCurr });
          } else if (common) {
            const currRaw = this.read(item.rt, x, y, t.width, t.height);
            const merged = mergePixels3Way(common, currRaw, raw, remoteWins);
            rtParts.push({ x, y, w: t.width, h: t.height, raw: merged });
          } else {
            rtParts.push({ x, y, w: t.width, h: t.height, raw });
          }
        }
        this.upload(item.rt, rtParts);
        if (ppParts.length && item.pp) this.upload(item.pp, ppParts);
      }
      if (item.shown) this.onStageChange?.();
      return;
    }

    if (item.gpu) {
      item.cpu = null;
      for (const t of valid) {
        const key = keyOf(t.col, t.row);
        const common = decodeBase(key, t.width * t.height * 4);
        const remoteWins = concurrency?.remoteIsNewer ? concurrency.remoteIsNewer(t.col, t.row) : true;
        const activeBak = item.bak?.has(key) ?? false;
        const raw = resolveRaw(t, !common && !activeBak ? SCRATCH : undefined);
        if (!raw) continue;

        let tile = item.gpu.get(key);
        const coldBefore = !tile ? item.coldTiles.get(key) : undefined;
        let finalRaw: Uint8Array = raw;

        if (activeBak && item.bak) {
          const { w, h } = this.tileSize(t.col, t.row);
          const currRaw = tile
            ? this.read(this.atlas.texture(tile.slot), tile.slot.x, tile.slot.y, w, h)
            : (coldBefore ? decodeTile(coldBefore) : null) ?? new Uint8Array(w * h * 4);
          const bakSlot = item.bak.get(key) ?? null;
          const cleanBackup = item.bakClean?.get(key);
          const beforeStroke = (cleanBackup && decodeTile(cleanBackup)) ??
            (bakSlot ? this.read(this.atlas.texture(bakSlot), bakSlot.x, bakSlot.y, w, h) : new Uint8Array(w * h * 4));
          const mergedBak = common ? mergePixels3Way(common, beforeStroke, raw, remoteWins) : raw;
          const bakClean = item.bakClean ?? (item.bakClean = new Map());
          if (isEmpty(mergedBak)) {
            if (bakSlot) {
              this.atlas.free(bakSlot);
              item.bak.set(key, null);
            }
            bakClean.set(key, null);
          } else {
            let nextBak = bakSlot;
            if (!nextBak) {
              nextBak = this.atlas.alloc(tile ? [tile.slot.page] : item.lastPage >= 0 ? [item.lastPage] : undefined);
              item.bak.set(key, nextBak);
              if (t.width < w || t.height < h) {
                this.atlas.writePixels(nextBak, null, 0, 0, w, h, w, h);
              }
            }
            this.atlas.writePixels(nextBak, mergedBak, 0, 0, t.width, t.height, w, h);
            if (!common && t.width === w && t.height === h && (t.compression === 'lz4' || t.compression === 'raw')) {
              bakClean.set(key, { data: normalizeTileBytes(t.data).slice(), compression: t.compression, w, h });
            } else {
              bakClean.delete(key);
            }
          }
          finalRaw = overlayActivePixels(beforeStroke, currRaw, mergedBak);
        } else if (common) {
          const currRaw = tile
            ? this.read(this.atlas.texture(tile.slot), tile.slot.x, tile.slot.y, tile.w, tile.h)
            : (coldBefore ? decodeTile(coldBefore) : null) ?? new Uint8Array(t.width * t.height * 4);
          finalRaw = mergePixels3Way(common, currRaw, raw, remoteWins);
        }

        item.cleanCache.delete(key);

        if (isEmpty(finalRaw)) {
          item.coldTiles.delete(key);
          if (tile) {
            this.freeTile(tile);
            item.gpu.delete(key);
          }
          continue;
        }
        const canKeepColdOffscreen =
          !tile &&
          !activeBak &&
          this.viewBounds !== null &&
          !this.isTileInView(t.col, t.row) &&
          item.gpu.size + item.coldTiles.size > VIEW_THAW_TILE_THRESHOLD;
        if (canKeepColdOffscreen) {
          if (!common && !activeBak && (t.compression === 'lz4' || t.compression === 'raw')) {
            const bytes = normalizeTileBytes(t.data);
            item.coldTiles.set(key, {
              data: bytes.slice(),
              compression: t.compression,
              w: t.width,
              h: t.height,
            });
          } else {
            const compressed = compressTileBuffer(finalRaw, 'lz4');
            item.coldTiles.set(key, {
              data: compressed.data,
              compression: compressed.compression === 'raw' ? 'raw' : 'lz4',
              w: t.width,
              h: t.height,
            });
          }
          continue;
        }
        item.coldTiles.delete(key);
        const created = !tile;
        if (!tile) tile = this.addTile(item, t.col, t.row, false);
        if (created && (t.width < tile.w || t.height < tile.h)) {
          this.atlas.writePixels(tile.slot, null, 0, 0, tile.w, tile.h, tile.w, tile.h);
        }
        this.atlas.writePixels(tile.slot, finalRaw, 0, 0, t.width, t.height, tile.w, tile.h);
        if (!common && !activeBak && t.compression === 'lz4' && t.width === tile.w && t.height === tile.h) {
          item.cleanCache.set(key, {
            data: normalizeTileBytes(t.data).slice(),
            compression: 'lz4',
            w: t.width,
            h: t.height,
          });
        }
        tile.lastSeenMs = performance.now();
      }
      if (item.shown) this.onStageChange?.();
      return;
    }

    item.coldTiles.clear();
    item.cleanCache.clear();
    const cpu = item.cpu ?? (item.cpu = new Map());
    for (const t of valid) {
      const key = keyOf(t.col, t.row);
      const common = decodeBase(key, t.width * t.height * 4);
      if (common) {
        const remote = resolveRaw(t);
        if (!remote) continue;
        const prevCpu = cpu.get(key);
        const currRaw = (prevCpu ? decodeTile(prevCpu) : null) ?? new Uint8Array(t.width * t.height * 4);
        const remoteWins = concurrency?.remoteIsNewer ? concurrency.remoteIsNewer(t.col, t.row) : true;
        const merged = mergePixels3Way(common, currRaw, remote, remoteWins);
        if (isEmpty(merged)) cpu.delete(key);
        else {
          const compressed = compressTileBuffer(merged, 'lz4');
          cpu.set(key, { data: compressed.data, compression: compressed.compression, w: t.width, h: t.height });
        }
      } else {
        cpu.set(key, { data: normalizeTileBytes(t.data), compression: t.compression === 'lz4' ? 'lz4' : 'raw', w: t.width, h: t.height });
      }
    }
  }

  private tick = () => {
    const now = performance.now();
    if ((this.belowCacheRT || this.aboveCacheRT) && now - this.stackCache.lastUsedMs > SCRATCH_IDLE_MS) {
      this.releaseStackCache();
    }
    if (this.compositeRT && now - this.compositeUsed > this.scratchIdleMs) {
      this.compositeRT.destroy(true);
      this.compositeRT = null;
    }
    // Defer heavy GPU->CPU park/freeze readbacks and texture teardown while actively drawing, panning, or zooming.
    if (this.isActivelyDrawing() || now - this.lastInteractionAt < 1200) return;
    const big = this.canvasWidth * this.canvasHeight >= BIG_CANVAS_PX;
    for (const item of this.layersMap.values()) {
      if (big && item.pp && item.ppClean && now - item.lastUsed > PINGPONG_IDLE_MS) {
        this.flushPendingReads();
        item.pp.destroy(true);
        item.pp = null;
        item.ppReleased = true;
      }
    }
    if (this.job) return;

    // Park the layer untouched the longest (a dirty before-state means a tool may still be busy
    // with it). The active layer too: it was only made resident by a tool, the brush draws sparse.
    let park: LayerItem | null = null;
    for (const item of this.layersMap.values()) {
      if (!item.rt || this.isPinned(item)) continue;
      const idle = now - item.lastUsed;
      if (idle < PARK_AFTER_MS || (item.pp && !item.ppClean && idle < 15000)) continue;
      if (!park || item.lastUsed < park.lastUsed) park = item;
    }
    if (park) {
      this.job = { kind: 'park', item: park, version: park.version, next: 0, tiles: new Map() };
      this.pump();
      return;
    }

    // Too many off-screen tiles on the GPU: the least recently shown layer goes to the CPU
    let hiddenBytes = 0;
    let freeze: LayerItem | null = null;
    const frozen = (item: LayerItem) => item.gpu && !item.shown && !item.bak?.size && !this.isPinned(item) && !this.keepWarm(item);
    for (const item of this.layersMap.values()) {
      if (!frozen(item)) continue;
      for (const t of item.gpu!.values()) hiddenBytes += t.w * t.h * 4;
      if (!freeze || item.lastShown < freeze.lastShown) freeze = item;
    }
    if (freeze && hiddenBytes > this.hiddenTileBudget) {
      // Unedited since it came from the CPU (animation playback): just let the GPU copy go
      if (freeze.cpu) {
        // …and the next least recently shown ones too while over budget, as long as they are as cheap
        for (const item of [...this.layersMap.values()].filter((i) => frozen(i) && i.cpu).sort((a, b) => a.lastShown - b.lastShown)) {
          if (hiddenBytes <= this.hiddenTileBudget) break;
          for (const t of item.gpu!.values()) hiddenBytes -= t.w * t.h * 4;
          this.dropGpuTiles(item);
          this.rebuildDisplay(item);
        }
        return;
      }
      this.job = { kind: 'freeze', item: freeze, version: freeze.version, next: 0, keys: [...freeze.gpu!.keys()], tiles: new Map() };
      this.pump();
      return;
    }

    // Active visible layers exceeding the soft GPU tile/VRAM limit spill oldest offscreen tiles to CPU LRU
    if (!this.wrapAroundEnabled && !this.evictingOffscreen && this.viewBounds && !this.isActivelyDrawing()) {
      this.enforceTileLruBudgetNow(false);
    }
    // Trim idle pooled atlas pages after 15s so VRAM stays bounded when zoomed in or idle
    this.atlas.trimPool(15000, 1);
  };

  /** Phase 6.3: Dynamically updates GPU tile/VRAM LRU ceiling and atlas pool retention */
  public setGpuTileBudget(patch: { maxTiles?: number; maxMegabytes?: number; maxPooledAtlasPages?: number }) {
    if (patch.maxTiles !== undefined && Number.isFinite(patch.maxTiles)) {
      this.softGpuTileLimit = Math.max(16, Math.round(patch.maxTiles));
    }
    if (patch.maxMegabytes !== undefined && Number.isFinite(patch.maxMegabytes)) {
      this.softGpuByteLimit = Math.max(8, patch.maxMegabytes) * 1048576;
    }
    if (patch.maxPooledAtlasPages !== undefined && Number.isFinite(patch.maxPooledAtlasPages)) {
      this.atlas.setMaxPooledPages(patch.maxPooledAtlasPages);
    }
  }

  /**
   * Phase 6.3: Evaluates GPU tile count & atlas VRAM byte budget and evicts least-recently-viewed
   * offscreen tiles down to 85% low-water target (clean-first, zero-readPixels prioritized).
   */
  public enforceTileLruBudgetNow(trimAllPooledPages = true): number {
    if (this.destroyed || this.wrapAroundEnabled || this.evictingOffscreen || !this.viewBounds) return 0;
    let totalGpuTiles = 0;
    for (const item of this.layersMap.values()) totalGpuTiles += item.gpu?.size ?? 0;
    const atlasBytes = this.atlas.stats().activeBytes;
    const overTiles = totalGpuTiles > this.softGpuTileLimit;
    const overBytes = atlasBytes > this.softGpuByteLimit;
    if (!overTiles && !overBytes) {
      if (trimAllPooledPages) this.atlas.trimPool(0, 0);
      return 0;
    }
    // Hysteresis low-water target (85%) avoids evicting 1-2 tiles every frame during continuous panning
    const targetTiles = Math.floor(this.softGpuTileLimit * 0.85);
    const excessByTiles = Math.max(0, totalGpuTiles - targetTiles);
    const excessByBytes = overBytes
      ? Math.ceil((atlasBytes - this.softGpuByteLimit * 0.85) / (TS * TS * 4))
      : 0;
    const excess = Math.max(excessByTiles, excessByBytes);
    const evictedClean = this.evictOffscreenGpuTiles(excess);
    if (trimAllPooledPages) this.atlas.trimPool(0, 0);
    return evictedClean;
  }

  /** Evicts least-recently-viewed offscreen tiles from warm layers into `coldTiles` without blocking */
  private evictOffscreenGpuTiles(excess: number): number {
    if (excess <= 0 || !this.viewBounds) return 0;
    const candidates: Array<{ item: LayerItem; key: string; tile: GpuTile; lastSeen: number; clean: boolean }> = [];
    for (const item of this.layersMap.values()) {
      if (!item.gpu || item.rt || this.isPinned(item) || (this.pendingBakReads.get(item.model.id) ?? 0) > 0) continue;
      const pendingAfter = this.pendingAfterSlots.get(item.model.id);
      for (const [key, tile] of item.gpu) {
        if (item.bak?.has(key) || pendingAfter?.has(tile.slot)) continue;
        if (this.isTileInView(tile.col, tile.row)) continue;
        candidates.push({
          item,
          key,
          tile,
          lastSeen: tile.lastSeenMs ?? 0,
          clean: item.cleanCache.has(key),
        });
      }
    }
    if (!candidates.length) return 0;
    // Prioritize clean tiles (zero GPU readPixels stall) before dirty tiles, both in LRU order
    candidates.sort((a, b) => {
      if (a.clean !== b.clean) return a.clean ? -1 : 1;
      return a.lastSeen - b.lastSeen;
    });

    const dirtyBatchCap = excess > this.softGpuTileLimit * 0.25 ? 16 : 12;
    let remaining = excess;
    let evictedClean = 0;
    const dirtyBatch: Array<{ item: LayerItem; version: number; key: string; tile: GpuTile; slot: Slot }> = [];
    for (const c of candidates) {
      if (remaining <= 0) break;
      const clean = c.item.cleanCache.get(c.key);
      if (clean) {
        c.item.cleanCache.delete(c.key);
        c.item.coldTiles.set(c.key, clean);
        this.freeTile(c.tile);
        c.item.gpu!.delete(c.key);
        remaining--;
        evictedClean++;
        this.lruCleanEvictions++;
      } else if (dirtyBatch.length < dirtyBatchCap) {
        dirtyBatch.push({ item: c.item, version: c.item.version, key: c.key, tile: c.tile, slot: c.tile.slot });
      }
    }
    if (!dirtyBatch.length || !this.reader) return evictedClean;

    this.evictingOffscreen = true;
    const byTex = new Map<RenderTexture, Array<(typeof dirtyBatch)[number] & { rect: Rect }>>();
    for (const b of dirtyBatch) {
      this.acquireAfterSlots(b.item.model.id, [b.slot]);
      const tex = this.atlas.texture(b.slot);
      const list = byTex.get(tex) ?? [];
      list.push({ ...b, rect: { x: b.slot.x, y: b.slot.y, w: b.tile.w, h: b.tile.h } });
      byTex.set(tex, list);
    }
    const reader = this.reader;
    const jobs = [...byTex].map(([tex, parts]) => reader(tex, parts.map((p) => p.rect)).then((pxs) => ({ parts, pxs })));
    void Promise.all(jobs)
      .then((results) => {
        for (const { parts, pxs } of results) {
          parts.forEach((p, idx) => {
            const raw = pxs[idx];
            if (
              this.destroyed ||
              p.item.destroyed ||
              p.item.rt ||
              !p.item.gpu ||
              p.item.version !== p.version ||
              p.item.bak?.has(p.key) ||
              p.item.gpu.get(p.key) !== p.tile ||
              p.tile.slot !== p.slot
            ) {
              return;
            }
            if (this.isTileInView(p.tile.col, p.tile.row)) return;
            if (raw && !isEmpty(raw)) {
              const compressed = compressTileBuffer(raw, 'lz4');
              p.item.coldTiles.set(p.key, {
                data: compressed.data,
                compression: compressed.compression === 'raw' ? 'raw' : 'lz4',
                w: p.tile.w,
                h: p.tile.h,
              });
            }
            p.item.cleanCache.delete(p.key);
            this.freeTile(p.tile);
            p.item.gpu.delete(p.key);
            this.lruDirtyEvictions++;
          });
        }
      })
      .finally(() => {
        for (const b of dirtyBatch) {
          this.releaseAfterSlots(b.item.model.id, [b.slot]);
        }
        this.evictingOffscreen = false;
      });
    return evictedClean;
  }

  private pump = () => {
    this.jobTimer = null;
    const job = this.job;
    if (!job || this.destroyed) return;
    if (job.reading) return;
    if (this.isActivelyDrawing() || performance.now() - this.lastInteractionAt < 1200) {
      this.jobTimer = setTimeout(this.pump, 350);
      return;
    }
    if (job.kind === 'park') this.stepPark(job);
    else this.stepFreeze(job);
    if (this.job && !this.job.reading) this.jobTimer = setTimeout(this.pump, 16);
  };

  private abortJob() {
    const job = this.job;
    this.job = null;
    if (this.jobTimer) clearTimeout(this.jobTimer);
    this.jobTimer = null;
    if (job?.kind === 'park') for (const t of job.tiles.values()) this.freeTile(t);
  }

  private finishPark(job: Extract<Job, { kind: 'park' }>) {
    const { item } = job;
    this.flushPendingReads();
    this.job = null;
    item.rt!.destroy(true);
    item.pp?.destroy(true);
    item.rt = null;
    item.pp = null;
    item.ppReleased = false;
    item.ppClean = true;
    item.sprite.texture = Texture.EMPTY;
    item.gpu = job.tiles;
    item.cpu = null;
    this.rebuildDisplay(item);
  }

  /** Resident → warm, a tile row per step: read back asynchronously via PBO and pack into atlas slots */
  private stepPark(job: Extract<Job, { kind: 'park' }>) {
    const { item } = job;
    const W = this.canvasWidth;
    const H = this.canvasHeight;
    if (this.reader) {
      if (job.reading) return;
      if (job.next < this.rows) {
        if (item.destroyed || item.version !== job.version || !item.rt || this.isPinned(item)) return this.abortJob();
        const row = job.next;
        const version = job.version;
        const y = row * TS;
        const h = Math.min(TS, H - y);
        const chunkCols = 8; // <= 2048px wide (<= 2MB) per PBO read chunk
        const rects: Rect[] = [];
        for (let c = 0; c < this.cols; c += chunkCols) {
          const x = c * TS;
          const cw = Math.min(chunkCols * TS, W - x);
          if (cw > 0) rects.push({ x, y, w: cw, h });
        }
        job.reading = true;
        this.pendingReadCount++;
        let settled = false;
        const settleRead = () => {
          if (settled) return;
          settled = true;
          job.reading = false;
          this.pendingReadCount = Math.max(0, this.pendingReadCount - 1);
        };
        void this.reader(item.rt, rects)
          .then((chunks) => {
            settleRead();
            if (this.destroyed || this.job !== job || item.destroyed || item.version !== version || !item.rt || this.isPinned(item)) {
              if (this.job === job) this.abortJob();
              return;
            }
            for (let ci = 0; ci < rects.length; ci++) {
              const strip = chunks[ci];
              const chunkW = rects[ci].w;
              const startCol = ci * chunkCols;
              const endCol = Math.min(this.cols, startCol + chunkCols);
              for (let col = startCol; col < endCol; col++) {
                const localX = (col - startCol) * TS;
                const w = Math.min(TS, chunkW - localX);
                if (isEmpty(strip, chunkW, localX, w, h)) continue;
                const tile = this.makeTile(item, col, row);
                let tileBuf: Uint8Array;
                if (w === chunkW) {
                  tileBuf = strip;
                } else {
                  tileBuf = SCRATCH.subarray(0, w * h * 4);
                  const rowBytes = w * 4;
                  const srcStrideBytes = chunkW * 4;
                  for (let ry = 0; ry < h; ry++) {
                    const srcOff = ry * srcStrideBytes + localX * 4;
                    tileBuf.set(strip.subarray(srcOff, srcOff + rowBytes), ry * rowBytes);
                  }
                }
                this.atlas.writePixels(tile.slot, tileBuf, 0, 0, w, h, w, h);
                job.tiles.set(keyOf(col, row), tile);
              }
            }
            job.next++;
            if (job.next >= this.rows) {
              this.finishPark(job);
            } else if (!this.jobTimer) {
              const busy = this.isActivelyDrawing() || performance.now() - this.lastInteractionAt < 1200;
              this.jobTimer = setTimeout(this.pump, busy ? 350 : 16);
            }
          })
          .catch(() => {
            settleRead();
            if (this.job === job) this.abortJob();
          });
        return;
      }
      this.finishPark(job);
      return;
    }

    const t0 = performance.now();
    while (job.next < this.rows && performance.now() - t0 < STEP_BUDGET_MS) {
      if (item.destroyed || item.version !== job.version || !item.rt || this.isPinned(item)) return this.abortJob();
      const y = job.next * TS;
      const h = Math.min(TS, H - y);
      const strip = this.read(item.rt, 0, y, W, h);
      for (let col = 0; col < this.cols; col++) {
        const x = col * TS;
        const w = Math.min(TS, W - x);
        if (isEmpty(strip, W, x, w, h)) continue;
        const tile = this.makeTile(item, col, job.next);
        const view = new Texture({ source: item.rt.source, frame: new Rectangle(x, y, w, h) });
        this.atlas.write(tile.slot, view, 0, 0, w, h, w, h);
        view.destroy(false);
        job.tiles.set(keyOf(col, job.next), tile);
      }
      job.next++;
    }
    if (job.next < this.rows) return;
    this.finishPark(job);
  }

  private finishFreeze(job: Extract<Job, { kind: 'freeze' }>) {
    const { item } = job;
    for (const [key, t] of item.coldTiles) {
      if (!job.tiles.has(key)) job.tiles.set(key, t);
    }
    item.coldTiles.clear();
    this.job = null;
    this.dropGpuTiles(item);
    item.cpu = job.tiles;
    this.rebuildDisplay(item);
  }

  /** Warm and off screen → cold: tiles read back and LZ4-compressed, slots freed */
  private stepFreeze(job: Extract<Job, { kind: 'freeze' }>) {
    const { item } = job;
    if (this.reader) {
      if (job.reading) return;
      const dirtyBatch: Array<{ key: string; tile: GpuTile; slot: Slot }> = [];
      const t0 = performance.now();
      while (job.next < job.keys.length && dirtyBatch.length < 4 && (dirtyBatch.length > 0 || performance.now() - t0 < STEP_BUDGET_MS)) {
        if (item.destroyed || item.version !== job.version || !item.gpu || item.shown || this.isPinned(item) || this.keepWarm(item)) return this.abortJob();
        const key = job.keys[job.next++];
        const t = item.gpu.get(key);
        if (!t) continue;
        const clean = item.cleanCache.get(key);
        if (clean) {
          job.tiles.set(key, clean);
        } else {
          dirtyBatch.push({ key, tile: t, slot: t.slot });
        }
      }
      if (dirtyBatch.length > 0) {
        const version = job.version;
        const id = item.model.id;
        const byTex = new Map<RenderTexture, Array<(typeof dirtyBatch)[number] & { rect: Rect }>>();
        for (const b of dirtyBatch) {
          this.acquireAfterSlots(id, [b.slot]);
          const tex = this.atlas.texture(b.slot);
          const list = byTex.get(tex) ?? [];
          list.push({ ...b, rect: { x: b.slot.x, y: b.slot.y, w: b.tile.w, h: b.tile.h } });
          byTex.set(tex, list);
        }
        job.reading = true;
        this.pendingReadCount++;
        let settled = false;
        const settleRead = () => {
          if (settled) return;
          settled = true;
          job.reading = false;
          this.pendingReadCount = Math.max(0, this.pendingReadCount - 1);
          for (const b of dirtyBatch) this.releaseAfterSlots(id, [b.slot]);
        };
        const reader = this.reader;
        const reads = [...byTex].map(([tex, parts]) => reader(tex, parts.map((p) => p.rect)).then((pxs) => ({ parts, pxs })));
        void Promise.all(reads)
          .then((results) => {
            settleRead();
            if (this.destroyed || this.job !== job || item.destroyed || item.version !== version || !item.gpu || item.shown || this.isPinned(item) || this.keepWarm(item)) {
              if (this.job === job) this.abortJob();
              return;
            }
            for (const { parts, pxs } of results) {
              parts.forEach((p, idx) => {
                const raw = pxs[idx];
                if (raw && !isEmpty(raw)) {
                  job.tiles.set(p.key, {
                    data: compressTileBuffer(raw, 'lz4').data,
                    compression: 'lz4',
                    w: p.tile.w,
                    h: p.tile.h,
                  });
                }
              });
            }
            if (job.next >= job.keys.length) {
              this.finishFreeze(job);
            } else if (!this.jobTimer) {
              const busy = this.isActivelyDrawing() || performance.now() - this.lastInteractionAt < 1200;
              this.jobTimer = setTimeout(this.pump, busy ? 350 : 16);
            }
          })
          .catch(() => {
            settleRead();
            if (this.job === job) this.abortJob();
          });
        return;
      }
      if (job.next < job.keys.length) return;
      this.finishFreeze(job);
      return;
    }

    const t0 = performance.now();
    while (job.next < job.keys.length && performance.now() - t0 < STEP_BUDGET_MS) {
      if (item.destroyed || item.version !== job.version || !item.gpu || item.shown || this.isPinned(item) || this.keepWarm(item)) return this.abortJob();
      const key = job.keys[job.next++];
      const t = item.gpu.get(key);
      if (!t) continue;
      const clean = item.cleanCache.get(key);
      if (clean) {
        job.tiles.set(key, clean);
      } else {
        const raw = this.read(this.atlas.texture(t.slot), t.slot.x, t.slot.y, t.w, t.h);
        job.tiles.set(key, { data: compressTileBuffer(raw.slice(), 'lz4').data, compression: 'lz4', w: t.w, h: t.h });
      }
    }
    if (job.next < job.keys.length) return;
    this.finishFreeze(job);
  }

  /** Copies every pixel of `src` into same-sized `dst` without linear sampling drift on large canvases */
  private copyInto(src: RenderTexture, dst: RenderTexture) {
    const r = this.renderer as unknown as {
      gl?: WebGLRenderingContext;
      texture?: { _activateLocation?: (loc: number) => void; _activeTextureLocation?: number };
      renderTarget?: {
        copyToTexture?: (
          source: RenderTexture,
          dest: RenderTexture,
          originSrc: { x: number; y: number },
          size: { width: number; height: number },
          originDest: { x: number; y: number }
        ) => void;
        resetState?: () => void;
      };
    };
    if (r.renderTarget?.copyToTexture) {
      if (r.texture?._activateLocation) r.texture._activateLocation(0);
      else if (r.gl) {
        r.gl.activeTexture(r.gl.TEXTURE0);
        if (r.texture && r.texture._activeTextureLocation !== undefined) r.texture._activeTextureLocation = 0;
      }
      r.renderTarget.copyToTexture(src, dst, { x: 0, y: 0 }, { width: src.width, height: src.height }, { x: 0, y: 0 });
      r.renderTarget.resetState?.();
      this.mips.markDirty(dst.source);
      return;
    }
    const prevMag = src.source.magFilter;
    const prevMin = src.source.minFilter;
    const prevMip = src.source.mipmapFilter;
    src.source.magFilter = 'nearest';
    src.source.minFilter = 'nearest';
    src.source.mipmapFilter = 'nearest';
    src.source.style.update();
    const blit = new Sprite(src);
    this.renderer.render({ container: blit, target: dst, clear: true, clearColor: [0, 0, 0, 0] });
    blit.destroy();
    src.source.magFilter = prevMag;
    src.source.minFilter = prevMin;
    src.source.mipmapFilter = prevMip;
    src.source.style.update();
  }

  /** A new texture holding a copy of src */
  /** @internal */
  copyTexture(src: RenderTexture): RenderTexture {
    const rt = RenderTexture.create({ width: src.width, height: src.height, resolution: 1 });
    this.copyInto(src, rt);
    return rt;
  }

  /** GPU memory held by layer textures (and CPU memory of cold layers), for tests and the developer panel */
  public getTextureStats() {
    const full = this.canvasWidth * this.canvasHeight * 4;
    let resident = 0;
    let pingPong = 0;
    let warm = 0;
    let tiles = 0;
    let cold = 0;
    let coldTiles = 0;
    let backups = 0;
    let cpuBytes = 0;
    for (const item of this.layersMap.values()) {
      if (item.rt) resident++;
      if (item.pp) pingPong++;
      if (item.gpu) {
        warm++;
        tiles += item.gpu.size;
      } else if (!item.rt) cold++;
      coldTiles += item.coldTiles.size;
      for (const s of item.bak?.values() ?? []) if (s) backups++;
      for (const t of item.cpu?.values() ?? []) cpuBytes += t.data.byteLength;
      for (const t of item.coldTiles.values()) cpuBytes += t.data.byteLength;
    }
    const scratch = this.compositeRT ? 1 : 0;
    const atlas = this.atlas.stats();
    const mipBytes = this.mips.bytes();
    const gpuBytes = (resident + pingPong + scratch) * full + atlas.bytes + mipBytes;
    const mb = (b: number) => Math.round(b / 1048576);
    return {
      layers: this.layersMap.size,
      /** canvas-sized textures (resident layers, their ping-pong copies, the composite) */
      textures: resident + pingPong + scratch,
      megabytes: mb(gpuBytes),
      resident,
      pingPong,
      warm,
      tiles,
      cold,
      coldTiles,
      scratch,
      /** atlas pages (64 tiles each, 17 MB) holding warm tiles, backups and previews */
      atlasPages: atlas.pages,
      atlasMegabytes: mb(atlas.activeBytes),
      atlasPooledPages: atlas.pooledPages,
      atlasPooledMegabytes: mb(atlas.pooledBytes),
      atlasPoolHits: atlas.poolHits,
      atlasPoolMisses: atlas.poolMisses,
      atlasFragmentation: atlas.fragmentationRatio,
      /** mip levels of layer textures shown zoomed out (freed a few seconds after zooming back in) */
      mipMegabytes: mb(mipBytes),
      /** tiles copied before their first write in the stroke being drawn */
      backups,
      previewTiles: this.preview.gpu?.size ?? 0,
      cpuMegabytes: mb(cpuBytes),
      lruBudgetTiles: this.softGpuTileLimit,
      lruBudgetMegabytes: mb(this.softGpuByteLimit),
      lruEvictions: this.lruCleanEvictions + this.lruDirtyEvictions,
      lruCleanEvictions: this.lruCleanEvictions,
      lruDirtyEvictions: this.lruDirtyEvictions,
      lruReheatHits: this.lruReheatHits,
    };
  }

  /** One filter per colour and way of drawing (key: colour, plus 0x1000000 when shaded) */
  private onionFilters = new Map<number, Filter>();

  private getOnionFilter(tint: number, shade: boolean): Filter {
    const key = tint + (shade ? 0x1000000 : 0);
    let filter = this.onionFilters.get(key);
    if (!filter) this.onionFilters.set(key, (filter = this.createOnionFilter(tint, shade)));
    return filter;
  }

  /**
   * uMode 0: the drawing in one flat colour. uMode 1: the colour keeps the drawing's lights and
   * darks (dark lines a deep shade of it, light fills a pale one), so shading still reads.
   */
  private createOnionFilter(tint: number, shade: boolean): Filter {
    return Filter.from({
      gl: {
        vertex: defaultFilterVert,
        fragment: `#version 300 es
          precision highp float;
          in vec2 vTextureCoord;
          out vec4 finalColor;
          uniform sampler2D uTexture;
          uniform vec3 uTint;
          uniform float uMode;
          void main() {
            vec4 src = texture(uTexture, vTextureCoord);
            float a = src.a;
            vec3 col = uTint;
            if (uMode > 0.5 && a > 0.0) {
              float lum = dot(src.rgb / a, vec3(0.299, 0.587, 0.114));
              col = lum < 0.5 ? mix(uTint * 0.3, uTint, lum * 2.0) : mix(uTint, vec3(1.0), (lum - 0.5) * 1.5);
            }
            finalColor = vec4(col * a, a);
          }
        `,
      },
      resources: {
        onionUniforms: {
          uTint: { value: [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255], type: 'vec3<f32>' },
          uMode: { value: shade ? 1 : 0, type: 'f32' },
        },
      },
    });
  }

  public getLayerItem(layerId: string): PixiLayerItem | undefined {
    return this.layersMap.get(layerId);
  }

  public getLayers(): PixiLayerItem[] {
    return Array.from(this.layersMap.values());
  }

  /* ---------- Live preview ---------- */

  /** Where live previews are drawn (other painters' dabs): sparse, tiles appear where something is drawn */
  public getPreviewTarget(): DrawTarget {
    return { draw: (c, x, y, w, h) => this.drawSparse(this.preview, c, x, y, w, h) };
  }

  /** Draws a 2D canvas (straight alpha) into the preview at (x, y): text being typed */
  public drawPreviewCanvas(canvas: HTMLCanvasElement, x: number, y: number) {
    // Not Texture.from: it caches per canvas, and the destroy below would poison that cache
    const texture = new Texture({ source: new CanvasSource({ resource: canvas }) });
    const holder = new Container();
    const sprite = new Sprite(texture);
    sprite.position.set(x, y);
    holder.addChild(sprite);
    this.drawSparse(this.preview, holder, x, y, canvas.width, canvas.height);
    holder.destroy({ children: true });
    texture.destroy(true);
  }

  /** Clears a rectangle of the preview (a painter's stroke was committed); emptied tiles are freed */
  public clearPreviewRegion(x: number, y: number, w: number, h: number) {
    const gpu = this.preview.gpu!;
    for (const [key, t] of [...gpu]) {
      const tx = t.sprite.x;
      const ty = t.sprite.y;
      const ix0 = Math.max(x, tx);
      const iy0 = Math.max(y, ty);
      const ix1 = Math.min(x + w, tx + t.w);
      const iy1 = Math.min(y + h, ty + t.h);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      if (ix0 === tx && iy0 === ty && ix1 === tx + t.w && iy1 === ty + t.h) {
        this.freeTile(t);
        gpu.delete(key);
      } else {
        this.atlas.writePixels(t.slot, null, ix0 - tx, iy0 - ty, ix1 - ix0, iy1 - iy0, t.w, t.h);
      }
    }
    this.onStageChange?.();
  }

  private recyclePreviewParticles(particles: Particle[]) {
    for (const p of particles) {
      if (this.previewParticlePool.length < 4000) this.previewParticlePool.push(p);
    }
  }

  /** Appends pooled dab particles for a remote painter into one batched ParticleContainer per painter (no scene-graph Sprite bloat) */
  public addPreviewDabs(
    key: string,
    dabs: Array<{ x: number; y: number; size: number; alpha: number; color: string }>,
    tipTexture: Texture
  ) {
    if (!dabs.length) return;
    let entry = this.previewPainters.get(key);
    if (!entry) {
      const container = new ParticleContainer<Particle>({
        texture: tipTexture,
        dynamicProperties: { position: false, rotation: false, vertex: false, uvs: false, color: false },
      });
      container.blendMode = 'normal';
      this.preview.display.addChild(container);
      entry = { container, lastAt: 0 };
      this.previewPainters.set(key, entry);
    } else if (entry.container.texture !== tipTexture) {
      entry.container.texture = tipTexture;
    }
    entry.lastAt = performance.now();
    const list = dabs.length > 4000 ? dabs.slice(-4000) : dabs;
    const overflow = entry.container.particleChildren.length + list.length - 4000;
    if (overflow > 0) {
      const removed = entry.container.removeParticles(0, Math.min(overflow, entry.container.particleChildren.length));
      this.recyclePreviewParticles(removed);
    }
    const tw = tipTexture.width || 1;
    const th = tipTexture.height || 1;
    const added: Particle[] = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      let p = this.previewParticlePool.pop();
      if (!p) {
        p = new Particle({
          texture: tipTexture,
          x: d.x,
          y: d.y,
          scaleX: d.size / tw,
          scaleY: d.size / th,
          anchorX: 0.5,
          anchorY: 0.5,
          tint: d.color,
          alpha: Math.max(0.01, Math.min(1, d.alpha)),
        });
      } else {
        p.texture = tipTexture;
        p.anchorX = 0.5;
        p.anchorY = 0.5;
        p.x = d.x;
        p.y = d.y;
        p.scaleX = d.size / tw;
        p.scaleY = d.size / th;
        p.rotation = 0;
        p.tint = d.color;
        p.alpha = Math.max(0.01, Math.min(1, d.alpha));
      }
      added[i] = p;
    }
    entry.container.addParticle(...added);
    this.onStageChange?.();
  }

  /** Removes one painter's preview particles when their stroke commits (O(1), never touches other painters) */
  public dropPreviewPainter(key: string) {
    const entry = this.previewPainters.get(key);
    const now = performance.now();
    if (entry) {
      this.previewPainters.delete(key);
      this.recyclePreviewParticles(entry.container.particleChildren.splice(0));
      entry.container.removeFromParent();
      entry.container.destroy();
    }
    for (const [k, e] of this.previewPainters) {
      if (now - e.lastAt > 8000) {
        this.previewPainters.delete(k);
        this.recyclePreviewParticles(e.container.particleChildren.splice(0));
        e.container.removeFromParent();
        e.container.destroy();
      }
    }
    this.onStageChange?.();
  }

  public clearPreview() {
    for (const e of this.previewPainters.values()) {
      this.recyclePreviewParticles(e.container.particleChildren.splice(0));
      e.container.removeFromParent();
      e.container.destroy();
    }
    this.previewPainters.clear();
    for (const t of this.preview.gpu!.values()) this.freeTile(t);
    this.preview.gpu!.clear();
    this.onStageChange?.();
  }

  /**
   * Clears a texture to transparent. Never use renderer.clear({ target }) for this: Pixi does
   * not bind the target there, it clears whichever framebuffer was bound last, which silently
   * wiped unrelated layers (and left this one untouched). Rendering nothing with clear binds first.
   */
  private clearTexture(target: RenderTexture) {
    this.renderer.render({ container: this.emptyContainer, target, clear: true, clearColor: [0, 0, 0, 0] });
  }

  /**
   * Makes the before-state equal the layer now. A sparse layer just lets go of the tiles it backed
   * up during the edit (nothing is copied: only tiles changed since are ever copied, on first write).
   */
  public syncPingPong(layerId: string) {
    const item = this.layersMap.get(layerId);
    if (!item) return;
    if (!item.rt) {
      this.dropBackups(item);
      return;
    }
    if (!item.pp) {
      void item.pingPongTexture; // allocating copies the layer: that is the sync
      item.ppClean = true;
      return;
    }

    this.flushPendingReads();
    this.copyInto(item.renderTexture, item.pp);
    item.ppClean = true;
  }

  /** After an edit that is already final (remote op, reload): resync only an idle resident before-state */
  public refreshPingPong(layerId: string) {
    const item = this.layersMap.get(layerId);
    if (item?.rt && item.pp && item.ppClean) this.syncPingPong(layerId);
  }

  /** The layer about to be drawn on needs its before-state buffer (fill / transform read it after editing) */
  public ensurePingPong(layerId: string) {
    const item = this.layersMap.get(layerId);
    if (item?.rt && !item.pp) this.syncPingPong(layerId);
  }

  /** Back to the state of the last sync (a cancelled stroke or transform) */
  public revertToPingPong(layerId: string) {
    const item = this.layersMap.get(layerId);
    if (!item) return;
    if (!item.rt) {
      this.restoreBackups(item);
      if (item.shown) this.onStageChange?.();
      return;
    }
    if (!item.pp) return; // never allocated = nothing changed since the last sync

    this.flushPendingReads();
    this.copyInto(item.pp, item.rt);
    if (item.shown) this.onStageChange?.();
  }

  private thumbRT: RenderTexture | null = null;

  private compositeRT: RenderTexture | null = null;
  private compositeUsed = 0;
  /** Temporary overlay sprite shown during "Apply Filter to New Layer" live preview */
  private filterOverlaySprite: Sprite | null = null;

  public setFilterOverlay(texture: RenderTexture | null, zIndex = 1e6) {
    this.deactivateStackCache();
    if (!texture) {
      if (this.filterOverlaySprite) {
        this.layersContainer.removeChild(this.filterOverlaySprite);
        this.filterOverlaySprite.destroy();
        this.filterOverlaySprite = null;
        this.onStageChange?.();
      }
      return;
    }
    if (!this.filterOverlaySprite) {
      this.filterOverlaySprite = new Sprite(texture);
      this.layersContainer.addChild(this.filterOverlaySprite);
    } else if (this.filterOverlaySprite.texture !== texture) {
      this.filterOverlaySprite.texture = texture;
    }
    this.filterOverlaySprite.visible = true;
    this.filterOverlaySprite.zIndex = zIndex;
    this.layersContainer.sortChildren();
    this.onStageChange?.();
  }

  /** Lightweight fingerprint of all visible layers' pixel versions & display props, for filter source caching */
  public getVisibleCompositeVersion(): string {
    let acc = this.lastBgColor;
    for (const item of this.layersMap.values()) {
      if (!item.shown && item.model.layerType !== 'mask') continue;
      acc += `|${item.model.id}:${item.version}:${item.model.sortOrder}:${item.display.alpha}:${item.model.blendMode}`;
      if (item.adjust) acc += `:${item.adjust.paramsKey}`;
      if (item.layerColorKey) acc += `:${item.layerColorKey}`;
      if (item.layerEffectsKey) acc += `:fx=${item.layerEffectsKey}`;
    }
    for (const [gid, entry] of this.groupEffectContainers) {
      acc += `|gfx:${gid}:${entry.effectsKey}`;
    }
    return acc;
  }

  private parseCssColorRgba(color: string): [number, number, number, number] {
    const clean = color.trim();
    if (/^#[0-9a-f]{6}$/i.test(clean)) {
      const n = parseInt(clean.slice(1), 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    }
    if (/^#[0-9a-f]{3}$/i.test(clean)) {
      const r = parseInt(clean[1] + clean[1], 16) / 255;
      const g = parseInt(clean[2] + clean[2], 16) / 255;
      const b = parseInt(clean[3] + clean[3], 16) / 255;
      return [r, g, b, 1];
    }
    return [1, 1, 1, 1];
  }

  /**
   * Reads all visible layers composited into a single premultiplied RGBA Uint8Array, without
   * creating redundant full-size 2D canvas copies when WebGL PBO readback is available.
   */
  public async readVisibleCompositeAsync(includeBackground = false, releaseCompositeAfter = false): Promise<Uint8Array> {
    this.updateAdjustmentScopes(true); // whole-canvas scope composites for adjustment layers
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    let totalCold = 0;
    for (const item of this.layersMap.values()) {
      if (item.shown || item.model.layerType === 'mask') totalCold += item.coldTiles.size;
    }

    const overlayPrev = this.filterOverlaySprite?.visible ?? false;
    if (this.filterOverlaySprite) this.filterOverlaySprite.visible = false;
    const previewVisible = this.previewContainer.visible;
    this.previewContainer.visible = false;

    try {
      if (totalCold <= 2400 && this.reader) {
        const rt = this.ensureComposite();
        const clearColor = includeBackground ? this.parseCssColorRgba(this.lastBgColor) : [0, 0, 0, 0];
        this.withAllTilesVisible(() => {
          this.renderer.render({ container: this.layersContainer, target: rt, clear: true, clearColor });
        }, true);
        this.pendingReadCount++;
        try {
          const [pixels] = await this.reader(rt, [{ x: 0, y: 0, w, h }]);
          return pixels;
        } finally {
          this.pendingReadCount = Math.max(0, this.pendingReadCount - 1);
          if (releaseCompositeAfter && this.compositeRT === rt) {
            this.compositeRT.destroy(true);
            this.compositeRT = null;
          }
        }
      }

      // Massive multi-layer fallback: 2D offscreen composite, premultiply straight RGBA, and immediately free canvas
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d')!;
      if (includeBackground) {
        ctx.fillStyle = this.lastBgColor;
        ctx.fillRect(0, 0, w, h);
      }
      const ordered = [...this.layersMap.values()]
        .filter((i) => i.shown && i.model.layerType !== 'group' && i.model.layerType !== 'mask')
        .sort((a, b) => a.model.sortOrder - b.model.sortOrder);
      for (const item of ordered) {
        const lc = this.layerToCanvas(item.model.id);
        if (!lc) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, item.display.alpha));
        const rt = (item.model as LayerModel & { renderTransform?: Affine2D }).renderTransform;
        if (rt && !rt.isIdentity) ctx.transform(rt.a, rt.b, rt.c, rt.d, rt.tx, rt.ty);
        ctx.drawImage(lc, 0, 0);
        ctx.restore();
      }
      const raw = ctx.getImageData(0, 0, w, h).data;
      out.width = 0;
      out.height = 0;
      const premul = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 4) {
        const a = raw[i + 3];
        if (!a) continue;
        if (a === 255) {
          premul[i] = raw[i];
          premul[i + 1] = raw[i + 1];
          premul[i + 2] = raw[i + 2];
          premul[i + 3] = 255;
        } else {
          premul[i] = ((raw[i] * a + 127) / 255) | 0;
          premul[i + 1] = ((raw[i + 1] * a + 127) / 255) | 0;
          premul[i + 2] = ((raw[i + 2] * a + 127) / 255) | 0;
          premul[i + 3] = a;
        }
      }
      return premul;
    } finally {
      this.previewContainer.visible = previewVisible;
      if (this.filterOverlaySprite) this.filterOverlaySprite.visible = overlayPrev;
    }
  }

  private ensureComposite(): RenderTexture {
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    this.compositeUsed = performance.now();
    if (!this.compositeRT || this.compositeRT.width !== w || this.compositeRT.height !== h) {
      this.compositeRT?.destroy(true);
      this.compositeRT = RenderTexture.create({ width: w, height: h, resolution: 1 });
    }
    return this.compositeRT;
  }

  /**
   * All visible layers composited into one canvas-sized texture, for flood fill / color picking
   * (freed when idle). Live previews are not part of it.
   */
  public getCompositeTexture(includeBackground = false): RenderTexture {
    this.updateAdjustmentScopes(true); // whole-canvas scope composites for adjustment layers
    const target = this.ensureComposite();
    const previewVisible = this.previewContainer.visible;
    const overlayVisible = this.filterOverlaySprite?.visible ?? false;
    this.previewContainer.visible = false;
    if (this.filterOverlaySprite) this.filterOverlaySprite.visible = false;
    let totalCold = 0;
    for (const item of this.layersMap.values()) if (item.shown) totalCold += item.coldTiles.size;
    try {
      if (totalCold > FULL_COMPOSITE_COLD_LIMIT && !this.adjustmentOrder.length && !this.groupEffectContainers.size) {
        this.withAllTilesVisible(() => this.renderLargeComposite(target, includeBackground));
      } else {
        this.withAllTilesVisible(() => {
          this.renderer.render({
            container: includeBackground ? this.rootContainer : this.layersContainer,
            target,
            clear: true,
            clearColor: [0, 0, 0, 0],
          });
        }, true);
      }
    } finally {
      this.previewContainer.visible = previewVisible;
      if (this.filterOverlaySprite) this.filterOverlaySprite.visible = overlayVisible;
    }
    return target;
  }

  /** Stream cold tiles one layer at a time into a full-resolution composite. */
  private renderLargeComposite(target: RenderTexture, includeBackground: boolean) {
    const items = [...this.layersMap.values()].filter((item) => item.shown && item.display.renderable);
    items.sort((a, b) => a.display.zIndex - b.display.zIndex);
    const backgroundRenderable = this.backgroundGraphic.renderable;
    for (const item of items) item.display.renderable = false;
    try {
      this.renderer.render({
        container: includeBackground ? this.rootContainer : this.layersContainer,
        target, clear: true, clearColor: [0, 0, 0, 0],
      });
      this.backgroundGraphic.renderable = false;
      for (const item of items) {
        const temporary: Array<[string, CpuTile, GpuTile]> = [];
        item.display.renderable = true;
        try {
          for (const [key, cpu] of item.coldTiles) {
            const [col, row] = key.split('_').map(Number);
            const raw = decodeTile(cpu, SCRATCH);
            if (!raw || isEmpty(raw)) continue;
            const tile = this.uploadColdTile(item, key, col, row, cpu, raw);
            temporary.push([key, cpu, tile]);
          }
          this.renderer.render({ container: includeBackground ? this.rootContainer : this.layersContainer, target, clear: false });
        } finally {
          item.display.renderable = false;
          for (const [key, cpu, tile] of temporary) {
            if (item.cleanCache.get(key) === cpu) item.cleanCache.delete(key);
            item.gpu?.delete(key);
            this.freeTile(tile);
          }
        }
      }
    } finally {
      this.backgroundGraphic.renderable = backgroundRenderable;
      for (const item of items) item.display.renderable = true;
    }
  }

  /** True while the local user has an active stroke or drew within the last 650ms */
  public isActivelyDrawing(recentMs = 650): boolean {
    if (this.lastLocalDrawAt > 0 && performance.now() - this.lastLocalDrawAt < recentMs) return true;
    for (const l of this.layersMap.values()) {
      if ((l.bak?.size ?? 0) > 0) return true;
    }
    return false;
  }

  /**
   * A small preview of one layer as a data URL. Cached until the layer's pixels change; a cold
   * layer (tiles only on the CPU) is decoded when the page is idle and reported via onThumbnail.
   */
  public getLayerThumbnail(layerId: string, thumbWidth = 48, thumbHeight = 48, fromRemote = false): string | null {
    const item = this.layersMap.get(layerId);
    // Adjustment layers have no pixels: the layer panel shows their kind's icon
    if (!item || item.adjust) return null;
    if (item.thumb?.version === item.version) return item.thumb.url;
    if (!item.rt && !item.gpu && !item.cpu?.size && !item.coldTiles.size) {
      item.thumb = { version: item.version, url: '' };
      return null;
    }
    const local = !fromRemote || layerId === this.activeId;
    const prev = this.thumbQueue.get(layerId);
    // Always render thumbnails asynchronously on the queue so WebSocket/op handlers and active drawing never block
    this.thumbQueue.set(layerId, { w: thumbWidth, h: thumbHeight, local: Boolean(prev?.local || local) });
    if (!this.thumbTimer && !this.thumbsPaused) {
      const elapsed = this.lastLocalDrawAt > 0 ? performance.now() - this.lastLocalDrawAt : Infinity;
      const waitMs = local
        ? (elapsed < 650 ? Math.max(250, 650 - elapsed) : 60)
        : Math.max(45, 450 - (performance.now() - this.lastRemoteThumbExtractAt));
      this.thumbTimer = setTimeout(this.drainThumbs, waitMs);
    }
    return item.thumb?.url || null;
  }

  private publishThumb(id: string, item: LayerItem, version: number, url: string) {
    if (item.thumb && item.thumb.version > version) {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
        this.thumbBlobUrls.delete(url);
      }
      return;
    }
    const old = item.thumb?.url;
    item.thumb = { version, url };
    this.onThumbnail?.(id, url);
    if (old && old.startsWith('blob:') && old !== url) {
      setTimeout(() => {
        URL.revokeObjectURL(old);
        this.thumbBlobUrls.delete(old);
      }, 2000);
    }
  }

  /** Pauses background layer thumbnail generation (e.g., while playing an animation) to keep frame times flat */
  public setThumbnailsPaused(paused: boolean) {
    this.thumbsPaused = paused;
    if (paused && this.thumbTimer) {
      clearTimeout(this.thumbTimer);
      this.thumbTimer = null;
    }
    if (!paused && this.thumbQueue.size > 0 && !this.thumbTimer && !this.destroyed) {
      this.thumbTimer = setTimeout(this.drainThumbs, 60);
    }
  }

  private drainThumbs = () => {
    this.thumbTimer = null;
    if (this.destroyed) return;
    if (this.thumbsPaused) return;
    const now = performance.now();
    // Pick a local/active item first so user feedback stays snappy while remote thumbs yield
    let picked: [string, { w: number; h: number; local: boolean }] | undefined;
    for (const entry of this.thumbQueue) {
      if (entry[1].local) {
        picked = entry;
        break;
      }
      if (!picked) picked = entry;
    }
    if (picked) {
      if (!picked[1].local) {
        const busy =
          now - this.lastLocalDrawAt < 1000 ||
          now - this.lastInteractionAt < 900 ||
          this.pendingReadCount > 0 ||
          [...this.layersMap.values()].some((l) => (l.bak?.size ?? 0) > 0);
        const cooldown = busy ? 600 : 6000 - (now - this.lastRemoteThumbExtractAt);
        if (cooldown > 10) {
          this.thumbTimer = setTimeout(this.drainThumbs, cooldown);
          return;
        }
      } else if (this.isActivelyDrawing() || now - this.lastInteractionAt < 900 || this.pendingReadCount > 0) {
        this.thumbTimer = setTimeout(this.drainThumbs, 350);
        return;
      }
      const [id, size] = picked;
      this.thumbQueue.delete(id);
      const item = this.layersMap.get(id);
      if (item && item.thumb?.version !== item.version) {
        const version = item.version;
        if (!size.local) this.lastRemoteThumbExtractAt = now;
        void this.renderThumbAsync(item, size.w, size.h).then((canvas) => {
          if (!canvas || this.destroyed || this.layersMap.get(id) !== item) return;
          if (typeof canvas.toBlob === 'function') {
            canvas.toBlob((blob) => {
              if (this.destroyed || !blob || this.layersMap.get(id) !== item) return;
              const url = URL.createObjectURL(blob);
              this.thumbBlobUrls.add(url);
              this.publishThumb(id, item, version, url);
            }, 'image/webp', 0.8);
          } else {
            const url = canvas.toDataURL('image/webp', 0.8) || canvas.toDataURL('image/png');
            if (url) this.publishThumb(id, item, version, url);
          }
        });
      }
    }
    if (this.thumbQueue.size) {
      let hasLocal = false;
      for (const v of this.thumbQueue.values()) {
        if (v.local) { hasLocal = true; break; }
      }
      this.thumbTimer = setTimeout(this.drainThumbs, hasLocal ? 20 : 6000);
    }
  };

  /** Populates a scaled container with all active/cold tiles of `item` for thumbnail generation */
  private populateThumbContainer(
    item: LayerItem,
    holder: Container,
    temporary: Texture[],
    thumbWidth: number,
    thumbHeight: number
  ) {
    holder.scale.set(thumbWidth / this.canvasWidth, thumbHeight / this.canvasHeight);
    if (item.rt) {
      holder.addChild(new Sprite(item.rt));
      return;
    }
    const pushCpuTiles = (entries: Iterable<[string, CpuTile]>, count: number) => {
      if (count <= 0) return;
      if (count > 64 && typeof document !== 'undefined') {
        // Rasterize large offscreen CPU tile sets into one 2D canvas to avoid creating hundreds of GPU textures
        const c = this.rasterizeCpuTilesToCanvas(entries, thumbWidth, thumbHeight);
        if (c) {
          const tex = new Texture({ source: new CanvasSource({ resource: c }) });
          temporary.push(tex);
          const sp = new Sprite(tex);
          sp.scale.set(this.canvasWidth / thumbWidth, this.canvasHeight / thumbHeight);
          holder.addChild(sp);
          return;
        }
      }
      for (const [key, t] of entries) {
        const raw = decodeTile(t);
        if (!raw || isEmpty(raw)) continue;
        const [col, row] = key.split('_').map(Number);
        const tex = new Texture({
          source: new BufferImageSource({ resource: raw, width: t.w, height: t.h, format: 'rgba8unorm', alphaMode: 'premultiplied-alpha' }),
        });
        temporary.push(tex);
        const s = new Sprite(tex);
        s.position.set(col * TS, row * TS);
        holder.addChild(s);
      }
    };
    if (item.gpu) {
      if (item.coldTiles.size > 0) pushCpuTiles(item.coldTiles, item.coldTiles.size);
      for (const t of item.gpu.values()) {
        const s = new Sprite(t.sprite.texture);
        s.position.copyFrom(t.sprite.position);
        holder.addChild(s);
      }
    } else if (item.cpu) {
      pushCpuTiles(item.cpu, item.cpu.size);
    }
  }

  /** The layer drawn at thumbnail size into `target` (whichever form the layer is in) */
  private drawThumb(item: LayerItem, target: RenderTexture, thumbWidth: number, thumbHeight: number) {
    const holder = new Container();
    const temporary: Texture[] = [];
    this.populateThumbContainer(item, holder, temporary, thumbWidth, thumbHeight);
    this.renderer.render({ container: holder, target, clear: true, clearColor: [0, 0, 0, 0] });
    holder.destroy({ children: true });
    temporary.forEach((t) => t.destroy(true));
  }

  /**
   * The thumbnail read back without stalling the page: a synchronous extract waited for the GPU to
   * finish everything queued (the stroke just committed, its read-backs) and made the frame after
   * each pen-up on a big canvas 20–35 ms. Falls back to the synchronous path without a reader.
   */
  /** Pure CPU 2D thumbnail rasterizer for CPU tiles: 0 texImage2D, 0 readPixels */
  private rasterizeCpuTilesToCanvas(
    entries: Iterable<[string, CpuTile]>,
    thumbWidth: number,
    thumbHeight: number
  ): HTMLCanvasElement | null {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = thumbWidth;
    c.height = thumbHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return c;
    const img = ctx.createImageData(thumbWidth, thumbHeight);
    const dst = img.data;
    const sx = thumbWidth / this.canvasWidth;
    const sy = thumbHeight / this.canvasHeight;
    const stepY = Math.max(1, Math.floor(1 / sy));
    const stepX = Math.max(1, Math.floor(1 / sx));
    for (const [key, t] of entries) {
      const raw = decodeTile(t, SCRATCH);
      if (!raw || isEmpty(raw)) continue;
      const [col, row] = key.split('_').map(Number);
      const tx = col * TS;
      const ty = row * TS;
      const px0 = Math.max(0, Math.floor(tx * sx));
      const py0 = Math.max(0, Math.floor(ty * sy));
      const px1 = Math.min(thumbWidth, Math.ceil((tx + t.w) * sx));
      const py1 = Math.min(thumbHeight, Math.ceil((ty + t.h) * sy));
      for (let py = py0; py < py1; py++) {
        const ly = Math.min(t.h - 1, Math.max(0, Math.floor(py / sy - ty + stepY * 0.25)));
        for (let px = px0; px < px1; px++) {
          const lx = Math.min(t.w - 1, Math.max(0, Math.floor(px / sx - tx + stepX * 0.25)));
          const si = (ly * t.w + lx) * 4;
          const a = raw[si + 3];
          if (!a) continue;
          const di = (py * thumbWidth + px) * 4;
          const k = 255 / a;
          dst[di] = Math.min(255, Math.round(raw[si] * k));
          dst[di + 1] = Math.min(255, Math.round(raw[si + 1] * k));
          dst[di + 2] = Math.min(255, Math.round(raw[si + 2] * k));
          dst[di + 3] = a;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  private renderThumbAsync(item: LayerItem, thumbWidth: number, thumbHeight: number): Promise<HTMLCanvasElement | null> {
    this.deactivateStackCache();
    if (!item.rt && !item.gpu && item.cpu) {
      return Promise.resolve(this.rasterizeCpuTilesToCanvas(item.cpu, thumbWidth, thumbHeight));
    }
    const reader = this.reader;
    if (!reader) return Promise.resolve(this.renderThumbCanvas(item, thumbWidth, thumbHeight));
    let rt: RenderTexture | null = null;
    try {
      rt = RenderTexture.create({ width: thumbWidth, height: thumbHeight, resolution: 1 });
      this.drawThumb(item, rt, thumbWidth, thumbHeight);
      const read = reader(rt, [{ x: 0, y: 0, w: thumbWidth, h: thumbHeight }]);
      const own = rt;
      return read
        .then(([px]) => {
          own.destroy(true);
          if (typeof document === 'undefined') return null;
          const out = new Uint8ClampedArray(thumbWidth * thumbHeight * 4);
          for (let i = 0; i < out.length; i += 4) {
            const a = px[i + 3];
            if (!a) continue;
            out[i] = Math.min(255, Math.round((px[i] * 255) / a));
            out[i + 1] = Math.min(255, Math.round((px[i + 1] * 255) / a));
            out[i + 2] = Math.min(255, Math.round((px[i + 2] * 255) / a));
            out[i + 3] = a;
          }
          const canvas = document.createElement('canvas');
          canvas.width = thumbWidth;
          canvas.height = thumbHeight;
          canvas.getContext('2d', { willReadFrequently: true })?.putImageData(new ImageData(out, thumbWidth, thumbHeight), 0, 0);
          return canvas;
        })
        .catch((err) => {
          console.warn('[LayerManager] Thumbnail read error:', err);
          if (!own.destroyed) own.destroy(true);
          return null;
        });
    } catch (err) {
      console.warn('[LayerManager] Thumbnail generation error:', err);
      rt?.destroy(true);
      return Promise.resolve(null);
    }
  }

  /** Fast WebGL downsample of the layer (whichever form it is in) straight to the thumbnail size */
  private renderThumbCanvas(item: LayerItem, thumbWidth: number, thumbHeight: number): HTMLCanvasElement | null {
    try {
      if (!this.thumbRT) {
        this.thumbRT = RenderTexture.create({ width: thumbWidth, height: thumbHeight });
      }
      const holder = new Container();
      const temporary: Texture[] = [];
      this.populateThumbContainer(item, holder, temporary, thumbWidth, thumbHeight);
      this.renderer.render({ container: holder, target: this.thumbRT, clear: true, clearColor: [0, 0, 0, 0] });
      holder.destroy({ children: true });
      temporary.forEach((t) => t.destroy(true));

      const extracted = this.renderer.extract.canvas({
        target: this.thumbRT,
      });

      let realCanvas: HTMLCanvasElement;
      if (typeof HTMLCanvasElement !== 'undefined' && extracted instanceof HTMLCanvasElement) {
        realCanvas = extracted;
      } else {
        realCanvas = document.createElement('canvas');
        realCanvas.width = thumbWidth;
        realCanvas.height = thumbHeight;
        const ctx = realCanvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(extracted as any, 0, 0);
        }
      }

      return realCanvas;
    } catch (err) {
      console.warn('[LayerManager] Thumbnail generation error:', err);
      return null;
    }
  }

  /**
   * The whole layer as a 2D canvas (straight alpha) for export, without making a sparse layer
   * resident: ten sparse 10000×8000 layers exported one by one never need ten full textures.
   */
  public layerToCanvas(layerId: string): HTMLCanvasElement | null {
    const item = this.layersMap.get(layerId);
    if (!item || item.adjust) return null;
    const canvas = document.createElement('canvas');
    canvas.width = this.canvasWidth;
    canvas.height = this.canvasHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const put = (x: number, y: number, w: number, h: number, px: Uint8Array) => {
      const img = ctx.createImageData(w, h);
      const dst = img.data; // clamps and rounds the divisions
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3];
        if (!a) continue;
        const k = 255 / a;
        dst[i] = px[i] * k;
        dst[i + 1] = px[i + 1] * k;
        dst[i + 2] = px[i + 2] * k;
        dst[i + 3] = a;
      }
      ctx.putImageData(img, x, y);
    };
    if (item.rt) {
      for (let y = 0; y < this.canvasHeight; y += TS) {
        const h = Math.min(TS, this.canvasHeight - y);
        put(0, y, this.canvasWidth, h, this.read(item.rt, 0, y, this.canvasWidth, h));
      }
    } else if (item.gpu) {
      for (const [key, t] of item.coldTiles) {
        const raw = decodeTile(t);
        if (!raw || isEmpty(raw)) continue;
        const [col, row] = key.split('_').map(Number);
        put(col * TS, row * TS, t.w, t.h, raw);
      }
      for (const t of item.gpu.values()) put(t.sprite.x, t.sprite.y, t.w, t.h, this.read(this.atlas.texture(t.slot), t.slot.x, t.slot.y, t.w, t.h));
    } else {
      for (const [key, t] of item.cpu ?? []) {
        const raw = decodeTile(t);
        if (!raw || isEmpty(raw)) continue;
        const [col, row] = key.split('_').map(Number);
        put(col * TS, row * TS, t.w, t.h, raw);
      }
    }
    return canvas;
  }

  public clearLayer(layerId: string) {
    const item = this.layersMap.get(layerId);
    if (!item) return;
    this.flushPendingReads();
    item.version++;
    if (item.rt) {
      this.clearTexture(item.rt);
      if (item.pp) this.clearTexture(item.pp);
      if (item.shown) this.onStageChange?.();
      return;
    }
    this.dropGpuTiles(item);
    item.coldTiles.clear();
    item.cpu = new Map();
    if (item.shown || this.keepWarm(item)) this.thaw(item);
    else this.rebuildDisplay(item);
  }

  /**
   * getCanvasThumbnail read back without stalling the page (the synchronous extract waited for the
   * GPU to finish all queued work: a long frame a second after each stroke on a big canvas)
   */
  public getCanvasThumbnailAsync(maxSide = 220): Promise<string | null> {
    this.updateAdjustmentScopes(true); // whole-canvas scope composites for adjustment layers
    const reader = this.reader;
    if (!reader || typeof document === 'undefined') return Promise.resolve(this.getCanvasThumbnail(maxSide));
    const previewVisible = this.previewContainer.visible;
    let small: RenderTexture | null = null;
    try {
      const w = this.canvasWidth;
      const h = this.canvasHeight;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      small = RenderTexture.create({ width: tw, height: th, resolution: 1 });
      this.previewContainer.visible = false;
      this.withAllTilesVisible(() => {
        this.renderer.render({ container: this.rootContainer, target: small!, clear: true, clearColor: [0, 0, 0, 0], transform: new Matrix().scale(scale, scale) });
      });
      const own = small;
      const read = reader(own, [{ x: 0, y: 0, w: tw, h: th }]);
      return read
        .then(([px]) => {
          own.destroy(true);
          // The background is opaque, so premultiplied = straight here; un-premultiply anyway for safety
          const out = new Uint8ClampedArray(tw * th * 4);
          for (let i = 0; i < out.length; i += 4) {
            const a = px[i + 3];
            if (!a) continue;
            out[i] = Math.min(255, Math.round((px[i] * 255) / a));
            out[i + 1] = Math.min(255, Math.round((px[i + 1] * 255) / a));
            out[i + 2] = Math.min(255, Math.round((px[i + 2] * 255) / a));
            out[i + 3] = a;
          }
          const c = document.createElement('canvas');
          c.width = tw;
          c.height = th;
          c.getContext('2d', { willReadFrequently: true })?.putImageData(new ImageData(out, tw, th), 0, 0);
          return c.toDataURL('image/jpeg', 0.82);
        })
        .catch((err) => {
          console.warn('[LayerManager] Canvas thumbnail failed:', err);
          if (!own.destroyed) own.destroy(true);
          return null;
        });
    } catch (err) {
      console.warn('[LayerManager] Canvas thumbnail failed:', err);
      small?.destroy(true);
      return Promise.resolve(null);
    } finally {
      this.previewContainer.visible = previewVisible;
    }
  }

  /** Small JPEG of the whole canvas (background + visible layers) for the canvas switcher. */
  public getCanvasThumbnail(maxSide = 220): string | null {
    this.updateAdjustmentScopes(true); // whole-canvas scope composites for adjustment layers
    const previewVisible = this.previewContainer.visible;
    try {
      const w = this.canvasWidth;
      const h = this.canvasHeight;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      // Drawn straight at thumbnail size: a canvas-sized intermediate is 305 MB at 10000×8000
      const small = RenderTexture.create({ width: tw, height: th, resolution: 1 });
      // Live remote-stroke previews are not part of the picture
      this.previewContainer.visible = false;
      this.withAllTilesVisible(() => {
        this.renderer.render({ container: this.rootContainer, target: small, clear: true, clearColor: [0, 0, 0, 0], transform: new Matrix().scale(scale, scale) });
      });
      const out = this.renderer.extract.canvas({ target: small }) as HTMLCanvasElement;
      const url = out.toDataURL('image/jpeg', 0.82);
      small.destroy(true);
      return url;
    } catch (err) {
      console.warn('[LayerManager] Canvas thumbnail failed:', err);
      return null;
    } finally {
      this.previewContainer.visible = previewVisible;
    }
  }

  /**
   * Low-resolution premultiplied RGBA pixels of either one layer or the visible composite,
   * drawn directly at thumbnail scale (<= 96×96 ≈ 36 KB) so the Filter Library never allocates
   * a full-canvas buffer even on 10000×8000 canvases.
   */
  public async readFilterThumbnailPixels(
    layerId: string | null,
    includeBackground = false,
    maxSide = 96,
  ): Promise<{ pixels: Uint8Array; width: number; height: number; origWidth: number; origHeight: number } | null> {
    this.updateAdjustmentScopes(true);
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    if (w <= 0 || h <= 0) return null;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const small = RenderTexture.create({ width: tw, height: th, resolution: 1 });
    const previewVisible = this.previewContainer.visible;
    const overlayVisible = this.filterOverlaySprite?.visible ?? false;
    this.previewContainer.visible = false;
    if (this.filterOverlaySprite) this.filterOverlaySprite.visible = false;
    try {
      const clearColor = includeBackground ? this.parseCssColorRgba(this.lastBgColor) : [0, 0, 0, 0];
      const item = layerId ? this.layersMap.get(layerId) : null;
      if (item) {
        const holder = new Container();
        const temporary: Texture[] = [];
        this.populateThumbContainer(item, holder, temporary, tw, th);
        this.renderer.render({ container: holder, target: small, clear: true, clearColor });
        holder.destroy({ children: true });
        temporary.forEach((t) => t.destroy(true));
      } else {
        this.withAllTilesVisible(() => {
          this.renderer.render({
            container: this.layersContainer,
            target: small,
            clear: true,
            clearColor,
            transform: new Matrix().scale(scale, scale),
          });
        });
      }
      if (this.reader) {
        const [pixels] = await this.reader(small, [{ x: 0, y: 0, w: tw, h: th }]);
        return { pixels, width: tw, height: th, origWidth: w, origHeight: h };
      }
      const extracted = this.renderer.extract.canvas({ target: small }) as HTMLCanvasElement;
      const ctx = extracted.getContext('2d');
      if (!ctx) return null;
      const raw = ctx.getImageData(0, 0, tw, th).data;
      const premul = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 4) {
        const a = raw[i + 3];
        if (!a) continue;
        if (a === 255) {
          premul[i] = raw[i]; premul[i + 1] = raw[i + 1]; premul[i + 2] = raw[i + 2]; premul[i + 3] = 255;
        } else {
          premul[i] = ((raw[i] * a + 127) / 255) | 0;
          premul[i + 1] = ((raw[i + 1] * a + 127) / 255) | 0;
          premul[i + 2] = ((raw[i + 2] * a + 127) / 255) | 0;
          premul[i + 3] = a;
        }
      }
      return { pixels: premul, width: tw, height: th, origWidth: w, origHeight: h };
    } catch (err) {
      console.warn('[LayerManager] Filter thumbnail read failed:', err);
      return null;
    } finally {
      this.previewContainer.visible = previewVisible;
      if (this.filterOverlaySprite) this.filterOverlaySprite.visible = overlayVisible;
      small.destroy(true);
    }
  }

  /** Full-size picture as shown (background, masks, current animation frames), for GIF / video / sequence / cel export */
  public renderCompositeCanvas(options?: { transparent?: boolean }): HTMLCanvasElement {
    this.updateAdjustmentScopes(true); // whole-canvas scope composites for adjustment layers
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    let totalCold = 0;
    for (const item of this.layersMap.values()) {
      if (item.shown || item.model.layerType === 'mask') totalCold += item.coldTiles.size;
    }
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d')!;
    if (!options?.transparent) {
      ctx.fillStyle = this.lastBgColor;
      ctx.fillRect(0, 0, w, h);
    }

    if (totalCold > 2400) {
      // Massive multi-layer offscreen fallback: composite visible layers via 2D canvas without overflowing GPU atlas
      const ordered = [...this.layersMap.values()]
        .filter((i) => i.shown && i.model.layerType !== 'group' && i.model.layerType !== 'mask')
        .sort((a, b) => a.model.sortOrder - b.model.sortOrder);
      for (const item of ordered) {
        const lc = this.layerToCanvas(item.model.id);
        if (!lc) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, item.display.alpha));
        const rt = (item.model as LayerModel & { renderTransform?: Affine2D }).renderTransform;
        if (rt && !rt.isIdentity) ctx.transform(rt.a, rt.b, rt.c, rt.d, rt.tx, rt.ty);
        ctx.drawImage(lc, 0, 0);
        ctx.restore();
      }
      return out;
    }

    const rt = this.ensureComposite();
    const overlayVisible = this.filterOverlaySprite?.visible ?? false;
    if (this.filterOverlaySprite) this.filterOverlaySprite.visible = false;
    // Layers only: the paper graphic carries a shadow and a border line that are not the picture
    this.withAllTilesVisible(() => {
      this.renderer.render({ container: this.layersContainer, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    }, true);
    if (this.filterOverlaySprite) this.filterOverlaySprite.visible = overlayVisible;
    const layersCanvas = this.renderer.extract.canvas({ target: rt }) as HTMLCanvasElement;
    ctx.drawImage(layersCanvas, 0, 0);
    return out;
  }

  private destroyItem(item: LayerItem) {
    this.flushPendingReads();
    if (this.job?.item === item) this.abortJob();
    item.destroyed = true;
    item.coldTiles.clear();
    item.cleanCache.clear();
    item.display.parent?.removeChild(item.display);
    item.maskFilters?.forEach((f) => f.destroy());
    item.layerColorFilter?.destroy();
    item.layerEffectsFilter?.destroy();
    item.blendFilter?.filter.destroy();
    if (item.adjust) {
      item.display.filters = null;
      this.releaseAdjustmentScope(item.adjust);
      item.adjust.filter.destroy();
      item.adjust = null;
    }
    item.rt?.destroy(true);
    item.pp?.destroy(true);
    item.rt = null;
    item.pp = null;
    this.dropGpuTiles(item);
    const held = this.heldBakSlots.get(item.model.id);
    if (held) {
      for (const s of held) this.atlas.free(s);
      this.heldBakSlots.delete(item.model.id);
    }
    this.pendingBakReads.delete(item.model.id);
    const heldAfter = this.heldAfterSlots.get(item.model.id);
    if (heldAfter) {
      for (const s of heldAfter) this.atlas.free(s);
      this.heldAfterSlots.delete(item.model.id);
    }
    this.pendingAfterSlots.delete(item.model.id);
    item.cpu = null;
    item.display.destroy({ children: true });
  }

  public destroy() {
    this.flushPendingReads();
    this.destroyed = true;
    this.hydrateEpoch++;
    if (this.hydrateRaf) cancelAnimationFrame(this.hydrateRaf);
    this.hydrateRaf = 0;
    if (this.hydrateTimer !== null) clearTimeout(this.hydrateTimer);
    this.hydrateTimer = null;
    this.hydrateInFlight = false;
    if (this.sharpMipTimer) clearTimeout(this.sharpMipTimer);
    this.releaseStackCache();
    this.releaseWrapAroundView();
    clearInterval(this.tickTimer);
    if (this.thumbTimer) clearTimeout(this.thumbTimer);
    for (const url of this.thumbBlobUrls) URL.revokeObjectURL(url);
    this.thumbBlobUrls.clear();
    this.abortJob();
    this.setFilterOverlay(null);
    this.compositeRT?.destroy(true);
    this.compositeRT = null;
    this.thumbRT?.destroy(true);
    for (const item of this.layersMap.values()) this.destroyItem(item);
    this.layersMap.clear();
    this.previewParticlePool = [];
    for (const e of this.previewPainters.values()) {
      e.container.particleChildren.length = 0;
      e.container.destroy();
    }
    this.previewPainters.clear();
    this.dropGpuTiles(this.preview);
    this.heldBakSlots.clear();
    this.pendingBakReads.clear();
    this.heldAfterSlots.clear();
    this.pendingAfterSlots.clear();
    this.pendingReadCount = 0;
    this.mips.destroy();
    this.atlas.destroy();
    this.paperCheckerGraphic?.destroy({ texture: true, textureSource: true });
    this.paperCheckerGraphic = null;
    this.rootContainer.destroy({ children: true });
  }

  private createScreentoneFilter(density: number, angleRad: number, dotScale: number): Filter {
    const fragShader = `#version 300 es
      precision highp float;
      in vec2 vTextureCoord;
      out vec4 finalColor;
      uniform sampler2D uTexture;
      uniform vec2 uResolution;
      uniform float uDensity;
      uniform float uAngle;
      uniform float uDotScale;

      void main() {
          vec4 sampleCol = texture(uTexture, vTextureCoord);
          if (sampleCol.a <= 0.001) {
              finalColor = vec4(0.0);
              return;
          }

          vec2 p = vTextureCoord * uResolution;
          float cosA = cos(uAngle);
          float sinA = sin(uAngle);
          mat2 rot = mat2(cosA, -sinA, sinA, cosA);
          vec2 rotP = rot * p;

          float cellSize = max(2.0, uResolution.x / max(1.0, uDensity));
          vec2 cellId = floor(rotP / cellSize);
          vec2 cellCoord = fract(rotP / cellSize) - vec2(0.5);

          // Calculate perceptual luminance
          float lum = dot(sampleCol.rgb, vec3(0.299, 0.587, 0.114));
          float maxRadius = 0.5 * clamp(uDotScale, 0.5, 1.8);
          float dotRadius = maxRadius * sqrt(clamp(1.0 - lum, 0.0, 1.0));

          float dist = length(cellCoord);
          float edgeSmooth = fwidth(dist) * 1.5;
          float dotAlpha = smoothstep(dotRadius + edgeSmooth, dotRadius - edgeSmooth, dist);

          // Halftone dots: Preserve original color, modulate opacity/density
          finalColor = vec4(sampleCol.rgb, sampleCol.a * dotAlpha);
      }
    `;

    return Filter.from({
      gl: {
        vertex: defaultFilterVert,
        fragment: fragShader,
      },
      resources: {
        screentoneUniforms: {
          uResolution: { value: [this.canvasWidth, this.canvasHeight], type: 'vec2<f32>' },
          uDensity: { value: density, type: 'f32' },
          uAngle: { value: angleRad, type: 'f32' },
          uDotScale: { value: dotScale, type: 'f32' },
        },
      },
    });
  }

  public mapPixiBlendMode(blendMode: BlendMode): any {
    const normalized = blendMode.toLowerCase().replace(/_/g, '-');
    switch (normalized) {
      case 'multiply':
        return 'multiply';
      case 'screen':
        return 'screen';
      case 'overlay':
        return 'overlay';
      case 'darken':
        return 'darken';
      case 'lighten':
        return 'lighten';
      case 'color-dodge':
        return 'color-dodge';
      case 'color-burn':
        return 'color-burn';
      case 'hard-light':
        return 'hard-light';
      case 'soft-light':
        return 'soft-light';
      case 'difference':
        return 'difference';
      case 'exclusion':
        return 'exclusion';
      case 'add':
      case 'linear-dodge':
      case 'glow':
        return 'add';
      case 'linear-burn':
        return 'multiply';
      case 'vivid-light':
      case 'linear-light':
        return 'hard-light';
      case 'pin-light':
      case 'hard-mix':
        return 'overlay';
      case 'subtract':
        return 'subtract';
      case 'divide':
        return 'screen';
      case 'erase':
        return 'erase';
      default:
        return 'normal';
    }
  }
}
