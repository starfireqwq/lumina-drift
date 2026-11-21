import React, { useEffect, useId, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ToolWindow } from './workspace/ToolWindow';
import { AtelierModal, modalButton } from './AtelierModal';
import { OverlayPresence } from './OverlayPresence';
import { useI18n } from '../context/I18nContext';
import {
  ALIGN_BASIS_CHOICES, resolveAlignBasis,
  type AlignBasis, type AlignBasisChoice, type AlignBlocker,
  type AlignOutcome, type AlignX, type AlignY, type DistributeMode,
} from '../utils/layerAlign';

/** The basis is a personal habit, kept per browser */
const BASIS_KEY = 'atelier_align_basis';
const loadChoice = (): AlignBasisChoice => {
  try {
    const saved = localStorage.getItem(BASIS_KEY);
    return (ALIGN_BASIS_CHOICES as readonly string[]).includes(saved ?? '') ? saved as AlignBasisChoice : 'auto';
  } catch {
    return 'auto';
  }
};

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

interface LayerAlignWindowProps {
  targetLabel: string | null;
  targetCount: number;
  blocker: AlignBlocker | null;
  hasSelection: boolean;
  onAlign: (x: AlignX | null, y: AlignY | null, basis: AlignBasis, allowCrop?: boolean) => Promise<AlignOutcome>;
  onDistribute: (mode: DistributeMode, basis: AlignBasis, allowCrop?: boolean) => Promise<AlignOutcome>;
  onClose: () => void;
}

type PendingAction =
  | { kind: 'align'; x: AlignX | null; y: AlignY | null; basis: AlignBasis }
  | { kind: 'distribute'; mode: DistributeMode; basis: AlignBasis };

/**
 * 對齊・均分: a floating tool window that stays open while you work. Aligns one or more layers/groups
 * to the objects' union bounds, the canvas, or the selection, and distributes 2+ targets evenly along
 * edges, centres, or equal gaps.
 */
export default function LayerAlignWindow({
  targetLabel, targetCount, blocker, hasSelection, onAlign, onDistribute, onClose,
}: LayerAlignWindowProps) {
  const { t } = useI18n();
  const selectId = useId();
  const distLabelId = useId();
  const [choice, setChoice] = useState<AlignBasisChoice>(loadChoice);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'info' | 'warn'; text: string } | null>(null);
  const [askCrop, setAskCrop] = useState<PendingAction | null>(null);
  // Each move runs the streak of light across the frame again
  const [sweep, setSweep] = useState(0);
  const basis = resolveAlignBasis(choice, hasSelection, targetCount);
  const reason = blocker
    ? t.align.blocked[blocker]
    : !basis
      ? (choice === 'objects' ? t.align.needMulti : t.align.noSelection)
      : null;
  const alignDisabled = Boolean(reason) || busy;
  const distributeDisabled = alignDisabled || targetCount < 2;

  useEffect(() => { setStatus(null); }, [targetLabel, targetCount, choice]);

  const pick = (next: AlignBasisChoice) => {
    setChoice(next);
    try { localStorage.setItem(BASIS_KEY, next); } catch { /* this tab still remembers */ }
  };

  const execute = async (action: PendingAction, allowCrop = false) => {
    setBusy(true);
    let outcome: AlignOutcome = 'failed';
    try {
      outcome = action.kind === 'align'
        ? await onAlign(action.x, action.y, action.basis, allowCrop)
        : await onDistribute(action.mode, action.basis, allowCrop);
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
    } else if (outcome === 'needMulti') {
      setStatus({ tone: 'warn', text: t.align.needMulti });
    } else {
      setStatus({ tone: 'warn', text: t.align.failed });
    }
  };

  const runAlign = (x: AlignX | null, y: AlignY | null) => {
    if (basis) void execute({ kind: 'align', x, y, basis });
  };

  const runDistribute = (mode: DistributeMode) => {
    if (basis) void execute({ kind: 'distribute', mode, basis });
  };

  const btn = 'atelier-icon-btn relative z-[1] h-10 w-10 disabled:cursor-not-allowed disabled:opacity-35';
  const cellName = (x: AlignX, y: AlignY) => (x === 'center' && y === 'center'
    ? t.align.middle
    : t.align.both.replace('{x}', t.align.x[x]).replace('{y}', t.align.y[y]));
  const titleMeta = targetLabel || (targetCount > 1 ? t.align.targetCount.replace('{count}', String(targetCount)) : null);

  return (
    <>
      <ToolWindow id="layer-align" icon={<AlignWindowIcon />}
        title={
          <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
            <span className="shrink-0">{t.align.title}</span>
            {titleMeta && <span className="truncate font-normal text-neutral-400">{titleMeta}</span>}
          </span>
        }
        onClose={onClose} initial={{ x: -300, y: 132, w: 272, h: 0 }} minW={240} minH={120}>
        {/* Side by side when there is room (tablet / phone held sideways), else stacked cleanly */}
        <div className="flex flex-wrap items-start justify-center gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-44 space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <label htmlFor={selectId} className="shrink-0 text-[11px] text-neutral-400">{t.align.basis}</label>
              <select id={selectId} value={choice} onChange={(e) => pick(e.target.value as AlignBasisChoice)}
                className="atelier-field h-7 min-w-[5rem] flex-1 px-2 text-xs">
                {ALIGN_BASIS_CHOICES.map((c) => <option key={c} value={c}>{t.align.basisNames[c]}</option>)}
              </select>
              {choice === 'auto' && basis && (
                <span className="shrink-0 whitespace-nowrap text-[11px] text-indigo-300">
                  {t.align.autoUses.replace('{basis}', t.align.basisNames[basis])}
                </span>
              )}
            </div>
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
                <button key={x} type="button" disabled={alignDisabled} onClick={() => runAlign(x, null)} title={t.align.x[x]} aria-label={t.align.x[x]}
                  className={btn} style={{ gridColumn: i + 2, gridRow: 1 }}>
                  <AlignEdgeIcon axis="x" at={AT[i]} />
                </button>
              ))}
            </div>
            <div role="group" aria-label={t.align.vertical} className="contents">
              {YS.map((y, i) => (
                <button key={y} type="button" disabled={alignDisabled} onClick={() => runAlign(null, y)} title={t.align.y[y]} aria-label={t.align.y[y]}
                  className={btn} style={{ gridColumn: 1, gridRow: i + 2 }}>
                  <AlignEdgeIcon axis="y" at={AT[i]} />
                </button>
              ))}
            </div>
            <div role="group" aria-label={t.align.pad} className="contents">
              {YS.map((y, row) => XS.map((x, col) => (
                <button key={`${x}-${y}`} type="button" disabled={alignDisabled} onClick={() => runAlign(x, y)}
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
                  <button key={mode} type="button" disabled={distributeDisabled} onClick={() => runDistribute(mode)}
                    title={t.align.dist[mode]} aria-label={t.align.dist[mode]} className={btn}>
                    <DistributeIcon mode={mode} />
                  </button>
                ))}
              </div>
              <div role="group" aria-label={t.align.distributeV} className="grid grid-cols-4 gap-1">
                {DIST_V.map((mode) => (
                  <button key={mode} type="button" disabled={distributeDisabled} onClick={() => runDistribute(mode)}
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
