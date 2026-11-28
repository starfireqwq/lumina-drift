import type { Renderer, TextureSource } from 'pixi.js';

interface MipState {
  /** Levels kept, level 0 included */
  levels: number;
  /** Levels 1… match level 0 */
  fresh: boolean;
  /** Levels 1… are available for sampling (TEXTURE_MAX_LEVEL > 0) */
  enabled: boolean;
  sharp: boolean;
  /** Source-level tile atlas slot pitch in texels (0 = single image without slot isolation) */
  slotPitch: number;
  onDestroy: () => void;
}

interface GlTextureInfo {
  target: number;
  internalFormat: number;
  format: number;
  type: number;
  texture?: WebGLTexture | null;
}

interface MipResampler {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  fbo: WebGLFramebuffer;
  scratchTex: WebGLTexture | null;
  scratchW: number;
  scratchH: number;
  uTex: WebGLUniformLocation | null;
  uSrcLevel: WebGLUniformLocation | null;
  uSrcSize: WebGLUniformLocation | null;
  uDstSize: WebGLUniformLocation | null;
  uSlotPitch: WebGLUniformLocation | null;
  uKernel: WebGLUniformLocation | null;
}

/** 4-tap Lanczos-2 / Catmull-Rom style kernel for level 0 → 1 (high line-art contrast, H(π)=0) */
export const MIP_KERNEL_L1 = [-0.09, 0.59, 0.59, -0.09] as const;
/** Standard Catmull-Rom 4-tap kernel for level k → k+1 (k >= 1) to avoid multi-level ringing */
export const MIP_KERNEL_DEEP = [-0.0625, 0.5625, 0.5625, -0.0625] as const;

export function mipKernelForLevel(level: number): readonly [number, number, number, number] {
  return level <= 1 ? MIP_KERNEL_L1 : MIP_KERNEL_DEEP;
}

/**
 * Pure CPU reference implementation of the WebGL2 4×4 premultiplied-RGBA mip downsampler.
 * `slotPitch` is the source-level atlas slot pitch in texels (0 disables slot boundary clamping).
 */
export function downsampleRgbaPremul4x4(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  kernel: readonly [number, number, number, number],
  slotPitch = 0,
): Uint8Array {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return new Uint8Array(0);
  const dst = new Uint8Array(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  const maxSlotX = slotPitch > 0 ? Math.max(0, Math.floor((srcW - 1) / slotPitch)) : 0;
  const maxSlotY = slotPitch > 0 ? Math.max(0, Math.floor((srcH - 1) / slotPitch)) : 0;

  for (let dy = 0; dy < dstH; dy++) {
    const srcPosY = (dy + 0.5) * scaleY;
    const baseY = Math.floor(srcPosY - 0.5);
    let minY = 0;
    let maxY = srcH - 1;
    if (slotPitch > 0) {
      const sySlot = Math.max(0, Math.min(maxSlotY, Math.floor(srcPosY / slotPitch)));
      minY = sySlot * slotPitch;
      maxY = Math.min(srcH - 1, minY + slotPitch - 1);
    }

    for (let dx = 0; dx < dstW; dx++) {
      const srcPosX = (dx + 0.5) * scaleX;
      const baseX = Math.floor(srcPosX - 0.5);
      let minX = 0;
      let maxX = srcW - 1;
      if (slotPitch > 0) {
        const sxSlot = Math.max(0, Math.min(maxSlotX, Math.floor(srcPosX / slotPitch)));
        minX = sxSlot * slotPitch;
        maxX = Math.min(srcW - 1, minX + slotPitch - 1);
      }

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let j = 0; j < 4; j++) {
        const iy = Math.max(minY, Math.min(maxY, baseY + j - 1));
        const wy = kernel[j];
        let rowR = 0;
        let rowG = 0;
        let rowB = 0;
        let rowA = 0;
        const rowBase = iy * srcW;
        for (let i = 0; i < 4; i++) {
          const ix = Math.max(minX, Math.min(maxX, baseX + i - 1));
          const wx = kernel[i];
          const si = (rowBase + ix) * 4;
          rowR += src[si] * wx;
          rowG += src[si + 1] * wx;
          rowB += src[si + 2] * wx;
          rowA += src[si + 3] * wx;
        }
        sumR += rowR * wy;
        sumG += rowG * wy;
        sumB += rowB * wy;
        sumA += rowA * wy;
      }

      const a = Math.max(0, Math.min(255, Math.round(sumA)));
      const r = Math.min(a, Math.max(0, Math.min(255, Math.round(sumR))));
      const g = Math.min(a, Math.max(0, Math.min(255, Math.round(sumG))));
      const b = Math.min(a, Math.max(0, Math.min(255, Math.round(sumB))));
      const di = (dy * dstW + dx) * 4;
      dst[di] = r;
      dst[di + 1] = g;
      dst[di + 2] = b;
      dst[di + 3] = a;
    }
  }
  return dst;
}

