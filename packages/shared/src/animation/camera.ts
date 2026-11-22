import {
  Affine2D,
  EvaluatedTransform,
  IDENTITY_AFFINE,
  TransformKeyframe,
  applyAffinePoint,
  evaluateTransformKeyframes,
  invertAffine,
  multiplyAffine,
  transformToAffineMatrix,
} from './keyframes';

/**
 * 2D Camera framing box metadata stored on a special group layer (`layerType === 'group'` + `meta.camera`).
 * Keyframes live on the same layer's `meta.keyframes`, so multiplayer sync, undo, and layer ACL work natively.
 */
export interface CameraFrameMeta {
  /** Base output width in canvas pixels */
  width: number;
  /** Base output height in canvas pixels */
  height: number;
  /** Show action-safe (90%) and title-safe (80%) inner guides */
  showSafeArea?: boolean;
}

export interface CameraLikeLayer {
  id: string;
  layerType: string;
  isVisible: boolean;
  meta?: {
    camera?: CameraFrameMeta;
    keyframes?: TransformKeyframe[];
  } | null;
}

export interface EvaluatedCameraFrame {
  /** Base output width in pixels */
  width: number;
  /** Base output height in pixels */
  height: number;
  /** Evaluated transform of the camera frame around the canvas center */
  transform: EvaluatedTransform;
  /** Affine matrix mapping base centered camera rect coordinates -> canvas coordinates */
  cameraToCanvas: Affine2D;
  /** Center point of the camera frame in canvas coordinates */
  centerX: number;
  centerY: number;
  /** Effective half-extents along camera local axes */
  halfWidth: number;
  halfHeight: number;
  /** Rotation in radians */
  rotation: number;
  /** Effective scale (>0; <1 zooms in, >1 zooms out) */
  scaleX: number;
  scaleY: number;
  /** Four corners in canvas coordinates: top-left, top-right, bottom-right, bottom-left */
  corners: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  showSafeArea: boolean;
}

export interface CameraMotionSample {
  frame: number;
  x: number;
  y: number;
  isKey: boolean;
}

export interface CameraPreviewViewport {
  zoom: number;
  panX: number;
  panY: number;
  rotation: number;
  mirrorX: false;
  /** Screen-space framing rectangle centered in the viewport */
  frameRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export const MIN_CAMERA_DIM = 64;
export const MAX_CAMERA_DIM = 8192;
export const CAMERA_MIN_SCALE = 0.05;
export const CAMERA_MAX_SCALE = 8;
export const CAMERA_ACTION_SAFE_RATIO = 0.9;
export const CAMERA_TITLE_SAFE_RATIO = 0.8;

export function isCameraLayer(layer: CameraLikeLayer | null | undefined): boolean {
  return Boolean(layer && layer.layerType === 'group' && layer.meta?.camera);
}

export function normalizeCameraMeta(
  meta: Partial<CameraFrameMeta> | null | undefined,
  canvasWidth: number,
  canvasHeight: number
): CameraFrameMeta {
  const safeCanvasW = Math.max(MIN_CAMERA_DIM, Math.round(canvasWidth) || 1280);
  const safeCanvasH = Math.max(MIN_CAMERA_DIM, Math.round(canvasHeight) || 720);
  const defaultW = Math.max(MIN_CAMERA_DIM, Math.round(safeCanvasW * 0.85));
  const defaultH = Math.max(MIN_CAMERA_DIM, Math.round(safeCanvasH * 0.85));
  const rawW = Number(meta?.width);
  const rawH = Number(meta?.height);
  const width = Number.isFinite(rawW) && rawW > 0
    ? Math.max(MIN_CAMERA_DIM, Math.min(MAX_CAMERA_DIM, Math.round(rawW)))
    : Math.min(MAX_CAMERA_DIM, defaultW);
  const height = Number.isFinite(rawH) && rawH > 0
    ? Math.max(MIN_CAMERA_DIM, Math.min(MAX_CAMERA_DIM, Math.round(rawH)))
    : Math.min(MAX_CAMERA_DIM, defaultH);
  return {
    width,
    height,
    showSafeArea: meta?.showSafeArea !== false,
  };
}

/** Finds the first active camera layer (prefers visible camera layer if multiple exist). */
export function findCameraLayer<T extends CameraLikeLayer>(
  layers: ReadonlyArray<T>,
  opts?: { visibleOnly?: boolean }
): T | null {
  let fallback: T | null = null;
  for (const l of layers) {
    if (!isCameraLayer(l)) continue;
    if (l.isVisible) return l;
    if (!opts?.visibleOnly && !fallback) fallback = l;
  }
  return opts?.visibleOnly ? null : fallback;
}

/** Evaluates a camera frame's geometry in canvas coordinates at a given timeline frame. */
export function evaluateCameraFrame(
  meta: CameraFrameMeta,
  keyframes: ReadonlyArray<TransformKeyframe> | undefined | null,
  frame: number,
  canvasWidth: number,
  canvasHeight: number
): EvaluatedCameraFrame {
  const norm = normalizeCameraMeta(meta, canvasWidth, canvasHeight);
  const defaultPx = canvasWidth / 2;
  const defaultPy = canvasHeight / 2;
  const rawEval = evaluateTransformKeyframes(keyframes, frame, defaultPx, defaultPy);
  const scaleX = Math.max(CAMERA_MIN_SCALE, Math.min(CAMERA_MAX_SCALE, Math.abs(rawEval.scaleX) || 1));
  const scaleY = Math.max(CAMERA_MIN_SCALE, Math.min(CAMERA_MAX_SCALE, Math.abs(rawEval.scaleY) || 1));
  const transform: EvaluatedTransform = {
    ...rawEval,
    scaleX,
    scaleY,
    opacity: 1,
    active:
      rawEval.active ||
      rawEval.x !== 0 ||
      rawEval.y !== 0 ||
      scaleX !== 1 ||
      scaleY !== 1 ||
      rawEval.rotation !== 0,
  };
  const cameraToCanvas = transformToAffineMatrix(transform);
  const halfW = norm.width / 2;
  const halfH = norm.height / 2;
  const left = defaultPx - halfW;
  const right = defaultPx + halfW;
  const top = defaultPy - halfH;
  const bottom = defaultPy + halfH;
  const center = applyAffinePoint(cameraToCanvas, defaultPx, defaultPy);
  const corners: EvaluatedCameraFrame['corners'] = [
    applyAffinePoint(cameraToCanvas, left, top),
    applyAffinePoint(cameraToCanvas, right, top),
    applyAffinePoint(cameraToCanvas, right, bottom),
    applyAffinePoint(cameraToCanvas, left, bottom),
  ];

  return {
    width: norm.width,
    height: norm.height,
    transform,
    cameraToCanvas,
    centerX: center.x,
    centerY: center.y,
    halfWidth: halfW * scaleX,
    halfHeight: halfH * scaleY,
    rotation: transform.rotation,
    scaleX,
    scaleY,
    corners,
    showSafeArea: norm.showSafeArea !== false,
  };
}

/**
 * Computes the 2D Canvas affine transform mapping full canvas pixels into a camera-framed
 * output surface of size `outWidth x outHeight`.
 *
 * Pass `(m.a, m.b, m.c, m.d, m.tx, m.ty)` to `ctx.setTransform(...)` before `ctx.drawImage(sourceCanvas, 0, 0)`.
 */
export function computeCameraCanvasToOutputMatrix(
  evaluated: EvaluatedCameraFrame,
  canvasWidth: number,
  canvasHeight: number,
  outWidth = evaluated.width,
  outHeight = evaluated.height
): Affine2D {
  const invCam = invertAffine(evaluated.cameraToCanvas) ?? IDENTITY_AFFINE;
  const baseLeft = canvasWidth / 2 - evaluated.width / 2;
  const baseTop = canvasHeight / 2 - evaluated.height / 2;
  const shiftToOrigin: Affine2D = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    tx: -baseLeft,
    ty: -baseTop,
    isIdentity: baseLeft === 0 && baseTop === 0,
  };
  const sx = outWidth / Math.max(1, evaluated.width);
  const sy = outHeight / Math.max(1, evaluated.height);
  const scaleToOut: Affine2D = {
    a: sx,
    b: 0,
    c: 0,
    d: sy,
    tx: 0,
    ty: 0,
    isIdentity: Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6,
  };
  return multiplyAffine(scaleToOut, multiplyAffine(shiftToOrigin, invCam));
}

