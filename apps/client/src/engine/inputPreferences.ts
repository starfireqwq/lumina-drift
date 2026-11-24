export const SHOW_BRUSH_CROSSHAIR_KEY = 'atelier_show_brush_crosshair';
export const TOUCH_SIMULATED_PRESSURE_KEY = 'atelier_touch_simulated_pressure';

type PointerLike = {
  clientX: number;
  clientY: number;
  timeStamp: number;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function readBooleanPreference(key: string, defaultValue: boolean): boolean {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
  } catch {
    // Storage may be unavailable in restricted or headless contexts.
  }
  return defaultValue;
}

function writeBooleanPreference(key: string, value: boolean) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Ignore storage quota or security restrictions.
  }
}

let showBrushCrosshair = readBooleanPreference(SHOW_BRUSH_CROSSHAIR_KEY, true);
let touchSimulatedPressure = readBooleanPreference(TOUCH_SIMULATED_PRESSURE_KEY, false);

const crosshairListeners = new Set<() => void>();
const touchPressureListeners = new Set<() => void>();

export const getShowBrushCrosshair = () => showBrushCrosshair;

export function setShowBrushCrosshair(next: boolean) {
  const normalized = Boolean(next);
  if (normalized === showBrushCrosshair) return;
  showBrushCrosshair = normalized;
  writeBooleanPreference(SHOW_BRUSH_CROSSHAIR_KEY, normalized);
  crosshairListeners.forEach((listener) => listener());
}

export const subscribeShowBrushCrosshair = (listener: () => void) => {
  crosshairListeners.add(listener);
  return () => {
    crosshairListeners.delete(listener);
  };
};

export const getTouchSimulatedPressure = () => touchSimulatedPressure;

export function setTouchSimulatedPressure(next: boolean) {
  const normalized = Boolean(next);
  if (normalized === touchSimulatedPressure) return;
  touchSimulatedPressure = normalized;
  writeBooleanPreference(TOUCH_SIMULATED_PRESSURE_KEY, normalized);
  touchPressureListeners.forEach((listener) => listener());
}

export const subscribeTouchSimulatedPressure = (listener: () => void) => {
  touchPressureListeners.add(listener);
  return () => {
    touchPressureListeners.delete(listener);
  };
};

/**
 * Estimates natural pressure for finger-only touch strokes (`pointerType === 'touch'`)
 * from stroke lead-in distance, movement speed, and lift-off taper.
 * Never used for physical pens (`pointerType === 'pen'`) or mice (`pointerType === 'mouse'`).
 */
export class TouchPressureSimulator {
  private static readonly START_PRESSURE = 0.24;
  private static readonly TAP_PRESSURE = 0.62;
  private static readonly LEAD_IN_DISTANCE = 26;
  private static readonly MIN_SPEED_PRESSURE = 0.24;
  private static readonly MAX_SPEED_PRESSURE = 0.92;
  private static readonly SLOW_SPEED = 0.14; // px/ms
  private static readonly FAST_SPEED = 2.1; // px/ms

  private lastX: number;
  private lastY: number;
  private lastTime: number;
  private totalDistance = 0;
  private smoothedSpeed = 0.45;
  private currentPressure = TouchPressureSimulator.START_PRESSURE;

  constructor(initial: PointerLike) {
    this.lastX = initial.clientX;
    this.lastY = initial.clientY;
    this.lastTime = initial.timeStamp;
  }

  get distance(): number {
    return this.totalDistance;
  }

  get pressure(): number {
    return this.currentPressure;
  }

  private velocityPressure(speed: number): number {
    const t = clamp(
      (speed - TouchPressureSimulator.SLOW_SPEED) /
        (TouchPressureSimulator.FAST_SPEED - TouchPressureSimulator.SLOW_SPEED),
      0,
      1,
    );
    return (
      TouchPressureSimulator.MAX_SPEED_PRESSURE -
      (TouchPressureSimulator.MAX_SPEED_PRESSURE - TouchPressureSimulator.MIN_SPEED_PRESSURE) *
        Math.pow(t, 0.85)
    );
  }

  sample(point: PointerLike, isRelease = false): number {
    if (isRelease) return this.release(point);
    const dx = point.clientX - this.lastX;
    const dy = point.clientY - this.lastY;
    const dist = Math.hypot(dx, dy);
    const rawDt = point.timeStamp - this.lastTime;
    const dt = rawDt > 0 ? Math.min(rawDt, 120) : 0;

    if (dist < 0.05 && dt === 0) {
      return this.currentPressure;
    }

    this.lastX = point.clientX;
    this.lastY = point.clientY;
    if (rawDt > 0) this.lastTime = point.timeStamp;
    this.totalDistance += dist;

    if (dist >= 0.05) {
      const effectiveDt = Math.max(dt, 4);
      const instantSpeed = dist / effectiveDt;
      const speedAlpha = 1 - Math.exp(-effectiveDt / 26);
      this.smoothedSpeed += (instantSpeed - this.smoothedSpeed) * speedAlpha;
    }

    const leadRatio = clamp(this.totalDistance / TouchPressureSimulator.LEAD_IN_DISTANCE, 0, 1);
    const smoothLead = leadRatio * leadRatio * (3 - 2 * leadRatio);
    const speedTarget = this.velocityPressure(this.smoothedSpeed);
    const targetPressure =
      TouchPressureSimulator.START_PRESSURE +
      (speedTarget - TouchPressureSimulator.START_PRESSURE) * smoothLead;

    const pressureAlpha = 1 - Math.exp(-Math.max(dt, 8) / 22);
    this.currentPressure = clamp(
      this.currentPressure + (targetPressure - this.currentPressure) * pressureAlpha,
      0.08,
      1,
    );
    return this.currentPressure;
  }

  release(point?: PointerLike): number {
    if (point) {
      const dx = point.clientX - this.lastX;
      const dy = point.clientY - this.lastY;
      const dist = Math.hypot(dx, dy);
      const dt = Math.max(4, Math.min(120, point.timeStamp - this.lastTime));
      if (dist >= 0.5) {
        this.totalDistance += dist;
        const instantSpeed = dist / dt;
        this.smoothedSpeed = this.smoothedSpeed * 0.5 + instantSpeed * 0.5;
      }
      this.lastX = point.clientX;
      this.lastY = point.clientY;
      if (point.timeStamp > this.lastTime) this.lastTime = point.timeStamp;
    }

    if (this.totalDistance < 4) {
      this.currentPressure = TouchPressureSimulator.TAP_PRESSURE;
      return this.currentPressure;
    }

    const fastFactor = clamp(this.smoothedSpeed / TouchPressureSimulator.FAST_SPEED, 0, 1);
    const tailFloor = 0.22 - fastFactor * 0.13; // ~0.22 on slow lift, ~0.09 on fast flick
    const tapered = Math.min(this.currentPressure * 0.52, tailFloor);
    this.currentPressure = clamp(tapered, 0.08, 0.28);
    return this.currentPressure;
  }
}
