import { BufferImageSource, Container, Matrix, Rectangle, type Renderer, RenderTexture, Sprite, Texture } from 'pixi.js';
import { DEFAULT_TILE_SIZE } from '@atelier/shared';
import type { MipmapView } from './MipmapView';

const TS = DEFAULT_TILE_SIZE;
/**
 * A slot is the 256 px tile plus a 4 px gutter all round, copies of the tile's edge (or what a
 * stroke leaves just outside it): sampling at a tile's edge reads its own pixels, never a
 * neighbouring slot — bilinear at 1:1, and the page's mip levels when zoomed out (see below).
 */
export const GUTTER = 4;
export const PITCH = TS + 2 * GUTTER;
const SLOTS_PER_ROW = 8;
/** 8 × 8 = 64 tiles per page (2112 px square: fits every GPU's texture limit) */
export const ATLAS_PAGE_SIZE = PITCH * SLOTS_PER_ROW;
export const ATLAS_PAGE_BYTES = ATLAS_PAGE_SIZE * ATLAS_PAGE_SIZE * 4;
/**
 * Mip levels of a page shown zoomed out: while the pitch divides by 2^level, a texel of that
 * level averages one slot only (264 = 8 × 33: levels 1–3, so 2112 → 264 px, 1/8 zoom)
 */
export const ATLAS_MIP_LEVELS = (() => {
  let levels = 1;
  while (levels < 4 && PITCH % (1 << levels) === 0) levels++;
  return levels;
})();

/** Where a tile lives: (x, y) is its top-left texel in the page (its gutter starts at x − GUTTER, y − GUTTER) */
export interface Slot {
  page: number;
  index: number;
  x: number;
  y: number;
}

interface Page {
  rt: RenderTexture;
  free: number[];
  used: number;
}

export type MagFilter = 'linear' | 'nearest';

/** How a texture is sampled when shown larger than 1:1 ('nearest' = each canvas pixel a sharp square) */
export function applyMagFilter(tex: Texture, mode: MagFilter) {
  const source = tex.source;
  if (source.magFilter === mode) return;
  source.magFilter = mode;
  source.style.update(); // pushes the sampler change to the GPU texture
}

/** The nine shifts that write a rectangle plus a copy of its edge pixels one texel outwards (centre last) */
const AROUND: Array<[number, number]> = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1], [0, 0]];

/**
 * Sparse layer tiles packed into big texture pages, so a layer full of tiles is a handful of
 * textures: its sprites batch into a few draw calls (one texture per tile made ~1300 for a filled
 * 10000×8000 layer). Pages are shared by all layers; a layer prefers pages it already uses.
 */
export class TileAtlas {
  private pages: Array<Page | null> = [];
  /** Phase 6.3: Warm pool of empty atlas pages to eliminate WebGL texture alloc/destroy stalls on 4K–8K+ pan/zoom */
  private pagePool: Array<{ rt: RenderTexture; freedAtMs: number }> = [];
  private maxPooledPages = 2;
  private poolHits = 0;
  private poolMisses = 0;
  private zero: Texture | null = null;
  private zeroGutter: Texture | null = null;
  private zeroGutterBytes: Uint8Array | null = null;
  private scratch: RenderTexture | null = null;
  private padded: Uint8Array | null = null;
  private padded32: Uint32Array | null = null;
  private paddedSource: BufferImageSource | null = null;
  private paddedTex: Texture | null = null;
  private uploadSprite: Sprite | null = null;
  private uploadHolder: Container | null = null;
  private magFilter: MagFilter = 'linear';

  constructor(
    private renderer: Renderer,
    private mips?: MipmapView,
    private slotsPerRow = SLOTS_PER_ROW,
    maxPooledPages = 2
  ) {
    this.maxPooledPages = Math.max(0, Math.min(8, Math.round(maxPooledPages)));
  }

  public setMaxPooledPages(maxPages: number) {
    this.maxPooledPages = Math.max(0, Math.min(8, Math.round(maxPages)));
    this.trimPool(0, this.maxPooledPages);
  }

