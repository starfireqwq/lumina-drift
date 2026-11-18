import {
  VectorAnchor,
  VectorBoundingBox,
  VectorStroke,
} from './vector-types';
import { Point2D } from '../ruler/ruler-math';

/**
 * Computes Axis-Aligned Bounding Box for vector anchors
 */
export function computeStrokeBounds(anchors: VectorAnchor[], padding: number = 10): VectorBoundingBox {
  if (anchors.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const a of anchors) {
    const r = (a.width || padding) / 2 + 2;
    minX = Math.min(minX, a.x - r, (a.cp1x ?? a.x) - r, (a.cp2x ?? a.x) - r);
    minY = Math.min(minY, a.y - r, (a.cp1y ?? a.y) - r, (a.cp2y ?? a.y) - r);
    maxX = Math.max(maxX, a.x + r, (a.cp1x ?? a.x) + r, (a.cp2x ?? a.x) + r);
    maxY = Math.max(maxY, a.y + r, (a.cp1y ?? a.y) + r, (a.cp2y ?? a.y) + r);
  }

  return {
    minX: Math.floor(minX),
    minY: Math.floor(minY),
    maxX: Math.ceil(maxX),
    maxY: Math.ceil(maxY),
  };
}

/**
 * Ramer–Douglas–Peucker over (x, y, stroke width): a point survives if dropping it would move
 * the line, or change its thickness, by more than epsilon. Width is a dimension so that pressure
 * swells on a straight run are kept as well as bends.
 */
function simplifyStrokePoints(
  pts: Array<{ x: number; y: number; pressure: number }>,
  baseWidth: number,
  epsilon: number
): number[] {
  if (pts.length <= 2) return pts.map((_, i) => i);

  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];

  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const ax = pts[a].x;
    const ay = pts[a].y;
    const az = pts[a].pressure * baseWidth;
    const dx = pts[b].x - ax;
    const dy = pts[b].y - ay;
    const dz = pts[b].pressure * baseWidth - az;
    const lenSq = dx * dx + dy * dy + dz * dz;

    let worst = -1;
    let worstDistSq = epsilon * epsilon;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i].x - ax;
      const py = pts[i].y - ay;
      const pz = pts[i].pressure * baseWidth - az;
      // Closest point on the chord a→b (clamped, so closed loops with a == b still work)
      const t = lenSq > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / lenSq)) : 0;
      const ex = px - t * dx;
      const ey = py - t * dy;
      const ez = pz - t * dz;
      const distSq = ex * ex + ey * ey + ez * ez;
      if (distSq > worstDistSq) {
        worstDistSq = distSq;
        worst = i;
      }
    }

    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i] === 1) indices.push(i);
  }
  return indices;
}

/**
 * Fits raw pointer/pen points into smooth Cubic Bézier anchors
 */
