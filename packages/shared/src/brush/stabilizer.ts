/**
 * Stroke stabilizer (防手震) and the spline that joins the smoothed points.
 *
 * 1. One or two first-order low-pass stages on the pen position, timed by each event's own
 *    timestamp, so the result does not depend on the pen's report rate. A low-pass filter never
 *    overshoots: the line cannot swing past where the pen stopped, nor ring around a straight
 *    path. (The old mass-spring did both: at levels 1–3 its damping let it oscillate for dozens of
 *    events, so straight lines coiled like a phone cord and fast strokes ran 20 px past the stop.)
 *    Lag grows with the level; at pen-up `settle` finishes the line where the pen lifted.
 * 2. Centripetal Catmull-Rom spline through the smoothed points: knots spaced by √distance, so
 *    uneven spacing (slowing down, the dense end of a stroke) bends without hooks or loops.
 */

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  time?: number;
}

/**
 * Per-stage time constant (ms) for levels 0–10.
 * Tuned for 60–240Hz displays: Levels 1–4 filter jitter with sub-frame/near-zero cursor drag;
 * Levels 5–10 provide progressive lazy-string line smoothing.
 */
const STAGE_TAU_MS = [0, 1.5, 3, 5, 7.5, 10.5, 14, 18.5, 24, 31, 40];
export const MAX_STABILIZER_LEVEL = STAGE_TAU_MS.length - 1;
export const STABILIZER_LEVEL_STEP = 0.5;
/** Event spacing assumed for points without a timestamp, and the step `settle` simulates */
const DEFAULT_DT_MS = 1000 / 120;
/** Minimum positive dt when coalesced browser events arrive in the same frame with equal timestamps */
const MIN_COALESCED_DT_MS = 2;
/** A long pause counts as this much: the line catches up but does not jump across the gap */
const MAX_DT_MS = 100;

const clampLevel = (level: number) => Math.max(0, Math.min(
  MAX_STABILIZER_LEVEL,
  Math.round((Number(level) || 0) / STABILIZER_LEVEL_STEP) * STABILIZER_LEVEL_STEP,
));

function positionTau(level: number, pullDist: number, settling: boolean): number {
  const baseTau = STAGE_TAU_MS[level];
  const tau = settling ? Math.max(3, baseTau * 0.65) : baseTau;
  const catchThresh = level <= 5 ? 2.5 : 5;
  if (baseTau <= 2 || pullDist <= catchThresh) return tau;
  const scale = level <= 5 ? 14 : 22;
  const catchUp = 1 + Math.min(2.4, (pullDist - catchThresh) / scale);
  return Math.max(1.5, tau / catchUp);
}

export class DynamicStabilizer {
  private level = 0;
  private lowerLevel = 0;
  private levelFraction = 0;
  private secondStageWeight = 0;
  private pressureTau = 1.5;
  private lowRateInput = false;
  // Two low-pass stages in series for both position AND pressure so size/position stay phase-aligned
  private ax = 0;
  private ay = 0;
  private bx = 0;
  private by = 0;
  private ap = 0.5;
  private bp = 0.5;
  private lastTime: number | undefined;
  private isInitialized = false;

  constructor(level: number = 3) {
    this.setLevel(level);
  }

  public setLevel(level: number) {
    this.level = clampLevel(level);
    this.lowerLevel = Math.floor(this.level);
    this.levelFraction = this.level - this.lowerLevel;
    this.secondStageWeight = Math.max(0, Math.min(1, this.level - 3));
    const lowerTau = STAGE_TAU_MS[this.lowerLevel];
    const upperTau = STAGE_TAU_MS[Math.ceil(this.level)];
    const baseTau = lowerTau + (upperTau - lowerTau) * this.levelFraction;
    this.pressureTau = Math.max(1.5, Math.min(6, baseTau * 0.45));
  }

  public getLevel(): number {
    return this.level;
  }

