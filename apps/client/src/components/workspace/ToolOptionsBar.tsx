import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_STABILIZER_LEVEL, STABILIZER_LEVEL_STEP, ToolType, VectorEraserMode, VectorWidthMode } from '@atelier/shared';
import {
  ClipboardPaste,
  Copy,
  Crop,
  Eraser,
  FlipHorizontal2,
  Minus,
  Move,
  Plus,
  Redo2,
  Scissors,
  SquareDashed,
  SlidersHorizontal,
  Undo2,
  X,
} from 'lucide-react';
import { BrushProperties } from '../../engine/BrushRenderer';
import { AntiAliasSelector } from '../AntiAliasSelector';
import { LiquifyMode } from '../../engine/LiquifyEngine';
import { SmudgeMode } from '../../engine/BlurSmudgeEngine';
import { OutlineSettings } from '../../engine/colorOutline';
import { findSubTool, findTool, getLocalizedSubTool, getLocalizedTool, type SubToolId } from './toolCatalog';
import { useShortcutLabel } from './ToolRail';
import { ColorWheelStudio } from '../ColorWheelStudio';
import { CommandBar } from './QuickActions';
import { CORNER_RADIUS_SHAPES, ShapeSubtype } from './tools/useShapeTools';
import { useWheelStep } from '../../hooks/useWheelStep';
import { resolvePluginText } from '../../plugins/pluginApi';
import { getPluginLabels } from '../../plugins/pluginLabels';
import { isPluginToolOptionVisible, type RegisteredPluginTool } from '../../plugins/pluginTools';
import { getPluginToolIcon } from './pluginToolIcons';
import { getUiScale } from '../../theme/uiScale';
import { useI18n } from '../../context/I18nContext';
import { useAnchoredPopover } from '../../utils/popoverPosition';
import { useEffectiveWidth } from '../../hooks/useEffectiveWidth';

export type SelectionMode = 'replace' | 'add' | 'subtract';
export type BezierMode = 'pen' | 'curve';

/* ---------- small controls ---------- */

const Sep = () => <div aria-hidden className="mx-1 h-6 w-px shrink-0 bg-neutral-700/70" />;

/**
 * The outline colour: a swatch that opens the same colour wheel as the colour panel (with the
 * eyedropper). Fixed-position so the scrolling options bar does not clip it.
 */
export const ColorPopoverButton: React.FC<{
  color: string;
  onChange: (hex: string) => void;
  onPick?: () => void;
  label?: string;
  title?: string;
  mixed?: boolean;
  'data-testid'?: string;
}> = ({ color, onChange, onPick, label = '描邊顏色', title, mixed, 'data-testid': testId }) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPopover(open, btnRef, popRef, { align: 'left', gap: 6, margin: 8, fallbackWidth: Math.round(240 * getUiScale()) });
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!btnRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <>
      <button ref={btnRef} type="button" data-outline-color data-testid={testId} aria-label={label} aria-expanded={open} title={title ?? `${label}（色輪與滴管）`}
        onClick={() => setOpen((v) => !v)}
        className="h-7 w-8 shrink-0 rounded border-2 border-neutral-600"
        style={{ backgroundColor: color, backgroundImage: mixed ? 'repeating-linear-gradient(135deg, transparent 0 4px, #737373 4px 8px)' : undefined }} />
      {open && typeof document !== 'undefined' && createPortal(
        <div ref={pos.setPopoverEl} data-outline-color role="dialog" aria-label={label}
          style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
          className="fixed z-[95] w-60 max-w-[calc(100vw-16px)] overflow-y-auto atelier-popover atelier-menu-in p-3">
          <div className="mb-2 text-[11px] font-bold text-neutral-300">{label}</div>
          <ColorWheelStudio isOpen embedded single onClose={() => setOpen(false)}
            brushProps={{ color } as BrushProperties}
            onUpdateBrushProps={(props) => props.color && onChange(props.color)}
            onActivateCanvasEyedropper={onPick ? () => { setOpen(false); onPick(); } : undefined} />
        </div>,
        document.body
      )}
    </>
  );
};

export const Segmented = <T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<{ id: T; label: string; title?: string }>;
  onChange: (v: T) => void;
  label: string;
}) => (
  <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-lg border border-neutral-700 bg-neutral-950/60 p-0.5">
    {options.map((o) => (
      <button key={o.id} type="button" role="radio" aria-checked={value === o.id} title={o.title}
        onClick={() => onChange(o.id)}
        className={`whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium transition ${value === o.id ? 'bg-indigo-600 text-white shadow' : 'text-neutral-300 hover:bg-neutral-800 hover:text-white'}`}>
        {o.label}
      </button>
    ))}
  </div>
);

