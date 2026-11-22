/**
 * Off-Main-Thread Stroke Worker
 * High-performance stroke smoothing (DynamicStabilizer / Catmull-Rom)
 * Dynamic pressure curve mapping (linear, soft, hard, s-curve, custom)
 * Output via Transferable Float32Array (Zero-Copy)
 */

import {
  DynamicStabilizer,
  MIN_BRUSH_SPACING,
  evaluatePressureCurve,
  evaluateDynamicChannel,
  evaluateAngleJitterRadians,
  PressureCurveConfig,
  PressureCurveType,
  type BrushDynamicsConfig,
} from '@atelier/shared';

export interface RawPoint {
  x: number;
  y: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  /** Pen barrel rotation in degrees (PointerEvent.twist), 0 when unsupported */
  twist?: number;
  time?: number;
}

export interface WorkerBrushConfig {
  size: number;
  minSize: number;
  hardness: number;
  flow: number;
  spacing: number;
  isEraser: boolean;
  eraserMode?: 'hard' | 'soft';
  opacity: number;
  stabilizerLevel: number; // 0 (raw) to 10 (maximum smoothing)
  followSamples?: boolean;
  lowRateInput?: boolean;
  scatter: number; // 0 to 1
  pressureCurve?: PressureCurveType | PressureCurveConfig;
  colorMixing?: number;
  paintAmount?: number;
  brushType?: string;
  antiAlias?: 'none' | 'weak' | 'medium' | 'strong';
  /** 'pen': the dab angle follows the pen (twist, else the tilt direction) instead of the stroke */
  angleMode?: 'direction' | 'pen' | 'fixed';
  /** Brush Engine v2 per-channel dynamics (pressure / tilt / velocity / random + min floor) */
  dynamics?: BrushDynamicsConfig;
}

// Float count per dab: [x, y, size, pressure, alpha, rotation, tilt (0 upright … 1 flat)]
export const FLOATS_PER_DAB = 7;

export class StrokeWorkerEngine {
  private config: WorkerBrushConfig = {
    size: 16,
    minSize: 0.8,
    hardness: 0.8,
    flow: 1.0,
    spacing: MIN_BRUSH_SPACING,
    isEraser: false,
    opacity: 1.0,
    stabilizerLevel: 3,
    scatter: 0,
    pressureCurve: 'linear',
  };

  private stabilizer = new DynamicStabilizer(3);

  // Causal C¹ quadratic midpoint spline state (zero full-segment lookahead delay & zero endpoint hooks)
  private prevAnchor: RawPoint | null = null;
  private lastControl: RawPoint | null = null;
  private hasFirstSegment = false;
  private distanceToNextDab = 0; // Remaining path length, carried across segments and worker messages.
  // The pen's latest tilt / twist: they change slowly, so a batch of dabs shares them
  private pen = { tilt: 0, azimuth: 0, twist: 0, has: false };
  // Smoothed normalized stroke velocity (0..1) for velocity-driven dynamics (does not alter stabilizer)
  private lastRawForVel: { x: number; y: number; time: number } | null = null;
  private currentVelocity = 0;

  private trackPen(pt: RawPoint) {
    const tx = pt.tiltX ?? 0;
    const ty = pt.tiltY ?? 0;
    this.pen = {
      tilt: Math.min(1, Math.hypot(tx, ty) / 90),
      azimuth: Math.atan2(ty, tx),
      twist: ((pt.twist ?? 0) * Math.PI) / 180,
      has: tx !== 0 || ty !== 0 || Boolean(pt.twist),
    };
    const now = pt.time ?? 0;
    if (this.lastRawForVel && now > this.lastRawForVel.time) {
      const dt = Math.max(1, now - this.lastRawForVel.time);
      const speedPxPerMs = Math.hypot(pt.x - this.lastRawForVel.x, pt.y - this.lastRawForVel.y) / dt;
      const norm = Math.max(0, Math.min(1, speedPxPerMs / 2.5));
      this.currentVelocity = this.currentVelocity * 0.65 + norm * 0.35;
    }
    this.lastRawForVel = { x: pt.x, y: pt.y, time: now };
  }

