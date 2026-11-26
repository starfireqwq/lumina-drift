import { hexToRgb01, normalizeHexColor } from './layer-color';

export type LayerEffectBorderMode = 'edge' | 'watercolor';
export type LayerEffectOverlayBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';

export interface LayerBorderEffect {
  enabled: boolean;
  mode: LayerEffectBorderMode;
  width: number;
  color: string;
  opacity: number;
  antiAlias?: boolean;
  watercolorDarkness?: number;
  watercolorBlur?: number;
}

export interface LayerDropShadowEffect {
  enabled: boolean;
  color: string;
  opacity: number;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread?: number;
}

export interface LayerOuterGlowEffect {
  enabled: boolean;
  color: string;
  opacity: number;
  radius: number;
  spread?: number;
}

export interface LayerColorOverlayEffect {
  enabled: boolean;
  color: string;
  opacity: number;
  blendMode?: LayerEffectOverlayBlendMode;
}

export interface LayerEffectsMeta {
  enabled: boolean;
  border?: LayerBorderEffect | null;
  dropShadow?: LayerDropShadowEffect | null;
  outerGlow?: LayerOuterGlowEffect | null;
  colorOverlay?: LayerColorOverlayEffect | null;
}

export const DEFAULT_LAYER_BORDER_EFFECT: LayerBorderEffect = {
  enabled: false,
  mode: 'edge',
  width: 4,
  color: '#111827',
  opacity: 1,
  antiAlias: true,
  watercolorDarkness: 0.55,
  watercolorBlur: 3,
};

export const DEFAULT_LAYER_DROP_SHADOW_EFFECT: LayerDropShadowEffect = {
  enabled: false,
  color: '#000000',
  opacity: 0.45,
  offsetX: 6,
  offsetY: 6,
  blur: 10,
  spread: 0,
};

export const DEFAULT_LAYER_OUTER_GLOW_EFFECT: LayerOuterGlowEffect = {
  enabled: false,
  color: '#60A5FA',
  opacity: 0.75,
  radius: 12,
  spread: 0,
};

export const DEFAULT_LAYER_COLOR_OVERLAY_EFFECT: LayerColorOverlayEffect = {
  enabled: false,
  color: '#6366F1',
  opacity: 0.6,
  blendMode: 'normal',
};

export function createDefaultLayerEffects(): LayerEffectsMeta {
  return {
    enabled: true,
    border: { ...DEFAULT_LAYER_BORDER_EFFECT },
    dropShadow: { ...DEFAULT_LAYER_DROP_SHADOW_EFFECT },
    outerGlow: { ...DEFAULT_LAYER_OUTER_GLOW_EFFECT },
    colorOverlay: { ...DEFAULT_LAYER_COLOR_OVERLAY_EFFECT },
  };
}

const VALID_BORDER_MODES = new Set<LayerEffectBorderMode>(['edge', 'watercolor']);
const VALID_OVERLAY_BLENDS = new Set<LayerEffectOverlayBlendMode>(['normal', 'multiply', 'screen', 'overlay']);

function clampNum(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, value));
}

function normalizeBorderEffect(input: unknown): LayerBorderEffect | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return null;
  const mode = r.mode === undefined ? 'edge' : r.mode;
  if (typeof mode !== 'string' || !VALID_BORDER_MODES.has(mode as LayerEffectBorderMode)) return null;
  const width = clampNum(r.width, 1, 64);
  const opacity = clampNum(r.opacity ?? 1, 0, 1);
  const color = normalizeHexColor(r.color ?? DEFAULT_LAYER_BORDER_EFFECT.color);
  if (width === null || opacity === null || !color) return null;
  const antiAlias = r.antiAlias === undefined ? true : r.antiAlias;
  if (typeof antiAlias !== 'boolean') return null;
  const watercolorDarkness = clampNum(r.watercolorDarkness ?? DEFAULT_LAYER_BORDER_EFFECT.watercolorDarkness, 0, 1);
  const watercolorBlur = clampNum(r.watercolorBlur ?? DEFAULT_LAYER_BORDER_EFFECT.watercolorBlur, 0, 32);
  if (watercolorDarkness === null || watercolorBlur === null) return null;
  return {
    enabled: r.enabled,
    mode: mode as LayerEffectBorderMode,
    width: Math.round(width * 10) / 10,
    color,
    opacity: Math.round(opacity * 1000) / 1000,
    antiAlias,
    watercolorDarkness: Math.round(watercolorDarkness * 1000) / 1000,
    watercolorBlur: Math.round(watercolorBlur * 10) / 10,
  };
}

