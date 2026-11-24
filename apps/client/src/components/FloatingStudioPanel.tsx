import React, { useRef } from 'react';
import { BrushProperties } from '../engine/BrushRenderer';
import { isBrushTool } from '../engine/brushToolSettings';
import { LiquifyMode } from '../engine/LiquifyEngine';
import { SmudgeMode } from '../engine/BlurSmudgeEngine';
import { ColorWheelStudio } from './ColorWheelStudio';
import { LayerModel, MAX_STABILIZER_LEVEL, STABILIZER_LEVEL_STEP, ToolType, VectorEraserMode, VectorWidthMode } from '@atelier/shared';
import { AntiAliasSelector } from './AntiAliasSelector';
import { useI18n } from '../context/I18nContext';
import {
  Activity,
  Blend,
  CheckCircle2,
  Circle,
  Compass,
  Droplets,
  Expand,
  Image as ImageIcon,
  Layers,
  Minus,
  PaintBucket,
  Palette,
  Scissors,
  Shrink,
  Sparkles,
  Spline,
  Trash2,
  Wand2,
  WandSparkles,
  Waves,
  Zap,
} from 'lucide-react';
import { useWheelStep } from '../hooks/useWheelStep';
import { CORNER_RADIUS_SHAPES, ShapeSubtype } from './workspace/tools/useShapeTools';

const WheelRangeInput: React.FC<
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value'> & {
    value: number;
    wheelStep?: number;
    onValueChange: (next: number) => void;
  }
> = ({ value, min = 0, max = 100, step = 1, wheelStep, onValueChange, ...rest }) => {
  const ref = useRef<HTMLInputElement>(null);
  const minNum = Number(min);
  const maxNum = Number(max);
  const baseStep = wheelStep ?? Number(step);
  useWheelStep(ref, (steps, e) => {
    const mult = e.shiftKey ? 5 : 1;
    const raw = value + steps * baseStep * mult;
    const clamped = Math.max(minNum, Math.min(maxNum, raw));
    const rounded = baseStep < 1 ? Math.round(clamped * 100) / 100 : Math.round(clamped);
    if (rounded !== value) onValueChange(rounded);
  });
  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.target.value))}
      {...rest}
    />
  );
};

interface FloatingStudioPanelProps {
  currentTool: ToolType;
  /** Phone layout: the options bar hides hardness / stabilizer there, so this panel shows them */
  compact?: boolean;
  brushProps: BrushProperties;
  onChangeBrushProps: (props: Partial<BrushProperties>) => void;
  wandTolerance: number;
  onChangeWandTolerance: (tol: number) => void;
  wandContiguous?: boolean;
  onToggleWandContiguous?: () => void;
  onExpandSelection?: () => void;
  onContractSelection?: () => void;
  onClearSelection?: () => void;
  hasSelection?: boolean;
  onUploadCustomBrush: (file: File) => void;
  onClearCustomBrush: () => void;
  onOpenPresetModal?: () => void;
  onOpenColorWheel?: () => void;
  gradientMode?: 'fg_to_bg' | 'fg_to_trans';
  onChangeGradientMode?: (mode: 'fg_to_bg' | 'fg_to_trans') => void;
  gradientType?: 'linear' | 'radial';
  onChangeGradientType?: (type: 'linear' | 'radial') => void;
  // Phase 7: AI Smart Fill
  layers?: LayerModel[];
  referenceLayerId?: string | null;
  onChangeReferenceLayerId?: (id: string | null) => void;
  gapClosingRadius?: number;
  onChangeGapClosingRadius?: (r: number) => void;
  // Paint Bucket Tool
  bucketReference?: 'current' | 'all' | 'specific' | 'none';
  onChangeBucketReference?: (ref: 'current' | 'all' | 'specific' | 'none') => void;
  bucketTolerance?: number;
  onChangeBucketTolerance?: (tol: number) => void;
  bucketExpand?: number;
  onChangeBucketExpand?: (exp: number) => void;
  bucketRefLayerId?: string | null;
  onChangeBucketRefLayerId?: (id: string | null) => void;
  expandRadius?: number;
  onChangeExpandRadius?: (r: number) => void;
  // Liquify brush options
  liquifyMode?: LiquifyMode;
  onChangeLiquifyMode?: (mode: LiquifyMode) => void;
  liquifyRadius?: number;
  onChangeLiquifyRadius?: (r: number) => void;
  liquifyStrength?: number;
  onChangeLiquifyStrength?: (s: number) => void;
  liquifyHardness?: number;
  onChangeLiquifyHardness?: (h: number) => void;
  liquifyRefAreaOnly?: boolean;
  onChangeLiquifyRefAreaOnly?: (v: boolean) => void;
  smudgeMode?: SmudgeMode;
  onChangeSmudgeMode?: (mode: SmudgeMode) => void;
  // Shape Tool Integrated Options
  shapeSubtype?: ShapeSubtype;
  onChangeShapeSubtype?: (st: ShapeSubtype) => void;
  shapeFillMode?: 'stroke' | 'fill' | 'stroke_and_fill';
  onChangeShapeFillMode?: (mode: 'stroke' | 'fill' | 'stroke_and_fill') => void;
  shapeLineWidth?: number;
  onChangeShapeLineWidth?: (w: number) => void;
  shapeCornerRadius?: number;
  onChangeShapeCornerRadius?: (r: number) => void;
  // Phase 10: Vector & Color Tools
  vectorEraserMode?: VectorEraserMode;
  onChangeVectorEraserMode?: (m: VectorEraserMode) => void;
  vectorWidthMode?: VectorWidthMode;
  onChangeVectorWidthMode?: (m: VectorWidthMode) => void;
  onActivateCanvasEyedropper?: () => void;
}