  /** The dab angle for 'pen' mode: barrel twist if the pen reports it, else where it leans */
  private penAngle(fallback: number) {
    if (this.config.angleMode !== 'pen' || !this.pen.has) return fallback;
    return this.pen.twist || this.pen.azimuth;
  }

  public initStroke(config: WorkerBrushConfig, initialPoint: RawPoint): Float32Array {
    this.config = { ...config };
    this.stabilizer.setLevel(config.stabilizerLevel ?? 3);
    this.stabilizer.setLowRateInput(config.lowRateInput ?? false);
    this.stabilizer.reset(initialPoint);

    this.distanceToNextDab = 0;
    this.prevAnchor = { ...initialPoint };
    this.lastControl = { ...initialPoint };
    this.hasFirstSegment = false;
    this.lastRawForVel = null;
    this.currentVelocity = 0;
    this.trackPen(initialPoint);

    // Generate the initial dab at start of stroke
    return this.generateInitialDab(initialPoint);
  }

  public setPressureCurve(curve: PressureCurveConfig, followSamples = false) {
    this.config.pressureCurve = curve;
    this.config.followSamples = followSamples;
  }

  public startSegment(point: RawPoint): Float32Array {
    return this.initStroke(this.config, point);
  }

  private computeDabSizeAndAlpha(mappedPressure: number): { size: number; alpha: number } {
    const p = Math.max(0, Math.min(1.0, mappedPressure));
    if (p === 0) return { size: 0, alpha: 0 };
    const effectiveMin = Math.max(0, Math.min(this.config.minSize, this.config.size));
    const dyn = this.config.dynamics;
    const dynInput = {
      pressure: p,
      tilt: this.pen.tilt,
      velocity: this.currentVelocity,
      rand: Math.random(),
    };

    if (this.config.eraserMode) {
      const size = dyn?.size
        ? Math.max(0.35, this.config.size * evaluateDynamicChannel(dyn.size, dynInput, 1))
        : effectiveMin + (this.config.size - effectiveMin) * p;
      const opMult = dyn?.opacity ? evaluateDynamicChannel(dyn.opacity, dynInput, 1) : 1;
      return {
        size,
        alpha: Math.max(0, Math.min(1, this.config.opacity * opMult)),
      };
    }

    const explicitAirbrush = this.config.brushType === 'airbrush';
    if (this.config.antiAlias === 'none' && !explicitAirbrush) {
      const size = dyn?.size
        ? Math.max(1, Math.round(this.config.size * evaluateDynamicChannel(dyn.size, dynInput, 1)))
        : Math.max(1, Math.round(effectiveMin + (this.config.size - effectiveMin) * p));
      return { size, alpha: 1.0 };
    }

    // Compute dab size using explicit v2 size dynamics when configured, else preserve legacy minSize..size taper
    const computeSize = (defaultSize: number): number => {
      if (!dyn?.size) return defaultSize;
      const minRatio = dyn.size.min ?? (this.config.size > 0 ? effectiveMin / this.config.size : 0);
      const mult = evaluateDynamicChannel({ ...dyn.size, min: minRatio }, dynInput, 1);
      return Math.max(0.35, this.config.size * mult);
    };

    const isAirbrush = explicitAirbrush || this.config.hardness <= 0.25;
    if (isAirbrush) {
      const size = Math.max(1.5, computeSize(effectiveMin + (this.config.size - effectiveMin) * (0.72 + 0.28 * p)));
      const opMult = dyn?.opacity ? evaluateDynamicChannel(dyn.opacity, dynInput, 1) : Math.pow(p, 1.4);
      const flowMult = dyn?.flow ? evaluateDynamicChannel(dyn.flow, dynInput, 1) : 1;
      const passAlpha = Math.min(0.96, this.config.flow * flowMult * this.config.opacity * opMult);
      const overlap = Math.max(1, 0.63 * size / this.spacingForSize(size));
      const alpha = 1 - Math.pow(1 - passAlpha, 1 / overlap);
      return { size, alpha };
    }

    const isInkingPen =
      this.config.brushType !== 'pencil' &&
      (this.config.brushType === 'pen' ||
        (this.config.hardness >= 0.92 && (this.config.colorMixing ?? 0) === 0 && this.config.flow >= 0.98));

    if (isInkingPen && !dyn?.opacity && !dyn?.flow) {
      const size = computeSize(effectiveMin + (this.config.size - effectiveMin) * p);
      const alpha = this.config.flow * this.config.opacity * (0.78 + 0.22 * Math.pow(p, 0.5));
      return { size, alpha };
    }

    // Painting, blending & shading brushes (or any brush with explicit v2 opacity/flow dynamics):
    const size = computeSize(effectiveMin + (this.config.size - effectiveMin) * p);
    const isPlainSolidBrush = (this.config.colorMixing ?? 0) === 0 && this.config.flow >= 0.99 && this.config.hardness >= 0.8;
    const legacyPressureOpacity = isPlainSolidBrush && p >= 0.8
      ? Math.min(0.999, 0.75 + (p - 0.8) * 1.245)
      : Math.pow(p, 1.35);
    const opMult = dyn?.opacity ? evaluateDynamicChannel(dyn.opacity, dynInput, 1) : legacyPressureOpacity;
    const flowMult = dyn?.flow ? evaluateDynamicChannel(dyn.flow, dynInput, 1) : 1;
    const passAlpha = Math.min(0.999, this.config.flow * flowMult * this.config.opacity * opMult);
    // When opacity dynamics are explicitly OFF and flow is full on a hard brush, stamp directly without overlap attenuation
    if (dyn?.opacity && !dyn.opacity.pressure && !dyn.opacity.tilt && !dyn.opacity.velocity && !(dyn.opacity.random ?? 0) && this.config.flow * flowMult >= 0.99 && this.config.hardness >= 0.85) {
      return { size, alpha: passAlpha };
    }
    const overlap = Math.max(1.2, 0.55 / Math.max(MIN_BRUSH_SPACING, this.config.spacing));
    const alpha = 1 - Math.pow(1 - passAlpha, 1 / overlap);
    return { size, alpha };
  }

