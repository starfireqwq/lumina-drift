import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Crop,
  Link2,
  Link2Off,
  RotateCcw,
} from 'lucide-react';
import { ToolWindow } from './workspace/ToolWindow';
import { CANVAS_UNITS, CanvasUnit, clampDpi, formatUnitNumber, pixelsToUnit, unitToPixels } from '@atelier/shared';
import { getUiScale } from '../theme/uiScale';
import { useI18n } from '../context/I18nContext';
import type { Translations } from '../locales';
import {
  ANCHORS,
  boxFromAnchor,
  boxToOffset,
  clampResizeSize,
  getAnchorDef,
  RESIZE_MAX,
  RESIZE_MIN,
  type AnchorKey,
  type ResizeBox,
} from '../utils/canvasResize';

interface ResizeCanvasModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentWidth: number;
  currentHeight: number;
  currentDpi?: number;
  currentUnit?: CanvasUnit;
  box: ResizeBox;
  anchor: AnchorKey | null;
  lockAspect: boolean;
  modifierState?: { shift: boolean; alt: boolean };
  onChangeBox: (box: ResizeBox, anchorHint: AnchorKey | null) => void;
  onSelectAnchor: (anchor: AnchorKey) => void;
  onToggleLockAspect: () => void;
  onReset: () => void;
  onResize: (width: number, height: number, offsetX: number, offsetY: number, dpi?: number, unit?: CanvasUnit) => Promise<void>;
}

export const PRESETS = [
  { label: '正方 2K', w: 2048, h: 2048 },
  { label: 'FHD 橫', w: 1920, h: 1080 },
  { label: 'FHD 直', w: 1080, h: 1920 },
  { label: 'A4 300dpi', w: 2480, h: 3508 },
  { label: '4K UHD', w: 3840, h: 2160 },
  { label: '正方 4K', w: 4096, h: 4096 },
];

const parseDim = (s: string): number | null => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};

const renderAnchorArrow = (dx: number, dy: number) => {
  if (dx === 0 && dy === 0) return <span className="h-2 w-2 rounded-full bg-current" />;
  if (dx < 0 && dy < 0) return <ArrowUpLeft className="h-3 w-3" />;
  if (dx === 0 && dy < 0) return <ArrowUp className="h-3 w-3" />;
  if (dx > 0 && dy < 0) return <ArrowUpRight className="h-3 w-3" />;
  if (dx < 0 && dy === 0) return <ArrowLeft className="h-3 w-3" />;
  if (dx > 0 && dy === 0) return <ArrowRight className="h-3 w-3" />;
  if (dx < 0 && dy > 0) return <ArrowDownLeft className="h-3 w-3" />;
  if (dx === 0 && dy > 0) return <ArrowDown className="h-3 w-3" />;
  return <ArrowDownRight className="h-3 w-3" />;
};

const getAnchorLabel = (key: AnchorKey, t: Translations): string => {
  switch (key) {
    case 'tl': return t.canvas.anchorTopLeft;
    case 't': return t.canvas.anchorTop;
    case 'tr': return t.canvas.anchorTopRight;
    case 'l': return t.canvas.anchorLeft;
    case 'c': return t.canvas.anchorCenter;
    case 'r': return t.canvas.anchorRight;
    case 'bl': return t.canvas.anchorBottomLeft;
    case 'b': return t.canvas.anchorBottom;
    case 'br': return t.canvas.anchorBottomRight;
    default: return t.canvas.anchorCenter;
  }
};

const getPresetLabel = (index: number, defaultLabel: string, t: Translations): string => {
  switch (index) {
    case 0: return t.canvas.preset2k;
    case 1: return t.canvas.presetFhdH;
    case 2: return t.canvas.presetFhdV;
    case 3: return t.canvas.presetA4;
    case 4: return t.canvas.preset4kUhd;
    case 5: return t.canvas.preset4kSq;
    default: return defaultLabel;
  }
};

