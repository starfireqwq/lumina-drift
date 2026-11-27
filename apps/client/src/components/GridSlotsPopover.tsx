import React from 'react';
import { CanvasGridConfig, getGridSlotLabel, GRID_MAX_DIM, GRID_MIN_DIM } from '@atelier/shared';
import { Crosshair, LayoutGrid, Trash2, UserCheck, UserMinus, X } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

interface GridSlotsPopoverProps {
  open: boolean;
  onClose: () => void;
  grid: CanvasGridConfig;
  canManage: boolean;
  canEdit: boolean;
  currentUserId?: string;
  onUpdateGrid: (patch: { enabled?: boolean; rows?: number; cols?: number; showLabels?: boolean; clearSlots?: boolean }) => void;
  onClaimSlot: (slotIndex: number) => void;
  onReleaseSlot: (slotIndex: number) => void;
  onFocusSlot: (slotIndex: number) => void;
}

const PRESETS: Array<[number, number]> = [
  [2, 2],
  [2, 3],
  [3, 3],
  [4, 4],
];

export const GridSlotsPopover: React.FC<GridSlotsPopoverProps> = ({
  open,
  onClose,
  grid,
  canManage,
  canEdit,
  currentUserId,
  onUpdateGrid,
  onClaimSlot,
  onReleaseSlot,
  onFocusSlot,
}) => {
  const { t } = useI18n();
  if (!open) return null;

  const total = grid.rows * grid.cols;
  const slotMap = new Map(grid.slots.map((s) => [s.slotIndex, s]));
  const countText = t.collab.gridSlotCount
    .replace('{claimed}', String(grid.slots.length))
    .replace('{total}', String(total));

  return (
    <div
      role="dialog"
      aria-label={t.collab.gridModeTitle}
      data-testid="grid-slots-popover"
      className="atelier-popover absolute bottom-12 right-3 z-40 flex w-80 max-w-[calc(100vw-24px)] flex-col gap-2.5 rounded-xl border border-neutral-700/80 bg-neutral-900/95 p-3 text-xs text-neutral-200 shadow-2xl backdrop-blur-md"
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 pb-2">
        <div className="flex items-center gap-1.5 font-semibold text-neutral-100">
          <LayoutGrid className="h-4 w-4 text-indigo-400" />
          <span>{t.collab.gridModeTitle}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.common.close}
          className="atelier-icon-btn h-6 w-6"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Mode toggle & Grid dimensions */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 font-medium text-neutral-200">
            <input
              type="checkbox"
              data-testid="grid-mode-enable-toggle"
              checked={grid.enabled}
              disabled={!canManage}
              onChange={(e) => onUpdateGrid({ enabled: e.currentTarget.checked })}
              className="h-3.5 w-3.5 accent-indigo-500"
            />
            <span>{t.collab.gridEnable}</span>
          </label>
          <span className="text-[11px] font-mono text-indigo-300">{countText}</span>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center gap-1.5 text-[11px] text-neutral-300">
            <span>{t.collab.gridRows}</span>
            <input
              type="number"
              data-testid="grid-rows-input"
              min={GRID_MIN_DIM}
              max={GRID_MAX_DIM}
              value={grid.rows}
              disabled={!canManage}
              onChange={(e) => {
                const v = Math.max(GRID_MIN_DIM, Math.min(GRID_MAX_DIM, Number(e.currentTarget.value) || 1));
                onUpdateGrid({ rows: v });
              }}
              className="atelier-field h-7 w-14 px-1.5 text-center font-mono text-xs"
            />
          </label>
          <label className="flex flex-1 items-center gap-1.5 text-[11px] text-neutral-300">
            <span>{t.collab.gridCols}</span>
            <input
              type="number"
              data-testid="grid-cols-input"
              min={GRID_MIN_DIM}
              max={GRID_MAX_DIM}
              value={grid.cols}
              disabled={!canManage}
              onChange={(e) => {
                const v = Math.max(GRID_MIN_DIM, Math.min(GRID_MAX_DIM, Number(e.currentTarget.value) || 1));
                onUpdateGrid({ cols: v });
              }}
              className="atelier-field h-7 w-14 px-1.5 text-center font-mono text-xs"
            />
          </label>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-1">
            {PRESETS.map(([r, c]) => (
              <button
                key={`${r}x${c}`}
                type="button"
                data-testid={`grid-preset-${r}x${c}`}
                onClick={() => onUpdateGrid({ enabled: true, rows: r, cols: c })}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] transition ${
                  grid.rows === r && grid.cols === c && grid.enabled
                    ? 'border-indigo-500 bg-indigo-600/30 text-indigo-200'
                    : 'border-neutral-700 bg-neutral-800/80 text-neutral-300 hover:bg-neutral-700/80'
                }`}
              >
                {r}×{c}
              </button>
            ))}
            <button
              type="button"
              data-testid="grid-clear-claims-btn"
              disabled={grid.slots.length === 0}
              onClick={() => onUpdateGrid({ clearSlots: true })}
              className="ml-auto inline-flex items-center gap-1 rounded border border-rose-800/70 bg-rose-950/50 px-1.5 py-0.5 text-[11px] text-rose-200 hover:bg-rose-900/60 disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              <span>{t.collab.gridClearAll}</span>
            </button>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-300">
            <input
              type="checkbox"
              data-testid="grid-show-labels-toggle"
              checked={grid.showLabels}
              disabled={!canManage}
              onChange={(e) => onUpdateGrid({ showLabels: e.currentTarget.checked })}
              className="h-3.5 w-3.5 accent-indigo-500"
            />
            <span>{t.collab.gridShowLabels}</span>
          </label>
          {!canManage && (
            <span className="truncate text-[10px] text-neutral-400" title={t.collab.gridAdminOnlyHint}>
              {t.collab.gridAdminOnlyHint}
            </span>
          )}
        </div>
      </div>

      {/* Interactive Slot Grid */}
      {grid.enabled && (
        <div
          className="grid max-h-60 gap-1.5 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950/70 p-2"
          style={{ gridTemplateColumns: `repeat(${Math.min(grid.cols, 4)}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: total }, (_, idx) => {
            const row = Math.floor(idx / grid.cols);
            const col = idx % grid.cols;
            const code = getGridSlotLabel(row, col);
            const slot = slotMap.get(idx);
            const isMine = Boolean(slot && currentUserId && slot.userId === currentUserId);
            const canRelease = Boolean(slot && canEdit && (isMine || canManage));
            const canClaim = Boolean(!slot && canEdit);

            return (
              <div
                key={idx}
                data-testid={`grid-slot-card-${idx}`}
                style={slot ? { borderColor: `${slot.color}88` } : undefined}
                className={`flex flex-col gap-1 rounded-md border p-1.5 text-[10px] transition ${
                  slot
                    ? isMine
                      ? 'bg-indigo-950/50'
                      : 'bg-neutral-900/90'
                    : 'border-neutral-800 bg-neutral-900/40'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono font-bold text-indigo-300">{code}</span>
                  <button
                    type="button"
                    data-testid={`grid-focus-slot-${idx}`}
                    onClick={() => onFocusSlot(idx)}
                    title={t.collab.gridSlotFocus}
                    className="rounded p-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-white"
                  >
                    <Crosshair className="h-3 w-3" />
                  </button>
                </div>
                <div className="truncate text-[10px]" title={slot ? slot.displayName : t.collab.gridSlotEmpty}>
                  {slot ? (
                    <span className="inline-flex items-center gap-1 text-neutral-100">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: slot.color }} />
                      <span className="truncate">{slot.displayName}</span>
                    </span>
                  ) : (
                    <span className="text-neutral-500">{t.collab.gridSlotEmpty}</span>
                  )}
                </div>
                {canClaim && (
                  <button
                    type="button"
                    data-testid={`grid-claim-slot-${idx}`}
                    onClick={() => onClaimSlot(idx)}
                    className="mt-auto inline-flex items-center justify-center gap-0.5 rounded bg-indigo-600/80 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-500"
                  >
                    <UserCheck className="h-2.5 w-2.5" />
                    <span>{t.collab.gridSlotClaim}</span>
                  </button>
                )}
                {canRelease && (
                  <button
                    type="button"
                    data-testid={`grid-release-slot-${idx}`}
                    onClick={() => onReleaseSlot(idx)}
                    className="mt-auto inline-flex items-center justify-center gap-0.5 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-200 hover:bg-rose-900/70 hover:text-rose-100"
                  >
                    <UserMinus className="h-2.5 w-2.5" />
                    <span>{t.collab.gridSlotRelease}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
