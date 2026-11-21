import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Crosshair, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { FilterValues } from '@atelier/shared';
import {
  defaultFilterValues, filterFitsLayer, filterGroupLabel, filterGroupsInUse, filterLabel, filterParamLabel, filterPointParam, filtersInGroup,
  getFilter, loadFilterValues, paramShown, saveFilterValues, snapRange, type FilterDef, type FilterGroup, type FilterParam,
} from '../utils/filterRegistry';
import { filterPoint } from '../utils/filterPoint';
import { ToolWindow } from './workspace/ToolWindow';
import { usePhoneLayout } from './workspace/dockStore';
import { useI18n } from '../context/I18nContext';

interface Props {
  filterId: string | null;
  layerName: string;
  /** The active layer's type: line-art fixes stay off masks */
  layerType?: string;
  /** The layer's tone counts (levels), once the first preview has counted them */
  histogram?: Uint32Array | null;
  busy: boolean;
  onChoose: (id: string) => void;
  onBack: () => void;
  onPreview: (values: FilterValues | null) => void;
  onApply: (values: FilterValues) => Promise<boolean>;
  onClose: () => void;
}

/** The group the menu last showed (this browser only) */
const GROUP_KEY = 'atelier_filter_group';
const readGroup = (groups: FilterGroup[]) => {
  try {
    const saved = localStorage.getItem(GROUP_KEY);
    return groups.find((group) => group === saved) ?? groups[0];
  } catch {
    return groups[0];
  }
};

