import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pipette, Plus, Minus, Sparkles, X } from 'lucide-react';
import {
  addColorRangeSample,
  computeColorRangeMask,
  hexToRgb,
  removeMatchingColorRangeSample,
  sampleRgbaAt,
  type ColorRangeSample,
} from '@atelier/shared';
import { useI18n } from '../context/I18nContext';
import { AtelierModal } from './AtelierModal';
import type { SelectionCombineMode } from '../engine/SelectionEngine';

export type ColorRangeSourceMode = 'layer' | 'merged';
type PreviewMode = 'mask' | 'red' | 'selection';
type PickerMode = 'replace' | 'add' | 'subtract';

export interface ColorRangeSourceBuffer {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

interface ColorRangeDialogProps {
  open: boolean;
  initialColor: string;
  initialFuzziness?: number;
  initialCombineMode?: SelectionCombineMode;
  canSampleLayer: boolean;
  readSource: (mode: ColorRangeSourceMode) => Promise<ColorRangeSourceBuffer | null>;
  onApply: (mask: Uint8Array, mode: SelectionCombineMode) => void;
  onClose: () => void;
}

const PREVIEW_MAX_SIDE = 360;

function sampleToHex(s: ColorRangeSample): string {
  const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${hex(s.r)}${hex(s.g)}${hex(s.b)}`.toUpperCase();
}

function downsampleBuffer(buf: ColorRangeSourceBuffer, maxSide: number): ColorRangeSourceBuffer {
  const { width, height, rgba } = buf;
  if (width <= maxSide && height <= maxSide) return buf;
  const scale = maxSide / Math.max(width, height);
  const pw = Math.max(1, Math.round(width * scale));
  const ph = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(pw * ph * 4);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) / scale));
    const srcRow = sy * width;
    const dstRow = y * pw;
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) / scale));
      const si = (srcRow + sx) * 4;
      const di = (dstRow + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { rgba: out, width: pw, height: ph };
}

export const ColorRangeDialog: React.FC<ColorRangeDialogProps> = ({
  open,
  initialColor,
  initialFuzziness = 40,
  initialCombineMode = 'replace',
  canSampleLayer,
  readSource,
  onApply,
  onClose,
}) => {
  const { t } = useI18n();
  const labels = t.colorRange;

  const [sourceMode, setSourceMode] = useState<ColorRangeSourceMode>(canSampleLayer ? 'layer' : 'merged');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('mask');
  const [pickerMode, setPickerMode] = useState<PickerMode>('replace');
  const [combineMode, setCombineMode] = useState<SelectionCombineMode>(initialCombineMode);
  const [fuzziness, setFuzziness] = useState<number>(Math.max(0, Math.min(200, Math.round(initialFuzziness))));
  const [feather, setFeather] = useState<number>(0);
  const [invert, setInvert] = useState<boolean>(false);
  const [samples, setSamples] = useState<ColorRangeSample[]>(() => [hexToRgb(initialColor)]);
  const [excludeSamples, setExcludeSamples] = useState<ColorRangeSample[]>([]);
  const [sourceBuf, setSourceBuf] = useState<ColorRangeSourceBuffer | null>(null);
  const [loading, setLoading] = useState(false);

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const readSourceRef = useRef(readSource);
  readSourceRef.current = readSource;

  // Reset initial color and source when opened
  useEffect(() => {
    if (!open) return;
    setSourceMode(canSampleLayer ? 'layer' : 'merged');
    setSamples([hexToRgb(initialColor)]);
    setExcludeSamples([]);
    setCombineMode(initialCombineMode);
    setInvert(false);
    setFeather(0);
    setFuzziness(Math.max(0, Math.min(200, Math.round(initialFuzziness))));
  }, [open, initialColor, initialFuzziness, initialCombineMode, canSampleLayer]);

  // Read source pixels whenever dialog opens or sourceMode changes
  useEffect(() => {
    if (!open) {
      setSourceBuf(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void readSourceRef.current(sourceMode).then((buf) => {
      if (!cancelled) {
        setSourceBuf(buf);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setSourceBuf(null);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [open, sourceMode]);

  const previewBuf = useMemo(
    () => (sourceBuf ? downsampleBuffer(sourceBuf, PREVIEW_MAX_SIDE) : null),
    [sourceBuf],
  );

  const previewMask = useMemo(() => {
    if (!previewBuf) return null;
    const scale = sourceBuf ? previewBuf.width / Math.max(1, sourceBuf.width) : 1;
    return computeColorRangeMask(
      previewBuf.rgba,
      previewBuf.width,
      previewBuf.height,
      {
        samples,
        excludeSamples,
        fuzziness,
        feather: Math.round(feather * scale),
        invert,
      },
      false,
    );
  }, [previewBuf, sourceBuf, samples, excludeSamples, fuzziness, feather, invert]);

  const coveragePct = useMemo(() => {
    if (!previewMask || previewMask.length === 0) return 0;
    let selected = 0;
    for (let i = 0; i < previewMask.length; i++) {
      if (previewMask[i] > 0) selected++;
    }
    return Math.round((selected / previewMask.length) * 1000) / 10;
  }, [previewMask]);

  // Paint preview canvas
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !previewBuf || !previewMask) return;
    const { width, height, rgba } = previewBuf;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    const dst = img.data;

    for (let i = 0; i < width * height; i++) {
      const m = previewMask[i];
      const di = i * 4;
      if (previewMode === 'mask') {
        dst[di] = m;
        dst[di + 1] = m;
        dst[di + 2] = m;
        dst[di + 3] = 255;
      } else if (previewMode === 'red') {
        const sr = rgba[di];
        const sg = rgba[di + 1];
        const sb = rgba[di + 2];
        const sa = rgba[di + 3] / 255;
        // Checkerboard backdrop for transparent areas
        const checker = (((i % width) >> 3) ^ ((Math.floor(i / width)) >> 3)) & 1 ? 210 : 175;
        const br = sr * sa + checker * (1 - sa);
        const bg = sg * sa + checker * (1 - sa);
        const bb = sb * sa + checker * (1 - sa);
        const overlayA = (m / 255) * 0.55;
        dst[di] = Math.round(239 * overlayA + br * (1 - overlayA));
        dst[di + 1] = Math.round(68 * overlayA + bg * (1 - overlayA));
        dst[di + 2] = Math.round(68 * overlayA + bb * (1 - overlayA));
        dst[di + 3] = 255;
      } else {
        // Selection dim preview: unselected areas dimmed, selected areas vivid
        const sr = rgba[di];
        const sg = rgba[di + 1];
        const sb = rgba[di + 2];
        const sa = rgba[di + 3] / 255;
        const checker = (((i % width) >> 3) ^ ((Math.floor(i / width)) >> 3)) & 1 ? 64 : 44;
        const br = sr * sa + checker * (1 - sa);
        const bg = sg * sa + checker * (1 - sa);
        const bb = sb * sa + checker * (1 - sa);
        const factor = 0.22 + 0.78 * (m / 255);
        dst[di] = Math.round(br * factor);
        dst[di + 1] = Math.round(bg * factor);
        dst[di + 2] = Math.round(bb * factor);
        dst[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [previewBuf, previewMask, previewMode]);

  const handlePreviewClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!previewBuf || !previewCanvasRef.current) return;
    const rect = previewCanvasRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * previewBuf.width;
    const py = ((e.clientY - rect.top) / rect.height) * previewBuf.height;
    const picked = sampleRgbaAt(previewBuf.rgba, previewBuf.width, previewBuf.height, px, py, false);
    if (!picked) return;

    const effectiveMode: PickerMode = e.shiftKey ? 'add' : e.altKey ? 'subtract' : pickerMode;
    if (effectiveMode === 'replace') {
      setSamples([picked]);
      setExcludeSamples([]);
    } else if (effectiveMode === 'add') {
      setSamples((prev) => addColorRangeSample(prev, picked));
      setExcludeSamples((prev) => removeMatchingColorRangeSample(prev, picked, 18).next);
    } else {
      // Subtract: remove nearest included sample if close, otherwise add to exclusion samples
      setSamples((prev) => {
        if (prev.length > 1) {
          const { next, removed } = removeMatchingColorRangeSample(prev, picked, 24);
          if (removed) return next;
        }
        return prev;
      });
      setExcludeSamples((prev) => addColorRangeSample(prev, picked));
    }
  };

  const handleApply = () => {
    if (!sourceBuf) return;
    const fullMask = computeColorRangeMask(
      sourceBuf.rgba,
      sourceBuf.width,
      sourceBuf.height,
      { samples, excludeSamples, fuzziness, feather, invert },
      false,
    );
    onApply(fullMask, combineMode);
    onClose();
  };

  if (!open) return null;

  return (
    <AtelierModal
      title={labels.title}
      icon={<Sparkles className="h-4 w-4 text-indigo-400" />}
      onClose={onClose}
      width="lg"
    >
      <div data-testid="color-range-dialog" className="space-y-3 text-xs text-neutral-200">
        {/* Source & Eyedropper toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded-md border border-atelier-border bg-neutral-900/60 p-0.5">
            <button
              type="button"
              disabled={!canSampleLayer}
              data-testid="color-range-source-layer"
              aria-pressed={sourceMode === 'layer'}
              onClick={() => setSourceMode('layer')}
              className={`rounded px-2 py-1 text-[11px] disabled:opacity-40 ${
                sourceMode === 'layer' ? 'bg-indigo-600/35 text-indigo-100' : 'text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              {labels.sourceLayer}
            </button>
            <button
              type="button"
              data-testid="color-range-source-merged"
              aria-pressed={sourceMode === 'merged'}
              onClick={() => setSourceMode('merged')}
              className={`rounded px-2 py-1 text-[11px] ${
                sourceMode === 'merged' ? 'bg-indigo-600/35 text-indigo-100' : 'text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              {labels.sourceMerged}
            </button>
          </div>

          {/* Eyedropper mode */}
          <div className="flex items-center gap-1" role="group" aria-label={labels.pickerLabel}>
            <button
              type="button"
              data-testid="color-range-picker-replace"
              aria-pressed={pickerMode === 'replace'}
              onClick={() => setPickerMode('replace')}
              title={labels.pickerReplace}
              className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${
                pickerMode === 'replace' ? 'border-indigo-400 bg-indigo-600/30 text-indigo-100' : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              <Pipette className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-testid="color-range-picker-add"
              aria-pressed={pickerMode === 'add'}
              onClick={() => setPickerMode('add')}
              title={labels.pickerAdd}
              className={`flex items-center gap-0.5 rounded border px-2 py-1 text-[11px] ${
                pickerMode === 'add' ? 'border-emerald-400 bg-emerald-600/30 text-emerald-100' : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              <Pipette className="h-3.5 w-3.5" /><Plus className="h-3 w-3" />
            </button>
            <button
              type="button"
              data-testid="color-range-picker-subtract"
              aria-pressed={pickerMode === 'subtract'}
              onClick={() => setPickerMode('subtract')}
              title={labels.pickerSubtract}
              className={`flex items-center gap-0.5 rounded border px-2 py-1 text-[11px] ${
                pickerMode === 'subtract' ? 'border-rose-400 bg-rose-600/30 text-rose-100' : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              <Pipette className="h-3.5 w-3.5" /><Minus className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Live Preview Canvas */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-neutral-400">
            <span>{labels.previewHint}</span>
            <div className="flex items-center gap-1">
              {(['mask', 'red', 'selection'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={previewMode === m}
                  onClick={() => setPreviewMode(m)}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    previewMode === m ? 'bg-indigo-500/30 text-indigo-100' : 'text-neutral-400 hover:bg-neutral-800'
                  }`}
                >
                  {m === 'mask' ? labels.previewMask : m === 'red' ? labels.previewRed : labels.previewSelection}
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-h-[180px] items-center justify-center rounded-lg border border-atelier-border bg-neutral-950 p-2">
            {loading || !previewBuf ? (
              <span className="text-neutral-400">{labels.loading}</span>
            ) : (
              <canvas
                ref={previewCanvasRef}
                data-testid="color-range-preview"
                onClick={handlePreviewClick}
                className="max-h-[260px] max-w-full cursor-crosshair rounded border border-neutral-800 object-contain"
              />
            )}
          </div>
        </div>

        {/* Sampled color swatches */}
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-neutral-400">{labels.samples}:</span>
          {samples.map((s, idx) => {
            const hex = sampleToHex(s);
            return (
              <button
                key={`inc-${idx}-${hex}`}
                type="button"
                onClick={() => setSamples((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))}
                title={hex}
                className="flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 hover:border-rose-400"
              >
                <span className="h-3 w-3 rounded-full border border-white/25" style={{ backgroundColor: hex }} />
                <span className="font-mono text-[10px] text-neutral-300">{hex}</span>
                {samples.length > 1 && <X className="h-2.5 w-2.5 text-neutral-500" />}
              </button>
            );
          })}
          {excludeSamples.length > 0 && (
            <>
              <span className="ml-2 text-rose-300">{labels.excluded}:</span>
              {excludeSamples.map((s, idx) => {
                const hex = sampleToHex(s);
                return (
                  <button
                    key={`exc-${idx}-${hex}`}
                    type="button"
                    onClick={() => setExcludeSamples((prev) => prev.filter((_, i) => i !== idx))}
                    title={hex}
                    className="flex items-center gap-1 rounded-full border border-rose-500/50 bg-rose-950/30 px-1.5 py-0.5 hover:border-rose-300"
                  >
                    <span className="h-3 w-3 rounded-full border border-white/25" style={{ backgroundColor: hex }} />
                    <span className="font-mono text-[10px] text-rose-200">{hex}</span>
                    <X className="h-2.5 w-2.5 text-rose-300" />
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* Sliders: Fuzziness & Feather */}
        <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2.5">
          <label className="flex items-center gap-2.5">
            <span className="w-20 shrink-0 text-neutral-300">{labels.fuzziness}</span>
            <input
              type="range"
              min={0}
              max={200}
              value={fuzziness}
              data-testid="color-range-fuzziness"
              onChange={(e) => setFuzziness(Number(e.target.value))}
              className="h-1.5 flex-1 accent-indigo-500"
            />
            <span className="w-10 text-right font-mono text-[11px] tabular-nums text-neutral-300">{fuzziness}</span>
          </label>
          <label className="flex items-center gap-2.5">
            <span className="w-20 shrink-0 text-neutral-300">{labels.feather}</span>
            <input
              type="range"
              min={0}
              max={64}
              value={feather}
              data-testid="color-range-feather"
              onChange={(e) => setFeather(Number(e.target.value))}
              className="h-1.5 flex-1 accent-indigo-500"
            />
            <span className="w-10 text-right font-mono text-[11px] tabular-nums text-neutral-300">{feather}px</span>
          </label>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-200">
              <input
                type="checkbox"
                checked={invert}
                data-testid="color-range-invert"
                onChange={(e) => setInvert(e.target.checked)}
              />
              <span>{labels.invert}</span>
            </label>

            <div className="flex items-center gap-1">
              <span className="text-[11px] text-neutral-400">{labels.combineMode}:</span>
              {(['replace', 'add', 'subtract'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={combineMode === m}
                  onClick={() => setCombineMode(m)}
                  className={`rounded border px-2 py-0.5 text-[11px] ${
                    combineMode === m
                      ? 'border-indigo-400 bg-indigo-600/30 text-indigo-100'
                      : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                  }`}
                >
                  {m === 'replace' ? t.toolOptions.selectionNew : m === 'add' ? t.toolOptions.selectionAdd : t.toolOptions.selectionSubtract}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-atelier-border pt-2.5">
          <span data-testid="color-range-stats" className="font-mono text-[11px] text-neutral-400">
            {labels.coverage.replace('{pct}', String(coveragePct))}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="color-range-cancel"
              onClick={onClose}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              {labels.cancel}
            </button>
            <button
              type="button"
              disabled={!sourceBuf || loading}
              data-testid="color-range-apply"
              onClick={handleApply}
              className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              {labels.apply}
            </button>
          </div>
        </div>
      </div>
    </AtelierModal>
  );
};
