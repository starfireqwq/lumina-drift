/**
 * CSP/Krita Professional Layer Blend Modes Engine
 *
 * Implements standard digital painting blend equations in both
 * TypeScript/JavaScript and WebGL2 GLSL ES 3.00.
 */

import { BlendMode } from '../types/models';

/**
 * Evaluates blend mode equation on normalized RGB floats [0..1]
 * dst = bottom layer (backdrop), src = top layer (source)
 */
export function blendComponent(src: number, dst: number, mode: BlendMode): number {
  const s = Math.max(0.0, Math.min(1.0, src));
  const d = Math.max(0.0, Math.min(1.0, dst));

  const normalized = mode.toLowerCase().replace(/-/g, '_');

  switch (normalized) {
    case 'multiply':
      // 色彩增值 / 正片疊底
      return s * d;

    case 'screen':
      // 濾色
      return 1.0 - (1.0 - s) * (1.0 - d);

    case 'overlay':
      // 覆蓋 / 疊加
      return d < 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);

    case 'add':
    case 'linear_dodge':
      // 發光 / 加亮
      return Math.min(1.0, s + d);

    case 'color_dodge':
      // 顏色減淡
      return s >= 1.0 ? 1.0 : Math.min(1.0, d / (1.0 - s + 0.00001));

    case 'color_burn':
      // 顏色加深
      return s <= 0.0 ? 0.0 : 1.0 - Math.min(1.0, (1.0 - d) / (s + 0.00001));

    case 'linear_burn':
      // 線性加深 (Linear Burn)
      return Math.max(0.0, s + d - 1.0);

    case 'darken':
      // 變暗
      return Math.min(s, d);

    case 'darker_color':
      return s < d ? s : d;

    case 'lighten':
      // 變亮
      return Math.max(s, d);

    case 'lighter_color':
      return s > d ? s : d;

    case 'glow':
      // 發光 (Glow / CSP 局部發光)
      return Math.min(1.0, d + s * 1.35);

    case 'vivid_light':
      // 亮光 (Vivid Light)
      return s < 0.5
        ? (s <= 0.0 ? 0.0 : 1.0 - Math.min(1.0, (1.0 - d) / (2.0 * s + 0.00001)))
        : (s >= 1.0 ? 1.0 : Math.min(1.0, d / (2.0 * (1.0 - s) + 0.00001)));

    case 'linear_light':
      // 線性光 (Linear Light)
      return Math.max(0.0, Math.min(1.0, d + 2.0 * s - 1.0));

    case 'pin_light':
      // 點光 (Pin Light)
      return s > 0.5 ? Math.max(d, 2.0 * (s - 0.5)) : Math.min(d, 2.0 * s);

    case 'hard_mix':
      // 實色混合 (Hard Mix)
      return s + d >= 1.0 ? 1.0 : 0.0;

    case 'divide':
      // 劃分 (Divide)
      return s <= 0.0 ? 1.0 : Math.min(1.0, d / s);

    case 'hard_light':
      return s < 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);

    case 'soft_light':
      return (1.0 - 2.0 * s) * d * d + 2.0 * s * d;

    case 'difference':
      // 差值
      return Math.abs(s - d);

    case 'exclusion':
      // 排除
      return s + d - 2.0 * s * d;

    case 'subtract':
      // 減去
      return Math.max(0.0, d - s);

    case 'normal':
    default:
      return s;
  }
}

/**
 * Evaluates blend mode on RGBA (0..255) with alpha compositing
 */
export function evaluateBlendModeRgba(
  srcR: number,
  srcG: number,
  srcB: number,
  srcA: number,
  dstR: number,
  dstG: number,
  dstB: number,
  dstA: number,
  mode: BlendMode,
  layerOpacity: number = 1.0
): [number, number, number, number] {
  const sa = (srcA / 255.0) * Math.max(0.0, Math.min(1.0, layerOpacity));
  const da = dstA / 255.0;

  if (sa <= 0.0) return [dstR, dstG, dstB, dstA];
  if (da <= 0.0) return [srcR, srcG, srcB, Math.round(sa * 255)];

  const sNormR = srcR / 255.0;
  const sNormG = srcG / 255.0;
  const sNormB = srcB / 255.0;

  const dNormR = dstR / 255.0;
  const dNormG = dstG / 255.0;
  const dNormB = dstB / 255.0;

  // 1. Blend RGB
  const blendedR = blendComponent(sNormR, dNormR, mode);
  const blendedG = blendComponent(sNormG, dNormG, mode);
  const blendedB = blendComponent(sNormB, dNormB, mode);

  // 2. Alpha compositing: outA = sa + da * (1 - sa)
  const outA = sa + da * (1.0 - sa);
  const finalR = (blendedR * sa + dNormR * da * (1.0 - sa)) / (outA || 1.0);
  const finalG = (blendedG * sa + dNormG * da * (1.0 - sa)) / (outA || 1.0);
  const finalB = (blendedB * sa + dNormB * da * (1.0 - sa)) / (outA || 1.0);

  return [
    Math.round(Math.max(0, Math.min(255, finalR * 255))),
    Math.round(Math.max(0, Math.min(255, finalG * 255))),
    Math.round(Math.max(0, Math.min(255, finalB * 255))),
    Math.round(Math.max(0, Math.min(255, outA * 255))),
  ];
}

