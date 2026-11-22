import React, { useEffect, useMemo, useRef, useState } from 'react';
import { applyAffinePoint } from '@atelier/shared';
import {
  LightTableExternalRef,
  LightTableItemTransform,
  LightTableState,
  externalRefsFor,
  getLightTableTransform,
  lightTableTransformToAffine,
  updateLightTableTransform,
} from '../engine/lightTable';
import { getLightTableAssetUrl } from '../engine/lightTableAssets';

export interface LightTableOverlayProps {
  lightTable: LightTableState;
  activeFolderId: string | null;
  currentCelId: string | null;
  canvasWidth: number;
  canvasHeight: number;
  /** Interactive on-canvas reference drag/scale/rotate mode */
  dragMode: boolean;
  selectedRefId: string | null;
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  screenToCanvas: (sx: number, sy: number) => { x: number; y: number };
  onUpdateLightTable: (fn: (s: LightTableState) => LightTableState) => void;
}

type DragKind = 'move' | 'scale' | 'rotate';

interface DragState {
  kind: DragKind;
  pointerId: number;
  refId: string;
  startCanvas: { x: number; y: number };
  startTransform: LightTableItemTransform;
  centerCanvas: { x: number; y: number };
  startDist: number;
  startAngle: number;
}

/**
 * Local-only overlay for Phase E2 Light Table:
 * 1. Renders local IndexedDB external reference images aligned to canvas coordinates with full
 *    per-reference transform (position, scale, rotation, flipX/Y), opacity, and tint styling.
 * 2. When `dragMode` is active, renders interactive move/scale/rotate handles for the currently
 *    selected reference (either a canvas cel or an external image) without touching layer pixels.
 */