  /** Browser pointer reports may arrive once per display frame rather than at tablet rate. */
  public setLowRateInput(enabled: boolean) {
    this.lowRateInput = enabled;
  }

  public reset(initialPoint?: StrokePoint) {
    if (initialPoint) {
      const p = initialPoint.pressure ?? 0.5;
      this.ax = this.bx = initialPoint.x;
      this.ay = this.by = initialPoint.y;
      this.ap = this.bp = p;
      this.lastTime = initialPoint.time;
      this.isInitialized = true;
    } else {
      this.lastTime = undefined;
      this.isInitialized = false;
    }
  }

  /** Pushes a raw pointer sample and returns the smoothed point */
  public pushRawPoint(raw: StrokePoint): StrokePoint {
    if (!this.isInitialized) {
      this.reset(raw);
      return { ...raw };
    }
    const dt = this.elapsed(raw.time);
    const rawP = raw.pressure ?? 0.5;
    if (this.level === 0) {
      this.ax = this.bx = raw.x;
      this.ay = this.by = raw.y;
      this.ap = this.bp = rawP;
      return { ...raw };
    }
    this.stepPosition(raw.x, raw.y, dt);
    // A shorter time constant keeps pen size responsive to contact pressure.
    const apAlpha = 1 - Math.exp(-dt / this.pressureTau);
    this.ap += (rawP - this.ap) * apAlpha;
    this.bp += (this.ap - this.bp) * apAlpha;
    return { x: this.bx, y: this.by, pressure: this.bp, tiltX: raw.tiltX, tiltY: raw.tiltY, time: raw.time };
  }

  /**
   * Points that carry a lagging line on to `raw` (where the pen lifted), easing in cleanly and
   * smoothly tapering pressure over the remaining arc length so lifting never leaves an abrupt
   * needle-wire step.
   */
  public settle(raw: StrokePoint): StrokePoint[] {
    if (!this.isInitialized || this.level === 0) return [];
    const positions: Array<{ x: number; y: number; dist: number }> = [];
    let prevX = this.bx;
    let prevY = this.by;
    const startP = this.bp;
    // Target end pressure: smoothly taper slightly on lift without dropping instantaneously to 0.02 or rebounding above startP
    const endP = raw.pressure > 0.01 ? Math.min(startP, raw.pressure) : Math.min(startP, Math.max(0.04, startP * 0.4));

    let totalDist = 0;
    for (let i = 0; i < 120 && Math.hypot(raw.x - this.bx, raw.y - this.by) > 0.35; i++) {
      this.stepPosition(raw.x, raw.y, DEFAULT_DT_MS, true);
      const seg = Math.hypot(this.bx - prevX, this.by - prevY);
      totalDist += seg;
      positions.push({ x: this.bx, y: this.by, dist: totalDist });
      prevX = this.bx;
      prevY = this.by;
    }

    const finalSeg = Math.hypot(raw.x - prevX, raw.y - prevY);
    if (finalSeg > 0.01 || positions.length > 0) {
      totalDist += finalSeg;
      positions.push({ x: raw.x, y: raw.y, dist: totalDist });
    }

    this.ax = this.bx = raw.x;
    this.ay = this.by = raw.y;
    this.ap = this.bp = endP;

    const invTotal = totalDist > 1e-4 ? 1 / totalDist : 0;
    return positions.map((pos, idx) => {
      const u = invTotal > 0 ? Math.min(1, pos.dist * invTotal) : (idx + 1) / Math.max(1, positions.length);
      const smooth = u * u * (3 - 2 * u);
      return {
        x: pos.x,
        y: pos.y,
        pressure: startP + (endP - startP) * smooth,
        tiltX: raw.tiltX,
        tiltY: raw.tiltY,
        time: raw.time,
      };
    });
  }

