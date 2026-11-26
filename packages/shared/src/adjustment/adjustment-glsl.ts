import { ADJUSTMENT_BLEND_MODE_IDS, adjustmentBlendModeId, type CompiledAdjustment } from './adjustment-layer';

const blend = ADJUSTMENT_BLEND_MODE_IDS;

export const ADJUSTMENT_GLSL = /* glsl */ `
float lumAdjMin(vec3 c) { return min(min(c.r, c.g), c.b); }
float lumAdjMax(vec3 c) { return max(max(c.r, c.g), c.b); }

vec3 lumAdjRgbToHsl(vec3 c) {
    float hi = lumAdjMax(c);
    float lo = lumAdjMin(c);
    float l = (hi + lo) / 2.0;
    float delta = hi - lo;
    if (delta == 0.0) return vec3(0.0, 0.0, l);
    float s = delta / (1.0 - abs(2.0 * l - 1.0));
    float sector = hi == c.r ? (c.g - c.b) / delta :
        hi == c.g ? 2.0 + (c.b - c.r) / delta : 4.0 + (c.r - c.g) / delta;
    return vec3(fract(sector / 6.0), s, l);
}

vec3 lumAdjHslToRgb(float h, float s, float l) {
    float chroma = (1.0 - abs(2.0 * l - 1.0)) * s;
    float m = l - chroma / 2.0;
    float sector = fract(h) * 6.0;
    float x = chroma * (1.0 - abs(mod(sector, 2.0) - 1.0));
    float hi = clamp(chroma + m, 0.0, 1.0);
    float mid = clamp(x + m, 0.0, 1.0);
    float lo = clamp(m, 0.0, 1.0);
    if (sector < 1.0) return vec3(hi, mid, lo);
    if (sector < 2.0) return vec3(mid, hi, lo);
    if (sector < 3.0) return vec3(lo, hi, mid);
    if (sector < 4.0) return vec3(lo, mid, hi);
    if (sector < 5.0) return vec3(mid, lo, hi);
    return vec3(hi, lo, mid);
}

float lumAdjLightness(float v, float amount) {
    return amount < 0.0 ? v * (1.0 + amount) : v + (1.0 - v) * amount;
}

float lumAdjLuma(vec3 c) {
    return (c.r * 299.0 + c.g * 587.0 + c.b * 114.0) / 1000.0;
}

vec3 lumAdjLut(sampler2D lut, float index) {
    return texture(lut, vec2((index + 0.5) / 256.0, 0.5)).rgb;
}

vec3 lumAdjApply(vec3 c, sampler2D lut, int program, vec4 hsl,
                 vec3 cbShadows, vec3 cbMidtones, vec3 cbHighlights, float cbPreserve) {
    if (program == 0) {
        vec3 index = floor(c * 255.0 + 0.5);
        return vec3(lumAdjLut(lut, index.r).r, lumAdjLut(lut, index.g).g, lumAdjLut(lut, index.b).b);
    }
    if (program == 1) {
        float l = (lumAdjMax(c) + lumAdjMin(c)) / 2.0;
        float a = 0.25, center = 0.333, k = 0.7;
        float shadows = clamp((l - center) / -a + 0.5, 0.0, 1.0) * k;
        float midtones = clamp((l - center) / a + 0.5, 0.0, 1.0) * clamp((l + center - 1.0) / -a + 0.5, 0.0, 1.0) * k;
        float highlights = clamp((l + center - 1.0) / a + 0.5, 0.0, 1.0) * k;
        vec3 result = clamp(c + cbShadows * shadows + cbMidtones * midtones + cbHighlights * highlights, 0.0, 1.0);
        if (cbPreserve == 0.0) return result;
        vec3 tone = lumAdjRgbToHsl(result);
        return lumAdjHslToRgb(tone.x, tone.y, l);
    }
    if (program == 2) {
        if (hsl.w != 0.0) {
            return lumAdjHslToRgb(hsl.x, hsl.y, lumAdjLightness(lumAdjLuma(c), hsl.z));
        }
        vec3 tone = lumAdjRgbToHsl(c);
        float h = fract(tone.x + hsl.x);
        float s = clamp(tone.y * (1.0 + hsl.y), 0.0, 1.0);
        float l = lumAdjLightness(tone.z, hsl.z);
        return lumAdjHslToRgb(h, s, l);
    }
    return lumAdjLut(lut, floor(lumAdjLuma(c * 255.0) + 0.5));
}

float lumAdjLum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
float lumAdjSat(vec3 c) { return lumAdjMax(c) - lumAdjMin(c); }

vec3 lumAdjClipColor(vec3 c) {
    float l = lumAdjLum(c);
    float lo = lumAdjMin(c);
    float hi = lumAdjMax(c);
    if (lo < 0.0) c = l + (c - l) * l / (l - lo);
    if (hi > 1.0) c = l + (c - l) * (1.0 - l) / (hi - l);
    return c;
}

vec3 lumAdjSetLum(vec3 c, float l) {
    float delta = l - lumAdjLum(c);
    return lumAdjClipColor(c + delta);
}

vec3 lumAdjSetSat(vec3 c, float s) {
    float lo = lumAdjMin(c);
    float range = lumAdjMax(c) - lo;
    if (range == 0.0) return vec3(0.0);
    return (c - lo) * s / range;
}

float lumAdjBlendComponent(float src, float dst, int mode) {
    float s = clamp(src, 0.0, 1.0);
    float d = clamp(dst, 0.0, 1.0);
    if (mode == ${blend.multiply}) return s * d;
    if (mode == ${blend.screen}) return 1.0 - (1.0 - s) * (1.0 - d);
    if (mode == ${blend.overlay}) return d < 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);
    if (mode == ${blend.add}) return min(1.0, s + d);
    if (mode == ${blend.color_dodge}) return s >= 1.0 ? 1.0 : min(1.0, d / (1.0 - s + 0.00001));
    if (mode == ${blend.color_burn}) return s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - d) / (s + 0.00001));
    if (mode == ${blend.linear_burn}) return max(0.0, s + d - 1.0);
    if (mode == ${blend.darken}) return min(s, d);
    if (mode == ${blend.lighten}) return max(s, d);
    if (mode == ${blend.glow}) return min(1.0, d + s * 1.35);
    if (mode == ${blend.vivid_light}) {
        return s < 0.5
            ? (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - d) / (2.0 * s + 0.00001)))
            : (s >= 1.0 ? 1.0 : min(1.0, d / (2.0 * (1.0 - s) + 0.00001)));
    }
    if (mode == ${blend.linear_light}) return clamp(d + 2.0 * s - 1.0, 0.0, 1.0);
    if (mode == ${blend.pin_light}) return s > 0.5 ? max(d, 2.0 * (s - 0.5)) : min(d, 2.0 * s);
    if (mode == ${blend.hard_mix}) return s + d >= 1.0 ? 1.0 : 0.0;
    if (mode == ${blend.divide}) return s <= 0.0 ? 1.0 : min(1.0, d / s);
    if (mode == ${blend.hard_light}) return s < 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);
    if (mode == ${blend.soft_light}) return (1.0 - 2.0 * s) * d * d + 2.0 * s * d;
    if (mode == ${blend.difference}) return abs(s - d);
    if (mode == ${blend.exclusion}) return s + d - 2.0 * s * d;
    if (mode == ${blend.subtract}) return max(0.0, d - s);
    return s;
}

vec3 lumAdjBlend(vec3 src, vec3 dst, int mode) {
    if (mode == ${blend.normal}) return src;
    if (mode == ${blend.hue}) return lumAdjSetLum(lumAdjSetSat(src, lumAdjSat(dst)), lumAdjLum(dst));
    if (mode == ${blend.saturation}) return lumAdjSetLum(lumAdjSetSat(dst, lumAdjSat(src)), lumAdjLum(dst));
    if (mode == ${blend.color}) return lumAdjSetLum(src, lumAdjLum(dst));
    if (mode == ${blend.luminosity}) return lumAdjSetLum(dst, lumAdjLum(src));
    if (mode == ${blend.darker_color}) return lumAdjLum(src) < lumAdjLum(dst) ? src : dst;
    if (mode == ${blend.lighter_color}) return lumAdjLum(src) > lumAdjLum(dst) ? src : dst;
    return vec3(lumAdjBlendComponent(src.r, dst.r, mode), lumAdjBlendComponent(src.g, dst.g, mode),
                lumAdjBlendComponent(src.b, dst.b, mode));
}
`;

export function compiledAdjustmentUniforms(compiled: CompiledAdjustment, blendMode: string) {
  return {
    program: compiled.program,
    hsl: compiled.hsl,
    cbShadows: compiled.cb.shadows,
    cbMidtones: compiled.cb.midtones,
    cbHighlights: compiled.cb.highlights,
    cbPreserve: compiled.cb.preserve,
    blendId: adjustmentBlendModeId(blendMode),
  };
}
