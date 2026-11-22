import React, { useEffect, useId, useState } from 'react';
import { AlertTriangle, Compass } from 'lucide-react';
import { ToolWindow } from './workspace/ToolWindow';
import { AtelierModal, modalButton } from './AtelierModal';
import { OverlayPresence } from './OverlayPresence';
import { useI18n } from '../context/I18nContext';
import {
  ALIGN_BASIS_CHOICES, guideAxisAvailability, resolveAlignBasis,
  type AlignBasis, type AlignBasisChoice, type AlignBlocker, type AlignGuideSummary,
  type AlignOutcome, type AlignX, type AlignY, type DistributeMode,
  type GuideAlignMode, type TextBoundsMode, type VectorAlignScope, type VectorBoundsMode,
} from '../utils/layerAlign';

/** The basis and L3 mode choices are personal habits, kept per browser */
const BASIS_KEY = 'atelier_align_basis';
const GUIDE_MODE_KEY = 'atelier_align_guide_mode';
const VECTOR_BOUNDS_KEY = 'atelier_align_vector_bounds';
const TEXT_BOUNDS_KEY = 'atelier_align_text_bounds';

const loadChoice = (): AlignBasisChoice => {
  try {
    const saved = localStorage.getItem(BASIS_KEY);
    return (ALIGN_BASIS_CHOICES as readonly string[]).includes(saved ?? '') ? saved as AlignBasisChoice : 'auto';
  } catch {
    return 'auto';
  }
};

const loadPref = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const saved = localStorage.getItem(key);
    return allowed.includes(saved as T) ? (saved as T) : fallback;
  } catch {
    return fallback;
  }
};

export interface AlignUiOptions {
  guideMode: GuideAlignMode;
  vectorScope: VectorAlignScope;
  vectorBoundsMode: VectorBoundsMode;
  textBoundsMode: TextBoundsMode;
}

const XS: AlignX[] = ['left', 'center', 'right'];
const YS: AlignY[] = ['top', 'center', 'bottom'];
const AT = ['start', 'center', 'end'] as const;
const DIST_H: readonly DistributeMode[] = ['left', 'hcenter', 'right', 'hgap'];
const DIST_V: readonly DistributeMode[] = ['top', 'vcenter', 'bottom', 'vgap'];

/**
 * One axis: the frame's edge (a centre line is dashed) and two bars lined up against it.
 * Drawn for left / centre / right; the vertical ones are the same drawing mirrored on the diagonal.
 */
export const AlignEdgeIcon: React.FC<{ axis: 'x' | 'y'; at: (typeof AT)[number] }> = ({ axis, at }) => {
  const line = at === 'start' ? 2.5 : at === 'end' ? 13.5 : 8;
  const long = at === 'start' ? 4 : at === 'end' ? 3 : 3.5;
  const short = at === 'start' ? 4 : at === 'end' ? 7 : 5.5;
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <g transform={axis === 'y' ? 'matrix(0 1 1 0 0 0)' : undefined}>
        <line x1={line} y1="1.5" x2={line} y2="14.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"
          strokeDasharray={at === 'center' ? '2 1.6' : undefined} opacity={at === 'center' ? 0.75 : 1} />
        <rect x={long} y="4" width="9" height="3.2" rx="1.1" fill="currentColor" />
        <rect x={short} y="8.8" width="5" height="3.2" rx="1.1" fill="currentColor" opacity="0.7" />
      </g>
    </svg>
  );
};

/** A pad cell: where in the frame the layer goes on both axes */
const AlignCellIcon: React.FC<{ col: number; row: number }> = ({ col, row }) => (
  <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.35" />
    <rect x={3.25 + col * 2.5} y={3.25 + row * 2.5} width="4.5" height="4.5" rx="1.2" fill="currentColor" />
  </svg>
);

