import React, { useRef, useState } from 'react';
import {
  Brush,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eraser,
  Grid2x2,
  Hand,
  Keyboard,
  Layers,
  Paintbrush,
  Pencil,
  Pipette,
  Redo2,
  SlidersHorizontal,
  Undo2,
  Users,
} from 'lucide-react';
import type { ToolType } from '@atelier/shared';
import { MAX_BRUSH_SIZE } from './toolCatalog';
import type { MobilePanelDef } from './DockSystem';
import { useI18n } from '../../context/I18nContext';

const SIDE_COLLAPSED_KEY = 'atelier_touch_side_collapsed';
const DOCK_COLLAPSED_KEY = 'atelier_touch_dock_collapsed';

const LOG_MAX = Math.log(MAX_BRUSH_SIZE);
const sizeToPos = (size: number) => Math.max(0, Math.min(1, Math.log(Math.max(1, size)) / LOG_MAX));
const posToSize = (pos: number) => Math.max(1, Math.min(MAX_BRUSH_SIZE, Math.round(Math.exp(Math.max(0, Math.min(1, pos)) * LOG_MAX))));

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore
  }
}

interface FloatingTrackProps {
  label: string;
  position: number;
  valueText: string;
  fill: string;
  onChange: (pos: number) => void;
  onDragChange?: (dragging: boolean) => void;
}

const FloatingVerticalTrack: React.FC<FloatingTrackProps> = ({
  label,
  position,
  valueText,
  fill,
  onChange,
  onDragChange,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const updateFromEvent = (e: React.PointerEvent) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    onChange(Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)));
  };

  return (
    <div className="relative flex flex-col items-center">
      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap rounded-lg border border-neutral-600/80 bg-neutral-950/95 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white shadow-xl"
        >
          {valueText}
        </div>
      )}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position * 100)}
        aria-valuetext={valueText}
        title={`${label}: ${valueText}`}
        style={{ touchAction: 'none' }}
        className="relative h-24 w-6 cursor-ns-resize overflow-hidden rounded-full border border-white/15 bg-neutral-950/75 shadow-inner outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        onPointerDown={(e) => {
          e.stopPropagation();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
          setDragging(true);
          onDragChange?.(true);
          updateFromEvent(e);
        }}
        onPointerMove={(e) => {
          if (dragging || (e.buttons & 1) !== 0 || e.currentTarget.hasPointerCapture?.(e.pointerId)) {
            updateFromEvent(e);
          }
        }}
        onPointerUp={(e) => {
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
          setDragging(false);
          onDragChange?.(false);
        }}
        onPointerCancel={() => {
          setDragging(false);
          onDragChange?.(false);
        }}
      >
        <div
          className="absolute inset-x-0 bottom-0 rounded-full transition-[height] duration-75"
          style={{ height: `${position * 100}%`, background: fill }}
        />
        <div
          className="absolute left-1/2 h-2.5 w-4 -translate-x-1/2 translate-y-1/2 rounded-full border border-white/90 bg-white shadow"
          style={{ bottom: `${Math.max(4, Math.min(96, position * 100))}%` }}
        />
      </div>
    </div>
  );
};