export function fitPointsToBezier(
  points: Array<{ x: number; y: number; pressure?: number }>,
  baseWidth: number = 4
): VectorAnchor[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    const p = points[0];
    const pres = p.pressure ?? 0.5;
    return [
      {
        x: p.x,
        y: p.y,
        pressure: pres,
        width: Math.max(1, baseWidth * pres),
      },
    ];
  }

  // 1. Simplify points that are too close (< 2.5px) to reduce jitter
  const filtered: Array<{ x: number; y: number; pressure: number }> = [
    { x: points[0].x, y: points[0].y, pressure: points[0].pressure ?? 0.5 },
  ];

  for (let i = 1; i < points.length; i++) {
    const prev = filtered[filtered.length - 1];
    const curr = points[i];
    const distSq = (curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2;
    if (distSq >= 6.0 || i === points.length - 1) {
      filtered.push({
        x: curr.x,
        y: curr.y,
        pressure: curr.pressure ?? 0.5,
      });
    }
  }

  // 2. Keep only the points that carry shape: one anchor every 2.5px (what step 1 alone leaves)
  // is hundreds of anchors per stroke, unusable for editing and heavy to sync.
  // shortcut: RDP + neighbour tangents, not a least-squares curve fit; switch to Schneider
  // fitting (as Krita's freehand path does) if strokes need fewer anchors at the same accuracy.
  const epsilon = Math.min(2.5, Math.max(0.75, baseWidth * 0.1));
  const kept = simplifyStrokePoints(filtered, baseWidth, epsilon);

  const n = kept.length;
  const last = filtered.length - 1;
  const anchors: VectorAnchor[] = [];

  for (let i = 0; i < n; i++) {
    const curr = filtered[kept[i]];
    const prev = filtered[kept[Math.max(0, i - 1)]];
    const next = filtered[kept[Math.min(n - 1, i + 1)]];

    // Tangent direction from the drawn points right around the anchor (the sparse neighbours
    // are too far away to tell which way the pen was heading), handle length from each adjacent
    // segment so unevenly spaced anchors do not overshoot on the short side
    const before = filtered[Math.max(0, kept[i] - 2)];
    const after = filtered[Math.min(last, kept[i] + 2)];
    const tx = after.x - before.x;
    const ty = after.y - before.y;
    const tLen = Math.hypot(tx, ty) || 1;
    const inLen = Math.hypot(curr.x - prev.x, curr.y - prev.y) / 3;
    const outLen = Math.hypot(next.x - curr.x, next.y - curr.y) / 3;

    const cp1x = i > 0 ? curr.x - (tx / tLen) * inLen : undefined;
    const cp1y = i > 0 ? curr.y - (ty / tLen) * inLen : undefined;

    const cp2x = i < n - 1 ? curr.x + (tx / tLen) * outLen : undefined;
    const cp2y = i < n - 1 ? curr.y + (ty / tLen) * outLen : undefined;

    const p = curr.pressure;
    const width = Math.max(1, baseWidth * p);

    anchors.push({
      x: curr.x,
      y: curr.y,
      cp1x,
      cp1y,
      cp2x,
      cp2y,
      pressure: p,
      width,
    });
  }

  return anchors;
}

/**
 * Samples a Cubic Bézier segment into discrete points for collision testing and rendering
 */
export function sampleBezierSegment(
  p0: Point2D,
  cp1: Point2D,
  cp2: Point2D,
  p1: Point2D,
  steps: number = 10
): Point2D[] {
  const result: Point2D[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;

    const x = uuu * p0.x + 3 * uu * t * cp1.x + 3 * u * tt * cp2.x + ttt * p1.x;
    const y = uuu * p0.y + 3 * uu * t * cp1.y + 3 * u * tt * cp2.y + ttt * p1.y;
    result.push({ x, y });
  }
  return result;
}

/**
 * Samples an entire VectorStroke into a continuous polyline
 */
export function sampleVectorStroke(stroke: VectorStroke, stepsPerSegment: number = 12): Point2D[] {
  const { anchors } = stroke;
  if (anchors.length === 0) return [];
  if (anchors.length === 1) return [{ x: anchors[0].x, y: anchors[0].y }];

  const samples: Point2D[] = [];

  for (let i = 0; i < anchors.length - 1; i++) {
    const a0 = anchors[i];
    const a1 = anchors[i + 1];

    const p0 = { x: a0.x, y: a0.y };
    const cp1 = { x: a0.cp2x ?? a0.x, y: a0.cp2y ?? a0.y };
    const cp2 = { x: a1.cp1x ?? a1.x, y: a1.cp1y ?? a1.y };
    const p1 = { x: a1.x, y: a1.y };

    const segSamples = sampleBezierSegment(p0, cp1, cp2, p1, stepsPerSegment);
    if (i > 0) segSamples.shift(); // Avoid duplicate joint points
    samples.push(...segSamples);
  }

  return samples;
}

/**
 * Calculates squared distance from a point to a line segment
 */
export function distancePointToLineSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { distanceSq: number; t: number; projX: number; projY: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    const dSq = (px - x1) ** 2 + (py - y1) ** 2;
    return { distanceSq: dSq, t: 0, projX: x1, projY: y1 };
  }

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const distanceSq = (px - projX) ** 2 + (py - projY) ** 2;

  return { distanceSq, t, projX, projY };
}

/**
 * Tests if point (px, py) is within radius of vector stroke
 */