function normalizeDropShadowEffect(input: unknown): LayerDropShadowEffect | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return null;
  const color = normalizeHexColor(r.color ?? DEFAULT_LAYER_DROP_SHADOW_EFFECT.color);
  const opacity = clampNum(r.opacity ?? DEFAULT_LAYER_DROP_SHADOW_EFFECT.opacity, 0, 1);
  const offsetX = clampNum(r.offsetX ?? DEFAULT_LAYER_DROP_SHADOW_EFFECT.offsetX, -128, 128);
  const offsetY = clampNum(r.offsetY ?? DEFAULT_LAYER_DROP_SHADOW_EFFECT.offsetY, -128, 128);
  const blur = clampNum(r.blur ?? DEFAULT_LAYER_DROP_SHADOW_EFFECT.blur, 0, 64);
  const spread = clampNum(r.spread ?? 0, 0, 32);
  if (!color || opacity === null || offsetX === null || offsetY === null || blur === null || spread === null) return null;
  return {
    enabled: r.enabled,
    color,
    opacity: Math.round(opacity * 1000) / 1000,
    offsetX: Math.round(offsetX),
    offsetY: Math.round(offsetY),
    blur: Math.round(blur * 10) / 10,
    spread: Math.round(spread * 10) / 10,
  };
}

function normalizeOuterGlowEffect(input: unknown): LayerOuterGlowEffect | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return null;
  const color = normalizeHexColor(r.color ?? DEFAULT_LAYER_OUTER_GLOW_EFFECT.color);
  const opacity = clampNum(r.opacity ?? DEFAULT_LAYER_OUTER_GLOW_EFFECT.opacity, 0, 1);
  const radius = clampNum(r.radius ?? DEFAULT_LAYER_OUTER_GLOW_EFFECT.radius, 0, 64);
  const spread = clampNum(r.spread ?? 0, 0, 32);
  if (!color || opacity === null || radius === null || spread === null) return null;
  return {
    enabled: r.enabled,
    color,
    opacity: Math.round(opacity * 1000) / 1000,
    radius: Math.round(radius * 10) / 10,
    spread: Math.round(spread * 10) / 10,
  };
}

function normalizeColorOverlayEffect(input: unknown): LayerColorOverlayEffect | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return null;
  const color = normalizeHexColor(r.color ?? DEFAULT_LAYER_COLOR_OVERLAY_EFFECT.color);
  const opacity = clampNum(r.opacity ?? DEFAULT_LAYER_COLOR_OVERLAY_EFFECT.opacity, 0, 1);
  const blendMode = r.blendMode === undefined ? 'normal' : r.blendMode;
  if (!color || opacity === null || typeof blendMode !== 'string' || !VALID_OVERLAY_BLENDS.has(blendMode as LayerEffectOverlayBlendMode)) {
    return null;
  }
  return {
    enabled: r.enabled,
    color,
    opacity: Math.round(opacity * 1000) / 1000,
    blendMode: blendMode as LayerEffectOverlayBlendMode,
  };
}

export function normalizeLayerEffectsMeta(input: unknown): LayerEffectsMeta | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return null;
  const out: LayerEffectsMeta = { enabled: r.enabled };
  if (r.border != null) {
    const border = normalizeBorderEffect(r.border);
    if (!border) return null;
    out.border = border;
  }
  if (r.dropShadow != null) {
    const dropShadow = normalizeDropShadowEffect(r.dropShadow);
    if (!dropShadow) return null;
    out.dropShadow = dropShadow;
  }
  if (r.outerGlow != null) {
    const outerGlow = normalizeOuterGlowEffect(r.outerGlow);
    if (!outerGlow) return null;
    out.outerGlow = outerGlow;
  }
  if (r.colorOverlay != null) {
    const colorOverlay = normalizeColorOverlayEffect(r.colorOverlay);
    if (!colorOverlay) return null;
    out.colorOverlay = colorOverlay;
  }
  return out;
}