  private generateInitialDab(pt: RawPoint): Float32Array {
    const dabs = new Float32Array(FLOATS_PER_DAB);
    const rawP = Math.max(0, Math.min(1.0, pt.pressure ?? 0.02));
    const mappedPressure = evaluatePressureCurve(rawP, this.config.pressureCurve ?? 'linear');
    const { size, alpha } = this.computeDabSizeAndAlpha(mappedPressure);

    dabs[0] = pt.x;
    dabs[1] = pt.y;
    dabs[2] = size;
    dabs[3] = mappedPressure;
    dabs[4] = alpha;
    dabs[5] = this.penAngle(0); // rotation
    dabs[6] = this.pen.tilt;

    this.distanceToNextDab = this.spacingForSize(size);
    return dabs;
  }

  private spacingForSize(size: number) {
    // Keep standard 0.8px floor for normal brush sizes, tighten smoothly below 4px so needle tapers never bead
    const minStep = size < 4 ? Math.max(0.25, size * 0.2) : 0.8;
    const soft = !this.config.eraserMode &&
      (this.config.brushType === 'airbrush' || (this.config.antiAlias !== 'none' && this.config.hardness <= 0.25));
    const spacing = Math.max(MIN_BRUSH_SPACING, this.config.spacing);
    return soft ? Math.max(0.25, size * Math.min(0.08, spacing)) : Math.max(minStep, size * spacing);
  }

