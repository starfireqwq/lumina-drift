export type KeyframeEasing =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'step'
  | 'cubicBezier';

export type KeyframeBezierPresetId =
  | 'softEase'
  | 'strongEase'
  | 'decelerate'
  | 'accelerate'
  | 'softOvershoot'
  | 'strongOvershoot';

export interface KeyframeBezierPreset {
  id: KeyframeBezierPresetId;
  bezier: [number, number, number, number];
}

export const BEZIER_PRESETS: ReadonlyArray<KeyframeBezierPreset> = [
  { id: 'softEase', bezier: [0.37, 0, 0.63, 1] },
  { id: 'strongEase', bezier: [0.83, 0, 0.17, 1] },
  { id: 'decelerate', bezier: [0.16, 1, 0.3, 1] },
  { id: 'accelerate', bezier: [0.7, 0, 0.84, 0] },
  { id: 'softOvershoot', bezier: [0.34, 1.35, 0.64, 1] },
  { id: 'strongOvershoot', bezier: [0.34, 1.56, 0.64, 1] },
];

export function matchBezierPreset(
  bezier: Readonly<[number, number, number, number]> | undefined | null
): KeyframeBezierPresetId | null {
  if (!bezier) return null;
  for (const preset of BEZIER_PRESETS) {
    if (
      Math.abs(preset.bezier[0] - bezier[0]) < 1e-3 &&
      Math.abs(preset.bezier[1] - bezier[1]) < 1e-3 &&
      Math.abs(preset.bezier[2] - bezier[2]) < 1e-3 &&
      Math.abs(preset.bezier[3] - bezier[3]) < 1e-3
    ) {
      return preset.id;
    }
  }
  return null;
}

export interface TransformKeyframe {
  frame: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  pivotX: number;
  pivotY: number;
  /** Optional keyframe opacity multiplier (0..1, omitted defaults to 1 for legacy files) */
  opacity?: number;
  easing: KeyframeEasing;
  bezier?: [number, number, number, number];
}

export interface EvaluatedTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  pivotX: number;
  pivotY: number;
  opacity: number;
  active: boolean;
}

export interface Affine2D {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
  isIdentity: boolean;
}

export const IDENTITY_AFFINE: Affine2D = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0, isIdentity: true };

const sampleCurve = (a1: number, a2: number, u: number): number => {
  const c = 3 * a1;
  const b = 3 * (a2 - a1) - c;
  const a = 1 - c - b;
  return ((a * u + b) * u + c) * u;
};

const sampleCurveDerivative = (a1: number, a2: number, u: number): number => {
  const c = 3 * a1;
  const b = 3 * (a2 - a1) - c;
  const a = 1 - c - b;
  return (3 * a * u + 2 * b) * u + c;
};

export function solveCubicBezier(t: number, x1: number, y1: number, x2: number, y2: number): number {
  const tt = Math.max(0, Math.min(1, t));
  if (tt === 0 || tt === 1) return tt;
  const cx1 = Math.max(0, Math.min(1, x1));
  const cx2 = Math.max(0, Math.min(1, x2));
  let lo = 0;
  let hi = 1;
  let u = tt;
  for (let i = 0; i < 8; i++) {
    const x = sampleCurve(cx1, cx2, u) - tt;
    if (Math.abs(x) < 1e-6) return sampleCurve(y1, y2, u);
    if (x < 0) lo = u;
    else hi = u;
    const dx = sampleCurveDerivative(cx1, cx2, u);
    if (Math.abs(dx) < 1e-6) break;
    const next = u - x / dx;
    u = next > lo && next < hi ? next : (lo + hi) * 0.5;
  }
  for (let i = 0; i < 12; i++) {
    const x = sampleCurve(cx1, cx2, u) - tt;
    if (Math.abs(x) < 1e-6) break;
    if (x < 0) lo = u;
    else hi = u;
    u = (lo + hi) * 0.5;
  }
  return sampleCurve(y1, y2, u);
}

export function evaluateEasing(t: number, easing: KeyframeEasing, bezier?: [number, number, number, number]): number {
  const tt = Math.max(0, Math.min(1, t));
  switch (easing) {
    case 'step':
      return tt >= 1 ? 1 : 0;
    case 'easeIn':
      return tt * tt * tt;
    case 'easeOut': {
      const inv = 1 - tt;
      return 1 - inv * inv * inv;
    }
    case 'easeInOut':
      return tt < 0.5 ? 4 * tt * tt * tt : 1 - Math.pow(-2 * tt + 2, 3) / 2;
    case 'cubicBezier': {
      const b = bezier ?? [0.42, 0, 0.58, 1];
      return solveCubicBezier(tt, b[0], b[1], b[2], b[3]);
    }
    default:
      return tt;
  }
}

