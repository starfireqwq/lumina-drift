import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, Brush, Eraser, Pipette } from 'lucide-react';
import type { AtelierBrushPreset } from '@atelier/shared';
import { useI18n } from '../context/I18nContext';
import { getBrushLibrary, subscribeBrushLibrary } from '../services/brushLibrary';
import { recordUsedColor, useColorHistoryState } from '../services/colorHistoryStore';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../utils/colorWheelMath';
import { computePopupPalettePosition, computeRadialSlotPositions, hitTestPopupRing } from '../utils/popupPaletteMath';
import { findSubTool, findSubToolForTool, getLocalizedSubTool, type SubToolId } from './workspace/toolCatalog';

const PALETTE_RADIUS = 166;
const PALETTE_MARGIN = 16;
const SWATCH_RADIUS = 96;
const SLOT_RADIUS = 140;
const HOLD_MS = 180;
const WHEEL_SIZE = 118;
const WHEEL_CENTER = WHEEL_SIZE / 2;
const HUE_RADIUS = 50;
const HUE_WIDTH = 12;
const SV_START = 30;
const SV_SIZE = WHEEL_SIZE - SV_START * 2;
const QUICK_SUB_TOOLS: SubToolId[] = ['eraser', 'bucket', 'lasso', 'smudge'];
const quickSubTools = QUICK_SUB_TOOLS.flatMap((id) => {
  const subTool = findSubTool(id) ?? (id === 'bucket' ? findSubToolForTool('bucket') : undefined);
  return subTool ? [subTool] : [];
});

export interface DesktopPopupPaletteProps {
  isOpen: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  currentColor: string;
  secondaryColor: string;
  isEraser: boolean;
  activeSubToolId: SubToolId;
  selectedBrushId: string | null;
  onSelectColor: (hex: string) => void;
  onSelectPreset: (preset: AtelierBrushPreset) => void;
  onSelectSubTool: (subToolId: SubToolId) => void;
  onSelectEyedropper: () => void;
  onToggleEraser: () => void;
  onSwapColors: () => void;
}

type Hsv = [number, number, number];
type WheelPick = { hsv: Hsv; hex: string };

function drawWheel(ctx: CanvasRenderingContext2D, [hue, saturation, value]: Hsv) {
  ctx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);
  const ring = ctx.createConicGradient(0, WHEEL_CENTER, WHEEL_CENTER);
  for (let angle = 0; angle <= 360; angle += 60) {
    ring.addColorStop(angle / 360, rgbToHex(...hsvToRgb(angle, 1, 1)));
  }
  ctx.beginPath();
  ctx.arc(WHEEL_CENTER, WHEEL_CENTER, HUE_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = HUE_WIDTH;
  ctx.strokeStyle = ring;
  ctx.stroke();

  const svRight = SV_START + SV_SIZE;
  const saturationFill = ctx.createLinearGradient(SV_START, 0, svRight, 0);
  saturationFill.addColorStop(0, '#FFFFFF');
  saturationFill.addColorStop(1, rgbToHex(...hsvToRgb(hue, 1, 1)));
  ctx.fillStyle = saturationFill;
  ctx.fillRect(SV_START, SV_START, SV_SIZE, SV_SIZE);
  const valueFill = ctx.createLinearGradient(0, SV_START, 0, svRight);
  valueFill.addColorStop(0, 'transparent');
  valueFill.addColorStop(1, '#000000');
  ctx.fillStyle = valueFill;
  ctx.fillRect(SV_START, SV_START, SV_SIZE, SV_SIZE);

  const radians = hue * Math.PI / 180;
  const markers = [
    [WHEEL_CENTER + HUE_RADIUS * Math.cos(radians), WHEEL_CENTER + HUE_RADIUS * Math.sin(radians)],
    [SV_START + saturation * SV_SIZE, SV_START + (1 - value) * SV_SIZE],
  ];
  for (const [x, y] of markers) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#15161B';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function wheelPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * WHEEL_SIZE / rect.width,
    y: (event.clientY - rect.top) * WHEEL_SIZE / rect.height,
  };
}

