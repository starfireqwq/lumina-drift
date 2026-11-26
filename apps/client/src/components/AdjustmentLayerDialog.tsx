import React, { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import {
  buildCurveLUT, createDefaultAdjustment, GRADIENT_PRESETS, normalizeAdjustment,
  type AdjustmentCurvePoint, type GradientMapStop, type GradientPresetName, type LayerAdjustment, type LayerModel,
} from '@atelier/shared';
import { useI18n } from '../context/I18nContext';
import { editCurvePoint, editGradientStop } from './workspace/adjustmentEditing';
import { ToolWindow } from './workspace/ToolWindow';

interface Props {
  layer: LayerModel;
  open: boolean;
  readOnly?: boolean;
  embedded?: boolean;
  onPreview(adj: LayerAdjustment | null): void;
  onCommit(adj: LayerAdjustment): void;
  onCancel(): void;
  getHistogram?: () => Promise<Uint32Array | null>;
}

const channels = ['master', 'red', 'green', 'blue'] as const;
type Channel = typeof channels[number];
const tones = ['shadows', 'midtones', 'highlights'] as const;
type Tone = typeof tones[number];
const actionClass = 'atelier-btn atelier-btn--ghost disabled:opacity-40';
const inputClass = 'min-w-0 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100';

export function AdjustmentLayerDialog({ layer, open, readOnly = false, embedded, onPreview, onCommit, onCancel, getHistogram }: Props) {
  const { t } = useI18n();
  const labels = t.studio.adjustment;
  const [draft, setDraft] = useState(() => normalizeAdjustment(layer.meta?.adjustment) ?? createDefaultAdjustment('hsl'));
  const draftRef = useRef(draft);
  const callbacks = useRef({ onPreview, onCommit, onCancel, getHistogram });
  callbacks.current = { onPreview, onCommit, onCancel, getHistogram };
  const [channel, setChannel] = useState<Channel>('master');
  const [tone, setTone] = useState<Tone>('midtones');
  const [histogram, setHistogram] = useState<Uint32Array | null>(null);
  const frame = useRef<number | null>(null);
  const kind = draft.kind;

  const update = (next: LayerAdjustment) => {
    if (!open || readOnly) return;
    const normalized = normalizeAdjustment(next)!;
    draftRef.current = normalized;
    setDraft(normalized);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      callbacks.current.onPreview(draftRef.current);
    });
  };

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, [open, readOnly]);

  useEffect(() => {
    if (!open || kind !== 'levels' || !callbacks.current.getHistogram) return;
    let active = true;
    void callbacks.current.getHistogram().then((bins) => {
      if (active) setHistogram(bins);
    }).catch(() => {});
    return () => { active = false; };
  }, [open, kind, layer.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || (event.key !== 'Escape' && event.key !== 'Enter')) return;
      const target = event.target instanceof Element ? event.target : null;
      const blockers = document.querySelectorAll('[aria-modal="true"], [role="menu"]');
      if (Array.from(blockers).some((el) => !el.closest('[data-phase="closing"], [data-overlay-phase="closing"], .pointer-events-none'))) return;
      if (event.key === 'Enter' && (readOnly || target?.closest(
        'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type="range"]):not([type="checkbox"]):not([type="color"])',
      ))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') callbacks.current.onCancel();
      else callbacks.current.onCommit(draftRef.current);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, readOnly]);

  const slider = (path: keyof typeof labels, value: number, min: number, max: number, onChange: (value: number) => void, step = 1) => (
    <NumericParam key={path} path={path} label={labels[path]} {...{ value, min, max, onChange, step }} />
  );
  const toggle = (path: keyof typeof labels, checked: boolean, onChange: (checked: boolean) => void) => (
    <label className="flex items-center gap-2 text-neutral-200">
      <input type="checkbox" data-testid={`adjustment-param-${path}`} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {labels[path]}
    </label>
  );
  const channelLabels = { master: t.studio.channelRgb, red: t.studio.channelRed, green: t.studio.channelGreen, blue: t.studio.channelBlue };
  let controls: React.ReactNode;

  switch (kind) {
    case 'hsl': {
      const { params } = draft;
      const set = (patch: Partial<typeof params>) => update({ kind, params: { ...params, ...patch } });
      controls = <>
        {slider('hue', params.hue, params.colorize ? 0 : -180, params.colorize ? 360 : 180, (hue) => set({ hue }))}
        {slider('saturation', params.saturation, params.colorize ? 0 : -100, 100, (saturation) => set({ saturation }))}
        {slider('lightness', params.lightness, -100, 100, (lightness) => set({ lightness }))}
        {toggle('colorize', params.colorize, (colorize) => set({ colorize, hue: colorize ? 30 : 0, saturation: colorize ? 25 : 0, lightness: 0 }))}
      </>;
      break;
    }
    case 'levels': {
      const { params } = draft;
      const values = params[channel];
      const set = (key: keyof typeof values, value: number) =>
        update({ kind, params: { ...params, [channel]: { ...values, [key]: value } } });
      controls = <>
        <label className="flex items-center justify-between gap-2">
          {labels.channel}
          <select className={inputClass} data-testid="adjustment-channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {channels.map((id) => <option key={id} value={id}>{channelLabels[id]}</option>)}
          </select>
        </label>
        {histogram && <ToneHistogram bins={histogram} label={labels.histogram} />}
        {slider('inBlack', values.inBlack, 0, values.inWhite - 2, (v) => set('inBlack', v))}
        {slider('gamma', values.gamma, 0.1, 9.99, (v) => set('gamma', v), 0.01)}
        {slider('inWhite', values.inWhite, values.inBlack + 2, 255, (v) => set('inWhite', v))}
        {slider('outBlack', values.outBlack, 0, 255, (v) => set('outBlack', v))}
        {slider('outWhite', values.outWhite, 0, 255, (v) => set('outWhite', v))}
      </>;
      break;
    }
    case 'curves': {
      const { params } = draft;
      controls = <>
        <div role="group" aria-label={labels.channel} data-testid="adjustment-channel" className="flex flex-wrap gap-1">
          {channels.map((id) => (
            <button key={id} type="button" value={id} aria-pressed={channel === id}
              className={channel === id ? 'atelier-btn atelier-btn--primary' : actionClass} onClick={() => setChannel(id)}>
              {channelLabels[id]}
            </button>
          ))}
        </div>
        <CurveEditor key={channel} points={params[channel]} readOnly={readOnly}
          onChange={(points) => update({ kind, params: { ...params, [channel]: points } })} />
      </>;
      break;
    }
    case 'color_balance': {
      const { params } = draft;
      const values = params[tone];
      const set = (key: keyof typeof values, value: number) =>
        update({ kind, params: { ...params, [tone]: { ...values, [key]: value } } });
      controls = <>
        <label className="flex items-center justify-between gap-2">
          {labels.tone}
          <select className={inputClass} data-testid="adjustment-tone" value={tone} onChange={(e) => setTone(e.target.value as Tone)}>
            {tones.map((id) => <option key={id} value={id}>{labels[id]}</option>)}
          </select>
        </label>
        {slider('cyanRed', values.cyanRed, -100, 100, (v) => set('cyanRed', v))}
        {slider('magentaGreen', values.magentaGreen, -100, 100, (v) => set('magentaGreen', v))}
        {slider('yellowBlue', values.yellowBlue, -100, 100, (v) => set('yellowBlue', v))}
        {toggle('preserveLuminosity', params.preserveLuminosity, (preserveLuminosity) => update({ kind, params: { ...params, preserveLuminosity } }))}
      </>;
      break;
    }
    case 'gradient_map': {
      const { params } = draft;
      controls = <>
        <GradientEditor {...params} readOnly={readOnly}
          onChange={(stops) => update({ kind, params: { ...params, stops } })} />
        {toggle('reverse', params.reverse, (reverse) => update({ kind, params: { ...params, reverse } }))}
      </>;
      break;
    }
    case 'brightness_contrast': {
      const { params } = draft;
      controls = <>
        {slider('brightness', params.brightness, -150, 150, (brightness) => update({ kind, params: { ...params, brightness } }))}
        {slider('contrast', params.contrast, -50, 100, (contrast) => update({ kind, params: { ...params, contrast } }))}
      </>;
      break;
    }
  }

  return (
    <ToolWindow id="adjustment-layer" icon={<SlidersHorizontal />} dockPanel="filters" embedded={embedded}
      title={<>{t.layers.adjustment.kinds[kind]} <span className="ml-1.5 font-normal text-neutral-400">{layer.name}</span></>}
      initial={{ x: -120, y: 96, w: 376, h: 0 }} minW={270} minH={210} fitViewport
      closeOnEsc={false} onClose={onCancel} dataAttributes={{ 'data-testid': 'adjustment-dialog', 'data-adjustment-kind': kind }}
      footer={<>
        <button type="button" data-testid="adjustment-reset" className={`mr-auto ${actionClass}`} disabled={readOnly}
          onClick={() => update(createDefaultAdjustment(kind))}>{t.common.reset}</button>
        <button type="button" data-testid="adjustment-cancel" className={actionClass} onClick={onCancel}>{t.common.cancel}</button>
        <button type="button" data-testid="adjustment-ok" className="atelier-btn atelier-btn--primary disabled:opacity-40"
          disabled={readOnly} onClick={() => onCommit(draftRef.current)}>{t.common.confirm}</button>
      </>}
    >
      {readOnly && <p className="mb-3 text-neutral-300">{t.layers.adjustment.readOnly}</p>}
      <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-3 border-0 p-0 disabled:opacity-60">{controls}</fieldset>
    </ToolWindow>
  );
}

