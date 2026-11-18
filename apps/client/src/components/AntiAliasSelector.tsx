import React from 'react';
import type { AntiAliasLevel } from '../engine/BrushRenderer';
import { useI18n } from '../context/I18nContext';

interface AntiAliasSelectorProps {
  value: AntiAliasLevel | undefined;
  onChange: (level: AntiAliasLevel) => void;
  compact?: boolean;
  requireCoverage?: boolean;
}

const LEVELS: AntiAliasLevel[] = ['none', 'weak', 'medium', 'strong'];

const AntiAliasGlyph: React.FC<{ level: AntiAliasLevel }> = ({ level }) => {
  if (level === 'none') {
    // Crisp jagged bitmap cross/circle silhouette representing binary 0-AA pixel rendering
    return (
      <svg viewBox="0 0 18 18" className="h-3.5 w-3.5" aria-hidden="true">
        <path
          fill="currentColor"
          d="M7 2h4v2h2v2h2v4h-2v2h-2v2H7v-2H5v-2H3V6h2V4h2V2z"
        />
      </svg>
    );
  }
  if (level === 'weak') {
    return (
      <svg viewBox="0 0 18 18" className="h-3.5 w-3.5" aria-hidden="true">
        <circle cx="9" cy="9" r="5.6" fill="currentColor" opacity="0.22" />
        <circle cx="9" cy="9" r="4.9" fill="currentColor" />
      </svg>
    );
  }
  if (level === 'medium') {
    return (
      <svg viewBox="0 0 18 18" className="h-3.5 w-3.5" aria-hidden="true">
        <circle cx="9" cy="9" r="6.3" fill="currentColor" opacity="0.24" />
        <circle cx="9" cy="9" r="5.0" fill="currentColor" opacity="0.55" />
        <circle cx="9" cy="9" r="3.9" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 18 18" className="h-3.5 w-3.5" aria-hidden="true">
      <circle cx="9" cy="9" r="7.2" fill="currentColor" opacity="0.16" />
      <circle cx="9" cy="9" r="5.6" fill="currentColor" opacity="0.34" />
      <circle cx="9" cy="9" r="4.1" fill="currentColor" opacity="0.65" />
      <circle cx="9" cy="9" r="2.8" fill="currentColor" />
    </svg>
  );
};

/** 4-level anti-aliasing selector matching CSP's icon strip (none / weak / medium / strong) */
export const AntiAliasSelector: React.FC<AntiAliasSelectorProps> = ({ value, onChange, compact = false, requireCoverage = false }) => {
  const { t } = useI18n();
  const active: AntiAliasLevel = requireCoverage && value === 'none' ? 'medium' : value ?? 'medium';
  const levels = requireCoverage ? LEVELS.slice(1) : LEVELS;

  const labels: Record<AntiAliasLevel, string> = {
    none: t.studio.antiAliasNone,
    weak: t.studio.antiAliasWeak,
    medium: t.studio.antiAliasMedium,
    strong: t.studio.antiAliasStrong,
  };

  return (
    <div
      role="radiogroup"
      aria-label={t.studio.antiAlias}
      className={compact ? 'inline-flex shrink-0 items-center gap-0.5 rounded-md border border-neutral-800 bg-neutral-900/70 p-0.5' : 'grid grid-cols-4 gap-1'}
    >
      {levels.map((lvl) => {
        const selected = active === lvl;
        const label = `${t.studio.antiAlias}: ${labels[lvl]}`;
        return (
          <button
            key={lvl}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => onChange(lvl)}
            className={
              compact
                ? `flex h-6 w-6 items-center justify-center rounded transition ${
                    selected
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'
                  }`
                : `flex items-center justify-center gap-1 rounded border py-1 text-[10px] font-medium transition ${
                    selected
                      ? 'border-indigo-400 bg-indigo-600 text-white'
                      : 'border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-750 hover:text-white'
                  }`
            }
          >
            <AntiAliasGlyph level={lvl} />
            {!compact && <span>{labels[lvl]}</span>}
          </button>
        );
      })}
    </div>
  );
};
