export type TouchLongPressAction = 'radial' | 'eyedropper';
export type TouchSingleFingerMode = 'draw' | 'pan' | 'ignore';

export interface TouchGestureSettings {
  quickPinchToFit: boolean;
  fourFingerTapFullscreen: boolean;
  rapidUndoRedoHold: boolean;
  longPressAction: TouchLongPressAction;
  longPressDelayMs: number;
  threeFingerSwipeCopyPaste: boolean;
  singleFingerMode: TouchSingleFingerMode;
}

export const TOUCH_GESTURES_KEY = 'atelier_touch_gestures_v1';
export const MIN_LONG_PRESS_DELAY_MS = 250;
export const MAX_LONG_PRESS_DELAY_MS = 1000;
export const RAPID_UNDO_HOLD_DELAY_MS = 450;
export const RAPID_UNDO_REPEAT_MS = 140;

export const DEFAULT_TOUCH_GESTURE_SETTINGS: TouchGestureSettings = {
  quickPinchToFit: true,
  fourFingerTapFullscreen: true,
  rapidUndoRedoHold: true,
  longPressAction: 'radial',
  longPressDelayMs: 450,
  threeFingerSwipeCopyPaste: true,
  singleFingerMode: 'draw',
};

const clampDelay = (ms: unknown): number => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_TOUCH_GESTURE_SETTINGS.longPressDelayMs;
  return Math.max(MIN_LONG_PRESS_DELAY_MS, Math.min(MAX_LONG_PRESS_DELAY_MS, Math.round(ms)));
};

const isLongPressAction = (v: unknown): v is TouchLongPressAction => v === 'radial' || v === 'eyedropper';
const isSingleFingerMode = (v: unknown): v is TouchSingleFingerMode => v === 'draw' || v === 'pan' || v === 'ignore';

export function normalizeTouchGestureSettings(raw: Partial<TouchGestureSettings> | null | undefined): TouchGestureSettings {
  const s = raw ?? {};
  return {
    quickPinchToFit: typeof s.quickPinchToFit === 'boolean' ? s.quickPinchToFit : DEFAULT_TOUCH_GESTURE_SETTINGS.quickPinchToFit,
    fourFingerTapFullscreen: typeof s.fourFingerTapFullscreen === 'boolean' ? s.fourFingerTapFullscreen : DEFAULT_TOUCH_GESTURE_SETTINGS.fourFingerTapFullscreen,
    rapidUndoRedoHold: typeof s.rapidUndoRedoHold === 'boolean' ? s.rapidUndoRedoHold : DEFAULT_TOUCH_GESTURE_SETTINGS.rapidUndoRedoHold,
    longPressAction: isLongPressAction(s.longPressAction) ? s.longPressAction : DEFAULT_TOUCH_GESTURE_SETTINGS.longPressAction,
    longPressDelayMs: clampDelay(s.longPressDelayMs),
    threeFingerSwipeCopyPaste: typeof s.threeFingerSwipeCopyPaste === 'boolean' ? s.threeFingerSwipeCopyPaste : DEFAULT_TOUCH_GESTURE_SETTINGS.threeFingerSwipeCopyPaste,
    singleFingerMode: isSingleFingerMode(s.singleFingerMode) ? s.singleFingerMode : DEFAULT_TOUCH_GESTURE_SETTINGS.singleFingerMode,
  };
}

function readStoredSettings(): TouchGestureSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(TOUCH_GESTURES_KEY) : null;
    if (!raw) return { ...DEFAULT_TOUCH_GESTURE_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<TouchGestureSettings>;
    return normalizeTouchGestureSettings(parsed);
  } catch {
    return { ...DEFAULT_TOUCH_GESTURE_SETTINGS };
  }
}

function writeStoredSettings(settings: TouchGestureSettings) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TOUCH_GESTURES_KEY, JSON.stringify(settings));
    }
  } catch {
    // Storage may be unavailable in restricted contexts.
  }
}

let currentSettings: TouchGestureSettings = readStoredSettings();
const settingsListeners = new Set<() => void>();

export const getTouchGestureSettings = (): TouchGestureSettings => currentSettings;

