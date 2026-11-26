import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, Sparkles } from 'lucide-react';
import {
  createDefaultLayerEffects,
  DEFAULT_LAYER_BORDER_EFFECT,
  DEFAULT_LAYER_COLOR_OVERLAY_EFFECT,
  DEFAULT_LAYER_DROP_SHADOW_EFFECT,
  DEFAULT_LAYER_OUTER_GLOW_EFFECT,
  hasActiveLayerEffects,
  normalizeHexColor,
  normalizeLayerEffectsMeta,
  type LayerBorderEffect,
  type LayerColorOverlayEffect,
  type LayerDropShadowEffect,
  type LayerEffectOverlayBlendMode,
  type LayerEffectsMeta,
  type LayerModel,
  type LayerOuterGlowEffect,
} from '@atelier/shared';
import type { Translations } from '../locales';
import { useAnchoredPopover } from '../utils/popoverPosition';

type EffectsLabels = Translations['layers']['effects'];

interface LayerEffectsPopoverProps {
  labels: EffectsLabels;
  layer: LayerModel | null;
  disabled?: boolean;
  onPreview?: (layerId: string, effects: LayerEffectsMeta | null) => void;
  onCommit: (layerId: string, effects: LayerEffectsMeta | null) => void;
  openSignal?: number;
}

function hydrateEffects(raw: LayerEffectsMeta | null | undefined): LayerEffectsMeta {
  const norm = normalizeLayerEffectsMeta(raw);
  const def = createDefaultLayerEffects();
  if (!norm) return { ...def, enabled: false };
  return {
    enabled: norm.enabled,
    border: { ...DEFAULT_LAYER_BORDER_EFFECT, ...(norm.border ?? {}) },
    dropShadow: { ...DEFAULT_LAYER_DROP_SHADOW_EFFECT, ...(norm.dropShadow ?? {}) },
    outerGlow: { ...DEFAULT_LAYER_OUTER_GLOW_EFFECT, ...(norm.outerGlow ?? {}) },
    colorOverlay: { ...DEFAULT_LAYER_COLOR_OVERLAY_EFFECT, ...(norm.colorOverlay ?? {}) },
  };
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  testId,
  onChange,
  onRelease,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  testId?: string;
  onChange: (next: number) => void;
  onRelease: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-neutral-300">
      <span className="w-16 shrink-0 truncate">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onRelease}
        onKeyUp={onRelease}
        className="h-1.5 min-w-0 flex-1 accent-indigo-500"
      />
      <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-400">
        {Math.round(value * 10) / 10}{suffix}
      </span>
    </label>
  );
}