/**
 * WebGL2 GLSL code for Layer Blend Modes
 */
export const BLEND_MODES_GLSL = /* glsl */ `
vec3 blendMultiply(vec3 src, vec3 dst) {
    return src * dst;
}

vec3 blendScreen(vec3 src, vec3 dst) {
    return vec3(1.0) - (vec3(1.0) - src) * (vec3(1.0) - dst);
}

vec3 blendOverlay(vec3 src, vec3 dst) {
    return vec3(
        dst.r < 0.5 ? 2.0 * src.r * dst.r : 1.0 - 2.0 * (1.0 - src.r) * (1.0 - dst.r),
        dst.g < 0.5 ? 2.0 * src.g * dst.g : 1.0 - 2.0 * (1.0 - src.g) * (1.0 - dst.g),
        dst.b < 0.5 ? 2.0 * src.b * dst.b : 1.0 - 2.0 * (1.0 - src.b) * (1.0 - dst.b)
    );
}

vec3 blendAdd(vec3 src, vec3 dst) {
    return min(vec3(1.0), src + dst);
}

vec3 blendColorDodge(vec3 src, vec3 dst) {
    return vec3(
        src.r >= 1.0 ? 1.0 : min(1.0, dst.r / (1.0 - src.r + 0.00001)),
        src.g >= 1.0 ? 1.0 : min(1.0, dst.g / (1.0 - src.g + 0.00001)),
        src.b >= 1.0 ? 1.0 : min(1.0, dst.b / (1.0 - src.b + 0.00001))
    );
}

vec3 blendColorBurn(vec3 src, vec3 dst) {
    return vec3(
        src.r <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - dst.r) / (src.r + 0.00001)),
        src.g <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - dst.g) / (src.g + 0.00001)),
        src.b <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - dst.b) / (src.b + 0.00001))
    );
}

vec3 blendDarken(vec3 src, vec3 dst) {
    return min(src, dst);
}

vec3 blendLighten(vec3 src, vec3 dst) {
    return max(src, dst);
}

vec3 blendDifference(vec3 src, vec3 dst) {
    return abs(src - dst);
}

vec3 blendSubtract(vec3 src, vec3 dst) {
    return max(vec3(0.0), dst - src);
}

vec4 compositeLayer(vec4 src, vec4 dst, int mode, float opacity) {
    float sa = src.a * clamp(opacity, 0.0, 1.0);
    float da = dst.a;
    if (sa <= 0.0) return dst;
    if (da <= 0.0) return vec4(src.rgb, sa);

    vec3 blended = src.rgb;
    if (mode == 1) blended = blendMultiply(src.rgb, dst.rgb);
    else if (mode == 2) blended = blendScreen(src.rgb, dst.rgb);
    else if (mode == 3) blended = blendOverlay(src.rgb, dst.rgb);
    else if (mode == 4) blended = blendAdd(src.rgb, dst.rgb);
    else if (mode == 5) blended = blendColorDodge(src.rgb, dst.rgb);
    else if (mode == 6) blended = blendColorBurn(src.rgb, dst.rgb);
    else if (mode == 7) blended = blendDarken(src.rgb, dst.rgb);
    else if (mode == 8) blended = blendLighten(src.rgb, dst.rgb);
    else if (mode == 9) blended = blendDifference(src.rgb, dst.rgb);
    else if (mode == 10) blended = blendSubtract(src.rgb, dst.rgb);

    float outA = sa + da * (1.0 - sa);
    vec3 outRgb = (blended * sa + dst.rgb * da * (1.0 - sa)) / max(outA, 0.0001);
    return vec4(outRgb, outA);
}
`;
