export type QuickShapeKind = 'line' | 'arc' | 'circle' | 'ellipse' | 'rectangle' | 'quadrilateral' | 'triangle';

export interface QuickShapePoint {
  x: number;
  y: number;
  pressure?: number;
}

type Point = Pick<QuickShapePoint, 'x' | 'y'>;
type Triangle = [Point, Point, Point];
type Quad = [Point, Point, Point, Point];

export type QuickShapeCandidate = { score: number } & (
  | { kind: 'line'; start: Point; end: Point; length: number }
  | { kind: 'arc'; start: Point; end: Point; center: Point; radius: number; startAngle: number; endAngle: number; anticlockwise: boolean; sweep: number }
  | { kind: 'circle'; center: Point; radius: number; rotation: number }
  | { kind: 'ellipse'; center: Point; rx: number; ry: number; rotation: number }
  | { kind: 'rectangle'; center: Point; width: number; height: number; rotation: number; corners: Quad }
  | { kind: 'quadrilateral'; corners: Quad }
  | { kind: 'triangle'; corners: Triangle }
);

const TAU = 2 * Math.PI;
const FIT_INTERVALS = 96;
const MIN_DIMENSION = 2;
const MAX_SAMPLES = 65536;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const direction = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);
const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const polar = (center: Point, radius: number, angle: number): Point => ({
  x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle),
});
const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});
const rotate = (point: Point, angle: number): Point => ({
  x: point.x * Math.cos(angle) - point.y * Math.sin(angle),
  y: point.x * Math.sin(angle) + point.y * Math.cos(angle),
});
const finitePoint = (point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y);
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const angleStep = Math.PI / 12;
const snapAngle = (angle: number, snap: boolean) => snap ? Math.round(angle / angleStep) * angleStep : angle;
const quality = (error: number) => clamp(1 - 10 * error, 0, 1);