export function hasActiveLayerEffects(effects: LayerEffectsMeta | null | undefined): boolean {
  if (!effects?.enabled) return false;
  return Boolean(
    (effects.border?.enabled && effects.border.width > 0 && effects.border.opacity > 0) ||
    (effects.dropShadow?.enabled && effects.dropShadow.opacity > 0) ||
    (effects.outerGlow?.enabled && effects.outerGlow.opacity > 0) ||
    (effects.colorOverlay?.enabled && effects.colorOverlay.opacity > 0)
  );
}

export function layerEffectsKey(effects: LayerEffectsMeta | null | undefined): string {
  if (!hasActiveLayerEffects(effects) || !effects) return '';
  const b = effects.border?.enabled
    ? `b:${effects.border.mode},${effects.border.width},${effects.border.color},${effects.border.opacity},${effects.border.antiAlias ? 1 : 0},${effects.border.watercolorDarkness ?? 0.55},${effects.border.watercolorBlur ?? 3}`
    : '';
  const s = effects.dropShadow?.enabled
    ? `s:${effects.dropShadow.color},${effects.dropShadow.opacity},${effects.dropShadow.offsetX},${effects.dropShadow.offsetY},${effects.dropShadow.blur},${effects.dropShadow.spread ?? 0}`
    : '';
  const g = effects.outerGlow?.enabled
    ? `g:${effects.outerGlow.color},${effects.outerGlow.opacity},${effects.outerGlow.radius},${effects.outerGlow.spread ?? 0}`
    : '';
  const o = effects.colorOverlay?.enabled
    ? `o:${effects.colorOverlay.color},${effects.colorOverlay.opacity},${effects.colorOverlay.blendMode ?? 'normal'}`
    : '';
  return [b, s, g, o].filter(Boolean).join('|');
}

export function computeLayerEffectsPadding(effects: LayerEffectsMeta | null | undefined): number {
  if (!hasActiveLayerEffects(effects) || !effects) return 0;
  let pad = 0;
  if (effects.border?.enabled) {
    const bw = effects.border.mode === 'watercolor'
      ? Math.ceil(effects.border.width + (effects.border.watercolorBlur ?? 3))
      : Math.ceil(effects.border.width + 2);
    pad = Math.max(pad, bw);
  }
  if (effects.dropShadow?.enabled) {
    const sw = Math.ceil(Math.max(Math.abs(effects.dropShadow.offsetX), Math.abs(effects.dropShadow.offsetY)) + effects.dropShadow.blur * 1.5 + (effects.dropShadow.spread ?? 0) + 2);
    pad = Math.max(pad, sw);
  }
  if (effects.outerGlow?.enabled) {
    const gw = Math.ceil(effects.outerGlow.radius * 1.5 + (effects.outerGlow.spread ?? 0) + 2);
    pad = Math.max(pad, gw);
  }
  return Math.min(192, pad);
}

/* ---------- Fast O(W*H) CPU Layer Effects Renderer (Export & Reference) ---------- */

const INF_DIST = 1e12;

function edt1d(f: Float32Array, d: Float32Array, v: Int32Array, z: Float32Array, n: number): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF_DIST;
  z[1] = INF_DIST;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF_DIST;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const diff = q - v[k];
    d[q] = diff * diff + f[v[k]];
  }
}

/** Exact 2D squared Euclidean distance transform from pixels with alpha >= threshold. */
function computeSquaredDistanceField(alpha: Float32Array, width: number, height: number, threshold = 16 / 255): Float32Array {
  const n = width * height;
  const grid = new Float32Array(n);
  let anySeed = false;
  for (let i = 0; i < n; i++) {
    if (alpha[i] >= threshold) {
      grid[i] = 0;
      anySeed = true;
    } else {
      grid[i] = INF_DIST;
    }
  }
  if (!anySeed) return grid;

  const maxDim = Math.max(width, height);
  const f = new Float32Array(maxDim);
  const d = new Float32Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float32Array(maxDim + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    edt1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = grid[row + x];
    edt1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) grid[row + x] = d[x];
  }
  return grid;
}