/**
 * Computes a CanvasViewport state so the camera frame sits upright and fitted inside the viewport
 * for real-time "Look Through Camera" playback preview.
 */
export function computeCameraPreviewViewport(
  evaluated: EvaluatedCameraFrame,
  canvasWidth: number,
  canvasHeight: number,
  viewWidth: number,
  viewHeight: number,
  padding = 28
): CameraPreviewViewport {
  const safeViewW = Math.max(64, viewWidth || 640);
  const safeViewH = Math.max(64, viewHeight || 480);
  const pad = Math.min(padding, safeViewW * 0.08, safeViewH * 0.08);
  const effW = Math.max(1, evaluated.width * evaluated.scaleX);
  const effH = Math.max(1, evaluated.height * evaluated.scaleY);
  const zoom = Math.max(
    0.05,
    Math.min(32, Math.min((safeViewW - pad * 2) / effW, (safeViewH - pad * 2) / effH))
  );
  const rotation = -evaluated.rotation;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = evaluated.centerX - canvasWidth / 2;
  const dy = evaluated.centerY - canvasHeight / 2;
  const panX = safeViewW / 2 - zoom * (dx * cos - dy * sin);
  const panY = safeViewH / 2 - zoom * (dx * sin + dy * cos);

  const frameW = effW * zoom;
  const frameH = effH * zoom;
  return {
    zoom,
    panX,
    panY,
    rotation,
    mirrorX: false,
    frameRect: {
      x: (safeViewW - frameW) / 2,
      y: (safeViewH - frameH) / 2,
      width: frameW,
      height: frameH,
    },
  };
}

/** Samples the camera frame center path across its keyframe range for motion-path visualization. */
export function sampleCameraMotionPath(
  meta: CameraFrameMeta,
  keyframes: ReadonlyArray<TransformKeyframe> | undefined | null,
  canvasWidth: number,
  canvasHeight: number,
  maxSamples = 240
): CameraMotionSample[] {
  if (!keyframes || keyframes.length < 2) return [];
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  const firstFrame = sorted[0].frame;
  const lastFrame = sorted[sorted.length - 1].frame;
  const span = Math.max(1, lastFrame - firstFrame);
  const step = Math.max(1, Math.ceil(span / Math.max(16, maxSamples)));
  const keySet = new Set(sorted.map((k) => Math.round(k.frame)));
  const frames = new Set<number>();
  for (let f = firstFrame; f <= lastFrame; f += step) frames.add(f);
  for (const k of sorted) frames.add(Math.round(k.frame));
  const ordered = [...frames].sort((a, b) => a - b);
  return ordered.map((frame) => {
    const ev = evaluateCameraFrame(meta, sorted, frame, canvasWidth, canvasHeight);
    return {
      frame,
      x: ev.centerX,
      y: ev.centerY,
      isKey: keySet.has(frame),
    };
  });
}
