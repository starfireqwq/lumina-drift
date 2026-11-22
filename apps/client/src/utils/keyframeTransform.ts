import {
  applyAffinePoint,
  evaluateTransformKeyframes,
  IDENTITY_AFFINE,
  invertAffine,
  multiplyAffine,
  transformToAffineMatrix,
  type Affine2D,
  type EvaluatedTransform,
  type KeyframeEasing,
  type TransformKeyframe,
} from '@atelier/shared';

export interface KeyframeLayerLike {
  id: string;
  parentId?: string | null;
  meta?: { keyframes?: TransformKeyframe[] } | null;
}

export interface KeyframeBaseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type KeyframeHandleType =
  | 'move'
  | 'rotate'
  | 'pivot'
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w';

export interface MotionPathSample {
  frame: number;
  x: number;
  y: number;
}

export interface MotionPathKeyPoint extends MotionPathSample {
  opacity: number;
  easing: KeyframeEasing;
}

export interface KeyframeMotionPath {
  samples: MotionPathSample[];
  keyPoints: MotionPathKeyPoint[];
  hasMovement: boolean;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const clampScale = (s: number) => Math.max(0.05, Math.min(20, s));

/**
 * Resolves the composed world affine matrix of all ancestor groups above `layerId` at `frame`.
 */
export function resolveParentWorldAffine(
  layers: ReadonlyArray<KeyframeLayerLike>,
  layerId: string,
  frame: number,
  canvasWidth: number,
  canvasHeight: number
): Affine2D {
  const byId = new Map<string, KeyframeLayerLike>();
  for (const l of layers) byId.set(l.id, l);
  const start = byId.get(layerId);
  if (!start?.parentId) return IDENTITY_AFFINE;

  const chain: KeyframeLayerLike[] = [];
  let cur = byId.get(start.parentId);
  for (let depth = 0; cur && depth < 16; depth++) {
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();

  const defPx = canvasWidth / 2;
  const defPy = canvasHeight / 2;
  let acc = IDENTITY_AFFINE;
  for (const node of chain) {
    const kfs = node.meta?.keyframes;
    if (kfs && kfs.length > 0) {
      const ev = evaluateTransformKeyframes(kfs, frame, defPx, defPy);
      acc = multiplyAffine(acc, transformToAffineMatrix(ev));
    }
  }
  return acc;
}

/**
 * Resolves the world affine matrix of `layerId` at `frame` (optionally replacing its local evaluation
 * with a live drag preview).
 */
export function resolveLayerWorldAffine(
  layers: ReadonlyArray<KeyframeLayerLike>,
  layerId: string,
  frame: number,
  canvasWidth: number,
  canvasHeight: number,
  overrideEval?: EvaluatedTransform | null
): Affine2D {
  const parent = resolveParentWorldAffine(layers, layerId, frame, canvasWidth, canvasHeight);
  const layer = layers.find((l) => l.id === layerId);
  const localEval =
    overrideEval ??
    evaluateTransformKeyframes(layer?.meta?.keyframes, frame, canvasWidth / 2, canvasHeight / 2);
  return multiplyAffine(parent, transformToAffineMatrix(localEval));
}

export interface HandleDragInput {
  handle: KeyframeHandleType;
  startEval: EvaluatedTransform;
  parentWorld: Affine2D;
  startCanvas: { x: number; y: number };
  curCanvas: { x: number; y: number };
  maintainAspect?: boolean;
  snapAngle?: boolean;
  axisLock?: boolean;
}

/**
 * Pure keyframe handle drag solver. Converts canvas-space pointer deltas into the layer's local
 * parent coordinate system and updates x/y, scaleX/scaleY, rotation, or pivotX/pivotY (with
 * exact translation compensation so dragging the pivot does not visually move the layer).
 */
export function applyKeyframeHandleDrag(input: HandleDragInput): EvaluatedTransform {
  const { handle, startEval, parentWorld, startCanvas, curCanvas, maintainAspect, snapAngle, axisLock } = input;
  const invParent = invertAffine(parentWorld) ?? IDENTITY_AFFINE;
  const pStart = applyAffinePoint(invParent, startCanvas.x, startCanvas.y);
  const pCur = applyAffinePoint(invParent, curCanvas.x, curCanvas.y);
  let ldx = pCur.x - pStart.x;
  let ldy = pCur.y - pStart.y;

  if (handle === 'move') {
    if (axisLock) {
      if (Math.abs(ldx) >= Math.abs(ldy)) ldy = 0;
      else ldx = 0;
    }
    return {
      ...startEval,
      x: round1(startEval.x + ldx),
      y: round1(startEval.y + ldy),
      active: true,
    };
  }

  const pivX = startEval.pivotX + startEval.x;
  const pivY = startEval.pivotY + startEval.y;

  if (handle === 'pivot') {
    // Move pivot to match pointer delta while keeping the resulting affine matrix (tx, ty) identical
    const cos = Math.cos(startEval.rotation);
    const sin = Math.sin(startEval.rotation);
    const rotDx = cos * ldx + sin * ldy;
    const rotDy = -sin * ldx + cos * ldy;
    const safeSx = Math.abs(startEval.scaleX) < 1e-4 ? (startEval.scaleX < 0 ? -1e-4 : 1e-4) : startEval.scaleX;
    const safeSy = Math.abs(startEval.scaleY) < 1e-4 ? (startEval.scaleY < 0 ? -1e-4 : 1e-4) : startEval.scaleY;
    const dpX = rotDx / safeSx;
    const dpY = rotDy / safeSy;
    return {
      ...startEval,
      pivotX: round1(startEval.pivotX + dpX),
      pivotY: round1(startEval.pivotY + dpY),
      x: round1(startEval.x + ldx - dpX),
      y: round1(startEval.y + ldy - dpY),
      active: true,
    };
  }

  if (handle === 'rotate') {
    const a0 = Math.atan2(pStart.y - pivY, pStart.x - pivX);
    const a1 = Math.atan2(pCur.y - pivY, pCur.x - pivX);
    let nextRot = startEval.rotation + (a1 - a0);
    if (snapAngle) {
      const step = Math.PI / 12; // 15 degrees
      nextRot = Math.round(nextRot / step) * step;
    }
    return {
      ...startEval,
      rotation: round4(nextRot),
      active: true,
    };
  }

  // Scale handles (nw, n, ne, e, se, s, sw, w) around pivot in rotated local axes
  const cos = Math.cos(startEval.rotation);
  const sin = Math.sin(startEval.rotation);
  const rel0X = pStart.x - pivX;
  const rel0Y = pStart.y - pivY;
  const rel1X = pCur.x - pivX;
  const rel1Y = pCur.y - pivY;
  const u0 = cos * rel0X + sin * rel0Y;
  const v0 = -sin * rel0X + cos * rel0Y;
  const u1 = cos * rel1X + sin * rel1Y;
  const v1 = -sin * rel1X + cos * rel1Y;

  const isCorner = handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw';
  const affectsX = handle.includes('e') || handle.includes('w');
  const affectsY = handle.includes('n') || handle.includes('s');

  let nextSx = startEval.scaleX;
  let nextSy = startEval.scaleY;

  if (isCorner && maintainAspect) {
    const d0 = Math.hypot(u0, v0);
    const d1 = Math.hypot(u1, v1);
    const ratio = d0 > 6 ? d1 / d0 : 1;
    nextSx = clampScale(startEval.scaleX * ratio);
    nextSy = clampScale(startEval.scaleY * ratio);
  } else {
    if (affectsX && Math.abs(u0) > 6) {
      nextSx = clampScale(startEval.scaleX * (u1 / u0));
    }
    if (affectsY && Math.abs(v0) > 6) {
      nextSy = clampScale(startEval.scaleY * (v1 / v0));
    }
  }

  return {
    ...startEval,
    scaleX: round3(nextSx),
    scaleY: round3(nextSy),
    active: true,
  };
}

/**
 * Merges an evaluated transform into a TransformKeyframe at `frame`, preserving existing easing,
 * bezier handles, and opacity if a keyframe already exists on that frame.
 */
export function buildKeyframeFromEval(
  existingKfs: ReadonlyArray<TransformKeyframe> | undefined | null,
  frame: number,
  evaluated: EvaluatedTransform
): TransformKeyframe {
  const f = Math.max(0, Math.round(frame));
  const exact = existingKfs?.find((k) => Math.round(k.frame) === f);
  return {
    frame: f,
    x: round1(evaluated.x),
    y: round1(evaluated.y),
    scaleX: round3(evaluated.scaleX),
    scaleY: round3(evaluated.scaleY),
    rotation: round4(evaluated.rotation),
    pivotX: round1(evaluated.pivotX),
    pivotY: round1(evaluated.pivotY),
    opacity: exact?.opacity ?? evaluated.opacity,
    easing: exact?.easing ?? 'easeInOut',
    bezier: exact?.bezier,
  };
}

/**
 * Computes the world-space motion path of a layer's pivot point across its keyframe span.
 * Returns null if the layer has fewer than 2 keyframes (even after applying liveOverride).
 */
export function sampleKeyframeMotionPath(
  layers: ReadonlyArray<KeyframeLayerLike>,
  layerId: string,
  canvasWidth: number,
  canvasHeight: number,
  liveOverride?: { frame: number; evaluated: EvaluatedTransform } | null
): KeyframeMotionPath | null {
  const layer = layers.find((l) => l.id === layerId);
  const rawKfs: TransformKeyframe[] = layer?.meta?.keyframes ?? [];
  let effectiveKfs = rawKfs;
  if (liveOverride) {
    const f = Math.max(0, Math.round(liveOverride.frame));
    const merged = buildKeyframeFromEval(rawKfs, f, liveOverride.evaluated);
    effectiveKfs = [...rawKfs.filter((k) => Math.round(k.frame) !== f), merged];
  }
  if (effectiveKfs.length < 2) return null;

  const sorted = [...effectiveKfs].sort((a, b) => a.frame - b.frame);
  const fMin = Math.round(sorted[0].frame);
  const fMax = Math.round(sorted[sorted.length - 1].frame);
  if (fMax <= fMin) return null;

  const defPx = canvasWidth / 2;
  const defPy = canvasHeight / 2;
  const step = Math.max(1, Math.ceil((fMax - fMin) / 360));
  const frameSet = new Set<number>();
  for (let f = fMin; f <= fMax; f += step) frameSet.add(f);
  for (const k of sorted) frameSet.add(Math.round(k.frame));
  const sampleFrames = [...frameSet].sort((a, b) => a - b);

  const worldPtAt = (f: number): { x: number; y: number; ev: EvaluatedTransform } => {
    const ev = evaluateTransformKeyframes(sorted, f, defPx, defPy);
    const parent = resolveParentWorldAffine(layers, layerId, f, canvasWidth, canvasHeight);
    const world = multiplyAffine(parent, transformToAffineMatrix(ev));
    const pt = applyAffinePoint(world, ev.pivotX, ev.pivotY);
    return { x: pt.x, y: pt.y, ev };
  };

  const samples: MotionPathSample[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const f of sampleFrames) {
    const { x, y } = worldPtAt(f);
    samples.push({ frame: f, x, y });
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const keyPoints: MotionPathKeyPoint[] = sorted.map((k) => {
    const f = Math.round(k.frame);
    const { x, y, ev } = worldPtAt(f);
    return { frame: f, x, y, opacity: ev.opacity, easing: k.easing };
  });

  const hasMovement = Math.hypot(maxX - minX, maxY - minY) > 0.5;
  return { samples, keyPoints, hasMovement };
}
