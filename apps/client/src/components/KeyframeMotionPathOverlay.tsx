import React from 'react';
import type { KeyframeMotionPath } from '../utils/keyframeTransform';

interface KeyframeMotionPathOverlayProps {
  path: KeyframeMotionPath;
  currentFrame: number;
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  onSelectFrame?: (frame: number) => void;
}

/**
 * Local-only SVG overlay displaying a keyframed layer's center motion trajectory, per-frame
 * spacing dots, and clickable keyframe diamond nodes. Never rendered into exported files.
 */
export const KeyframeMotionPathOverlay: React.FC<KeyframeMotionPathOverlayProps> = ({
  path,
  currentFrame,
  canvasToScreen,
  onSelectFrame,
}) => {
  const keyFrameSet = new Set(path.keyPoints.map((k) => k.frame));
  const screenSamples = path.samples.map((s) => ({
    frame: s.frame,
    ...canvasToScreen(s.x, s.y),
  }));
  const screenKeys = path.keyPoints.map((kp) => ({
    ...kp,
    ...canvasToScreen(kp.x, kp.y),
  }));
  const polylinePoints = screenSamples.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[21] select-none overflow-hidden"
      data-testid="keyframe-motion-path-overlay"
    >
      <svg className="h-full w-full overflow-visible">
        {path.hasMovement && screenSamples.length >= 2 && (
          <>
            <polyline
              points={polylinePoints}
              fill="none"
              stroke="rgba(9, 9, 11, 0.55)"
              strokeWidth={3.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <polyline
              points={polylinePoints}
              fill="none"
              stroke="#fbbf24"
              strokeWidth={1.75}
              strokeDasharray="6 4"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-testid="motion-path-polyline"
            />
          </>
        )}

        {/* Per-frame spacing dots showing easing acceleration / deceleration */}
        {path.hasMovement &&
          screenSamples.map((pt) =>
            keyFrameSet.has(pt.frame) ? null : (
              <circle
                key={`s-${pt.frame}`}
                cx={pt.x}
                cy={pt.y}
                r={2}
                fill="#fde68a"
                stroke="rgba(9, 9, 11, 0.75)"
                strokeWidth={0.75}
              />
            )
          )}

        {/* Keyframe diamond nodes (non-current nodes sit above transform quad for direct click-to-jump) */}
        {screenKeys.map((kp) => {
          const isCur = Math.round(kp.frame) === Math.round(currentFrame);
          const size = isCur ? 6.5 : 5;
          const clickable = Boolean(onSelectFrame) && !isCur;
          return (
            <g
              key={`k-${kp.frame}`}
              transform={`translate(${kp.x}, ${kp.y})`}
              data-testid={`motion-path-key-${kp.frame}`}
              className={clickable ? 'pointer-events-auto cursor-pointer touch-none' : 'pointer-events-none'}
              onPointerDown={(e) => {
                if (!clickable || !onSelectFrame) return;
                e.stopPropagation();
                e.preventDefault();
                onSelectFrame(kp.frame);
              }}
            >
              {clickable && <circle r={12} fill="transparent" />}
              <polygon
                points={`0,${-size} ${size},0 0,${size} ${-size},0`}
                fill={isCur ? '#fbbf24' : '#818cf8'}
                stroke="#ffffff"
                strokeWidth={isCur ? 1.75 : 1.25}
              />
              <text
                x={size + 4}
                y={-size - 1}
                fontSize={10}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fontWeight={isCur ? 700 : 600}
                fill={isCur ? '#fde68a' : '#e0e7ff'}
                stroke="rgba(9, 9, 11, 0.85)"
                strokeWidth={2.5}
                paintOrder="stroke"
              >
                #{kp.frame + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};
