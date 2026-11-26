import {
  defaultFilterVert,
  Filter,
  GlProgram,
  UniformGroup,
  type Container,
  type FilterSystem,
  type RenderSurface,
  type Texture,
} from 'pixi.js';
import {
  computeLayerEffectsPadding,
  hasActiveLayerEffects,
  hexToRgb01,
  layerEffectsKey,
  type LayerEffectOverlayBlendMode,
  type LayerEffectsMeta,
} from '@atelier/shared';

const OVERLAY_BLEND_ID: Record<LayerEffectOverlayBlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
};

const fragment = `#version 300 es
precision highp float;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputClamp;

// Canvas pixel basis vectors in filter UV space
uniform vec2 uCanvasDx;
uniform vec2 uCanvasDy;

// Border: x=enabled(0/1), y=mode(0=edge,1=watercolor), z=width, w=opacity
uniform vec4 uBorderParams;
// Border extra: x=antiAlias(0/1), y=wcDarkness, z=wcBlur, w=0
uniform vec4 uBorderExtra;
uniform vec3 uBorderColor;

// Shadow: x=enabled(0/1), y=opacity, z=offsetX, w=offsetY
uniform vec4 uShadowParams;
// Shadow extra: x=blur, y=spread, z=0, w=0
uniform vec4 uShadowExtra;
uniform vec3 uShadowColor;

// Glow: x=enabled(0/1), y=opacity, z=radius, w=spread
uniform vec4 uGlowParams;
uniform vec3 uGlowColor;

// Overlay: x=enabled(0/1), y=opacity, z=blendMode(0=normal,1=multiply,2=screen,3=overlay), w=0
uniform vec4 uOverlayParams;
uniform vec3 uOverlayColor;

vec4 sampleAt(vec2 canvasOffset) {
  vec2 uv = vTextureCoord + canvasOffset.x * uCanvasDx + canvasOffset.y * uCanvasDy;
  if (uv.x < uInputClamp.x || uv.y < uInputClamp.y || uv.x > uInputClamp.z || uv.y > uInputClamp.w) {
    return vec4(0.0);
  }
  return texture(uTexture, uv);
}

vec3 applyOverlayBlend(vec3 base, vec3 ov, float mode) {
  if (mode < 0.5) return ov;
  if (mode < 1.5) return base * ov;
  if (mode < 2.5) return vec3(1.0) - (vec3(1.0) - base) * (vec3(1.0) - ov);
  return mix(2.0 * base * ov, vec3(1.0) - 2.0 * (vec3(1.0) - base) * (vec3(1.0) - ov), step(0.5, base));
}

// Smoothly blurred alpha around baseOffset using 2-ring weighted disc sampling
float sampleBlurredAlpha(vec2 baseOffset, float radius, float spread) {
  float centerA = sampleAt(baseOffset).a;
  if (radius <= 0.25 && spread <= 0.25) return centerA;

  float totalR = max(0.5, radius + spread);
  float wSum = 1.0;
  float aSum = centerA;
  float maxA = centerA;

  // 2 concentric rings (8 + 16 samples) for smooth circular blur & spread
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.78539816;
    vec2 dir = vec2(cos(ang), sin(ang));
    float a1 = sampleAt(baseOffset + dir * (totalR * 0.48)).a;
    aSum += a1 * 0.75;
    wSum += 0.75;
    if (spread > 0.25) {
      float as = sampleAt(baseOffset + dir * spread).a;
      maxA = max(maxA, as);
    }
  }
  for (int i = 0; i < 16; i++) {
    float ang = float(i) * 0.39269908 + 0.19634954;
    vec2 dir = vec2(cos(ang), sin(ang));
    float a2 = sampleAt(baseOffset + dir * totalR).a;
    aSum += a2 * 0.38;
    wSum += 0.38;
  }

  float avg = aSum / wSum;
  if (spread <= 0.25) return avg;
  float spreadMix = clamp(spread / max(1.0, radius + spread), 0.0, 0.85);
  return clamp(mix(avg, max(avg, maxA), spreadMix), 0.0, 1.0);
}

// Circular dilation for crisp/anti-aliased edge border
float sampleBorderAlpha(float width, float antiAlias) {
  float maxA = sampleAt(vec2(0.0)).a;
  if (maxA >= 0.999) return 1.0;

  // Inner ring (half radius) + outer ring (full radius, 24 directions)
  for (int i = 0; i < 12; i++) {
    float ang = float(i) * 0.52359877;
    vec2 dir = vec2(cos(ang), sin(ang));
    maxA = max(maxA, sampleAt(dir * (width * 0.5)).a);
  }
  for (int i = 0; i < 24; i++) {
    float ang = float(i) * 0.26179939;
    vec2 dir = vec2(cos(ang), sin(ang));
    maxA = max(maxA, sampleAt(dir * width).a);
  }
  if (antiAlias < 0.5) {
    return step(0.08, maxA);
  }
  return smoothstep(0.02, 0.45, maxA);
}

vec4 compositeOver(vec4 topPm, vec4 bottomPm) {
  return topPm + bottomPm * (1.0 - topPm.a);
}

void main(void) {
  vec4 src = sampleAt(vec2(0.0));
  vec4 acc = vec4(0.0);

  // 1. Drop Shadow
  if (uShadowParams.x > 0.5 && uShadowParams.y > 0.0) {
    vec2 shift = -uShadowParams.zw;
    float shA = sampleBlurredAlpha(shift, uShadowExtra.x, uShadowExtra.y) * uShadowParams.y;
    if (shA > 0.0005) {
      acc = compositeOver(vec4(uShadowColor * shA, shA), acc);
    }
  }

  // 2. Outer Glow
  if (uGlowParams.x > 0.5 && uGlowParams.y > 0.0) {
    float glA = sampleBlurredAlpha(vec2(0.0), uGlowParams.z, uGlowParams.w) * uGlowParams.y;
    if (glA > 0.0005) {
      acc = compositeOver(vec4(uGlowColor * glA, glA), acc);
    }
  }

  // 3. Edge Border (solid outline behind content)
  if (uBorderParams.x > 0.5 && uBorderParams.y < 0.5 && uBorderParams.z > 0.0 && uBorderParams.w > 0.0) {
    float bA = sampleBorderAlpha(uBorderParams.z, uBorderExtra.x) * uBorderParams.w;
    if (bA > 0.0005) {
      acc = compositeOver(vec4(uBorderColor * bA, bA), acc);
    }
  }

  // 4. Watercolor outer bleed (behind main content)
  bool isWatercolor = uBorderParams.x > 0.5 && uBorderParams.y >= 0.5 && uBorderParams.z > 0.0 && uBorderParams.w > 0.0;
  float wcDarkness = isWatercolor ? (uBorderExtra.y * uBorderParams.w) : 0.0;
  if (isWatercolor && uBorderExtra.z > 0.25 && src.a < 0.999) {
    float blurR = uBorderExtra.z;
    vec4 bleedSum = vec4(0.0);
    float wSum = 0.0;
    for (int i = 0; i < 12; i++) {
      float ang = float(i) * 0.52359877;
      vec2 dir = vec2(cos(ang), sin(ang));
      bleedSum += sampleAt(dir * blurR) * 0.65;
      bleedSum += sampleAt(dir * (blurR * 0.5)) * 1.0;
      wSum += 1.65;
    }
    vec4 bleedAvg = bleedSum / max(1.0, wSum);
    if (bleedAvg.a > 0.002) {
      vec3 bRgb = clamp(bleedAvg.rgb / bleedAvg.a, 0.0, 1.0);
      if (uOverlayParams.x > 0.5 && uOverlayParams.y > 0.0) {
        vec3 ovRgb = applyOverlayBlend(bRgb, uOverlayColor, uOverlayParams.z);
        bRgb = mix(bRgb, ovRgb, uOverlayParams.y);
      }
      float outBleedA = clamp(bleedAvg.a * (1.0 - src.a) * wcDarkness * 0.42, 0.0, 1.0);
      acc = compositeOver(vec4(bRgb * outBleedA, outBleedA), acc);
    }
  }

  // 5. Source content + Color Overlay + Watercolor interior rim darkening
  if (src.a > 0.0005) {
    vec3 rgb = clamp(src.rgb / src.a, 0.0, 1.0);
    float outA = src.a;

    if (uOverlayParams.x > 0.5 && uOverlayParams.y > 0.0) {
      vec3 blended = applyOverlayBlend(rgb, uOverlayColor, uOverlayParams.z);
      rgb = mix(rgb, blended, uOverlayParams.y);
    }

    if (isWatercolor) {
      float avgA = sampleBlurredAlpha(vec2(0.0), max(1.0, uBorderParams.z), 0.0);
      float edge = clamp(((outA - avgA) / max(0.2, outA)) * 1.85, 0.0, 1.0);
      float strength = edge * wcDarkness;
      if (strength > 0.0) {
        vec3 darkRgb = rgb * (vec3(0.28) + 0.44 * rgb);
        rgb = mix(rgb, darkRgb, strength);
        outA = clamp(outA + strength * 0.25 * outA, 0.0, 1.0);
      }
    }

    acc = compositeOver(vec4(rgb * outA, outA), acc);
  }

  finalColor = acc;
}
`;