function boxBlur1dChannel(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number): void {
  const r = Math.max(1, Math.round(radius));
  const win = r * 2 + 1;
  const inv = 1 / win;
  const tmp = new Float32Array(width * height);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const cx = Math.max(0, Math.min(width - 1, k));
      sum += src[row + cx];
    }
    tmp[row] = sum * inv;
    for (let x = 1; x < width; x++) {
      const removeX = Math.max(0, x - r - 1);
      const addX = Math.min(width - 1, x + r);
      sum += src[row + addX] - src[row + removeX];
      tmp[row + x] = sum * inv;
    }
  }
  // Vertical pass
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const cy = Math.max(0, Math.min(height - 1, k));
      sum += tmp[cy * width + x];
    }
    dst[x] = sum * inv;
    for (let y = 1; y < height; y++) {
      const removeY = Math.max(0, y - r - 1);
      const addY = Math.min(height - 1, y + r);
      sum += tmp[addY * width + x] - tmp[removeY * width + x];
      dst[y * width + x] = sum * inv;
    }
  }
}

function blurAlphaFloat(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.round(radius);
  if (r <= 0 || width <= 0 || height <= 0) return new Float32Array(src);
  // 3-pass box blur approximates a smooth Gaussian of standard deviation ~ radius/2
  const passR = Math.max(1, Math.round(r * 0.55));
  let cur = new Float32Array(src);
  let nxt = new Float32Array(src.length);
  for (let p = 0; p < 3; p++) {
    boxBlur1dChannel(cur, nxt, width, height, passR);
    const swap = cur;
    cur = nxt;
    nxt = swap;
  }
  return cur;
}

function blendOverlayChannel(base: number, ov: number, mode: LayerEffectOverlayBlendMode): number {
  switch (mode) {
    case 'multiply':
      return base * ov;
    case 'screen':
      return 1 - (1 - base) * (1 - ov);
    case 'overlay':
      return base < 0.5 ? 2 * base * ov : 1 - 2 * (1 - base) * (1 - ov);
    default:
      return ov;
  }
}

/**
 * Applies non-destructive Layer Effects to a straight-alpha RGBA pixel buffer.
 * Compositing order (bottom to top): Drop Shadow -> Outer Glow -> Edge Border -> Source (+ Color Overlay + Watercolor Border).
 */