  private appendSmoothedPoint(pt: RawPoint, generatedDabsList: number[]) {
    if (!this.prevAnchor || !this.lastControl) {
      this.prevAnchor = { ...pt };
      this.lastControl = { ...pt };
      return;
    }
    const dist = Math.hypot(pt.x - this.lastControl.x, pt.y - this.lastControl.y);
    if (dist < 0.15) {
      // Even on sub-pixel dwell, carry updated pressure forward smoothly without stalling
      this.lastControl.pressure = pt.pressure;
      return;
    }

    const mid: RawPoint = {
      x: (this.lastControl.x + pt.x) * 0.5,
      y: (this.lastControl.y + pt.y) * 0.5,
      pressure: ((this.lastControl.pressure ?? 0.02) + (pt.pressure ?? this.lastControl.pressure ?? 0.02)) * 0.5,
      tiltX: pt.tiltX,
      tiltY: pt.tiltY,
      twist: pt.twist,
      time: pt.time,
    };

    if (this.config.followSamples) {
      this.emitQuadraticSegment(this.lastControl, mid, pt, generatedDabsList);
      this.prevAnchor = this.lastControl = pt;
      return;
    }

    if (!this.hasFirstSegment) {
      this.emitQuadraticSegment(this.prevAnchor, this.prevAnchor, mid, generatedDabsList);
      this.hasFirstSegment = true;
    } else {
      this.emitQuadraticSegment(this.prevAnchor, this.lastControl, mid, generatedDabsList);
    }

    this.prevAnchor = mid;
    this.lastControl = { ...pt };
  }

  public addRawPoints(points: RawPoint[]): Float32Array {
    if (points.length === 0) return new Float32Array(0);

    const generatedDabsList: number[] = [];

    for (let i = 0; i < points.length; i++) {
      const raw = points[i];
      this.trackPen(raw);
      const smoothed = this.stabilizer.pushRawPoint(raw);
      this.appendSmoothedPoint(smoothed, generatedDabsList);
    }

    return new Float32Array(generatedDabsList);
  }

  public finishStroke(lastPoint?: RawPoint): Float32Array {
    const generatedDabsList: number[] = [];

    if (lastPoint) {
      this.trackPen(lastPoint);
      if (this.stabilizer.getLevel() > 0) {
        const tail = this.stabilizer.settle(lastPoint);
        for (const pt of tail) {
          this.appendSmoothedPoint(pt, generatedDabsList);
        }
      } else {
        const pt = this.stabilizer.pushRawPoint(lastPoint);
        this.appendSmoothedPoint(pt, generatedDabsList);
      }
    }

    // Flush the remaining half-segment smoothly right up to the final pointer coordinate
    if (this.prevAnchor && this.lastControl) {
      const dist = Math.hypot(this.lastControl.x - this.prevAnchor.x, this.lastControl.y - this.prevAnchor.y);
      if (dist >= 0.05) {
        const midCtrl: RawPoint = {
          x: (this.prevAnchor.x + this.lastControl.x) * 0.5,
          y: (this.prevAnchor.y + this.lastControl.y) * 0.5,
          pressure: ((this.prevAnchor.pressure ?? 0.02) + (this.lastControl.pressure ?? this.prevAnchor.pressure ?? 0.02)) * 0.5,
        };
        this.emitQuadraticSegment(this.prevAnchor, midCtrl, this.lastControl, generatedDabsList);
      }
    }

    this.prevAnchor = null;
    this.lastControl = null;
    this.hasFirstSegment = false;
    this.stabilizer.reset();
    return new Float32Array(generatedDabsList);
  }