export class LayerEffectsFilter extends Filter {
  private readonly fxUniforms: UniformGroup;
  private currentKey = '';
  private basePadding = 0;
  private refContainer: Container | null = null;

  constructor(effects: LayerEffectsMeta, refContainer?: Container | null) {
    const fxUniforms = new UniformGroup({
      uCanvasDx: { value: new Float32Array([1 / 1024, 0]), type: 'vec2<f32>' },
      uCanvasDy: { value: new Float32Array([0, 1 / 1024]), type: 'vec2<f32>' },
      uBorderParams: { value: new Float32Array(4), type: 'vec4<f32>' },
      uBorderExtra: { value: new Float32Array(4), type: 'vec4<f32>' },
      uBorderColor: { value: new Float32Array(3), type: 'vec3<f32>' },
      uShadowParams: { value: new Float32Array(4), type: 'vec4<f32>' },
      uShadowExtra: { value: new Float32Array(4), type: 'vec4<f32>' },
      uShadowColor: { value: new Float32Array(3), type: 'vec3<f32>' },
      uGlowParams: { value: new Float32Array(4), type: 'vec4<f32>' },
      uGlowColor: { value: new Float32Array(3), type: 'vec3<f32>' },
      uOverlayParams: { value: new Float32Array(4), type: 'vec4<f32>' },
      uOverlayColor: { value: new Float32Array(3), type: 'vec3<f32>' },
    });
    super({
      glProgram: GlProgram.from({
        vertex: defaultFilterVert,
        fragment,
        name: 'lumina-layer-effects-filter',
        preferredFragmentPrecision: 'highp',
      }),
      resolution: 'inherit',
      padding: computeLayerEffectsPadding(effects),
      resources: { fxUniforms },
    });
    this.fxUniforms = fxUniforms;
    this.refContainer = refContainer ?? null;
    this.setEffects(effects);
  }