export const LightTableOverlay: React.FC<LightTableOverlayProps> = ({
  lightTable,
  activeFolderId,
  currentCelId,
  canvasWidth,
  canvasHeight,
  dragMode,
  selectedRefId,
  canvasToScreen,
  screenToCanvas,
  onUpdateLightTable,
}) => {
  const visibleExternalRefs = useMemo(
    () => externalRefsFor(lightTable, activeFolderId, currentCelId, { visibleOnly: true }),
    [lightTable, activeFolderId, currentCelId]
  );

  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const missing = visibleExternalRefs.filter((r) => !assetUrls[r.id]);
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (ref) => [ref.id, await getLightTableAssetUrl(ref.id)] as const)
    ).then((pairs) => {
      if (cancelled) return;
      const patch: Record<string, string> = {};
      for (const [id, url] of pairs) {
        if (url) patch[id] = url;
      }
      if (Object.keys(patch).length > 0) {
        setAssetUrls((prev) => ({ ...prev, ...patch }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visibleExternalRefs, assetUrls]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const cur = screenToCanvas(e.clientX, e.clientY);
      const base = drag.startTransform;
      if (drag.kind === 'move') {
        const dx = cur.x - drag.startCanvas.x;
        const dy = cur.y - drag.startCanvas.y;
        onUpdateLightTable((s) =>
          updateLightTableTransform(s, drag.refId, {
            x: Math.round((base.x + dx) * 10) / 10,
            y: Math.round((base.y + dy) * 10) / 10,
          })
        );
      } else if (drag.kind === 'scale') {
        const dist = Math.hypot(cur.x - drag.centerCanvas.x, cur.y - drag.centerCanvas.y);
        const factor = Math.max(0.1, dist / Math.max(12, drag.startDist));
        const nextScale = Math.max(0.1, Math.min(5, Math.round(base.scale * factor * 100) / 100));
        onUpdateLightTable((s) => updateLightTableTransform(s, drag.refId, { scale: nextScale }));
      } else if (drag.kind === 'rotate') {
        const angle = Math.atan2(cur.y - drag.centerCanvas.y, cur.x - drag.centerCanvas.x);
        let deg = base.rotation + ((angle - drag.startAngle) * 180) / Math.PI;
        while (deg > 180) deg -= 360;
        while (deg < -180) deg += 360;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        onUpdateLightTable((s) =>
          updateLightTableTransform(s, drag.refId, { rotation: Math.round(deg * 10) / 10 })
        );
      }
    };
    const onUp = (e: PointerEvent) => {
      if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
        dragRef.current = null;
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [screenToCanvas, onUpdateLightTable]);

  if (!lightTable.enabled) return null;
  if (visibleExternalRefs.length === 0 && (!dragMode || !selectedRefId)) return null;

  // Compute canvas->screen 2D affine matrix from 3 basis points (0,0), (1,0), (0,1)
  const o = canvasToScreen(0, 0);
  const ex = canvasToScreen(1, 0);
  const ey = canvasToScreen(0, 1);
  const c2s = {
    a: ex.x - o.x,
    b: ex.y - o.y,
    c: ey.x - o.x,
    d: ey.y - o.y,
    tx: o.x,
    ty: o.y,
  };

  const renderExternalRef = (ref: LightTableExternalRef) => {
    const url = assetUrls[ref.id];
    if (!url) return null;
    const tr = getLightTableTransform(lightTable, ref.id);
    const m = lightTableTransformToAffine(tr, canvasWidth, canvasHeight);
    // Fit external image initially centered inside canvas bounds
    const fitScale = Math.min(1, canvasWidth / Math.max(1, ref.width), canvasHeight / Math.max(1, ref.height));
    const drawW = ref.width * fitScale;
    const drawH = ref.height * fitScale;
    const left = (canvasWidth - drawW) / 2;
    const top = (canvasHeight - drawH) / 2;
    const opacity = Math.max(0.02, Math.min(1, lightTable.opacity * tr.opacity));
    const filterId = `lt-tint-${ref.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const hasTint = tr.tintMode !== 'original' && Boolean(tr.tint);

    return (
      <g
        key={ref.id}
        transform={`matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.tx} ${m.ty})`}
        opacity={opacity}
      >
        {hasTint && (
          <defs>
            <filter id={filterId} colorInterpolationFilters="sRGB">
              <feFlood floodColor={tr.tint!} floodOpacity={tr.tintMode === 'shade' ? 0.65 : 0.9} result="flood" />
              <feComposite in="flood" in2="SourceAlpha" operator="in" result="colored" />
              {tr.tintMode === 'shade' ? (
                <feBlend in="SourceGraphic" in2="colored" mode="multiply" />
              ) : (
                <feMerge>
                  <feMergeNode in="colored" />
                </feMerge>
              )}
            </filter>
          </defs>
        )}
        <image
          href={url}
          x={left}
          y={top}
          width={drawW}
          height={drawH}
          preserveAspectRatio="none"
          filter={hasTint ? `url(#${filterId})` : undefined}
        />
      </g>
    );
  };

  // Interactive reference handle box when dragMode is enabled
  let handleNode: React.ReactNode = null;
  if (dragMode && selectedRefId) {
    const tr = getLightTableTransform(lightTable, selectedRefId);
    const m = lightTableTransformToAffine(tr, canvasWidth, canvasHeight);
    const ext = visibleExternalRefs.find((r) => r.id === selectedRefId);
    const fitScale = ext
      ? Math.min(1, canvasWidth / Math.max(1, ext.width), canvasHeight / Math.max(1, ext.height))
      : 1;
    const boxW = ext ? ext.width * fitScale : canvasWidth;
    const boxH = ext ? ext.height * fitScale : canvasHeight;
    const left = (canvasWidth - boxW) / 2;
    const top = (canvasHeight - boxH) / 2;
    const canvasCorners = [
      applyAffinePoint(m, left, top),
      applyAffinePoint(m, left + boxW, top),
      applyAffinePoint(m, left + boxW, top + boxH),
      applyAffinePoint(m, left, top + boxH),
    ];
    const centerCanvas = applyAffinePoint(m, canvasWidth / 2, canvasHeight / 2);
    const screenCorners = canvasCorners.map((p) => canvasToScreen(p.x, p.y));
    const screenCenter = canvasToScreen(centerCanvas.x, centerCanvas.y);
    const poly = screenCorners.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const topMid = {
      x: (screenCorners[0].x + screenCorners[1].x) / 2,
      y: (screenCorners[0].y + screenCorners[1].y) / 2,
    };
    const dx = topMid.x - screenCenter.x;
    const dy = topMid.y - screenCenter.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const rotHandle = { x: topMid.x + (dx / len) * 24, y: topMid.y + (dy / len) * 24 };

    const begin = (kind: DragKind) => (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const startCanvas = screenToCanvas(e.clientX, e.clientY);
      dragRef.current = {
        kind,
        pointerId: e.pointerId,
        refId: selectedRefId,
        startCanvas,
        startTransform: { ...tr },
        centerCanvas,
        startDist: Math.hypot(startCanvas.x - centerCanvas.x, startCanvas.y - centerCanvas.y),
        startAngle: Math.atan2(startCanvas.y - centerCanvas.y, startCanvas.x - centerCanvas.x),
      };
    };

    handleNode = (
      <g data-testid="light-table-drag-handles">
        <polygon
          points={poly}
          fill="rgba(245, 158, 11, 0.04)"
          stroke="#f59e0b"
          strokeWidth={1.75}
          strokeDasharray="6 4"
          className="pointer-events-auto cursor-move touch-none"
          onPointerDown={begin('move')}
        />
        <line x1={topMid.x} y1={topMid.y} x2={rotHandle.x} y2={rotHandle.y} stroke="#f59e0b" strokeWidth={1.5} />
        <g
          transform={`translate(${rotHandle.x}, ${rotHandle.y})`}
          className="pointer-events-auto cursor-grab touch-none"
          onPointerDown={begin('rotate')}
        >
          <circle r={12} fill="transparent" />
          <circle r={5.5} fill="#0f172a" stroke="#f59e0b" strokeWidth={2} />
        </g>
        {screenCorners.map((pt, idx) => (
          <g
            key={`lt-c-${idx}`}
            transform={`translate(${pt.x}, ${pt.y})`}
            className="pointer-events-auto cursor-nwse-resize touch-none"
            onPointerDown={begin('scale')}
          >
            <circle r={12} fill="transparent" />
            <rect x={-5} y={-5} width={10} height={10} rx={2} fill="#0f172a" stroke="#f59e0b" strokeWidth={2} />
          </g>
        ))}
      </g>
    );
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[20] select-none overflow-hidden"
      data-testid="light-table-overlay"
    >
      <svg className="h-full w-full overflow-visible">
        <g transform={`matrix(${c2s.a} ${c2s.b} ${c2s.c} ${c2s.d} ${c2s.tx} ${c2s.ty})`}>
          {visibleExternalRefs.map(renderExternalRef)}
        </g>
        {handleNode}
      </svg>
    </div>
  );
};