export function applyLayerEffectsToRgba(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  effects: LayerEffectsMeta | null | undefined,
): Uint8ClampedArray {
  const count = width * height;
  if (count <= 0 || !hasActiveLayerEffects(effects) || !effects) {
    return new Uint8ClampedArray(src);
  }

  const srcAlpha = new Float32Array(count);
  let hasPixels = false;
  for (let i = 0; i < count; i++) {
    const a = src[i * 4 + 3] / 255;
    srcAlpha[i] = a;
    if (a > 0) hasPixels = true;
  }
  if (!hasPixels) return new Uint8ClampedArray(src);

  // Premultiplied accumulation buffer [r, g, b, a] in 0..1
  const accR = new Float32Array(count);
  const accG = new Float32Array(count);
  const accB = new Float32Array(count);
  const accA = new Float32Array(count);

  const compositeSolid = (alphaBuf: Float32Array, hex: string, opacity: number) => {
    if (opacity <= 0) return;
    const [cr, cg, cb] = hexToRgb01(hex);
    for (let i = 0; i < count; i++) {
      const sa = Math.max(0, Math.min(1, alphaBuf[i] * opacity));
      if (sa <= 0) continue;
      const inv = 1 - sa;
      accR[i] = cr * sa + accR[i] * inv;
      accG[i] = cg * sa + accG[i] * inv;
      accB[i] = cb * sa + accB[i] * inv;
      accA[i] = sa + accA[i] * inv;
    }
  };

  let baseDistSq: Float32Array | null = null;
  const getBaseDistSq = () => {
    if (!baseDistSq) baseDistSq = computeSquaredDistanceField(srcAlpha, width, height);
    return baseDistSq;
  };

  const dilateWithSpread = (alphaBuf: Float32Array, spread: number, reuseBaseDist = false): Float32Array => {
    if (spread <= 0) return alphaBuf;
    const distSq = reuseBaseDist ? getBaseDistSq() : computeSquaredDistanceField(alphaBuf, width, height);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const d = Math.sqrt(distSq[i]);
      const cov = Math.max(0, Math.min(1, spread + 0.5 - d));
      out[i] = Math.max(alphaBuf[i], cov);
    }
    return out;
  };

  // 1. Drop Shadow
  const shadow = effects.dropShadow;
  if (shadow?.enabled && shadow.opacity > 0) {
    const ox = Math.round(shadow.offsetX);
    const oy = Math.round(shadow.offsetY);
    const shifted = new Float32Array(count);
    for (let y = 0; y < height; y++) {
      const sy = y - oy;
      if (sy < 0 || sy >= height) continue;
      const dstRow = y * width;
      const srcRow = sy * width;
      for (let x = 0; x < width; x++) {
        const sx = x - ox;
        if (sx < 0 || sx >= width) continue;
        shifted[dstRow + x] = srcAlpha[srcRow + sx];
      }
    }
    const spreaded = dilateWithSpread(shifted, shadow.spread ?? 0, false);
    const blurred = shadow.blur > 0 ? blurAlphaFloat(spreaded, width, height, shadow.blur) : spreaded;
    compositeSolid(blurred, shadow.color, shadow.opacity);
  }

  // 2. Outer Glow
  const glow = effects.outerGlow;
  if (glow?.enabled && glow.opacity > 0) {
    const spreaded = dilateWithSpread(srcAlpha, glow.spread ?? 0, true);
    const blurred = glow.radius > 0 ? blurAlphaFloat(spreaded, width, height, glow.radius) : spreaded;
    compositeSolid(blurred, glow.color, glow.opacity);
  }

  // 3. Edge Border (solid outline behind content)
  const border = effects.border;
  if (border?.enabled && border.mode === 'edge' && border.width > 0 && border.opacity > 0) {
    const distSq = getBaseDistSq();
    const borderAlpha = new Float32Array(count);
    const w = border.width;
    const aa = border.antiAlias !== false;
    for (let i = 0; i < count; i++) {
      const d = Math.sqrt(distSq[i]);
      borderAlpha[i] = aa ? Math.max(0, Math.min(1, w + 0.5 - d)) : (d <= w ? 1 : 0);
    }
    compositeSolid(borderAlpha, border.color, border.opacity);
  }

  // 4. Source content + Color Overlay + Watercolor Border
  const overlay = effects.colorOverlay;
  const overlayEnabled = Boolean(overlay?.enabled && overlay.opacity > 0);
  const overlayRgb = overlayEnabled ? hexToRgb01(overlay!.color) : [0, 0, 0] as [number, number, number];
  const overlayOp = overlayEnabled ? overlay!.opacity : 0;
  const overlayBlend: LayerEffectOverlayBlendMode = overlay?.blendMode ?? 'normal';

  const wcEnabled = Boolean(border?.enabled && border.mode === 'watercolor' && border.width > 0 && border.opacity > 0);
  const wcDarkness = wcEnabled ? (border!.watercolorDarkness ?? 0.55) * border!.opacity : 0;
  const wcBlurRadius = wcEnabled ? Math.round(border!.watercolorBlur ?? 3) : 0;
  const wcRangeBlur = wcEnabled ? blurAlphaFloat(srcAlpha, width, height, Math.max(1, border!.width)) : null;

  let wcBleedR: Float32Array | null = null;
  let wcBleedG: Float32Array | null = null;
  let wcBleedB: Float32Array | null = null;
  let wcBleedA: Float32Array | null = null;
  if (wcEnabled && wcBlurRadius > 0) {
    const pmR = new Float32Array(count);
    const pmG = new Float32Array(count);
    const pmB = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = srcAlpha[i];
      if (a <= 0) continue;
      let r = src[i * 4] / 255;
      let g = src[i * 4 + 1] / 255;
      let b = src[i * 4 + 2] / 255;
      if (overlayEnabled) {
        r = r + (blendOverlayChannel(r, overlayRgb[0], overlayBlend) - r) * overlayOp;
        g = g + (blendOverlayChannel(g, overlayRgb[1], overlayBlend) - g) * overlayOp;
        b = b + (blendOverlayChannel(b, overlayRgb[2], overlayBlend) - b) * overlayOp;
      }
      pmR[i] = r * a;
      pmG[i] = g * a;
      pmB[i] = b * a;
    }
    wcBleedR = blurAlphaFloat(pmR, width, height, wcBlurRadius);
    wcBleedG = blurAlphaFloat(pmG, width, height, wcBlurRadius);
    wcBleedB = blurAlphaFloat(pmB, width, height, wcBlurRadius);
    wcBleedA = blurAlphaFloat(srcAlpha, width, height, wcBlurRadius);
  }

  // Composite watercolor outer bleed behind main layer content
  if (wcBleedR && wcBleedG && wcBleedB && wcBleedA) {
    for (let i = 0; i < count; i++) {
      const ba = wcBleedA[i];
      if (ba <= 0.001) continue;
      const sa = Math.max(0, Math.min(1, ba * (1 - srcAlpha[i]) * wcDarkness * 0.42));
      if (sa <= 0.0005) continue;
      const br = Math.min(1, wcBleedR[i] / ba);
      const bg = Math.min(1, wcBleedG[i] / ba);
      const bb = Math.min(1, wcBleedB[i] / ba);
      const inv = 1 - sa;
      accR[i] = br * sa + accR[i] * inv;
      accG[i] = bg * sa + accG[i] * inv;
      accB[i] = bb * sa + accB[i] * inv;
      accA[i] = sa + accA[i] * inv;
    }
  }

  for (let i = 0; i < count; i++) {
    let sa = srcAlpha[i];
    if (sa <= 0) continue;
    let r = src[i * 4] / 255;
    let g = src[i * 4 + 1] / 255;
    let b = src[i * 4 + 2] / 255;

    if (overlayEnabled) {
      r = r + (blendOverlayChannel(r, overlayRgb[0], overlayBlend) - r) * overlayOp;
      g = g + (blendOverlayChannel(g, overlayRgb[1], overlayBlend) - g) * overlayOp;
      b = b + (blendOverlayChannel(b, overlayRgb[2], overlayBlend) - b) * overlayOp;
    }

    if (wcEnabled && wcRangeBlur) {
      const edge = Math.max(0, Math.min(1, ((sa - wcRangeBlur[i]) / Math.max(0.2, sa)) * 1.85));
      const strength = edge * wcDarkness;
      if (strength > 0) {
        // Pigment pooling: darken and enrich edge color like watercolor drying rim
        const dr = r * (0.28 + 0.44 * r);
        const dg = g * (0.28 + 0.44 * g);
        const db = b * (0.28 + 0.44 * b);
        r = r + (dr - r) * strength;
        g = g + (dg - g) * strength;
        b = b + (db - b) * strength;
        sa = Math.min(1, sa + strength * 0.25 * sa);
      }
    }

    const inv = 1 - sa;
    accR[i] = r * sa + accR[i] * inv;
    accG[i] = g * sa + accG[i] * inv;
    accB[i] = b * sa + accB[i] * inv;
    accA[i] = sa + accA[i] * inv;
  }

  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, Math.min(1, accA[i]));
    const idx = i * 4;
    if (a <= 0.0001) {
      out[idx] = 0;
      out[idx + 1] = 0;
      out[idx + 2] = 0;
      out[idx + 3] = 0;
      continue;
    }
    const invA = 1 / a;
    out[idx] = Math.round(Math.max(0, Math.min(1, accR[i] * invA)) * 255);
    out[idx + 1] = Math.round(Math.max(0, Math.min(1, accG[i] * invA)) * 255);
    out[idx + 2] = Math.round(Math.max(0, Math.min(1, accB[i] * invA)) * 255);
    out[idx + 3] = Math.round(a * 255);
  }
  return out;
}