export function distancePointToStroke(
  px: number,
  py: number,
  stroke: VectorStroke,
  stepsPerSegment: number = 10
): { minDistance: number; closestIndex: number; samplePoint: Point2D } {
  const samples = sampleVectorStroke(stroke, stepsPerSegment);
  if (samples.length === 0) {
    return { minDistance: Infinity, closestIndex: -1, samplePoint: { x: 0, y: 0 } };
  }

  let minDistanceSq = Infinity;
  let closestIndex = 0;
  let samplePoint = samples[0];

  for (let i = 0; i < samples.length - 1; i++) {
    const p1 = samples[i];
    const p2 = samples[i + 1];
    const { distanceSq, projX, projY } = distancePointToLineSegment(px, py, p1.x, p1.y, p2.x, p2.y);
    if (distanceSq < minDistanceSq) {
      minDistanceSq = distanceSq;
      closestIndex = i;
      samplePoint = { x: projX, y: projY };
    }
  }

  return {
    minDistance: Math.sqrt(minDistanceSq),
    closestIndex,
    samplePoint,
  };
}

/**
 * Checks whether 2 line segments (p1-p2 and p3-p4) intersect
 */
export function lineSegmentsIntersect(
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  p4: Point2D
): { intersects: boolean; x?: number; y?: number; t1?: number; t2?: number } {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return { intersects: false };

  const t1 = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const t2 = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;

  if (t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1) {
    return {
      intersects: true,
      x: p1.x + t1 * (p2.x - p1.x),
      y: p1.y + t1 * (p2.y - p1.y),
      t1,
      t2,
    };
  }

  return { intersects: false };
}

/**
 * Finds all intersection points between two vector strokes
 */
export function findIntersectionsBetweenStrokes(
  strokeA: VectorStroke,
  strokeB: VectorStroke
): Array<{ x: number; y: number; sampleIdxA: number; sampleIdxB: number }> {
  const samplesA = sampleVectorStroke(strokeA, 10);
  const samplesB = sampleVectorStroke(strokeB, 10);
  const results: Array<{ x: number; y: number; sampleIdxA: number; sampleIdxB: number }> = [];

  for (let i = 0; i < samplesA.length - 1; i++) {
    for (let j = 0; j < samplesB.length - 1; j++) {
      const hit = lineSegmentsIntersect(samplesA[i], samplesA[i + 1], samplesB[j], samplesB[j + 1]);
      if (hit.intersects && hit.x !== undefined && hit.y !== undefined) {
        results.push({
          x: hit.x,
          y: hit.y,
          sampleIdxA: i,
          sampleIdxB: j,
        });
      }
    }
  }

  return results;
}

/**
 * Vector Eraser: Mode 1 - Erase Entire Stroke
 * Tests if eraser touch circle hits any part of the stroke
 */
export function hitTestVectorStroke(
  stroke: VectorStroke,
  eraserX: number,
  eraserY: number,
  eraserRadius: number
): boolean {
  const { minDistance } = distancePointToStroke(eraserX, eraserY, stroke);
  const threshold = eraserRadius + stroke.baseWidth / 2;
  return minDistance <= threshold;
}

/**
 * Vector Eraser: Mode 2 - Erase Up To Intersection (交點消除)
 * Splits stroke at intersections with other strokes, and deletes the segment touched by the eraser
 */