export function updateTouchGestureSettings(patch: Partial<TouchGestureSettings>): TouchGestureSettings {
  const next = normalizeTouchGestureSettings({ ...currentSettings, ...patch });
  const changed = (Object.keys(next) as Array<keyof TouchGestureSettings>).some((k) => next[k] !== currentSettings[k]);
  if (!changed) return currentSettings;
  currentSettings = next;
  writeStoredSettings(next);
  settingsListeners.forEach((listener) => listener());
  return currentSettings;
}

export function resetTouchGestureSettings(): TouchGestureSettings {
  currentSettings = { ...DEFAULT_TOUCH_GESTURE_SETTINGS };
  writeStoredSettings(currentSettings);
  settingsListeners.forEach((listener) => listener());
  return currentSettings;
}

export function subscribeTouchGestureSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

// ---------- Canvas Fullscreen (4-finger tap UI chrome toggle) ----------
let canvasFullscreen = false;
const fullscreenListeners = new Set<() => void>();

export const getCanvasFullscreen = (): boolean => canvasFullscreen;

export function setCanvasFullscreen(next: boolean): boolean {
  const normalized = Boolean(next);
  if (normalized === canvasFullscreen) return canvasFullscreen;
  canvasFullscreen = normalized;
  fullscreenListeners.forEach((listener) => listener());
  return canvasFullscreen;
}

export function toggleCanvasFullscreen(): boolean {
  return setCanvasFullscreen(!canvasFullscreen);
}

export function subscribeCanvasFullscreen(listener: () => void): () => void {
  fullscreenListeners.add(listener);
  return () => {
    fullscreenListeners.delete(listener);
  };
}

// ---------- Pure Gesture Detection Helpers (Procraft-inspired) ----------

export interface Point2D {
  x: number;
  y: number;
}

export interface PinchSample {
  dist: number;
  time: number;
}

/**
 * Tracks a two-finger pinch gesture to detect a quick inward pinch-to-fit.
 * Inspired by Procraft's `QUICK_PINCH_SPEED` (-2.5 normalized spread/sec over recent window)
 * with browser PointerEvent sampling resilience.
 */
export class QuickPinchTracker {
  private readonly startDist: number;
  private readonly startTime: number;
  private readonly samples: PinchSample[] = [];
  private minDist: number;
  private maxDist: number;

  static readonly WINDOW_MS = 90;
  static readonly MAX_DURATION_MS = 420;
  static readonly MIN_START_DIST = 60;
  static readonly MAX_END_RATIO = 0.72;
  static readonly SPEED_THRESHOLD = -1.75; // normalized spread per second

  constructor(initialDist: number, now: number) {
    this.startDist = Math.max(1, initialDist);
    this.startTime = now;
    this.minDist = this.startDist;
    this.maxDist = this.startDist;
    this.samples.push({ dist: this.startDist, time: now });
  }

  record(dist: number, now: number): void {
    const safeDist = Math.max(0, dist);
    if (safeDist < this.minDist) this.minDist = safeDist;
    if (safeDist > this.maxDist) this.maxDist = safeDist;
    this.samples.push({ dist: safeDist, time: now });
    const cutoff = now - QuickPinchTracker.WINDOW_MS * 2;
    while (this.samples.length > 4 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
  }