function PopupColorWheel({ color, label, dpr, onSelect }: {
  color: string;
  label: string;
  dpr: number;
  onSelect: (hex: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ pointerId: number; mode: 'hue' | 'sv'; pick: WheelPick } | null>(null);
  const [lastPick, setLastPick] = useState<WheelPick | null>(null);
  const rgb = hexToRgb(color);
  const hex = rgbToHex(...rgb);
  const [hue, saturation, value] = lastPick?.hex === hex ? lastPick.hsv : rgbToHsv(...rgb);
  const bufferSize = Math.round(WHEEL_SIZE * dpr);

  useLayoutEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const scale = bufferSize / WHEEL_SIZE;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawWheel(ctx, [hue, saturation, value]);
  }, [bufferSize, hue, saturation, value]);

  const updatePick = (x: number, y: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    const [h, s, v] = drag.pick.hsv;
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    const hsv: Hsv = drag.mode === 'hue'
      ? [(Math.atan2(y - WHEEL_CENTER, x - WHEEL_CENTER) * 180 / Math.PI + 360) % 360, s, v]
      : [h, clamp((x - SV_START) / SV_SIZE), 1 - clamp((y - SV_START) / SV_SIZE)];
    const nextHex = rgbToHex(...hsvToRgb(...hsv));
    const changed = nextHex !== drag.pick.hex;
    drag.pick = { hsv, hex: nextHex };
    setLastPick(drag.pick);
    if (changed) onSelect(nextHex);
  };

  const clearDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      data-testid="popup-color-wheel"
      aria-label={label}
      width={bufferSize}
      height={bufferSize}
      style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
      className="block cursor-crosshair touch-none"
      onPointerDown={(event) => {
        if (event.button !== 0 || dragRef.current) return;
        const { x, y } = wheelPoint(event);
        const distance = Math.hypot(x - WHEEL_CENTER, y - WHEEL_CENTER);
        const onHue = Math.abs(distance - HUE_RADIUS) <= HUE_WIDTH / 2;
        const onSquare = [x, y].every((point) => point >= SV_START && point <= SV_START + SV_SIZE);
        if (!onHue && !onSquare) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, mode: onHue ? 'hue' : 'sv', pick: { hsv: [hue, saturation, value], hex } };
        updatePick(x, y);
      }}
      onPointerMove={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        const { x, y } = wheelPoint(event);
        updatePick(x, y);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        const { x, y } = wheelPoint(event);
        updatePick(x, y);
        recordUsedColor(dragRef.current.pick.hex);
        clearDrag(event);
      }}
      onPointerCancel={clearDrag}
      onLostPointerCapture={clearDrag}
    />
  );
}

const readViewport = () => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 });
const focusStyle = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white';
const quickButtonStyle = `grid h-7 place-items-center rounded-full text-neutral-200 hover:bg-neutral-700 aria-pressed:bg-indigo-700 ${focusStyle}`;