const MIP_VERT_SRC = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const MIP_FRAG_SRC = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform int uSrcLevel;
uniform ivec2 uSrcSize;
uniform ivec2 uDstSize;
uniform int uSlotPitch;
uniform vec4 uKernel;
out vec4 fragColor;

void main() {
  vec2 srcPos = gl_FragCoord.xy * (vec2(uSrcSize) / vec2(uDstSize));
  ivec2 base = ivec2(floor(srcPos - 0.5));
  int minX = 0;
  int maxX = uSrcSize.x - 1;
  int minY = 0;
  int maxY = uSrcSize.y - 1;
  if (uSlotPitch > 0) {
    int sx = clamp(int(floor(srcPos.x / float(uSlotPitch))), 0, max(0, (uSrcSize.x - 1) / uSlotPitch));
    int sy = clamp(int(floor(srcPos.y / float(uSlotPitch))), 0, max(0, (uSrcSize.y - 1) / uSlotPitch));
    minX = sx * uSlotPitch;
    maxX = min(uSrcSize.x - 1, minX + uSlotPitch - 1);
    minY = sy * uSlotPitch;
    maxY = min(uSrcSize.y - 1, minY + uSlotPitch - 1);
  }
  float w[4] = float[4](uKernel.x, uKernel.y, uKernel.z, uKernel.w);
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    int iy = clamp(base.y + j - 1, minY, maxY);
    vec4 rowSum = vec4(0.0);
    for (int i = 0; i < 4; i++) {
      int ix = clamp(base.x + i - 1, minX, maxX);
      rowSum += texelFetch(uTex, ivec2(ix, iy), uSrcLevel) * w[i];
    }
    sum += rowSum * w[j];
  }
  vec4 c = clamp(sum, 0.0, 1.0);
  c.rgb = min(c.rgb, vec3(c.a));
  fragColor = c;
}`;

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
  /** Written while fresh: invalidate the mip chain before the next render */
  private dirty = new Set<TextureSource>();
  private unhook: (() => void) | null = null;
  private lastUsed = 0;
  private resampler: MipResampler | null = null;
  private resamplerFailed = false;

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

  /** Prepares zoomed-out sampling, returning false when the frame budget defers this source. */
  ensure(source: TextureSource, levels: number, slotPitch = 0, fastMode = false, deadline = Infinity): boolean {
    if (!this.supported || source.destroyed || levels < 2) return true;
    this.lastUsed = performance.now();
    const gl = this.gl!;
    let s = this.states.get(source);
    if (s?.fresh && !this.dirty.has(source) && s.slotPitch === slotPitch && (fastMode || s.sharp)) {
      if (!s.enabled) {
        if (this.lastUsed >= deadline) return false;
        const info = this.bindForEdit(source);
        gl.texParameteri(info.target, gl.TEXTURE_MAX_LEVEL, s.levels - 1);
        s.enabled = true;
      }
      return true;
    }
    if (this.lastUsed >= deadline) return false;
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
      s = { levels, fresh: false, enabled: false, sharp: false, slotPitch, onDestroy };
      this.states.set(source, s);
      source.once('destroy', onDestroy);
      // Pixi picks a mipmapped minFilter from mipLevelCount; style.update() pushes it to the GPU
      source.mipLevelCount = levels;
      source.style.update();
      this.bindForEdit(source);
    } else {
      s.slotPitch = slotPitch;
    }

    if (fastMode || !this.buildSharpMips(gl, source, info, s)) {
      // Enable the full retained chain before generating hardware mipmaps.
      gl.texParameteri(info.target, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(info.target, gl.TEXTURE_MAX_LEVEL, s.levels - 1);
      gl.generateMipmap(info.target);
    }
    s.sharp = !fastMode;
    s.fresh = true;
    s.enabled = true;
    this.dirty.delete(source);
    return true;
  }

  /** Temporarily clamp sampling to mip level 0 without freeing mip storage (sharp 85%–100% view) */
  suspend() {
    if (!this.gl || !this.states.size) return;
    const gl = this.gl;
    for (const [source, s] of this.states) {
      if (!s.enabled || source.destroyed) continue;
      const info = this.bindForEdit(source);
      gl.texParameteri(info.target, gl.TEXTURE_MAX_LEVEL, 0);
      s.enabled = false;
    }
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
    if (this.gl && this.resampler) {
      this.gl.deleteFramebuffer(this.resampler.fbo);
      this.gl.deleteTexture(this.resampler.scratchTex);
      this.gl.deleteVertexArray(this.resampler.vao);
      this.gl.deleteProgram(this.resampler.program);
      this.resampler = null;
    }
    this.unhook?.();
    this.unhook = null;
  }

  /** Written since their levels were built: sampled from level 0 until ensure() rebuilds them */
  private flush() {
    const gl = this.gl!;
    for (const source of this.dirty) {
      const s = this.states.get(source);
      if (!s || source.destroyed) continue;
      if (s.enabled) {
        const info = this.bindForEdit(source);
        gl.texParameteri(info.target, gl.TEXTURE_MAX_LEVEL, 0);
        s.enabled = false;
      }
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

  private ensureResampler(gl: WebGL2RenderingContext): MipResampler | null {
    if (this.resampler) return this.resampler;
    if (
      this.resamplerFailed ||
      typeof gl.createProgram !== 'function' ||
      typeof gl.createShader !== 'function' ||
      typeof gl.createVertexArray !== 'function' ||
      typeof gl.createFramebuffer !== 'function'
    ) {
      this.resamplerFailed = true;
      return null;
    }

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, MIP_VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, MIP_FRAG_SRC);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      this.resamplerFailed = true;
      return null;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.resamplerFailed = true;
      return null;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      this.resamplerFailed = true;
      return null;
    }

    const vao = gl.createVertexArray();
    const fbo = gl.createFramebuffer();
    const scratchTex = gl.createTexture();
    if (!vao || !fbo || !scratchTex) {
      if (vao) gl.deleteVertexArray(vao);
      if (fbo) gl.deleteFramebuffer(fbo);
      if (scratchTex) gl.deleteTexture(scratchTex);
      gl.deleteProgram(program);
      this.resamplerFailed = true;
      return null;
    }

    this.resampler = {
      program,
      vao,
      fbo,
      scratchTex,
      scratchW: 0,
      scratchH: 0,
      uTex: gl.getUniformLocation(program, 'uTex'),
      uSrcLevel: gl.getUniformLocation(program, 'uSrcLevel'),
      uSrcSize: gl.getUniformLocation(program, 'uSrcSize'),
      uDstSize: gl.getUniformLocation(program, 'uDstSize'),
      uSlotPitch: gl.getUniformLocation(program, 'uSlotPitch'),
      uKernel: gl.getUniformLocation(program, 'uKernel'),
    };
    return this.resampler;
  }

  private buildSharpMips(
    gl: WebGL2RenderingContext,
    source: TextureSource,
    info: GlTextureInfo,
    s: MipState,
  ): boolean {
    if (!info.texture || info.target !== gl.TEXTURE_2D) return false;
    // Isolate errors from this mip build from earlier renderer work.
    while (gl.getError() !== gl.NO_ERROR) {}
    const resampler = this.ensureResampler(gl);
    if (!resampler?.scratchTex) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(info.target, info.texture);
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevReadFbo = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevSampler = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array | number[] | null;
    const prevColorMask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[] | null;
    const prevScissor = gl.isEnabled(gl.SCISSOR_TEST);
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepth = gl.isEnabled(gl.DEPTH_TEST);
    const prevStencil = gl.isEnabled(gl.STENCIL_TEST);
    const prevCull = gl.isEnabled(gl.CULL_FACE);
    const prevMinFilter = gl.getTexParameter(info.target, gl.TEXTURE_MIN_FILTER) as number;
    const prevMagFilter = gl.getTexParameter(info.target, gl.TEXTURE_MAG_FILTER) as number;

    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, resampler.fbo);
      let srcW = source.pixelWidth;
      let srcH = source.pixelHeight;
      const needW = Math.max(1, srcW >> 1);
      const needH = Math.max(1, srcH >> 1);
      if (resampler.scratchW < needW || resampler.scratchH < needH) {
        const nextW = Math.max(resampler.scratchW, needW);
        const nextH = Math.max(resampler.scratchH, needH);
        gl.bindTexture(gl.TEXTURE_2D, resampler.scratchTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nextW, nextH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(info.target, info.texture);
        if (gl.getError() !== gl.NO_ERROR) return false;
        resampler.scratchW = nextW;
        resampler.scratchH = nextH;
      }

      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resampler.scratchTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;

      if (prevScissor) gl.disable(gl.SCISSOR_TEST);
      if (prevBlend) gl.disable(gl.BLEND);
      if (prevDepth) gl.disable(gl.DEPTH_TEST);
      if (prevStencil) gl.disable(gl.STENCIL_TEST);
      if (prevCull) gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);

      gl.useProgram(resampler.program);
      gl.bindVertexArray(resampler.vao);
      if (prevSampler) gl.bindSampler(0, null);
      gl.uniform1i(resampler.uTex, 0);
      // texelFetch requires a mipmapped min filter for levels above the base level.
      gl.texParameteri(info.target, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
      gl.texParameteri(info.target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      gl.texParameteri(info.target, gl.TEXTURE_BASE_LEVEL, 0);
      for (let level = 1; level < s.levels; level++) {
        const dstW = Math.max(1, srcW >> 1);
        const dstH = Math.max(1, srcH >> 1);
        gl.texParameteri(info.target, gl.TEXTURE_MAX_LEVEL, level - 1);
        gl.viewport(0, 0, dstW, dstH);
        gl.uniform1i(resampler.uSrcLevel, level - 1);
        gl.uniform2i(resampler.uSrcSize, srcW, srcH);
        gl.uniform2i(resampler.uDstSize, dstW, dstH);
        const levelSlotPitch = s.slotPitch > 0 ? Math.max(1, s.slotPitch >> (level - 1)) : 0;
        gl.uniform1i(resampler.uSlotPitch, levelSlotPitch);
        const k = mipKernelForLevel(level);
        gl.uniform4f(resampler.uKernel, k[0], k[1], k[2], k[3]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.copyTexSubImage2D(info.target, level, 0, 0, 0, 0, dstW, dstH);
        srcW = dstW;
        srcH = dstH;
      }
      return gl.getError() === gl.NO_ERROR;
    } finally {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, info.target, null, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
      if (prevReadFbo !== prevFbo) gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevReadFbo);
      gl.bindVertexArray(null);
      if (prevSampler) gl.bindSampler(0, prevSampler);
      gl.texParameteri(info.target, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(info.target, gl.TEXTURE_MAX_LEVEL, s.levels - 1);
      if (prevMinFilter) gl.texParameteri(info.target, gl.TEXTURE_MIN_FILTER, prevMinFilter);
      if (prevMagFilter) gl.texParameteri(info.target, gl.TEXTURE_MAG_FILTER, prevMagFilter);
      if (prevViewport && prevViewport.length >= 4) {
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      }
      if (prevColorMask && prevColorMask.length >= 4) {
        gl.colorMask(prevColorMask[0], prevColorMask[1], prevColorMask[2], prevColorMask[3]);
      }
      if (prevScissor) gl.enable(gl.SCISSOR_TEST);
      if (prevBlend) gl.enable(gl.BLEND);
      if (prevDepth) gl.enable(gl.DEPTH_TEST);
      if (prevStencil) gl.enable(gl.STENCIL_TEST);
      if (prevCull) gl.enable(gl.CULL_FACE);
      (this.renderer as unknown as { resetState?: () => void }).resetState?.();
    }
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