  /**
   * Evaluates C¹ quadratic Bezier (p0 --ctrl--> p2) and emits dabs spaced strictly by arc length
   */
  private emitQuadraticSegment(
    p0: RawPoint,
    ctrl: RawPoint,
    p2: RawPoint,
    outputDabs: number[]
  ) {
    const chord = Math.hypot(ctrl.x - p0.x, ctrl.y - p0.y) + Math.hypot(p2.x - ctrl.x, p2.y - ctrl.y);
    if (chord < 0.001) return;

    const subdivisions = Math.max(3, Math.min(20, Math.ceil(chord / 4)));
    const pr0 = p0.pressure ?? 0.02;
    const pr1 = ctrl.pressure ?? pr0;
    const pr2 = p2.pressure ?? pr1;
    let previous = { x: p0.x, y: p0.y, pressure: pr0 };

    for (let step = 1; step <= subdivisions; step++) {
      const t = step / subdivisions;
      const omt = 1 - t;
      const cx = omt * omt * p0.x + 2 * omt * t * ctrl.x + t * t * p2.x;
      const cy = omt * omt * p0.y + 2 * omt * t * ctrl.y + t * t * p2.y;
      const cp = omt * omt * pr0 + 2 * omt * t * pr1 + t * t * pr2;
      const dx = cx - previous.x;
      const dy = cy - previous.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const angle = Math.atan2(dy, dx);
        let travelled = 0;
        while (this.distanceToNextDab <= length - travelled + 1e-9) {
          travelled = Math.min(length, travelled + this.distanceToNextDab);
          const u = travelled / length;
          const interpP = Math.max(0, Math.min(1.0, previous.pressure + (cp - previous.pressure) * u));
          const pressure = evaluatePressureCurve(interpP, this.config.pressureCurve ?? 'linear');
          const { size, alpha } = this.computeDabSizeAndAlpha(pressure);
          let x = previous.x + dx * u;
          let y = previous.y + dy * u;
          let rotation = this.penAngle(angle);
          const dynInput = {
            pressure,
            tilt: this.pen.tilt,
            velocity: this.currentVelocity,
            rand: Math.random(),
          };
          if (this.config.dynamics?.angle) {
            rotation += evaluateAngleJitterRadians(this.config.dynamics.angle, dynInput);
          }
          const scatterMult = this.config.dynamics?.scatter
            ? evaluateDynamicChannel(this.config.dynamics.scatter, dynInput, 1)
            : 1;
          const effScatter = this.config.scatter * scatterMult;
          if (effScatter > 0) {
            const normal = angle + Math.PI / 2;
            const jitter = (Math.random() - 0.5) * 4 * effScatter * size;
            x += Math.cos(normal) * jitter;
            y += Math.sin(normal) * jitter;
            rotation += (Math.random() - 0.5) * Math.PI * effScatter;
          }

          outputDabs.push(x, y, size, pressure, alpha, rotation, this.pen.tilt);
          this.distanceToNextDab = this.spacingForSize(size);
        }
        this.distanceToNextDab -= length - travelled;
      }
      previous = { x: cx, y: cy, pressure: cp };
    }
  }
}

// Web Worker message listener
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  const engine = new StrokeWorkerEngine();
  self.onmessage = (e: MessageEvent) => {
    const { type, config, point, points, strokeId } = e.data;

    switch (type) {
      case 'START_STROKE': {
        const dabs = engine.initStroke(config, point);
        const dabCount = dabs.length / FLOATS_PER_DAB;
        (self as any).postMessage(
          { type: 'DABS', buffer: dabs.buffer, count: dabCount, isStart: true, strokeId },
          [dabs.buffer]
        );
        break;
      }

      case 'ADD_POINTS': {
        const dabs = engine.addRawPoints(points);
        const dabCount = dabs.length / FLOATS_PER_DAB;
        if (dabCount > 0) {
          (self as any).postMessage(
            { type: 'DABS', buffer: dabs.buffer, count: dabCount, strokeId },
            [dabs.buffer]
          );
        }
        break;
      }

      case 'FINISH_STROKE': {
        const dabs = engine.finishStroke(point);
        const dabCount = dabs.length / FLOATS_PER_DAB;
        (self as any).postMessage(
          { type: 'STROKE_FINISHED', buffer: dabs.buffer, count: dabCount, strokeId },
          [dabs.buffer]
        );
        break;
      }

      default:
        console.warn('[StrokeWorker] Unknown message type:', type);
    }
  };
}
