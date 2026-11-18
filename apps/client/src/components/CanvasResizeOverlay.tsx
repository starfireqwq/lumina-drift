import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import {
  boxToOffset,
  inferAnchorFromBox,
  resizeBoxWithHandle,
  type AnchorKey,
  type ResizeBox,
  type ResizeHandle,
} from '../utils/canvasResize';

interface Point {
  x: number;
  y: number;
}

interface CanvasResizeOverlayProps {
  isActive: boolean;
  oldWidth: number;
  oldHeight: number;
  box: ResizeBox;
  lockAspect: boolean;
  onChangeBox: (next: ResizeBox, anchorHint: AnchorKey | null) => void;
  onModifiersChange?: (mods: { shift: boolean; alt: boolean }) => void;
  canvasToScreen: (cx: number, cy: number) => Point;
  screenToCanvas: (sx: number, sy: number) => Point;
}

const HANDLE_LIST: Array<{ key: ResizeHandle; u: number; v: number; isCorner: boolean; nx: number; ny: number }> = [
  { key: 'nw', u: 0, v: 0, isCorner: true, nx: -1, ny: -1 },
  { key: 'n', u: 0.5, v: 0, isCorner: false, nx: 0, ny: -1 },
  { key: 'ne', u: 1, v: 0, isCorner: true, nx: 1, ny: -1 },
  { key: 'e', u: 1, v: 0.5, isCorner: false, nx: 1, ny: 0 },
  { key: 'se', u: 1, v: 1, isCorner: true, nx: 1, ny: 1 },
  { key: 's', u: 0.5, v: 1, isCorner: false, nx: 0, ny: 1 },
  { key: 'sw', u: 0, v: 1, isCorner: true, nx: -1, ny: 1 },
  { key: 'w', u: 0, v: 0.5, isCorner: false, nx: -1, ny: 0 },
];

const EDGE_STRIP_KEYS: Array<{ key: ResizeHandle; a: number; b: number; nx: number; ny: number }> = [
  { key: 'n', a: 0, b: 1, nx: 0, ny: -1 },
  { key: 'e', a: 1, b: 2, nx: 1, ny: 0 },
  { key: 's', a: 2, b: 3, nx: 0, ny: 1 },
  { key: 'w', a: 3, b: 0, nx: -1, ny: 0 },
];

