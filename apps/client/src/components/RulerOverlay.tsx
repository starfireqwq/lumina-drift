import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RulerManager, RulerState } from '../engine/RulerManager';
import type { ViewportState } from '../engine/Viewport';
import { Compass, Minus, Move, Plus, RotateCw, Trash2, Sliders, X } from 'lucide-react';

interface RulerOverlayProps {
  canvasWidth: number;
  canvasHeight: number;
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  screenToCanvas: (sx: number, sy: number) => { x: number; y: number };
  viewportZoom?: number;
  subscribeViewport?: (cb: () => void) => () => void;
  getViewportSnapshot?: () => ViewportState;
}

const DEFAULT_VP: ViewportState = { zoom: 1, panX: 0, panY: 0, rotation: 0, mirrorX: false };
const getDefaultVp = () => DEFAULT_VP;

type DragTarget =
  | { type: 'symmetry_center' }
  | { type: 'concentric_center' }
  | { type: 'horizon' }
  | { type: 'vp1' }
  | { type: 'vp2' }
  | { type: 'vp3' }
  | { type: 'parallel_angle'; startX: number; startY: number; startAngle: number };

export const RulerOverlay: React.FC<RulerOverlayProps> = ({
  canvasWidth,
  canvasHeight,
  canvasToScreen,
  screenToCanvas,
  viewportZoom: propZoom,
  subscribeViewport,
  getViewportSnapshot,
}) => {
  const rulerMgr = RulerManager.getInstance();
  const [state, setState] = useState<RulerState>(rulerMgr.state);
  const dragTargetRef = useRef<DragTarget | null>(null);

  useEffect(() => {
    return rulerMgr.subscribe((newState) => setState({ ...newState }));
  }, []);

  const noopSub = useCallback(() => () => {}, []);
  const snap = useSyncExternalStore(
    state.mode !== 'off' && subscribeViewport ? subscribeViewport : noopSub,
    getViewportSnapshot ?? getDefaultVp,
    getViewportSnapshot ?? getDefaultVp
  );
  const viewportZoom = getViewportSnapshot ? snap.zoom : (propZoom ?? 1);

  if (state.mode === 'off') return null;

  const handlePointerDown = (target: DragTarget, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragTargetRef.current = target;

    const onPointerMove = (ev: PointerEvent) => {
      if (!dragTargetRef.current) return;
      const canvasPt = screenToCanvas(ev.clientX, ev.clientY);

      switch (dragTargetRef.current.type) {
        case 'symmetry_center':
          rulerMgr.updateSymmetry({
            centerX: Math.round(canvasPt.x),
            centerY: Math.round(canvasPt.y),
          });
          break;
        case 'concentric_center':
          rulerMgr.updateConcentric({
            centerX: Math.round(canvasPt.x),
            centerY: Math.round(canvasPt.y),
          });
          break;
        case 'horizon':
          rulerMgr.updatePerspective({ horizonY: Math.round(canvasPt.y) });
          break;
        case 'vp1':
          rulerMgr.updatePerspective({
            vp1: { x: Math.round(canvasPt.x), y: Math.round(canvasPt.y) },
          });
          break;
        case 'vp2':
          rulerMgr.updatePerspective({
            vp2: { x: Math.round(canvasPt.x), y: Math.round(canvasPt.y) },
          });
          break;
        case 'vp3':
          rulerMgr.updatePerspective({
            vp3: { x: Math.round(canvasPt.x), y: Math.round(canvasPt.y) },
          });
          break;
        case 'parallel_angle': {
          const dx = ev.clientX - dragTargetRef.current.startX;
          const dy = ev.clientY - dragTargetRef.current.startY;
          let deg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
          if (deg < 0) deg += 360;
          rulerMgr.updateParallel({ angleDeg: deg });
          break;
        }
      }
    };

    const onPointerUp = () => {
      dragTargetRef.current = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  return (
    <>
      <svg className="absolute inset-0 w-full h-full pointer-events-none z-20 select-none overflow-visible">
      <defs>
        <filter id="glow-neon" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 1. 对称尺 (Symmetry Ruler) Overlay */}
      {state.mode === 'symmetry' && (() => {
        const centerScreen = canvasToScreen(state.symmetry.centerX, state.symmetry.centerY);
        const radius = Math.max(canvasWidth, canvasHeight) * 2 * Math.max(0.5, viewportZoom);
        const lines: React.ReactNode[] = [];

        const renderDoubleLine = (key: string, x1: number, y1: number, x2: number, y2: number) => {
          return (
            <g key={key}>
              {/* High-contrast dark backing outline */}
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#000000"
                strokeWidth="1.6"
                strokeLinecap="round"
                opacity="0.75"
              />
              {/* Vibrant foreground dashed neon line */}
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#E879F9"
                strokeWidth="0.8"
                strokeDasharray="8 4"
                strokeLinecap="round"
                opacity="1"
                filter="url(#glow-neon)"
              />
            </g>
          );
        };

        const count = state.symmetry.axesCount || 2;
        const isRadial = state.symmetry.mode === 'radial' || count > 2;
        const isBilateral = !isRadial && (state.symmetry.mode === 'bilateral' || count === 2);
        const isTwoAxis = !isRadial && state.symmetry.mode === '2-axis';

        if (isBilateral) {
          // Bilateral mirror line passing through center
          const angle = ((state.symmetry.angleDeg ?? 90) * Math.PI) / 180;
          const x1 = centerScreen.x + Math.cos(angle) * radius;
          const y1 = centerScreen.y + Math.sin(angle) * radius;
          const x2 = centerScreen.x - Math.cos(angle) * radius;
          const y2 = centerScreen.y - Math.sin(angle) * radius;
          lines.push(renderDoubleLine('sym-bilateral', x1, y1, x2, y2));
        } else if (isTwoAxis) {
          // Horizontal and vertical cross
          lines.push(
            renderDoubleLine('sym-2axis-h', centerScreen.x - radius, centerScreen.y, centerScreen.x + radius, centerScreen.y),
            renderDoubleLine('sym-2axis-v', centerScreen.x, centerScreen.y - radius, centerScreen.x, centerScreen.y + radius)
          );
        } else {
          // Multi-line Radial symmetry: render all axes with high contrast
          // When even (e.g. 2, 4, 6, 8, 12, 16): draw count/2 full diameter lines through center
          if (count % 2 === 0) {
            const half = count / 2;
            const step = Math.PI / half;
            for (let i = 0; i < half; i++) {
              const angle = i * step;
              const x1 = centerScreen.x - Math.cos(angle) * radius;
              const y1 = centerScreen.y - Math.sin(angle) * radius;
              const x2 = centerScreen.x + Math.cos(angle) * radius;
              const y2 = centerScreen.y + Math.sin(angle) * radius;
              lines.push(renderDoubleLine(`sym-axis-diam-${i}`, x1, y1, x2, y2));
            }
          } else {
            // When odd (e.g. 3, 5, 7): draw count radial rays from center outward
            const step = (Math.PI * 2) / count;
            for (let i = 0; i < count; i++) {
              const angle = i * step - Math.PI / 2;
              const x2 = centerScreen.x + Math.cos(angle) * radius;
              const y2 = centerScreen.y + Math.sin(angle) * radius;
              lines.push(renderDoubleLine(`sym-axis-ray-${i}`, centerScreen.x, centerScreen.y, x2, y2));
            }
          }
        }

        return (
          <g>
            {lines}
            {/* Draggable center pivot */}
            <circle
              cx={centerScreen.x}
              cy={centerScreen.y}
              r={12}
              fill="#A855F7"
              fillOpacity="0.25"
              stroke="#C084FC"
              strokeWidth="2"
              className="pointer-events-auto cursor-move"
              onPointerDown={(e) => handlePointerDown({ type: 'symmetry_center' }, e)}
            />
            <circle
              cx={centerScreen.x}
              cy={centerScreen.y}
              r={3}
              fill="#FFFFFF"
              className="pointer-events-none"
            />
            {/* Floating badge */}
            <g transform={`translate(${centerScreen.x + 16}, ${centerScreen.y - 16})`}>
              <rect
                x="-4"
                y="-14"
                width="120"
                height="22"
                rx="4"
                fill="#1E1B4B"
                fillOpacity="0.85"
                stroke="#6366F1"
                strokeWidth="1"
              />
              <text x="4" y="0" fill="#E0E7FF" fontSize="10" fontFamily="sans-serif" fontWeight="bold">
                {state.symmetry.mode === 'bilateral'
                  ? '雙向鏡像 (2線)'
                  : state.symmetry.mode === '2-axis'
                  ? '對稱尺 (十字)'
                  : `放射對稱 (${state.symmetry.axesCount}線)`}
              </text>
            </g>
          </g>
        );
      })()}

      {/* 2. 透视尺 (Perspective Ruler) Overlay */}
      {state.mode === 'perspective' && (() => {
        const { mode, horizonY, vp1, vp2, vp3 } = state.perspective;
        const sHorizonL = canvasToScreen(-canvasWidth * 2, horizonY);
        const sHorizonR = canvasToScreen(canvasWidth * 3, horizonY);
        const sHorizonHandle = canvasToScreen(canvasWidth * 0.5, horizonY);
        const sVP1 = canvasToScreen(vp1.x, vp1.y);
        const sVP2 = canvasToScreen(vp2.x, vp2.y);
        const sVP3 = canvasToScreen(vp3.x, vp3.y);

        // Radiating perspective rays
        const drawRays = (vpScreen: { x: number; y: number }, color: string) => {
          const rays = [];
          const numRays = 8;
          for (let i = -numRays; i < numRays; i++) {
            const angle = (i * Math.PI) / (numRays * 2);
            const rx = vpScreen.x + Math.cos(angle) * 3000;
            const ry = vpScreen.y + Math.sin(angle) * 3000;
            rays.push(
              <line
                key={`vp-ray-${color}-${i}`}
                x1={2 * vpScreen.x - rx}
                y1={2 * vpScreen.y - ry}
                x2={rx}
                y2={ry}
                stroke={color}
                strokeWidth="1"
                strokeDasharray="4 6"
                opacity="0.22"
              />
            );
          }
          return rays;
        };

        return (
          <g>
            {/* Horizon Line */}
            <line
              x1={sHorizonL.x}
              y1={sHorizonL.y}
              x2={sHorizonR.x}
              y2={sHorizonR.y}
              stroke="#06B6D4"
              strokeWidth="2"
              opacity="0.9"
              filter="url(#glow-neon)"
            />
            {/* Horizon handle label */}
            <g transform={`translate(${sHorizonHandle.x + 18}, ${sHorizonHandle.y - 8})`}
              className="pointer-events-auto cursor-move touch-none" onPointerDown={(event) => handlePointerDown({ type: 'horizon' }, event)}>
              <rect
                x="0"
                y="-12"
                width="120"
                height="18"
                rx="3"
                fill="#083344"
                fillOpacity="0.8"
                stroke="#06B6D4"
                strokeWidth="1"
              />
              <text x="6" y="0" fill="#67E8F9" fontSize="10" fontFamily="sans-serif" fontWeight="bold">
                地平線 (Eye Level)
              </text>
            </g>

            {/* Rays */}
            {drawRays(sVP1, '#38BDF8')}
            {(mode === '2-point' || mode === '3-point') && drawRays(sVP2, '#F43F5E')}
            {mode === '3-point' && drawRays(sVP3, '#10B981')}

            {/* VP1 Handle */}
            <circle
              cx={sVP1.x}
              cy={sVP1.y}
              r={12}
              fill="#0284C7"
              fillOpacity="0.4"
              stroke="#38BDF8"
              strokeWidth="2"
              className="pointer-events-auto cursor-move"
              onPointerDown={(e) => handlePointerDown({ type: 'vp1' }, e)}
            />
            <circle cx={sVP1.x} cy={sVP1.y} r={4} fill="#FFFFFF" />
            <text x={sVP1.x + 12} y={sVP1.y - 8} fill="#38BDF8" fontSize="11" fontWeight="bold">
              VP 1
            </text>

            {/* VP2 Handle */}
            {(mode === '2-point' || mode === '3-point') && (
              <>
                <circle
                  cx={sVP2.x}
                  cy={sVP2.y}
                  r={12}
                  fill="#E11D48"
                  fillOpacity="0.4"
                  stroke="#FB7185"
                  strokeWidth="2"
                  className="pointer-events-auto cursor-move"
                  onPointerDown={(e) => handlePointerDown({ type: 'vp2' }, e)}
                />
                <circle cx={sVP2.x} cy={sVP2.y} r={4} fill="#FFFFFF" />
                <text x={sVP2.x + 12} y={sVP2.y - 8} fill="#FB7185" fontSize="11" fontWeight="bold">
                  VP 2
                </text>
              </>
            )}

            {/* VP3 Handle */}
            {mode === '3-point' && (
              <>
                <circle
                  cx={sVP3.x}
                  cy={sVP3.y}
                  r={12}
                  fill="#059669"
                  fillOpacity="0.4"
                  stroke="#34D399"
                  strokeWidth="2"
                  className="pointer-events-auto cursor-move"
                  onPointerDown={(e) => handlePointerDown({ type: 'vp3' }, e)}
                />
                <circle cx={sVP3.x} cy={sVP3.y} r={4} fill="#FFFFFF" />
                <text x={sVP3.x + 12} y={sVP3.y - 8} fill="#34D399" fontSize="11" fontWeight="bold">
                  VP 3 (天頂/天底)
                </text>
              </>
            )}
          </g>
        );
      })()}

      {/* 3. 平行線尺規 (Parallel Ruler) Overlay */}
      {state.mode === 'parallel' && (() => {
        const rad = (state.parallel.angleDeg * Math.PI) / 180;
        const center = canvasToScreen(canvasWidth / 2, canvasHeight / 2);
        const ux = Math.cos(rad);
        const uy = Math.sin(rad);
        const perpX = -uy;
        const perpY = ux;

        const lines = [];
        const count = 12;
        const step = 60 * viewportZoom;
        for (let i = -count; i <= count; i++) {
          const ox = center.x + perpX * (i * step);
          const oy = center.y + perpY * (i * step);
          lines.push(
            <line
              key={`par-${i}`}
              x1={ox - ux * 3000}
              y1={oy - uy * 3000}
              x2={ox + ux * 3000}
              y2={oy + uy * 3000}
              stroke="#38BDF8"
              strokeWidth={i === 0 ? '1.8' : '1'}
              strokeDasharray={i === 0 ? 'none' : '4 6'}
              opacity={i === 0 ? '0.85' : '0.35'}
            />
          );
        }

        return (
          <g>
            {lines}
            {/* Center rotation handle */}
            <circle
              cx={center.x}
              cy={center.y}
              r={14}
              fill="#0369A1"
              fillOpacity="0.4"
              stroke="#38BDF8"
              strokeWidth="2"
              className="pointer-events-auto cursor-pointer"
              onPointerDown={(e) =>
                handlePointerDown(
                  { type: 'parallel_angle', startX: center.x, startY: center.y, startAngle: state.parallel.angleDeg },
                  e
                )
              }
            />
            <text x={center.x + 18} y={center.y - 4} fill="#38BDF8" fontSize="11" fontWeight="bold">
              平行角度: {state.parallel.angleDeg}°
            </text>
          </g>
        );
      })()}

      {/* 4. 同心圓尺規 (Concentric Circle Ruler) Overlay */}
      {state.mode === 'concentric' && (() => {
        const center = canvasToScreen(state.concentric.centerX, state.concentric.centerY);
        const circles = [];
        const step = (state.concentric.stepRadius || 50) * viewportZoom;
        for (let i = 1; i <= 15; i++) {
          circles.push(
            <circle
              key={`conc-${i}`}
              cx={center.x}
              cy={center.y}
              r={i * step}
              fill="none"
              stroke="#EAB308"
              strokeWidth={i % 5 === 0 ? '1.5' : '1'}
              strokeDasharray={i % 5 === 0 ? 'none' : '4 4'}
              opacity={i % 5 === 0 ? '0.7' : '0.35'}
            />
          );
        }

        return (
          <g>
            {circles}
            {/* Draggable center pivot */}
            <circle
              cx={center.x}
              cy={center.y}
              r={12}
              fill="#A16207"
              fillOpacity="0.4"
              stroke="#FACC15"
              strokeWidth="2"
              className="pointer-events-auto cursor-move"
              onPointerDown={(e) => handlePointerDown({ type: 'concentric_center' }, e)}
            />
            <circle cx={center.x} cy={center.y} r={3} fill="#FFFFFF" />
            <text x={center.x + 16} y={center.y - 8} fill="#FACC15" fontSize="11" fontWeight="bold">
              同心圓圓心 (Concentric)
            </text>
          </g>
        );
      })()}
    </svg>

    {/* On-canvas ruler bar: what is active, a quick adjuster and remove */}
    <div className="atelier-popover atelier-menu-in absolute left-1/2 top-3 z-30 flex -translate-x-1/2 select-none flex-wrap items-center gap-1.5 p-1.5 text-xs pointer-events-auto"
      onPointerDown={(e) => e.stopPropagation()}>
      <span className="flex items-center gap-1.5 pl-1.5 pr-1 font-medium text-neutral-100">
        <Compass className="h-3.5 w-3.5 text-indigo-400" />
        {state.mode === 'symmetry'
          ? state.symmetry.mode === 'bilateral' ? '鏡像' : state.symmetry.mode === '2-axis' ? '十字對稱' : '放射對稱'
          : state.mode === 'parallel' ? '平行線'
          : state.mode === 'perspective' ? `${state.perspective.mode.replace('-point', '')} 點透視`
          : '同心圓'}
      </span>
      {state.mode === 'symmetry' && (
        <div className="flex items-center">
          <button type="button" aria-label="減少對稱線" className="atelier-icon-btn h-7 w-6"
            onClick={() => { const n = Math.max(2, (state.symmetry.axesCount || 2) - 1); rulerMgr.updateSymmetry({ axesCount: n, mode: n === 2 ? 'bilateral' : 'radial' }); }}>
            <Minus className="h-3 w-3" />
          </button>
          <span className="w-10 text-center font-mono tabular-nums text-neutral-100">{state.symmetry.axesCount || 2} 線</span>
          <button type="button" aria-label="增加對稱線" className="atelier-icon-btn h-7 w-6"
            onClick={() => { const n = Math.min(24, (state.symmetry.axesCount || 2) + 1); rulerMgr.updateSymmetry({ axesCount: n, mode: n === 2 ? 'bilateral' : 'radial' }); }}>
            <Plus className="h-3 w-3" />
          </button>
        </div>
      )}
      {state.mode === 'parallel' && (
        <div className="flex items-center">
          <button type="button" aria-label="角度 −15°" className="atelier-icon-btn h-7 w-6"
            onClick={() => rulerMgr.updateParallel({ angleDeg: (state.parallel.angleDeg - 15 + 360) % 360 })}><Minus className="h-3 w-3" /></button>
          <span className="w-10 text-center font-mono tabular-nums text-neutral-100">{state.parallel.angleDeg}°</span>
          <button type="button" aria-label="角度 +15°" className="atelier-icon-btn h-7 w-6"
            onClick={() => rulerMgr.updateParallel({ angleDeg: (state.parallel.angleDeg + 15) % 360 })}><Plus className="h-3 w-3" /></button>
        </div>
      )}
      <div className="mx-0.5 h-5 w-px bg-neutral-700" />
      <button type="button" onClick={() => rulerMgr.setMode('off')} title="移除尺規" className="atelier-btn atelier-btn--ghost atelier-btn--danger">
        <Trash2 />移除
      </button>
    </div>
    </>
  );
};