  private elapsed(time?: number): number {
    let dt = DEFAULT_DT_MS;
    if (time !== undefined && this.lastTime !== undefined) {
      const delta = time - this.lastTime;
      // Same-frame coalesced events frequently carry identical timestamps; keep advancing instead of a=0 freeze
      dt = delta > 0 ? Math.min(MAX_DT_MS, delta) : MIN_COALESCED_DT_MS;
    }
    if (time !== undefined && (this.lastTime === undefined || time > this.lastTime)) {
      this.lastTime = time;
    }
    return dt;
  }

  private stepPosition(x: number, y: number, dt: number, settling = false) {
    const pullDist = Math.hypot(x - this.bx, y - this.by);
    let tau = positionTau(this.lowerLevel, pullDist, settling);
    if (this.levelFraction > 0) {
      const upperTau = positionTau(this.lowerLevel + 1, pullDist, settling);
      tau += (upperTau - tau) * this.levelFraction;
    }
    if (this.lowRateInput && !settling) {
      tau = Math.max(tau, Math.min(dt, 1000 / 60) * (0.75 + this.level * 0.3));
    }
    const a = 1 - Math.exp(-dt / Math.max(0.5, tau));
    if (this.secondStageWeight === 0) {
      // Single-stage exponential smoothing for levels 1-3: ultra low cursor drag while filtering jitter
      this.ax = this.bx += (x - this.bx) * a;
      this.ay = this.by += (y - this.by) * a;
    } else {
      this.ax += (x - this.ax) * a;
      this.ay += (y - this.ay) * a;
      // At 3.5 the second stage responds faster, bridging the one- and two-stage filters.
      const b = this.secondStageWeight === 1 ? a : 1 - Math.exp(-dt / Math.max(0.5, tau * this.secondStageWeight));
      this.bx += (this.ax - this.bx) * b;
      this.by += (this.ay - this.by) * b;
    }
  }

  /**
   * Centripetal Catmull-Rom between p1 and p2 at u in [0..1] (Barry–Goldman pyramid). Pressure is
   * linear between p1 and p2: a coincident pair of points must not swing it.
   */
  public static interpolateCatmullRom(
    p0: StrokePoint,
    p1: StrokePoint,
    p2: StrokePoint,
    p3: StrokePoint,
    u: number
  ): StrokePoint {
    const knot = (a: StrokePoint, b: StrokePoint) => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
    const t0 = 0;
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const t = t1 + (t2 - t1) * u;
    const lerp = (a: number, b: number, ta: number, tb: number) => ((tb - t) * a + (t - ta) * b) / (tb - ta);
    const pyramid = (v0: number, v1: number, v2: number, v3: number) => {
      const a1 = lerp(v0, v1, t0, t1);
      const a2 = lerp(v1, v2, t1, t2);
      const a3 = lerp(v2, v3, t2, t3);
      return lerp(lerp(a1, a2, t0, t2), lerp(a2, a3, t1, t3), t1, t2);
    };
    const pr1 = p1.pressure ?? 0.5;
    const pr2 = p2.pressure ?? 0.5;
    return {
      x: pyramid(p0.x, p1.x, p2.x, p3.x),
      y: pyramid(p0.y, p1.y, p2.y, p3.y),
      pressure: Math.max(0, Math.min(1, pr1 + (pr2 - pr1) * u)),
    };
  }

  /**
   * Subdivides segment (p1 -> p2) into smoothly spaced dabs
   * @param spacing Distance in pixels between consecutive dabs
   */
  public static sampleSplineSegment(
    p0: StrokePoint,
    p1: StrokePoint,
    p2: StrokePoint,
    p3: StrokePoint,
    spacing: number = 4
  ): StrokePoint[] {
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (dist < 0.1) return [];

    const steps = Math.max(4, Math.ceil(dist / Math.max(1, spacing)));
    const samples: StrokePoint[] = [];

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      samples.push(DynamicStabilizer.interpolateCatmullRom(p0, p1, p2, p3, t));
    }

    return samples;
  }
}