function NumericParam({ path, label, value, min, max, step, onChange }: {
  path: string; label: string; value: number; min: number; max: number; step: number; onChange(value: number): void;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-x-3 gap-y-1">
      <span className="col-span-2 text-neutral-200">{label}</span>
      <input aria-label={label} type="range" className="w-full min-w-0 accent-indigo-400"
        {...{ min, max, step, value }} onChange={(e) => { setTyping(null); onChange(e.currentTarget.valueAsNumber); }} />
      <input aria-label={label} className={`w-full tabular-nums ${inputClass}`} type="number" data-testid={`adjustment-param-${path}`}
        {...{ min, max, step }} value={typing ?? value} onBlur={() => setTyping(null)} onChange={(e) => {
          const { value: text, valueAsNumber: number } = e.currentTarget;
          setTyping(document.activeElement === e.currentTarget ? text : null);
          if (Number.isFinite(number)) onChange(Math.max(min, Math.min(max, number)));
        }} />
    </div>
  );
}

function ToneHistogram({ bins, label }: { bins: Uint32Array; label: string }) {
  const peak = Math.max(1, ...bins);
  const bars = Array.from(bins, (count, i) => count ? `M${i + 0.5} 48v-${Math.max(1, count * 48 / peak)}` : '').join('');
  return <svg role="img" aria-label={label} viewBox="0 0 256 48" preserveAspectRatio="none"
    className="h-14 w-full rounded bg-neutral-950 text-indigo-300/70">
    <path d={bars} stroke="currentColor" />
  </svg>;
}

