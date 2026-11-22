import React, { useEffect, useRef } from 'react';
import { VectorStroke, ToolType } from '@atelier/shared';
import { CanvasViewport } from '../engine/Viewport';
import { isCornerAnchor, PenPoint } from '../engine/vectorEditing';

interface VectorOverlayProps {
  viewport: CanvasViewport | null;
  viewportState: unknown; // changes on every zoom / pan / rotate; only used to trigger a redraw
  strokes: VectorStroke[];
  currentTool: ToolType;
  isVectorLayer: boolean;
  /** vector_edit: the stroke whose handles are shown, and its selected anchor (-1 = none) */
  selectedStrokeId?: string | null;
  /** Additional / multi-selected strokes highlighted for batch alignment or editing */
  selectedStrokeIds?: readonly string[];
  selectedAnchorIndex?: number;
  /** Stroke being dragged (node edit) or the pen path in progress, drawn as a guide line */
  previewStroke?: VectorStroke | null;
  /** vector_bezier: the points placed so far */
  penPoints?: PenPoint[];
}

const NODE_TOOLS: ToolType[] = ['vector_reshape', 'vector_width', 'vector_eraser', 'vector_edit', 'vector_bezier'];

/** Anchors, handles and guide paths for the vector tools, in screen space over the canvas. */
export const VectorOverlay: React.FC<VectorOverlayProps> = ({
  viewport,
  viewportState,
  strokes,
  currentTool,
  isVectorLayer,
  selectedStrokeId = null,
  selectedStrokeIds = [],
  selectedAnchorIndex = -1,
  previewStroke = null,
  penPoints = [],
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const show = isVectorLayer && NODE_TOOLS.includes(currentTool);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport || !show) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { clientWidth, clientHeight } = canvas;
    if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
      canvas.width = clientWidth;
      canvas.height = clientHeight;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const S = (x: number, y: number) => viewport.canvasToScreen(x, y);

    const tracePath = (s: VectorStroke) => {
      const a = s.anchors;
      if (a.length === 0) return;
      ctx.beginPath();
      const p0 = S(a[0].x, a[0].y);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 0; i < a.length - 1; i++) {
        const c1 = S(a[i].cp2x ?? a[i].x, a[i].cp2y ?? a[i].y);
        const c2 = S(a[i + 1].cp1x ?? a[i + 1].x, a[i + 1].cp1y ?? a[i + 1].y);
        const p = S(a[i + 1].x, a[i + 1].y);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
      }
    };

    const drawHandle = (ax: number, ay: number, hx: number | undefined, hy: number | undefined) => {
      if (hx === undefined || hy === undefined || Math.hypot(hx - ax, hy - ay) < 0.5) return;
      const a = S(ax, ay);
      const h = S(hx, hy);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(h.x, h.y);
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(h.x, h.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };

    const drawAnchor = (x: number, y: number, corner: boolean, selected: boolean, size = 7) => {
      const p = S(x, y);
      if (p.x < -20 || p.y < -20 || p.x > canvas.width + 20 || p.y > canvas.height + 20) return;
      ctx.beginPath();
      if (corner) ctx.rect(p.x - size / 2, p.y - size / 2, size, size);
      else ctx.arc(p.x, p.y, size / 2 + 0.5, 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#fbbf24' : '#0ea5e9';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    };

    ctx.save();
    ctx.setLineDash([]);

    // Outline of selected stroke(s), so it is clear which line(s) are targeted
    const multiSelected = new Set<string>(selectedStrokeIds);
    if (selectedStrokeId) multiSelected.add(selectedStrokeId);
    if (multiSelected.size > 0 && !previewStroke) {
      for (const s of strokes) {
        if (!multiSelected.has(s.id)) continue;
        tracePath(s);
        ctx.strokeStyle = s.id === selectedStrokeId ? 'rgba(14, 165, 233, 0.92)' : 'rgba(129, 140, 248, 0.85)';
        ctx.lineWidth = s.id === selectedStrokeId ? 1.8 : 1.5;
        ctx.stroke();
      }
    }

    // Guide line of a stroke being edited or drawn with the pen
    if (previewStroke) {
      tracePath(previewStroke);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = '#0ea5e9';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (currentTool === 'vector_bezier') {
      penPoints.forEach((p, i) => {
        if (p.hx !== undefined && p.hy !== undefined && !p.corner) {
          drawHandle(p.x, p.y, p.hx, p.hy);
          drawHandle(p.x, p.y, 2 * p.x - p.hx, 2 * p.y - p.hy);
        }
        // The first point is where a click closes the path
        drawAnchor(p.x, p.y, true, i === 0 && penPoints.length >= 3, i === 0 ? 9 : 7);
      });
    } else {
      const edited = previewStroke && currentTool === 'vector_edit' ? previewStroke : null;
      for (const stroke of strokes) {
        const s = edited && edited.id === stroke.id ? edited : stroke;
        const isSel = s.id === selectedStrokeId;
        const isMulti = multiSelected.has(s.id);
        if (currentTool === 'vector_edit' && isSel) {
          s.anchors.forEach((a) => {
            drawHandle(a.x, a.y, a.cp1x, a.cp1y);
            drawHandle(a.x, a.y, a.cp2x, a.cp2y);
          });
        }
        s.anchors.forEach((a, i) => drawAnchor(a.x, a.y, isCornerAnchor(a), isSel && i === selectedAnchorIndex, isMulti ? 8 : 6));
      }
    }
    ctx.restore();
    // viewportState is a dependency on purpose: the viewport object itself never changes on
    // zoom / pan, so without it the anchors stayed where they were drawn before the view moved
  }, [viewport, viewportState, strokes, currentTool, show, selectedStrokeId, selectedStrokeIds, selectedAnchorIndex, previewStroke, penPoints]);

  if (!show) return null;

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 z-20 h-full w-full" />;
};
