import { computeStrokeBounds, VectorAnchor, VectorStroke } from '@atelier/shared';

/**
 * Node-level vector editing (pen tool / direct selection), kept free of rendering so it is
 * easy to reason about. A "smooth" anchor has its two handles on one line through the anchor;
 * a "corner" anchor has independent (or collapsed) handles.
 */
export type HandleKind = 'anchor' | 'cp1' | 'cp2';

export interface VectorHit {
  strokeId: string;
  index: number;
  handle: HandleKind;
}

export interface PenPoint {
  x: number;
  y: number;
  /** Outgoing handle; the incoming one mirrors it unless corner is set */
  hx?: number;
  hy?: number;
  corner?: boolean;
}

type Pt = { x: number; y: number };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export const withBounds = (stroke: VectorStroke): VectorStroke => ({
  ...stroke,
  bounds: computeStrokeBounds(stroke.anchors, stroke.baseWidth),
});

const cp1Of = (a: VectorAnchor): Pt => ({ x: a.cp1x ?? a.x, y: a.cp1y ?? a.y });
const cp2Of = (a: VectorAnchor): Pt => ({ x: a.cp2x ?? a.x, y: a.cp2y ?? a.y });

/** True when the anchor's handles are collapsed or not on one straight line through it. */
export const isCornerAnchor = (a: VectorAnchor): boolean => {
  const c1 = cp1Of(a);
  const c2 = cp2Of(a);
  const l1 = dist(c1, a);
  const l2 = dist(c2, a);
  if (l1 < 0.5 || l2 < 0.5) return true;
  const cos = ((a.x - c1.x) * (c2.x - a.x) + (a.y - c1.y) * (c2.y - a.y)) / (l1 * l2);
  return cos < 0.985; // more than ~10° off a straight line
};

/** Handles of `selectedId` first (they sit on top), then every anchor. */
export const hitTestNodes = (
  strokes: VectorStroke[],
  p: Pt,
  radius: number,
  selectedId: string | null,
): VectorHit | null => {
  const selected = strokes.find((s) => s.id === selectedId);
  if (selected) {
    for (let i = 0; i < selected.anchors.length; i++) {
      const a = selected.anchors[i];
      if (a.cp1x !== undefined && dist(cp1Of(a), a) > 0.5 && dist(cp1Of(a), p) <= radius) return { strokeId: selected.id, index: i, handle: 'cp1' };
      if (a.cp2x !== undefined && dist(cp2Of(a), a) > 0.5 && dist(cp2Of(a), p) <= radius) return { strokeId: selected.id, index: i, handle: 'cp2' };
    }
  }
  let best: VectorHit | null = null;
  let bestD = radius;
  for (const s of strokes) {
    s.anchors.forEach((a, i) => {
      const d = dist(a, p);
      if (d <= bestD) {
        bestD = d;
        best = { strokeId: s.id, index: i, handle: 'anchor' };
      }
    });
  }
  return best;
};

const mapAnchor = (stroke: VectorStroke, index: number, fn: (a: VectorAnchor) => VectorAnchor): VectorStroke =>
  withBounds({ ...stroke, anchors: stroke.anchors.map((a, i) => (i === index ? fn(a) : a)) });

/** Moves an anchor together with its handles. */
export const moveAnchor = (stroke: VectorStroke, index: number, to: Pt): VectorStroke =>
  mapAnchor(stroke, index, (a) => {
    const dx = to.x - a.x;
    const dy = to.y - a.y;
    return {
      ...a,
      x: to.x,
      y: to.y,
      cp1x: a.cp1x !== undefined ? a.cp1x + dx : undefined,
      cp1y: a.cp1y !== undefined ? a.cp1y + dy : undefined,
      cp2x: a.cp2x !== undefined ? a.cp2x + dx : undefined,
      cp2y: a.cp2y !== undefined ? a.cp2y + dy : undefined,
    };
  });

/**
 * Moves one handle. On a smooth anchor the opposite handle turns with it (keeping its own
 * length) unless `breakTangent` (Alt) is held, which turns the anchor into a corner.
 */
