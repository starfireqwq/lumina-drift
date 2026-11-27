import { lazy, Suspense, useEffect, useRef } from 'react';
import type { AtelierBrushPreset } from '@atelier/shared';
import type { BrushProperties } from '../../engine/BrushRenderer';
import { useI18n } from '../../context/I18nContext';
import { resolveTheme } from '../../theme/themes';
import { findCategory, findSubTool, getLocalizedCategoryLabel, getLocalizedSubTool } from './toolCatalog';
import type { SubToolId, SubToolParams, ToolCategoryId } from './toolCatalog';
import { useShortcutLabel } from './ToolRail';

const BrushToolset = lazy(() => import('../BrushToolset').then((m) => ({ default: m.BrushToolset })));

const ERASER_PREVIEW_SIZE = { width: 144, height: 36 };

function EraserStrokePreview({
  params,
  isLight,
}: {
  params?: SubToolParams;
  isLight: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = params?.eraserMode === 'soft' ? 'soft' : 'hard';
  const sizePressure = params?.eraserSizePressure !== false;
  const opacityPressure = Boolean(params?.eraserOpacityPressure);
  const minSizeRatio = typeof params?.eraserMinSizeRatio === 'number'
    ? Math.max(0.05, Math.min(1, params.eraserMinSizeRatio))
    : 0.25;
  const baseOpacity = typeof params?.eraserOpacity === 'number'
    ? Math.max(0.1, Math.min(1, params.eraserOpacity))
    : 1;
  const inkColor = isLight ? '#18181b' : '#ffffff';
  const inkClear = isLight ? 'rgba(24,24,27,0)' : 'rgba(255,255,255,0)';

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { width, height } = ERASER_PREVIEW_SIZE;
    ctx.clearRect(0, 0, width, height);

    const maxRadius = mode === 'soft' ? 9.5 : 6.8;
    const hardness = mode === 'soft' ? 0.08 : 0.94;
    const step = mode === 'soft' ? 1.8 : 1.25;
    for (let x = 11; x <= width - 11; x += step) {
      const t = (x - 11) / (width - 22);
      const curve = Math.sin(Math.PI * t) ** 0.95;
      const sizeFactor = sizePressure ? (minSizeRatio + (1 - minSizeRatio) * curve) : 0.78;
      const r = Math.max(0.9, maxRadius * sizeFactor);
      const y = height / 2 - 7 * Math.sin(2 * Math.PI * t);
      const alphaFactor = opacityPressure ? (0.06 + 0.94 * (curve ** 1.15)) : 1;
      const stampAlpha = mode === 'soft' ? 0.26 * baseOpacity * alphaFactor : 0.92 * baseOpacity * alphaFactor;
      ctx.globalAlpha = Math.max(0.02, Math.min(1, stampAlpha));
      const gradient = ctx.createRadialGradient(x, y, r * hardness, x, y, r);
      gradient.addColorStop(0, inkColor);
      gradient.addColorStop(1, inkClear);
      ctx.fillStyle = gradient;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = inkColor;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  }, [mode, sizePressure, opacityPressure, minSizeRatio, baseOpacity, inkColor, inkClear]);

  return <canvas ref={canvasRef} {...ERASER_PREVIEW_SIZE} aria-hidden="true" className="h-7 w-[92px] max-w-[44%] shrink-0" />;
}

interface SubToolPanelProps {
  activeCategoryId: ToolCategoryId;
  activeSubToolId: SubToolId;
  onSelectSubTool: (subToolId: SubToolId) => void;
  onResetSubTool?: (subToolId: SubToolId) => void;
  currentBrushProps: BrushProperties;
  selectedBrushId: string | null;
  onApplyPreset: (preset: AtelierBrushPreset) => void;
}