  public setReferenceContainer(container: Container | null): void {
    this.refContainer = container;
  }

  public setEffects(effects: LayerEffectsMeta): void {
    const key = layerEffectsKey(effects);
    if (key === this.currentKey) return;
    this.currentKey = key;
    this.basePadding = computeLayerEffectsPadding(effects);
    this.padding = this.basePadding;

    const u = this.fxUniforms.uniforms;
    const active = hasActiveLayerEffects(effects);

    const b = active ? effects.border : null;
    (u.uBorderParams as Float32Array).set([
      b?.enabled ? 1 : 0,
      b?.mode === 'watercolor' ? 1 : 0,
      b?.width ?? 0,
      b?.opacity ?? 0,
    ]);
    (u.uBorderExtra as Float32Array).set([
      b?.antiAlias === false ? 0 : 1,
      b?.watercolorDarkness ?? 0.55,
      b?.watercolorBlur ?? 3,
      0,
    ]);
    (u.uBorderColor as Float32Array).set(hexToRgb01(b?.color ?? '#111827'));

    const s = active ? effects.dropShadow : null;
    (u.uShadowParams as Float32Array).set([
      s?.enabled ? 1 : 0,
      s?.opacity ?? 0,
      s?.offsetX ?? 0,
      s?.offsetY ?? 0,
    ]);
    (u.uShadowExtra as Float32Array).set([s?.blur ?? 0, s?.spread ?? 0, 0, 0]);
    (u.uShadowColor as Float32Array).set(hexToRgb01(s?.color ?? '#000000'));

    const g = active ? effects.outerGlow : null;
    (u.uGlowParams as Float32Array).set([
      g?.enabled ? 1 : 0,
      g?.opacity ?? 0,
      g?.radius ?? 0,
      g?.spread ?? 0,
    ]);
    (u.uGlowColor as Float32Array).set(hexToRgb01(g?.color ?? '#60A5FA'));

    const o = active ? effects.colorOverlay : null;
    (u.uOverlayParams as Float32Array).set([
      o?.enabled ? 1 : 0,
      o?.opacity ?? 0,
      OVERLAY_BLEND_ID[o?.blendMode ?? 'normal'] ?? 0,
      0,
    ]);
    (u.uOverlayColor as Float32Array).set(hexToRgb01(o?.color ?? '#6366F1'));

    this.fxUniforms.update();
  }

  public updateZoomPadding(zoom: number): void {
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    this.padding = Math.min(256, Math.ceil(this.basePadding * Math.max(1, scale)));
  }

  public override apply(filterManager: FilterSystem, input: Texture, output: RenderSurface, clearMode: boolean): void {
    const inW = Math.max(1, input.source.width);
    const inH = Math.max(1, input.source.height);
    const wt = this.refContainer?.worldTransform;
    const u = this.fxUniforms.uniforms;
    if (wt) {
      (u.uCanvasDx as Float32Array).set([wt.a / inW, wt.b / inH]);
      (u.uCanvasDy as Float32Array).set([wt.c / inW, wt.d / inH]);
    } else {
      (u.uCanvasDx as Float32Array).set([1 / inW, 0]);
      (u.uCanvasDy as Float32Array).set([0, 1 / inH]);
    }
    this.fxUniforms.update();
    filterManager.applyFilter(this, input, output, clearMode);
  }
}
