import type { PressureCurveConfig } from '@atelier/shared';

const KEY = 'atelier_stylus_pressure_curve';
export const DEFAULT_PRESSURE_CURVE: PressureCurveConfig = { type: 'custom', bezierPoints: [0.25, 0.25, 0.75, 0.75], deadZone: 0 };
export const MAX_STYLUS_DEAD_ZONE = 0.2;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function constrainStylusCurve(curve: PressureCurveConfig): PressureCurveConfig {
  const [x1, y1, x2, y2] = curve.bezierPoints ?? DEFAULT_PRESSURE_CURVE.bezierPoints!;
  return {
    ...curve,
    bezierPoints: [clamp(x1, 0, 1), clamp(y1, 0, 1), clamp(x2, 0, 1), clamp(y2, 0, 1)],
    deadZone: clamp(curve.deadZone ?? 0, 0, MAX_STYLUS_DEAD_ZONE),
  };
}

export function readStylusPressureCurve(): PressureCurveConfig | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PressureCurveConfig | null;
    if (value?.type === 'custom' && value.bezierPoints?.length === 4 &&
      value.bezierPoints.every((point) => Number.isFinite(point) && point >= 0 && point <= 1) &&
      (value.deadZone === undefined || Number.isFinite(value.deadZone) && value.deadZone >= 0 && value.deadZone <= 0.5)) {
      return constrainStylusCurve(value);
    }
  } catch {
    // Older or unavailable settings fall back to the brush's existing response.
  }
}

export function saveStylusPressureCurve(curve: PressureCurveConfig) {
  localStorage.setItem(KEY, JSON.stringify(constrainStylusCurve(curve)));
}
