import { Layers } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import type { FilterCompositeMemoryPlan } from '../utils/filterMemoryGuard';

export interface FilterTargetOptions {
  /** Whether applying to a new composited layer is active */
  applyToNewLayer: boolean;
  /** Whether the user can apply directly to the active layer (false for vector/text/group/locked) */
  canApplyCurrent: boolean;
  /** Whether creating a new layer is permitted (false for guests without create permission or blocked by memory) */
  canCreateNewLayer: boolean;
  /** Include canvas paper background color when compositing visible layers */
  includeBackground: boolean;
  memoryPlan: FilterCompositeMemoryPlan;
  onToggleNewLayer: (next: boolean) => void;
  onToggleBackground: (next: boolean) => void;
}

/**
 * Compact target selector shared by parameter filters, color curves, and gradient map.
 * Lets the user apply onto a new composited layer above the active layer with one click.
 */
export function FilterTargetBar({ target, busy }: { target?: FilterTargetOptions; busy: boolean }) {
  const { t } = useI18n();
  if (!target) return null;
  const lockedToNew = !target.canApplyCurrent && target.applyToNewLayer;
  const blocked = target.memoryPlan.tier === 'block';
  const disableToggle = busy || lockedToNew || (!target.applyToNewLayer && (!target.canCreateNewLayer || blocked));

  return (
    <div className="space-y-1 border-t border-neutral-800/80 pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-neutral-300">
        <label
          className={`flex items-center gap-1.5 ${disableToggle ? 'cursor-not-allowed opacity-65' : 'cursor-pointer'}`}
          title={blocked ? t.filters.newLayerBlocked : lockedToNew ? t.filters.newLayerForcedHint : undefined}
        >
          <input
            type="checkbox"
            disabled={disableToggle}
            checked={target.applyToNewLayer}
            onChange={(e) => target.onToggleNewLayer(e.target.checked)}
          />
          <Layers className="h-3.5 w-3.5 shrink-0 text-indigo-300" aria-hidden />
          <span>{t.filters.applyToNewLayer}</span>
        </label>
        {target.applyToNewLayer && (
          <label className={`flex items-center gap-1.5 text-neutral-400 ${busy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:text-neutral-200'}`}>
            <input
              type="checkbox"
              disabled={busy}
              checked={target.includeBackground}
              onChange={(e) => target.onToggleBackground(e.target.checked)}
            />
            <span>{t.filters.includeBackground}</span>
          </label>
        )}
      </div>
      {lockedToNew && (
        <p className="text-[10px] leading-snug text-indigo-300/85">{t.filters.newLayerForcedHint}</p>
      )}
      {target.applyToNewLayer && (target.memoryPlan.tier === 'warn' || target.memoryPlan.tier === 'confirm') && (
        <p className="text-[10px] leading-snug text-amber-300/85">
          {t.filters.newLayerMemoryHint.replace('{mb}', String(target.memoryPlan.estimatedMB))}
        </p>
      )}
      {blocked && !target.applyToNewLayer && (
        <p className="text-[10px] leading-snug text-neutral-500">{t.filters.newLayerBlocked}</p>
      )}
    </div>
  );
}
