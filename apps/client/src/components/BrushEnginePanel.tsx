import React, { useEffect, useRef, useState } from 'react';
import type { BrushProperties } from '../engine/BrushRenderer';
import { useWheelStep } from '../hooks/useWheelStep';
import { useI18n } from '../context/I18nContext';

interface BrushEnginePanelProps {
  brushProps: BrushProperties;
  onChange: (props: Partial<BrushProperties>) => void;
  /** Draws a sample stroke with the current settings */
  renderPreview: () => HTMLCanvasElement | null;
}

const Row: React.FC<{ label: string; hint: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }> = ({
  label, hint, value, min, max, step = 0.05, unit = '%', onChange,
}) => {
  const rowRef = useRef<HTMLLabelElement>(null);
  useWheelStep(rowRef, (steps) => {
    const next = Math.max(min, Math.min(max, Math.round((value + steps * step) * 1000) / 1000));
    if (next !== value) onChange(next);
  });
  return (
    <label ref={rowRef} className="flex items-center gap-2 text-[11px] text-neutral-300" title={hint}>
      <span className="w-16 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-1.5 min-w-0 flex-1" aria-label={label} />
      <span className="w-10 shrink-0 text-right font-mono tabular-nums text-neutral-400">{unit === '%' ? Math.round(value * 100) : Math.round(value)}{unit}</span>
    </label>
  );
};

/** Brush engine options (CSP / Krita style) with a live sample stroke */
export const BrushEnginePanel: React.FC<BrushEnginePanelProps> = ({ brushProps: p, onChange, renderPreview }) => {
  const { t } = useI18n();
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setPreview(renderPreview()?.toDataURL() ?? null), 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);

  const section = 'space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/60 p-2';
  const head = 'text-[11px] font-semibold text-neutral-200';
  return (
    <div className="space-y-2" aria-label={t.studio.brushEngine}>
      <div className="overflow-hidden rounded-lg border border-neutral-700 bg-white" aria-label={t.studio.strokePreview}>
        {preview ? <img src={preview} alt={t.studio.strokePreview} className="block h-[72px] w-full object-contain" /> : <div className="h-[72px]" />}
      </div>

      <div className={section}>
        <div className={head}>{t.studio.paperTexture}</div>
        <Row label={t.studio.textureDensity} hint={t.studio.textureDensityHint} value={p.textureDensity ?? 0} min={0} max={1} onChange={(v) => onChange({ textureDensity: v })} />
        <Row label={t.studio.textureScale} hint="" value={p.textureScale ?? 1} min={0.5} max={4} step={0.1} unit="x" onChange={(v) => onChange({ textureScale: v })} />
      </div>

      <div className={section}>
        <label className={`${head} flex items-center gap-2`}>
          <input type="checkbox" checked={Boolean(p.dualBrush)} onChange={(e) => onChange({ dualBrush: e.target.checked })} />
          {t.studio.dualBrush}
          <span className="font-normal text-neutral-500">{t.studio.dualBrushHint}</span>
        </label>
        {p.dualBrush && (
          <>
            <Row label={t.studio.dualSize} hint="" value={p.dualSize ?? 0.4} min={0.1} max={1} onChange={(v) => onChange({ dualSize: v })} />
            <Row label={t.studio.scatter} hint="" value={p.dualScatter ?? 0.6} min={0} max={2} onChange={(v) => onChange({ dualScatter: v })} />
          </>
        )}
      </div>

      <div className={section}>
        <div className={head}>{t.studio.colorJitter}</div>
        <Row label={t.studio.hueJitter} hint="" value={p.hueJitter ?? 0} min={0} max={1} onChange={(v) => onChange({ hueJitter: v })} />
        <Row label={t.studio.satJitter} hint="" value={p.satJitter ?? 0} min={0} max={1} onChange={(v) => onChange({ satJitter: v })} />
        <Row label={t.studio.valJitter} hint="" value={p.valJitter ?? 0} min={0} max={1} onChange={(v) => onChange({ valJitter: v })} />
      </div>

      <div className={section}>
        <div className={head}>{t.studio.tipAngleAndTilt}</div>
        <div role="radiogroup" aria-label={t.studio.tipAngle} className="flex gap-1">
          {([['direction', t.studio.angleDirection], ['pen', t.studio.anglePen], ['fixed', t.studio.angleFixed]] as const).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={(p.angleMode ?? 'direction') === id} onClick={() => onChange({ angleMode: id })}
              className={`flex-1 rounded-md border px-1.5 py-1 text-[11px] ${(p.angleMode ?? 'direction') === id ? 'border-indigo-400 bg-indigo-600 text-white' : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'}`}>
              {label}
            </button>
          ))}
        </div>
        <Row label={t.studio.tipAngle} hint="" value={p.tipAngle ?? 0} min={-90} max={90} step={1} unit="°" onChange={(v) => onChange({ tipAngle: v })} />
        <Row label={t.studio.roundness} hint="" value={p.roundness ?? 1} min={0.1} max={1} onChange={(v) => onChange({ roundness: v })} />
        <Row label={t.studio.tiltSize} hint="" value={p.tiltSize ?? 0} min={0} max={1} onChange={(v) => onChange({ tiltSize: v })} />
      </div>

      <div className={section}>
        <div className={head}>{t.studio.colorMixing}</div>
        <Row label={t.studio.colorMixing} hint="" value={p.colorMixing ?? 0} min={0} max={1} onChange={(v) => onChange({ colorMixing: v })} />
        <Row label={t.studio.wetness} hint="" value={p.paintAmount ?? 0.7} min={0.1} max={1} onChange={(v) => onChange({ paintAmount: v })} />
        <Row label={t.studio.colorStretch} hint="" value={p.colorStretch ?? 0} min={0} max={1} onChange={(v) => onChange({ colorStretch: v })} />
      </div>
    </div>
  );
};