export function LayerEffectsPopover({
  labels,
  layer,
  disabled,
  onPreview,
  onCommit,
  openSignal,
}: LayerEffectsPopoverProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const draftRef = useRef<LayerEffectsMeta>(hydrateEffects(layer?.meta?.effects));
  const [draft, setDraft] = useState<LayerEffectsMeta>(() => hydrateEffects(layer?.meta?.effects));
  const lastSignalRef = useRef<number | undefined>(openSignal);

  const unsupported = !layer || layer.layerType === 'mask' || layer.layerType === 'adjustment';
  const active = !unsupported && hasActiveLayerEffects(layer?.meta?.effects);

  const { top, left, maxHeight, setPopoverEl } = useAnchoredPopover(open, anchorRef, popoverRef, {
    gap: 4,
    margin: 8,
    fallbackWidth: 296,
    fallbackHeight: 420,
  });

  // Sync draft when target layer or external persisted effects change
  useEffect(() => {
    const next = hydrateEffects(layer?.meta?.effects);
    draftRef.current = next;
    setDraft(next);
  }, [layer?.id, layer?.meta?.effects]);

  useEffect(() => {
    if (openSignal !== undefined && openSignal !== lastSignalRef.current) {
      lastSignalRef.current = openSignal;
      if (!unsupported && !disabled) setOpen(true);
    }
  }, [openSignal, unsupported, disabled]);

  useEffect(() => {
    if (!open) return;
    popoverRef.current?.focus({ preventScroll: true });
    const dismissOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!popoverRef.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      anchorRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape, true);
    };
  }, [open]);

  // Clear preview on close or layer switch
  useEffect(() => {
    if (!open && layer) onPreview?.(layer.id, null);
  }, [open, layer?.id]);

  const applyDraft = (next: LayerEffectsMeta, commitNow: boolean) => {
    draftRef.current = next;
    setDraft(next);
    if (!layer) return;
    onPreview?.(layer.id, next);
    if (commitNow) {
      onCommit(layer.id, next);
      onPreview?.(layer.id, null);
    }
  };

  const commitCurrent = () => {
    if (!layer) return;
    onCommit(layer.id, draftRef.current);
    onPreview?.(layer.id, null);
  };

  const updateBorder = (patch: Partial<LayerBorderEffect>, commitNow = false) => {
    const cur = draftRef.current;
    const border: LayerBorderEffect = { ...DEFAULT_LAYER_BORDER_EFFECT, ...(cur.border ?? {}), ...patch };
    const next: LayerEffectsMeta = {
      ...cur,
      enabled: patch.enabled ? true : cur.enabled,
      border,
    };
    applyDraft(next, commitNow);
  };

  const updateShadow = (patch: Partial<LayerDropShadowEffect>, commitNow = false) => {
    const cur = draftRef.current;
    const dropShadow: LayerDropShadowEffect = { ...DEFAULT_LAYER_DROP_SHADOW_EFFECT, ...(cur.dropShadow ?? {}), ...patch };
    const next: LayerEffectsMeta = {
      ...cur,
      enabled: patch.enabled ? true : cur.enabled,
      dropShadow,
    };
    applyDraft(next, commitNow);
  };

  const updateGlow = (patch: Partial<LayerOuterGlowEffect>, commitNow = false) => {
    const cur = draftRef.current;
    const outerGlow: LayerOuterGlowEffect = { ...DEFAULT_LAYER_OUTER_GLOW_EFFECT, ...(cur.outerGlow ?? {}), ...patch };
    const next: LayerEffectsMeta = {
      ...cur,
      enabled: patch.enabled ? true : cur.enabled,
      outerGlow,
    };
    applyDraft(next, commitNow);
  };

  const updateOverlay = (patch: Partial<LayerColorOverlayEffect>, commitNow = false) => {
    const cur = draftRef.current;
    const colorOverlay: LayerColorOverlayEffect = { ...DEFAULT_LAYER_COLOR_OVERLAY_EFFECT, ...(cur.colorOverlay ?? {}), ...patch };
    const next: LayerEffectsMeta = {
      ...cur,
      enabled: patch.enabled ? true : cur.enabled,
      colorOverlay,
    };
    applyDraft(next, commitNow);
  };

  const handleReset = () => {
    if (!layer) return;
    const cleared = { ...createDefaultLayerEffects(), enabled: false };
    draftRef.current = cleared;
    setDraft(cleared);
    onPreview?.(layer.id, null);
    onCommit(layer.id, null);
  };

  const border = draft.border ?? DEFAULT_LAYER_BORDER_EFFECT;
  const shadow = draft.dropShadow ?? DEFAULT_LAYER_DROP_SHADOW_EFFECT;
  const glow = draft.outerGlow ?? DEFAULT_LAYER_OUTER_GLOW_EFFECT;
  const overlay = draft.colorOverlay ?? DEFAULT_LAYER_COLOR_OVERLAY_EFFECT;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={Boolean(disabled || unsupported)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-pressed={active}
        data-testid="layer-effects-trigger"
        onClick={() => setOpen((v) => !v)}
        title={labels.tooltip}
        aria-label={labels.title}
        className={`atelier-icon-btn h-6 shrink-0 gap-0.5 px-1.5 text-[10px] font-bold tracking-tight ${
          active
            ? 'border border-indigo-400/70 bg-indigo-600/30 text-indigo-100'
            : 'border border-neutral-700/70 text-neutral-300'
        }`}
      >
        <Sparkles className="h-3 w-3" />
        <span>fx</span>
      </button>

      {open && !unsupported && createPortal(
        <div
          ref={setPopoverEl}
          id={id}
          role="dialog"
          aria-label={labels.title}
          tabIndex={-1}
          data-testid="layer-effects-popover"
          style={{ top, left, maxHeight }}
          onKeyDown={(e) => e.stopPropagation()}
          className="atelier-popover atelier-menu-in fixed z-[95] w-[19rem] max-w-[calc(100vw-16px)] space-y-2.5 overflow-y-auto overscroll-contain p-3 text-xs"
        >
          {/* Header + Master Toggle + Reset */}
          <div className="flex items-center justify-between gap-2 border-b border-atelier-border pb-2">
            <div className="flex items-center gap-1.5 font-semibold text-neutral-100">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              <span>{labels.title}</span>
              {layer.layerType === 'group' && (
                <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium text-indigo-200">
                  {labels.folderScope}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <label className="flex cursor-pointer items-center gap-1 text-[11px] text-neutral-300">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  data-testid="layer-effects-master-toggle"
                  onChange={(e) => applyDraft({ ...draftRef.current, enabled: e.target.checked }, true)}
                />
                <span>{labels.enabled}</span>
              </label>
              <button
                type="button"
                onClick={handleReset}
                title={labels.reset}
                aria-label={labels.reset}
                data-testid="layer-effects-reset"
                className="rounded border border-atelier-border p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* 1. Border Effect (Edge / Watercolor) */}
          <section className="space-y-1.5 rounded-md border border-neutral-800 bg-neutral-900/50 p-2">
            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-1.5 font-medium text-neutral-100">
                <input
                  type="checkbox"
                  checked={border.enabled}
                  data-testid="layer-effect-border-toggle"
                  onChange={(e) => updateBorder({ enabled: e.target.checked }, true)}
                />
                <span>{labels.border}</span>
              </label>
              {border.enabled && (
                <div className="flex rounded border border-atelier-border bg-neutral-950/70 p-0.5">
                  <button
                    type="button"
                    data-testid="layer-effect-border-mode-edge"
                    aria-pressed={border.mode === 'edge'}
                    onClick={() => updateBorder({ mode: 'edge' }, true)}
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      border.mode === 'edge' ? 'bg-indigo-500/30 text-indigo-100' : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {labels.borderEdge}
                  </button>
                  <button
                    type="button"
                    data-testid="layer-effect-border-mode-watercolor"
                    aria-pressed={border.mode === 'watercolor'}
                    onClick={() => updateBorder({ mode: 'watercolor' }, true)}
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      border.mode === 'watercolor' ? 'bg-indigo-500/30 text-indigo-100' : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {labels.borderWatercolor}
                  </button>
                </div>
              )}
            </div>

            {border.enabled && (
              <div className="space-y-1.5 pt-1">
                <SliderRow
                  label={labels.width}
                  value={border.width}
                  min={1}
                  max={64}
                  suffix="px"
                  testId="layer-effect-border-width"
                  onChange={(width) => updateBorder({ width })}
                  onRelease={commitCurrent}
                />
                <SliderRow
                  label={labels.opacity}
                  value={Math.round(border.opacity * 100)}
                  min={0}
                  max={100}
                  suffix="%"
                  testId="layer-effect-border-opacity"
                  onChange={(pct) => updateBorder({ opacity: pct / 100 })}
                  onRelease={commitCurrent}
                />
                {border.mode === 'edge' ? (
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <label className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                      <input
                        type="color"
                        value={normalizeHexColor(border.color)?.toLowerCase() ?? '#111827'}
                        data-testid="layer-effect-border-color"
                        onChange={(e) => {
                          const c = normalizeHexColor(e.target.value);
                          if (c) updateBorder({ color: c }, true);
                        }}
                        className="h-6 w-8 cursor-pointer rounded border border-atelier-border bg-neutral-800 p-0.5"
                      />
                      <span>{labels.color}</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-1 text-[11px] text-neutral-300">
                      <input
                        type="checkbox"
                        checked={border.antiAlias !== false}
                        onChange={(e) => updateBorder({ antiAlias: e.target.checked }, true)}
                      />
                      <span>{labels.antiAlias}</span>
                    </label>
                  </div>
                ) : (
                  <>
                    <SliderRow
                      label={labels.watercolorDarkness}
                      value={Math.round((border.watercolorDarkness ?? 0.55) * 100)}
                      min={0}
                      max={100}
                      suffix="%"
                      testId="layer-effect-wc-darkness"
                      onChange={(pct) => updateBorder({ watercolorDarkness: pct / 100 })}
                      onRelease={commitCurrent}
                    />
                    <SliderRow
                      label={labels.watercolorBlur}
                      value={border.watercolorBlur ?? 3}
                      min={0}
                      max={32}
                      suffix="px"
                      testId="layer-effect-wc-blur"
                      onChange={(watercolorBlur) => updateBorder({ watercolorBlur })}
                      onRelease={commitCurrent}
                    />
                  </>
                )}
              </div>
            )}
          </section>

          {/* 2. Drop Shadow */}
          <section className="space-y-1.5 rounded-md border border-neutral-800 bg-neutral-900/50 p-2">
            <label className="flex cursor-pointer items-center gap-1.5 font-medium text-neutral-100">
              <input
                type="checkbox"
                checked={shadow.enabled}
                data-testid="layer-effect-shadow-toggle"
                onChange={(e) => updateShadow({ enabled: e.target.checked }, true)}
              />
              <span>{labels.dropShadow}</span>
            </label>
            {shadow.enabled && (
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                    <input
                      type="color"
                      value={normalizeHexColor(shadow.color)?.toLowerCase() ?? '#000000'}
                      data-testid="layer-effect-shadow-color"
                      onChange={(e) => {
                        const c = normalizeHexColor(e.target.value);
                        if (c) updateShadow({ color: c }, true);
                      }}
                      className="h-6 w-8 cursor-pointer rounded border border-atelier-border bg-neutral-800 p-0.5"
                    />
                    <span>{labels.color}</span>
                  </label>
                </div>
                <SliderRow
                  label={labels.opacity}
                  value={Math.round(shadow.opacity * 100)}
                  min={0}
                  max={100}
                  suffix="%"
                  testId="layer-effect-shadow-opacity"
                  onChange={(pct) => updateShadow({ opacity: pct / 100 })}
                  onRelease={commitCurrent}
                />
                <SliderRow
                  label={labels.offsetX}
                  value={shadow.offsetX}
                  min={-64}
                  max={64}
                  suffix="px"
                  testId="layer-effect-shadow-x"
                  onChange={(offsetX) => updateShadow({ offsetX })}
                  onRelease={commitCurrent}
                />
                <SliderRow
                  label={labels.offsetY}
                  value={shadow.offsetY}
                  min={-64}
                  max={64}
                  suffix="px"
                  testId="layer-effect-shadow-y"
                  onChange={(offsetY) => updateShadow({ offsetY })}
                  onRelease={commitCurrent}
                />
                <SliderRow
                  label={labels.blur}
                  value={shadow.blur}
                  min={0}
                  max={64}
                  suffix="px"
                  testId="layer-effect-shadow-blur"
                  onChange={(blur) => updateShadow({ blur })}
                  onRelease={commitCurrent}
                />
                <SliderRow
                  label={labels.spread}
                  value={shadow.spread ?? 0}
                  min={0}
                  max={32}
                  suffix="px"
                  onChange={(spread) => updateShadow({ spread })}
                  onRelease={commitCurrent}
                />
              </div>
            )}
          </section>

          {/* 3. Outer Glow */}
          <section className="space-y-1.5 rounded-md border border-neutral-800 bg-neutral-900/50 p-2">
            <label className="flex cursor-pointer items-center gap-1.5 font-medium text-neutral-100">
              <input
                type="checkbox"
                checked={glow.enabled}
                data-testid="layer-effect-glow-toggle"
                onChange={(e) => updateGlow({ enabled: e.target.checked }, true)}
              />
              <span>{labels.outerGlow}</span>
            </label>
            {glow.enabled && (
              <div className="space-y-1.5 pt-1">
                <label className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                  <input
                    type="color"
                    value={normalizeHexColor(glow.color)?.toLowerCase() ?? '#60a5fa'}
                    data-testid="layer-effect-glow-color"
                    onChange={(e) => {
                      const c = normalizeHexColor(e.target.value);
                      if (c) updateGlow({ color: c }, true);
                    }}
                    className="h-6 w-8 cursor-pointer rounded border border-atelier-border bg-neutral-800 p-0.5"
                  />
                  <span>{labels.color}</span>
                </label>
                <SliderRow
                  label={labels.opacity}
                  value={Math.round(glow.opacity * 100)}
                  min={0}
                  max={100}
                  suffix="%"
                  testId="layer-effect-glow-opacity"
                  onChange={(pct) => updateGlow({ opacity: pct / 100 })}
                  onRelease={commitCurrent}
                />
                <SliderRow
                  label={labels.radius}
                  value={glow.radius}
                  min={0}
                  max={64}
                  suffix="px"
                  testId="layer-effect-glow-radius"
                  onChange={(radius) => updateGlow({ radius })}
                  onRelease={commitCurrent}
                />
                <SliderRow
                  label={labels.spread}
                  value={glow.spread ?? 0}
                  min={0}
                  max={32}
                  suffix="px"
                  onChange={(spread) => updateGlow({ spread })}
                  onRelease={commitCurrent}
                />
              </div>
            )}
          </section>

          {/* 4. Color Overlay */}
          <section className="space-y-1.5 rounded-md border border-neutral-800 bg-neutral-900/50 p-2">
            <label className="flex cursor-pointer items-center gap-1.5 font-medium text-neutral-100">
              <input
                type="checkbox"
                checked={overlay.enabled}
                data-testid="layer-effect-overlay-toggle"
                onChange={(e) => updateOverlay({ enabled: e.target.checked }, true)}
              />
              <span>{labels.colorOverlay}</span>
            </label>
            {overlay.enabled && (
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                    <input
                      type="color"
                      value={normalizeHexColor(overlay.color)?.toLowerCase() ?? '#6366f1'}
                      data-testid="layer-effect-overlay-color"
                      onChange={(e) => {
                        const c = normalizeHexColor(e.target.value);
                        if (c) updateOverlay({ color: c }, true);
                      }}
                      className="h-6 w-8 cursor-pointer rounded border border-atelier-border bg-neutral-800 p-0.5"
                    />
                    <span>{labels.color}</span>
                  </label>
                  <select
                    value={overlay.blendMode ?? 'normal'}
                    data-testid="layer-effect-overlay-blend"
                    onChange={(e) => updateOverlay({ blendMode: e.target.value as LayerEffectOverlayBlendMode }, true)}
                    className="atelier-field h-6 px-1.5 text-[11px]"
                  >
                    <option value="normal">{labels.blendNormal}</option>
                    <option value="multiply">{labels.blendMultiply}</option>
                    <option value="screen">{labels.blendScreen}</option>
                    <option value="overlay">{labels.blendOverlay}</option>
                  </select>
                </div>
                <SliderRow
                  label={labels.opacity}
                  value={Math.round(overlay.opacity * 100)}
                  min={0}
                  max={100}
                  suffix="%"
                  testId="layer-effect-overlay-opacity"
                  onChange={(pct) => updateOverlay({ opacity: pct / 100 })}
                  onRelease={commitCurrent}
                />
              </div>
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
