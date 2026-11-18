import { BufferImageSource, Container, Matrix, Rectangle, type Renderer, RenderTexture, Sprite, Texture } from 'pixi.js';
import { DEFAULT_TILE_SIZE } from '@atelier/shared';

const TS = DEFAULT_TILE_SIZE;
/** A slot is the 256 px tile plus a 1 px gutter all round: bilinear sampling at a tile's edge reads its own pixels, never a neighbouring slot */
const PITCH = TS + 2;
const SLOTS_PER_ROW = 8;
/** 8 × 8 = 64 tiles per page (2064 px square: fits every GPU's texture limit) */
export const ATLAS_PAGE_SIZE = PITCH * SLOTS_PER_ROW;
const SLOTS_PER_PAGE = SLOTS_PER_ROW * SLOTS_PER_ROW;
export const ATLAS_PAGE_BYTES = ATLAS_PAGE_SIZE * ATLAS_PAGE_SIZE * 4;

/** Where a tile lives: (x, y) is its top-left texel in the page (its gutter starts at x − 1, y − 1) */
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

  constructor(private renderer: Renderer) {}

  /** Zoomed in far, pages are sampled 'nearest' (sharp pixels); copies are 1:1 and unaffected */
  setMagFilter(mode: MagFilter) {
    if (this.magFilter === mode) return;
    this.magFilter = mode;
    for (const p of this.pages) if (p) applyMagFilter(p.rt, mode);
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
      const rt = RenderTexture.create({ width: ATLAS_PAGE_SIZE, height: ATLAS_PAGE_SIZE, resolution: 1 });
      if (this.magFilter !== 'linear') applyMagFilter(rt, this.magFilter);
      this.pages[pageIndex] = { rt, free: Array.from({ length: SLOTS_PER_PAGE }, (_, i) => SLOTS_PER_PAGE - 1 - i), used: 0 };
    }
    const page = this.pages[pageIndex]!;
    const index = page.free.pop()!;
    page.used++;
    return { page: pageIndex, index, x: (index % SLOTS_PER_ROW) * PITCH + 1, y: Math.floor(index / SLOTS_PER_ROW) * PITCH + 1 };
  }

  /** The slot goes back to its page; an empty page is freed (the GPU memory goes with it) */
  free(slot: Slot) {
    const page = this.pages[slot.page];
    if (!page) return;
    page.free.push(slot.index);
    page.used--;
    if (page.used <= 0) {
      page.rt.destroy(true);
      this.pages[slot.page] = null;
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
  private target(slot: Slot, x = -1, y = -1, w = PITCH, h = PITCH): Texture {
    return new Texture({ source: this.texture(slot).source, frame: new Rectangle(slot.x + x, slot.y + y, w, h) });
  }

  /**
   * Draws `container` (in canvas coordinates) into the slot holding the tile whose top-left canvas
   * pixel is (tx, ty). The gutter receives what falls just outside the tile, as a neighbour would.
   */
  draw(slot: Slot, container: Container, tx: number, ty: number) {
    const target = this.target(slot);
    this.renderer.render({ container, target, clear: false, transform: new Matrix().translate(1 - tx, 1 - ty) });
    target.destroy(false);
  }

  /**
   * Replaces a w × h rectangle at (ox, oy) inside the slot's tile (tileW × tileH) with `source`
   * (premultiplied, drawn without blending). Sides of the rectangle that touch the tile's edge
   * are also copied one texel into the gutter.
   */
  write(slot: Slot, source: Texture, ox: number, oy: number, w: number, h: number, tileW = TS, tileH = TS) {
    const holder = new Container();
    for (const [dx, dy] of AROUND) {
      if ((dx < 0 && ox > 0) || (dx > 0 && ox + w < tileW) || (dy < 0 && oy > 0) || (dy > 0 && oy + h < tileH)) continue;
      const s = new Sprite(source);
      s.position.set(1 + ox + dx, 1 + oy + dy);
      s.width = w;
      s.height = h;
      s.blendMode = 'none'; // only honoured below a root container
      holder.addChild(s);
    }
    const target = this.target(slot);
    this.renderer.render({ container: holder, target, clear: false });
    target.destroy(false);
    holder.destroy({ children: true });
  }

  /** write() for premultiplied RGBA bytes; null clears to transparent */
  writePixels(slot: Slot, px: Uint8Array | null, ox: number, oy: number, w: number, h: number, tileW = TS, tileH = TS) {
    // Fast zero-alloc path for full 256×256 tile uploads: packs 1px clamped gutter on CPU
    // and streams directly via gl.texSubImage2D when WebGL is active (no FBO switch or shader draw).
    if (ox === 0 && oy === 0 && w === TS && h === TS && tileW === TS && tileH === TS) {
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
            this.packFullWithGutter(px);
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
          gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.x - 1, slot.y - 1, PITCH, PITCH, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          return;
        }
        this.ensureUploadRig();
        if (!px) {
          this.uploadSprite!.texture = this.zeroGutterTexture();
        } else {
          this.packFullWithGutter(px);
          this.paddedSource!.update();
          this.uploadSprite!.texture = this.paddedTex!;
        }
        this.uploadSprite!.position.set(slot.x - 1, slot.y - 1);
        this.renderer.render({ container: this.uploadHolder!, target: page.rt, clear: false });
        return;
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

  private packFullWithGutter(px: Uint8Array) {
    const dst32 = this.padded32!;
    if ((px.byteOffset & 3) === 0) {
      const src32 = new Uint32Array(px.buffer, px.byteOffset, TS * TS);
      for (let y = 0; y < TS; y++) {
        const s = y * TS;
        const d = (y + 1) * PITCH;
        dst32[d] = src32[s];
        dst32.set(src32.subarray(s, s + TS), d + 1);
        dst32[d + TS + 1] = src32[s + TS - 1];
      }
    } else {
      const dst = this.padded!;
      const rowBytes = TS * 4;
      const pitchBytes = PITCH * 4;
      for (let y = 0; y < TS; y++) {
        const s = y * rowBytes;
        const d = (y + 1) * pitchBytes;
        dst.set(px.subarray(s, s + 4), d);
        dst.set(px.subarray(s, s + rowBytes), d + 4);
        dst.set(px.subarray(s + rowBytes - 4, s + rowBytes), d + 4 + rowBytes);
      }
    }
    dst32.set(dst32.subarray(PITCH, PITCH * 2), 0);
    dst32.set(dst32.subarray(TS * PITCH, (TS + 1) * PITCH), (TS + 1) * PITCH);
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

  /** Pages allocated / slots in use, for getTextureStats */
  stats() {
    let pages = 0;
    let slots = 0;
    for (const p of this.pages) {
      if (!p) continue;
      pages++;
      slots += p.used;
    }
    return { pages, slots, bytes: pages * ATLAS_PAGE_BYTES };
  }

  destroy() {
    for (const p of this.pages) p?.rt.destroy(true);
    this.pages = [];
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