/** Number box that lets the user clear it and type freely; commits on Enter / blur. */
export const NumberBox: React.FC<{
  value: number;
  min: number;
  max: number;
  step?: number;
  bigStep?: number;
  onCommit: (n: number) => void;
  label: string;
  width?: string;
  suffix?: string;
}> = ({ value, min, max, step = 1, bigStep = 10, onCommit, label, width = 'w-12', suffix }) => {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const valueStep = Math.min(1, step);
  const clampValue = (n: number) => Math.max(min, Math.min(max, Math.round(n / valueStep) * valueStep));
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  useWheelStep(inputRef, (steps, e) => {
    const delta = steps * (e.shiftKey ? bigStep : step);
    const clamped = clampValue(value + delta);
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  });
  const commit = () => {
    setEditing(false);
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const clamped = clampValue(n);
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <label className="flex shrink-0 items-center gap-1">
      <span className="sr-only">{label}</span>
      <input
        ref={inputRef}
        type="text"
        inputMode={valueStep < 1 ? 'decimal' : 'numeric'}
        aria-label={label}
        value={text}
        onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
        onChange={(e) => setText(e.target.value.replace(valueStep < 1 ? /[^0-9.]/g : /[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          if (e.key === 'Escape') { setText(String(value)); setEditing(false); (e.currentTarget as HTMLInputElement).blur(); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const n = Math.max(min, Math.min(max, value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? bigStep : step)));
            onCommit(n);
            setText(String(n));
          }
        }}
        className={`atelier-field h-7 ${width} px-1.5 text-center font-mono text-xs tabular-nums`}
      />
      {suffix && <span className="text-[11px] text-neutral-400">{suffix}</span>}
    </label>
  );
};

const StepNumberField: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  bigStep?: number;
  onCommit: (n: number) => void;
  suffix?: string;
  width?: string;
}> = ({ label, value, min, max, step = 1, bigStep = 10, onCommit, suffix, width = 'w-11' }) => {
  const applyDelta = (delta: number) => {
    const next = Math.max(min, Math.min(max, Math.round(value + delta)));
    if (next !== value) onCommit(next);
  };
  // − [n] + : Shift+click (or Shift+wheel / arrows in the box) steps by bigStep
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="whitespace-nowrap text-[11px] text-neutral-400">{label}</span>
      <div className="flex items-center">
        <button type="button" aria-label={`${label} 減少`} title={`−${step}（Shift −${bigStep}）`} disabled={value <= min}
          onClick={(e) => applyDelta(-(e.shiftKey ? bigStep : step))} className="atelier-icon-btn h-7 w-6">
          <Minus className="h-3 w-3" />
        </button>
        <NumberBox label={label} value={value} min={min} max={max} step={step} bigStep={bigStep} onCommit={onCommit} width={width} suffix={suffix} />
        <button type="button" aria-label={`${label} 增加`} title={`+${step}（Shift +${bigStep}）`} disabled={value >= max}
          onClick={(e) => applyDelta(e.shiftKey ? bigStep : step)} className="atelier-icon-btn h-7 w-6">
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};

const SliderField: React.FC<{
  label: string;
  value: number; // 0..100
  onChange: (v: number) => void;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}> = ({ label, value, onChange, suffix = '%', min = 0, max = 100, step = 1, className = 'w-20' }) => {
  const rangeRef = useRef<HTMLInputElement>(null);
  const wheelStepSize = max >= 150 ? 5 : step;
  useWheelStep(rangeRef, (steps, e) => {
    const delta = steps * (e.shiftKey ? 10 : wheelStepSize);
    const next = Math.max(min, Math.min(max, Math.round((value + delta) / step) * step));
    if (next !== value) onChange(next);
  });
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="text-[11px] text-neutral-400">{label}</span>
      <input ref={rangeRef} type="range" min={min} max={max} step={step} value={value} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))} className={`${className} h-1.5 cursor-pointer`} />
      <NumberBox label={label} value={value} min={min} max={max} step={wheelStepSize} bigStep={10} onCommit={onChange} width="w-10" suffix={suffix} />
    </div>
  );
};

/* ---------- options bar ---------- */