const PALETTE_SWATCHES = [
  '#000000',
  '#FFFFFF',
  '#EF4444',
  '#F97316',
  '#FBBF24',
  '#10B981',
  '#06B6D4',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
  '#78350F',
  '#475569',
];

export const FloatingStudioPanel: React.FC<FloatingStudioPanelProps> = ({
  currentTool,
  compact = false,
  brushProps,
  onChangeBrushProps,
  wandTolerance,
  onChangeWandTolerance,
  wandContiguous = true,
  onToggleWandContiguous,
  onExpandSelection,
  onContractSelection,
  onClearSelection,
  hasSelection = false,
  onUploadCustomBrush,
  onClearCustomBrush,
  onOpenPresetModal,
  onOpenColorWheel,
  gradientMode = 'fg_to_bg',
  onChangeGradientMode,
  gradientType = 'linear',
  onChangeGradientType,
  layers = [],
  referenceLayerId = null,
  onChangeReferenceLayerId,
  gapClosingRadius = 4,
  onChangeGapClosingRadius,
  bucketReference = 'all',
  onChangeBucketReference,
  bucketTolerance = 32,
  onChangeBucketTolerance,
  bucketExpand = 1,
  onChangeBucketExpand,
  bucketRefLayerId = null,
  onChangeBucketRefLayerId,
  expandRadius = 2,
  onChangeExpandRadius,
  liquifyMode = 'push',
  onChangeLiquifyMode,
  liquifyRadius = 60,
  onChangeLiquifyRadius,
  liquifyStrength = 0.5,
  onChangeLiquifyStrength,
  liquifyHardness = 0.5,
  onChangeLiquifyHardness,
  liquifyRefAreaOnly = false,
  onChangeLiquifyRefAreaOnly,
  smudgeMode = 'smudge',
  onChangeSmudgeMode,
  shapeSubtype = 'rect',
  onChangeShapeSubtype,
  shapeFillMode = 'stroke',
  onChangeShapeFillMode,
  shapeLineWidth = 3,
  onChangeShapeLineWidth,
  shapeCornerRadius = 0,
  onChangeShapeCornerRadius,
  vectorEraserMode = 'intersect',
  onChangeVectorEraserMode,
  vectorWidthMode = 'thicken',
  onChangeVectorWidthMode,
  onActivateCanvasEyedropper,
}) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isSnapEnabled = brushProps.snapToRuler !== false;

  const handleToggleSnap = () => {
    onChangeBrushProps({ snapToRuler: !isSnapEnabled });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadCustomBrush(file);
      e.target.value = '';
    }
  };

  const isPencil = currentTool === 'pencil';
  const isEraser = currentTool === 'eraser';
  const isWand = currentTool === 'magic_wand';

  return (
    <div className="flex flex-col gap-2.5 text-xs text-neutral-300">
      {/* Preset Library & Format Extension (.abr / .sut) button */}
      {onOpenPresetModal && (
        <button
          type="button"
          onClick={onOpenPresetModal}
          className="w-full flex items-center justify-between p-2 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 hover:text-white transition group"
        >
          <div className="flex items-center gap-1.5 font-semibold text-[11px]">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400 group-hover:rotate-12 transition-transform" />
            <span>{t.brushPreset.title}</span>
          </div>
          <span className="text-[10px] text-neutral-400">.abr / .sut / .brush</span>
        </button>
      )}

      <>
          {/* Vector Tools Dedicated Controls Card */}
          {currentTool === 'vector_reshape' && (
            <div className="flex flex-col gap-2 p-2.5 bg-neutral-900/60 rounded-lg border border-neutral-800">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-indigo-400 flex items-center gap-1.5">
                  <Spline className="w-3.5 h-3.5 text-indigo-400" />
                  {t.tools.vectorReshape}
                </span>
              </div>
            </div>
          )}

          {/* Tool-specific options (colour lives in the 色彩 panel) */}
          {currentTool === 'gradient' && (
            <div className="flex flex-col gap-2 p-2.5 bg-neutral-900/60 rounded-xl border border-neutral-800">
              {/* Gradient Tool Specific Options */}
              {currentTool === 'gradient' && (
                <div className="pt-2 border-t border-neutral-800 space-y-2">
                  <span className="text-[10px] text-indigo-400 font-bold block">{t.tools.gradient} {t.tools.selectionOptions}</span>
                  <div className="flex gap-1.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => onChangeGradientMode?.('fg_to_bg')}
                      className={`flex-1 py-1 rounded text-center font-medium transition ${
                        gradientMode === 'fg_to_bg'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-neutral-800 text-neutral-400'
                      }`}
                    >
                      {t.toolOptions.gradFgBg}
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeGradientMode?.('fg_to_trans')}
                      className={`flex-1 py-1 rounded text-center font-medium transition ${
                        gradientMode === 'fg_to_trans'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-neutral-800 text-neutral-400'
                      }`}
                    >
                      {t.toolOptions.gradFgTransparent}
                    </button>
                  </div>
                </div>
              )}



            </div>
          )}

          {currentTool === 'shape' && (
            <div className="flex flex-col gap-2 p-2.5 bg-neutral-900/60 rounded-xl border border-neutral-800">
              <span className="text-[10px] text-indigo-400 font-bold block">{t.tools.shape} {t.tools.selectionOptions}</span>
              <div className="grid grid-cols-4 gap-1 text-[10px]">
                {([
                  { id: 'rect', label: t.toolOptions.shapeRect },
                  { id: 'triangle', label: t.toolOptions.shapeTriangle },
                  { id: 'diamond', label: t.toolOptions.shapeDiamond },
                  { id: 'pentagon', label: t.toolOptions.shapePentagon },
                  { id: 'star', label: t.toolOptions.shapeStar },
                  { id: 'ellipse', label: t.toolOptions.shapeEllipse },
                  { id: 'line', label: t.toolOptions.shapeLine },
                  { id: 'arrow', label: t.toolOptions.shapeArrow },
                ] as const).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onChangeShapeSubtype?.(opt.id)}
                    className={`py-1 rounded font-medium border transition ${
                      shapeSubtype === opt.id
                        ? 'bg-indigo-600 border-indigo-400 text-white'
                        : 'bg-neutral-800 border-neutral-700/80 text-neutral-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 text-[10px]">
                {([
                  { id: 'stroke', label: t.toolOptions.shapeStroke },
                  { id: 'fill', label: t.toolOptions.shapeFill },
                  { id: 'stroke_and_fill', label: t.toolOptions.shapeStrokeAndFill },
                ] as const).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onChangeShapeFillMode?.(m.id)}
                    className={`flex-1 py-1 rounded font-medium transition ${
                      shapeFillMode === m.id
                        ? 'bg-indigo-600 text-white'
                        : 'bg-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="space-y-1 pt-1 border-t border-neutral-800">
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-neutral-400 font-medium">{t.toolOptions.shapeLineWidth}</span>
                  <span className="font-mono text-indigo-400 font-semibold">{shapeLineWidth} px</span>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => onChangeShapeLineWidth?.(Math.max(1, shapeLineWidth - 10))} className="px-1 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-mono text-neutral-300">&lt;&lt;</button>
                  <button type="button" onClick={() => onChangeShapeLineWidth?.(Math.max(1, shapeLineWidth - 1))} className="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-mono text-neutral-300">&lt;</button>
                  <WheelRangeInput
                    min={1}
                    max={200}
                    step={1}
                    wheelStep={2}
                    aria-label="面板形狀線寬"
                    value={shapeLineWidth}
                    onValueChange={(v) => onChangeShapeLineWidth?.(v)}
                    className="flex-1 h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                  <button type="button" onClick={() => onChangeShapeLineWidth?.(Math.min(200, shapeLineWidth + 1))} className="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-mono text-neutral-300">&gt;</button>
                  <button type="button" onClick={() => onChangeShapeLineWidth?.(Math.min(200, shapeLineWidth + 10))} className="px-1 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-mono text-neutral-300">&gt;&gt;</button>
                </div>
              </div>
              {CORNER_RADIUS_SHAPES.includes(shapeSubtype) && (
                <div className="space-y-1 pt-1 border-t border-neutral-800">
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="text-neutral-400 font-medium">{t.toolOptions.shapeCornerRadius}</span>
                    <span className="font-mono text-indigo-400 font-semibold">{shapeCornerRadius} px</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => onChangeShapeCornerRadius?.(Math.max(0, shapeCornerRadius - 10))} className="px-1 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-mono text-neutral-300">&lt;&lt;</button>
                    <button type="button" onClick={() => onChangeShapeCornerRadius?.(Math.max(0, shapeCornerRadius - 1))} className="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-mono text-neutral-300">&lt;</button>
                    <WheelRangeInput
                      min={0}
                      max={200}
                      step={1}
                      wheelStep={2}
                      aria-label="面板導角圓滑度"
                      value={shapeCornerRadius}
                      onValueChange={(v) => onChangeShapeCornerRadius?.(v)}
                      className="flex-1 h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                    <button type="button" onClick={() => onChangeShapeCornerRadius?.(Math.min(200, shapeCornerRadius + 1))} className="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-mono text-neutral-300">&gt;</button>
                    <button type="button" onClick={() => onChangeShapeCornerRadius?.(Math.min(200, shapeCornerRadius + 10))} className="px-1 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-mono text-neutral-300">&gt;&gt;</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 2. Tool-Specific Parameters */}
          <div className="space-y-2.5">

            {!isWand && currentTool !== 'lasso' && currentTool !== 'smart_fill' && currentTool !== 'canvas_resize' && (
              <div className="p-2 bg-neutral-900/60 rounded-lg border border-neutral-800 space-y-1">
                <span className="text-neutral-400 font-medium">{t.studio.antiAlias}</span>
                <AntiAliasSelector value={brushProps.antiAlias} onChange={(antiAlias) => onChangeBrushProps({ antiAlias })} />
              </div>
            )}
            {/* Mixing / wetness / stretch live in BrushEnginePanel (with the other engine options and a preview) */}

            {/* Brush Hardness & Edge Softness / Blur (畫筆邊緣模糊程度與硬度) */}
            {compact && isBrushTool(currentTool) && (
              <div className="p-2 bg-neutral-900/60 rounded-lg border border-neutral-800 space-y-1.5">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-neutral-300 font-medium flex items-center gap-1">
                    <Circle className="w-3 h-3 text-indigo-400" />
                    {t.studio.hardness}
                  </span>
                  <span className="font-mono text-indigo-400 font-semibold">
                    {Math.round(brushProps.hardness * 100)}%
                    <span className="text-[10px] text-neutral-400 ml-1 font-sans">
                      {brushProps.hardness <= 0.25
                        ? t.studio.hardnessSoft
                        : brushProps.hardness <= 0.7
                        ? t.studio.hardnessMid
                        : t.studio.hardnessHard}
                    </span>
                  </span>
                </div>
                <WheelRangeInput
                  min="0.0"
                  max="1.0"
                  step="0.05"
                  value={brushProps.hardness}
                  onValueChange={(v) => onChangeBrushProps({ hardness: v })}
                  className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
                <div className="grid grid-cols-4 gap-1 pt-0.5">
                  {[
                    { label: `${t.studio.hardnessSoft} 15%`, val: 0.15 },
                    { label: `${t.studio.hardnessMid} 50%`, val: 0.5 },
                    { label: `${t.studio.hardnessHard} 85%`, val: 0.85 },
                    { label: '100%', val: 1.0 },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => onChangeBrushProps({ hardness: preset.val })}
                      className={`py-0.5 text-[9px] rounded border transition ${
                        Math.abs(brushProps.hardness - preset.val) < 0.08
                          ? 'bg-indigo-600 border-indigo-400 text-white font-medium'
                          : 'bg-neutral-800/80 border-neutral-700/80 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Stabilizer Level (動態重心手抖修正) */}
            {compact && !isWand && currentTool !== 'lasso' && currentTool !== 'smart_fill' && currentTool !== 'canvas_resize' && (
              <div className="p-2 bg-neutral-900/60 rounded-lg border border-neutral-800 space-y-1.5">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-neutral-300 font-medium flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-amber-400" />
                    {t.studio.stabilizer}
                  </span>
                  <span className="font-mono text-amber-400 font-semibold">
                    Lv. {brushProps.stabilizerLevel}
                  </span>
                </div>
                <WheelRangeInput
                  min="0"
                  max={MAX_STABILIZER_LEVEL}
                  step={STABILIZER_LEVEL_STEP}
                  aria-label={t.toolOptions.stabilizer}
                  value={brushProps.stabilizerLevel}
                  onValueChange={(v) => onChangeBrushProps({ stabilizerLevel: v })}
                  className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer "
                />
                <div className="grid grid-cols-4 gap-1 pt-0.5">
                  {[
                    { label: `${t.studio.stabilizerOff} (0)`, val: 0 },
                    { label: `${t.studio.stabilizerLow} (3)`, val: 3 },
                    { label: `${t.studio.stabilizerMid} (6)`, val: 6 },
                    { label: `${t.studio.stabilizerHigh} (${MAX_STABILIZER_LEVEL})`, val: MAX_STABILIZER_LEVEL },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => onChangeBrushProps({ stabilizerLevel: preset.val })}
                      className={`py-0.5 text-[9px] rounded border transition ${
                        brushProps.stabilizerLevel === preset.val
                          ? 'bg-amber-600 border-amber-400 text-white font-medium'
                          : 'bg-neutral-800/80 border-neutral-700/80 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Ruler Snapping & Auxiliary Guides (尺規與輔助線吸附控制) */}
            {!isWand && currentTool !== 'lasso' && currentTool !== 'smart_fill' && currentTool !== 'canvas_resize' && (
              <div className="p-2.5 bg-neutral-900/60 rounded-lg border border-neutral-800 space-y-2">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-neutral-200 font-semibold flex items-center gap-1.5">
                    <Compass className="w-3.5 h-3.5 text-indigo-400" />
                    <span>{t.rulers.title}</span>
                  </span>

                  {/* 吸附開關 Toggle Switch */}
                  <button
                    type="button"
                    onClick={handleToggleSnap}
                    aria-pressed={isSnapEnabled}
                    className="atelier-btn !h-6 !px-2 text-[11px]"
                  >
                    <span>{t.rulers.snap}</span>
                  </button>
                </div>

              </div>
            )}
            {/* Paint Bucket Tool Controls (油漆桶工具) */}
            {currentTool === 'bucket' && (
              <div className="p-2.5 bg-neutral-900/70 rounded-lg border border-amber-800/60 space-y-2.5 animate-in fade-in duration-150">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-semibold text-amber-400 text-[11px]">
                    <PaintBucket className="w-3.5 h-3.5 text-amber-400" />
                    <span>{t.tools.bucket}</span>
                  </div>
                  <span className="px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 text-[9px] border border-amber-800 font-mono">
                    Flood Fill
                  </span>
                </div>

                {/* Reference Mode Selector */}
                <div className="space-y-1">
                  <span className="text-[11px] text-neutral-300 font-medium">{t.toolOptions.bucketRefMode}</span>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
                    <button
                      type="button"
                      onClick={() => onChangeBucketReference?.('current')}
                      className={`py-1 text-[10px] rounded border transition font-medium ${
                        bucketReference === 'current'
                          ? 'bg-amber-600 border-amber-400 text-white shadow'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {t.toolOptions.refCurrent}
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeBucketReference?.('all')}
                      className={`py-1 text-[10px] rounded border transition font-medium ${
                        bucketReference === 'all'
                          ? 'bg-amber-600 border-amber-400 text-white shadow'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {t.toolOptions.refAll}
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeBucketReference?.('specific')}
                      className={`py-1 text-[10px] rounded border transition font-medium ${
                        bucketReference === 'specific'
                          ? 'bg-amber-600 border-amber-400 text-white shadow'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {t.toolOptions.refSpecific}
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeBucketReference?.('none')}
                      className={`py-1 text-[10px] rounded border transition font-medium ${
                        bucketReference === 'none'
                          ? 'bg-amber-600 border-amber-400 text-white shadow'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {t.toolOptions.refNone}
                    </button>
                  </div>
                </div>

                {/* Specific Layer Dropdown */}
                {bucketReference === 'specific' && (
                  <div className="space-y-1">
                    <select
                      value={bucketRefLayerId || ''}
                      onChange={(e) => onChangeBucketRefLayerId?.(e.target.value || null)}
                      className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-amber-500"
                    >
                      <option value="">{t.toolOptions.selectLayer}</option>
                      {layers.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Gap Closing / Expansion Slider */}
                <div className="space-y-1">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-neutral-300 font-medium">{t.toolOptions.bucketExpand}</span>
                    <span className="font-mono text-amber-400 font-semibold">+{bucketExpand} px</span>
                  </div>
                  <WheelRangeInput
                    min="0"
                    max="10"
                    value={bucketExpand}
                    onValueChange={(v) => onChangeBucketExpand?.(Math.round(v))}
                    className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer "
                  />
                </div>
              </div>
            )}

            {/* AI Smart Enclose & Fill Controls (智能線稿填色) */}
            {currentTool === 'smart_fill' && (
              <div className="p-2.5 bg-neutral-900/70 rounded-lg border border-neutral-800 space-y-2.5 animate-in fade-in duration-150">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-semibold text-indigo-400 text-[11px]">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400 " />
                    <span>{t.toolOptions.smartFillTitle}</span>
                  </div>
                </div>

                {/* 1. Reference Lineart Layer Selector */}
                <div className="space-y-1">
                  <span className="text-[11px] text-neutral-300 font-medium flex items-center gap-1">
                    <Layers className="w-3 h-3 text-indigo-400" />
                    {t.toolOptions.refLineart}
                  </span>
                  <select
                    value={referenceLayerId || 'auto'}
                    onChange={(e) =>
                      onChangeReferenceLayerId &&
                      onChangeReferenceLayerId(e.target.value === 'auto' ? null : e.target.value)
                    }
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
                  >
                    <option value="auto">{t.toolOptions.autoTopLineart}</option>
                    {layers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} {l.isLocked ? '🔒' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 2. Gap Closing Radius */}
                <div className="space-y-1">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-neutral-300 font-medium">
                      {t.toolOptions.gapClosing}
                    </span>
                    <span className="font-mono text-indigo-400 font-semibold">
                      {gapClosingRadius} px
                    </span>
                  </div>
                  <WheelRangeInput
                    min="0"
                    max="10"
                    step="1"
                    value={gapClosingRadius}
                    onValueChange={(v) =>
                      onChangeGapClosingRadius &&
                      onChangeGapClosingRadius(Math.round(v))
                    }
                    className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer "
                  />
                  <div className="flex justify-between text-[9px] text-neutral-500">
                    <span>{t.toolOptions.gapStrict}</span>
                    <span>{t.toolOptions.gapMid}</span>
                    <span>{t.toolOptions.gapLoose}</span>
                  </div>
                </div>

                {/* 3. Under-line Expansion */}
                <div className="space-y-1">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-neutral-300 font-medium">
                      {t.toolOptions.underlineExpansion}
                    </span>
                    <span className="font-mono text-indigo-400 font-semibold">
                      +{expandRadius} px
                    </span>
                  </div>
                  <WheelRangeInput
                    min="0"
                    max="5"
                    step="1"
                    value={expandRadius}
                    onValueChange={(v) =>
                      onChangeExpandRadius &&
                      onChangeExpandRadius(Math.round(v))
                    }
                    className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer "
                  />
                </div>
              </div>
            )}
            {/* Smudge Mode (揉色模式：拖曳揉色 / 原位融合) */}
            {currentTool === 'smudge' && (
              <div className="p-2 bg-neutral-900/60 rounded-lg border border-neutral-800 space-y-1.5">
                <span className="text-[11px] text-neutral-300 font-medium block">{t.toolOptions.smudgeMode}</span>
                <div className="grid grid-cols-2 gap-1">
                  {([
                    { id: 'smudge', label: t.toolOptions.smudgeDrag },
                    { id: 'blend', label: t.toolOptions.smudgeBlend },
                  ] as const).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onChangeSmudgeMode?.(m.id)}
                      className={`px-2 py-1.5 rounded text-[11px] font-medium transition cursor-pointer ${
                        smudgeMode === m.id
                          ? 'bg-indigo-600 text-white shadow'
                          : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Liquify Tool Controls (CSP 歪斜/液化屬性) */}
            {currentTool === 'liquify' && (
              <div className="p-2.5 bg-neutral-900/70 rounded-lg border border-indigo-700/50 space-y-2.5 animate-in fade-in duration-150">
                <div className="flex items-center justify-between text-[11px] font-semibold text-indigo-300">
                  <span>{t.tools.liquify}</span>
                  <span className="font-mono text-[10px] text-neutral-400">{Math.round(liquifyRadius)} px</span>
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] text-neutral-300 font-medium">{t.toolOptions.liquifyMode}</span>
                  <div className="grid grid-cols-4 gap-1">
                    {([
                      { id: 'push', label: t.toolOptions.liquifyPush },
                      { id: 'expand', label: t.toolOptions.liquifyExpand },
                      { id: 'pinch', label: t.toolOptions.liquifyPinch },
                      { id: 'push_left', label: t.toolOptions.liquifyPushLeft },
                      { id: 'push_right', label: t.toolOptions.liquifyPushRight },
                      { id: 'twirl_left', label: t.toolOptions.liquifyTwirlLeft },
                      { id: 'twirl_right', label: t.toolOptions.liquifyTwirlRight },
                    ] as const).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => onChangeLiquifyMode?.(m.id)}
                        className={`py-1 px-1 text-[10px] rounded border transition font-medium ${
                          liquifyMode === m.id || (liquifyMode === 'twirl' && m.id === 'twirl_left')
                            ? 'bg-indigo-600 border-indigo-400 text-white shadow'
                            : 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:text-white'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-neutral-300">{t.toolOptions.strength}</span>
                    <span className="font-mono text-indigo-300">{Math.round(liquifyStrength * 100)}</span>
                  </div>
                  <WheelRangeInput
                    min="5"
                    max="100"
                    step="1"
                    value={Math.round(liquifyStrength * 100)}
                    onValueChange={(v) => onChangeLiquifyStrength?.(v / 100)}
                    className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-neutral-300">{t.toolOptions.liquifyHardness}</span>
                    <span className="font-mono text-indigo-300">{Math.round(liquifyHardness * 100)}</span>
                  </div>
                  <WheelRangeInput
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(liquifyHardness * 100)}
                    onValueChange={(v) => onChangeLiquifyHardness?.(v / 100)}
                    className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer"
                  />
                </div>
                <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer pt-0.5">
                  <input
                    type="checkbox"
                    checked={liquifyRefAreaOnly}
                    onChange={(e) => onChangeLiquifyRefAreaOnly?.(e.target.checked)}
                  />
                  <span>{t.toolOptions.liquifyRefArea}</span>
                </label>
              </div>
            )}

          </div>

          {/* 3. Custom Brush Texture Upload */}
          {!isWand && currentTool !== 'lasso' && currentTool !== 'liquify' && currentTool !== 'canvas_resize' && (
            <div className="pt-2 border-t border-neutral-800">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/webp,image/svg+xml"
                onChange={handleFileChange}
                className="hidden"
              />

              {brushProps.customBrushUrl ? (
                <div className="flex items-center justify-between bg-neutral-900/80 p-1.5 rounded-lg border border-neutral-700/60">
                  <div className="flex items-center gap-2 truncate">
                    <img
                      src={brushProps.customBrushUrl}
                      alt="brush tip"
                      className="w-5 h-5 rounded object-cover border border-neutral-700 bg-black/40"
                    />
                    <span className="text-[10px] text-neutral-300 truncate font-mono">
                      {t.studio.customBrushTip}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={onClearCustomBrush}
                    title={t.common.delete}
                    className="p-1 hover:text-rose-400 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 px-2 bg-neutral-800/80 hover:bg-neutral-700/80 border border-neutral-700/60 rounded-lg text-[11px] text-neutral-300 transition"
                >
                  <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                  <span>{t.studio.loadCustomBrush}</span>
                </button>
              )}
            </div>
          )}
      </>
    </div>
  );
};
