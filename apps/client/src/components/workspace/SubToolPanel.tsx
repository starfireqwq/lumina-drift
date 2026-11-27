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
  const showBrushPresets = activeCategoryId === 'paint';

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
            return (
              <button
                key={sub.id}
                type="button"
                data-subtool-id={sub.id}
                aria-pressed={active}
                title={hint}
                onClick={() => onSelectSubTool(sub.id)}
                className={`flex min-w-0 items-center gap-2 border-b border-neutral-700/60 px-2.5 py-2 text-left text-xs transition ${
                  active
                    ? 'bg-indigo-600/25 text-neutral-50'
                    : 'text-neutral-200 hover:bg-neutral-800/70'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
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