  /** Releases idle pooled atlas RenderTextures back to GPU VRAM */
  public trimPool(maxIdleMs = 0, targetCount = 0): number {
    const now = performance.now();
    let freed = 0;
    while (this.pagePool.length > targetCount) {
      const oldest = this.pagePool[0];
      if (maxIdleMs > 0 && now - oldest.freedAtMs < maxIdleMs) break;
      this.pagePool.shift()!.rt.destroy(true);
      freed++;
    }
    return freed;
  }

  /** The pages in use (zoomed out, their mip levels are brought up to date before a frame) */
  *pageTextures(visible?: ReadonlySet<number>): Iterable<RenderTexture> {
    for (let index = 0; index < this.pages.length; index++) {
      const page = this.pages[index];
      if (page && (!visible || visible.has(index))) yield page.rt;
    }
  }

  /** Zoomed in far, pages are sampled 'nearest' (sharp pixels); copies are 1:1 and unaffected */
  setMagFilter(mode: MagFilter) {
    if (this.magFilter === mode) return;
    this.magFilter = mode;
    for (const p of this.pages) if (p) applyMagFilter(p.rt, mode);
    for (const pooled of this.pagePool) applyMagFilter(pooled.rt, mode);
  }

  /** A free slot, from one of `prefer` (the layer's pages) if any has room */
  alloc(prefer?: Iterable<number>): Slot {
    let pageIndex = -1;
    for (const p of prefer ?? []) {
      if (this.pages[p]?.free.length) {
        pageIndex = p;
        break;
      }
    }
    if (pageIndex < 0) pageIndex = this.pages.findIndex((p) => p !== null && p.free.length > 0);
    if (pageIndex < 0) {
      pageIndex = this.pages.indexOf(null);
      if (pageIndex < 0) pageIndex = this.pages.length;
      const size = PITCH * this.slotsPerRow;
      const slots = this.slotsPerRow ** 2;
      let rt: RenderTexture;
      const pooled = this.pagePool.pop();
      if (pooled && !pooled.rt.destroyed) {
        rt = pooled.rt;
        this.poolHits++;
      } else {
        rt = RenderTexture.create({ width: size, height: size, resolution: 1 });
        this.poolMisses++;
      }
      if (this.magFilter !== 'linear') applyMagFilter(rt, this.magFilter);
      this.pages[pageIndex] = { rt, free: Array.from({ length: slots }, (_, i) => slots - 1 - i), used: 0 };
    }
    const page = this.pages[pageIndex]!;
    const index = page.free.pop()!;
    page.used++;
    return { page: pageIndex, index, x: (index % this.slotsPerRow) * PITCH + GUTTER, y: Math.floor(index / this.slotsPerRow) * PITCH + GUTTER };
  }

  /** The slot goes back to its page; an empty page is returned to the warm reuse pool or freed */
  free(slot: Slot) {
    const page = this.pages[slot.page];
    if (!page) return;
    page.free.push(slot.index);
    page.used--;
    if (page.used <= 0) {
      this.pages[slot.page] = null;
      if (this.maxPooledPages > 0 && this.pagePool.length < this.maxPooledPages && !page.rt.destroyed) {
        this.pagePool.push({ rt: page.rt, freedAtMs: performance.now() });
      } else {
        page.rt.destroy(true);
      }
    }
  }

  texture(slot: Slot): RenderTexture {
    return this.pages[slot.page]!.rt;
  }

  /** The slot's w × h pixels as a texture (display sprites, copies) */
  view(slot: Slot, w = TS, h = TS): Texture {
    return new Texture({ source: this.texture(slot).source, frame: new Rectangle(slot.x, slot.y, w, h) });
  }

  /** Render target confined to the slot and its gutter (drawing is clipped to it, coordinates start at the gutter) */
  private target(slot: Slot, x = -GUTTER, y = -GUTTER, w = PITCH, h = PITCH): Texture {
    return new Texture({ source: this.texture(slot).source, frame: new Rectangle(slot.x + x, slot.y + y, w, h) });
  }

