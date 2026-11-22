import React, { useRef, useState } from 'react';
import { Lock, RotateCw, Unlock } from 'lucide-react';
import {
  applyAffinePoint,
  multiplyAffine,
  transformToAffineMatrix,
  type Affine2D,
  type EvaluatedTransform,
} from '@atelier/shared';
import {
  applyKeyframeHandleDrag,
  type KeyframeBaseRect,
  type KeyframeHandleType,
} from '../utils/keyframeTransform';
import { useI18n } from '../context/I18nContext';

interface KeyframeTransformOverlayProps {
  isActive: boolean;
  baseRect: KeyframeBaseRect;
  evaluated: EvaluatedTransform;
  parentWorld: Affine2D;
  frame: number;
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  screenToCanvas: (sx: number, sy: number) => { x: number; y: number };
  onPreviewChange: (next: EvaluatedTransform | null) => void;
  onCommit: (next: EvaluatedTransform) => void;
}

const SCALE_HANDLES: ReadonlyArray<{ id: KeyframeHandleType; u: number; v: number }> = [
  { id: 'nw', u: 0, v: 0 },
  { id: 'n', u: 0.5, v: 0 },
  { id: 'ne', u: 1, v: 0 },
  { id: 'e', u: 1, v: 0.5 },
  { id: 'se', u: 1, v: 1 },
  { id: 's', u: 0.5, v: 1 },
  { id: 'sw', u: 0, v: 1 },
  { id: 'w', u: 0, v: 0.5 },
];

