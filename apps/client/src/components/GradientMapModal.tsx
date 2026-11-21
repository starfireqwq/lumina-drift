import React, { useState, useEffect } from 'react';
import {
  GRADIENT_PRESETS,
  GradientPresetName,
  GradientStop,
} from '@atelier/shared';
import { Blend, Check, Eye, Plus, Trash2 } from 'lucide-react';
import { ToolWindow } from './workspace/ToolWindow';
import { FilterTargetBar, type FilterTargetOptions } from './FilterTargetBar';
import { useI18n } from '../context/I18nContext';

interface GradientMapModalProps {
  isOpen: boolean;
  busy: boolean;
  target?: FilterTargetOptions;
  onClose: () => void;
  onApply: (stops: GradientStop[], opacity: number) => Promise<boolean>;
  onPreview?: (stops: GradientStop[] | null, opacity: number) => void;
}

export const GradientMapModal: React.FC<GradientMapModalProps> = ({
  isOpen,
  busy,
  target,
  onClose,
  onApply,
  onPreview,
}) => {
  const { t } = useI18n();
  const [selectedPreset, setSelectedPreset] = useState<GradientPresetName | 'custom'>('sunset');
  const [stops, setStops] = useState<GradientStop[]>(GRADIENT_PRESETS.sunset);
  const [opacity, setOpacity] = useState<number>(1.0);
  const [livePreview, setLivePreview] = useState<boolean>(true);
  const [activeStopIdx, setActiveStopIdx] = useState<number>(0);

  // When preset changes, load preset stops
  const handleSelectPreset = (name: GradientPresetName) => {
    setSelectedPreset(name);
    setStops([...GRADIENT_PRESETS[name]]);
    setActiveStopIdx(0);
  };

  // Build CSS linear-gradient string for preview bar
  const cssGradient = `linear-gradient(to right, ${[...stops]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`)
    .join(', ')})`;

  // Trigger live preview
  useEffect(() => {
    if (!isOpen || busy) return;
    if (livePreview && onPreview) {
      const timer = setTimeout(() => onPreview(stops, opacity), 160);
      return () => clearTimeout(timer);
    } else if (onPreview) {
      onPreview(null, opacity);
    }
  }, [isOpen, busy, livePreview, stops, opacity, onPreview, target?.applyToNewLayer, target?.includeBackground]);

  if (!isOpen) return null;

  const handleUpdateStopColor = (idx: number, newColor: string) => {
    const updated = [...stops];
    updated[idx] = { ...updated[idx], color: newColor };
    setStops(updated);
    setSelectedPreset('custom');
  };

  const handleUpdateStopOffset = (idx: number, newOffset: number) => {
    const updated = [...stops];
    updated[idx] = { ...updated[idx], offset: Math.max(0, Math.min(1, newOffset)) };
    updated.sort((a, b) => a.offset - b.offset);
    setStops(updated);
    setSelectedPreset('custom');
  };

  const handleAddStop = () => {
    if (stops.length >= 8) return;
    const newStop: GradientStop = { offset: 0.5, color: '#38bdf8' };
    const updated = [...stops, newStop].sort((a, b) => a.offset - b.offset);
    setStops(updated);
    setActiveStopIdx(updated.findIndex((s) => s === newStop));
    setSelectedPreset('custom');
  };

  const handleRemoveStop = (idx: number) => {
    if (stops.length <= 2) return;
    const updated = stops.filter((_, i) => i !== idx);
    setStops(updated);
    setActiveStopIdx(Math.max(0, idx - 1));
    setSelectedPreset('custom');
  };

  const handleConfirm = async () => {
    if (busy || !await onApply(stops, opacity)) return;
    if (onPreview) onPreview(null, opacity);
    onClose();
  };

  const handleCancel = () => {
    if (onPreview) onPreview(null, opacity);
    onClose();
  };

  const activeStop = stops[activeStopIdx] || stops[0];

  const presets: Array<{ id: GradientPresetName; label: string }> = [
    { id: 'sunset', label: t.studio.presetSunset },
    { id: 'cyberpunk', label: t.studio.presetCyberpunk },
    { id: 'ink', label: t.studio.presetInk },
  ];
  const presetCss = (name: GradientPresetName) => `linear-gradient(to right, ${GRADIENT_PRESETS[name].map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`).join(', ')})`;

  return (
    <ToolWindow id="gradient-map" title={t.studio.gradientMapTitle} icon={<Blend />} onClose={handleCancel}
      initial={{ x: -352, y: 96, w: 340, h: 0 }} minW={300}
      footer={(
        <>
          <button type="button" onClick={handleCancel} className="atelier-btn atelier-btn--ghost">{t.common.cancel}</button>
          <button type="button" onClick={handleConfirm} disabled={busy} className="atelier-btn atelier-btn--primary">
            <Check />{busy ? t.common.processing : t.common.apply}
          </button>
        </>
      )}>
        <div className="space-y-3">
          {/* Preset Buttons */}
          <div role="radiogroup" aria-label="預設" className="grid grid-cols-3 gap-1.5">
            {presets.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={selectedPreset === p.id} onClick={() => handleSelectPreset(p.id)}
                className={`flex flex-col gap-1.5 rounded-lg border p-1.5 text-left text-[11px] font-medium transition ${selectedPreset === p.id
                  ? 'border-indigo-500 bg-indigo-600/15 text-white' : 'border-neutral-700 bg-neutral-950/50 text-neutral-400 hover:border-neutral-500'}`}>
                <span className="h-2.5 w-full rounded-full" style={{ background: presetCss(p.id) }} />
                {p.label}
              </button>
            ))}
          </div>

          {/* Interactive Gradient Bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-neutral-400">
              <span>{t.studio.darkToLight}</span>
              <button type="button" onClick={handleAddStop} disabled={stops.length >= 8} className="atelier-btn atelier-btn--ghost !h-6 !px-2 text-[11px]">
                <Plus />{t.studio.addStop}
              </button>
            </div>

            {/* Gradient Track & Pin Handles */}
            <div className="relative pt-2 pb-5">
              <div
                className="w-full h-6 rounded-lg shadow-inner border border-neutral-700"
                style={{ background: cssGradient }}
              />

              {/* Draggable Stop Pins */}
              {stops.map((stop, idx) => {
                const isActive = activeStopIdx === idx;
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveStopIdx(idx)}
                    className="absolute -bottom-1 transform -translate-x-1/2 flex flex-col items-center group cursor-pointer focus:outline-none"
                    style={{ left: `${stop.offset * 100}%` }}
                  >
                    <div
                      className={`w-4 h-4 rounded-full border-2 shadow-md transition-transform ${
                        isActive
                          ? 'border-white scale-125 ring-2 ring-indigo-500'
                          : 'border-neutral-400 group-hover:scale-110'
                      }`}
                      style={{ backgroundColor: stop.color }}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active Color Stop Editor */}
          {activeStop && (
            <div className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-950/50 px-2 py-1.5">
              <input type="color" value={activeStop.color} aria-label={t.studio.colorStop}
                onChange={(e) => handleUpdateStopColor(activeStopIdx, e.target.value)}
                className="h-6 w-7 cursor-pointer rounded border border-neutral-700 bg-transparent" />
              <span className="font-mono text-[11px] uppercase text-neutral-300">{activeStop.color}</span>
              <label className="ml-auto flex items-center gap-1 text-[11px] text-neutral-400">
                {t.studio.stopPosition}
                <input type="number" min="0" max="100" value={Math.round(activeStop.offset * 100)}
                  onChange={(e) => handleUpdateStopOffset(activeStopIdx, parseInt(e.target.value, 10) / 100)}
                  className="atelier-field h-6 w-12 px-1.5 text-center font-mono text-[11px]" />%
              </label>
              {stops.length > 2 && (
                <button type="button" onClick={() => handleRemoveStop(activeStopIdx)} title={t.common.delete} aria-label={t.common.delete}
                  className="atelier-icon-btn h-6 w-6 hover:!text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
              )}
            </div>
          )}

          {/* Opacity Slider */}
          <label className="flex items-center gap-2 text-[11px] text-neutral-400">
            <span className="shrink-0">{t.toolOptions.strength}</span>
            <input type="range" min="0" max="1" step="0.01" value={opacity} onChange={(e) => setOpacity(parseFloat(e.target.value))}
              className="h-1.5 min-w-0 flex-1 cursor-pointer" />
            <span className="w-9 text-right font-mono tabular-nums text-neutral-200">{Math.round(opacity * 100)}%</span>
          </label>

          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-300">
            <input type="checkbox" checked={livePreview} onChange={(e) => setLivePreview(e.target.checked)} />
            <Eye className="h-3.5 w-3.5 text-neutral-400" />{t.common.preview}
          </label>
          <FilterTargetBar target={target} busy={busy} />
        </div>
    </ToolWindow>
  );
};
