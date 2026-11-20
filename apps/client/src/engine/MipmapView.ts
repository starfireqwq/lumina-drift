import type { Renderer, TextureSource } from 'pixi.js';

interface MipState {
  /** Levels kept, level 0 included */
  levels: number;
  /** Levels 1… sampled (TEXTURE_MAX_LEVEL > 0) and matching level 0 */
  fresh: boolean;
  onDestroy: () => void;
}

interface GlTextureInfo {
  target: number;
  internalFormat: number;
  format: number;
  type: number;
}

interface TextureSystemInternals {
  bindSource(source: TextureSource, location?: number): void;
  getGlSource(source: TextureSource): GlTextureInfo;
  _activateLocation?: (location: number) => void;
  _activeTextureLocation?: number;
}

/** Levels down to 1 px (a canvas-sized texture shown at any zoom) */
export function fullMipLevels(width: number, height: number) {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

/**
 * Mip levels for textures shown zoomed out. Bilinear sampling alone reads 4 texels per screen
 * pixel, so below 100 % thin lines skip pixels and turn jagged; mip levels average every texel
 * first (CSP, Krita do the same).
 *
 * Levels exist only for textures `ensure()` was called for (on screen while zoomed out) and are
 * dropped by `releaseIdle()`. A write into a texture (any render into it: renderTarget.bind is
 * watched; raw uploads call markDirty) makes its levels stale: before the next render it is
 * sampled from level 0 only (TEXTURE_MAX_LEVEL 0, as with no mips), until ensure() rebuilds them.
 * WebGL2 only (TEXTURE_MAX_LEVEL, non-power-of-two mips); elsewhere nothing changes.
 */
export class MipmapView {
  readonly supported: boolean;
  private gl: WebGL2RenderingContext | null = null;
  private states = new Map<TextureSource, MipState>();
  /** Written while fresh: falls back to level 0 before the next render */
  private dirty = new Set<TextureSource>();
  private unhook: (() => void) | null = null;
  private lastUsed = 0;

  constructor(private renderer: Renderer) {
    const r = renderer as unknown as {
      gl?: WebGL2RenderingContext;
      context?: { webGLVersion?: number };
      renderTarget?: { bind: (...args: unknown[]) => unknown };
      render: (...args: unknown[]) => unknown;
    };
    this.supported = !!r.gl && r.context?.webGLVersion === 2 && !!r.renderTarget;
    if (!this.supported) return;
    this.gl = r.gl!;
    const rts = r.renderTarget!;
    const bind = rts.bind;
    rts.bind = (...args: unknown[]) => {
      if (this.states.size) this.markDirty(surfaceSource(args[0]));
      return bind.apply(rts, args);
    };
    const render = r.render;
    r.render = (...args: unknown[]) => {
      if (this.dirty.size) this.flush();
      return render.apply(r, args);
    };
    this.unhook = () => {
      rts.bind = bind;
      r.render = render;
    };
  }

  /** Pixels of `source` changed outside the renderer (texSubImage2D) */
  markDirty(source: TextureSource | null | undefined) {
    if (!source) return;
    const s = this.states.get(source);
    if (s?.fresh) this.dirty.add(source);
  }

  /** `source` is about to be shown zoomed out: its levels exist and match level 0 */
  ensure(source: TextureSource, levels: number) {
    if (!this.supported || source.destroyed || levels < 2) return;
    this.lastUsed = performance.now();
    let s = this.states.get(source);
    if (s && s.fresh && !this.dirty.has(source)) return;
    const gl = this.gl!;
    const info = this.bindForEdit(source);
    if (!s) {
      let w = source.pixelWidth;
      let h = source.pixelHeight;
      for (let level = 1; level < levels; level++) {
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        gl.texImage2D(info.target, level, info.internalFormat, w, h, 0, info.format, info.type, null);
      }
      const onDestroy = () => this.forget(source);
      s = { levels, fresh: false, onDestroy };
      this.states.set(source, s);
      source.once('destroy', onDestroy);
      // Pixi picks a mipmapped minFilter from mipLevelCount; style.update() pushes it to the GPU
      source.mipLevelCount = levels;
      source.style.update();
      this.bindForEdit(source);
    }
    // generateMipmap fills levels up to TEXTURE_MAX_LEVEL only: raise it first (stale levels sat at 0)
    gl.texParameteri(info.target, gl.TEXTURE_MAX_LEVEL, s.levels - 1);
    gl.generateMipmap(info.target);
    s.fresh = true;
    this.dirty.delete(source);
  }

  /** Zoomed in again for `idleMs`: the levels' memory is given back */
  releaseIdle(idleMs: number) {
    if (!this.states.size || performance.now() - this.lastUsed < idleMs) return;
    this.releaseAll();
  }

  releaseAll() {
    if (!this.gl) return;
    const gl = this.gl;
    for (const [source, s] of [...this.states]) {
      if (!source.destroyed) {
        const info = this.bindForEdit(source);
        for (let level = 1; level < s.levels; level++) {
          gl.texImage2D(info.target, level, info.internalFormat, 0, 0, 0, info.format, info.type, null);
        }
        gl.texParameteri(info.target, gl.TEXTURE_MAX_LEVEL, 0);
        source.mipLevelCount = 1;
        source.style.update();
      }
      this.forget(source);
    }
  }

  /** GPU bytes held by levels 1… (for texture stats) */
  bytes() {
    let total = 0;
    for (const [source, s] of this.states) {
      let w = source.pixelWidth;
      let h = source.pixelHeight;
      for (let level = 1; level < s.levels; level++) {
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        total += w * h * 4;
      }
    }
    return total;
  }

  destroy() {
    this.releaseAll();
    this.unhook?.();
    this.unhook = null;
  }

  /** Written since their levels were built: sampled from level 0 until ensure() rebuilds them */
  private flush() {
    const gl = this.gl!;
    for (const source of this.dirty) {
      const s = this.states.get(source);
      if (!s?.fresh || source.destroyed) continue;
      const info = this.bindForEdit(source);
      gl.texParameteri(info.target, gl.TEXTURE_MAX_LEVEL, 0);
      s.fresh = false;
    }
    this.dirty.clear();
  }

  private forget(source: TextureSource) {
    const s = this.states.get(source);
    if (!s) return;
    source.off('destroy', s.onDestroy);
    this.states.delete(source);
    this.dirty.delete(source);
  }

  /**
   * Binds `source` on unit 0 and makes unit 0 active: bindSource skips both when Pixi believes the
   * source is already there, yet the active unit may be another one (see TileAtlas.writePixels).
   */
  private bindForEdit(source: TextureSource): GlTextureInfo {
    const ts = (this.renderer as unknown as { texture: TextureSystemInternals }).texture;
    ts.bindSource(source, 0);
    if (ts._activateLocation) ts._activateLocation(0);
    else {
      this.gl!.activeTexture(this.gl!.TEXTURE0);
      ts._activeTextureLocation = 0;
    }
    return ts.getGlSource(source);
  }
}

/** The texture source a renderTarget.bind() call draws into (a Texture, a source, a RenderTarget or bind options) */
function surfaceSource(arg: unknown): TextureSource | null {
  if (!arg || typeof arg !== 'object') return null;
  const surface = 'target' in arg ? (arg as { target: unknown }).target : arg;
  if (!surface || typeof surface !== 'object') return null;
  const s = surface as { isTexture?: boolean; source?: TextureSource; colorTexture?: TextureSource };
  if (s.isTexture) return s.source ?? null;
  if (s.colorTexture) return s.colorTexture;
  return surface as TextureSource;
}
