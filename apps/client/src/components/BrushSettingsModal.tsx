import React, { useRef } from 'react';
import { MAX_STABILIZER_LEVEL, STABILIZER_LEVEL_STEP, MIN_BRUSH_SPACING } from '@atelier/shared';
import { Paintbrush, RotateCcw, Upload } from 'lucide-react';
import { AtelierModal, modalButton } from './AtelierModal';
import { AntiAliasSelector } from './AntiAliasSelector';
import { BrushEnginePanel } from './BrushEnginePanel';
import { useWheelStep } from '../hooks/useWheelStep';
import type { BrushProperties } from '../engine/BrushRenderer';
import type { BrushToolId } from '../engine/brushToolSettings';
import { MAX_BRUSH_SIZE } from './workspace/toolCatalog';
import { useI18n } from '../context/I18nContext';

interface BrushSettingsModalProps {
  tool: BrushToolId;
  brushProps: BrushProperties;
  onChange: (props: Partial<BrushProperties>) => void;
  onReset: () => void;
  onUploadTip: (file: File) => void;
  onClearTip: () => void;
  onImportBrushes: () => void;
  renderPreview: () => HTMLCanvasElement | null;
  onClose: () => void;
}

const Field: React.FC<{ label: string; hint: string; value: number; min: number; max: number; step?: number; format: (v: number) => string; onChange: (v: number) => void }> = ({
  label, hint, value, min, max, step = 1, format, onChange,
}) => {
  const fieldRef = useRef<HTMLLabelElement>(null);
  useWheelStep(fieldRef, (steps) => {
    const next = Math.max(min, Math.min(max, Math.round((value + steps * step) * 1000) / 1000));
    if (next !== value) onChange(next);
  });
  return (
    <label ref={fieldRef} className="block space-y-0.5" title={hint}>
      <span className="flex justify-between text-[11px]">
        <span className="text-neutral-200">{label}{hint ? <span className="ml-1 text-neutral-500">{hint}</span> : null}</span>
        <span className="font-mono tabular-nums text-indigo-300">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="w-full" />
    </label>
  );
};

/** 筆刷詳細設定: every setting of one brush tool, with reset to default, tip upload and brush import */
export const BrushSettingsModal: React.FC<BrushSettingsModalProps> = ({
  tool, brushProps: p, onChange, onReset, onUploadTip, onClearTip, onImportBrushes, renderPreview, onClose,
}) => {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const isEraser = tool === 'eraser';
  const toolName = tool === 'brush' ? t.tools.brush : tool === 'pencil' ? t.tools.pencil : t.tools.eraser;

  return (
    <AtelierModal
      title={`${t.studio.brushDetailSettings}：${toolName}`}
      subtitle={t.studio.brushDetailsSubtitle}
      icon={<Paintbrush />}
      width="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={`${modalButton.secondary} mr-auto flex items-center gap-1`} onClick={() => { if (confirm(`${t.studio.restoreDefaultsConfirm} (${toolName})`)) onReset(); }}>
            <RotateCcw className="h-3.5 w-3.5" />{t.studio.restoreBrushDefaults}
          </button>
          {!isEraser && <button type="button" className={modalButton.secondary} onClick={onImportBrushes}>{t.studio.importBrushFile}</button>}
          <button type="button" className={modalButton.primary} onClick={onClose}>{t.common.done}</button>
        </>
      }
    >
      <div className={isEraser ? undefined : 'grid gap-4 sm:grid-cols-2'}>
        <div className="space-y-3">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-white">{t.studio.sizeAndPressure}</h3>
            <Field label={t.toolOptions.size} hint="" value={p.size} min={1} max={MAX_BRUSH_SIZE} format={(v) => `${v}px`} onChange={(v) => onChange({ size: v })} />
            <Field label={t.studio.minSize} hint={t.studio.minSizeHint} value={Math.round((p.minSize / Math.max(1, p.size)) * 100)} min={0} max={100}
              format={(v) => `${v}%`} onChange={(v) => onChange({ minSize: Math.max(0, Math.round(((p.size * v) / 100) * 10) / 10) })} />
          </section>
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-white">{t.studio.density}</h3>
            <Field label={t.toolOptions.opacity} hint={t.studio.opacityHint} value={p.opacity} min={0.01} max={1} step={0.01} format={pct} onChange={(v) => onChange({ opacity: v })} />
            {!isEraser && <>
              <Field label={t.toolOptions.flow} hint={t.studio.flowHint} value={p.flow} min={0.01} max={1} step={0.01} format={pct} onChange={(v) => onChange({ flow: v })} />
              <Field label={t.toolOptions.hardness} hint={t.studio.hardnessHint} value={p.hardness} min={0} max={1} step={0.01} format={pct} onChange={(v) => onChange({ hardness: v })} />
            </>}
            <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-neutral-300">
              <span className="shrink-0">{t.studio.antiAlias}</span>
              <AntiAliasSelector compact requireCoverage={isEraser} value={p.antiAlias} onChange={(antiAlias) => onChange({ antiAlias })} />
            </div>
          </section>
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-white">{t.studio.strokeSection}</h3>
            {!isEraser && <>
              <Field label={t.studio.spacing} hint={t.studio.spacingHint} value={p.spacing} min={MIN_BRUSH_SPACING} max={1.5} step={0.01} format={pct} onChange={(v) => onChange({ spacing: v })} />
              <Field label={t.studio.scatter} hint={t.studio.scatterHint} value={p.scatter} min={0} max={1} step={0.01} format={pct} onChange={(v) => onChange({ scatter: v })} />
            </>}
            <Field label={t.toolOptions.stabilizer} hint={t.studio.stabilizerHint} value={p.stabilizerLevel}
              min={0} max={MAX_STABILIZER_LEVEL} step={STABILIZER_LEVEL_STEP} format={String}
              onChange={(v) => onChange({ stabilizerLevel: v })} />
          </section>
          {!isEraser && <section className="space-y-1.5">
            <h3 className="text-xs font-semibold text-white">{t.studio.brushTipShape}</h3>
            <div className="flex items-center gap-2">
              <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg border border-neutral-700 bg-neutral-100">
                {p.customBrushUrl ? <img src={p.customBrushUrl} alt={t.studio.customTip} className="h-full w-full object-contain" /> : <span className="h-7 w-7 rounded-full bg-neutral-900" aria-label={t.studio.circleTip} />}
              </span>
              <div className="flex flex-col gap-1">
                <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1 rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800">
                  <Upload className="h-3 w-3" />{t.studio.uploadTipImage}
                </button>
                {p.customBrushUrl && (
                  <button type="button" onClick={onClearTip} className="rounded-md px-2 py-0.5 text-left text-[11px] text-neutral-400 hover:text-white">{t.studio.revertCircleTip}</button>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/webp,image/jpeg,image/svg+xml" className="hidden" aria-label={t.studio.uploadTipImage}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadTip(f); e.target.value = ''; }} />
            </div>
            <p className="text-[10px] text-neutral-500">{t.studio.tipPngHint}</p>
          </section>}
        </div>
        {!isEraser && <div>
          <BrushEnginePanel brushProps={p} onChange={onChange} renderPreview={renderPreview} />
        </div>}
      </div>
    </AtelierModal>
  );
};
