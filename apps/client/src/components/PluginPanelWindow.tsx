import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Brush,
  Layers,
  Lock,
  Palette,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
  Square,
  Wand2,
  Zap,
} from 'lucide-react';
import type { CanvasMemberModel, LayerModel, UserPayload } from '@atelier/shared';
import { canPluginEditLayerPixels } from '../plugins/pluginCanvasBridge';
import {
  resolvePluginName,
  resolvePluginText,
  type PluginFieldCondition,
  type PluginManifestModern,
  type PluginPanelAction,
  type PluginPanelDeclaration,
  type PluginPanelField,
} from '../plugins/pluginApi';
import { getPluginLabels } from '../plugins/pluginLabels';
import type { PluginV2Result } from '../plugins/pluginRpc';
import { ToolWindow } from './workspace/ToolWindow';
import { usePhoneLayout } from './workspace/dockStore';
import { useI18n } from '../context/I18nContext';

export type PluginPanelValues = Record<string, string | number | boolean>;

export function isPluginPanelFieldVisible(
  field: { when?: PluginFieldCondition },
  values: PluginPanelValues,
): boolean {
  if (!field.when) return true;
  const current = values[field.when.key];
  return typeof current === 'string' || typeof current === 'boolean'
    ? field.when.is.includes(current)
    : false;
}

export function buildInitialPanelValues(
  panel: PluginPanelDeclaration,
  layers: readonly LayerModel[],
  activeLayerId: string | null,
): PluginPanelValues {
  const values: PluginPanelValues = {};
  for (const field of panel.fields) {
    switch (field.kind) {
      case 'range':
      case 'number':
        values[field.key] = field.initial;
        break;
      case 'toggle':
        values[field.key] = field.initial;
        break;
      case 'select':
        values[field.key] = field.initial;
        break;
      case 'color':
        values[field.key] = field.initial;
        break;
      case 'input':
        values[field.key] = field.initial ?? '';
        break;
      case 'layer': {
        const selectable = layers.filter((l) => field.allowGroup || l.layerType !== 'group');
        const preferred = activeLayerId && selectable.some((l) => l.id === activeLayerId)
          ? activeLayerId
          : (selectable[0]?.id ?? '');
        values[field.key] = preferred;
        break;
      }
      case 'section':
      case 'text':
        break;
    }
  }
  return values;
}

export function applyPanelPatchValues(
  panel: PluginPanelDeclaration,
  current: PluginPanelValues,
  patch: Record<string, string | number | boolean>,
): PluginPanelValues {
  const fieldByKey = new Map(panel.fields.map((f) => [f.key, f]));
  const next: PluginPanelValues = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const field = fieldByKey.get(key);
    if (!field) continue;
    switch (field.kind) {
      case 'range':
        if (typeof value === 'number' && Number.isFinite(value)) {
          next[key] = Math.min(field.max, Math.max(field.min, value));
        }
        break;
      case 'number':
        if (typeof value === 'number' && Number.isFinite(value)) {
          let clamped = value;
          if (field.min !== undefined) clamped = Math.max(field.min, clamped);
          if (field.max !== undefined) clamped = Math.min(field.max, clamped);
          next[key] = clamped;
        }
        break;
      case 'toggle':
        if (typeof value === 'boolean') next[key] = value;
        break;
      case 'select':
        if (typeof value === 'string' && field.options.some((o) => o.value === value)) {
          next[key] = value;
        }
        break;
      case 'color':
        if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
          next[key] = value.toLowerCase();
        }
        break;
      case 'layer':
        if (typeof value === 'string') next[key] = value;
        break;
      case 'input':
        if (typeof value === 'string') {
          const cap = Math.min(200, field.maxLength ?? 200);
          next[key] = value.slice(0, cap);
        }
        break;
      case 'text':
        if (typeof value === 'string') next[key] = value.slice(0, 200);
        break;
      case 'section':
        break;
    }
  }
  return next;
}