export const moveHandle = (stroke: VectorStroke, index: number, handle: 'cp1' | 'cp2', to: Pt, breakTangent: boolean): VectorStroke =>
  mapAnchor(stroke, index, (a) => {
    const smooth = !isCornerAnchor(a) && !breakTangent;
    const next: VectorAnchor = { ...a };
    if (handle === 'cp1') {
      next.cp1x = to.x;
      next.cp1y = to.y;
    } else {
      next.cp2x = to.x;
      next.cp2y = to.y;
    }
    if (smooth) {
      const other = handle === 'cp1' ? cp2Of(a) : cp1Of(a);
      const len = dist(other, a);
      const d = dist(to, a);
      if (d > 0.01 && len > 0.01) {
        const ox = a.x - ((to.x - a.x) / d) * len;
        const oy = a.y - ((to.y - a.y) / d) * len;
        if (handle === 'cp1') {
          next.cp2x = ox;
          next.cp2y = oy;
        } else {
          next.cp1x = ox;
          next.cp1y = oy;
        }
      }
    }
    return next;
  });

/** Corner -> smooth handles along the neighbours' direction; smooth -> collapsed (sharp) corner. */
export const toggleCorner = (stroke: VectorStroke, index: number): VectorStroke => {
  const a = stroke.anchors[index];
  if (!a) return stroke;
  if (!isCornerAnchor(a)) {
    return mapAnchor(stroke, index, (x) => ({ ...x, cp1x: x.x, cp1y: x.y, cp2x: x.x, cp2y: x.y }));
  }
  const prev = stroke.anchors[index - 1] ?? a;
  const next = stroke.anchors[index + 1] ?? a;
  let dx = next.x - prev.x;
  let dy = next.y - prev.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d;
  dy /= d;
  const l1 = dist(prev, a) / 3;
  const l2 = dist(a, next) / 3;
  return mapAnchor(stroke, index, (x) => ({ ...x, cp1x: x.x - dx * l1, cp1y: x.y - dy * l1, cp2x: x.x + dx * l2, cp2y: x.y + dy * l2 }));
};

/** Removes one anchor; returns null when fewer than two remain (the stroke should be deleted). */
export const deleteAnchor = (stroke: VectorStroke, index: number): VectorStroke | null => {
  if (stroke.anchors.length <= 2) return null;
  return withBounds({ ...stroke, anchors: stroke.anchors.filter((_, i) => i !== index) });
};

/**
 * Pen points -> bezier anchors. Pen mode uses the dragged handles (mirrored in, unless corner);
 * curve mode derives handles from the neighbours (Catmull-Rom), so clicks join smoothly.
 */
export const penPointsToAnchors = (points: PenPoint[], mode: 'pen' | 'curve', width: number, closed: boolean): VectorAnchor[] => {
  const pts = closed && points.length > 2 ? [...points, points[0]] : points;
  return pts.map((p, i) => {
    const anchor: VectorAnchor = { x: p.x, y: p.y, pressure: 1, width };
    if (mode === 'pen') {
      if (p.hx !== undefined && p.hy !== undefined && !p.corner) {
        anchor.cp2x = p.hx;
        anchor.cp2y = p.hy;
        anchor.cp1x = 2 * p.x - p.hx;
        anchor.cp1y = 2 * p.y - p.hy;
      } else {
        anchor.cp1x = anchor.cp2x = p.x;
        anchor.cp1y = anchor.cp2y = p.y;
      }
      return anchor;
    }
    const prev = pts[i - 1] ?? (closed ? pts[pts.length - 2] : undefined);
    const next = pts[i + 1] ?? (closed ? pts[1] : undefined);
    if (p.corner || !prev || !next) {
      anchor.cp1x = anchor.cp2x = p.x;
      anchor.cp1y = anchor.cp2y = p.y;
      return anchor;
    }
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    anchor.cp1x = p.x - tx;
    anchor.cp1y = p.y - ty;
    anchor.cp2x = p.x + tx;
    anchor.cp2y = p.y + ty;
    return anchor;
  });
};

export const buildPenStroke = (
  layerId: string,
  points: PenPoint[],
  mode: 'pen' | 'curve',
  props: { color: string; width: number; opacity: number },
  closed: boolean,
): VectorStroke | null => {
  if (points.length < 2) return null;
  return withBounds({
    id: `vec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    layerId,
    color: props.color,
    opacity: props.opacity,
    baseWidth: props.width,
    anchors: penPointsToAnchors(points, mode, props.width, closed),
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    closed,
    createdAt: Date.now(),
  });
};