export function eraseStrokeToIntersection(
  targetStroke: VectorStroke,
  otherStrokes: VectorStroke[],
  eraserX: number,
  eraserY: number,
  eraserRadius: number
): VectorStroke[] {
  // 1. Check if target stroke is even touched by eraser
  const hit = hitTestVectorStroke(targetStroke, eraserX, eraserY, eraserRadius);
  if (!hit) {
    return [targetStroke];
  }

  // 2. Find all intersections of targetStroke with other strokes
  const intersections: Array<{ x: number; y: number; sampleIdxA: number }> = [];
  for (const other of otherStrokes) {
    if (other.id === targetStroke.id) continue;
    const inters = findIntersectionsBetweenStrokes(targetStroke, other);
    intersections.push(...inters);
  }

  // If no intersections found, whole stroke is erased (CSP behavior)
  if (intersections.length === 0) {
    return [];
  }

  // Sort intersections along stroke sample index
  intersections.sort((a, b) => a.sampleIdxA - b.sampleIdxA);

  // Cluster close duplicate intersection indices (within 2 samples of each other)
  const mergedIntersections: number[] = [];
  for (const it of intersections) {
    if (mergedIntersections.length === 0 || it.sampleIdxA - mergedIntersections[mergedIntersections.length - 1] > 2) {
      mergedIntersections.push(it.sampleIdxA);
    }
  }

  const samples = sampleVectorStroke(targetStroke, 10);
  const totalSamples = samples.length;

  // Find sample index closest to eraser touch point
  const { closestIndex } = distancePointToStroke(eraserX, eraserY, targetStroke, 10);

  // Divide sample intervals into chunks by intersections
  const cutIndices = [0, ...mergedIntersections, totalSamples - 1];
  // Deduplicate and sort cutIndices
  const uniqueCuts = Array.from(new Set(cutIndices)).sort((a, b) => a - b);

  // Identify which sub-segment the eraser touched
  let touchedSegmentIndex = -1;
  for (let s = 0; s < uniqueCuts.length - 1; s++) {
    const startIdx = uniqueCuts[s];
    const endIdx = uniqueCuts[s + 1];
    if (closestIndex >= startIdx && closestIndex <= endIdx) {
      touchedSegmentIndex = s;
      break;
    }
  }

  // Build resulting sub-strokes, discarding the touched one
  const resultingStrokes: VectorStroke[] = [];

  for (let s = 0; s < uniqueCuts.length - 1; s++) {
    if (s === touchedSegmentIndex) {
      // Discard this segment! (Erase to intersection)
      continue;
    }

    const startIdx = uniqueCuts[s];
    const endIdx = uniqueCuts[s + 1];
    const segPoints = samples.slice(startIdx, endIdx + 1);

    if (segPoints.length >= 2) {
      const newAnchors = fitPointsToBezier(segPoints, targetStroke.baseWidth);
      if (newAnchors.length >= 2) {
        resultingStrokes.push({
          ...targetStroke,
          id: `${targetStroke.id}_part_${s}_${Date.now()}`,
          anchors: newAnchors,
          bounds: computeStrokeBounds(newAnchors, targetStroke.baseWidth),
        });
      }
    }
  }

  return resultingStrokes;
}

/**
 * Vector Reshape / Pinch Tool (修線工具 - 捏線與節點重調)
 * Deforms anchors and Bézier control handles smoothly within brush radius towards drag vector
 */
export function pinchVectorStroke(
  stroke: VectorStroke,
  pinchCenter: { x: number; y: number },
  dragDelta: { x: number; y: number },
  brushRadius: number = 40
): VectorStroke {
  let anyModified = false;
  const updatedAnchors: VectorAnchor[] = stroke.anchors.map((anchor) => {
    const dist = Math.hypot(anchor.x - pinchCenter.x, anchor.y - pinchCenter.y);
    if (dist >= brushRadius) {
      return { ...anchor };
    }

    anyModified = true;
    // Smooth cosine bell falloff: (1 - (dist / R)^2)^2
    const t = 1 - dist / brushRadius;
    const falloff = t * t * (3 - 2 * t); // smoothstep

    const dx = dragDelta.x * falloff;
    const dy = dragDelta.y * falloff;

    return {
      ...anchor,
      x: anchor.x + dx,
      y: anchor.y + dy,
      cp1x: anchor.cp1x !== undefined ? anchor.cp1x + dx : undefined,
      cp1y: anchor.cp1y !== undefined ? anchor.cp1y + dy : undefined,
      cp2x: anchor.cp2x !== undefined ? anchor.cp2x + dx : undefined,
      cp2y: anchor.cp2y !== undefined ? anchor.cp2y + dy : undefined,
    };
  });

  if (!anyModified) return stroke;

  return {
    ...stroke,
    anchors: updatedAnchors,
    bounds: computeStrokeBounds(updatedAnchors, stroke.baseWidth),
  };
}

/**
 * Vector Line Width Adjustment Tool (線寬調整工具 - 加粗 / 變細)
 * Adjusts anchor stroke width within brush radius
 */
