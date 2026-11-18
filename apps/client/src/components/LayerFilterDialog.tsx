import { useState, useEffect } from 'react';
import { Check, SlidersHorizontal } from 'lucide-react';
import { LAYER_FILTERS, type LayerFilterId } from '../utils/layerFilters';
import { ToolWindow } from './workspace/ToolWindow';
import { useI18n } from '../context/I18nContext';

interface Props {
  filterId: LayerFilterId | null;
  layerName: string;
  busy: boolean;
  onChoose: (id: LayerFilterId | 'curves' | 'gradient') => void;
  onPreview: (values: number[] | null) => void;
  onApply: (values: number[]) => Promise<boolean>;
  onClose: () => void;
}

export function LayerFilterDialog({ filterId, layerName, busy, onChoose, onPreview, onApply, onClose }: Props) {
  const { t } = useI18n();
  const definition = filterId ? LAYER_FILTERS[filterId] : null;
  const [values, setValues] = useState(() => definition?.controls.map((control) => control.initial) ?? []);
  const [preview, setPreview] = useState(true);

  useEffect(() => {
    if (!definition || !preview || busy) return;
    const timer = setTimeout(() => onPreview(values), 160);
    return () => clearTimeout(timer);
  }, [definition, preview, values, onPreview, busy]);

  const choice = 'atelier-btn justify-start !h-8 text-xs';

  return (
    <ToolWindow id="layer-filter" icon={<SlidersHorizontal />}
      title={<>{definition?.label ?? t.studio.filters}<span className="ml-1.5 font-normal text-neutral-500">{layerName}</span></>}
      onClose={onClose} initial={{ x: -312, y: 96, w: 300, h: 0 }} minW={240}
      footer={definition ? (
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-300">
            <input type="checkbox" disabled={busy} checked={preview} onChange={(event) => {
              setPreview(event.target.checked);
              if (!event.target.checked) onPreview(null);
            }} />{t.studio.previewDab}
          </label>
          <button type="button" onClick={onClose} className="atelier-btn atelier-btn--ghost">{t.common.cancel}</button>
          <button type="button" disabled={busy} onClick={async () => { if (await onApply(values)) onClose(); }} className="atelier-btn atelier-btn--primary">
            <Check />{busy ? t.common.applying : t.common.apply}
          </button>
        </>
      ) : undefined}>
      {!definition ? (
        <div className="grid grid-cols-2 gap-1.5">
          {(Object.keys(LAYER_FILTERS) as LayerFilterId[]).map((id) => (
            <button type="button" key={id} onClick={() => onChoose(id)} className={choice}>{LAYER_FILTERS[id].label}</button>
          ))}
          <button type="button" onClick={() => onChoose('curves')} className={choice}>{t.studio.colorCurves}</button>
          <button type="button" onClick={() => onChoose('gradient')} className={choice}>{t.studio.gradientMap}</button>
        </div>
      ) : (
        <div className="space-y-3">
          {filterId === 'invert' && <p className="text-neutral-300">將這個圖層反轉成負片。</p>}
          {definition.controls.map((control, index) => (
            <label key={control.label} className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 text-[11px] text-neutral-300">
              <span>{control.label}</span>
              <output className="font-mono tabular-nums text-neutral-100">{values[index]}</output>
              <input disabled={busy} className="col-span-2 h-1.5 w-full cursor-pointer" type="range" min={control.min} max={control.max} step={'step' in control ? Number(control.step) : 1} value={values[index]}
                onChange={(event) => setValues(values.map((value, i) => i === index ? Number(event.target.value) : value))} />
            </label>
          ))}
        </div>
      )}
    </ToolWindow>
  );
}
