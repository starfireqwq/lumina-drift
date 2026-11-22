import React, { useEffect, useRef, useState } from 'react';
import {
  CAMERA_ACTION_SAFE_RATIO,
  CAMERA_MAX_SCALE,
  CAMERA_MIN_SCALE,
  CAMERA_TITLE_SAFE_RATIO,
  CameraFrameMeta,
  CameraMotionSample,
  EvaluatedCameraFrame,
  TransformKeyframe,
  applyAffinePoint,
  evaluateCameraFrame,
  sampleCameraMotionPath,
} from '@atelier/shared';
import { EyeOff } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { upsertTransformKeyframe } from '../engine/AnimationEngine';

export interface CameraFrameOverlayProps {
  cameraMeta: CameraFrameMeta;
  keyframes: ReadonlyArray<TransformKeyframe> | undefined | null;
  currentFrame: number;
  canvasWidth: number;
  canvasHeight: number;
  /** Interactive handles enabled when camera tool window is open or camera layer is active & editable */
  interactive: boolean;
  /** Real-time "Look Through Camera" preview mode */
  previewActive: boolean;
  /** Screen-space framing rect when `previewActive` is true */
  previewFrameRect?: { x: number; y: number; width: number; height: number } | null;
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  screenToCanvas: (sx: number, sy: number) => { x: number; y: number };
  onExitPreview?: () => void;
  onSelectFrame?: (frame: number) => void;
  onCommitKeyframes?: (next: TransformKeyframe[]) => void;
}

type DragKind = 'move' | 'scale' | 'rotate';

interface DragState {
  kind: DragKind;
  pointerId: number;
  startCanvas: { x: number; y: number };
  startTransform: EvaluatedCameraFrame['transform'];
  startCenter: { x: number; y: number };
  startDist: number;
  startAngle: number;
}

const buildCameraKeyframe = (
  existing: ReadonlyArray<TransformKeyframe> | undefined | null,
  frame: number,
  tr: EvaluatedCameraFrame['transform']
): TransformKeyframe => {
  const prev = existing?.find((k) => Math.round(k.frame) === Math.round(frame));
  return {
    frame: Math.round(frame),
    x: Math.round(tr.x * 100) / 100,
    y: Math.round(tr.y * 100) / 100,
    scaleX: Math.round(tr.scaleX * 1000) / 1000,
    scaleY: Math.round(tr.scaleY * 1000) / 1000,
    rotation: Math.round(tr.rotation * 10000) / 10000,
    pivotX: tr.pivotX,
    pivotY: tr.pivotY,
    opacity: 1,
    easing: prev?.easing ?? 'easeInOut',
    ...(prev?.bezier ? { bezier: prev.bezier } : {}),
  };
};

/**
 * Local-only SVG overlay for the 2D Camera framing box:
 * - Edit mode: Lumina-styled cyan/indigo framing outline, action/title safe guides, motion path,
 *   clickable keyframe nodes, and direct move/scale/rotate handles when interactive.
 * - Preview mode: dark matte mask outside the upright camera frame + compact exit pill.
 */
