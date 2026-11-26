import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  computePerspectiveGridLines,
  sampleCurveRulerPoints,
  type PerspectiveGridPlane,
} from '@atelier/shared';
import { RulerManager, RulerState } from '../engine/RulerManager';
import type { ViewportState } from '../engine/Viewport';
import { Compass, Grid3x3, Layers, Minus, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

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
  | { type: 'radial_center' }
  | { type: 'radial_inner_radius' }
  | { type: 'horizon' }
  | { type: 'vp1' }
  | { type: 'vp2' }
  | { type: 'vp3' }
  | { type: 'grid_origin' }
  | { type: 'curve_anchor'; id: string }
  | { type: 'curve_handle'; id: string; side: 'handleIn' | 'handleOut' }
  | { type: 'parallel_angle'; startX: number; startY: number; startAngle: number }
  | { type: 'guide'; id: string; axis: 'x' | 'y'; startClientX: number; startClientY: number; moved: boolean; additive: boolean };

const GRID_PLANE_COLORS: Record<PerspectiveGridPlane, string> = {
  xy: '#38BDF8',
  xz: '#34D399',
  yz: '#FBBF24',
};

export const RulerOverlay: React.FC<RulerOverlayProps> = ({
  canvasWidth,
  canvasHeight,
  canvasToScreen,
  screenToCanvas,
  viewportZoom: propZoom,
  subscribeViewport,
  getViewportSnapshot,
}) => {
  const { t } = useI18n();
  const rulerMgr = RulerManager.getInstance();
  const [state, setState] = useState<RulerState>(rulerMgr.state);
  const dragTargetRef = useRef<DragTarget | null>(null);

  useEffect(() => {
    return rulerMgr.subscribe((newState) => setState({ ...newState }));
  }, [rulerMgr]);

  const hasGuides = state.guides.visible && state.guides.items.length > 0;
  const isRulerVisible = state.mode !== 'off' && state.boundSource?.enabled !== false;
  const canEdit = state.boundSource?.editable ?? true;
  const noopSub = useCallback(() => () => {}, []);
  const snap = useSyncExternalStore(
    (isRulerVisible || hasGuides) && subscribeViewport ? subscribeViewport : noopSub,
    getViewportSnapshot ?? getDefaultVp,
    getViewportSnapshot ?? getDefaultVp,
  );
  const viewportZoom = getViewportSnapshot ? snap.zoom : (propZoom ?? 1);

  const perspectiveGridLines = useMemo(() => {
    if (!isRulerVisible || state.mode !== 'perspective' || !state.perspective.grid?.enabled) return [];
    return computePerspectiveGridLines(state.perspective, canvasWidth, canvasHeight);
  }, [isRulerVisible, state.mode, state.perspective, canvasWidth, canvasHeight]);

  const sampledCurvePoints = useMemo(() => {
    if (!isRulerVisible || state.mode !== 'curve') return [];
    return sampleCurveRulerPoints(state.curve, 28);
  }, [isRulerVisible, state.mode, state.curve]);

  if (!isRulerVisible && !hasGuides) return null;

  const commitIfBound = () => {
    if (rulerMgr.state.boundSource?.editable) {
      rulerMgr.commitBoundLayerRuler();
    }
  };

  const handlePointerDown = (target: DragTarget, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (target.type !== 'guide' && !canEdit) return;
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
        case 'radial_center':
          rulerMgr.updateRadialLine({
            centerX: Math.round(canvasPt.x),
            centerY: Math.round(canvasPt.y),
          });
          break;
        case 'radial_inner_radius': {
          const { centerX, centerY } = rulerMgr.state.radialLine;
          const dist = Math.round(Math.hypot(canvasPt.x - centerX, canvasPt.y - centerY));
          rulerMgr.updateRadialLine({ innerRadius: Math.max(0, Math.min(2000, dist)) });
          break;
        }
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
        case 'grid_origin':
          rulerMgr.updatePerspectiveGrid({
            gridOrigin: { x: Math.round(canvasPt.x), y: Math.round(canvasPt.y) },
          });
          break;
        case 'curve_anchor': {
          const id = dragTargetRef.current.id;
          const existing = rulerMgr.state.curve.anchors.find((a) => a.id === id);
          if (existing) {
            const nx = Math.round(canvasPt.x);
            const ny = Math.round(canvasPt.y);
            const dx = nx - existing.x;
            const dy = ny - existing.y;
            rulerMgr.updateCurveAnchor(id, {
              x: nx,
              y: ny,
              ...(existing.handleIn ? { handleIn: { x: existing.handleIn.x + dx, y: existing.handleIn.y + dy } } : {}),
              ...(existing.handleOut ? { handleOut: { x: existing.handleOut.x + dx, y: existing.handleOut.y + dy } } : {}),
            });
          }
          break;
        }
        case 'curve_handle': {
          const { id, side } = dragTargetRef.current;
          rulerMgr.updateCurveAnchor(id, {
            [side]: { x: Math.round(canvasPt.x), y: Math.round(canvasPt.y) },
          });
          break;
        }
        case 'parallel_angle': {
          const dx = ev.clientX - dragTargetRef.current.startX;
          const dy = ev.clientY - dragTargetRef.current.startY;
          let deg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
          if (deg < 0) deg += 360;
          rulerMgr.updateParallel({ angleDeg: deg });
          break;
        }
        case 'guide': {
          const current = dragTargetRef.current;
          if (Math.hypot(ev.clientX - current.startClientX, ev.clientY - current.startClientY) >= 3) {
            current.moved = true;
          }
          const found = rulerMgr.state.guides.items.find((item) => item.id === current.id);
          if (current.moved && found && !found.locked) {
            const raw = current.axis === 'x' ? canvasPt.x : canvasPt.y;
            const limit = current.axis === 'x' ? canvasWidth : canvasHeight;
            rulerMgr.updateGuide(current.id, { position: Math.max(0, Math.min(limit, Math.round(raw))) });
          }
          break;
        }
      }
    };

    const onPointerUp = () => {
      const finished = dragTargetRef.current;
      dragTargetRef.current = null;
      if (finished && finished.type === 'guide' && !finished.moved) {
        rulerMgr.toggleGuideSelected(finished.id, finished.additive);
      } else if (finished && finished.type !== 'guide') {
        commitIfBound();
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  const scopeLabel = (scope: 'all_layers' | 'same_folder' | 'target_layer') =>
    scope === 'all_layers'
      ? t.rulers.scopeAllLayers
      : scope === 'same_folder'
        ? t.rulers.scopeSameFolder
        : t.rulers.scopeTargetLayer;

  const activeModeLabel = () => {
    switch (state.mode) {
      case 'symmetry':
        return state.symmetry.mode === 'bilateral'
          ? t.rulers.symmetry
          : state.symmetry.mode === '2-axis'
            ? t.rulers.quadrants
            : t.rulers.radial;
      case 'parallel':
        return t.rulers.parallel;
      case 'perspective':
        return `${state.perspective.mode === '1-point' ? t.rulers.point1 : state.perspective.mode === '2-point' ? t.rulers.point2 : t.rulers.point3} ${t.rulers.perspective}`;
      case 'concentric':
        return t.rulers.concentricRuler;
      case 'radial_line':
        return t.rulers.radialLine;
      case 'curve':
        return t.rulers.curveRuler;
      default:
        return '';
    }
  };

  return (
    <>
      <svg className="absolute inset-0 w-full h-full pointer-events-none z-20 select-none overflow-visible" data-testid="ruler-overlay-svg">
        <defs>
          <filter id="glow-neon" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* 1. 對稱尺 (Symmetry Ruler) Overlay */}
        {isRulerVisible && state.mode === 'symmetry' && (() => {
          const centerScreen = canvasToScreen(state.symmetry.centerX, state.symmetry.centerY);
          const canvasTopLeft = canvasToScreen(0, 0);
          const canvasBottomRight = canvasToScreen(canvasWidth, canvasHeight);
          const extent = Math.max(
            2400,
            Math.hypot(canvasBottomRight.x - canvasTopLeft.x, canvasBottomRight.y - canvasTopLeft.y) * 1.5,
          );
          const lines: React.ReactNode[] = [];
          const pushRay = (key: string, angleRad: number, stroke = '#C084FC') => {
            const dx = Math.cos(angleRad) * extent;
            const dy = Math.sin(angleRad) * extent;
            lines.push(
              <g key={key}>
                <line
                  x1={centerScreen.x - dx}
                  y1={centerScreen.y - dy}
                  x2={centerScreen.x + dx}
                  y2={centerScreen.y + dy}
                  stroke="#000000"
                  strokeWidth="4"
                  opacity="0.35"
                />
                <line
                  x1={centerScreen.x - dx}
                  y1={centerScreen.y - dy}
                  x2={centerScreen.x + dx}
                  y2={centerScreen.y + dy}
                  stroke={stroke}
                  strokeWidth="2"
                  strokeDasharray="10 5"
                  opacity="0.92"
                />
              </g>,
            );
          };

          const count = state.symmetry.axesCount || 2;
          const isRadial = state.symmetry.mode === 'radial' || count > 2;
          const isBilateral = !isRadial && (state.symmetry.mode === 'bilateral' || count === 2);
          const isTwoAxis = !isRadial && state.symmetry.mode === '2-axis';

          if (isBilateral) {
            const angle = ((state.symmetry.angleDeg ?? 90) * Math.PI) / 180;
            pushRay('bilateral-axis', angle, '#E879F9');
          } else if (isTwoAxis) {
            pushRay('2axis-v', Math.PI / 2, '#C084FC');
            pushRay('2axis-h', 0, '#C084FC');
          } else {
            const step = (Math.PI * 2) / count;
            for (let i = 0; i < count; i++) {
              const angle = i * step;
              const x2 = centerScreen.x + Math.cos(angle) * extent;
              const y2 = centerScreen.y + Math.sin(angle) * extent;
              lines.push(
                <g key={`rad-${i}`}>
                  <line
                    x1={centerScreen.x}
                    y1={centerScreen.y}
                    x2={x2}
                    y2={y2}
                    stroke="#000000"
                    strokeWidth="3.5"
                    opacity="0.3"
                  />
                  <line
                    x1={centerScreen.x}
                    y1={centerScreen.y}
                    x2={x2}
                    y2={y2}
                    stroke="#A855F7"
                    strokeWidth="1.8"
                    strokeDasharray="6 4"
                    opacity="0.9"
                  />
                </g>,
              );
            }
          }

          return (
            <g>
              {lines}
              <circle
                cx={centerScreen.x}
                cy={centerScreen.y}
                r={14}
                fill="#7C3AED"
                fillOpacity="0.45"
                stroke="#E879F9"
                strokeWidth="2.5"
                className={canEdit ? 'pointer-events-auto cursor-move' : ''}
                onPointerDown={(e) => handlePointerDown({ type: 'symmetry_center' }, e)}
              />
              <circle cx={centerScreen.x} cy={centerScreen.y} r={4} fill="#FFFFFF" />
              <g transform={`translate(${centerScreen.x + 18}, ${centerScreen.y - 12})`}>
                <rect
                  x="0"
                  y="-12"
                  width="126"
                  height="18"
                  rx="4"
                  fill="#1E1B4B"
                  fillOpacity="0.88"
                  stroke="#A855F7"
                  strokeWidth="1"
                />
                <text x="6" y="0" fill="#F0ABFC" fontSize="10" fontWeight="bold">
                  {state.symmetry.mode === 'bilateral'
                    ? `${t.rulers.symmetry} (${state.symmetry.angleDeg ?? 90}°)`
                    : state.symmetry.mode === '2-axis'
                      ? t.rulers.quadrants
                      : `${t.rulers.radial} (${state.symmetry.axesCount})`}
                </text>
              </g>
            </g>
          );
        })()}

        {/* 2. 透視尺 (Perspective Ruler) + 2D 透視空間網格 (XY/XZ/YZ) Overlay */}
        {isRulerVisible && state.mode === 'perspective' && (() => {
          const { mode, horizonY, vp1, vp2, vp3, grid } = state.perspective;
          const sHorizonL = canvasToScreen(-canvasWidth * 2, horizonY);
          const sHorizonR = canvasToScreen(canvasWidth * 3, horizonY);
          const sHorizonHandle = canvasToScreen(canvasWidth * 0.5, horizonY);
          const sVP1 = canvasToScreen(vp1.x, vp1.y);
          const sVP2 = canvasToScreen(vp2.x, vp2.y);
          const sVP3 = canvasToScreen(vp3.x, vp3.y);
          const gridOrigin = grid?.gridOrigin ?? {
            x: Math.round(canvasWidth / 2),
            y: Math.round(Math.min(canvasHeight * 0.85, horizonY + Math.max(120, canvasHeight * 0.25))),
          };
          const sGridOrigin = canvasToScreen(gridOrigin.x, gridOrigin.y);
          const gridOpacity = grid?.opacity ?? 0.35;

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
                />,
              );
            }
            return rays;
          };

          return (
            <g>
              {/* 2D Perspective Spatial Grid (XY / XZ / YZ) */}
              {grid?.enabled && perspectiveGridLines.length > 0 && (
                <g data-testid="perspective-grid-lines">
                  {perspectiveGridLines.map((line, idx) => {
                    const p1 = canvasToScreen(line.x1, line.y1);
                    const p2 = canvasToScreen(line.x2, line.y2);
                    return (
                      <line
                        key={`pgrid-${line.plane}-${idx}`}
                        data-grid-plane={line.plane}
                        x1={p1.x}
                        y1={p1.y}
                        x2={p2.x}
                        y2={p2.y}
                        stroke={GRID_PLANE_COLORS[line.plane]}
                        strokeWidth="1"
                        opacity={gridOpacity}
                      />
                    );
                  })}
                </g>
              )}

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
              <g
                transform={`translate(${sHorizonHandle.x + 18}, ${sHorizonHandle.y - 8})`}
                className={canEdit ? 'pointer-events-auto cursor-move touch-none' : ''}
                onPointerDown={(event) => handlePointerDown({ type: 'horizon' }, event)}
              >
                <rect
                  x="0"
                  y="-12"
                  width="128"
                  height="18"
                  rx="3"
                  fill="#083344"
                  fillOpacity="0.82"
                  stroke="#06B6D4"
                  strokeWidth="1"
                />
                <text x="6" y="0" fill="#67E8F9" fontSize="10" fontFamily="sans-serif" fontWeight="bold">
                  {t.rulers.horizonEyeLevel}
                </text>
              </g>

              {/* Rays */}
              {drawRays(sVP1, '#38BDF8')}
              {(mode === '2-point' || mode === '3-point') && drawRays(sVP2, '#F43F5E')}
              {mode === '3-point' && drawRays(sVP3, '#10B981')}

              {/* Grid Origin Handle */}
              {grid?.enabled && (
                <g
                  data-testid="perspective-grid-origin"
                  className={canEdit ? 'pointer-events-auto cursor-move touch-none' : ''}
                  onPointerDown={(e) => handlePointerDown({ type: 'grid_origin' }, e)}
                >
                  <polygon
                    points={`${sGridOrigin.x},${sGridOrigin.y - 9} ${sGridOrigin.x + 9},${sGridOrigin.y} ${sGridOrigin.x},${sGridOrigin.y + 9} ${sGridOrigin.x - 9},${sGridOrigin.y}`}
                    fill="#065F46"
                    fillOpacity="0.72"
                    stroke="#34D399"
                    strokeWidth="2"
                  />
                  <circle cx={sGridOrigin.x} cy={sGridOrigin.y} r={2.5} fill="#FFFFFF" />
                </g>
              )}

              {/* VP1 Handle */}
              <circle
                cx={sVP1.x}
                cy={sVP1.y}
                r={12}
                fill="#0284C7"
                fillOpacity="0.4"
                stroke="#38BDF8"
                strokeWidth="2"
                className={canEdit ? 'pointer-events-auto cursor-move' : ''}
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
                    className={canEdit ? 'pointer-events-auto cursor-move' : ''}
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
                    className={canEdit ? 'pointer-events-auto cursor-move' : ''}
                    onPointerDown={(e) => handlePointerDown({ type: 'vp3' }, e)}
                  />
                  <circle cx={sVP3.x} cy={sVP3.y} r={4} fill="#FFFFFF" />
                  <text x={sVP3.x + 12} y={sVP3.y - 8} fill="#34D399" fontSize="11" fontWeight="bold">
                    {t.rulers.vp3Label}
                  </text>
                </>
              )}
            </g>
          );
        })()}

        {/* 3. 平行線尺規 (Parallel Ruler) Overlay */}
        {isRulerVisible && state.mode === 'parallel' && (() => {
          const rad = (state.parallel.angleDeg * Math.PI) / 180;
          const center = canvasToScreen(canvasWidth / 2, canvasHeight / 2);
          const ux = Math.cos(rad);
          const uy = Math.sin(rad);
          const perpX = -uy;
          const perpY = ux;
          const lines = [];

          for (let i = -12; i <= 12; i++) {
            const ox = center.x + perpX * i * 60 * viewportZoom;
            const oy = center.y + perpY * i * 60 * viewportZoom;
            lines.push(
              <line
                key={`par-${i}`}
                x1={ox - ux * 2000}
                y1={oy - uy * 2000}
                x2={ox + ux * 2000}
                y2={oy + uy * 2000}
                stroke="#34D399"
                strokeWidth={i === 0 ? '2' : '1'}
                strokeDasharray={i === 0 ? 'none' : '4 6'}
                opacity={i === 0 ? '0.85' : '0.35'}
              />,
            );
          }

          const handleDist = 80;
          const hx = center.x + ux * handleDist;
          const hy = center.y + uy * handleDist;

          return (
            <g>
              {lines}
              <line x1={center.x} y1={center.y} x2={hx} y2={hy} stroke="#10B981" strokeWidth="2.5" />
              <circle cx={center.x} cy={center.y} r={5} fill="#10B981" />
              <circle
                cx={hx}
                cy={hy}
                r={10}
                fill="#065F46"
                fillOpacity="0.6"
                stroke="#34D399"
                strokeWidth="2"
                className={canEdit ? 'pointer-events-auto cursor-grab' : ''}
                onPointerDown={(e) =>
                  handlePointerDown(
                    { type: 'parallel_angle', startX: center.x, startY: center.y, startAngle: state.parallel.angleDeg },
                    e,
                  )
                }
              />
              <text x={hx + 14} y={hy + 4} fill="#34D399" fontSize="11" fontWeight="bold">
                {t.rulers.parallelAngleShort}: {state.parallel.angleDeg}°
              </text>
            </g>
          );
        })()}

        {/* 4. 同心圓尺規 (Concentric Ruler) Overlay */}
        {isRulerVisible && state.mode === 'concentric' && (() => {
          const center = canvasToScreen(state.concentric.centerX, state.concentric.centerY);
          const circles = [];
          const step = (state.concentric.stepRadius || 50) * viewportZoom;

          for (let i = 1; i <= 20; i++) {
            circles.push(
              <circle
                key={`conc-${i}`}
                cx={center.x}
                cy={center.y}
                r={i * step}
                fill="none"
                stroke="#FACC15"
                strokeWidth={i % 2 === 0 ? '1.2' : '0.8'}
                strokeDasharray="6 4"
                opacity="0.35"
              />,
            );
          }

          return (
            <g>
              {circles}
              <circle
                cx={center.x}
                cy={center.y}
                r={12}
                fill="#A16207"
                fillOpacity="0.4"
                stroke="#FACC15"
                strokeWidth="2"
                className={canEdit ? 'pointer-events-auto cursor-move' : ''}
                onPointerDown={(e) => handlePointerDown({ type: 'concentric_center' }, e)}
              />
              <circle cx={center.x} cy={center.y} r={3} fill="#FFFFFF" />
              <text x={center.x + 16} y={center.y - 8} fill="#FACC15" fontSize="11" fontWeight="bold">
                {t.rulers.concentricCenterLabel}
              </text>
            </g>
          );
        })()}

        {/* 5. 集中線／放射狀尺規 (Radial Line Ruler) Overlay */}
        {isRulerVisible && state.mode === 'radial_line' && (() => {
          const center = canvasToScreen(state.radialLine.centerX, state.radialLine.centerY);
          const rayCount = Math.max(4, Math.min(72, Math.floor(state.radialLine.rayCount ?? 24)));
          const innerRadiusCanvas = Math.max(0, state.radialLine.innerRadius ?? 0);
          const innerRadiusScreen = innerRadiusCanvas * viewportZoom;
          const extent = 2600;
          const rays: React.ReactNode[] = [];

          for (let i = 0; i < rayCount; i++) {
            const angle = (i * Math.PI * 2) / rayCount;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const startR = innerRadiusScreen > 0 ? innerRadiusScreen : 16;
            rays.push(
              <line
                key={`radial-line-${i}`}
                x1={center.x + cos * startR}
                y1={center.y + sin * startR}
                x2={center.x + cos * extent}
                y2={center.y + sin * extent}
                stroke="#FB7185"
                strokeWidth={i % 4 === 0 ? '1.5' : '1'}
                strokeDasharray={i % 4 === 0 ? '8 5' : '4 7'}
                opacity={i % 4 === 0 ? '0.68' : '0.38'}
              />,
            );
          }

          const radiusHandleX = center.x + Math.max(28, innerRadiusScreen);
          const radiusHandleY = center.y;

          return (
            <g data-testid="radial-line-overlay">
              {rays}
              {innerRadiusScreen > 0 && (
                <circle
                  cx={center.x}
                  cy={center.y}
                  r={innerRadiusScreen}
                  fill="none"
                  stroke="#FDA4AF"
                  strokeWidth="1.5"
                  strokeDasharray="6 4"
                  opacity="0.75"
                />
              )}
              {/* Inner radius drag handle */}
              {innerRadiusCanvas > 0 && (
                <circle
                  cx={radiusHandleX}
                  cy={radiusHandleY}
                  r={7}
                  fill="#881337"
                  fillOpacity="0.75"
                  stroke="#FDA4AF"
                  strokeWidth="1.8"
                  className={canEdit ? 'pointer-events-auto cursor-ew-resize' : ''}
                  onPointerDown={(e) => handlePointerDown({ type: 'radial_inner_radius' }, e)}
                />
              )}
              {/* Focus center handle */}
              <circle
                cx={center.x}
                cy={center.y}
                r={13}
                fill="#BE123C"
                fillOpacity="0.45"
                stroke="#FB7185"
                strokeWidth="2.2"
                className={canEdit ? 'pointer-events-auto cursor-move' : ''}
                onPointerDown={(e) => handlePointerDown({ type: 'radial_center' }, e)}
              />
              <line x1={center.x - 7} y1={center.y} x2={center.x + 7} y2={center.y} stroke="#FFFFFF" strokeWidth="1.5" />
              <line x1={center.x} y1={center.y - 7} x2={center.x} y2={center.y + 7} stroke="#FFFFFF" strokeWidth="1.5" />
              <text x={center.x + 18} y={center.y - 10} fill="#FDA4AF" fontSize="11" fontWeight="bold">
                {t.rulers.radialCenterLabel} ({rayCount})
              </text>
            </g>
          );
        })()}

        {/* 6. 曲線／貝茲特殊尺規 (Curve / Bezier Ruler) Overlay */}
        {isRulerVisible && state.mode === 'curve' && (() => {
          const pathD = sampledCurvePoints
            .map((pt, idx) => {
              const s = canvasToScreen(pt.x, pt.y);
              return `${idx === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
            })
            .join(' ');
          const showHandles = state.curve.curveType === 'bezier' || state.curve.curveType === 'quadratic';

          return (
            <g data-testid="curve-ruler-overlay">
              {pathD && (
                <>
                  <path
                    d={pathD}
                    fill="none"
                    stroke="#000000"
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity="0.35"
                  />
                  <path
                    d={pathD}
                    fill="none"
                    stroke="#E879F9"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity="0.95"
                    filter="url(#glow-neon)"
                  />
                </>
              )}
              {state.curve.anchors.map((anchor, idx) => {
                const sAnchor = canvasToScreen(anchor.x, anchor.y);
                const sIn = showHandles && anchor.handleIn ? canvasToScreen(anchor.handleIn.x, anchor.handleIn.y) : null;
                const sOut = showHandles && anchor.handleOut ? canvasToScreen(anchor.handleOut.x, anchor.handleOut.y) : null;
                return (
                  <g key={anchor.id}>
                    {sIn && (
                      <>
                        <line x1={sAnchor.x} y1={sAnchor.y} x2={sIn.x} y2={sIn.y} stroke="#C084FC" strokeWidth="1.2" opacity="0.75" />
                        <circle
                          cx={sIn.x}
                          cy={sIn.y}
                          r={6}
                          fill="#2E1065"
                          stroke="#D8B4FE"
                          strokeWidth="1.8"
                          className={canEdit ? 'pointer-events-auto cursor-move' : ''}
                          onPointerDown={(e) => handlePointerDown({ type: 'curve_handle', id: anchor.id, side: 'handleIn' }, e)}
                        />
                      </>
                    )}
                    {sOut && (
                      <>
                        <line x1={sAnchor.x} y1={sAnchor.y} x2={sOut.x} y2={sOut.y} stroke="#C084FC" strokeWidth="1.2" opacity="0.75" />
                        <circle
                          cx={sOut.x}
                          cy={sOut.y}
                          r={6}
                          fill="#2E1065"
                          stroke="#F0ABFC"
                          strokeWidth="1.8"
                          className={canEdit ? 'pointer-events-auto cursor-move' : ''}
                          onPointerDown={(e) => handlePointerDown({ type: 'curve_handle', id: anchor.id, side: 'handleOut' }, e)}
                        />
                      </>
                    )}
                    <circle
                      data-testid={`curve-anchor-${anchor.id}`}
                      cx={sAnchor.x}
                      cy={sAnchor.y}
                      r={8}
                      fill="#701A75"
                      fillOpacity="0.85"
                      stroke="#F5D0FE"
                      strokeWidth="2.2"
                      className={canEdit ? 'pointer-events-auto cursor-move' : ''}
                      onPointerDown={(e) => handlePointerDown({ type: 'curve_anchor', id: anchor.id }, e)}
                    />
                    <text x={sAnchor.x + 11} y={sAnchor.y - 8} fill="#F5D0FE" fontSize="10" fontFamily="monospace" fontWeight="bold">
                      {idx + 1}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })()}

        {/* 7. 水平／垂直輔助線 (Canvas Guides) Overlay */}
        {hasGuides && state.guides.items.map((guide) => {
          const isSelected = state.guides.selectedIds.includes(guide.id);
          const p0 = guide.axis === 'x'
            ? canvasToScreen(guide.position, 0)
            : canvasToScreen(0, guide.position);
          const p1 = guide.axis === 'x'
            ? canvasToScreen(guide.position, canvasHeight)
            : canvasToScreen(canvasWidth, guide.position);
          const strokeColor = isSelected ? '#818cf8' : '#38bdf8';
          const label = `${guide.axis === 'x' ? 'X' : 'Y'} ${Math.round(guide.position)}`;
          const tagX = guide.axis === 'x' ? p0.x + 6 : p0.x + 8;
          const tagY = guide.axis === 'x' ? p0.y + 18 : p0.y - 6;
          const onGuideDown = (e: React.PointerEvent) =>
            handlePointerDown({
              type: 'guide',
              id: guide.id,
              axis: guide.axis,
              startClientX: e.clientX,
              startClientY: e.clientY,
              moved: false,
              additive: e.shiftKey || e.ctrlKey || e.metaKey,
            }, e);

          return (
            <g key={guide.id} data-guide-id={guide.id} data-guide-selected={isSelected ? 'true' : 'false'}>
              <line
                x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y}
                stroke="#000000" strokeWidth={isSelected ? '3' : '2.2'} opacity="0.45"
              />
              <line
                x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y}
                stroke={strokeColor}
                strokeWidth={isSelected ? '1.8' : '1.2'}
                strokeDasharray={isSelected ? 'none' : '6 4'}
                opacity={isSelected ? '0.95' : '0.85'}
              />
              <line
                x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y}
                stroke="transparent"
                strokeWidth="12"
                className={`pointer-events-auto ${guide.locked ? 'cursor-pointer' : guide.axis === 'x' ? 'cursor-ew-resize' : 'cursor-ns-resize'}`}
                onPointerDown={onGuideDown}
              />
              <g
                className={`pointer-events-auto ${guide.locked ? 'cursor-pointer' : guide.axis === 'x' ? 'cursor-ew-resize' : 'cursor-ns-resize'}`}
                onPointerDown={onGuideDown}
              >
                <rect
                  x={tagX - 4}
                  y={tagY - 12}
                  width={Math.max(40, label.length * 6.8 + 10)}
                  height={16}
                  rx={4}
                  fill={isSelected ? '#312e81' : '#0f172a'}
                  fillOpacity="0.88"
                  stroke={strokeColor}
                  strokeWidth={isSelected ? '1.3' : '0.9'}
                />
                <text
                  x={tagX + 1}
                  y={tagY}
                  fill={isSelected ? '#e0e7ff' : '#bae6fd'}
                  fontSize="10"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fontWeight="600"
                >
                  {label}
                </text>
              </g>
            </g>
          );
        })}
      </svg>

      {/* On-canvas ruler bar: active mode, layer binding pill, quick adjuster and remove */}
      {isRulerVisible && (
        <div
          data-testid="ruler-hud-bar"
          className="atelier-popover atelier-menu-in absolute left-1/2 top-3 z-30 flex -translate-x-1/2 select-none flex-wrap items-center gap-1.5 p-1.5 text-xs pointer-events-auto"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="flex items-center gap-1.5 pl-1.5 pr-1 font-medium text-neutral-100">
            <Compass className="h-3.5 w-3.5 text-indigo-400" />
            {activeModeLabel()}
          </span>

          {state.boundSource && (
            <span
              data-testid="ruler-hud-bound-pill"
              className="flex items-center gap-1 rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-medium text-purple-200 ring-1 ring-purple-400/40"
              title={state.boundSource.editable ? undefined : t.rulers.layerBindingReadonly}
            >
              <Layers className="h-3 w-3" />
              <span className="max-w-[96px] truncate">{state.boundSource.ownerLayerName}</span>
              <span className="opacity-70">· {scopeLabel(state.boundSource.scope)}</span>
            </span>
          )}

          {state.mode === 'symmetry' && canEdit && (
            <div className="flex items-center">
              <button
                type="button"
                aria-label={t.rulers.decreaseAxes}
                className="atelier-icon-btn h-7 w-6"
                onClick={() => {
                  const n = Math.max(2, (state.symmetry.axesCount || 2) - 1);
                  rulerMgr.updateSymmetry({ axesCount: n, mode: n === 2 ? 'bilateral' : 'radial' });
                  commitIfBound();
                }}
              >
                <Minus className="h-3 w-3" />
              </button>
              <span className="w-9 text-center font-mono tabular-nums text-neutral-100">{state.symmetry.axesCount || 2}</span>
              <button
                type="button"
                aria-label={t.rulers.increaseAxes}
                className="atelier-icon-btn h-7 w-6"
                onClick={() => {
                  const n = Math.min(24, (state.symmetry.axesCount || 2) + 1);
                  rulerMgr.updateSymmetry({ axesCount: n, mode: n === 2 ? 'bilateral' : 'radial' });
                  commitIfBound();
                }}
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          )}

          {state.mode === 'parallel' && canEdit && (
            <div className="flex items-center">
              <button
                type="button"
                aria-label={t.rulers.angleMinus15}
                className="atelier-icon-btn h-7 w-6"
                onClick={() => {
                  rulerMgr.updateParallel({ angleDeg: (state.parallel.angleDeg - 15 + 360) % 360 });
                  commitIfBound();
                }}
              >
                <Minus className="h-3 w-3" />
              </button>
              <span className="w-10 text-center font-mono tabular-nums text-neutral-100">{state.parallel.angleDeg}°</span>
              <button
                type="button"
                aria-label={t.rulers.anglePlus15}
                className="atelier-icon-btn h-7 w-6"
                onClick={() => {
                  rulerMgr.updateParallel({ angleDeg: (state.parallel.angleDeg + 15) % 360 });
                  commitIfBound();
                }}
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          )}

          {state.mode === 'radial_line' && canEdit && (
            <div className="flex items-center">
              <button
                type="button"
                aria-label={t.rulers.decreaseRays}
                className="atelier-icon-btn h-7 w-6"
                onClick={() => {
                  rulerMgr.updateRadialLine({ rayCount: Math.max(4, (state.radialLine.rayCount ?? 24) - 4) });
                  commitIfBound();
                }}
              >
                <Minus className="h-3 w-3" />
              </button>
              <span className="w-9 text-center font-mono tabular-nums text-neutral-100">{state.radialLine.rayCount ?? 24}</span>
              <button
                type="button"
                aria-label={t.rulers.increaseRays}
                className="atelier-icon-btn h-7 w-6"
                onClick={() => {
                  rulerMgr.updateRadialLine({ rayCount: Math.min(72, (state.radialLine.rayCount ?? 24) + 4) });
                  commitIfBound();
                }}
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          )}

          {state.mode === 'curve' && canEdit && (
            <button
              type="button"
              className="atelier-btn atelier-btn--ghost !h-7 !px-2 text-[11px]"
              onClick={() => {
                rulerMgr.addCurveAnchor();
                commitIfBound();
              }}
            >
              {t.rulers.curveAddNode}
            </button>
          )}

          {state.mode === 'perspective' && canEdit && (
            <button
              type="button"
              aria-pressed={Boolean(state.perspective.grid?.enabled)}
              className={`atelier-btn !h-7 !px-2 text-[11px] ${state.perspective.grid?.enabled ? 'bg-emerald-600/30 text-emerald-200 ring-1 ring-emerald-400/50' : 'atelier-btn--ghost'}`}
              onClick={() => {
                rulerMgr.updatePerspectiveGrid({ enabled: !state.perspective.grid?.enabled });
                commitIfBound();
              }}
            >
              <Grid3x3 className="h-3.5 w-3.5" />
              {t.rulers.perspectiveGridShow}
            </button>
          )}

          {canEdit && (
            <>
              <div className="mx-0.5 h-5 w-px bg-neutral-700" />
              <button
                type="button"
                onClick={() => {
                  if (state.boundSource) {
                    rulerMgr.commitBoundLayerRuler({ enabled: false });
                  } else {
                    rulerMgr.setMode('off');
                  }
                }}
                title={t.rulers.removeRuler}
                className="atelier-btn atelier-btn--ghost atelier-btn--danger"
              >
                <Trash2 />{t.rulers.removeRuler}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
};
