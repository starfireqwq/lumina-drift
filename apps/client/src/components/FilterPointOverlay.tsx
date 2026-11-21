import { useEffect, useId, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { ViewportState } from '../engine/Viewport';
import { filterPoint, type FilterPointState } from '../utils/filterPoint';
import { useI18n } from '../context/I18nContext';

interface Props {
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  screenToCanvas: (sx: number, sy: number) => { x: number; y: number };
  subscribeViewport: (cb: () => void) => () => void;
  getViewportSnapshot: () => ViewportState;
}

const noopSub = () => () => {};
const EXIT_MS = 180;

/**
 * The open filter's centre on the canvas: a handle to drag (or nudge with the arrow keys) and,
 * for filters with a radius, a dashed circle showing how far the effect reaches. A streak of
 * light runs once round the circle when it appears.
 */
export function FilterPointOverlay({ canvasToScreen, screenToCanvas, subscribeViewport, getViewportSnapshot }: Props) {
  const { t } = useI18n();
  const gradientId = useId();
  const live = useSyncExternalStore(filterPoint.subscribe, filterPoint.get, filterPoint.get);
  const visible = live?.shown ? live : null;
  // Kept for a moment after the filter closes, so the handle fades out instead of vanishing
  const [last, setLast] = useState<FilterPointState | null>(visible);
  if (visible && visible !== last) setLast(visible);
  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => setLast(null), EXIT_MS);
    return () => clearTimeout(timer);
  }, [visible]);
  const point = visible ?? last;
  const closing = !visible;
  useSyncExternalStore(point ? subscribeViewport : noopSub, getViewportSnapshot, getViewportSnapshot);
  if (!point) return null;

  const screen = canvasToScreen(point.x, point.y);
  const edge = point.radius ? canvasToScreen(point.x + point.radius, point.y) : null;
  const ring = edge ? Math.hypot(edge.x - screen.x, edge.y - screen.y) : 0;

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (closing) return;
    event.stopPropagation();
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const grab = screenToCanvas(event.clientX, event.clientY);
    const from = { x: point.x - grab.x, y: point.y - grab.y };
    const move = (e: PointerEvent) => {
      const at = screenToCanvas(e.clientX, e.clientY);
      filterPoint.move(at.x + from.x, at.y + from.y);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const nudge = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    filterPoint.move(point.x + delta[0], point.y + delta[1]);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div className="atelier-filter-point" data-closing={closing}>
        {ring > 0 && (
          <svg aria-hidden className="atelier-filter-point-ring absolute overflow-visible"
            style={{ left: screen.x, top: screen.y, width: 1, height: 1 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="rgb(var(--a-400))" />
                <stop offset="1" stopColor="rgb(251 113 133)" />
              </linearGradient>
            </defs>
            <circle r={ring} fill="none" stroke="rgb(0 0 0 / .55)" strokeWidth={3} />
            <circle r={ring} fill="none" stroke="rgb(var(--a-400) / .9)" strokeWidth={1.25} strokeDasharray="6 5" />
            <circle className="sweep" r={ring} fill="none" stroke={`url(#${gradientId})`} strokeWidth={2.5}
              strokeLinecap="round" pathLength={100} strokeDasharray="16 84" />
          </svg>
        )}
        <button type="button" aria-label={t.filters.dragCenter} title={t.filters.dragCenter}
          className="pointer-events-auto absolute flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-move touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          style={{ left: screen.x, top: screen.y }} onPointerDown={startDrag} onKeyDown={nudge}>
          <span aria-hidden className="h-4 w-4 rounded-full border-2 border-indigo-400 bg-neutral-950/80 shadow-[0_0_0_1.5px_rgb(0_0_0/.6)]" />
          <span aria-hidden className="absolute h-1 w-1 rounded-full bg-white" />
        </button>
      </div>
    </div>
  );
}