  /**
   * Evaluates on finger release whether this pinch was a deliberate quick inward snap.
   * Returns true if the fingers closed rapidly inward without zooming outward first.
   */
  shouldFitOnRelease(now: number): boolean {
    if (this.startDist < QuickPinchTracker.MIN_START_DIST) return false;
    const totalDuration = now - this.startTime;
    if (totalDuration <= 0 || totalDuration > QuickPinchTracker.MAX_DURATION_MS) return false;
    // Reject gestures that expanded noticeably before closing (user was zooming in then adjusting).
    if (this.maxDist > this.startDist * 1.18) return false;
    const last = this.samples[this.samples.length - 1];
    if (!last) return false;
    const ratio = last.dist / this.startDist;
    if (ratio > QuickPinchTracker.MAX_END_RATIO) return false;

    // Pick a reference sample ~40-90ms before the final sample to measure closing speed.
    let ref = this.samples[0];
    for (let i = this.samples.length - 2; i >= 0; i--) {
      if (last.time - this.samples[i].time >= 28) {
        ref = this.samples[i];
        break;
      }
    }
    const dtSec = Math.max(0.016, (last.time - ref.time) / 1000);
    const recentSpeed = ((last.dist - ref.dist) / this.startDist) / dtSec;
    const avgSpeed = ((last.dist - this.startDist) / this.startDist) / Math.max(0.03, totalDuration / 1000);
    return recentSpeed <= QuickPinchTracker.SPEED_THRESHOLD || avgSpeed <= QuickPinchTracker.SPEED_THRESHOLD * 0.9;
  }
}

export interface ThreeFingerSwipeResult {
  triggered: boolean;
  centroid: Point2D;
}

/**
 * Detects a Procraft-style 3-finger swipe down gesture to open the Copy & Paste menu.
 * Requires all 3 active fingers to move decisively downward (`>= 42px` each, average `>= 68px`,
 * and clearly vertical rather than horizontal scrub).
 */
export function detectThreeFingerSwipeDown(
  starts: ReadonlyMap<number, Point2D>,
  currents: ReadonlyMap<number, Point2D>,
): ThreeFingerSwipeResult {
  if (currents.size !== 3) {
    return { triggered: false, centroid: { x: 0, y: 0 } };
  }
  let sumDx = 0;
  let sumDy = 0;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const [id, cur] of currents.entries()) {
    const start = starts.get(id);
    if (!start) return { triggered: false, centroid: { x: 0, y: 0 } };
    const dx = cur.x - start.x;
    const dy = cur.y - start.y;
    if (dy < 42) return { triggered: false, centroid: { x: 0, y: 0 } };
    sumDx += dx;
    sumDy += dy;
    sumX += cur.x;
    sumY += cur.y;
    count++;
  }
  if (count !== 3) return { triggered: false, centroid: { x: 0, y: 0 } };
  const avgDx = sumDx / 3;
  const avgDy = sumDy / 3;
  const triggered = avgDy >= 68 && avgDy > Math.abs(avgDx) * 1.45;
  return {
    triggered,
    centroid: { x: sumX / 3, y: sumY / 3 },
  };
}

export type MultiFingerTapAction = 'undo' | 'redo' | 'fullscreen' | null;

export function classifyMultiFingerTap(params: {
  maxPointers: number;
  hasMoved: boolean;
  durationMs: number;
  cancelled: boolean;
  rapidTriggered: boolean;
  swipeTriggered: boolean;
  quickPinchTriggered: boolean;
  fourFingerFullscreenEnabled: boolean;
}): MultiFingerTapAction {
  const {
    maxPointers,
    hasMoved,
    durationMs,
    cancelled,
    rapidTriggered,
    swipeTriggered,
    quickPinchTriggered,
    fourFingerFullscreenEnabled,
  } = params;
  if (cancelled || hasMoved || rapidTriggered || swipeTriggered || quickPinchTriggered) return null;
  const maxDuration = maxPointers >= 4 ? 550 : 500;
  if (durationMs >= maxDuration) return null;
  if (maxPointers === 2) return 'undo';
  if (maxPointers === 3) return 'redo';
  if (maxPointers >= 4 && fourFingerFullscreenEnabled) return 'fullscreen';
  return null;
}

/**
 * Computes screen coordinates for the floating Eyedropper Loupe lifted above the finger
 * so the user's fingertip never covers the sampled color ring.
 */
export function computeLoupePosition(
  clientX: number,
  clientY: number,
  viewportW: number,
  viewportH: number,
  liftPx = 64,
  radiusPx = 46,
): Point2D {
  const pad = radiusPx + 10;
  const x = Math.max(pad, Math.min(Math.max(pad, viewportW - pad), clientX));
  const preferredY = clientY - liftPx;
  const y = preferredY < pad
    ? Math.min(Math.max(pad, viewportH - pad), clientY + liftPx)
    : Math.min(Math.max(pad, viewportH - pad), preferredY);
  return { x, y };
}