export function LayerFilterDialog({ filterId, layerName, layerType, histogram, busy, onChoose, onBack, onPreview, onApply, onClose }: Props) {
  const { t } = useI18n();
  const phone = usePhoneLayout();
  const definition = getFilter(filterId);
  const groups = useMemo(filterGroupsInUse, []);
  const [group, setGroup] = useState<FilterGroup>(() => readGroup(groups));
  const [values, setValues] = useState<FilterValues>(() => definition ? loadFilterValues(definition) : {});
  const [preview, setPreview] = useState(true);

  // The centre lives outside the settings (the canvas handle moves it too) and joins them for each run
  const pointParam = filterPointParam(definition);
  const point = useSyncExternalStore(filterPoint.subscribe, filterPoint.get, filterPoint.get);
  const px = point?.x;
  const py = point?.y;
  const jobValues = useMemo<FilterValues>(
    () => pointParam && px !== undefined && py !== undefined ? { ...values, [pointParam.key]: { x: px, y: py } } : values,
    [values, pointParam, px, py],
  );
  const pointShown = pointParam ? paramShown(pointParam, values) : false;
  const radius = definition?.pointRadius ? values[definition.pointRadius] : null;
  const hasPoint = point !== null;
  useEffect(() => {
    if (hasPoint) filterPoint.show(pointShown, typeof radius === 'number' ? radius : null);
  }, [hasPoint, pointShown, radius]);

  useEffect(() => {
    if (!definition || !preview || busy) return;
    const timer = setTimeout(() => onPreview(jobValues), 160);
    return () => clearTimeout(timer);
  }, [definition, preview, jobValues, onPreview, busy]);

  const pickGroup = (next: FilterGroup) => {
    setGroup(next);
    try { localStorage.setItem(GROUP_KEY, next); } catch { /* the first group shows next time */ }
  };

  const item = (def: FilterDef, index: number) => {
    const fits = filterFitsLayer(def, layerType);
    return (
      <button type="button" key={def.id} disabled={!fits} onClick={() => onChoose(def.id)}
        title={!fits ? t.filters.lineartNotOnMask : def.tool ? t.filters.opensTool : undefined}
        className="atelier-btn atelier-filter-item !h-8 justify-start text-xs disabled:opacity-45" style={{ '--i': index } as CSSProperties}>
        <span className="min-w-0 flex-1 truncate text-left">{filterLabel(def, t)}</span>
        {def.tool && <><ArrowUpRight aria-hidden className="!h-3.5 !w-3.5 shrink-0 text-neutral-500" /><span className="sr-only">{t.filters.opensTool}</span></>}
      </button>
    );
  };

  const menu = phone ? (
    <div role="group" aria-label={t.filters.groupsAria} className="flex flex-col gap-1">
      {groups.map((g) => {
        const open = g === group;
        return (
          <div key={g}>
            <button type="button" aria-expanded={open} onClick={() => pickGroup(g)}
              className={`atelier-filter-group flex h-10 w-full items-center justify-between rounded-lg px-3 text-sm ${open ? 'bg-neutral-800 text-white' : 'text-neutral-300'}`}>
              {filterGroupLabel(g, t)}
              <ChevronDown aria-hidden className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && <div className="grid grid-cols-2 gap-1.5 px-1 py-1.5">{filtersInGroup(g).map(item)}</div>}
          </div>
        );
      })}
    </div>
  ) : (
    <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2">
      <div role="group" aria-label={t.filters.groupsAria} className="flex flex-col gap-0.5 border-r border-neutral-800 pr-2">
        {groups.map((g) => (
          <button type="button" key={g} aria-pressed={g === group} onClick={() => pickGroup(g)}
            className={`atelier-filter-group h-8 rounded-md px-2 text-left text-xs transition-colors ${g === group ? 'bg-neutral-800 font-semibold text-white' : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200'}`}>
            {filterGroupLabel(g, t)}
          </button>
        ))}
      </div>
      <div key={group} className="flex flex-col gap-1">{filtersInGroup(group).map(item)}</div>
    </div>
  );

  const actions = definition ? (
    <>
      <button type="button" onClick={onBack} aria-label={t.common.back} title={t.common.back} className="atelier-icon-btn h-7 w-7">
        <ArrowLeft className="h-4 w-4" />
      </button>
      {definition.params.length > 0 && (
        <button type="button" disabled={busy} onClick={() => setValues(defaultFilterValues(definition))}
          aria-label={t.filters.resetParams} title={t.filters.resetParams} className="atelier-icon-btn h-7 w-7">
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
    </>
  ) : undefined;

  return (
    <ToolWindow id="layer-filter" icon={<SlidersHorizontal />}
      title={<>{definition ? filterLabel(definition, t) : t.filters.title}<span className="ml-1.5 font-normal text-neutral-500">{layerName}</span></>}
      actions={actions} onClose={onClose} initial={{ x: -332, y: 96, w: 320, h: 0 }} minW={260}
      footer={definition ? (
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-300">
            <input type="checkbox" disabled={busy} checked={preview} onChange={(event) => {
              setPreview(event.target.checked);
              if (!event.target.checked) onPreview(null);
            }} />{t.filters.preview}
          </label>
          <button type="button" onClick={onClose} className="atelier-btn atelier-btn--ghost">{t.common.cancel}</button>
          <button type="button" disabled={busy} className="atelier-btn atelier-btn--primary" onClick={async () => {
            if (await onApply(jobValues)) {
              saveFilterValues(definition, values);
              onClose();
            }
          }}>
            <Check />{busy ? t.common.applying : t.common.apply}
          </button>
        </>
      ) : undefined}>
      {!definition ? menu : (
        <div className="space-y-3">
          {definition.hint && <p className="text-neutral-300">{t.filters[definition.hint]}</p>}
          {definition.histogram && <ToneHistogram data={histogram ?? null} values={values} />}
          {definition.params.filter((param) => paramShown(param, values)).map((param, index, shown) => (
            <div key={param.key} className="space-y-1.5">
              {param.section && param.section !== shown[index - 1]?.section && (
                <p className={`atelier-filter-item text-[11px] font-medium text-neutral-500 ${index > 0 ? 'pt-1' : ''}`} style={{ '--i': index } as CSSProperties}>
                  {t.filters.sections[param.section]}
                </p>
              )}
              <ParamControl param={param} index={index} label={filterParamLabel(param, t)} busy={busy}
                value={values[param.key]} onChange={(value) => setValues((current) => ({ ...current, [param.key]: value }))} />
            </div>
          ))}
        </div>
      )}
    </ToolWindow>
  );
}

function ParamControl({ param, index, label, value, busy, onChange }: {
  param: FilterParam;
  index: number;
  label: string;
  value: unknown;
  busy: boolean;
  onChange: (value: number | string | boolean) => void;
}) {
  const id = useId();
  const { t } = useI18n();
  const row = 'atelier-filter-item text-[11px] text-neutral-300';
  const style = { '--i': index } as CSSProperties;
  switch (param.kind) {
    case 'range':
      return <RangeControl param={param} id={id} label={label} value={typeof value === 'number' ? value : param.initial} busy={busy} onChange={onChange} className={row} style={style} />;
    case 'select':
      return (
        <label className={`${row} flex items-center justify-between gap-2`} style={style}>
          <span>{label}</span>
          <select disabled={busy} className="atelier-field h-7 min-w-0 max-w-[62%] truncate px-2 text-xs" value={String(value ?? param.initial)} onChange={(event) => onChange(event.target.value)}>
            {param.options.map((option) => <option key={option.value} value={option.value}>{filterParamLabel(option, t)}</option>)}
          </select>
        </label>
      );
    case 'toggle':
      return (
        <label className={`${row} flex cursor-pointer items-center gap-2`} style={style}>
          <input type="checkbox" disabled={busy} checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          <span>{label}</span>
        </label>
      );
    case 'color':
      return (
        <label className={`${row} flex items-center justify-between gap-2`} style={style}>
          <span>{label}</span>
          <input type="color" disabled={busy} className="h-6 w-10 cursor-pointer rounded border border-neutral-700 bg-transparent"
            value={typeof value === 'string' ? value : param.initial} onChange={(event) => onChange(event.target.value)} />
        </label>
      );
    case 'point':
      return <PointControl label={label} busy={busy} className={row} style={style} />;
  }
}

const numberOr = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/**
 * The layer's tones (levels window): bars on a square-root scale so thin line art still shows,
 * the parts outside the input range dimmed, and a mark where the midtones land.
 */
function ToneHistogram({ data, values }: { data: Uint32Array | null; values: FilterValues }) {
  const { t } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null);
  const lo = numberOr(values.inBlack, 0);
  const hi = Math.max(lo + 1, numberOr(values.inWhite, 255));
  const mid = numberOr(values.midtones, 0);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (data) {
        let peak = 0;
        for (let v = 0; v < 256; v++) peak = Math.max(peak, data[v]);
        const top = Math.sqrt(peak) || 1;
        ctx.fillStyle = 'rgb(165 180 252 / .8)';
        for (let v = 0; v < 256; v++) {
          const bar = (Math.sqrt(data[v]) / top) * (h - 3);
          if (bar > 0) ctx.fillRect((v / 256) * w, h - bar, Math.max(1, w / 256), bar);
        }
      }
      const x = (v: number) => (v / 255) * w;
      ctx.fillStyle = 'rgb(0 0 0 / .5)';
      ctx.fillRect(0, 0, x(lo), h);
      ctx.fillRect(x(hi), 0, w - x(hi), h);
      const midAt = lo + (hi - lo) * Math.pow(0.5, Math.pow(3, mid / 100));
      ctx.lineWidth = 1.5;
      for (const [at, color] of [[lo, 'rgb(23 23 23)'], [midAt, 'rgb(163 163 163)'], [hi, 'rgb(250 250 250)']] as const) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x(at), 0);
        ctx.lineTo(x(at), h);
        ctx.stroke();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [data, lo, hi, mid]);
  return (
    <canvas ref={ref} role="img" aria-label={t.filters.histogramAria}
      className="atelier-filter-item block h-14 w-full rounded-md border border-neutral-800 bg-neutral-950/60" />
  );
}