function meanPoint(points: readonly Point[]): Point {
  const sum = points.reduce((total, p) => ({ x: total.x + p.x, y: total.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function cumulativeLengths(points: readonly Point[]): number[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + distance(points[i - 1], points[i]));
  return lengths;
}

function resample(points: readonly Point[], lengths: readonly number[], intervals: number): Point[] {
  const total = lengths[lengths.length - 1];
  let right = 1;
  return Array.from({ length: intervals + 1 }, (_, i) => {
    if (i === 0) return points[0];
    if (i === intervals) return points[points.length - 1];
    const offset = total * (i / intervals);
    while (lengths[right] < offset) right++;
    const len = lengths[right] - lengths[right - 1];
    return lerp(points[right - 1], points[right], len > 0 ? (offset - lengths[right - 1]) / len : 0);
  });
}

function pointToSegment(point: Point, a: Point, b: Point): number {
  const edge = subtract(b, a);
  const lengthSquared = dot(edge, edge);
  if (!lengthSquared) return distance(point, a);
  return distance(point, lerp(a, b, clamp(dot(subtract(point, a), edge) / lengthSquared, 0, 1)));
}

function errors(points: readonly Point[], errorAt: (point: Point) => number) {
  let sum = 0;
  let squares = 0;
  let max = 0;
  for (const point of points) {
    const error = errorAt(point);
    sum += error;
    squares += error * error;
    max = Math.max(max, error);
  }
  const rms = Math.sqrt(squares / points.length);
  return { rms, max, combined: (sum / points.length + rms) / 2 };
}

// The fit runs in bounding-box-normalized coordinates. Pivoting rejects singular traces.
function leastSquares(points: readonly Point[], terms: (p: Point) => number[], target: (p: Point) => number) {
  const count = terms(points[0]).length;
  const rows = Array.from({ length: count }, () => new Array<number>(count + 1).fill(0));
  for (const p of points) {
    const vector = terms(p);
    const value = target(p);
    for (let j = 0; j < count; j++) {
      for (let k = 0; k < count; k++) rows[j][k] += vector[j] * vector[k];
      rows[j][count] += vector[j] * value;
    }
  }
  for (let j = 0; j < count; j++) {
    let pivot = j;
    for (let k = j + 1; k < count; k++) {
      if (Math.abs(rows[k][j]) > Math.abs(rows[pivot][j])) pivot = k;
    }
    if (Math.abs(rows[pivot][j]) < 1e-9) return null;
    [rows[j], rows[pivot]] = [rows[pivot], rows[j]];
    const divisor = rows[j][j];
    for (let k = j; k <= count; k++) rows[j][k] /= divisor;
    for (let i = 0; i < count; i++) {
      if (i === j) continue;
      const factor = rows[i][j];
      for (let k = j; k <= count; k++) rows[i][k] -= factor * rows[j][k];
    }
  }
  const result = rows.map(row => row[count]);
  return result.every(Number.isFinite) ? result : null;
}

function fitCircle(points: readonly Point[]) {
  const fit = leastSquares(points, p => [p.x, p.y, 1], p => dot(p, p));
  if (!fit) return null;
  const [x, y, offset] = fit;
  const center = { x: x / 2, y: y / 2 };
  const radius = Math.sqrt(dot(center, center) + offset);
  return radius > 0 && Number.isFinite(radius) ? { center, radius } : null;
}

function angularTravel(points: readonly Point[], center: Point) {
  let net = 0;
  let absolute = 0;
  for (let i = 1; i < points.length; i++) {
    const from = subtract(points[i - 1], center);
    const to = subtract(points[i], center);
    const delta = Math.atan2(cross(from, to), dot(from, to));
    net += delta;
    absolute += Math.abs(delta);
  }
  return { net, reversal: (absolute - Math.abs(net)) / 2 };
}

function wrapsOnce(points: readonly Point[], center: Point): boolean {
  const { net, reversal } = angularTravel([...points, points[0]], center);
  return Math.abs(Math.abs(net) - TAU) < 0.01 && reversal < 0.55;
}

function recognizeOpen(points: readonly Point[], pathLength: number): QuickShapeCandidate | null {
  const start = points[0];
  const end = points[points.length - 1];
  const length = distance(start, end);
  const straight = errors(points, p => pointToSegment(p, start, end));
  if (length / pathLength >= 0.73 && straight.max < length * 0.065 && straight.rms < length * 0.032) {
    const axis = subtract(end, start);
    let reversal = 0;
    for (let i = 1; i < points.length; i++) {
      reversal -= Math.min(0, dot(subtract(points[i], points[i - 1]), axis));
    }
    if (reversal < length * length * 0.042) return { kind: 'line', start, end, length, score: quality(straight.combined) };
  }

  const circle = fitCircle(points);
  if (!circle) return null;
  const { center, radius } = circle;
  const radial = errors(points, p => Math.abs(distance(p, center) - radius));
  const { net, reversal } = angularTravel(points, center);
  const sweep = Math.abs(net);
  const sagitta = 2 * radius * Math.sin(sweep / 4) ** 2;
  if (sweep < 29 * Math.PI / 180 || sweep > 326 * Math.PI / 180 || reversal > sweep * 0.09 ||
    sagitta < length * 0.062 || radial.rms > Math.min(0.024, sagitta * 0.19) || radial.max > 0.065) return null;
  const startAngle = direction(center, start);
  const endAngle = startAngle + net;
  return {
    kind: 'arc', center, radius, startAngle, endAngle, anticlockwise: net < 0, sweep,
    start: polar(center, radius, startAngle), end: polar(center, radius, endAngle), score: quality(radial.combined),
  };
}

function fitEllipse(points: readonly Point[]) {
  const fit = leastSquares(points, p => [p.x * p.x, 2 * p.x * p.y, p.y * p.y, 2 * p.x, 2 * p.y], () => 1);
  if (!fit) return null;
  const [a, b, c, d, e] = fit;
  const determinant = a * c - b * b;
  if (determinant <= 0 || a <= 0) return null;
  const center = { x: (b * e - c * d) / determinant, y: (b * d - a * e) / determinant };
  const level = 1 - d * center.x - e * center.y;
  const split = Math.hypot(a - c, 2 * b);
  const rx = Math.sqrt(level / ((a + c - split) / 2));
  const ry = Math.sqrt(level / ((a + c + split) / 2));
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx > 0.8 || ry < 0.018) return null;
  return { center, rx, ry, rotation: Math.atan2(2 * b, a - c) / 2 + Math.PI / 2 };
}

function recognizeOval(points: readonly Point[]): QuickShapeCandidate | null {
  const ellipse = fitEllipse(points);
  if (!ellipse || !wrapsOnce(points, ellipse.center)) return null;
  const { center, rx, ry, rotation } = ellipse;
  if (ry / rx >= 0.86) {
    const circle = fitCircle(points);
    if (circle) {
      const radial = errors(points, p => Math.abs(distance(p, circle.center) - circle.radius));
      if (radial.rms < 0.024 && radial.max < 0.059) {
        return { kind: 'circle', ...circle, rotation: direction(circle.center, points[0]), score: quality(radial.combined) };
      }
    }
    return null;
  }

  // Distance in pixels to a dense polyline of the ellipse, so this can compete with polygon fits.
  const perimeter = Array.from({ length: FIT_INTERVALS }, (_, i) => ellipsePoint(ellipse, i * TAU / FIT_INTERVALS));
  const error = polygonErrors(points, perimeter);
  return error.rms < 0.024 && error.max < 0.065
    ? { kind: 'ellipse', ...ellipse, score: quality(error.combined) } : null;
}

function polygonErrors(points: readonly Point[], corners: readonly Point[]) {
  return errors(points, p => {
    let min = Infinity;
    for (let i = 0; i < corners.length; i++) {
      min = Math.min(min, pointToSegment(p, corners[i], corners[(i + 1) % corners.length]));
    }
    return min;
  });
}

function fitEdge(points: readonly Point[]) {
  const center = meanPoint(points);
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const p of points) {
    const { x, y } = subtract(p, center);
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  return { center, axis: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function fitPolygonCorners(points: readonly Point[], indices: readonly number[]) {
  const sides = indices.map((from, i) => {
    const to = indices[i + 1] ?? points.length + indices[0];
    const trim = Math.floor((to - from) * 0.13);
    const samples = [];
    for (let j = from + trim; j <= to - trim; j++) samples.push(points[j % points.length]);
    return fitEdge(samples);
  });
  const corners = indices.map((index, i) => {
    const a = sides[(i + sides.length - 1) % sides.length];
    const b = sides[i];
    const determinant = cross(a.axis, b.axis);
    if (Math.abs(determinant) < 0.16) return points[index];
    const shift = cross(subtract(b.center, a.center), b.axis) / determinant;
    const corner = { x: a.center.x + shift * a.axis.x, y: a.center.y + shift * a.axis.y };
    return distance(corner, points[index]) < 0.12 ? corner : points[index];
  });
  const edges = corners.map((p, i) => subtract(corners[(i + 1) % corners.length], p));
  const lengths = edges.map(edge => Math.hypot(edge.x, edge.y));
  if (lengths.some(length => length < 0.065)) return null;
  const turns = edges.map((edge, i) => {
    const next = (i + 1) % edges.length;
    return cross(edge, edges[next]) / (lengths[i] * lengths[next]);
  });
  const minTurn = corners.length === 4 ? 0.22 : 0.12;
  if (turns.some(turn => Math.abs(turn) < minTurn)) return null;
  const positive = turns.filter(turn => turn > 0).length;
  if (positive === 0 || positive === corners.length) return { corners, inside: meanPoint(corners) };
  if (corners.length !== 4 || positive === 2) return null;
  const reflex = (turns.findIndex(turn => (turn > 0) === (positive === 1)) + 1) % 4;
  // The diagonal from a reflex vertex to its opposite lies inside both halves.
  return { corners, inside: lerp(corners[reflex], corners[(reflex + 2) % 4], 0.5) };
}

function fitRectangle(points: readonly Point[], corners: Quad, polygonError: number): QuickShapeCandidate | null {
  const edges = corners.map((p, i) => subtract(corners[(i + 1) % 4], p));
  const lengths = edges.map(edge => Math.hypot(edge.x, edge.y));
  if (edges.some((edge, i) => {
    const next = (i + 1) % 4;
    return Math.abs(dot(edge, edges[next])) / (lengths[i] * lengths[next]) > 0.24;
  })) return null;
  if ([0, 1].some(i => Math.abs(cross(edges[i], edges[i + 2])) / (lengths[i] * lengths[i + 2]) > 0.27)) return null;
  // Average all four edge directions after rotating each into the first edge's frame.
  const sign = Math.sign(cross(edges[0], edges[1]));
  const rotation = direction({ x: 0, y: 0 }, meanPoint(edges.map((edge, i) => rotate(edge, -sign * i * Math.PI / 2))));
  const aligned = corners.map(p => rotate(p, -rotation));
  const axes = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  for (let i = 0; i < 4; i++) {
    axes[i === 0 || i === 3 ? 0 : 1].x += aligned[i].x / 2;
    axes[i < 2 ? 0 : 1].y += aligned[i].y / 2;
  }
  const width = Math.abs(axes[1].x - axes[0].x);
  const height = Math.abs(axes[1].y - axes[0].y);
  const rect: Quad = [
    rotate(axes[0], rotation),
    rotate({ x: axes[1].x, y: axes[0].y }, rotation),
    rotate(axes[1], rotation),
    rotate({ x: axes[0].x, y: axes[1].y }, rotation),
  ];
  if (Math.min(width, height) < 0.065 ||
    rect.some((p, i) => distance(p, corners[i]) > Math.min(width, height) * 0.18 + 0.006)) return null;
  const error = polygonErrors(points, rect).combined;
  return error <= polygonError + 0.0075
    ? { kind: 'rectangle', center: meanPoint(rect), width, height, rotation, corners: rect, score: quality(error) }
    : null;
}

function recognizePolygon(loop: readonly Point[], trace: readonly Point[]): QuickShapeCandidate | null {
  const evaluate = (indices: readonly number[]): QuickShapeCandidate | null => {
    const fit = fitPolygonCorners(loop, indices);
    if (!fit || !wrapsOnce(trace, fit.inside)) return null;
    const { corners } = fit;
    const error = polygonErrors(trace, corners);
    if (error.rms >= 0.032 || error.max >= 0.082) return null;
    const score = quality(error.combined);
    return corners.length === 3
      ? { kind: 'triangle', corners: corners as Triangle, score }
      : fitRectangle(trace, corners as Quad, error.combined) ??
        { kind: 'quadrilateral', corners: corners as Quad, score };
  };
  const indices = loop.map((_, i) => i);
  while (indices.length > 4) {
    let remove = 0;
    let least = Infinity;
    for (let i = 0; i < indices.length; i++) {
      const a = loop[indices[(i + indices.length - 1) % indices.length]];
      const b = loop[indices[i]];
      const c = loop[indices[(i + 1) % indices.length]];
      const cost = pointToSegment(b, a, c) * distance(a, c);
      if (cost < least) {
        least = cost;
        remove = i;
      }
    }
    indices.splice(remove, 1);
  }
  // A closure gap or noisy corner can bias vertex pruning. Try turns measured over
  // several samples as a second set of seeds, then score the same fitted sides.
  const count = loop.length;
  const turns = loop.map((point, i) => {
    const a = subtract(point, loop[(i + count - 5) % count]);
    const b = subtract(loop[(i + 5) % count], point);
    return { index: i, turn: Math.abs(Math.atan2(cross(a, b), dot(a, b))) };
  }).sort((a, b) => b.turn - a.turn);
  const peaks: number[] = [];
  for (const { index } of turns) {
    if (peaks.every(p => Math.min(Math.abs(p - index), count - Math.abs(p - index)) > 6)) peaks.push(index);
    if (peaks.length === 4) break;
  }
  const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);
  const best = (candidates: Array<QuickShapeCandidate | null>) =>
    candidates.reduce<QuickShapeCandidate | null>((a, b) => b && (!a || b.score > a.score) ? b : a, null);
  const quad = best([evaluate(indices), evaluate(sorted(peaks))]);
  const triangle = best([
    ...indices.map((_, i) => evaluate(indices.filter((_, j) => i !== j))),
    evaluate(sorted(peaks.slice(0, 3))),
  ]);
  return triangle && (!quad || triangle.score >= quad.score - 0.025) ? triangle : quad;
}

export function recognizeQuickShape(points: ReadonlyArray<QuickShapePoint>): QuickShapeCandidate | null {
  if (points.length < 5 || !points.every(finitePoint)) return null;
  const lengths = cumulativeLengths(points);
  const length = lengths[lengths.length - 1];
  if (!Number.isFinite(length) || length < 24) return null;
  const samples = resample(points, lengths, FIT_INTERVALS);
  const xs = samples.map(p => p.x);
  const ys = samples.map(p => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  const diagonal = Math.hypot(width, height);
  if (!Number.isFinite(diagonal) || diagonal < 4) return null;
  const origin = { x: minX + width / 2, y: minY + height / 2 };
  const normalized = samples.map(p => ({ x: (p.x - origin.x) / diagonal, y: (p.y - origin.y) / diagonal }));
  const start = normalized[0];
  // Near the end, a short overshoot may pass the start and continue onto the first edge.
  let closingIndex = normalized.length - 1;
  let gap = distance(start, normalized[closingIndex]);
  const pathLength = length / diagonal;
  for (let i = Math.ceil(FIT_INTERVALS * 0.82); i < normalized.length - 1; i++) {
    const candidateGap = distance(start, normalized[i]);
    if (candidateGap < 0.065 && candidateGap < gap * 0.8) {
      gap = candidateGap;
      closingIndex = i;
    }
  }
  let shape: QuickShapeCandidate | null;
  if (gap <= Math.min(0.22, pathLength * 0.10)) {
    const trace = normalized.slice(0, closingIndex + 1);
    const closed = [...trace, start];
    const loop = resample(closed, cumulativeLengths(closed), FIT_INTERVALS).slice(0, -1);
    const polygon = recognizePolygon(loop, trace);
    const oval = recognizeOval(trace);
    shape = polygon && (!oval || polygon.score >= oval.score + 0.025) ? polygon : oval;
  } else {
    shape = recognizeOpen(normalized, pathLength);
  }
  if (!shape) return null;
  const toCanvas = (p: Point): Point => ({ x: origin.x + p.x * diagonal, y: origin.y + p.y * diagonal });
  switch (shape.kind) {
    case 'line':
      return { ...shape, start: toCanvas(shape.start), end: toCanvas(shape.end), length: shape.length * diagonal };
    case 'arc':
      return { ...shape, start: toCanvas(shape.start), end: toCanvas(shape.end), center: toCanvas(shape.center), radius: shape.radius * diagonal };
    case 'circle':
      return { ...shape, center: toCanvas(shape.center), radius: shape.radius * diagonal };
    case 'ellipse':
      return { ...shape, center: toCanvas(shape.center), rx: shape.rx * diagonal, ry: shape.ry * diagonal };
    case 'rectangle':
      return { ...shape, center: toCanvas(shape.center), width: shape.width * diagonal, height: shape.height * diagonal, corners: shape.corners.map(toCanvas) as Quad };
    case 'quadrilateral':
    case 'triangle':
      return { ...shape, corners: shape.corners.map(toCanvas) } as typeof shape;
  }
}

function polygonCentroid(corners: readonly Point[]): Point {
  const origin = corners[0];
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 1; i < corners.length - 1; i++) {
    const a = subtract(corners[i], origin);
    const b = subtract(corners[i + 1], origin);
    const weight = cross(a, b);
    area += weight;
    x += (a.x + b.x) * weight;
    y += (a.y + b.y) * weight;
  }
  return area ? { x: origin.x + x / (3 * area), y: origin.y + y / (3 * area) } : meanPoint(corners);
}

export function adjustQuickShapeByPointer(
  initial: QuickShapeCandidate, anchor: Point, pointer: Point, snapAngle15 = false,
): QuickShapeCandidate {
  if (!finitePoint(pointer) || !finitePoint(anchor)) return initial;
  if (initial.kind === 'line' || initial.kind === 'arc') {
    const { start } = initial;
    const dragLength = distance(start, pointer);
    if (!Number.isFinite(dragLength) || dragLength > Number.MAX_SAFE_INTEGER) return initial;
    const oldAngle = direction(start, initial.end);
    const angle = snapAngle(dragLength > 0 ? direction(start, pointer) : oldAngle, snapAngle15);
    if (initial.kind === 'line') {
      const length = Math.max(MIN_DIMENSION, dragLength);
      return { ...initial, length, end: polar(start, length, angle) };
    }
    const chord = distance(start, initial.end);
    if (!chord || !initial.radius) return initial;
    const length = Math.max(MIN_DIMENSION, MIN_DIMENSION * chord / initial.radius, dragLength);
    const scale = length / chord;
    const turn = angle - oldAngle;
    const offset = rotate(subtract(initial.center, start), turn);
    const center = { x: start.x + offset.x * scale, y: start.y + offset.y * scale };
    const radius = initial.radius * scale;
    if (!finitePoint(center) || !Number.isFinite(radius)) return initial;
    return {
      ...initial, center, radius, end: polar(start, length, angle),
      startAngle: initial.startAngle + turn, endAngle: initial.endAngle + turn,
    };
  }

  const center = 'center' in initial ? initial.center : polygonCentroid(initial.corners);
  const before = distance(center, anchor);
  const after = distance(center, pointer);
  if (!Number.isFinite(before) || !Number.isFinite(after) || after > Number.MAX_SAFE_INTEGER) return initial;
  if (initial.kind === 'circle') {
    const rotation = snapAngle(after ? direction(center, pointer) : initial.rotation, snapAngle15);
    return { ...initial, radius: Math.max(MIN_DIMENSION, after), rotation };
  }
  const minDimension = initial.kind === 'ellipse' ? Math.min(initial.rx, initial.ry)
    : Math.min(...initial.corners.map((p, i, corners) => distance(p, corners[(i + 1) % corners.length])));
  if (!minDimension) return initial;
  const baseline = before >= 1 ? before : initial.kind === 'ellipse' ? initial.rx : Math.max(...initial.corners.map(p => distance(center, p)));
  const scale = Math.max(MIN_DIMENSION / minDimension, after / baseline);
  const originalAngle = 'rotation' in initial ? initial.rotation : direction(center, initial.corners[0]);
  const turn = before >= 1 && after ? wrapAngle(direction(center, pointer) - direction(center, anchor)) : 0;
  const rotation = snapAngle(originalAngle + turn, snapAngle15);
  if (initial.kind === 'ellipse') {
    const rx = initial.rx * scale;
    const ry = initial.ry * scale;
    return Number.isFinite(rx) && Number.isFinite(ry) ? { ...initial, rx, ry, rotation } : initial;
  }
  const corners = initial.corners.map(p => {
    const offset = rotate(subtract(p, center), rotation - originalAngle);
    return { x: center.x + offset.x * scale, y: center.y + offset.y * scale };
  });
  if (!corners.every(finitePoint)) return initial;
  if (initial.kind === 'rectangle') {
    return { ...initial, corners: corners as Quad, rotation, width: initial.width * scale, height: initial.height * scale };
  }
  return { ...initial, corners } as typeof initial;
}

function ellipsePoint(shape: { center: Point; rx: number; ry: number; rotation: number }, angle: number): Point {
  const offset = rotate({ x: shape.rx * Math.cos(angle), y: shape.ry * Math.sin(angle) }, shape.rotation);
  return { x: shape.center.x + offset.x, y: shape.center.y + offset.y };
}

export function sampleQuickShapePoints(
  shape: QuickShapeCandidate, spacingPx: number, pressure = 0.7,
): Array<{ x: number; y: number; pressure: number }> {
  const spacing = Number.isFinite(spacingPx) ? Math.max(1, spacingPx) : 1;
  const steps = (length: number) => clamp(Math.ceil(length / spacing), 1, MAX_SAMPLES);
  let points: Point[];
  if (shape.kind === 'line') {
    const count = steps(shape.length);
    points = Array.from({ length: count + 1 }, (_, i) => lerp(shape.start, shape.end, i / count));
  } else if (shape.kind === 'circle' || shape.kind === 'arc') {
    const sweep = shape.kind === 'circle' ? TAU : shape.anticlockwise ? -shape.sweep : shape.sweep;
    const angle = shape.kind === 'circle' ? shape.rotation : shape.startAngle;
    const count = Math.max(shape.kind === 'circle' ? 4 : 1, steps(shape.radius * Math.abs(sweep)));
    points = Array.from({ length: count + 1 }, (_, i) => polar(shape.center, shape.radius, angle + sweep * (i / count)));
    points[count] = shape.kind === 'circle' ? points[0] : shape.end;
    if (shape.kind === 'arc') points[0] = shape.start;
  } else if (shape.kind === 'ellipse') {
    const estimate = Math.PI * (3 * (shape.rx + shape.ry) - Math.sqrt((3 * shape.rx + shape.ry) * (shape.rx + 3 * shape.ry)));
    const divisions = clamp(steps(estimate) * 2, FIT_INTERVALS, MAX_SAMPLES);
    const path = Array.from({ length: divisions }, (_, i) => ellipsePoint(shape, i * TAU / divisions));
    path.push(path[0]);
    const lengths = cumulativeLengths(path);
    points = resample(path, lengths, Math.max(4, steps(lengths[lengths.length - 1])));
  } else {
    points = [];
    shape.corners.forEach((start, i, corners) => {
      const end = corners[(i + 1) % corners.length];
      const count = steps(distance(start, end));
      for (let j = 0; j < count; j++) points.push(lerp(start, end, j / count));
    });
    points.push(points[0]);
  }
  const p = Number.isFinite(pressure) ? clamp(pressure, 0, 1) : 0.7;
  return points.map(({ x, y }) => ({ x, y, pressure: p }));
}

export function buildQuickShapeDabs(
  points: ReadonlyArray<{ x: number; y: number; pressure: number }>, size: number, alpha: number, angleRad?: number,
): Float32Array {
  const dabs = new Float32Array(points.length * 7);
  const last = points.length - 1;
  const closed = last > 1 && distance(points[0], points[last]) === 0;
  points.forEach((p, i) => {
    const prev = points[i - 1] ?? points[closed ? last - 1 : i];
    const next = points[i + 1] ?? points[closed ? 1 : i];
    dabs.set([p.x, p.y, size, p.pressure, alpha, angleRad ?? direction(prev, next), 0], i * 7);
  });
  return dabs;
}