  /**
   * Draws `container` (in canvas coordinates) into the slot holding the tile whose top-left canvas
   * pixel is (tx, ty). The gutter receives what falls just outside the tile, as a neighbour would.
   */
  draw(slot: Slot, container: Container, tx: number, ty: number) {
    const target = this.target(slot);
    this.renderer.render({ container, target, clear: false, transform: new Matrix().translate(GUTTER - tx, GUTTER - ty) });
    target.destroy(false);
  }

  /**
   * Replaces a w × h rectangle at (ox, oy) inside the slot's tile (tileW × tileH) with `source`
   * (premultiplied, drawn without blending). Sides of the rectangle that touch the tile's edge
   * are also copied into the gutter: exactly one texel out, the edge row or column stretched beyond.
   */
  write(slot: Slot, source: Texture, ox: number, oy: number, w: number, h: number, tileW = TS, tileH = TS) {
    const holder = new Container();
    const views: Texture[] = [];
    const add = (tex: Texture, x: number, y: number, sw: number, sh: number) => {
      const s = new Sprite(tex);
      s.position.set(x, y);
      s.width = sw;
      s.height = sh;
      s.blendMode = 'none'; // only honoured below a root container
      holder.addChild(s);
    };
    const left = ox <= 0;
    const top = oy <= 0;
    const right = ox + w >= tileW;
    const bottom = oy + h >= tileH;
    // A canvas-edge tile written whole: the rest of its slot is cleared, so no pixels of the slot's
    // previous tile sit next to its edge (mip levels average them in when zoomed out)
    if (left && top && right && bottom && (tileW < TS || tileH < TS)) add(this.zeroTexture(), 0, 0, PITCH, PITCH);
    if (GUTTER > 1) {
      const f = source.frame;
      const sx = f.width / w;
      const sy = f.height / h;
      const edge = (fx: number, fy: number, fw: number, fh: number, x: number, y: number, sw: number, sh: number) => {
        const view = new Texture({ source: source.source, frame: new Rectangle(fx, fy, fw, fh) });
        views.push(view);
        add(view, x, y, sw, sh);
      };
      const x0 = GUTTER + ox;
      const y0 = GUTTER + oy;
      const outer = GUTTER - 1;
      const fr = f.x + f.width - sx;
      const fb = f.y + f.height - sy;
      // Corners first (the whole corner square: the one-texel ring below overwrites its inner part)
      if (left && top) edge(f.x, f.y, sx, sy, x0 - GUTTER, y0 - GUTTER, GUTTER, GUTTER);
      if (right && top) edge(fr, f.y, sx, sy, x0 + w, y0 - GUTTER, GUTTER, GUTTER);
      if (left && bottom) edge(f.x, fb, sx, sy, x0 - GUTTER, y0 + h, GUTTER, GUTTER);
      if (right && bottom) edge(fr, fb, sx, sy, x0 + w, y0 + h, GUTTER, GUTTER);
      if (left) edge(f.x, f.y, sx, f.height, x0 - GUTTER, y0, outer, h);
      if (right) edge(fr, f.y, sx, f.height, x0 + w + 1, y0, outer, h);
      if (top) edge(f.x, f.y, f.width, sy, x0, y0 - GUTTER, w, outer);
      if (bottom) edge(f.x, fb, f.width, sy, x0, y0 + h + 1, w, outer);
    }
    for (const [dx, dy] of AROUND) {
      if ((dx < 0 && !left) || (dx > 0 && !right) || (dy < 0 && !top) || (dy > 0 && !bottom)) continue;
      add(source, GUTTER + ox + dx, GUTTER + oy + dy, w, h);
    }
    const target = this.target(slot);
    this.renderer.render({ container: holder, target, clear: false });
    target.destroy(false);
    holder.destroy({ children: true });
    for (const v of views) v.destroy(false);
  }