/** Where the centre is (dragged on the canvas), and a button that puts it back on the content */
function PointControl({ label, busy, className, style }: { label: string; busy: boolean; className: string; style: CSSProperties }) {
  const { t } = useI18n();
  const point = useSyncExternalStore(filterPoint.subscribe, filterPoint.get, filterPoint.get);
  return (
    <div className={`${className} flex items-center gap-2`} style={style}>
      <Crosshair aria-hidden className="h-3.5 w-3.5 shrink-0 text-indigo-300" />
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono tabular-nums text-neutral-400">{point ? `${point.x}, ${point.y}` : '—'}</span>
      <button type="button" disabled={busy || !point} onClick={() => filterPoint.recenter()} className="atelier-btn !h-6 shrink-0 !px-2 text-[11px]">
        {t.filters.recenter}
      </button>
    </div>
  );
}

/** A slider with a number box: typing only takes effect once the number is inside the range; leaving the box snaps it in */
function RangeControl({ param, id, label, value, busy, onChange, className, style }: {
  param: Extract<FilterParam, { kind: 'range' }>;
  id: string;
  label: string;
  value: number;
  busy: boolean;
  onChange: (value: number) => void;
  className: string;
  style: CSSProperties;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const step = param.step ?? 1;
  // Settings that run both ways from 0 (brightness, a shift…) fill from the middle to the thumb
  const bipolar = param.min < 0 && param.max === -param.min;
  const at = ((value - param.min) / (param.max - param.min)) * 100;
  const fill = bipolar ? { '--lo': `${Math.min(50, at)}%`, '--hi': `${Math.max(50, at)}%` } as CSSProperties : undefined;
  const commit = () => {
    const typed = Number(draft);
    const next = draft.trim() !== '' && Number.isFinite(typed) ? snapRange(param, typed) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <div className={`${className} grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1`} style={style}>
      <label htmlFor={id}>{label}</label>
      <input type="number" inputMode="decimal" disabled={busy} aria-label={label} min={param.min} max={param.max} step={step} value={draft}
        className="atelier-field h-6 w-16 px-1.5 text-right font-mono text-[11px] tabular-nums"
        onChange={(event) => {
          setDraft(event.target.value);
          const typed = Number(event.target.value);
          if (event.target.value.trim() !== '' && typed >= param.min && typed <= param.max) onChange(snapRange(param, typed));
        }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit(); }} />
      <input id={id} disabled={busy} className={`col-span-2 w-full cursor-pointer ${bipolar ? 'atelier-bipolar-range h-3.5' : 'h-1.5'}`} style={fill}
        type="range" min={param.min} max={param.max} step={step} value={value}
        onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}