export interface TouchSideIslandProps {
  side?: 'left' | 'right';
  size: number;
  opacity: number;
  color: string;
  currentTool: ToolType;
  canUndo: boolean;
  canRedo: boolean;
  onSize: (size: number) => void;
  onOpacity: (opacity: number) => void;
  onSizeDrag: (dragging: boolean) => void;
  onToggleEyedropper: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * Procraft-inspired floating side brush island for mobile/tablet non-desktop mode:
 * vertical brush size, quick eyedropper, vertical opacity, undo/redo, and edge collapse toggle.
 */
export const TouchSideIsland: React.FC<TouchSideIslandProps> = ({
  side = 'left',
  size,
  opacity,
  color,
  currentTool,
  canUndo,
  canRedo,
  onSize,
  onOpacity,
  onSizeDrag,
  onToggleEyedropper,
  onUndo,
  onRedo,
}) => {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(() => readBool(SIDE_COLLAPSED_KEY));
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeBool(SIDE_COLLAPSED_KEY, next);
      return next;
    });
  };

  const isRight = side === 'right';
  const edgePos = isRight ? 'right-2' : 'left-2';
  const CollapseIcon = isRight
    ? (collapsed ? ChevronLeft : ChevronRight)
    : (collapsed ? ChevronRight : ChevronLeft);

  if (collapsed) {
    return (
      <div
        data-touch-island="side-collapsed"
        className={`pointer-events-auto absolute top-1/2 z-30 -translate-y-1/2 ${isRight ? 'right-0' : 'left-0'}`}
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={t.touchUi.expandSideControls}
          title={t.touchUi.expandSideControls}
          className={`atelier-popover flex h-14 w-6 items-center justify-center border border-neutral-700/80 bg-neutral-900/80 text-neutral-300 backdrop-blur-md shadow-xl transition hover:text-white ${
            isRight ? 'rounded-l-xl border-r-0' : 'rounded-r-xl border-l-0'
          }`}
        >
          <CollapseIcon className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-touch-island="side"
      className={`atelier-popover pointer-events-auto absolute top-1/2 z-30 flex -translate-y-1/2 flex-col items-center gap-2 rounded-2xl border border-neutral-700/75 bg-neutral-900/82 px-1.5 py-2 backdrop-blur-md shadow-2xl ${edgePos}`}
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={t.touchUi.collapseSideControls}
        title={t.touchUi.collapseSideControls}
        className="flex h-6 w-8 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-white/10 hover:text-white"
      >
        <CollapseIcon className="h-3.5 w-3.5" />
      </button>

      <span className="text-[10px] font-mono tabular-nums text-neutral-300">{size}</span>
      <FloatingVerticalTrack
        label={t.studio.brushSize}
        position={sizeToPos(size)}
        valueText={`${size} px`}
        fill="linear-gradient(to top, rgba(99,102,241,0.5), rgba(129,140,248,0.95))"
        onChange={(pos) => onSize(posToSize(pos))}
        onDragChange={onSizeDrag}
      />

      <button
        type="button"
        onClick={onToggleEyedropper}
        aria-label={t.tools.eyedropper}
        title={t.tools.eyedropper}
        aria-pressed={currentTool === 'eyedropper'}
        className={`flex h-8 w-8 items-center justify-center rounded-xl border transition ${
          currentTool === 'eyedropper'
            ? 'border-indigo-400 bg-indigo-500/30 text-white shadow-inner'
            : 'border-white/15 bg-neutral-800/80 text-neutral-200 hover:bg-neutral-700/80'
        }`}
      >
        <Pipette className="h-4 w-4" />
      </button>

      <FloatingVerticalTrack
        label={t.studio.opacity}
        position={opacity}
        valueText={`${Math.round(opacity * 100)}%`}
        fill={`linear-gradient(to top, transparent, ${color})`}
        onChange={(pos) => onOpacity(Math.max(0.01, Math.min(1, Math.round(pos * 100) / 100)))}
      />
      <span className="text-[10px] font-mono tabular-nums text-neutral-400">{Math.round(opacity * 100)}%</span>

      <div className="my-0.5 h-px w-6 bg-white/10" />

      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        aria-label={t.common.undo}
        title={t.common.undo}
        className="flex h-8 w-8 items-center justify-center rounded-xl text-neutral-200 transition hover:bg-white/10 disabled:opacity-35"
      >
        <Undo2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        aria-label={t.common.redo}
        title={t.common.redo}
        className="flex h-8 w-8 items-center justify-center rounded-xl text-neutral-200 transition hover:bg-white/10 disabled:opacity-35"
      >
        <Redo2 className="h-4 w-4" />
      </button>
    </div>
  );
};

export interface TouchToolIslandProps {
  isTablet: boolean;
  currentTool: ToolType;
  color: string;
  activeSheet: MobilePanelDef['id'] | null;
  showMembers: boolean;
  onSelectTool: (tool: ToolType) => void;
  onOpenSheet: (id: MobilePanelDef['id']) => void;
  onOpenBrushToolset: () => void;
  onToggleMembers: () => void;
}

/**
 * Procraft-inspired floating bottom tool island for phones & non-desktop touch tablets.
 * Keeps the canvas full-bleed while offering 1-tap primary tools, slide-out drawers, and collapse-to-pill.
 */
