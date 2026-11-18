import React, { useRef } from 'react';
import { MAX_BRUSH_SIZE } from './toolCatalog';
import { NumberBox } from './ToolOptionsBar';
import { startDrag } from './DockSystem';
import { SLIDERS_WIDTH_MAX, SLIDERS_WIDTH_MIN } from './dockStore';
import { useWheelStep } from '../../hooks/useWheelStep';
import { useUiScale } from '../../theme/uiScale';

interface VerticalSliderProps {
  label: string;
  /** 0 (bottom) … 1 (top) */
  position: number;
  valueText: string;
  /** The number above the track: tap it to type an exact value */
  exact: { value: number; min: number; max: number; onCommit: (n: number) => void; wheelStep?: (value: number) => number };
  onChange: (position: number) => void;
  onDragChange?: (dragging: boolean) => void;
  fill: string;
  wide?: boolean;
  children?: React.ReactNode;
}

/** A tall slider made for pens and fingers: drag anywhere on the track, arrow keys or mouse wheel step it */
const VerticalSlider: React.FC<VerticalSliderProps> = ({ label, position, valueText, exact, onChange, onDragChange, fill, wide, children }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  useWheelStep(wrapRef, (steps) => {
    const unit = exact.wheelStep ? exact.wheelStep(exact.value) : 1;
    const next = Math.max(exact.min, Math.min(exact.max, exact.value + steps * unit));
    if (next !== exact.value) exact.onCommit(next);
  });
  const fromEvent = (e: React.PointerEvent) => {
    const r = trackRef.current!.getBoundingClientRect();
    onChange(Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)));
  };
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return (
    <div ref={wrapRef} className="flex min-h-0 flex-1 flex-col items-center gap-1 px-1 py-1">
      <NumberBox label={`${label}（輸入數值）`} value={exact.value} min={exact.min} max={exact.max} onCommit={exact.onCommit} width="!h-5 w-full max-w-[60px] !px-0.5 text-[10px]" />
      {children}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position * 100)}
        aria-valuetext={valueText}
        title={label}
        style={{ touchAction: 'none' }}
        className={`relative min-h-[60px] flex-1 cursor-ns-resize rounded-full border border-neutral-700 bg-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${wide ? 'w-7' : 'w-6'}`}
        onPointerDown={(e) => {
          e.stopPropagation();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
          onDragChange?.(true);
          fromEvent(e);
        }}
        onPointerMove={(e) => { if (e.buttons & 1 || e.currentTarget.hasPointerCapture?.(e.pointerId)) fromEvent(e); }}
        onPointerUp={(e) => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ } onDragChange?.(false); }}
        onPointerCancel={() => onDragChange?.(false)}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowUp' ? 0.02 : e.key === 'ArrowDown' ? -0.02 : e.key === 'PageUp' ? 0.1 : e.key === 'PageDown' ? -0.1 : 0;
          if (step) {
            e.preventDefault();
            onChange(clamp(position + step));
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            onChange(e.key === 'End' ? 1 : 0);
          }
        }}
      >
        <div className="absolute inset-x-0 bottom-0 rounded-full" style={{ height: `${position * 100}%`, background: fill }} />
        <div className="absolute left-1/2 h-3 w-[calc(100%+4px)] -translate-x-1/2 translate-y-1/2 rounded-full border border-white bg-neutral-200 shadow" style={{ bottom: `${position * 100}%` }} />
      </div>
    </div>
  );
};

interface BrushSideSlidersProps {
  size: number;
  onSize: (size: number) => void;
  opacity: number;
  onOpacity: (opacity: number) => void;
  color: string;
  /** While the size is dragged the canvas shows the real on-screen size */
  onSizeDrag: (dragging: boolean) => void;
  width?: number;
  side?: 'left' | 'right';
  onResizeWidth?: (width: number) => void;
}

const LOG_MAX = Math.log(MAX_BRUSH_SIZE);
const sizeToPos = (size: number) => Math.log(Math.max(1, size)) / LOG_MAX;
const posToSize = (pos: number) => Math.max(1, Math.min(MAX_BRUSH_SIZE, Math.round(Math.exp(pos * LOG_MAX))));

/** CSP-style strip at the far left: brush size on the top half, opacity on the bottom half */
export const BrushSideSliders: React.FC<BrushSideSlidersProps> = ({ size, onSize, opacity, onOpacity, color, onSizeDrag, width, side = 'left', onResizeWidth }) => {
  const ui = useUiScale();
  const actualWidth = width ?? Math.round(44 * ui);
  const wide = actualWidth >= 68 * ui;
  const dot = Math.max(2, Math.min(wide ? 26 : 22, Math.sqrt(size) * 2.2));
  return (
    <div
      className="atelier-chrome relative flex shrink-0 select-none flex-col border-r py-1"
      style={{ width: actualWidth }}
      role="group"
      aria-label="筆刷大小與不透明度"
    >
      <VerticalSlider label="筆刷大小" position={sizeToPos(size)} valueText={`${size}`} onChange={(p) => onSize(posToSize(p))} onDragChange={onSizeDrag}
        wide={wide}
        exact={{ value: size, min: 1, max: MAX_BRUSH_SIZE, onCommit: onSize, wheelStep: (v) => (v >= 100 ? Math.max(5, Math.round(v * 0.08)) : v >= 20 ? 2 : 1) }}
        fill="linear-gradient(to top, #4f46e5, #818cf8)">
        <span className="flex h-6 w-6 items-center justify-center" aria-hidden="true">
          <span className="rounded-full bg-neutral-100" style={{ width: dot, height: dot }} />
        </span>
      </VerticalSlider>
      <div className="mx-1.5 my-1 h-px bg-neutral-700" />
      <VerticalSlider label="筆刷不透明度" position={opacity} valueText={`${Math.round(opacity * 100)}%`} onChange={(p) => onOpacity(Math.max(0.01, Math.round(p * 100) / 100))}
        wide={wide}
        exact={{ value: Math.round(opacity * 100), min: 1, max: 100, onCommit: (n) => onOpacity(n / 100), wheelStep: () => 2 }}
        fill={`linear-gradient(to top, transparent, ${color})`}>
        <span className="h-5 w-5 rounded-full border border-neutral-600" aria-hidden="true"
          style={{ background: `linear-gradient(${color}, ${color}), repeating-conic-gradient(#555 0% 25%, #888 0% 50%) 0 0/6px 6px`, opacity: Math.max(0.15, opacity) }} />
      </VerticalSlider>
      {onResizeWidth && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="調整筆刷滑桿寬度"
          style={{ touchAction: 'none' }}
          className={`group absolute inset-y-0 z-10 w-2 cursor-col-resize ${side === 'right' ? '-left-1' : '-right-1'}`}
          onDoubleClick={() => onResizeWidth(Math.round(44 * ui))}
          onPointerDown={(e) => {
            const start = actualWidth;
            startDrag(e, (dx) => {
              const raw = start + (side === 'right' ? -dx : dx);
              onResizeWidth(Math.max(SLIDERS_WIDTH_MIN * ui, Math.min(SLIDERS_WIDTH_MAX * ui, raw)));
            });
          }}
        >
          <div className="mx-auto h-full w-0.5 bg-indigo-500/0 transition group-hover:bg-indigo-500/60" />
        </div>
      )}
    </div>
  );
};
