import React from 'react';
import { CanvasGridConfig, getGridSlotLabel, getGridSlotRect } from '@atelier/shared';
import { Crosshair, User } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

interface GridSlotsOverlayProps {
  grid: CanvasGridConfig;
  canvasWidth: number;
  canvasHeight: number;
  currentUserId?: string;
  canvasToScreen: (cx: number, cy: number) => { x: number; y: number };
  onFocusSlot: (slotIndex: number) => void;
}

/**
 * Renders non-blocking canvas grid lines and slot claim labels in screen space
 * so panning, zooming, rotation, and mirror flip stay aligned with the canvas.
 */
export const GridSlotsOverlay: React.FC<GridSlotsOverlayProps> = ({
  grid,
  canvasWidth,
  canvasHeight,
  currentUserId,
  canvasToScreen,
  onFocusSlot,
}) => {
  const { t } = useI18n();
  if (!grid.enabled) return null;

  const { rows, cols } = grid;
  const slotMap = new Map(grid.slots.map((s) => [s.slotIndex, s]));
  const total = rows * cols;

  // Compute canvas outer quad and internal divider lines in screen coordinates
  const lines: Array<{ key: string; x1: number; y1: number; x2: number; y2: number; border?: boolean }> = [];
  for (let c = 0; c <= cols; c++) {
    const cx = (canvasWidth * c) / cols;
    const p1 = canvasToScreen(cx, 0);
    const p2 = canvasToScreen(cx, canvasHeight);
    lines.push({ key: `v-${c}`, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, border: c === 0 || c === cols });
  }
  for (let r = 0; r <= rows; r++) {
    const cy = (canvasHeight * r) / rows;
    const p1 = canvasToScreen(0, cy);
    const p2 = canvasToScreen(canvasWidth, cy);
    lines.push({ key: `h-${r}`, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, border: r === 0 || r === rows });
  }

  const slotBadges: Array<{
    slotIndex: number;
    code: string;
    x: number;
    y: number;
    claimedBy?: string;
    color?: string;
    label?: string;
    isMine: boolean;
  }> = [];

  if (grid.showLabels) {
    for (let idx = 0; idx < total; idx++) {
      const rect = getGridSlotRect(grid, idx, canvasWidth, canvasHeight);
      if (!rect) continue;
      const topLeft = canvasToScreen(rect.x + Math.min(10, rect.width * 0.08), rect.y + Math.min(10, rect.height * 0.08));
      const claimed = slotMap.get(idx);
      slotBadges.push({
        slotIndex: idx,
        code: getGridSlotLabel(rect.row, rect.col),
        x: topLeft.x,
        y: topLeft.y,
        claimedBy: claimed?.displayName,
        color: claimed?.color,
        label: claimed?.label,
        isMine: Boolean(claimed && currentUserId && claimed.userId === currentUserId),
      });
    }
  }

  return (
    <div
      data-testid="grid-slots-overlay"
      data-grid-rows={rows}
      data-grid-cols={cols}
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden select-none"
    >
      <svg className="h-full w-full overflow-visible">
        {lines.map((ln) => (
          <line
            key={ln.key}
            x1={ln.x1}
            y1={ln.y1}
            x2={ln.x2}
            y2={ln.y2}
            stroke={ln.border ? 'rgba(99, 102, 241, 0.72)' : 'rgba(99, 102, 241, 0.55)'}
            strokeWidth={ln.border ? 1.75 : 1.25}
            strokeDasharray={ln.border ? undefined : '6 4'}
          />
        ))}
      </svg>

      {slotBadges.map((b) => (
        <button
          key={b.slotIndex}
          type="button"
          data-testid={`grid-slot-badge-${b.slotIndex}`}
          data-claimed-by={b.claimedBy ?? ''}
          onClick={(e) => {
            e.stopPropagation();
            onFocusSlot(b.slotIndex);
          }}
          title={`${b.code}${b.claimedBy ? ` · ${b.claimedBy}` : ` · ${t.collab.gridSlotEmpty}`} (${t.collab.gridSlotFocus})`}
          style={{
            transform: `translate3d(${Math.round(b.x)}px, ${Math.round(b.y)}px, 0)`,
            borderColor: b.color ? `${b.color}AA` : undefined,
          }}
          className={`pointer-events-auto absolute left-0 top-0 inline-flex max-w-[160px] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium shadow-sm backdrop-blur-sm transition hover:brightness-110 ${
            b.claimedBy
              ? b.isMine
                ? 'bg-indigo-950/90 text-indigo-100'
                : 'bg-neutral-950/85 text-neutral-100'
              : 'border-neutral-600/70 bg-neutral-950/75 text-neutral-300'
          }`}
        >
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: b.color || '#64748b' }}
          />
          <span className="font-mono font-bold text-indigo-300">{b.code}</span>
          {b.claimedBy ? (
            <span className="inline-flex min-w-0 items-center gap-0.5 truncate">
              <User className="h-2.5 w-2.5 shrink-0 opacity-75" />
              <span className="truncate">{b.claimedBy}</span>
            </span>
          ) : (
            <span className="truncate text-neutral-400">{t.collab.gridSlotEmpty}</span>
          )}
          <Crosshair className="h-2.5 w-2.5 shrink-0 opacity-60" />
        </button>
      ))}
    </div>
  );
};
