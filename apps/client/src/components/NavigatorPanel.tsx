import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { FlipHorizontal2, FlipVertical2, Maximize2, Minus, Plus, RotateCcw, RotateCw, Scan } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import type { ViewportState } from '../engine/Viewport';
import {
  canvasPointToPreview, computeNavigatorFit, computeViewportPolygonInCanvas, normalizeRotationDegrees,
  previewPointToCanvas, screenPointToCanvas, sliderToZoomPercent, zoomPercentToSlider,
} from '../utils/navigatorMath';

export interface NavigatorPanelProps {
  canvasWidth: number;
  canvasHeight: number;
  viewportState: ViewportState;
  displayScale: number;
  viewSize: { width: number; height: number };
  renderPreview: (canvas: HTMLCanvasElement, maxSide: number) => boolean;
  previewRevision: number;
  subscribePreview?: (refresh: () => void) => () => void;
  onPanToCanvasPoint: (cx: number, cy: number) => void;
  onSetZoomPercent: (percent: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFitView: () => void;
  onResetView: () => void;
  onSetRotationDeg: (deg: number) => void;
  onRotateByDeg: (deltaDeg: number) => void;
  onResetRotation: () => void;
  onToggleMirrorX: () => void;
  onToggleMirrorY: () => void;
}

const REFRESH_INTERVAL = 150;
const PREVIEW_MAX_SIDE = 280;
const sliderClass = 'h-6 min-w-0 flex-1 cursor-pointer accent-indigo-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 [@media(pointer:coarse)]:h-9';

function NavigatorButton({ label, onClick, children, pressed, testId, className = 'min-w-6 px-0.5' }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={pressed} onClick={onClick} data-testid={testId}
      className={`atelier-icon-btn h-6 shrink-0 text-[11px] tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 [&_svg]:size-3.5 [@media(pointer:coarse)]:h-9 ${className}`}>
      {children}
    </button>
  );
}

