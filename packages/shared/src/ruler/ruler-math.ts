/**
 * AtelierSync Ruler & Guideline System Math
 * Supports symmetry, perspective, parallel, concentric, radial line, and curve rulers.
 */

export type RulerMode = 'off' | 'symmetry' | 'perspective' | 'parallel' | 'concentric' | 'radial_line' | 'curve';

export type SymmetryMode = '2-axis' | 'radial' | 'bilateral';

export interface SymmetryConfig {
  mode: SymmetryMode;
  axesCount: number; // 2, 3, 4, 5, 6, 8, 12, 16, etc.
  centerX: number;
  centerY: number;
  angleDeg?: number; // 0 to 360, default 90 (vertical line)
  kaleidoscope?: boolean;
}

export type PerspectiveMode = '1-point' | '2-point' | '3-point';

export interface Point2D {
  x: number;
  y: number;
}

export type PerspectiveGridPlane = 'xy' | 'xz' | 'yz';

export interface PerspectiveGridConfig {
  enabled: boolean;
  planes: { xy: boolean; xz: boolean; yz: boolean };
  spacing: number;
  gridOrigin?: Point2D;
  opacity?: number;
}

export interface PerspectiveGridLine {
  plane: PerspectiveGridPlane;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PerspectiveConfig {
  mode: PerspectiveMode;
  horizonY: number;
  vp1: Point2D; // Primary Vanishing Point (Left or Center)
  vp2: Point2D; // Secondary Vanishing Point (Right)
  vp3: Point2D; // Tertiary Vanishing Point (Vertical / Aerial / Worm-eye)
  snapThreshold?: number;
  grid?: PerspectiveGridConfig;
}

export interface ParallelConfig {
  angleDeg: number; // 0 to 360 degrees
  snapThreshold?: number;
}

export interface ConcentricConfig {
  centerX: number;
  centerY: number;
  stepRadius?: number; // e.g. 50px increments
}

export interface RadialLineConfig {
  centerX: number;
  centerY: number;
  rayCount?: number;
  innerRadius?: number;
  snapThreshold?: number;
}

export type CurveRulerType = 'bezier' | 'quadratic' | 'spline';

export interface CurveAnchorPoint {
  id: string;
  x: number;
  y: number;
  handleIn?: Point2D;
  handleOut?: Point2D;
}

export interface CurveRulerConfig {
  curveType: CurveRulerType;
  closed: boolean;
  anchors: CurveAnchorPoint[];
  snapSamplesPerSegment?: number;
}

/** Vertical ('x': constant x) or horizontal ('y': constant y) canvas guide line */
export type CanvasGuideAxis = 'x' | 'y';

export interface CanvasGuide {
  id: string;
  axis: CanvasGuideAxis;
  /** Whole-pixel coordinate in canvas space */
  position: number;
  locked?: boolean;
}

export interface GuidesConfig {
  visible: boolean;
  items: CanvasGuide[];
  /** Subset of guide IDs explicitly chosen as alignment/distribution basis (empty = all visible) */
  selectedIds: string[];
}

/**
 * Computes all symmetric counterpart points for a stroke dab point
 */
export function computeSymmetryPoints(
  pt: Point2D,
  config: SymmetryConfig
): Point2D[] {
  const { mode, axesCount, centerX, centerY, angleDeg = 90, kaleidoscope } = config;
  const results: Point2D[] = [pt];

  const count = axesCount || 2;
  const isRadial = mode === 'radial' || (mode !== '2-axis' && mode !== 'bilateral' && count > 2);

  if (!isRadial && mode === 'bilateral') {
    // Bilateral mirror reflection across a line passing through center
    const rad = (angleDeg * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const vx = pt.x - centerX;
    const vy = pt.y - centerY;
    const dot = vx * ux + vy * uy;
    const rx = centerX + 2 * dot * ux - vx;
    const ry = centerY + 2 * dot * uy - vy;
    results.push({
      x: Math.round(rx * 100) / 100,
      y: Math.round(ry * 100) / 100,
    });
  } else if (!isRadial && mode === '2-axis') {
    // 2-axis: horizontal and vertical cross mirror (4 quadrants)
    const hMirror: Point2D = { x: 2 * centerX - pt.x, y: pt.y };
    const vMirror: Point2D = { x: pt.x, y: 2 * centerY - pt.y };
    const qMirror: Point2D = { x: 2 * centerX - pt.x, y: 2 * centerY - pt.y };
    results.push(hMirror, vMirror, qMirror);
  } else {
    // Radial symmetry around center with N lines / rays
    const actualCount = Math.max(2, Math.min(24, Math.floor(count)));
    const dx = pt.x - centerX;
    const dy = pt.y - centerY;
    const dist = Math.hypot(dx, dy);
    const baseAngle = Math.atan2(dy, dx);
    const stepAngle = (Math.PI * 2) / actualCount;

    for (let i = 1; i < actualCount; i++) {
      const angle = baseAngle + i * stepAngle;
      results.push({
        x: Math.round((centerX + dist * Math.cos(angle)) * 100) / 100,
        y: Math.round((centerY + dist * Math.sin(angle)) * 100) / 100,
      });

      if (kaleidoscope) {
        const mirrorAngle = -baseAngle + i * stepAngle;
        results.push({
          x: Math.round((centerX + dist * Math.cos(mirrorAngle)) * 100) / 100,
          y: Math.round((centerY + dist * Math.sin(mirrorAngle)) * 100) / 100,
        });
      }
    }

    if (kaleidoscope) {
      const mirrorBase = -baseAngle;
      results.push({
        x: Math.round((centerX + dist * Math.cos(mirrorBase)) * 100) / 100,
        y: Math.round((centerY + dist * Math.sin(mirrorBase)) * 100) / 100,
      });
    }
  }

  // De-duplicate points that lie on the axis
  const uniqueMap = new Map<string, Point2D>();
  for (const p of results) {
    const key = `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, p);
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Snaps a moving point to the closest perspective guide line
 * Returns the snapped position and snapping direction info
 */
export function snapPerspectivePoint(
  currentPt: Point2D,
  anchorPt: Point2D,
  config: PerspectiveConfig,
  lockedAxis?: string,
): { point: Point2D; snapped: boolean; axisLabel?: string } {
  const vx = currentPt.x - anchorPt.x;
  const vy = currentPt.y - anchorPt.y;
  const len = Math.hypot(vx, vy);

  if (!lockedAxis && len < 3) {
    return { point: currentPt, snapped: false };
  }

  const { mode, vp1, vp2, vp3 } = config;

  // Build candidate guideline directions through anchorPt
  const candidates: Array<{ dir: Point2D; label: string }> = [];

  // Direction towards VP1
  const d1x = anchorPt.x - vp1.x;
  const d1y = anchorPt.y - vp1.y;
  const len1 = Math.hypot(d1x, d1y) || 1;
  candidates.push({ dir: { x: d1x / len1, y: d1y / len1 }, label: 'VP1' });

  if (mode === '2-point' || mode === '3-point') {
    const d2x = anchorPt.x - vp2.x;
    const d2y = anchorPt.y - vp2.y;
    const len2 = Math.hypot(d2x, d2y) || 1;
    candidates.push({ dir: { x: d2x / len2, y: d2y / len2 }, label: 'VP2' });
  }

  if (mode === '3-point') {
    const d3x = anchorPt.x - vp3.x;
    const d3y = anchorPt.y - vp3.y;
    const len3 = Math.hypot(d3x, d3y) || 1;
    candidates.push({ dir: { x: d3x / len3, y: d3y / len3 }, label: 'VP3' });
  } else {
    // 1-point and 2-point perspective maintain true vertical guidelines
    candidates.push({ dir: { x: 0, y: 1 }, label: 'Vertical' });
    if (mode === '1-point') {
      // 1-point also maintains true horizontal guidelines
      candidates.push({ dir: { x: 1, y: 0 }, label: 'Horizontal' });
    }
  }

  // Find the candidate direction with highest directional alignment (cosine)
  let bestCandidate: (typeof candidates)[number] | undefined;
  let maxAlignment = -1;
  let bestProj = 0;

  for (const c of candidates) {
    if ((lockedAxis && c.label !== lockedAxis) || (c.dir.x === 0 && c.dir.y === 0)) continue;
    const proj = vx * c.dir.x + vy * c.dir.y;
    const align = Math.abs(proj);
    if (align > maxAlignment) {
      maxAlignment = align;
      bestCandidate = c;
      bestProj = proj;
    }
  }

  // Project point onto the best guideline
  if (!bestCandidate) return { point: currentPt, snapped: false };
  const snappedX = anchorPt.x + bestProj * bestCandidate.dir.x;
  const snappedY = anchorPt.y + bestProj * bestCandidate.dir.y;

  return {
    point: { x: snappedX, y: snappedY },
    snapped: true,
    axisLabel: bestCandidate.label,
  };
}

/**
 * Snaps a moving point along a parallel guide line passing through anchorPt
 */
export function snapParallelPoint(
  currentPt: Point2D,
  anchorPt: Point2D,
  angleDeg: number
): Point2D {
  const rad = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);

  const vx = currentPt.x - anchorPt.x;
  const vy = currentPt.y - anchorPt.y;
  const proj = vx * ux + vy * uy;

  return {
    x: anchorPt.x + proj * ux,
    y: anchorPt.y + proj * uy,
  };
}

/**
 * Snaps a moving point onto a concentric circle around center
 */
export function snapConcentricPoint(
  currentPt: Point2D,
  center: Point2D,
  lockedRadius?: number | null
): { point: Point2D; radius: number } {
  const dx = currentPt.x - center.x;
  const dy = currentPt.y - center.y;
  const currentRadius = Math.hypot(dx, dy) || 1;
  const angle = Math.atan2(dy, dx);

  const targetRadius = lockedRadius != null && lockedRadius > 0 ? lockedRadius : currentRadius;

  return {
    point: {
      x: center.x + targetRadius * Math.cos(angle),
      y: center.y + targetRadius * Math.sin(angle),
    },
    radius: targetRadius,
  };
}

const GRID_LINES_PER_FAMILY = 60;

function gridTicks(min: number, max: number, origin: number, spacing: number, limit: number): number[] {
  // Keep ticks on the original grid if the canvas needs a coarser display.
  const step = spacing * Math.max(1, Math.ceil((max - min) / spacing / (limit - 1)));
  const offset = ((origin % step - min % step) % step + step) % step;
  const first = min + offset;
  const ticks: number[] = [];
  for (let i = 0; i < limit; i++) {
    const tick = first + i * step;
    if (tick > max) break;
    ticks.push(tick);
  }
  return ticks;
}

function clipGridLine(
  plane: PerspectiveGridPlane,
  start: Point2D,
  through: Point2D,
  width: number,
  height: number,
  minY: number,
  ray: boolean,
): PerspectiveGridLine | null {
  const dx = through.x - start.x;
  const dy = through.y - start.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;

  // Liang-Barsky clipping of a segment (t in [0, 1]) or a ray (t >= 0).
  let first = 0;
  let last = ray ? Infinity : 1;
  for (const [p, q] of [[-dx, start.x], [dx, width - start.x], [-dy, start.y - minY], [dy, height - start.y]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else if (p < 0) {
      first = Math.max(first, q / p);
    } else {
      last = Math.min(last, q / p);
    }
  }
  if (first >= last) return null;

  const x1 = start.x + first * dx;
  const y1 = start.y + first * dy;
  const x2 = start.x + last * dx;
  const y2 = start.y + last * dy;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return {
    plane,
    x1: Math.max(0, Math.min(width, x1)),
    y1: Math.max(minY, Math.min(height, y1)),
    x2: Math.max(0, Math.min(width, x2)),
    y2: Math.max(minY, Math.min(height, y2)),
  };
}

export function computePerspectiveGridLines(
  config: PerspectiveConfig,
  canvasWidth: number,
  canvasHeight: number,
): PerspectiveGridLine[] {
  const { grid, mode, horizonY, vp1, vp2, vp3 } = config;
  if (!grid?.enabled || canvasWidth <= 0 || canvasHeight <= 0 ||
      ![canvasWidth, canvasHeight, horizonY].every(Number.isFinite)) return [];

  const spacing = Math.max(20, Math.min(300, Number.isFinite(grid.spacing) ? grid.spacing : 80));
  const defaultY = Math.min(canvasHeight * 0.85, horizonY + Math.max(120, canvasHeight * 0.25));
  const { x = canvasWidth / 2, y = defaultY } = grid.gridOrigin ?? {};
  const origin = {
    x: Number.isFinite(x) ? x : canvasWidth / 2,
    y: Number.isFinite(y) ? y : defaultY,
  };
  const xTicks = gridTicks(0, canvasWidth, origin.x, spacing, GRID_LINES_PER_FAMILY);
  const yTicks = gridTicks(0, canvasHeight, origin.y, spacing, GRID_LINES_PER_FAMILY);
  const lines: PerspectiveGridLine[] = [];
  const groundTop = Math.max(0, horizonY);
  const addLine = (plane: PerspectiveGridPlane, start: Point2D, end: Point2D, ray = false) => {
    const line = clipGridLine(plane, start, end, canvasWidth, canvasHeight, plane === 'xz' ? groundTop : 0, ray);
    if (line) lines.push(line);
  };

  if (grid.planes.xz && groundTop < canvasHeight) {
    const originY = Math.max(groundTop, Math.min(canvasHeight, origin.y));
    const baseY = originY > groundTop ? originY : canvasHeight;
    const depthY = mode === '1-point' ? canvasHeight : baseY;
    for (const x of xTicks) {
      const tick = { x, y: depthY };
      addLine('xz', vp1, tick, true);
      if (mode !== '1-point') addLine('xz', vp2, tick, true);
    }
    if (mode === '1-point') {
      const referenceDepth = baseY - horizonY;
      const bottomDepth = canvasHeight - horizonY;
      const step = spacing / referenceDepth;
      const firstRow = Math.max(-GRID_LINES_PER_FAMILY, Math.ceil((referenceDepth / bottomDepth - 1) / step));
      let previousY = Infinity;
      for (let i = 0; i < GRID_LINES_PER_FAMILY; i++) {
        // Equal steps in reciprocal depth make the rows converge on the horizon.
        const y = horizonY + referenceDepth / (1 + (firstRow + i) * step);
        if (y < groundTop || previousY - y < 1) break;
        addLine('xz', { x: 0, y }, { x: canvasWidth, y });
        previousY = y;
      }
    }
  }

  for (const plane of ['xy', 'yz'] as const) {
    if (!grid.planes[plane]) continue;
    if (mode === '1-point' && plane === 'xy') {
      for (const y of yTicks) addLine(plane, { x: 0, y }, { x: canvasWidth, y });
    } else if (mode === '1-point') {
      const edgeTicks = gridTicks(0, canvasHeight, origin.y, spacing, GRID_LINES_PER_FAMILY / 2);
      for (const x of [0, canvasWidth]) {
        if (x === vp1.x) continue;
        for (const y of edgeTicks) addLine(plane, vp1, { x, y }, true);
      }
    } else {
      const vp = plane === 'xy' ? vp1 : vp2;
      const originX = Math.max(0, Math.min(canvasWidth, origin.x));
      const baseX = originX === vp.x ? (vp.x < canvasWidth / 2 ? canvasWidth : 0) : originX;
      for (const y of yTicks) addLine(plane, vp, { x: baseX, y }, true);
    }

    if (mode === '3-point') {
      const originY = Math.max(0, Math.min(canvasHeight, origin.y));
      const baseY = originY === vp3.y ? (vp3.y < canvasHeight / 2 ? canvasHeight : 0) : originY;
      for (const x of xTicks) addLine(plane, vp3, { x, y: baseY }, true);
    } else {
      for (const x of xTicks) addLine(plane, { x, y: 0 }, { x, y: canvasHeight });
    }
  }
  return lines;
}

export function snapRadialLinePoint(
  currentPt: Point2D,
  anchorPt: Point2D,
  config: RadialLineConfig,
): { point: Point2D; snapped: boolean; angleDeg?: number } {
  const { centerX, centerY } = config;
  const offsetX = currentPt.x - centerX;
  const offsetY = currentPt.y - centerY;
  let dx = anchorPt.x - centerX;
  let dy = anchorPt.y - centerY;
  let length = Math.hypot(dx, dy);
  if (length < 1e-3) {
    dx = offsetX;
    dy = offsetY;
    length = Math.hypot(dx, dy);
  }
  if (length < 1e-3) return { point: currentPt, snapped: false };

  const ux = dx / length;
  const uy = dy / length;
  const projection = Math.max(0, offsetX * ux + offsetY * uy);
  return {
    point: { x: centerX + projection * ux, y: centerY + projection * uy },
    snapped: true,
    angleDeg: (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360,
  };
}

export function createDefaultCurveRuler(width: number, height: number): CurveRulerConfig {
  return {
    curveType: 'bezier',
    closed: false,
    anchors: [
      {
        id: 'c1', x: width * 0.2, y: height * 0.65,
        handleIn: { x: width * 0.1, y: height * 0.65 },
        handleOut: { x: width * 0.3, y: height * 0.65 },
      },
      {
        id: 'c2', x: width * 0.5, y: height * 0.5,
        handleIn: { x: width * 0.4, y: height * 0.625 },
        handleOut: { x: width * 0.6, y: height * 0.375 },
      },
      {
        id: 'c3', x: width * 0.8, y: height * 0.35,
        handleIn: { x: width * 0.7, y: height * 0.35 },
        handleOut: { x: width * 0.9, y: height * 0.35 },
      },
    ],
  };
}

type CubicControls = readonly [Point2D, Point2D, Point2D, Point2D];

function interpolatePoint(start: Point2D, end: Point2D, t: number): Point2D {
  return { x: (1 - t) * start.x + t * end.x, y: (1 - t) * start.y + t * end.y };
}

function curveSegmentCount(config: CurveRulerConfig): number {
  const count = config.anchors.length;
  return count < 2 ? 0 : config.closed ? count : count - 1;
}

function curveSegmentControls(config: CurveRulerConfig, index: number): CubicControls {
  const { anchors, closed, curveType } = config;
  const start = anchors[index];
  const end = anchors[(index + 1) % anchors.length];
  if (curveType === 'quadratic') {
    const control = start.handleOut ?? end.handleIn ?? interpolatePoint(start, end, 0.5);
    return [start, interpolatePoint(start, control, 2 / 3), interpolatePoint(end, control, 2 / 3), end];
  }
  if (curveType === 'spline') {
    const previous = anchors[index - 1] ?? (closed ? anchors[anchors.length - 1] : start);
    const following = anchors[index + 2] ?? (closed ? anchors[(index + 2) % anchors.length] : end);
    // Express the uniform Catmull-Rom tangents as cubic Bézier controls.
    return [
      start,
      { x: start.x + (end.x - previous.x) / 6, y: start.y + (end.y - previous.y) / 6 },
      { x: end.x - (following.x - start.x) / 6, y: end.y - (following.y - start.y) / 6 },
      end,
    ];
  }
  return [
    start,
    start.handleOut ?? interpolatePoint(start, end, 1 / 3),
    end.handleIn ?? interpolatePoint(start, end, 2 / 3),
    end,
  ];
}

function evaluateCubic([start, first, second, end]: CubicControls, t: number): Point2D {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * start.x + b * first.x + c * second.x + d * end.x,
    y: a * start.y + b * first.y + c * second.y + d * end.y,
  };
}

export function evaluateCurveSegment(config: CurveRulerConfig, segmentIndex: number, t: number): Point2D {
  const count = curveSegmentCount(config);
  if (count === 0) {
    const point = config.anchors[0];
    return point ? { x: point.x, y: point.y } : { x: 0, y: 0 };
  }
  const index = Math.max(0, Math.min(count - 1, Math.trunc(segmentIndex)));
  return evaluateCubic(curveSegmentControls(config, index), Math.max(0, Math.min(1, t)));
}

function curveSampleCount(config: CurveRulerConfig, requested?: number): number {
  const samples = Math.floor(requested ?? config.snapSamplesPerSegment ?? 32);
  return Number.isSafeInteger(samples) ? Math.max(1, samples) : 32;
}

export function sampleCurveRulerPoints(config: CurveRulerConfig, samplesPerSegment?: number): Point2D[] {
  const first = config.anchors[0];
  if (!first) return [];
  const points: Point2D[] = [{ x: first.x, y: first.y }];
  const samples = curveSampleCount(config, samplesPerSegment);
  const segments = curveSegmentCount(config);
  for (let index = 0; index < segments; index++) {
    const controls = curveSegmentControls(config, index);
    for (let step = 1; step <= samples; step++) {
      points.push(evaluateCubic(controls, step / samples));
    }
  }
  return points;
}

function distanceDerivativeCoefficients(controls: CubicControls, query: Point2D): number[] {
  // The squared-distance derivative is proportional to (curve - query) dot curve'.
  // Multiplying the cubic and quadratic Bernstein bases gives a degree-five polynomial.
  const cubicWeights = [1, 3, 3, 1];
  const quadraticWeights = [1, 2, 1];
  const productWeights = [1, 5, 10, 10, 5, 1];
  const coefficients = productWeights.map(() => 0);
  for (let i = 0; i < controls.length; i++) {
    const offsetX = controls[i].x - query.x;
    const offsetY = controls[i].y - query.y;
    for (let j = 0; j < quadraticWeights.length; j++) {
      const dx = controls[j + 1].x - controls[j].x;
      const dy = controls[j + 1].y - controls[j].y;
      coefficients[i + j] += (offsetX * dx + offsetY * dy) *
        cubicWeights[i] * quadraticWeights[j] / productWeights[i + j];
    }
  }
  return coefficients;
}

function splitBernsteinCoefficients(coefficients: readonly number[]): [number[], number[]] {
  const row = [...coefficients];
  const left = [row[0]];
  const right = [row[row.length - 1]];
  for (let last = row.length - 1; last > 0; last--) {
    for (let i = 0; i < last; i++) row[i] = (row[i] + row[i + 1]) / 2;
    left.push(row[0]);
    right.push(row[last - 1]);
  }
  return [left, right.reverse()];
}

function curveMinimumIntervals(
  coefficients: number[],
  speedLimit: number,
  distanceAt: (t: number) => number,
): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  if (!coefficients.every(Number.isFinite)) return intervals;
  const visit = (values: number[], low: number, high: number, depth: number) => {
    const signs = values.filter((value) => value !== 0).map(Math.sign);
    const changes = signs.reduce((count, sign, index) => count + Number(index > 0 && sign !== signs[index - 1]), 0);
    if (changes === 0) return;
    if (changes === 1 && signs[0] > 0) return; // A single positive-to-negative root is a maximum.
    if (changes === 1 || (high - low) * speedLimit <= 0.02 || depth >= 40) {
      intervals.push([low, high]);
      return;
    }
    // Subdivide where multiple stationary points can lie between two samples.
    const [left, right] = splitBernsteinCoefficients(values);
    const middle = (low + high) / 2;
    distanceAt(middle);
    visit(left, low, middle, depth + 1);
    visit(right, middle, high, depth + 1);
  };
  visit(coefficients, 0, 1, 0);
  return intervals;
}

export function snapCurveRulerPoint(
  currentPt: Point2D,
  config: CurveRulerConfig,
  opts?: { samplesPerSegment?: number },
): { point: Point2D; snapped: boolean; segmentIndex: number; t: number; distance: number } {
  let best = { point: currentPt, snapped: false, segmentIndex: -1, t: 0, distance: Infinity };
  const segments = curveSegmentCount(config);
  const samples = Math.max(2, curveSampleCount(config, opts?.samplesPerSegment));
  const goldenRatio = (Math.sqrt(5) - 1) / 2;

  for (let index = 0; index < segments; index++) {
    const controls = curveSegmentControls(config, index);
    const distanceAt = (t: number): number => {
      const point = evaluateCubic(controls, t);
      const distance = Math.hypot(point.x - currentPt.x, point.y - currentPt.y);
      if (distance < best.distance) best = { point, snapped: true, segmentIndex: index, t, distance };
      return distance;
    };
    const distances = Array.from({ length: samples + 1 }, (_, step) => distanceAt(step / samples));
    // The derivative is bounded by three times the longest control polygon edge.
    const speedLimit = 3 * Math.max(...controls.slice(1).map((point, edge) =>
      Math.hypot(point.x - controls[edge].x, point.y - controls[edge].y)));
    const coefficients = distanceDerivativeCoefficients(controls, currentPt);

    for (let [low, high] of curveMinimumIntervals(coefficients, speedLimit, distanceAt)) {
      let nearestStep = -1;
      let nearestDistance = Infinity;
      for (let step = Math.ceil(low * samples); step <= Math.floor(high * samples); step++) {
        if (distances[step] < nearestDistance) {
          nearestStep = step;
          nearestDistance = distances[step];
        }
      }
      if (nearestStep >= 0) {
        low = Math.max(low, (nearestStep - 1) / samples);
        high = Math.min(high, (nearestStep + 1) / samples);
      }
      let left = high - goldenRatio * (high - low);
      let right = low + goldenRatio * (high - low);
      let leftDistance = distanceAt(left);
      let rightDistance = distanceAt(right);
      // Continue past eight iterations when a long segment needs subpixel refinement.
      for (let iteration = 0; iteration < 40 && (iteration < 8 || (high - low) * speedLimit > 0.02); iteration++) {
        if (leftDistance <= rightDistance) {
          high = right;
          right = left;
          rightDistance = leftDistance;
          left = high - goldenRatio * (high - low);
          leftDistance = distanceAt(left);
        } else {
          low = left;
          left = right;
          leftDistance = rightDistance;
          right = low + goldenRatio * (high - low);
          rightDistance = distanceAt(right);
        }
      }
    }
  }
  return best;
}