function OpenDesktopPopupPalette({
  position, onClose, currentColor, secondaryColor, isEraser, activeSubToolId, selectedBrushId,
  onSelectColor, onSelectPreset, onSelectSubTool, onSelectEyedropper, onToggleEraser, onSwapColors,
}: DesktopPopupPaletteProps) {
  const { t } = useI18n();
  const { studio } = t;
  const closeHintId = useId();
  const paletteRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef(0);
  const [viewport, setViewport] = useState(readViewport);
  const [hoveredLabel, setHoveredLabel] = useState('');
  const [focusedLabel, setFocusedLabel] = useState('');
  const { history } = useColorHistoryState();
  const { brushes } = useSyncExternalStore(subscribeBrushLibrary, getBrushLibrary);
  const colors = history.slice(0, 10);
  const slots = [
    ...brushes.slice(0, 6).map((preset) => ({ kind: 'brush' as const, preset })),
    ...quickSubTools.map((subTool) => ({ kind: 'tool' as const, subTool })),
  ];
  const pos = computePopupPalettePosition(position.x, position.y, PALETTE_RADIUS, viewport.width, viewport.height, PALETTE_MARGIN);
  const size = PALETTE_RADIUS * 2;
  const scale = Math.min(1, Math.max(1, Math.min(viewport.width, viewport.height) - PALETTE_MARGIN * 2) / size);
  const colorPositions = computeRadialSlotPositions(PALETTE_RADIUS, PALETTE_RADIUS, SWATCH_RADIUS, colors.length, -90);
  const slotPositions = computeRadialSlotPositions(PALETTE_RADIUS, PALETTE_RADIUS, SLOT_RADIUS, slots.length, -90);

  useLayoutEffect(() => {
    openedAtRef.current = performance.now();
    const panel = paletteRef.current;
    const previousFocus = document.activeElement;
    panel?.focus({ preventScroll: true });
    let dprQuery: MediaQueryList;
    const updateViewport = () => {
      const next = readViewport();
      setViewport(next);
      dprQuery?.removeEventListener('change', updateViewport);
      dprQuery = window.matchMedia(`(resolution: ${next.dpr}dppx)`);
      dprQuery.addEventListener('change', updateViewport);
    };
    updateViewport();
    window.addEventListener('resize', updateViewport);
    return () => {
      window.removeEventListener('resize', updateViewport);
      dprQuery.removeEventListener('change', updateViewport);
      if (previousFocus instanceof HTMLElement && (panel?.contains(document.activeElement) || document.activeElement === document.body)) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const chooseColor = (color: string) => {
    onSelectColor(color);
    recordUsedColor(color);
    onClose();
  };
  const chooseSlot = (slot: typeof slots[number]) => {
    if (slot.kind === 'brush') onSelectPreset(slot.preset);
    else onSelectSubTool(slot.subTool.id);
    onClose();
  };

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 2 || performance.now() - openedAtRef.current < HOLD_MS) return;
      const dx = (event.clientX - pos.cx) / scale;
      const dy = (event.clientY - pos.cy) / scale;
      const colorIndex = hitTestPopupRing(dx, dy, SWATCH_RADIUS - 16, SWATCH_RADIUS + 16, colors.length);
      const slotIndex = hitTestPopupRing(dx, dy, SLOT_RADIUS - 22, PALETTE_RADIUS, slots.length);
      if (colorIndex === null && slotIndex === null) return;
      // Keep intercepting the native context menu through the release event.
      window.requestAnimationFrame(() => {
        if (!paletteRef.current) return;
        if (colorIndex !== null) chooseColor(colors[colorIndex]);
        else if (slotIndex !== null) chooseSlot(slots[slotIndex]);
      });
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerup', onPointerUp);
    };
  });

  const labelEvents = (label: string) => ({
    onPointerEnter: () => setHoveredLabel(label),
    onPointerLeave: () => setHoveredLabel(''),
    onFocus: () => setFocusedLabel(label),
    onBlur: () => setFocusedLabel(''),
  });

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[92] touch-none"
        aria-hidden
        onPointerDown={(event) => { if (event.button === 0) onClose(); }}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div
        ref={paletteRef}
        data-testid="desktop-popup-palette"
        data-cx={Math.round(pos.cx)}
        data-cy={Math.round(pos.cy)}
        data-radius={PALETTE_RADIUS}
        role="dialog"
        aria-label={studio.popupPaletteTitle}
        aria-describedby={closeHintId}
        tabIndex={-1}
        className="fixed z-[92] touch-none select-none rounded-full bg-[#1C1D23] text-neutral-100 shadow-[0_14px_42px_#0008,inset_0_0_0_1px_#555660] outline-none"
        style={{ left: pos.cx - PALETTE_RADIUS, top: pos.cy - PALETTE_RADIUS, width: size, height: size, transform: `scale(${scale})` }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button === 2) openedAtRef.current = performance.now();
        }}
      >
        <span id={closeHintId} className="sr-only">{studio.popupCloseHint}</span>
        <div aria-hidden className="pointer-events-none absolute inset-[48px] rounded-full border border-[#41434D] bg-[#25262E]" />
        <div aria-hidden className="pointer-events-none absolute inset-[88px] rounded-full border border-[#41434D] bg-[#1C1D23]" />
        <div className="absolute left-1/2 top-[80px] flex -translate-x-1/2 flex-col items-center gap-0.5">
          <PopupColorWheel color={currentColor} label={studio.tabWheel} dpr={viewport.dpr} onSelect={onSelectColor} />
          <div className="flex items-center gap-0.5 rounded-full border border-neutral-600 bg-[#30313B] px-0.5">
            <button type="button" className={`${quickButtonStyle} w-12`} data-testid="popup-swap-colors"
              aria-label={studio.popupSwapColors} title={studio.popupSwapColors} onClick={onSwapColors}>
              <span className="flex items-center gap-1" aria-hidden>
                <span className="h-3 w-3 rounded-sm border border-white/40" style={{ backgroundColor: currentColor }} />
                <ArrowLeftRight className="h-3 w-3" />
                <span className="h-3 w-3 rounded-sm border border-white/40" style={{ backgroundColor: secondaryColor }} />
              </span>
            </button>
            <button type="button" className={`${quickButtonStyle} w-7`} data-testid="popup-eyedropper"
              aria-label={t.tools.eyedropper} title={t.tools.eyedropper} onClick={() => { onSelectEyedropper(); onClose(); }}>
              <Pipette className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button type="button" className={`${quickButtonStyle} w-7`} data-testid="popup-eraser"
              aria-label={t.tools.eraser} title={t.tools.eraser} aria-pressed={isEraser} onClick={() => { onToggleEraser(); onClose(); }}>
              <Eraser className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
        <div role="group" aria-label={studio.popupRecentColors}>
          {colors.map((color, index) => (
            <button key={color} type="button" data-testid="popup-color-swatch" data-color={color}
              aria-label={color} aria-pressed={currentColor.toUpperCase() === color.toUpperCase()}
              className={`absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40 hover:ring-2 hover:ring-white aria-pressed:ring-2 aria-pressed:ring-indigo-300 ${focusStyle}`}
              style={{ left: colorPositions[index].x, top: colorPositions[index].y, backgroundColor: color }}
              onClick={() => chooseColor(color)} {...labelEvents(color)}
            />
          ))}
        </div>
        <div role="group" aria-label={`${studio.popupQuickBrushes} / ${studio.popupQuickTools}`}>
          {slots.map((slot, index) => {
            const isBrush = slot.kind === 'brush';
            const id = isBrush ? slot.preset.id : slot.subTool.id;
            const label = isBrush ? slot.preset.name : getLocalizedSubTool(id, t).label;
            const Icon = isBrush ? Brush : slot.subTool.icon;
            return (
              <button key={`${slot.kind}-${id}`} type="button" aria-label={label}
                data-testid={isBrush ? 'popup-brush-slot' : 'popup-subtool-slot'}
                data-preset-id={isBrush ? id : undefined} data-subtool-id={isBrush ? undefined : id}
                aria-pressed={isBrush ? selectedBrushId === id && !isEraser : activeSubToolId === id}
                className={`absolute grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-[#50515D] hover:border-neutral-200 hover:bg-[#565867] aria-pressed:border-indigo-300 aria-pressed:bg-indigo-800 ${isBrush ? 'bg-[#353743]' : 'bg-[#282930]'} ${focusStyle}`}
                style={{ left: slotPositions[index].x, top: slotPositions[index].y }}
                onClick={() => chooseSlot(slot)} {...labelEvents(label)}
              >
                <span aria-hidden><Icon className="h-[18px] w-[18px]" /></span>
              </button>
            );
          })}
        </div>
        {(hoveredLabel || focusedLabel) && (
          <span aria-hidden className="pointer-events-none absolute left-1/2 top-[232px] max-w-[126px] -translate-x-1/2 truncate rounded-md bg-[#121318] px-1.5 py-0.5 text-center text-[10px] font-medium leading-tight text-white">
            {hoveredLabel || focusedLabel}
          </span>
        )}
      </div>
    </>,
    document.body,
  );
}

export function DesktopPopupPalette(props: DesktopPopupPaletteProps) {
  return props.isOpen ? <OpenDesktopPopupPalette {...props} /> : null;
}
