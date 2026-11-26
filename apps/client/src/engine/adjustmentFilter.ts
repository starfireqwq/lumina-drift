import {
  BufferImageSource,
  Filter,
  GlProgram,
  Matrix,
  Texture,
  TextureMatrix,
  UniformGroup,
  type FilterSystem,
  type RenderSurface,
  type Sprite,
} from 'pixi.js';
import { ADJUSTMENT_GLSL, compiledAdjustmentUniforms, type CompiledAdjustment } from '@atelier/shared';

/**
 * Live adjustment layer (調整圖層): the last filter of the layer's display, which is an opaque
 * canvas-sized quad (after its masks the quad's alpha is the coverage). It reads what is already
 * drawn below (`blendRequired`) and replaces it (`blendMode = 'none'`) with the adjusted picture —
 * the same math as the shared `applyAdjustmentStep` the exports use:
 * root scope recolours the picture below; clip / group scope adds the change of the scope's own
 * composite (a canvas-space texture rendered by LayerManager) to the picture below.
 */

const vertex = `in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vScopeCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
uniform mat3 uScopeMatrix;

vec4 filterVertexPosition(vec2 position)
{
    vec2 p = position * uOutputFrame.zw + uOutputFrame.xy;
    p.x = p.x * (2.0 / uOutputTexture.x) - 1.0;
    p.y = p.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(p, 0.0, 1.0);
}

void main(void)
{
    gl_Position = filterVertexPosition(aPosition);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
    vScopeCoord = (uScopeMatrix * vec3(vTextureCoord, 1.0)).xy;
}
`;

const fragment = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
in vec2 vScopeCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uBackTexture;
uniform sampler2D uLutTexture;
uniform sampler2D uScopeTexture;
uniform vec4 uScopeClamp;
uniform vec4 uHsl;
uniform vec3 uCbShadows;
uniform vec3 uCbMidtones;
uniform vec3 uCbHighlights;
uniform float uCbPreserve;
uniform float uProgram;
uniform float uBlend;
uniform float uScoped;

${ADJUSTMENT_GLSL}

vec3 lumAdjFull(vec3 c)
{
    int program = int(uProgram + 0.5);
    int mode = int(uBlend + 0.5);
    vec3 adjusted = lumAdjApply(c, uLutTexture, program, uHsl, uCbShadows, uCbMidtones, uCbHighlights, uCbPreserve);
    return lumAdjBlend(adjusted, c, mode);
}

