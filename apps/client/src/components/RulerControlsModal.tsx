import React, { useEffect, useState } from 'react';
import { Compass, Layers, Link2, Lock, Plus, RotateCw, Trash2, Unlink2, Unlock, X } from 'lucide-react';
import type {
  CurveRulerType,
  LayerModel,
  LayerRulerMeta,
  LayerRulerScope,
  PerspectiveGridPlane,
  RulerMode,
} from '@atelier/shared';
import { RulerManager, RulerState } from '../engine/RulerManager';
import { ToolWindow } from './workspace/ToolWindow';
import { Segmented } from './workspace/ToolOptionsBar';
import { useI18n } from '../context/I18nContext';

interface RulerControlsModalProps {
  isOpen: boolean;
  onClose: () => void;
  canvasWidth?: number;
  canvasHeight?: number;
  activeLayer?: LayerModel | null;
  layers?: LayerModel[];
  canEditLayer?: (layer: LayerModel) => boolean;
  onUpdateLayerRuler?: (layerId: string, ruler: LayerRulerMeta | null) => void;
}

/** Quick-pick chips (counts, angles) */
const Chips = <T extends number>({
  values,
  current,
  label,
  disabled,
  onPick,
}: {
  values: T[];
  current: T;
  label: (v: T) => string;
  disabled?: boolean;
  onPick: (v: T) => void;
}) => (
  <div className="grid grid-cols-4 gap-1">
    {values.map((v) => (
      <button
        key={v}
        type="button"
        disabled={disabled}
        aria-pressed={current === v}
        onClick={() => onPick(v)}
        className="atelier-btn !h-6 !px-1 font-mono text-[11px] disabled:opacity-45"
      >
        {label(v)}
      </button>
    ))}
  </div>
);

const Row: React.FC<{ label: string; value?: React.ReactNode; children: React.ReactNode }> = ({ label, value, children }) => (
  <div className="space-y-1.5">
    <div className="flex items-center justify-between text-[11px] text-neutral-400">
      <span>{label}</span>
      {value !== undefined && <span className="font-mono tabular-nums text-neutral-100">{value}</span>}
    </div>
    {children}
  </div>
);

const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[11px] leading-relaxed text-neutral-500">{children}</p>
);