export const TouchToolIsland: React.FC<TouchToolIslandProps> = ({
  isTablet,
  currentTool,
  color,
  activeSheet,
  showMembers,
  onSelectTool,
  onOpenSheet,
  onOpenBrushToolset,
  onToggleMembers,
}) => {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(() => readBool(DOCK_COLLAPSED_KEY));
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeBool(DOCK_COLLAPSED_KEY, next);
      return next;
    });
  };

  const toolBtnClass = (active: boolean) =>
    `atelier-icon-btn h-10 w-10 shrink-0 rounded-xl transition ${
      active
        ? 'bg-indigo-500/30 text-white ring-1 ring-indigo-400/80'
        : 'text-neutral-200 hover:bg-white/10'
    }`;

  if (collapsed) {
    return (
      <div
        data-workspace-entry="mobile-tools"
        data-touch-island="dock-collapsed"
        className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center px-3"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div
          className="atelier-popover pointer-events-auto flex items-center gap-1.5 rounded-full border border-neutral-700/80 bg-neutral-900/88 px-2.5 py-1 backdrop-blur-md shadow-2xl"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => onOpenSheet('toolPicker')}
            aria-label={t.navbar.tools}
            aria-haspopup="dialog"
            className="atelier-icon-btn h-8 w-8 rounded-full"
          >
            <Grid2x2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onOpenSheet('color')}
            aria-label="色彩"
            className="atelier-icon-btn h-8 w-8 rounded-full"
          >
            <span className="h-5 w-5 rounded-full border-2 border-white/85 shadow" style={{ backgroundColor: color }} />
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={t.touchUi.expandToolIsland}
            title={t.touchUi.expandToolIsland}
            className="atelier-icon-btn h-8 w-8 rounded-full text-neutral-300 hover:text-white"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-workspace-entry="mobile-tools"
      data-touch-island="dock"
      className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center px-2"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div
        className="atelier-popover no-scrollbar pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-neutral-700/80 bg-neutral-900/86 px-2 py-1.5 backdrop-blur-md shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* All Tools Drawer */}
        <button
          type="button"
          onClick={() => onOpenSheet('toolPicker')}
          aria-label={t.navbar.tools}
          aria-haspopup="dialog"
          className={toolBtnClass(activeSheet === 'toolPicker')}
        >
          <Grid2x2 className="h-5 w-5" />
        </button>

        {/* Primary direct tools */}
        <button
          type="button"
          onClick={() => onSelectTool('brush')}
          aria-label={t.tools.brush}
          title={t.tools.brush}
          className={toolBtnClass(currentTool === 'brush')}
        >
          <Brush className="h-4 w-4" />
        </button>
        {isTablet && (
          <button
            type="button"
            onClick={() => onSelectTool('pencil')}
            aria-label={t.tools.pencil}
            title={t.tools.pencil}
            className={toolBtnClass(currentTool === 'pencil')}
          >
            <Pencil className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onSelectTool('eraser')}
          aria-label={t.tools.eraser}
          title={t.tools.eraser}
          className={toolBtnClass(currentTool === 'eraser')}
        >
          <Eraser className="h-4 w-4" />
        </button>
        {isTablet && (
          <button
            type="button"
            onClick={() => onSelectTool('hand')}
            aria-label={t.tools.hand}
            title={t.tools.hand}
            className={toolBtnClass(currentTool === 'hand')}
          >
            <Hand className="h-4 w-4" />
          </button>
        )}

        <div className="mx-0.5 h-6 w-px shrink-0 bg-white/12" />

        {/* Slide-out Drawer Panel Triggers */}
        <button
          type="button"
          onClick={() => onOpenSheet('color')}
          aria-label="色彩"
          className={toolBtnClass(activeSheet === 'color')}
        >
          <span className="h-6 w-6 rounded-full border-2 border-white/85 shadow" style={{ backgroundColor: color }} />
        </button>
        <button
          type="button"
          onClick={onOpenBrushToolset}
          aria-label={t.brushPreset.toolset}
          className={toolBtnClass(activeSheet === 'brushToolset')}
        >
          <Paintbrush className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => onOpenSheet('layers')}
          aria-label="圖層"
          className={toolBtnClass(activeSheet === 'layers')}
        >
          <Layers className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => onOpenSheet('toolProps')}
          aria-label={t.toolOptions.title}
          className={toolBtnClass(activeSheet === 'toolProps')}
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>
        {showMembers && (
          <button
            type="button"
            onClick={onToggleMembers}
            aria-label="成員"
            className={toolBtnClass(activeSheet === 'members')}
          >
            <Users className="h-5 w-5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpenSheet('quickKeys')}
          aria-label="快捷鍵面板"
          className={toolBtnClass(activeSheet === 'quickKeys')}
        >
          <Keyboard className="h-5 w-5" />
        </button>

        <div className="mx-0.5 h-6 w-px shrink-0 bg-white/12" />

        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={t.touchUi.collapseToolIsland}
          title={t.touchUi.collapseToolIsland}
          className="atelier-icon-btn h-9 w-8 shrink-0 rounded-xl text-neutral-400 hover:bg-white/10 hover:text-white"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
