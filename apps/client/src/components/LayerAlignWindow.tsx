import React, { useEffect, useId, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ToolWindow } from './workspace/ToolWindow';
import { AtelierModal, modalButton } from './AtelierModal';
import { OverlayPresence } from './OverlayPresence';
import { useI18n } from '../context/I18nContext';
import {
  ALIGN_BASIS_CHOICES, resolveAlignBasis,
  type AlignBasis, type AlignBasisChoice, type AlignBlocker, type AlignX, type AlignY,
} from '../utils/layerAlign';
import type { AlignOutcome } from './workspace/tools/useLayerAlign';

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

/** The window's own mark: a dashed frame with a block snapped into its corner */
export const AlignWindowIcon: React.FC<{ className?: string }> = ({ className = 'h-4 w-4' }) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.2 1.6" />
    <rect x="3.5" y="3.5" width="6" height="5" rx="1.2" fill="currentColor" />
  </svg>
);

interface LayerAlignWindowProps {
  /** The layer that moves (the active one), or null */
  layerName: string | null;
  /** Why it cannot move now (a key of t.align.blocked) */
  blocker: AlignBlocker | null;
  hasSelection: boolean;
  onAlign: (x: AlignX | null, y: AlignY | null, basis: AlignBasis, allowCrop?: boolean) => Promise<AlignOutcome>;
  onClose: () => void;
}

/**
 * 對齊: a small window that stays open while you work. Three buttons above the frame move the
 * layer left / right, three beside it up / down, and the 3×3 pad inside the frame does both at
 * once. The frame is the canvas or the selection (the whole layer moves; nothing is cut out).
 */
export default function LayerAlignWindow({ layerName, blocker, hasSelection, onAlign, onClose }: LayerAlignWindowProps) {
  const { t } = useI18n();
  const selectId = useId();
  const [choice, setChoice] = useState<AlignBasisChoice>(loadChoice);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'info' | 'warn'; text: string } | null>(null);
  const [askCrop, setAskCrop] = useState<{ x: AlignX | null; y: AlignY | null; basis: AlignBasis } | null>(null);
  // Each move runs the streak of light across the frame again
  const [sweep, setSweep] = useState(0);
  const basis = resolveAlignBasis(choice, hasSelection);
  const reason = blocker ? t.align.blocked[blocker] : !basis ? t.align.noSelection : null;
  const disabled = Boolean(reason) || busy;

  useEffect(() => { setStatus(null); }, [layerName, choice]);

  const pick = (next: AlignBasisChoice) => {
    setChoice(next);
    try { localStorage.setItem(BASIS_KEY, next); } catch { /* this tab still remembers */ }
  };

  const run = async (x: AlignX | null, y: AlignY | null, allowCrop = false, useBasis: AlignBasis | null = basis) => {
    if (!useBasis) return;
    setBusy(true);
    let outcome: AlignOutcome = 'failed';
    try {
      outcome = await onAlign(x, y, useBasis, allowCrop);
    } finally {
      setBusy(false);
    }
    if (outcome === 'moved') {
      setStatus({ tone: 'ok', text: t.align.done });
      setSweep((n) => n + 1);
    } else if (outcome === 'confirm') {
      setAskCrop({ x, y, basis: useBasis });
    } else if (outcome === 'aligned') {
      setStatus({ tone: 'info', text: t.align.alreadyAligned });
    } else if (outcome === 'empty') {
      setStatus({ tone: 'info', text: t.align.empty });
    } else {
      setStatus({ tone: 'warn', text: outcome === 'noSelection' ? t.align.noSelection : t.align.failed });
    }
  };

  const btn = 'atelier-icon-btn relative z-[1] h-10 w-10 disabled:cursor-not-allowed disabled:opacity-35';
  const cellName = (x: AlignX, y: AlignY) => (x === 'center' && y === 'center'
    ? t.align.middle
    : t.align.both.replace('{x}', t.align.x[x]).replace('{y}', t.align.y[y]));

  return (
    <>
      <ToolWindow id="layer-align" icon={<AlignWindowIcon />}
        title={<>{t.align.title}{layerName && <span className="ml-1.5 font-normal text-neutral-500">{layerName}</span>}</>}
        onClose={onClose} initial={{ x: -300, y: 132, w: 252, h: 0 }} minW={228} minH={120}>
        {/* Side by side when there is room (a phone held sideways), else the basis above the pad */}
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
          <div className="min-w-0 flex-1 basis-48 space-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor={selectId} className="shrink-0 text-[11px] text-neutral-400">{t.align.basis}</label>
            <select id={selectId} value={choice} onChange={(e) => pick(e.target.value as AlignBasisChoice)}
              className="atelier-field h-7 min-w-0 flex-1 px-2 text-xs">
              {ALIGN_BASIS_CHOICES.map((c) => <option key={c} value={c}>{t.align.basisNames[c]}</option>)}
            </select>
            {choice === 'auto' && basis && (
              <span className="shrink-0 whitespace-nowrap text-[11px] text-indigo-300">{t.align.autoUses.replace('{basis}', t.align.basisNames[basis])}</span>
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
                <button key={x} type="button" disabled={disabled} onClick={() => void run(x, null)} title={t.align.x[x]} aria-label={t.align.x[x]}
                  className={btn} style={{ gridColumn: i + 2, gridRow: 1 }}>
                  <AlignEdgeIcon axis="x" at={AT[i]} />
                </button>
              ))}
            </div>
            <div role="group" aria-label={t.align.vertical} className="contents">
              {YS.map((y, i) => (
                <button key={y} type="button" disabled={disabled} onClick={() => void run(null, y)} title={t.align.y[y]} aria-label={t.align.y[y]}
                  className={btn} style={{ gridColumn: 1, gridRow: i + 2 }}>
                  <AlignEdgeIcon axis="y" at={AT[i]} />
                </button>
              ))}
            </div>
            <div role="group" aria-label={t.align.pad} className="contents">
              {YS.map((y, row) => XS.map((x, col) => (
                <button key={`${x}-${y}`} type="button" disabled={disabled} onClick={() => void run(x, y)}
                  title={cellName(x, y)} aria-label={cellName(x, y)}
                  className={`${btn} text-indigo-200`} style={{ gridColumn: col + 2, gridRow: row + 2 }}>
                  <AlignCellIcon col={col} row={row} />
                </button>
              )))}
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
                if (ask) void run(ask.x, ask.y, true, ask.basis);
              }}>{t.align.cropConfirm}</button>
            </>
          )}>
          <p className="leading-relaxed text-neutral-300">{t.align.cropBody}</p>
        </AtelierModal>
      </OverlayPresence>
    </>
  );
}
