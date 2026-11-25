import { lazy, Suspense } from 'react';
import type { AtelierBrushPreset } from '@atelier/shared';
import type { BrushProperties } from '../../engine/BrushRenderer';
import { useI18n } from '../../context/I18nContext';
import { findCategory, findSubTool, getLocalizedCategoryLabel, getLocalizedSubTool } from './toolCatalog';
import type { SubToolId, ToolCategoryId } from './toolCatalog';
import { useShortcutLabel } from './ToolRail';

const BrushToolset = lazy(() => import('../BrushToolset').then((m) => ({ default: m.BrushToolset })));

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
  const { t } = useI18n();
  const shortcutLabel = useShortcutLabel();
  const category = findCategory(activeCategoryId);
  const activeSubTool = findSubTool(activeSubToolId);
  const title = getLocalizedCategoryLabel(activeCategoryId, t);
  const showBrushPresets = activeCategoryId === 'paint' || activeCategoryId === 'eraser';

  return (
    <div className={`flex min-h-0 flex-col ${showBrushPresets ? 'h-full' : ''}`}>
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 pt-2">
        <h3 className="text-xs font-semibold text-neutral-200">{title}</h3>
        {onResetSubTool && activeSubTool?.defaultParams && (
          <button type="button" data-subtool-reset className="atelier-btn px-2 py-1 text-xs"
            onClick={() => onResetSubTool(activeSubToolId)}>
            {t.common.reset}
          </button>
        )}
      </div>
      <div role="group" aria-label={`${t.tools.subToolTitle} · ${title}`} className={`gap-1 p-2 ${showBrushPresets ? 'flex shrink-0 flex-wrap' : 'grid'}`}>
        {category?.subTools.map((sub) => {
          const Icon = sub.icon;
          const { label, hint } = getLocalizedSubTool(sub.id, t);
          const key = shortcutLabel(sub.shortcutId);
          return (
            <button key={sub.id} type="button" data-subtool-id={sub.id}
              aria-pressed={activeSubToolId === sub.id} title={showBrushPresets ? hint : undefined}
              onClick={() => onSelectSubTool(sub.id)}
              className="flex min-w-0 items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/5 aria-pressed:border-indigo-400/50 aria-pressed:bg-indigo-500/20">
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{label}</span>
                {!showBrushPresets && <span className="mt-0.5 block text-[11px] text-neutral-400">{hint}</span>}
              </span>
              {!showBrushPresets && key && <kbd className="atelier-kbd shrink-0">{key}</kbd>}
            </button>
          );
        })}
      </div>
      {showBrushPresets && (
        <Suspense fallback={null}>
          <BrushToolset currentBrushProps={currentBrushProps} selectedId={selectedBrushId} onApplyPreset={onApplyPreset} />
        </Suspense>
      )}
    </div>
  );
}