export function SubToolPanel({
  activeCategoryId, activeSubToolId, onSelectSubTool, onResetSubTool,
  currentBrushProps, selectedBrushId, onApplyPreset,
}: SubToolPanelProps) {
  const { t, themeId, customTheme } = useI18n();
  const isLight = resolveTheme(themeId, customTheme).base === 'light';
  const shortcutLabel = useShortcutLabel();
  const category = findCategory(activeCategoryId);
  const activeSubTool = findSubTool(activeSubToolId);
  const title = getLocalizedCategoryLabel(activeCategoryId, t);
  const showBrushPresets = activeCategoryId === 'paint';
  const showEraserPreviews = activeCategoryId === 'eraser';

  return (
    <div className={`flex min-h-0 flex-col ${showBrushPresets ? 'h-full' : ''}`}>
      {showBrushPresets ? (
        <div
          role="group"
          aria-label={`${t.tools.subToolTitle} · ${title}`}
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-700/60 p-1.5"
        >
          {category?.subTools.map((sub) => {
            const Icon = sub.icon;
            const { label, hint } = getLocalizedSubTool(sub.id, t);
            return (
              <button
                key={sub.id}
                type="button"
                data-subtool-id={sub.id}
                aria-pressed={activeSubToolId === sub.id}
                title={hint}
                onClick={() => onSelectSubTool(sub.id)}
                className="flex min-w-0 items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-left text-xs text-neutral-200 hover:bg-white/5 aria-pressed:border-indigo-400/50 aria-pressed:bg-indigo-500/20"
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate font-medium">{label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div role="group" aria-label={`${t.tools.subToolTitle} · ${title}`} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {category?.subTools.map((sub) => {
            const Icon = sub.icon;
            const { label, hint } = getLocalizedSubTool(sub.id, t);
            const key = shortcutLabel(sub.shortcutId);
            const active = activeSubToolId === sub.id;
            const liveEraserParams: SubToolParams | undefined = showEraserPreviews && active
              ? {
                ...sub.defaultParams,
                eraserMode: currentBrushProps.eraserMode === 'soft' ? 'soft' : 'hard',
                eraserSizePressure: currentBrushProps.dynamics?.size
                  ? Boolean(currentBrushProps.dynamics.size.pressure)
                  : currentBrushProps.minSize < currentBrushProps.size,
                eraserOpacityPressure: Boolean(currentBrushProps.dynamics?.opacity?.pressure),
                eraserMinSizeRatio: currentBrushProps.dynamics?.size?.min
                  ?? (currentBrushProps.size > 0 ? currentBrushProps.minSize / currentBrushProps.size : 0.25),
                eraserOpacity: currentBrushProps.opacity,
              }
              : sub.defaultParams;
            return (
              <button
                key={sub.id}
                type="button"
                data-subtool-id={sub.id}
                aria-pressed={active}
                title={hint}
                onClick={() => onSelectSubTool(sub.id)}
                className={`flex min-w-0 items-center gap-2 border-b border-neutral-700/60 px-2.5 ${showEraserPreviews ? 'py-1.5' : 'py-2'} text-left text-xs transition ${
                  active
                    ? 'bg-indigo-600/25 text-neutral-50'
                    : 'text-neutral-200 hover:bg-neutral-800/70'
                }`}
              >
                {showEraserPreviews ? (
                  <EraserStrokePreview params={liveEraserParams} isLight={isLight} />
                ) : (
                  <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                {key && <kbd className="atelier-kbd shrink-0">{key}</kbd>}
              </button>
            );
          })}
          {onResetSubTool && activeSubTool?.defaultParams && (
            <div className="flex justify-end px-2 py-1.5">
              <button
                type="button"
                data-subtool-reset
                className="atelier-btn px-2 py-0.5 text-[11px]"
                onClick={() => onResetSubTool(activeSubToolId)}
              >
                {t.common.reset}
              </button>
            </div>
          )}
        </div>
      )}
      {showBrushPresets && (
        <Suspense fallback={null}>
          <BrushToolset currentBrushProps={currentBrushProps} selectedId={selectedBrushId} onApplyPreset={onApplyPreset} />
        </Suspense>
      )}
    </div>
  );
}