  /** write() for premultiplied RGBA bytes; null clears to transparent */
  writePixels(slot: Slot, px: Uint8Array | null, ox: number, oy: number, w: number, h: number, tileW = TS, tileH = TS) {
    // Fast zero-alloc path for full-tile uploads (including clamped edge/corner tiles <= TS): packs
    // the whole slot on CPU (tile, clamped gutter, the rest of a canvas-edge tile's slot cleared)
    // and streams it directly via gl.texSubImage2D (no FBO switch or shader draw).
    if (ox === 0 && oy === 0 && w === tileW && h === tileH && w > 0 && h > 0 && w <= TS && h <= TS) {
      const page = this.pages[slot.page];
      if (page) {
        const gl = (this.renderer as any).gl as WebGLRenderingContext | undefined;
        const texSys = (this.renderer as any).texture as {
          bindSource?: (s: any, loc?: number) => void;
          _activateLocation?: (loc: number) => void;
          _activeTextureLocation?: number;
          _premultiplyAlpha?: boolean;
        } | undefined;
        if (gl && texSys?.bindSource) {
          let bytes: Uint8Array;
          if (!px) {
            bytes = this.zeroGutterBytes ??= new Uint8Array(PITCH * PITCH * 4);
          } else {
            this.ensurePaddedBuffers();
            this.packRectWithGutter(px, w, h);
            bytes = this.padded!;
          }
          texSys.bindSource(page.rt.source, 0);
          // bindSource does nothing when Pixi believes the page already sits on unit 0, yet the
          // ACTIVE unit may be another one: unbinding a destroyed texture (an atlas page freed
          // mid-batch) or the batcher's multi-texture binds activate other units. texSubImage2D
          // then wrote into whatever that unit held — lost writes, or pixels landing in another
          // page (an 8K gradient's undo left 9 tiles untouched). Always upload through unit 0.
          if (texSys._activateLocation) texSys._activateLocation(0);
          else {
            gl.activeTexture(gl.TEXTURE0);
            if (texSys._activeTextureLocation !== undefined) texSys._activeTextureLocation = 0;
          }
          if (texSys._premultiplyAlpha) {
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
            texSys._premultiplyAlpha = false;
          }
          gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.x - GUTTER, slot.y - GUTTER, PITCH, PITCH, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          this.mips?.markDirty(page.rt.source);
          return;
        }
        if (w === TS && h === TS) {
          this.ensureUploadRig();
          if (!px) {
            this.uploadSprite!.texture = this.zeroGutterTexture();
          } else {
            this.packRectWithGutter(px, TS, TS);
            this.paddedSource!.update();
            this.uploadSprite!.texture = this.paddedTex!;
          }
          this.uploadSprite!.position.set(slot.x - GUTTER, slot.y - GUTTER);
          this.renderer.render({ container: this.uploadHolder!, target: page.rt, clear: false });
          return;
        }
      }
    }
    if (!px) {
      this.write(slot, this.zeroTexture(), ox, oy, w, h, tileW, tileH);
      return;
    }
    const tex = new Texture({ source: new BufferImageSource({ resource: px, width: w, height: h, format: 'rgba8unorm', alphaMode: 'premultiplied-alpha' }) });
    this.write(slot, tex, ox, oy, w, h, tileW, tileH);
    tex.destroy(true);
  }

  private ensurePaddedBuffers() {
    if (!this.padded) {
      this.padded = new Uint8Array(PITCH * PITCH * 4);
      this.padded32 = new Uint32Array(this.padded.buffer);
    }
  }

  private ensureUploadRig() {
    if (this.uploadHolder) return;
    this.ensurePaddedBuffers();
    this.paddedSource = new BufferImageSource({ resource: this.padded!, width: PITCH, height: PITCH, format: 'rgba8unorm', alphaMode: 'premultiplied-alpha' });
    this.paddedTex = new Texture({ source: this.paddedSource });
    this.uploadSprite = new Sprite(this.paddedTex);
    this.uploadSprite.blendMode = 'none';
    this.uploadHolder = new Container();
    this.uploadHolder.addChild(this.uploadSprite);
  }