export const ResizeCanvasModal: React.FC<ResizeCanvasModalProps> = ({
  isOpen,
  onClose,
  currentWidth,
  currentHeight,
  currentDpi = 300,
  currentUnit = 'px',
  box,
  anchor,
  lockAspect,
  modifierState,
  onChangeBox,
  onSelectAnchor,
  onToggleLockAspect,
  onReset,
  onResize,
}) => {
  const { t } = useI18n();
  const [unit, setUnit] = useState<CanvasUnit>(currentUnit);
  const [dpiStr, setDpiStr] = useState(String(clampDpi(currentDpi)));
  const [widthStr, setWidthStr] = useState(() => formatUnitNumber(pixelsToUnit(box.width, currentUnit, currentDpi), currentUnit));
  const [heightStr, setHeightStr] = useState(() => formatUnitNumber(pixelsToUnit(box.height, currentUnit, currentDpi), currentUnit));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dpi = clampDpi(Number(dpiStr) || currentDpi);

  useEffect(() => {
    setWidthStr(formatUnitNumber(pixelsToUnit(box.width, unit, dpi), unit));
    setHeightStr(formatUnitNumber(pixelsToUnit(box.height, unit, dpi), unit));
  }, [box.width, box.height, unit, dpi]);

  if (!isOpen) return null;

  const activeAnchorKey: AnchorKey = anchor ?? 'c';
  const activeAnchorDef = anchor ? getAnchorDef(anchor) : null;
  const { offsetX, offsetY } = boxToOffset(box);
  const ratio = currentWidth / Math.max(1, currentHeight);
  const scale = getUiScale() || 1;
  const initialX = typeof window !== 'undefined' ? Math.max(16, Math.round(window.innerWidth / scale - 348)) : 24;

  const applyDimensions = (w: number, h: number) => {
    const cw = clampResizeSize(w);
    const ch = clampResizeSize(h);
    onChangeBox(boxFromAnchor(cw, ch, currentWidth, currentHeight, activeAnchorKey), anchor ?? 'c');
  };

  const toPx = (raw: string, d = dpi): number | null => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0) return null;
    return unit === 'px' ? Math.round(v) : unitToPixels(v, unit, d);
  };

  const handleWidthChange = (raw: string) => {
    setWidthStr(raw);
    const parsed = toPx(raw);
    if (parsed !== null && parsed >= RESIZE_MIN && parsed <= RESIZE_MAX) {
      const nextH = lockAspect ? clampResizeSize(parsed / ratio) : box.height;
      if (lockAspect) setHeightStr(formatUnitNumber(pixelsToUnit(nextH, unit, dpi), unit));
      applyDimensions(parsed, nextH);
    }
  };

  const handleHeightChange = (raw: string) => {
    setHeightStr(raw);
    const parsed = toPx(raw);
    if (parsed !== null && parsed >= RESIZE_MIN && parsed <= RESIZE_MAX) {
      const nextW = lockAspect ? clampResizeSize(parsed * ratio) : box.width;
      if (lockAspect) setWidthStr(formatUnitNumber(pixelsToUnit(nextW, unit, dpi), unit));
      applyDimensions(nextW, parsed);
    }
  };

  const handleUnitChange = (nextUnit: CanvasUnit) => {
    if (nextUnit === unit) return;
    setUnit(nextUnit);
    setWidthStr(formatUnitNumber(pixelsToUnit(box.width, nextUnit, dpi), nextUnit));
    setHeightStr(formatUnitNumber(pixelsToUnit(box.height, nextUnit, dpi), nextUnit));
  };

  const handleDpiCommit = (nextDpiRaw: number) => {
    const nextDpi = clampDpi(nextDpiRaw);
    setDpiStr(String(nextDpi));
    if (unit !== 'px') {
      const pw = parseFloat(widthStr);
      const ph = parseFloat(heightStr);
      const nextW = Number.isFinite(pw) && pw > 0 ? clampResizeSize(unitToPixels(pw, unit, nextDpi)) : box.width;
      const nextH = Number.isFinite(ph) && ph > 0 ? clampResizeSize(unitToPixels(ph, unit, nextDpi)) : box.height;
      applyDimensions(nextW, nextH);
    }
  };

  const commitTypedInputs = (): { w: number; h: number } => {
    const pw = toPx(widthStr);
    const ph = toPx(heightStr);
    const cw = clampResizeSize(pw ?? box.width);
    const ch = clampResizeSize(ph ?? box.height);
    setWidthStr(formatUnitNumber(pixelsToUnit(cw, unit, dpi), unit));
    setHeightStr(formatUnitNumber(pixelsToUnit(ch, unit, dpi), unit));
    return { w: cw, h: ch };
  };

  const handlePreset = (pw: number, ph: number) => {
    setWidthStr(formatUnitNumber(pixelsToUnit(pw, unit, dpi), unit));
    setHeightStr(formatUnitNumber(pixelsToUnit(ph, unit, dpi), unit));
    applyDimensions(pw, ph);
  };

  const unchanged =
    box.width === currentWidth &&
    box.height === currentHeight &&
    offsetX === 0 &&
    offsetY === 0 &&
    dpi === clampDpi(currentDpi) &&
    unit === currentUnit;
  const willCropOrShift = box.width < currentWidth || box.height < currentHeight || offsetX !== 0 || offsetY !== 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { w, h } = commitTypedInputs();
    const finalBox =
      w !== box.width || h !== box.height
        ? boxFromAnchor(w, h, currentWidth, currentHeight, activeAnchorKey)
        : box;
    const { offsetX: ox, offsetY: oy } = boxToOffset(finalBox);

    if (
      finalBox.width === currentWidth &&
      finalBox.height === currentHeight &&
      ox === 0 &&
      oy === 0 &&
      dpi === clampDpi(currentDpi) &&
      unit === currentUnit
    ) {
      onClose();
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onResize(finalBox.width, finalBox.height, ox, oy, dpi, unit);
      onClose();
    } catch (err: any) {
      setError(err.message || t.canvas.resizeFailed);
    } finally {
      setLoading(false);
    }
  };

  const selectedCol = activeAnchorDef ? Math.round(activeAnchorDef.ax * 2) : -1;
  const selectedRow = activeAnchorDef ? Math.round(activeAnchorDef.ay * 2) : -1;

  return (
    <ToolWindow
      id="canvas-resize"
      title={t.canvas.resizeTitle}
      icon={<Crop className="h-3.5 w-3.5 text-indigo-400" />}
      onClose={onClose}
      initial={{ x: initialX, y: 68, w: 320, h: 520 }}
      minW={290}
      minH={380}
      bodyClassName="overflow-y-auto p-3"
      actions={
        <button
          type="button"
          onClick={onReset}
          disabled={unchanged}
          title={t.canvas.resetDefaultSize}
          className="atelier-icon-btn h-6 w-6 disabled:opacity-35"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      }
      footer={
        <>
          <button type="button" onClick={onClose} className="atelier-btn h-8 px-3 text-xs">
            {t.common.cancel}
          </button>
          <button
            type="submit"
            form="resize-canvas-form"
            disabled={loading}
            className="atelier-btn-primary h-8 px-3.5 text-xs disabled:opacity-50"
          >
            {loading ? t.canvas.applying : t.canvas.applyResize}
          </button>
        </>
      }
    >
      <form id="resize-canvas-form" onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex items-center justify-between rounded-lg bg-neutral-900/70 px-2.5 py-1.5 text-[11px] text-neutral-300">
          <span>
            {t.canvas.currentSize}：<strong className="tabular-nums text-neutral-100">{currentWidth} × {currentHeight} px</strong>
          </span>
          {(offsetX !== 0 || offsetY !== 0) && (
            <span className="tabular-nums text-indigo-300">
              {t.canvas.offset} {offsetX > 0 ? `+${offsetX}` : offsetX}, {offsetY > 0 ? `+${offsetY}` : offsetY}
            </span>
          )}
        </div>

        {/* Unit & DPI */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex rounded-md border border-neutral-700 bg-neutral-950/60 p-0.5 text-[11px]">
            {CANVAS_UNITS.map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => handleUnitChange(u)}
                aria-pressed={unit === u}
                className={`rounded px-2 py-0.5 font-mono transition ${unit === u ? 'bg-indigo-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'}`}
              >
                {u}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-[11px] text-neutral-300">
            <span>DPI</span>
            <input
              type="number"
              min={30}
              max={1200}
              value={dpiStr}
              onChange={(e) => setDpiStr(e.target.value)}
              onBlur={() => handleDpiCommit(Number(dpiStr) || currentDpi)}
              className="atelier-field h-7 w-16 px-1.5 font-mono text-xs tabular-nums"
            />
          </label>
        </div>

        {/* Dimensions */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <div>
            <label htmlFor="resize-w" className="mb-1 block text-[11px] font-medium text-neutral-300">
              {t.canvas.width} ({unit})
            </label>
            <input
              id="resize-w"
              type="number"
              step={unit === 'px' ? 1 : 'any'}
              min={unit === 'px' ? RESIZE_MIN : 0.1}
              value={widthStr}
              onChange={(e) => handleWidthChange(e.target.value)}
              onBlur={commitTypedInputs}
              required
              className="atelier-field h-8 w-full px-2.5 text-sm font-medium tabular-nums"
            />
          </div>

          <button
            type="button"
            onClick={onToggleLockAspect}
            aria-pressed={lockAspect}
            title={lockAspect ? t.canvas.unlockAspect : t.canvas.lockAspect}
            className={`atelier-icon-btn mb-0.5 h-8 w-8 ${lockAspect ? 'border-indigo-500/70 bg-indigo-600/25 text-indigo-200' : ''}`}
          >
            {lockAspect ? <Link2 className="h-4 w-4" /> : <Link2Off className="h-4 w-4" />}
          </button>

          <div>
            <label htmlFor="resize-h" className="mb-1 block text-[11px] font-medium text-neutral-300">
              {t.canvas.height} ({unit})
            </label>
            <input
              id="resize-h"
              type="number"
              step={unit === 'px' ? 1 : 'any'}
              min={unit === 'px' ? RESIZE_MIN : 0.1}
              value={heightStr}
              onChange={(e) => handleHeightChange(e.target.value)}
              onBlur={commitTypedInputs}
              required
              className="atelier-field h-8 w-full px-2.5 text-sm font-medium tabular-nums"
            />
          </div>
        </div>
        {unit !== 'px' && (
          <div className="text-[11px] tabular-nums text-neutral-400">
            {t.canvas.physicalSize}: <span className="font-mono text-neutral-200">{box.width} × {box.height} px</span> ({dpi} DPI)
          </div>
        )}

        {/* 3x3 Anchor Grid */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2.5">
          <div className="grid grid-cols-3 gap-1" role="group" aria-label={t.canvas.anchorPoint}>
            {ANCHORS.map((a, idx) => {
              const col = idx % 3;
              const row = Math.floor(idx / 3);
              const isSelected = anchor === a.key;
              const dx = selectedCol >= 0 ? col - selectedCol : 0;
              const dy = selectedRow >= 0 ? row - selectedRow : 0;
              const isNeighbor = selectedCol >= 0 && Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
              const anchorLabel = getAnchorLabel(a.key, t);
              return (
                <button
                  key={a.key}
                  type="button"
                  data-anchor={a.key}
                  aria-label={`${t.canvas.anchorPoint}：${anchorLabel}`}
                  aria-pressed={isSelected}
                  title={`${t.canvas.anchorPoint}：${anchorLabel}`}
                  onClick={() => onSelectAnchor(a.key)}
                  className={`flex h-7 w-7 items-center justify-center rounded border transition ${
                    isSelected
                      ? 'border-indigo-400 bg-indigo-600 text-white shadow-sm'
                      : isNeighbor
                        ? 'border-neutral-700 bg-neutral-800/80 text-neutral-300 hover:border-neutral-500 hover:text-white'
                        : 'border-neutral-800 bg-neutral-900 text-neutral-600 hover:border-neutral-600 hover:text-neutral-300'
                  }`}
                >
                  {isSelected
                    ? renderAnchorArrow(0, 0)
                    : isNeighbor
                      ? renderAnchorArrow(dx, dy)
                      : null}
                </button>
              );
            })}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1 text-[11px]">
            <span className="font-medium text-neutral-200">
              {t.canvas.anchorPoint}：<span className="text-indigo-300">{activeAnchorDef ? getAnchorLabel(activeAnchorDef.key, t) : t.canvas.anchorCustomOffset}</span>
            </span>
            <p className="leading-snug text-neutral-400">
              {t.canvas.anchorHint}
            </p>
          </div>
        </div>

        {/* Presets */}
        <div>
          <span className="mb-1.5 block text-[11px] font-medium text-neutral-400">{t.canvas.presets}</span>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p, idx) => {
              const active = box.width === p.w && box.height === p.h;
              const label = getPresetLabel(idx, p.label, t);
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => handlePreset(p.w, p.h)}
                  className={`rounded-md border px-2 py-1 text-[11px] transition ${
                    active
                      ? 'border-indigo-500 bg-indigo-600/20 text-white'
                      : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Shortcut hints */}
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-neutral-900/60 px-2.5 py-1.5 text-[11px] text-neutral-400">
          <span className={`rounded px-1.5 py-0.5 ${modifierState?.shift ? 'bg-indigo-600/40 text-indigo-100' : 'bg-neutral-800 text-neutral-300'}`}>
            {t.canvas.shiftConstraint}
          </span>
          <span className={`rounded px-1.5 py-0.5 ${modifierState?.alt ? 'bg-amber-600/40 text-amber-100' : 'bg-neutral-800 text-neutral-300'}`}>
            {t.canvas.altSymmetric}
          </span>
          <span className="text-neutral-500">{t.canvas.dragPreviewHint}</span>
        </div>

        {willCropOrShift && (
          <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-2.5 py-1.5 text-[11px] text-amber-200">
            {t.canvas.cropWarning}
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-lg border border-rose-800/80 bg-rose-950/50 px-2.5 py-1.5 text-xs text-rose-200">
            {error}
          </div>
        )}
      </form>
    </ToolWindow>
  );
};
