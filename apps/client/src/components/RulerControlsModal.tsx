import React, { useEffect, useState } from 'react';
import { Compass, Lock, RotateCw, Trash2, Unlock, X } from 'lucide-react';
import { RulerMode } from '@atelier/shared';
import { RulerManager, RulerState } from '../engine/RulerManager';
import { ToolWindow } from './workspace/ToolWindow';
import { Segmented } from './workspace/ToolOptionsBar';
import { useI18n } from '../context/I18nContext';

interface RulerControlsModalProps {
  isOpen: boolean;
  onClose: () => void;
  canvasWidth?: number;
  canvasHeight?: number;
}

const MODES: Array<{ id: RulerMode; label: string }> = [
  { id: 'off', label: '關閉' },
  { id: 'symmetry', label: '對稱' },
  { id: 'perspective', label: '透視' },
  { id: 'parallel', label: '平行線' },
  { id: 'concentric', label: '同心圓' },
];

/** Quick-pick chips (counts, angles) */
const Chips = <T extends number>({ values, current, label, onPick }: { values: T[]; current: T; label: (v: T) => string; onPick: (v: T) => void }) => (
  <div className="grid grid-cols-4 gap-1">
    {values.map((v) => (
      <button key={v} type="button" aria-pressed={current === v} onClick={() => onPick(v)} className="atelier-btn !h-6 !px-1 font-mono text-[11px]">
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

/** Short hint under each ruler: what to drag on the canvas */
const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[11px] leading-relaxed text-neutral-500">{children}</p>
);

export const RulerControlsModal: React.FC<RulerControlsModalProps> = ({
  isOpen,
  onClose,
  canvasWidth = 2048,
  canvasHeight = 2048,
}) => {
  const { t } = useI18n();
  const rulerMgr = RulerManager.getInstance();
  const [state, setState] = useState<RulerState>(rulerMgr.state);

  const modes: Array<{ id: RulerMode; label: string }> = [
    { id: 'off', label: t.rulers.off },
    { id: 'symmetry', label: t.rulers.symmetry },
    { id: 'perspective', label: t.rulers.perspective },
    { id: 'parallel', label: t.rulers.parallel },
    { id: 'concentric', label: t.rulers.concentricRuler },
  ];

  useEffect(() => rulerMgr.subscribe((newState) => setState({ ...newState })), [rulerMgr]);

  if (!isOpen) return null;

  const axes = state.symmetry.axesCount || 2;
  const guides = state.guides;

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

  return (
    <ToolWindow id="rulers" title={t.rulers.title} icon={<Compass />} onClose={onClose}
      initial={{ x: -332, y: 96, w: 320, h: 0 }} minW={280}
      footer={state.mode !== 'off' ? (
        <>
          <button type="button" onClick={() => rulerMgr.initDimensions(canvasWidth, canvasHeight)} className="atelier-btn atelier-btn--ghost mr-auto">
            <RotateCw />{t.common.center}
          </button>
          <button type="button" onClick={() => rulerMgr.setMode('off')} className="atelier-btn atelier-btn--danger">
            <Trash2 />{t.rulers.clearAllRulers}
          </button>
        </>
      ) : undefined}>
      <div className="space-y-3">
        <div role="radiogroup" aria-label={t.rulers.title} className="grid grid-cols-5 gap-0.5 rounded-lg border border-neutral-700 bg-neutral-950/60 p-0.5 text-[11px] font-medium">
          {modes.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={state.mode === m.id} onClick={() => rulerMgr.setMode(m.id)}
              className={`truncate rounded-md py-1 transition ${state.mode === m.id ? 'bg-indigo-600 text-white shadow' : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'}`}>
              {m.label}
            </button>
          ))}
        </div>

        {state.mode === 'off' && (
          <div className="flex flex-col items-center gap-2 py-6 text-neutral-500">
            <Compass className="h-8 w-8 opacity-40" />
            <span>選一種尺規開始</span>
          </div>
        )}

        {state.mode === 'symmetry' && (
          <>
            <Segmented label={t.rulers.symmetryMode} value={state.symmetry.mode} onChange={(mode) => rulerMgr.updateSymmetry({ mode })}
              options={[{ id: 'bilateral', label: t.rulers.symmetry }, { id: '2-axis', label: t.rulers.quadrants }, { id: 'radial', label: t.rulers.radial }]} />
            <Row label="對稱線" value={`${axes} 條`}>
              <Chips values={[2, 3, 4, 5, 6, 8, 12, 16]} current={axes} label={(n) => `${n}`}
                onPick={(n) => rulerMgr.updateSymmetry({ axesCount: n, mode: n === 2 ? 'bilateral' : 'radial' })} />
              <input type="range" min="2" max="24" step="1" value={axes} aria-label="對稱線數量" className="h-1.5 w-full cursor-pointer"
                onChange={(e) => { const n = parseInt(e.target.value, 10); rulerMgr.updateSymmetry({ axesCount: n, mode: n === 2 ? 'bilateral' : 'radial' }); }} />
            </Row>
            {state.symmetry.mode === 'bilateral' && (
              <Row label="鏡像軸" value={`${state.symmetry.angleDeg ?? 90}°`}>
                <Chips values={[90, 0, 45, 135]} current={state.symmetry.angleDeg ?? 90}
                  label={(d) => (d === 90 ? '左右' : d === 0 ? '上下' : `${d}°`)} onPick={(angleDeg) => rulerMgr.updateSymmetry({ angleDeg })} />
              </Row>
            )}
            <label className="flex cursor-pointer items-center justify-between text-[11px] text-neutral-300">
              萬花筒
              <input type="checkbox" checked={Boolean(state.symmetry.kaleidoscope)} onChange={(e) => rulerMgr.updateSymmetry({ kaleidoscope: e.target.checked })} />
            </label>
            <Hint>拖曳畫布上的中心點可移動對稱軸。</Hint>
          </>
        )}

        {state.mode === 'perspective' && (
          <>
            <Segmented label="滅點" value={state.perspective.mode} onChange={(mode) => rulerMgr.updatePerspective({ mode })}
              options={[{ id: '1-point', label: '1 點' }, { id: '2-point', label: '2 點' }, { id: '3-point', label: '3 點' }]} />
            <Hint>筆劃會吸附到透視線。拖曳畫布上的滅點與地平線調整位置。</Hint>
          </>
        )}

        {state.mode === 'parallel' && (
          <>
            <Row label="角度" value={`${state.parallel.angleDeg}°`}>
              <input type="range" min="0" max="359" value={state.parallel.angleDeg} aria-label="平行線角度" className="h-1.5 w-full cursor-pointer"
                onChange={(e) => rulerMgr.updateParallel({ angleDeg: parseInt(e.target.value, 10) })} />
              <Chips values={[0, 30, 45, 60, 90, 120, 135, 180]} current={state.parallel.angleDeg} label={(d) => `${d}°`}
                onPick={(angleDeg) => rulerMgr.updateParallel({ angleDeg })} />
            </Row>
          </>
        )}

        {state.mode === 'concentric' && (
          <Row label="間距" value={`${state.concentric.stepRadius} px`}>
            <input type="range" min="20" max="150" step="5" value={state.concentric.stepRadius} aria-label="同心圓間距" className="h-1.5 w-full cursor-pointer"
              onChange={(e) => rulerMgr.updateConcentric({ stepRadius: parseInt(e.target.value, 10) })} />
          </Row>
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