export interface ToolOptionsBarProps {
  currentTool: ToolType;
  activeSubToolId?: SubToolId;
  compact: boolean;
  onOpenOptions?: () => void;
  inPanel?: boolean;
  brushProps: BrushProperties;
  onBrushProps: (p: Partial<BrushProperties>) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  // selection
  hasSelection: boolean;
  selectionMode: SelectionMode;
  onSelectionMode: (m: SelectionMode) => void;
  selectionAntialias: boolean;
  onSelectionAntialias: (enabled: boolean) => void;
  selectionFeather: number;
  onSelectionFeather: (px: number) => void;
  polygonPointCount: number;
  onPolygonFinish: () => void;
  onPolygonCancel: () => void;
  onSelectionTransform: () => void;
  onSelectionMask: () => void;
  onSelectionGrow: (px: number) => void;
  onFeatherActiveSelection: (px: number) => void;
  /** 依顏色範圍選取: pixels of the active layer near the main colour */
  onColorRange: () => void;
  lassoErase: boolean;
  onLassoErase: (on: boolean) => void;
  pasteToNewLayer: boolean;
  onPasteToNewLayer: (on: boolean) => void;
  onClearSelection: () => void;
  onSelectionInvert: () => void;
  onSelectionCopy: () => void;
  onSelectionCut: () => void;
  onSelectionDelete: () => void;
  /** Something was copied: 貼上 is offered */
  canPaste: boolean;
  onPaste: () => void;
  wandTolerance: number;
  onWandTolerance: (n: number) => void;
  wandContiguous: boolean;
  onWandContiguous: (v: boolean) => void;
  // fill
  bucketTolerance: number;
  onBucketTolerance: (n: number) => void;
  bucketReference: 'current' | 'all' | 'specific' | 'none';
  onBucketReference: (r: 'current' | 'all' | 'specific' | 'none') => void;
  bucketMode: 'click' | 'lasso';
  lassoFillErase?: boolean;
  onLassoFillErase?: (erase: boolean) => void;
  gapClosingRadius?: number;
  onGapClosingRadius?: (v: number) => void;
  expandRadius?: number;
  onExpandRadius?: (v: number) => void;
  confirmSoloFullFill?: boolean;
  onConfirmSoloFullFill?: (enabled: boolean) => void;
  outline: OutlineSettings;
  onOutline: (patch: Partial<OutlineSettings>) => void;
  /** Canvas eyedropper for the outline colour (picks once, then returns to the brush) */
  onPickOutlineColor?: () => void;
  gradientType: 'linear' | 'radial';
  onGradientType: (t: 'linear' | 'radial') => void;
  // liquify
  liquifyMode: LiquifyMode;
  onLiquifyMode: (m: LiquifyMode) => void;
  liquifyStrength: number;
  onLiquifyStrength: (s: number) => void;
  liquifyHardness: number;
  onLiquifyHardness: (h: number) => void;
  liquifyRefAreaOnly: boolean;
  onLiquifyRefAreaOnly: (v: boolean) => void;
  smudgeMode: SmudgeMode;
  onSmudgeMode: (m: SmudgeMode) => void;
  // shape
  shapeSubtype: ShapeSubtype;
  onShapeSubtype: (s: ShapeSubtype) => void;
  shapeFillMode: 'stroke' | 'fill' | 'stroke_and_fill';
  onShapeFillMode: (m: 'stroke' | 'fill' | 'stroke_and_fill') => void;
  shapeLineWidth: number;
  onShapeLineWidth: (n: number) => void;
  shapeCornerRadius: number;
  onShapeCornerRadius: (n: number) => void;
  // vector
  vectorEraserMode: VectorEraserMode;
  onVectorEraserMode: (m: VectorEraserMode) => void;
  vectorWidthMode: VectorWidthMode;
  onVectorWidthMode: (m: VectorWidthMode) => void;
  bezierMode: BezierMode;
  onBezierMode: (m: BezierMode) => void;
  bezierPointCount: number;
  onBezierFinish: () => void;
  onBezierCancel: () => void;
  vectorAnchorSelected: boolean;
  onVectorToggleCorner: () => void;
  onVectorDeleteAnchor: () => void;
  // transform
  onStartTransform: () => void;
  onStartPuppetWarp: () => void;
  isTransformActive: boolean;
  eraserMode: 'hard' | 'soft';
  onEraserMode: (mode: 'hard' | 'soft') => void;
  /** 筆刷詳細設定 dialog (brush / pencil / eraser) */
  onOpenBrushSettings?: () => void;
  /** Active v2.5 custom plugin tool, if any */
  activePluginTool?: RegisteredPluginTool | null;
  pluginToolOptions?: Record<string, string | number | boolean>;
  onPluginToolOptionChange?: (key: string, value: string | number | boolean) => void;
  onExitPluginTool?: () => void;
}

