type Point = { x: number; y: number };

export interface TransformBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** Normalized pivot offset relative to box size (default 0.5, 0.5 = center) */
  pivotX?: number;
  pivotY?: number;
}

export function getBoxPivotCanvasPoint(box: TransformBox): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const ox = ((box.pivotX ?? 0.5) - 0.5) * box.width;
  const oy = ((box.pivotY ?? 0.5) - 0.5) * box.height;
  const cos = Math.cos(box.rotation);
  const sin = Math.sin(box.rotation);
  return { x: cx + ox * cos - oy * sin, y: cy + ox * sin + oy * cos };
}

export function projectTransformBox(box: TransformBox, zoom: number, project: (x: number, y: number) => Point) {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const center = project(centerX, centerY);
  const cos = Math.cos(box.rotation);
  const sin = Math.sin(box.rotation);
  const axisX = project(centerX + cos * Math.sign(box.width), centerY + sin * Math.sign(box.width));
  const axisY = project(centerX - sin * Math.sign(box.height), centerY + cos * Math.sign(box.height));
  const width = Math.abs(box.width) * zoom;
  const height = Math.abs(box.height) * zoom;

  return {
    left: center.x - width / 2,
    top: center.y - height / 2,
    width,
    height,
    matrix: [
      (axisX.x - center.x) / zoom,
      (axisX.y - center.y) / zoom,
      (axisY.x - center.x) / zoom,
      (axisY.y - center.y) / zoom,
    ],
  };
}
