import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { BarSelect, CanvasActionBar } from './workspace/CanvasActionBar';
import { Segmented } from './workspace/ToolOptionsBar';
import { DISTORT_MODES, type DistortMode } from '../utils/distortModes';

export { DISTORT_MODES, type DistortMode };

export interface MeshWarpNode {
  x: number; // In canvas coordinates
  y: number; // In canvas coordinates
  u: number; // Normalized [0..1]
  v: number; // Normalized [0..1]
}

interface MeshWarpOverlayProps {
  isActive: boolean;
  mode: DistortMode;
  onChangeMode: (mode: DistortMode | 'transform') => void;
  sourceCanvas: HTMLCanvasElement | null;
  initialBounds: { minX: number; minY: number; width: number; height: number };
  canvasWidth: number;
  canvasHeight: number;
  onApply: (
    warpedCanvas: HTMLCanvasElement,
    bounds: { minX: number; minY: number; width: number; height: number }
  ) => void;
  onCancel: () => void;
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  screenToCanvas: (sx: number, sy: number) => { x: number; y: number };
}

export const MeshWarpOverlay: React.FC<MeshWarpOverlayProps> = ({
  isActive,
  mode,
  onChangeMode,
  sourceCanvas,
  initialBounds,
  canvasWidth,
  canvasHeight,
  onApply,
  onCancel,
  canvasToScreen,
  screenToCanvas,
}) => {
  const [meshSize, setGridSize] = useState(4);
  const gridSize = mode === 'mesh' ? meshSize : 2;
  const [nodes, setNodes] = useState<MeshWarpNode[]>([]);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingNodeIdxRef = useRef<number | null>(null);
  const dragNodesRef = useRef<MeshWarpNode[]>([]);
  const dragPointRef = useRef<{ x: number; y: number } | null>(null);

  // Initialize grid nodes
  const initGrid = useCallback(
    (size: number) => {
      const newNodes: MeshWarpNode[] = [];
      const { minX, minY, width, height } = initialBounds;

      for (let r = 0; r < size; r++) {
        const v = r / (size - 1);
        for (let c = 0; c < size; c++) {
          const u = c / (size - 1);
          newNodes.push({
            x: minX + u * width,
            y: minY + v * height,
            u,
            v,
          });
        }
      }
      setNodes(newNodes);
    },
    [initialBounds]
  );

  useEffect(() => {
    if (isActive) {
      initGrid(gridSize);
    }
  }, [isActive, mode, gridSize, initGrid]);

  // Keyboard Enter & Escape listeners
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest('input, select, textarea, button')) {
        e.preventDefault();
        handleApply();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, nodes, onApply, onCancel]);

  // Helper to draw a textured triangle with affine transform
  const drawTriangle = (
    ctx: CanvasRenderingContext2D,
    im: HTMLCanvasElement,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    u2: number,
    v2: number
  ) => {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.closePath();
    ctx.clip();

    // Source coordinates in pixels
    const sx0 = u0 * im.width;
    const sy0 = v0 * im.height;
    const sx1 = u1 * im.width;
    const sy1 = v1 * im.height;
    const sx2 = u2 * im.width;
    const sy2 = v2 * im.height;

    // Affine transformation matrix calculation
    const sxA = sx1 - sx0, syA = sy1 - sy0;
    const sxB = sx2 - sx0, syB = sy2 - sy0;
    const denom = sxA * syB - sxB * syA;
    if (Math.abs(denom) > 0.0001) {
      const m11 = ((x1 - x0) * syB - (x2 - x0) * syA) / denom;
      const m12 = ((y1 - y0) * syB - (y2 - y0) * syA) / denom;
      const m21 = ((x2 - x0) * sxA - (x1 - x0) * sxB) / denom;
      const m22 = ((y2 - y0) * sxA - (y1 - y0) * sxB) / denom;
      const dx = x0 - m11 * sx0 - m21 * sy0;
      const dy = y0 - m12 * sx0 - m22 * sy0;

      ctx.transform(m11, m12, m21, m22, dx, dy);
      ctx.drawImage(im, 0, 0);
    }

    ctx.restore();
  };

  // Render the warped mesh into canvas
  const renderMesh = useCallback(
    (targetCanvas: HTMLCanvasElement, project: (x: number, y: number) => { x: number; y: number }) => {
      const ctx = targetCanvas.getContext('2d');
      if (!ctx || !sourceCanvas || nodes.length < gridSize * gridSize) return;

      ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);

      const subDiv = mode === 'mesh' ? 2 : 6;
      const size = gridSize;

      for (let r = 0; r < size - 1; r++) {
        for (let c = 0; c < size - 1; c++) {
          const n00 = nodes[r * size + c];
          const n10 = nodes[r * size + (c + 1)];
          const n01 = nodes[(r + 1) * size + c];
          const n11 = nodes[(r + 1) * size + (c + 1)];
          const ax = n10.x - n11.x, ay = n10.y - n11.y;
          const bx = n01.x - n11.x, by = n01.y - n11.y;
          const cx = n00.x - n10.x - n01.x + n11.x, cy = n00.y - n10.y - n01.y + n11.y;
          const denominator = ax * by - ay * bx;
          const projective = mode === 'perspective' && Math.abs(denominator) > 1e-7;
          const g = projective ? (cx * by - cy * bx) / denominator : 0;
          const h = projective ? (ax * cy - ay * cx) / denominator : 0;

          // Subdivide quad using bilinear interpolation
          for (let sr = 0; sr < subDiv; sr++) {
            const sv0 = sr / subDiv;
            const sv1 = (sr + 1) / subDiv;

            for (let sc = 0; sc < subDiv; sc++) {
              const su0 = sc / subDiv;
              const su1 = (sc + 1) / subDiv;

              // Bilinear interpolate 4 corners
              const interp = (u: number, v: number) => {
                if (projective) {
                  const w = 1 + g * u + h * v;
                  return {
                    ...project((n00.x + (n10.x * (1 + g) - n00.x) * u + (n01.x * (1 + h) - n00.x) * v) / w,
                      (n00.y + (n10.y * (1 + g) - n00.y) * u + (n01.y * (1 + h) - n00.y) * v) / w),
                    u, v,
                  };
                }
                const w00 = (1 - u) * (1 - v);
                const w10 = u * (1 - v);
                const w01 = (1 - u) * v;
                const w11 = u * v;

                return {
                  ...project(n00.x * w00 + n10.x * w10 + n01.x * w01 + n11.x * w11,
                    n00.y * w00 + n10.y * w10 + n01.y * w01 + n11.y * w11),
                  u: n00.u * w00 + n10.u * w10 + n01.u * w01 + n11.u * w11,
                  v: n00.v * w00 + n10.v * w10 + n01.v * w01 + n11.v * w11,
                };
              };

              const p00 = interp(su0, sv0);
              const p10 = interp(su1, sv0);
              const p01 = interp(su0, sv1);
              const p11 = interp(su1, sv1);

              // 2 Triangles per micro-cell
              drawTriangle(
                ctx,
                sourceCanvas,
                p00.x,
                p00.y,
                p10.x,
                p10.y,
                p11.x,
                p11.y,
                p00.u,
                p00.v,
                p10.u,
                p10.v,
                p11.u,
                p11.v
              );
              drawTriangle(
                ctx,
                sourceCanvas,
                p00.x,
                p00.y,
                p11.x,
                p11.y,
                p01.x,
                p01.y,
                p00.u,
                p00.v,
                p11.u,
                p11.v,
                p01.u,
                p01.v
              );
            }
          }
        }
      }
    },
    [nodes, gridSize, sourceCanvas, mode]
  );

  // Redraw preview canvas whenever nodes update
  useEffect(() => {
    if (!isActive || !previewCanvasRef.current || !sourceCanvas) return;
    const canvas = previewCanvasRef.current;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    renderMesh(canvas, canvasToScreen);
  }, [isActive, renderMesh, sourceCanvas, canvasToScreen]);

  const handleApply = () => {
    if (!sourceCanvas || nodes.length === 0) {
      onCancel();
      return;
    }
    if (nodes.every((node) => node.x === initialBounds.minX + node.u * initialBounds.width &&
      node.y === initialBounds.minY + node.v * initialBounds.height)) {
      onCancel();
      return;
    }

    // Determine final bounding box of warped nodes
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x > maxX) maxX = node.x;
      if (node.y > maxY) maxY = node.y;
    }

    minX = Math.min(canvasWidth, Math.max(0, Math.floor(minX)));
    minY = Math.min(canvasHeight, Math.max(0, Math.floor(minY)));
    maxX = Math.max(0, Math.min(canvasWidth, Math.ceil(maxX)));
    maxY = Math.max(0, Math.min(canvasHeight, Math.ceil(maxY)));

    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = w;
    outputCanvas.height = h;

    renderMesh(outputCanvas, (x, y) => ({ x: x - minX, y: y - minY }));
    onApply(outputCanvas, { minX, minY, width: w, height: h });
  };

  const startDrag = (index: number, event: React.PointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingNodeIdxRef.current = index;
    dragNodesRef.current = nodes;
    dragPointRef.current = screenToCanvas(event.clientX, event.clientY);
  };

  const moveNode = (event: React.PointerEvent<SVGCircleElement>) => {
    const index = draggingNodeIdxRef.current;
    const start = dragPointRef.current;
    if (index === null || !start) return;
    event.stopPropagation();
    const point = screenToCanvas(event.clientX, event.clientY);
    const original = dragNodesRef.current;
    const node = original[index];
    const x = Math.min(canvasWidth * 2, Math.max(-canvasWidth, node.x + point.x - start.x));
    const y = Math.min(canvasHeight * 2, Math.max(-canvasHeight, node.y + point.y - start.y));
    const dx = x - node.x;
    const dy = y - node.y;
    setNodes(original.map((entry, i) => {
      if (mode === 'parallel') {
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        if (horizontal && entry.v === node.v) return { ...entry, x: entry.x + dx };
        if (!horizontal && entry.u === node.u) return { ...entry, y: entry.y + dy };
        return entry;
      }
      if (mode === 'perspective') {
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        if (horizontal && entry.v === node.v) {
          const maxInward = initialBounds.width / 2 - 1;
          const bounded = node.u === 0 ? Math.min(dx, maxInward) : Math.max(dx, -maxInward);
          return { ...entry, x: entry.x + (i === index ? bounded : -bounded) };
        }
        if (!horizontal && entry.u === node.u) {
          const maxInward = initialBounds.height / 2 - 1;
          const bounded = node.v === 0 ? Math.min(dy, maxInward) : Math.max(dy, -maxInward);
          return { ...entry, y: entry.y + (i === index ? bounded : -bounded) };
        }
        return entry;
      }
      return i === index ? { ...entry, x, y } : entry;
    }));
  };

  const endDrag = (event: React.PointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    draggingNodeIdxRef.current = null;
    dragPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (!isActive) return null;

  return (
    <div className="absolute inset-0 z-30 pointer-events-none select-none">
      {/* Real-time Warped Canvas Preview */}
      <canvas ref={previewCanvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />

      {/* SVG Control Wireframe & Node Handles */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
        {/* Grid lines */}
        {(() => {
          const lines = [];
          const size = gridSize;
          // Horizontal lines
          for (let r = 0; r < size; r++) {
            for (let c = 0; c < size - 1; c++) {
              const pA = canvasToScreen(nodes[r * size + c]?.x || 0, nodes[r * size + c]?.y || 0);
              const pB = canvasToScreen(nodes[r * size + c + 1]?.x || 0, nodes[r * size + c + 1]?.y || 0);
              lines.push(
                <line
                  key={`h-${r}-${c}`}
                  x1={pA.x}
                  y1={pA.y}
                  x2={pB.x}
                  y2={pB.y}
                  stroke="#6366F1"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  opacity="0.8"
                />
              );
            }
          }
          // Vertical lines
          for (let c = 0; c < size; c++) {
            for (let r = 0; r < size - 1; r++) {
              const pA = canvasToScreen(nodes[r * size + c]?.x || 0, nodes[r * size + c]?.y || 0);
              const pB = canvasToScreen(nodes[(r + 1) * size + c]?.x || 0, nodes[(r + 1) * size + c]?.y || 0);
              lines.push(
                <line
                  key={`v-${c}-${r}`}
                  x1={pA.x}
                  y1={pA.y}
                  x2={pB.x}
                  y2={pB.y}
                  stroke="#6366F1"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  opacity="0.8"
                />
              );
            }
          }
          return lines;
        })()}

        {/* Nodes */}
        {nodes.map((node, idx) => {
          const sPos = canvasToScreen(node.x, node.y);
          const isCorner =
            idx === 0 ||
            idx === gridSize - 1 ||
            idx === gridSize * (gridSize - 1) ||
            idx === gridSize * gridSize - 1;

          return (
            <circle
              key={`node-${idx}`}
              cx={sPos.x}
              cy={sPos.y}
              r={isCorner ? 7 : 5}
              fill={isCorner ? '#818CF8' : '#C7D2FE'}
              stroke="#312E81"
              strokeWidth="2"
              className="pointer-events-auto touch-none cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => startDrag(idx, e)}
              onPointerMove={moveNode}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          );
        })}
      </svg>

      <CanvasActionBar onApply={handleApply} onCancel={onCancel}>
        <BarSelect label="變形模式" value={mode as DistortMode | 'transform'}
          options={[{ id: 'transform', label: '自由變形' }, ...DISTORT_MODES]} onChange={onChangeMode} />
        {mode === 'mesh' && (
          <Segmented label="網格密度" value={String(gridSize)} onChange={(v) => setGridSize(Number(v))}
            options={[3, 4, 5].map((n) => ({ id: String(n), label: `${n}×${n}` }))} />
        )}
        <button type="button" onClick={() => initGrid(gridSize)} title="重設所有控制點" className="atelier-btn atelier-btn--ghost">
          <RefreshCw />重設
        </button>
      </CanvasActionBar>
    </div>
  );
};
