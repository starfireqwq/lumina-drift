import React, { useEffect, useRef, useState } from 'react';
import {
  resolveDefaultBrushDynamics,
  type BrushDynamicChannel,
  type BrushDynamicsConfig,
  type BrushMixMode,
  type BrushTextureBlendMode,
  type DualBrushBlendMode,
} from '@atelier/shared';
import { Upload, X } from 'lucide-react';
import type { BrushProperties } from '../engine/BrushRenderer';
import { useWheelStep } from '../hooks/useWheelStep';
import { useI18n } from '../context/I18nContext';

interface BrushEnginePanelProps {
  brushProps: BrushProperties;
  onChange: (props: Partial<BrushProperties>) => void;
  /** Draws a sample stroke with the current settings */
  renderPreview: () => HTMLCanvasElement | null;
}

const Row: React.FC<{
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}> = ({ label, hint, value, min, max, step = 0.05, unit = '%', onChange }) => {
  const rowRef = useRef<HTMLLabelElement>(null);
  useWheelStep(rowRef, (steps) => {
    const next = Math.max(min, Math.min(max, Math.round((value + steps * step) * 1000) / 1000));
    if (next !== value) onChange(next);
  });
  return (
    <label ref={rowRef} className="flex min-w-0 items-center gap-2 text-[11px] text-neutral-300" title={hint}>
      <span className="w-[4.5rem] shrink-0 truncate">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 min-w-0 flex-1"
        aria-label={label}
      />
      <span className="w-10 shrink-0 text-right font-mono tabular-nums text-neutral-400">
        {unit === '%' ? Math.round(value * 100) : unit === 'x' ? value.toFixed(1) : Math.round(value)}
        {unit}
      </span>
    </label>
  );
};

const Pill: React.FC<{
  active: boolean;
  label: string;
  onClick: () => void;
  testId?: string;
}> = ({ active, label, onClick, testId }) => (
  <button
    type="button"
    data-testid={testId}
    aria-pressed={active}
    onClick={onClick}
    className={`rounded-md border px-1.5 py-0.5 text-[10px] leading-tight transition-colors ${
      active
        ? 'border-indigo-400 bg-indigo-600/80 text-white'
        : 'border-neutral-700 bg-neutral-900/70 text-neutral-300 hover:bg-neutral-800'
    }`}
  >
    {label}
  </button>
);

const readImageAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Brush engine options with live sample stroke, per-channel dynamics, wet mix, paper texture, and dual brush */
export const BrushEnginePanel: React.FC<BrushEnginePanelProps> = ({ brushProps: p, onChange, renderPreview }) => {
  const { t } = useI18n();
  const [preview, setPreview] = useState<string | null>(null);
  const textureFileRef = useRef<HTMLInputElement>(null);
  const dualFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setPreview(renderPreview()?.toDataURL() ?? null), 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);

  const defaults = resolveDefaultBrushDynamics(p);
  const dyn: BrushDynamicsConfig = {
    size: { ...defaults.size, ...p.dynamics?.size },
    opacity: { ...defaults.opacity, ...p.dynamics?.opacity },
    flow: { ...defaults.flow, ...p.dynamics?.flow },
    angle: { ...defaults.angle, ...p.dynamics?.angle },
    scatter: { ...defaults.scatter, ...p.dynamics?.scatter },
    colorMix: { ...defaults.colorMix, ...p.dynamics?.colorMix },
  };

  const patchChannel = (key: keyof BrushDynamicsConfig, patch: Partial<BrushDynamicChannel>) => {
    const nextChannel: BrushDynamicChannel = { ...(dyn[key] ?? {}), ...patch };
    onChange({
      dynamics: {
        ...dyn,
        [key]: nextChannel,
      },
    });
  };

  const hasDynamicControl = (ch?: BrushDynamicChannel) =>
    Boolean(ch?.pressure || ch?.tilt || ch?.velocity || (ch?.random ?? 0) > 0);

  const section = 'space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/60 p-2';
  const head = 'text-[11px] font-semibold text-neutral-200';
  const mixMode: BrushMixMode = p.mixMode ?? 'blend';
  const texMode: BrushTextureBlendMode = p.textureBlendMode ?? 'subtract';
  const dualMode: DualBrushBlendMode = p.dualBlendMode ?? 'multiply';

  return (
    <div className="space-y-2" aria-label={t.studio.brushEngine} data-testid="brush-engine-panel">
      <div className="overflow-hidden rounded-lg border border-neutral-700 bg-white" aria-label={t.studio.strokePreview}>
        {preview ? (
          <img src={preview} alt={t.studio.strokePreview} className="block h-[72px] w-full object-contain" />
        ) : (
          <div className="h-[72px]" />
        )}
      </div>

      {/* Per-channel Stroke Dynamics (Size / Opacity / Flow / Angle / Scatter) */}
      <div className={section} data-testid="brush-dynamics-section">
        <div className={head}>{t.studio.brushDynamics}</div>

        {/* Opacity Dynamics */}
        <div className="space-y-1 rounded-md border border-neutral-800/80 bg-neutral-950/40 p-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="text-[11px] text-neutral-200">{t.studio.dynOpacity}</span>
            <div className="flex flex-wrap gap-1">
              <Pill
                testId="dyn-opacity-pressure"
                active={Boolean(dyn.opacity?.pressure)}
                label={t.studio.dynPressure}
                onClick={() => patchChannel('opacity', { pressure: !dyn.opacity?.pressure })}
              />
              <Pill
                testId="dyn-opacity-tilt"
                active={Boolean(dyn.opacity?.tilt)}
                label={t.studio.dynTilt}
                onClick={() => patchChannel('opacity', { tilt: !dyn.opacity?.tilt })}
              />
              <Pill
                testId="dyn-opacity-velocity"
                active={Boolean(dyn.opacity?.velocity)}
                label={t.studio.dynVelocity}
                onClick={() => patchChannel('opacity', { velocity: !dyn.opacity?.velocity })}
              />
            </div>
          </div>
          {hasDynamicControl(dyn.opacity) && (
            <Row
              label={t.studio.dynMin}
              hint=""
              value={dyn.opacity?.min ?? 0}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => patchChannel('opacity', { min: v })}
            />
          )}
          <Row
            label={t.studio.dynRandom}
            hint=""
            value={dyn.opacity?.random ?? 0}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => patchChannel('opacity', { random: v })}
          />
        </div>

        {/* Flow Dynamics */}
        <div className="space-y-1 rounded-md border border-neutral-800/80 bg-neutral-950/40 p-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="text-[11px] text-neutral-200">{t.studio.dynFlow}</span>
            <div className="flex flex-wrap gap-1">
              <Pill
                testId="dyn-flow-pressure"
                active={Boolean(dyn.flow?.pressure)}
                label={t.studio.dynPressure}
                onClick={() => patchChannel('flow', { pressure: !dyn.flow?.pressure })}
              />
              <Pill
                active={Boolean(dyn.flow?.tilt)}
                label={t.studio.dynTilt}
                onClick={() => patchChannel('flow', { tilt: !dyn.flow?.tilt })}
              />
              <Pill
                active={Boolean(dyn.flow?.velocity)}
                label={t.studio.dynVelocity}
                onClick={() => patchChannel('flow', { velocity: !dyn.flow?.velocity })}
              />
            </div>
          </div>
          {hasDynamicControl(dyn.flow) && (
            <Row
              label={t.studio.dynMin}
              hint=""
              value={dyn.flow?.min ?? 0}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => patchChannel('flow', { min: v })}
            />
          )}
        </div>

        {/* Size Dynamics */}
        <div className="space-y-1 rounded-md border border-neutral-800/80 bg-neutral-950/40 p-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="text-[11px] text-neutral-200">{t.studio.dynSize}</span>
            <div className="flex flex-wrap gap-1">
              <Pill
                testId="dyn-size-pressure"
                active={Boolean(dyn.size?.pressure)}
                label={t.studio.dynPressure}
                onClick={() => patchChannel('size', { pressure: !dyn.size?.pressure })}
              />
              <Pill
                active={Boolean(dyn.size?.tilt)}
                label={t.studio.dynTilt}
                onClick={() => patchChannel('size', { tilt: !dyn.size?.tilt })}
              />
              <Pill
                active={Boolean(dyn.size?.velocity)}
                label={t.studio.dynVelocity}
                onClick={() => patchChannel('size', { velocity: !dyn.size?.velocity })}
              />
            </div>
          </div>
          <Row
            label={t.studio.dynRandom}
            hint=""
            value={dyn.size?.random ?? 0}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => patchChannel('size', { random: v })}
          />
        </div>

        {/* Angle Jitter & Scatter Pressure */}
        <Row
          label={t.studio.dynAngleJitter}
          hint=""
          value={dyn.angle?.random ?? 0}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => patchChannel('angle', { random: v })}
        />
        <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-300">
          <span className="truncate">{t.studio.dynScatterPressure}</span>
          <Pill
            active={Boolean(dyn.scatter?.pressure)}
            label={t.studio.dynPressure}
            onClick={() => patchChannel('scatter', { pressure: !dyn.scatter?.pressure })}
          />
        </div>
      </div>

      {/* Color Mixing & Wet Edges */}
      <div className={section} data-testid="brush-mixing-section">
        <div className={head}>{t.studio.colorMixing}</div>
        <div role="radiogroup" aria-label={t.studio.colorMixing} className="flex flex-wrap gap-1">
          {(
            [
              ['blend', t.studio.mixModeBlend],
              ['smudge', t.studio.mixModeSmudge],
              ['dilute', t.studio.mixModeDilute],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              data-testid={`mix-mode-${id}`}
              aria-checked={mixMode === id}
              onClick={() => onChange({ mixMode: id, ...(id !== 'blend' && (p.colorMixing ?? 0) === 0 ? { colorMixing: 0.7 } : {}) })}
              className={`min-w-0 flex-1 rounded-md border px-1.5 py-1 text-[11px] ${
                mixMode === id
                  ? 'border-indigo-400 bg-indigo-600 text-white'
                  : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Row label={t.studio.colorMixing} hint="" value={p.colorMixing ?? 0} min={0} max={1} onChange={(v) => onChange({ colorMixing: v })} />
        <Row label={t.studio.wetness} hint="" value={p.paintAmount ?? 0.7} min={0.05} max={1} onChange={(v) => onChange({ paintAmount: v })} />
        <Row label={t.studio.colorStretch} hint="" value={p.colorStretch ?? 0} min={0} max={1} onChange={(v) => onChange({ colorStretch: v })} />
        <label className="flex items-center gap-2 pt-0.5 text-[11px] text-neutral-200">
          <input
            type="checkbox"
            data-testid="brush-wet-edges"
            checked={Boolean(p.wetEdges)}
            onChange={(e) => onChange({ wetEdges: e.target.checked })}
          />
          {t.studio.wetEdges}
        </label>
      </div>

      {/* Color Dynamics (FG/BG Mix + HSV Jitter) */}
      <div className={section}>
        <div className="flex items-center justify-between gap-1">
          <div className={head}>{t.studio.colorJitter}</div>
          <Pill
            testId="dyn-fgbg-pressure"
            active={Boolean(dyn.colorMix?.pressure)}
            label={t.studio.dynPressure}
            onClick={() => patchChannel('colorMix', { pressure: !dyn.colorMix?.pressure })}
          />
        </div>
        <Row label={t.studio.fgBgMix} hint="" value={p.fgBgMix ?? 0} min={0} max={1} step={0.01} onChange={(v) => onChange({ fgBgMix: v })} />
        <Row label={t.studio.hueJitter} hint="" value={p.hueJitter ?? 0} min={0} max={1} onChange={(v) => onChange({ hueJitter: v })} />
        <Row label={t.studio.satJitter} hint="" value={p.satJitter ?? 0} min={0} max={1} onChange={(v) => onChange({ satJitter: v })} />
        <Row label={t.studio.valJitter} hint="" value={p.valJitter ?? 0} min={0} max={1} onChange={(v) => onChange({ valJitter: v })} />
      </div>

      {/* Paper Texture */}
      <div className={section}>
        <div className="flex flex-wrap items-center justify-between gap-1">
          <div className={head}>{t.studio.paperTexture}</div>
          <div className="flex items-center gap-1">
            <Pill
              active={Boolean(p.textureInvert)}
              label={t.studio.textureInvert}
              onClick={() => onChange({ textureInvert: !p.textureInvert })}
            />
            <button
              type="button"
              onClick={() => textureFileRef.current?.click()}
              className="flex items-center gap-1 rounded-md border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:bg-neutral-800"
            >
              <Upload className="h-2.5 w-2.5" />
              {t.studio.uploadTexture}
            </button>
            {p.customTextureUrl && (
              <button
                type="button"
                title={t.studio.clearTexture}
                onClick={() => onChange({ customTextureUrl: null })}
                className="rounded-md border border-neutral-700 p-0.5 text-neutral-400 hover:text-white"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
            <input
              ref={textureFileRef}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  void readImageAsDataUrl(f).then((url) =>
                    onChange({ customTextureUrl: url, ...(p.textureDensity ? {} : { textureDensity: 0.45 }) })
                  );
                }
                e.target.value = '';
              }}
            />
          </div>
        </div>
        <div role="radiogroup" aria-label={t.studio.paperTexture} className="flex flex-wrap gap-1">
          {(
            [
              ['subtract', t.studio.texModeSubtract],
              ['multiply', t.studio.texModeMultiply],
              ['overlay', t.studio.texModeOverlay],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={texMode === id}
              onClick={() => onChange({ textureBlendMode: id })}
              className={`min-w-0 flex-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
                texMode === id
                  ? 'border-indigo-400 bg-indigo-600 text-white'
                  : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Row label={t.studio.textureDensity} hint={t.studio.textureDensityHint} value={p.textureDensity ?? 0} min={0} max={1} onChange={(v) => onChange({ textureDensity: v })} />
        <Row label={t.studio.textureScale} hint="" value={p.textureScale ?? 1} min={0.5} max={4} step={0.1} unit="x" onChange={(v) => onChange({ textureScale: v })} />
      </div>

      {/* Dual Brush */}
      <div className={section}>
        <label className={`${head} flex flex-wrap items-center gap-1.5`}>
          <input type="checkbox" checked={Boolean(p.dualBrush)} onChange={(e) => onChange({ dualBrush: e.target.checked })} />
          <span>{t.studio.dualBrush}</span>
          <span className="font-normal text-neutral-500">{t.studio.dualBrushHint}</span>
        </label>
        {p.dualBrush && (
          <>
            <div role="radiogroup" aria-label={t.studio.dualBrush} className="flex flex-wrap gap-1">
              {(
                [
                  ['multiply', t.studio.dualModeMultiply],
                  ['subtract', t.studio.dualModeSubtract],
                  ['darken', t.studio.dualModeDarken],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={dualMode === id}
                  onClick={() => onChange({ dualBlendMode: id })}
                  className={`min-w-0 flex-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
                    dualMode === id
                      ? 'border-indigo-400 bg-indigo-600 text-white'
                      : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Row label={t.studio.dualSize} hint="" value={p.dualSize ?? 0.4} min={0.1} max={1} onChange={(v) => onChange({ dualSize: v })} />
            <Row label={t.studio.scatter} hint="" value={p.dualScatter ?? 0.6} min={0} max={2} onChange={(v) => onChange({ dualScatter: v })} />
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => dualFileRef.current?.click()}
                className="flex items-center gap-1 rounded-md border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:bg-neutral-800"
              >
                <Upload className="h-2.5 w-2.5" />
                {t.studio.uploadDualTip}
              </button>
              {p.dualTipUrl && (
                <button
                  type="button"
                  onClick={() => onChange({ dualTipUrl: null })}
                  className="text-[10px] text-neutral-400 hover:text-white"
                >
                  {t.studio.clearDualTip}
                </button>
              )}
              <input
                ref={dualFileRef}
                type="file"
                accept="image/png,image/webp,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readImageAsDataUrl(f).then((url) => onChange({ dualTipUrl: url }));
                  e.target.value = '';
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* Angle & Tilt */}
      <div className={section}>
        <div className={head}>{t.studio.tipAngleAndTilt}</div>
        <div role="radiogroup" aria-label={t.studio.tipAngle} className="flex flex-wrap gap-1">
          {(
            [
              ['direction', t.studio.angleDirection],
              ['pen', t.studio.anglePen],
              ['fixed', t.studio.angleFixed],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={(p.angleMode ?? 'direction') === id}
              onClick={() => onChange({ angleMode: id })}
              className={`min-w-0 flex-1 rounded-md border px-1.5 py-1 text-[11px] ${
                (p.angleMode ?? 'direction') === id
                  ? 'border-indigo-400 bg-indigo-600 text-white'
                  : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Row label={t.studio.tipAngle} hint="" value={p.tipAngle ?? 0} min={-90} max={90} step={1} unit="°" onChange={(v) => onChange({ tipAngle: v })} />
        <Row label={t.studio.roundness} hint="" value={p.roundness ?? 1} min={0.1} max={1} onChange={(v) => onChange({ roundness: v })} />
        <Row label={t.studio.tiltSize} hint="" value={p.tiltSize ?? 0} min={0} max={1} onChange={(v) => onChange({ tiltSize: v })} />
      </div>
    </div>
  );
};
