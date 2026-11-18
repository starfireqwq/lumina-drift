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
import { compressTileBuffer, decompressTileBuffer, DEFAULT_TILE_SIZE, type Affine2D, type BlendMode, type LayerModel, type TileCoord, type TileData } from '@atelier/shared';
import { normalizeTileBytes } from './TileEngine';
import { applyMagFilter, TileAtlas, type MagFilter, type Slot } from './TileAtlas';
import { decodeTiles } from './commitWorkers';

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
  draw(container: Container, x: number, y: number, w: number, h: number): void;
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
/** Main-thread time one background step (parking / freezing a layer) may take */
const STEP_BUDGET_MS = 6;
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
interface GpuTile { slot: Slot; sprite: Sprite; w: number; h: number; lastSeenMs?: number }
interface CpuTile { data: Uint8Array; compression: 'lz4' | 'raw'; w: number; h: number }

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
  /** The atlas page this layer last got a slot from: its next tiles go there first (fewer textures per layer) */
  lastPage = -1;
  /** Its cold tiles are being decoded in a worker (prefetch) */
  decoding = false;
  lastUsed = performance.now();
  lastShown = 0;
  /** Bumps on anything that may change the pixels (thumbnail cache, background jobs) */
  version = 0;
  shown = false;
  hasAnimatedTransform = false;
  destroyed = false;
  thumb: { version: number; url: string } | null = null;
  screentoneFilter?: Filter | null;
  onionFilter?: Filter | null;
  maskFilters?: Map<string, MaskFilter>;
  /** On a layer with filters, the filter that does its blend mode (see syncLayers) */
  blendFilter: { mode: string; filter: Filter } | null = null;

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
  | { kind: 'park'; item: LayerItem; version: number; next: number; tiles: Map<string, GpuTile> }
  | { kind: 'freeze'; item: LayerItem; version: number; next: number; keys: string[]; tiles: Map<string, CpuTile> };

export class LayerManager {
  public rootContainer: Container;
  public layersContainer: Container;
  public previewContainer: Container;
  public backgroundGraphic: Graphics;
  /** A thumbnail that had to wait (a cold layer's tiles are decoded when the page is idle) */
  public onThumbnail: ((layerId: string, url: string) => void) | null = null;

  private renderer: Renderer;
  private canvasWidth: number;
  private canvasHeight: number;
  private cols: number;
  private rows: number;
  private lastBgColor: string = '#FFFFFF';
  private layersMap = new Map<string, LayerItem>();
  private emptyContainer = new Container();
  private atlas: TileAtlas;
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

  /** Live previews (other painters' strokes in progress, text being typed): sparse like a layer */
  private preview: LayerItem;
  private previewPainters = new Map<string, { container: ParticleContainer<Particle>; lastAt: number }>();
  private previewParticlePool: Particle[] = [];
  private thumbBlobUrls = new Set<string>();
  private viewBounds: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private cullSuspended = 0;
  private tileStructureVersion = 0;
  private lastViewGridKey = '';
  private evictingOffscreen = false;
  private thumbsPaused = false;
  private destroyed = false;

