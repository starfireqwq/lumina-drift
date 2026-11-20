import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { FilterValues } from '@atelier/shared';
import {
  defaultFilterValues, filterGroupLabel, filterGroupsInUse, filterLabel, filterParamLabel, filtersInGroup,
  getFilter, loadFilterValues, saveFilterValues, snapRange, type FilterDef, type FilterGroup, type FilterParam,
} from '../utils/filterRegistry';
import { ToolWindow } from './workspace/ToolWindow';
import { usePhoneLayout } from './workspace/dockStore';
import { useI18n } from '../context/I18nContext';

interface Props {
  filterId: string | null;
  layerName: string;
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

export function LayerFilterDialog({ filterId, layerName, busy, onChoose, onBack, onPreview, onApply, onClose }: Props) {
  const { t } = useI18n();
  const phone = usePhoneLayout();
  const definition = getFilter(filterId);
  const groups = useMemo(filterGroupsInUse, []);
  const [group, setGroup] = useState<FilterGroup>(() => readGroup(groups));
  const [values, setValues] = useState<FilterValues>(() => definition ? loadFilterValues(definition) : {});
  const [preview, setPreview] = useState(true);

  useEffect(() => {
    if (!definition || !preview || busy) return;
    const timer = setTimeout(() => onPreview(values), 160);
    return () => clearTimeout(timer);
  }, [definition, preview, values, onPreview, busy]);

  const pickGroup = (next: FilterGroup) => {
    setGroup(next);
    try { localStorage.setItem(GROUP_KEY, next); } catch { /* the first group shows next time */ }
  };

  const item = (def: FilterDef, index: number) => (
    <button type="button" key={def.id} onClick={() => onChoose(def.id)} title={def.tool ? t.filters.opensTool : undefined}
      className="atelier-btn atelier-filter-item !h-8 justify-start text-xs" style={{ '--i': index } as CSSProperties}>
      <span className="min-w-0 flex-1 truncate text-left">{filterLabel(def, t)}</span>
      {def.tool && <><ArrowUpRight aria-hidden className="!h-3.5 !w-3.5 shrink-0 text-neutral-500" /><span className="sr-only">{t.filters.opensTool}</span></>}
    </button>
  );

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
            if (await onApply(values)) {
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
          {definition.params.map((param, index) => (
            <ParamControl key={param.key} param={param} index={index} label={filterParamLabel(param, t)} busy={busy}
              value={values[param.key]} onChange={(value) => setValues((current) => ({ ...current, [param.key]: value }))} />
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
          <select disabled={busy} className="atelier-field h-7 px-2 text-xs" value={String(value ?? param.initial)} onChange={(event) => onChange(event.target.value)}>
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
  }
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
      <input id={id} disabled={busy} className="col-span-2 h-1.5 w-full cursor-pointer" type="range" min={param.min} max={param.max} step={step} value={value}
        onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}