export const KeyframeTransformOverlay: React.FC<KeyframeTransformOverlayProps> = ({
  isActive,
  baseRect,
  evaluated,
  parentWorld,
  frame,
  canvasToScreen,
  screenToCanvas,
  onPreviewChange,
  onCommit,
}) => {
  const { t } = useI18n();
  const [maintainAspect, setMaintainAspect] = useState(true);

  const dragRef = useRef<{
    handle: KeyframeHandleType;
    startCanvas: { x: number; y: number };
    startEval: EvaluatedTransform;
    latestEval: EvaluatedTransform;
    moved: boolean;
  } | null>(null);

  if (!isActive) return null;

  const world = multiplyAffine(parentWorld, transformToAffineMatrix(evaluated));
  const localToScreen = (u: number, v: number) => {
    const cx = baseRect.x + baseRect.width * u;
    const cy = baseRect.y + baseRect.height * v;
    const wp = applyAffinePoint(world, cx, cy);
    return canvasToScreen(wp.x, wp.y);
  };

  const nw = localToScreen(0, 0);
  const ne = localToScreen(1, 0);
  const se = localToScreen(1, 1);
  const sw = localToScreen(0, 1);
  const nMid = localToScreen(0.5, 0);
  const sMid = localToScreen(0.5, 1);

  const pivWorld = applyAffinePoint(world, evaluated.pivotX, evaluated.pivotY);
  const pivScreen = canvasToScreen(pivWorld.x, pivWorld.y);

  // Rotate handle floats 28px outward along the top-edge normal
  const upDx = nMid.x - sMid.x;
  const upDy = nMid.y - sMid.y;
  const upLen = Math.hypot(upDx, upDy) || 1;
  const rotScreen = {
    x: nMid.x + (upDx / upLen) * 28,
    y: nMid.y + (upDy / upLen) * 28,
  };

  const quadPoints = `${nw.x},${nw.y} ${ne.x},${ne.y} ${se.x},${se.y} ${sw.x},${sw.y}`;

  const onPointerDown = (handle: KeyframeHandleType, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // keep dragging if capture fails
    }
    const startCanvas = screenToCanvas(e.clientX, e.clientY);
    dragRef.current = {
      handle,
      startCanvas,
      startEval: { ...evaluated },
      latestEval: { ...evaluated },
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const curCanvas = screenToCanvas(e.clientX, e.clientY);
    const next = applyKeyframeHandleDrag({
      handle: drag.handle,
      startEval: drag.startEval,
      parentWorld,
      startCanvas: drag.startCanvas,
      curCanvas,
      maintainAspect: e.shiftKey ? !maintainAspect : maintainAspect,
      snapAngle: e.shiftKey,
      axisLock: e.shiftKey,
    });
    drag.latestEval = next;
    drag.moved = true;
    onPreviewChange(next);
  };

  const finishDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    if (drag.moved) {
      onCommit(drag.latestEval);
    }
    onPreviewChange(null);
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 select-none overflow-hidden"
      data-testid="keyframe-transform-overlay"
    >
      <svg className="h-full w-full overflow-visible">
        {/* Moveable quad fill + amber/indigo keyframe outline */}
        <polygon
          points={quadPoints}
          fill="rgba(245, 158, 11, 0.06)"
          stroke="#f59e0b"
          strokeWidth={1.75}
          strokeDasharray="6 3"
          data-testid="kf-handle-move"
          className="pointer-events-auto cursor-move touch-none"
          onPointerDown={(e) => onPointerDown('move', e)}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        />

        {/* Rotation stem & handle */}
        <line
          x1={nMid.x}
          y1={nMid.y}
          x2={rotScreen.x}
          y2={rotScreen.y}
          stroke="#f59e0b"
          strokeWidth={1.5}
        />
        <g
          transform={`translate(${rotScreen.x}, ${rotScreen.y})`}
          data-testid="kf-handle-rotate"
          className="pointer-events-auto cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={(e) => onPointerDown('rotate', e)}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        >
          <circle r={16} fill="transparent" />
          <circle r={9} fill="#18181b" stroke="#f59e0b" strokeWidth={1.75} />
          <g transform="translate(-5, -5)">
            <RotateCw size={10} color="#fbbf24" />
          </g>
        </g>

        {/* 8 scale handles with enlarged touch hit area (>= 32px) */}
        {SCALE_HANDLES.map(({ id, u, v }) => {
          const pt = localToScreen(u, v);
          const isCorner = id.length === 2;
          return (
            <g
              key={id}
              transform={`translate(${pt.x}, ${pt.y})`}
              data-testid={`kf-handle-${id}`}
              className="pointer-events-auto cursor-pointer touch-none"
              onPointerDown={(e) => onPointerDown(id, e)}
              onPointerMove={onPointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
            >
              <circle r={16} fill="transparent" />
              {isCorner ? (
                <rect
                  x={-5}
                  y={-5}
                  width={10}
                  height={10}
                  rx={2}
                  fill="#ffffff"
                  stroke="#f59e0b"
                  strokeWidth={2}
                />
              ) : (
                <circle r={4.5} fill="#18181b" stroke="#f59e0b" strokeWidth={2} />
              )}
            </g>
          );
        })}

        {/* Pivot crosshair handle (repositioning compensates x/y so pixels stay put) */}
        <g
          transform={`translate(${pivScreen.x}, ${pivScreen.y})`}
          data-testid="kf-handle-pivot"
          className="pointer-events-auto cursor-crosshair touch-none"
          onPointerDown={(e) => onPointerDown('pivot', e)}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        >
          <circle r={16} fill="transparent" />
          <circle r={7} fill="rgba(24, 24, 27, 0.85)" stroke="#818cf8" strokeWidth={1.75} />
          <line x1={-10} y1={0} x2={10} y2={0} stroke="#818cf8" strokeWidth={1.25} />
          <line x1={0} y1={-10} x2={0} y2={10} stroke="#818cf8" strokeWidth={1.25} />
          <circle r={2} fill="#fbbf24" />
        </g>
      </svg>

      {/* Compact non-blocking floating pill (top-center, never covers canvas preview or timeline) */}
      <div className="pointer-events-auto absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-amber-500/35 bg-neutral-950/85 px-2.5 py-1 text-[11px] text-neutral-200 shadow-lg backdrop-blur-md">
        <span className="font-mono text-[10px] font-bold text-amber-300">
          ◆ #{frame + 1}
        </span>
        <span className="hidden text-neutral-400 sm:inline">
          {t.animation.keyframeDragHint.replace('{frame}', String(frame + 1))}
        </span>
        <button
          type="button"
          onClick={() => setMaintainAspect((v) => !v)}
          aria-pressed={maintainAspect}
          className={`flex h-6 items-center gap-1 rounded-full border px-2 text-[10px] font-bold transition-colors ${
            maintainAspect
              ? 'border-amber-500/50 bg-amber-500/20 text-amber-200'
              : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
          }`}
        >
          {maintainAspect ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
          {t.animation.keyframeLockAspect}
        </button>
      </div>
    </div>
  );
};
