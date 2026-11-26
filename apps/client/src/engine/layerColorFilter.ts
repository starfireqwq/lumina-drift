import { defaultFilterVert, Filter, GlProgram, UniformGroup } from 'pixi.js';
import { DEFAULT_LAYER_MAIN_COLOR, DEFAULT_LAYER_SUB_COLOR, hexToRgb01, normalizeHexColor } from '@atelier/shared';

// Pixi uses GLSL ES 1.00 when there is no version directive, which both WebGL versions accept.
const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec3 uMainColor;
uniform vec3 uSubColor;

void main(void) {
  vec4 c = texture2D(uTexture, vTextureCoord);
  if (c.a <= 0.0001) {
    finalColor = c;
    return;
  }
  vec3 rgb = clamp(c.rgb / c.a, 0.0, 1.0);
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  vec3 mapped = mix(uMainColor, uSubColor, luma);
  finalColor = vec4(mapped * c.a, c.a);
}
`;

export class LayerColorFilter extends Filter {
  private readonly colorUniforms: UniformGroup;
  private colorKey = '';

  constructor(mainHex = DEFAULT_LAYER_MAIN_COLOR, subHex = DEFAULT_LAYER_SUB_COLOR) {
    const colorUniforms = new UniformGroup({
      uMainColor: { value: new Float32Array(3), type: 'vec3<f32>' },
      uSubColor: { value: new Float32Array(3), type: 'vec3<f32>' },
    });
    super({
      glProgram: GlProgram.from({
        vertex: defaultFilterVert,
        fragment,
        name: 'lumina-layer-color-filter',
        preferredFragmentPrecision: 'highp',
      }),
      resolution: 'inherit',
      resources: { colorUniforms },
    });
    this.colorUniforms = colorUniforms;
    this.setColors(mainHex, subHex);
  }

  public setColors(mainHex: string, subHex = DEFAULT_LAYER_SUB_COLOR): void {
    const main = normalizeHexColor(mainHex) ?? '#000000';
    const sub = normalizeHexColor(subHex) ?? '#000000';
    const key = `${main}|${sub}`;
    if (key === this.colorKey) return;
    const { uMainColor, uSubColor } = this.colorUniforms.uniforms;
    (uMainColor as Float32Array).set(hexToRgb01(main));
    (uSubColor as Float32Array).set(hexToRgb01(sub));
    this.colorUniforms.update();
    this.colorKey = key;
  }
}
