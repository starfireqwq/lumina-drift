import type { ViewportState } from '../engine/Viewport';

interface Point {
  x: number;
  y: number;
}

interface NavigatorFit extends Point {
  width: number;
  height: number;
  scale: number;
}

const MIN_ZOOM_PERCENT = 5;
const MAX_ZOOM_PERCENT = 3200;
const SLIDER_MAX = 1000;
const ZOOM_RATIO = MAX_ZOOM_PERCENT / MIN_ZOOM_PERCENT;

export function computeNavigatorFit(
  canvasWidth: number, canvasHeight: number, boxWidth: number, boxHeight: number, padding = 10,
): NavigatorFit {
  const scale = canvasWidth > 0 && canvasHeight > 0
    ? Math.max(0, Math.min((boxWidth - 2 * padding) / canvasWidth, (boxHeight - 2 * padding) / canvasHeight))
    : 0;
  const width = canvasWidth * scale;
  const height = canvasHeight * scale;
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height, scale };
}

export function screenPointToCanvas(
  sx: number, sy: number, state: ViewportState, canvasWidth: number, canvasHeight: number,
): Point {
  const dx = sx - state.panX;
  const dy = sy - state.panY;
  const cos = Math.cos(state.rotation);
  const sin = Math.sin(state.rotation);
  return {
    x: canvasWidth / 2 + (dx * cos + dy * sin) / (state.mirrorX ? -state.zoom : state.zoom),
    y: canvasHeight / 2 + (dy * cos - dx * sin) / (state.mirrorY ? -state.zoom : state.zoom),
  };
}

export function canvasPointToScreen(
  cx: number, cy: number, state: ViewportState, canvasWidth: number, canvasHeight: number,
): Point {
  const dx = (cx - canvasWidth / 2) * (state.mirrorX ? -state.zoom : state.zoom);
  const dy = (cy - canvasHeight / 2) * (state.mirrorY ? -state.zoom : state.zoom);
  const cos = Math.cos(state.rotation);
  const sin = Math.sin(state.rotation);
  return { x: state.panX + dx * cos - dy * sin, y: state.panY + dx * sin + dy * cos };
}

export function computeViewportPolygonInCanvas(
  state: ViewportState, viewWidth: number, viewHeight: number, canvasWidth: number, canvasHeight: number,
) {
  const points = [[0, 0], [viewWidth, 0], [viewWidth, viewHeight], [0, viewHeight]].map(([x, y]) =>
    screenPointToCanvas(x, y, state, canvasWidth, canvasHeight),
  );
  const epsilon = 1e-7;
  const coversFullCanvas = [[0, 0], [canvasWidth, 0], [canvasWidth, canvasHeight], [0, canvasHeight]].every(([x, y]) => {
    const p = canvasPointToScreen(x, y, state, canvasWidth, canvasHeight);
    return p.x >= -epsilon && p.x <= viewWidth + epsilon && p.y >= -epsilon && p.y <= viewHeight + epsilon;
  });
  return { points, coversFullCanvas };
}

export function computePanForCanvasCenter(
  targetCanvasX: number, targetCanvasY: number, state: ViewportState,
  viewWidth: number, viewHeight: number, canvasWidth: number, canvasHeight: number,
) {
  const offset = canvasPointToScreen(targetCanvasX, targetCanvasY, { ...state, panX: 0, panY: 0 }, canvasWidth, canvasHeight);
  return { panX: viewWidth / 2 - offset.x, panY: viewHeight / 2 - offset.y };
}

export function previewPointToCanvas(
  px: number, py: number, fit: NavigatorFit, mirrorX: boolean, mirrorY: boolean,
  canvasWidth: number, canvasHeight: number,
): Point {
  const x = (px - fit.x) / fit.scale;
  const y = (py - fit.y) / fit.scale;
  return { x: mirrorX ? canvasWidth - x : x, y: mirrorY ? canvasHeight - y : y };
}

export function canvasPointToPreview(
  cx: number, cy: number, fit: NavigatorFit, mirrorX: boolean, mirrorY: boolean,
  canvasWidth: number, canvasHeight: number,
): Point {
  return {
    x: fit.x + (mirrorX ? canvasWidth - cx : cx) * fit.scale,
    y: fit.y + (mirrorY ? canvasHeight - cy : cy) * fit.scale,
  };
}