  /** The whole slot (PITCH × PITCH) into `padded`: the tile, its edges repeated over the gutter, zeros beyond a smaller tile */
  private packRectWithGutter(px: Uint8Array, w: number, h: number) {
    const dst32 = this.padded32!;
    if (w < TS || h < TS) dst32.fill(0);
    // 32-bit copies need an aligned view (a subarray at an odd offset is copied once)
    const aligned = (px.byteOffset & 3) === 0 ? px : px.slice(0, w * h * 4);
    const src32 = new Uint32Array(aligned.buffer, aligned.byteOffset, w * h);
    for (let y = 0; y < h; y++) {
      const s = y * w;
      const d = (y + GUTTER) * PITCH;
      dst32.fill(src32[s], d, d + GUTTER);
      dst32.set(src32.subarray(s, s + w), d + GUTTER);
      dst32.fill(src32[s + w - 1], d + GUTTER + w, d + 2 * GUTTER + w);
    }
    const rowLen = w + 2 * GUTTER;
    const first = GUTTER * PITCH;
    const last = (GUTTER + h - 1) * PITCH;
    for (let k = 0; k < GUTTER; k++) {
      dst32.copyWithin(k * PITCH, first, first + rowLen);
      dst32.copyWithin((GUTTER + h + k) * PITCH, last, last + rowLen);
    }
  }

  private zeroGutterTexture(): Texture {
    this.zeroGutter ??= new Texture({
      source: new BufferImageSource({ resource: new Uint8Array(PITCH * PITCH * 4), width: PITCH, height: PITCH, format: 'rgba8unorm', alphaMode: 'premultiplied-alpha' }),
    });
    return this.zeroGutter;
  }

  /** dst becomes a copy of src, gutter included (through a scratch texture: both may share a page) */
  copy(src: Slot, dst: Slot) {
    this.scratch ??= RenderTexture.create({ width: PITCH, height: PITCH, resolution: 1 });
    const from = this.target(src);
    const s = new Sprite(from);
    this.renderer.render({ container: s, target: this.scratch, clear: true, clearColor: [0, 0, 0, 0] }); // over transparent = exact copy
    s.destroy();
    from.destroy(false);
    const holder = new Container();
    const back = new Sprite(this.scratch);
    back.blendMode = 'none';
    holder.addChild(back);
    const to = this.target(dst);
    this.renderer.render({ container: holder, target: to, clear: false });
    to.destroy(false);
    holder.destroy({ children: true });
  }

  private zeroTexture(): Texture {
    this.zero ??= new Texture({
      source: new BufferImageSource({ resource: new Uint8Array(TS * TS * 4), width: TS, height: TS, format: 'rgba8unorm', alphaMode: 'premultiplied-alpha' }),
    });
    return this.zero;
  }

  /** Pages allocated / slots in use / warm pool metrics, for getTextureStats */
  stats() {
    let pages = 0;
    let slots = 0;
    for (const p of this.pages) {
      if (!p) continue;
      pages++;
      slots += p.used;
    }
    const slotsPerPage = this.slotsPerRow ** 2;
    const pageBytes = (PITCH * this.slotsPerRow) ** 2 * 4;
    const pooledPages = this.pagePool.length;
    const pooledBytes = pooledPages * pageBytes;
    const capacitySlots = pages * slotsPerPage;
    const fragmentationRatio =
      capacitySlots > 0 ? Math.round((1 - slots / capacitySlots) * 1000) / 1000 : 0;
    return {
      pages,
      slots,
      capacitySlots,
      pageBytes,
      bytes: pages * pageBytes + pooledBytes,
      activeBytes: pages * pageBytes,
      pooledPages,
      pooledBytes,
      poolHits: this.poolHits,
      poolMisses: this.poolMisses,
      fragmentationRatio,
    };
  }

  destroy() {
    for (const p of this.pages) p?.rt.destroy(true);
    this.pages = [];
    for (const pooled of this.pagePool) pooled.rt.destroy(true);
    this.pagePool = [];
    this.zero?.destroy(true);
    this.zeroGutter?.destroy(true);
    this.paddedTex?.destroy(true);
    this.uploadHolder?.destroy({ children: true });
    this.scratch?.destroy(true);
    this.zero = null;
    this.zeroGutter = null;
    this.zeroGutterBytes = null;
    this.padded = null;
    this.padded32 = null;
    this.paddedSource = null;
    this.paddedTex = null;
    this.uploadSprite = null;
    this.uploadHolder = null;
    this.scratch = null;
  }
}