/** Distribute marks: two edge lines (or dashed centres) vs three bars with equal-gap ticks; mirrored on the diagonal for vertical */
const DistributeIcon: React.FC<{ mode: DistributeMode }> = ({ mode }) => {
  const vertical = mode === 'top' || mode === 'vcenter' || mode === 'bottom' || mode === 'vgap';
  const kind = mode === 'left' || mode === 'top' ? 'start'
    : mode === 'hcenter' || mode === 'vcenter' ? 'center'
    : mode === 'right' || mode === 'bottom' ? 'end'
    : 'gap';
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <g transform={vertical ? 'matrix(0 1 1 0 0 0)' : undefined}>
        {kind === 'start' && (
          <>
            <line x1="2.5" y1="2" x2="2.5" y2="14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <rect x="3.7" y="4" width="3.3" height="8" rx="1" fill="currentColor" />
            <line x1="9" y1="2" x2="9" y2="14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <rect x="10.2" y="5.5" width="4.3" height="5" rx="1" fill="currentColor" opacity="0.72" />
          </>
        )}
        {kind === 'end' && (
          <>
            <rect x="1.5" y="5.5" width="4.3" height="5" rx="1" fill="currentColor" opacity="0.72" />
            <line x1="7" y1="2" x2="7" y2="14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <rect x="9" y="4" width="3.3" height="8" rx="1" fill="currentColor" />
            <line x1="13.5" y1="2" x2="13.5" y2="14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </>
        )}
        {kind === 'center' && (
          <>
            <path d="M4.25 1.5V3.7M4.25 12.3V14.5M11.75 1.5V4.7M11.75 11.3V14.5"
              stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.8" />
            <rect x="2.25" y="4.2" width="4" height="7.6" rx="1" fill="currentColor" />
            <rect x="9.25" y="5.2" width="5" height="5.6" rx="1" fill="currentColor" opacity="0.75" />
          </>
        )}
        {kind === 'gap' && (
          <>
            <rect x="1.5" y="3.5" width="2.2" height="9" rx="0.9" fill="currentColor" opacity="0.72" />
            <rect x="6.2" y="2.5" width="3.6" height="11" rx="1" fill="currentColor" />
            <rect x="12.3" y="4.5" width="2.2" height="7" rx="0.9" fill="currentColor" opacity="0.72" />
            <line x1="4.3" y1="8" x2="5.6" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.85" />
            <line x1="10.4" y1="8" x2="11.7" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.85" />
          </>
        )}
      </g>
    </svg>
  );
};

/** The window's own mark: a dashed frame with a block snapped into its corner */
export const AlignWindowIcon: React.FC<{ className?: string }> = ({ className = 'h-4 w-4' }) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.2 1.6" />
    <rect x="3.5" y="3.5" width="6" height="5" rx="1.2" fill="currentColor" />
  </svg>
);

const EMPTY_GUIDES: AlignGuideSummary = { xs: [], ys: [], usingSelection: false, totalCount: 0 };

interface LayerAlignWindowProps {
  targetLabel: string | null;
  targetCount: number;
  blocker: AlignBlocker | null;
  hasSelection: boolean;
  guideSummary?: AlignGuideSummary;
  hasVectorTarget?: boolean;
  canTargetVectorStrokes?: boolean;
  vectorStrokeCount?: number;
  selectedVectorStrokeCount?: number;
  hasTextTarget?: boolean;
  onOpenGuides?: () => void;
  onAlign: (x: AlignX | null, y: AlignY | null, basis: AlignBasis, allowCrop?: boolean, options?: AlignUiOptions) => Promise<AlignOutcome>;
  onDistribute: (mode: DistributeMode, basis: AlignBasis, allowCrop?: boolean, options?: AlignUiOptions) => Promise<AlignOutcome>;
  onClose: () => void;
}

type PendingAction =
  | { kind: 'align'; x: AlignX | null; y: AlignY | null; basis: AlignBasis; options: AlignUiOptions }
  | { kind: 'distribute'; mode: DistributeMode; basis: AlignBasis; options: AlignUiOptions };

