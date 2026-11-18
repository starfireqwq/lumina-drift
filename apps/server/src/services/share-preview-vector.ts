import { distancePointToLineSegment, sampleBezierSegment, type Affine2D, type VectorStroke } from '@atelier/shared';

/** Rasterize stored vector paths for previews, including vector imports that contain no tiles. */
export function sampleVectors(strokes: VectorStroke[], width: number, height: number, scale: number, matrix: Affine2D) {
  const { a, b, c, d, tx, ty } = matrix;
  const det = a * d - b * c;
  const paint = new Uint8ClampedArray(width * height * 4);
  if (!det) return paint;

  const project = (x: number, y: number) => ({ x: (a * x + c * y + tx) * scale, y: (b * x + d * y + ty) * scale });
  const maxStretch = Math.max(Math.abs(a) + Math.abs(c), Math.abs(b) + Math.abs(d)) * scale;
  const mask = new Uint8ClampedArray(width * height);
  for (const stroke of strokes) {
    if (!stroke.anchors.length || !(stroke.opacity > 0) || !/^#[\da-f]{6}$/i.test(stroke.color)) continue;
    const color = parseInt(stroke.color.slice(1), 16);
    let left = width, right = 0, top = height, bottom = 0;
    const mark = (start: { x: number; y: number }, end: { x: number; y: number }, sw: number, ew: number) => {
      const s = project(start.x, start.y);
      const e = project(end.x, end.y);
      const pad = Math.max(sw, ew) * maxStretch / 2 + 1;
      const x0 = Math.max(0, Math.floor(Math.min(s.x, e.x) - pad));
      const x1 = Math.min(width, Math.ceil(Math.max(s.x, e.x) + pad));
      const y0 = Math.max(0, Math.floor(Math.min(s.y, e.y) - pad));
      const y1 = Math.min(height, Math.ceil(Math.max(s.y, e.y) + pad));
      if (x0 >= x1 || y0 >= y1) return;
      left = Math.min(left, x0); right = Math.max(right, x1);
      top = Math.min(top, y0); bottom = Math.max(bottom, y1);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const dx = (x + 0.5) / scale - tx;
          const dy = (y + 0.5) / scale - ty;
          const px = (d * dx - c * dy) / det;
          const py = (a * dy - b * dx) / det;
          const { distanceSq, t } = distancePointToLineSegment(px, py, start.x, start.y, end.x, end.y);
          const radius = (sw + (ew - sw) * t) / 2;
          const coverage = Math.max(0, Math.min(1, (radius - Math.sqrt(distanceSq)) * maxStretch + 0.5));
          const index = y * width + x;
          mask[index] = Math.max(mask[index], coverage * 255);
        }
      }
    };
    const anchors = stroke.anchors;
    if (anchors.length === 1) mark(anchors[0], anchors[0], anchors[0].width, anchors[0].width);
    for (let i = 1; i < anchors.length; i++) {
      const l = anchors[i - 1], r = anchors[i];
      const control1 = { x: l.cp2x ?? l.x, y: l.cp2y ?? l.y };
      const control2 = { x: r.cp1x ?? r.x, y: r.cp1y ?? r.y };
      const length = Math.hypot(control1.x - l.x, control1.y - l.y) +
        Math.hypot(control2.x - control1.x, control2.y - control1.y) + Math.hypot(r.x - control2.x, r.y - control2.y);
      const steps = Math.max(2, Math.min(96, Math.ceil(length * maxStretch / 5)));
      const points = sampleBezierSegment(l, control1, control2, r, steps);
      for (let k = 0; k < steps; k++) {
        const widthAt = (sample: number) => Math.max(1, l.width + ((r.width - l.width) * sample) / steps);
        mark(points[k], points[k + 1], widthAt(k), widthAt(k + 1));
      }
    }
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const index = y * width + x;
        const alpha = mask[index] / 255 * Math.min(1, stroke.opacity);
        mask[index] = 0;
        if (!alpha) continue;
        const i = index * 4;
        paint[i] = (color >> 16) * alpha + paint[i] * (1 - alpha);
        paint[i + 1] = ((color >> 8) & 255) * alpha + paint[i + 1] * (1 - alpha);
        paint[i + 2] = (color & 255) * alpha + paint[i + 2] * (1 - alpha);
        paint[i + 3] = 255 * alpha + paint[i + 3] * (1 - alpha);
      }
    }
  }
  return paint;
}