function cursorForDirection(dx: number, dy: number): string {
  const angle = (((Math.atan2(dy, dx) * 180) / Math.PI) % 180 + 180) % 180;
  if (angle < 22.5 || angle >= 157.5) return 'ew-resize';
  if (angle < 67.5) return 'nwse-resize';
  if (angle < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

/**
 * Interactive canvas edge/corner resize frame projected through the viewport transform.
 * Dragging handles updates canvas width/height/anchor live; Shift locks aspect ratio and Alt
 * scales symmetrically around the box center.
 */
export const CanvasResizeOverlay: React.FC<CanvasResizeOverlayProps> = ({
  isActive,
  oldWidth,
  oldHeight,
  box,
  lockAspect,
  onChangeBox,
  onModifiersChange,
  canvasToScreen,
  screenToCanvas,
}) => {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [viewSize, setViewSize] = useState<{ w: number; h: number }>({ w: 2000, h: 1200 });
  const [draggingHandle, setDraggingHandle] = useState<ResizeHandle | null>(null);
  const [mods, setMods] = useState<{ shift: boolean; alt: boolean }>({ shift: false, alt: false });

  const latestRef = useRef({
    box,
    oldWidth,
    oldHeight,
    lockAspect,
    onChangeBox,
    onModifiersChange,
    screenToCanvas,
  });
  latestRef.current = {
    box,
    oldWidth,
    oldHeight,
    lockAspect,
    onChangeBox,
    onModifiersChange,
    screenToCanvas,
  };

  const dragRef = useRef<{
    handle: ResizeHandle;
    startBox: ResizeBox;
    startCanvas: Point;
    lastClient: Point;
    aspect: number;
  } | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !isActive) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setViewSize({ w: r.width, h: r.height });
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    window.addEventListener('resize', sync);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;

    const applyFromClient = (clientX: number, clientY: number, shift: boolean, alt: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      const cur = latestRef.current;
      const canvasPt = cur.screenToCanvas(clientX, clientY);
      const next = resizeBoxWithHandle(
        drag.startBox,
        drag.handle,
        canvasPt.x - drag.startCanvas.x,
        canvasPt.y - drag.startCanvas.y,
        cur.lockAspect || shift,
        alt,
        drag.aspect
      );
      cur.onChangeBox(next, inferAnchorFromBox(next, cur.oldWidth, cur.oldHeight));
    };

    const onKey = (ev: KeyboardEvent) => {
      const nextMods = { shift: ev.shiftKey, alt: ev.altKey };
      setMods(nextMods);
      latestRef.current.onModifiersChange?.(nextMods);
      if (dragRef.current) {
        if (ev.altKey) ev.preventDefault();
        applyFromClient(dragRef.current.lastClient.x, dragRef.current.lastClient.y, ev.shiftKey, ev.altKey);
      }
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [isActive]);

  if (!isActive) return null;

  const corners: [Point, Point, Point, Point] = [
    canvasToScreen(box.x, box.y),
    canvasToScreen(box.x + box.width, box.y),
    canvasToScreen(box.x + box.width, box.y + box.height),
    canvasToScreen(box.x, box.y + box.height),
  ];

  const oldCorners: [Point, Point, Point, Point] = [
    canvasToScreen(0, 0),
    canvasToScreen(oldWidth, 0),
    canvasToScreen(oldWidth, oldHeight),
    canvasToScreen(0, oldHeight),
  ];

  const hasDelta = box.x !== 0 || box.y !== 0 || box.width !== oldWidth || box.height !== oldHeight;
  const ptsStr = corners.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const oldPtsStr = oldCorners.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const maskPath = `M0,0 H${viewSize.w} V${viewSize.h} H0 Z M${corners[0].x.toFixed(1)},${corners[0].y.toFixed(1)} L${corners[1].x.toFixed(1)},${corners[1].y.toFixed(1)} L${corners[2].x.toFixed(1)},${corners[2].y.toFixed(1)} L${corners[3].x.toFixed(1)},${corners[3].y.toFixed(1)} Z`;

  const screenDir = (nx: number, ny: number): Point => {
    const o = canvasToScreen(0, 0);
    const p = canvasToScreen(nx, ny);
    return { x: p.x - o.x, y: p.y - o.y };
  };

  const startHandleDrag = (handle: ResizeHandle, e: React.PointerEvent<Element>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      handle,
      startBox: { ...box },
      startCanvas: screenToCanvas(e.clientX, e.clientY),
      lastClient: { x: e.clientX, y: e.clientY },
      aspect: box.width / Math.max(1, box.height),
    };
    setDraggingHandle(handle);
    const m = { shift: e.shiftKey, alt: e.altKey };
    setMods(m);
    onModifiersChange?.(m);
  };

  const moveHandleDrag = (e: React.PointerEvent<Element>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    drag.lastClient = { x: e.clientX, y: e.clientY };
    const m = { shift: e.shiftKey, alt: e.altKey };
    setMods(m);
    onModifiersChange?.(m);
    const canvasPt = screenToCanvas(e.clientX, e.clientY);
    const next = resizeBoxWithHandle(
      drag.startBox,
      drag.handle,
      canvasPt.x - drag.startCanvas.x,
      canvasPt.y - drag.startCanvas.y,
      lockAspect || e.shiftKey,
      e.altKey,
      drag.aspect
    );
    onChangeBox(next, inferAnchorFromBox(next, oldWidth, oldHeight));
  };

  const endHandleDrag = (e: React.PointerEvent<Element>) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {}
    dragRef.current = null;
    setDraggingHandle(null);
  };

  const minScreenY = Math.min(...corners.map((c) => c.y));
  const avgScreenX = corners.reduce((acc, c) => acc + c.x, 0) / 4;
  const badgeX = Math.max(96, Math.min(viewSize.w - 96, avgScreenX));
  const badgeY = Math.max(12, Math.min(viewSize.h - 44, minScreenY > 46 ? minScreenY - 34 : Math.min(...corners.map((c) => c.y)) + 12));
  const { offsetX, offsetY } = boxToOffset(box);

  return (
    <div
      ref={rootRef}
      data-canvas-resize-overlay="true"
      className="pointer-events-none absolute inset-0 z-30 select-none overflow-hidden"
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <path d={maskPath} fill="rgba(5, 6, 12, 0.52)" fillRule="evenodd" />

        {hasDelta && (
          <polygon
            points={oldPtsStr}
            fill="none"
            stroke="rgba(148, 163, 184, 0.65)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}

        <polygon
          points={ptsStr}
          fill="none"
          stroke="#6366f1"
          strokeWidth={2}
        />
        <polygon
          points={ptsStr}
          fill="none"
          stroke="rgba(255, 255, 255, 0.85)"
          strokeWidth={1}
          strokeDasharray="6 4"
        />

        {EDGE_STRIP_KEYS.map((edge) => {
          const pa = corners[edge.a];
          const pb = corners[edge.b];
          const dir = screenDir(edge.nx, edge.ny);
          return (
            <line
              key={edge.key}
              data-resize-edge={edge.key}
              data-canvas-resize-overlay="true"
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              stroke="transparent"
              strokeWidth={14}
              style={{ pointerEvents: 'stroke', cursor: cursorForDirection(dir.x, dir.y), touchAction: 'none' }}
              onPointerDown={(e) => startHandleDrag(edge.key, e)}
              onPointerMove={moveHandleDrag}
              onPointerUp={endHandleDrag}
              onPointerCancel={endHandleDrag}
            />
          );
        })}
      </svg>

      {HANDLE_LIST.map((h) => {
        const pt = canvasToScreen(box.x + box.width * h.u, box.y + box.height * h.v);
        const dir = screenDir(h.nx, h.ny);
        const active = draggingHandle === h.key;
        const edgeAngle = h.isCorner
          ? 0
          : h.key === 'n' || h.key === 's'
            ? (Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180) / Math.PI
            : (Math.atan2(corners[2].y - corners[1].y, corners[2].x - corners[1].x) * 180) / Math.PI;
        return (
          <button
            key={h.key}
            type="button"
            aria-label={`${t.canvas.handleAriaLabel}: ${h.key}`}
            data-resize-handle={h.key}
            data-canvas-resize-overlay="true"
            onPointerDown={(e) => startHandleDrag(h.key, e)}
            onPointerMove={moveHandleDrag}
            onPointerUp={endHandleDrag}
            onPointerCancel={endHandleDrag}
            style={{
              left: pt.x,
              top: pt.y,
              cursor: cursorForDirection(dir.x, dir.y),
              touchAction: 'none',
              transform: h.isCorner ? 'translate(-50%, -50%)' : `translate(-50%, -50%) rotate(${edgeAngle.toFixed(1)}deg)`,
            }}
            className={`pointer-events-auto absolute flex items-center justify-center border shadow-md transition-colors ${
              h.isCorner
                ? `h-3.5 w-3.5 rounded-[3px] ${active ? 'border-white bg-indigo-500 scale-110' : 'border-indigo-500 bg-white hover:bg-indigo-100'}`
                : `h-2.5 w-6 rounded-full ${active ? 'border-white bg-indigo-500 scale-110' : 'border-indigo-500 bg-white hover:bg-indigo-100'}`
            }`}
          />
        );
      })}

      <div
        className="pointer-events-none absolute flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-indigo-400/50 bg-neutral-950/90 px-2.5 py-1 text-[11px] font-medium text-neutral-100 shadow-lg backdrop-blur-sm"
        style={{ left: badgeX, top: badgeY }}
      >
        <span className="tabular-nums font-semibold text-white">
          {box.width} × {box.height} px
        </span>
        {(offsetX !== 0 || offsetY !== 0) && (
          <span className="tabular-nums text-neutral-400">
            {t.canvas.offset} {offsetX > 0 ? `+${offsetX}` : offsetX}, {offsetY > 0 ? `+${offsetY}` : offsetY}
          </span>
        )}
        {(mods.shift || lockAspect) && (
          <span className="rounded bg-indigo-500/30 px-1.5 py-0.5 text-[10px] text-indigo-200">{t.canvas.shiftConstraint}</span>
        )}
        {mods.alt && (
          <span className="rounded bg-amber-500/30 px-1.5 py-0.5 text-[10px] text-amber-200">{t.canvas.altSymmetric}</span>
        )}
      </div>
    </div>
  );
};