  constructor(renderer: Renderer, width: number, height: number, bgColor: string = '#FFFFFF') {
    this.renderer = renderer;
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.cols = Math.ceil(width / TS);
    this.rows = Math.ceil(height / TS);
    this.lastBgColor = bgColor || '#FFFFFF';
    this.atlas = new TileAtlas(renderer);

    this.rootContainer = new Container();

    // 1. Background checkerboard / color
    this.backgroundGraphic = new Graphics();
    this.updateBackground(this.lastBgColor);
    this.rootContainer.addChild(this.backgroundGraphic);

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

  public updateBackground(bgColor?: string) {
    const color = bgColor && bgColor.trim() !== '' ? bgColor : this.lastBgColor;
    this.lastBgColor = color;
    this.backgroundGraphic.clear();

    // Crisp edge-free paper rectangle (no dark border rim or stroke around canvas perimeter)
    this.backgroundGraphic
      .rect(0, 0, this.canvasWidth, this.canvasHeight)
      .fill({ color });
  }

  public syncLayers(layers: LayerModel[]) {
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

      // Groups can nest: every enclosing group's eye and opacity apply
      let effectiveVisible = model.isVisible;
      let effectiveAlpha = Math.max(0, Math.min(1, model.opacity));
      let parentId = model.layerType === 'mask' ? null : model.parentId;
      for (let depth = 0; parentId && depth < 16; depth++) {
        const parentModel = byId.get(parentId);
        if (!parentModel) break;
        if (!parentModel.isVisible) effectiveVisible = false;
        effectiveAlpha *= Math.max(0, Math.min(1, parentModel.opacity));
        parentId = parentModel.parentId;
      }

      // Onion skin (display only): the neighbouring frame drawn in one flat colour
      const onionTint = (model as LayerModel & { onionTint?: number }).onionTint;
      item.onionFilter = onionTint === undefined ? null : this.getOnionFilter(onionTint);

      item.shown = effectiveVisible && model.layerType !== 'mask';
      if (item.shown) item.lastShown = now;
      item.display.visible = effectiveVisible;
      item.display.alpha = effectiveAlpha;
      item.display.zIndex = model.sortOrder;
      item.sprite.visible = true;
      const rt = (model as LayerModel & { renderTransform?: Affine2D }).renderTransform;
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

    // Re-index children only when display stacking order actually changed (avoids dirtying Pixi every anim frame)
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

    // Filters sample masks and clipping bases as whole textures, and screentone works in canvas
    // pixels: those stay resident. On-screen layers (and the one being edited) get their tiles on the GPU.
    // shortcut: every mask is resident (fine for a few masks), park masks of hidden cels if animations use many
    this.structuralPins.clear();
    for (let i = 0; i < drawable.length; i++) {
      const model = drawable[i];
      const item = this.layersMap.get(model.id)!;
      if (model.layerType === 'mask') this.structuralPins.add(model.id);
      if (item.shown && model.screentoneEnabled) this.structuralPins.add(model.id);
      if (item.shown && model.clipToBelow && i > 0) this.structuralPins.add(clipBaseOf(i).id);
    }
    for (const item of this.layersMap.values()) {
      if (this.isPinned(item)) this.makeResident(item);
      else if ((item.shown || this.keepWarm(item)) && !item.rt && !item.gpu) this.thaw(item);
      else if ((item.shown || this.keepWarm(item)) && item.gpu && item.coldTiles.size > 0 && this.viewBounds) {
        const c0 = Math.max(0, Math.floor((this.viewBounds.x0 - TS) / TS));
        const c1 = Math.min(this.cols - 1, Math.floor((this.viewBounds.x1 + TS) / TS));
        const r0 = Math.max(0, Math.floor((this.viewBounds.y0 - TS) / TS));
        const r1 = Math.min(this.rows - 1, Math.floor((this.viewBounds.y1 + TS) / TS));
        for (let row = r0; row <= r1; row++) {
          for (let col = c0; col <= c1; col++) {
            if (item.coldTiles.has(keyOf(col, row))) this.reheatTile(item, col, row);
          }
        }
      }
    }

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

      // Clipping (不會塗出去): only where the base below shows, after the base's own mask
      const clip: Filter[] = [];
      if (hasClip) {
        const base = clipBaseOf(i);
        const baseItem = this.layersMap.get(base.id);
        if (baseItem?.rt && base.layerType !== 'mask') {
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

      // Screentone shapes the pixels, masks and clipping cut them, onion skin recolours what is left
      const hasAnyFilter = Boolean(item.screentoneFilter || clip.length || masks.length || item.onionFilter);
      const activeFilters: Filter[] = hasAnyFilter
        ? [
            ...(item.screentoneFilter ? [item.screentoneFilter] : []),
            ...clip,
            ...(masks.length ? maskFiltersOf() : []),
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
    for (const item of this.layersMap.values()) if (item.rt) applyMagFilter(item.rt, mode);
  }

  public setActiveLayer(layerId: string | null) {
    this.activeId = layerId;
    const item = layerId ? this.layersMap.get(layerId) : undefined;
    if (item && !item.rt && !item.gpu) this.thaw(item);
  }

  /** Keeps a layer resident for a reason ('transform', …) until pinned to null */
  public pin(reason: string, layerId: string | null) {
    this.pins.set(reason, layerId);
    const item = layerId ? this.layersMap.get(layerId) : undefined;
    if (item) this.makeResident(item);
  }

  private isPinned(item: LayerItem) {
    if (this.structuralPins.has(item.model.id)) return true;
    for (const id of this.pins.values()) if (id === item.model.id) return true;
    return false;
  }

  private keepWarm(item: LayerItem) {
    return item.model.id === this.activeId;
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
   * scene traversal and cold offscreen tiles reheat seamlessly when panned into view.
   */
  public setViewportBounds(bounds: { x0: number; y0: number; x1: number; y1: number } | null) {
    this.viewBounds = bounds;
    const c0 = bounds ? Math.max(0, Math.floor((bounds.x0 - TS) / TS)) : 0;
    const c1 = bounds ? Math.min(this.cols - 1, Math.floor((bounds.x1 + TS) / TS)) : this.cols - 1;
    const r0 = bounds ? Math.max(0, Math.floor((bounds.y0 - TS) / TS)) : 0;
    const r1 = bounds ? Math.min(this.rows - 1, Math.floor((bounds.y1 + TS) / TS)) : this.rows - 1;
    const gridKey = bounds ? `${c0},${r0},${c1},${r1}:${this.cullSuspended}:${this.tileStructureVersion}` : `all:${this.cullSuspended}:${this.tileStructureVersion}`;
    if (this.lastViewGridKey === gridKey) return;
    this.lastViewGridKey = gridKey;
    const now = performance.now();
    for (const item of this.layersMap.values()) {
      if (item.gpu) {
        for (const t of item.gpu.values()) {
          const col = Math.floor(t.sprite.x / TS);
          const row = Math.floor(t.sprite.y / TS);
          const inView = this.cullSuspended > 0 || !bounds || (col >= c0 && col <= c1 && row >= r0 && row <= r1);
          if (t.sprite.visible !== inView) t.sprite.visible = inView;
          if (inView) t.lastSeenMs = now;
        }
      }
      if (bounds && item.coldTiles.size > 0 && (item.shown || this.keepWarm(item))) {
        for (let row = r0; row <= r1; row++) {
          for (let col = c0; col <= c1; col++) {
            if (item.coldTiles.has(keyOf(col, row))) {
              this.reheatTile(item, col, row);
            }
          }
        }
      }
    }
  }

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
    item.coldTiles.delete(key);
    const raw = decodeTile(cpu, SCRATCH);
    if (!raw || isEmpty(raw)) return undefined;
    const gpu = item.gpu ?? (item.gpu = new Map());
    const tile = this.makeTile(item, col, row);
    this.atlas.writePixels(tile.slot, raw, 0, 0, cpu.w, cpu.h, tile.w, tile.h);
    gpu.set(key, tile);
    item.cleanCache.set(key, cpu);
    item.display.addChildAt(tile.sprite, 0);
    return tile;
  }

  /**
   * Temporarily unhides all tile sprites (and optionally rehears visible layers' coldTiles within
   * safety limits) for full-canvas composites, flood-fills, or exports.
   */
  private withAllTilesVisible<T>(fn: () => T, includeColdTiles = false): T {
    this.cullSuspended++;
    const tempCold: Array<{ item: LayerItem; key: string; cpu: CpuTile }> = [];
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
      if (totalCold > 0 && totalCold <= 2400) {
        for (const item of this.layersMap.values()) {
          if (!item.shown && item.model.layerType !== 'mask') continue;
          for (const [key, cpu] of [...item.coldTiles]) {
            const [col, row] = key.split('_').map(Number);
            if (this.reheatTile(item, col, row)) {
              tempCold.push({ item, key, cpu });
            }
          }
        }
      }
    }
    try {
      return fn();
    } finally {
      for (let i = tempCold.length - 1; i >= 0; i--) {
        const { item, key, cpu } = tempCold[i];
        const t = item.gpu?.get(key);
        if (t && item.cleanCache.get(key) === cpu) {
          item.cleanCache.delete(key);
          item.coldTiles.set(key, cpu);
          this.freeTile(t);
          item.gpu?.delete(key);
        }
      }
      this.cullSuspended = Math.max(0, this.cullSuspended - 1);
      if (this.cullSuspended === 0 && this.viewBounds) {
        for (const item of this.layersMap.values()) {
          if (!item.gpu) continue;
          for (const [key, t] of item.gpu) {
            const [col, row] = key.split('_').map(Number);
            t.sprite.visible = this.isTileInView(col, row);
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
    return { slot: s, sprite, w, h, lastSeenMs: performance.now() };
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
    if (!tile) {
      bak.set(key, null);
      return;
    }
    const s = this.atlas.alloc([tile.slot.page]);
    this.atlas.copy(tile.slot, s);
    bak.set(key, s);
  }

  private dropBackups(item: LayerItem) {
    const bak = item.bak;
    item.bak = null;
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
    item.bak = null;
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
  private drawSparse(item: LayerItem, container: Container, x: number, y: number, w: number, h: number, ink?: StrokeInk) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.canvasWidth, Math.ceil(x + w));
    const y1 = Math.min(this.canvasHeight, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const gpu = item.gpu ?? (item.gpu = new Map());
    this.touch(item);
    // One pixel more on each side: a tile's gutter mirrors its neighbour's edge
    const c0 = Math.max(0, Math.floor((x0 - 1) / TS));
    const c1 = Math.min(this.cols - 1, Math.floor(x1 / TS));
    const r0 = Math.max(0, Math.floor((y0 - 1) / TS));
    const r1 = Math.min(this.rows - 1, Math.floor(y1 / TS));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const tx = col * TS;
        const ty = row * TS;
        const key = keyOf(col, row);
        let t = gpu.get(key);
        if (!t && item.coldTiles.has(key) && !(x0 >= tx + TS || x1 <= tx || y0 >= ty + TS || y1 <= ty)) {
          t = this.reheatTile(item, col, row);
        }
        if (!t) {
          if (x0 >= tx + TS || x1 <= tx || y0 >= ty + TS || y1 <= ty) continue; // only its gutter: no tile for that
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
  }

  /**
   * Where a brush draws on this layer: its whole texture if it is resident (or `whole` is asked:
   * a mixer brush reading under the dabs, a selection mask), otherwise tile by tile.
   */
  public drawTarget(layerId: string, opts?: { whole?: boolean; ink?: StrokeInk }): BrushTarget | null {
    const item = this.layersMap.get(layerId);
    if (!item) return null;
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
      draw: (c, x, y, w, h) => {
        this.lastLocalDrawAt = performance.now();
        this.drawSparse(item, c, x, y, w, h, ink);
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
    if (!item.gpu) this.thaw(item);
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
          const slot = hasBak ? item.bak!.get(key) : item.gpu?.get(key)?.slot;
          const tx = col * TS;
          const ty = row * TS;
          const ix0 = Math.max(r.x, tx);
          const iy0 = Math.max(r.y, ty);
          const ix1 = Math.min(r.x + r.w, tx + TS);
          const iy1 = Math.min(r.y + r.h, ty + TS);
          if (!slot) {
            if (hasBak) continue; // before-state did not exist
            const cold = item.coldTiles.get(key) ?? (!item.gpu ? item.cpu?.get(key) : undefined);
            if (!cold) continue;
            const src = decodeTile(cold);
            if (!src) continue;
            const sw = ix1 - ix0;
            const sh = iy1 - iy0;
            const dst = out[ri];
            if (ix0 === r.x && iy0 === r.y && sw === r.w && sh === r.h && r.w === cold.w && r.h === cold.h) {
              out[ri] = src.slice();
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

  /** Raw tiles (premultiplied) of a layer, read without stalling; `before` = as of the last sync */
  public readTilesAsync(layerId: string, coords: TileCoord[], which: 'after' | 'before' = 'after'): Promise<TileData[]> {
    const sizes = coords.map((c) => (c.col >= 0 && c.row >= 0 && c.col < this.cols && c.row < this.rows ? this.tileSize(c.col, c.row) : { w: 0, h: 0 }));
    const rects = coords.map((c, i) => ({ x: c.col * TS, y: c.row * TS, w: sizes[i].w, h: sizes[i].h }));
    return this.readAsync(layerId, rects, which).then((pxs) =>
      coords.map((c, i) => ({ col: c.col, row: c.row, width: sizes[i].w, height: sizes[i].h, compression: 'raw' as const, data: pxs[i], byteLength: pxs[i].byteLength })));
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
    if (!item.gpu && item.cpu) this.thaw(item);
    const key = keyOf(col, row);
    const hasBak = which === 'before' && item.bak?.has(key);
    const slot = hasBak ? item.bak!.get(key) : item.gpu?.get(key)?.slot;
    if (!slot) {
      if (hasBak) return null;
      const cold = item.coldTiles.get(key);
      if (!cold) return null;
      const raw = decodeTile(cold);
      return raw ? raw.slice() : null;
    }
    return this.read(this.atlas.texture(slot), slot.x, slot.y, w, h);
  }

  /** Replaces a rectangle of a layer with premultiplied RGBA (no blending), whichever form it is in */
  public writeRegion(layerId: string, x: number, y: number, w: number, h: number, px: Uint8Array) {
    const item = this.layersMap.get(layerId);
    if (item) this.writeInto(item, x, y, w, h, px);
  }

  private writeInto(item: LayerItem, x: number, y: number, w: number, h: number, px: Uint8Array | null) {
    if (w <= 0 || h <= 0) return;
    if (item.rt && item !== this.preview) {
      this.upload(this.use(item), [{ x, y, w, h, raw: px ?? new Uint8Array(w * h * 4) }]);
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
        item.cleanCache.delete(key);
        if (!t) {
          if (!sub) continue; // transparent onto nothing
          this.backup(item, key, undefined);
          t = this.addTile(item, col, row);
        } else {
          if (item !== this.preview) this.detachIfPendingAfter(item, t);
          this.backup(item, key, t);
        }
        t.lastSeenMs = performance.now();
        this.atlas.writePixels(t.slot, sub, ix0 - tx, iy0 - ty, sw, sh, t.w, t.h);
      }
    }
  }

  /* ---------- Forms ---------- */

  /** Replaces rectangles of a texture with premultiplied RGBA (no blending) */
  private upload(target: RenderTexture, parts: Array<{ x: number; y: number; w: number; h: number; raw: Uint8Array }>, clear = false) {
    if (!parts.length && !clear) return;
    const holder = new Container();
    const textures: Texture[] = [];
    for (const p of parts) {
      const tex = new Texture({
        source: new BufferImageSource({ resource: p.raw, width: p.w, height: p.h, format: 'rgba8unorm', alphaMode: 'premultiplied-alpha' }),
      });
      textures.push(tex);
      const s = new Sprite(tex);
      s.position.set(p.x, p.y);
      s.blendMode = 'none'; // only honoured below a root container
      holder.addChild(s);
    }
    this.renderer.render({ container: holder, target, clear, clearColor: [0, 0, 0, 0] });
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
    const d = item.display;
    for (const c of [...d.children]) if (c === item.sprite || c.label === TILE_LABEL) d.removeChild(c);
    if (item.rt) d.addChildAt(item.sprite, 0);
    else if (item.gpu) {
      let i = 0;
      for (const t of item.gpu.values()) d.addChildAt(t.sprite, i++);
    }
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
    const viewCullWarm = Boolean(this.viewBounds && entries.length > VIEW_THAW_TILE_THRESHOLD);
    entries.forEach(([key, t], i) => {
      const raw = raws[i];
      if (!raw) return;
      const [col, row] = key.split('_').map(Number);
      if (viewCullWarm && !this.isTileInView(col, row)) {
        item.coldTiles.set(key, t);
        return;
      }
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

  /** Cold → warm now (a layer that comes on screen; prefetch() does this ahead, off the main thread) */
  private thaw(item: LayerItem) {
    item.coldTiles.clear();
    item.cleanCache.clear();
    const gpu = new Map<string, GpuTile>();
    const now = performance.now();
    const viewCullThaw = Boolean(this.viewBounds && (item.cpu?.size ?? 0) > VIEW_THAW_TILE_THRESHOLD);
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
    for (const id of layerIds) {
      const item = this.layersMap.get(id);
      if (!item || item.rt || item.gpu || item.decoding || !item.cpu?.size) continue;
      item.decoding = true;
      const version = item.version;
      const entries = [...item.cpu];
      void decodeTiles(entries.map(([, t]) => ({ data: t.data, compression: t.compression, w: t.w, h: t.h })))
        .then((raws) => {
          item.decoding = false;
          if (item.destroyed || item.rt || item.gpu || item.version !== version) return;
          this.warmFrom(item, entries, raws);
          item.lastShown = performance.now(); // just fetched: not the first to go back to the CPU
        })
        .catch(() => {
          item.decoding = false;
        });
    }
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
    if (!item || !tiles?.length) return;
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
      return;
    }

    if (item.gpu) {
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
          const beforeStroke = bakSlot ? this.read(this.atlas.texture(bakSlot), bakSlot.x, bakSlot.y, w, h) : new Uint8Array(w * h * 4);
          const mergedBak = common ? mergePixels3Way(common, beforeStroke, raw, remoteWins) : raw;
          if (isEmpty(mergedBak)) {
            if (bakSlot) {
              this.atlas.free(bakSlot);
              item.bak.set(key, null);
            }
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
        tile.lastSeenMs = performance.now();
      }
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
    if (this.compositeRT && now - this.compositeUsed > SCRATCH_IDLE_MS) {
      this.compositeRT.destroy(true);
      this.compositeRT = null;
    }
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
    if (freeze && hiddenBytes > HIDDEN_TILE_BUDGET) {
      // Unedited since it came from the CPU (animation playback): just let the GPU copy go
      if (freeze.cpu) {
        // …and the next least recently shown ones too while over budget, as long as they are as cheap
        for (const item of [...this.layersMap.values()].filter((i) => frozen(i) && i.cpu).sort((a, b) => a.lastShown - b.lastShown)) {
          if (hiddenBytes <= HIDDEN_TILE_BUDGET) break;
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

    // Active visible layers exceeding the soft GPU tile limit spill oldest offscreen tiles to CPU LRU
    if (!this.evictingOffscreen && this.viewBounds && !this.isActivelyDrawing()) {
      let totalGpuTiles = 0;
      for (const item of this.layersMap.values()) totalGpuTiles += item.gpu?.size ?? 0;
      if (totalGpuTiles > SOFT_GPU_TILE_LIMIT) {
        this.evictOffscreenGpuTiles(totalGpuTiles - SOFT_GPU_TILE_LIMIT);
      }
    }
  };

  /** Evicts least-recently-viewed offscreen tiles from warm layers into `coldTiles` without blocking */
  private evictOffscreenGpuTiles(excess: number) {
    if (excess <= 0 || !this.viewBounds) return;
    const candidates: Array<{ item: LayerItem; key: string; tile: GpuTile; lastSeen: number }> = [];
    for (const item of this.layersMap.values()) {
      if (!item.gpu || item.rt || this.isPinned(item) || (this.pendingBakReads.get(item.model.id) ?? 0) > 0) continue;
      const pendingAfter = this.pendingAfterSlots.get(item.model.id);
      for (const [key, tile] of item.gpu) {
        if (item.bak?.has(key) || pendingAfter?.has(tile.slot)) continue;
        const [col, row] = key.split('_').map(Number);
        if (this.isTileInView(col, row)) continue;
        candidates.push({ item, key, tile, lastSeen: tile.lastSeenMs ?? 0 });
      }
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => a.lastSeen - b.lastSeen);

    let remaining = excess;
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
      } else if (dirtyBatch.length < 8) {
        dirtyBatch.push({ item: c.item, version: c.item.version, key: c.key, tile: c.tile, slot: c.tile.slot });
      }
    }
    if (!dirtyBatch.length || !this.reader) return;

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
            const [col, row] = p.key.split('_').map(Number);
            if (this.isTileInView(col, row)) return;
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
          });
        }
      })
      .finally(() => {
        for (const b of dirtyBatch) {
          this.releaseAfterSlots(b.item.model.id, [b.slot]);
        }
        this.evictingOffscreen = false;
      });
  }

  private pump = () => {
    this.jobTimer = null;
    const job = this.job;
    if (!job) return;
    if (job.kind === 'park') this.stepPark(job);
    else this.stepFreeze(job);
    if (this.job) this.jobTimer = setTimeout(this.pump, 16);
  };

  private abortJob() {
    const job = this.job;
    this.job = null;
    if (this.jobTimer) clearTimeout(this.jobTimer);
    this.jobTimer = null;
    if (job?.kind === 'park') for (const t of job.tiles.values()) this.freeTile(t);
  }

  /** Resident → warm, a tile row per step: read back, copy the tiles that have pixels into atlas slots */
  private stepPark(job: Extract<Job, { kind: 'park' }>) {
    const { item } = job;
    const W = this.canvasWidth;
    const H = this.canvasHeight;
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

  /** Warm and off screen → cold: tiles read back and LZ4-compressed, slots freed */
  private stepFreeze(job: Extract<Job, { kind: 'freeze' }>) {
    const { item } = job;
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
    for (const [key, t] of item.coldTiles) {
      if (!job.tiles.has(key)) job.tiles.set(key, t);
    }
    item.coldTiles.clear();
    this.job = null;
    this.dropGpuTiles(item);
    item.cpu = job.tiles;
    this.rebuildDisplay(item);
  }

  /** A new texture holding a copy of src */
  /** @internal */
  copyTexture(src: RenderTexture): RenderTexture {
    const rt = RenderTexture.create({ width: src.width, height: src.height, resolution: 1 });
    const blit = new Sprite(src);
    this.renderer.render({ container: blit, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    blit.destroy();
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
    let backups = 0;
    let cpuBytes = 0;
    for (const item of this.layersMap.values()) {
      if (item.rt) resident++;
      if (item.pp) pingPong++;
      if (item.gpu) {
        warm++;
        tiles += item.gpu.size;
      } else if (!item.rt) cold++;
      for (const s of item.bak?.values() ?? []) if (s) backups++;
      for (const t of item.cpu?.values() ?? []) cpuBytes += t.data.byteLength;
      for (const t of item.coldTiles.values()) cpuBytes += t.data.byteLength;
    }
    const scratch = this.compositeRT ? 1 : 0;
    const atlas = this.atlas.stats();
    const gpuBytes = (resident + pingPong + scratch) * full + atlas.bytes;
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
      scratch,
      /** atlas pages (64 tiles each, 17 MB) holding warm tiles, backups and previews */
      atlasPages: atlas.pages,
      atlasMegabytes: mb(atlas.bytes),
      /** tiles copied before their first write in the stroke being drawn */
      backups,
      previewTiles: this.preview.gpu?.size ?? 0,
      cpuMegabytes: mb(cpuBytes),
    };
  }

  private onionFilters = new Map<number, Filter>();

  private getOnionFilter(tint: number): Filter {
    let filter = this.onionFilters.get(tint);
    if (!filter) this.onionFilters.set(tint, (filter = this.createOnionFilter(tint)));
    return filter;
  }

  private createOnionFilter(tint: number): Filter {
    return Filter.from({
      gl: {
        vertex: defaultFilterVert,
        fragment: `#version 300 es
          precision highp float;
          in vec2 vTextureCoord;
          out vec4 finalColor;
          uniform sampler2D uTexture;
          uniform vec3 uTint;
          void main() {
            float a = texture(uTexture, vTextureCoord).a;
            finalColor = vec4(uTint * a, a);
          }
        `,
      },
      resources: {
        onionUniforms: {
          uTint: { value: [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255], type: 'vec3<f32>' },
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
    const blitSprite = new Sprite(item.renderTexture);
    this.renderer.render({
      container: blitSprite,
      target: item.pp,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    blitSprite.destroy();
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
      return;
    }
    if (!item.pp) return; // never allocated = nothing changed since the last sync

    this.flushPendingReads();
    const blitSprite = new Sprite(item.pp);
    this.renderer.render({
      container: blitSprite,
      target: item.rt,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    blitSprite.destroy();
  }

  private thumbRT: RenderTexture | null = null;

  private compositeRT: RenderTexture | null = null;
  private compositeUsed = 0;

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
    const target = this.ensureComposite();
    const previewVisible = this.previewContainer.visible;
    this.previewContainer.visible = false;
    this.withAllTilesVisible(() => {
      this.renderer.render({
        container: includeBackground ? this.rootContainer : this.layersContainer,
        target,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
    }, true);
    this.previewContainer.visible = previewVisible;
    return target;
  }

  /** True while the local user has an active stroke or drew within the last 650ms */
  public isActivelyDrawing(): boolean {
    if (this.lastLocalDrawAt > 0 && performance.now() - this.lastLocalDrawAt < 650) return true;
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
    if (!item) return null;
    if (item.thumb?.version === item.version) return item.thumb.url;
    if (!item.rt && !item.gpu && !item.cpu?.size && !item.coldTiles.size) {
      item.thumb = { version: item.version, url: '' };
      return null;
    }
    const local = !fromRemote || layerId === this.activeId;
    const prev = this.thumbQueue.get(layerId);
    // Always render thumbnails asynchronously on the queue so WebSocket/op handlers and active drawing never block
    this.thumbQueue.set(layerId, { w: thumbWidth, h: thumbHeight, local: Boolean(prev?.local || local) });
    if (!this.thumbTimer) {
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
    if (!paused && this.thumbQueue.size > 0 && !this.thumbTimer && !this.destroyed) {
      this.thumbTimer = setTimeout(this.drainThumbs, 60);
    }
  }

  private drainThumbs = () => {
    this.thumbTimer = null;
    if (this.destroyed) return;
    if (this.thumbsPaused) {
      if (this.thumbQueue.size > 0) this.thumbTimer = setTimeout(this.drainThumbs, 350);
      return;
    }
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
          this.pendingReadCount > 0 ||
          [...this.layersMap.values()].some((l) => (l.bak?.size ?? 0) > 0);
        const cooldown = busy ? 600 : 6000 - (now - this.lastRemoteThumbExtractAt);
        if (cooldown > 10) {
          this.thumbTimer = setTimeout(this.drainThumbs, cooldown);
          return;
        }
      } else if (this.isActivelyDrawing() || this.pendingReadCount > 0) {
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
    const ctx = c.getContext('2d');
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
          canvas.getContext('2d')?.putImageData(new ImageData(out, thumbWidth, thumbHeight), 0, 0);
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
    if (!item) return null;
    const canvas = document.createElement('canvas');
    canvas.width = this.canvasWidth;
    canvas.height = this.canvasHeight;
    const ctx = canvas.getContext('2d')!;
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
          c.getContext('2d')?.putImageData(new ImageData(out, tw, th), 0, 0);
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

  /** Full-size picture as shown (background, masks, current animation frames), for GIF / video frames */
  public renderCompositeCanvas(): HTMLCanvasElement {
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
    ctx.fillStyle = this.lastBgColor;
    ctx.fillRect(0, 0, w, h);

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
    // Layers only: the paper graphic carries a shadow and a border line that are not the picture
    this.withAllTilesVisible(() => {
      this.renderer.render({ container: this.layersContainer, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    }, true);
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
    this.layersContainer.removeChild(item.display);
    item.maskFilters?.forEach((f) => f.destroy());
    item.blendFilter?.filter.destroy();
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
    clearInterval(this.tickTimer);
    if (this.thumbTimer) clearTimeout(this.thumbTimer);
    for (const url of this.thumbBlobUrls) URL.revokeObjectURL(url);
    this.thumbBlobUrls.clear();
    this.abortJob();
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
    this.atlas.destroy();
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
