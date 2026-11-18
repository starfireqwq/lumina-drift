/**
 * AtelierSync Ruler & Guideline System Math
 * Supports Symmetry, Perspective (1/2/3-Point), Parallel, and Concentric Snapping
 */

export type RulerMode = 'off' | 'symmetry' | 'perspective' | 'parallel' | 'concentric';

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

export interface PerspectiveConfig {
  mode: PerspectiveMode;
  horizonY: number;
  vp1: Point2D; // Primary Vanishing Point (Left or Center)
  vp2: Point2D; // Secondary Vanishing Point (Right)
  vp3: Point2D; // Tertiary Vanishing Point (Vertical / Aerial / Worm-eye)
  snapThreshold?: number;
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
