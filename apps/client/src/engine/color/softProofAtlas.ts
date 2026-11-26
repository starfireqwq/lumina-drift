import { clampUnit, type Vec3 } from './colorMath';

export function packSoftProofAtlas({ size, data }: { size: number; data: Uint8Array }): Uint8Array {
  const atlas = new Uint8Array(data.length);
  const row = size * 4;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      const start = (b * size + g) * row;
      atlas.set(data.subarray(start, start + row), (g * size + b) * row);
    }
  }
  return atlas;
}

export function sampleSoftProofAtlas(atlas: Uint8Array, size: number, r: number, g: number, b: number): { rgb: Vec3; gamut: number } {
  const max = size - 1;
  const x = clampUnit(r / 255) * max;
  const y = clampUnit(g / 255) * max;
  const z = clampUnit(b / 255) * max;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = Math.min(x0 + 1, max);
  const y1 = Math.min(y0 + 1, max);
  const z1 = Math.min(z0 + 1, max);
  const row = size * size;
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const channel = (offset: number) => {
    const sampleSlice = (slice: number) => {
      const left = slice * size + x0;
      const right = slice * size + x1;
      const texel = (column: number, rowIndex: number) => atlas[(rowIndex * row + column) * 4 + offset];
      const top = mix(texel(left, y0), texel(right, y0), x - x0);
      const bottom = mix(texel(left, y1), texel(right, y1), x - x0);
      return mix(top, bottom, y - y0);
    };
    return mix(sampleSlice(z0), sampleSlice(z1), z - z0);
  };
  return { rgb: [channel(0), channel(1), channel(2)], gamut: channel(3) / 255 };
}

export const SOFT_PROOF_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uLut;
uniform float uLutSize;
uniform float uProof;
uniform float uGamut;
uniform vec3 uWarnColor;

vec4 sampleSlice(vec2 point, float slice) {
    float n = uLutSize;
    return texture(uLut, vec2((point.x + 0.5 + slice * n) / (n * n), (point.y + 0.5) / n));
}

void main(void) {
    vec4 inputColor = texture(uTexture, vTextureCoord);
    if (inputColor.a == 0.0) {
        finalColor = inputColor;
        return;
    }

    vec3 rgb = clamp(inputColor.rgb / inputColor.a, 0.0, 1.0);
    vec3 p = rgb * (uLutSize - 1.0);
    float b0 = floor(p.b);
    float b1 = min(b0 + 1.0, uLutSize - 1.0);
    vec4 proof = mix(sampleSlice(p.rg, b0), sampleSlice(p.rg, b1), p.b - b0);
    vec3 color = uProof > 0.5 ? proof.rgb : rgb;
    if (uGamut > 0.5 && proof.a > 0.5) {
        float strength = mod(gl_FragCoord.x + gl_FragCoord.y, 6.0) < 3.0 ? 0.9 : 0.6;
        color = mix(color, uWarnColor, strength);
    }
    finalColor = vec4(color * inputColor.a, inputColor.a);
}
`;