const clampKeyframeOpacity = (v: number | undefined): number =>
  v === undefined || !Number.isFinite(v) ? 1 : Math.max(0, Math.min(1, v));

export function evaluateTransformKeyframes(
  keyframes: ReadonlyArray<TransformKeyframe> | undefined | null,
  frame: number,
  defaultPivotX = 0,
  defaultPivotY = 0
): EvaluatedTransform {
  if (!keyframes || keyframes.length === 0) {
    return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: defaultPivotX, pivotY: defaultPivotY, opacity: 1, active: false };
  }
  let sorted = keyframes;
  for (let i = 1; i < keyframes.length; i++) {
    if (keyframes[i].frame < keyframes[i - 1].frame) {
      sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
      break;
    }
  }
  const first = sorted[0];
  if (frame <= first.frame || sorted.length === 1) {
    return {
      x: first.x,
      y: first.y,
      scaleX: first.scaleX,
      scaleY: first.scaleY,
      rotation: first.rotation,
      pivotX: first.pivotX,
      pivotY: first.pivotY,
      opacity: clampKeyframeOpacity(first.opacity),
      active: true,
    };
  }
  const last = sorted[sorted.length - 1];
  if (frame >= last.frame) {
    return {
      x: last.x,
      y: last.y,
      scaleX: last.scaleX,
      scaleY: last.scaleY,
      rotation: last.rotation,
      pivotX: last.pivotX,
      pivotY: last.pivotY,
      opacity: clampKeyframeOpacity(last.opacity),
      active: true,
    };
  }
  let k0 = first;
  let k1 = last;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (frame >= sorted[i].frame && frame <= sorted[i + 1].frame) {
      k0 = sorted[i];
      k1 = sorted[i + 1];
      break;
    }
  }
  const span = Math.max(1e-6, k1.frame - k0.frame);
  const rawT = (frame - k0.frame) / span;
  const e = evaluateEasing(rawT, k0.easing, k0.bezier);
  const lerp = (a: number, b: number) => a + (b - a) * e;
  return {
    x: lerp(k0.x, k1.x),
    y: lerp(k0.y, k1.y),
    scaleX: lerp(k0.scaleX, k1.scaleX),
    scaleY: lerp(k0.scaleY, k1.scaleY),
    rotation: lerp(k0.rotation, k1.rotation),
    pivotX: lerp(k0.pivotX, k1.pivotX),
    pivotY: lerp(k0.pivotY, k1.pivotY),
    opacity: clampKeyframeOpacity(lerp(clampKeyframeOpacity(k0.opacity), clampKeyframeOpacity(k1.opacity))),
    active: true,
  };
}

export function transformToAffineMatrix(t: EvaluatedTransform): Affine2D {
  if (
    !t.active ||
    (t.x === 0 && t.y === 0 && t.scaleX === 1 && t.scaleY === 1 && t.rotation === 0)
  ) {
    return IDENTITY_AFFINE;
  }
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const a = cos * t.scaleX;
  const b = sin * t.scaleX;
  const c = -sin * t.scaleY;
  const d = cos * t.scaleY;
  const tx = t.pivotX + t.x - (a * t.pivotX + c * t.pivotY);
  const ty = t.pivotY + t.y - (b * t.pivotX + d * t.pivotY);
  return { a, b, c, d, tx, ty, isIdentity: false };
}

export function multiplyAffine(parent: Affine2D, child: Affine2D): Affine2D {
  if (parent.isIdentity) return child;
  if (child.isIdentity) return parent;
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty,
    isIdentity: false,
  };
}

export function applyAffinePoint(m: Affine2D, x: number, y: number): { x: number; y: number } {
  if (m.isIdentity) return { x, y };
  return {
    x: m.a * x + m.c * y + m.tx,
    y: m.b * x + m.d * y + m.ty,
  };
}

export function invertAffine(m: Affine2D): Affine2D | null {
  if (m.isIdentity) return IDENTITY_AFFINE;
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-8) return null;
  const invDet = 1 / det;
  const a = m.d * invDet;
  const b = -m.b * invDet;
  const c = -m.c * invDet;
  const d = m.a * invDet;
  const tx = -(a * m.tx + c * m.ty);
  const ty = -(b * m.tx + d * m.ty);
  return { a, b, c, d, tx, ty, isIdentity: false };
}