export const ToolOptionsBar: React.FC<ToolOptionsBarProps> = (p) => {
  const { t: tr, language } = useI18n();
  const pluginStrings = getPluginLabels(language);
  const t = p.currentTool;
  const subTool = p.activeSubToolId ? findSubTool(p.activeSubToolId) : undefined;
  const activeSubToolId = subTool?.tool === t ? subTool.id : undefined;
  const locTool = activeSubToolId ? getLocalizedSubTool(activeSubToolId, tr) : getLocalizedTool(t, tr);
  const Icon = (activeSubToolId ? subTool : findTool(t))?.icon;
  const shortcut = useShortcutLabel();
  const isClickFill = t === 'bucket' && p.bucketMode === 'click';
  const isLassoFill = t === 'bucket' && p.bucketMode === 'lasso';
  const isPaintUnfilled = t === 'paint_unfilled';
  const fillReference = isPaintUnfilled && p.bucketReference === 'none' ? 'current' : p.bucketReference;
  const isSelectTool = ['select_rect', 'select_ellipse', 'lasso', 'select_polygon', 'magic_wand', 'select_brush', 'select_eraser'].includes(t);
  const selBtn = 'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-neutral-100 hover:bg-indigo-600/40';

  const barRef = useRef<HTMLDivElement>(null);
  const { viewportWidth } = useEffectiveWidth(barRef);
  const isNarrowMobile = !p.inPanel && viewportWidth < 600;
  const historyButtons = (
    <>
      <button type="button" onClick={p.onUndo} disabled={!p.canUndo} title={`${tr.common.undo} (${shortcut('action_undo')})`} aria-label={tr.common.undo} className="atelier-icon-btn h-8 w-8 shrink-0">
        <Undo2 className="h-4 w-4" />
      </button>
      <button type="button" onClick={p.onRedo} disabled={!p.canRedo} title={`${tr.common.redo} (${shortcut('action_redo')})`} aria-label={tr.common.redo} className="atelier-icon-btn h-8 w-8 shrink-0">
        <Redo2 className="h-4 w-4" />
      </button>
    </>
  );

  if (p.onOpenOptions) {
    return (
      <div role="toolbar" aria-label={tr.toolOptions.title} data-workspace-entry="options"
        className="atelier-chrome flex h-10 min-w-0 shrink-0 items-center gap-1 border-b px-2">
        {historyButtons}
        <button type="button" onClick={p.onOpenOptions} aria-haspopup="dialog" aria-label={tr.toolOptions.title}
          className="atelier-icon-btn ml-auto flex h-8 min-w-0 items-center gap-1.5 px-2 text-xs">
          <SlidersHorizontal className="h-4 w-4 shrink-0" />
          <span className="truncate">{p.activePluginTool
            ? resolvePluginText(p.activePluginTool.tool.label, p.activePluginTool.tool.i18nLabel, language)
            : locTool.label}</span>
        </button>
      </div>
    );
  }

  if (p.activePluginTool) {
    const activeTool = p.activePluginTool;
    const PluginIcon = getPluginToolIcon(activeTool.tool.icon);
    const toolLabel = resolvePluginText(activeTool.tool.label, activeTool.tool.i18nLabel, language);
    const toolHint = activeTool.tool.hint
      ? resolvePluginText(activeTool.tool.hint, activeTool.tool.i18nHint, language)
      : undefined;
    const vals = p.pluginToolOptions ?? {};
    const visibleParams = (activeTool.tool.options ?? []).filter((param) =>
      isPluginToolOptionVisible(param, vals),
    );
    return (
      <div
        ref={barRef}
        role="toolbar"
        aria-label={tr.navbar.tools}
        data-workspace-entry="options"
        data-plugin-tool-options={activeTool.key}
        className={`atelier-chrome flex shrink-0 items-center gap-1.5 border-b px-2 text-xs ${
          isNarrowMobile ? 'h-11 overflow-x-auto no-scrollbar touch-pan-x' : 'min-h-11 flex-wrap py-1 content-center'
        }`}
      >
        {!p.inPanel && <>{historyButtons}<Sep /></>}
        <div className="flex shrink-0 items-center gap-1.5 pr-1" title={toolHint}>
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-cyan-500/40 bg-cyan-500/15 text-cyan-200">
            <PluginIcon className="h-4 w-4" />
          </span>
          <span className="font-semibold text-cyan-100">{toolLabel}</span>
          <span className="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-300">
            {pluginStrings.customToolTag}
          </span>
        </div>
        {visibleParams.map((param) => {
          const paramLabel = resolvePluginText(param.label, param.i18nLabel, language);
          const cur = vals[param.key] ?? param.initial;
          if (param.kind === 'range') {
            const num = typeof cur === 'number' ? cur : param.initial;
            return (
              <React.Fragment key={param.key}>
                <Sep />
                <SliderField
                  label={paramLabel}
                  value={num}
                  min={param.min}
                  max={param.max}
                  step={param.step ?? 1}
                  suffix={param.unit ?? ''}
                  onChange={(v) => p.onPluginToolOptionChange?.(param.key, v)}
                />
              </React.Fragment>
            );
          }
          if (param.kind === 'select') {
            const str = typeof cur === 'string' ? cur : param.initial;
            return (
              <React.Fragment key={param.key}>
                <Sep />
                <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-300">
                  <span className="text-neutral-400">{paramLabel}</span>
                  <select
                    value={str}
                    onChange={(e) => p.onPluginToolOptionChange?.(param.key, e.target.value)}
                    className="rounded-md border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-100"
                  >
                    {param.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {resolvePluginText(opt.label, opt.i18nLabel, language)}
                      </option>
                    ))}
                  </select>
                </label>
              </React.Fragment>
            );
          }
          if (param.kind === 'toggle') {
            const checked = typeof cur === 'boolean' ? cur : param.initial;
            return (
              <React.Fragment key={param.key}>
                <Sep />
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-300">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => p.onPluginToolOptionChange?.(param.key, e.target.checked)}
                  />
                  <span>{paramLabel}</span>
                </label>
              </React.Fragment>
            );
          }
          if (param.kind === 'color') {
            const hexVal = typeof cur === 'string' ? cur : param.initial;
            return (
              <React.Fragment key={param.key}>
                <Sep />
                <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-300">
                  <span className="text-neutral-400">{paramLabel}</span>
                  <input
                    type="color"
                    value={hexVal}
                    onChange={(e) => p.onPluginToolOptionChange?.(param.key, e.target.value)}
                    className="h-6 w-7 cursor-pointer rounded border border-neutral-700 bg-transparent p-0"
                  />
                </label>
              </React.Fragment>
            );
          }
          return null;
        })}
        {p.onExitPluginTool && (
          <>
            <Sep />
            <button
              type="button"
              onClick={p.onExitPluginTool}
              className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800"
            >
              <X className="h-3.5 w-3.5" />
              {pluginStrings.toolBackToBrush}
            </button>
          </>
        )}
        <div className={`ml-auto flex items-center border-l border-neutral-800 pl-1 ${isNarrowMobile ? 'shrink-0' : 'max-w-full flex-wrap'}`}>
          <CommandBar wrap={!isNarrowMobile} />
        </div>
      </div>
    );
  }

  return (
    <div ref={barRef} role="toolbar" aria-label={tr.navbar.tools} data-workspace-entry="options"
      className={`atelier-chrome flex shrink-0 items-center gap-1.5 border-b px-2 text-xs ${
        isNarrowMobile ? 'h-11 overflow-x-auto no-scrollbar touch-pan-x' : 'min-h-11 flex-wrap py-1 content-center'
      }`}>
      {!p.inPanel && <>{historyButtons}<Sep /></>}

      {Icon && (
        <div className="flex shrink-0 items-center gap-1.5 pr-1" title={locTool.hint}>
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600/20 text-indigo-300"><Icon className="h-4 w-4" /></span>
          <span className="font-semibold text-neutral-100">{locTool.label}</span>
        </div>
      )}

      {/* Size and opacity live only in the strip at the far left (BrushSideSliders) */}
      {(t === 'brush' || t === 'pencil' || t === 'eraser') && p.onOpenBrushSettings && (
        <>
          <Sep />
          <button type="button" onClick={p.onOpenBrushSettings} title={tr.studio.brushDetailSettings}
            className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800">
            <SlidersHorizontal className="h-3.5 w-3.5" />{tr.studio.brushSettings}
          </button>
        </>
      )}
      {t === 'brush' && !p.compact && (
        <>
          <Sep />
          <SliderField label={tr.toolOptions.hardness} value={Math.round(p.brushProps.hardness * 100)} onChange={(v) => p.onBrushProps({ hardness: v / 100 })} />
        </>
      )}
      {(t === 'brush' || t === 'pencil' || t === 'eraser') && !p.compact && (
        <>
          <Sep />
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-[11px] text-neutral-400">{tr.studio.antiAlias}</span>
            <AntiAliasSelector compact requireCoverage={t === 'eraser'} value={p.brushProps.antiAlias} onChange={(antiAlias) => p.onBrushProps({ antiAlias })} />
          </div>
        </>
      )}
      {(t === 'brush' || t === 'pencil') && !p.compact && (
        <>
          <Sep />
          <SliderField label={tr.toolOptions.stabilizer} value={p.brushProps.stabilizerLevel}
            max={MAX_STABILIZER_LEVEL} step={STABILIZER_LEVEL_STEP} suffix="" className="w-16"
            onChange={(v) => p.onBrushProps({ stabilizerLevel: v })} />
        </>
      )}

      {(t === 'blur' || t === 'smudge') && (
        <>
          <Sep />
          {t === 'smudge' && (
            <>
              <Segmented label={tr.toolOptions.smudgeMode} value={p.smudgeMode} onChange={p.onSmudgeMode} options={[
                { id: 'smudge', label: tr.toolOptions.smudgeDrag },
                { id: 'blend', label: tr.toolOptions.smudgeBlend },
              ]} />
              <Sep />
            </>
          )}
          <SliderField label={tr.toolOptions.strength} value={Math.round(p.brushProps.flow * 100)} min={1} onChange={(v) => p.onBrushProps({ flow: v / 100 })} />
        </>
      )}

      {t === 'liquify' && (
        <>
          <Sep />
          <Segmented label={tr.toolOptions.liquifyMode} value={p.liquifyMode} onChange={p.onLiquifyMode}
            options={[
              { id: 'push', label: tr.toolOptions.liquifyPush },
              { id: 'expand', label: tr.toolOptions.liquifyExpand },
              { id: 'pinch', label: tr.toolOptions.liquifyPinch },
              { id: 'push_left', label: tr.toolOptions.liquifyPushLeft },
              { id: 'push_right', label: tr.toolOptions.liquifyPushRight },
              { id: 'twirl_left', label: tr.toolOptions.liquifyTwirlLeft },
              { id: 'twirl_right', label: tr.toolOptions.liquifyTwirlRight },
            ]} />
          <Sep />
          <SliderField label={tr.toolOptions.strength} value={Math.round(p.liquifyStrength * 100)} min={5} onChange={(v) => p.onLiquifyStrength(v / 100)} />
          <Sep />
          <SliderField label={tr.toolOptions.liquifyHardness} value={Math.round(p.liquifyHardness * 100)} min={0} onChange={(v) => p.onLiquifyHardness(v / 100)} />
          <Sep />
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-300">
            <input type="checkbox" checked={p.liquifyRefAreaOnly} onChange={(e) => p.onLiquifyRefAreaOnly(e.target.checked)} />
            {tr.toolOptions.liquifyRefArea}
          </label>
        </>
      )}

      {isSelectTool && (
        <>
          <Sep />
          <Segmented label={tr.toolOptions.selectionMode} value={p.selectionMode} onChange={p.onSelectionMode}
            options={[
              { id: 'replace', label: tr.toolOptions.selectionNew },
              { id: 'add', label: tr.toolOptions.selectionAdd, title: tr.toolOptions.selectionAddHint },
              { id: 'subtract', label: tr.toolOptions.selectionSubtract, title: tr.toolOptions.selectionSubtractHint },
            ]} />
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-300">
            <input type="checkbox" checked={p.selectionAntialias} onChange={(e) => p.onSelectionAntialias(e.target.checked)} />
            {tr.toolOptions.selectionAntialias}
          </label>
          <SliderField label={tr.toolOptions.selectionFeatherRadius} value={p.selectionFeather} max={64} suffix=" px" onChange={p.onSelectionFeather} />
          {t === 'select_polygon' && p.polygonPointCount > 0 && (
            <>
              <button type="button" onClick={p.onPolygonFinish} className="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500">
                {tr.toolOptions.polygonFinish} ({p.polygonPointCount}) Enter
              </button>
              <button type="button" onClick={p.onPolygonCancel} className="shrink-0 rounded-md px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800">
                {tr.toolOptions.polygonCancel} Esc
              </button>
            </>
          )}
        </>
      )}
      {t === 'eraser' && (
        <>
          <Sep />
          <Segmented label={tr.toolOptions.eraserMode} value={p.eraserMode} onChange={p.onEraserMode}
            options={[
              { id: 'hard', label: tr.toolOptions.eraserHard },
              { id: 'soft', label: tr.toolOptions.eraserSoft },
            ]} />
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-300" title={tr.toolOptions.lassoEraseTooltip}>
            <input type="checkbox" checked={p.lassoErase} onChange={(e) => p.onLassoErase(e.target.checked)} />
            {tr.toolOptions.lassoErase}
          </label>
        </>
      )}
      {isSelectTool && (
        <>
          <Sep />
          <button type="button" onClick={p.onColorRange} title={tr.toolOptions.colorRangeTooltip}
            className="shrink-0 rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800">{tr.toolOptions.colorRange}</button>
        </>
      )}
      {(t === 'magic_wand' || t === 'lasso') && (
        <>
          <Sep />
          <SliderField label={tr.toolOptions.tolerance} value={p.wandTolerance} max={255} suffix="" onChange={p.onWandTolerance} />
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-300">
            <input type="checkbox" checked={p.wandContiguous} onChange={(e) => p.onWandContiguous(e.target.checked)} />
            {tr.toolOptions.contiguous}
          </label>
        </>
      )}

      {(isClickFill || isPaintUnfilled) && (
        <>
          <Sep />
          <Segmented label={tr.toolOptions.referenceLayer} value={fillReference} onChange={p.onBucketReference}
            options={[
              { id: 'current', label: tr.toolOptions.currentLayer },
              { id: 'all', label: tr.toolOptions.allLayers },
              ...(isClickFill ? [{ id: 'none' as const, label: tr.toolOptions.selectionOnly }] : []),
            ]} />
          <Sep />
          <SliderField label={tr.toolOptions.tolerance} value={p.bucketTolerance} max={255} suffix="" onChange={p.onBucketTolerance} />
          {isClickFill && p.onConfirmSoloFullFill && (
            <label className="flex max-w-full items-center gap-1.5 text-[11px] text-neutral-300">
              <input type="checkbox" checked={p.confirmSoloFullFill}
                onChange={(e) => p.onConfirmSoloFullFill?.(e.target.checked)} />
              {tr.toolOptions.confirmSoloFullFill}
            </label>
          )}
        </>
      )}

      {isLassoFill && (
        <>
          <Sep />
          {p.onLassoFillErase && (
            <Segmented label={tr.toolOptions.lassoFillAction} value={p.lassoFillErase ? 'erase' : 'paint'}
              onChange={(action) => p.onLassoFillErase?.(action === 'erase')}
              options={[
                { id: 'paint', label: tr.toolOptions.lassoFillPaint },
                { id: 'erase', label: tr.toolOptions.lassoFillTransparent },
              ]} />
          )}
          <div className="flex max-w-full flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-neutral-400">{tr.studio.antiAlias}</span>
            <AntiAliasSelector compact value={p.brushProps.antiAlias} onChange={(antiAlias) => p.onBrushProps({ antiAlias })} />
          </div>
        </>
      )}

      {(t === 'smart_fill' || isPaintUnfilled) && (
        <>
          <Sep />
          {p.gapClosingRadius !== undefined && p.onGapClosingRadius && (
            <SliderField label={tr.toolOptions.gapClosing} value={p.gapClosingRadius} max={10}
              suffix="px" onChange={p.onGapClosingRadius} />
          )}
          {p.expandRadius !== undefined && p.onExpandRadius && (
            <SliderField label={isPaintUnfilled ? tr.toolOptions.areaScaling : tr.toolOptions.underlineExpansion}
              value={p.expandRadius} min={isPaintUnfilled ? -6 : 0} max={6} suffix="px" onChange={p.onExpandRadius} />
          )}
        </>
      )}

      {(t === 'brush' || t === 'pencil' || (isLassoFill && !p.lassoFillErase)) && (
        <>
          <Sep />
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-300"
            title={tr.toolOptions.outline}>
            <input type="checkbox" checked={p.outline.enabled} onChange={(e) => p.onOutline({ enabled: e.target.checked })} />
            {tr.toolOptions.outline}
          </label>
          {p.outline.enabled && (
            <>
              <NumberBox label={tr.toolOptions.outlineWidth} value={p.outline.width} min={1} max={40} onCommit={(n) => p.onOutline({ width: n })} width="w-10" suffix="px" />
              <ColorPopoverButton color={p.outline.color} onChange={(color) => p.onOutline({ color })} onPick={p.onPickOutlineColor} label={tr.toolOptions.outlineColor} />
            </>
          )}
        </>
      )}

      {t === 'gradient' && (
        <>
          <Sep />
          <Segmented label={tr.toolOptions.gradientType} value={p.gradientType} onChange={p.onGradientType}
            options={[{ id: 'linear', label: tr.toolOptions.gradientLinear }, { id: 'radial', label: tr.toolOptions.gradientRadial }]} />
        </>
      )}

      {t === 'shape' && (
        <>
          <Sep />
          <Segmented label={tr.toolOptions.shapeSubtype} value={p.shapeSubtype} onChange={p.onShapeSubtype}
            options={[
              { id: 'rect', label: tr.toolOptions.shapeRect },
              { id: 'triangle', label: tr.toolOptions.shapeTriangle },
              { id: 'diamond', label: tr.toolOptions.shapeDiamond },
              { id: 'pentagon', label: tr.toolOptions.shapePentagon },
              { id: 'star', label: tr.toolOptions.shapeStar },
              { id: 'ellipse', label: tr.toolOptions.shapeEllipse },
              { id: 'line', label: tr.toolOptions.shapeLine },
              { id: 'arrow', label: tr.toolOptions.shapeArrow },
            ]} />
          <Segmented label={tr.toolOptions.shapeFillMode} value={p.shapeFillMode} onChange={p.onShapeFillMode}
            options={[
              { id: 'stroke', label: tr.toolOptions.shapeStroke },
              { id: 'fill', label: tr.toolOptions.shapeFill },
              { id: 'stroke_and_fill', label: tr.toolOptions.shapeStrokeAndFill },
            ]} />
          <Sep />
          <StepNumberField label={tr.toolOptions.shapeLineWidth} value={p.shapeLineWidth} min={1} max={200} onCommit={p.onShapeLineWidth} suffix="px" />
          {CORNER_RADIUS_SHAPES.includes(p.shapeSubtype) && (
            <>
              <Sep />
              <StepNumberField label={tr.toolOptions.shapeCornerRadius} value={p.shapeCornerRadius} min={0} max={200} onCommit={p.onShapeCornerRadius} suffix="px" />
            </>
          )}
        </>
      )}

      {t === 'vector_eraser' && (
        <>
          <Sep />
          <Segmented label={tr.toolOptions.vectorEraserMode} value={p.vectorEraserMode} onChange={p.onVectorEraserMode}
            options={[
              { id: 'intersect', label: tr.toolOptions.vectorIntersect },
              { id: 'partial', label: tr.toolOptions.vectorPartial },
              { id: 'entire', label: tr.toolOptions.vectorEntire },
            ]} />
        </>
      )}
      {t === 'vector_width' && (
        <>
          <Sep />
          <Segmented label={tr.toolOptions.vectorWidthMode} value={p.vectorWidthMode} onChange={p.onVectorWidthMode}
            options={[{ id: 'thicken', label: tr.toolOptions.vectorThicken }, { id: 'thin', label: tr.toolOptions.vectorThin }]} />
        </>
      )}
      {t === 'vector_bezier' && (
        <>
          <Sep />
          <Segmented label={tr.toolOptions.bezierMode} value={p.bezierMode} onChange={p.onBezierMode}
            options={[
              { id: 'pen', label: tr.toolOptions.bezierPen, title: tr.toolOptions.bezierPenHint },
              { id: 'curve', label: tr.toolOptions.bezierCurve, title: tr.toolOptions.bezierCurveHint },
            ]} />
          {p.bezierPointCount > 0 && (
            <>
              <button type="button" onClick={p.onBezierFinish} className="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500">
                {tr.toolOptions.bezierFinish} ({p.bezierPointCount}) Enter
              </button>
              <button type="button" onClick={p.onBezierCancel} className="shrink-0 rounded-md px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800">{tr.toolOptions.bezierCancel} Esc</button>
            </>
          )}
        </>
      )}
      {t === 'vector_edit' && p.vectorAnchorSelected && (
        <>
          <Sep />
          <button type="button" onClick={p.onVectorToggleCorner} className="shrink-0 rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800">{tr.toolOptions.vectorToggleCorner}</button>
          <button type="button" onClick={p.onVectorDeleteAnchor} className="shrink-0 rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950/40">{tr.toolOptions.vectorDeleteAnchor}</button>
        </>
      )}

      {t === 'transform' && !p.isTransformActive && (
        <>
          <Sep />
          <button type="button" onClick={p.onStartTransform} className="flex shrink-0 items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500">
            <Move className="h-3.5 w-3.5" /> {tr.toolOptions.startTransform}
          </button>
          <button type="button" data-testid="tool-options-puppet-warp" onClick={p.onStartPuppetWarp}
            className="atelier-btn atelier-btn--ghost shrink-0">
            {tr.puppetWarp.title}
          </button>
        </>
      )}

      {p.hasSelection && !p.isTransformActive && (
        <div className="ml-auto flex shrink-0 items-center gap-1 rounded-lg border border-indigo-500/40 bg-indigo-950/40 py-0.5 pl-2 pr-0.5" role="group" aria-label={tr.toolOptions.selectionActions}>
          <SquareDashed className="h-3.5 w-3.5 text-indigo-300" />
          <span className="mr-1 text-[11px] font-semibold text-indigo-200">{tr.toolOptions.selectionActions}</span>
          <button type="button" onClick={p.onSelectionTransform} title={tr.toolOptions.selectionTransform} className={selBtn}><Move className="h-3.5 w-3.5" />{tr.toolOptions.selectionTransform}</button>
          <button type="button" onClick={p.onSelectionCopy} title={`${tr.toolOptions.selectionCopy} (${shortcut('action_selection_copy')})`} className={selBtn}><Copy className="h-3.5 w-3.5" />{tr.toolOptions.selectionCopy}</button>
          <button type="button" onClick={p.onSelectionCut} title={`${tr.toolOptions.selectionCut} (${shortcut('action_selection_cut')})`} className={selBtn}><Scissors className="h-3.5 w-3.5" />{tr.toolOptions.selectionCut}</button>
          {p.canPaste && <button type="button" onClick={p.onPaste} title={`${tr.toolOptions.selectionPaste} (${shortcut('action_selection_paste')})`} className={selBtn}><ClipboardPaste className="h-3.5 w-3.5" />{tr.toolOptions.selectionPaste}</button>}
          <button type="button" onClick={p.onSelectionDelete} title={`${tr.toolOptions.selectionDelete} (${shortcut('action_selection_delete')})`} className={`${selBtn} hover:!bg-rose-600/40`}><Eraser className="h-3.5 w-3.5" />{tr.toolOptions.selectionDelete}</button>
          <button type="button" onClick={p.onSelectionInvert} title={`${tr.toolOptions.selectionInvert} (${shortcut('action_selection_invert')})`} className={selBtn}><FlipHorizontal2 className="h-3.5 w-3.5" />{tr.toolOptions.selectionInvert}</button>
          <button type="button" onClick={p.onSelectionMask} title={tr.toolOptions.selectionMask} className={selBtn}><Crop className="h-3.5 w-3.5" />{tr.toolOptions.selectionMask}</button>
          <button type="button" onClick={() => p.onSelectionGrow(3)} title={`${tr.toolOptions.selectionGrow} 3 px`} aria-label={`${tr.toolOptions.selectionGrow} 3 px`} className="atelier-icon-btn h-7 w-7"><Plus className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => p.onSelectionGrow(-3)} title={`${tr.toolOptions.selectionShrink} 3 px`} aria-label={`${tr.toolOptions.selectionShrink} 3 px`} className="atelier-icon-btn h-7 w-7"><Minus className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => p.onFeatherActiveSelection(4)} title={tr.toolOptions.selectionFeatherTooltip} className={selBtn}>{tr.toolOptions.selectionFeather}</button>
          <button type="button" onClick={p.onClearSelection} title={`${tr.toolOptions.selectionClear} (${shortcut('action_clear_selection')})`} className={selBtn}><X className="h-3.5 w-3.5" />{tr.toolOptions.selectionClear}</button>
        </div>
      )}
      {!p.isTransformActive && (isSelectTool || p.canPaste) && (
        <label className={`${p.hasSelection ? '' : 'ml-auto'} flex shrink-0 items-center gap-1 text-[11px] text-neutral-300`} title={tr.toolOptions.pasteToNewLayerTooltip}>
          <input type="checkbox" checked={p.pasteToNewLayer} onChange={(e) => p.onPasteToNewLayer(e.target.checked)} />
          {tr.toolOptions.pasteToNewLayer}
        </label>
      )}
      {!p.hasSelection && !p.isTransformActive && (isSelectTool || p.canPaste) && (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-500">
          {p.canPaste && <button type="button" onClick={p.onPaste} title={`${tr.toolOptions.selectionPaste} (${shortcut('action_selection_paste')})`} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-neutral-200 hover:bg-neutral-800"><ClipboardPaste className="h-3.5 w-3.5" />{tr.toolOptions.selectionPaste}</button>}
          {isSelectTool && (
            <>
              <button type="button" onClick={p.onSelectionInvert} title={`${tr.toolOptions.selectionSelectAll} (${shortcut('action_selection_invert')})`} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-neutral-200 hover:bg-neutral-800"><SquareDashed className="h-3.5 w-3.5" />{tr.toolOptions.selectionSelectAll}</button>
            </>
          )}
        </span>
      )}
      {/* 指令列: the viewer's own buttons (pencil to choose) */}
      <div className={`ml-auto flex items-center border-l border-neutral-800 pl-1 ${isNarrowMobile ? 'shrink-0' : 'max-w-full flex-wrap'}`}><CommandBar wrap={!isNarrowMobile} /></div>
    </div>
  );
};