function renderPanelIcon(iconName?: string) {
  switch (iconName?.toLowerCase()) {
    case 'sparkles': return <Sparkles />;
    case 'sliders': return <SlidersHorizontal />;
    case 'wand': return <Wand2 />;
    case 'layers': return <Layers />;
    case 'palette': return <Palette />;
    case 'brush': return <Brush />;
    case 'zap': return <Zap />;
    default: return <Puzzle />;
  }
}

interface PluginPanelWindowProps {
  plugin: PluginManifestModern;
  panel: PluginPanelDeclaration;
  layers: LayerModel[];
  activeLayerId: string | null;
  user: UserPayload | null;
  isGuest: boolean;
  canvasMember: CanvasMemberModel | null;
  onExecute: (
    actionId: string,
    values: PluginPanelValues,
    options: { onSlowStart?: () => void; signal?: AbortSignal },
  ) => Promise<PluginV2Result>;
  onNotice?: (message: string) => void;
  onClose: () => void;
  /** Offset index when multiple plugin panels are open simultaneously */
  stackIndex?: number;
}

const LIVE_DEBOUNCE_MS = 200;
const SLOW_BAR_DELAY_MS = 300;

export const PluginPanelWindow: React.FC<PluginPanelWindowProps> = ({
  plugin,
  panel,
  layers,
  activeLayerId,
  user,
  isGuest,
  canvasMember,
  onExecute,
  onNotice,
  onClose,
  stackIndex = 0,
}) => {
  const { language } = useI18n();
  const phone = usePhoneLayout();
  const strings = getPluginLabels(language);

  const [values, setValues] = useState<PluginPanelValues>(() =>
    buildInitialPanelValues(panel, layers, activeLayerId),
  );
  const [busy, setBusy] = useState(false);
  const [slowRunning, setSlowRunning] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');

  const valuesRef = useRef(values);
  valuesRef.current = values;
  const abortRef = useRef<AbortController | null>(null);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Keep 'layer' fields synchronized when canvas layers change
  useEffect(() => {
    setValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const field of panel.fields) {
        if (field.kind !== 'layer') continue;
        const selectable = layers.filter((l) => field.allowGroup || l.layerType !== 'group');
        const currentId = typeof prev[field.key] === 'string' ? (prev[field.key] as string) : '';
        if (!currentId || !selectable.some((l) => l.id === currentId)) {
          const fallback = activeLayerId && selectable.some((l) => l.id === activeLayerId)
            ? activeLayerId
            : (selectable[0]?.id ?? '');
          if (fallback !== currentId) {
            next[field.key] = fallback;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [layers, activeLayerId, panel.fields]);

  const layerEditability = useMemo(() => {
    const map = new Map<string, boolean>();
    const acl = { user, isGuest, canvasMember };
    for (const layer of layers) {
      if (isGuest || !user) {
        map.set(layer.id, false);
        continue;
      }
      if (layer.layerType === 'group') {
        map.set(layer.id, !layer.isLocked && (layer.ownerId === user.id || user.serverRole === 'admin'));
        continue;
      }
      map.set(layer.id, canPluginEditLayerPixels(layer, layers, acl).allowed);
    }
    return map;
  }, [layers, user, isGuest, canvasMember]);

  const triggerAction = async (actionId: string, overrideValues?: PluginPanelValues) => {
    if (liveTimerRef.current) {
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    setBusy(true);
    setSlowRunning(false);
    setErrorText('');

    slowTimerRef.current = setTimeout(() => {
      if (mountedRef.current && abortRef.current === controller) {
        setSlowRunning(true);
      }
    }, SLOW_BAR_DELAY_MS);

    try {
      const payload = overrideValues ?? valuesRef.current;
      const result = await onExecute(actionId, payload, {
        signal: controller.signal,
        onSlowStart: () => {
          if (mountedRef.current && abortRef.current === controller) {
            setSlowRunning(true);
          }
        },
      });
      if (!mountedRef.current || abortRef.current !== controller) return;
      if (result.patchValues) {
        setValues((prev) => applyPanelPatchValues(panel, prev, result.patchValues!));
      }
      if (result.statusText !== undefined) {
        setStatusText(result.statusText);
      }
      if (result.notice) {
        onNotice?.(result.notice);
      }
    } catch (error) {
      if (!mountedRef.current || abortRef.current !== controller) return;
      if (controller.signal.aborted) {
        setStatusText(strings.aborted);
      } else {
        setErrorText(error instanceof Error ? error.message : strings.failed);
      }
    } finally {
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
      if (mountedRef.current && abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
        setSlowRunning(false);
      }
    }
  };

  const handleAbort = () => {
    abortRef.current?.abort();
  };

  const updateField = (field: PluginPanelField, nextValue: string | number | boolean) => {
    const nextValues = { ...valuesRef.current, [field.key]: nextValue };
    setValues(nextValues);
    if ('live' in field && field.live) {
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = setTimeout(() => {
        liveTimerRef.current = null;
        void triggerAction('change', nextValues);
      }, LIVE_DEBOUNCE_MS);
    }
  };

  const pluginTitle = resolvePluginName(plugin, language);
  const panelTitle = resolvePluginText(panel.title, panel.i18nTitle, language);
  const winId = `plugin_panel_${plugin.id}_${panel.id}`;
  const initialW = Math.min(440, Math.max(240, panel.defaultWidth ?? 288));

  const actionButtonClass = (variant: PluginPanelAction['variant']) => {
    const size = phone ? '!h-9 !px-3.5 text-xs' : '!h-7 !px-3 text-xs';
    if (variant === 'primary') return `atelier-btn atelier-btn--primary ${size}`;
    if (variant === 'danger') {
      return `atelier-btn ${size} border-rose-500/50 bg-rose-600/25 text-rose-200 hover:bg-rose-600/40`;
    }
    return `atelier-btn ${size}`;
  };

  const footer = (panel.actions.length > 0 || slowRunning) ? (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        {slowRunning && (
          <button
            type="button"
            onClick={handleAbort}
            data-plugin-panel-abort="true"
            className={`atelier-btn border-rose-500/50 bg-rose-600/20 text-rose-200 hover:bg-rose-600/35 ${phone ? '!h-9 !px-3 text-xs' : '!h-7 !px-2.5 text-[11px]'}`}
          >
            <Square className="h-3 w-3 fill-current" aria-hidden />
            {strings.abort}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {panel.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={busy}
            data-plugin-panel-action={action.id}
            onClick={() => void triggerAction(action.id)}
            className={actionButtonClass(action.variant)}
          >
            {resolvePluginText(action.label, action.i18nLabel, language)}
          </button>
        ))}
      </div>
    </div>
  ) : undefined;

  return (
    <ToolWindow
      id={winId}
      title={
        <span className="atelier-plugin-sweep inline-flex max-w-full items-center gap-1.5 pr-1">
          <span className="truncate">{panelTitle}</span>
          <span className="hidden sm:inline truncate font-normal text-neutral-500">{pluginTitle}</span>
        </span>
      }
      icon={renderPanelIcon(panel.icon)}
      onClose={onClose}
      initial={{ x: -24 - stackIndex * 24, y: 68 + stackIndex * 24, w: initialW, h: 0 }}
      minW={240}
      minH={160}
      footer={footer}
    >
      {/* Light sweep running bar when execution exceeds 300ms */}
      <div className="atelier-filter-refine" data-on={slowRunning ? 'true' : 'false'} aria-hidden />
      <div className="space-y-2.5" data-plugin-panel={`${plugin.id}:${panel.id}`}>
        {panel.fields
          .filter((field) => isPluginPanelFieldVisible(field, values))
          .map((field) => (
            <PanelFieldControl
              key={field.key}
              field={field}
              value={values[field.key]}
              layers={layers}
              layerEditability={layerEditability}
              busy={busy}
              phone={phone}
              language={language}
              onChange={(val) => updateField(field, val)}
            />
          ))}

        {statusText && (
          <p
            data-plugin-panel-status="true"
            className="rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-1.5 text-[11px] text-neutral-300 break-words"
          >
            {statusText}
          </p>
        )}
        {errorText && (
          <p
            role="alert"
            className="rounded-md border border-rose-500/40 bg-rose-950/30 px-2.5 py-1.5 text-[11px] text-rose-300 break-words"
          >
            {errorText}
          </p>
        )}
      </div>
    </ToolWindow>
  );
};

interface PanelFieldControlProps {
  field: PluginPanelField;
  value: string | number | boolean | undefined;
  layers: readonly LayerModel[];
  layerEditability: ReadonlyMap<string, boolean>;
  busy: boolean;
  phone: boolean;
  language: ReturnType<typeof useI18n>['language'];
  onChange: (value: string | number | boolean) => void;
}

const PanelFieldControl: React.FC<PanelFieldControlProps> = ({
  field,
  value,
  layers,
  layerEditability,
  busy,
  phone,
  language,
  onChange,
}) => {
  const inputId = useId();
  const fieldHeight = phone ? 'h-9 text-xs' : 'h-7 text-xs';

  switch (field.kind) {
    case 'section':
      return (
        <div className="border-b border-neutral-800/80 pb-1 pt-1 text-[11px] font-semibold tracking-wide text-indigo-300">
          {resolvePluginText(field.label, field.i18nLabel, language)}
        </div>
      );

    case 'text': {
      const display = typeof value === 'string'
        ? value
        : resolvePluginText(field.text, field.i18nText, language);
      return (
        <p className="text-[11px] leading-relaxed text-neutral-300 break-words" data-panel-field={field.key}>
          {display}
        </p>
      );
    }

    case 'range': {
      const label = resolvePluginText(field.label, field.i18nLabel, language);
      const numVal = typeof value === 'number' && Number.isFinite(value) ? value : field.initial;
      const step = field.step ?? 1;
      return (
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 text-[11px] text-neutral-300" data-panel-field={field.key}>
          <label htmlFor={inputId} className="truncate">{label}</label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              disabled={busy}
              aria-label={label}
              min={field.min}
              max={field.max}
              step={step}
              value={numVal}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (Number.isFinite(parsed)) {
                  onChange(Math.min(field.max, Math.max(field.min, parsed)));
                }
              }}
              className={`atelier-field ${phone ? 'h-8 w-20' : 'h-6 w-16'} px-1.5 text-right font-mono text-[11px] tabular-nums`}
            />
            {field.unit && <span className="text-[10px] text-neutral-400">{field.unit}</span>}
          </div>
          <input
            id={inputId}
            type="range"
            disabled={busy}
            min={field.min}
            max={field.max}
            step={step}
            value={numVal}
            onChange={(e) => onChange(Number(e.target.value))}
            className={`col-span-2 w-full cursor-pointer ${phone ? 'h-3' : 'h-1.5'}`}
          />
        </div>
      );
    }

    case 'number': {
      const label = resolvePluginText(field.label, field.i18nLabel, language);
      const numVal = typeof value === 'number' && Number.isFinite(value) ? value : field.initial;
      return (
        <label className="flex items-center justify-between gap-2 text-[11px] text-neutral-300" data-panel-field={field.key}>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <div className="flex shrink-0 items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              disabled={busy}
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              value={numVal}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (!Number.isFinite(parsed)) return;
                let clamped = parsed;
                if (field.min !== undefined) clamped = Math.max(field.min, clamped);
                if (field.max !== undefined) clamped = Math.min(field.max, clamped);
                onChange(clamped);
              }}
              className={`atelier-field ${fieldHeight} w-24 px-2 text-right font-mono tabular-nums`}
            />
            {field.unit && <span className="text-[10px] text-neutral-400">{field.unit}</span>}
          </div>
        </label>
      );
    }

    case 'toggle': {
      const label = resolvePluginText(field.label, field.i18nLabel, language);
      return (
        <label
          className={`flex cursor-pointer items-center gap-2 text-[11px] text-neutral-200 ${phone ? 'min-h-[36px]' : ''}`}
          data-panel-field={field.key}
        >
          <input
            type="checkbox"
            disabled={busy}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className={phone ? 'h-4 w-4' : 'h-3.5 w-3.5'}
          />
          <span className="min-w-0 flex-1 break-words">{label}</span>
        </label>
      );
    }

    case 'select': {
      const label = resolvePluginText(field.label, field.i18nLabel, language);
      return (
        <label className="flex items-center justify-between gap-2 text-[11px] text-neutral-300" data-panel-field={field.key}>
          <span className="shrink-0">{label}</span>
          <select
            disabled={busy}
            value={typeof value === 'string' ? value : field.initial}
            onChange={(e) => onChange(e.target.value)}
            className={`atelier-field ${fieldHeight} min-w-0 max-w-[64%] truncate px-2`}
          >
            {field.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {resolvePluginText(opt.label, opt.i18nLabel, language)}
              </option>
            ))}
          </select>
        </label>
      );
    }

    case 'color': {
      const label = resolvePluginText(field.label, field.i18nLabel, language);
      const colorVal = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : field.initial;
      return (
        <label className="flex items-center justify-between gap-2 text-[11px] text-neutral-300" data-panel-field={field.key}>
          <span className="truncate">{label}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase text-neutral-400">{colorVal}</span>
            <input
              type="color"
              disabled={busy}
              value={colorVal}
              onChange={(e) => onChange(e.target.value)}
              className={`${phone ? 'h-8 w-12' : 'h-6 w-10'} cursor-pointer rounded border border-neutral-700 bg-transparent`}
            />
          </div>
        </label>
      );
    }

    case 'layer': {
      const label = resolvePluginText(field.label, field.i18nLabel, language);
      const selectable = layers.filter((l) => field.allowGroup || l.layerType !== 'group');
      const selectedId = typeof value === 'string' ? value : '';
      const selectedReadonly = selectedId ? layerEditability.get(selectedId) === false : false;
      return (
        <label className="flex flex-col gap-1 text-[11px] text-neutral-300" data-panel-field={field.key}>
          <span className="flex items-center justify-between gap-1">
            <span className="truncate">{label}</span>
            {selectedReadonly && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-300">
                <Lock className="h-3 w-3" aria-hidden />
                RO
              </span>
            )}
          </span>
          <select
            disabled={busy || selectable.length === 0}
            value={selectedId}
            onChange={(e) => onChange(e.target.value)}
            className={`atelier-field ${fieldHeight} w-full truncate px-2`}
          >
            {selectable.map((layer) => {
              const editable = layerEditability.get(layer.id) !== false;
              return (
                <option key={layer.id} value={layer.id}>
                  {editable ? layer.name : `🔒 ${layer.name}`}
                </option>
              );
            })}
          </select>
        </label>
      );
    }

    case 'input': {
      const label = resolvePluginText(field.label, field.i18nLabel, language);
      const maxLen = Math.min(200, field.maxLength ?? 200);
      return (
        <label className="flex flex-col gap-1 text-[11px] text-neutral-300" data-panel-field={field.key}>
          <span className="truncate">{label}</span>
          <input
            type="text"
            disabled={busy}
            maxLength={maxLen}
            placeholder={field.placeholder}
            value={typeof value === 'string' ? value : (field.initial ?? '')}
            onChange={(e) => onChange(e.target.value.slice(0, maxLen))}
            className={`atelier-field ${fieldHeight} w-full px-2`}
          />
        </label>
      );
    }
  }
};