/** Compact 2-way pill toggle used for L3 context options (guide mode, vector bounds, text bounds) */
function CompactToggle<T extends string>({
  label, value, options, onChange, testIdPrefix,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (next: T) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="shrink-0 text-[11px] text-neutral-400">{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex min-w-0 shrink-0 rounded-md border border-neutral-800 bg-neutral-950/60 p-0.5 text-[11px]">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={value === opt.id}
            data-testid={`${testIdPrefix}-${opt.id}`}
            onClick={() => onChange(opt.id)}
            className={`whitespace-nowrap rounded px-2 py-0.5 transition ${
              value === opt.id
                ? 'bg-indigo-600 font-medium text-white shadow-sm'
                : 'text-neutral-400 hover:text-neutral-100'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 對齊・均分: a floating tool window that stays open while you work. Aligns one or more layers/groups,
 * vector strokes, or text layers to objects, guides, the canvas, or the selection, and distributes
 * 2+ targets evenly along edges, centres, or equal gaps.
 */
export default function LayerAlignWindow({
  targetLabel,
  targetCount,
  blocker,
  hasSelection,
  guideSummary = EMPTY_GUIDES,
  hasVectorTarget = false,
  canTargetVectorStrokes = false,
  vectorStrokeCount = 0,
  selectedVectorStrokeCount = 0,
  hasTextTarget = false,
  onOpenGuides,
  onAlign,
  onDistribute,
  onClose,
}: LayerAlignWindowProps) {
  const { t } = useI18n();
  const selectId = useId();
  const vectorScopeId = useId();
  const distLabelId = useId();
  const [choice, setChoice] = useState<AlignBasisChoice>(loadChoice);
  const [guideMode, setGuideMode] = useState<GuideAlignMode>(() => loadPref(GUIDE_MODE_KEY, ['range', 'nearest'] as const, 'range'));
  const [vectorScope, setVectorScope] = useState<VectorAlignScope>('layer');
  const [vectorBoundsMode, setVectorBoundsMode] = useState<VectorBoundsMode>(() => loadPref(VECTOR_BOUNDS_KEY, ['stroke', 'path'] as const, 'stroke'));
  const [textBoundsMode, setTextBoundsMode] = useState<TextBoundsMode>(() => loadPref(TEXT_BOUNDS_KEY, ['glyph', 'box'] as const, 'glyph'));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'info' | 'warn'; text: string } | null>(null);
  const [askCrop, setAskCrop] = useState<PendingAction | null>(null);
  // Each move runs the streak of light across the frame again
  const [sweep, setSweep] = useState(0);

  const effectiveVectorScope: VectorAlignScope = !canTargetVectorStrokes
    ? 'layer'
    : (vectorScope === 'selected' && selectedVectorStrokeCount === 0 ? 'layer' : vectorScope);
  const effectiveCount = effectiveVectorScope === 'selected'
    ? selectedVectorStrokeCount
    : effectiveVectorScope === 'all'
      ? vectorStrokeCount
      : targetCount;
  const hasGuides = guideSummary.xs.length > 0 || guideSummary.ys.length > 0;
  const guideAvail = guideAxisAvailability(guideSummary);
  const basis = resolveAlignBasis(choice, hasSelection, effectiveCount, hasGuides);
  const reason = blocker
    ? t.align.blocked[blocker]
    : !basis
      ? (choice === 'objects' ? t.align.needMulti : choice === 'guide' ? t.align.noGuides : t.align.noSelection)
      : null;
  const alignDisabled = Boolean(reason) || busy;
  const alignXDisabled = alignDisabled || (basis === 'guide' && !guideAvail.canAlignX);
  const alignYDisabled = alignDisabled || (basis === 'guide' && !guideAvail.canAlignY);
  const alignXYDisabled = alignXDisabled || alignYDisabled;
  const distributeDisabled = alignDisabled || effectiveCount < 2;
  const distributeHDisabled = distributeDisabled || (basis === 'guide' && !guideAvail.canDistributeX);
  const distributeVDisabled = distributeDisabled || (basis === 'guide' && !guideAvail.canDistributeY);

  useEffect(() => {
    setStatus(null);
  }, [targetLabel, targetCount, choice, effectiveVectorScope, guideMode, vectorBoundsMode, textBoundsMode]);

  const pick = (next: AlignBasisChoice) => {
    setChoice(next);
    try { localStorage.setItem(BASIS_KEY, next); } catch { /* this tab still remembers */ }
  };

  const pickGuideMode = (next: GuideAlignMode) => {
    setGuideMode(next);
    try { localStorage.setItem(GUIDE_MODE_KEY, next); } catch { /* ignore */ }
  };

  const pickVectorBounds = (next: VectorBoundsMode) => {
    setVectorBoundsMode(next);
    try { localStorage.setItem(VECTOR_BOUNDS_KEY, next); } catch { /* ignore */ }
  };

  const pickTextBounds = (next: TextBoundsMode) => {
    setTextBoundsMode(next);
    try { localStorage.setItem(TEXT_BOUNDS_KEY, next); } catch { /* ignore */ }
  };

  const currentOptions = (): AlignUiOptions => ({
    guideMode,
    vectorScope: effectiveVectorScope,
    vectorBoundsMode,
    textBoundsMode,
  });

  const execute = async (action: PendingAction, allowCrop = false) => {
    setBusy(true);
    let outcome: AlignOutcome = 'failed';
    try {
      outcome = action.kind === 'align'
        ? await onAlign(action.x, action.y, action.basis, allowCrop, action.options)
        : await onDistribute(action.mode, action.basis, allowCrop, action.options);
    } finally {
      setBusy(false);
    }
    if (outcome === 'moved') {
      setStatus({ tone: 'ok', text: action.kind === 'distribute' ? t.align.distributed : t.align.done });
      setSweep((n) => n + 1);
    } else if (outcome === 'confirm') {
      setAskCrop(action);
    } else if (outcome === 'aligned') {
      setStatus({ tone: 'info', text: action.kind === 'distribute' ? t.align.alreadyDistributed : t.align.alreadyAligned });
    } else if (outcome === 'empty') {
      setStatus({ tone: 'info', text: t.align.empty });
    } else if (outcome === 'noSelection') {
      setStatus({ tone: 'warn', text: t.align.noSelection });
    } else if (outcome === 'noGuides') {
      setStatus({ tone: 'warn', text: t.align.noGuides });
    } else if (outcome === 'needGuides') {
      setStatus({ tone: 'warn', text: t.align.needGuides });
    } else if (outcome === 'needMulti') {
      setStatus({ tone: 'warn', text: t.align.needMulti });
    } else {
      setStatus({ tone: 'warn', text: t.align.failed });
    }
  };

  const runAlign = (x: AlignX | null, y: AlignY | null) => {
    if (basis) void execute({ kind: 'align', x, y, basis, options: currentOptions() });
  };

  const runDistribute = (mode: DistributeMode) => {
    if (basis) void execute({ kind: 'distribute', mode, basis, options: currentOptions() });
  };

  const btn = 'atelier-icon-btn relative z-[1] h-10 w-10 disabled:cursor-not-allowed disabled:opacity-35';
  const cellName = (x: AlignX, y: AlignY) => (x === 'center' && y === 'center'
    ? t.align.middle
    : t.align.both.replace('{x}', t.align.x[x]).replace('{y}', t.align.y[y]));
  const titleMeta = effectiveVectorScope !== 'layer'
    ? t.align.targetCount.replace('{count}', String(effectiveCount))
    : (targetLabel || (targetCount > 1 ? t.align.targetCount.replace('{count}', String(targetCount)) : null));
  const showGuideStrip = basis === 'guide' || choice === 'guide';

  return (
    <>
      <ToolWindow id="layer-align" icon={<AlignWindowIcon />}
        title={
          <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
            <span className="shrink-0">{t.align.title}</span>
            {titleMeta && <span className="truncate font-normal text-neutral-400">{titleMeta}</span>}
          </span>
        }
        onClose={onClose} initial={{ x: -304, y: 132, w: 280, h: 0 }} minW={244} minH={120}>
        {/* Side by side when there is room (tablet / phone held sideways), else stacked cleanly */}
        <div className="flex flex-wrap items-start justify-center gap-x-4 gap-y-2.5">
          <div className="min-w-0 flex-1 basis-48 space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <label htmlFor={selectId} className="shrink-0 text-[11px] text-neutral-400">{t.align.basis}</label>
              <select id={selectId} data-testid="align-basis-select" value={choice} onChange={(e) => pick(e.target.value as AlignBasisChoice)}
                className="atelier-field h-7 min-w-[5.25rem] flex-1 px-2 text-xs">
                {ALIGN_BASIS_CHOICES.map((c) => <option key={c} value={c}>{t.align.basisNames[c]}</option>)}
              </select>
              {choice === 'auto' && basis && (
                <span data-testid="align-auto-uses" className="shrink-0 whitespace-nowrap text-[11px] text-indigo-300">
                  {t.align.autoUses.replace('{basis}', t.align.basisNames[basis])}
                </span>
              )}
            </div>

            {/* Context options: only shown when relevant so the window stays uncluttered */}
            {showGuideStrip && (
              <div className="space-y-1.5 rounded-lg border border-neutral-800/80 bg-neutral-950/40 px-2 py-1.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                  <span className="inline-flex min-w-0 items-center gap-1 text-sky-300">
                    <span className="truncate">
                      {t.align.guideSummary
                        .replace('{x}', String(guideSummary.xs.length))
                        .replace('{y}', String(guideSummary.ys.length))}
                    </span>
                    {guideSummary.usingSelection && (
                      <span className="shrink-0 rounded bg-indigo-500/25 px-1 py-0.5 text-[10px] font-medium text-indigo-200">
                        {t.align.guideSelectedBadge}
                      </span>
                    )}
                  </span>
                  {onOpenGuides && (
                    <button
                      type="button"
                      data-testid="align-open-guides"
                      onClick={onOpenGuides}
                      className="atelier-btn atelier-btn--ghost !h-6 shrink-0 gap-1 !px-1.5 text-[11px] text-neutral-200"
                    >
                      <Compass className="h-3 w-3 text-sky-400" />
                      <span>{t.align.manageGuides}</span>
                    </button>
                  )}
                </div>
                {hasGuides && (
                  <CompactToggle
                    label={t.align.guideMode}
                    value={guideMode}
                    onChange={pickGuideMode}
                    testIdPrefix="align-guide-mode"
                    options={[
                      { id: 'range', label: t.align.guideModes.range },
                      { id: 'nearest', label: t.align.guideModes.nearest },
                    ]}
                  />
                )}
              </div>
            )}

            {hasVectorTarget && (
              <div className="space-y-1.5 rounded-lg border border-neutral-800/80 bg-neutral-950/40 px-2 py-1.5">
                {canTargetVectorStrokes && (
                  <div className="flex min-w-0 items-center gap-2">
                    <label htmlFor={vectorScopeId} className="shrink-0 text-[11px] text-neutral-400">{t.align.vectorScope}</label>
                    <select
                      id={vectorScopeId}
                      data-testid="align-vector-scope"
                      value={effectiveVectorScope}
                      onChange={(e) => setVectorScope(e.target.value as VectorAlignScope)}
                      className="atelier-field h-6 min-w-0 flex-1 px-1.5 text-[11px]"
                    >
                      <option value="layer">{t.align.vectorScopes.layer}</option>
                      <option value="selected" disabled={selectedVectorStrokeCount === 0}>
                        {t.align.vectorScopes.selected.replace('{count}', String(selectedVectorStrokeCount))}
                      </option>
                      <option value="all">
                        {t.align.vectorScopes.all.replace('{count}', String(vectorStrokeCount))}
                      </option>
                    </select>
                  </div>
                )}
                <CompactToggle
                  label={t.align.vectorBounds}
                  value={vectorBoundsMode}
                  onChange={pickVectorBounds}
                  testIdPrefix="align-vector-bounds"
                  options={[
                    { id: 'stroke', label: t.align.vectorBoundsModes.stroke },
                    { id: 'path', label: t.align.vectorBoundsModes.path },
                  ]}
                />
              </div>
            )}

            {hasTextTarget && (
              <div className="rounded-lg border border-neutral-800/80 bg-neutral-950/40 px-2 py-1.5">
                <CompactToggle
                  label={t.align.textBounds}
                  value={textBoundsMode}
                  onChange={pickTextBounds}
                  testIdPrefix="align-text-bounds"
                  options={[
                    { id: 'glyph', label: t.align.textBoundsModes.glyph },
                    { id: 'box', label: t.align.textBoundsModes.box },
                  ]}
                />
              </div>
            )}

            <p role="status" aria-live="polite"
              className={`min-h-[1rem] text-center text-[11px] leading-snug ${reason || status?.tone === 'warn' ? 'text-amber-300' : status?.tone === 'ok' ? 'text-emerald-300' : 'text-neutral-400'}`}>
              {reason ?? status?.text ?? ''}
            </p>
          </div>

          <div className="grid w-max shrink-0 gap-1" style={{ gridTemplateColumns: 'repeat(4, 2.5rem)', gridTemplateRows: 'repeat(4, 2.5rem)' }}>
            <div key={sweep} aria-hidden className="atelier-align-frame pointer-events-none rounded-lg border border-dashed border-indigo-400/45 bg-indigo-500/[0.05]"
              style={{ gridColumn: '2 / 5', gridRow: '2 / 5' }} />
            <div role="group" aria-label={t.align.horizontal} className="contents">
              {XS.map((x, i) => (
                <button key={x} type="button" data-testid={`align-x-${x}`} disabled={alignXDisabled} onClick={() => runAlign(x, null)} title={t.align.x[x]} aria-label={t.align.x[x]}
                  className={btn} style={{ gridColumn: i + 2, gridRow: 1 }}>
                  <AlignEdgeIcon axis="x" at={AT[i]} />
                </button>
              ))}
            </div>
            <div role="group" aria-label={t.align.vertical} className="contents">
              {YS.map((y, i) => (
                <button key={y} type="button" data-testid={`align-y-${y}`} disabled={alignYDisabled} onClick={() => runAlign(null, y)} title={t.align.y[y]} aria-label={t.align.y[y]}
                  className={btn} style={{ gridColumn: 1, gridRow: i + 2 }}>
                  <AlignEdgeIcon axis="y" at={AT[i]} />
                </button>
              ))}
            </div>
            <div role="group" aria-label={t.align.pad} className="contents">
              {YS.map((y, row) => XS.map((x, col) => (
                <button key={`${x}-${y}`} type="button" data-testid={`align-xy-${x}-${y}`} disabled={alignXYDisabled} onClick={() => runAlign(x, y)}
                  title={cellName(x, y)} aria-label={cellName(x, y)}
                  className={`${btn} text-indigo-200`} style={{ gridColumn: col + 2, gridRow: row + 2 }}>
                  <AlignCellIcon col={col} row={row} />
                </button>
              )))}
            </div>
          </div>

          <div role="region" aria-labelledby={distLabelId}
            className="flex w-max shrink-0 flex-col items-center gap-1.5 rounded-lg border border-neutral-800/80 bg-neutral-950/35 px-2 py-1.5">
            <span id={distLabelId} className="text-[11px] font-medium text-neutral-400">{t.align.distribute}</span>
            <div className="flex flex-col gap-1">
              <div role="group" aria-label={t.align.distributeH} className="grid grid-cols-4 gap-1">
                {DIST_H.map((mode) => (
                  <button key={mode} type="button" data-testid={`distribute-${mode}`} disabled={distributeHDisabled} onClick={() => runDistribute(mode)}
                    title={t.align.dist[mode]} aria-label={t.align.dist[mode]} className={btn}>
                    <DistributeIcon mode={mode} />
                  </button>
                ))}
              </div>
              <div role="group" aria-label={t.align.distributeV} className="grid grid-cols-4 gap-1">
                {DIST_V.map((mode) => (
                  <button key={mode} type="button" data-testid={`distribute-${mode}`} disabled={distributeVDisabled} onClick={() => runDistribute(mode)}
                    title={t.align.dist[mode]} aria-label={t.align.dist[mode]} className={btn}>
                    <DistributeIcon mode={mode} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ToolWindow>

      <OverlayPresence open={Boolean(askCrop)}>
        <AtelierModal title={t.align.cropTitle} icon={<AlertTriangle />} onClose={() => setAskCrop(null)}
          footer={(
            <>
              <button type="button" className={modalButton.secondary} onClick={() => setAskCrop(null)}>{t.common.cancel}</button>
              <button type="button" className={modalButton.primary} onClick={() => {
                const ask = askCrop;
                setAskCrop(null);
                if (ask) void execute(ask, true);
              }}>{t.align.cropConfirm}</button>
            </>
          )}>
          <p className="leading-relaxed text-neutral-300">{t.align.cropBody}</p>
        </AtelierModal>
      </OverlayPresence>
    </>
  );
}