function CurveEditor({ points, readOnly, onChange }: {
  points: AdjustmentCurvePoint[]; readOnly: boolean; onChange(points: AdjustmentCurvePoint[]): void;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const drag = useRef<{ index: number; pointerId: number } | null>(null);
  const lut = buildCurveLUT(points.map(({ x, y }) => ({ x: x / 255, y: y / 255 })));
  const line = Array.from(lut, (y, x) => `${x},${255 - y}`).join(' ');
  const index = Math.min(active, points.length - 1);
  const selected = points[index];

  const position = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.round((e.clientX - rect.left) * 271 / rect.width - 8), y: Math.round(263 - (e.clientY - rect.top) * 271 / rect.height) };
  };
  const hit = (point: AdjustmentCurvePoint) => points.findIndex((p) => Math.hypot(p.x - point.x, p.y - point.y) <= 9);
  const remove = (i: number) => {
    onChange(editCurvePoint(points, i, null));
    setActive(Math.max(0, i - 1));
  };

  return <>
    <svg role="img" aria-label={t.studio.colorCurvesTitle} viewBox="-8 -8 271 271"
      className="mx-auto aspect-square w-full max-w-[250px] touch-none rounded border border-neutral-700 bg-neutral-950"
      onPointerDown={(e) => {
        if (readOnly || e.button !== 0 || drag.current) return;
        const point = position(e);
        let i = hit(point);
        if (i === -1) {
          const next = editCurvePoint(points, -1, point);
          if (next === points) return;
          i = next.findIndex((p) => p.x === Math.max(0, Math.min(255, point.x)));
          onChange(next);
        }
        setActive(i);
        drag.current = { index: i, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!readOnly && drag.current?.pointerId === e.pointerId) onChange(editCurvePoint(points, drag.current.index, position(e)));
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        const point = position(e);
        if (point.x < -16 || point.x > 271 || point.y < -16 || point.y > 271) remove(drag.current.index);
        drag.current = null;
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={(e) => { if (!readOnly) remove(hit(position(e))); }}>
      <path d="M0 255H255V0H0Z M0 255L255 0 M64 0V255 M128 0V255 M192 0V255 M0 64H255 M0 128H255 M0 192H255"
        fill="none" className="stroke-neutral-700" />
      <polyline points={line} fill="none" strokeWidth="2" className="stroke-indigo-300" />
      {points.map(({ x, y }, i) => (
        <circle key={x} cx={x} cy={255 - y} r={5} className={i === index ? 'fill-indigo-300' : 'fill-neutral-100'} />
      ))}
    </svg>
    <div className="flex flex-wrap gap-1">
      <button type="button" data-testid="adjustment-curve-preset-invert" className={actionClass}
        onClick={() => { setActive(0); onChange([{ x: 0, y: 255 }, { x: 255, y: 0 }]); }}>{t.studio.adjustment.invert}</button>
      <button type="button" data-testid="adjustment-curve-reset" className={actionClass}
        onClick={() => { setActive(0); onChange([{ x: 0, y: 0 }, { x: 255, y: 255 }]); }}>{t.common.reset}</button>
      <button type="button" className={actionClass} disabled={index === 0 || index === points.length - 1}
        onClick={() => remove(index)}>{t.studio.adjustment.removePoint}</button>
    </div>
    <NumericParam key={`curve-x-${index}`} path="curve-x" label={t.studio.inputCoord} value={selected.x}
      min={index > 0 && index < points.length - 1 ? points[index - 1].x + 1 : selected.x}
      max={index > 0 && index < points.length - 1 ? points[index + 1].x - 1 : selected.x}
      step={1} onChange={(x) => onChange(editCurvePoint(points, index, { x, y: selected.y }))} />
    <NumericParam key={`curve-y-${index}`} path="curve-y" label={t.studio.outputCoord} value={selected.y} min={0} max={255}
      step={1} onChange={(y) => onChange(editCurvePoint(points, index, { x: selected.x, y }))} />
  </>;
}

function GradientEditor({ stops, reverse, readOnly, onChange }: {
  stops: GradientMapStop[]; reverse: boolean; readOnly: boolean; onChange(stops: GradientMapStop[]): void;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const drag = useRef<{ index: number; pointerId: number } | null>(null);
  const index = Math.min(active, stops.length - 1);
  const selected = stops[index];
  const presets: Record<GradientPresetName, string> = { sunset: t.studio.presetSunset, cyberpunk: t.studio.presetCyberpunk, ink: t.studio.presetInk };
  const bar = `linear-gradient(to ${reverse ? 'left' : 'right'}, ${stops.map(({ offset, color }) => `${color} ${offset * 100}%`).join(', ')})`;
  const position = (e: React.PointerEvent<HTMLDivElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    const offset = (e.clientX - bounds.left) / bounds.width;
    return reverse ? 1 - offset : offset;
  };
  const add = (offset: number) => {
    const next = editGradientStop(stops, -1, offset);
    if (next === stops) return null;
    const i = next.findIndex((stop) => !stops.includes(stop));
    setActive(i);
    onChange(next);
    return i;
  };
  const addInLargestGap = () => {
    let length = 0;
    let offset = 0.5;
    const boundaries = [0, ...stops.map((stop) => stop.offset), 1];
    for (let i = 1; i < boundaries.length; i++) {
      const gap = boundaries[i] - boundaries[i - 1];
      if (gap <= length) continue;
      length = gap;
      offset = boundaries[i - 1] + gap / 2;
    }
    add(offset);
  };

  return <>
    <div className="flex flex-wrap gap-1">
      {(Object.keys(presets) as GradientPresetName[]).map((id) => (
        <button key={id} type="button" className={actionClass}
          onClick={() => { setActive(0); onChange(GRADIENT_PRESETS[id]); }}>{presets[id]}</button>
      ))}
    </div>
    <div className="mx-2 h-10 touch-none"
      onPointerDown={(e) => {
        if (readOnly || e.button !== 0 || drag.current) return;
        const handle = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-stop-index]') : null;
        const i = handle ? Number(handle.dataset.stopIndex) : add(position(e));
        if (i === null) return;
        setActive(i);
        drag.current = { index: i, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!readOnly && drag.current?.pointerId === e.pointerId) onChange(editGradientStop(stops, drag.current.index, position(e)));
      }}
      onLostPointerCapture={() => { drag.current = null; }}>
      <div className="relative h-6 rounded border border-neutral-600" style={{ background: bar }}>
        {stops.map((stop, i) => (
          <button key={i} type="button" data-stop-index={i} onClick={() => setActive(i)} aria-pressed={i === index}
            aria-label={`${t.studio.adjustment.stopPosition} ${stop.offset}`}
            className={`absolute top-full h-4 w-4 -translate-x-1/2 rounded-sm border-2 ${i === index ? 'border-indigo-300' : 'border-neutral-500'}`}
            style={{ left: `${(reverse ? 1 - stop.offset : stop.offset) * 100}%`, backgroundColor: stop.color }} />
        ))}
      </div>
    </div>
    <NumericParam key={index} path="stopPosition" label={t.studio.adjustment.stopPosition} value={selected.offset} min={0} max={1} step={0.001}
      onChange={(offset) => onChange(editGradientStop(stops, index, offset))} />
    <label className="flex items-center gap-2">
      {t.studio.adjustment.stopColor}
      <input type="color" value={selected.color} data-testid="adjustment-param-stopColor"
        onChange={(e) => onChange(stops.map((stop, i) => i === index ? { ...stop, color: e.target.value } : stop))} />
    </label>
    <div className="flex flex-wrap gap-1">
      <button type="button" className={actionClass} disabled={stops.length >= 16} onClick={addInLargestGap}>{t.studio.addStop}</button>
      <button type="button" className={actionClass} disabled={stops.length <= 2}
        onClick={() => { setActive(Math.max(0, index - 1)); onChange(editGradientStop(stops, index, null)); }}>
        {t.studio.adjustment.removeStop}
      </button>
    </div>
  </>;
}