void main(void)
{
    vec4 front = texture(uTexture, vTextureCoord);
    vec4 back = texture(uBackTexture, vTextureCoord);
    float k = clamp(front.a, 0.0, 1.0);
    finalColor = back;
    if (k <= 0.0 || back.a <= 0.0) return;
    if (uScoped < 0.5) {
        vec3 bs = clamp(back.rgb / back.a, 0.0, 1.0);
        vec3 outS = mix(bs, lumAdjFull(bs), k);
        finalColor = vec4(clamp(outS, 0.0, 1.0) * back.a, back.a);
        return;
    }
    float inside = step(uScopeClamp.x, vScopeCoord.x) * step(uScopeClamp.y, vScopeCoord.y)
        * step(vScopeCoord.x, uScopeClamp.z) * step(vScopeCoord.y, uScopeClamp.w);
    vec4 c = texture(uScopeTexture, vScopeCoord) * inside;
    if (c.a <= 0.0) return;
    vec3 cs = clamp(c.rgb / c.a, 0.0, 1.0);
    vec3 delta = (lumAdjFull(cs) - cs) * k * c.a;
    finalColor = vec4(clamp(back.rgb + delta, vec3(0.0), vec3(back.a)), back.a);
}
`;

/** 256 × 1 RGBA8 lookup table texture, read with NEAREST at texel centres */
function lutTexture(): Texture {
  return new Texture({
    source: new BufferImageSource({
      resource: new Uint8Array(256 * 4),
      width: 256,
      height: 1,
      format: 'rgba8unorm',
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'nearest',
    }),
  });
}

export class AdjustmentFilter extends Filter {
  /** Clip / group scope: the sprite showing the scope composite (canvas space), else null */
  public scopeSprite: Sprite | null = null;
  private readonly lut: Texture;
  private readonly scopeMatrix: TextureMatrix;
  private readonly uniformGroup: UniformGroup;

  constructor() {
    const lut = lutTexture();
    const scopeMatrix = new TextureMatrix(Texture.EMPTY);
    const uniformGroup = new UniformGroup({
      uScopeMatrix: { value: new Matrix(), type: 'mat3x3<f32>' },
      uScopeClamp: { value: scopeMatrix.uClampFrame, type: 'vec4<f32>' },
      uHsl: { value: new Float32Array(4), type: 'vec4<f32>' },
      uCbShadows: { value: new Float32Array(3), type: 'vec3<f32>' },
      uCbMidtones: { value: new Float32Array(3), type: 'vec3<f32>' },
      uCbHighlights: { value: new Float32Array(3), type: 'vec3<f32>' },
      uCbPreserve: { value: 0, type: 'f32' },
      uProgram: { value: 0, type: 'f32' },
      uBlend: { value: 0, type: 'f32' },
      uScoped: { value: 0, type: 'f32' },
    });
    super({
      glProgram: GlProgram.from({ vertex, fragment, name: 'lumina-adjustment-filter' }),
      blendRequired: true,
      // Everything below an adjustment layer is redrawn through it: keep the screen's sharpness
      resolution: 'inherit',
      resources: {
        adjustmentUniforms: uniformGroup,
        uBackTexture: Texture.EMPTY,
        uLutTexture: lut.source,
        uScopeTexture: Texture.EMPTY.source,
      },
    });
    // The output is the whole adjusted picture under the quad: replace, never blend
    this.blendMode = 'none';
    this.lut = lut;
    this.scopeMatrix = scopeMatrix;
    this.uniformGroup = uniformGroup;
  }

  /** New parameters (compiled by the shared math) and blend mode; `scoped` = clip / group scope */
  public setAdjustment(compiled: CompiledAdjustment, blendMode: string, scoped: boolean) {
    const u = compiledAdjustmentUniforms(compiled, blendMode);
    const uniforms = this.uniformGroup.uniforms;
    (uniforms.uHsl as Float32Array).set(u.hsl);
    (uniforms.uCbShadows as Float32Array).set(u.cbShadows);
    (uniforms.uCbMidtones as Float32Array).set(u.cbMidtones);
    (uniforms.uCbHighlights as Float32Array).set(u.cbHighlights);
    uniforms.uCbPreserve = u.cbPreserve;
    uniforms.uProgram = u.program;
    uniforms.uBlend = u.blendId;
    uniforms.uScoped = scoped ? 1 : 0;
    this.uniformGroup.update();
    const source = this.lut.source as BufferImageSource;
    const lut = compiled.lut.length === 256 * 4 ? compiled.lut : new Uint8Array(256 * 4);
    (source.resource as Uint8Array).set(lut);
    source.update();
  }

  /** Unbinds the scope texture (call before destroying it) */
  public clearScope() {
    this.scopeSprite = null;
    this.scopeMatrix.texture = Texture.EMPTY;
    this.resources.uScopeTexture = Texture.EMPTY.source;
  }

  public override apply(filterManager: FilterSystem, input: Texture, output: RenderSurface, clearMode: boolean): void {
    const uniforms = this.uniformGroup.uniforms;
    const sprite = uniforms.uScoped ? this.scopeSprite : null;
    const texture = sprite && !sprite.texture.destroyed && sprite.texture.source && !sprite.texture.source.destroyed ? sprite.texture : Texture.EMPTY;
    this.scopeMatrix.texture = texture;
    this.scopeMatrix.update();
    if (sprite && texture !== Texture.EMPTY) {
      filterManager.calculateSpriteMatrix(uniforms.uScopeMatrix as Matrix, sprite).prepend(this.scopeMatrix.mapCoord);
    }
    this.resources.uScopeTexture = texture.source;
    filterManager.applyFilter(this, input, output, clearMode);
  }

  public override destroy(destroyPrograms = false): void {
    this.clearScope();
    this.scopeMatrix.destroy();
    // The filter (and its bind group) goes first, then the LUT it was bound to
    super.destroy(destroyPrograms);
    this.lut.destroy(true);
  }
}