export function zoomPercentToSlider(percent: number): number {
  const zoom = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, percent));
  return SLIDER_MAX * Math.log(zoom / MIN_ZOOM_PERCENT) / Math.log(ZOOM_RATIO);
}

export function sliderToZoomPercent(slider: number): number {
  const position = Math.min(SLIDER_MAX, Math.max(0, slider));
  return MIN_ZOOM_PERCENT * ZOOM_RATIO ** (position / SLIDER_MAX);
}

export const DEFAULT_SHIFT_WHEEL_ROTATION_DEG = 5;
export const DEFAULT_CTRL_SHIFT_WHEEL_ROTATION_DEG = 1;

export const WHEEL_ROTATION_STEP_LIMITS = {
  shiftStepDeg: { min: 1, max: 45, step: 1 },
  ctrlShiftStepDeg: { min: 0.5, max: 10, step: 0.5 },
} as const;

interface WheelRotationSettings {
  readonly shiftStepDeg: number;
  readonly ctrlShiftStepDeg: number;
}

const DEFAULT_WHEEL_ROTATION_SETTINGS: WheelRotationSettings = {
  shiftStepDeg: DEFAULT_SHIFT_WHEEL_ROTATION_DEG,
  ctrlShiftStepDeg: DEFAULT_CTRL_SHIFT_WHEEL_ROTATION_DEG,
};
const WHEEL_ROTATION_SETTINGS_KEY = 'atelier:wheel-rotation-settings:v1';

function normalizeWheelRotationSettings(raw?: Partial<WheelRotationSettings> | null): WheelRotationSettings {
  const normalize = (key: keyof WheelRotationSettings) => {
    const value = raw?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WHEEL_ROTATION_SETTINGS[key];
    const { min, max, step } = WHEEL_ROTATION_STEP_LIMITS[key];
    return Math.max(min, Math.min(max, Math.round(value / step) * step));
  };
  return {
    shiftStepDeg: normalize('shiftStepDeg'),
    ctrlShiftStepDeg: normalize('ctrlShiftStepDeg'),
  };
}

function readWheelRotationSettings(): WheelRotationSettings {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(WHEEL_ROTATION_SETTINGS_KEY) : null;
    return stored ? normalizeWheelRotationSettings(JSON.parse(stored)) : DEFAULT_WHEEL_ROTATION_SETTINGS;
  } catch {
    return DEFAULT_WHEEL_ROTATION_SETTINGS;
  }
}

let wheelRotationSettings = readWheelRotationSettings();
const wheelRotationListeners = new Set<() => void>();

export const getWheelRotationSettings = (): WheelRotationSettings => wheelRotationSettings;

export function subscribeWheelRotationSettings(listener: () => void): () => void {
  wheelRotationListeners.add(listener);
  return () => { wheelRotationListeners.delete(listener); };
}

export function setWheelRotationSettings(patch: Partial<WheelRotationSettings>): void {
  const next = normalizeWheelRotationSettings({ ...wheelRotationSettings, ...patch });
  if (next.shiftStepDeg === wheelRotationSettings.shiftStepDeg
      && next.ctrlShiftStepDeg === wheelRotationSettings.ctrlShiftStepDeg) return;
  wheelRotationSettings = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(WHEEL_ROTATION_SETTINGS_KEY, JSON.stringify(next));
    }
  } catch {
    // Keep the setting for this session when storage is unavailable.
  }
  wheelRotationListeners.forEach((listener) => listener());
}

export function resetWheelRotationSettings(): void {
  setWheelRotationSettings(DEFAULT_WHEEL_ROTATION_SETTINGS);
}

export function computeWheelRotationRadians(
  deltaX: number,
  deltaY: number,
  deltaMode = 0,
  stepDegrees = DEFAULT_SHIFT_WHEEL_ROTATION_DEG,
): number {
  // Windows can report Shift + vertical wheel motion on the horizontal axis.
  const raw = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
  if (raw === 0) return 0;
  const step = stepDegrees * Math.PI / 180;
  return deltaMode !== 0 || Math.abs(raw) >= 40 ? Math.sign(raw) * step : (raw / 100) * step;
}

export function normalizeRotationDegrees(radians: number): number {
  const degrees = (radians % (2 * Math.PI)) * 180 / Math.PI;
  const signed = degrees > 180 ? degrees - 360 : degrees < -180 ? degrees + 360 : degrees;
  return Math.round(signed * 10) / 10 || 0;
}