export function adjustVectorStrokeWidth(
  stroke: VectorStroke,
  brushCenter: { x: number; y: number },
  brushRadius: number = 32,
  deltaWidth: number = 2.0 // positive for thicken, negative for thin
): VectorStroke {
  let anyModified = false;
  const updatedAnchors: VectorAnchor[] = stroke.anchors.map((anchor) => {
    const dist = Math.hypot(anchor.x - brushCenter.x, anchor.y - brushCenter.y);
    if (dist >= brushRadius) {
      return { ...anchor };
    }

    anyModified = true;
    const falloff = 1 - dist / brushRadius;
    const newWidth = Math.max(0.75, Math.min(128, anchor.width + deltaWidth * falloff));
    const newPressure = Math.max(0.1, Math.min(1.0, newWidth / Math.max(1, stroke.baseWidth)));

    return {
      ...anchor,
      width: newWidth,
      pressure: newPressure,
    };
  });

  if (!anyModified) return stroke;

  return {
    ...stroke,
    anchors: updatedAnchors,
    bounds: computeStrokeBounds(updatedAnchors, stroke.baseWidth),
  };
}

/**
 * Move a specific anchor point or tangent control handle
 */
export function moveVectorAnchor(
  stroke: VectorStroke,
  anchorIndex: number,
  newPos: { x: number; y: number },
  handle: 'anchor' | 'cp1' | 'cp2' = 'anchor'
): VectorStroke {
  if (anchorIndex < 0 || anchorIndex >= stroke.anchors.length) return stroke;

  const anchors = [...stroke.anchors];
  const target = { ...anchors[anchorIndex] };

  if (handle === 'anchor') {
    const dx = newPos.x - target.x;
    const dy = newPos.y - target.y;
    target.x = newPos.x;
    target.y = newPos.y;
    if (target.cp1x !== undefined) target.cp1x += dx;
    if (target.cp1y !== undefined) target.cp1y += dy;
    if (target.cp2x !== undefined) target.cp2x += dx;
    if (target.cp2y !== undefined) target.cp2y += dy;
  } else if (handle === 'cp1') {
    target.cp1x = newPos.x;
    target.cp1y = newPos.y;
  } else if (handle === 'cp2') {
    target.cp2x = newPos.x;
    target.cp2y = newPos.y;
  }

  anchors[anchorIndex] = target;

  return {
    ...stroke,
    anchors,
    bounds: computeStrokeBounds(anchors, stroke.baseWidth),
  };
}

/**
 * High-quality 2D vector rasterization of Cubic Bézier strokes onto a CanvasRenderingContext2D
 */
export function renderVectorStrokeToCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  stroke: VectorStroke
) {
  const { anchors, color, opacity } = stroke;
  if (anchors.length === 0) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (anchors.length === 1) {
    const a = anchors[0];
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Draw segment by segment with variable stroke widths
  for (let i = 0; i < anchors.length - 1; i++) {
    const a0 = anchors[i];
    const a1 = anchors[i + 1];

    const cp1x = a0.cp2x ?? a0.x;
    const cp1y = a0.cp2y ?? a0.y;
    const cp2x = a1.cp1x ?? a1.x;
    const cp2y = a1.cp1y ?? a1.y;

    const widthDelta = a1.width - a0.width;
    if (Math.abs(widthDelta) < 0.75) {
      ctx.lineWidth = Math.max(1, (a0.width + a1.width) / 2);
      ctx.beginPath();
      ctx.moveTo(a0.x, a0.y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, a1.x, a1.y);
      ctx.stroke();
      continue;
    }

    // The width changes along this segment. Anchors are sparse now, so one flat width per
    // segment would turn a taper into visible steps: draw it in short pieces instead.
    const approxLength =
      Math.hypot(cp1x - a0.x, cp1y - a0.y) +
      Math.hypot(cp2x - cp1x, cp2y - cp1y) +
      Math.hypot(a1.x - cp2x, a1.y - cp2y);
    const steps = Math.min(256, Math.max(2, Math.ceil(approxLength / 3)));
    const pieces = sampleBezierSegment(
      { x: a0.x, y: a0.y },
      { x: cp1x, y: cp1y },
      { x: cp2x, y: cp2y },
      { x: a1.x, y: a1.y },
      steps
    );
    for (let k = 0; k < steps; k++) {
      ctx.lineWidth = Math.max(1, a0.width + widthDelta * ((k + 0.5) / steps));
      ctx.beginPath();
      ctx.moveTo(pieces[k].x, pieces[k].y);
      ctx.lineTo(pieces[k + 1].x, pieces[k + 1].y);
      ctx.stroke();
    }
  }

  ctx.restore();
}