export const CameraFrameOverlay: React.FC<CameraFrameOverlayProps> = ({
  cameraMeta,
  keyframes,
  currentFrame,
  canvasWidth,
  canvasHeight,
  interactive,
  previewActive,
  previewFrameRect,
  canvasToScreen,
  screenToCanvas,
  onExitPreview,
  onSelectFrame,
  onCommitKeyframes,
}) => {
  const { t } = useI18n();
  const [liveTransform, setLiveTransform] = useState<EvaluatedCameraFrame['transform'] | null>(null);
  const liveTransformRef = useRef<EvaluatedCameraFrame['transform'] | null>(null);
  liveTransformRef.current = liveTransform;
  const dragRef = useRef<DragState | null>(null);

  const effectiveKeyframes = React.useMemo(() => {
    if (!liveTransform) return keyframes ?? [];
    return upsertTransformKeyframe(keyframes, buildCameraKeyframe(keyframes, currentFrame, liveTransform));
  }, [keyframes, currentFrame, liveTransform]);

  const evaluated = React.useMemo(
    () => evaluateCameraFrame(cameraMeta, effectiveKeyframes, currentFrame, canvasWidth, canvasHeight),
    [cameraMeta, effectiveKeyframes, currentFrame, canvasWidth, canvasHeight]
  );

  const motionSamples: CameraMotionSample[] = React.useMemo(
    () => (previewActive ? [] : sampleCameraMotionPath(cameraMeta, effectiveKeyframes, canvasWidth, canvasHeight)),
    [previewActive, cameraMeta, effectiveKeyframes, canvasWidth, canvasHeight]
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const cur = screenToCanvas(e.clientX, e.clientY);
      const base = drag.startTransform;
      if (drag.kind === 'move') {
        const dx = cur.x - drag.startCanvas.x;
        const dy = cur.y - drag.startCanvas.y;
        setLiveTransform({ ...base, x: base.x + dx, y: base.y + dy, active: true });
      } else if (drag.kind === 'scale') {
        const dist = Math.hypot(cur.x - drag.startCenter.x, cur.y - drag.startCenter.y);
        const factor = Math.max(0.05, dist / Math.max(12, drag.startDist));
        const nextScale = Math.max(CAMERA_MIN_SCALE, Math.min(CAMERA_MAX_SCALE, base.scaleX * factor));
        setLiveTransform({ ...base, scaleX: nextScale, scaleY: nextScale, active: true });
      } else if (drag.kind === 'rotate') {
        const angle = Math.atan2(cur.y - drag.startCenter.y, cur.x - drag.startCenter.x);
        let nextRot = base.rotation + (angle - drag.startAngle);
        if (e.shiftKey) {
          const step = Math.PI / 12; // 15° snap
          nextRot = Math.round(nextRot / step) * step;
        }
        setLiveTransform({ ...base, rotation: nextRot, active: true });
      }
    };

    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      const committed = liveTransformRef.current;
      setLiveTransform(null);
      if (committed && onCommitKeyframes) {
        const next = upsertTransformKeyframe(keyframes, buildCameraKeyframe(keyframes, currentFrame, committed));
        onCommitKeyframes(next);
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
  }, [screenToCanvas, keyframes, currentFrame, onCommitKeyframes]);

  const startDrag = (kind: DragKind) => (e: React.PointerEvent) => {
    if (!interactive || previewActive || !onCommitKeyframes) return;
    e.stopPropagation();
    e.preventDefault();
    const startCanvas = screenToCanvas(e.clientX, e.clientY);
    const startCenter = { x: evaluated.centerX, y: evaluated.centerY };
    const startDist = Math.hypot(startCanvas.x - startCenter.x, startCanvas.y - startCenter.y);
    const startAngle = Math.atan2(startCanvas.y - startCenter.y, startCanvas.x - startCenter.x);
    dragRef.current = {
      kind,
      pointerId: e.pointerId,
      startCanvas,
      startTransform: { ...evaluated.transform },
      startCenter,
      startDist,
      startAngle,
    };
  };

  if (previewActive && previewFrameRect) {
    const { x, y, width, height } = previewFrameRect;
    const outerPath = `M -4000 -4000 H 8000 V 8000 H -4000 Z M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
    return (
      <div
        className="pointer-events-none absolute inset-0 z-[23] select-none overflow-hidden"
        data-testid="camera-preview-overlay"
      >
        <svg className="h-full w-full">
          <path d={outerPath} fill="rgba(7, 9, 14, 0.88)" fillRule="evenodd" />
          <rect
            x={x}
            y={y}
            width={width}
            height={height}
            fill="none"
            stroke="rgba(56, 189, 248, 0.85)"
            strokeWidth={1.5}
          />
          {evaluated.showSafeArea && (
            <rect
              x={x + width * ((1 - CAMERA_ACTION_SAFE_RATIO) / 2)}
              y={y + height * ((1 - CAMERA_ACTION_SAFE_RATIO) / 2)}
              width={width * CAMERA_ACTION_SAFE_RATIO}
              height={height * CAMERA_ACTION_SAFE_RATIO}
              fill="none"
              stroke="rgba(56, 189, 248, 0.28)"
              strokeWidth={1}
              strokeDasharray="5 4"
            />
          )}
        </svg>
        {onExitPreview && (
          <div className="pointer-events-auto absolute left-1/2 top-14 -translate-x-1/2">
            <button
              type="button"
              data-testid="camera-preview-exit"
              onClick={onExitPreview}
              className="flex items-center gap-1.5 rounded-full border border-sky-400/50 bg-neutral-950/85 px-3 py-1 text-xs font-medium text-sky-200 shadow-lg backdrop-blur-md transition hover:border-sky-300 hover:bg-neutral-900"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
              <span>{t.animation.cameraPreviewOn}</span>
              <EyeOff className="h-3.5 w-3.5 text-sky-300" />
            </button>
          </div>
        )}
      </div>
    );
  }

  const screenCorners = evaluated.corners.map((c) => canvasToScreen(c.x, c.y));
  const polygonStr = screenCorners.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const screenCenter = canvasToScreen(evaluated.centerX, evaluated.centerY);

  const buildInsetPolygon = (ratio: number) => {
    const hw = (evaluated.width * ratio) / 2;
    const hh = (evaluated.height * ratio) / 2;
    const cx0 = canvasWidth / 2;
    const cy0 = canvasHeight / 2;
    const pts = [
      applyAffinePoint(evaluated.cameraToCanvas, cx0 - hw, cy0 - hh),
      applyAffinePoint(evaluated.cameraToCanvas, cx0 + hw, cy0 - hh),
      applyAffinePoint(evaluated.cameraToCanvas, cx0 + hw, cy0 + hh),
      applyAffinePoint(evaluated.cameraToCanvas, cx0 - hw, cy0 + hh),
    ].map((p) => canvasToScreen(p.x, p.y));
    return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  };

  const topMid = {
    x: (screenCorners[0].x + screenCorners[1].x) / 2,
    y: (screenCorners[0].y + screenCorners[1].y) / 2,
  };
  const topNormal = (() => {
    const dx = topMid.x - screenCenter.x;
    const dy = topMid.y - screenCenter.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    return { x: dx / len, y: dy / len };
  })();
  const rotateHandle = {
    x: topMid.x + topNormal.x * 26,
    y: topMid.y + topNormal.y * 26,
  };

  const screenPath = motionSamples.map((s) => ({ ...s, ...canvasToScreen(s.x, s.y) }));
  const motionPolyline = screenPath.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[22] select-none overflow-hidden"
      data-testid="camera-frame-overlay"
    >
      <svg className="h-full w-full overflow-visible">
        <defs>
          <linearGradient id="lumina-camera-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="50%" stopColor="#818cf8" />
            <stop offset="100%" stopColor="#22d3ee" />
          </linearGradient>
        </defs>

        {/* Camera center motion path */}
        {screenPath.length >= 2 && (
          <>
            <polyline
              points={motionPolyline}
              fill="none"
              stroke="rgba(9, 9, 11, 0.55)"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <polyline
              points={motionPolyline}
              fill="none"
              stroke="#38bdf8"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {screenPath
              .filter((p) => p.isKey)
              .map((kp) => {
                const isCur = Math.round(kp.frame) === Math.round(currentFrame);
                const sz = isCur ? 6 : 4.5;
                return (
                  <g
                    key={`cam-k-${kp.frame}`}
                    transform={`translate(${kp.x}, ${kp.y})`}
                    className={onSelectFrame && !isCur ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none'}
                    onPointerDown={(e) => {
                      if (!onSelectFrame || isCur) return;
                      e.stopPropagation();
                      e.preventDefault();
                      onSelectFrame(kp.frame);
                    }}
                  >
                    {onSelectFrame && !isCur && <circle r={11} fill="transparent" />}
                    <polygon
                      points={`0,${-sz} ${sz},0 0,${sz} ${-sz},0`}
                      fill={isCur ? '#38bdf8' : '#6366f1'}
                      stroke="#ffffff"
                      strokeWidth={1.25}
                    />
                  </g>
                );
              })}
          </>
        )}

        {/* Outer shadow outline + Lumina gradient camera border */}
        <polygon
          points={polygonStr}
          fill="none"
          stroke="rgba(9, 9, 11, 0.65)"
          strokeWidth={4}
          strokeLinejoin="round"
        />
        <polygon
          points={polygonStr}
          fill="none"
          stroke="url(#lumina-camera-stroke)"
          strokeWidth={2}
          strokeLinejoin="round"
          data-testid="camera-frame-polygon"
        />

        {/* Safe area guides (90% action safe, 80% title safe) */}
        {evaluated.showSafeArea && (
          <>
            <polygon
              points={buildInsetPolygon(CAMERA_ACTION_SAFE_RATIO)}
              fill="none"
              stroke="rgba(56, 189, 248, 0.4)"
              strokeWidth={1}
              strokeDasharray="6 4"
            />
            <polygon
              points={buildInsetPolygon(CAMERA_TITLE_SAFE_RATIO)}
              fill="none"
              stroke="rgba(129, 140, 248, 0.3)"
              strokeWidth={1}
              strokeDasharray="3 4"
            />
          </>
        )}

        {/* Center crosshair */}
        <g transform={`translate(${screenCenter.x}, ${screenCenter.y})`}>
          <line x1={-7} y1={0} x2={7} y2={0} stroke="#38bdf8" strokeWidth={1.25} />
          <line x1={0} y1={-7} x2={0} y2={7} stroke="#38bdf8" strokeWidth={1.25} />
        </g>

        {/* Dimension badge at top-left corner */}
        <g transform={`translate(${screenCorners[0].x + 6}, ${screenCorners[0].y - 8})`}>
          <text
            fontSize={10}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fontWeight={600}
            fill="#bae6fd"
            stroke="rgba(9, 9, 11, 0.85)"
            strokeWidth={3}
            paintOrder="stroke"
          >
            CAM {evaluated.width}×{evaluated.height} ({Math.round(evaluated.scaleX * 100)}%)
          </text>
        </g>

        {/* Interactive handles (only when editable & active) */}
        {interactive && onCommitKeyframes && (
          <>
            {/* Center drag handle for panning camera */}
            <g
              transform={`translate(${screenCenter.x}, ${screenCenter.y})`}
              className="pointer-events-auto cursor-move touch-none"
              data-testid="camera-handle-move"
              onPointerDown={startDrag('move')}
            >
              <circle r={13} fill="rgba(14, 165, 233, 0.16)" stroke="#38bdf8" strokeWidth={1.25} />
              <circle r={3} fill="#e0f2fe" />
            </g>

            {/* Rotation stem & knob */}
            <line
              x1={topMid.x}
              y1={topMid.y}
              x2={rotateHandle.x}
              y2={rotateHandle.y}
              stroke="#38bdf8"
              strokeWidth={1.5}
            />
            <g
              transform={`translate(${rotateHandle.x}, ${rotateHandle.y})`}
              className="pointer-events-auto cursor-grab touch-none"
              data-testid="camera-handle-rotate"
              onPointerDown={startDrag('rotate')}
            >
              <circle r={12} fill="transparent" />
              <circle r={5.5} fill="#0f172a" stroke="#38bdf8" strokeWidth={2} />
            </g>

            {/* 4 corner scale handles */}
            {screenCorners.map((pt, idx) => (
              <g
                key={`cam-c-${idx}`}
                transform={`translate(${pt.x}, ${pt.y})`}
                className="pointer-events-auto cursor-nwse-resize touch-none"
                data-testid={`camera-handle-scale-${idx}`}
                onPointerDown={startDrag('scale')}
              >
                <circle r={12} fill="transparent" />
                <rect
                  x={-5}
                  y={-5}
                  width={10}
                  height={10}
                  rx={2}
                  fill="#0f172a"
                  stroke="#38bdf8"
                  strokeWidth={2}
                />
              </g>
            ))}
          </>
        )}
      </svg>
    </div>
  );
};