export const RulerControlsModal: React.FC<RulerControlsModalProps> = ({
  isOpen,
  onClose,
  canvasWidth = 2048,
  canvasHeight = 2048,
  activeLayer = null,
  layers = [],
  canEditLayer,
  onUpdateLayerRuler,
}) => {
  const { t } = useI18n();
  const rulerMgr = RulerManager.getInstance();
  const [state, setState] = useState<RulerState>(rulerMgr.state);
  const [pendingScope, setPendingScope] = useState<LayerRulerScope>('same_folder');

  useEffect(() => rulerMgr.subscribe((newState) => setState({ ...newState })), [rulerMgr]);

  if (!isOpen) return null;

  const modes: Array<{ id: RulerMode; label: string }> = [
    { id: 'off', label: t.rulers.off },
    { id: 'symmetry', label: t.rulers.symmetry },
    { id: 'perspective', label: t.rulers.perspective },
    { id: 'parallel', label: t.rulers.parallel },
    { id: 'concentric', label: t.rulers.concentricRuler },
    { id: 'radial_line', label: t.rulers.radialLine },
    { id: 'curve', label: t.rulers.curveRuler },
  ];

  const canEditActiveRuler = state.boundSource?.editable ?? true;
  const commitIfBound = () => {
    if (rulerMgr.state.boundSource?.editable) {
      rulerMgr.commitBoundLayerRuler();
    }
  };

  const activeLayerSupportsRuler = Boolean(
    activeLayer && activeLayer.layerType !== 'mask' && activeLayer.layerType !== 'adjustment',
  );
  const canEditTargetLayer = Boolean(activeLayer && activeLayerSupportsRuler && (canEditLayer ? canEditLayer(activeLayer) : true));
  const ownLayerRuler = activeLayer?.meta?.ruler ?? null;
  const boundOwnerLayer = state.boundSource
    ? layers.find((l) => l.id === state.boundSource?.ownerLayerId) ?? null
    : null;
  const managedLayer = boundOwnerLayer ?? (ownLayerRuler && activeLayer ? activeLayer : null);
  const managedRuler = managedLayer?.meta?.ruler ?? null;
  const canEditManagedLayer = Boolean(managedLayer && (canEditLayer ? canEditLayer(managedLayer) : true));

  const axes = state.symmetry.axesCount || 2;
  const guides = state.guides;
  const grid = state.perspective.grid ?? {
    enabled: false,
    planes: { xy: false, xz: true, yz: false },
    spacing: 80,
    opacity: 0.35,
  };

  const addQuickGuide = (axis: 'x' | 'y') => {
    const limit = axis === 'x' ? canvasWidth : canvasHeight;
    const sameAxis = guides.items.filter((g) => g.axis === axis);
    let pos = Math.round(limit / 2);
    if (sameAxis.length > 0) {
      const step = Math.max(32, Math.round(limit / 8));
      const existing = new Set(sameAxis.map((g) => Math.round(g.position)));
      for (let i = 1; i <= 16; i++) {
        const candidate = Math.max(0, Math.min(limit, pos + (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * step));
        if (!existing.has(candidate)) {
          pos = candidate;
          break;
        }
      }
    }
    rulerMgr.addGuide(axis, pos);
  };

  const handleBindCurrentToActiveLayer = () => {
    if (!activeLayer || !canEditTargetLayer || !onUpdateLayerRuler) return;
    const exported = rulerMgr.exportCurrentAsLayerRuler(pendingScope, true);
    if (!exported) return;
    rulerMgr.clearDetachedMode();
    onUpdateLayerRuler(activeLayer.id, exported);
  };

  const handleToggleManagedEnabled = (enabled: boolean) => {
    if (!managedLayer || !managedRuler || !canEditManagedLayer || !onUpdateLayerRuler) return;
    onUpdateLayerRuler(managedLayer.id, { ...managedRuler, enabled });
  };

  const handleChangeManagedScope = (scope: LayerRulerScope) => {
    if (!managedLayer || !managedRuler || !canEditManagedLayer || !onUpdateLayerRuler) return;
    onUpdateLayerRuler(managedLayer.id, { ...managedRuler, scope });
  };

  const handleRemoveManagedRuler = () => {
    if (!managedLayer || !canEditManagedLayer || !onUpdateLayerRuler) return;
    onUpdateLayerRuler(managedLayer.id, null);
  };

  const toggleGridPlane = (plane: PerspectiveGridPlane) => {
    if (!canEditActiveRuler) return;
    rulerMgr.updatePerspectiveGrid({
      enabled: true,
      planes: { ...grid.planes, [plane]: !grid.planes[plane] },
    });
    commitIfBound();
  };

  return (
    <ToolWindow
      id="rulers"
      title={t.rulers.title}
      icon={<Compass />}
      onClose={onClose}
      initial={{ x: 84, y: 84, w: 336, h: 0 }}
      minW={304}
      footer={state.mode !== 'off' && canEditActiveRuler ? (
        <>
          <button
            type="button"
            onClick={() => {
              rulerMgr.initDimensions(canvasWidth, canvasHeight, { forceBound: true });
              commitIfBound();
            }}
            className="atelier-btn atelier-btn--ghost mr-auto"
          >
            <RotateCw />{t.common.center}
          </button>
          <button
            type="button"
            onClick={() => {
              if (state.boundSource && onUpdateLayerRuler) {
                onUpdateLayerRuler(state.boundSource.ownerLayerId, null);
              } else {
                rulerMgr.setMode('off');
              }
            }}
            className="atelier-btn atelier-btn--danger"
          >
            <Trash2 />{t.rulers.clearAllRulers}
          </button>
        </>
      ) : undefined}
    >
      <div className="space-y-3">
        {/* Mode Selector (7 modes, 4-col clean grid) */}
        <div
          role="radiogroup"
          aria-label={t.rulers.title}
          className="grid grid-cols-4 gap-0.5 rounded-lg border border-neutral-700 bg-neutral-950/60 p-0.5 text-[11px] font-medium"
        >
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              data-testid={`ruler-mode-${m.id}`}
              aria-checked={state.mode === m.id}
              disabled={!canEditActiveRuler && state.mode !== m.id}
              onClick={() => {
                rulerMgr.setMode(m.id);
                if (m.id === 'off') {
                  if (state.boundSource && onUpdateLayerRuler) {
                    onUpdateLayerRuler(state.boundSource.ownerLayerId, null);
                  }
                } else {
                  commitIfBound();
                }
              }}
              className={`truncate rounded-md px-1 py-1 transition disabled:opacity-45 ${
                state.mode === m.id
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* CSP-Style Ruler-on-Layer Binding Card */}
        {onUpdateLayerRuler && (
          <div
            data-testid="ruler-layer-binding-section"
            className="space-y-2 rounded-lg border border-purple-500/25 bg-purple-950/20 p-2.5"
          >
            <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-purple-200">
              <span className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-purple-400" />
                {t.rulers.layerBindingTitle}
              </span>
            </div>

            {managedLayer && managedRuler ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-neutral-200" data-testid="ruler-bound-owner-label">
                    {t.rulers.layerBindingBoundTo.replace('{name}', managedLayer.name)}
                  </span>
                  {canEditManagedLayer && (
                    <button
                      type="button"
                      data-testid="ruler-unbind-layer-btn"
                      onClick={handleRemoveManagedRuler}
                      className="atelier-btn atelier-btn--ghost atelier-btn--danger !h-6 !px-1.5 text-[10px]"
                    >
                      <Unlink2 className="h-3 w-3" />
                      {t.rulers.layerBindingUnbind}
                    </button>
                  )}
                </div>

                {!canEditManagedLayer ? (
                  <p className="text-[11px] text-amber-300/90">{t.rulers.layerBindingReadonly}</p>
                ) : (
                  <>
                    <label className="flex cursor-pointer items-center justify-between text-[11px] text-neutral-300">
                      <span>{t.rulers.layerBindingEnabled}</span>
                      <input
                        type="checkbox"
                        data-testid="ruler-bound-enabled-toggle"
                        checked={managedRuler.enabled}
                        onChange={(e) => handleToggleManagedEnabled(e.target.checked)}
                      />
                    </label>
                    <div className="space-y-1">
                      <span className="text-[10px] text-neutral-400">{t.rulers.layerBindingScope}</span>
                      <div className="grid grid-cols-3 gap-1">
                        {(['all_layers', 'same_folder', 'target_layer'] as LayerRulerScope[]).map((scope) => (
                          <button
                            key={scope}
                            type="button"
                            data-testid={`ruler-scope-${scope}`}
                            aria-pressed={managedRuler.scope === scope}
                            onClick={() => handleChangeManagedScope(scope)}
                            className={`rounded px-1.5 py-1 text-[10px] font-medium transition ${
                              managedRuler.scope === scope
                                ? 'bg-purple-600 text-white'
                                : 'bg-neutral-900/70 text-neutral-300 hover:bg-neutral-800'
                            }`}
                          >
                            {scope === 'all_layers'
                              ? t.rulers.scopeAllLayers
                              : scope === 'same_folder'
                                ? t.rulers.scopeSameFolder
                                : t.rulers.scopeTargetLayer}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-neutral-400">{t.rulers.layerBindingDetached}</p>
                {state.mode !== 'off' && activeLayer && canEditTargetLayer && (
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-3 gap-1">
                      {(['all_layers', 'same_folder', 'target_layer'] as LayerRulerScope[]).map((scope) => (
                        <button
                          key={scope}
                          type="button"
                          aria-pressed={pendingScope === scope}
                          onClick={() => setPendingScope(scope)}
                          className={`rounded px-1.5 py-1 text-[10px] font-medium transition ${
                            pendingScope === scope
                              ? 'bg-purple-600/80 text-white'
                              : 'bg-neutral-900/70 text-neutral-400 hover:bg-neutral-800'
                          }`}
                        >
                          {scope === 'all_layers'
                            ? t.rulers.scopeAllLayers
                            : scope === 'same_folder'
                              ? t.rulers.scopeSameFolder
                              : t.rulers.scopeTargetLayer}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      data-testid="ruler-bind-current-layer-btn"
                      onClick={handleBindCurrentToActiveLayer}
                      className="atelier-btn w-full justify-center !h-7 bg-purple-600/85 text-[11px] text-white hover:bg-purple-500"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      {t.rulers.layerBindingBindCurrent} ({activeLayer.name})
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {state.mode === 'off' && (
          <div className="flex flex-col items-center gap-2 py-5 text-neutral-500">
            <Compass className="h-8 w-8 opacity-40" />
            <span>{t.rulers.pickModeHint}</span>
          </div>
        )}

        {/* Symmetry Controls */}
        {state.mode === 'symmetry' && (
          <>
            <Segmented
              label={t.rulers.symmetryMode}
              value={state.symmetry.mode}
              onChange={(mode) => {
                rulerMgr.updateSymmetry({ mode });
                commitIfBound();
              }}
              options={[
                { id: 'bilateral', label: t.rulers.symmetry },
                { id: '2-axis', label: t.rulers.quadrants },
                { id: 'radial', label: t.rulers.radial },
              ]}
            />
            <Row label={t.rulers.symmetryLines} value={`${axes}`}>
              <Chips
                values={[2, 3, 4, 5, 6, 8, 12, 16]}
                current={axes}
                disabled={!canEditActiveRuler}
                label={(n) => `${n}`}
                onPick={(n) => {
                  rulerMgr.updateSymmetry({ axesCount: n, mode: n === 2 ? 'bilateral' : 'radial' });
                  commitIfBound();
                }}
              />
              <input
                type="range"
                min="2"
                max="24"
                step="1"
                disabled={!canEditActiveRuler}
                value={axes}
                aria-label={t.rulers.axesCount}
                className="h-1.5 w-full cursor-pointer"
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  rulerMgr.updateSymmetry({ axesCount: n, mode: n === 2 ? 'bilateral' : 'radial' });
                }}
                onPointerUp={commitIfBound}
              />
            </Row>
            {state.symmetry.mode === 'bilateral' && (
              <Row label={t.rulers.mirrorAxis} value={`${state.symmetry.angleDeg ?? 90}°`}>
                <Chips
                  values={[90, 0, 45, 135]}
                  current={state.symmetry.angleDeg ?? 90}
                  disabled={!canEditActiveRuler}
                  label={(d) => (d === 90 ? t.rulers.mirrorLeftRight : d === 0 ? t.rulers.mirrorUpDown : `${d}°`)}
                  onPick={(angleDeg) => {
                    rulerMgr.updateSymmetry({ angleDeg });
                    commitIfBound();
                  }}
                />
              </Row>
            )}
            <label className="flex cursor-pointer items-center justify-between text-[11px] text-neutral-300">
              {t.rulers.kaleidoscope}
              <input
                type="checkbox"
                disabled={!canEditActiveRuler}
                checked={Boolean(state.symmetry.kaleidoscope)}
                onChange={(e) => {
                  rulerMgr.updateSymmetry({ kaleidoscope: e.target.checked });
                  commitIfBound();
                }}
              />
            </label>
            <Hint>{t.rulers.symmetryHint}</Hint>
          </>
        )}

        {/* Perspective Controls + 2D Spatial Grid (XY / XZ / YZ) */}
        {state.mode === 'perspective' && (
          <>
            <Segmented
              label={t.rulers.vanishingPointLabel}
              value={state.perspective.mode}
              onChange={(mode) => {
                rulerMgr.updatePerspective({ mode });
                commitIfBound();
              }}
              options={[
                { id: '1-point', label: t.rulers.point1 },
                { id: '2-point', label: t.rulers.point2 },
                { id: '3-point', label: t.rulers.point3 },
              ]}
            />

            {/* 2.3 Perspective 2D Spatial Grid */}
            <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/45 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-neutral-200">{t.rulers.perspectiveGridTitle}</span>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-300">
                  <input
                    type="checkbox"
                    data-testid="perspective-grid-toggle"
                    disabled={!canEditActiveRuler}
                    checked={grid.enabled}
                    onChange={(e) => {
                      rulerMgr.updatePerspectiveGrid({ enabled: e.target.checked });
                      commitIfBound();
                    }}
                  />
                  <span>{t.rulers.perspectiveGridShow}</span>
                </label>
              </div>

              <div className="grid grid-cols-3 gap-1">
                {(['xy', 'xz', 'yz'] as PerspectiveGridPlane[]).map((plane) => {
                  const active = grid.enabled && grid.planes[plane];
                  const activeCls =
                    plane === 'xy'
                      ? 'bg-sky-600/80 text-white'
                      : plane === 'xz'
                        ? 'bg-emerald-600/80 text-white'
                        : 'bg-amber-600/80 text-white';
                  return (
                    <button
                      key={plane}
                      type="button"
                      data-testid={`perspective-grid-plane-${plane}`}
                      aria-pressed={active}
                      disabled={!canEditActiveRuler}
                      onClick={() => toggleGridPlane(plane)}
                      className={`rounded px-1.5 py-1 text-[10px] font-medium transition disabled:opacity-45 ${
                        active ? activeCls : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'
                      }`}
                    >
                      {plane === 'xy'
                        ? t.rulers.perspectiveGridXY
                        : plane === 'xz'
                          ? t.rulers.perspectiveGridXZ
                          : t.rulers.perspectiveGridYZ}
                    </button>
                  );
                })}
              </div>

              {grid.enabled && (
                <>
                  <Row label={t.rulers.perspectiveGridSpacing} value={`${Math.round(grid.spacing)} px`}>
                    <input
                      type="range"
                      data-testid="perspective-grid-spacing"
                      min="20"
                      max="300"
                      step="5"
                      disabled={!canEditActiveRuler}
                      value={Math.round(grid.spacing)}
                      aria-label={t.rulers.perspectiveGridSpacing}
                      className="h-1.5 w-full cursor-pointer"
                      onChange={(e) => rulerMgr.updatePerspectiveGrid({ spacing: parseInt(e.target.value, 10) })}
                      onPointerUp={commitIfBound}
                    />
                    <Chips
                      values={[40, 80, 120, 180]}
                      current={Math.round(grid.spacing)}
                      disabled={!canEditActiveRuler}
                      label={(v) => `${v}`}
                      onPick={(spacing) => {
                        rulerMgr.updatePerspectiveGrid({ spacing });
                        commitIfBound();
                      }}
                    />
                  </Row>
                  <Row label={t.rulers.perspectiveGridOpacity} value={`${Math.round((grid.opacity ?? 0.35) * 100)}%`}>
                    <input
                      type="range"
                      min="10"
                      max="90"
                      step="5"
                      disabled={!canEditActiveRuler}
                      value={Math.round((grid.opacity ?? 0.35) * 100)}
                      aria-label={t.rulers.perspectiveGridOpacity}
                      className="h-1.5 w-full cursor-pointer"
                      onChange={(e) => rulerMgr.updatePerspectiveGrid({ opacity: parseInt(e.target.value, 10) / 100 })}
                      onPointerUp={commitIfBound}
                    />
                  </Row>
                </>
              )}
            </div>

            <Hint>{t.rulers.perspectiveHint}</Hint>
          </>
        )}

        {/* Parallel Controls */}
        {state.mode === 'parallel' && (
          <Row label={t.rulers.angle} value={`${state.parallel.angleDeg}°`}>
            <input
              type="range"
              min="0"
              max="359"
              disabled={!canEditActiveRuler}
              value={state.parallel.angleDeg}
              aria-label={t.rulers.angle}
              className="h-1.5 w-full cursor-pointer"
              onChange={(e) => rulerMgr.updateParallel({ angleDeg: parseInt(e.target.value, 10) })}
              onPointerUp={commitIfBound}
            />
            <Chips
              values={[0, 30, 45, 60, 90, 120, 135, 180]}
              current={state.parallel.angleDeg}
              disabled={!canEditActiveRuler}
              label={(d) => `${d}°`}
              onPick={(angleDeg) => {
                rulerMgr.updateParallel({ angleDeg });
                commitIfBound();
              }}
            />
          </Row>
        )}

        {/* Concentric Controls */}
        {state.mode === 'concentric' && (
          <Row label={t.rulers.concentricStep} value={`${state.concentric.stepRadius} px`}>
            <input
              type="range"
              min="20"
              max="150"
              step="5"
              disabled={!canEditActiveRuler}
              value={state.concentric.stepRadius}
              aria-label={t.rulers.concentricStep}
              className="h-1.5 w-full cursor-pointer"
              onChange={(e) => rulerMgr.updateConcentric({ stepRadius: parseInt(e.target.value, 10) })}
              onPointerUp={commitIfBound}
            />
          </Row>
        )}

        {/* 2.1 Radial Line (集中線) Controls */}
        {state.mode === 'radial_line' && (
          <>
            <Row label={t.rulers.radialRayCount} value={`${state.radialLine.rayCount ?? 24}`}>
              <Chips
                values={[8, 12, 16, 24, 32, 36, 48, 60]}
                current={state.radialLine.rayCount ?? 24}
                disabled={!canEditActiveRuler}
                label={(n) => `${n}`}
                onPick={(rayCount) => {
                  rulerMgr.updateRadialLine({ rayCount });
                  commitIfBound();
                }}
              />
              <input
                type="range"
                min="4"
                max="72"
                step="1"
                disabled={!canEditActiveRuler}
                value={state.radialLine.rayCount ?? 24}
                aria-label={t.rulers.radialRayCount}
                className="h-1.5 w-full cursor-pointer"
                onChange={(e) => rulerMgr.updateRadialLine({ rayCount: parseInt(e.target.value, 10) })}
                onPointerUp={commitIfBound}
              />
            </Row>
            <Row label={t.rulers.radialInnerRadius} value={`${Math.round(state.radialLine.innerRadius ?? 0)} px`}>
              <input
                type="range"
                min="0"
                max={Math.max(400, Math.round(Math.min(canvasWidth, canvasHeight) * 0.45))}
                step="5"
                disabled={!canEditActiveRuler}
                value={Math.round(state.radialLine.innerRadius ?? 0)}
                aria-label={t.rulers.radialInnerRadius}
                className="h-1.5 w-full cursor-pointer"
                onChange={(e) => rulerMgr.updateRadialLine({ innerRadius: parseInt(e.target.value, 10) })}
                onPointerUp={commitIfBound}
              />
            </Row>
            <Hint>{t.rulers.radialLineHint}</Hint>
          </>
        )}

        {/* 2.1 Curve / Bezier Ruler Controls */}
        {state.mode === 'curve' && (
          <>
            <Segmented
              label={t.rulers.curveType}
              value={state.curve.curveType}
              onChange={(curveType) => {
                if (!canEditActiveRuler) return;
                rulerMgr.updateCurve({ curveType: curveType as CurveRulerType });
                commitIfBound();
              }}
              options={[
                { id: 'bezier', label: t.rulers.curveBezier },
                { id: 'quadratic', label: t.rulers.curveQuadratic },
                { id: 'spline', label: t.rulers.curveSpline },
              ]}
            />
            <label className="flex cursor-pointer items-center justify-between text-[11px] text-neutral-300">
              <span>{t.rulers.curveClosed}</span>
              <input
                type="checkbox"
                data-testid="curve-closed-toggle"
                disabled={!canEditActiveRuler}
                checked={state.curve.closed}
                onChange={(e) => {
                  rulerMgr.updateCurve({ closed: e.target.checked });
                  commitIfBound();
                }}
              />
            </label>
            <div className="flex items-center justify-between gap-1.5">
              <span className="text-[11px] text-neutral-400">
                {t.rulers.curveNodes}: <strong className="font-mono text-neutral-100">{state.curve.anchors.length}</strong>
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="curve-add-node-btn"
                  disabled={!canEditActiveRuler || state.curve.anchors.length >= 64}
                  onClick={() => {
                    rulerMgr.addCurveAnchor();
                    commitIfBound();
                  }}
                  className="atelier-btn !h-6 !px-2 text-[11px] disabled:opacity-45"
                >
                  <Plus className="h-3 w-3" />
                  {t.rulers.curveAddNode}
                </button>
                <button
                  type="button"
                  disabled={!canEditActiveRuler}
                  onClick={() => {
                    rulerMgr.resetCurveToCanvas(canvasWidth, canvasHeight);
                    commitIfBound();
                  }}
                  className="atelier-btn atelier-btn--ghost !h-6 !px-2 text-[11px] disabled:opacity-45"
                >
                  {t.rulers.curveReset}
                </button>
              </div>
            </div>
            {state.curve.anchors.length > 2 && canEditActiveRuler && (
              <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto rounded border border-neutral-800/80 bg-neutral-950/40 p-1.5">
                {state.curve.anchors.map((a, idx) => (
                  <button
                    key={a.id}
                    type="button"
                    title={`${t.rulers.curveRemoveNode} #${idx + 1}`}
                    onClick={() => {
                      rulerMgr.removeCurveAnchor(a.id);
                      commitIfBound();
                    }}
                    className="inline-flex items-center gap-1 rounded bg-neutral-800/90 px-1.5 py-0.5 font-mono text-[10px] text-neutral-200 hover:bg-rose-900/70 hover:text-rose-100"
                  >
                    #{idx + 1}
                    <X className="h-2.5 w-2.5" />
                  </button>
                ))}
              </div>
            )}
            <Hint>{t.rulers.curveHint}</Hint>
          </>
        )}

        {/* Horizontal & vertical canvas guides for alignment / distribution */}
        <div className="space-y-2 border-t border-neutral-800 pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-neutral-300">{t.rulers.guidesTitle}</span>
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1 text-[11px] text-neutral-400">
                <input
                  type="checkbox"
                  checked={guides.visible}
                  onChange={(e) => rulerMgr.setGuidesVisible(e.target.checked)}
                />
                <span>{t.rulers.guidesShow}</span>
              </label>
              {guides.items.length > 0 && (
                <button
                  type="button"
                  onClick={() => rulerMgr.clearGuides()}
                  title={t.rulers.clearGuides}
                  aria-label={t.rulers.clearGuides}
                  className="atelier-btn atelier-btn--ghost atelier-btn--danger !h-6 !px-1.5 text-[11px]"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="add-vertical-guide"
              onClick={() => addQuickGuide('x')}
              className="atelier-btn !h-7 justify-center text-[11px]"
            >
              {t.rulers.addVerticalGuide}
            </button>
            <button
              type="button"
              data-testid="add-horizontal-guide"
              onClick={() => addQuickGuide('y')}
              className="atelier-btn !h-7 justify-center text-[11px]"
            >
              {t.rulers.addHorizontalGuide}
            </button>
          </div>

          {guides.items.length === 0 ? (
            <p className="text-[11px] leading-snug text-neutral-500">{t.rulers.guidesEmpty}</p>
          ) : (
            <div className="max-h-36 space-y-1 overflow-y-auto pr-0.5">
              {guides.items.map((g) => {
                const selected = guides.selectedIds.includes(g.id);
                const maxCoord = g.axis === 'x' ? canvasWidth : canvasHeight;
                return (
                  <div
                    key={g.id}
                    data-testid={`guide-row-${g.id}`}
                    className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[11px] ${
                      selected
                        ? 'border-indigo-400/70 bg-indigo-500/15 text-indigo-100'
                        : 'border-neutral-800 bg-neutral-950/50 text-neutral-200'
                    }`}
                  >
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={(e) => rulerMgr.toggleGuideSelected(g.id, e.shiftKey || e.ctrlKey || e.metaKey)}
                      className={`h-5 w-6 shrink-0 rounded font-mono text-[10px] font-semibold transition ${
                        selected ? 'bg-indigo-500 text-white' : 'bg-neutral-800 text-sky-300 hover:bg-neutral-700'
                      }`}
                    >
                      {g.axis === 'x' ? 'X' : 'Y'}
                    </button>
                    <input
                      type="number"
                      min={0}
                      max={maxCoord}
                      step={1}
                      value={Math.round(g.position)}
                      disabled={Boolean(g.locked)}
                      aria-label={`${g.axis === 'x' ? 'X' : 'Y'} px`}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) {
                          rulerMgr.updateGuide(g.id, { position: Math.max(0, Math.min(maxCoord, Math.round(v))) });
                        }
                      }}
                      className="atelier-field !h-5 min-w-0 flex-1 px-1.5 font-mono text-[11px] tabular-nums"
                    />
                    <span className="shrink-0 text-[10px] text-neutral-500">px</span>
                    <button
                      type="button"
                      aria-pressed={Boolean(g.locked)}
                      title={t.rulers.guideLock}
                      aria-label={t.rulers.guideLock}
                      onClick={() => rulerMgr.updateGuide(g.id, { locked: !g.locked })}
                      className="atelier-icon-btn !h-5 !w-5 shrink-0"
                    >
                      {g.locked ? <Lock className="h-3 w-3 text-amber-300" /> : <Unlock className="h-3 w-3 text-neutral-400" />}
                    </button>
                    <button
                      type="button"
                      title={t.rulers.guideDelete}
                      aria-label={t.rulers.guideDelete}
                      onClick={() => rulerMgr.removeGuide(g.id)}
                      className="atelier-icon-btn !h-5 !w-5 shrink-0 text-neutral-400 hover:text-rose-300"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {guides.items.length > 0 && <Hint>{t.rulers.guideSelectHint}</Hint>}
        </div>
      </div>
    </ToolWindow>
  );
};
