import React, { useEffect, useRef, useState } from 'react';
import {
  resolveDefaultBrushDynamics,
  type BrushColorDynamicsConfig,
  type BrushDynamicChannel,
  type BrushDynamicsConfig,
  type BrushMixMode,
  type BrushTextureBlendMode,
  type BrushTipPlayMode,
  type ColorDynamicsScope,
  type DualBrushBlendMode,
  type DualTipShape,
  type PigmentBlendModel,
} from '@atelier/shared';
import { Plus, Upload, X } from 'lucide-react';
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
  const multiTipFileRef = useRef<HTMLInputElement>(null);

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
    const nextDynamics: BrushDynamicsConfig = {
      ...dyn,
      [key]: nextChannel,
    };
    // Keep size.min bound to BrushSettingsModal's minSize slider unless explicitly set on the brush.
    if (p.dynamics?.size?.min === undefined && nextDynamics.size) {
      const { min: _omit, ...sizeWithoutMin } = nextDynamics.size;
      nextDynamics.size = sizeWithoutMin;
    }
    onChange({
      dynamics: nextDynamics,
    });
  };

  const hasDynamicControl = (ch?: BrushDynamicChannel) =>
    Boolean(ch?.pressure || ch?.tilt || ch?.velocity || (ch?.random ?? 0) > 0);

  const section = 'space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/60 p-2';
  const head = 'text-[11px] font-semibold text-neutral-200';
  const mixMode: BrushMixMode = p.mixMode ?? 'blend';
  const pigmentModel: PigmentBlendModel = p.pigmentBlendMode ?? 'subtractive';
  const texMode: BrushTextureBlendMode = p.textureBlendMode ?? 'subtract';
  const dualMode: DualBrushBlendMode = p.dualBlendMode ?? 'multiply';
  const dualShape: DualTipShape = p.dualTipShape ?? (p.dualTipUrl ? 'custom' : 'same');
  const tipPlayMode: BrushTipPlayMode = p.tipPlayMode ?? 'single';
  const tipUrls = p.tipUrls ?? [];
  const colorDyn: BrushColorDynamicsConfig = {
    scope: p.colorDynamics?.scope ?? 'perDab',
    hueJitter: p.colorDynamics?.hueJitter ?? p.hueJitter ?? 0,
    saturationJitter: p.colorDynamics?.saturationJitter ?? p.satJitter ?? 0,
    lightnessJitter: p.colorDynamics?.lightnessJitter ?? p.valJitter ?? 0,
    huePressure: p.colorDynamics?.huePressure ?? 0,
    saturationPressure: p.colorDynamics?.saturationPressure ?? 0,
    lightnessPressure: p.colorDynamics?.lightnessPressure ?? 0,
    hueGradient: p.colorDynamics?.hueGradient ?? 0,
    saturationGradient: p.colorDynamics?.saturationGradient ?? 0,
    lightnessGradient: p.colorDynamics?.lightnessGradient ?? 0,
    gradientLength: p.colorDynamics?.gradientLength ?? 400,
    fgBgMix: p.colorDynamics?.fgBgMix ?? p.fgBgMix ?? 0,
    fgBgGradient: p.colorDynamics?.fgBgGradient ?? false,
  };
  const patchColorDyn = (patch: Partial<BrushColorDynamicsConfig>) => {
    const next: BrushColorDynamicsConfig = { ...colorDyn, ...patch };
    const extra: Partial<BrushProperties> = { colorDynamics: next };
    if ('hueJitter' in patch) extra.hueJitter = patch.hueJitter;
    if ('saturationJitter' in patch) extra.satJitter = patch.saturationJitter;
    if ('lightnessJitter' in patch) extra.valJitter = patch.lightnessJitter;
    if ('fgBgMix' in patch) extra.fgBgMix = patch.fgBgMix;
    onChange(extra);
  };

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
        <div className="space-y-1 pt-0.5">
          <div className="text-[10px] text-neutral-400">{t.studio.pigmentModelLabel}</div>
          <div role="radiogroup" aria-label={t.studio.pigmentModelLabel} className="flex flex-wrap gap-1">
            {(
              [
                ['subtractive', t.studio.pigmentModelSubtractive],
                ['oklab', t.studio.pigmentModelOklab],
                ['rgb', t.studio.pigmentModelRgb],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                data-testid={`pigment-model-${id}`}
                aria-checked={pigmentModel === id}
                onClick={() => onChange({ pigmentBlendMode: id })}
                className={`min-w-0 flex-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
                  pigmentModel === id
                    ? 'border-indigo-400 bg-indigo-600 text-white'
                    : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {pigmentModel === 'subtractive' && (
          <Row label={t.studio.pigmentStrength} hint="" value={p.pigmentStrength ?? 0.85} min={0} max={1} onChange={(v) => onChange({ pigmentStrength: v })} />
        )}
        <Row label={t.studio.chargeDepletion} hint="" value={p.chargeDepletion ?? 0} min={0} max={1} onChange={(v) => onChange({ chargeDepletion: v })} />
        <label className="flex items-center gap-2 pt-0.5 text-[11px] text-neutral-200">
          <input
            type="checkbox"
            data-testid="brush-wet-edges"
            checked={Boolean(p.wetEdges)}
            onChange={(e) => onChange({ wetEdges: e.target.checked })}
          />
          {t.studio.wetEdges}
        </label>
        {p.wetEdges && (
          <div className="space-y-1 border-l border-neutral-800 pl-2" data-testid="brush-wet-edge-controls">
            <Row label={t.studio.wetEdgeStrength} hint="" value={p.wetEdgeStrength ?? 0.55} min={0} max={1} onChange={(v) => onChange({ wetEdgeStrength: v })} />
            <Row label={t.studio.wetEdgeWidth} hint="" value={p.wetEdgeWidth ?? 0.22} min={0.05} max={0.5} step={0.01} onChange={(v) => onChange({ wetEdgeWidth: v })} />
            <Row label={t.studio.wetEdgeDarkness} hint="" value={p.wetEdgeDarkness ?? 0.35} min={0} max={1} onChange={(v) => onChange({ wetEdgeDarkness: v })} />
          </div>
        )}
      </div>

      {/* Color Dynamics (FG/BG Mix + HSL Random / Pressure / Stroke Gradient) */}
      <div className={section} data-testid="brush-color-dynamics-section">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <div className={head}>{t.studio.colorJitter}</div>
          <div className="flex items-center gap-1">
            {(
              [
                ['perDab', t.studio.colorScopePerDab],
                ['perStroke', t.studio.colorScopePerStroke],
              ] as readonly [ColorDynamicsScope, string][]
            ).map(([scopeId, label]) => (
              <Pill
                key={scopeId}
                testId={`color-scope-${scopeId}`}
                active={(colorDyn.scope ?? 'perDab') === scopeId}
                label={label}
                onClick={() => patchColorDyn({ scope: scopeId })}
              />
            ))}
            <Pill
              testId="dyn-fgbg-pressure"
              active={Boolean(dyn.colorMix?.pressure)}
              label={t.studio.dynPressure}
              onClick={() => patchChannel('colorMix', { pressure: !dyn.colorMix?.pressure })}
            />
          </div>
        </div>
        <Row label={t.studio.fgBgMix} hint="" value={colorDyn.fgBgMix ?? 0} min={0} max={1} step={0.01} onChange={(v) => patchColorDyn({ fgBgMix: v })} />
        <label className="flex items-center gap-2 text-[10px] text-neutral-300">
          <input
            type="checkbox"
            data-testid="color-fgbg-gradient"
            checked={Boolean(colorDyn.fgBgGradient)}
            onChange={(e) => patchColorDyn({ fgBgGradient: e.target.checked })}
          />
          {t.studio.colorFgBgGradient}
        </label>
        <Row label={t.studio.hueJitter} hint="" value={colorDyn.hueJitter ?? 0} min={0} max={1} onChange={(v) => patchColorDyn({ hueJitter: v })} />
        <Row label={t.studio.satJitter} hint="" value={colorDyn.saturationJitter ?? 0} min={0} max={1} onChange={(v) => patchColorDyn({ saturationJitter: v })} />
        <Row label={t.studio.valJitter} hint="" value={colorDyn.lightnessJitter ?? 0} min={0} max={1} onChange={(v) => patchColorDyn({ lightnessJitter: v })} />
        <div className="space-y-1 border-t border-neutral-800/80 pt-1">
          <Row label={t.studio.colorHuePressure} hint="" value={colorDyn.huePressure ?? 0} min={-1} max={1} step={0.05} onChange={(v) => patchColorDyn({ huePressure: v })} />
          <Row label={t.studio.colorSatPressure} hint="" value={colorDyn.saturationPressure ?? 0} min={-1} max={1} step={0.05} onChange={(v) => patchColorDyn({ saturationPressure: v })} />
          <Row label={t.studio.colorLightPressure} hint="" value={colorDyn.lightnessPressure ?? 0} min={-1} max={1} step={0.05} onChange={(v) => patchColorDyn({ lightnessPressure: v })} />
          <Row label={t.studio.colorHueGradient} hint="" value={colorDyn.hueGradient ?? 0} min={-1} max={1} step={0.05} onChange={(v) => patchColorDyn({ hueGradient: v })} />
          <Row label={t.studio.colorSatGradient} hint="" value={colorDyn.saturationGradient ?? 0} min={-1} max={1} step={0.05} onChange={(v) => patchColorDyn({ saturationGradient: v })} />
          <Row label={t.studio.colorLightGradient} hint="" value={colorDyn.lightnessGradient ?? 0} min={-1} max={1} step={0.05} onChange={(v) => patchColorDyn({ lightnessGradient: v })} />
          <Row label={t.studio.colorGradientLength} hint="" value={colorDyn.gradientLength ?? 400} min={50} max={2000} step={50} unit="px" onChange={(v) => patchColorDyn({ gradientLength: v })} />
        </div>
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
      <div className={section} data-testid="brush-dual-section">
        <label className={`${head} flex flex-wrap items-center gap-1.5`}>
          <input
            type="checkbox"
            data-testid="brush-dual-toggle"
            checked={Boolean(p.dualBrush)}
            onChange={(e) => onChange({ dualBrush: e.target.checked })}
          />
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
                  ['screen', t.studio.dualModeScreen],
                  ['overlay', t.studio.dualModeOverlay],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  data-testid={`dual-mode-${id}`}
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
            <div className="space-y-1">
              <div className="text-[10px] text-neutral-400">{t.studio.dualTipShape}</div>
              <div role="radiogroup" aria-label={t.studio.dualTipShape} className="flex flex-wrap gap-1">
                {(
                  [
                    ['same', t.studio.dualShapeSame],
                    ['round', t.studio.dualShapeRound],
                    ['soft', t.studio.dualShapeSoft],
                    ['speckle', t.studio.dualShapeSpeckle],
                    ['bristle', t.studio.dualShapeBristle],
                    ['square', t.studio.dualShapeSquare],
                    ['custom', t.studio.dualShapeCustom],
                  ] as const
                ).map(([shapeId, label]) => (
                  <button
                    key={shapeId}
                    type="button"
                    role="radio"
                    data-testid={`dual-shape-${shapeId}`}
                    aria-checked={dualShape === shapeId}
                    onClick={() => onChange({ dualTipShape: shapeId })}
                    className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
                      dualShape === shapeId
                        ? 'border-indigo-400 bg-indigo-600 text-white'
                        : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <Row label={t.studio.dualSize} hint="" value={p.dualSize ?? 0.4} min={0.1} max={1} onChange={(v) => onChange({ dualSize: v })} />
            <Row label={t.studio.dualSpacing} hint="" value={p.dualSpacing ?? 0.35} min={0.05} max={2} step={0.05} onChange={(v) => onChange({ dualSpacing: v })} />
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
                  onClick={() => onChange({ dualTipUrl: null, dualTipShape: dualShape === 'custom' ? 'same' : dualShape })}
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
                  if (f) void readImageAsDataUrl(f).then((url) => onChange({ dualTipUrl: url, dualTipShape: 'custom' }));
                  e.target.value = '';
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* Multi-Tip Playback */}
      <div className={section} data-testid="brush-multitip-section">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <div className={head}>{t.studio.multiTipTitle}</div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="multitip-add-btn"
              onClick={() => multiTipFileRef.current?.click()}
              className="flex items-center gap-1 rounded-md border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:bg-neutral-800"
            >
              <Plus className="h-2.5 w-2.5" />
              {t.studio.multiTipAdd}
            </button>
            {tipUrls.length > 0 && (
              <button
                type="button"
                data-testid="multitip-clear-btn"
                onClick={() => onChange({ tipUrls: [], tipPlayMode: 'single' })}
                className="text-[10px] text-neutral-400 hover:text-white"
              >
                {t.studio.multiTipClear}
              </button>
            )}
            <input
              ref={multiTipFileRef}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) {
                  void Promise.all(files.map(readImageAsDataUrl)).then((urls) => {
                    const nextUrls = [...tipUrls, ...urls];
                    onChange({
                      tipUrls: nextUrls,
                      tipPlayMode: tipPlayMode === 'single' && nextUrls.length >= 2 ? 'sequential' : tipPlayMode,
                    });
                  });
                }
                e.target.value = '';
              }}
            />
          </div>
        </div>
        <div role="radiogroup" aria-label={t.studio.multiTipTitle} className="flex flex-wrap gap-1">
          {(
            [
              ['single', t.studio.multiTipSingle],
              ['sequential', t.studio.multiTipSequential],
              ['random', t.studio.multiTipRandom],
              ['randomNoRepeat', t.studio.multiTipRandomNoRepeat],
            ] as const
          ).map(([modeId, label]) => (
            <button
              key={modeId}
              type="button"
              role="radio"
              data-testid={`tip-play-${modeId}`}
              aria-checked={tipPlayMode === modeId}
              onClick={() => onChange({ tipPlayMode: modeId })}
              className={`min-w-0 flex-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
                tipPlayMode === modeId
                  ? 'border-indigo-400 bg-indigo-600 text-white'
                  : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tipUrls.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5" data-testid="multitip-thumbnails">
            {tipUrls.map((url, idx) => (
              <div key={`${idx}_${url.slice(0, 24)}`} className="relative h-8 w-8 overflow-hidden rounded border border-neutral-700 bg-neutral-100">
                <img src={url} alt={`Tip ${idx + 1}`} className="h-full w-full object-contain" />
                <button
                  type="button"
                  aria-label={`${t.studio.multiTipClear} ${idx + 1}`}
                  onClick={() => {
                    const nextUrls = tipUrls.filter((_, i) => i !== idx);
                    onChange({ tipUrls: nextUrls, ...(nextUrls.length <= 1 ? { tipPlayMode: 'single' } : {}) });
                  }}
                  className="absolute right-0 top-0 rounded-bl bg-neutral-900/80 p-0.5 text-neutral-300 hover:text-white"
                >
                  <X className="h-2 w-2" />
                </button>
              </div>
            ))}
          </div>
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