export function NavigatorPanel({
  canvasWidth, canvasHeight, viewportState, displayScale, viewSize, renderPreview, previewRevision, subscribePreview,
  onPanToCanvasPoint, onSetZoomPercent, onZoomIn, onZoomOut, onResetZoom, onFitView, onResetView,
  onSetRotationDeg, onRotateByDeg, onResetRotation, onToggleMirrorX, onToggleMirrorY,
}: NavigatorPanelProps) {
  const { t } = useI18n();
  const labels = t.navigator;
  const previewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const refreshRef = useRef<() => void>(() => {});
  const dragRef = useRef<{ pointerId: number; frame: number; point: { x: number; y: number } | null } | null>(null);
  const clipId = useId();
  const mirrorX = Boolean(viewportState.mirrorX);
  const mirrorY = Boolean(viewportState.mirrorY);
  const zoomPercent = viewportState.zoom * displayScale * 100;
  const rotationDeg = normalizeRotationDegrees(viewportState.rotation);
  const zoomPercentRef = useRef(zoomPercent);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const measure = (width: number, height: number) => {
      setBox((current) => current.width === width && current.height === height ? current : { width, height });
    };
    measure(preview.clientWidth, preview.clientHeight);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width, entry.contentRect.height));
    observer.observe(preview);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRefresh = -Infinity;
    const refresh = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        lastRefresh = performance.now();
        if (canvasRef.current) renderPreview(canvasRef.current, PREVIEW_MAX_SIDE);
      }, Math.max(0, REFRESH_INTERVAL - (performance.now() - lastRefresh)));
    };
    refreshRef.current = refresh;
    const unsubscribe = subscribePreview?.(refresh);
    refresh();
    return () => {
      unsubscribe?.();
      clearTimeout(timer);
    };
  }, [renderPreview, subscribePreview]);

  useEffect(() => refreshRef.current(), [previewRevision]);
  useEffect(() => () => cancelAnimationFrame(dragRef.current?.frame ?? 0), []);

  useLayoutEffect(() => { zoomPercentRef.current = zoomPercent; }, [zoomPercent]);
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? preview.clientHeight : 1;
      const delta = Math.max(-160, Math.min(160, event.deltaY * unit));
      const percent = sliderToZoomPercent(zoomPercentToSlider(zoomPercentRef.current * Math.exp(-delta * 0.0025)));
      zoomPercentRef.current = percent;
      onSetZoomPercent(percent);
    };
    preview.addEventListener('wheel', onWheel, { passive: false });
    return () => preview.removeEventListener('wheel', onWheel);
  }, [onSetZoomPercent]);

  const fit = computeNavigatorFit(canvasWidth, canvasHeight, box.width, box.height);
  const { points, coversFullCanvas } = computeViewportPolygonInCanvas(
    viewportState, viewSize.width, viewSize.height, canvasWidth, canvasHeight,
  );
  const vertices = points.map(({ x, y }) => canvasPointToPreview(x, y, fit, mirrorX, mirrorY, canvasWidth, canvasHeight));
  const polygonPoints = vertices.map(({ x, y }) => `${x},${y}`).join(' ');
  const shadePath = `M${fit.x} ${fit.y}h${fit.width}v${fit.height}h${-fit.width}Z M${polygonPoints}Z`;
  const panTo = (x: number, y: number) => onPanToCanvasPoint(
    Math.max(0, Math.min(canvasWidth, x)), Math.max(0, Math.min(canvasHeight, y)),
  );
  const pointerToCanvas = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return previewPointToCanvas(event.clientX - rect.left, event.clientY - rect.top, fit, mirrorX, mirrorY, canvasWidth, canvasHeight);
  };
  const endDrag = (pointerId: number, applyPending: boolean) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== pointerId) return;
    dragRef.current = null;
    cancelAnimationFrame(drag.frame);
    if (applyPending && drag.point) panTo(drag.point.x, drag.point.y);
  };

  return (
    <div className="atelier-chrome flex h-full min-h-24 min-w-0 flex-col gap-1 p-1 [@media(pointer:coarse)]:min-h-56"
      onKeyDown={(event) => { if (event.code === 'Space' || event.key.startsWith('Arrow')) event.stopPropagation(); }}>
      <div ref={previewRef} data-testid="navigator-preview" role="group" tabIndex={0} aria-label={labels.preview}
        className="relative min-h-9 min-w-0 flex-1 touch-none cursor-crosshair select-none overflow-hidden rounded-md bg-[#202024] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 active:cursor-grabbing"
        style={{ backgroundImage: 'conic-gradient(#29292e 25%, transparent 0 50%, #29292e 0 75%, transparent 0)', backgroundSize: '14px 14px' }}
        onPointerDown={(event) => {
          if (event.button !== 0 || dragRef.current || !fit.scale) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, frame: 0, point: null };
          const { x, y } = pointerToCanvas(event);
          panTo(x, y);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag?.pointerId !== event.pointerId || !fit.scale) return;
          drag.point = pointerToCanvas(event);
          if (drag.frame) return;
          drag.frame = requestAnimationFrame(() => {
            drag.frame = 0;
            const point = drag.point;
            drag.point = null;
            if (point) panTo(point.x, point.y);
          });
        }}
        onPointerUp={(event) => endDrag(event.pointerId, true)}
        onPointerCancel={(event) => endDrag(event.pointerId, false)}
        onLostPointerCapture={(event) => endDrag(event.pointerId, false)}
        onKeyDown={(event) => {
          const horizontal = Number(event.key === 'ArrowRight') - Number(event.key === 'ArrowLeft');
          const vertical = Number(event.key === 'ArrowDown') - Number(event.key === 'ArrowUp');
          if ((!horizontal && !vertical) || !fit.scale) return;
          event.preventDefault();
          event.stopPropagation();
          const center = screenPointToCanvas(viewSize.width / 2, viewSize.height / 2, viewportState, canvasWidth, canvasHeight);
          const step = 8 / fit.scale;
          panTo(center.x + horizontal * step * (mirrorX ? -1 : 1), center.y + vertical * step * (mirrorY ? -1 : 1));
        }}>
        <canvas ref={canvasRef} data-testid="navigator-canvas" width={1} height={1} aria-hidden="true"
          className="pointer-events-none absolute shadow-sm"
          style={{ left: fit.x, top: fit.y, width: fit.width, height: fit.height, transform: `scale(${mirrorX ? -1 : 1}, ${mirrorY ? -1 : 1})` }} />
        <svg data-testid="navigator-viewport-overlay" aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
          <defs>
            <clipPath id={clipId}><rect x={fit.x} y={fit.y} width={fit.width} height={fit.height} /></clipPath>
          </defs>
          {fit.scale > 0 && (
            <>
              {coversFullCanvas
                ? <rect x={fit.x} y={fit.y} width={fit.width} height={fit.height} fill="none" stroke="#ef4444" strokeOpacity={0.65} />
                : <path d={shadePath} fill="rgba(0, 0, 0, 0.30)" fillRule="evenodd" clipPath={`url(#${clipId})`} />}
              <polygon data-testid="navigator-red-box" points={polygonPoints} stroke="#ef4444" strokeWidth="2"
                strokeLinejoin="round" fill="rgba(239, 68, 68, 0.08)" />
            </>
          )}
        </svg>
      </div>

      <div role="group" aria-label={labels.zoom} className="flex min-w-0 shrink-0 items-center gap-px">
        <input type="range" min={0} max={1000} value={zoomPercentToSlider(zoomPercent)}
          aria-label={labels.zoom} aria-valuetext={`${zoomPercent.toFixed(1)}%`} title={labels.zoom}
          onChange={(event) => onSetZoomPercent(sliderToZoomPercent(event.currentTarget.valueAsNumber))}
          data-testid="navigator-zoom-slider" className={sliderClass} />
        <NavigatorButton label={`${zoomPercent.toFixed(1)}% · ${labels.actualSize}`} testId="navigator-zoom-value" onClick={onResetZoom}
          className="w-[52px] justify-end pr-1">{zoomPercent.toFixed(1)}%</NavigatorButton>
        <NavigatorButton label={labels.zoomOut} onClick={onZoomOut}><Minus /></NavigatorButton>
        <NavigatorButton label={labels.zoomIn} onClick={onZoomIn}><Plus /></NavigatorButton>
        <NavigatorButton label={labels.actualSize} onClick={onResetZoom}>1:1</NavigatorButton>
        <NavigatorButton label={labels.fit} onClick={onFitView}><Maximize2 /></NavigatorButton>
        <NavigatorButton label={labels.resetView} onClick={onResetView}><Scan /></NavigatorButton>
      </div>
      <div role="group" aria-label={labels.rotation} className="-mt-1 flex min-w-0 shrink-0 items-center gap-px">
        <input type="range" min={-180} max={180} step={0.1} value={rotationDeg}
          aria-label={labels.rotation} aria-valuetext={`${rotationDeg.toFixed(1)}°`} title={labels.rotation}
          onChange={(event) => onSetRotationDeg(event.currentTarget.valueAsNumber)}
          data-testid="navigator-rotation-slider" className={sliderClass} />
        <NavigatorButton label={`${rotationDeg.toFixed(1)}° · ${labels.resetRotation}`} testId="navigator-rotation-value" onClick={onResetRotation}
          className="w-[52px] justify-end pr-1">{rotationDeg.toFixed(1)}°</NavigatorButton>
        <NavigatorButton label={labels.rotateLeft} onClick={() => onRotateByDeg(-15)}><RotateCcw /></NavigatorButton>
        <NavigatorButton label={labels.rotateRight} onClick={() => onRotateByDeg(15)}><RotateCw /></NavigatorButton>
        <NavigatorButton label={labels.resetRotation} onClick={onResetRotation}>0°</NavigatorButton>
        <NavigatorButton label={labels.mirrorX} pressed={mirrorX} onClick={onToggleMirrorX}><FlipHorizontal2 /></NavigatorButton>
        <NavigatorButton label={labels.mirrorY} pressed={mirrorY} onClick={onToggleMirrorY}><FlipVertical2 /></NavigatorButton>
      </div>
    </div>
  );
}
