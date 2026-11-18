/**
 * Advanced Brush Pressure Curve & Dynamics Mapping
 *
 * Maps raw hardware pressure (0.0 to 1.0 from Pointer Events API)
 * to dynamic brush tip size and opacity/flow, supporting CSP/Krita-style
 * custom pressure response curves.
 */

export type PressureCurveType = 'linear' | 'soft' | 'hard' | 's-curve' | 'custom';

export interface PressureCurveConfig {
  type: PressureCurveType;
  // Cubic Bezier control points: [p1x, p1y, p2x, p2y] in [0..1]
  bezierPoints?: [number, number, number, number];
  // Minimum pressure threshold to register a stroke
  deadZone?: number;
}

/**
 * Evaluates pressure response for a given raw input pressure (0..1)
 */
export function evaluatePressureCurve(
  rawPressure: number,
  config?: PressureCurveType | PressureCurveConfig
): number {
  const p = Math.max(0.0, Math.min(1.0, rawPressure));

  if (!config) return p;

  const type = typeof config === 'string' ? config : config.type;
  const deadZone = (typeof config === 'object' && config.deadZone) ? config.deadZone : 0.0;

  // Apply dead zone threshold
  if (p < deadZone) return 0.0;
  const normalizedP = deadZone >= 1.0 ? 1.0 : (p - deadZone) / (1.0 - deadZone);

  switch (type) {
    case 'linear':
      return normalizedP;

    case 'soft':
      // Krita-like responsive light touch (easier entry without losing control)
      return Math.pow(normalizedP, 0.72);

    case 'hard':
      // Requires firmer pressing to expand tip size (concave curve)
      return Math.pow(normalizedP, 1.75);

    case 's-curve': {
      // Gentle S-curve blending linear response with Hermite smoothing so light strokes stay expressive
      const smooth = normalizedP * normalizedP * (3.0 - 2.0 * normalizedP);
      return normalizedP * 0.55 + smooth * 0.45;
    }

    case 'custom': {
      if (typeof config === 'object' && config.bezierPoints) {
        return evaluateCubicBezierPressure(normalizedP, config.bezierPoints);
      }
      return normalizedP;
    }

    default:
      return normalizedP;
  }
}

/**
 * Evaluates a 1D cubic Bezier curve defined by P0=(0,0), P1=(p1x,p1y), P2=(p2x,p2y), P3=(1,1)
 * Finds y for a given x using binary search / Newton-Raphson
 */
function evaluateCubicBezierPressure(x: number, pts: [number, number, number, number]): number {
  const [p1x, p1y, p2x, p2y] = pts;

  // Solve x(t) = x for t in [0..1]
  let low = 0.0;
  let high = 1.0;
  let t = x;

  for (let iter = 0; iter < 12; iter++) {
    const currentX = 3 * (1 - t) * (1 - t) * t * p1x + 3 * (1 - t) * t * t * p2x + t * t * t;
    if (Math.abs(currentX - x) < 0.001) break;
    if (currentX < x) {
      low = t;
    } else {
      high = t;
    }
    t = (low + high) * 0.5;
  }

  // Compute y(t)
  const y = 3 * (1 - t) * (1 - t) * t * p1y + 3 * (1 - t) * t * t * p2y + t * t * t;
  return Math.max(0.0, Math.min(1.0, y));
}

/**
 * Calculates dynamic brush tip size and opacity based on pressure curve
 */
export function mapBrushDynamics(
  rawPressure: number,
  baseSize: number,
  minSize: number,
  baseOpacity: number,
  config?: PressureCurveType | PressureCurveConfig
): { size: number; opacity: number; mappedPressure: number } {
  const mapped = evaluatePressureCurve(rawPressure, config);

  // Dynamic Size: minSize + (baseSize - minSize) * mappedPressure, allowing fine < 1px needle taper
  const effectiveMin = Math.min(minSize, baseSize);
  const floorSize = Math.min(0.35, effectiveMin);
  const size = Math.max(floorSize > 0 ? floorSize : 0.35, effectiveMin + (baseSize - effectiveMin) * mapped);

  // Dynamic Opacity: keep light strokes clear and crisp (Krita-like curve)
  const opacity = Math.max(0.01, Math.min(1.0, baseOpacity * (0.35 + 0.65 * Math.pow(mapped, 0.8))));

  return {
    size,
    opacity,
    mappedPressure: mapped,
  };
}
